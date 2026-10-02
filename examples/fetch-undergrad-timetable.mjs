/**
 * 深圳大学本科生「我的课表」抓取器。
 *
 * 入口：jwapp/sys/wdkb（本科生），与研究生 gsapp/sys/wdkbapp 不同。
 * 使用真实 Chromium/Chrome 持久化 profile，登录后的设备信任 Cookie 会保留。
 *
 * 必填环境变量：SZU_STUDENT_ID、SZU_PASSWORD
 * 可选环境变量：
 *   SZU_HEADED=1                 有头运行（滑块或首次登录时使用）
 *   SZU_BROWSER_CHANNEL=chrome   使用系统 Chrome；默认使用 Playwright Chromium
 *   SZU_PROFILE=./browser-profile
 *   SZU_OUTPUT=./output/undergraduate-timetable.json
 *   SZU_LOG_DIR=./logs
 */

import { chromium } from 'playwright';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUDENT_ID = process.env.SZU_STUDENT_ID;
const PASSWORD = process.env.SZU_PASSWORD;
const HEADED = process.env.SZU_HEADED === '1';
const PROFILE = resolve(process.env.SZU_PROFILE || resolve(ROOT, 'browser-profile'));
const OUTPUT = resolve(
  process.env.SZU_OUTPUT || resolve(ROOT, 'output/undergraduate-timetable.json'),
);
const LOG_DIR = resolve(process.env.SZU_LOG_DIR || resolve(ROOT, 'logs'));
const ENTRY =
  process.env.SZU_ENTRY_URL ||
  'https://ehall.szu.edu.cn/jwapp/sys/wdkb/*default/index.do?t_s=1790913987519&amp_sec_version_=1&gid_=eEV2M0R2Rk1RSlk0a2pDdVhNT3J3aE1CdEZDaUpOZTNjNDZrM3ZibUJYTThhSldsbEppdElBUUxwWWNHbnJoMXNjb0t0TFJsV29tYitEeGJWREhCZWc9PQ&EMAP_LANG=zh&THEME=cherry#/xskcb';
const EHALL_HOME = 'https://ehall.szu.edu.cn/new/index.html';
const AUTH_HOST = 'authserver.szu.edu.cn';
const REQUIRED_ENDPOINTS = ['dqxnxq', 'dqzc', 'xskcb'];
const OPTIONAL_ENDPOINTS = ['xsdkkc', 'xswpkc', 'xssjkkc'];
const COURSE_ENDPOINTS = new Set([...REQUIRED_ENDPOINTS, ...OPTIONAL_ENDPOINTS].map((x) => `${x}.do`));

if (!STUDENT_ID || !PASSWORD) {
  console.error('请先设置 SZU_STUDENT_ID 和 SZU_PASSWORD。');
  process.exit(2);
}

const timestamp = () => new Date().toISOString();
const safeName = timestamp().replaceAll(':', '').replaceAll('.', '');
const logPath = resolve(LOG_DIR, `undergraduate-timetable-${safeName}.log`);

