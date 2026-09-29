# 深圳大学研究生课表抓取指南

> 适用系统：深圳大学研究生「我的课表应用」（金智 ehall `gsapp/sys/wdkbapp`）
> 适用身份：深大在读研究生（本科生请参考 [szu-cli](https://github.com/AwesomeHou/szu-cli) 的 `jwapp/sys/wdkb`，两者接口不同）
> 验证日期：2026-09-29，接口均为实测可用

---

## 一、总览：两条实现路线

| 路线 | 工具 | 适用场景 | 短信验证频率 |
|------|------|----------|--------------|
| A. 纯 HTTP | requests / axios / curl | 本机 IP 在校园网内（不触发异地风控） | 从不触发 |
| B. Playwright 持久化浏览器（**推荐**） | Node.js + playwright | 云服务器 / 校外 IP | **仅首次一次**，之后设备信任长期免验证 |

> ⚠️ 关键坑：深大对**云服务器 IP**（腾讯云/阿里云等）触发「非常用地点登录」强制 MFA 短信验证。
> 且"信任此设备"依赖浏览器指纹 Cookie（`happyVoyage`，由 JS 实时计算），**纯 HTTP 无法复现**，
> 所以校外/云服务器场景必须走路线 B。

---

## 二、认证流程（金智 CAS）

### 2.1 入口地址

```
认证服务：https://authserver.szu.edu.cn/authserver/login
（旧域名 sso.szu.edu.cn 已下线，勿用）
```

### 2.2 密码加密算法（AES-128-CBC）

登录前先 GET 登录页，从 HTML 提取两个隐藏字段：
- `pwdEncryptSalt`：16 字符加密盐（AES 密钥）
- `execution`：一次性表单令牌（每次会话都变）

加密规则：**明文 = 64 位随机字符串 + 密码**，密钥 = `pwdEncryptSalt`，IV = 16 位随机字符串，PKCS7 填充，输出 Base64。

随机字符串字符集：`ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678`

Node.js 实现（零依赖，`node:crypto` 即可）：

```js
import crypto from 'node:crypto';

const CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const randomString = (n) =>
  Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

export function encryptPassword(password, salt) {
  if (!salt) return password; // 登录页可能不返回盐（未开加密），此时明文提交
  const key = Buffer.from(salt, 'utf8');                 // 16 字节 → AES-128
  const iv  = Buffer.from(randomString(16), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const data = Buffer.from(randomString(64) + password, 'utf8');
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
}
```

提取隐藏字段（正则）：

```js
const salt     = html.match(/id="pwdEncryptSalt"\s+value="([^"]+)"/)?.[1] ?? '';
const execution = html.match(/id="execution"\s+name="execution"\s+value="([^"]+)"/)?.[1] ?? '';
```

### 2.3 提交登录

```
POST https://authserver.szu.edu.cn/authserver/login?service=<回调地址>
Content-Type: application/x-www-form-urlencoded

username=<学号>
&password=<encryptPassword 结果>
&captca=
&_eventId=submit
&cllt=userNameLogin
&dllt=generalLogin
&lt=
&execution=<登录页提取的一次性令牌>
```

- 成功：`302` 重定向到 `service?ticket=ST-xxxxx`，携带 Cookie `CASTGC`（全局票据）——**保存整个 Cookie Jar，后续复用**
- 失败：`200` 返回登录页 HTML（用户名或密码错误）
- 需 MFA：`302` 重定向到 `https://authserver.szu.edu.cn/authserver/reAuthCheck?...`

### 2.4 MFA 短信验证（仅云服务器/异地 IP 首次触发）

被重定向到 reAuthCheck 页面后，页面源码里有 `window.reAuthParams = {...}`，提取 `service` 和 `reAuthUserId`。

**第 1 步：切换到短信验证方式**（默认可能是企业微信扫码，`reAuthType=3` 是短信）

```
POST https://authserver.szu.edu.cn/authserver/reAuthCheck/changeReAuthType.do

isMultifactor=true&reAuthType=3&service=<reAuthParams.service>
```

**第 2 步：发送短信验证码**

```
POST https://authserver.szu.edu.cn/authserver/dynamicCode/getDynamicCodeByReauth.do

userName=<学号>&authCodeTypeName=reAuthDynamicCodeType
```

返回 `{"res":"success","mobile":"176****6053","returnMessage":"We have sent a dynamic code to your mobile phone","codeTime":...}`。
验证码 **约 5 分钟有效**，收到手机短信后进入第 3 步。

**第 3 步：提交验证码 + 信任此设备**

```
POST https://authserver.szu.edu.cn/authserver/reAuthSubmit.do

service=<service>
&reAuthType=3
&isMultifactor=true
&password=
&dynamicCode=<6位短信验证码>
&uuid=
&answer1=
&answer2=
&otpCode=
&skipTmpReAuth=true        ← 关键：信任此设备，之后免 MFA
```

返回 `{"msg":"auth success","code":"reAuth_success"}` 即成功。

**第 4 步：重新提交登录**（回到 2.3 流程拿 ticket）

### 2.5 设备信任的持久化（重要）

`skipTmpReAuth=true` 的信任记录绑定**浏览器指纹 Cookie**（`happyVoyage`，登录页 JS 计算），与 IP、User-Agent 均有关。要长期免验证：

- **Playwright 持久化上下文**：`chromium.launchPersistentContext('<profile目录>')`，指纹 Cookie 会随 profile 保存，之后每次密码登录直接成功，不再触发 MFA（已实测）
- 纯 HTTP 模式下 `happyVoyage` 无法稳定复现 → 每次都要走 MFA，这就是推荐路线 B 的原因
- 信任有效期实测数月级别；失效后重新走一遍 2.4 即可

---

## 三、课表数据接口（认证完成后）

### 3.1 应用入口

```
https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb
```

先 GET 此地址（未登录会 302 到 CAS，走完 2.x 认证后带 ticket 跳回），建立 `gsapp` 应用会话。之后即可直接调用数据接口。

### 3.2 数据接口清单

基础路径均为 `https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/`

| 接口 | 方法 | 请求参数 | 用途 |
|------|------|----------|------|
| `modules/xskcb/kfdxnxqcx.do` | POST | 无 body | 学年学期列表（含 XNXQDM 代码） |
| `wdkcb/initXsxx.do` | GET | `XH=`（可空） | 学生信息（学号/姓名/学院） |
| `modules/xskcb/xsskjccx.do` | POST | `XNXQDM=20261&XH=<学号>` | 节次时间方案（第N节几点上课） |
| `modules/xskcb/xspkjgcx.do` | POST | `XNXQDM=20261&XH=` | **排课结果（核心课表数据）★** |
| `modules/xskcb/xsjxrwcx.do` | POST | `XNXQDM=20261&XH=&pageNumber=1&pageSize=20` | 教学任务（选课信息） |
| `modules/xskcb/xswsckbkc.do` | POST | `XNXQDM=20261&XH=<学号>` | 未收录课表课程（无固定时间） |
| `wdkcb/getXsTtbkList.do` | POST | `XNXQDM=20261&XH=<学号>` | 退补课记录 |

> `XNXQDM` 学期代码规则：**学年 + 学期序号**，`20261` = 2026-2027 学年第一学期，`20252` = 2025-2026 学年第二学期。
> `XH` 部分接口可传空（服务端从会话取），稳妥起见都传学号。
> 响应头需带 `X-Requested-With: XMLHttpRequest`（XHR 标识）。

### 3.3 xspkjgcx.do 核心字段（排课结果）

响应结构：`{ "code": "0", "datas": { "xspkjgcx": { "totalSize": 21, "rows": [...] } } }`

每条 row 是**一节课**（一门课占多条），有效字段：

| 字段 | 含义 | 示例 |
|------|------|------|
| `KCMC` | 课程名称 | `管理理论与实证` |
| `XQ` | 星期几（1=周一 … 7=周日） | `2` |
| `ZCMC` | 周次文本 | `3-10周` |
| `ZCBH` | **周次位图**（30位01串，第i位=1表示第i周有课） | `001111111100000000000000000000` |
| `KSJCDM` / `JSJCDM` | 起止节次号 | `5` / `5` |
| `KSSJ` / `JSSJ` | 起止时间，数字格式：前2位小时+后2位分钟 | `1145` = 11:45，`830` = 08:30 |
| `JASMC` | 教室名称 | `汇星楼1号教室` |
| `JSXM` | 授课教师（多人逗号分隔） | `SHEN JIE` |
| `XNXQDM` | 学期代码 | `20261` |
| `XS` | 学时 | `8` |

> 时间换算示例（`KSSJ=1145, JSSJ=1225` → 11:45-12:25）。也可以不换算，直接用 `xsskjccx.do` 返回的节次表。
> 周次判断**优先用 ZCBH 位图**（最精确，能表达单双周/不规则周），`ZCMC` 仅作展示。

### 3.4 响应示例（真实数据，已脱敏）

<details>
<summary><b>xspkjgcx.do（排课结果，点击展开）</b></summary>

```json
{
  "code": "0",
  "datas": {
    "xspkjgcx": {
      "totalSize": 21,
      "rows": [
        {
          "KCMC": "管理理论与实证",
          "XQ": 2,
          "ZCMC": "3-10周",
          "ZCBH": "001111111100000000000000000000",
          "KSJCDM": 5, "JSJCDM": 5,
          "KSSJ": 1145, "JSSJ": 1225,
          "JASMC": "汇星楼1号教室",
          "JSXM": "SHEN JIE",
          "XNXQDM": "20261",
          "XS": 8,
          "KCDM": "03072", "BJDM": "20261-02...", "JASDM": "01601010",
          "SFQZAP": 1, "CZSJ": "2026-07-07 00:00:00", "QZAPYY": null,
          "WID": "ddcad84c...", "CZR": "2022001128"
        }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>kfdxnxqcx.do（学期列表）</b></summary>

```json
{
  "code": "0",
  "datas": {
    "kfdxnxqcx": {
      "totalSize": 23,
      "rows": [
        { "XNXQDM": "20261", "XNXQDM_DISPLAY": "2026-2027学年 第一学期", "KBKFRQ": "2026-07-15 00:00:00", "WID": "20261" },
        { "XNXQDM": "20252", "XNXQDM_DISPLAY": "2025-2026学年 第二学期", "KBKFRQ": "2026-01-26 00:00:00", "WID": "20252" }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>xsskjccx.do（节次时间，研究生 14 节制）</b></summary>

```json
{
  "code": "0",
  "datas": {
    "xsskjccx": {
      "totalSize": 14,
      "rows": [
        { "DM": "1",  "MC": "第一节",  "KSSJ": 830,  "JSSJ": 910,  "JCFAMC": "深大标准节次" },
        { "DM": "2",  "MC": "第二节",  "KSSJ": 915,  "JSSJ": 955,  "JCFAMC": "深大标准节次" },
        { "DM": "3",  "MC": "第三节",  "KSSJ": 1015, "JSSJ": 1055, "JCFAMC": "深大标准节次" }
      ]
    }
  }
}
```

</details>

<details>
<summary><b>initXsxx.do（学生信息）</b></summary>

```json
{ "data": [ { "XH": "2610XXXXXXX", "XM": "张三", "YXDM": "02003000", "YXDM_DISPLAY": "微众银行金融科技学院" } ] }
```

</details>

<details>
<summary><b>xswsckbkc.do（未收录课程）</b></summary>

```json
{
  "code": "0",
  "datas": {
    "xswsckbkc": {
      "totalSize": 1,
      "rows": [ { "KCMC": "卓越学者讲堂", "KCDM": "06683", "XNXQDM": "20261", "XH": "2610XXXXXXX" } ]
    }
  }
}
```

</details>

---

## 四、最小可用实现（Node.js + Playwright，路线 B）

> 完整可运行版本（凭据走环境变量、含 2.4 节 MFA 全流程交互处理）见 [`../examples/fetch-timetable.mjs`](../examples/fetch-timetable.mjs)。下面是精简版核心逻辑。

```js
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const STUDENT_ID = '你的学号';
const PASSWORD  = '你的密码';
const PROFILE   = './browser-profile';          // 持久化目录，保存设备信任，勿删
const ENTRY = 'https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb';

// 密码加密（见 2.2）
const CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const rnd = (n) => Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const encrypt = (pwd, salt) => {
  if (!salt) return pwd;
  const c = crypto.createCipheriv('aes-128-cbc',
    Buffer.from(salt), Buffer.from(rnd(16)));
  return Buffer.concat([c.update(Buffer.from(rnd(64) + pwd)), c.final()]).toString('base64');
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();

// 1. 进应用（未登录会自动弹到 CAS 登录页）
await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });

// 2. 登录（设备信任后不再触发 MFA；首次触发 MFA 见 2.4，此处略）
if (page.url().includes('authserver.szu.edu.cn/authserver/login')) {
  const salt = await page.locator('#pwdEncryptSalt').inputValue().catch(() => '');
  const execution = await page.locator('#execution').inputValue();
  await page.locator('input#username:visible').first().fill(STUDENT_ID);
  await page.locator('input#password:visible').first().fill(encrypt(PASSWORD, salt));
  await page.locator('a#login_submit:visible').first().click();
  await page.waitForLoadState('domcontentloaded');
  // 若跳到 reAuthCheck → 执行 2.4 的三个 MFA 接口（可在 page.evaluate 里 fetch）
}

// 3. 监听课表接口响应（页面会自动调用）
const api = {};
page.on('response', async (r) => {
  const name = r.url().split('/').pop()?.split('?')[0];
  if (name === 'xspkjgcx.do') {
    try { api['xspkjgcx.do'] = await r.json(); } catch {}
  }
});

// 4. 强制重新导航触发接口（SPA hash 路由，同 URL 重复 goto 不会重载！）
await page.goto('about:blank');
await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 40 && !api['xspkjgcx.do']; i++) await page.waitForTimeout(500);

// 5. 得到课表 JSON
const rows = api['xspkjgcx.do']?.datas?.xspkjgcx?.rows ?? [];
console.log(`共 ${rows.length} 条排课记录`);
for (const r of rows) {
  const hhmm = (v) => `${String(Math.floor(v / 100)).padStart(2, '0')}:${String(v % 100).padStart(2, '0')}`;
  console.log(`周${r.XQ} ${hhmm(r.KSSJ)}-${hhmm(r.JSSJ)} ${r.KCMC} @${r.JASMC} (${r.JSXM}) ${r.ZCMC}`);
}

await ctx.close();
```

输出示例：

```
共 21 条排课记录
周1 19:00-19:40 工程伦理 @汇星楼1号教室 (李俊杰,王为) 7-10周
周1 19:41-20:20 工程伦理 @汇星楼1号教室 (李俊杰,王为) 7-10周
周1 20:30-21:05 工程伦理 @汇星楼1号教室 (李俊杰,王为) 7-10周
周2 10:15-10:55 管理理论与实证 @汇星楼1号教室 (SHEN JIE) 3-10周
...
```

---

## 五、注意事项

1. **频率**：低频使用（每日 1 次量级），勿高频抓取。接口无验证码/频率限制，但请自觉。
2. **合规**：仅查询本人数据。勿传播 Cookie、勿替他人查询、勿用于商业用途。
3. **会话有效期**：CAS 的 `CASTGC` 与 gsapp 应用会话约数小时～数天过期，过期后重新走 2.3 密码登录即可（设备信任仍有效，无需再 MFA）。
4. **SPA 坑**：`#/xskcb` 是 hash 路由，同 URL 重复 `page.goto` 不会重新加载，需先 `goto('about:blank')` 强制导航。
5. **登录页坑**：页面存在重复 `id`（username/password 各两个），定位必须加 `:visible` 过滤；登录页语言可能是英文（"Unified identity authentication platform"），元素 id 不变。
6. **星号 URL**：入口 URL 里的 `*default` 是金智应用路由的合法部分，不是通配符，原样使用。
7. **XNXQDM 获取**：新学期开始后先调 `kfdxnxqcx.do` 拿最新学期代码，不要硬编码。

---

*本文档基于 2026-09-29 实测整理（Playwright Chromium + Node.js 22，Ubuntu 22.04）。*
