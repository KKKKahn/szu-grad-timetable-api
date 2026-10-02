# 深圳大学研究生课表抓取指南

> 适用系统：深圳大学研究生「我的课表应用」（金智 ehall `gsapp/sys/wdkbapp`）
> 适用身份：深大在读研究生（本科生接口不同，请参考 [szu-cli](https://github.com/AwesomeHou/szu-cli) 的 `jwapp/sys/wdkb`）
> 实测环境：Node.js 22 + Playwright Chromium，Ubuntu 22.04
> 本文档不含任何真实凭据 —— 学号、密码、手机号、票据、设备指纹均已替换为占位符

---

## 一、总览：两条实现路线

| 路线 | 工具 | 适用场景 | 结论 |
|------|------|----------|------|
| A. 纯 HTTP | requests / axios / OkHttp / curl | 仅校园网内且已建立设备信任 | **不推荐用于首次登录** |
| B. Playwright 持久化浏览器（**推荐**） | Node.js + playwright | 任何网络环境 | 首次一次验证，之后长期免验证 |

> ⚠️ 最关键的一条结论：深大的「设备信任」依赖一个由服务端下发的 Cookie
> `MULTIFACTOR_BROWSER_FINGERPRINT`（32 位），而这个 Cookie **只有在真实浏览器环境下才会下发**。
> 纯 HTTP 客户端拿不到它，于是会陷入"验证码验证成功、却永远拿不到 ticket"的死循环。
> 详细实验过程见 [2.7 节](#27-为什么纯-http-首次登录一定走不通四层排除实验)。

所以：**首次建立信任用路线 B（浏览器），拿到信任之后可以用路线 A（纯 HTTP）静默复用。**

---

## 二、认证流程（金智 CAS）

### 2.1 入口地址

```
认证服务：https://authserver.szu.edu.cn/authserver/login
（旧域名 sso.szu.edu.cn 已下线，勿用）
```

登录页必须取两个隐藏字段：`pwdEncryptSalt`（16 字符加密盐）、`execution`（一次性表单令牌）。

```js
const salt      = html.match(/id="pwdEncryptSalt"\s+value="([^"]+)"/)?.[1] ?? '';
const execution = html.match(/name="execution"\s+value="([^"]+)"/)?.[1] ?? '';
```

### 2.2 密码加密算法（AES-128-CBC）

规则：**明文 = 64 位随机字符串 + 密码**，密钥 = `pwdEncryptSalt`，IV = 16 位随机字符串，PKCS7 填充，输出 Base64。

随机串字符集：`ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678`

```js
import crypto from 'node:crypto';

const CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
const randomString = (n) =>
  Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

export function encryptPassword(password, salt) {
  if (!salt) return password; // 登录页未返回盐时明文提交
  const key    = Buffer.from(salt, 'utf8');
  const iv     = Buffer.from(randomString(16), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const data   = Buffer.from(randomString(64) + password, 'utf8');
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
}
```

> 表单里密码框的 `name` 是 **`passwordText`**，真正提交的是隐藏域 `name="password"`。
> 最简单可靠的做法：把**明文**填进 `#password`，然后点提交按钮，让页面自己的 JS 去加密 —— 不要自己填密文，容易填错字段。

### 2.3 提交登录

```
POST https://authserver.szu.edu.cn/authserver/login?service=<回调地址>
Content-Type: application/x-www-form-urlencoded

username=<学号>
&password=<encryptPassword 结果>
&captcha=                      ← 注意拼写是 captcha（图形验证码，通常留空）
&_eventId=submit
&cllt=userNameLogin
&dllt=generalLogin
&lt=
&execution=<登录页提取的一次性令牌>
```

三种结果：

| 结果 | 表现 |
|------|------|
| 成功 | `302` 到 `service?ticket=ST-xxxxx`，同时下发 `CASTGC`（TGT 票据） |
| 需二次验证 | `302` 到 `reAuthCheck/reAuthLoginView.do?isMultifactor=true&service=...` |
| 失败 | `200` 回登录页（密码错 / 需要滑块 / 账号异常） |

**登录后先看有没有被滑块挡住**（见 2.6），这是最常见的"登录没反应"原因。

### 2.4 二次验证 MFA（异地 IP / 新设备首次必现）

进入 `reAuthLoginView.do` 后，页面里有 `window.reAuthParams`，取其中的 `service`（其余字段可用于诊断）。

#### 渠道映射表（重点）

所有渠道**共用同一个发码接口**，区别只在 `reAuthType` 和 `authCodeTypeName`：

| reAuthType | authCodeTypeName | 渠道 | 发码返回里的 `mobile` |
|---|---|---|---|
| 3 | `reAuthDynamicCodeType` | 短信验证码 | 有（脱敏手机号） |
| **4** | **`reAuthWChatDynamicCodeType`** | **企业微信验证码** | **无** |
| 5 | `reAuthCpdailyDynamicCodeType` | 今日校园 | 无 |
| 11 | `reAuthEmailDynamicCodeType` | 邮箱 | 无 |
| 12 | `reAuthDingTalkDynamicCodeType` | 钉钉 | 无 |
| 13 | `reAuthWeLinkDynamicCodeType` | WeLink | 无 |
| 15 | `reAuthWeChatServiceDynamicCodeType` | 微信服务号 | 无 |

> 实测：多数账号页面默认就是 **reAuthType=4（企业微信验证码）**。
> 它**不是扫码**，是收一串数字验证码，和短信的用法完全一样。
> 短信被风控收不到时，改用企业微信渠道往往能正常收到。

#### 第 1 步：切换渠道

```http
POST https://authserver.szu.edu.cn/authserver/reAuthCheck/changeReAuthType.do
Content-Type: application/x-www-form-urlencoded

isMultifactor=true&reAuthType=4&service=<reAuthParams.service>
```

#### 第 2 步：发送验证码

```http
POST https://authserver.szu.edu.cn/authserver/dynamicCode/getDynamicCodeByReauth.do
Content-Type: application/x-www-form-urlencoded

userName=<学号>&authCodeTypeName=reAuthWChatDynamicCodeType
```

返回示例：

```json
// 企业微信渠道（reAuthType=4）—— 注意没有 mobile 字段
{"res":"other_success","returnMessage":"验证码已发送成功","codeTime":120}

// 短信渠道（reAuthType=3）—— 带脱敏手机号
{"res":"success","mobile":"176****0000","returnMessage":"...","codeTime":120}
```

**验证码有效期是 `codeTime` 秒（实测 120 秒），不是 5 分钟。** 过期只能重发。
重发有冷却（约 44 秒），频繁重发会返回：

```json
{"res":"code_time_fail","returnMessage":"您已重复发送，请44秒后再试"}
```

#### 第 3 步：提交验证码 + 信任此设备

```http
POST https://authserver.szu.edu.cn/authserver/reAuthCheck/reAuthSubmit.do
Content-Type: application/x-www-form-urlencoded

service=<service>
&reAuthType=4
&isMultifactor=true
&password=
&dynamicCode=<收到的验证码>
&uuid=
&answer1=
&answer2=
&otpCode=
&skipTmpReAuth=true          ← 关键：信任此设备，之后免 MFA
```

> ⚠️ **路径坑**：完整路径是 `/authserver/reAuthCheck/reAuthSubmit.do`，
> 少写 `reAuthCheck/` 这一段会拿不到正确响应。

返回：

```json
{"msg":"认证成功","code":"reAuth_success"}
```

可能的失败码：`reAuth_failed`（验证码错/过期）、`reAuth_unauthorized`。

`skipTmpReAuth` 两个取值：`true` = 信任此设备（长期免验证）；`false` = 仅本次登录。

#### 第 4 步：官方下一步就是 GET /login

前端 `reAuth.js` 里写得清清楚楚，成功后**没有别的接口**，只有一次跳转：

```js
// reAuthSubmit.do 成功回调
window.location.href = contextPath + "/login?service=" + encodeURIComponent(reAuthParams.service);
```

所以验证成功后请求：

```http
GET https://authserver.szu.edu.cn/authserver/login?service=<service>
→ 302 → <service>&ticket=ST-xxxxx     ← ticket 在这里
```

> 如果这一步又被 302 回 `reAuthLoginView.do`，说明设备信任没建成
> —— 通常是客户端不是真实浏览器（见 2.7）。

#### 关于「可信设备弹窗」

当 `window.reAuthParams.isSleepAccount === '0'` 时，页面会弹一个「可信浏览器提示」：

- 点 **信任此设备** → `skipTmpReAuth = true`
- 点 **仅本次登录** → `skipTmpReAuth = false`

自动化脚本（用 fetch 直接调接口）不会触发弹窗，直接传 `skipTmpReAuth=true` 即可。

### 2.5 设备信任到底是怎么存的

**关键 Cookie：`MULTIFACTOR_BROWSER_FINGERPRINT`（32 位）**

实测结论：

| 现象 | 结论 |
|---|---|
| 全新浏览器首次访问，服务端就下发该 Cookie | 它是**服务端生成**的，不是客户端 JS 算的 |
| 手动删掉它再请求，服务端下发**一模一样的值** | 是确定性的，绑定"账号 + 客户端特征" |
| 换一个 User-Agent，拿到的值就不同 | 与 UA 强相关 ⇒ **App 的 UA 必须固定** |
| 只带这个 Cookie（不带 CASTGC）走纯 HTTP | portal、gsapp 两个 service 都**免 MFA 直出 ticket** |
| 不带它走纯 HTTP | 100% 触发二次验证 |

**所以：内置任何人的指纹值都没有意义**，换了客户端就失效。正确做法是——
用真实浏览器完整走一次 MFA（`skipTmpReAuth=true`），然后把服务端下发的这个 Cookie 持久化下来复用。

持久化方式：

- Node/Playwright：`chromium.launchPersistentContext('<profile目录>')`，Cookie 随 profile 落盘
- 原生 App：从 `CookieManager.getCookie("https://authserver.szu.edu.cn")` 取出后自己存

> 顺带纠正一个流传较广的说法：很多人以为信任绑定的是 `happyVoyage`。
> 实测 `happyVoyage` 只是风控 Cookie（每次响应都会重新下发，172 位），
> **它不承载设备信任**，真正管用的是 `MULTIFACTOR_BROWSER_FINGERPRINT`。

### 2.6 滑块拼图验证码（"输两遍密码"的真凶）

提交密码后如果**停在登录页没反应**，八成是被滑块挡了：

```http
GET /authserver/checkNeedCaptcha.htl?username=<学号>&_=<时间戳>
→ {"isNeed": true}
```

页面文本会出现：**「请完成安全验证！ 向右滑动填充拼图」**

典型表现：用户提交 → 被挡回登录页 → 以为密码输错 → 再输一遍 → 又被挡回，无限循环。
**这不是密码错了，也不是 MFA。**

- 触发原因：短时间内失败/重试次数偏多、异地 IP、新设备
- 判断维度是**账号**（接口带 `username`），不是 IP
- 处理：用有头浏览器（`headless: false`）让用户手动滑一次，之后通常就恢复
- **绝对不要自动重试登录** —— 每失败一次，这个状态会持续更久

本项目脚本会主动检测它，并在无头模式下给出明确提示（见 `examples/fetch-timetable.mjs`）。

### 2.7 为什么纯 HTTP 首次登录一定走不通（四层排除实验）

为了确认"能不能不装浏览器内核"，逐层排除过：

| # | 实验 | 做法 | 拿到 `MULTIFACTOR_BROWSER_FINGERPRINT`？ |
|---|---|---|---|
| 1 | 基础纯 HTTP | Node fetch，常规头 | ❌ |
| 2 | 完整复制 Chrome 请求头 | `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` / `Upgrade-Insecure-Requests` / `Accept-Language` / 完整 `Accept` / `Cache-Control`，并补上浏览器的前置请求 `getLanguageTypes.htl`、`checkNeedCaptcha.htl` | ❌ |
| 3 | 伪造 TLS + HTTP/2 指纹 | `curl-impersonate`，依次 `chrome116` / `chrome110` / `chrome99_android` / `ff117` | ❌ 四种全败 |
| 4 | 真实 Chromium 内用 `fetch`（不走表单导航） | Playwright 页面内 `fetch(url, {method:'POST'})` | ❌ 且返回 **HTTP 401** |

第 4 个实验的信号最关键：**服务端能区分"浏览器导航请求"和"程序化请求"，后者直接 401。**

结论：既不是请求头的问题，也不是 TLS/JA3 指纹的问题，
只能是**浏览器运行时环境**这一层。因此：

- 首次建立信任 **必须** 用真实浏览器内核（Node 侧即 Playwright，Android 侧即 WebView）
- Cronet 之类"只提供 Chromium 网络栈"的库预计同样无效
- **但信任建立之后**，纯 HTTP 带上那个指纹 Cookie 就能正常工作（已实测两个 service 通过）

### 2.8 常见错误码速查

| 位置 | 返回 | 含义 / 处理 |
|---|---|---|
| 发码 | `code_time_fail` | 发送太频繁，等冷却（约 44 秒）后再试 |
| 发码 | `other_success` | 企业微信等渠道的正常成功（**不是错误**） |
| 提交码 | `reAuth_failed` | 验证码错误或过期 |
| 提交码 | `reAuth_unauthorized` | 会话失效，重走流程 |
| 提交码后 GET /login | 302 回 `reAuthLoginView` | 信任未建成（客户端不是真实浏览器 / 指纹 Cookie 丢了） |
| 页面内 fetch 登录 | `401` | 登录必须走表单导航，不能用 fetch |
| 登录页 | 「请完成安全验证」 | 滑块拼图，见 2.6 |

---

## 三、课表数据接口（认证完成后）

### 3.1 应用入口

```
https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb
```

先 GET 此地址（未登录会 302 到 CAS，走完 2.x 后带 ticket 跳回），建立 `gsapp` 应用会话。

### 3.2 数据接口清单

基础路径均为 `https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/`

| 接口 | 方法 | 请求参数 | 用途 |
|------|------|----------|------|
| `modules/xskcb/kfdxnxqcx.do` | POST | 无 body | 学年学期列表（含 XNXQDM 代码） |
| `wdkcb/initXsxx.do` | GET | `XH=`（可空） | 学生信息（学号/姓名/学院） |
| `modules/xskcb/xsskjccx.do` | POST | `XNXQDM=20261&XH=<学号>` | 节次时间方案 |
| `modules/xskcb/xspkjgcx.do` | POST | `XNXQDM=20261&XH=` | **排课结果（核心课表数据）★** |
| `modules/xskcb/xsjxrwcx.do` | POST | `XNXQDM=20261&XH=&pageNumber=1&pageSize=20` | 教学任务（选课信息） |
| `modules/xskcb/xswsckbkc.do` | POST | `XNXQDM=20261&XH=<学号>` | 未收录课表课程 |
| `wdkcb/getXsTtbkList.do` | POST | `XNXQDM=20261&XH=<学号>` | 退补课记录 |

> `XNXQDM` 规则：**学年 + 学期序号**，`20261` = 2026-2027 学年第一学期。
> `XH` 部分接口可传空（服务端从会话取），稳妥起见都传学号。
> 响应头需带 `X-Requested-With: XMLHttpRequest`。

### 3.3 xspkjgcx.do 核心字段

响应结构：`{ "code": "0", "datas": { "xspkjgcx": { "totalSize": N, "rows": [...] } } }`

| 字段 | 含义 | 示例 |
|------|------|------|
| `KCMC` | 课程名称 | `示例课程A` |
| `XQ` | 星期几（1=周一 … 7=周日） | `2` |
| `ZCMC` | 周次文本 | `3-10周` |
| `ZCBH` | **周次位图**（30位01串，第i位=1表示第i周有课） | `001111111100000000000000000000` |
| `KSJCDM` / `JSJCDM` | 起止节次号 | `5` / `5` |
| `KSSJ` / `JSSJ` | 起止时间：前2位小时+后2位分钟 | `1145` = 11:45，`830` = 08:30 |
| `JASMC` | 教室名称 | `示例楼101` |
| `JSXM` | 授课教师（多人逗号分隔） | `示例教师` |
| `XNXQDM` | 学期代码 | `20261` |
| `XS` | 学时 | `8` |

> 周次判断**优先用 `ZCBH` 位图**（能表达单双周/不规则周），`ZCMC` 仅作展示。
> 时间换算：`KSSJ=1145` → 11:45。也可直接用 `xsskjccx.do` 返回的节次表。

### 3.4 响应示例（已脱敏，人名/教室/课程均为占位）

完整样例见 [`../examples/szu-grad-timetable-api-samples.json`](../examples/szu-grad-timetable-api-samples.json)，摘录：

```json
{
  "code": "0",
  "datas": {
    "xspkjgcx": {
      "totalSize": 21,
      "rows": [
        {
          "KCMC": "示例课程A",
          "XQ": 2,
          "ZCMC": "3-10周",
          "ZCBH": "001111111100000000000000000000",
          "KSJCDM": 5, "JSJCDM": 5,
          "KSSJ": 1145, "JSSJ": 1225,
          "JASMC": "示例楼101",
          "JSXM": "示例教师",
          "XNXQDM": "20261",
          "XS": 8,
          "KCDM": "00000", "BJDM": "20261-00", "JASDM": "00000000",
          "SFQZAP": 1, "CZSJ": "2026-07-07 00:00:00", "QZAPYY": null,
          "WID": "<已脱敏>", "CZR": "<已脱敏>"
        }
      ]
    }
  }
}
```

---

## 四、最小可用实现

完整可运行版本见 [`../examples/fetch-timetable.mjs`](../examples/fetch-timetable.mjs)（凭据走环境变量、
含渠道选择、滑块检测、MFA 交互）。核心流程：

```js
import { chromium } from 'playwright';

const PROFILE = './browser-profile';   // 持久化目录，保存设备信任，勿删
const ENTRY   = 'https://ehall.szu.edu.cn/gsapp/sys/wdkbapp/*default/index.do?EMAP_LANG=zh&THEME=teal#/xskcb';

const ctx  = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = ctx.pages()[0] ?? await ctx.newPage();

// 1) 进应用（未登录会自动弹到 CAS）
await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });

if (page.url().includes('authserver.szu.edu.cn/authserver/login')) {
  // 2) 先查滑块：isNeed=true 就必须有头模式手动滑（见文档 2.6）
  // 3) 填明文密码到 #password，点 #login_submit，让页面 JS 自己加密
  // 4) 若跳到 reAuthCheck，执行 2.4 的三个接口（页面里 fetch 即可）
}

// 5) 监听课表接口（页面会自动调用）
const api = {};
page.on('response', async (r) => {
  if (r.url().split('/').pop()?.split('?')[0] === 'xspkjgcx.do') {
    try { api.timetable = await r.json(); } catch {}
  }
});

// 6) SPA hash 路由：同 URL 重复 goto 不会重载，先 about:blank 再导航
await page.goto('about:blank');
await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 60 && !api.timetable; i++) await page.waitForTimeout(500);

const rows = api.timetable?.datas?.xspkjgcx?.rows ?? [];
console.log(`共 ${rows.length} 条排课记录`);
await ctx.close();
```

---

## 五、踩坑清单（按踩到的概率排序）

1. **【最高频】滑块拼图挡登录** —— 表现为"登录没反应 / 要输两遍密码"。
   先查 `checkNeedCaptcha.htl`，`isNeed=true` 就用有头模式手动滑。**不要自动重试**。
2. **`reAuthSubmit.do` 路径漏了 `reAuthCheck/`** —— 正确是
   `/authserver/reAuthCheck/reAuthSubmit.do`。
3. **验证码有效期当成 5 分钟** —— 实际 `codeTime` 通常 120 秒，过期只能重发。
4. **以为企业微信是扫码** —— 它是**验证码**（`reAuthType=4`），和短信一样填数字。
   页面默认往往就是它。
5. **以为信任绑在 `happyVoyage` 上** —— 实际是 `MULTIFACTOR_BROWSER_FINGERPRINT`。
   `happyVoyage` 只是风控 Cookie，每次响应都会重新下发。
6. **用 fetch 提交登录** —— 会 401。登录必须走表单导航（页面 JS 加密 + 提交）。
   MFA 那三个接口本来就是 XHR，用 fetch 是对的。
7. **自己把密文填进密码框** —— 密码框 `name` 是 `passwordText`，提交的隐藏域才是 `password`。
   填明文、点按钮最稳。
8. **SPA hash 路由** —— `#/xskcb` 同 URL 重复 `goto` 不重载，需先 `goto('about:blank')`。
9. **登录页重复 id** —— `username`/`password` 各有两个（二维码登录表单也在页面上），
   Playwright 定位要加 `:visible`。
10. **连续重发验证码** —— 触发 `code_time_fail`，并且会加重账号风控，
    进而引出第 1 条的滑块。
11. **换 UA 会导致重新触发 MFA** —— 指纹与 UA 相关，自动化脚本请固定 UA。
12. **`*default` 不是通配符** —— 是金智应用路由的合法部分，原样保留。
13. **SPA 页面跳转后接口没触发** —— 需要强制重新导航，见第四节第 6 步。

---

## 六、复现检查清单

按顺序自查，能定位 90% 的问题：

- [ ] 登录页能取到 `pwdEncryptSalt`（16 位）和 `execution`
- [ ] `checkNeedCaptcha.htl` 返回 `{"isNeed": false}`（若为 true → 先处理滑块）
- [ ] 提交密码后 302 的 `Location` 是什么？
      - 含 `ticket=ST-` → 成功，设备信任已生效
      - 含 `reAuthLoginView` → 走 2.4 二次验证
      - 回到 `/login` → 密码错 or 被滑块挡
- [ ] 二次验证时，`reAuthType` 与 `authCodeTypeName` 是否匹配（见 2.4 渠道表）
- [ ] `reAuthSubmit.do` 返回 `reAuth_success`，且路径带 `reAuthCheck/`
- [ ] 之后 `GET /login?service=...` 的 302 里出现 `ticket=ST-`
- [ ] Cookie 里有 `MULTIFACTOR_BROWSER_FINGERPRINT`（32 位）→ 信任已建立，下次免验证
- [ ] profile 目录（或 App 本地存储）被保留，没有被每次删除

---

## 七、合规与频率

- 仅查询**本人**数据，勿替他人查询、勿传播 Cookie。
- 低频使用（每日 1 次量级），失败后**不要循环重试**。
- 接口可能随学校系统升级变化，请以实际系统为准。

---

*本文档内容均来自实机抓包与对照实验，所有个人信息已脱敏。*
