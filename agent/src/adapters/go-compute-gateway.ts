import { readFileSync } from 'node:fs';
import type { ComputeJob } from '../domain/research.js';
import { contentHash } from '../domain/research.js';
import { ResearchStore } from '../memory/research-store.js';
import type { ComputeGateway, ComputeRequest, ResultView } from './compute-gateway.js';
import { EffectApprovals, type ApprovalReceipt } from '../domain/effect-approval.js';

interface RemoteBinding {
  userId: string; projectId: string;
  datasets: Record<string, { ref: string; sha256: string; textColumn: string; timeColumn?: string; covariates?: string[] }>;
  models: Record<string, { modelId: number; runtimeId?: number }>;
}
const goConfiguration = () => ({
  bindings: process.env.THETA_COMPUTE_BINDINGS ? readFileSync(process.env.THETA_COMPUTE_BINDINGS, 'utf8') : null,
  credential: process.env.THETA_COMPUTE_TOKEN ?? null,
});
export const goConfigurationFingerprint = (): string => contentHash(goConfiguration());
/** Adapter for the existing Go v1 API. Remote datasets must be registered by the host.
 * The current server has no submit idempotency contract: uncertain requests are fenced
 * locally and never retried automatically. Go owns all remote task lifecycle state. */
export class GoComputeGateway implements ComputeGateway {
  constructor(private readonly endpoint: string, private readonly store: ResearchStore, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('远端计算端点必须使用 HTTPS；本机允许 HTTP。');
    if (url.username || url.password || url.search || url.hash) throw new Error('计算端点不可包含凭据、查询或片段。');
  }
  private async request(route: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${this.endpoint.replace(/\/$/u, '')}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(process.env.THETA_COMPUTE_TOKEN ? { authorization: `Bearer ${process.env.THETA_COMPUTE_TOKEN}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error(`计算服务返回 HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }
  async submit(request: ComputeRequest, authorization?: ApprovalReceipt): Promise<ComputeJob> {
    new EffectApprovals(this.store).assert(authorization, 'compute.submit', this.endpoint, request);
    if (Object.keys(request.plan.params).some(key => key.includes('.')) || request.plan.labelColumn || request.plan.device) throw new Error('远端 worker 尚未登记扩展参数协议，拒绝丢弃参数后提交。');
    const configuration = goConfiguration();
    if (request.execution?.computeConfigurationFingerprint !== contentHash(configuration)) throw new Error('远端数据/runtime 映射或凭据已变化，请重新确认。');
    if ((request.execution?.embedding as { mode?: string } | undefined)?.mode === 'cloud') throw new Error('当前 Go worker 协议尚不能验证云 embedding 调用预算，暂不能远端执行此方案。');
    let existing: { taskId?: string; hash: string } | undefined;
    try { existing = this.store.get('remote-job', request.jobId); } catch (error) { if (!(error instanceof Error) || !error.message.startsWith('记录不存在')) throw error; }
    const hash = contentHash(request);
    if (existing) {
      if (existing.hash !== hash) throw new Error('提交内容与原请求不一致');
      if (existing.taskId) return this.status(request.jobId);
      throw new Error('上次远端提交结果不确定，请先在 Go 控制面核对任务；不会自动重复提交。');
    }
    const file = process.env.THETA_COMPUTE_BINDINGS;
    if (!file) throw new Error('远端模式需要 THETA_COMPUTE_BINDINGS：宿主登记的用户、数据版本和模型 runtime 映射。');
    const bindings = JSON.parse(configuration.bindings!) as RemoteBinding;
    const dataset = bindings.datasets[request.dataset.datasetRef];
    const model = bindings.models[request.plan.modelId];
    if (!dataset || dataset.sha256 !== request.dataset.sha256 || dataset.textColumn !== request.plan.textColumn || dataset.timeColumn !== request.plan.timeColumn || contentHash(dataset.covariates ?? []) !== contentHash(request.plan.covariates ?? [])) throw new Error('远端数据及规范化列映射尚未由宿主登记或不匹配。');
    if (!model || !bindings.userId || !bindings.projectId) throw new Error('缺少远端身份/模型映射');
    if (!this.store.putIfAbsent('remote-job', request.jobId, { hash })) throw new Error('另一个宿主正在提交此任务，请先查询状态，不会重复发送请求。');
    const params = { ...request.plan.params, ...(request.plan.modelId === 'theta' ? { embedding_provider: 'local' } : {}) };
    const task = await this.request('/api/v1/tasks', { user_id: bindings.userId, project_id: bindings.projectId, dataset_ref: dataset.ref, model_id: model.modelId, ...(model.runtimeId ? { runtime_id: model.runtimeId } : {}), job_name: request.jobId, params, priority: 5 });
    if (typeof task.id !== 'number' && typeof task.id !== 'string') throw new Error('计算服务未返回有效 task ID，提交结果待核对');
    this.store.put('remote-job', request.jobId, { hash, taskId: String(task.id) });
    return this.map(request.jobId, task);
  }
  private id(jobId: string): string {
    const mapping = this.store.get<{ taskId?: string }>('remote-job', jobId);
    if (!mapping.taskId || !/^\d+$/u.test(mapping.taskId)) throw new Error('缺少已确认的远端任务 ID');
    return mapping.taskId;
  }
  private map(id: string, task: Record<string, unknown>): ComputeJob {
    const state = String(task.status).toLowerCase();
    const status = ({ pending: 'queued', queued: 'queued', running: 'running', succeeded: 'completed', success: 'completed', completed: 'completed', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled', cancelling: 'running' } as const)[state];
    if (!status) throw new Error(`未知远端任务状态：${state}`);
    return { id, status, phase: String(task.phase ?? state), percent: Number(task.progress ?? 0) };
  }
  async status(jobId: string): Promise<ComputeJob> { return this.map(jobId, await this.request(`/api/v1/tasks/${this.id(jobId)}`)); }
  async cancel(jobId: string): Promise<ComputeJob> { await this.request(`/api/v1/tasks/${this.id(jobId)}/cancel`, {}); return this.status(jobId); }
  async results(jobId: string, _view: ResultView, _offset?: number): Promise<unknown> {
    if ((await this.status(jobId)).status !== 'completed') throw new Error('远端任务尚未完成');
    const download = await this.request(`/api/v1/tasks/${this.id(jobId)}/model/download`);
    return { jobId, download, evidence: [], limitations: ['当前 Go API 只提供模型下载；结构化结果 manifest 接口尚未提供，不能据此虚构主题或指标。'] };
  }
}
