import { ApiFailure, patientId, request, session } from '../../api';

export interface PatientAuditViewer {
  displayName: string;
  relation: string;
  context: string;
  visibility?: 'G1' | 'G2' | 'G3';
}

export interface PatientAuditItem {
  at: string;
  action: string;
  category: string;
  viewer: PatientAuditViewer;
  timeLabel: string;
  viewerLabel: string;
}

export interface PatientAuditPage {
  patientId: string;
  from: string;
  to: string;
  items: PatientAuditItem[];
  nextAfter: string | null;
}

const PAGE_LIMIT = 20;
const MAX_CURSOR_LENGTH = 2048;
const RELATIONS = new Set(['医护人员', '法定监护人', '照护者', '配偶', '代理人', '患者本人', '系统', '访问者']);
const CONTEXTS = new Set(['随诊', '主诊', '值班', '会诊', '护理', '自动', ...RELATIONS]);

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 400): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function only(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every(key => fields.includes(key)); }
function instant(value: unknown): value is string {
  if (!text(value, 80) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function visibilityLabel(value: 'G1' | 'G2' | 'G3'): string {
  return value === 'G1' ? '完整共享' : value === 'G2' ? '摘要' : '仅知会';
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Strict patient-facing projection. Cursor is deliberately opaque and is only validated as a bounded string. */
export function parseAuditPage(value: unknown, id: string, now = Date.now()): PatientAuditPage {
  if (!text(id, 200) || !object(value) || !only(value, ['patientId', 'from', 'to', 'items', 'nextAfter']) || value.patientId !== id || !instant(value.from) || !instant(value.to) || Date.parse(value.from) > Date.parse(value.to) || Date.parse(value.to) > now) throw new Error('访问记录响应格式无效。');
  if (!Array.isArray(value.items) || value.items.length > 100) throw new Error('访问记录响应格式无效。');
  const items = value.items.map(item => {
    if (!object(item) || !only(item, ['at', 'action', 'category', 'viewer']) || !instant(item.at) || Date.parse(item.at) < Date.parse(value.from as string) || Date.parse(item.at) > Date.parse(value.to as string) || !text(item.action, 400) || !text(item.category, 200) || !object(item.viewer) || !only(item.viewer, ['displayName', 'relation', 'context', 'visibility']) || !text(item.viewer.displayName, 200) || !text(item.viewer.relation, 80) || !RELATIONS.has(item.viewer.relation) || !text(item.viewer.context, 80) || !CONTEXTS.has(item.viewer.context) || item.viewer.visibility !== undefined && !['G1', 'G2', 'G3'].includes(String(item.viewer.visibility))) throw new Error('访问记录条目格式无效。');
    const viewer = { displayName: item.viewer.displayName, relation: item.viewer.relation, context: item.viewer.context, ...(item.viewer.visibility === undefined ? {} : { visibility: item.viewer.visibility as 'G1' | 'G2' | 'G3' }) };
    const visibility = viewer.visibility ? ` · ${visibilityLabel(viewer.visibility)}` : '';
    return { at: item.at, action: item.action, category: item.category, viewer, timeLabel: formatTime(item.at), viewerLabel: `${viewer.displayName}（${viewer.context}${visibility}）` };
  });
  if (value.nextAfter !== null && !text(value.nextAfter, MAX_CURSOR_LENGTH)) throw new Error('访问记录分页游标无效。');
  return { patientId: id, from: value.from, to: value.to, items, nextAfter: value.nextAfter as string | null };
}

interface Scope { userId: string; actorId: string; patientId: string; }
function scope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(value: Scope): boolean { const current = scope(); return Boolean(current && current.userId === value.userId && current.actorId === value.actorId && current.patientId === value.patientId); }
function itemKey(item: PatientAuditItem): string { return [item.at, item.action, item.category, item.viewer.displayName, item.viewer.relation, item.viewer.context, item.viewer.visibility ?? ''].join('\u0000'); }
function resetPage(page: MiniPageContext, fields: Record<string, unknown>): void { page.setData({ loading: false, loadingMore: false, items: [], nextAfter: null, error: '', denied: false, ...fields }); }
export function auditPath(id: string, after?: string): string {
  if (!text(id, 200) || after !== undefined && !text(after, MAX_CURSOR_LENGTH)) throw new Error('访问记录查询范围无效。');
  return `/api/v1/patients/${encodeURIComponent(id)}/audit?limit=${PAGE_LIMIT}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`;
}

const auditPage: Record<string, any> & ThisType<MiniPageContext> = {
  data: {
    loading: false,
    loadingMore: false,
    error: '',
    denied: false,
    items: [] as PatientAuditItem[],
    nextAfter: null as string | null,
    scopeKey: '',
    revision: 0,
    seenCursors: [] as string[],
    seenItems: [] as string[],
  },

  onLoad() {},
  onShow() {
    const current = session();
    if (!current) { this.invalidate(); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const currentScope = scope();
    if (!currentScope) { this.invalidate(); this.setData({ error: '当前微信身份尚未绑定患者档案。' }); return; }
    const key = `${currentScope.userId}:${currentScope.actorId}:${currentScope.patientId}`;
    if (key !== this.data.scopeKey || this.data.denied) { this.setData({ scopeKey: key }); this.load(currentScope); }
  },
  onHide() { this.invalidate(); },
  onUnload() { this.invalidate(); },

  invalidate() {
    this.data.revision += 1;
    this.setData({ revision: this.data.revision, scopeKey: '', loading: false, loadingMore: false, items: [], nextAfter: null, seenCursors: [], seenItems: [] });
  },

  load(currentScope: Scope = scope() as Scope) {
    if (!currentScope || !sameScope(currentScope)) { resetPage(this, { error: '身份已切换，请返回首页后重新打开。' }); return; }
    const revision = (this.data.revision as number) + 1;
    this.setData({ revision, loading: true, loadingMore: false, error: '', denied: false, items: [], nextAfter: null, seenCursors: [], seenItems: [] });
    this.read(currentScope, revision, undefined, false);
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.nextAfter) return;
    const currentScope = scope(); const cursor = this.data.nextAfter as string;
    if (!currentScope || !sameScope(currentScope) || (this.data.seenCursors as string[]).includes(cursor)) return;
    this.setData({ loadingMore: true });
    this.read(currentScope, this.data.revision as number, cursor, true);
  },

  async read(currentScope: Scope, revision: number, after: string | undefined, append: boolean) {
    try {
      const id = currentScope.patientId;
      const value = parseAuditPage(await request<unknown>(auditPath(id, after)), id);
      if (revision !== this.data.revision || !sameScope(currentScope)) return;
      const existing = append ? this.data.items as PatientAuditItem[] : [];
      const keys = new Set<string>(append ? (this.data.seenItems as string[]) : []);
      const nextItems = [...existing];
      for (const item of value.items) { const key = itemKey(item); if (!keys.has(key)) { keys.add(key); nextItems.push(item); } }
      const cursors = append ? [...(this.data.seenCursors as string[]), after!] : [];
      if (value.nextAfter && cursors.includes(value.nextAfter)) throw new Error('访问记录分页游标未推进。');
      this.setData({ items: nextItems, nextAfter: value.nextAfter, seenCursors: cursors, seenItems: [...keys], error: '', denied: false });
    } catch (error) {
      // 401/403 can rotate or clear the session before control reaches here;
      // handle them before the scope check so stale sensitive items are always
      // cleared even when sameScope(currentScope) is already false.
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) { this.invalidate(); this.setData({ denied: true, error: '当前身份已无权查看访问记录，请返回首页重新核对。' }); return; }
      if (revision !== this.data.revision || !sameScope(currentScope)) return;
      this.setData({ error: error instanceof Error ? error.message : '访问记录读取失败，请稍后重试。' });
    } finally {
      if (revision === this.data.revision) this.setData({ loading: false, loadingMore: false });
    }
  },
  refresh() { const currentScope = scope(); if (currentScope) this.load(currentScope); },
};

if (typeof Page === 'function') Page(auditPage);
