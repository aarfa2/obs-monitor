# OBS Monitor

局域网或公网机群监控：每台 OBS 电脑跑无界面采集器，中心服务器一份看板。只监控，不控制 OBS。不要用 Electron 打包采集器。看板需要登录；采集器仍用共享 token 接入。

## 角色

- **Hub（中心）**：跑在监控服务器，打开网页、收采集器、存 24 小时日志、发 Webhook。
- **Agent（采集器）**：跑在每台 OBS 电脑，只连本机 `127.0.0.1:4455`，把指标推到中心。本机不提供网页，不存一天日志，只留读取游标。

## 开发（本机既当中心又当一台采集器）

```powershell
copy config.example.json config.json
# 填写 obs.password、token，开发时 hubUrl 用 ws://127.0.0.1:8787/agent
# 首次登录：填写 admin.username / admin.password（至少 8 位），启动后会写入 data/users.json
npm install
npm run dev
```

打开 `http://localhost:5173`。先登录，首页是机群，点进去才是单机页。管理员可打开「用户」增删账号。

也可以不配 `admin.password`，改用：

```powershell
npm run user:add -- --username admin --password 你的密码 --admin
```

## 生产

监控服务器：

```powershell
npm run build
npm start
```

局域网看板：`http://服务器IP:8787`（需登录）。

每台 OBS 电脑：复制项目（或之后的安装包），`config.json` 里：

- `token` 与中心相同（公网务必改成强随机值，不要用示例里的 `obs-monitor-lan`）
- `hubUrl` 局域网为 `ws://服务器IP:8787/agent`；公网为 `wss://你的域名/agent`
- `displayName` 如 `录播-03`
- `obs.password` 为本机 OBS WebSocket 密码（不要开放 4455 到局域网或公网）

```powershell
npm run start:agent
```

开机可用 NSSM / 任务计划程序跑 `npx tsx src/agent.ts` 或后续打好的单文件。不要为采集器上 Electron。

`data/machine-id.txt` 第一次运行自动生成，不要复制到另一台（否则两台会撞 ID）。

## 公网

看板要上公网时：

1. 前面用 Caddy / Nginx 做 HTTPS，反代到本机 `127.0.0.1:8787`（不要直接把 8787 打到公网）。
2. 采集器出站连 `wss://域名/agent`，OBS 的 4455 仍只听本机。
3. 第一个管理员用 `config.json` 的 `admin` 或 `npm run user:add` 创建；不要公开注册。
4. 普通用户只能看看板；管理员可以管用户、测试 Webhook。会话是 httpOnly cookie，约 7 天。

## 日志

- OBS 自己的 `%APPDATA%\obs-studio\logs\`：OBS **不会**自动删。采集器会删超过 24 小时且不是当前正在写的 txt。
- 采集器本机：几乎不写业务日志，只有 `data/log-cursor.json` 和 `machine-id.txt`。
- 中心：按机器保留 24 小时，网页分类/搜索查的是中心。用户表在中心 `data/users.json`。

## 配置项

| 项 | 中心 | 采集器 |
| --- | --- | --- |
| listen | 监听地址端口 | 不用 |
| token | 接入密钥 | 同一份 |
| hubUrl | 不用 | `ws://中心:8787/agent` 或 `wss://域名/agent` |
| displayName | 不用 | 看板显示名 |
| admin.username / password | 用户表为空时创建首个管理员 | 不用 |
| obs.url / password | 不用 | 本机 OBS |
| alerts.webhookUrl | 通用 Webhook | 不用（报警由中心发出） |
