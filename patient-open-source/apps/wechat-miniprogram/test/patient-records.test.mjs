import test from 'node:test';
import assert from 'node:assert/strict';

const { HttpFailure, NetworkFailure, OUTBOX_BASE_DELAY_MS, OUTBOX_MAX_ATTEMPTS, Outbox, makeRecords, retryDelayMs, sendRecord, sessionScope, submitRecords } = await import('../dist/patient-records.js');

function storage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function records() {
  return makeRecords('patient-1', 38.5, ['LETHARGY', 'RASH'], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z', (() => {
    let index = 0;
    return () => `fixed-key-${++index}`;
  })());
}

test('体温和症状输入经过范围、时间和编码校验', () => {
  const value = records();
  assert.equal(value.length, 3);
  assert.equal(value[0].code, 'TEMP');
  assert.equal(value[0].valueNumeric, 38.5);
  assert.equal(value[1].valueCoded, 'LETHARGY');
  assert.throws(() => makeRecords('patient-1', 33.9, [], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z'), /34–43/);
  assert.throws(() => makeRecords('patient-1', 38, ['UNKNOWN'], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z'), /无法识别/);
  assert.throws(() => makeRecords('patient-1', 38, [], 'PATIENT_REPORTED', '2999-01-01T00:00:00.000Z'), /晚于/);
});

test('Outbox 按 user/actor/patient 隔离并保持 FIFO', () => {
  const store = storage();
  const first = new Outbox(store, 'user-1', 'actor-1', 'patient-1');
  const second = new Outbox(store, 'user-1', 'actor-2', 'patient-1');
  first.enqueue(records());
  assert.equal(first.entries().length, 3);
  assert.equal(second.entries().length, 0);
  assert.deepEqual(first.entries().map(item => item.record.idempotencyKey), ['fixed-key-1', 'fixed-key-2', 'fixed-key-3']);
});

test('网络失败保存剩余记录并复用原幂等键', async () => {
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1');
  const value = records();
  let calls = 0;
  const result = await submitRecords(value, async record => {
    calls += 1;
    if (calls === 2) throw new NetworkFailure('offline');
  }, outbox);
  assert.deepEqual(result, { confirmed: 1, queued: 2, remaining: [], error: null });
  assert.deepEqual(outbox.entries().map(item => item.record.idempotencyKey), ['fixed-key-2', 'fixed-key-3']);
});

test('仅在服务端确认后出队，HTTP 拒绝保留为可见失败', async () => {
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1');
  const value = records().slice(0, 2);
  outbox.enqueue(value);
  await assert.rejects(outbox.flush(async () => { throw new HttpFailure('无权限', 403); }), /无权限/);
  assert.equal(outbox.entries().length, 2);
  const expected = ['fixed-key-1', 'fixed-key-2'];
  const sent = await outbox.flush(async record => { assert.equal(record.idempotencyKey, expected.shift()); }, true);
  assert.equal(sent.sent, 2);
  assert.equal(outbox.entries().length, 0);
});

test('未知结果以网络失败处理时原幂等键可安全恢复', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  const value = records().slice(0, 1);
  const result = await submitRecords(value, async () => { throw new NetworkFailure('连接在响应前中断'); }, outbox);
  assert.equal(result.queued, 1);
  const queuedKey = outbox.entries()[0].record.idempotencyKey;
  now += OUTBOX_BASE_DELAY_MS;
  await outbox.flush(async record => { assert.equal(record.idempotencyKey, queuedKey); });
  assert.equal(outbox.entries().length, 0);
});

test('网络失败持久化指数退避，首条未到期时保持 FIFO，不跳过后续记录', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  const value = records();
  outbox.enqueue(value);
  const attempted = [];
  const first = await outbox.flush(async record => {
    attempted.push(record.idempotencyKey);
    throw new NetworkFailure('offline');
  }, true);
  assert.deepEqual(attempted, ['fixed-key-1']);
  assert.equal(first.networkError, true);
  assert.equal(outbox.entries()[0].attemptCount, 1);
  assert.equal(Date.parse(outbox.entries()[0].nextAttemptAt), now + retryDelayMs(1));

  await outbox.flush(async record => { attempted.push(record.idempotencyKey); }, true);
  assert.deepEqual(attempted, ['fixed-key-1']);

  now += OUTBOX_BASE_DELAY_MS;
  await outbox.flush(async record => { attempted.push(record.idempotencyKey); }, true);
  assert.deepEqual(attempted, ['fixed-key-1', 'fixed-key-1', 'fixed-key-2', 'fixed-key-3']);
  assert.equal(outbox.entries().length, 0);
});

test('首次直发网络失败入队时立即带退避时间，并保留同一批次顺序', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  const result = await submitRecords(records(), async () => { throw new NetworkFailure('offline'); }, outbox);
  assert.equal(result.queued, 3);
  assert.deepEqual(outbox.entries().map(item => item.record.idempotencyKey), ['fixed-key-1', 'fixed-key-2', 'fixed-key-3']);
  assert.equal(outbox.entries()[0].attemptCount, 1);
  assert.equal(Date.parse(outbox.entries()[0].nextAttemptAt), now + OUTBOX_BASE_DELAY_MS);
  assert.deepEqual(outbox.entries().slice(1).map(item => item.attemptCount), [0, 0]);
});

test('自动重试最多五次，达到上限后需人工强制重试并重新计数', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  outbox.enqueue(records().slice(0, 1));
  let calls = 0;
  for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    await outbox.flush(async () => { calls += 1; throw new NetworkFailure('offline'); }, true);
    if (attempt < OUTBOX_MAX_ATTEMPTS) now += retryDelayMs(attempt);
  }
  assert.equal(calls, OUTBOX_MAX_ATTEMPTS);
  assert.equal(outbox.entries()[0].state, 'REJECTED');
  assert.equal(outbox.entries()[0].attemptCount, OUTBOX_MAX_ATTEMPTS);
  assert.equal(outbox.entries()[0].nextAttemptAt, undefined);
  await outbox.flush(async () => { calls += 100; }, true);
  assert.equal(calls, OUTBOX_MAX_ATTEMPTS);
  const forced = await outbox.flush(async () => { calls += 1; }, true, true);
  assert.equal(forced.sent, 1);
  assert.equal(calls, OUTBOX_MAX_ATTEMPTS + 1);
  assert.equal(outbox.entries().length, 0);
});

