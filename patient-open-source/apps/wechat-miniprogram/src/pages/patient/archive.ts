import { at as formatLocalDateTime } from '../../date-format';
import { ApiFailure } from '../../api';
import { archiveKinds, archiveOptions, currentArchiveScope, emptyArchive, emptyArchiveFilter, filterArchives, sameArchiveScope, type ArchiveFilter, type ArchiveKind, type ArchiveScope, type ClinicalArchive } from '../../clinical-archive';

import { loadClinicalArchives, saveClinicalArchive, removeClinicalArchive, previewReportImage } from '../../clinical-data';

const labels: Record<ArchiveKind, string> = { hospital: '住院记录', check: '我的检查', outpatient: '门诊病历', prescription: '我的处方' };
const dateLabels: Record<ArchiveKind, string> = { hospital: '入院日期', check: '检查日期', outpatient: '就诊日期', prescription: '开方日期' };
function displayRow(row: ClinicalArchive) {
  const status = row.kind === 'hospital' ? row.dischargeDate ? '已出院' : '住院中' : row.kind === 'prescription' ? row.status === 'active' ? '使用中' : '已结束' : row.kind === 'check' ? ({ lab: '化验', imaging: '影像', other: '其他检查' }[row.checkCategory]) : '门诊记录';
  return { ...row, kindLabel: labels[row.kind], statusLabel: status, imageLabel: row.artifactId ? '原图已留存' : row.source === 'example' ? '示例 · 无原图' : '手动录入', dateLabel: dateLabels[row.kind], recordedAt: formatLocalDateTime(row.updatedAt) };
}

