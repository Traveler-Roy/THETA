import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductSessionStore, type ProductSession } from '../src/memory/session-store.js';
import { ResearchStore } from '../src/memory/research-store.js';
import { LocalProductTools, isExplicitApproval, isExplicitDenial } from '../src/tools/local-tools.js';
import { ConversationAgent, observationText } from '../src/conversation/conversation-agent.js';
import { createConfiguredProvider, configuredProviderSummaries } from '../src/providers/configured-provider.js';
import { loadThetaProjectEnvironment, repositoryRoot } from '../src/environment.js';
import type { EffectApproval } from '../src/domain/effect-approval.js';
import { WebTaskStore, publicTask } from './task-store.js';
import { contentHash } from '../src/domain/research.js';
import type { Dataset } from '../src/domain/research.js';

interface WebMeta { id: string; projectId: string; createdAt: string; updatedAt: string; pinned: boolean; archived?: boolean }
interface WebCard { id: string; runId: string; contentHash: string; summary: string; createdAt: string; state: 'pending' | 'submitting' | 'approved' | 'rejected' | 'revised' | 'superseded' | 'expired' | 'failed'; feedback?: string; error?: string }
interface Project { id: string; name: string; createdAt: string; updatedAt: string; pinned: boolean; archived?: boolean }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const MAX_UPLOAD = 200 * 1024 * 1024;

