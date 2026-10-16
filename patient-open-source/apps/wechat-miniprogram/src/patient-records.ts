import { patientId as currentPatientId, request, session, type MiniSession } from './api';
import { recordOutboxKey } from './config';

/**
 * 症状按紧急程度分三组，顺序影响界面分组展示。
 * 以 SYMPTOM_<code> 形式提交，valueCoded 为 code，unit 为 '1'。
 */
export const symptoms = [
  // 需要立即急诊 —— 这些情况不要等到复诊再说
  { code: 'CNS', label: '抽搐 / 意识改变 / 剧烈头痛', group: '需要立即急诊', urgencyNote: '这是需要立即急诊的情况，请直接拨打急救电话。' },
  { code: 'BLEEDING', label: '牙龈出血、鼻出血、皮肤出现瘀点或瘀斑', group: '需要立即急诊', urgencyNote: '如果是经期出血，请到「经期与用药关注」页单独记录，不算这里。' },
  // 需要尽快告诉医生 —— 当天或次日联系照护团队
  { code: 'FEVER_RISING', label: '发热峰值持续上升（连续多天越来越高）', group: '需要尽快告诉医生' },
  { code: 'LETHARGY', label: '精神差、嗜睡或叫不醒', group: '需要尽快告诉医生' },
  { code: 'ARTHRITIS_IMPROVED', label: '关节好像不那么疼了', group: '需要尽快告诉医生', urgencyNote: '关节症状减轻不一定是好事，MAS 活动时关节反而可能不疼，请告诉医生。' },
  { code: 'MEDICATION_URGENT', label: '药物可能的严重副作用', group: '需要尽快告诉医生' },
  // 也要记录的变化 —— 带到复诊时提
  { code: 'RASH', label: '新发或加重的皮疹', group: '也要记录的变化' },
  { code: 'ANOREXIA', label: '拒食或进食明显减少', group: '也要记录的变化' },
  { code: 'GI', label: '腹痛或呕吐', group: '也要记录的变化' },
  { code: 'EYE_RED', label: '眼睛发红或怕光', group: '也要记录的变化' },
  { code: 'CANNOT_WALK', label: '不愿走路或不愿动', group: '也要记录的变化' },
  { code: 'FEVER_HIGH', label: '持续高热（体温已在上方记录，此处勾选表示「是持续高热」）', group: '也要记录的变化' },
] as const;

export type SymptomGroup = {
  group: string;
  items: Array<(typeof symptoms)[number] & { selected: boolean }>;
};

/**
 * 把带有 selected 标志的症状选项按 group 字段聚合，保持各组内的声明顺序。
 */
export function buildSymptomGroups(
  opts: Array<(typeof symptoms)[number] & { selected: boolean }>,
): SymptomGroup[] {
  const map = new Map<string, SymptomGroup>();
  for (const item of opts) {
    if (!map.has(item.group)) map.set(item.group, { group: item.group, items: [] });
    map.get(item.group)!.items.push(item);
  }
  return [...map.values()];
}

export type RecordSource = 'CAREGIVER_REPORTED' | 'PATIENT_REPORTED';

export interface RecordInput {
  notes?: string;
  patientId: string;
  code: string;
  display: string;
  valueNumeric?: number;
  valueCoded?: string;
  unit: string;
  observedAt: string;
  source: RecordSource;
  idempotencyKey: string;
  tags: string[];
  confidence?: 'HIGH' | 'LOW';
}

/** 查询包含医生、检验和设备记录；本人提交仍只允许 RecordSource 的两种来源。 */
export interface ObservationView extends Omit<RecordInput, 'source'> {
  id: string;
  source: RecordSource | 'CLINIC' | 'LAB' | 'DEVICE';
  recordedAt?: string;
  recordedBy?: string;
}

export interface QueueEntry {
  record: RecordInput;
  state: 'PENDING' | 'REJECTED';
  error?: string;
  /** Number of network attempts already made for this record. */
  attemptCount?: number;
  /** Do not retry before this server-independent local time. */
  nextAttemptAt?: string;
}

export const OUTBOX_BASE_DELAY_MS = 1_000;
export const OUTBOX_MAX_DELAY_MS = 16_000;
export const OUTBOX_MAX_ATTEMPTS = 5;

export function retryDelayMs(attemptCount: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) throw new Error('退避次数无效。');
  return Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * (2 ** Math.min(attemptCount - 1, OUTBOX_MAX_ATTEMPTS - 1)));
}

export class NetworkFailure extends Error {
  readonly kind = 'NETWORK';
}

