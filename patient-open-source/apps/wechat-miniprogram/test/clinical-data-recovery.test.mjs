import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, SESSION_KEY } from './helpers/wechat-runtime.mjs';
const registered = capturePages();
const { clinicalMutation } = await import('../dist/clinical-data.js');
const { clearSession } = await import('../dist/api.js');
const { archiveScopeKey } = await import('../dist/clinical-archive.js');
const reportPage = await loadPage(registered, new URL('../dist/pages/patient/report.js', import.meta.url).href);
const archivePage = await loadPage(registered, new URL('../dist/pages/patient/archive.js', import.meta.url).href);
const scope = { userId: 'user-1', actorId: 'actor-1', patientId: 'patient-1' };
const session = { ...scope, accessToken: 'access', refreshToken: 'refresh', actorIds: [scope.actorId], role: 'PATIENT' };
const key = `${archiveScopeKey(scope)}:pending:vitals:new`;
const path = '/api/v1/patients/patient-1/auxiliary-vitals';
const send = payload => clinicalMutation(scope, 'vitals:new', path, 'POST', payload, row => row);

test('断网结果未知后重进页面，先确认原命令；不同新草稿须再次明确保存', async () => {
  let online = false; const committed = new Map();
  const { storage, calls } = installWx((_, options) => {
    if (!committed.has(options.data.idempotencyKey)) committed.set(options.data.idempotencyKey, options.data);
    return online ? [200, { data: committed.get(options.data.idempotencyKey) }] : 'NETWORK';
  }, { session });
  const old = { recordedAt: '2026-10-14T00:00:00Z', heartRate: 100 };
  const draft = { recordedAt: '2026-10-15T00:00:00Z', heartRate: 105 };
  await assert.rejects(send(old), /网络/);
  const originalKey = storage.get(key).idempotencyKey;
  online = true;
  await assert.rejects(send(draft), /上次保存已确认.*当前填写的内容尚未保存/);
  assert.equal(committed.size, 1);
  assert.equal(calls.requests[1].data.idempotencyKey, originalKey);
  assert.equal(calls.requests[1].data.recordedAt, old.recordedAt);
  assert.equal(storage.has(key), false);
  const result = await send(draft);
  assert.equal(result.heartRate, 105); assert.equal(committed.size, 2);
});

test('408/429保留命令，不换幂等键；明确400拒绝释放命令', async () => {
  for (const status of [408, 429, 400]) {
    let first = true;
    const { storage, calls } = installWx((_, options) => {
      if (first) { first = false; return [status, { error: { message: '请重试' } }]; }
      return [200, { data: options.data }];
    }, { session });
    await assert.rejects(send({ heartRate: 100 }));
    assert.equal(storage.has(key), status !== 400);
    await send({ heartRate: 100 });
    assert.equal(calls.requests[0].data.idempotencyKey === calls.requests[1].data.idempotencyKey, status !== 400);
  }
});

test('损坏的待确认payload不递归、不覆盖、不提交', async () => {
  const { storage, calls } = installWx(() => [500, {}], { session });
  storage.set(key, { idempotencyKey: 'old', fingerprint: '{"a":1}', payload: { a: 2 } });
  await assert.rejects(send({ a: 3 }), /待确认内容无效/);
  assert.equal(calls.requests.length, 0); assert.equal(storage.get(key).idempotencyKey, 'old');
});

test('退出身份清理临床待提交正文和附件缓存，保留另一身份和旧资料', () => {
  const { storage } = installWx(() => [500, {}], { session });
  const otherKey = `${archiveScopeKey({ ...scope, patientId: 'other' })}:pending:vitals:new`;
  storage.set(key, { payload: { content: '正文' } }); storage.set(otherKey, { payload: {} });
  const legacy = archiveScopeKey(scope); storage.set(legacy, { records: [{ title: '旧资料' }] });
  const upload = `${legacy}:upload:1`; storage.set(upload, 'artifact-1');
  clearSession();
  assert.equal(storage.has(key), false); assert.equal(storage.has(upload), false);
  assert.equal(storage.has(otherKey), true); assert.equal(storage.has(legacy), true);
});

test('报告Tab切换身份解除旧导入忙碌并清空旧分类计数', async () => {
  const { storage } = installWx(() => [200, { data: { records: [] } }], { session });
  const page = instantiate(reportPage); await page.onShow();
  page.setData({ importing: true, legacyCount: 3 });
  storage.set(SESSION_KEY, { ...session, patientId: 'other' }); await page.onShow();
  assert.equal(page.data.importing, false); assert.equal(page.data.legacyCount, 0);
});

test('原图下载403不打开图片，清除已显示的档案与草稿', async () => {
  let previewed = false;
  installWx(() => [200, { data: { url: 'grant' } }], { session, extra: {
    downloadFile: options => options.success({ statusCode: 403, tempFilePath: '/tmp/denied' }),
    previewImage: () => { previewed = true; },
  } });
  const page = instantiate(archivePage); page.scope = scope;
  page.allRows = [{ id: 'record', artifactId: 'artifact-1' }];
  page.setData({ rows: page.allRows, mode: 'detail', detail: page.allRows[0], draft: { content: '旧正文' } });
  await page.preview();
  assert.equal(previewed, false); assert.equal(page.data.detail, null); assert.deepEqual(page.allRows, []);
  assert.equal(page.data.draft.content, ''); assert.match(page.data.error, /权限/);
});
