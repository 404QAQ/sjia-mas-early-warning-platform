import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The page module registers itself with the WeChat runtime at import time. The
// pure payload/rotation helpers remain testable in Node without a device.
globalThis.Page = () => {};
globalThis.wx = {};
const { buildInjectionLogPayload, calendarPlanRows, deriveInjectionSummary, parseOverview, parseMedicationWave, buildMedicationWaveRows } = await import('../dist/pages/patient/medications.js');

const oralPlan = { id: 'oral-1', patientId: 'p1', route: 'ORAL', dose: 1, unit: 'mg' };
const injectionPlan = { id: 'sc-1', patientId: 'p1', route: 'SC_INJECTION', dose: 8, unit: 'mg/kg' };
const draft = (overrides = {}) => ({ site: 'LUQ', administeredBy: 'SELF', coldChainEnabled: false, coldChainType: '', durationHours: '', reportedAt: '', ...overrides });

test('M-03 小程序非注射计划不携带注射字段', () => {
  const payload = buildInjectionLogPayload(oralPlan, 'oral-key', '2026-10-09T10:00:00.000Z', draft({ site: '', administeredBy: '' }));
  assert.deepEqual(payload, { idempotencyKey: 'oral-key', planId: 'oral-1', takenAt: '2026-10-09T10:00:00.000Z', actualDose: 1, unit: 'mg' });
});

test('M-03 皮下注射缺少部位或注射人会在小程序本地拒绝', () => {
  assert.throws(() => buildInjectionLogPayload(injectionPlan, 'missing-site', '2026-10-09T10:00:00.000Z', draft({ site: '' })), /注射部位和注射人/);
  assert.throws(() => buildInjectionLogPayload(injectionPlan, 'missing-admin', '2026-10-09T10:00:00.000Z', draft({ administeredBy: '' })), /注射部位和注射人/);
});

test('M-03 冷链事实必须有类型、非空时长和报告日期', () => {
  assert.throws(() => buildInjectionLogPayload(injectionPlan, 'cold-empty-duration', '2026-10-09T10:00:00.000Z', draft({ coldChainEnabled: true, coldChainType: 'UNREFRIGERATED', durationHours: '', reportedAt: '2026-10-09' })), /冷链事实/);
  assert.throws(() => buildInjectionLogPayload(injectionPlan, 'cold-missing-date', '2026-10-09T10:00:00.000Z', draft({ coldChainEnabled: true, coldChainType: 'UNREFRIGERATED', durationHours: '2' })), /冷链事实/);
  assert.throws(() => buildInjectionLogPayload(injectionPlan, 'cold-future-date', '2026-10-09T10:00:00.000Z', draft({ coldChainEnabled: true, coldChainType: 'UNREFRIGERATED', durationHours: '2', reportedAt: '2999-01-01' })), /冷链事实/);
  const payload = buildInjectionLogPayload(injectionPlan, 'cold-valid', '2026-10-09T10:00:00.000Z', draft({ coldChainEnabled: true, coldChainType: 'TRANSPORT_DELAY', durationHours: '2.5', reportedAt: '2026-10-08' }));
  assert.deepEqual(payload.coldChainEvent, { type: 'TRANSPORT_DELAY', durationHours: 2.5, reportedAt: '2026-10-07T16:00:00.000Z' });
});

