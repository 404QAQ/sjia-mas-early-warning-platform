/**
 * wxml 静态检查：小程序开发者工具只在打开页面时才报编译错误，且报错位置指向 dist，
 * 而 dist 是每次构建都清空重建的产物 —— 在 dist 里改会被下次构建抹掉。
 * 这个脚本在构建前扫源码，把「改了 dist 没改 src」这类问题拦在开发工具之前。
 *
 * 检查三类问题：
 *   ① 同一节点同时使用 wx:for 与 wx:if/wx:elif/wx:else（编译直接失败，就是本次踩到的坑）
 *   ② wx:elif/wx:else 前面没有 wx:if/wx:elif 兄弟节点
 *   ③ 标签不匹配、未闭合、多个根节点
 *
 * 用法：node scripts/check-wxml.mjs [目录...]   默认扫 apps/wechat-miniprogram/src
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const args = process.argv.slice(2);
const targets = args.length ? args : ['apps/wechat-miniprogram/src'];

const files = [];
async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.wxml')) files.push(full);
  }
}
for (const target of targets) {
  const full = path.resolve(rootDir, target);
  const info = await stat(full).catch(() => null);
  if (!info) { console.error(`路径不存在：${target}`); process.exitCode = 1; continue; }
  if (info.isDirectory()) await walk(full); else files.push(full);
}
files.sort();

const problems = [];
let nodeCount = 0;

for (const file of files) {
  const display = path.relative(rootDir, file);
  const raw = await readFile(file, 'utf8');
  // 注释用等长空白替换，保持行号不变
  const text = raw.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  const doc = { tag: '#document', line: 0, children: [] };
  const stack = [doc];
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/g;
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const isClose = match[1] === '/';
    const tag = match[2];
    const attrText = match[3];
    const selfClose = /\/\s*$/.test(attrText);
    const line = text.slice(0, match.index).split('\n').length;

    if (isClose) {
      const current = stack.at(-1);
      if (current === doc) { problems.push(`${display}:${line} 多余的 </${tag}>`); continue; }
      if (current.tag !== tag) {
        problems.push(`${display}:${line} 标签不匹配：</${tag}> 关闭的是 <${current.tag}>（开于第 ${current.line} 行）`);
        const index = stack.map(item => item.tag).lastIndexOf(tag);
        if (index > 0) stack.length = index;
        continue;
      }
      stack.pop();
      continue;
    }

    const names = new Set();
    for (const attr of attrText.matchAll(attrRe)) if (attr[1]) names.add(attr[1]);
    nodeCount += 1;

    const parent = stack.at(-1);
    const sibling = parent.children.at(-1);
    if (parent === doc && sibling) problems.push(`${display}:${line} 出现多个根节点（<${tag}>，前一个根在第 ${sibling.line} 行）`);

    const hasFor = names.has('wx:for');
    const hasIf = names.has('wx:if');
    const hasElif = names.has('wx:elif');
    const hasElse = names.has('wx:else');
    if (hasFor && (hasIf || hasElif || hasElse)) {
      problems.push(`${display}:${line} <${tag}> 同一节点同时使用 wx:for 与 ${hasIf ? 'wx:if' : hasElif ? 'wx:elif' : 'wx:else'}（用 <block wx:else> 包一层，把 wx:for 下沉到内层）`);
    }
    if ((hasElif || hasElse) && !(sibling && sibling.conditional)) {
      problems.push(`${display}:${line} <${tag}> 使用 ${hasElif ? 'wx:elif' : 'wx:else'}，但前一个兄弟节点${sibling ? ` <${sibling.tag}>（第 ${sibling.line} 行）` : '不存在'}不是 wx:if/wx:elif`);
    }

    parent.children.push({ tag, line, conditional: hasIf || hasElif || hasElse });
    if (!selfClose) stack.push({ tag, line, children: [] });
  }
  for (const left of stack) if (left !== doc) problems.push(`${display}:${left.line} <${left.tag}> 未闭合`);
}

console.log(`扫描 ${files.length} 个 wxml 文件 / ${nodeCount} 个节点`);
if (problems.length) {
  console.log('\n发现问题：');
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('✓ 通过：无 wx:for 与条件指令同节点、无 wx:elif/wx:else 失配、无标签不匹配或未闭合');
}
