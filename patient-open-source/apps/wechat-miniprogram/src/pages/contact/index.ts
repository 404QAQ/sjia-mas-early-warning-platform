import { API_BASE } from '../../config';

type ContactAction = 'CONTACTED' | 'UNABLE_TO_CONTACT' | 'NOT_NEEDED';
type ContactRoute = { kind: 'link' | 'share'; code: string };
interface ContactResponse { kind: ContactAction; at: string; }
interface ContactSummary { title: string; action: string; patientDisplayName?: string; }
interface ContactView { kind: 'link'; visibility: 'G1_NOTIFY' | 'G2_SUMMARY'; expiresAt: string; response: ContactResponse | null; summary: ContactSummary; }
interface ShareSummary {
  title: string;
  description: string;
  patientDisplayName?: string;
  updatedAt: string;
  planVersion: number;
  thresholds: string[];
  hospitalName: string;
  nightEntrance?: string;
  arrivalMinutesNight: number;
  triageScript: string;
  followUpClinicianPhone: string;
  neverDo: string[];
  canDo: string[];
}
interface ShareView { kind: 'share'; visibility: 'G2_SUMMARY'; expiresAt: string; summary: ShareSummary; }
type ContactPageView = ContactView | ShareView;

const CODE = /^[A-Za-z0-9_-]{7}$/;
const ACTIONS: readonly ContactAction[] = ['CONTACTED', 'UNABLE_TO_CONTACT', 'NOT_NEEDED'];

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }

function parseAction(value: unknown): ContactResponse | null {
  if (!object(value) || !keys(value, ['kind', 'at']) || !ACTIONS.includes(value.kind as ContactAction) || !instant(value.at)) return null;
  return { kind: value.kind as ContactAction, at: value.at };
}

function parseLink(value: unknown): ContactView | null {
  if (!object(value) || !keys(value, ['visibility', 'expiresAt', 'response', 'summary']) ||
    !['G1_NOTIFY', 'G2_SUMMARY'].includes(value.visibility as string) || !instant(value.expiresAt) ||
    !(value.response === null || parseAction(value.response)) || !object(value.summary) ||
    !keys(value.summary, ['title', 'action', 'patientDisplayName']) || !text(value.summary.title, 200) || !text(value.summary.action, 1000) ||
    (value.summary.patientDisplayName !== undefined && !text(value.summary.patientDisplayName, 200))) return null;
  const summary = value.summary;
  const title = summary.title as string;
  const action = summary.action as string;
  const patientDisplayName = summary.patientDisplayName as string | undefined;
  // G1 is notification-only; strip a name even if a faulty upstream DTO includes it.
  return {
    kind: 'link', visibility: value.visibility as ContactView['visibility'], expiresAt: value.expiresAt,
    response: value.response === null ? null : parseAction(value.response),
    summary: { title, action, ...(value.visibility === 'G2_SUMMARY' && patientDisplayName !== undefined ? { patientDisplayName } : {}) },
  };
}

function parseShare(value: unknown): ShareView | null {
  if (!object(value) || !keys(value, ['visibility', 'expiresAt', 'summary']) || value.visibility !== 'G2_SUMMARY' || !instant(value.expiresAt) || !object(value.summary)) return null;
  const summary = value.summary;
  const allowed = ['title', 'description', 'patientDisplayName', 'updatedAt', 'planVersion', 'thresholds', 'hospitalName', 'nightEntrance', 'arrivalMinutesNight', 'triageScript', 'followUpClinicianPhone', 'neverDo', 'canDo'];
  if (!keys(summary, allowed) || !text(summary.title, 200) || !text(summary.description, 1000) ||
    (summary.patientDisplayName !== undefined && !text(summary.patientDisplayName, 200)) || !instant(summary.updatedAt) ||
    typeof summary.planVersion !== 'number' || !Number.isSafeInteger(summary.planVersion) || summary.planVersion < 1 ||
    !Array.isArray(summary.thresholds) || summary.thresholds.length < 1 || !summary.thresholds.every(item => text(item, 500)) ||
    !text(summary.hospitalName, 200) || (summary.nightEntrance !== undefined && !text(summary.nightEntrance, 200)) ||
    typeof summary.arrivalMinutesNight !== 'number' || !Number.isSafeInteger(summary.arrivalMinutesNight) || summary.arrivalMinutesNight < 0 ||
    !text(summary.triageScript, 1000) || !text(summary.followUpClinicianPhone, 80) ||
    !Array.isArray(summary.neverDo) || summary.neverDo.length < 1 || !summary.neverDo.every(item => text(item, 500)) ||
    !Array.isArray(summary.canDo) || summary.canDo.length < 1 || !summary.canDo.every(item => text(item, 500))) return null;
  return {
    kind: 'share', visibility: 'G2_SUMMARY', expiresAt: value.expiresAt,
    summary: {
      title: summary.title, description: summary.description, updatedAt: summary.updatedAt, planVersion: summary.planVersion,
      thresholds: [...summary.thresholds], hospitalName: summary.hospitalName, arrivalMinutesNight: summary.arrivalMinutesNight,
      triageScript: summary.triageScript, followUpClinicianPhone: summary.followUpClinicianPhone,
      neverDo: [...summary.neverDo], canDo: [...summary.canDo],
      ...(summary.patientDisplayName === undefined ? {} : { patientDisplayName: summary.patientDisplayName }),
      ...(summary.nightEntrance === undefined ? {} : { nightEntrance: summary.nightEntrance }),
    },
  };
}

