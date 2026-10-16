import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installWx } from './helpers/wechat-runtime.mjs';
const require = createRequire(import.meta.url);
const { saveVitals, readVitals, vitalStorageKey } = require('../dist/local-vitals.js');
const scope = { userId: 'u', actorId: 'a', patientId: 'p' };
const value = () => ({ systolic: 112, diastolic: 70, spo2: 98, heartRate: 102, recordedAt: new Date().toISOString() });
test('本机体征保存后可回读，不跨患者或身份共享', () => {
  installWx(() => [404, {}]);
  const sample = value(); saveVitals(scope, sample);
  assert.deepEqual(readVitals(scope), sample);
  assert.equal(readVitals({ ...scope, patientId: 'other' }), null);
  assert.equal(readVitals({ ...scope, actorId: 'other' }), null);
  assert.notEqual(vitalStorageKey({ ...scope, userId: 'u:a' }), vitalStorageKey({ ...scope, actorId: 'a:a' }));
});
test('不接受不合理测量，写入失败时不冒充已保存', () => {
  installWx(() => [404, {}], { extra: { setStorageSync() { throw new Error('storage full'); } } });
  for (const invalid of [{ spo2: 101 }, { heartRate: 0 }, { systolic: 60 }, { diastolic: 1.5 }, { recordedAt: 'wrong' }]) assert.throws(() => saveVitals(scope, { ...value(), ...invalid }));
  assert.throws(() => saveVitals(scope, value()), /storage full/);
});
