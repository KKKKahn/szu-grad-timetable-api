/**
 * 深圳大学研究生课表 —— 最小可用实现（路线 B：Playwright 持久化浏览器）
 *
 * 配套文档：../docs/szu-grad-timetable-api.md
 *
 * 环境变量（全部必填/可选见下，请勿把凭据写进代码）：
 *   SZU_STUDENT_ID   必填  学号
 *   SZU_PASSWORD     必填  统一身份认证密码
 *   SZU_MFA_CHANNEL  可选  二次验证渠道：4=企业微信验证码（默认）3=短信验证码
 *                          也可填 11=邮箱 12=钉钉 5=今日校园（需在 reAuthLoginView 页面存在该渠道）
 *   SZU_HEADED       可选  设为 1 时用有头模式运行（需要滑块拼图验证时必须开）
 *   SZU_PROFILE      可选  浏览器持久化目录，默认 ./browser-profile
 *
 * 运行：
 *   export SZU_STUDENT_ID='你的学号'
 *   export SZU_PASSWORD='你的密码'
 *   node examples/fetch-timetable.mjs
 *
 * 首次运行（或设备信任失效）会触发二次验证，终端按提示输入验证码即可。
 * skipTmpReAuth=true 会「信任此设备」，之后由持久化 profile 保持长期免验证。
 */

import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const STUDENT_ID = process.env.SZU_STUDENT_ID;
const PASSWORD = process.env.SZU_PASSWORD;
const MFA_CHANNEL = process.env.SZU_MFA_CHANNEL || '4';
const HEADED = process.env.SZU_HEADED === '1';
const PROFILE =
  process.env.SZU_PROFILE ||
  new URL('../browser-profile/', pathToFileURL(import.meta.url)).pathname;

const ENTRY =
  'https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb';
const AUTH = 'https://authserver.szu.edu.cn/authserver';

// 二次验证渠道表：reAuthType → authCodeTypeName（见文档 2.4）
const CHANNELS = {
  '3': { name: '短信验证码', authCodeTypeName: 'reAuthDynamicCodeType', hasMobile: true },
  '4': { name: '企业微信验证码', authCodeTypeName: 'reAuthWChatDynamicCodeType', hasMobile: false },
  '5': { name: '今日校园验证码', authCodeTypeName: 'reAuthCpdailyDynamicCodeType', hasMobile: false },
  '11': { name: '邮箱验证码', authCodeTypeName: 'reAuthEmailDynamicCodeType', hasMobile: false },
  '12': { name: '钉钉验证码', authCodeTypeName: 'reAuthDingTalkDynamicCodeType', hasMobile: false },
  '13': { name: 'WeLink验证码', authCodeTypeName: 'reAuthWeLinkDynamicCodeType', hasMobile: false },
};
const CHANNEL = CHANNELS[MFA_CHANNEL];

if (!STUDENT_ID || !PASSWORD) {
  console.error('请先设置环境变量 SZU_STUDENT_ID 和 SZU_PASSWORD');
  process.exit(1);
}
if (!CHANNEL) {
  console.error(`SZU_MFA_CHANNEL=${MFA_CHANNEL} 不支持，可选：${Object.keys(CHANNELS).join(' / ')}`);
  process.exit(1);
}

// 密码加密（文档 2.2）：64 位随机串 + 密码，AES-128-CBC，IV 为 16 位随机串
const CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const rnd = (n) =>
  Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const encryptPassword = (pwd, salt) => {
  if (!salt) return pwd; // 登录页未返回盐时明文提交
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(salt), Buffer.from(rnd(16)));
  return Buffer.concat([
    cipher.update(Buffer.from(rnd(64) + pwd)),
    cipher.final(),
  ]).toString('base64');
};

const log = (s) => console.log(s);

/**
 * 检测是否需要滑块拼图验证码（文档 2.6）
 * 返回 true 表示需要，调用方应改用有头模式让用户手动滑
 */
