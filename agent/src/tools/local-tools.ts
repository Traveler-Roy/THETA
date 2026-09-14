import path from 'node:path';
import { BundledSkills, skillTools } from './bundled-skills.js';
import { KnowledgeBase } from '../knowledge/knowledge-base.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { InferenceProvider } from '../providers/types.js';
import { contentHash, type Dataset, type ResearchRun, type TrainingPlan, type ComputeJob } from '../domain/research.js';
import { ResearchStore } from '../memory/research-store.js';
import { notebookKey, type AnalysisNotebook, type ProductSession } from '../memory/session-store.js';
import { PythonCapabilityWorker, type CapabilityWorker } from '../adapters/python-worker.js';
import { LocalComputeGateway, type ComputeGateway } from '../adapters/compute-gateway.js';
import { GoComputeGateway, goConfigurationFingerprint } from '../adapters/go-compute-gateway.js';
import { EffectApprovals } from '../domain/effect-approval.js';
import type { ComputeRequest, ResultView } from '../adapters/compute-gateway.js';
import { productTools } from './tool-catalog.js';
import { ResearchContexts } from '../memory/research-context.js';
import { analysisReady, executeMining, miningTools } from './mining-tools.js';
import type { AnalysisRuntime } from '../adapters/analysis-runtime.js';
import { StatisticalTools, statisticsTools } from './statistics-tools.js';

export interface ProductToolContext { session: ProductSession; userMessage: string; signal?: AbortSignal; save(): void }
export interface ProductToolExecutor {
  execute(name: string, input: unknown, context: ProductToolContext): Promise<unknown>;
  readContext?(session: ProductSession): unknown;
  readState?(session: ProductSession): unknown;
  knowledgeCatalog?(): unknown;
  toolAvailable?(name: string, session: ProductSession): boolean;
  analysisProgress?(session: ProductSession): unknown;
  decorateAnswer?(session: ProductSession, answer: string): string;
  recordUnderstanding?(session: ProductSession, answer: string): void;
}