function decodeScene(value: string): Record<string, string> {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
  }
  const params: Record<string, string> = {};
  decoded.split('&').forEach(part => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index);
    const raw = part.slice(index + 1);
    try { params[key] = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { /* invalid scene is handled as missing */ }
  });
  return params;
}

function routeFromOptions(options: { c?: string; t?: string; s?: string; scene?: string }): ContactRoute | null {
  if (options.c && CODE.test(options.c)) return { kind: 'link', code: options.c };
  if (options.t && CODE.test(options.t)) return { kind: 'link', code: options.t };
  if (options.s && CODE.test(options.s)) return { kind: 'share', code: options.s };
  if (!options.scene) return null;
  const scene = decodeScene(options.scene);
  if (scene.c && CODE.test(scene.c)) return { kind: 'link', code: scene.c };
  if (scene.t && CODE.test(scene.t)) return { kind: 'link', code: scene.t };
  if (scene.s && CODE.test(scene.s)) return { kind: 'share', code: scene.s };
  return null;
}

function neutralError(status: number): string {
  return [401, 403, 404, 410].includes(status) ? '这条内容已不可访问。' : '暂时无法读取内容，请稍后重新打开。';
}

function publicRequest<T>(path: string, method: 'GET' | 'POST', data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}${path}`, method, data,
      header: { accept: 'application/json', 'content-type': 'application/json' },
      success: result => {
        const body = object(result.data) ? result.data : null;
        if (result.statusCode < 200 || result.statusCode >= 300) { reject(new Error(neutralError(result.statusCode))); return; }
        if (!body || !Object.hasOwn(body, 'data')) { reject(new Error('暂时无法读取完整内容，请稍后重新打开。')); return; }
        resolve(body.data as T);
      },
      fail: () => reject(new Error('连接失败，请稍后重试。')),
    });
  });
}

Page({
  data: {
    loading: true,
    sending: false,
    error: '',
    route: null as ContactRoute | null,
    view: null as ContactPageView | null,
  },
  onLoad(options: { c?: string; t?: string; s?: string; scene?: string }) {
    const route = routeFromOptions(options);
    this.setData({ route, loading: true, error: '', view: null });
    if (!route) { this.setData({ loading: false, error: '这条内容已不可访问。' }); return; }
    this.load(route);
  },
  load(route?: ContactRoute) {
    route = route ?? this.data.route;
    if (!route) { this.setData({ loading: false, error: '这条内容已不可访问。' }); return; }
    this.setData({ loading: true, error: '', view: null });
    const path = route.kind === 'link' ? `/api/v1/contact-links/${encodeURIComponent(route.code)}` : `/api/v1/emergency-shares/${encodeURIComponent(route.code)}`;
    publicRequest<unknown>(path, 'GET').then(value => {
      const view = route.kind === 'link' ? parseLink(value) : parseShare(value);
      if (!view || Date.parse(view.expiresAt) <= Date.now()) throw new Error('这条内容已不可访问。');
      this.setData({ view, error: '' });
    }).catch(error => this.setData({ error: error instanceof Error ? error.message : '这条内容已不可访问。' })).finally(() => this.setData({ loading: false }));
  },
  respond(event: { currentTarget: { dataset: { kind: string } } }) {
    const kind = event.currentTarget.dataset.kind as ContactAction;
    const route = this.data.route;
    const view = this.data.view;
    if (this.data.sending || !route || route.kind !== 'link' || !view || view.kind !== 'link' || !ACTIONS.includes(kind) || view.response) return;
    this.setData({ sending: true, error: '' });
    publicRequest<unknown>(`/api/v1/contact-links/${encodeURIComponent(route.code)}/actions`, 'POST', { kind }).then(value => {
      const response = object(value) ? parseAction(value.response) : null;
      if (!response || response.kind !== kind) throw new Error('本次反馈尚未确认，请重新打开核对后再试。');
      this.setData({ view: { ...view, response } }); wx.showToast({ title: '已记录', icon: 'success' });
    }).catch(error => this.setData({ error: error instanceof Error ? error.message : '本次反馈尚未确认，请重新打开核对后再试。' })).finally(() => this.setData({ sending: false }));
  },
});