/** Local HTTP transport for the same core used by the CLI; no workflow engine. */
export function createAgentServer(home: string, inferenceFactory = createConfiguredProvider) {
  const sessions = new ProductSessionStore(home);
  const records = new ResearchStore(home);
  const tools = new LocalProductTools({ runtimeDb: path.join(home, 'runtime.sqlite'), uploadDir: path.join(home, 'uploads'), inferenceFactory });
  const active = new Map<string, AbortController>();
  const tasks = new WebTaskStore(records);
  tasks.recover((id, lease) => sessions.release(id, lease));
  const inFlight = new Set<Promise<unknown>>();
  let shuttingDown = false;
  const metas = () => records.list<WebMeta>('web-session').filter(m => !m.archived);
  const webSession = (id: string) => {
    if (!metas().some(m => m.id === id)) throw new HttpError(404, '对话不存在或已归档。');
    return sessions.get(id);
  };
  const cardsFor = (id: string) => records.list<WebCard>('web-card').filter(c => c.runId === id);
  const syncCards = (session: ProductSession) => {
    const pending = session.pendingConfirmation;
    const previous = cardsFor(session.id);
    let expired = false;
    if (pending) { try { expired = records.get<EffectApproval>('effect-approval', pending.checkpointId).expiresAt < Date.now(); } catch { /* Legacy records may not include an effect. */ } }
    for (const card of previous) {
      if (card.state === 'pending' && (card.id !== pending?.checkpointId || card.contentHash !== pending.contentHash)) {
        records.put('web-card', card.id, { ...card, state: 'superseded' });
      } else if (card.state === 'pending' && expired) {
        records.put('web-card', card.id, { ...card, state: 'expired' });
      }
    }
    if (!active.has(session.id)) {
      for (const card of previous.filter(c => c.state === 'submitting')) {
        const execution = session.statisticalExecution;
        const completed = execution?.approvalId === card.id && execution.status === 'complete';
        records.put('web-card', card.id, {...card, state:completed ? 'approved' : pending?.checkpointId===card.id ? 'pending' : 'failed',
          error:completed ? undefined : '上次处理已中断。先核查已保存结果；未完成计算需要新的确认，不能重复提交旧卡。'});
      }
    }
    if (pending && !previous.some(c => c.id === pending.checkpointId)) {
      records.put('web-card', pending.checkpointId, { id: pending.checkpointId, runId: session.id, contentHash: pending.contentHash, summary: pending.summary, createdAt: new Date().toISOString(), state: expired ? 'expired' : 'pending' });
    }
  };
  const cardTitle = (summary: string) => /^确认执行统计分析/u.test(summary) ? '确认统计分析' : /^确认整理并解读/u.test(summary) ? '确认整理结果' : /^确认结合原始文本/u.test(summary) ? '确认深入解读' : /^.*取消.{0,12}[？?]/u.test(summary) ? '确认取消训练' : /^允许执行/u.test(summary) ? '确认启动训练' : '确认本次操作';
  const taskView = (session: ProductSession, taskId = session.webTaskId) => {
    if (!taskId) return undefined;
    const task = tasks.get(taskId); const view = publicTask(task);
    const execution = session.statisticalExecution;
    if (session.webTaskId !== taskId || task.status !== 'running' || !execution || execution.status !== 'running') return view;
    const file = path.join(home, 'statistics-progress', `${execution.analysisId}.json`);
    if (!existsSync(file)) return view;
    try { const progress = JSON.parse(readFileSync(file, 'utf8')); return {...view, progress:{completed:progress.completedSteps,total:progress.totalSteps}}; }
    catch { return view; }
  };
  const snapshot = (session: ProductSession) => {
    const state = tools.readState(session) as { lastObservedJob?: { status: string; percent: number; phase?: string } } | null;
    const job = state?.lastObservedJob;
    return { runId: session.id, projectId: records.get<WebMeta>('web-session', session.id).projectId,
      status: active.has(session.id) ? 'running' : session.pendingConfirmation ? 'waiting_human' : 'ready',
      task: taskView(session),
      currentState: 'Agent 对话', analysisMode: session.analysisMode ?? 'topic', eventCount: session.executionEvents?.length ?? 0,
      datasetRef: session.datasetRefs[0], conversationTitle: session.title, messageCount: session.messages.filter(m => m.role === 'user' || m.role === 'assistant' && m.content).length,
      lastMessageAt: session.updatedAt, lastEventAt: session.updatedAt,
      pendingReason: session.pendingConfirmation?.summary, pendingActionRef: session.pendingConfirmation?.checkpointId,
      trainingStatus: job?.status, trainingPercent: job?.percent, trainingPhase: job?.phase };
  };
  const checkpoint = (session: ProductSession) => session.pendingConfirmation ? {
    checkpointId: session.pendingConfirmation.checkpointId, kind: 'action', contentHash: session.pendingConfirmation.contentHash,
    summaryForUser: session.pendingConfirmation.summary, content: {}, warnings: [],
    view: { title: cardTitle(session.pendingConfirmation.summary), summary: session.pendingConfirmation.summary, sections: [] },
  } : null;
  const artifactUrl = (id: string, file: string) => `/api/v3/runs/${encodeURIComponent(id)}/files?path=${encodeURIComponent(file)}`;
  const conversation = (session: ProductSession) => { syncCards(session); return { runId: session.id, messages: [...session.messages.flatMap((m, index) => {
    if (!['user', 'assistant'].includes(m.role) || !m.content || m.metadata?.webHostEvent) return [];
    let content = String(m.metadata?.webUserText ?? m.content);
    if (m.role === 'assistant') content = content.replace(/\]\(<?(\/[^)>]+)>?\)/gu, (_, file: string) => `](${artifactUrl(session.id, file)})`);
    return [{ messageId: `${session.id}:${index}`, role: m.role, content, ...(m.metadata?.webError ? { messageKind: 'conversation.error' } : {}), createdAt: String(m.metadata?.webCreatedAt ?? records.get<WebMeta>('web-session', session.id).createdAt) }];
  }), ...cardsFor(session.id).map(card => ({
    messageId: `local.interaction.${session.id}.${card.id}`, role: 'assistant', messageKind: 'activity.interaction.snapshot', createdAt: card.createdAt,
    content: JSON.stringify({ runId: session.id, resolution: card.state, feedback: card.feedback, error: card.error, interaction: { source: 'agent', status: card.state, card: { kind: 'action_review', actionRef: card.id, contentHash: card.contentHash, title: cardTitle(card.summary), description: card.summary, requiresHumanAction: card.state === 'pending' } } }),
  }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }; };
  const activities = (session: ProductSession) => {
    const latest = new Map((session.executionEvents ?? []).map(e => [e.callId, e]));
    const recent = [...latest.values()].slice(-100).map(e => ({ eventId: e.callId, kind: e.kind, toolId: e.kind === 'tool' ? e.name : undefined, displayName: e.name, userMessage: e.detail ?? '', status: e.status, startedAt: e.startedAt, completedAt: e.status === 'started' ? undefined : e.timestamp, safeOutputSummary: `${e.status} · ${(e.durationMs / 1000).toFixed(1)}s` }));
    return { runId: session.id, recent, progress: { completedGates: 0, totalGates: 0, percent: 0, label: active.has(session.id) ? 'Agent 正在处理' : '等待你的消息' } };
  };
  async function locked<T>(id: string, fn: (s: ProductSession, save: () => void, signal: AbortSignal, lease: string) => Promise<T>) {
    if (active.has(id)) throw new HttpError(409, '当前对话正在处理上一条消息，请稍后继续。');
    const lease = sessions.acquire(id); const session = webSession(id); const controller = new AbortController(); active.set(id, controller);
    const timer = setInterval(() => sessions.renew(id, lease), 30000);
    const save = () => { sessions.save(session, lease); syncCards(session); };
    try { return await fn(session, save, controller.signal, lease); }
    finally { try { save(); } finally { clearInterval(timer); active.delete(id); sessions.release(id, lease); } }
  }
  async function turn(session: ProductSession, save: () => void, signal: AbortSignal, text: string, attachments: Array<{ kind: string; id: string }> = [], decision?: { action: string; checkpointId: string; expectedContentHash: string }, hostEvent = false) {
    const inference = inferenceFactory();
    if (!inference) throw new HttpError(503, '请先在 agent/.env.local 配置对话模型。');
    for (const attachment of attachments.filter(a => a.kind === 'dataset')) {
      const dataset = records.get<Dataset>('dataset', attachment.id);
      if (!session.datasetRefs.includes(dataset.datasetRef)) session.datasetRefs.push(dataset.datasetRef);
    }
    let input = text;
    if (decision) {
      const pending = session.pendingConfirmation;
      if (!pending || pending.checkpointId !== decision.checkpointId || pending.contentHash !== decision.expectedContentHash) throw new HttpError(409, '确认内容已变化，请刷新后重新查看。');
    }
    if (session.pendingConfirmation && (decision || isExplicitApproval(text) || isExplicitDenial(text))) {
      syncCards(session);
      const pending = session.pendingConfirmation;
      const card = records.get<WebCard>('web-card', pending.checkpointId);
      const approve = decision ? decision.action === 'approve' : isExplicitApproval(text);
      if (approve && card.state === 'expired') throw new HttpError(409, '这张确认卡已过期，请告诉 Agent 重新生成卡片。');
      records.put('web-card', card.id, { ...card, state: 'submitting', error: undefined });
      try {
        const receipt = approve ? await tools.approve(session, '确认', signal, save) : tools.deny(session, text);
        records.put('web-card', card.id, { ...card, error: undefined, state: approve ? 'approved' : decision?.action === 'revise' ? 'revised' : 'rejected', ...(!approve ? { feedback: text } : {}) });
        save();
        if (session.webTaskId && active.has(session.id)) tasks.update(session.webTaskId, {phase: approve ? '计算已返回，正在整理证据' : '正在根据反馈更新计划'});
        input = approve
          ? `用户明确确认刚展示的操作。主机执行回执：${observationText(receipt, 64000)}。依据真实状态继续。`
          : `用户${decision?.action === 'revise' ? '要求修改当前方案' : '拒绝当前操作'}，反馈：${JSON.stringify(text)}。主机回执：${observationText(receipt)}。${decision?.action === 'revise' ? '按反馈准备新方案和新的确认卡；未获新确认不能执行。' : '确认已拒绝，本次不执行，不要自行重新弹出相同操作。可以继续讨论。'}`;
      } catch (error) {
        records.put('web-card', card.id, { ...card, state: card.state === 'expired' ? 'expired' : session.pendingConfirmation ? 'pending' : 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    if (attachments.length) input += `\n主机已成功附加以下数据（不是目录候选，不需 dataset_use）：${JSON.stringify(attachments.filter(a => a.kind === 'dataset').map(a => ({ datasetRef: a.id, fileName: records.get<Dataset>('dataset', a.id).fileName })))}。直接用 dataset_understand 的 datasetRef 读取以上附件，不能把 datasetRef 当作 catalogId。不要发现或替换为其他文件。附件不代表计算授权。`;
    session.messages.push({ role: 'system', content: '当前宿主是网页对话界面。用户通过输入框旁的添加文件按钮上传文件，不能使用 CLI /attach 或拖入本地文件路径；不要建议终端命令。已交付报告由宿主提供可点击的浏览器链接。' });
    const start = session.messages.length;
    const saveTurn = () => {
      for (const m of session.messages.slice(start)) {
        m.metadata = { ...m.metadata, webCreatedAt: m.metadata?.webCreatedAt ?? new Date().toISOString(), ...(m.role === 'user' ? { webUserText: text, webHostEvent: hostEvent } : {}) };
      }
      save();
    };
    const agent = new ConversationAgent({ inference, tools, save: saveTurn, onEvent: event => {
      if (!session.webTaskId || event.kind !== 'tool') return;
      const task = tasks.get(session.webTaskId);
      if (task.status !== 'running') return;
      const phase = /plan|checkpoint|inspect/.test(event.name) ? '正在建立分析计划' : /results|knowledge/.test(event.name) ? '正在核查证据与撰写结果' : /dataset/.test(event.name) ? '正在理解数据' : '正在处理分析任务';
      tasks.update(task.id, {phase, lastOperation: event.name});
    } });
    try { return await agent.turn(session, input, signal, { userIntent: hostEvent ? '' : text }); }
    catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 600) : '响应处理失败';
      session.messages.push({ role: 'assistant', content: `本轮回复未能完成：${detail}\n已有训练与报告保留。${session.pendingSynthesis ? '本次解读授权和证据已保留，可以发送“重试解读”继续，不会重新训练。' : '可以重新发送消息继续。'}`, metadata: { webError: true } });
      throw error;
    }
    finally {
      saveTurn();
      const user = session.messages.slice(start).find(m => m.role === 'user');
      if (user) user.metadata = { ...user.metadata, webUserText: text, webHostEvent: hostEvent };
      save();
    }
  }
  const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, data })); };
  const readBody = async (req: IncomingMessage, max = 1024 * 1024) => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, '文件超过 200 MiB 或请求过大。'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/u.test(host)) throw new HttpError(403, '本地 Agent API 仅允许 localhost。');
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):(?:4320|4318)$/u.test(origin)) throw new HttpError(403, '来源不允许。');
      const url = new URL(req.url ?? '/', `http://${host}`); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? 'GET';
      if (parts[0] !== 'api' || parts[1] !== 'v3') throw new HttpError(404, '接口不存在。');
      if (parts[2] === 'health') return json(res, { service: 'theta-agent', mode: 'conversation', checks: [] });
      if (parts[2] === 'inference') {
        if (method !== 'GET') throw new HttpError(400, '此本地前端使用 agent/.env.local 的模型设置，修改后重启 API。');
        const provider = inferenceFactory();
        if (parts[3] === 'settings') return json(res, { readOnly: true, llm: { providerId: provider?.id ?? null, model: provider?.model ?? '', baseUrl: '', apiKeyConfigured: !!provider, reasoningMode: 'auto', reasoningEffort: 'high', reasoningBudgetTokens: null, temperature: 0.2, maxTokens: 4096, timeoutMs: 180000, streaming: false, typewriter: false, typewriterSpeedMs: 15 }, embedding: { enabled: false, providerId: 'local', model: '', baseUrl: '', dimensions: null, apiKeyConfigured: false } });
        return json(res, { kind: 'inference.provider.list', selection: provider ? { providerId: provider.id, model: provider.model, source: 'agent environment' } : null, providers: configuredProviderSummaries().map(p => ({ id: p.id, displayName: p.name, baseUrl: '', credentialConfigured: p.configured, configured: p.configured, configuredModel: p.model, selected: p.id === provider?.id, local: false, category: 'direct', models: [p.model], capabilities: { streaming: false, reasoning: true, reasoningEffort: false } })) });
      }
      if (parts[2] === 'projects') {
        const list = () => records.list<Project>('web-project').filter(p => !p.archived).map(p => ({ ...p, runIds: metas().filter(m => m.projectId === p.id).map(m => m.id) }));
        if (method === 'GET') return json(res, { projects: list() });
        const body = method === 'DELETE' ? {} : JSON.parse((await readBody(req)).toString());
        const previous = parts[3] ? records.get<Project>('web-project', parts[3]) : undefined;
        const project = { id: previous?.id ?? randomUUID(), name: String(body.name ?? previous?.name ?? '新项目').slice(0, 120), createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), pinned: body.pinned ?? previous?.pinned ?? false, archived: method === 'DELETE' };
        records.put('web-project', project.id, project); return json(res, { ...project, runIds: metas().filter(m => m.projectId === project.id).map(m => m.id) });
      }
      if (parts[2] === 'datasets') {
        const view = (d: Dataset) => ({ datasetRef: d.datasetRef, displayName: d.fileName, sizeBytes: d.sizeBytes, suffix: path.extname(d.fileName), createdAt: new Date().toISOString() });
        if (method === 'GET') return json(res, { datasets: records.list<Dataset>('dataset').map(view) });
        const raw = await readBody(req, MAX_UPLOAD + 1024 * 1024);
        const form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: new Uint8Array(raw) }).formData();
        const file = form.get('file');
        if (!(file instanceof File) || !file.size || file.size > MAX_UPLOAD) throw new HttpError(400, '请选择非空且不超过 200 MiB 的数据文件。');
        const tempDir = path.join(home, 'incoming', randomUUID()); mkdirSync(tempDir, { recursive: true });
        const filePath = path.join(tempDir, path.basename(file.name));
        try {
          writeFileSync(filePath, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
          const scratch: ProductSession = { id: `upload-${randomUUID()}`, title: '', datasetRefs: [], messages: [], updatedAt: new Date().toISOString() };
          const receipt = await tools.attach(filePath, scratch) as { datasetRef: string };
          return json(res, view(records.get<Dataset>('dataset', receipt.datasetRef)));
        } finally { rmSync(tempDir, { recursive: true, force: true }); }
      }
      if (parts[2] !== 'runs') throw new HttpError(404, '接口不存在。');
      if (!parts[3]) {
        if (method === 'GET') return json(res, { runs: metas().map(m => snapshot(sessions.get(m.id))) });
        const body = JSON.parse((await readBody(req)).toString());
        const session = body.sourceSessionId ? webSession(body.sourceSessionId) : sessions.create();
        if (!body.sourceSessionId) {
          if (body.analysisMode !== undefined && !['topic','free'].includes(body.analysisMode)) throw new HttpError(400, '分析模式无效');
          session.analysisMode = body.analysisMode ?? 'topic';
          session.title = String(body.researchGoal ?? '新的研究对话').slice(0, 120);
          records.put('web-session', session.id, { id: session.id, projectId: body.projectId, createdAt: session.updatedAt, updatedAt: session.updatedAt, pinned: false });
        }
        if (body.datasetRef) { records.get<Dataset>('dataset', body.datasetRef); if (!session.datasetRefs.includes(body.datasetRef)) session.datasetRefs.push(body.datasetRef); }
        sessions.save(session); return json(res, snapshot(session));
      }
      const id = parts[3]; let session = webSession(id); const action = parts.slice(4).join('/');
      if (!action && method === 'DELETE') { const meta = records.get<WebMeta>('web-session', id); records.put('web-session', id, { ...meta, archived: true }); return json(res, { runId: id }); }
      if (!action && method === 'PATCH') {
        const body = JSON.parse((await readBody(req)).toString());
        if (body.analysisMode !== undefined && active.has(id)) throw new HttpError(409, '当前正在执行，请结束后切换模式');
        await locked(id, async (s, save) => {
          if (body.analysisMode !== undefined) {
            if (!['topic','free'].includes(body.analysisMode)) throw new HttpError(400, '分析模式无效');
            if (s.pendingConfirmation || s.pendingSynthesis || s.pendingStatisticalInterpretation) throw new HttpError(409, '先结束当前执行或处理确认卡，再切换分析模式');
            s.analysisMode = body.analysisMode;
          }
          if (body.displayName) s.title = String(body.displayName).slice(0, 120); save();
        });
        return json(res, { runId: id, displayName: sessions.get(id).title, analysisMode: sessions.get(id).analysisMode ?? 'topic' });
      }
      if (!action) return json(res, snapshot(session));
      if (action.startsWith('tasks/') && method === 'GET') {
        const task = tasks.get(parts[5]);
        if (task.runId !== id) throw new HttpError(404, '任务不属于当前对话');
        return json(res, taskView(session, task.id));
      }
      if (action === 'conversation') return json(res, conversation(session));
      if (action === 'checkpoint') return json(res, checkpoint(session));
      if (action === 'activities') return json(res, activities(session));
      if (action === 'files') {
        const file = realpathSync(url.searchParams.get('path') ?? '');
        const allowed = (session.reports ?? []).some(r => {
          const root = realpathSync(path.dirname(r.reportPath)); const rel = path.relative(root, file); return (!rel.startsWith('..') && !path.isAbsolute(rel)) || r.files.some(artifact => { try { return realpathSync(artifact.path) === file; } catch { return false; } });
        }) || (session.statisticalReports ?? []).some(r => r.files.some(f => {try{return realpathSync(f.path)===file;}catch{return false;}})) || (session.interpretations ?? []).some(i => realpathSync(i.documentPath) === file);
        const skillAllowed=(session.skillArtifacts??[]).some(f=>{try{return realpathSync(f.path)===file;}catch{return false;}});
        if ((!allowed && !skillAllowed) || !statSync(file).isFile()) throw new HttpError(403, '文件不属于当前对话的已交付报告。');
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json', '.log': 'text/plain; charset=utf-8' };
        let content = readFileSync(file);
        if (path.extname(file) === '.html') content = Buffer.from(content.toString().replace(/(href|src)=["']([^"']+)["']/gu, (match, attr, target) => {
          if (/^(?:https?:|data:|#|\/api\/)/iu.test(target)) return match;
          const localPath = target.startsWith('file:') ? fileURLToPath(target) : path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]));
          return `${attr}="${artifactUrl(id, localPath)}"`;
        }));
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox allow-scripts allow-downloads; default-src 'self' data: https://cdn.plot.ly https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plot.ly https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'" }); res.end(content); return;
      }
      if (action === 'activities/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        let last = '';
        const send = () => { try { const s = sessions.get(id); const value = JSON.stringify({ snapshot: snapshot(s), checkpoint: checkpoint(s), conversation: conversation(s), activity: activities(s) }); if (value !== last) { res.write(`event: sync\ndata: ${value}\n\n`); last = value; } else res.write(': heartbeat\n\n'); } catch { res.end(); } };
        send(); const timer = setInterval(send, 1000); res.on('close', () => clearInterval(timer)); return;
      }
      if (action === 'stop' && method === 'POST') { active.get(id)?.abort(); return json(res, { stopped: true }); }
      if (method !== 'POST' || !['messages', 'checkpoint-decision'].includes(action)) throw new HttpError(404, '当前 Agent 使用自然语言对话，不提供旧工作流接口。');
      const body = JSON.parse((await readBody(req)).toString());
      if (action === 'checkpoint-decision') {
        if (!['approve', 'reject', 'revise'].includes(body.action) || typeof body.checkpointId !== 'string' || typeof body.expectedContentHash !== 'string') throw new HttpError(400, '确认操作无效，请重新查看卡片。');
        if (body.action === 'revise' && (typeof body.feedback !== 'string' || !body.feedback.trim())) throw new HttpError(400, '请填写要修改的内容。');
      }
      const text = String(body.content ?? body.feedback ?? (body.action === 'approve' ? '确认' : body.action === 'reject' ? '拒绝本次操作，暂不执行。' : '')).trim();
      if (!text || text.length > 16000) throw new HttpError(400, '消息需包含 1–16000 个字符。');
      if (body.async === true) {
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw new HttpError(400, '需要有效的请求编号');
        const request = {action, text, attachments: body.attachments ?? [], ...(action === 'checkpoint-decision' ? {decision: {action: body.action, checkpointId: body.checkpointId, expectedContentHash: body.expectedContentHash}} : {})};
        const previous = tasks.find(id, body.requestId);
        if (previous) {
          if (previous.fingerprint !== contentHash(request)) throw new HttpError(409, '同一请求编号不能用于不同内容');
          return json(res, {...snapshot(sessions.get(id)), task: publicTask(previous)}, 202);
        }
        if (active.has(id)) throw new HttpError(409, '当前对话正在处理任务，请等待或停止当前任务');
        if (action === 'checkpoint-decision' && (!session.pendingConfirmation || session.pendingConfirmation.checkpointId !== body.checkpointId || session.pendingConfirmation.contentHash !== body.expectedContentHash)) throw new HttpError(409, '确认内容已变化，请刷新后重新查看。');
        if (!inferenceFactory()) throw new HttpError(503, '请先配置对话模型');
        const objective = action === 'checkpoint-decision' && body.action === 'approve' ? session.pendingConfirmation?.summary.split('\n').find(line => line.startsWith('问题：'))?.slice(3) ?? text : text;
        const task = tasks.create(id, body.requestId, request, objective);
        let taskSignal: AbortSignal | undefined;
        const work = locked(id, async (s, save, signal, lease) => {
          taskSignal = signal;
          s.webTaskId = task.id; save();
          tasks.update(task.id, {status: 'running', lease, phase: action === 'checkpoint-decision' && body.action === 'approve' ? '正在执行已确认的操作' : '正在理解数据与研究目标'});
          const answer = await turn(s, save, signal, text, body.attachments ?? [], action === 'checkpoint-decision' ? body : undefined);
          const status = shuttingDown ? 'interrupted' : signal.aborted ? 'cancelled' : /本轮等待已达到时间上限/.test(answer ?? '') ? 'interrupted' : s.pendingConfirmation ? 'waiting_human' : 'completed';
          tasks.update(task.id, {status, completedAt: new Date().toISOString(), phase: status === 'waiting_human' ? '计划已保存，等待确认' : status === 'completed' ? '本轮处理完成' : '已暂停，记录保留'});
        }).catch(error => {
          tasks.update(task.id, {status: shuttingDown ? 'interrupted' : taskSignal?.aborted ? 'cancelled' : 'failed', phase: '本轮未完成，记录保留', error: error instanceof Error ? error.message.slice(0, 1000) : String(error), completedAt: new Date().toISOString()});
        });
        inFlight.add(work); void work.finally(() => inFlight.delete(work));
        return json(res, {...snapshot(sessions.get(id)), task: publicTask(tasks.get(task.id))}, 202);
      }
      await locked(id, (s, save, signal) => turn(s, save, signal, text, body.attachments ?? [], action === 'checkpoint-decision' ? body : undefined));
      return json(res, snapshot(sessions.get(id)));
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(error instanceof HttpError ? error.status : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'AGENT_ERROR', message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  const monitor = setInterval(() => {
    for (const meta of metas()) {
      if (active.has(meta.id) || !sessions.get(meta.id).monitorTraining) continue;
      void locked(meta.id, async (s, save, signal) => {
        const result = await tools.execute('run_status', {}, { session: s, userMessage: '', save }); save();
        if (!s.monitorTraining) await turn(s, save, signal, `主机训练监控事件，不是用户授权：${observationText(result)}。说明真实状态，完成时请求 results_read 的独立确认，不要自动开始训练。`, [], undefined, true);
      }).catch(error => console.error('Training monitor:', error instanceof Error ? error.message : String(error)));
    }
  }, 3000);
  monitor.unref(); server.on('close', () => { shuttingDown = true; clearInterval(monitor); for (const controller of active.values()) controller.abort(); void Promise.allSettled([...inFlight]).then(() => sessions.close()); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadThetaProjectEnvironment();
  const home = path.resolve(process.env.THETA_AGENT_HOME ?? path.join(repositoryRoot(), '.theta_agent'));
  const port = Number(process.env.THETA_AGENT_API_PORT ?? 4318);
  createAgentServer(home).listen(port, '127.0.0.1', () => console.log(`THETA Agent API http://127.0.0.1:${port} · ${home}`));
}
