import { request } from '../../api';
import { at } from '../../date-format';

export interface DiaryShare { id: string; entryId: string; targetActorId: string; status: 'ACTIVE' | 'REVOKED'; version: number; expiresAt: string; expiresLabel: string }
export interface DiaryTarget { actorId: string; label: string }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 300 && !/[\0\r\n]/.test(value);
function parseShare(value: unknown, patientId: string): DiaryShare {
  if (!object(value) || value.patientId !== patientId || !text(value.id) || !text(value.entryId) || !text(value.targetActorId) || !['ACTIVE', 'REVOKED'].includes(String(value.status)) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('私人记录授权状态无效，请重新读取。');
  return { id: value.id, entryId: value.entryId, targetActorId: value.targetActorId, status: value.status as DiaryShare['status'], version: Number(value.version), expiresAt: value.expiresAt, expiresLabel: at(value.expiresAt) };
}
export async function loadDiaryShares(patientId: string): Promise<DiaryShare[]> {
  const shares: DiaryShare[] = [];
  const cursors = new Set<string>();
  let after = '';
  do {
    const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(patientId)}/private-diary/share${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    if (!object(value) || !Array.isArray(value.shares) || (value.nextAfter !== undefined && !text(value.nextAfter))) throw new Error('私人记录授权列表无效。');
    shares.push(...value.shares.map(item => parseShare(item, patientId)));
    after = typeof value.nextAfter === 'string' ? value.nextAfter : '';
    if (after && cursors.has(after)) throw new Error('私人记录授权分页异常，请重新读取。');
    cursors.add(after);
  } while (after);
  return shares;
}
export async function loadDiaryTargets(patientId: string): Promise<DiaryTarget[]> {
  const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(patientId)}/private-diary/share-targets`);
  if (!object(value) || value.patientId !== patientId || !Array.isArray(value.targets)) throw new Error('可分享医生列表无效。');
  return value.targets.map(item => {
    if (!object(item) || !text(item.actorId) || !text(item.label)) throw new Error('可分享医生信息无效。');
    return { actorId: item.actorId, label: item.label };
  });
}
export async function mutateDiaryShare(patientId: string, entryId: string, method: 'POST' | 'DELETE', payload: Record<string, unknown>): Promise<DiaryShare> {
  const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(patientId)}/private-diary/${encodeURIComponent(entryId)}/share`, method, payload);
  if (!object(value) || typeof value.created !== 'boolean') throw new Error('私人记录授权尚未确认，请重试。');
  const share = parseShare(value.share, patientId);
  if (share.entryId !== entryId || (method === 'POST' && (share.targetActorId !== payload.targetActorId || share.status !== 'ACTIVE')) || (method === 'DELETE' && (share.id !== payload.shareId || share.status !== 'REVOKED'))) throw new Error('私人记录授权回执不一致，请重新读取。');
  return share;
}
export async function removeDiaryEntry(patientId: string, entryId: string, payload: Record<string, unknown>): Promise<number> {
  const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(patientId)}/private-diary/${encodeURIComponent(entryId)}`, 'DELETE', payload);
  if (!object(value) || value.deleted !== true || !object(value.entry) || value.entry.id !== entryId || value.entry.patientId !== patientId || value.entry.tombstone !== true || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || value.entry.revision !== value.revision) throw new Error('私人记录删除尚未确认，请重试。');
  return Number(value.revision);
}
