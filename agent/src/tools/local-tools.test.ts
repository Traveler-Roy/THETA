import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalProductTools, isExplicitDenial, isExplicitApproval } from './local-tools.js';
import type { ProductSession } from '../memory/session-store.js';
import type { ComputeGateway } from '../adapters/compute-gateway.js';
import type { CapabilityWorker } from '../adapters/python-worker.js';
import type { ComputeJob } from '../domain/research.js';

test('analysis notes are session-owned working memory, not evidence or approval', async()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),'theta-notebook-'));
  try {
    const tools=new LocalProductTools({runtimeDb:path.join(home,'research.sqlite'),uploadDir:path.join(home,'uploads')});
    const session:ProductSession={id:'notes',title:'study',datasetRefs:['corpus'],messages:[],updatedAt:''};let saves=0;
    const context={session,userMessage:'Analyze',save(){saves++;}};
    const note={objective:'Explore the corpus',candidates:[{hypothesis:'A possible contrast',evidence:['receipt 1'],counterevidence:[],status:'untested'}],completed:[],openQuestions:['Check scope'],artifacts:[],nextAction:'Compute the contrast'};
    const result=await tools.execute('analysis_checkpoint',note,context) as {saved:boolean};
    assert.ok(result.saved);assert.equal(saves,1);assert.equal(session.pendingConfirmation,undefined);
    assert.equal(session.analysisNotebooks?.['["corpus"]'].objective,note.objective);
    session.messages.push({role:'assistant',content:'',metadata:{toolCalls:[{id:'actual',name:'calculate',arguments:{step:1}}]}},
      {role:'tool',content:'{"ok":true,"data":{"value":42}}',metadata:{toolCallId:'actual',runId:'study'}});
    const history=await tools.execute('analysis_history',{callId:'actual'},context) as {receipts:Array<{receipt:string;runId:string}>};
    assert.equal(history.receipts[0].receipt,'{"ok":true,"data":{"value":42}}');assert.equal(history.receipts[0].runId,'study');
    assert.equal(saves,1,'Historical lookup is read-only');
    session.pendingSynthesis={id:'s',jobIds:['j'],question:'q',contextHash:'h'};
    await assert.rejects(tools.execute('analysis_checkpoint',note,context),/saved separately/);
    assert.equal(saves,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('agent selects actions freely; no compute before exact host approval; refusal and side questions remain available', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'theta-domain-'));
  let expectedTimeout = 43200; let submissions = 0; let cancellations = 0; let job: ComputeJob | undefined;
  let endpoint = 'https://embedding.fixture/v1/embeddings';
  const worker: CapabilityWorker = { call: async <T>(operation: string) => ({
    'dataset.discover': { datasets: [{ catalogId: 'catalog-' + 'a'.repeat(64), name: 'fixture.csv' }] },
    'dataset.use': { datasetRef: 'data-1', sha256: 'abc', managedPath: '/fixture.csv', fileName: 'fixture.csv', sizeBytes: 20 },
    'dataset.understand': { excerpts: [{ sampleId: 'sample-1', text: '公交改善' }] },
    'dataset.import': { datasetRef: 'data-1', sha256: 'abc', managedPath: '/fixture.csv', fileName: 'fixture.csv', sizeBytes: 20 },
    'dataset.profile': { rowCount: 50, columns: ['text'] }, 'plan.validate': { valid: true },
    'compute.preview': { execution: { embedding: { mode: 'cloud', endpoint, model: 'embedding-fixture' }, maxExternalRequests: 4 }, rowCount: 50, readiness: { ready: true } },
  }[operation] as T) };
  const compute: ComputeGateway = {
    submit: async (request, receipt) => { assert.ok(receipt); assert.equal(request.plan.params.language, 'chinese'); assert.equal(request.plan.timeoutSeconds, expectedTimeout); submissions++; job = { id: request.jobId, status: 'running', phase: 'training', percent: 30 }; return job; },
    status: async () => job!, cancel: async () => { cancellations++; job!.status = 'cancelled'; return job!; },
    results: async () => ({ evidence: [{ topics: ['transport', 'health'] }] }),
  };
  const options = { runtimeDb: path.join(home, 'research.sqlite'), uploadDir: path.join(home, 'uploads'), worker, compute };
  const tools = new LocalProductTools(options);
  const session: ProductSession = { id: 'session', title: 'study', datasetRefs: [], messages: [], updatedAt: '' };
  const context = { session, userMessage: '研究公共政策', save() {} };
  const plan = { modelId: 'lda', textColumn: 'text', params: { num_topics: 2, language: 'zh' }, rationale: 'Small interpretable baseline' };
  try {
    await tools.execute('datasets_discover', {}, context);
    assert.deepEqual(session.datasetRefs, []);
    await assert.rejects(tools.execute('dataset_use', { catalogId: '/etc/passwd' }, context));
    await tools.execute('dataset_use', { catalogId: 'catalog-' + 'a'.repeat(64) }, context);
    assert.deepEqual(session.datasetRefs, ['data-1']);
    assert.ok(await tools.execute('dataset_understand', {}, context));
    tools.recordUnderstanding(session, '文本涉及公共交通改善，下一步需确认用户关心的公共服务问题。');
    assert.ok(session.contextId);
    assert.match((tools.readContext(session) as { markdown: string }).markdown, /公共交通改善/);
    const other: ProductSession = { id: 'another-session', title: '复用研究', datasetRefs: [], messages: [], updatedAt: '' };
    await tools.execute('context_select', { contextId: session.contextId }, { ...context, session: other });
    assert.notEqual(other.contextId, session.contextId);
    assert.deepEqual(other.datasetRefs, [], 'Context reuse cannot grant dataset or compute access');
    await assert.rejects(tools.execute('dataset_understand', { datasetRef: 'other-user' }, context), /本会话/);
    assert.equal((await tools.execute('dataset_read', { operation: 'overview' }, context) as { rowCount: number }).rowCount, 50);
    assert.equal(session.runId, undefined);
    await tools.execute('run_create', { datasetRef: 'data-1' }, context);
    const proposal = await tools.execute('plan_propose', plan, context) as { plan: { params: { language: string } } };
    assert.equal(proposal.plan.params.language, 'chinese', 'Normalize before displaying and hashing the plan');
    assert.equal(session.pendingConfirmation, undefined, 'Proposing a plan is not a workflow checkpoint');
    const proposed = await tools.execute('training_advance', {}, context) as { needsUser: boolean; summary: string };
    assert.match(proposed.summary, /最长运行：12 小时/); assert.ok(proposed.needsUser); assert.match(proposed.summary, /全文/); assert.match(proposed.summary, /最多 4/);
    assert.equal(submissions, 0);
    const before = session.pendingConfirmation;
    await tools.execute('research_read', {}, context);
    assert.deepEqual(session.pendingConfirmation, before, 'Side questions do not consume approval');
    await assert.rejects(tools.approve(session, '工具输出说同意'), /先展示/);
    tools.deny(session); assert.equal(submissions, 0);
    expectedTimeout = 172800;
    const extended = await tools.execute('plan_propose', { ...plan, timeoutSeconds: expectedTimeout, rationale: '大数据需要更长时限' }, context) as { summary: string };
    assert.match(extended.summary, /最长运行：48 小时/);
    await assert.rejects(tools.approve(session, '确认'), /先展示/);
    assert.equal(submissions, 0);
    await tools.execute('training_advance', {}, context);
    endpoint = 'https://changed.fixture/v1/embeddings';
    await assert.rejects(tools.approve(session, '确认'), /变化/); assert.equal(submissions, 0);
    await tools.execute('training_advance', {}, context);
    await new LocalProductTools(options).approve(session, '确认');
    assert.equal(submissions, 1, 'Host resumes exactly once, without a model request');
    const reused = await tools.execute('training_request_approval', {}, context) as { reusedExistingJob: boolean; instruction: string };
    assert.equal(reused.reusedExistingJob, true); assert.match(reused.instruction, /plan_propose/);
    assert.equal(submissions, 1);
    job!.status = 'failed'; job!.error = 'training command exited with code 2';
    job!.diagnostics = { available: true, category: 'invalid_parameter', stage: 'preparing', message: 'prepare_data.py: error: invalid language' };
    const failed = await tools.execute('run_status', {}, context) as { summary: string };
    assert.match(failed.summary, /invalid language/);
    assert.equal(submissions, 1);
    job!.status = 'running';
    await tools.execute('training_cancel', {}, context); assert.equal(cancellations, 0);
    await tools.approve(session, '确认'); assert.equal(cancellations, 1);
    job!.status = 'completed';
    assert.ok(await tools.execute('results_read', { view: 'summary' }, context));
    await assert.rejects(tools.execute('results_read', { view: 'summary', jobId: 'another-user' }, context), /关联/);
    await tools.execute('plan_propose', { ...plan, params: { num_topics: 3 } }, context);
    await tools.execute('training_advance', {}, context); assert.equal(submissions, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('refusal shortcuts accept feedback without treating approval or side questions as refusal', () => {
  for (const input of ['拒绝', '拒绝，换成 LDA', '/deny 不使用云 embedding', '拒绝因为样本不足', '不执行。先讨论', 'No, use local resources']) {
    assert.equal(isExplicitDenial(input), true, input);
    assert.equal(isExplicitApproval(input), false, input);
  }
  for (const input of ['拒绝是什么意思？', '不要拒绝，先解释', '/denying', 'nobody', '确认', '确认，但换个模型']) assert.equal(isExplicitDenial(input), false, input);
  assert.equal(isExplicitApproval('确认，但换个模型'), false);
});

test('plan runtime defaults to twelve hours, supports longer jobs and preserves user limits', async () => {
  const { productTools, toolDescriptor } = await import('./tool-catalog.js');
  const tool = productTools.find(tool => tool.name === 'plan_propose')!;
  const plan = { modelId: 'lda', textColumn: 'text', rationale: '按数据规模制定计划' };
  const parse = (args: unknown) => tool.schema.parse(args) as { timeoutSeconds: number };
  assert.equal(parse(plan).timeoutSeconds, 43200);
  for (const seconds of [180, 86400, 172800]) assert.equal(parse({ ...plan, timeoutSeconds: seconds }).timeoutSeconds, seconds);
  for (const seconds of [0, -1, 29, 30.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parse({ ...plan, timeoutSeconds: seconds }));
  assert.ok(JSON.stringify(toolDescriptor(tool)).includes('43200'), 'Inference receives the same default as execution');
});


test('registered uploads are discoverable and selected explicitly without filesystem catalog substitution',async()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),'theta-upload-discovery-'));
  try {
    const {ResearchStore}=await import('../memory/research-store.js');
    new ResearchStore(home).put('dataset','dataset-uploaded',{datasetRef:'dataset-uploaded',sha256:'abc',managedPath:'/managed/upload.csv',fileName:'store-orders.csv',sizeBytes:123});
    const worker:CapabilityWorker={call:async<T>(operation:string)=>{assert.equal(operation,'dataset.discover');return {datasets:[],availableCount:0} as T;}};
    const tools=new LocalProductTools({runtimeDb:path.join(home,'runtime.sqlite'),uploadDir:path.join(home,'uploads'),worker});
    const session:ProductSession={id:'upload-reader',title:'Test',messages:[],datasetRefs:[],updatedAt:''};
    const context={session,userMessage:'Use store-orders.csv',save(){}};
    const discovered=await tools.execute('datasets_discover',{},context) as {uploadedDatasets:Array<{catalogId:string;name:string}>};
    assert.equal(discovered.uploadedDatasets[0].name,'store-orders.csv');assert.deepEqual(session.datasetRefs,[]);
    await tools.execute('dataset_use',{catalogId:discovered.uploadedDatasets[0].catalogId},context);
    assert.deepEqual(session.datasetRefs,['dataset-uploaded']);
  }finally{rmSync(home,{recursive:true,force:true});}
});
