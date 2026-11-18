#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help ]]; then
  printf '%s\n' '用法：bash scripts/setup-tailscale.sh' \
    '在 Linux 上安装并登录 Tailscale，通过 Serve 转发 Pocket，并写入 .env。' \
    '请用运行 Pocket 的普通用户执行。安装和配置 Tailscale 时脚本会调用 sudo。'
  exit 0
fi

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail '未知参数，请使用 --help 查看用法。'
[[ $(uname -s) == Linux ]] || fail '此脚本适用于 Linux。'
(( EUID != 0 )) || fail '请用运行 Pocket 的普通用户启动脚本，不要对整个脚本使用 sudo。'
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for cmd in node curl sudo systemctl; do
  command -v "$cmd" >/dev/null || fail "缺少命令 $cmd。"
done

port=$(node --input-type=module <<'NODE'
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

if (existsSync('.env') && !lstatSync('.env').isFile()) {
  throw new Error('请使用仓库中的普通 .env 文件。');
}
const config = parseEnv(readFileSync(existsSync('.env') ? '.env' : '.env.example', 'utf8'));
const host = config.POCKET_HOST ?? '127.0.0.1';
const port = Number(config.POCKET_PORT ?? 4310);
if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('请在 .env 中设置 POCKET_HOST=127.0.0.1 和有效的 POCKET_PORT。');
}
console.log(port);
NODE
)
target="http://127.0.0.1:$port"

if ! command -v tailscale >/dev/null; then
  printf '%s\n' '安装 Tailscale 需要 Linux 管理员权限。'
  sudo -v || fail '请在 Ubuntu 主机终端运行本脚本，并在那里输入 sudo 密码。'
  installer=$(mktemp)
  trap 'rm -f -- "$installer"' EXIT
  curl -fsSL --retry 2 --connect-timeout 10 --max-time 30 https://tailscale.com/install.sh -o "$installer"
  sh "$installer"
fi

if ! systemctl is-active --quiet tailscaled; then
  sudo systemctl enable --now tailscaled
fi

status=$(tailscale status --json)
state=$(node -pe 'JSON.parse(process.argv[1]).BackendState' "$status")
if [[ $state != Running ]]; then
  printf '%s\n' '请打开 Tailscale 打印的登录链接，登录你要与安卓手机共用的 tailnet。'
  sudo tailscale up
  status=$(tailscale status --json)
fi

dns=$(node -e '
const status = JSON.parse(process.argv[1]);
const dns = status.Self?.DNSName?.replace(/\.$/, "");
if (status.BackendState !== "Running" || !/^[a-z\d-]+(?:\.[a-z\d-]+)*\.ts\.net$/.test(dns ?? "")) {
  console.error("主机尚未加入 tailnet，或未获得 ts.net 域名。请完成设备登录，检查 MagicDNS 后重试。");
  process.exit(1);
}
console.log(dns);
' "$status")
origin="https://$dns"

serve_state() {
  tailscale serve status --json | node -e '
const config = JSON.parse(require("node:fs").readFileSync(0, "utf8")) ?? {};
const [host, target] = process.argv.slice(1);
const authority = host + ":443";
const rootProxy = config.Web?.[authority]?.Handlers?.["/"]?.Proxy;
const uses443 = c => c.TCP?.["443"] ||
  Object.keys(c.Web ?? {}).some(key => key.endsWith(":443")) ||
  Object.entries(c.AllowFunnel ?? {}).some(([key, enabled]) => enabled && key.endsWith(":443"));
if (Object.values(config.Foreground ?? {}).some(uses443) ||
    Object.entries(config.AllowFunnel ?? {}).some(([key, enabled]) => enabled && key.endsWith(":443"))) {
  console.error("Tailscale 的 443 端口已有前台转发或 Funnel，请先处理现有配置。");
  process.exit(1);
}
if (config.TCP?.["443"]?.HTTPS === true && rootProxy === target) {
  console.log("ready");
} else if (uses443(config)) {
  console.error("Tailscale 的 443 端口已有其他转发，请先通过 tailscale serve status 检查。");
  process.exit(1);
} else {
  console.log("empty");
}
' "$dns" "$target"
}

route=$(serve_state)
if [[ $route == empty ]]; then
  printf '%s\n' '如果 Tailscale 给出启用 HTTPS 的链接，请在浏览器中完成设置。'
  sudo tailscale serve --bg --https=443 "$target"
fi
route=$(serve_state)
[[ $route == ready ]] || fail '尚未确认 HTTPS 转发。完成 Tailscale 的浏览器设置后重跑脚本。'

node --input-type=module - "$origin" <<'NODE'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const origin = process.argv[2];
const existing = existsSync('.env');
const content = readFileSync(existing ? '.env' : '.env.example', 'utf8');
if (!existing || parseEnv(content).POCKET_ORIGIN !== origin) {
  // Node uses the last value for duplicate env keys. Appending preserves quoted multiline values.
  const next = `${content}${content.endsWith('\n') ? '' : '\n'}\n# Tailscale Serve\nPOCKET_ORIGIN=${origin}\n`;
  if (parseEnv(next).POCKET_ORIGIN !== origin) throw new Error('无法写入有效的 POCKET_ORIGIN，请检查 .env 格式。');
  const dir = mkdtempSync('.pocket-env-');
  try {
    const temp = join(dir, '.env');
    writeFileSync(temp, next, { mode: 0o600 });
    renameSync(temp, '.env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
NODE

printf '\n%s\n' "Pocket HTTPS 地址 $origin" "已设置 $PWD/.env 中的 POCKET_ORIGIN。"
if curl --noproxy '*' -fsS --max-time 10 "$origin/api/host" 2>/dev/null | node -e '
try {
  const host = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (typeof host.id !== "string" || !["password", "pairing"].includes(host.authMode)) process.exit(1);
} catch { process.exit(1); }
'; then
  printf '%s\n' 'HTTPS 已通过检查。安卓连接同一 tailnet 后即可打开上述地址。'
else
  printf '%s\n' '请用更新后的 .env 启动 Pocket。若 Pocket 在前台运行，请在原终端用 Ctrl+C 停止后执行 npm start。' \
    '若使用 systemd 用户服务，请执行 systemctl --user restart codex-pocket。' \
    "启动后可用 curl --noproxy '*' -f '$origin/api/host' 验证。"
fi
