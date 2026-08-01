import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { VectorDatabase } from '../src/database.js';
import type { IndexerDependencies } from '../src/indexer.js';
import { startWatcher, type WatchEvent } from '../src/watcher.js';

const dependencies: IndexerDependencies = {
  initEmbedder: async () => {},
  embed: async () => new Float32Array([0, 1]),
};

async function waitFor(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error('Timed out waiting for watcher event');
}

function paths(config: KxConfig): string[] {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    return db.listPaths();
  } finally {
    db.close();
  }
}

function contents(config: KxConfig): string[] {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    return db.search(new Float32Array([0, 1]), 50).map(result => result.content);
  } finally {
    db.close();
  }
}

test('watcher indexes root events with source filters and removes renamed or deleted files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-watcher-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'temporary-watcher-test',
    index: './index.sqlite',
    indexing: { deny: ['docs/denied.txt'] },
    sources: [
      { type: 'docs', path: './docs', glob: '**/*.txt', exclude: ['**/excluded.txt'] },
      { type: 'docs', path: './docs', glob: '.allowed-hidden.txt' },
    ],
    embedding: { model: 'test', dimensions: 2 },
  }));
  const config = loadConfig(root);
  const events: WatchEvent[] = [];
  const handle = startWatcher(config, dependencies, {
    chokidar: {
      usePolling: true,
      interval: 20,
      binaryInterval: 20,
      atomic: false,
      awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 5 },
    },
    onEvent: event => events.push(event),
  });
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  await handle.ready;

  const original = join(root, 'docs', 'tracked.txt');
  await writeFile(original, 'first watcher content that is long enough to be indexed');
  await waitFor(() => assert.ok(paths(config).includes('docs/tracked.txt')));
  assert.ok(contents(config).some(content => content.includes('first watcher content')));

  await writeFile(original, 'second watcher content that replaces the old document in SQLite');
  await waitFor(() => {
    const indexed = contents(config);
    assert.ok(indexed.some(content => content.includes('second watcher content')));
    assert.ok(!indexed.some(content => content.includes('first watcher content')));
  });

  const renamed = join(root, 'docs', 'renamed.txt');
  await rename(original, renamed);
  await waitFor(() => {
    const indexedPaths = paths(config);
    assert.ok(indexedPaths.includes('docs/renamed.txt'));
    assert.ok(!indexedPaths.includes('docs/tracked.txt'));
  });

  await unlink(renamed);
  await waitFor(() => assert.ok(!paths(config).includes('docs/renamed.txt')));

  const offGlob = join(root, 'docs', 'off-glob.md');
  const excluded = join(root, 'docs', 'excluded.txt');
  const denied = join(root, 'docs', 'denied.txt');
  const implicitHidden = join(root, 'docs', '.secret.txt');
  const explicitHidden = join(root, 'docs', '.allowed-hidden.txt');
  await Promise.all([
    writeFile(offGlob, 'off glob content that must never be indexed'),
    writeFile(excluded, 'excluded content that must never be indexed'),
    writeFile(denied, 'denied content that must never be indexed'),
    writeFile(implicitHidden, 'implicit hidden content that must never be indexed'),
    writeFile(explicitHidden, 'explicit hidden content selected intentionally'),
  ]);
  await waitFor(() => {
    const addEvents = events.filter(event => event.event === 'add').map(event => basename(event.filePath));
    assert.ok(addEvents.includes('off-glob.md'));
    assert.ok(addEvents.includes('excluded.txt'));
    assert.ok(addEvents.includes('denied.txt'));
    assert.ok(addEvents.includes('.secret.txt'));
    assert.ok(addEvents.includes('.allowed-hidden.txt'));
    assert.ok(paths(config).includes('docs/.allowed-hidden.txt'));
  });
  const indexedPaths = paths(config);
  assert.ok(!indexedPaths.includes('docs/off-glob.md'));
  assert.ok(!indexedPaths.includes('docs/excluded.txt'));
  assert.ok(!indexedPaths.includes('docs/denied.txt'));
  assert.ok(!indexedPaths.includes('docs/.secret.txt'));
  assert.ok(indexedPaths.includes('docs/.allowed-hidden.txt'));
  assert.ok(events.some(event => event.event === 'add' && basename(event.filePath) === 'excluded.txt' && event.action === 'removed'));
  assert.ok(events.some(event => event.event === 'add' && basename(event.filePath) === 'denied.txt' && event.action === 'removed'));
});