export class HttpFailure extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storagePort(): StoragePort {
  return {
    getItem: key => {
      const value = wx.getStorageSync<unknown>(key);
      return typeof value === 'string' ? value : value == null ? null : JSON.stringify(value);
    },
    setItem: (key, value) => wx.setStorageSync(key, value),
    removeItem: key => wx.removeStorageSync(key),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isRecord(value: unknown, patient: string): value is RecordInput {
  if (!object(value)) return false;
  const item = value as Partial<RecordInput>;
  return item.patientId === patient && typeof item.code === 'string' && Boolean(item.code) && typeof item.display === 'string' &&
    typeof item.unit === 'string' && Boolean(item.unit) && typeof item.idempotencyKey === 'string' && Boolean(item.idempotencyKey) &&
    typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt)) &&
    (item.source === 'CAREGIVER_REPORTED' || item.source === 'PATIENT_REPORTED') && Array.isArray(item.tags) &&
    item.tags.every(tag => typeof tag === 'string') &&
    (item.notes === undefined || typeof item.notes === 'string' && item.notes.length <= 2000 && !/\0/.test(item.notes)) &&
    (item.confidence === undefined || item.confidence === 'HIGH' || item.confidence === 'LOW') &&
    ((typeof item.valueNumeric === 'number' && Number.isFinite(item.valueNumeric)) || typeof item.valueCoded === 'string');
}

function isQueueEntry(value: unknown, patient: string): value is QueueEntry {
  return object(value) && (value.state === 'PENDING' || value.state === 'REJECTED') && isRecord(value.record, patient) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.attemptCount === undefined || (typeof value.attemptCount === 'number' && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0 && value.attemptCount <= 32)) &&
    (value.nextAttemptAt === undefined || (typeof value.nextAttemptAt === 'string' && Number.isFinite(Date.parse(value.nextAttemptAt))));
}

/**
 * Queue scope includes the user, actor and patient. This prevents a delayed
 * request or a later actor switch from exposing or replaying another scope's
 * records.
 */
export class Outbox {
  readonly key: string;
  private flushFlight: Promise<FlushResult> | null = null;
  constructor(
    private readonly storage: StoragePort,
    userId: string,
    actorId: string,
    private readonly patient: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    // 键格式由 config 统一生成：会话失效时 api.ts 按同一个键清理本队列。
    this.key = recordOutboxKey(userId, actorId, patient);
  }

