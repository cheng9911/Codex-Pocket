import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.platform !== 'linux') throw new Error('此脚本只生成 Linux systemd 用户服务。');
const root = resolve('.');
if (/[\r\n]|[ \t\\]$/u.test(root)) throw new Error('项目路径无法安全写入 systemd 的 WorkingDirectory。');
const quote = (v: string) =>
  '"' + v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const dir = join(homedir(), '.config', 'systemd', 'user');
await mkdir(dir, { recursive: true });
const path = join(dir, 'codex-pocket.service');
await writeFile(
  path,
  `[Unit]
Description=Codex Pocket host service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${quote(process.execPath)} ${quote(join(root, 'node_modules/tsx/dist/cli.mjs'))} ${quote(join(root, 'apps/server/src/index.ts'))}
Environment=${quote('PATH=' + process.env.PATH)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  `已生成 ${path}，尚未启用。执行以下命令启用：\nsystemctl --user daemon-reload\nsystemctl --user enable --now codex-pocket`,
);
