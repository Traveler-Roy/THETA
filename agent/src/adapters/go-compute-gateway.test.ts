import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoComputeGateway, goConfigurationFingerprint } from './go-compute-gateway.js';
import { EffectApprovals } from '../domain/effect-approval.js';
import { ResearchStore } from '../memory/research-store.js';

test('Go gateway binds host-owned dataset/model mappings, restores task IDs and fences uncertain submissions', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'theta-go-'));
  const previous = process.env.THETA_COMPUTE_BINDINGS;
  const bindings = path.join(home, 'bindings.json');
  process.env.THETA_COMPUTE_BINDINGS = bindings;
  writeFileSync(bindings, JSON.stringify({ userId: 'user', projectId: 'project', datasets: { dataset: { ref: 'registered', sha256: 'sha', textColumn: 'text' } }, models: { lda: { modelId: 7 }, theta: { modelId: 8 } } }));
  const store = new ResearchStore(home);
  let posts = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; const body = JSON.parse(String(init.body)); assert.equal(body.dataset_ref, 'registered');
      if (body.model_id === 8) assert.equal(body.params.embedding_provider, 'local');
    }
    return Response.json({ id: 42, status: 'running', phase: 'training', progress: 60 });
  };
  const request = { jobId: 'job-one', runId: 'run', execution: { computeConfigurationFingerprint: goConfigurationFingerprint() }, dataset: { datasetRef: 'dataset', sha256: 'sha', fileName: 'data.csv', managedPath: '/local', sizeBytes: 10 }, plan: { modelId: 'lda', textColumn: 'text', params: {}, rationale: 'baseline', timeoutSeconds: 30 } };
  try {
    const approvals = new EffectApprovals(store);
    const permit = (payload: typeof request) => { const value = approvals.request('session', { action: 'compute.submit', target: 'http://127.0.0.1:8080', payload, summary: 'test task' }); return approvals.decide(value.id, 'session', value.hash, true); };
    const receipt = permit(request);
    const gateway = new GoComputeGateway('http://127.0.0.1:8080', store, fetcher);
    await assert.rejects(gateway.submit(request), /确认/); assert.equal(posts, 0);
    assert.equal((await gateway.submit(request, receipt)).percent, 60);
    await new GoComputeGateway('http://127.0.0.1:8080', store, fetcher).submit(request, receipt);
    assert.equal(posts, 1);
    const theta = { ...request, jobId: 'job-theta', plan: { ...request.plan, modelId: 'theta' } };
    await gateway.submit(theta, permit(theta));
    assert.equal(posts, 2);
    await assert.rejects(gateway.submit({ ...request, plan: { ...request.plan, params: { num_topics: 2 } } }, receipt), /变化/);
    const failing = new GoComputeGateway('http://127.0.0.1:8080', store, async () => { throw new Error('network interrupted'); });
    const uncertain = { ...request, jobId: 'job-uncertain' }; const uncertainReceipt = permit(uncertain);
    await assert.rejects(failing.submit(uncertain, uncertainReceipt), /network/);
    await assert.rejects(failing.submit(uncertain, uncertainReceipt), /不确定/);
  } finally { if (previous === undefined) delete process.env.THETA_COMPUTE_BINDINGS; else process.env.THETA_COMPUTE_BINDINGS = previous; rmSync(home, { recursive: true, force: true }); }
});
