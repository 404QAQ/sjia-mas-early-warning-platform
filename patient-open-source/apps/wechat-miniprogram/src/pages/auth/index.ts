import { ApiFailure, loginWithWechat } from '../../api';
import { ENTRY_SEX_INTENT_KEY } from '../../config';

Page({
  data: {
    loading: false,
    error: '',
    notBound: false,
    entrySex: 'UNKNOWN' as 'MALE' | 'FEMALE' | 'UNKNOWN',
    entrySexLabel: '入口选择不会改变档案中的登记信息。',
  },
  onShow() { this.setData({ error: '', notBound: false }); },
  chooseSex(event: { currentTarget?: { dataset?: { sex?: unknown } } }) {
    const sex = event.currentTarget?.dataset?.sex;
    if (sex !== 'MALE' && sex !== 'FEMALE' && sex !== 'UNKNOWN') return;
    const entrySexLabel = sex === 'MALE' ? '已选择男性入口，登录后查看可用档案。' : sex === 'FEMALE' ? '已选择女性入口，登录后查看可用档案。' : '登录后查看可用档案。';
    this.setData({ entrySex: sex, entrySexLabel });
    try { wx.setStorageSync(ENTRY_SEX_INTENT_KEY, sex); } catch { /* storage is optional in demo runtime */ }
  },
  login(): Promise<void> | undefined {
    if (this.data.loading) return undefined;
    try { wx.setStorageSync(ENTRY_SEX_INTENT_KEY, this.data.entrySex); } catch { /* storage is optional in demo runtime */ }
    this.setData({ loading: true, error: '', notBound: false });
    const preferredSex = this.data.entrySex === 'MALE' || this.data.entrySex === 'FEMALE' ? this.data.entrySex : undefined;
    return loginWithWechat(preferredSex).then(() => wx.switchTab({ url: '/pages/home/index' })).catch(error => {
      // 首次使用最常见的就是「还没绑定」：突出邀请码入口，而不是让家属去找「管理员」。
      const notBound = error instanceof ApiFailure && error.code === 'WECHAT_IDENTITY_NOT_BOUND';
      this.setData({ notBound, error: error instanceof Error ? error.message : '微信登录暂不可用。' });
    }).finally(() => this.setData({ loading: false }));
  },
  openBind() { wx.navigateTo({ url: '/pages/auth/bind' }); },
});
