interface WxRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: unknown;
  header?: Record<string, string>;
  success?: (result: { statusCode: number; data?: unknown }) => void;
  fail?: (error: { errMsg?: string }) => void;
  complete?: () => void;
}

interface WxLoginOptions { success?: (result: { code: string }) => void; fail?: (error: { errMsg?: string }) => void; }

interface WxApi {
  getFileSystemManager?(): { readFile(options: { filePath: string; success: (result: { data: ArrayBuffer | string }) => void; fail: (error: { errMsg?: string }) => void }): void };
  chooseImage?(options: { count?: number; sizeType?: Array<'original' | 'compressed'>; sourceType?: Array<'album' | 'camera'>; success?: (result: { tempFilePaths: string[] }) => void; fail?: (error: { errMsg?: string }) => void }): void;
  saveFile?(options: { tempFilePath: string; success?: (result: { savedFilePath: string }) => void; fail?: (error: { errMsg?: string }) => void }): void;
  removeSavedFile?(options: { filePath: string; success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  previewImage?(options: { current?: string; urls: string[]; fail?: (error: { errMsg?: string }) => void }): void;
  openSetting?(options: { success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  setNavigationBarTitle?(options: { title: string }): void;
  request(options: WxRequestOptions): { abort(): void };
  downloadFile?(options: { url: string; header?: Record<string, string>; timeout?: number; success?: (result: { statusCode: number; tempFilePath: string }) => void; fail?: (error: { errMsg?: string }) => void }): { abort(): void };
  openDocument?(options: { filePath: string; fileType?: 'pdf'; showMenu?: boolean; success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  login(options: WxLoginOptions): void;
  navigateTo(options: { url: string; success?: () => void; fail?: () => void }): void;
  navigateBack(options?: { delta?: number; success?: () => void; fail?: () => void }): void;
  pageScrollTo(options: { selector?: string; scrollTop?: number; duration?: number }): void;
  switchTab(options: { url: string; success?: () => void; fail?: () => void }): void;
  setTabBarItem?(options: { index: number; text: string; success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  redirectTo(options: { url: string; success?: () => void; fail?: () => void }): void;
  reLaunch(options: { url: string; success?: () => void; fail?: () => void }): void;
  showModal(options: { title?: string; content: string; confirmText?: string; cancelText?: string; confirmColor?: string; success?: (result: { confirm: boolean; cancel: boolean }) => void; fail?: () => void }): void;
  showToast(options: { title: string; icon?: 'none' | 'success' | 'loading'; duration?: number }): void;
  setClipboardData?(options: { data: string; success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  makePhoneCall(options: { phoneNumber: string; success?: () => void; fail?: (error: { errMsg?: string }) => void }): void;
  requestSubscribeMessage(options: {
    tmplIds: string[];
    success?: (result: Record<string, string>) => void;
    fail?: (error: { errMsg?: string; errCode?: number }) => void;
  }): void;
  setStorageSync(key: string, value: unknown): void;
  getStorageSync<T = unknown>(key: string): T;
  removeStorageSync(key: string): void;
  getStorageInfoSync?(): { keys: string[] };
  getLaunchOptionsSync(): { query?: Record<string, string>; scene?: number };
  onNetworkStatusChange?(callback: (result: { isConnected: boolean; networkType?: string }) => void): void;
  offNetworkStatusChange?(callback: (result: { isConnected: boolean; networkType?: string }) => void): void;
}

declare const wx: WxApi;

// WeChat miniprogram runtime provides these globals; declare them here rather
// than pulling in @types/node so the project has no ambient type dependency.
declare function setTimeout(callback: () => void, ms?: number): number;
declare function clearTimeout(id: number | undefined): void;

declare function App(options: Record<string, unknown>): void;
interface MiniPageContext { data: Record<string, any>; setData(value: Record<string, unknown>, callback?: () => void): void; [key: string]: any; }
declare function Page(options: Record<string, unknown> & ThisType<MiniPageContext>): void;
declare function getApp<T = Record<string, unknown>>(): T;
