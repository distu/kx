import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { VectorDatabase } from '../src/database.js';
import type { IndexerDependencies } from '../src/indexer.js';
import { createIgnoreMatcher, startWatcher, type WatchEvent } from '../src/watcher.js';

const dependencies: IndexerDependencies = {
  initEmbedder: async () => {},
  embed: async () => new Float32Array([0, 1]),
};

async function waitFor(assertion: () => void, timeoutMs = 15_000): Promise<void> {
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
  // No backend override: this exercises the recursive native watcher that runs
  // in production, the one whose absence caused the polling meltdown.
  const handle = startWatcher(config, dependencies, {
    settleMs: 50,
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

test('watcher skips worktree copies, backups and build output entirely', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-watcher-ignored-'));
  await mkdir(join(root, 'docs/worktrees/feature'), { recursive: true });
  await mkdir(join(root, 'docs/node_modules/pkg'), { recursive: true });
  await mkdir(join(root, 'docs/build'), { recursive: true });
  await mkdir(join(root, 'docs/.backups'), { recursive: true });
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'temporary-ignored-test',
    index: './index.sqlite',
    sources: [{ type: 'docs', path: './docs', glob: '**/*.txt' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  const config = loadConfig(root);
  const events: WatchEvent[] = [];
  const handle = startWatcher(config, dependencies, {
    settleMs: 50,
    onEvent: event => events.push(event),
  });
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  await handle.ready;

  const noise = [
    join(root, 'docs/worktrees/feature/copia.txt'),
    join(root, 'docs/node_modules/pkg/dependencia.txt'),
    join(root, 'docs/build/gerado.txt'),
    join(root, 'docs/.backups/antigo.txt'),
  ];
  await Promise.all(noise.map(file => writeFile(file, 'conteúdo que jamais deve ser indexado pelo watcher')));
  // The sentinel is written last and awaited, so the noise above had at least
  // as much time to be picked up had it not been ignored.
  const sentinel = join(root, 'docs', 'sentinela.txt');
  await writeFile(sentinel, 'conteúdo legítimo que precisa ser indexado normalmente');
  await waitFor(() => assert.ok(paths(config).includes('docs/sentinela.txt')));

  const indexedPaths = paths(config);
  assert.deepEqual(indexedPaths, ['docs/sentinela.txt']);
  for (const file of noise) {
    assert.ok(!events.some(event => event.filePath === file), `evento inesperado para ${file}`);
  }
});

test('an ignored directory name above the observed root does not disable the source', () => {
  const insideWorktree = '/repo/worktrees/feature/docs';
  const isIgnored = createIgnoreMatcher([insideWorktree]);

  assert.equal(isIgnored(join(insideWorktree, 'guia.md')), false);
  assert.equal(isIgnored(join(insideWorktree, 'worktrees/copia.md')), true);
  assert.equal(isIgnored(join(insideWorktree, 'node_modules/pkg/index.js')), true);
});
