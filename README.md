# BugShot

安卓 App 测试用的桌面工具：手机用 USB 连上电脑，发现 bug 时按一下快捷键就截取手机画面，填几句描述归到对应项目；支持多轮复测、复制纯文本反馈、导出 zip。

从 v0.3 起分成两个程序：

- **BugShot 服务端**：装在局域网里一台常开的电脑（或 NAS 的 Docker）上。所有项目、反馈、截图都存在这里，大家共用一套数据；MCP 和只读网页也只在这里开，地址固定。
- **BugShot**（客户端）：装在每个测试人员的电脑上，负责连手机截图、记反馈。第一次打开时自动在局域网里找到服务端，填团队令牌和自己的名字即可。连不上服务端时新记的反馈先存在本机，连上后自动补传。

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
- **多人共用**：每条反馈记下记录人，列表可以按记录人筛选；别人记的反馈实时出现；两个人同时改同一条时，后保存的人会被提示是否覆盖。
- **离线暂存**：服务端连不上时照样能截图记录，反馈标“待上传”，恢复后按顺序补传并分配编号；删除项目、结束测试等操作要等连上再做。
- **旧数据上传**：从 v0.1 / v0.2 升级后，本机原有的项目可以一键上传到服务端，重名的在名字后加上记录人。
- **网页**：浏览器打开 `http://<服务端IP>:17800/?token=<团队令牌>` 只读查看；`/mcp` 是 MCP（Streamable HTTP）服务。
- **检查更新**：客户端读取本仓库的 GitHub Releases，一键下载并重启安装；服务端在窗口标题栏提示新版本，需要手动下载安装。

## 安装服务端

最省事：在要当服务端的电脑上拉下这个仓库，对 Claude Code 或 Codex 说“部署服务端”，它会按 [AGENTS.md](AGENTS.md) 装好、设成开机自启，并告诉你地址和团队令牌。

也可以自己装，二选一：

- **常开的 Windows / Mac 电脑**：从 Releases 下载 `BugShot-Server-Setup-<版本>.exe` 或 `BugShot-Server-<版本>-<arch>.dmg`。打开后关掉窗口会缩到托盘继续运行，窗口里可以勾选“开机自动启动”，能看到地址、团队令牌、在线的客户端、数据目录和备份。
- **NAS / Linux（Docker）**：

  ```bash
  docker run -d --name bugshot --restart unless-stopped --network host \
    -v /volume1/bugshot:/data ghcr.io/hui455/bugshot-server:latest
  docker logs bugshot   # 第一次启动会打印团队令牌
  ```

  用 `--network host` 客户端才能自动找到它（UDP 17801）；不方便时改成 `-p 17800:17800`，客户端手动填地址。可用环境变量 `BUGSHOT_TOKEN`、`BUGSHOT_NAME`、`BUGSHOT_PORT` 固定令牌、名称和端口。

数据目录里 `projects/` 是全部数据，`backups/` 是每天 3:00 的自动备份（保留 7 份），`server.json` 是服务端设置。

## 接入 AI agent（MCP）

MCP 在服务端上。服务端窗口里有“复制 Claude Code / Codex 接入命令”，客户端的“连接服务端”面板里也有。

Claude Code：

```bash
claude mcp add --transport http bugshot http://<服务端IP>:17800/mcp --header "Authorization: Bearer <团队令牌>"
```

Codex：

```bash
export BUGSHOT_TOKEN=<团队令牌>
codex mcp add bugshot --url http://<服务端IP>:17800/mcp --bearer-token-env-var BUGSHOT_TOKEN
```

或在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.bugshot]
url = "http://<服务端IP>:17800/mcp"
bearer_token_env_var = "BUGSHOT_TOKEN"
```

提供的工具：`list_projects`、`create_project`、`get_project`、`list_bugs`、`search_bugs`、`get_bug`（附带截图图片）、`add_bug`、`update_bug`、`set_retest_result`、`start_round`、`end_round`、`get_feedback_text`、`export_project_zip`。服务端窗口勾选“只读”后 agent 只能读取。AI agent 记的反馈，记录人显示为“AI agent”。

## 开发

需要 Node.js 22。

```bash
npm install
npm run dev          # 启动客户端开发版
npm run dev:server   # 启动带窗口的服务端开发版
npm run serve        # 启动不带窗口的服务端（数据在 ./data）
npm test             # 单元测试
npm run typecheck
```

开发时 adb 会依次从设置里指定的路径、`ANDROID_HOME`、系统 PATH 查找。

## 发布新版本

1. 修改 `package.json` 里的 `version`，例如 `0.3.0`。客户端和服务端要升级到同一版本。
2. 在 Actions 页面手动运行 Release（或打标签 `v0.3.0` 推送）。
3. GitHub Actions 会在 Windows 和 macOS 上打包客户端（自动内置 adb）和服务端，发布到 Releases，并把服务端镜像推到 `ghcr.io/hui455/bugshot-server`。已安装的客户端点“检查更新”就能升级。

说明：macOS 安装包没有签名，第一次打开需要在“系统设置 → 隐私与安全性”里允许；未签名的 macOS 版不能自动更新，需要手动下载新的 dmg。Windows 版可以正常自动更新。

服务端数据默认在 Windows：`%APPDATA%\BugShot Server\data`，macOS：`~/Library/Application Support/BugShot Server/data`，可以在服务端窗口里换位置。客户端只在本机（`%APPDATA%\BugShot\BugShot\client`）存缓存和待上传的反馈。
