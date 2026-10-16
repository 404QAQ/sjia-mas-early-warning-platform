/**
 * 按微信小程序真实语义运行页面的测试辅助。
 *
 * 微信的 Page(options)：options.data 深拷贝成 this.data，WXML 只渲染 this.data；
 * 其余非函数的顶层字段也会深拷贝，但挂在页面实例 this 上，**不在 this.data 里**；
 * setData 支持 'a.b' 路径写入。很多测试用 `Page = () => {}` 跳过页面逻辑，
 * 就会漏掉「状态写在顶层、读 this.data 得到 undefined」这类只在真机出现的问题。
 */
export const SESSION_KEY = 'mas.wechat.session.v1';

export function capturePages() {
  const registered = [];
  globalThis.Page = options => { registered.push(options); };
  return registered;
}

export async function loadPage(registered, specifier) {
  const before = registered.length;
  await import(specifier);
  if (registered.length !== before + 1) throw new Error(`${specifier} 没有注册页面`);
  return registered[registered.length - 1];
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

export function instantiate(options) {
  const page = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'data') continue;
    page[key] = typeof value === 'function' ? value : structuredClone(value);
  }
  page.data = structuredClone(options.data ?? {});
  // setData 的值必须可被结构化克隆（微信要求可序列化），克隆失败说明页面往 data 里放了函数或实例。
  page.setData = function setData(patch) { for (const [key, value] of Object.entries(patch)) setPath(this.data, key, structuredClone(value)); };
  return page;
}

export const flush = () => new Promise(resolve => setTimeout(resolve, 0));
export async function settle(times = 6) { for (let index = 0; index < times; index += 1) await flush(); }

/**
 * wx 桩：storage 为真实 Map；respond(path, options) 返回 [statusCode, body] 或 'NETWORK'（触发 fail）。
 * 返回 calls 记录请求、跳转、弹窗与剪贴板。
 */
export function installWx(respond, { session, extra = {} } = {}) {
  const storage = new Map(session ? [[SESSION_KEY, structuredClone(session)]] : []);
  const calls = { requests: [], navigations: [], modals: [], clipboard: [], toasts: [] };
  globalThis.wx = {
    request(options) {
      const url = new URL(options.url);
      const path = url.pathname + url.search;
      calls.requests.push({ path, method: options.method ?? 'GET', data: options.data, header: options.header });
      Promise.resolve().then(() => respond(path, options)).then(reply => {
        if (reply === 'NETWORK') options.fail?.({ errMsg: 'request:fail' });
        else options.success?.({ statusCode: reply[0], data: reply[1] });
      });
      return { abort() {} };
    },
    login(options) { options.success({ code: 'wx-code' }); },
    getStorageSync(key) { return storage.has(key) ? structuredClone(storage.get(key)) : ''; },
    setStorageSync(key, value) { storage.set(key, structuredClone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    getStorageInfoSync() { return { keys: [...storage.keys()] }; },
    redirectTo(options) { calls.navigations.push(['redirectTo', options.url]); },
    reLaunch(options) { calls.navigations.push(['reLaunch', options.url]); },
    navigateTo(options) { calls.navigations.push(['navigateTo', options.url]); },
    switchTab(options) { calls.navigations.push(['switchTab', options.url]); },
    showToast(options) { calls.toasts.push(options.title); },
    showModal(options) { calls.modals.push(options); options.success?.({ confirm: calls.modalAnswer ?? true, cancel: !(calls.modalAnswer ?? true) }); },
    setClipboardData(options) { calls.clipboard.push(options.data); options.success?.(); },
    getLaunchOptionsSync() { return {}; },
    ...extra,
  };
  return { storage, calls };
}
