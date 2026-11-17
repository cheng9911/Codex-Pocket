import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const upstream = JSON.parse(
  await readFile(new URL('../packages/codex-transport/UPSTREAM.json', import.meta.url), 'utf8'),
);
for (const file of upstream.files) {
  const bytes = await readFile(file.path);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    file.sha256,
    `Unexpected upstream edit: ${file.path}`,
  );
}
console.log(`Verified ${upstream.files.length} unchanged upstream files at ${upstream.commit}`);
