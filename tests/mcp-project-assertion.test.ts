import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type KxConfig } from '../src/config.js';
import { createMcpServer } from '../src/mcp-server.js';

const PROJECT_ID_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID_B = '22222222-2222-4222-8222-222222222222';

async function makeProject(projectId?: string): Promise<{ root: string; config: KxConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'kx-mcp-scope-'));
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'same-human-readable-label',
    index: './index.sqlite',
    ...(projectId ? { mcp: { projectId } } : {}),
    sources: [],
    embedding: { model: 'test', dimensions: 2 },
  }));
  return { root, config: loadConfig(root) };
}

async function connect(config: KxConfig): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(config);
  const client = new Client({ name: 'kx-test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

function scope(root: string, projectId: string): {
  expected_project_id: string;
  expected_project_root: string;
} {
  return {
    expected_project_id: projectId,
    expected_project_root: root,
  };
}

test('protected MCP tools require the active project UUID in their schemas', async (t) => {
  const { root, config } = await makeProject(PROJECT_ID_A);
  const connection = await connect(config);
  t.after(async () => {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await connection.client.listTools();
  const expectedTools = [
    'search',
    'ingest',
    'reindex',
    'status',
    'megabrain_add',
    'megabrain_update',
    'megabrain_status',
    'megabrain_get',
  ];
  assert.deepEqual(listed.tools.map(tool => tool.name), expectedTools);
  for (const tool of listed.tools) {
    assert.ok(tool.inputSchema.required?.includes('expected_project_id'), tool.name);
    assert.ok(tool.inputSchema.required?.includes('expected_project_root'), tool.name);
  }
});

test('missing or mismatched project assertion fails before any project data is opened', async (t) => {
  const { root, config } = await makeProject(PROJECT_ID_A);
  const connection = await connect(config);
  t.after(async () => {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  });

  const missing = await connection.client.callTool({ name: 'status', arguments: {} });
  assert.equal(missing.isError, true);
  assert.equal(resultText(missing), 'KX_PROJECT_ASSERTION_REQUIRED');
  assert.equal(existsSync(config.index), false);

  const missingRoot = await connection.client.callTool({
    name: 'status',
    arguments: { expected_project_id: PROJECT_ID_A },
  });
  assert.equal(missingRoot.isError, true);
  assert.equal(resultText(missingRoot), 'KX_PROJECT_ASSERTION_REQUIRED');
  assert.equal(existsSync(config.index), false);

  const calls = [
    { name: 'search', arguments: { ...scope(root, PROJECT_ID_B), query: 'synthetic canary' } },
    { name: 'status', arguments: scope(root, PROJECT_ID_B) },
    { name: 'ingest', arguments: { ...scope(root, PROJECT_ID_B), path: join(root, 'canary.md') } },
    { name: 'reindex', arguments: { ...scope(root, PROJECT_ID_B), mode: 'full' } },
    { name: 'megabrain_add', arguments: { ...scope(root, PROJECT_ID_B), titulo: 'canary' } },
    { name: 'megabrain_update', arguments: { ...scope(root, PROJECT_ID_B), slug: 'canary', tipo: 'avanco' } },
    { name: 'megabrain_status', arguments: scope(root, PROJECT_ID_B) },
    { name: 'megabrain_get', arguments: { ...scope(root, PROJECT_ID_B), slug: 'canary' } },
  ];

  for (const call of calls) {
    const result = await connection.client.callTool(call);
    assert.equal(result.isError, true, call.name);
    assert.equal(resultText(result), 'KX_PROJECT_MISMATCH', call.name);
    assert.equal(existsSync(config.index), false, call.name);
    assert.equal(existsSync(join(root, '.vault')), false, call.name);
  }
});

test('matching UUID allows the existing behavior while a matching label is insufficient', async (t) => {
  const protectedA = await makeProject(PROJECT_ID_A);
  const protectedB = await makeProject(PROJECT_ID_B);
  const connectionA = await connect(protectedA.config);
  const connectionB = await connect(protectedB.config);
  t.after(async () => {
    await connectionA.close();
    await connectionB.close();
    await rm(protectedA.root, { recursive: true, force: true });
    await rm(protectedB.root, { recursive: true, force: true });
  });

  assert.equal(protectedA.config.project, protectedB.config.project);

  const mismatch = await connectionA.client.callTool({
    name: 'status',
    arguments: scope(protectedA.root, PROJECT_ID_B),
  });
  assert.equal(mismatch.isError, true);
  assert.equal(resultText(mismatch), 'KX_PROJECT_MISMATCH');
  assert.equal(existsSync(protectedA.config.index), false);

  const allowed = await connectionA.client.callTool({
    name: 'status',
    arguments: scope(protectedA.root, PROJECT_ID_A.toUpperCase()),
  });
  assert.notEqual(allowed.isError, true);
  assert.match(resultText(allowed), /Índice: same-human-readable-label/);
  assert.equal(existsSync(protectedA.config.index), true);

  const duplicatedUuidWrongRoot = await connectionA.client.callTool({
    name: 'status',
    arguments: scope(protectedB.root, PROJECT_ID_A),
  });
  assert.equal(duplicatedUuidWrongRoot.isError, true);
  assert.equal(resultText(duplicatedUuidWrongRoot), 'KX_PROJECT_MISMATCH');
});

test('legacy projects remain compatible until mcp.projectId is configured', async (t) => {
  const { root, config } = await makeProject();
  const connection = await connect(config);
  t.after(async () => {
    await connection.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await connection.client.listTools();
  for (const tool of listed.tools) {
    assert.ok(!tool.inputSchema.required?.includes('expected_project_id'), tool.name);
    assert.ok(!tool.inputSchema.required?.includes('expected_project_root'), tool.name);
  }

  const status = await connection.client.callTool({ name: 'status', arguments: {} });
  assert.notEqual(status.isError, true);
  assert.match(resultText(status), /Índice: same-human-readable-label/);
});
