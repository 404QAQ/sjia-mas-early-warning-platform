import test from 'node:test';
import assert from 'node:assert/strict';

const { ApiFailure } = await import('../dist/api.js');
const { MutationOutbox, newIdempotencyKey } = await import('../dist/mutation-outbox.js');

function storage() {
  const values = new Map();
  return {
    getStorageSync(key) { return values.get(key); },
    setStorageSync(key, value) { values.set(key, value); },
    removeStorageSync(key) { values.delete(key); },
  };
}

function entry(key = newIdempotencyKey('MEDICATION_LOG')) {
  return { operation: 'MEDICATION_LOG', idempotencyKey: key, payload: { idempotencyKey: key, planId: 'plan-1', takenAt: '2026-10-08T12:00:00.000Z', actualDose: 1, unit: 'mg' } };
}

test('用药 outbox 按 user/actor/patient 隔离并保留幂等键', async () => {
  const store = storage();
  const first = new MutationOutbox(store, 'actor-1', 'patient-1', 'user-1');
  const second = new MutationOutbox(store, 'actor-2', 'patient-1', 'user-1');
  const value = entry('med-key-1');
  first.enqueue(value);
  first.enqueue(value);
  assert.equal(first.entries().length, 1);
  assert.equal(second.entries().length, 0);
  const result = await first.flush(async () => { throw new ApiFailure('连接中断', 0); });
  assert.equal(result.networkError, true);
  assert.equal(first.entries()[0].idempotencyKey, 'med-key-1');
});

test('服务拒绝标记为失败，重试仍复用原幂等键', async () => {
  const store = storage();
  const outbox = new MutationOutbox(store, 'actor-1', 'patient-1', 'user-1');
  outbox.enqueue(entry('med-key-2'));
  const denied = await outbox.flush(async () => { throw new ApiFailure('无权限', 403); });
  assert.equal(denied.denied, true);
  assert.equal(outbox.entries()[0].state, 'REJECTED');
  let sentKey = '';
  const retried = await outbox.flush(async value => { sentKey = value.idempotencyKey; }, true);
  assert.equal(retried.sent, 1);
  assert.equal(sentKey, 'med-key-2');
  assert.equal(outbox.entries().length, 0);
});

test('2xx 回执不完整或未知结果时保留原幂等键，不标记为失败', async () => {
  const store = storage();
  const outbox = new MutationOutbox(store, 'actor-1', 'patient-1', 'user-1');
  outbox.enqueue(entry('med-key-unknown'));
  const result = await outbox.flush(async () => { throw new ApiFailure('服务响应不完整，记录尚未确认；重试会沿用同一条，不会重复记录。', 200); });
  assert.equal(result.networkError, true);
  assert.equal(result.rejected, 0);
  assert.equal(outbox.entries()[0].idempotencyKey, 'med-key-unknown');
});

test('5xx 与 429 不是对操作的结论：保留为待提交，不标记为被拒绝', async () => {
  for (const status of [429, 502, 503]) {
    const outbox = new MutationOutbox(storage(), 'actor-1', 'patient-1', 'user-1');
    outbox.enqueue(entry(`med-key-${status}`));
    const result = await outbox.flush(async () => { throw new ApiFailure('服务暂时不可用', status); });
    assert.equal(result.networkError, true);
    assert.equal(result.rejected, 0);
    assert.equal(outbox.entries()[0].state, 'PENDING');
  }
});