test('身份切换产生的 409 保留 PENDING 和原幂等键', async () => {
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1');
  const value = records().slice(0, 1);
  outbox.enqueue(value);
  await assert.rejects(outbox.flush(async () => { throw new HttpFailure('身份已切换', 409); }, true), /身份已切换/);
  assert.deepEqual(outbox.entries().map(item => [item.state, item.record.idempotencyKey]), [['PENDING', value[0].idempotencyKey]]);
});

test('队列键对冒号和患者、Actor、API 范围保持隔离', () => {
  const store = storage();
  const first = new Outbox(store, 'user:a', 'actor:b', 'patient:c');
  const second = new Outbox(store, 'user', 'a:actor', 'b:patient:c');
  assert.notEqual(first.key, second.key);
  first.enqueue(makeRecords('patient:c', 38.5, [], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z', () => 'collision-key').slice(0, 1));
  assert.equal(second.entries().length, 0);
  assert.match(first.key, /^mas\.wechat\.pending\.v2:/);
  assert.match(first.key, /%3A/);
});

test('session scope 使用结构化编码，冒号不会造成身份碰撞', () => {
  const base = { accessToken: 'a', refreshToken: 'r', userId: 'u:a', actorIds: ['actor'], actorId: 'actor', role: 'PATIENT', patientId: 'p' };
  assert.notEqual(sessionScope(base), sessionScope({ ...base, userId: 'u', actorId: 'a:actor' }));
  assert.equal(sessionScope(null), null);
});

test('服务端回执必须带回原幂等键', async () => {
  const previous = globalThis.wx;
  const sessionValue = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['actor'], actorId: 'actor', role: 'PATIENT', patientId: 'patient-1' };
  const record = records()[0];
  let includeKey = false;
  globalThis.wx = {
    getStorageSync(key) { return key === 'mas.wechat.session.v1' ? sessionValue : null; },
    request(options) {
      const observation = { id: 'observation-1', patientId: record.patientId, code: record.code, unit: record.unit, observedAt: record.observedAt, source: record.source, ...(includeKey ? { idempotencyKey: record.idempotencyKey, ...(record.confidence === undefined ? {} : { confidence: record.confidence }) } : {}) };
      options.success({ statusCode: 201, data: { data: { observation } } });
    },
  };
  try {
    await assert.rejects(sendRecord(record, sessionScope(sessionValue)), NetworkFailure);
    includeKey = true;
    await sendRecord(record, sessionScope(sessionValue));
  } finally {
    globalThis.wx = previous;
  }
});

test('重新实例化 Outbox 后仍尊重已持久化的退避时间', async () => {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const store = storage();
  const first = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  first.enqueue(records().slice(0, 1));
  await first.flush(async () => { throw new NetworkFailure('offline'); }, true);
  const restored = new Outbox(store, 'user-1', 'actor-1', 'patient-1', () => now);
  let calls = 0;
  await restored.flush(async () => { calls += 1; }, true);
  assert.equal(calls, 0);
  now += OUTBOX_BASE_DELAY_MS;
  await restored.flush(async () => { calls += 1; }, true);
  assert.equal(calls, 1);
});

test('并发 flush 共享同一发送 flight，不重复发送队首记录', async () => {
  const store = storage();
  const outbox = new Outbox(store, 'user-1', 'actor-1', 'patient-1');
  outbox.enqueue(records().slice(0, 1));
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = async () => { calls += 1; await gate; };
  const first = outbox.flush(send, true);
  const second = outbox.flush(send, true);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
  assert.equal(outbox.entries().length, 0);
});

test('补齐的 12 种症状都能通过 makeRecords 提交，code/valueCoded/unit 对应正确', () => {
  const allCodes = ['FEVER_RISING', 'LETHARGY', 'ANOREXIA', 'RASH', 'GI',
    'BLEEDING', 'CNS', 'ARTHRITIS_IMPROVED', 'EYE_RED', 'CANNOT_WALK', 'MEDICATION_URGENT', 'FEVER_HIGH'];
  for (const code of allCodes) {
    const recs = makeRecords('patient-1', 38.5, [code], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z');
    const sym = recs.find(r => r.code.startsWith('SYMPTOM_'));
    assert.ok(sym, `${code}: 未生成症状记录`);
    assert.equal(sym.code, `SYMPTOM_${code}`, `${code}: code 不匹配`);
    assert.equal(sym.valueCoded, code, `${code}: valueCoded 不匹配`);
    assert.equal(sym.unit, '1', `${code}: unit 必须为 1`);
  }
});

test('makeRecords 仍拒绝未知症状码', () => {
  assert.throws(() => makeRecords('patient-1', 38.5, ['UNKNOWN_SYMPTOM'], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z'), /无法识别/);
  assert.throws(() => makeRecords('patient-1', 38.5, ['FEVER_HIGH', 'NOT_A_SYMPTOM'], 'PATIENT_REPORTED', '2026-10-08T12:00:00.000Z'), /无法识别/);
});

test('buildSymptomGroups 按 group 聚合并保持声明顺序', async () => {
  const { buildSymptomGroups, symptoms } = await import('../dist/patient-records.js');
  const opts = symptoms.map(item => ({ ...item, selected: false }));
  const groups = buildSymptomGroups(opts);
  // 至少有三个分组
  assert.ok(groups.length >= 3, '分组数量应 ≥ 3');
  // 热线紧急那组：CNS 和 BLEEDING 在同一组且排名靠前
  const urgentGroup = groups.find(g => g.items.some(i => i.code === 'CNS'));
  assert.ok(urgentGroup, '找不到含 CNS 的分组');
  assert.ok(urgentGroup.items.some(i => i.code === 'BLEEDING'), 'BLEEDING 应与 CNS 同组');
  // ARTHRITIS_IMPROVED 有 urgencyNote
  const arthGroup = groups.flatMap(g => g.items).find(i => i.code === 'ARTHRITIS_IMPROVED');
  assert.ok(arthGroup, 'ARTHRITIS_IMPROVED 不在任何分组');
  assert.ok(arthGroup.urgencyNote && arthGroup.urgencyNote.length > 0, 'ARTHRITIS_IMPROVED 应有 urgencyNote');
  // BLEEDING 的 urgencyNote 提示与经期出血区分
  const bleedItem = groups.flatMap(g => g.items).find(i => i.code === 'BLEEDING');
  assert.ok(bleedItem.urgencyNote && /经期/.test(bleedItem.urgencyNote), 'BLEEDING urgencyNote 应提示区分经期出血');
  // selected 标志通过 buildSymptomGroups 正确传递
  const selectedOpts = symptoms.map(item => ({ ...item, selected: item.code === 'CNS' }));
  const selectedGroups = buildSymptomGroups(selectedOpts);
  const cnsItem = selectedGroups.flatMap(g => g.items).find(i => i.code === 'CNS');
  assert.equal(cnsItem.selected, true, 'selected 标志未透传');
  const otherItem = selectedGroups.flatMap(g => g.items).find(i => i.code === 'RASH');
  assert.equal(otherItem.selected, false, '未选中项 selected 应为 false');
});

test('补充说明在离线队列重建后完整保留，正文回执不一致不能算保存成功', async () => {
  const store = storage(); const record = { ...records()[0], notes: '本次感受：一般\n补充说明：食欲下降。' };
  new Outbox(store, 'u', 'actor', 'patient-1').enqueue([record]);
  const restored = new Outbox(store, 'u', 'actor', 'patient-1');
  assert.equal(restored.entries()[0].record.notes, record.notes);
  const previous = globalThis.wx;
  const identity = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['actor'], actorId: 'actor', role: 'PATIENT', patientId: 'patient-1' };
  let matching = false;
  globalThis.wx = {
    getStorageSync(key) { return key === 'mas.wechat.session.v1' ? identity : null; },
    request(options) { options.success({ statusCode: 201, data: { data: { observation: { ...record, id: 'saved-id', notes: matching ? record.notes : undefined } } } }); },
  };
  try { await assert.rejects(sendRecord(record), /原记录不一致/); matching = true; await sendRecord(record); }
  finally { globalThis.wx = previous; }
});
