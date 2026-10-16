/**
 * 医生给的微信绑定邀请码：8 位，字母表与服务端一致（去掉 0/O、1/I 等易混字符）。
 *
 * 只容忍抄写差异（全角、空格、连字符、小写），不做猜测纠错：把 O 抄成 0 不会被
 * 自动改正 —— 0 不在字母表里，直接按格式错误提示。服务端会再规范化一次，以服务端为准。
 */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const INVITE_CODE_FORMAT_MESSAGE = '邀请码是 8 位字母或数字（不含 0、1、I、O），请核对后重新输入';

const VALID_CODE = new RegExp(`^[${INVITE_CODE_ALPHABET}]{8}$`);

export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const nfkc = typeof value.normalize === 'function' ? value.normalize('NFKC') : value;
  // 个别运行时没有 normalize：手动把全角 ASCII 折回半角（中文输入法全角模式最常见）。
  const folded = nfkc.replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  // 聊天里粘贴来的码常带 en/em 破折号（–—）：与短横线一样只当分隔符。
  const compact = folded.replace(/[\s\-_·•–—]/g, '').toUpperCase();
  return VALID_CODE.test(compact) ? compact : null;
}

/** 展示成 `ABCD-EFGH`，与医生端念给家属的格式一致。 */
export function formatInviteCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