function redact(value) {
  return String(value)
    .replaceAll(PASSWORD, '[REDACTED_PASSWORD]')
    .replaceAll(STUDENT_ID, maskStudentId(STUDENT_ID))
    .replace(/(ticket=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(CASTGC|MULTIFACTOR_BROWSER_FINGERPRINT)=([^;\s]+)/gi, '$1=[REDACTED]')
    .replace(/([?&](?:gid_|t_s)=)[^&\s#]+/gi, '$1[REDACTED]');
}

function safeSourceUrl(value) {
  return redact(value);
}

function maskStudentId(value) {
  const text = String(value);
  return text.length <= 4 ? '****' : `${text.slice(0, 2)}****${text.slice(-2)}`;
}

async function log(message, details = '') {
  const line = `[${timestamp()}] ${message}${details ? ` ${redact(details)}` : ''}\n`;
  process.stdout.write(line);
  await appendFile(logPath, line, 'utf8');
}

function endpointName(url) {
  try {
    const name = new URL(url).pathname.split('/').pop();
    return COURSE_ENDPOINTS.has(name) ? name.slice(0, -3) : null;
  } catch {
    return null;
  }
}

function rowsOf(response, key) {
  return response?.datas?.[key]?.rows ?? [];
}

function firstRow(response, key) {
  return rowsOf(response, key)[0] ?? null;
}

function stringOrNull(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function splitTeachers(value) {
  return String(value ?? '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCourse(row) {
  return {
    courseCode: stringOrNull(row.KCH),
    courseName: stringOrNull(row.KCM),
    section: stringOrNull(row.KXH),
    teachers: splitTeachers(row.SKJS),
    weeksText: stringOrNull(row.ZCMC),
    weekday: toNumber(row.SKXQ),
    startSection: toNumber(row.KSJC),
    endSection: toNumber(row.JSJC),
    location: stringOrNull(row.JASMC),
    campus: stringOrNull(row.XXXQDM),
    rawId: stringOrNull(row.JXBID),
  };
}

function normalizeAdjustment(row) {
  return {
    courseCode: stringOrNull(row.KCH),
    courseName: stringOrNull(row.KCM),
    section: stringOrNull(row.KXH),
    weeksText: stringOrNull(row.ZCMC),
    weekday: toNumber(row.SKXQ),
    startSection: toNumber(row.KSJC),
    endSection: toNumber(row.JSJC),
    newWeeksText: stringOrNull(row.XZCMC ?? row.ZCMC),
    newWeekday: toNumber(row.XSKXQ),
    newStartSection: toNumber(row.XKSJC),
    newEndSection: toNumber(row.XJSJC),
    rawId: stringOrNull(row.JXBID),
  };
}

function normalizeApi(api, sourceUrl) {
  const termRow = firstRow(api.dqxnxq, 'dqxnxq');
  const weekRow = firstRow(api.dqzc, 'dqzc');
  return {
    fetchedAt: timestamp(),
    sourceUrl: safeSourceUrl(sourceUrl),
    term: {
      id: stringOrNull(termRow?.DM),
      name: stringOrNull(termRow?.MC),
      year: stringOrNull(termRow?.XNDM),
      semester: stringOrNull(termRow?.XQDM),
      currentWeek: toNumber(weekRow?.ZC),
    },
    items: rowsOf(api.xskcb, 'xskcb').map(normalizeCourse),
    extraItems: {
      adjusted: rowsOf(api.xsdkkc, 'xsdkkc').map(normalizeAdjustment),
      unlisted: rowsOf(api.xswpkc, 'xswpkc').map(normalizeCourse),
      practice: rowsOf(api.xssjkkc, 'xssjkkc').map(normalizeCourse),
    },
  };
}

function emptyApi(key) {
  return { code: '0', datas: { [key]: { rows: [] } } };
}

async function waitForApis(page, api, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (REQUIRED_ENDPOINTS.every((key) => api[key])) return;
    await page.waitForTimeout(250);
  }
}

async function loginIfNeeded(page) {
  if (!page.url().includes(`${AUTH_HOST}/authserver/login`)) return;

  await log('检测到统一身份认证登录页', `account=${maskStudentId(STUDENT_ID)}`);
  const username = page.locator('#username:visible').first();
  await username.fill(STUDENT_ID);

  // 密码输入框初始带 readonly，站点脚本会在输入用户名后解除；使用 DOM 事件
  // 写入可见框，让站点自己的 startLogin() 完成 AES 加密并提交隐藏域。
  const password = page.locator('#password:visible').first();
  await password.evaluate((element, value) => {
    element.removeAttribute('readonly');
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, PASSWORD);
  await page.locator('#login_submit:visible').first().click();
  await page.waitForTimeout(1500);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (page.url().includes('/reAuthCheck/')) {
    throw new Error(
      '当前设备触发了统一身份认证二次验证。请先用有头模式完成一次可信设备登录，或确认校园网/浏览器 profile 未变化。',
    );
  }
  if (page.url().includes(`${AUTH_HOST}/authserver/login`) && /验证码|密码错误|请输入/.test(bodyText)) {
    throw new Error(`登录未成功：${bodyText.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  await log('统一身份认证提交完成', `url=${page.url()}`);
}

async function main() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(dirname(OUTPUT), { recursive: true });
  await log('开始抓取本科生课表', `entry=${ENTRY}`);
  await log('浏览器配置', `headless=${!HEADED} channel=${process.env.SZU_BROWSER_CHANNEL || 'playwright-chromium'}`);

  const launchOptions = {
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.env.SZU_BROWSER_CHANNEL) launchOptions.channel = process.env.SZU_BROWSER_CHANNEL;

  const context = await chromium.launchPersistentContext(PROFILE, launchOptions);
  const page = context.pages()[0] ?? (await context.newPage());
  const api = {};

  page.on('request', (request) => {
    const name = endpointName(request.url());
    if (name) void log('捕获课表请求', `${request.method()} ${name}.do`);
  });
  page.on('response', async (response) => {
    const name = endpointName(response.url());
    if (!name) return;
    try {
      const parsed = await response.json();
      const oldRows = rowsOf(api[name], name).length;
      const newRows = rowsOf(parsed, name).length;
      // 页面可能按初始化和当前周各请求一次；保留行数最多的完整响应。
      if (!api[name] || newRows >= oldRows) {
        api[name] = parsed;
        await log('保存课表响应', `${name}.do status=${response.status()} rows=${newRows}`);
      }
    } catch {
      await log('忽略非 JSON 课表响应', `${name}.do status=${response.status()}`);
    }
  });

  try {
    let response = await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page);

    if (page.url().includes(`${AUTH_HOST}/authserver/login`) || page.url().includes('/reAuthCheck/')) {
      throw new Error(`认证未完成，当前页面为 ${page.url()}`);
    }

    // 先打开 eHall 首页建立门户会话，再进入应用。部分账号直接访问应用会得到 403。
    await page.goto(EHALL_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    await page.goto('about:blank');
    response = await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForApis(page, api);

    for (const key of OPTIONAL_ENDPOINTS) api[key] ??= emptyApi(key);
    if (!REQUIRED_ENDPOINTS.every((key) => api[key])) {
      const body = await page.locator('body').innerText().catch(() => '');
      throw new Error(
        `未捕获完整本科生课表接口（缺少 ${REQUIRED_ENDPOINTS.filter((key) => !api[key]).join(', ')}），` +
          `HTTP=${response?.status() ?? 'unknown'}，页面=${body.replace(/\s+/g, ' ').slice(0, 180)}`,
      );
    }

    const result = normalizeApi(api, page.url());
    await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await log('课表抓取完成', `term=${result.term.id} courses=${result.items.length} output=${OUTPUT}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await log('浏览器已关闭');
  }
}

main().catch(async (error) => {
  const message = error?.stack || error?.message || String(error);
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(logPath, `[${timestamp()}] ERROR ${redact(message)}\n`, 'utf8');
  } catch {
    // 日志写入失败时仍将原始错误交给进程退出码。
  }
  console.error(redact(message));
  process.exit(1);
});
