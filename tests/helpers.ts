import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/server/src/store.ts';
import { PocketService } from '../apps/server/src/service.ts';
import { openTransport } from '../packages/codex-transport/index.ts';

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pocket-test-'));
  await mkdir(join(root, 'other'));
  const store = new Store(join(root, 'data', 'pocket.sqlite'));
  const service = new PocketService(store, {
    id: store.meta('hostId')!,
    name: 'Test host',
    version: 'test',
  });
  await service.start([root], (options) =>
    openTransport({
      ...options,
      command: process.execPath,
      args: [resolve('tests/fixtures/codex.mjs')],
    }),
  );
  return {
    root,
    store,
    service,
    async close() {
      await service.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function waitFor<T>(store: Store, check: () => T | undefined): Promise<T> {
  const current = check();
  if (current !== undefined) return Promise.resolve(current);
  return new Promise((resolve) => {
    const listener = () => {
      const result = check();
      if (result !== undefined) {
        store.off('event', listener);
        resolve(result);
      }
    };
    store.on('event', listener);
  });
}