Page({
  data: { title: '历史记录', subtitle: '查询已保存的诊疗档案', kind: 'history', rows: [] as ReturnType<typeof displayRow>[], filter: emptyArchiveFilter(), ...archiveOptions([]), error: '', mode: 'list', detail: null as ReturnType<typeof displayRow> | null, draft: emptyArchive(), saving: false, checkCategories: ['化验', '影像', '其他'], dateLabel: '记录日期', total: 0, loading: false },
  scope: null as ArchiveScope | null,
  allRows: [] as ClinicalArchive[],
  pendingId: '',
  onLoad(options: { kind?: string; id?: string; filter?: string }) {
    const kind = archiveKinds.some(item => item.key === options.kind) ? options.kind as ArchiveKind : 'history';
    const config = archiveKinds.find(item => item.key === kind);
    this.pendingId = options.id ?? '';
    let filter = emptyArchiveFilter();
    if (options.filter) { try { let raw: Record<string, unknown>; try { raw = JSON.parse(options.filter) as Record<string, unknown>; } catch { raw = JSON.parse(decodeURIComponent(options.filter)) as Record<string, unknown>; } filter = Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, typeof raw[key] === 'string' && raw[key].length < 300 ? raw[key] : value])) as unknown as ArchiveFilter; } catch { /* Invalid URL filters fall back to defaults. */ } }
    this.setData({ kind, title: config?.label ?? '历史记录', subtitle: config?.subtitle ?? '按时间、医院、科室与疾病查询', filter, dateLabel: kind === 'history' ? '记录日期' : dateLabels[kind] });
    wx.setNavigationBarTitle?.({ title: config?.label ?? '历史记录' });
  },
  async onShow() {
    const scope = currentArchiveScope();
    if (!scope) { this.scope = null; this.allRows = []; this.setData({ rows: [], detail: null, error: '请先绑定患者档案。', mode: 'list' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    if (this.scope && JSON.stringify(scope) !== JSON.stringify(this.scope)) { this.pendingId = ''; this.setData({ rows: [], detail: null, draft: emptyArchive(), mode: 'list', filter: emptyArchiveFilter() }); }
    this.scope = scope; await this.refresh();
    if (this.pendingId) { const id = this.pendingId; this.pendingId = ''; this.showDetail(id); }
  },
  authorized() { if (sameArchiveScope(this.scope)) return true; this.onShow(); return false; },
  async refresh() {
    const scope = this.scope as ArchiveScope | null; if (!scope) return;
    this.setData({ loading: true, error: '' });
    try { const rows = await loadClinicalArchives(scope); if (!sameArchiveScope(scope)) return; this.allRows = rows; this.setData({ ...archiveOptions(rows), total: rows.length }); this.search(); }
    catch (error) { if (sameArchiveScope(scope)) { this.allRows = []; this.setData({ rows: [], detail: null, error: error instanceof Error ? error.message : '档案读取失败。' }); } }
    finally { if (sameArchiveScope(scope)) this.setData({ loading: false }); }
  },
  changeFilter(event: { currentTarget: { dataset: { field?: string; options?: string } }; detail: { value: string } }) {
    const { field, options } = event.currentTarget.dataset;
    if (!field || !['keyword', 'time', 'hospital', 'department', 'disease', 'start', 'end'].includes(field)) return;
    const value = options ? this.data[options]?.[Number(event.detail.value)] : event.detail.value;
    if (typeof value === 'string') { this.setData({ [`filter.${field}`]: options && Number(event.detail.value) === 0 && field !== 'time' ? '' : value }); this.search(); }
  },
  search() {
    const filter = this.data.filter as ArchiveFilter;
    if (filter.time === '自定义' && filter.start && filter.end && filter.start > filter.end) { this.setData({ error: '开始日期不能晚于结束日期。', rows: [] }); return; }
    this.setData({ rows: filterArchives(this.allRows, filter, this.data.kind === 'history' ? undefined : this.data.kind as ArchiveKind).map(displayRow), error: '' });
  },
  resetFilter() { this.setData({ filter: emptyArchiveFilter() }); this.search(); },
  openDetail(event: { currentTarget: { dataset: { id: string } } }) { if (this.authorized()) this.showDetail(event.currentTarget.dataset.id); },
  showDetail(id: string) { const row = this.allRows.find((item: ClinicalArchive) => item.id === id); if (row) { this.setData({ detail: displayRow(row), mode: 'detail', error: '' }); wx.pageScrollTo?.({ scrollTop: 0, duration: 0 }); } else this.setData({ error: '这条档案已不存在，请返回列表重新打开。' }); },
  add() {
    if (!this.authorized()) return;
    const kind = this.data.kind === 'history' ? 'check' : this.data.kind as ArchiveKind;
    const draft = emptyArchive(kind); if (kind === 'hospital') draft.title = '住院记录'; if (kind === 'prescription') { draft.title = '门诊处方'; draft.drugs = [{ name: '', dose: '', usage: '' }]; }
    if (kind === 'check') draft.items = [{ name: '', value: '', unit: '', range: '', abnormal: false }];
    this.setData({ mode: 'edit', draft, dateLabel: dateLabels[kind], error: '' }); wx.pageScrollTo?.({ scrollTop: 0, duration: 0 });
  },
  edit() { if (this.authorized() && this.data.detail) this.setData({ draft: { ...this.data.detail }, dateLabel: dateLabels[this.data.detail.kind as ArchiveKind], mode: 'edit', error: '' }); },
  changeField(event: { currentTarget: { dataset: { field: string } }; detail: { value: string } }) {
    const field = event.currentTarget.dataset.field;
    if (['title', 'hospital', 'department', 'doctor', 'diagnosis', 'date', 'dischargeDate', 'content', 'abnormal'].includes(field)) this.setData({ [`draft.${field}`]: event.detail.value });
  },
  changeCategory(event: { detail: { value: string } }) { this.setData({ 'draft.checkCategory': ['lab', 'imaging', 'other'][Number(event.detail.value)] ?? 'lab' }); },
  clearDischarge() { this.setData({ 'draft.dischargeDate': '' }); },
  addItem() { if (this.data.draft.items.length < 50) this.setData({ 'draft.items': [...this.data.draft.items, { name: '', value: '', unit: '', range: '', abnormal: false }] }); },
  addDrug() { if (this.data.draft.drugs.length < 30) this.setData({ 'draft.drugs': [...this.data.draft.drugs, { name: '', dose: '', usage: '' }] }); },
  changeLine(event: { currentTarget: { dataset: { list: string; index: number; field: string } }; detail: { value: string | boolean } }) {
    const { list, index, field } = event.currentTarget.dataset;
    if (!['items', 'drugs'].includes(list) || !['name', 'value', 'unit', 'range', 'abnormal', 'dose', 'usage'].includes(field)) return;
    const rows = this.data.draft[list].map((row: Record<string, unknown>, i: number) => i === Number(index) ? { ...row, [field]: event.detail.value } : row);
    this.setData({ [`draft.${list}`]: rows });
  },
  removeLine(event: { currentTarget: { dataset: { list: string; index: number } } }) { const { list, index } = event.currentTarget.dataset; if (['items', 'drugs'].includes(list)) this.setData({ [`draft.${list}`]: this.data.draft[list].filter((_: unknown, i: number) => i !== Number(index)) }); },
  async save() {
    if (this.data.saving || !this.authorized()) return;
    const scope = this.scope as ArchiveScope; this.setData({ saving: true, error: '' });
    try { const row = await saveClinicalArchive(scope, this.data.draft); if (!sameArchiveScope(scope)) return; this.allRows = [row, ...this.allRows.filter((item: ClinicalArchive) => item.id !== row.id)]; this.search(); this.showDetail(row.id); wx.showToast({ title: '医疗档案已保存', icon: 'success' }); }
    catch (error) { if (sameArchiveScope(scope)) this.setData({ error: error instanceof Error ? error.message : '保存失败，请重试。' }); }
    finally { if (sameArchiveScope(scope)) this.setData({ saving: false }); }
  },
  cancelEdit() { if (!this.data.saving) this.setData({ mode: this.data.draft.id && this.data.detail ? 'detail' : 'list', draft: emptyArchive(), error: '' }); },
  backToList() { if (this.data.saving) return; this.setData({ mode: 'list', detail: null, error: '' }); this.refresh(); },
  async preview() {
    if (!this.authorized() || !this.data.detail?.artifactId) return;
    const scope = this.scope as ArchiveScope;
    try { await previewReportImage(scope, this.data.detail.artifactId); }
    catch (error) {
      if (!sameArchiveScope(scope)) return;
      if (error instanceof ApiFailure && (error.status === 401 || error.status === 403)) {
        this.allRows = []; this.setData({ rows: [], detail: null, draft: emptyArchive(), mode: 'list', total: 0, ...archiveOptions([]) });
      }
      this.setData({ error: error instanceof Error ? error.message : '原图暂时无法打开。' });
    }
  },
  togglePrescription() {
    if (this.data.saving || !this.authorized() || this.data.detail?.kind !== 'prescription') return;
    const current = this.data.detail as ClinicalArchive;
    const expectedScope = { ...this.scope } as ArchiveScope;
    wx.showModal({ title: current.status === 'active' ? '标记处方已结束' : '恢复处方档案状态', content: '这会更新处方资料的标记；医生用药计划需由医生调整，请按原医嘱用药。', success: async (result) => {
      if (!result.confirm || !sameArchiveScope(expectedScope) || this.data.saving) return;
      this.setData({ saving: true, error: '' });
      try { const saved = await saveClinicalArchive(expectedScope, { ...current, status: current.status === 'active' ? 'completed' : 'active' }); if (!sameArchiveScope(expectedScope)) return; this.allRows = this.allRows.map((item: ClinicalArchive) => item.id === saved.id ? saved : item); this.showDetail(saved.id); }
      catch (error) { if (sameArchiveScope(expectedScope)) this.setData({ error: error instanceof Error ? error.message : '状态保存失败。' }); }
      finally { if (sameArchiveScope(expectedScope)) this.setData({ saving: false }); }
    } });
  },
  remove() {
    if (this.data.saving || !this.authorized() || !this.data.detail) return;
    const row = this.data.detail as ClinicalArchive;
    const expectedScope = { ...this.scope } as ArchiveScope;
    wx.showModal({ title: '删除医疗档案', content: `确定删除“${row.title}”？删除后患者端和医生端的档案列表将不再展示该资料。`, confirmText: '删除', confirmColor: '#a3262e', success: async (result) => {
      if (!result.confirm || !sameArchiveScope(expectedScope) || this.data.saving) return;
      this.setData({ saving: true, error: '' });
      try { await removeClinicalArchive(expectedScope, row); if (!sameArchiveScope(expectedScope)) return; this.allRows = this.allRows.filter((item: ClinicalArchive) => item.id !== row.id); this.setData({ mode: 'list', detail: null }); this.search(); wx.showToast({ title: '医疗档案已删除', icon: 'success' }); }
      catch (error) { if (sameArchiveScope(expectedScope)) this.setData({ error: error instanceof Error ? error.message : '删除失败，请重试。' }); }
      finally { if (sameArchiveScope(expectedScope)) this.setData({ saving: false }); }
    } });
  },
  openScan() { if (this.authorized()) wx.navigateTo({ url: '/pages/patient/scan' }); },
});
