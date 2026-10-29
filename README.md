# BugShot

安卓 App 测试用的桌面工具：手机用 USB 连上电脑，发现 bug 时按一下快捷键就截取手机画面，填几句描述归到对应项目；支持多轮复测、复制纯文本反馈、导出 zip，并在局域网提供网页和 MCP 服务给 AI agent 使用。

## 功能

- **项目**：项目名沿用“编号-名称”（如 `16-违章查询`），带开发人员、类型；可按关键字（项目名或反馈内容）搜索，按“测试中 / 待复测 / 已通过”筛选。
- **截图提 Bug**：`Ctrl/Cmd+Shift+B`（窗口不在前台也能用）或悬浮窗按钮，通过 adb 截取手机画面，自动记录机型、系统版本、分辨率和前台 Activity。
- **只记文字**：`Ctrl/Cmd+Shift+T`，不带截图。
- **登记**：模块（tab1–tab4 / 广告 / 登录/支付 / 悬浮窗 / 其他）+ 页面 + 问题，可标“审核状态 / 上线模式”；页面名按项目历史自动提示；常用短语一键填入，可自定义，按使用次数排序。
- **截图管理**：登记时和登记后都能重截、删除、追加截图。
- **圈画评论**：在截图上画框、圈、箭头或随手画，每处自动编号并可写评论；评论画在图上，原图保留。导出 zip、局域网网页、MCP 里用的都是带标注的图，`bugs.csv` 有“图注”列。
- **回归测试**：每个项目按轮次记录，每轮“测试中 / 已结束”并记录时间；开新一轮时自动带出未修复的问题，逐条标“已修复 / 仍存在”。
- **复制文本**：只复制文字，格式与飞书表“反馈原文”一致（按 tab / 广告分组编号），复测轮只列“仍存在 + 新增”。
- **导出 zip**：`反馈原文.txt`、`report.html`、`bugs.csv`（Excel 可直接打开）、`bugs.json`、`screenshots/`。
- **局域网**：默认端口 17800。浏览器打开 `http://<电脑IP>:17800/?token=<口令>` 只读查看；`/mcp` 是 MCP（Streamable HTTP）服务。
- **检查更新**：读取本仓库的 GitHub Releases，一键下载并重启安装。

## 接入 AI agent（MCP）

在 BugShot 标题栏点“局域网 · MCP”，里面有可直接复制的命令。

Claude Code：

```bash
claude mcp add --transport http bugshot http://<电脑IP>:17800/mcp --header "Authorization: Bearer <口令>"
```

Codex：

```bash
export BUGSHOT_TOKEN=<口令>
codex mcp add bugshot --url http://<电脑IP>:17800/mcp --bearer-token-env-var BUGSHOT_TOKEN
```

或在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.bugshot]
url = "http://<电脑IP>:17800/mcp"
bearer_token_env_var = "BUGSHOT_TOKEN"
```

提供的工具：`list_projects`、`create_project`、`get_project`、`list_bugs`、`search_bugs`、`get_bug`（附带截图图片）、`add_bug`、`update_bug`、`set_retest_result`、`start_round`、`end_round`、`get_feedback_text`、`export_project_zip`。勾选“只读”后 agent 只能读取。

## 开发

需要 Node.js 22。

```bash
npm install
npm run dev          # 启动开发版
npm test             # 单元测试
npm run typecheck
```

开发时 adb 会依次从设置里指定的路径、`ANDROID_HOME`、系统 PATH 查找。

## 发布新版本

1. 修改 `package.json` 里的 `version`，例如 `0.2.0`。
2. 提交后打标签并推送：`git tag v0.2.0 && git push origin v0.2.0`。
3. GitHub Actions 会在 Windows 和 macOS 上打包（自动内置 adb），发布到 Releases。已安装的 BugShot 点“检查更新”就能升级。

说明：macOS 安装包没有签名，第一次打开需要在“系统设置 → 隐私与安全性”里允许；未签名的 macOS 版不能自动更新，需要手动下载新的 dmg。Windows 版可以正常自动更新。

数据保存在本机用户目录（Windows：`%APPDATA%\BugShot\BugShot`，macOS：`~/Library/Application Support/BugShot/BugShot`）。
