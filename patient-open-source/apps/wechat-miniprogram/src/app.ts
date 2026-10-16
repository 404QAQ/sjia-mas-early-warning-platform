import { logout, session } from './api';

type ContactQueryKey = 'c' | 't' | 's' | 'scene';

/**
 * 联系人短链由微信启动参数进入小程序。只转发页面已支持的 query 名称，
 * 具体 code 格式、过期时间和公开数据仍由 contact 页面及服务端核验。
 */
function contactEntryUrl(shown?: { query?: Record<string, string> }): string | null {
  let options: { query?: Record<string, string> } | undefined = shown;
  // 热启动时 getLaunchOptionsSync 只返回冷启动参数；onShow 自带的参数才是这次点开的短链。
  if (!options?.query) { try { options = wx.getLaunchOptionsSync(); } catch { return null; } }
  const query = options?.query;
  if (!query) return null;
  for (const key of ['c', 't', 's', 'scene'] as ContactQueryKey[]) {
    const value = query[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096) {
      return `/pages/contact/index?${key}=${encodeURIComponent(value)}`;
    }
  }
  return null;
}

let handledContactEntry = '';

function routeContactEntry(shown?: { query?: Record<string, string> }): void {
  const url = contactEntryUrl(shown);
  if (!url || handledContactEntry === url) return;
  handledContactEntry = url;
  // 等待首屏路由完成后再替换，避免在 App.onLaunch 阶段调用路由 API 被微信拒绝；
  // 失败时允许同一短链下次再进来时重试。
  setTimeout(() => wx.redirectTo({ url, fail: () => { if (handledContactEntry === url) handledContactEntry = ''; } }), 0);
}

App({
  globalData: { role: session()?.role ?? null },
  // 角色由服务端微信会话和 Actor 权限派生；启动参数只用于联系人短链，不得改变权限。
  onLaunch() { routeContactEntry(); },
  onShow(options?: { query?: Record<string, string> }) { routeContactEntry(options); },
  onError() {
    // 小程序全局错误不展示敏感请求内容；业务页面自行显示可操作的错误文案。
  },
  logout() { void logout().finally(() => wx.redirectTo({ url: '/pages/auth/index' })); },
});
