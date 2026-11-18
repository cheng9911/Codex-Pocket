# Codex Pocket

在安卓浏览器中查看和控制自己主机上的 Codex。支持手动切换主机；代码、任务与 Codex 登录凭据始终留在各自主机。

首版采用 React + TypeScript + Vite、Node.js、SQLite，以及从 [T3 Code](https://github.com/pingdotgg/t3code) 提取的 Codex 通信模块。网页成熟后再封装 Android APK。

## 已实现

- 一次性配对码、独立设备会话、会话撤销。
- 新建聊天，选择允许范围内的主机目录和模型。
- 多聊天实时状态、流式回复、工具输出、文件修改摘要。
- 三种消息意图：现在补充当前轮次、完成后发送、仅保存草稿；排队消息可查看和取消。
- 离线消息标为未发送，重连后手动确认；发送结果不确定时必须核对记录，不自动重放。
- 审批卡片显示主机、工作目录、命令/变更、原因和批准范围，支持本次或 Codex 会话范围审批。
- 回答问题、停止当前轮次；停止或任务失败会取消该聊天后续队列。
- 主机身份常驻显示、主机目录收藏、待处理列表、聊天搜索/改名/置顶/状态筛选。
- 当前主机的账号额度比例、额度窗口和重置时间；只显示 Codex 实际返回的数据。
- 浏览器中英文语音转文字，识别语言跟随界面语言，结果只填入草稿，用户确认发送。
- 简体中文 / English 界面，设置即时生效并保存在此浏览器；界面使用本地部署的阿里巴巴普惠体 3.0。
- 相同目录串行，不同目录并行。
- 页面刷新、断线重连；关闭浏览器不会停止任务。
- 手动切换主机，各自独立配对和保存会话。
- SQLite 状态与操作去重；服务重启后不会自动重复执行不确定操作。

这是初始可用版本。只控制本服务管理的聊天，不承诺接管官方桌面应用中正在运行的会话。APK、锁屏推送、聊天迁移、worktree 管理不在首版范围内。

## 本地启动

需要 Node.js 22.13+、npm，以及已安装并登录的 Codex CLI。

```bash
git clone https://github.com/cheng9911/Codex-Pocket.git
cd Codex-Pocket
npm ci
codex login status
npm run build
npm start
```

在另一个终端生成配对码：

```bash
cd Codex-Pocket
npm run pair
```

打开 **http://127.0.0.1:4310**，输入配对码。配对码只能使用一次，10 分钟有效；设备会话有效期为 30 天，可以在网页的“设备与连接”中撤销。

配对成功的设备可以操作该主机服务暴露的任务。不要分享配对码、设备 Cookie、数据库或 Codex 登录文件。

默认仅监听回环地址，允许的工作目录默认为启动时的项目目录。首次运行会连接自己的 Codex 子进程，不会停止官方桌面应用。

## 配置

复制 `.env.example` 为 `.env`，修改后重启服务。系统环境变量优先于 `.env`。

| 变量              | 默认值 / 作用                                          |
| ----------------- | ------------------------------------------------------ |
| `POCKET_HOST`     | `127.0.0.1`，监听地址                                  |
| `POCKET_PORT`     | `4310`                                                 |
| `POCKET_NAME`     | 主机名，在手机上显示                                   |
| `POCKET_ORIGIN`   | 对外访问的准确来源，如 `https://devbox.example.ts.net` |
| `POCKET_ROOTS`    | 允许的项目根目录，多个目录用英文分号 `;` 分隔          |
| `POCKET_DATA_DIR` | 默认 `~/.local/share/codex-pocket`                     |
| `CODEX_BIN`       | 默认通过 `PATH` 查找 `codex`，可指定绝对路径           |

目录选择会解析真实路径并拒绝根目录范围外的路径与符号链接跳转。这是项目选择边界，不是额外的操作系统隔离沙箱；工具权限仍由 Codex 的 workspace-write 沙箱和 on-request 审批策略执行。

## 安卓与外网访问

建议主机和安卓安装 Tailscale，加入同一个受控 tailnet。使用 Tailscale Serve 为本地服务提供 HTTPS：

```bash
tailscale serve --bg http://127.0.0.1:4310
```

以 Tailscale 打印的真实 HTTPS 地址填写 `.env`，例如：

```dotenv
POCKET_ORIGIN=https://devbox.example.ts.net
POCKET_NAME=我的开发机
POCKET_ROOTS=/home/me/projects;/home/me/work
CODEX_BIN=/absolute/path/to/codex
```

重启 Pocket，在安卓浏览器打开该 HTTPS 地址并配对。此时浏览器 Cookie 使用 Secure、HttpOnly、SameSite=Strict，WebSocket 同样校验来源与会话。默认不对公网开放 Codex app-server。

Tailscale 的 MagicDNS、HTTPS 和 Serve 权限需要按其[官方文档](https://tailscale.com/docs/features/tailscale-serve)配置；本项目不会自动安装、登录或改变你的 Tailscale 设置。

在主机切换面板添加第二台主机的地址即可。每台主机分别部署、登录 Codex 和配对。切换采用导航到目标主机的同源网页；仅主机名称和地址通过 URL fragment 传递并清理，不传设备凭据。主机列表是浏览器本地数据，不进行云同步。

## 界面语言与字体

点击左下角“设备与连接设置”（英文为 Settings and devices），在“界面语言 / Interface language”选择简体中文或 English。未配对时也可设置。首次访问按浏览器英文偏好选择英文，其余回退中文；手动选择保存在当前主机地址的浏览器存储中，刷新后保留。

语言切换不重载页面，不影响任务、审批或草稿，也不会翻译用户聊天与 Codex 输出。时间按所选语言格式、当前设备时区显示，后续语音识别使用相同语言。

阿里巴巴普惠体 3.0 的三种原始 WOFF2 字重由主机提供，首次加载约 16 MB，后续可使用浏览器缓存；不请求外部字体 CDN。代码与命令保留 IBM Plex Mono。字体许可见 `THIRD_PARTY_NOTICES.md`。

## 消息、草稿和语音

运行中选择“现在补充”会调用 `turn/steer`，并校验手机看到的执行轮次。当前轮次已结束或发生变化时明确拒绝，不自动转成排队。“完成后发送”保存在主机队列，当前轮次成功结束且目录可用后发送；同一目录的其他聊天仍按顺序执行。任务停止、失败或服务重启会取消此聊天未执行的队列。

草稿按主机和聊天保存在当前浏览器，不跨设备同步。离线可继续输入并保存为“未发送”，重连或刷新不会自动发送。若提交时连接中断或页面关闭，结果可能不确定：先核对聊天记录，再勾选确认后决定是否重新发送。清除浏览器站点数据也会清除草稿。

语音输入使用浏览器的 `SpeechRecognition` / `webkitSpeechRecognition`，首版语言为 `zh-CN`。远程页面需要 HTTPS 和麦克风权限；浏览器可能把音频交给自身的在线识别服务，网络要求取决于浏览器。此功能不通过 Codex 账号调用付费转写接口，也不在主机部署识别模型。不支持或识别失败时，可使用安卓键盘的麦克风。识别文字只填入草稿，不自动发送或执行。

目录收藏和聊天名称/置顶保存在当前主机 SQLite，已配对设备可看到相同整理结果。待处理列表包含审批、问题和稍后发送的队列。额度页从 `account/read` 与 `account/rateLimits/read` 读取，接收 `account/rateLimits/updated` 更新，支持手动刷新；账号未返回额度时明确显示缺失，不估算消息数。页面按当前设备时区显示重置时间。

会话范围审批由 Codex 决定实际缓存范围，不等同于永久关闭审批。命令、文件修改和额外权限的授权含义不同，卡片会分别标示；原生请求限制可用决定时，界面和接口都遵守该限制。

## Linux 后台运行

先完成 `.env` 和构建，再生成用户服务：

```bash
npm run service:install
systemctl --user daemon-reload
systemctl --user enable --now codex-pocket
journalctl --user -u codex-pocket -f
```

安装脚本只生成服务文件，默认不启用。若文件已存在会拒绝覆盖。需要停止终端中已有的 Pocket 实例，避免端口冲突。后台环境须能找到 Node 和 Codex；建议设置 `CODEX_BIN` 为绝对路径。

用户退出后是否继续运行取决于机器的 systemd 用户管理设置；如需长期无人值守，按机器管理策略配置用户 linger。主机仍须保持开机、联网且不休眠。

## 开发与验证

```bash
npm run dev          # 主机服务，代码变更会重启并中断活跃任务
npm run dev:web      # Vite，http://127.0.0.1:5173
npm run check
npm test
npm run verify:vendor
npm run build
```

开发时不设置 `POCKET_ORIGIN`，使用本地回环地址。Vite 把 `/api` 和 WebSocket 代理到 4310，浏览器在开发来源单独配对。

真实 Codex 验证需要已登录账号，并会消耗少量模型额度：

```bash
npm run verify:transport  # 初始化和读取模型目录，不启动模型任务
npm run verify:live       # 临时项目中的一轮文本任务
npm run verify:controls   # 临时项目中真实审批写入和轮次中断
npm run verify:features   # 真实账号额度读取和当前轮次追加指令
```

`verify:controls` 仅自动批准脚本创建的临时测试会话请求，测试提示只写入临时标记文件；不会给正常聊天配置自动批准。正常服务的审批由用户处理。

浏览器隔离验收可运行 `npm run preview:test`。它显式使用假 Codex 进程，只有临时测试数据，没有真实账号或文件执行能力，不能代替真实 Codex 验证。正常启动不会使用假数据。

测试与已知边界见 [验证记录](docs/verification.md)，数据流见 [架构说明](docs/architecture.md)，复用来源见 [UPSTREAM.json](packages/codex-transport/UPSTREAM.json)。

## 许可证

项目代码采用 MIT。T3 复用部分保留其原始 MIT 声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
