import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { indexProject, type IndexerDependencies } from '../src/indexer.js';
import { resolveIndexPath, builtinExclusionReason } from '../src/index-policy.js';
import { VectorDatabase } from '../src/database.js';

const dependencies: IndexerDependencies = {
  initEmbedder: async () => {},
  embed: async () => new Float32Array([0, 1]),
};

async function makeProject(kxJson: Record<string, unknown>, layout: Record<string, string>): Promise<{ root: string; config: KxConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'kx-builtin-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'builtin-test',
    index: './index.sqlite',
    embedding: { model: 'test', dimensions: 2 },
    ...kxJson,
  }));
  return { root, config: loadConfig(root) };
}

function indexedPaths(config: KxConfig): string[] {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    return db.listPaths();
  } finally {
    db.close();
  }
}

test('builtinExclusionReason classifica diretórios, extensões e lockfiles', () => {
  assert.match(builtinExclusionReason('node_modules/lib/index.js') ?? '', /node_modules/);
  assert.match(builtinExclusionReason('worktrees/feat-x/README.md') ?? '', /worktrees/);
  assert.match(builtinExclusionReason('app/build/Main.class') ?? '', /diretório/);
  assert.match(builtinExclusionReason('src/Main.class') ?? '', /\.class/);
  assert.match(builtinExclusionReason('web/app.min.js') ?? '', /\.min\.js/);
  assert.match(builtinExclusionReason('package-lock.json') ?? '', /lockfile/);
  assert.equal(builtinExclusionReason('src/Main.java'), null);
  assert.equal(builtinExclusionReason('docs/decisao-arquitetura.md'), null);
});

test('indexação pula worktrees, artefatos compilados e node_modules sem poluir o relatório', async (t) => {
  const { root, config } = await makeProject(
    { sources: [{ type: 'docs', path: '.', glob: '**/*' }] },
    {
      'docs/legitimo.md': 'Documento legítimo com conteúdo indexável de verdade.',
      'worktrees/feat-x/docs/copia.md': 'Cópia em worktree que não deve ser indexada nunca.',
      'node_modules/pacote/README.md': 'Readme de dependência de terceiro, fora do índice.',
      'app/build/Main.class': 'bytecode simulado com conteúdo comprido o suficiente',
      'app/pubspec.lock': 'lockfile: conteudo gerado que nao tem valor semantico',
    },
  );
  t.after(async () => rm(root, { recursive: true, force: true }));

  const stats = await indexProject(config, 'full', dependencies);

  const paths = indexedPaths(config);
  assert.ok(paths.some(p => p.endsWith('docs/legitimo.md')), 'o documento legítimo deveria estar no índice');
  assert.ok(!paths.some(p => p.includes('worktrees/')), 'worktrees não pode entrar no índice');
  assert.ok(!paths.some(p => p.includes('node_modules/')), 'node_modules não pode entrar no índice');
  assert.ok(!paths.some(p => p.endsWith('.class')), 'bytecode não pode entrar no índice');
  assert.ok(!paths.some(p => p.endsWith('.lock')), 'lockfile não pode entrar no índice');

  // Exclusão embutida é silenciosa: o relatório de bloqueios fica para a denylist do usuário.
  assert.equal(stats.blocked.length, 0);
});

test('fonte apontada explicitamente para dentro de um diretório excluído continua indexável', async (t) => {
  const { root, config } = await makeProject(
    { sources: [{ type: 'docs', path: './worktrees/especial', glob: '**/*.md' }] },
    { 'worktrees/especial/notas.md': 'Fonte explícita dentro de worktrees: a intenção declarada vence.' },
  );
  t.after(async () => rm(root, { recursive: true, force: true }));

  const decision = resolveIndexPath(config, join(root, 'worktrees', 'especial', 'notas.md'), true);
  assert.equal(decision.allowed, true);

  const stats = await indexProject(config, 'full', dependencies);
  assert.equal(stats.filesProcessed, 1);
  assert.ok(indexedPaths(config).some(p => p.endsWith('notas.md')));
});
