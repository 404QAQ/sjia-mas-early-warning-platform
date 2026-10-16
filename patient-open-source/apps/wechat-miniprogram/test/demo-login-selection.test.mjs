import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loginWithWechat, session } from '../dist/api.js';
import { installWx } from './helpers/wechat-runtime.mjs';

const require = createRequire(import.meta.url);
const config = require('../dist/config.js');
const actors = [
  { id: 'actor-self', patientId: 'patient-self', relation: 'SELF', activeFrom: '2000-01-01T00:00:00.000Z' },
  { id: 'actor-caregiver', patientId: 'patient-demo', relation: 'LEGAL_GUARDIAN', activeFrom: '2000-01-01T00:00:00.000Z' },
  { id: 'actor-female', patientId: 'patient-female', relation: 'SPOUSE', activeFrom: '2000-01-01T00:00:00.000Z' },
];

function loginFlow(available = actors, authorized = available.map(actor => actor.id)) {
  return installWx(path => {
    if (path === '/api/v1/auth/wechat/login') return [200, { data: { accessToken: 'access', refreshToken: 'refresh', userId: 'demo-user', actorIds: authorized } }];
    if (path === '/api/v1/auth/actors') return [200, { data: available }];
    const patientId = path.split('/')[4];
    if (path.endsWith('/summary')) return [200, { data: { patientId, sex: patientId === 'patient-female' ? 'FEMALE' : 'MALE' } }];
    return [404, {}];
  });
}

async function withDemoFlag(enabled, action) {
  const previous = config.AUTO_DEMO_LOGIN;
  config.AUTO_DEMO_LOGIN = enabled;
  try { await action(); } finally { config.AUTO_DEMO_LOGIN = previous; }
}

test('免邀请码首次登录默认进入已授权参考病例，标准包仍默认本人', async () => {
  for (const enabled of [false, true]) await withDemoFlag(enabled, async () => {
    loginFlow();
    const next = await loginWithWechat();
    assert.equal(next.patientId, enabled ? 'patient-demo' : 'patient-self');
    assert.equal(session()?.patientId, next.patientId);
    assert.equal(next.role, enabled ? 'LEGAL_GUARDIAN' : 'PATIENT');
  });
});

test('明确选择男女入口优先于免邀请码病例默认值', async () => {
  await withDemoFlag(true, async () => {
    for (const [sex, expected] of [['MALE', 'patient-self'], ['FEMALE', 'patient-female']]) {
      loginFlow();
      const next = await loginWithWechat(sex);
      assert.equal(next.patientId, expected);
    }
  });
});

test('免邀请码默认选择不会使用未授权、已撤销、已过期或医生身份', async () => {
  await withDemoFlag(true, async () => {
    const invalidCases = [
      { available: actors, authorized: ['actor-self', 'actor-female'] },
      { available: actors.map(actor => actor.patientId === 'patient-demo' ? { ...actor, revokedAt: '2001-01-01T00:00:00.000Z' } : actor) },
      { available: actors.map(actor => actor.patientId === 'patient-demo' ? { ...actor, activeUntil: '2001-01-01T00:00:00.000Z' } : actor) },
      { available: actors.map(actor => actor.patientId === 'patient-demo' ? { ...actor, relation: 'CLINICIAN' } : actor) },
    ];
    for (const { available, authorized } of invalidCases) {
      loginFlow(available, authorized);
      assert.equal((await loginWithWechat()).patientId, 'patient-self');
    }
  });
});

test('免邀请码登录不依赖当前开发者工具的 wx.login', async () => {
  await withDemoFlag(true, async () => {
    installWx(path => {
      if (path === '/api/v1/auth/wechat/login') return [200, { data: { accessToken: 'access', refreshToken: 'refresh', userId: 'demo-user', actorIds: ['actor-caregiver'] } }];
      if (path === '/api/v1/auth/actors') return [200, { data: actors }];
      return [404, {}];
    }, { extra: { login() { throw new Error('免登录包不应调用 wx.login'); } } });
    const next = await loginWithWechat();
    assert.equal(next.patientId, 'patient-demo');
  });
});
