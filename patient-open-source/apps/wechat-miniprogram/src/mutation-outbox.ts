import { ApiFailure } from './api';
import { MUTATION_OUTBOX_KEY_PREFIX } from './config';

/** 微信本地存储的最小适配接口，便于在真机和单元测试中复用。 */
export interface MiniStorage {
  getStorageSync<T = unknown>(key: string): T;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
}

export type MutationOperation = 'MEDICATION_LOG' | 'MEDICATION_PLAN' | 'MENSTRUAL_CYCLE' | 'MEDICATION_SIDE_EFFECT' | 'MEDICATION_SCREENING' | 'PRIVATE_DIARY' | 'VACCINATION_RECORD' | 'FAMILY_HISTORY' | 'PSYCH_SCREENING' | 'MESSAGE_READ' | 'EDUCATION_READ' | 'JOINT_ASSESSMENT' | 'EMERGENCY_PLAN' | 'EMERGENCY_KIT' | 'EMERGENCY_CARD' | 'EMERGENCY_SHARE' | 'LIFE_EVENT' | 'WORK_SUPPORT' | 'PREGNANCY_STATUS' | 'PREGNANCY_QUESTIONS' | 'PREGNANCY_QUESTIONS_USE';
export interface MutationEntry {
  operation: MutationOperation;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  state: 'PENDING' | 'REJECTED';
  error?: string;
}


/** 生成一次后会写入队列的幂等键；重试始终复用该键。 */
export function newIdempotencyKey(operation: MutationOperation): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `wx-${operation.toLowerCase()}-${suffix}`;
}

