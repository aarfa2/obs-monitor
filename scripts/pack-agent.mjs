import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release", "obs-agent");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", "agent.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(outDir, "obs-agent.cjs"),
  legalComments: "none",
});

copyFileSync(process.execPath, join(outDir, "node.exe"));

writeFileSync(
  join(outDir, "config.json"),
  `${JSON.stringify(
    {
      token: "obs-monitor-lan",
      hubUrl: "ws://HUB电脑的局域网IP:8787/agent",
      displayName: "录播-01",
      obs: {
        url: "ws://127.0.0.1:4455",
        password: "在这里填本机OBS的WebSocket密码",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

writeFileSync(
  join(outDir, "start.bat"),
  `@echo off
cd /d "%~dp0"
echo OBS Monitor Agent
node.exe obs-agent.cjs
if errorlevel 1 pause
`,
  "utf8",
);

writeFileSync(
  join(outDir, "install-autostart.ps1"),
  `$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute (Join-Path $root "node.exe") -Argument "obs-agent.cjs" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "OBS-Monitor-Agent" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "OBS-Monitor-Agent"
Write-Host "已注册开机任务 OBS-Monitor-Agent，并以当前用户启动。"
`,
  "utf8",
);

writeFileSync(
  join(outDir, "uninstall-autostart.ps1"),
  `Unregister-ScheduledTask -TaskName "OBS-Monitor-Agent" -Confirm:$false
Write-Host "已删除开机任务 OBS-Monitor-Agent"
`,
  "utf8",
);

writeFileSync(
  join(outDir, "安装说明.txt"),
  `OBS Monitor Agent — 每台 OBS 电脑安装说明
========================================

一、先在一台电脑上跑 Hub（监控网页）
  1. 打开 obs-monitor 项目
  2. 确认 config.json 里 token 已填（默认 obs-monitor-lan）
  3. 执行: npm run build && npm start
  4. 浏览器打开 http://Hub的IP:8787
  5. Windows 防火墙放行入站 TCP 8787

二、把本文件夹拷到每台 OBS 电脑
  整份复制，不要只拷 exe。建议放到:
  C:\\Program Files\\obs-agent
  或 D:\\obs-agent

  禁止拷贝 data\\machine-id.txt（每台电脑第一次启动会自己生成）

三、改这台电脑的 config.json
  token       必须和 Hub 完全一致
  hubUrl      ws://Hub电脑的局域网IP:8787/agent
              例如 ws://192.168.1.10:8787/agent
              不要用 127.0.0.1（那是本机，连不到 Hub）
  displayName 这台机在网页上的名字，例如 录播-01、机房-A
  obs.url     本机 OBS，固定 ws://127.0.0.1:4455
  obs.password 本机 OBS「工具 → WebSocket服务器设置」里的密码

四、本机 OBS 打开 WebSocket（只监听本机）
  工具 → WebSocket 服务器设置
  - 启用 WebSocket 服务器
  - 服务器端口 4455
  - 启用身份验证，设置密码（填到上面 config.json）
  - 服务器 IP / 绑定：127.0.0.1 或仅本地（不要对局域网开放 4455）

五、启动 Agent
  双击 start.bat
  窗口保持打开。Hub 网页上应出现这台机器。

六、开机自启（可选）
  右键 install-autostart.ps1 → 使用 PowerShell 运行
  必须用「登录 OBS 的那个 Windows 用户」运行，不要用 SYSTEM
  取消自启：运行 uninstall-autostart.ps1

常见问题
  - 网页没有这台机：检查 token、hubUrl、Hub 是否已启动、防火墙 8787
  - Agent 报 OBS 认证失败：密码和 OBS 里不一致，或 OBS 未开 WebSocket
  - 升级：覆盖 obs-agent.cjs 和 node.exe，保留 config.json 和 data 目录
`,
  "utf8",
);

console.log(`打包完成: ${outDir}`);
console.log("把整个 obs-agent 文件夹拷到每台 OBS 电脑，改 config.json 后双击 start.bat");