  entries(): QueueEntry[] {
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); } catch { throw new Error('无法读取本机待提交记录，请检查微信存储权限。'); }
    if (!raw) return [];
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value) || !value.every(item => isQueueEntry(item, this.patient))) throw new Error('invalid');
      return (value as QueueEntry[]).map(entry => ({
        ...entry,
        attemptCount: entry.attemptCount ?? 0,
        ...(entry.nextAttemptAt === undefined ? {} : { nextAttemptAt: entry.nextAttemptAt }),
      }));
    } catch { throw new Error('本机待提交记录格式损坏，未覆盖原有数据。'); }
  }

  private write(entries: QueueEntry[]): void {
    try { this.storage.setItem(this.key, JSON.stringify(entries)); }
    catch { throw new Error('无法保存到本机。尚未提交的记录仍待处理，请勿清理微信存储。'); }
  }

  enqueue(records: RecordInput[], options: { retryAfterMs?: number } = {}): void {
    const entries = this.entries();
    const retryAfterMs = options.retryAfterMs ?? 0;
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > OUTBOX_MAX_DELAY_MS) throw new Error('待提交记录退避时间无效。');
    const now = this.now();
    for (const [index, record] of records.entries()) {
      if (!isRecord(record, this.patient)) throw new Error('待提交记录不属于当前患者。');
      const prior = entries.find(entry => entry.record.idempotencyKey === record.idempotencyKey);
      if (prior && JSON.stringify(prior.record) !== JSON.stringify(record)) throw new Error('同一次提交的内容已经变了，本机的记录没有被覆盖。');
      const delay = index === 0 ? retryAfterMs : 0;
      if (!prior) entries.push({
        record: { ...record, tags: [...record.tags] },
        state: 'PENDING',
        attemptCount: delay > 0 ? 1 : 0,
        ...(delay > 0 ? { nextAttemptAt: new Date(now + delay).toISOString() } : {}),
      });
    }
    this.write(entries);
  }

  clear(): void {
    try {
      if (this.storage.removeItem) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, '[]');
    } catch { throw new Error('无法清理本机待提交记录。'); }
  }

  /** The earliest persisted retry deadline for the current scoped queue. */
  nextRetryAt(): number | null {
    const first = this.entries().find(entry => entry.state === 'PENDING');
    if (!first?.nextAttemptAt) return null;
    const value = Date.parse(first.nextAttemptAt);
    return Number.isFinite(value) ? value : null;
  }

  async flush(send: (record: RecordInput) => Promise<void>, retryRejected = false, force = false): Promise<FlushResult> {
    if (this.flushFlight) return this.flushFlight;
    const flight = this.flushInternal(send, retryRejected, force);
    this.flushFlight = flight;
    try { return await flight; }
    finally { if (this.flushFlight === flight) this.flushFlight = null; }
  }

  private async flushInternal(send: (record: RecordInput) => Promise<void>, retryRejected: boolean, force: boolean): Promise<FlushResult> {
    let sent = 0;
    let networkError = false;
    for (const entry of this.entries()) {
      if (entry.state === 'REJECTED' && (!retryRejected || (!force && (entry.attemptCount ?? 0) >= OUTBOX_MAX_ATTEMPTS))) continue;
      if (entry.state === 'REJECTED' && force) {
        const entries = this.entries();
        const current = entries.find(item => item.record.idempotencyKey === entry.record.idempotencyKey);
        if (!current) continue;
        current.state = 'PENDING';
        delete current.error;
        current.attemptCount = 0;
        delete current.nextAttemptAt;
        this.write(entries);
      }
      const nextAttemptAt = entry.nextAttemptAt === undefined ? 0 : Date.parse(entry.nextAttemptAt);
      // Preserve FIFO: a delayed head blocks later records in the same queue.
      if (!force && Number.isFinite(nextAttemptAt) && nextAttemptAt > this.now()) break;
      try {
        await send(entry.record);
      } catch (error) {
        if (error instanceof NetworkFailure) {
          const entries = this.entries();
          const current = entries.find(item => item.record.idempotencyKey === entry.record.idempotencyKey);
          if (current) {
            current.attemptCount = (current.attemptCount ?? 0) + 1;
            if (current.attemptCount >= OUTBOX_MAX_ATTEMPTS) {
              current.state = 'REJECTED';
              current.error = '网络重试次数已达上限，请手动重试。';
              delete current.nextAttemptAt;
            } else {
              current.nextAttemptAt = new Date(this.now() + retryDelayMs(current.attemptCount)).toISOString();
            }
          }
          this.write(entries);
          networkError = true;
          break;
        }
        // Authentication or authorization loss invalidates this scoped queue.
        // Let the page clear it after showing the failure; never keep records
        // that could be replayed under a revoked actor.
        if (error instanceof HttpFailure && (error.status === 409 || [401, 403].includes(error.status))) throw error;
        const entries = this.entries();
        const current = entries.find(item => item.record.idempotencyKey === entry.record.idempotencyKey);
        if (current) {
          current.state = 'REJECTED';
          current.error = error instanceof Error ? error.message : '服务未确认记录。';
        }
        this.write(entries);
        continue;
      }
      // Remove only after a response containing a server observation id.
      this.write(this.entries().filter(item => item.record.idempotencyKey !== entry.record.idempotencyKey));
      sent += 1;
    }
    const remaining = this.entries();
    return {
      sent,
      pending: remaining.filter(item => item.state === 'PENDING').length,
      rejected: remaining.filter(item => item.state === 'REJECTED').length,
      networkError,
      nextAttemptAt: this.nextRetryAt(),
    };
  }
}

interface FlushResult {
  sent: number;
  pending: number;
  rejected: number;
  networkError: boolean;
  nextAttemptAt: number | null;
}

export function makeRecords(
  patient: string,
  temperature: number,
  selectedSymptoms: string[],
  source: RecordSource,
  observedAt: string,
  makeKey: () => string = makeIdempotencyKey,
): RecordInput[] {
  if (!patient || typeof patient !== 'string') throw new Error('当前身份尚未绑定患者档案。');
  if (!Number.isFinite(temperature) || temperature < 34 || temperature > 43) throw new Error('请输入 34–43℃ 之间的体温。');
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now()) throw new Error('记录时间无效或不能晚于当前时间。');
  const confidence = Date.now() - Date.parse(observedAt) > 24 * 60 * 60 * 1_000 ? 'LOW' as const : undefined;
  const shared = { patientId: patient, observedAt, source, tags: [] as string[], ...(confidence === undefined ? {} : { confidence }) };
  const records: RecordInput[] = [{ ...shared, code: 'TEMP', display: '体温', valueNumeric: temperature, unit: '℃', idempotencyKey: makeKey() }];
  for (const code of [...new Set(selectedSymptoms)]) {
    const item = symptoms.find(symptom => symptom.code === code);
    if (!item) throw new Error('存在无法识别的症状，请刷新后重试。');
    records.push({ ...shared, code: `SYMPTOM_${item.code}`, display: item.label, valueCoded: item.code, unit: '1', idempotencyKey: makeKey() });
  }
  return records;
}

