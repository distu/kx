import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome, loadConfig } from '../src/config.js';
import { buildConfig, DEFAULT_DENY, parseSetupArgs, slugify } from '../src/setup.js';
import { isRegistered, writeCodexToml, writeJsonMcp, type AgentInfo } from '../src/agents.js';

const launcher = { command: '/opt/kx/node', args: ['/opt/kx/bin/kx.js', 'mcp', '--strict-project-root', '--project-root', '/p'] };

test('expandHome resolve ~ para o diretório do usuário', () => {
  assert.equal(expandHome('~/.kx/data/a.sqlite'), resolve(homedir(), '.kx/data/a.sqlite'));
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('./rel/a.sqlite'), './rel/a.sqlite');
  assert.equal(expandHome('/abs/~/a.sqlite'), '/abs/~/a.sqlite');
});

test('loadConfig não cria diretório literal "~" dentro do projeto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kx-home-'));
  try {
    await writeFile(join(root, '.kx.json'), JSON.stringify({ project: 'x', index: '~/.kx/data/x.sqlite', sources: [] }));
    const config = loadConfig(root);
    assert.equal(config.index, resolve(homedir(), '.kx/data/x.sqlite'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('slugify gera nome de índice seguro', () => {
  assert.equal(slugify('Meu Projeto Ágil!'), 'meu-projeto-agil');
  assert.equal(slugify('___'), 'projeto');
});

test('buildConfig inclui só as fontes que existem, denylist e asserção MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kx-setup-'));
  try {
    await mkdir(join(root, '.vault'));
    const counts = new Map([['md', 3], ['ts', 10], ['py', 2], ['yml', 1], ['png', 5]]);
    const config = buildConfig(root, counts, '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    assert.deepEqual(config.sources.map((s) => s.type), ['docs', 'vault', 'code', 'config']);
    assert.equal(config.sources[2].glob, '**/*.{ts,py}');
    assert.equal(config.sources[3].glob, '**/*.yml');
    assert.deepEqual(config.indexing.deny, DEFAULT_DENY);
    assert.equal(config.mcp.projectId, '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
    assert.match(config.index, /^~\/\.kx\/data\/kx-setup-.+\.sqlite$/);

    // A configuração gerada precisa ser aceita pelo validador real.
    await writeFile(join(root, '.kx.json'), JSON.stringify(config));
    const loaded = loadConfig(root);
    assert.equal(loaded.mcp?.projectId, '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeJsonMcp preserva outros servidores e é idempotente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kx-mcpjson-'));
  const file = join(root, '.mcp.json');
  try {
    await writeFile(file, JSON.stringify({ mcpServers: { outro: { command: 'x' } }, extra: true }));
    assert.equal(writeJsonMcp(file, launcher), 'updated');
    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(data.mcpServers.outro, { command: 'x' });
    assert.equal(data.extra, true);
    assert.deepEqual(data.mcpServers.kx, launcher);
    assert.equal(writeJsonMcp(file, launcher), 'unchanged');
    assert.equal(writeJsonMcp(join(root, '.cursor', 'mcp.json'), launcher), 'created');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeCodexToml substitui só a própria seção', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kx-codex-'));
  const file = join(root, 'config.toml');
  try {
    await writeFile(file, 'model = "x"\n\n[mcp_servers.kx]\ncommand = "antigo"\n\n[mcp_servers.outro]\ncommand = "y"\n');
    assert.equal(writeCodexToml(file, launcher, '/p'), 'updated');
    const text = await readFile(file, 'utf-8');
    assert.equal(text.match(/\[mcp_servers\.kx\]/g)?.length, 1);
    assert.match(text, /model = "x"/);
    assert.match(text, /\[mcp_servers\.outro\]\ncommand = "y"/);
    assert.doesNotMatch(text, /antigo/);
    assert.match(text, /cwd = "\/p"/);
    assert.equal(writeCodexToml(file, launcher, '/p'), 'unchanged');

    const agent: AgentInfo = { id: 'codex', name: 'Codex', detected: true, file: 'config.toml' };
    assert.equal(isRegistered(agent, root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseSetupArgs entende modo não interativo', () => {
  const o = parseSetupArgs(['--yes', '--no-index', '--agents', 'claude,cursor,foo', '--project-root', '/p']);
  assert.equal(o.yes, true);
  assert.equal(o.index, false);
  assert.deepEqual(o.agents, ['claude', 'cursor']);
  assert.equal(o.projectRoot, '/p');
});
