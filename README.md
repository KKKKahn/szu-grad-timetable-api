# SZU 研究生课表 API 指南与最小实现

> 深圳大学研究生「我的课表应用」（金智 ehall `gsapp/sys/wdkbapp`）的接口逆向文档与可运行示例代码。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 这是什么

通过程序化方式登录深圳大学统一身份认证（金智 CAS），抓取研究生「我的课表」数据，拿到结构化的课程 JSON：课程名、星期、周次、时间、教室、教师等。

所有接口均为 **2026-09-29 实时抓包实测**，不是抄旧文档；响应示例已脱敏。

- 适用身份：深大**在读研究生**
- 本科生系统接口不同，请参考 [szu-cli](https://github.com/AwesomeHou/szu-cli) 的 `jwapp/sys/wdkb`

## 文档

完整逆向指南见 **[`docs/szu-grad-timetable-api.md`](docs/szu-grad-timetable-api.md)**，包含：

1. **两条实现路线**：纯 HTTP（校园网 IP）vs Playwright 持久化浏览器（云服务器 IP，推荐）
2. **认证全流程**：密码 AES-128-CBC 加密、登录表单字段、MFA 短信验证三个接口、设备信任持久化
3. **接口清单**：7 个 `.do` 接口的完整 URL、请求参数与用途；核心字段逐个说明（含 `ZCBH` 周次位图、`KSSJ` 时间格式等坑）
4. **脱敏响应示例**
5. **最小可用实现**与 7 个实测踩坑记录

## 快速开始

```bash
git clone https://github.com/KKKKahn/szu-grad-timetable-api.git
cd szu-grad-timetable-api

npm install
npx playwright install chromium          # 下载 Chromium 浏览器

# 通过环境变量提供凭据（不要硬编码到代码里）
export SZU_STUDENT_ID='你的学号'
export SZU_PASSWORD='你的密码'

npm run timetable
```

- 云服务器 / 校外 IP **首次运行会触发短信 MFA**，终端按提示输入 6 位验证码即可；选择「信任此设备」后，持久化 profile 会长期免验证。
- 完整脱敏响应样例见 [`examples/szu-grad-timetable-api-samples.json`](examples/szu-grad-timetable-api-samples.json)。

运行输出示例：

```
共 21 条排课记录
周2 10:15-10:55 管理理论与实证 @汇星楼1号教室 (SHEN JIE) 3-10周
...
```

## 目录结构

```
├── README.md
├── LICENSE
├── package.json
├── docs/
│   └── szu-grad-timetable-api.md          # 完整逆向指南
└── examples/
    ├── fetch-timetable.mjs                # 可运行的最小实现（含 MFA 处理）
    └── szu-grad-timetable-api-samples.json # 脱敏响应样例
```

## 合规与免责

- 本项目仅供学习与个人使用，**仅可查询本人数据**，请勿替他人查询或传播 Cookie。
- 请**低频使用**，勿对学校服务器造成压力，勿用于商业用途。
- 因使用本项目产生的一切后果由使用者自行承担；如文档涉及的接口发生变化，请以实际系统为准。

## 相关项目

- [szu-cli](https://github.com/AwesomeHou/szu-cli) — 深圳大学本科生相关接口的命令行工具

## License

[MIT](LICENSE)
