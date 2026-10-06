#!/usr/bin/env node
/**
 * Darwin Skill - 高清截图脚本（跨平台）
 *
 * 用法: node scripts/screenshot.mjs [html文件路径] [输出png路径]
 *
 * 截图后端按优先级自动选择：
 *   1. playwright / playwright-core（2x 高清，只截 .card）—— 自动探测本地/全局安装
 *   2. web-access CDP Proxy（localhost:3456）—— 复用用户日常浏览器，无需装 playwright
 * 两者都不可用时报错并给出修复指引。
 *
 * 跨平台要点：用 pathToFileURL 生成 file:// URL（避免 Windows 的 /C:/ 前缀问题），
 * 打开图片的命令按 platform 选择（open/start/xdg-open），且失败不致命。
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';
const require = createRequire(import.meta.url);

const htmlPath = process.argv[2]
  ? process.argv[2]
  : new URL('../templates/result-card.html', import.meta.url).pathname;
const outputPath = process.argv[3]
  ? process.argv[3]
  : new URL('../templates/result-card.png', import.meta.url).pathname;

const fileUrl = /^[a-z]+:\/\//i.test(htmlPath) ? htmlPath : pathToFileURL(htmlPath).href;

// ---------- playwright 自动探测 ----------
function loadPlaywright() {
  const ids = ['playwright', 'playwright-core'];
  // 追加全局 npm root 下的候选路径
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    if (root) {
      ids.push(
        `${root}/playwright`,
        `${root}/playwright-core`,
        `${root}/playwright/node_modules/playwright-core`,
      );
    }
  } catch { /* npm 不可用则跳过 */ }

  for (const id of ids) {
    try { return require(id); } catch { /* 试下一个 */ }
  }
  return null;
}

// ---------- 跨平台打开图片（失败不致命）----------
function openImage(p) {
  try {
    if (process.platform === 'darwin') execSync(`open "${p}"`);
    else if (process.platform === 'win32') execSync(`start "" "${p}"`, { shell: 'cmd.exe' });
    else execSync(`xdg-open "${p}"`);
  } catch { /* 无 GUI / 命令缺失时忽略 */ }
}

// ---------- 后端 1：playwright ----------
async function viaPlaywright(pw) {
  const browser = await pw.chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 920, height: 1600 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2000);

    const card = await page.locator('.card');
    await card.screenshot({ path: outputPath, type: 'png' });
    const box = await card.boundingBox();
    console.log(`[playwright] 截图完成: ${outputPath}`);
    console.log(`卡片尺寸: ${Math.round(box.width)}x${Math.round(box.height)}px (CSS) → 2x 高清`);
  } finally {
    await browser.close();
  }
}

// ---------- 后端 2：web-access CDP Proxy ----------
const PROXY = 'http://localhost:3456';

async function proxyAlive() {
  try {
    const r = await fetch(`${PROXY}/targets`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function viaCdpProxy() {
  // 打开本地 HTML
  const newRes = await fetch(`${PROXY}/new`, { method: 'POST', body: fileUrl });
  const { targetId } = await newRes.json();
  if (!targetId) throw new Error('CDP Proxy 未返回 targetId');

  const evalJs = async (js) => {
    const r = await fetch(`${PROXY}/eval?target=${targetId}`, { method: 'POST', body: js });
    return (await r.json()).value;
  };

  try {
    // 计算 zoom：让整张 .card 放进当前 viewport（高度常超出，需缩放）
    const dims = await evalJs(
      'const c=document.querySelector(".card").getBoundingClientRect();' +
      'JSON.stringify({cw:c.width,ch:c.height,vw:innerWidth,vh:innerHeight})'
    );
    const { cw, ch, vw, vh } = JSON.parse(dims);
    const zoom = Math.min(1, (vw - 16) / cw, (vh - 16) / ch);
    await evalJs(
      `document.documentElement.style.zoom="${zoom.toFixed(3)}";` +
      `document.body.style.alignItems="flex-start";"ok"`
    );
    // 等字体/重排
    await evalJs('document.fonts.ready.then(()=>1);"ok"');
    await new Promise((res) => setTimeout(res, 1500));

    // 截图（CDP 偶发 Page.captureScreenshot 超时，重试一次）
    let saved = false;
    for (let i = 0; i < 2 && !saved; i++) {
      const r = await fetch(`${PROXY}/screenshot?target=${targetId}&file=${encodeURIComponent(outputPath)}`);
      const j = await r.json();
      if (j.saved) saved = true;
      else if (i === 0) await new Promise((res) => setTimeout(res, 1000));
      else throw new Error(`CDP 截图失败: ${j.error || JSON.stringify(j)}`);
    }
    console.log(`[cdp-proxy] 截图完成: ${outputPath}（缩放 ${zoom.toFixed(2)}，分辨率受浏览器 dpr 限制）`);
  } finally {
    await fetch(`${PROXY}/close?target=${targetId}`).catch(() => {});
  }
}

// ---------- 主流程 ----------
async function main() {
  const pw = loadPlaywright();
  if (pw) {
    await viaPlaywright(pw);
  } else if (await proxyAlive()) {
    console.log('未探测到 playwright，回退 web-access CDP Proxy。');
    await viaCdpProxy();
  } else {
    console.error(
      '截图失败：playwright 未安装，且 web-access CDP Proxy（localhost:3456）未运行。\n' +
      '修复二选一：\n' +
      '  1. 装 playwright：npm i -g playwright 或 npm i -g playwright-core\n' +
      '  2. 启动 CDP Proxy：node <web-access>/scripts/check-deps.mjs'
    );
    process.exit(1);
  }
  openImage(outputPath);
}

main().catch((err) => {
  console.error('截图失败:', err.message);
  process.exit(1);
});
