/**
 * 深圳大学研究生课表 —— 最小可用实现（路线 B：Playwright 持久化浏览器）
 *
 * 配套文档：../docs/szu-grad-timetable-api.md
 *   - 密码 AES-128-CBC 加密：见文档 2.2
 *   - MFA 短信验证三个接口：见文档 2.4
 *   - xspkjgcx.do 字段说明：见文档 3.3
 *
 * 运行：
 *   export SZU_STUDENT_ID='你的学号'
 *   export SZU_PASSWORD='你的密码'
 *   node examples/fetch-timetable.mjs
 *
 * 云服务器 / 校外 IP 首次运行会触发短信 MFA，终端按提示输入验证码即可；
 * skipTmpReAuth=true 会信任此设备，之后由持久化 profile 保持长期免验证。
 */

import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const STUDENT_ID = process.env.SZU_STUDENT_ID;
const PASSWORD = process.env.SZU_PASSWORD;

// 持久化 profile：保存浏览器指纹与设备信任，勿删、勿提交到仓库
const PROFILE = new URL('../browser-profile/', import.meta.url).pathname;
const ENTRY =
  'https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb';

if (!STUDENT_ID || !PASSWORD) {
  console.error('请先设置环境变量 SZU_STUDENT_ID 和 SZU_PASSWORD');
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

// MFA 短信验证（文档 2.4），仅在被重定向到 reAuthCheck 时调用
async function handleMfa(page, rl) {
  const reAuthParams = await page.evaluate(() => window.reAuthParams);
  const service = reAuthParams?.service;
  if (!service) throw new Error('未能从 reAuthCheck 页面提取 window.reAuthParams.service');

  // 第 1 步：切换到短信验证方式（reAuthType=3）
  await page.evaluate(
    async (service) => {
      await fetch('/authserver/reAuthCheck/changeReAuthType.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ isMultifactor: 'true', reAuthType: '3', service }),
      });
    },
    service,
  );

  // 第 2 步：发送短信验证码
  const sms = await page.evaluate(
    async (userName) => {
      const r = await fetch('/authserver/dynamicCode/getDynamicCodeByReauth.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ userName, authCodeTypeName: 'reAuthDynamicCodeType' }),
      });
      return r.json();
    },
    STUDENT_ID,
  );
  console.log(`短信已发送至 ${sms.mobile ?? '(号码已脱敏)'}，验证码约 5 分钟有效。`);

  // 第 3 步：提交验证码 + 信任此设备
  const dynamicCode = (await rl.question('请输入收到的 6 位短信验证码: ')).trim();
  const result = await page.evaluate(
    async ({ service, dynamicCode }) => {
      const r = await fetch('/authserver/reAuthSubmit.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          service,
          reAuthType: '3',
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
    { service, dynamicCode },
  );

  if (result.code !== 'reAuth_success') {
    throw new Error(`MFA 验证失败: ${JSON.stringify(result)}`);
  }
  console.log('MFA 验证成功，已信任此设备。');
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // 提前注册响应监听，捕获页面自动调用的排课接口
  const captured = {};
  page.on('response', async (response) => {
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
      const salt = await page.locator('#pwdEncryptSalt').inputValue().catch(() => '');
      await page.locator('input#username:visible').first().fill(STUDENT_ID);
      await page.locator('input#password:visible').first().fill(encryptPassword(PASSWORD, salt));
      await page.locator('a#login_submit:visible').first().click();

      try {
        // 异地 IP：等待跳转到 MFA 页面
        await page.waitForURL('**/reAuthCheck**', { timeout: 15000 });
        await handleMfa(page, rl);
        // 第 4 步：重新走应用入口拿 ticket
        await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        if (err.message?.startsWith('MFA')) throw err;
        // 未触发 MFA：页面已自动回到应用，等待加载完成即可
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
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
