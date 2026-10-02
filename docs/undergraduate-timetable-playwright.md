# 本科生课表 Playwright 抓取

本科生「我的课表」使用 `https://ehall.szu.edu.cn/jwapp/sys/wdkb/`，接口和研究生的 `gsapp/sys/wdkbapp/` 不同。本仓库的 `examples/fetch-undergrad-timetable.mjs` 使用 Playwright 持久化 Chromium/Chrome 完成登录和页面加载，并监听页面真实发出的课表接口。入口需要使用 eHall 生成的 `amp_sec_version_` 参数：

```text
.../wdkb/*default/index.do?t_s=...&amp_sec_version_=1&gid_=...&EMAP_LANG=zh&THEME=cherry#/xskcb
```

- `dqxnxq.do`：当前学年学期
- `dqzc.do`：当前教学周
- `xskcb.do`：正常课程
- `xsdkkc.do`、`xswpkc.do`、`xssjkkc.do`：调课、未排课、实践课（可选）

脚本只保存脱敏运行日志和标准化 JSON，不记录密码、Cookie、ticket 或请求表单值。日志默认写到 `logs/`，结果默认写到 `output/undergraduate-timetable.json`；这两个目录已加入忽略规则。

## 服务器复现

```bash
npm install
npx playwright install --with-deps chromium

export SZU_STUDENT_ID='你的学号'
export SZU_PASSWORD='你的密码'
export SZU_PROFILE="$PWD/browser-profile"
export SZU_HEADED=0
npm run timetable:undergrad
```

如果 eHall 首页生成了带 `t_s`/`gid_` 的最新入口，可以将完整 URL 放进 `SZU_ENTRY_URL`；脚本不会把其中的 ticket 或 Cookie 写入日志。

默认使用 Playwright 自带 Chromium，并带有 `--no-sandbox --disable-dev-shm-usage`，适合普通 Linux 容器或服务器。若服务器已安装 Google Chrome，可显式指定：

```bash
export SZU_BROWSER_CHANNEL=chrome
npm run timetable:undergrad
```

首次运行会在 `SZU_PROFILE` 建立持久化浏览器 profile。统一认证的设备信任 Cookie 会随 profile 保存；后续任务可以在无头模式直接复用。不要复制或提交该目录。

## 首次登录与滑块

登录页面的密码输入框初始是 `readonly`，脚本只把密码写入页面可见输入框并点击页面自身的登录按钮，由校园认证页面负责 AES 加密和提交。脚本不会把密码拼入 URL 或日志。

如果服务器触发滑块或二次验证：

1. 在有桌面的机器上设置 `SZU_HEADED=1`，运行一次并完成页面提示。
2. 保持同一个 `SZU_PROFILE` 目录，再把目录安全地放到服务器使用。
3. 二次验证页面不是脚本的正常无头路径；脚本会停止并在日志中记录当前页面状态，不会循环重试登录。

## 输出示例

```json
{
  "fetchedAt": "2026-10-02T00:00:00.000Z",
  "sourceUrl": "https://ehall.szu.edu.cn/jwapp/sys/wdkb/*default/index.do?...#/xskcb",
  "term": {
    "id": "2025-2026-2",
    "name": "2025-2026学年第二学期",
    "currentWeek": 16
  },
  "items": [
    {
      "courseCode": "0901970032",
      "courseName": "课程名称",
      "teachers": ["教师"],
      "weeksText": "1-17周",
      "weekday": 2,
      "startSection": 3,
      "endSection": 4,
      "location": "教学楼"
    }
  ]
}
```

## 诊断日志

每次运行生成 `logs/undergraduate-timetable-<UTC 时间>.log`，包含导航、认证状态、课表接口名称/HTTP 状态、响应行数和输出文件路径。接口请求只记录方法和 endpoint 名称，不记录请求体；日志写入失败不会阻止浏览器关闭。
