# OBS Monitor

局域网机群监控：每台 OBS 电脑跑无界面采集器，中心服务器一份看板。只监控，不控制 OBS。不要用 Electron 打包采集器。

## 角色

- **Hub（中心）**：跑在监控服务器，打开网页、收采集器、存 24 小时日志、发 Webhook。
- **Agent（采集器）**：跑在每台 OBS 电脑，只连本机 `127.0.0.1:4455`，把指标推到中心。本机不提供网页，不存一天日志，只留读取游标。

## 开发（本机既当中心又当一台采集器）

```powershell
copy config.example.json config.json
# 填写 obs.password、token，开发时 hubUrl 用 ws://127.0.0.1:8787/agent
npm install
npm run dev
```

打开 `http://localhost:5173`。首页是机群，点进去才是单机页。

## 生产

监控服务器：

```powershell
npm run build
npm start
```

看板：`http://服务器IP:8787`

每台 OBS 电脑：复制项目（或之后的安装包），`config.json` 里：

- `token` 与中心相同
- `hubUrl` 为 `ws://服务器IP:8787/agent`
- `displayName` 如 `录播-03`
- `obs.password` 为本机 OBS WebSocket 密码（不要开放 4455 到局域网）

```powershell
npm run start:agent
```

开机可用 NSSM / 任务计划程序跑 `npx tsx src/agent.ts` 或后续打好的单文件。不要为采集器上 Electron。

`data/machine-id.txt` 第一次运行自动生成，不要复制到另一台（否则两台会撞 ID）。

## 日志

- OBS 自己的 `%APPDATA%\obs-studio\logs\`：OBS **不会**自动删。采集器会删超过 24 小时且不是当前正在写的 txt。
- 采集器本机：几乎不写业务日志，只有 `data/log-cursor.json` 和 `machine-id.txt`。
- 中心：按机器保留 24 小时，网页分类/搜索查的是中心。

## 配置项

| 项 | 中心 | 采集器 |
| --- | --- | --- |
| listen | 监听地址端口 | 不用 |
| token | 接入密钥 | 同一份 |
| hubUrl | 不用 | `ws://中心:8787/agent` |
| displayName | 不用 | 看板显示名 |
| obs.url / password | 不用 | 本机 OBS |
| alerts.webhookUrl | 通用 Webhook | 不用（报警由中心发出） |
