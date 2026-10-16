import { ApiFailure, request, session } from './api';
import { API_BASE } from './config';
import { archiveScopeKey, sameArchiveScope, validateArchive, type ArchiveScope, type ClinicalArchive } from './clinical-archive';
import { validateVitals, type VitalRecord } from './local-vitals';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function assertClinicalScope(scope: ArchiveScope): void { if (!sameArchiveScope(scope)) throw new Error('身份已变更，请重新打开当前患者页面。'); }
function base(scope: ArchiveScope): string { assertClinicalScope(scope); return `/api/v1/patients/${encodeURIComponent(scope.patientId)}`; }
function commandKey(scope: ArchiveScope, action: string): string { return `${archiveScopeKey(scope)}:pending:${action}`; }

/** 网络结果未知时保留同一命令，不允许以新内容覆盖一次未确认的写入。 */
export async function clinicalMutation<T>(scope: ArchiveScope, action: string, path: string, method: 'POST' | 'PUT' | 'DELETE', payload: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  assertClinicalScope(scope);
  const key = commandKey(scope, action); const fingerprint = JSON.stringify(payload);
  const pending = wx.getStorageSync<unknown>(key);
  let idempotencyKey: string;
  if (pending) {
    if (!object(pending) || typeof pending.idempotencyKey !== 'string' || typeof pending.fingerprint !== 'string') throw new Error('待确认操作无法读取，请保留数据并重试。');
    if (pending.fingerprint !== fingerprint) {
      // A previous page may have been closed after a lost response. Reconcile the
      // original authorized command first; never claim the new draft was saved.
      let original: unknown;
      try { original = pending.payload ?? JSON.parse(pending.fingerprint); } catch { throw new Error('上次待确认内容已损坏，请保留本机资料。'); }
      if (!object(original) || JSON.stringify(original) !== pending.fingerprint) throw new Error('上次待确认内容无效，请保留本机资料。');
      await clinicalMutation(scope, action, path, method, original, parse);
      throw new Error('上次保存已确认。当前填写的内容尚未保存，请核对后再次点击保存。');
    }
    idempotencyKey = pending.idempotencyKey;
  } else {
    idempotencyKey = `wx-clinical-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    wx.setStorageSync(key, { idempotencyKey, fingerprint, payload });
  }
  try {
    const raw = await request<unknown>(path, method, { ...payload, idempotencyKey });
    assertClinicalScope(scope);
    const result = parse(raw);
    try { wx.removeStorageSync(key); } catch { /* The acknowledged command remains safe to replay. */ }
    return result;
  } catch (error) {
    // A definite rejection did not commit. Keep unknown/network/5xx receipts for replay.
    const status = object(error) ? error.status : undefined;
    if (sameArchiveScope(scope) && typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) { try { wx.removeStorageSync(key); } catch { /* preserve original error */ } }
    throw error;
  }
}

export function parseServerArchive(value: unknown, scope: ArchiveScope): ClinicalArchive {
  if (!object(value) || value.patientId !== scope.patientId || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.recordedBy !== 'string' || value.deletedAt) throw new Error('档案回执不完整，请重新读取后核对。');
  if (value.artifactId !== undefined && typeof value.artifactId !== 'string') throw new Error('档案附件标识无效。');
  return validateArchive({ ...value, imagePath: '' } as unknown as ClinicalArchive);
}
export async function loadClinicalArchives(scope: ArchiveScope): Promise<ClinicalArchive[]> {
  const data = await request<unknown>(`${base(scope)}/clinical-archives`); assertClinicalScope(scope);
  if (!object(data) || !Array.isArray(data.records)) throw new Error('医疗档案读取失败，请重试。');
  return data.records.map(row => parseServerArchive(row, scope)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
export function archivePayload(value: ClinicalArchive): Record<string, unknown> {
  const row = validateArchive(value);
  return Object.fromEntries(['kind', 'title', 'hospital', 'department', 'doctor', 'diagnosis', 'date', 'dischargeDate', 'content', 'abnormal', 'checkCategory', 'items', 'drugs', 'status', 'source', 'demo', 'artifactId'].filter(key => row[key as keyof ClinicalArchive] !== undefined).map(key => [key, row[key as keyof ClinicalArchive]]));
}
export async function saveClinicalArchive(scope: ArchiveScope, value: ClinicalArchive, legacyId?: string): Promise<ClinicalArchive> {
  const editing = Boolean(value.id && value.version);
  const path = `${base(scope)}/clinical-archives${editing ? `/${encodeURIComponent(value.id)}` : ''}`;
  const payload = { ...archivePayload(value), expectedVersion: editing ? value.version : 0, ...(legacyId ? { idempotencyKey: `legacy-${legacyId}` } : {}) };
  // Migration uses a stable key per old record even after a successful earlier import.
  if (legacyId) {
    const result = await request<unknown>(path, 'POST', payload); assertClinicalScope(scope);
    if (!object(result)) throw new Error('档案导入回执无效。');
    return parseServerArchive(result.record, scope);
  }
  return clinicalMutation(scope, `archive:${editing ? value.id : 'new'}`, path, editing ? 'PUT' : 'POST', payload, result => {
    if (!object(result)) throw new Error('档案保存回执无效。'); return parseServerArchive(result.record, scope);
  });
}
export async function removeClinicalArchive(scope: ArchiveScope, value: ClinicalArchive): Promise<void> {
  await clinicalMutation(scope, `archive-delete:${value.id}`, `${base(scope)}/clinical-archives/${encodeURIComponent(value.id)}`, 'DELETE', { expectedVersion: value.version }, result => {
    if (!object(result) || !object(result.record) || result.record.id !== value.id || result.record.patientId !== scope.patientId || typeof result.record.deletedAt !== 'string') throw new Error('删除结果尚未确认，请重新读取。');
  });
}

export async function uploadReportImage(scope: ArchiveScope, path: string): Promise<string> {
  assertClinicalScope(scope);
  if (!wx.getFileSystemManager) throw new Error('当前微信版本不能读取图片，请更新后重试。');
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => wx.getFileSystemManager!().readFile({ filePath: path, success: result => typeof result.data === 'string' ? reject(new Error('图片格式无效。')) : resolve(result.data), fail: () => reject(new Error('原图无法读取，请重新选择。')) }));
  assertClinicalScope(scope);
  if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的报告图片。');
  const header = new Uint8Array(bytes);
  const contentType = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? 'image/jpeg' : header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 ? 'image/png' : '';
  if (!contentType) throw new Error('目前支持 JPG 或 PNG 原图，请重新选择。');
  const metadata = await request<unknown>(`${base(scope)}/artifacts`, 'POST', bytes, { contentType, artifactKind: 'LAB_IMAGE' });
  assertClinicalScope(scope);
  if (!object(metadata) || metadata.patientId !== scope.patientId || typeof metadata.id !== 'string' || metadata.status !== 'READY') throw new Error('原图上传尚未确认，请重试。');
  return metadata.id;
}
export async function previewReportImage(scope: ArchiveScope, artifactId: string): Promise<void> {
  const prefix = `${base(scope)}/artifacts/${encodeURIComponent(artifactId)}`;
  const grant = await request<unknown>(`${prefix}/url`); assertClinicalScope(scope);
  if (!object(grant) || typeof grant.url !== 'string' || !wx.downloadFile) throw new Error('原图暂时无法打开。');
  const current = session()!;
  const path = await new Promise<string>((resolve, reject) => wx.downloadFile!({ url: `${API_BASE}${prefix}/content?grant=${encodeURIComponent(grant.url as string)}`, header: { authorization: `Bearer ${current.accessToken}`, 'x-actor-id': current.actorId }, success: result => result.statusCode === 200 ? resolve(result.tempFilePath) : reject(new ApiFailure('原图读取失败，请重新读取档案后核对权限。', result.statusCode)), fail: () => reject(new Error('原图下载失败，请检查网络。')) }));
  assertClinicalScope(scope);
  if (!wx.previewImage) throw new Error('当前环境不支持图片预览。');
  wx.previewImage({ current: path, urls: [path] });
}

export interface ServerVital extends VitalRecord { id: string; patientId: string; recordedBy: string; }
export async function loadAuxiliaryVitals(scope: ArchiveScope): Promise<{ records: ServerVital[]; latest: ServerVital | null }> {
  const result = await request<unknown>(`${base(scope)}/auxiliary-vitals`); assertClinicalScope(scope);
  const parse = (row: unknown): ServerVital => { if (!object(row) || row.patientId !== scope.patientId || typeof row.id !== 'string' || typeof row.recordedBy !== 'string') throw new Error('体征记录格式无效。'); validateVitals(row as unknown as VitalRecord); return row as unknown as ServerVital; };
  if (!object(result) || !Array.isArray(result.records)) throw new Error('体征记录暂时无法读取。');
  return { records: result.records.map(parse), latest: result.latest === null ? null : parse(result.latest) };
}
export async function saveAuxiliaryVitals(scope: ArchiveScope, value: VitalRecord): Promise<ServerVital> {
  validateVitals(value);
  return clinicalMutation(scope, 'vitals:new', `${base(scope)}/auxiliary-vitals`, 'POST', { ...value }, result => {
    if (!object(result) || !object(result.record) || result.record.patientId !== scope.patientId || typeof result.record.id !== 'string') throw new Error('测量保存结果尚未确认。');
    validateVitals(result.record as unknown as VitalRecord); return result.record as unknown as ServerVital;
  });
}
