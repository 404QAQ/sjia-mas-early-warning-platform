import { session } from '../../api';
import { AUTO_DEMO_LOGIN } from '../../config';
import { readVitals, type VitalScope } from '../../local-vitals';
import { loadAuxiliaryVitals, saveAuxiliaryVitals } from '../../clinical-data';
import { sameArchiveScope } from '../../clinical-archive';
import { at } from '../../date-format';

Page({
  data: { systolic: '', diastolic: '', spo2: '', heartRate: '', error: '', saved: '', demo: AUTO_DEMO_LOGIN, loading: false, saving: false, lastMeasured: '', history: [] as Array<Record<string, unknown>> },
  scope: null as VitalScope | null,
  pendingAt: '',
  generation: 0,
  onLoad() { this.load(); },
  onUnload() { this.generation += 1; },
  async load() {
    const current = session();
    if (!current?.patientId) { wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const scope = { userId: current.userId, actorId: current.actorId, patientId: current.patientId };
    this.scope = scope; const generation = ++this.generation;
    this.setData({ loading: true, error: '' });
    try {
      const result = await loadAuxiliaryVitals(scope);
      if (!sameArchiveScope(scope) || generation !== this.generation) return;
      this.setData({ history: result.records.slice(0, 10).map(row => ({ ...row, measured: at(row.recordedAt) })), lastMeasured: result.latest ? at(result.latest.recordedAt) : '' });
      if (!result.latest) { const legacy = readVitals(scope); if (legacy) { this.setData({ systolic: String(legacy.systolic), diastolic: String(legacy.diastolic), spo2: String(legacy.spo2), heartRate: String(legacy.heartRate), saved: '已填入旧版本机测量，请核对后保存到患者档案。' }); this.pendingAt = legacy.recordedAt; } }
    } catch (error) { if (sameArchiveScope(scope) && generation === this.generation) this.setData({ error: error instanceof Error ? error.message : '读取失败，请重试。' }); }
    finally { if (sameArchiveScope(scope) && generation === this.generation) this.setData({ loading: false }); }
  },
  change(event: { currentTarget?: { dataset?: { key?: string } }; detail?: { value?: string } }) {
    if (this.data.saving) return;
    const key = event.currentTarget?.dataset?.key;
    if (key && ['systolic', 'diastolic', 'spo2', 'heartRate'].includes(key)) this.setData({ [key]: event.detail?.value ?? '', saved: '', error: '' });
  },
  useSample() { if (AUTO_DEMO_LOGIN && !this.data.saving) this.setData({ systolic: '112', diastolic: '70', spo2: '98', heartRate: '102', error: '', saved: '' }); },
  async save() {
    const scope = this.scope as VitalScope | null;
    if (this.data.saving || !scope) return;
    if (!sameArchiveScope(scope)) { this.setData({ error: '身份已变更，请返回后重新打开。' }); return; }
    const generation = this.generation;
    this.setData({ saving: true, error: '', saved: '' });
    try {
      if (['systolic', 'diastolic', 'spo2', 'heartRate'].some(key => !/^\d{1,3}$/.test(this.data[key]))) throw new Error('请完整填写四项测量值。');
      if (!this.pendingAt) this.pendingAt = new Date().toISOString();
      const record = await saveAuxiliaryVitals(scope, { systolic: Number(this.data.systolic), diastolic: Number(this.data.diastolic), spo2: Number(this.data.spo2), heartRate: Number(this.data.heartRate), recordedAt: this.pendingAt });
      if (!sameArchiveScope(scope) || generation !== this.generation) return;
      this.pendingAt = '';
      this.setData({ saved: '测量已保存，首页与照护医生可查看。', lastMeasured: at(record.recordedAt), history: [{ ...record, measured: at(record.recordedAt) }, ...this.data.history.filter((item: { id: string }) => item.id !== record.id)].slice(0, 10), error: '' });
    } catch (error) { if (sameArchiveScope(scope) && generation === this.generation) this.setData({ error: error instanceof Error ? error.message : '保存失败，请重试。', saved: '' }); }
    finally { if (sameArchiveScope(scope) && generation === this.generation) this.setData({ saving: false }); }
  },
  back() { wx.navigateBack(); },
});