function nonEmpty(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validEntry(value: unknown): value is MutationEntry {
  if (!object(value) || !['MEDICATION_LOG', 'MEDICATION_PLAN', 'MENSTRUAL_CYCLE', 'MEDICATION_SIDE_EFFECT', 'MEDICATION_SCREENING', 'PRIVATE_DIARY', 'VACCINATION_RECORD', 'FAMILY_HISTORY', 'PSYCH_SCREENING', 'MESSAGE_READ', 'EDUCATION_READ', 'JOINT_ASSESSMENT', 'EMERGENCY_PLAN', 'EMERGENCY_KIT', 'EMERGENCY_CARD', 'EMERGENCY_SHARE', 'LIFE_EVENT', 'WORK_SUPPORT', 'PREGNANCY_STATUS', 'PREGNANCY_QUESTIONS', 'PREGNANCY_QUESTIONS_USE'].includes(String(value.operation)) ||
    !nonEmpty(value.idempotencyKey) || !object(value.payload) || value.payload.idempotencyKey !== value.idempotencyKey ||
    !nonEmpty(value.createdAt, 80) || !Number.isFinite(Date.parse(value.createdAt)) || !['PENDING', 'REJECTED'].includes(String(value.state))) return false;
  return value.error === undefined || nonEmpty(value.error, 4096);
}

function storageKey(userId: string, actorId: string, patientId: string): string {
  // Actor/patient are server-issued identifiers. Keep their values in the key to
  // ensure a delayed response or retry cannot cross an identity switch.
  return `${MUTATION_OUTBOX_KEY_PREFIX}:${userId}:${actorId}:${patientId}`;
}

export interface FlushResult { sent: number; pending: number; rejected: number; networkError: boolean; denied: boolean; }

export class MutationOutbox {
  readonly key: string;
  constructor(private readonly storage: MiniStorage, actorId: string, patientId: string, userId = actorId) {
    if (!nonEmpty(userId, 256) || !nonEmpty(actorId, 256) || !nonEmpty(patientId, 256)) throw new Error('本地待提交记录缺少身份范围。');
    this.key = storageKey(userId, actorId, patientId);
  }

  entries(): MutationEntry[] {
    let raw: unknown;
    try { raw = this.storage.getStorageSync<unknown>(this.key); } catch { throw new Error('无法读取本机待提交记录，请检查微信存储权限。'); }
    if (raw === undefined || raw === null || raw === '') return [];
    // wx.getStorageSync returns the stored value directly; tolerate legacy JSON
    // strings so an interrupted migration never overwrites recoverable entries.
    let value: unknown = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new Error('本机待提交记录格式损坏，未覆盖原有数据。'); }
    }
    if (!Array.isArray(value) || !value.every(validEntry)) throw new Error('本机待提交记录格式损坏，未覆盖原有数据。');
    return value.map(entry => ({ ...entry, payload: { ...entry.payload } }));
  }

  private write(entries: MutationEntry[]): void {
    try { this.storage.setStorageSync(this.key, entries); }
    catch { throw new Error('无法保存到本机。尚未确认的操作仍需保留，请勿清理微信存储。'); }
  }

  /**
   * 清理当前身份的待提交操作。十来个页面共用同一个队列键：某一页的功能被拒（403）时
   * 只能删掉该页给出的操作类型，不能连带删掉别的页面离线记下的用药打卡、应急预案等；
   * 只有不传 operations（会话真正失效）时才清空整个键。
   */
  clear(operations?: readonly MutationOperation[]): void {
    if (!operations) {
      try { this.storage.removeStorageSync(this.key); }
      catch { throw new Error('无法清理当前身份的本机待提交操作。'); }
      return;
    }
    const remaining = this.entries().filter(entry => !operations.includes(entry.operation));
    try { if (remaining.length) this.storage.setStorageSync(this.key, remaining); else this.storage.removeStorageSync(this.key); }
    catch { throw new Error('无法清理当前身份的本机待提交操作。'); }
  }

  enqueue(entry: Omit<MutationEntry, 'createdAt' | 'state'> & Partial<Pick<MutationEntry, 'createdAt' | 'state'>>): void {
    if (!validEntry({ ...entry, createdAt: entry.createdAt ?? new Date().toISOString(), state: entry.state ?? 'PENDING' })) throw new Error('待提交操作格式无效。');
    const next: MutationEntry = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString(), state: entry.state ?? 'PENDING' };
    const entries = this.entries();
    const prior = entries.find(item => item.idempotencyKey === next.idempotencyKey);
    if (prior) {
      if (JSON.stringify(prior.payload) !== JSON.stringify(next.payload) || prior.operation !== next.operation) throw new Error('同一次提交的内容已经变了，本机的操作没有被覆盖。');
      return;
    }
    entries.push(next);
    this.write(entries);
  }

  /** 仅允许重新填写已被服务端明确拒绝的命令；未知结果必须保留原幂等键。 */
  discardRejected(idempotencyKey: string, operation: MutationOperation): void {
    const entries = this.entries();
    const entry = entries.find(item => item.idempotencyKey === idempotencyKey && item.operation === operation);
    if (!entry || entry.state !== 'REJECTED') throw new Error('操作结果尚未确认，请先重试原操作。');
    this.write(entries.filter(item => item !== entry));
  }

  async flush(send: (entry: MutationEntry) => Promise<void>, retryRejected = false, supportedOperations?: readonly MutationOperation[]): Promise<FlushResult> {
    let sent = 0; let networkError = false; let denied = false;
    for (const entry of this.entries()) {
      if (supportedOperations && !supportedOperations.includes(entry.operation)) continue;
      if (entry.state === 'REJECTED' && !retryRejected) continue;
      let confirmed = false;
      try { await send(entry); confirmed = true; }
      catch (error) {
        // A malformed 2xx envelope is also an unknown write outcome: the server
        // may have committed before the client lost the response. Keep the
        // original idempotency key queued instead of marking it rejected.
        // 5xx 与 429 是服务端暂时不可用或限频，不是对这条操作的结论：同样保留待重试，不标成被拒绝。
        if (error instanceof ApiFailure && (error.status === 0 || (error.status >= 200 && error.status < 300) || error.status === 429 || error.status >= 500) ||
          error instanceof Error && /原幂等键已保留|尚未确认服务端|服务响应不完整/.test(error.message)) {
          networkError = true;
          break;
        }
        const entries = this.entries();
        const current = entries.find(item => item.idempotencyKey === entry.idempotencyKey);
        if (current) { current.state = 'REJECTED'; current.error = error instanceof Error ? error.message : '服务未确认该操作。'; }
        this.write(entries);
        if (error instanceof ApiFailure && [401, 403].includes(error.status)) { denied = true; break; }
      }
      if (networkError || denied || !confirmed) continue;
      const remaining = this.entries().filter(item => item.idempotencyKey !== entry.idempotencyKey);
      this.write(remaining); // remove only after a validated server response
      sent += 1;
    }
    const remaining = this.entries();
    return { sent, pending: remaining.filter(item => item.state === 'PENDING').length, rejected: remaining.filter(item => item.state === 'REJECTED').length, networkError, denied };
  }
}

/**
 * 失权后该清哪些待提交操作。会话已被清除（刷新令牌被服务端拒绝）说明整个身份失效，
 * 清空该身份全部队列，避免换人登录后残留；会话仍在说明只是本页功能被拒，只清本页的操作类型。
 */
export function deniedOperations(operations: readonly MutationOperation[], sessionAlive: boolean): readonly MutationOperation[] | undefined {
  return sessionAlive ? operations : undefined;
}

export function wxStorage(): MiniStorage {
  return { getStorageSync: key => wx.getStorageSync(key), setStorageSync: (key, value) => wx.setStorageSync(key, value), removeStorageSync: key => wx.removeStorageSync(key) };
}
