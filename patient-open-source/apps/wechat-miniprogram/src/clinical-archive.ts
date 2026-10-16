import { patientId, session } from './api';
import { API_BASE, AUTO_DEMO_LOGIN } from './config';

export type ArchiveKind = 'hospital' | 'check' | 'outpatient' | 'prescription';
export interface ArchiveScope { userId: string; actorId: string; patientId: string; }
export interface CheckItem { name: string; value: string; unit: string; range: string; abnormal: boolean; }
export interface PrescriptionDrug { name: string; dose: string; usage: string; }
export interface ClinicalArchive {
  patientId?: string; version?: number; artifactId?: string; recordedBy?: string;
  id: string; kind: ArchiveKind; title: string; hospital: string; department: string; doctor: string;
  diagnosis: string; date: string; dischargeDate: string; content: string; abnormal: string;
  checkCategory: 'lab' | 'imaging' | 'other'; items: CheckItem[]; drugs: PrescriptionDrug[];
  status: 'active' | 'completed'; imagePath: string; source: 'manual' | 'camera' | 'album' | 'example';
  demo: boolean; createdAt: string; updatedAt: string;
}
export interface ArchiveFilter { keyword: string; time: string; hospital: string; department: string; disease: string; start: string; end: string; }
export const archiveKinds: { key: ArchiveKind; label: string; subtitle: string; icon: string }[] = [
  { key: 'hospital', label: '住院记录', subtitle: '历次住院、诊断与主管医生', icon: 'building' },
  { key: 'check', label: '我的检查', subtitle: '化验、影像等检查结果', icon: 'flask' },
  { key: 'outpatient', label: '门诊病历', subtitle: '历次门诊就诊、诊断与处置', icon: 'clipboard' },
  { key: 'prescription', label: '我的处方', subtitle: '医生开具的处方、药品与用法', icon: 'pill' },
];
export const archiveTimes = ['全部时间', '近 7 天', '近 30 天', '近 90 天', '自定义'];
export function emptyArchiveFilter(): ArchiveFilter { return { keyword: '', time: '全部时间', hospital: '', department: '', disease: '', start: '', end: '' }; }
export function today(): string { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function emptyArchive(kind: ArchiveKind = 'check'): ClinicalArchive {
  return { id: '', kind, title: '', hospital: '', department: '', doctor: '', diagnosis: '', date: today(), dischargeDate: '', content: '', abnormal: '', checkCategory: 'lab', items: [], drugs: [], status: 'active', imagePath: '', source: 'manual', demo: false, createdAt: '', updatedAt: '' };
}
export function currentArchiveScope(): ArchiveScope | null {
  const current = session(); const id = patientId();
  return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null;
}
export function archiveScopeKey(scope: ArchiveScope): string {
  if (![scope.userId, scope.actorId, scope.patientId].every(value => typeof value === 'string' && value.trim())) throw new Error('当前身份尚未关联患者档案。');
  return `mas.clinical-archive.v1:${JSON.stringify([API_BASE, scope.userId, scope.actorId, scope.patientId])}`;
}
export function sameArchiveScope(scope: ArchiveScope | null): boolean { const current = currentArchiveScope(); return Boolean(scope && current && archiveScopeKey(scope) === archiveScopeKey(current)); }
export function validArchiveDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function cleanText(value: unknown, max = 200): string { if (typeof value !== 'string' || value.length > max || /\0/.test(value)) throw new Error('档案字段格式无效，请检查输入内容。'); return value.trim(); }
export function validateArchive(value: ClinicalArchive): ClinicalArchive {
  if (!isObject(value) || !archiveKinds.some(kind => kind.key === value.kind)) throw new Error('请选择有效的档案类型。');
  const row = { ...value };
  for (const key of ['id', 'title', 'hospital', 'department', 'doctor', 'diagnosis', 'date', 'dischargeDate', 'imagePath', 'createdAt', 'updatedAt'] as const) row[key] = cleanText(value[key], key === 'imagePath' ? 2048 : 200);
  row.content = cleanText(value.content, 5000); row.abnormal = cleanText(value.abnormal, 2000);
  if (!validArchiveDate(row.date)) throw new Error('请选择有效的记录日期。');
  if (row.dischargeDate && (!validArchiveDate(row.dischargeDate) || row.dischargeDate < row.date)) throw new Error('出院日期不能早于入院日期。');
  if (!row.hospital) throw new Error('请填写医院名称。');
  if (!row.title) throw new Error('请填写报告或病历名称。');
  if (row.kind === 'hospital' && !row.diagnosis) throw new Error('请填写入院诊断或主要病情。');
  if (row.kind === 'outpatient' && !row.content) throw new Error('请填写门诊病情与处置记录。');
  if (!['active', 'completed'].includes(row.status) || !['lab', 'imaging', 'other'].includes(row.checkCategory) || !['manual', 'camera', 'album', 'example'].includes(row.source) || typeof row.demo !== 'boolean') throw new Error('档案状态格式无效。');
  if (!Array.isArray(row.items) || row.items.length > 50 || !Array.isArray(row.drugs) || row.drugs.length > 30) throw new Error('检查项或药品数量超出范围。');
  row.items = row.items.map(item => {
    if (!isObject(item) || typeof item.abnormal !== 'boolean') throw new Error('检查项目格式无效。');
    return { name: cleanText(item.name), value: cleanText(item.value), unit: cleanText(item.unit), range: cleanText(item.range), abnormal: item.abnormal };
  }).filter(item => item.name);
  row.drugs = row.drugs.map(drug => {
    if (!isObject(drug)) throw new Error('处方药品格式无效。');
    return { name: cleanText(drug.name), dose: cleanText(drug.dose), usage: cleanText(drug.usage, 1000) };
  }).filter(drug => drug.name);
  if (row.kind === 'prescription' && !row.drugs.length) throw new Error('请至少填写一种处方药品。');
  if ((row.source === 'camera' || row.source === 'album') && !row.imagePath && !row.artifactId) throw new Error('报告原图尚未保存，请重新选择图片。');
  if (row.imagePath && !/^(wxfile:\/\/|https?:\/\/usr\/|\/)/.test(row.imagePath)) throw new Error('报告原图路径无效。');
  return row;
}
export function readArchives(scope: ArchiveScope): ClinicalArchive[] {
  let raw: unknown;
  try { raw = wx.getStorageSync<unknown>(archiveScopeKey(scope)); } catch { throw new Error('本机档案暂时无法读取，请重试。'); }
  if (raw === '' || raw === undefined || raw === null) return [];
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > 500) throw new Error('本机档案格式异常，原数据已保留，请勿重复新增。');
  try { return raw.records.map(row => { const parsed = validateArchive(row as ClinicalArchive); if (!parsed.id) throw new Error(); return parsed; }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); }
  catch { throw new Error('本机档案格式异常，原数据已保留，请勿重复新增。'); }
}
function writeArchives(scope: ArchiveScope, rows: ClinicalArchive[]): void {
  try { wx.setStorageSync(archiveScopeKey(scope), { version: 1, records: rows }); } catch { throw new Error('本机空间不足或保存失败，内容尚未入档，请保留当前页面并重试。'); }
}
export function saveArchive(scope: ArchiveScope, value: ClinicalArchive): ClinicalArchive {
  const row = validateArchive(value); const rows = readArchives(scope); const existing = rows.find(item => item.id === row.id);
  if (row.id && !existing) throw new Error('这条档案已不存在，请返回列表重新打开。');
  if (!existing && rows.length >= 500) throw new Error('本机档案已达 500 条，请先整理历史档案。');
  const now = new Date().toISOString();
  const saved = { ...row, id: existing?.id ?? `archive-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, createdAt: existing?.createdAt ?? now, updatedAt: now };
  writeArchives(scope, existing ? rows.map(item => item.id === existing.id ? saved : item) : [saved, ...rows]);
  return saved;
}
export function deleteArchive(scope: ArchiveScope, id: string): void {
  const rows = readArchives(scope);
  if (!rows.some(row => row.id === id)) throw new Error('这条档案已不存在。');
  writeArchives(scope, rows.filter(row => row.id !== id));
}
export function filterArchives(rows: ClinicalArchive[], filter: ArchiveFilter, kind?: ArchiveKind, now = today()): ClinicalArchive[] {
  const keyword = filter.keyword.trim().toLocaleLowerCase();
  const days = filter.time === '近 7 天' ? 7 : filter.time === '近 30 天' ? 30 : filter.time === '近 90 天' ? 90 : 0;
  const cutoff = days ? new Date(Date.parse(`${now}T12:00:00Z`) - (days - 1) * 86400_000).toISOString().slice(0, 10) : '';
  return rows.filter(row => (!kind || row.kind === kind) && (!keyword || [row.title, row.hospital, row.department, row.doctor, row.diagnosis, row.content, row.abnormal, ...row.items.map(item => `${item.name} ${item.value}`), ...row.drugs.map(item => item.name)].join(' ').toLocaleLowerCase().includes(keyword))
    && (!filter.hospital || row.hospital === filter.hospital) && (!filter.department || row.department === filter.department) && (!filter.disease || row.diagnosis === filter.disease)
    && (!days || row.date >= cutoff && row.date <= now)
    && (filter.time !== '自定义' || (!filter.start || row.date >= filter.start) && (!filter.end || row.date <= filter.end)));
}
export function archiveOptions(rows: ClinicalArchive[]) {
  const unique = (key: 'hospital' | 'department' | 'diagnosis') => [...new Set(rows.map(row => row[key]).filter(Boolean))].sort();
  return { timeOptions: archiveTimes, hospitalOptions: ['全部医院', ...unique('hospital')], departmentOptions: ['全部科室', ...unique('department')], diseaseOptions: ['全部疾病', ...unique('diagnosis')] };
}
export function exampleArchive(): ClinicalArchive {
  return { ...emptyArchive('check'), title: '示例 · 血常规与炎症指标', hospital: '示例儿童医院', department: '风湿免疫科', doctor: '李医生', diagnosis: 'sJIA 随访', abnormal: '铁蛋白 3400 ng/mL；AST 86 U/L；甘油三酯 320 mg/dL；CRP 168 mg/L。请结合原报告与医生评估。', content: '虚构儿童病例的本次检验示例，与演示指标页同一组数据。演示资料，请勿用于临床判断。', source: 'example', demo: true, items: [
    { name: '血小板计数', value: '152', unit: '10^9/L', range: '请参照原报告', abnormal: false },
    { name: '铁蛋白', value: '3400', unit: 'ng/mL', range: '请参照原报告', abnormal: true },
    { name: 'AST', value: '86', unit: 'U/L', range: '请参照原报告', abnormal: true },
    { name: '甘油三酯', value: '320', unit: 'mg/dL', range: '请参照原报告', abnormal: true },
    { name: '纤维蛋白原', value: '2.4', unit: 'g/L', range: '请参照原报告', abnormal: false },
    { name: '白细胞', value: '12.8', unit: '10^9/L', range: '请参照原报告', abnormal: false },
    { name: 'CRP', value: '168', unit: 'mg/L', range: '请参照原报告', abnormal: true },
  ] };
}
/** 与 reference-demo-fixture.mjs 的虚构儿童病例一致：7 项本次检验、2 项既往对照。 */
export function referenceDemoArchiveSamples(now = new Date()): ClinicalArchive[] {
  const instant = now.toISOString();
  const dateBeforeHours = (hours: number) => new Date(now.getTime() - hours * 3600_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const base = { ...exampleArchive(), date: dateBeforeHours(0.5) };
  const samples: ClinicalArchive[] = [base,
    { ...base, kind: 'hospital', title: '示例 · 住院诊疗记录', date: dateBeforeHours(36 * 24), dischargeDate: dateBeforeHours(29 * 24), diagnosis: 'sJIA 发热评估', content: '示例住院经过：完善检查、评估病情，出院后按医嘱随访。', items: [], abnormal: '' },
    { ...base, kind: 'outpatient', title: '示例 · 风湿免疫科复诊', date: dateBeforeHours(28 * 24), content: '示例门诊记录：复核体温与检查变化，按原处方记录用药，并带近期报告复诊。', items: [], abnormal: '' },
    { ...base, kind: 'prescription', title: '示例 · 门诊处方', date: dateBeforeHours(28 * 24 + 1), content: '虚构演示处方，与演示用药计划一致；不可作为真实用药依据，调整用药请联系医生。', drugs: [{ name: '泼尼松', dose: '15 mg', usage: '每日一次，口服；按原医嘱执行' }, { name: '甲氨蝶呤', dose: '7.5 mg', usage: '每周一次，口服；按原医嘱执行' }], items: [], abnormal: '' },
    { ...base, title: '示例 · 两日前检验对照', date: dateBeforeHours(49), content: '虚构儿童病例的既往检验对照。与本次血小板 152、铁蛋白 3400 比较时，请关注变化并联系医生。', abnormal: '铁蛋白 1060 ng/mL；本次检验请查看较新的检查报告。', items: [
      { name: '血小板计数', value: '210', unit: '10^9/L', range: '请参照原报告', abnormal: false },
      { name: '铁蛋白', value: '1060', unit: 'ng/mL', range: '请参照原报告', abnormal: true },
    ] },
  ];
  return samples.map((row, index) => ({ ...row, id: index === 4 ? 'demo-check-before' : `demo-${index}`, createdAt: instant, updatedAt: instant }));
}
export function ensureDemoArchives(scope: ArchiveScope): void {
  if (!AUTO_DEMO_LOGIN || scope.patientId !== 'patient-demo') return;
  const key = `${archiveScopeKey(scope)}:demo-seeded`;
  const seeded = wx.getStorageSync(key);
  if (seeded === 2) return;
  const rows = readArchives(scope);
  const samples = referenceDemoArchiveSamples();
  if (!rows.length && !seeded) writeArchives(scope, samples);
  else if (seeded === true) {
    // 只替换旧版自动生成且从未编辑的内置示例，保留用户新增、修改和删除。
    const untouched = (row: ClinicalArchive) => /^demo-[0-3]$/.test(row.id) && row.demo && row.source === 'example' && row.createdAt === row.updatedAt;
    const hadCurrentCheck = rows.some(row => row.id === 'demo-0' && untouched(row));
    const migrated = rows.map(row => untouched(row) ? samples.find(sample => sample.id === row.id) ?? row : row);
    if (hadCurrentCheck && !migrated.some(row => row.id === 'demo-check-before')) migrated.push(samples[4]!);
    writeArchives(scope, migrated);
  }
  wx.setStorageSync(key, 2);
}
