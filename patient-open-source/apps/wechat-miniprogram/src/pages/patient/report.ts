import { loadClinicalArchives, saveClinicalArchive, uploadReportImage } from '../../clinical-data';
import { archiveKinds, archiveOptions, currentArchiveScope, emptyArchiveFilter, readArchives, archiveScopeKey, sameArchiveScope, type ArchiveFilter, type ArchiveScope } from '../../clinical-archive';

Page({
  data: { kinds: archiveKinds, filter: emptyArchiveFilter(), ...archiveOptions([]), error: '', localCount: 0, hasDemo: false, loading: false, importing: false, legacyCount: 0 },
  scope: null as ArchiveScope | null,
  async onShow() {
    const scope = currentArchiveScope();
    if (!scope) { this.scope = null; this.setData({ error: '请先绑定患者档案。', ...archiveOptions([]), localCount: 0, legacyCount: 0, importing: false, loading: false, hasDemo: false }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    if (!this.scope || JSON.stringify(scope) !== JSON.stringify(this.scope)) this.setData({ filter: emptyArchiveFilter(), ...archiveOptions([]), localCount: 0, legacyCount: 0, importing: false, hasDemo: false });
    this.scope = scope;
    this.setData({ loading: true, error: '' });
    try { const rows = await loadClinicalArchives(scope); if (!sameArchiveScope(scope)) return; this.setData({ ...archiveOptions(rows), localCount: rows.length, hasDemo: rows.some(row => row.demo) }); try { this.setData({ legacyCount: readArchives(scope).length }); } catch { this.setData({ error: '旧版本本机档案读取异常，原资料已保留。' }); } }
    catch (error) { if (sameArchiveScope(scope)) this.setData({ localCount: 0, error: error instanceof Error ? error.message : '档案暂时无法读取。' }); }
    finally { if (sameArchiveScope(scope)) this.setData({ loading: false }); }
  },
  async importLegacy() {
    if (this.data.importing || !this.authorized()) return;
    const scope = this.scope as ArchiveScope; this.setData({ importing: true, error: '' });
    try {
      for (const row of readArchives(scope)) {
        if (!sameArchiveScope(scope)) return;
        const uploadKey = `${archiveScopeKey(scope)}:upload:${row.id}`;
        let artifactId = row.artifactId;
        if (row.imagePath) { const saved = wx.getStorageSync<unknown>(uploadKey); artifactId = typeof saved === 'string' && saved ? saved : await uploadReportImage(scope, row.imagePath); wx.setStorageSync(uploadKey, artifactId); }
        await saveClinicalArchive(scope, { ...row, imagePath: '', ...(artifactId ? { artifactId } : {}) }, row.id);
      }
      if (sameArchiveScope(scope)) { await this.onShow(); wx.showToast({ title: '旧档案已导入', icon: 'success' }); }
    } catch (error) { if (sameArchiveScope(scope)) this.setData({ error: error instanceof Error ? error.message : '导入未完成，可安全重试；旧资料仍保留。' }); }
    finally { if (sameArchiveScope(scope)) this.setData({ importing: false }); }
  },
  authorized() { if (sameArchiveScope(this.scope)) return true; this.onShow(); return false; },
  openScan() { if (this.authorized()) wx.navigateTo({ url: '/pages/patient/scan' }); },
  openArchive(event: { currentTarget: { dataset: { kind?: string } } }) {
    if (!this.authorized()) return;
    const kind = event.currentTarget.dataset.kind;
    if (archiveKinds.some(item => item.key === kind)) wx.navigateTo({ url: `/pages/patient/archive?kind=${kind}` });
  },
  changeFilter(event: { currentTarget: { dataset: { field?: string; options?: string } }; detail: { value: string } }) {
    const { field, options } = event.currentTarget.dataset;
    if (!field || !['keyword', 'time', 'hospital', 'department', 'disease', 'start', 'end'].includes(field)) return;
    const value = options ? this.data[options]?.[Number(event.detail.value)] : event.detail.value;
    if (typeof value === 'string') this.setData({ [`filter.${field}`]: options && Number(event.detail.value) === 0 && field !== 'time' ? '' : value });
  },
  search() {
    if (!this.authorized()) return;
    const filter = this.data.filter as ArchiveFilter;
    if (filter.time === '自定义' && filter.start && filter.end && filter.start > filter.end) { this.setData({ error: '开始日期不能晚于结束日期。' }); return; }
    wx.navigateTo({ url: `/pages/patient/archive?kind=history&filter=${encodeURIComponent(JSON.stringify(filter))}` });
  },
  openVisitReport() { if (this.authorized()) wx.navigateTo({ url: '/pages/patient/visit-report' }); },
});
