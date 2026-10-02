# 本科生课表实现日志

日期：2026-10-02（Asia/Shanghai）

## 已完成

- 对照 `szu-cli` 的本科生实现确认入口为 `jwapp/sys/wdkb`，接口为 `dqxnxq.do`、`dqzc.do`、`xskcb.do`，以及调课/未排课/实践课接口。
- 新增 `examples/fetch-undergrad-timetable.mjs`：Playwright 持久化 context、服务器无头参数、可选系统 Chrome channel、统一认证页面密码提交、接口响应捕获、标准化 JSON 输出和脱敏日志。
- 新增 `npm run timetable:undergrad`、部署文档和环境变量模板。
- 日志不写入密码、Cookie、ticket、请求体或完整学号；学号只以 `20****86` 形式出现。
- 确认入口参数必须是 `amp_sec_version_`；误写为 `_sec_version_` 会得到应用层 403。

## 实机验证

使用用户提供的账号在 Google Chrome 和 Playwright Chromium/Chrome 流程中验证。使用原始 `amp_sec_version_` 入口后，统一身份认证和本科生课表页面均成功加载，捕获到 `dqxnxq.do`、`dqzc.do`、`xskcb.do` 等接口。

成功结果：2026-2027 学年第一学期，当前教学周第 5 周，正常课表 8 条，调课记录 1 条。结果已保存为 `output/undergraduate-timetable.json`，本次脱敏日志已保存为 `logs/undergraduate-timetable-*.log`。

## 复现命令

```bash
npm install
npx playwright install --with-deps chromium
export SZU_STUDENT_ID='你的学号'
export SZU_PASSWORD='你的密码'
export SZU_BROWSER_CHANNEL=chrome  # 或留空使用 Playwright Chromium
npm run timetable:undergrad
```

运行日志在 `logs/`，结果在 `output/undergraduate-timetable.json`。`browser-profile/` 是登录态，必须单独保护，不能提交到仓库。
