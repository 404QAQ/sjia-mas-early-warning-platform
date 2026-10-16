import { saveClinicalArchive, uploadReportImage } from '../../clinical-data';
import { AUTO_DEMO_LOGIN } from '../../config';
import { archiveKinds, currentArchiveScope, emptyArchive, exampleArchive, sameArchiveScope, validateArchive, type ArchiveScope, type ClinicalArchive } from '../../clinical-archive';

Page({
  data: { step: 'choose', error: '', permissionDenied: false, picking: false, saving: false, previewPath: '', draft: emptyArchive(), kinds: archiveKinds, kindIndex: 1, demoEnabled: AUTO_DEMO_LOGIN, savedId: '', savedKind: 'check', hasImage: false },
  scope: null as ArchiveScope | null,
  generation: 0,
  committed: false,
  onLoad() { this.scope = currentArchiveScope(); },
  onShow() {
    const current = currentArchiveScope();
    if (!current) { this.releaseImage(); this.scope = null; this.generation += 1; this.setData({ step: 'choose', draft: emptyArchive(), previewPath: '', savedId: '', kindIndex: 1, picking: false, saving: false, hasImage: false, permissionDenied: false, error: '请先绑定患者档案。' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    if (this.scope && JSON.stringify(current) !== JSON.stringify(this.scope)) { this.releaseImage(); this.generation += 1; this.setData({ step: 'choose', draft: emptyArchive(), previewPath: '', savedId: '', kindIndex: 1, picking: false, saving: false, hasImage: false, permissionDenied: false, error: '身份已切换，请重新选择当前患者的报告。' }); }
    this.scope = current;
  },
  onUnload() { this.generation += 1; this.releaseImage(); },
  releaseImage() { if (!this.committed && this.data.draft.imagePath) wx.removeSavedFile?.({ filePath: this.data.draft.imagePath }); this.committed = false; },
  authorized() { if (sameArchiveScope(this.scope)) return true; this.onShow(); return false; },
  chooseCamera() { this.choose('camera'); },
  chooseAlbum() { this.choose('album'); },
  choose(source: 'camera' | 'album') {
    if (!this.authorized() || this.data.picking || this.data.saving) return;
    if (!wx.chooseImage) { this.setData({ error: '当前环境不支持选图，可以使用手动填写。' }); return; }
    const generation = ++this.generation;
    this.setData({ picking: true, error: '', permissionDenied: false });
    wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: [source], success: (result) => {
      if (generation !== this.generation || !sameArchiveScope(this.scope)) return;
      const path = result.tempFilePaths[0];
      if (!path) { this.setData({ picking: false, error: '未获得图片，请重新选择。' }); return; }
      this.releaseImage(); const draft = emptyArchive(); draft.source = source;
      this.setData({ step: 'confirm', draft, kindIndex: 1, previewPath: path, picking: false, hasImage: true, error: '' });
    }, fail: (error) => {
      if (generation !== this.generation || !sameArchiveScope(this.scope)) return;
      const message = error.errMsg ?? '';
      this.setData({ picking: false, permissionDenied: /auth|denied|permission/i.test(message), error: /cancel/i.test(message) ? '' : '未能取得图片。请确认相机或相册权限后重试，也可以手动填写。' });
    } });
  },
  openPermission() { wx.openSetting?.({ success: () => this.setData({ permissionDenied: false, error: '权限设置已返回，请重新选择拍照或相册。' }), fail: () => this.setData({ error: '无法打开设置，请在微信小程序设置中开启相机或相册权限。' }) }); },
  manual() { if (!this.authorized()) return; this.releaseImage(); this.setData({ step: 'confirm', draft: emptyArchive(), kindIndex: 1, previewPath: '', hasImage: false, error: '' }); },
  useExample() { if (!AUTO_DEMO_LOGIN || !this.authorized()) return; this.releaseImage(); this.setData({ step: 'confirm', draft: exampleArchive(), kindIndex: 1, previewPath: '', hasImage: false, error: '' }); },
  changeField(event: { currentTarget: { dataset: { field: string } }; detail: { value: string } }) { const field = event.currentTarget.dataset.field; if (!this.data.saving && ['title', 'hospital', 'department', 'doctor', 'diagnosis', 'date', 'dischargeDate', 'content', 'abnormal'].includes(field)) this.setData({ [`draft.${field}`]: event.detail.value }); },
  changeKind(event: { detail: { value: string } }) {
    if (this.data.saving) return;
    const index = Number(event.detail.value); const kind = archiveKinds[index]?.key;
    if (kind) this.setData({ kindIndex: index, 'draft.kind': kind, 'draft.drugs': kind === 'prescription' ? (this.data.draft.drugs.length ? this.data.draft.drugs : [{ name: '', dose: '', usage: '' }]) : [] });
  },
  changeDrug(event: { currentTarget: { dataset: { field: string; index: number } }; detail: { value: string } }) {
    if (this.data.saving) return;
    const { field, index } = event.currentTarget.dataset;
    if (['name', 'dose', 'usage'].includes(field)) this.setData({ 'draft.drugs': this.data.draft.drugs.map((row: Record<string, string>, i: number) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  changeItem(event: { currentTarget: { dataset: { field: string; index: number } }; detail: { value: string | boolean } }) {
    if (this.data.saving) return;
    const { field, index } = event.currentTarget.dataset;
    if (['name', 'value', 'unit', 'range', 'abnormal'].includes(field)) this.setData({ 'draft.items': this.data.draft.items.map((row: Record<string, unknown>, i: number) => i === Number(index) ? { ...row, [field]: event.detail.value } : row) });
  },
  addItem() { if (!this.data.saving && this.data.draft.items.length < 50) this.setData({ 'draft.items': [...this.data.draft.items, { name: '', value: '', unit: '', range: '', abnormal: false }] }); },
  removeItem(event: { currentTarget: { dataset: { index: number } } }) { if (!this.data.saving) this.setData({ 'draft.items': this.data.draft.items.filter((_: unknown, index: number) => index !== Number(event.currentTarget.dataset.index)) }); },
  addDrug() { if (!this.data.saving && this.data.draft.drugs.length < 30) this.setData({ 'draft.drugs': [...this.data.draft.drugs, { name: '', dose: '', usage: '' }] }); },
  preview() { if (this.data.previewPath) wx.previewImage?.({ current: this.data.previewPath, urls: [this.data.previewPath], fail: () => this.setData({ error: '图片暂时无法预览，请重新选择。' }) }); },
  reselect() { if (this.data.saving) return; this.releaseImage(); this.generation += 1; this.setData({ step: 'choose', previewPath: '', draft: emptyArchive(), error: '', picking: false, hasImage: false }); },
  async save() {
    if (this.data.saving || !this.authorized()) return;
    const generation = this.generation;
    const scope = this.scope as ArchiveScope;
    const draft = { ...this.data.draft } as ClinicalArchive;
    this.setData({ saving: true, error: '' });
    try {
      // Validate before writing a file; source-specific image validation follows persistence.
      validateArchive({ ...draft, source: draft.source === 'camera' || draft.source === 'album' ? 'manual' : draft.source });
      if (this.data.previewPath && !draft.artifactId) {
        const artifactId = await uploadReportImage(scope, this.data.previewPath);
        if (generation !== this.generation || !sameArchiveScope(scope)) return;
        draft.artifactId = artifactId; draft.imagePath = '';
        this.setData({ 'draft.artifactId': artifactId, 'draft.imagePath': '' });
      }
      if (generation !== this.generation || !sameArchiveScope(scope)) return;
      const saved = await saveClinicalArchive(scope, draft);
      if (generation !== this.generation || !sameArchiveScope(scope)) return;
      this.committed = true;
      this.setData({ step: 'saved', savedId: saved.id, savedKind: saved.kind, draft: saved, error: '' });
    } catch (error) { if (generation === this.generation && sameArchiveScope(scope)) this.setData({ error: error instanceof Error ? error.message : '保存失败，请重试。' }); }
    finally { if (generation === this.generation) this.setData({ saving: false }); }
  },
  viewSaved() { if (this.authorized() && this.data.savedId) wx.redirectTo({ url: `/pages/patient/archive?kind=${this.data.savedKind}&id=${encodeURIComponent(this.data.savedId)}` }); },
  backToReports() { wx.switchTab({ url: '/pages/patient/report' }); },
});
