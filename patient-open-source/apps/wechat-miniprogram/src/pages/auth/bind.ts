import { bindWechatWithInvite } from '../../api';
import { formatInviteCode, normalizeInviteCode } from '../../invite-code';

Page({
  data: {
    inviteCode: '',
    preview: '',
    submitting: false,
    error: '',
  },
  onCodeInput(event: { detail?: { value?: unknown } }) {
    const value = typeof event.detail?.value === 'string' ? event.detail.value : '';
    const normalized = normalizeInviteCode(value);
    this.setData({ inviteCode: value, preview: normalized ? formatInviteCode(normalized) : '', error: '' });
  },
  submit(): Promise<void> | undefined {
    if (this.data.submitting) return undefined;
    this.setData({ submitting: true, error: '' });
    return bindWechatWithInvite(String(this.data.inviteCode ?? '')).then(() => {
      wx.showToast({ title: '绑定成功', icon: 'success' });
      // 首页是 tab 页面；switchTab 会关闭登录、绑定这些非 tab 页面。
      wx.switchTab({ url: '/pages/home/index' });
    }).catch(error => {
      this.setData({ error: error instanceof Error ? error.message : '绑定暂不可用，请稍后重试。' });
    }).finally(() => this.setData({ submitting: false }));
  },
});
