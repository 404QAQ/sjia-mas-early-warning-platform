import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const distDir = path.join(appDir, 'dist');
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const tsc = path.join(rootDir, 'node_modules', '.pnpm', 'typescript@5.6.3', 'node_modules', 'typescript', 'lib', 'tsc.js');
const result = spawnSync(process.execPath, [tsc, '-p', path.join(appDir, 'tsconfig.json')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

// wxml 不在 tsc 的检查范围内，而开发者工具只在打开页面时才报编译错误。
// 在构建阶段先扫一遍源码，避免把「能构建但打不开」的包交给开发者工具。
const wxmlCheck = spawnSync(process.execPath, [path.join(scriptDir, 'check-wxml.mjs'), path.join(appDir, 'src')], { stdio: 'inherit' });
if (wxmlCheck.status !== 0) {
  console.error('wxml 检查未通过，已中止小程序构建');
  process.exit(wxmlCheck.status ?? 1);
}

// The API origin is an allow-listed, build-time value. Never put credentials in the
// package; production builds must provide the HTTPS origin explicitly.
const configuredApiBase = process.env.MAS_WECHAT_API_BASE?.trim();
if (process.env.NODE_ENV === 'production' && !configuredApiBase) {
  console.error('MAS_WECHAT_API_BASE is required for a production mini-program build');
  process.exit(1);
}
// 真机上的微信只放行已在后台报备的 HTTPS 域名；明文 HTTP 仅供开发者在开发者工具里
// 连自建演示服务（工具已关闭域名校验）。因此：
//   - 生产构建（NODE_ENV=production）一律要求 HTTPS，不给任何放行开关；
//   - 开发构建默认仍要求 HTTPS，只有显式设 MAS_WECHAT_ALLOW_INSECURE_HTTP=1 才放行 HTTP，
//     且放行时打印警告 —— 这种包不能当真机上线产物。
const allowInsecureHttp = process.env.NODE_ENV !== 'production' && process.env.MAS_WECHAT_ALLOW_INSECURE_HTTP === '1';
if (configuredApiBase) {
  let parsed;
  try { parsed = new URL(configuredApiBase); } catch { parsed = null; }
  const localDevelopment = parsed && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  // localhost 永远可用 http；其它主机默认要 https，除非显式放行开发用明文 HTTP。
  const protocolOk = parsed ? (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (localDevelopment || allowInsecureHttp))) : false;
  if (!parsed || !protocolOk || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    console.error('MAS_WECHAT_API_BASE must be an HTTPS API origin (HTTP is allowed only for localhost, or for a non-production build with MAS_WECHAT_ALLOW_INSECURE_HTTP=1; no path, credentials, query, or hash)');
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !localDevelopment) {
    console.warn(`⚠ 开发构建使用了明文 HTTP 的 API 地址 ${parsed.origin}：只能在关闭域名校验的开发者工具里使用，不能作为真机上线产物。`);
  }
}
if (configuredApiBase) {
  let configPath = path.join(distDir, 'config.js');
  let config = await readFile(configPath, 'utf8');
  const parsed = new URL(configuredApiBase);
  const apiBase = parsed.origin;
  config = config.replace(/http:\/\/127\.0\.0\.1:4302/g, () => apiBase);
  await writeFile(configPath, config, 'utf8');
}

// 免登录会议演示包不调用当前电脑的 wx.login，而是提交固定演示 code；
// 服务端仍必须在演示配置中提供固定身份映射，标准包保持显式微信登录入口。
if (process.env.MAS_WECHAT_AUTO_DEMO === '1') {
  const configPath = path.join(distDir, 'config.js');
  let config = await readFile(configPath, 'utf8');
  if (!config.includes('exports.AUTO_DEMO_LOGIN = false')) throw new Error('无法开启免登录演示模式：dist/config.js 缺少 AUTO_DEMO_LOGIN 占位');
  config = config.replace('exports.AUTO_DEMO_LOGIN = false', 'exports.AUTO_DEMO_LOGIN = true');
  await writeFile(configPath, config, 'utf8');
  console.warn('⚠ 已开启免登录演示模式：仅适用于开发者工具演示服务，不能用于真机上线。');
}

for (const file of ['app.json', 'project.config.json', 'sitemap.json']) await cp(path.join(appDir, file), path.join(distDir, file));

// 非 TS 的静态资源（wxml/wxss/json）要按**目录**整体拷，不能列文件名：
// 从前这里写死的是一串根目录模块名（api.js、app.js…），于是每当有人往 src 根目录
// 加一个新模块，本地因为 dist 里还留着上一份产物而看不出问题，CI/干净环境一构建就缺文件。
// 「根目录会加新文件」是常态而不是例外，所以这里按扩展名过滤整个 src 树。
// 逐个文件建父目录再拷。不能靠 cp 的 filter：它在嵌套目录下遇到被过滤掉的文件时，
// 不会为目标目录补建父路径，结果是整棵子树只剩 tsc 产出的 .js，wxml/json 全丢且**不报错**。
// 页面结构文件之外，tabBar 和页面插图也属于源码资产；按扩展名复制，避免
// 开发者工具打开源码正常但 dist 缺少图标的“假构建成功”。
const isStaticAsset = name => /\.(wxml|wxss|json|png|jpg|jpeg|svg|webp)$/.test(name);
async function copyAssets(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyAssets(from, to);
    else if (isStaticAsset(entry.name)) { await mkdir(path.dirname(to), { recursive: true }); await cp(from, to); }
  }
}
await copyAssets(path.join(appDir, 'src'), distDir);
// 根目录的源码级配置（app.json 等）不由 tsc 产出，单独补上。
for (const file of ['app.json']) await cp(path.join(appDir, file), path.join(distDir, file));

// 自检：源码里 import 的每个 dist 内相对模块都必须真实存在。
// 缺文件时 tsc 不报错（类型来自 src），只有开发者工具打开页面才炸，所以在这里拦下。
const emitted = new Set();
const collect = async dir => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full); else emitted.add(full);
  }
};
await collect(distDir);
const missing = [];
for (const file of emitted) {
  if (!file.endsWith('.js')) continue;
  const text = await readFile(file, 'utf8');
  for (const [, spec] of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const resolved = path.resolve(path.dirname(file), spec);
    if (!emitted.has(resolved)) missing.push(`${path.relative(rootDir, file)} → ${spec}`);
  }
}
if (missing.length) { console.error(`dist 里有未产出的模块引用：\n  ${missing.join('\n  ')}`); process.exit(1); }

console.log(`built ${path.relative(rootDir, distDir)}（${emitted.size} 个文件）`);
