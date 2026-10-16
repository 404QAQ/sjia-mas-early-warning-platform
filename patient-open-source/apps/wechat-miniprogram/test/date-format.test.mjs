import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/** 同一个时刻在患者手机上不能显示成两个时间 —— 患者报的「昨晚烧到 39.6℃」要能和医生看到的对上。 */
function render(tz) {
  const script = `
    const f = await import(${JSON.stringify(new URL('../dist/date-format.js', import.meta.url).href)});
    const fixed = '2026-10-13T16:30:00.000Z';
    console.log(JSON.stringify({ at: f.at(fixed), longDate: f.longDate(fixed), monthDay: f.monthDay(fixed) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(result.status, 0, `${tz} 下渲染失败：${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('患者端的时间显示不随手机时区改变', () => {
  const shanghai = render('Asia/Shanghai');
  for (const tz of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'UTC']) {
    assert.deepEqual(render(tz), shanghai, `${tz} 下的渲染结果与 Asia/Shanghai 不同`);
  }
  assert.match(shanghai.at, /2026\/10\/14 00:30/);
  assert.match(shanghai.monthDay, /10\/14/);
});

test('小程序里不再有漏掉时区的时间格式化', async () => {
  const files = ['pages/patient/trend.ts', 'pages/patient/records-workflow.ts', 'pages/patient/support.ts'];
  for (const name of files) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /toLocaleDateString\([^)]*\)(?![^)]*timeZone)/, `${name} 仍有未指定时区的 toLocaleDateString`);
    assert.doesNotMatch(source, /toLocaleString\('zh-CN'\)/, `${name} 仍有未指定时区的 toLocaleString`);
  }
  // 统一入口存在，公开版固定患者端的时区口径。
  const shared = await readFile(new URL('../src/date-format.ts', import.meta.url), 'utf8');
  assert.match(shared, /const ZONE = 'Asia\/Shanghai'/);
});