export function makeSymptomRecords(
  patient: string,
  selectedSymptoms: string[],
  source: RecordSource,
  observedAt: string,
  makeKey: () => string = makeIdempotencyKey,
): RecordInput[] {
  if (!patient || typeof patient !== 'string') throw new Error('当前身份尚未绑定患者档案。');
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now()) throw new Error('记录时间无效或不能晚于当前时间。');
  if (!selectedSymptoms.length) throw new Error('请选择本次实际出现的症状。');
  const confidence = Date.now() - Date.parse(observedAt) > 24 * 60 * 60 * 1_000 ? 'LOW' as const : undefined;
  return [...new Set(selectedSymptoms)].map(code => {
    const item = symptoms.find(symptom => symptom.code === code);
    if (!item) throw new Error('存在无法识别的症状，请刷新后重试。');
    return { patientId: patient, observedAt, source, tags: [], ...(confidence === undefined ? {} : { confidence }), code: `SYMPTOM_${item.code}`, display: code === 'FEVER_HIGH' ? '持续高热' : item.label, valueCoded: item.code, unit: '1', idempotencyKey: makeKey() };
  });
}

export function makeIdempotencyKey(): string {
  return `wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function errorStatus(error: unknown): number | undefined {
  return object(error) && typeof error.status === 'number' ? error.status : undefined;
}

function asNetworkFailure(error: unknown): NetworkFailure | null {
  const status = errorStatus(error);
  if (status === 0) return new NetworkFailure('网络连接失败，尚未确认服务端接收。');
  if (error instanceof NetworkFailure) return error;
  return null;
}

function sessionIdentity(value: MiniSession | null): string | null {
  return value ? JSON.stringify([value.userId, value.actorId, value.patientId ?? null]) : null;
}

export async function sendRecord(record: RecordInput, expectedIdentity?: string): Promise<void> {
  const before = session();
  if (!before || sessionIdentity(before) !== (expectedIdentity ?? sessionIdentity(before)) || currentPatientId() !== record.patientId) throw new HttpFailure('身份已切换，请刷新当前页面。', 409);
  let value: unknown;
  try {
    value = await request<unknown>('/api/v1/observations', 'POST', record);
  } catch (error) {
    const network = asNetworkFailure(error);
    if (network) throw network;
    const status = errorStatus(error);
    // A successful HTTP status with an invalid envelope is an unknown outcome:
    // the write may have committed before the response was truncated.
    if (status !== undefined && status >= 200 && status < 300) throw new NetworkFailure('服务响应不完整，记录尚未确认；重试会沿用同一条，不会重复记录。');
    if (status !== undefined) throw new HttpFailure(error instanceof Error ? error.message : '服务未确认记录。', status);
    throw error;
  }
  const after = session();
  if (!after || sessionIdentity(after) !== sessionIdentity(before) || currentPatientId() !== record.patientId) throw new HttpFailure('身份已切换，请刷新当前页面。', 409);
  if (!object(value) || !object(value.observation) || !validReceipt(value.observation, record)) throw new NetworkFailure('服务响应不完整或与原记录不一致，记录尚未确认；重试会沿用同一条，不会重复记录。');
}

function validReceipt(value: Record<string, unknown>, record: RecordInput): boolean {
  return typeof value.id === 'string' && Boolean(value.id) && value.patientId === record.patientId &&
    value.code === record.code && value.unit === record.unit && value.observedAt === record.observedAt &&
    value.source === record.source && value.idempotencyKey === record.idempotencyKey &&
    (record.notes === undefined || value.notes === record.notes) &&
    (record.confidence === undefined || value.confidence === record.confidence);
}

export async function submitRecords(
  records: RecordInput[],
  send: (record: RecordInput) => Promise<void>,
  outbox: Pick<Outbox, 'enqueue'>,
): Promise<{ confirmed: number; queued: number; remaining: RecordInput[]; error: string | null }> {
  let confirmed = 0;
  for (let index = 0; index < records.length; index += 1) {
    try {
      await send(records[index]!);
      confirmed += 1;
    } catch (error) {
      const network = asNetworkFailure(error);
      if (network) {
        const remaining = records.slice(index);
        try { outbox.enqueue(remaining, { retryAfterMs: OUTBOX_BASE_DELAY_MS }); return { confirmed, queued: remaining.length, remaining: [], error: null }; }
        catch (storageError) { return { confirmed, queued: 0, remaining, error: storageError instanceof Error ? storageError.message : '本机保存失败。' }; }
      }
      return { confirmed, queued: 0, remaining: records.slice(index), error: error instanceof Error ? error.message : '服务未确认记录。' };
    }
  }
  return { confirmed, queued: 0, remaining: [], error: null };
}

export function sourceForSession(value: MiniSession): RecordSource {
  return value.role === 'PATIENT' ? 'PATIENT_REPORTED' : 'CAREGIVER_REPORTED';
}

export function outboxForCurrentSession(): Outbox | null {
  const current = session();
  const patient = currentPatientId();
  return current && patient ? new Outbox(storagePort(), current.userId, current.actorId, patient) : null;
}

export function sessionScope(value: MiniSession | null = session()): string | null {
  return sessionIdentity(value);
}
