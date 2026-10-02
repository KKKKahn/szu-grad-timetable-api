# SZU 研究生课表 API 指南与最小实现

> 深圳大学研究生「我的课表应用」（金智 ehall `gsapp/sys/wdkbapp`）的接口逆向文档与可运行示例代码。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 这是什么

通过程序化方式登录深圳大学统一身份认证（金智 CAS），抓取研究生「我的课表」数据，拿到结构化的课程 JSON：课程名、星期、周次、时间、教室、教师等。

所有接口均为实机抓包实测，响应示例已脱敏，**不含任何真实凭据**。

- 适用身份：深大**在读研究生**
- 本科生接口不同，请参考 [szu-cli](https://github.com/AwesomeHou/szu-cli) 的 `jwapp/sys/wdkb`

## 一条最重要的结论

深大的「设备信任」依赖服务端下发的 Cookie `MULTIFACTOR_BROWSER_FINGERPRINT`（32 位），
而这个 Cookie **只有在真实浏览器环境下才会下发**。

纯 HTTP 客户端拿不到它，会陷入"验证码验证成功、却永远拿不到 ticket"的死循环。
实测排除过四层（完整请求头 / 伪造 TLS+HTTP2 指纹 / 四种浏览器指纹伪装 / 浏览器内 fetch），
全部失败，且浏览器内 fetch 直接返回 `401` —— 服务端能识别程序化请求。

所以：**首次建立信任用浏览器，拿到信任之后可以用纯 HTTP 静默复用。**

## 快速开始

```bash
git clone https://github.com/KKKKahn/szu-grad-timetable-api.git
cd szu-grad-timetable-api

cp .env.example .env   # 填入自己的学号和密码
npm install
npx playwright install chromium

npm run timetable
```

首次运行（或设备信任失效）会触发二次验证，终端按提示输入验证码即可。
验证时选择「信任此设备」，之后持久化 profile 会长期免验证。

运行时长提示：若卡在登录页没反应，先读文档的[「滑块拼图」一节](docs/szu-grad-timetable-api.md#26-滑块拼图验证码输两遍密码的真凶)。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SZU_STUDENT_ID` | ✅ | 学号 |
| `SZU_PASSWORD` | ✅ | 统一身份认证密码 |
| `SZU_MFA_CHANNEL` | ❌ | 二次验证渠道，默认 `4`。`4`=企业微信验证码，`3`=短信验证码，`11`=邮箱，`12`=钉钉，`5`=今日校园 |
| `SZU_HEADED` | ❌ | 设为 `1` 用有头模式。**遇到滑块拼图时必须开** |
| `SZU_PROFILE` | ❌ | 浏览器持久化目录，默认 `./browser-profile` |

> 短信被风控收不到时，把 `SZU_MFA_CHANNEL` 改成 `4`（企业微信验证码）通常能收到。
> 企业微信渠道**是验证码不是扫码**，用法与短信完全一致。

## 二次验证渠道一览

| reAuthType | `authCodeTypeName` | 渠道 |
|---|---|---|
| 3 | `reAuthDynamicCodeType` | 短信验证码 |
| **4** | **`reAuthWChatDynamicCodeType`** | **企业微信验证码**（多为页面默认） |
| 5 | `reAuthCpdailyDynamicCodeType` | 今日校园 |
| 11 | `reAuthEmailDynamicCodeType` | 邮箱 |
| 12 | `reAuthDingTalkDynamicCodeType` | 钉钉 |
| 13 | `reAuthWeLinkDynamicCodeType` | WeLink |

## 文档

完整逆向指南见 **[`docs/szu-grad-timetable-api.md`](docs/szu-grad-timetable-api.md)**：

1. **两条实现路线**与各自的适用边界
2. **认证全流程**：密码 AES-128-CBC 加密、登录表单、二次验证四步、设备信任机制
3. **二次验证渠道映射表**与常见错误码速查
4. **为什么纯 HTTP 首次登录一定走不通**（四层排除实验记录）
5. **滑块拼图验证码**的成因与处理
6. **接口清单**与核心字段说明（含 `ZCBH` 周次位图、`KSSJ` 时间格式）
7. **13 条踩坑清单**与**复现自查清单**
8. 脱敏响应示例

## 目录结构

```
├── README.md
├── LICENSE
├── package.json
├── .env.example                            # 环境变量模板
├── docs/
│   └── szu-grad-timetable-api.md           # 完整逆向指南
└── examples/
    ├── fetch-timetable.mjs                 # 可运行的最小实现（含 MFA 与滑块处理）
    └── szu-grad-timetable-api-samples.json # 脱敏响应样例
```

## 排错速查

| 症状 | 原因 / 处理 |
|---|---|
| 提交后停在登录页、要输两遍密码 | 滑块拼图。用 `SZU_HEADED=1` 重跑手动滑，见文档 2.6 |
| 验证码验证成功但没有 ticket | `reAuthSubmit.do` 路径漏了 `reAuthCheck/`，或客户端不是真实浏览器 |
| 验证码总是收不到 | 短信被风控，改用 `SZU_MFA_CHANNEL=4` 企业微信 |
| `code_time_fail` | 发码太频繁，等约 44 秒 |
| 第二次运行又要验证码 | profile 目录被删了，或 UA 变了（指纹与 UA 相关） |
| 页面内 fetch 登录返回 401 | 登录必须走表单导航，不能用 fetch |

## 合规与免责

- 仅供学习与个人使用，**仅可查询本人数据**，请勿替他人查询或传播 Cookie。
- 请**低频使用**，失败后不要循环重试，勿对学校服务器造成压力，勿用于商业用途。
- 因使用本项目产生的一切后果由使用者自行承担；接口若发生变化请以实际系统为准。

## 相关项目

- [szu-cli](https://github.com/AwesomeHou/szu-cli) — 深圳大学本科生接口的命令行工具

## License

[MIT](LICENSE)
