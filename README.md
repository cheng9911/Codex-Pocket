# Codex Pocket

Codex Pocket 是自托管的 Codex 网页控制台。安卓手机和电脑都能查看实时任务、发送消息、审批操作、回答问题或停止当前轮次。多台主机可以分别部署，聊天、代码和 Codex 登录状态留在各自主机。

**远程使用时，在浏览器打开自己的 Pocket HTTPS 地址，并输入这台主机的密码。** 主机通过 Cloudflare Tunnel 提供访问，手机无需安装 Tailscale 或 ChatGPT。当前提供网页，Android APK 尚未发布。

## 使用路线

1. [在电脑上安装、设置主机密码并启动](#先在电脑上启动并登录)。
2. [配置 Cloudflare Tunnel，让安卓通过 HTTPS 登录](#安卓手机连接主机)。
3. [查看历史、同步桌面任务](#查看并继续本机已有聊天)，或[在网页新建任务](#完成第一个任务)。
4. 日常使用见[消息与审批](#消息与审批)、[整理与设置](#整理与设置)和[切换主机](#连接多台主机)。长期使用见[后台运行](#linux-后台运行)、[更新与数据](#更新与数据)和[常见问题](#常见问题)。

| 你的目标 | 在 Pocket 里选择 |
| --- | --- |
| 看本机已有聊天的保存记录 | 打开对应聊天，进入「历史查看」 |
| 控制桌面端仍在运行的同一个聊天 | 在 Linux Codex 桌面打开该聊天，再点击 Pocket 的「连接桌面同步」 |
| 让 Pocket 独立执行 | 「新建聊天」，或在原端结束并释放已有聊天后选择「在 Pocket 中继续」 |

桌面同步通过 Linux 桌面应用的内部 IPC 实现，属于实验功能。已在记录的桌面版本上验证发送、追加指令、命令审批和停止。详细覆盖范围与版本见[桌面桥接验证](docs/verification.md#桌面-ipc-桥接)。

## 先在电脑上启动并登录

以下命令按 Linux / Bash 编写。已验证环境见[验证记录](docs/verification.md)。

### 1. 检查主机环境

需要 Node.js **22.13 或更新版本**、npm，以及已安装并登录的 Codex CLI。在准备运行 Pocket 的同一个系统用户下执行：

```bash
node --version
npm --version
codex --version
codex login status
```

确认 Codex 已登录；Pocket 使用这个用户的 Codex 环境。若终端找不到 `codex`，先解决可执行文件路径，再启动 Pocket。

### 2. 安装项目并配置工作目录

第一次下载：

```bash
git clone https://github.com/cheng9911/Codex-Pocket.git
cd Codex-Pocket
npm ci
```

已有仓库时，直接进入已有的 `Codex-Pocket` 目录，不必重新克隆。后面的 `npm` 命令都在这个目录执行。

首次配置时复制模板；**已有 `.env` 就直接编辑，不要覆盖**：

```bash
cp .env.example .env
```

编辑 `.env`，默认开放全部工作目录，无需逐个添加项目：

```dotenv
POCKET_HOST=127.0.0.1
POCKET_PORT=4310
POCKET_NAME=我的开发机
POCKET_ROOTS=/
```

`POCKET_ROOTS` 是工作目录范围。Linux 默认是 `/`（全部目录）；不设置或留空时同样使用文件系统根目录。实际访问仍受运行 Pocket 的系统用户权限限制，不会自动获得 root 权限。若希望限制到部分项目，可设置为 `/home/me/projects;/home/me/work`，多个绝对路径用英文分号分隔。第一次在本机使用时，保持 `POCKET_ORIGIN` 注释状态。

### 3. 设置这台主机的固定密码

在仓库目录执行：

```bash
npm run password:set
```

在终端输入两次你自己的密码（输入不回显）。密码不能为空，支持中文、空格和符号。发布到公网时请为每台主机设置独立、难猜的密码。只在本机终端输入密码，避免把它写进命令行参数。

默认配置文件为 **`~/.local/share/codex-pocket/auth.json`**。它保存随机盐和 scrypt 密码哈希，不保存可读明文；Linux 权限为 `600`。手机登录时输入原密码即可，不需要输入哈希。

设置 `POCKET_DATA_DIR` 时，默认位置随之变为该目录下的 `auth.json`；也可在 `.env` 用 `POCKET_AUTH_FILE=/绝对路径/auth.json` 单独指定。每台主机独立运行此命令并设置自己的密码，配置文件不随主机切换发送到手机或其他主机。

### 4. 构建并启动

```bash
npm run build
npm start
```

看到服务地址后，在**这台电脑**上打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)。等待终端显示 `Codex 已连接。`；如果连接失败，查看该终端中的原因。

前台运行时保留这个终端。`Ctrl+C` 会停止主机服务并影响正在执行的任务；关闭网页不会停止主机任务。已在运行的服务不必重复启动。

### 5. 登录并记住设备

1. 浏览器打开这台主机的 Pocket 地址。
2. 输入刚才设置的**主机密码**，给设备起名，例如“电脑浏览器”或“我的安卓手机”。
3. 勾选 **记住此设备（30 天）**，点击“登录此主机”。

Pocket 在浏览器中保存当前主机的独立会话 Cookie，不自行保存明文主机密码；浏览器自己的密码管理器由你决定是否使用。有效期内刷新页面、关闭后重新打开、切换到其他主机再回来，都可直接进入，不需要反复输入密码。有效期是登录起 30 天，不自动无限续期。

不勾选时使用浏览器会话 Cookie，服务端最多允许 **12 小时**；浏览器恢复会话时也可能恢复这种 Cookie，公共设备使用后请主动“退出此主机”。清除 Cookie、授权过期或设备被撤销后，需要重新登录。

**从旧版升级：** 尚未配置密码的主机仍支持 `npm run pair` 一次性配对，码有效期 10 分钟且只能用一次。设置密码并重启服务后，将停用配对码入口，并撤销全部旧设备授权；现有聊天和项目不受迁移影响。已启用密码后，删除配置文件不会退回配对模式，而会拒绝启动。

## 查看并继续本机已有聊天

从较早版本升级的用户请先按[更新步骤](#更新与数据)重新构建和启动。刷新网页并登录，侧栏会自动读取运行 Pocket 的系统用户在当前 Codex 环境中的已有聊天。沿用这台主机已配置的密码即可。

1. **保持 Codex 桌面应用打开。** Pocket 与桌面应用必须以同一个系统用户运行。
2. 在 Pocket 侧栏选择已有聊天；默认先显示历史。聊天未出现时点击“刷新本机聊天”，更早聊天可点击“加载更多本机聊天”。
3. 点击 **“连接桌面同步”**。出现 **“桌面同步 · 已连接”** 后，即可查看实时进度、发送新消息、在运行中选择“现在补充”、审批和停止。桌面端不需要先停止任务或退出。
4. 如果提示没有控制端，先在 Codex 桌面应用打开对应聊天，再重试。不要点击“在 Pocket 中继续”来代替桌面同步。
5. **“断开同步，任务留在桌面继续”** 仅断开 Pocket 的同步。关闭手机网页也不会停止桌面任务；停止任务必须点击“停止”。

发送、审批和停止沿用主机密码、设备 Cookie 和操作 ID 校验；手机不获得 Codex 登录凭据。主机服务关闭只关闭自己的连接和读取进程，不关闭桌面应用。

**聊天太长：** 连续的命令、文件修改和内部过程记录默认合并折叠为一条“执行记录”，点击后可展开查看命令和输出；正文回复、审批请求和失败记录仍直接显示。

### 连接配置

Linux 默认连接当前用户的 `~/.codex/ipc/ipc.sock`；设置了 `CODEX_HOME` 时使用其下面的 `ipc/ipc.sock`。一般无需额外配置。如果桌面端使用不同路径，可以在 `.env` 指定：

```dotenv
# 必须是当前用户拥有的本地 Unix socket，不能填写手机地址或 TCP 端口。
POCKET_DESKTOP_SOCKET=/home/your-user/.codex/ipc/ipc.sock
```

`CODEX_BIN` 仍用于本机聊天列表、历史读取及 Pocket 自建聊天。桌面同步的发消息、审批、停止通过 IPC 转交桌面端，不会再次 resume 该聊天或抢占写入锁。

**看到“工作目录不在允许的项目范围内”：** 检查旧 `.env` 是否仍限制到某个项目目录。需要全部工作空间时，改为 `POCKET_ROOTS=/`，然后重启 Pocket；需要保留限制时，将目标目录加入列表（英文分号分隔）。目录已删除时仍需先恢复目录。

| 页面状态 | 实际含义 |
| --- | --- |
| 历史查看 | 仅读取已保存内容，不能据此判断桌面端是否仍在执行 |
| 桌面同步 · 已连接 | 手机与桌面控制同一聊天，实时状态来自桌面端 |
| 桌面同步 · 已断开 | 控制暂停；桌面任务可能仍在运行，重新连接后核对状态 |
| 由 Pocket 继续 | 独立执行模式，任务由 Pocket 自己的 app-server 持有 |

### 断线和兼容性

- 网页显示 **「连接已断开」** 时，手机到 Pocket 的实时连接需要恢复。连接断开、握手超时或前台心跳超时后，网页会自动重连。切回前台时会继续使用健康的连接。主机持续接收桌面事件，手机重连后刷新展示。若发送结果待确认，先核对聊天记录。
- 聊天显示 **「桌面同步 · 已断开」** 时，Pocket 和桌面应用之间的本机连接已断开，旧审批失效，未发送的排队消息取消。让桌面保持打开并打开对应聊天，再点「连接桌面同步」。
- 重启 Pocket 服务会中断 **Pocket 自己执行**的轮次。桌面应用中的轮次继续运行，需要在网页重新连接桌面同步。
- **版本范围：** 实测 Linux 桌面 `26.1103.31037`，状态流版本 `11`。内部协议可能随桌面升级变化；不匹配时停止控制并显示错误，不能承诺其他版本、Windows 或 macOS 已验证。
- **内容范围：** 同步文字、命令输出、文件修改记录和支持的审批/问题。桌面专属画布、浏览器交互、图片等不等同于桌面画面镜像；无法处理的请求应在桌面完成。
- **任务归属：** 只连接桌面已持有的聊天，不保证可连接单独 CLI/VS Code 进程。桌面同步遵循该聊天原有权限；不会为了手机控制自动降低审批要求。

历史列表首次读取最近 50 条非归档聊天，可继续加载。名称、置顶和搜索仍在每台主机内管理。普通历史按轮次分页，桌面同步首次获取完整桌面聊天状态后按消息分页展示；非常大的聊天可能超过桥接帧大小限制并报错。

### 原来的独立执行方式

如果需要让任务完全由 Pocket 执行，在原端结束任务并释放聊天后，展开 **“其他继续方式” → “在 Pocket 中继续”**。任务结束、队列清空后可释放聊天。这个模式与“桌面同步”不同，不能用另一个 app-server 控制桌面正在运行的任务。

实测与边界见 [桌面桥接验证](docs/verification.md#桌面-ipc-桥接)。

## 完成第一个任务

1. 点击聊天列表顶部的 **＋ / 新建聊天**。
2. 输入聊天名称，选择主机上的工作目录；可点击“收藏当前目录”，方便下次使用。
3. 模型可保持“使用 Codex 默认模型”，点击“创建聊天”。
4. 输入一条简单指令，例如：**“请说明这个项目的目录结构，暂时不要修改文件。”**
5. 点击“发送”，观察消息流和状态。需要你决定时会出现审批卡片或问题。
6. 切换到其他聊天或关闭浏览器，原任务仍在主机运行。重新打开网页后会恢复显示。

相同工作目录的任务按顺序执行；不同工作目录可以并行。手机上点击左上角返回按钮回到聊天列表，电脑上可直接点击侧栏切换。

## 安卓手机连接主机

访问链路是 **安卓浏览器 → Cloudflare HTTPS / WebSocket → 主机上的 `cloudflared` → `127.0.0.1:4310` 上的 Pocket**。浏览器通过同一个 HTTPS 地址收发消息和接收实时事件。主机向 Cloudflare 发起出站连接，无需公网 IP 或路由器端口转发。

以下以 **Ubuntu / Linux、Bash、`pocket.example.com`** 为例。用你自己的域名替换示例，先完成[本机安装、构建和固定密码设置](#先在电脑上启动并登录)。如果已有自己的 Pocket HTTPS 地址，可直接跳到[安卓登录](#5-安卓登录)。

### 1. 在 Cloudflare 准备域名

使用一个你能管理 DNS 的域名，并在 Cloudflare 控制台确认它的状态是 **Active**。已由 Cloudflare 托管的域名可直接用一个空闲子域名，比如 `pocket.example.com`。

如果现有 DNS 托管在别处，先导出并核对网站、邮箱和域名验证记录，例如 A、AAAA、CNAME、MX、TXT。将这些记录复制到 Cloudflare，再在**域名注册商**处换成 Cloudflare 分配的两条域名服务器。如果已启用 DNSSEC，按迁移文档处理旧 DS 记录，等域名激活后再在 Cloudflare 重新启用。切换后验证原有网站和邮件服务。已有站点可以保留原解析目标，继续使用原主机。 [Cloudflare DNS 迁移步骤](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)

### 2. 创建隧道并启动主机连接器

1. 打开 **Cloudflare 控制台 → Networking → Tunnels → Create Tunnel**，给隧道命名，例如 `codex-pocket-home`。
2. 在 Ubuntu 上执行 `dpkg --print-architecture` 查看架构，下载对应的 `cloudflared` `.deb` 包。在下载目录执行 `sudo apt install ./cloudflared-linux-amd64.deb`（将文件名替换为下载的文件名），再运行 `cloudflared --version`。 [Cloudflare 官方安装包](https://developers.cloudflare.com/tunnel/downloads/)
3. 在隧道安装页选择 Linux 和主机架构。从 Cloudflare 生成的安装命令中复制 `service install` 后面的**隧道 Token**。按下面的步骤保存 Token，以当前用户运行连接器。 [Cloudflare 隧道配置步骤](https://developers.cloudflare.com/tunnel/get-started/)

以下命令只在运行 Pocket 的主机终端执行。按提示粘贴 Token 并回车，输入不会回显。Token 文件位于仓库外，权限为 `600`。

```bash
(
  set -eu
  umask 077
  mkdir -p "$HOME/.config/codex-pocket"
  printf '粘贴 Cloudflare 隧道 Token 并回车：'
  IFS= read -rs tunnel_token
  printf '\n'
  test -n "$tunnel_token"
  token_file="$HOME/.config/codex-pocket/cloudflare-tunnel.token"
  printf '%s\n' "$tunnel_token" > "$token_file"
  chmod 600 "$token_file"
)
```

首次安装时，复制下面整段生成并启用用户服务。若已用 Cloudflare 面板的命令安装并启动了系统级 `cloudflared` 服务，直接确认该隧道为 `Healthy`，即可进入下一步。

```bash
(
  set -eu
  cloudflared_bin=$(command -v cloudflared)
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/codex-pocket-cloudflared.service" <<EOF
[Unit]
Description=Cloudflare Tunnel connector for Codex Pocket

[Service]
ExecStart="$cloudflared_bin" tunnel --no-autoupdate --protocol http2 run --token-file %h/.config/codex-pocket/cloudflare-tunnel.token
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now codex-pocket-cloudflared.service
)
```

在 Cloudflare 控制台确认隧道为 **Healthy**。如果主机的出站网络有限制，这个配置需要能连到 Cloudflare 的 TCP `7844`。Token 只用于连接器，手机登录使用独立的 Pocket 主机密码。更换 Token 后，用 `systemctl --user restart codex-pocket-cloudflared` 重新加载。 [Cloudflare 隧道网络要求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

### 3. 配置 Pocket 的 HTTPS 来源

在仓库目录里编辑已有的 `.env`，替换旧的 `POCKET_ORIGIN`。保留已经设置的主机名、工作目录和密码配置路径。

```dotenv
POCKET_HOST=127.0.0.1
POCKET_PORT=4310
POCKET_ORIGIN=https://pocket.example.com
```

等 Pocket 任务结束后重启服务。前台运行时在原终端按 `Ctrl+C`，再执行 `npm start`。如果已经安装后台服务，执行 `systemctl --user restart codex-pocket`；首次设置后台运行见 [Linux 后台运行](#linux-后台运行)。设置公网来源后，电脑也改用相同的 HTTPS 地址。旧地址的浏览器授权不会带到新域名，首次访问需要重新登录。

### 4. 发布并验证子域名

打开刚创建的隧道，进入 **Routes → Add route → Published application**，填写以下内容并发布。

| 字段 | 示例 |
| --- | --- |
| Subdomain | `pocket` |
| Domain | `example.com` |
| Path | 留空，网页、API 和实时事件共用域名 |
| Service URL | `http://127.0.0.1:4310`，端口与 `POCKET_PORT` 一致 |

Cloudflare 会为子域名创建 DNS 记录。若同名记录已存在，先查清原用途再处理。保留默认的 Host 转发，让 Pocket 收到公网域名。发布后登录页可从公网访问，查看聊天和控制任务需要已授权的会话。 [Cloudflare 发布路由说明](https://developers.cloudflare.com/tunnel/get-started/#publish-an-application)

```bash
curl -fsS https://pocket.example.com/api/host
curl -sS -o /dev/null -w '%{http_code}\n' https://pocket.example.com/api/snapshot
```

第一条应返回包含主机名和 `"authMode":"password"` 的 JSON，第二条未带会话，应返回 `401`。从旧版 Tailscale Serve 迁移时，先验证新域名可用。如果这台主机仅为 Pocket 使用 Tailscale，可执行 `sudo systemctl disable --now tailscaled.service` 停止它并关闭开机启动。

### 5. 安卓登录

1. 用安卓浏览器打开你发布的 HTTPS 地址，例如 `https://pocket.example.com`。
2. 输入这台主机的固定密码，给设备起名，勾选「记住此设备（30 天）」。
3. 点击「登录此主机」。查看桌面上的当前任务时，保持桌面 Codex 打开并选择对应聊天，点击「连接桌面同步」。

可把这个地址加入书签或浏览器支持的主屏幕快捷方式。主机需要保持联网、唤醒且 Pocket 和连接器均在运行。公网部署和设备实测进度见[验证记录](docs/verification.md#cloudflare-tunnel-部署)。

## 消息与审批

### 选择指令何时发送

输入框下方的选择器明确区分三种意图：

| 选择 | 什么时候执行 | 适用情况 |
| --- | --- | --- |
| 现在补充 · 当前任务 | 追加到正在执行的轮次 | 补充要求、纠正当前方向 |
| 完成后发送 | 当前轮次成功结束且目录可用后执行 | 提前安排下一步 |
| 仅保存草稿 | 不发送，只保存在当前浏览器 | 先写好，稍后自己决定 |

没有执行中的任务时，默认选项显示“发送新任务”。选择方式后还需要点击右侧对应按钮，如“现在补充”“加入队列”或“保存草稿”。

“稍后发送”可以展开查看和取消。停止任务、任务失败或主机服务重启，会取消该聊天未执行的后续队列。追加指令时若原轮次已经结束，页面会提示失败，不会悄悄改成排队执行。

### 审批、回答与停止

- **审批：** 先核对主机、目录、命令或文件修改、请求原因，再选择批准范围，点击“允许本次”或“拒绝”。长命令和变更详情可展开。
- **批准范围：** 只提供 Codex 当前请求支持的范围。“此会话”范围由 Codex 缓存，可能减少同类操作的后续询问，不代表永久关闭审批；额外权限也可能只适用于当前轮次。
- **回答问题：** 在问题卡片填写或选择答案，再提交。
- **停止：** 点击输入框旁的“停止”。看到“正在停止”表示请求尚待确认，以后续实际状态为准。停止针对这个聊天的当前轮次，不会停止所有聊天；脱离任务生命周期的后台进程不保证一并结束。

### 断线与未发送消息

手机断线时主机可能仍在执行。离线输入保存在当前浏览器，显示“未发送”；恢复连接后，由你确认内容和发送方式再手动发送。

如果显示“发送结果待确认”，先核对聊天记录，确认仍需发送后再勾选确认框。刷新页面不会自动重放消息。聊天草稿按主机和聊天保存，清除浏览器站点数据会清除草稿。

## 整理与设置

| 想做什么 | 在哪里操作 |
| --- | --- |
| 查看需要处理的事项 | 点击“待处理列表”，包含审批、问题和稍后发送队列 |
| 搜索、按状态筛选 | 聊天列表顶部；支持全部、运行中、等我处理、已结束 |
| 改名或置顶聊天 | 打开聊天，点击标题旁的铅笔“整理聊天” |
| 收藏项目目录 | 新建聊天时点击“收藏当前目录”；收藏可再次选择或取消 |
| 查看额度和重置时间 | 点击侧栏底部“账号额度”，可手动刷新 |
| 切换中文 / English | 列表左下角齿轮“设备与连接设置” → “界面语言 / Interface language” |
| 设置或修改主机密码 | 在该主机终端运行 `npm run password:set`，随后重启服务 |
| 查看和撤销设备 | 齿轮 → “设备与连接”，选择对应设备“撤销” |
| 退出当前浏览器 | “设备与连接” → “退出此主机”；不会停止主机任务 |

手机处于聊天详情时，先返回聊天列表，再进入左下角设置。

**语言：** 简体中文和英文即时切换，未登录也能设置。首次访问跟随浏览器的英文偏好，其余语言回退中文。选择保存在当前主机地址的浏览器存储中，不跨主机自动同步。聊天内容、主机名称、目录和 Codex 输出保留原文；时间按所选语言格式和设备时区显示。

**语音：** 点击输入区麦克风并允许浏览器麦克风权限。识别语言跟随界面设置：中文 `zh-CN`，英文 `en-US`。结果仅填入草稿，由你确认发送。远程页面需要 HTTPS；不支持或服务无法连接时，使用安卓键盘的麦克风。Pocket 不部署本地语音模型，也不使用 Codex 账号调用转写接口；浏览器可能把音频交给自身在线服务。

**额度：** 显示当前主机 Codex 实际返回的账号额度及重置时间，不估算还能发送多少条消息。API Key 或自定义供应商可能不返回额度信息。

**字体：** 中英文界面使用随应用部署的阿里巴巴普惠体 3.0，代码和命令使用 IBM Plex Mono。三种普惠体字体文件合计约 16 MB。字体、脚本和样式使用带版本指纹的文件名，可由浏览器缓存。首次打开或缓存清除后，字体加载仍取决于网络速度。

## 连接多台主机

1. 在电脑 A、电脑 B 上分别安装、配置和启动 Pocket，并分别登录各自的 Codex。
2. 为每台主机分别创建 Cloudflare 隧道和子域名，例如 `home-pocket.example.com` 与 `work-pocket.example.com`。在各自的 `.env` 设置对应的 `POCKET_ORIGIN`。
3. 手机网页点击顶部主机名称，进入“切换主机”。
4. 填写另一台主机的名称、HTTPS 地址，点击“添加主机”，再点击该主机进入。
5. 首次访问它时，输入它自己的固定密码并勾选“记住此设备”。之后在有效期内切回来可直接进入。

以后在主机面板中点击目标主机即可切换。原主机任务继续运行；聊天不会迁移，也不会跨主机汇总。主机列表只保存名称和地址，不携带授权凭据。每台主机的密码、设备授权、目录收藏、聊天整理和额度独立。切换过程中只携带主机名称和地址，不携带密码或会话 Cookie。

## 配置参考

`.env` 从 Pocket 当前工作目录读取。更改后重启服务，已设置的系统环境变量优先于 `.env`。

| 变量 | 默认值 / 作用 |
| --- | --- |
| `POCKET_HOST` | `127.0.0.1`，仅本机回环；Cloudflare Tunnel 运行在同一主机时使用此值 |
| `POCKET_PORT` | `4310`；更改端口时同步更新 Cloudflare 路由的 Service URL |
| `POCKET_NAME` | 系统主机名；可改成容易辨认的名称 |
| `POCKET_ORIGIN` | 本地使用时不设置；远程使用时填准确的 HTTPS 来源 |
| `POCKET_ROOTS` | 默认全部目录（Linux 为 `/`）；可用英文分号分隔的绝对路径列表限制范围 |
| `POCKET_DATA_DIR` | `~/.local/share/codex-pocket`，存放 SQLite 等应用数据 |
| `POCKET_AUTH_FILE` | 默认 `POCKET_DATA_DIR/auth.json`；保存密码哈希，建议使用仓库外绝对路径 |
| `CODEX_BIN` | 从 `PATH` 查找 `codex`；后台运行时建议填绝对路径 |
| `POCKET_DESKTOP_SOCKET` | 本机桌面同步的 Unix socket。默认 `~/.codex/ipc/ipc.sock`，设置 `CODEX_HOME` 时改用该目录下的 `ipc/ipc.sock` |

用 `command -v codex` 查看当前可执行文件路径，并将结果填到 `CODEX_BIN`。目录选择会拒绝范围外路径和符号链接跳转；执行工具使用 Codex 的 `workspace-write` 沙箱与 `on-request` 审批策略，目录选择边界不替代操作系统权限控制。

## Linux 后台运行

先完成配置和构建，等任务结束后停止终端中已有的 Pocket 实例，避免端口冲突。在仓库目录运行：

```bash
npm run service:install
systemctl --user daemon-reload
systemctl --user enable --now codex-pocket
```

常用管理命令：

```bash
systemctl --user status codex-pocket    # 查看状态
journalctl --user -u codex-pocket -f    # 持续查看日志，Ctrl+C 仅退出日志查看
systemctl --user restart codex-pocket   # 等 Pocket 自己执行的任务结束后再重启
systemctl --user stop codex-pocket      # 停止服务
systemctl --user start codex-pocket     # 再次启动
```

`service:install` 只生成 `~/.config/systemd/user/codex-pocket.service`，不自动启用；已有文件时拒绝覆盖。日常启动用 `systemctl --user start`，不用重复安装。脚本记录安装时的项目目录、Node 路径和 `PATH`；迁移目录或更换 Node 后需检查服务文件，再执行 `daemon-reload`。

用户退出后服务是否继续运行取决于 systemd 用户管理配置；长期无人值守时按机器管理策略配置 linger。后台服务不会阻止主机休眠。

## 修改密码、忘记密码与撤销设备

- **修改或忘记密码：** 在该主机使用运行 Pocket 的系统用户，进入同一个仓库目录和 `.env` 环境，重新运行 `npm run password:set`。不需要旧密码；这是主机本地管理员操作，网页不提供修改密码接口。
- **生效时机：** 配置文件原子写入后，等任务结束再重启 Pocket。重启前仍使用内存中的旧密码；重启后全部旧设备会话和旧配对码失效，需要用新密码登录。
- **只撤销某台设备：** 设置 → 设备与连接 → 找到设备名称 → 撤销。该设备已连接的事件流会断开，后续接口访问被拒绝；不会停止主机任务。
- **撤销的含义：** 撤销的是一次设备授权。仍知道主机密码的人可以重新登录；如果不再信任某个设备使用者，应修改主机密码并重启。
- **配置损坏或丢失：** 恢复原配置文件，或重新运行设置密码命令。配置格式错误、权限过宽、已启用密码但文件缺失时，服务拒绝启动，不会自动降级为无密码或配对模式。Linux 可用 `chmod 600 /实际路径/auth.json` 修正权限。

主机密码登录每 10 分钟最多接受 10 次尝试（成功与失败都计入），限流记录保存在当前主机数据库中；反向代理地址、转发头或普通重启不能绕过。校验并发最多 2 个，繁忙时稍后再试。HTTPS 入口、来源校验和设备授权继续生效。

## 更新与数据

先等待任务结束，停止 Pocket 服务，并备份实际的 `POCKET_DATA_DIR` 整个目录。若用 `POCKET_AUTH_FILE` 将密码配置放在其他目录，也单独备份该文件。然后在干净的仓库中执行：

```bash
git pull --ff-only
npm ci
npm run check
npm run build
```

前台使用 `npm start`，后台使用 `systemctl --user start codex-pocket`，随后刷新网页。存在本地未提交修改或分叉提交时，先处理自己的修改，不要强制覆盖。

| 数据 | 保存位置 |
| --- | --- |
| 聊天映射、展示记录、收藏、置顶、队列和设备授权 | 当前主机 `POCKET_DATA_DIR` 中的 SQLite |
| Codex 自身历史和登录凭据 | 运行 Codex 的主机用户环境 |
| 输入草稿、语言选择和主机列表 | 当前浏览器、当前站点的本地存储 |
| 主机密码校验配置 | `POCKET_AUTH_FILE`，默认数据目录中的 `auth.json`，仅含盐和哈希 |
| 浏览器登录会话 | 当前浏览器 Cookie，主机保存会话记录 |

不要把数据库或含有凭据的文件提交到 GitHub。主机服务重启后，中断任务需要你检查状态并重新发起；失效审批不能继续批准，服务不会自动重放不确定操作。

## 常见问题

| 现象 | 怎么处理 |
| --- | --- |
| 本机网页打不开 | 确认 `npm start` 或后台服务仍运行；检查终端日志和端口是否为 4310；先完成 `npm run build` |
| `EADDRINUSE` / 端口占用 | 通常已有一个 Pocket 实例运行；使用原实例，或等任务结束后停止它，再启动另一个 |
| 页面提示来源不允许 / 403 | 检查 `.env` 的 `POCKET_ORIGIN` 与浏览器协议、域名、端口完全一致；修改后重启；远程配置后不要再用本地 URL |
| 手机打不开域名 | 检查域名已激活、子域名有解析，以及浏览器使用 `https://`；`127.0.0.1` 在手机上只指手机自己 |
| Cloudflare 显示 `1033` 或隧道离线 | 检查 `systemctl --user status codex-pocket-cloudflared` 和 `journalctl --user -u codex-pocket-cloudflared -n 50`，确认 Token 对应当前隧道、主机联网且 `7844` 出站可用 |
| Cloudflare 显示 `502` | 确认 Pocket 正在运行，并检查路由的 Service URL 是否为 `http://127.0.0.1:4310` 或实际的本机端口 |
| 网页能打开但实时事件掉线 | 区分网页的「连接已断开」和聊天的「桌面同步 · 已断开」，按下文检查对应链路 |
| 密码不正确 | 确认输入的是当前主机的密码；忘记时在对应主机运行 `npm run password:set` 并重启；密码不会自动去掉首尾空格 |
| 登录尝试过多 | 等待当前主机的 10 分钟窗口结束，避免持续重试；重启不会清除限流记录 |
| 改密码后旧密码仍可用 | 配置只在服务启动时读取；确认配置路径一致，并在任务结束后重启 Pocket |
| 配对码无效或过期（旧版兼容模式） | 重新运行 `npm run pair`；确认在服务使用的同一用户、仓库配置和数据目录下生成；一个码不能配对两次 |
| 看不到桌面端已有聊天 | 刷新网页后点击“刷新本机聊天”；确认 Pocket 与桌面端使用同一系统用户和 Codex 环境；更早聊天需加载更多 |
| 已有聊天提示占用 | 先结束原端任务并释放聊天；必要时退出原端应用，随后再点击“在 Pocket 中继续” |
| 提示 Codex 暂未就绪 | 在主机检查 `codex login status`、`CODEX_BIN` 和服务日志；修正后重启 Pocket |
| 找不到目标项目目录 | 使用 `POCKET_ROOTS=/` 开放全部目录，或加入目标目录后重启；目录需存在且当前系统用户有访问权限 |
| 页面无实时更新 | 查看连接状态；主机可能仍在执行，重连后核对记录，不要反复点击发送；重启服务会影响任务 |
| 状态是排队中 | 同一目录可能已有任务；等待前一个任务结束，或选择另一个工作目录 |
| 语音识别不可用 | 使用 HTTPS，检查麦克风权限及浏览器语音服务网络；仍不可用就用安卓键盘语音 |
| 字体第一次打开较慢 | 中文字体下载量较大，页面会先用系统字体显示；后续打开通常可复用浏览器缓存 |
| 桌面同步连接失败 | 保持桌面打开并打开目标聊天；确认同一系统用户、socket 路径、工作目录范围和桌面协议版本 |
| 停止后仍有某个后台进程 | 停止只中断指定轮次；检查主机上是否有独立运行的后台进程 |

### 排查远程连接断线或延迟

在 Ubuntu 主机终端运行以下命令，将域名和 `4310` 换成实际配置。设置了 `POCKET_ORIGIN` 时，本机探测用相同域名的 `Host` 请求头。

```bash
pocket_host=pocket.example.com
curl -fsS --max-time 10 -H "Host: $pocket_host" http://127.0.0.1:4310/api/host
curl -fsS --max-time 10 "https://$pocket_host/api/host"
journalctl --user -u codex-pocket-cloudflared --since '20 minutes ago'
```

- 本机响应正常、HTTPS 超时，且日志出现 Cloudflare 边缘连接断开或反复重连时，检查运行 `cloudflared` 的主机出口、代理规则和 `7844` 出站。面板安装的系统服务日志使用 `sudo journalctl -u cloudflared`。 [Cloudflare 隧道排障](https://developers.cloudflare.com/tunnel/troubleshooting/)
- HTTPS 可访问且只有某条聊天显示「桌面同步 · 已断开」时，检查对应桌面应用和聊天是否仍打开，在 Pocket 中重新连接该聊天。连接恢复后先核对任务状态、消息和审批。

## 开发与验证

```bash
npm run dev          # 主机服务，代码变更会重启并中断活跃任务
npm run dev:web      # Vite，http://127.0.0.1:5173
npm run check
npm test
npm run verify:vendor
npm run build
```

开发时不设置 `POCKET_ORIGIN`，使用本地回环地址。Vite 把 `/api` 和 WebSocket 代理到 4310，浏览器在开发来源单独登录（未配置密码的旧版主机使用配对）。

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