/** Research domain orchestration. No CLI imports, workflow FSM or training process code. */
export class LocalProductTools implements ProductToolExecutor {
  private readonly records: ResearchStore;
  private readonly worker: CapabilityWorker;
  private readonly compute: ComputeGateway;
  private readonly backend: string;
  private readonly approvals: EffectApprovals;
  private readonly contexts: ResearchContexts;
  private readonly statistics: StatisticalTools;
  private readonly knowledge = new KnowledgeBase();
  knowledgeCatalog(): unknown { return this.knowledge.catalog(); }
  toolAvailable(name: string, session: ProductSession): boolean {
    if (statisticsTools.some(tool=>tool.name===name)) return this.statistics.available(name,session);
    return !miningTools.some(tool=>tool.name===name) || (!!this.options.analysis && analysisReady(session));
  }
  analysisProgress(session: ProductSession): unknown {
    if (!this.options.analysis || !analysisReady(session)) return null;
    try {
      const plan=session.miningPlans?.[notebookKey(session)] ?? null;
      const workspace=this.options.analysis.inspect(session) as {delivered?:boolean;deliveredFiles?:Array<{path:string}>};
      if (plan && !plan.requiredFiles.every(name=>workspace.deliveredFiles?.some(file=>file.path===name))) workspace.delivered=false;
      return {plan,workspace,methodReview:session.methodReviews?.[notebookKey(session)] ?? null};
    }
    catch (error) { return {unavailable:error instanceof Error ? error.message : String(error)}; }
  }
  constructor(readonly options: { runtimeDb: string; uploadDir: string; inferenceFactory?: () => InferenceProvider | undefined; worker?: CapabilityWorker; compute?: ComputeGateway; analysis?: AnalysisRuntime; onJobObserved?: (job: ComputeJob) => void }) {
    const home = path.dirname(options.runtimeDb);
    this.records = new ResearchStore(home);
    this.contexts = new ResearchContexts(this.records);
    this.approvals = new EffectApprovals(this.records);
    this.worker = options.worker ?? new PythonCapabilityWorker();
    this.statistics = new StatisticalTools(this.records,this.worker,this.approvals,home);
    this.backend = options.compute ? 'custom' : process.env.THETA_COMPUTE_URL ?? 'local';
    this.compute = options.compute ?? (process.env.THETA_COMPUTE_URL ? new GoComputeGateway(process.env.THETA_COMPUTE_URL, this.records) : new LocalComputeGateway(home, this.worker));
  }
  readContext(session: ProductSession): unknown {
    if (!session.contextId) return undefined;
    const { id, markdown, documentPath } = this.contexts.read(session.contextId);
    return { id, markdown, documentPath };
  }
  readState(session: ProductSession): unknown {
    if (!session.runId) return null;
    const run = this.run(session);
    return { goal: run.goal, plan: run.plan, lastObservedJob: run.lastObservedJob ?? null,
      instruction: 'Last observed host state overrides historical dialogue; use run_status if fresh status is needed. Do not claim an old running job is still running after observed completion.' };
  }
  decorateAnswer(session: ProductSession, answer: string): string {
    const artifacts = session.pendingArtifacts ?? [];
    session.pendingArtifacts = undefined;
    for (const item of artifacts) answer = answer.replaceAll(`](file://${item.path})`, `](<${item.path}>)`);
    const remaining = artifacts.filter(item => !answer.includes(`](${item.path})`) && !answer.includes(`](<${item.path}>)`));
    return remaining.length ? `${answer}\n\n本次可用文件：\n\n${remaining.map(item => `- [${item.name}](<${item.path}>)`).join('\n')}` : answer;
  }
  recordUnderstanding(session: ProductSession, answer: string): void {
    if (session.pendingStatisticalInterpretation) {
      const report = session.statisticalReports?.find(r=>r.analysisId===session.pendingStatisticalInterpretation);
      if (report) {
        const documentPath = path.join(path.dirname(report.reportPath), 'interpretation.md');
        writeFileSync(documentPath, `# 统计结果研究解读\n\n分析：${report.analysisId}\n\n以下为 Agent 对已计算证据的解释；估计与原始精度以 results.json 为准。\n\n${answer}\n`, {mode:0o600});
        report.files = [...report.files.filter(f=>f.name!=='interpretation.md'), {name:'interpretation.md',path:documentPath,kind:'md'}];
        session.pendingArtifacts = [...(session.pendingArtifacts ?? []), {name:'统计结果研究解读',path:documentPath}];
      }
      session.pendingStatisticalInterpretation = undefined;
    }
    if (session.pendingSynthesis) {
      const request = session.pendingSynthesis;
      const directory = path.join(path.dirname(this.options.runtimeDb), 'interpretations');
      mkdirSync(directory, { recursive: true });
      const documentPath = path.join(directory, `${request.id}.md`);
      writeFileSync(documentPath, `# 研究结果综合解读\n\n问题：${request.question}\n\n来源：${request.jobIds.join(', ')}\n\n上下文版本：${request.contextHash}\n\n${answer}\n`, { mode: 0o600 });
      session.interpretations ??= [];
      session.interpretations.push({ ...request, documentPath });
      session.pendingSynthesis = undefined;
    }
    if (!session.pendingUnderstanding) return;
    const previous = session.contextId ? this.contexts.read(session.contextId) : undefined;
    const pending = session.pendingUnderstanding;
    const value = this.contexts.save(session.id, { title: previous?.title ?? '数据理解与研究目标',
      goal: session.runId ? this.run(session).goal : previous?.goal ?? pending.goal, understanding: answer.slice(0, 14000),
      questions: previous?.questions ?? ['研究或分析目标、数据来源和代表性仍需结合用户反馈确认。'], datasetRefs: pending.datasetRefs }, session.contextId);
    session.contextId = value.id; session.pendingUnderstanding = undefined;
  }
  async attach(filePath: string, session: ProductSession): Promise<unknown> {
    const dataset = await this.worker.call<Dataset>('dataset.import', { filePath: path.resolve(filePath), uploadDir: this.options.uploadDir });
    return this.registerDataset(dataset, session);
  }
  private registerDataset(dataset: Dataset, session: ProductSession): unknown {
    this.records.put('dataset', dataset.datasetRef, dataset);
    if (!session.datasetRefs.includes(dataset.datasetRef)) session.datasetRefs.push(dataset.datasetRef);
    if (session.runId) {
      const run = this.run(session);
      if (!run.datasetRef) { run.datasetRef = dataset.datasetRef; this.saveRun(run); }
    }
    return { datasetRef: dataset.datasetRef, fileName: dataset.fileName, sizeBytes: dataset.sizeBytes, sha256: dataset.sha256 };
  }
  private run(session: ProductSession): ResearchRun {
    if (!session.runId) throw new Error('尚未选择研究任务。可以先讨论或读取数据，需要记录研究时调用 run_create。');
    return this.records.get('run', session.runId);
  }
  private saveRun(run: ResearchRun): void { this.records.put('run', run.id, run); }
  private requireBackend(run: ResearchRun): void {
    if (run.computeBackend && run.computeBackend !== this.backend) throw new Error('本研究绑定了另一计算端点。请恢复原端点查询任务；不能把相同批准转到其他计算服务。');
  }
  private dataset(session: ProductSession, ref?: string): Dataset {
    const id = ref ?? (session.runId ? this.run(session).datasetRef : undefined) ?? (session.datasetRefs.length === 1 ? session.datasetRefs[0] : undefined);
    if (!id || !session.datasetRefs.includes(id)) throw new Error('请先在本会话中提供数据文件。');
    return this.records.get('dataset', id);
  }
  private async preview(run: ResearchRun, session: ProductSession): Promise<{ request: ComputeRequest; summary: string; ready: boolean; readiness: unknown }> {
    this.requireBackend(run);
    if (!run.plan || !run.planHash) throw new Error('请先提出具体模型、数据列和参数方案。');
    const dataset = this.dataset(session);
    const preview = await this.worker.call<{ execution: Record<string, unknown>; readiness: { ready: boolean }; rowCount: number }>('compute.preview', { plan: run.plan, dataset });
    const remote = this.backend !== 'local' && this.backend !== 'custom';
    if (remote && (Object.keys(run.plan.params).some(key => key.includes('.')) || run.plan.labelColumn || run.plan.device)) throw new Error('该远端 worker 尚未登记扩展参数协议；请使用本地适配器，不能静默丢弃参数。');
    const request = { jobId: `job-${run.planHash}`, runId: run.id, dataset, plan: run.plan, execution: { ...preview.execution, ...(remote ? { computeConfigurationFingerprint: goConfigurationFingerprint() } : {}) } };
    const embedding = preview.execution.embedding as { mode: string; endpoint?: string; model?: string };
    const runtime = preview.execution.runtime as { profile: string; revision: string; python: string; mode: string } | undefined;
    const environment = !remote && runtime ? `\n运行环境：${runtime.profile} · ${runtime.revision}（${runtime.mode === 'shared' ? '共享兼容环境' : '独立配置'}）\nPython：${runtime.python}` : '';
    const external = embedding.mode === 'cloud'
      ? `\n外部 embedding：${embedding.endpoint}\n外部模型：${embedding.model}\n将发送：选定文本列的全文与派生词表（${preview.rowCount} 行输入）。\n最多 ${preview.execution.maxExternalRequests} 次 HTTP 请求，包括失败请求；没有自动重试。\n费用按供应商计费，当前没有可靠金额报价。`
      : '\nEmbedding 使用本地资源；本操作不授权外部 embedding 或模型下载。';
    return { request, readiness: preview.readiness, ready: remote || preview.readiness.ready,
      summary: `允许执行这次${remote ? '远端' : `本地 ${run.plan.device ?? 'cpu'}`}计算？\n${this.planSummary(run, dataset)}${remote ? `\n计算端点：${this.backend}\n远端运行资源/费用以已登记 runtime 为准；确认包含该任务的状态查询和结果链接读取。` : ''}${environment}${external}\n这是一次具体操作授权，不授权后续新实验。` };
  }
  private requestEffect(session: ProductSession, run: ResearchRun, action: string, payload: unknown, summary: string): unknown {
    const approval = this.approvals.request(session.id, { action, target: this.backend, payload, summary });
    session.pendingConfirmation = { kind: 'action', runId: run.id, checkpointId: approval.id, contentHash: approval.hash, summary };
    return { needsUser: true, summary, instruction: '暂停当前工具调用，等待用户确认。用户也可以拒绝、修改或继续讨论，不要求完成固定步骤。' };
  }
  private async resultScope(session: ProductSession, jobIds: string[]): Promise<unknown[]> {
    const runs = (session.runIds ?? [session.runId!]).map(id => this.records.get<ResearchRun>('run', id));
    return Promise.all(jobIds.map(async jobId => {
      const owner = runs.find(run => run.jobs.includes(jobId));
      if (!owner) throw new Error('只能读取本会话已关联任务的结果');
      this.requireBackend(owner);
      const job = await this.compute.status(jobId);
      if (job.status !== 'completed') throw new Error('任务尚未成功完成，不能解读结果');
      return { jobId, runId: owner.id, resultHash: job.resultHash ?? null, planHash: owner.planHash, datasetRef: owner.datasetRef };
    }));
  }
  private async analysisPayload(session: ProductSession, jobIds: string[], question?: string): Promise<Record<string, unknown>> {
    return { jobs: await this.resultScope(session, jobIds), jobIds,
      ...(question !== undefined ? { question, contextHash: contentHash(this.readContext(session) ?? null) } : {}) };
  }
  private planSummary(run: ResearchRun, dataset: Dataset): string {
    const plan = run.plan!;
    const remote = this.backend !== 'local' && this.backend !== 'custom';
    const seconds = plan.timeoutSeconds;
    const durationText = [[Math.floor(seconds / 3600), '小时'], [Math.floor(seconds % 3600 / 60), '分钟'], [seconds % 60, '秒']]
      .filter(([value]) => value).map(([value, unit]) => `${value} ${unit}`).join(' ');
    const duration = remote ? `请求时长：${durationText}；现有远端 API 不接受此上限，实际时限由已登记 runtime 决定。` : `最长运行：${durationText}（上限，不是预计耗时）`;
    return `研究目标：${run.goal}\n数据：${dataset.fileName}\n模型：${plan.modelId}\n文本列：${plan.textColumn}${plan.timeColumn ? `\n时间列：${plan.timeColumn}` : ''}${plan.labelColumn ? `\n标签列：${plan.labelColumn}` : ''}\n设备：${plan.device ?? 'cpu'}${plan.covariates?.length ? `\n协变量：${plan.covariates.join('、')}` : ''}\n参数：${JSON.stringify(plan.params)}\n理由：${plan.rationale}\n${duration}\n输入将规范化为独立 UTF-8 CSV，原文件保留。`;
  }
  /** Read-only observation can run while the conversation holds a session lease. */
  async observeTraining(session: ProductSession) {
    if (!session.runId) return undefined;
    const run = this.run(session); this.requireBackend(run);
    if (!run.activeJob || !run.jobs.includes(run.activeJob)) return undefined;
    return this.compute.status(run.activeJob);
  }
  private async job(run: ResearchRun, session: ProductSession, id = run.activeJob): Promise<unknown> {
    this.requireBackend(run);
    if (!id || !run.jobs.includes(id)) throw new Error('尚无关联的训练任务。');
    const job = await this.compute.status(id);
    run.lastObservedJob = { id: job.id, status: job.status, percent: job.percent, phase: job.phase, telemetry: job.telemetry, resultDir: job.resultDir, resultWarning: job.resultWarning }; this.saveRun(run);
    session.monitorTraining = ['queued', 'running'].includes(job.status);
    this.options.onJobObserved?.(job);
    const error = job.diagnostics?.available ? job.diagnostics.message : job.error;
    return { job, snapshot: { currentState: job.status, trainingPercent: job.percent }, summary: `训练${({ queued: '已排队', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[job.status]}${error ? `：${error}` : ''}${job.resultWarning ? `\n${job.resultWarning}` : ''}${job.resultDir ? `\n原始结果目录：${job.resultDir}` : ''}` };
  }
  async execute(name: string, input: unknown, context: ProductToolContext): Promise<unknown> {
    if (name === 'training_request_approval') name = 'training_advance';
    const tool = productTools.find((item) => item.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const args = tool.schema.parse(input) as Record<string, unknown>;
    context.signal?.throwIfAborted();
    const session = context.session;
    if (skillTools.some(tool=>tool.name===name)) return new BundledSkills(path.dirname(this.options.runtimeDb)).execute(name,args,context);
    if (statisticsTools.some(tool=>tool.name===name)) return this.statistics.execute(name,args,context);
    if (miningTools.some(tool=>tool.name===name)) return executeMining(this.options.analysis,name,input,context,this.options.inferenceFactory?.());
    if (name === 'analysis_history') {
      const receipts = session.messages.flatMap((message,index) => {
        const call = session.messages[index-1]?.metadata?.toolCalls as Array<{id:string;name:string;arguments:unknown}> | undefined;
        if (message.role !== 'tool' || !call?.[0] || call[0].id !== message.metadata?.toolCallId || call[0].name === 'analysis_history') return [];
        return [{callId:call[0].id, tool:call[0].name, arguments:call[0].arguments, receipt:message.content, runId:message.metadata?.runId ?? null}];
      }).reverse();
      const selected = args.callId ? receipts.filter(item=>item.callId===args.callId) : receipts.slice(Number(args.offset),Number(args.offset)+Number(args.limit));
      return {receipts:selected, nextOffset:!args.callId && Number(args.offset)+selected.length<receipts.length ? Number(args.offset)+selected.length : null,
        instruction:'These are historical original receipts, not new execution. A missing runId means older provenance is unspecified, not that it belongs to the selected study. Match file/data/job identity before use.'};
    }
    if (name === 'analysis_checkpoint') {
      if (session.pendingSynthesis) throw new Error('The approved interpretation is saved separately; do not change the research notebook during synthesis.');
      session.analysisNotebooks ??= {};
      const key = notebookKey(session);
      if (!session.analysisNotebooks[key] && Object.keys(session.analysisNotebooks).length >= 30) throw new Error('Notebook study limit reached; use a new session.');
      session.analysisNotebooks[key] = args as unknown as AnalysisNotebook;
      context.save();
      return {saved:true, instruction:'Agent-authored working notes saved, not independently verified. Now perform the recorded next action using available tools; do not repeat completed inspections. This receipt does not prove that any listed artifact exists or grant execution approval.'};
    }
    if (name === 'knowledge_list') return this.knowledge.list(args);
    if (name === 'knowledge_search') return this.knowledge.search(String(args.query), args.documentId as string | undefined, args.limit as number);
    if (name === 'knowledge_read') return this.knowledge.read(args as { documentId: string; sectionId?: string; offset?: number; limit?: number });
    if (name === 'reports_list') return [...(session.reports ?? []), ...(session.statisticalReports ?? []).map(({analysisId,runId,status,reportPath,files})=>({analysisId,runId,status,reportPath,files}))];
    if (name === 'runs_list') return (session.runIds ?? []).map(id => { const run = this.records.get<ResearchRun>('run', id); return { id, goal: run.goal, datasetRef: run.datasetRef, modelId: run.plan?.modelId, jobs: run.jobs }; });
    if (name === 'contexts_list') return this.contexts.list();
    if (name === 'context_read') return this.contexts.read(String(args.contextId ?? session.contextId ?? ''));
    if (name === 'context_select') {
      const value = this.contexts.select(session.id, String(args.contextId)); session.contextId = value.id; context.save();
      return { ...value, instruction: '上下文已复制到本会话，不会自动附加其中的数据，也不继承任何计算授权。' };
    }
    if (name === 'context_save') {
      if (session.pendingSynthesis) throw new Error('综合解读由宿主保存为独立 Markdown；本次解读不要覆盖数据理解上下文。');
      const value = this.contexts.save(session.id, { title: String(args.title), goal: String(args.goal),
        understanding: String(args.understanding), questions: args.questions as string[],
        datasetRefs: session.datasetRefs.length ? [...session.datasetRefs] : session.contextId ? this.contexts.read(session.contextId).datasetRefs : [] }, session.contextId);
      session.contextId = value.id; session.pendingUnderstanding = undefined; context.save(); return value;
    }
    if (name === 'datasets_discover') {
      const catalog = await this.worker.call<Record<string,unknown>>('dataset.discover', args, context.signal);
      const uploaded = this.records.list<Dataset>('dataset'); const offset = Number(args.offset ?? 0);
      return {...catalog, uploadedDatasets:uploaded.slice(offset,offset+50).map(d=>({catalogId:'catalog-'+contentHash({registeredDataset:d.datasetRef,sha256:d.sha256}),name:d.fileName,sizeBytes:d.sizeBytes,source:'managed upload'})),uploadedNextOffset:offset+50<uploaded.length?offset+50:null,
        instruction:'目录候选与已注册上传均可选择。用户明确指定文件后使用其 catalogId；不要因为文件不在预上传目录就断言上传失败。发现不会自动附加或计算。'};
    }
    if (name === 'dataset_use') {
      const uploaded = this.records.list<Dataset>('dataset').find(d=>'catalog-'+contentHash({registeredDataset:d.datasetRef,sha256:d.sha256})===args.catalogId);
      const dataset = uploaded ?? await this.worker.call<Dataset>('dataset.use', { ...args, uploadDir: this.options.uploadDir }, context.signal);
      const attached = this.registerDataset(dataset, session); context.save();
      return { attached, instruction: '用户选择的数据已附加；可用 dataset_understand 理解业务。若当前研究已绑定其他数据，先新建研究，不要静默替换已有实验数据。' };
    }
    if (name === 'dataset_understand') {
      const dataset = this.dataset(session, args.datasetRef as string | undefined);
      const result = await this.worker.call('dataset.understand', { ...args, dataset }, context.signal);
      session.pendingUnderstanding = { datasetRefs: [dataset.datasetRef], goal: session.runId ? this.run(session).goal : session.lastUserIntent || context.userMessage || '待确认用户研究或分析目标' };
      context.save(); return result;
    }
    if (name === 'models_list') return this.worker.call('models.list', {}, context.signal);
    if (name === 'models_inspect') return this.worker.call('models.inspect', args, context.signal);
    if (name === 'runtime_config') return this.worker.call('runtime.config', {}, context.signal);
    if (name === 'runtime_check') return this.worker.call('runtime.check', args, context.signal);
    if (name === 'dataset_read') return this.worker.call('dataset.profile', { ...args, dataset: this.dataset(session, args.datasetRef as string | undefined) }, context.signal);
    if (name === 'run_create') {
      const ref = args.datasetRef as string | undefined ?? (session.datasetRefs.length === 1 ? session.datasetRefs[0] : undefined);
      if (ref) this.dataset(session, ref);
      const run: ResearchRun = { id: `run-${randomUUID()}`, goal: String(args.goal ?? context.userMessage), datasetRef: ref, jobs: [], notes: [] };
      this.saveRun(run); session.runId = run.id; session.runIds ??= []; session.runIds.push(run.id);
      session.pendingConfirmation = undefined; session.monitorTraining = false; context.save();
      return run;
    }
    if (name === 'run_select') {
      if (!session.runIds?.includes(String(args.runId))) throw new Error('研究任务不属于当前会话');
      session.runId = String(args.runId); session.pendingConfirmation = undefined; session.monitorTraining = false; context.save();
      return this.run(session);
    }
    const run = this.run(session);
    if (name === 'run_update') {
      if (run.jobs.length) throw new Error('已有计算任务的研究保留原目标；新实验请 run_create，后续业务理解可单独更新 context_save。');
      if (session.pendingConfirmation) this.deny(session);
      run.goal = String(args.goal); run.notes.push(context.userMessage); this.saveRun(run);
      if (session.contextId) {
        const previous = this.contexts.read(session.contextId);
        this.contexts.save(session.id, { title: previous.title, goal: run.goal, understanding: previous.understanding,
          questions: previous.questions, datasetRefs: previous.datasetRefs }, session.contextId);
      }
      context.save(); return run;
    }
    if (name === 'run_status') { const result = run.activeJob ? await this.job(run, session) : { goal: run.goal, plan: run.plan, pendingConfirmation: session.pendingConfirmation }; context.save(); return result; }
    if (name === 'research_read') return run;
    if (name === 'research_answer' || name === 'checkpoint_revise') {
      if (!context.userMessage.trim()) throw new Error('需要实际用户消息');
      run.notes.push(context.userMessage);
      if (name === 'checkpoint_revise') { if (session.pendingConfirmation) this.deny(session); }
      this.saveRun(run); context.save(); return { recorded: true, instruction: '根据用户反馈决定是否需要重新提案；这不是批准。', run };
    }
    if (name === 'research_continue') {
      run.profile = await this.worker.call('dataset.understand', { dataset: this.dataset(session) }, context.signal);
      session.pendingUnderstanding = { datasetRefs: [this.dataset(session).datasetRef], goal: run.goal }; context.save();
      this.saveRun(run); return { run, instruction: '结合内容证据与用户研究或业务目标解释：分析对象、关心的现象、可回答的问题和局限。区分观察/推测/待确认。首次理解后若用户尚未明确下一步，提供“快速描述性统计＋一个推荐模型”或“先明确目的”两种选择；用户选定快速分析且证据足够时准备具体训练方案与宿主确认卡。不要把格式检查当内容理解，也不要强制进入训练。' };
    }
    if (name === 'plan_propose') {
      if (run.jobs.length && run.plan?.modelId !== args.modelId) throw new Error('切换模型请先 run_create 建立独立实验，保留已有训练的目标、方案和结果。');
      if (run.activeJob) {
        this.requireBackend(run);
        const job = await this.compute.status(run.activeJob);
        if (['queued', 'running'].includes(job.status)) throw new Error('当前实验仍在执行。可以另建研究进行比较，或明确取消后修改。');
      }
      const dataset = this.dataset(session);
      const plan = args as unknown as TrainingPlan;
      if (plan.modelId === 'theta' && (plan.params.mode ?? 'zero_shot') === 'zero_shot' && plan.params.embedding_provider === undefined) {
        const config = await this.worker.call<{ embedding: { preferredMode: string } }>('runtime.config', {}, context.signal);
        plan.params.embedding_provider = config.embedding.preferredMode;
      }
      await this.worker.call('plan.validate', { plan, dataset }, context.signal);
      run.plan = plan; run.revision = (run.revision ?? 0) + 1;
      run.computeBackend = this.backend;
      run.planHash = contentHash({ runId: run.id, revision: run.revision, datasetHash: dataset.sha256, plan, backend: this.backend });
      run.activeJob = undefined;
      this.saveRun(run);
      session.pendingConfirmation = undefined; context.save();
      return { plan: run.plan, summary: this.planSummary(run, dataset), instruction: '方案已记录，尚未授权任何开销。可以讨论、修改、检查环境，或调用 training_advance 提出本次计算授权。' };
    }
    if (name === 'checkpoint_review') {
      if (!session.pendingConfirmation) throw new Error('没有待确认内容，请先提出具体方案。');
      return { needsUser: true, ...session.pendingConfirmation };
    }
    if (name === 'training_prepare') {
      const preview = await this.preview(run, session);
      return { ready: preview.ready, readiness: preview.readiness, summary: preview.summary, instruction: '此工具只检查准备情况，不消耗外部 API 额度，也不改变批准状态。' };
    }
    if (name === 'training_advance') {
      this.requireBackend(run);
      if (run.activeJob) { const result = await this.job(run, session); context.save(); return { ...(result as Record<string, unknown>), reusedExistingJob: true, instruction: '当前方案已有任务，本次仅返回原任务状态，没有创建新的确认卡，也没有启动新计算。不要反复申请同一操作。若用户明确要求新实验，先 plan_propose 保存新一版方案，再请求训练确认；否则说明当前真实状态即可。' }; }
      const preview = await this.preview(run, session);
      if (!preview.ready) return { ready: false, readiness: preview.readiness, instruction: '计算环境尚未就绪，不得声称已训练或静默下载模型。' };
      const result = this.requestEffect(session, run, 'compute.submit', preview.request, preview.summary); context.save(); return result;
    }
    if (name === 'training_cancel') {
      this.requireBackend(run);
      if (!run.activeJob) throw new Error('没有可取消的任务');
      const job = await this.compute.status(run.activeJob);
      if (!['queued', 'running'].includes(job.status)) throw new Error('任务已经结束');
      const result = this.requestEffect(session, run, 'compute.cancel', { jobId: run.activeJob, runId: run.id }, '确认停止当前训练？已生成的状态与产物将保留。'); context.save(); return result;
    }
    if (name === 'results_read') {
      this.requireBackend(run);
      const jobId = String(args.jobId ?? run.activeJob ?? '');
      if (!run.jobs.includes(jobId)) throw new Error('只能读取本研究已关联任务的结果');
      const payload = await this.analysisPayload(session, [jobId]);
      const key = contentHash({ backend: this.backend, payload });
      const grant = session.resultGrants?.[key];
      if (grant) {
        try { this.approvals.assert(grant, 'results.read', this.backend, payload); }
        catch { delete session.resultGrants![key]; }
        if (session.resultGrants![key] && args.view !== 'report') return this.compute.results(jobId, args.view as ResultView, args.offset as number | undefined);
      }
      const result = this.requestEffect(session, run, 'results.read', payload,
        `确认整理并解读本次模型产出？\n任务：${jobId}\n将读取已完成结果与原始数据标签，调用仓库原生可视化，交付全部可用图表、表格和原始矩阵，解释指标和图表含义。不会重新训练或调用外部 embedding。\n本次不包含结合原始文本与研究或业务目标的深入解读，该操作单独确认。`);
      context.save(); return result;
    }
    if (name === 'results_synthesize') {
      const jobIds = args.jobIds as string[] | undefined ?? (run.activeJob ? [run.activeJob] : []);
      if (!jobIds.length) throw new Error('尚无可解读结果');
      const payload = await this.analysisPayload(session, jobIds, String(args.question));
      const result = this.requestEffect(session, run, 'results.synthesize', payload,
        `确认结合原始文本、图表、结果表和既有数据理解进行研究解读？\n问题：${args.question}\n任务：${jobIds.join('、')}\n上下文：${session.contextId ?? '尚未保存，将明确缺失的业务信息'}\n将单独调用研究解读 Agent，使用当前对话模型分析上述证据并保存独立 Markdown，不重训，不调用外部 embedding。`);
      context.save(); return result;
    }
    throw new Error(`未实现工具：${name}`);
  }
  /** Host only: resume the exact suspended action, without another planning/model call. */
  async approve(session: ProductSession, userMessage: string, signal?: AbortSignal, save: () => void = () => {}): Promise<unknown> {
    if (!isExplicitApproval(userMessage) || !session.pendingConfirmation) throw new Error('需要先展示确认内容，并由用户明确回复“确认”。');
    const pending = session.pendingConfirmation;
    if (pending.kind !== 'action') throw new Error('旧版本确认已经失效，请重新查看本次计算操作。');
    if (this.approvals.get(pending.checkpointId).action === 'statistics.execute') return this.statistics.approve(session, signal, save);
    const run = this.run(session); this.requireBackend(run);
    if (pending.runId !== run.id) throw new Error('当前研究已变化，请重新确认。');
    const effect = this.approvals.get(pending.checkpointId);
    if (effect.action === 'compute.cancel') {
      if (contentHash(effect.payload) !== contentHash({ jobId: run.activeJob, runId: run.id })) throw new Error('当前任务已变化。');
      const receipt = this.approvals.decide(effect.id, session.id, pending.contentHash, true);
      this.approvals.assert(receipt, effect.action, this.backend, effect.payload);
      session.pendingConfirmation = undefined;
      return this.compute.cancel(run.activeJob!);
    }
    if (effect.action === 'results.read' || effect.action === 'results.synthesize') {
      const original = effect.payload as { jobIds: string[]; question?: string };
      const payload = await this.analysisPayload(session, original.jobIds, original.question);
      if (contentHash(payload) !== contentHash(effect.payload)) throw new Error('结果或业务上下文已变化，请重新查看并确认。');
      const receipt = this.approvals.decide(effect.id, session.id, pending.contentHash, true);
      this.approvals.assert(receipt, effect.action, this.backend, payload);
      session.pendingConfirmation = undefined;
      const reports = await Promise.all(original.jobIds.map(async jobId => {
        try { return await this.compute.results(jobId, 'report'); }
        catch (error) {
          const job = await this.compute.status(jobId).catch(() => undefined);
          throw new Error(`结果整理失败：${error instanceof Error ? error.message : String(error)}${job?.resultDir ? `\n原始结果目录：${job.resultDir}` : ''}\n已有训练产物保留；这不是训练重试。修复后可以重新申请结果整理。`);
        }
      }));
      const incomplete = reports.some(value => (value as { reportStatus?: string }).reportStatus === 'incomplete');
      for (const value of reports) {
        const report = value as { jobId?: string; reportPath?: string; manifestPath?: string; reportStatus?: 'complete' | 'incomplete'; files?: Array<{ name: string; path: string; kind: string }> };
        if (report.jobId && report.reportPath && Array.isArray(report.files)) {
          session.reports = [...(session.reports ?? []).filter(old => old.jobId !== report.jobId), { jobId: report.jobId, reportPath: report.reportPath, manifestPath: report.manifestPath, reportStatus: report.reportStatus, files: report.files }].slice(-30);
          session.pendingArtifacts = [...(session.pendingArtifacts ?? []), ...report.files.map(file => ({ name: `${report.jobId!.slice(0, 12)} · ${file.name}`, path: file.path }))];
        }
      }
      if (effect.action === 'results.read') {
        session.resultGrants ??= {};
        session.resultGrants[contentHash({ backend: this.backend, payload })] = receipt;
      } else if (!incomplete) {
        session.pendingSynthesis = { id: `interpretation-${randomUUID()}`, question: original.question!, jobIds: original.jobIds, contextHash: String(payload.contextHash) };
      }
      const analysisReports = reports.map(value => {
        const report = value as Record<string, unknown>;
        if (report.schemaVersion !== 'theta.result-report.v2') return report;
        const rawEvidence = report.evidence as Record<string, unknown>;
        // Per-file hashes and repeated reading advice stay in the manifest. Keep the
        // actual tables and source rows inside the host's bounded inference receipt.
        const evidence = { ...rawEvidence, figures: (rawEvidence.figures as Array<Record<string, unknown>> | undefined)?.map(({ relativePath, format }) => ({ relativePath, format })) };
        return { jobId: report.jobId, modelId: report.modelId, resultHash: report.resultHash,
          trainingPlan: report.trainingPlan,
          ...(effect.action === 'results.synthesize' ? { sourceData: report.sourceData } : {}),
          reportPath: report.reportPath, reportStatus: report.reportStatus, resultDir: report.resultDir, logPath: report.logPath, diagnostics: report.diagnostics, trainingLogPath: report.trainingLogPath, quality: report.quality, summary: report.summary, evidence, missingEvidence: report.missingEvidence,
          artifactRoots: { native: path.join(path.dirname(String(report.reportPath)), 'native'), training: report.resultDir },
          availableArtifacts: (report.files as Array<{ name: string; kind: string }>).map(({ name, kind }) => ({ name, kind })),
          instruction: '本次全部文件链接由宿主追加。使用当前原生表格和矩阵证据作答；报告入口只使用本回执的 reportPath，历史路径可能已过时。无需重复文件清单。' };
      });
      return { resumedAction: effect.action, reports: analysisReports,
        ...(effect.action === 'results.synthesize' ? { researchContext: this.readContext(session) } : {}),
        instruction: incomplete
          ? '结果整理未完成，仅生成了已有文件与诊断入口。明确说明缺失证据和错误，给出 reportPath、resultDir、logPath；availableArtifacts 列出的原始矩阵/文件确实存在，只是分析证据未通过校验，不要说它们不存在。不能声称图表已完整生成，也不能据此做主题占比或深入研究解读。diagnostics 已给出时直接解释，不要再问是否允许读取已有诊断。没有已保存模型的证据时不要承诺可重新导出。未重新训练。'
          : effect.action === 'results.read'
          ? '用户已确认结果整理与基础解读。给出报告路径、所有生成图表和表格链接，逐项解释含义及缺失项；综合业务解读需另用 results_synthesize 征求确认。'
          : '用户已确认独立研究解读。依据 sourceData 原始文本、已保存研究目标、原生图表与原始 theta/beta 回答实质研究问题，引用具体 sourceRow 和原生产物。不要把解释文件格式或图表用途当作结果分析。只有 matrixRowsAligned=true 才能关联文本与该行主题权重。完整回答由宿主保存为独立 Markdown。' };
    }
    if (effect.action !== 'compute.submit') throw new Error('未注册的外部操作，不能执行。');
    const preview = await this.preview(run, session);
    if (!preview.ready || contentHash(preview.request) !== contentHash(effect.payload)) throw new Error('操作、环境配置或数据已变化，请重新查看并确认。');
    const receipt = this.approvals.decide(effect.id, session.id, pending.contentHash, true);
    this.approvals.assert(receipt, effect.action, this.backend, preview.request);
    session.pendingConfirmation = undefined;
    const job = await this.compute.submit(preview.request, receipt);
    run.activeJob = job.id; run.lastObservedJob = { id: job.id, status: job.status, percent: job.percent, phase: job.phase, telemetry: job.telemetry, resultDir: job.resultDir, resultWarning: job.resultWarning }; if (!run.jobs.includes(job.id)) run.jobs.push(job.id);
    this.saveRun(run); session.monitorTraining = ['queued', 'running'].includes(job.status);
    this.options.onJobObserved?.(job);
    return { resumedAction: effect.action, job, instruction: '这是主机实际提交回执。请按真实任务状态回应用户，不得宣称已完成训练。' };
  }
  deny(session: ProductSession, feedback?: string): unknown {
    const pending = session.pendingConfirmation;
    if (!pending) throw new Error('当前没有待确认操作。');
    if (pending.kind === 'action') this.approvals.decide(pending.checkpointId, session.id, pending.contentHash, false);
    session.pendingConfirmation = undefined;
    if (feedback?.trim() && session.runId && pending.runId === session.runId) {
      const run = this.records.get<ResearchRun>('run', pending.runId);
      run.notes.push(feedback.trim()); this.saveRun(run);
    }
    return { denied: true, feedback: feedback?.trim(), instruction: '用户拒绝了该操作，没有启动新计算或外部请求。继续讨论；不要自行再次请求相同操作。' };
  }

}
export const isExplicitApproval = (text: string): boolean => /^(?:确认|确认执行|确认开始训练|批准|同意|yes|approve|\/approve)[。.!！]?$/iu.test(text.trim());

/** Only unambiguous refusal commands are host shortcuts; other wording stays with the Agent. */
export const isExplicitDenial = (text: string): boolean => /^(?:拒绝|不执行|取消本次操作|no|deny|\/deny)(?:$|[\s，,。.!！:：;；、]|因为|原因是)/iu.test(text.trim());