test('M-03 轮换摘要只提示事实，不判断药品可用性或补打', async () => {
  const summary = deriveInjectionSummary('sc-1', [
    { id: 'z', patientId: 'p1', planId: 'sc-1', takenAt: '2026-10-08T10:00:00.000Z', actualDose: 8, unit: 'mg/kg', injectionSite: 'LUQ', injectionAdministeredBy: 'SELF' },
    { id: 'y', patientId: 'p1', planId: 'sc-1', takenAt: '2026-10-01T10:00:00.000Z', actualDose: 8, unit: 'mg/kg', injectionSite: 'LUQ', injectionAdministeredBy: 'SELF' },
    { id: 'x', patientId: 'p1', planId: 'sc-1', takenAt: '2026-09-24T10:00:00.000Z', actualDose: 8, unit: 'mg/kg', injectionSite: 'RUQ', injectionAdministeredBy: 'SELF' },
  ]);
  assert.deepEqual(summary, { lastSite: 'LUQ', suggestedSite: 'RUQ', consecutiveCount: 2 });
  assert.deepEqual(deriveInjectionSummary('missing', []), { consecutiveCount: 0 });
  const [source, markup] = await Promise.all([
    readFile(new URL('../src/pages/patient/medications.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/medications.wxml', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /不判断药品是否可用/);
  assert.match(source, /不建议补打/);
  assert.match(markup, /记录冷链事实/);
  assert.match(markup, /轮换提示/);
  assert.match(markup, /储运与携带说明/);
  assert.match(markup, /联系照护团队/);
  assert.match(source, /不要自行补打/);
});

test('M-04 用药概览严格校验字段白名单和计划引用', () => {
  const plan = { id: 'sc-1', patientId: 'p1', drug: '示例药', dose: 8, unit: 'mg/kg', route: 'SC_INJECTION', frequency: 'DAILY', status: 'ACTIVE' };
  const log = { id: 'log-1', patientId: 'p1', planId: 'sc-1', takenAt: '2026-10-09T10:00:00.000Z', actualDose: 8, unit: 'mg/kg', injectionSite: 'LUQ', injectionAdministeredBy: 'SELF' };
  const base = { patientId: 'p1', asOf: '2026-10-09T12:00:00.000Z', plans: [plan], logs: [log], today: [{ planId: 'sc-1', status: 'RECORDED' }], trajectories: [{ planId: 'sc-1', drug: '示例药', status: 'ACTIVE', frequency: 'DAILY', unit: 'mg/kg', points: [], missingWindows: [] }] };
  assert.ok(parseOverview(base, 'p1'));
  assert.equal(parseOverview({ ...base, unexpected: true }, 'p1'), null);
  assert.equal(parseOverview({ ...base, today: [{ planId: 'foreign', status: 'RECORDED' }] }, 'p1'), null);
  assert.equal(parseOverview({ ...base, plans: [{ ...plan, route: 'ORAL' }] }, 'p1'), null);
  const stopped = { ...base, plans: [{ ...plan, status: 'STOPPED' }], today: [], trajectories: [{ ...base.trajectories[0], status: 'STOPPED' }] };
  assert.ok(parseOverview(stopped, 'p1'), '停止计划保留路线元信息后仍可严格读取历史注射事实');
  assert.equal(parseOverview({ ...stopped, plans: [] }, 'p1'), null, '不得仅因停止就放过无法核对所属计划的日志');
  assert.equal(parseOverview({ ...stopped, plans: [{ ...plan, status: 'STOPPED', route: 'ORAL' }] }, 'p1'), null, '历史注射事实仍与计划途径一致');
});

test('M-05 按需用药同日多次记录在月历详情逐条展示', () => {
  const plan = { id: 'prn-1', patientId: 'p1', drug: '退热药', dose: 1, unit: '片', route: 'ORAL', frequency: 'AS_NEEDED', status: 'ACTIVE' };
  const logs = [
    { id: 'dose-1', patientId: 'p1', planId: 'prn-1', takenAt: '2026-10-09T01:00:00.000Z', actualDose: 1, unit: '片' },
    { id: 'dose-2', patientId: 'p1', planId: 'prn-1', takenAt: '2026-10-09T05:30:00.000Z', actualDose: 2, unit: '片' },
  ];
  const rows = calendarPlanRows([plan], logs, '2026-10-09');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.key), ['prn-1:dose-1', 'prn-1:dose-2']);
  assert.deepEqual(rows.map(row => row.actualDoseLabel), ['实际 1 片', '实际 2 片']);
  assert.deepEqual(rows.map(row => row.takenAtLabel), ['09:00', '13:30']);
});

test('M-06 小程序严格校验 14 日共享快照、患者边界、日期顺序和计划唯一性', () => {
  const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, observations: [], planned: [], actual: [], relationHints: [] }));
  const plan = { id: 'plan-1', drug: '甲泼尼龙', kind: 'STEROID', route: 'ORAL', frequency: 'DAILY', unit: 'mg', status: 'ACTIVE' };
  const wave = { patientId: 'p1', asOf: '2026-10-14T12:00:00.000Z', range: { from: '2026-10-01', to: '2026-10-14', days: 14 }, plans: [plan], days };
  assert.ok(parseMedicationWave(wave, 'p1'));
  assert.equal(parseMedicationWave({ ...wave, patientId: 'p2' }, 'p1'), null);
  assert.equal(parseMedicationWave({ ...wave, plans: [plan, plan] }, 'p1'), null);
  assert.equal(parseMedicationWave({ ...wave, range: { ...wave.range, from: '2026-02-30' } }, 'p1'), null);
  assert.equal(parseMedicationWave({ ...wave, days: [days[1], days[0], ...days.slice(2)] }, 'p1'), null);
});

test('M-07 小程序波动行将漏记和计划偏差显示为警示状态', () => {
  const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, observations: [], planned: [], actual: [], relationHints: [] }));
  days[13].planned = [{ planId: 'plan-1', drug: '甲泼尼龙', plannedDose: 10, unit: 'mg', dueAt: '2026-10-14T00:00:00.000Z', frequency: 'DAILY' }];
  days[13].relationHints = [{ kind: 'MISSED', text: '甲泼尼龙计划剂量未记录', planId: 'plan-1' }];
  const wave = { patientId: 'p1', asOf: '2026-10-14T12:00:00.000Z', range: { from: '2026-10-01', to: '2026-10-14', days: 14 }, plans: [{ id: 'plan-1', drug: '甲泼尼龙', kind: 'STEROID', route: 'ORAL', frequency: 'DAILY', unit: 'mg', status: 'ACTIVE' }], days };
  const rows = buildMedicationWaveRows(wave);
  assert.equal(rows[0].date, '10月14日');
  assert.equal(rows[0].state, 'warn');
  assert.match(rows[0].hintsText, /未记录/);
});
