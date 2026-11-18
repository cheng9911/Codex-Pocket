import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { makePasswordConfig, savePasswordConfig } from '../apps/server/src/password.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = process.env.POCKET_DATA_DIR ?? join(homedir(), '.local', 'share', 'codex-pocket');
const path = resolve(process.env.POCKET_AUTH_FILE ?? join(directory, 'auth.json'));
async function readPassword() {
  if (process.argv.includes('--stdin')) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY)
    throw new Error('请在交互终端运行；自动化输入可使用 --stdin，勿将密码写入命令行参数');
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  const abort = new AbortController();
  prompt.on('SIGINT', () => abort.abort());
  try {
    process.stdout.write('设置此主机密码（输入不回显）：');
    const password = await prompt.question('', { signal: abort.signal });
    process.stdout.write('\n再次输入密码：');
    const confirmation = await prompt.question('', { signal: abort.signal });
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('两次密码不一致，未修改配置');
    return password;
  } finally {
    prompt.close();
  }
}
try {
  const config = await makePasswordConfig(await readPassword());
  await savePasswordConfig(path, config);
  console.log(
    `密码配置已保存：${path}\n文件仅保存加盐哈希。重启 Pocket 后生效，旧设备授权将全部撤销。`,
  );
} catch (error) {
  console.error(
    error instanceof Error && error.name === 'AbortError'
      ? '\n已取消，未修改配置。'
      : (error as Error).message,
  );
  process.exitCode = 1;
}
