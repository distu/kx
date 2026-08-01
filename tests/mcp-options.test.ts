import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseMcpBootOptions } from '../src/mcp-options.js';

test('strict MCP boot requires an explicit project root', () => {
  assert.throws(
    () => parseMcpBootOptions(['--strict-project-root'], undefined),
    /exige --project-root/i,
  );
});

test('MCP boot accepts project-root, legacy cwd and environment without ambiguity', () => {
  const root = resolve('/tmp/kx-explicit-root');
  assert.equal(parseMcpBootOptions(['--project-root', root], undefined).projectRoot, root);
  assert.equal(parseMcpBootOptions(['--cwd', root], undefined).projectRoot, root);
  assert.equal(parseMcpBootOptions([], root).projectRoot, root);
  assert.throws(
    () => parseMcpBootOptions(['--project-root', root, '--cwd', `${root}-other`], undefined),
    /raízes diferentes/i,
  );
  assert.throws(
    () => parseMcpBootOptions(['--project-root', root, '--project-root', root], undefined),
    /uma única vez/i,
  );
  assert.throws(
    () => parseMcpBootOptions(['--unknown'], undefined),
    /opção MCP desconhecida/i,
  );
});

test('an explicit missing root never falls back to another project configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-missing-explicit-root-'));
  const validRoot = await mkdtemp(join(tmpdir(), 'kx-valid-explicit-root-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(validRoot, { recursive: true, force: true });
  });

  assert.throws(() => loadConfig(root), /não encontrada na raiz explícita/i);

  await writeFile(join(validRoot, '.kx.json'), JSON.stringify({
    project: 'valid',
    index: './index.sqlite',
    mcp: { projectId: '33333333-3333-4333-8333-333333333333' },
    sources: [],
  }));
  assert.equal(loadConfig(validRoot).mcp?.projectId, '33333333-3333-4333-8333-333333333333');
});

test('mcp.projectId must be a UUID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-invalid-project-id-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'invalid',
    index: './index.sqlite',
    mcp: { projectId: 'shared-label' },
    sources: [],
  }));

  assert.throws(() => loadConfig(root), /UUID válido e exclusivo/i);
});

test('a malformed mcp block never falls back to unprotected legacy mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-invalid-mcp-block-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const baseConfig = {
    project: 'invalid',
    index: './index.sqlite',
    sources: [],
  };

  for (const malformed of ['project-id', [], {}, { projectID: '33333333-3333-4333-8333-333333333333' }]) {
    await writeFile(join(root, '.kx.json'), JSON.stringify({ ...baseConfig, mcp: malformed }));
    assert.throws(() => loadConfig(root), /mcp (deve|aceita)/i);
  }
});
