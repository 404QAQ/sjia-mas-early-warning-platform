import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_KEY, installWx, settle } from './helpers/wechat-runtime.mjs';
import { ApiFailure, request, session, saveSession, clearSession, switchActor } from '../dist/api.js';

const original = { accessToken: 'old-access', refreshToken: 'old-refresh', userId: 'user-1', actorIds: ['actor-1', 'actor-2'], actorId: 'actor-1', role: 'PATIENT', patientId: 'patient-1' };
const rotated = { accessToken: 'new-access', refreshToken: 'new-refresh', userId: original.userId, actorIds: original.actorIds };
const expired = [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }];
const ok = value => [200, { data: value }];
const isStale = error => error instanceof ApiFailure && error.status === 409;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const actors = [1, 2].map(index => ({ id: `actor-${index}`, patientId: `patient-${index}`, relation: 'SELF', activeFrom: '2020-01-01T00:00:00.000Z' }));

test('并行请求触发合法 token 轮换时，旧 token 已成功的患者摘要、趋势和报告仍可读取', async () => {
  const delayed = deferred();
  const { calls } = installWx((path, options) => {
    if (path === '/api/v1/auth/refresh') return ok(rotated);
    if (path === '/medications') return options.header.authorization === 'Bearer old-access' ? expired : ok('medications');
    return delayed.promise.then(() => ok(path));
  }, { session: original });
  const reads = ['/summary', '/trend', '/visit-summary'].map(path => request(path));
  const outcome = Promise.all(reads);
  await request('/medications');
  assert.equal(session().accessToken, rotated.accessToken);
  delayed.resolve();
  assert.deepEqual(await outcome, ['/summary', '/trend', '/visit-summary']);
  assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 1);
});

test('同批旧 token 的迟到 401 使用已轮换的 token 重试，不发起第二次刷新', async () => {
  const delayed = deferred();
  const { calls } = installWx((path, options) => {
    if (path === '/api/v1/auth/refresh') return ok(rotated);
    if (options.header.authorization !== 'Bearer old-access') return ok(path);
    return path === '/late' ? delayed.promise : expired;
  }, { session: original });
  const late = request('/late');
  await request('/first');
  delayed.resolve(expired);
  assert.equal(await late, '/late');
  assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 1);
  assert.deepEqual(calls.requests.filter(item => item.path === '/late').map(item => item.header.authorization), ['Bearer old-access', 'Bearer new-access']);
});

test('退出、换账号、同账号重新登录后，迟到成功与迟到 401 都不得进入新会话或重放', async () => {
  for (const change of [
    () => clearSession(),
    () => saveSession({ ...original, userId: 'another-user', accessToken: 'another-access', refreshToken: 'another-refresh' }),
    () => saveSession({ ...original, ...rotated }),
    () => { clearSession(); saveSession(original); },
    () => saveSession(original),
  ]) {
    for (const reply of [ok('private old result'), expired]) {
      const delayed = deferred();
      const { calls } = installWx(() => delayed.promise, { session: original });
      const pending = assert.rejects(request('/old-request'), isStale);
      change();
      delayed.resolve(reply);
      await pending;
      assert.equal(calls.requests.length, 1, '旧请求不得携新身份重放，也不得刷新新会话');
    }
  }
});

test('actor 切走又切回后，原身份的旧成功回包仍须丢弃', async () => {
  const delayed = deferred();
  installWx(path => path === '/api/v1/auth/actors' ? ok(actors) : delayed.promise, { session: original });
  const pending = assert.rejects(request('/old-request'), isStale);
  await switchActor('actor-2');
  await switchActor('actor-1');
  delayed.resolve(ok('private old result'));
  await pending;
  assert.equal(session().actorId, original.actorId);
});

test('刷新中切换 actor 只合并新 token，原请求不跨患者重放', async () => {
  const refresh = deferred();
  const { storage, calls } = installWx(path => path === '/api/v1/auth/refresh' ? refresh.promise : expired, { session: original });
  const pending = assert.rejects(request('/old-request'), isStale);
  await settle();
  storage.set(SESSION_KEY, { ...original, actorId: 'actor-2', patientId: 'patient-2' });
  refresh.resolve(ok(rotated));
  await pending;
  assert.equal(session().accessToken, rotated.accessToken);
  assert.equal(session().actorId, 'actor-2');
  assert.equal(session().patientId, 'patient-2');
  assert.equal(calls.requests.filter(item => item.path === '/old-request').length, 1);
});

test('旧登录的刷新尚未结束时，新登录可独立刷新，旧拒绝不能清除新会话', async () => {
  const oldRefresh = deferred();
  const next = { ...original, accessToken: 'login-access', refreshToken: 'login-refresh' };
  const finalTokens = { ...rotated, accessToken: 'final-access', refreshToken: 'final-refresh' };
  const { calls } = installWx((path, options) => {
    if (path === '/api/v1/auth/refresh') return options.data.refreshToken === original.refreshToken ? oldRefresh.promise : ok(finalTokens);
    return options.header.authorization === 'Bearer final-access' ? ok('new result') : expired;
  }, { session: original });
  const old = assert.rejects(request('/old-request'), isStale);
  await settle();
  saveSession(next);
  assert.equal(await request('/new-request'), 'new result');
  oldRefresh.resolve(expired);
  await old;
  assert.equal(session().accessToken, finalTokens.accessToken);
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 2);
});

test('旧身份的 403 核验迟到 401，不得刷新或清除新登录', async () => {
  const probe = deferred();
  const next = { ...original, userId: 'new-user', accessToken: 'login-access', refreshToken: 'login-refresh' };
  const { calls } = installWx(path => {
    if (path === '/api/v1/auth/actors') return probe.promise;
    if (path === '/api/v1/auth/refresh') return expired;
    return [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }];
  }, { session: original });
  const pending = assert.rejects(request('/old-request'), isStale);
  await settle();
  saveSession(next);
  probe.resolve(expired);
  await pending;
  assert.equal(session().userId, next.userId);
  assert.equal(session().accessToken, next.accessToken);
  assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 0);
  assert.equal(calls.navigations.length, 0);
});

test('切换 actor 后，旧 403 核验的空身份列表或有效列表都不得作用于新身份', async () => {
  for (const reply of [ok([]), ok(actors), expired]) {
    const probe = deferred();
    const { storage, calls } = installWx(path => path === '/api/v1/auth/actors' ? probe.promise : [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }], { session: original });
    const pending = assert.rejects(request('/old-request'), isStale);
    await settle();
    storage.set(SESSION_KEY, { ...original, actorId: 'actor-2', patientId: 'patient-2' });
    probe.resolve(reply);
    await pending;
    assert.equal(session().actorId, 'actor-2');
    assert.equal(session().patientId, 'patient-2');
    assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 0);
    assert.equal(calls.navigations.length, 0);
  }
});
