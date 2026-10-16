import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const port = 4387;
let child;
let base;

test.before(async () => {
  child = spawn(process.execPath, ['src/server.mjs'], { cwd: dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, ''), env: { ...process.env, PORT: String(port), PATIENT_API_MODE: 'fixture' }, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* 等待监听 */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('patient-api fixture 未能启动');
});

test.after(() => child?.kill('SIGTERM'));

test('fixture 登录、患者范围和医生路径边界', async () => {
  const login = await fetch(`${base}/api/v1/auth/wechat/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'demo-auto-login' }) });
  assert.equal(login.status, 200);
  const session = (await login.json()).data;
  const headers = { authorization: `Bearer ${session.accessToken}`, 'x-actor-id': 'actor-self@patient-demo' };
  assert.equal((await fetch(`${base}/api/v1/patients/patient-demo/summary`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/patients/patient-male/summary`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/patients/patient-male/summary`, { headers: { ...headers, 'x-actor-id': 'actor-self@patient-male' } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/worklist`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/auth/actors`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/emergency-shares/wrong-code`)).status, 404);
  const maleLogin = await fetch(`${base}/api/v1/auth/wechat/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'demo-auto-login', preferredSex: 'MALE' }) });
  assert.equal(maleLogin.status, 200);
  const maleSession = (await maleLogin.json()).data;
  assert.deepEqual(maleSession.actorIds, ['actor-self@patient-male']);
  assert.equal((await fetch(`${base}/api/v1/patients/patient-male/summary`, { headers: { authorization: `Bearer ${maleSession.accessToken}`, 'x-actor-id': 'actor-self@patient-male' } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/patients/patient-demo/summary`, { headers: { authorization: `Bearer ${maleSession.accessToken}`, 'x-actor-id': 'actor-self@patient-demo' } })).status, 403);
  const unsupported = await fetch(`${base}/api/v1/patients/patient-demo/medication-screenings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ score: 2 }) });
  assert.equal(unsupported.status, 501);
  const invalidObservation = await fetch(`${base}/api/v1/patients/patient-demo/observations`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'TEMP', valueNumeric: 37.2, doctorSecret: 'x' }) });
  assert.equal(invalidObservation.status, 400);
  const observation = await fetch(`${base}/api/v1/patients/patient-demo/observations`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'TEMP', value: 37.2 }) });
  assert.equal(observation.status, 200);
  const records = await fetch(`${base}/api/v1/patients/patient-demo/observations`, { headers });
  assert.equal((await records.json()).data.total, 1);
});

test('refresh 轮换且旧 refresh 不可重放', async () => {
  const login = await fetch(`${base}/api/v1/auth/wechat/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'demo-auto-login' }) });
  const first = (await login.json()).data;
  const refreshed = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: first.refreshToken }) });
  assert.equal(refreshed.status, 200);
  const second = (await refreshed.json()).data;
  assert.notEqual(second.accessToken, first.accessToken);
  const oldAccess = await fetch(`${base}/api/v1/patients/patient-demo/summary`, { headers: { authorization: `Bearer ${first.accessToken}`, 'x-actor-id': 'actor-self@patient-demo' } });
  assert.equal(oldAccess.status, 401);
  const newAccess = await fetch(`${base}/api/v1/patients/patient-demo/summary`, { headers: { authorization: `Bearer ${second.accessToken}`, 'x-actor-id': 'actor-self@patient-demo' } });
  assert.equal(newAccess.status, 200);
  const replay = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: first.refreshToken }) });
  assert.equal(replay.status, 401);
});

test('proxy 边界拒绝缺失或伪造的 Bearer 与 actor', async () => {
  const proxyPort = 4388;
  const proxy = spawn(process.execPath, ['src/server.mjs'], { cwd: dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, ''), env: { ...process.env, PORT: String(proxyPort), PATIENT_API_MODE: 'proxy', PATIENT_UPSTREAM_URL: '' }, stdio: 'ignore' });
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${proxyBase}/health`)).ok) break; } catch { /* 等待监听 */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal((await fetch(`${proxyBase}/api/v1/patients/patient-demo/summary`)).status, 401);
    assert.equal((await fetch(`${proxyBase}/api/v1/patients/patient-demo/summary`, { headers: { authorization: 'Token arbitrary' } })).status, 401);
    assert.equal((await fetch(`${proxyBase}/api/v1/patients/patient-demo/summary`, { headers: { authorization: 'Bearer arbitrary' } })).status, 400);
  } finally {
    proxy.kill('SIGTERM');
  }
});

test('proxy 不透传非患者响应字段', async () => {
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: { patientId: 'patient-demo', doctorSecret: 'should-not-leak' } }));
  });
  await new Promise(resolve => upstream.listen(4389, '127.0.0.1', resolve));
  const proxyPort = 4390;
  const proxy = spawn(process.execPath, ['src/server.mjs'], { cwd: dirname(fileURLToPath(import.meta.url)).replace(/\/test$/, ''), env: { ...process.env, PORT: String(proxyPort), PATIENT_API_MODE: 'proxy', PATIENT_UPSTREAM_URL: 'http://127.0.0.1:4389', PATIENT_ALLOW_INSECURE_UPSTREAM: '1' }, stdio: 'ignore' });
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${proxyBase}/health`)).ok) break; } catch { /* 等待监听 */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = await fetch(`${proxyBase}/api/v1/patients/patient-demo/summary`, { headers: { authorization: 'Bearer opaque', 'x-actor-id': 'actor-self@patient-demo' } });
    assert.equal(result.status, 502);
  } finally {
    proxy.kill('SIGTERM');
    await new Promise(resolve => upstream.close(resolve));
  }
});
