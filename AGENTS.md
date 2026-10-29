# 给 AI agent 的说明

这个仓库是 BugShot：测试人员用的截图记反馈工具。分两个程序：

- **服务端**（`src/server/`）：存全部项目和截图，提供客户端接口、只读网页和 MCP。整个团队只部署一台。
- **客户端**（Electron，`src/main/`、`src/renderer/`）：测试人员各自装，连服务端。

## 用户说“部署服务端”时

在当前这台电脑上把服务端跑起来，并让它一直运行、开机自启。按下面做，不要问用户可以自己判断的事。

### 1. 选方式

- 这台电脑有 Docker（NAS、Linux 服务器）→ 用 **Docker**。
- 否则 → 用 **Node 直接运行**（需要 Node 20+，没有就先装 LTS 版）。
- 用户明确想要带窗口的版本（托盘、能看在线客户端）→ 让用户从 Releases 下载 `BugShot-Server-Setup-*.exe` / `BugShot-Server-*.dmg` 安装，或者 `npm ci && npm run dist:server` 在 `release-server/` 里打出安装包。

### 2a. Docker

```bash
npm ci
npm run build:server            # 生成 out/server/bugshot-server.cjs
docker build -t bugshot-server .
docker run -d --name bugshot --restart unless-stopped --network host \
  -v <数据目录>:/data bugshot-server
docker logs bugshot             # 打印地址、MCP 地址和团队令牌
```

`--network host` 是为了让客户端在局域网里自动找到服务端（UDP 17801）。这台机器不支持 host 网络时改成 `-p 17800:17800`，客户端要手动填地址。如果 `ghcr.io/hui455/bugshot-server:latest` 能拉到，也可以直接用它，不用自己 build。

### 2b. Node 直接运行

```bash
npm ci
npm run build:server
node out/server/bugshot-server.cjs --data <数据目录>
```

`out/server/bugshot-server.cjs` 是单个文件，不依赖 `node_modules`，可以复制到别处运行。确认能启动后，把它设成常驻、开机自启：

- **Linux**：写一个 systemd 服务（`Restart=always`，`WorkingDirectory` 和 `--data` 用绝对路径），`systemctl enable --now`。
- **macOS**：写一个 `~/Library/LaunchAgents/` 下的 launchd plist（`RunAtLoad`、`KeepAlive`），`launchctl load`。
- **Windows**：用任务计划程序建一个“登录时 / 开机时”运行的任务，或者用 `pm2` + `pm2-windows-startup`。

数据目录不要放在仓库里（`git pull` / `git clean` 可能误删），默认建议：Linux `/var/lib/bugshot`，macOS `~/Library/Application Support/BugShot Server/data`，Windows `%APPDATA%\BugShot Server\data`。

### 3. 可选设置

环境变量（命令行参数优先）：`BUGSHOT_DATA` 数据目录、`BUGSHOT_PORT` 端口（默认 17800）、`BUGSHOT_TOKEN` 固定团队令牌、`BUGSHOT_NAME` 服务端名称（默认是电脑名）。其他设置在数据目录的 `server.json` 里（`readOnly: true` 让 MCP 只能读）。

### 4. 防火墙

放行 **TCP 17800**（客户端、网页、MCP）和 **UDP 17801**（局域网自动发现）。Windows 用 `New-NetFirewallRule`，Linux 看是 ufw 还是 firewalld。

### 5. 验证并告诉用户

```bash
curl http://127.0.0.1:17800/api/info   # 返回 {"app":"bugshot-server",...}
```

最后告诉用户这几样（启动日志里都有）：

- 服务端地址 `http://<局域网IP>:17800`
- 团队令牌（测试人员的客户端第一次打开会自动找到服务端，只需要填令牌和自己的名字）
- 网页地址 `http://<局域网IP>:17800/?token=<令牌>`
- MCP 接入命令：

  ```bash
  # Claude Code
  claude mcp add --transport http bugshot http://<局域网IP>:17800/mcp --header "Authorization: Bearer <令牌>"
  # Codex
  export BUGSHOT_TOKEN=<令牌>
  codex mcp add bugshot --url http://<局域网IP>:17800/mcp --bearer-token-env-var BUGSHOT_TOKEN
  ```

### 升级

`git pull && npm ci && npm run build:server`，然后重启服务（Docker 要重新 `docker build` 再重建容器，数据在挂载的目录里不会丢）。客户端和服务端要升级到同一版本。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run serve       # 本地起服务端，数据放 ./data
npm run dev         # 客户端
```
