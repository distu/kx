import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { VectorDatabase } from '../src/database.js';
import { indexProject, indexSinglePath, type IndexerDependencies } from '../src/indexer.js';
import { ingestPath } from '../src/mcp-server.js';
import { search } from '../src/searcher.js';
import { processWatcherChange } from '../src/watcher.js';

const CANARY = 'SYNTHETIC_INDEX_DENYLIST_CANARY_7f3c';
const dependencies: IndexerDependencies = {
  initEmbedder: async () => {},
  embed: async () => new Float32Array([0, 1]),
};

async function makeProject(deny?: string[]): Promise<{ root: string; config: KxConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'kx-denylist-'));
  await mkdir(join(root, 'docs', 'private'), { recursive: true });
  await writeFile(join(root, 'docs', 'public.md'), 'This ordinary document is safe to index.');
  await writeFile(join(root, 'docs', 'private', 'canary.md'), `This is ${CANARY}.`);
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'temporary-test',
    index: './index.sqlite',
    ...(deny ? { indexing: { deny } } : {}),
    sources: [{ type: 'docs', path: './docs', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  return { root, config: loadConfig(root) };
}

function indexedContents(config: KxConfig): string[] {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    return db.search(new Float32Array([0, 1]), 50).map(result => result.content);
  } finally {
    db.close();
  }
}

test('configuration without indexing.deny remains compatible', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(config.indexing, undefined);
  const stats = await indexProject(config, 'full', dependencies);
  assert.equal(stats.filesProcessed, 2);
  assert.ok(indexedContents(config).some(content => content.includes(CANARY)));
});

test('denylist blocks full and individual MCP ingestion of a synthetic canary', async (t) => {
  const { root, config } = await makeProject(['docs/private/**']);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const full = await indexProject(config, 'full', dependencies);
  assert.equal(full.filesProcessed, 1);
  assert.equal(full.filesSkipped, 1);
  assert.ok(!indexedContents(config).some(content => content.includes(CANARY)));

  // MCP `ingest` delegates to indexSinglePath, so this is the same admission gate.
  const ingest = await indexSinglePath(config, join(root, 'docs', 'private', 'canary.md'), dependencies);
  assert.equal(ingest.filesProcessed, 0);
  assert.equal(ingest.filesSkipped, 1);
  assert.equal(ingest.errors.length, 0);
  assert.equal(ingest.blocked.length, 1);
  assert.ok(!indexedContents(config).some(content => content.includes(CANARY)));

  const mcpResult = await ingestPath(config, join(root, 'docs', 'private', 'canary.md'), dependencies);
  assert.equal(mcpResult.isError, true);
  assert.match(mcpResult.content[0].text, /bloqueada pela política do projeto/i);
});

test('incremental reindex and watcher purge a path denied after it was indexed', async (t) => {
  const initial = await makeProject();
  t.after(async () => rm(initial.root, { recursive: true, force: true }));

  await indexProject(initial.config, 'full', dependencies);
  assert.ok(indexedContents(initial.config).some(content => content.includes(CANARY)));

  await writeFile(join(initial.root, '.kx.json'), JSON.stringify({
    project: 'temporary-test',
    index: './index.sqlite',
    indexing: { deny: ['docs/private/**'] },
    sources: [{ type: 'docs', path: './docs', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  const deniedConfig = loadConfig(initial.root);

  const incremental = await indexProject(deniedConfig, 'incremental', dependencies);
  assert.equal(incremental.filesPurged, 1);
  assert.ok(!indexedContents(deniedConfig).some(content => content.includes(CANARY)));

  // Simulate an add/change event after policy activation. The watcher calls the
  // same central gate and never puts the canary back into SQLite.
  const watcher = await processWatcherChange(
    deniedConfig,
    join(initial.root, 'docs', 'private', 'canary.md'),
    dependencies,
  );
  assert.ok(watcher);
  assert.equal(watcher.filesSkipped, 1);
  assert.ok(!indexedContents(deniedConfig).some(content => content.includes(CANARY)));
});

test('search reconciles stale denied chunks before returning results', async (t) => {
  const initial = await makeProject();
  t.after(async () => rm(initial.root, { recursive: true, force: true }));

  await indexProject(initial.config, 'full', dependencies);
  assert.ok(indexedContents(initial.config).some(content => content.includes(CANARY)));

  await writeFile(join(initial.root, '.kx.json'), JSON.stringify({
    project: 'temporary-test',
    index: './index.sqlite',
    indexing: { deny: ['./docs/private/**'] },
    sources: [{ type: 'docs', path: './docs', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  const deniedConfig = loadConfig(initial.root);
  assert.deepEqual(deniedConfig.indexing?.deny, ['docs/private/**']);

  const results = await search(deniedConfig, 'canary', 50, 'all', dependencies);
  assert.ok(!results.some(result => result.content.includes(CANARY)));
  assert.ok(!indexedContents(deniedConfig).some(content => content.includes(CANARY)));
});

test('denylist rejects invalid patterns and blocks symlink escapes', async (t) => {
  const project = await makeProject(['docs/private/**']);
  const externalRoot = await mkdtemp(join(tmpdir(), 'kx-denylist-external-'));
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  });

  const externalFile = join(externalRoot, 'outside.md');
  await writeFile(externalFile, `External ${CANARY}.`);
  const externalLink = join(project.root, 'docs', 'outside-link.md');
  await symlink(externalFile, externalLink);

  const escaped = await indexSinglePath(project.config, externalLink, dependencies);
  assert.equal(escaped.filesProcessed, 0);
  assert.equal(escaped.errors.length, 1);
  assert.match(escaped.errors[0], /fora das fontes configuradas/i);

  await writeFile(join(project.root, '.kx.json'), JSON.stringify({
    project: 'temporary-test',
    index: './index.sqlite',
    indexing: { deny: ['../outside/**'] },
    sources: [{ type: 'docs', path: './docs', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  assert.throws(() => loadConfig(project.root), /somente caminhos relativos/i);
});
