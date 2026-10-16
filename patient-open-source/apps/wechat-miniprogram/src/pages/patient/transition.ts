import { ApiFailure, patientId, request, session } from '../../api';

interface Scope { userId: string; actorId: string; patientId: string; }
interface Section { title: string; state: 'LOADING' | 'READY' | 'DENIED' | 'UNAVAILABLE'; items: string[]; error?: string; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function scope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(value: Scope): boolean { const current = scope(); return Boolean(current && current.userId === value.userId && current.actorId === value.actorId && current.patientId === value.patientId); }
function formatDate(value: string): string { return new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
function parseMilestones(value: unknown, id: string): string[] {
  if (!object(value) || !only(value, ['patientId', 'asOf', 'ageYears', 'lifeStage', 'milestones']) || value.patientId !== id || !instant(value.asOf) || typeof value.ageYears !== 'number' || !Number.isSafeInteger(value.ageYears) || value.ageYears < 0 || value.ageYears > 150 || !['CHILD', 'TRANSITION', 'ADULT'].includes(String(value.lifeStage)) || !Array.isArray(value.milestones) || value.milestones.length !== 4) throw new Error('交接里程碑响应格式无效。');
  const ages = [16, 17, 17.5, 18];
  return [`当前年龄约 ${value.ageYears} 岁 · 截至 ${formatDate(value.asOf)}`, ...value.milestones.map((item, index) => { if (!object(item) || !only(item, ['atAge', 'label', 'reached']) || item.atAge !== ages[index] || !text(item.label, 300) || typeof item.reached !== 'boolean') throw new Error('交接里程碑条目格式无效。'); return `${item.reached ? '已到' : '未到'} · ${item.atAge === 17.5 ? '17 岁半' : `${item.atAge} 岁`} · ${item.label}`; }), '里程碑不会自动改变当前权限、收件人或交接计划。'];
}
function parsePlan(value: unknown, id: string): string[] {
  if (!object(value) || !only(value, ['plan', 'message']) || !text(value.message, 1000) || !object(value.plan) || !only(value.plan, ['patientId', 'readinessScore', 'readinessAssessedAt', 'status', 'overageMonths', 'declinedUntil', 'version', 'updatedAt'])) throw new Error('照护转介计划响应格式无效。');
  const item = value.plan; const overage = item.overageMonths; const version = item.version; const readinessValue = item.readinessScore;
  if (item.patientId !== id || !['NOT_STARTED', 'PREPARING', 'REFERRAL_SENT', 'ACCEPTED', 'DECLINED_BY_PATIENT'].includes(String(item.status)) || typeof overage !== 'number' || !Number.isSafeInteger(overage) || overage < 0 || overage > 1200 || typeof version !== 'number' || !Number.isSafeInteger(version) || readinessValue !== undefined && (typeof readinessValue !== 'number' || !Number.isSafeInteger(readinessValue) || readinessValue < 0 || readinessValue > 100) || item.readinessAssessedAt !== undefined && !instant(item.readinessAssessedAt) || item.declinedUntil !== undefined && !instant(item.declinedUntil) || item.updatedAt !== undefined && !instant(item.updatedAt)) throw new Error('照护转介计划响应格式无效。');
  const status = ({ NOT_STARTED: '尚未开始', PREPARING: '准备中', REFERRAL_SENT: '转介已发出', ACCEPTED: '已接收', DECLINED_BY_PATIENT: '暂不转介' } as Record<string, string>)[String(item.status)]; const readiness = readinessValue === undefined ? '尚未评估' : `${readinessValue} 分`; return [value.message, `当前状态：${status}`, `过渡就绪度：${readiness}`, item.declinedUntil ? `可在 ${formatDate(item.declinedUntil)} 后再次询问` : '暂无重新询问日期', item.updatedAt ? `更新于 ${formatDate(item.updatedAt)}` : '尚未建立计划', '页面只展示照护团队提供的进度，不会修改转介安排。'];
}
interface ReadinessItem { id: string; label: string; done: boolean }

Page({
  data: {
    loading: true,
    saving: false,
    readinessVersion: 0,
    readinessAvailable: false,
    readinessCanWrite: false,
    readinessUpdated: '',
    error: '',
    notice: '',
    scopeKey: '',
    sections: [] as Section[],
    showReadinessPanel: true,
    readinessScore: 0,
    readinessDone: 0,
    takeoverStarted: false,
    readinessItems: [
      { id: 'records', label: '知道在哪里查看自己的健康记录', done: false },
      { id: 'medications', label: '能说出目前正在使用的药物', done: false },
      { id: 'contact', label: '知道复诊时应该联系谁', done: false },
      { id: 'emergency', label: '看过一次家庭应急流程卡', done: false },
    ] as ReadinessItem[],
  },
  pendingReadiness: null as Record<string, unknown> | null,
  onLoad() {},
  onShow() {
    const current = scope();
    if (!current) { this.setData({ scopeKey: '', loading: false, error: '', sections: [] }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const key = `${current.userId}:${current.actorId}:${current.patientId}`;
    if (key !== this.data.scopeKey) {
      this.pendingReadiness = null;
      const items = (this.data.readinessItems as ReadinessItem[]).map(item => ({ ...item, done: false }));
      this.setData({ readinessCanWrite: ['PATIENT', 'LEGAL_GUARDIAN'].includes(session()?.role ?? ''), scopeKey: key, sections: [], readinessItems: items, readinessDone: 0, readinessScore: 0, takeoverStarted: false, readinessAvailable: false, readinessVersion: 0, readinessUpdated: '', saving: false, notice: '' });
      this.load(current);
    }
  },
  async load(expected = scope() as Scope) {
    if (!expected || !sameScope(expected)) return;
    this.setData({ loading: true, error: '', sections: [{ title: '成长与照护交接', state: 'LOADING', items: [] }, { title: '照护转介计划', state: 'LOADING', items: [] }] });
    const [milestone, plan, readiness] = await Promise.allSettled([
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/transition-milestones`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/transition-plan`),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/transition-readiness`),
    ]);
    if (!sameScope(expected)) return;
    const toSection = (title: string, result: PromiseSettledResult<unknown>, parser: (value: unknown) => string[]): Section => {
      if (result.status === 'fulfilled') {
        try { return { title, state: 'READY', items: parser(result.value) }; }
        catch (error) { return { title, state: 'UNAVAILABLE', items: [], error: error instanceof Error ? error.message : '响应格式无效。' }; }
      }
      const error = result.reason;
      return { title, state: error instanceof ApiFailure && [401, 403].includes(error.status) ? 'DENIED' : 'UNAVAILABLE', items: [], error: error instanceof Error ? error.message : '当前暂不可用。' };
    };
    const sections = [toSection('成长与照护交接', milestone, value => parseMilestones(value, expected.patientId)), toSection('照护转介计划', plan, value => parsePlan(value, expected.patientId))];
    if (readiness.status === 'fulfilled') { try { this.applyReadiness(readiness.value, expected); } catch (error) { this.setData({ readinessAvailable: false, notice: error instanceof Error ? error.message : '自查进度暂不可用。' }); } }
    else this.setData({ readinessAvailable: false, notice: '自查进度暂不可用，请刷新后再试。' });
    const unavailable = readiness.status === 'rejected' || sections.some(item => item.state === 'UNAVAILABLE' || item.state === 'DENIED');
    this.setData({ loading: false, sections, error: unavailable ? '部分交接资料暂不可用，请重新读取。' : '' });
  },
  openContacts() { wx.navigateTo({ url: '/pages/patient/contacts' }); },
  openPrivateTalk() { wx.navigateTo({ url: '/pages/patient/support?compose=private-talk' }); },
  applyReadiness(value: unknown, expected: Scope) {
    if (!sameScope(expected)) return;
    if (!object(value) || !only(value, ['patientId', 'version', 'updatedAt', 'started', 'completedItemIds']) || value.patientId !== expected.patientId || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.started !== 'boolean' || !Array.isArray(value.completedItemIds) || value.completedItemIds.length > 4 || value.completedItemIds.some(item => !['records', 'medications', 'contact', 'emergency'].includes(String(item))) || value.updatedAt !== undefined && !instant(value.updatedAt)) throw new Error('服务端自查进度格式无效。');
    const items = (this.data.readinessItems as ReadinessItem[]).map(item => ({ ...item, done: (value.completedItemIds as string[]).includes(item.id) }));
    const done = items.filter(item => item.done).length;
    this.setData({ readinessItems: items, readinessDone: done, readinessScore: Math.round(done / items.length * 100), takeoverStarted: value.started, readinessVersion: Number(value.version), readinessAvailable: true, readinessUpdated: value.updatedAt ? formatDate(value.updatedAt as string) : '' });
  },
  async saveChecklist(started: boolean, items: ReadinessItem[]) {
    const expected = scope(); if (!expected || this.data.saving || !this.data.readinessAvailable || !this.data.readinessCanWrite) return;
    const command = this.pendingReadiness ?? { started, completedItemIds: items.filter(item => item.done).map(item => item.id), expectedVersion: this.data.readinessVersion, idempotencyKey: `readiness-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
    this.pendingReadiness = command;
    this.setData({ saving: true, notice: '', error: '' });
    try {
      const result = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/transition-readiness`, 'POST', command);
      if (!sameScope(expected)) return;
      if (!object(result)) throw new Error('自查保存回执无效。');
      this.applyReadiness(result.view, expected);
      this.pendingReadiness = null;
      this.setData({ notice: '自查进度已保存，照护团队可查看；不会自动变更档案权限。' });
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '自查进度保存失败，请重试。' });
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) { this.pendingReadiness = null; if (error.status === 409) await this.load(expected); }
    } finally { if (sameScope(expected)) this.setData({ saving: false }); }
  },
  startTakeover() { void this.saveChecklist(true, this.data.readinessItems as ReadinessItem[]); },
  toggleReadinessPanel() { this.setData({ showReadinessPanel: !this.data.showReadinessPanel }); },
  toggleReadiness(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const id = event.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || this.data.saving || !this.data.readinessAvailable || !this.data.readinessCanWrite || this.pendingReadiness) return;
    const items = (this.data.readinessItems as ReadinessItem[]).map(item => item.id === id ? { ...item, done: !item.done } : item);
    void this.saveChecklist(this.data.takeoverStarted as boolean, items);
  },
  retryReadiness() { void this.saveChecklist(this.data.takeoverStarted as boolean, this.data.readinessItems as ReadinessItem[]); },
  refresh() { const current = scope(); if (current) void this.load(current); },
});