async function needCaptcha(page) {
  const r = await page
    .evaluate(async (sid) => {
      const res = await fetch(
        `/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(sid)}&_=${Date.now()}`,
      );
      return res.text();
    }, STUDENT_ID)
    .catch(() => '');
  try {
    return JSON.parse(r)?.isNeed === true;
  } catch {
    return false;
  }
}

/**
 * 判断页面是否被卡在滑块验证上
 */
async function stuckOnCaptcha(page) {
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
  return /请完成安全验证|向右滑动填充拼图|滑动验证/.test(txt);
}

/**
 * MFA 二次验证（文档 2.4）。
 * 注意：三个接口在前端本来就是 XHR，所以在页面里用 fetch 调用是正确姿势；
 * 但登录（/login）必须走表单导航，用 fetch 会被服务端返回 401。
 */
async function handleMfa(page, rl) {
  const reAuthParams = await page.evaluate(() => window.reAuthParams);
  const service = reAuthParams?.service;
  if (!service) throw new Error('未能从 reAuthCheck 页面提取 window.reAuthParams.service');

  log(`\n[ MFA ] 已触发二次验证`);
  log(`[ MFA ] 页面默认渠道 reAuthType=${reAuthParams?.reAuthType ?? '(未知)'}`);
  log(`[ MFA ] 本次使用渠道 reAuthType=${MFA_CHANNEL}（${CHANNEL.name}）`);

  // 第 1 步：切换验证渠道
  await page.evaluate(
    async ({ service, reAuthType }) => {
      await fetch('/authserver/reAuthCheck/changeReAuthType.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ isMultifactor: 'true', reAuthType, service }),
      });
    },
    { service, reAuthType: MFA_CHANNEL },
  );

  // 第 2 步：发送验证码
  const sent = await page.evaluate(
    async ({ userName, authCodeTypeName }) => {
      const r = await fetch('/authserver/dynamicCode/getDynamicCodeByReauth.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ userName, authCodeTypeName }),
      });
      return r.json();
    },
    { userName: STUDENT_ID, authCodeTypeName: CHANNEL.authCodeTypeName },
  );

  if (sent?.res === 'code_time_fail') {
    throw new Error(`发送过于频繁：${sent.returnMessage}。请稍后重试，不要连续重发。`);
  }
  if (!sent || (sent.res !== 'success' && sent.res !== 'other_success')) {
    throw new Error(`验证码发送失败：${JSON.stringify(sent)}`);
  }

  // 短信渠道会返回脱敏手机号，企业微信等渠道没有 mobile 字段
  log(`[ MFA ] ${CHANNEL.name}已发送${sent.mobile ? `至 ${sent.mobile}` : ''}`);
  log(`[ MFA ] 有效时间 ${sent.codeTime ?? 120} 秒，超时请重新运行（不要连续重发，会触发风控）`);

  // 第 3 步：提交验证码 + 信任此设备
  const dynamicCode = (await rl.question('[ MFA ] 请输入收到的验证码: ')).trim();
  const result = await page.evaluate(
    async ({ service, reAuthType, dynamicCode }) => {
      const r = await fetch('/authserver/reAuthCheck/reAuthSubmit.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          service,
          reAuthType,
          isMultifactor: 'true',
          password: '',
          dynamicCode,
          uuid: '',
          answer1: '',
          answer2: '',
          otpCode: '',
          skipTmpReAuth: 'true', // 信任此设备，之后免 MFA
        }),
      });
      return r.json();
    },
    { service, reAuthType: MFA_CHANNEL, dynamicCode },
  );

  if (result?.code === 'reAuth_failed' || result?.code === 'reAuth_unauthorized') {
    throw new Error(`MFA 验证失败：${result.msg ?? JSON.stringify(result)}（验证码可能错误或已过期）`);
  }
  if (result?.code !== 'reAuth_success') {
    throw new Error(`MFA 返回异常：${JSON.stringify(result)}`);
  }
  log('[ MFA ] 验证成功，已信任此设备。');

  // 第 4 步：官方做法 —— 成功后 GET /login?service=... 取 ticket
  // （reAuth.js 里就是 window.location.href = contextPath + "/login?service=" + encodeURIComponent(service)）
  await page.goto(`${AUTH}/login?service=${encodeURIComponent(service)}`, {
    waitUntil: 'domcontentloaded',
  });
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // 捕获 ticket，便于判断「设备信任是否生效」
  let sawTicket = false;
  // 捕获页面自动调用的排课接口
  const captured = {};
  page.on('response', async (response) => {
    const loc = response.headers()['location'] || '';
    if (/ticket=ST-/.test(loc)) sawTicket = true;
    const name = response.url().split('/').pop()?.split('?')[0];
    if (name === 'xspkjgcx.do') {
      try {
        captured.timetable = await response.json();
      } catch {
        /* 忽略非 JSON 响应 */
      }
    }
  });

  try {
    // 1. 进应用，未登录会被弹到 CAS 登录页
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });

    // 2. 需要登录则填写表单并提交
    if (page.url().includes('authserver.szu.edu.cn/authserver/login')) {
      // 先查是否需要滑块拼图（频繁登录会触发，见文档 2.6）
      if (await needCaptcha(page)) {
        log('\n[!] 服务端要求滑块拼图验证（checkNeedCaptcha isNeed=true）');
        if (!HEADED) {
          throw new Error(
            '无头模式无法完成滑块。请改用有头模式重跑：SZU_HEADED=1 node examples/fetch-timetable.mjs\n' +
              '（滑块只需完成一次；频繁失败重试会让这个状态持续更久）',
          );
        }
        log('[!] 请在弹出的浏览器窗口中手动完成滑块，完成后脚本会自动继续…');
        await page.waitForFunction(
          () => !/请完成安全验证|向右滑动填充拼图/.test(document.body.innerText),
          { timeout: 120000 },
        );
      }

      const salt = await page.locator('#pwdEncryptSalt').inputValue().catch(() => '');
      await page.locator('input#username:visible').first().fill(STUDENT_ID);
      await page.locator('input#password:visible').first().fill(encryptPassword(PASSWORD, salt));
      await page.locator('a#login_submit:visible').first().click();

      // 提交后可能被滑块挡回登录页
      await page.waitForTimeout(2000);
      if (await stuckOnCaptcha(page)) {
        throw new Error(
          '登录被滑块拼图挡住。请改用有头模式重跑：SZU_HEADED=1 node examples/fetch-timetable.mjs\n' +
            '若持续出现，说明该账号近期失败次数过多，请隔一段时间再用常用网络手动登录一次。',
        );
      }

      try {
        // 异地 IP / 新设备：等待跳转到 MFA 页面
        await page.waitForURL('**/reAuthCheck**', { timeout: 15000 });
        await handleMfa(page, rl);
      } catch (err) {
        if (err.message?.startsWith('MFA') || err.message?.startsWith('登录被滑块')) throw err;
        // 未触发 MFA：说明设备信任已生效，页面会自动回到应用
        if (sawTicket) log('[ OK ] 设备信任已生效，未触发二次验证，直接出 ticket。');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    } else {
      log('[ OK ] 已处于登录状态，无需重新认证。');
    }

    // 3. SPA hash 路由同 URL 重复 goto 不会重载，先跳 about:blank 再强制导航
    await page.goto('about:blank');
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60 && !captured.timetable; i++) {
      await page.waitForTimeout(500);
    }

    // 4. 输出课表
    const rows = captured.timetable?.datas?.xspkjgcx?.rows ?? [];
    if (!rows.length) throw new Error('未捕获到 xspkjgcx.do 响应，请检查网络或登录状态');

    const hhmm = (v) =>
      `${String(Math.floor(v / 100)).padStart(2, '0')}:${String(v % 100).padStart(2, '0')}`;

    console.log(`共 ${rows.length} 条排课记录`);
    for (const r of rows) {
      console.log(
        `周${r.XQ} ${hhmm(r.KSSJ)}-${hhmm(r.JSSJ)} ${r.KCMC} @${r.JASMC} (${r.JSXM}) ${r.ZCMC}`,
      );
    }
  } finally {
    rl.close();
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
