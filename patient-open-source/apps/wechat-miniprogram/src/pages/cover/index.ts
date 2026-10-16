import { loginWithWechat, session } from '../../api';
import { AUTO_DEMO_LOGIN } from '../../config';

const COVER_MOMENTS = [
  { weather: '散步前，先看一眼天气', detail: '选一双舒服的鞋，按自己的节奏出发', care: '今天也要记得照顾好自己。' },
  { weather: '晴天出门，记得带水', detail: '遮阳、补水，也给自己留一点休息时间', care: '给自己留一点从容的时间。' },
  { weather: '遇到下雨，记得带伞', detail: '路面湿滑时慢一点，平安到达就很好', care: '辛苦的一天，也值得一句鼓励。' },
  { weather: '天气变化，多备一件薄外套', detail: '出门前核对当地预报，照顾好路上的自己', care: '慢一点也没关系，按自己的节奏来。' },
] as const;

const ENCOURAGEMENTS = [
  '把今天过好，就是很棒的进步。',
  '照顾好自己，再去处理其他事情。',
  '每一次小小的坚持，都值得被看见。',
  '愿你今天有一段安静、舒服的时光。',
] as const;

/**
 * 封面页（伪装页）—— 小程序启动后看到的**第一屏**，不是给家属用的功能页。
 *
 * 为什么要有这一页：慢病孩子的手机常常会被同学、亲戚、邻居顺手拿过去看，一个叫
 * 「MAS 预警平台」或一打开就是体温、皮疹、激素剂量的应用，等于把诊断摊开给别人看。
 * 这一页只做一件事：让**不经意的旁观者**看到的是一屏再普通不过的健康记录。
 *
 * 三条边界，都是刻意的：
 *   1. **不显示任何患者信息**。不读接口、不渲染姓名、科室、诊断、用药、告警 —— 这一页
 *      在未登录时也能正常渲染，因此不可能泄露任何东西。它拿到的唯一事实是「本机有没有会话」，
 *      而且只用来决定那一颗按钮去哪里，不渲染出来。
 *   2. **只展示生活类演示内容**。日期来自本机时钟；出行贴士、关心语和激励语句是固定的
 *      演示文案，不读取接口，也不编造体重、步数、睡眠这些可能暴露身份的数字。
 *   3. **它不假装成另一个应用**。不冒用任何真实产品或机构的名字与品牌，
 *      只是把入口做得平淡。
 *
 * 所以这一页不是安全边界（真要看内容仍然需要微信授权与已建立的绑定），
 * 它只是把「陌生人瞥一眼」这件事的成本重新降回零。
 */
Page({
  data: {
    today: '',
    weekday: '',
    greeting: '',
    weather: '',
    weatherDetail: '',
    care: '',
    encouragement: '',
    /** 「还没有记录」是这一页唯一的状态文案；有会话时也只是同一句话，不改成患者名字。 */
    status: '还没有记录。',
    error: '',
    opening: false,
  },

  onShow() {
    const now = new Date();
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const hour = now.getHours();
    // 只展示普通生活内容，不读取接口，也不根据会话推断任何患者信息。
    const moment = COVER_MOMENTS[(now.getDate() + now.getMonth()) % COVER_MOMENTS.length]!;
    const encouragement = ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)]!;
    this.setData({
      today: `${now.getMonth() + 1} 月 ${now.getDate()} 日`,
      weekday: weekdays[now.getDay()],
      greeting: hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好',
      weather: moment.weather,
      weatherDetail: moment.detail,
      care: moment.care,
      encouragement,
      opening: false,
    });
  },

  /**
   * 那颗真正的入口按钮。已经登录过就直接进首页，否则回登录页 —— 由**本机会话**决定，
   * 不向服务端问「这个微信是谁」：封面页不该因为一次网络请求就暴露身份或报错。
   * 会话是否仍然有效由后续页面按原来的方式判定（服务端拒绝时会统一清屏回登录页）。
   */
  async enter(): Promise<void> {
    if (this.data.opening) return;
    this.setData({ opening: true, error: '' });
    if (AUTO_DEMO_LOGIN) {
      try {
        await loginWithWechat();
        wx.switchTab({ url: '/pages/home/index', fail: () => this.setData({ opening: false }) });
      } catch (error) {
        // 免登录包失败时留在生活封面并给出可执行排查，不把用户误导到男女登录页。
        // 标准包仍保留显式登录入口；两种模式的失败边界不能混在一起。
        this.setData({ opening: false, error: error instanceof Error ? error.message : '线上服务暂不可用，请检查网络后重试。' });
      }
      return;
    }
    if (session()) wx.switchTab({ url: '/pages/home/index', fail: () => this.setData({ opening: false }) });
    else wx.redirectTo({ url: '/pages/auth/index', fail: () => this.setData({ opening: false }) });
  },
});
