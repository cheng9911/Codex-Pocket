import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PasswordConfig = { version: 1; algorithm: 'scrypt'; salt: string; hash: string };
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) throw new Error('密码不能为空');
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function makePasswordConfig(password: string): Promise<PasswordConfig> {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return {
    version: 1,
    algorithm: 'scrypt',
    salt,
    hash: (await derive(password, salt)).toString('hex'),
  };
}
export async function verifyPassword(password: string, config: PasswordConfig) {
  return timingSafeEqual(await derive(password, config.salt), Buffer.from(config.hash, 'hex'));
}
export async function loadPasswordConfig(path: string): Promise<PasswordConfig | undefined> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error('密码配置必须是小于 4 KB 的普通文件');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('密码配置权限过宽，请设置为 600');
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('密码配置格式无效，请运行 npm run password:set 重新设置');
  }
  if (
    data?.version !== 1 ||
    data?.algorithm !== 'scrypt' ||
    typeof data.salt !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.salt) ||
    typeof data.hash !== 'string' ||
    !/^[a-f0-9]{128}$/.test(data.hash)
  )
    throw new Error('密码配置格式无效，请运行 npm run password:set 重新设置');
  return { version: 1, algorithm: 'scrypt', salt: data.salt, hash: data.hash };
}
export async function savePasswordConfig(path: string, config: PasswordConfig) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(config, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
