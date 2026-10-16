import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.Page = () => {};
const { parseSnapshot } = await import('../dist/pages/patient/joint.js');

const source = () => readFile(new URL('../src/pages/patient/joint.ts', import.meta.url), 'utf8');

test('关节速记页面使用患者范围接口和 JOINT_ASSESSMENT outbox', async () => {
  const value = await source();
  assert.match(value, /\/joint-assessments/);
  assert.match(value, /'JOINT_ASSESSMENT'/);
  assert.match(value, /new MutationOutbox\(wxStorage\(\), scope\.actorId, scope\.patientId, scope\.userId\)/);
  assert.match(value, /sameScope\(scope\)/);
  // 失败后重试沿用同一条提交（outbox 的责任），失败文案不把技术术语丢给患者（文案的责任）。
  assert.match(value, /这条已留在本机，可以直接重试/);
  assert.doesNotMatch(value, /幂等键/, '患者可见文案不得出现「幂等键」');
  assert.match(value, /respondentForRole/);
});

test('关节速记页面提供可达入口且小程序路由已注册', async () => {
  const [page, records, app] = await Promise.all([
    readFile(new URL('../src/pages/patient/joint.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/records.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /bindtap="save"/);
  assert.match(page, /比之前好也要记一下/);
  assert.match(records, /bindtap="openJoint"/);
  assert.match(app, /pages\/patient\/joint/);
});

test('关节速记页面不渲染服务端趋势或临床内部字段', async () => {
  const value = await source();
  assert.doesNotMatch(value, /trendFlag|dataQuality|assessedBy|idempotencyKey.*{{/);
});

test('关节速记响应严格绑定当前患者并拒绝未知或未来字段', () => {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const record = { id: 'joint-1', patientId: 'patient-1', observedAt, morningStiffnessMinutes: 15, painNrs: 3, activityLevel: 'LIMITED', respondent: 'PATIENT' };
  assert.equal(parseSnapshot({ patientId: 'patient-1', assessments: [record] }, 'patient-1')[0].id, 'joint-1');
  assert.throws(() => parseSnapshot({ patientId: 'patient-2', assessments: [record] }, 'patient-1'));
  assert.throws(() => parseSnapshot({ patientId: 'patient-1', assessments: [{ ...record, internal: 'should-not-render' }] }, 'patient-1'));
  assert.throws(() => parseSnapshot({ patientId: 'patient-1', assessments: [{ ...record, observedAt: new Date(Date.now() + 60_000).toISOString() }] }, 'patient-1'));
});
