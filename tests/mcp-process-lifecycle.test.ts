import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(repoRoot, 'bin', 'kx.js');

async function makeProjectRoot(embedding = { model: 'test', dimensions: 2 }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kx-mcp-process-'));
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'process-lifecycle-fixture',
    index: './index.sqlite',
    sources: [],
    embedding,
  }));
  return root;
}

/** Faz o handshake e uma busca, o que força a carga real do modelo. */
async function handshakeAndSearch(child: ChildProcess): Promise<void> {
  const send = (message: unknown): void => { child.stdin?.write(`${JSON.stringify(message)}\n`); };
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kx-process-test', version: '1.0.0' },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'search', arguments: { query: 'carrega o modelo', top: 1 } },
  });
}

function startServer(root: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [entrypoint, 'mcp', '--cwd', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Resolve com o resultado da saída, ou rejeita se o processo passar do prazo.
 *
 * A checagem do estado já registrado vem antes da espera pelo evento: se o
 * processo encerrou entre o momento em que ficou pronto e esta chamada, o
 * evento `exit` já passou e esperar por ele travaria até o prazo.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<Exit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`o processo continuou vivo após ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Espera o servidor anunciar que subiu, para não medir ociosidade antes da hora. */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('o servidor não sinalizou inicialização')), timeoutMs);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes('MCP server kx iniciado')) {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        resolve();
      }
    };
    child.stderr?.on('data', onData);
  });
}

test('o processo encerra sozinho após o período de ociosidade', { timeout: 60_000 }, async (t) => {
  const root = await makeProjectRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = startServer(root, {
    KX_MCP_IDLE_SHUTDOWN_MINUTES: '0.02',
    KX_MCP_CHECK_INTERVAL_MS: '100',
  });

  await waitForReady(child, 30_000);
  const exit = await waitForExit(child, 20_000);

  assert.notEqual(exit.signal, 'SIGABRT', 'o encerramento não pode abortar');
});

test('encerra por ociosidade mesmo com o modelo de embedding carregado', { timeout: 180_000 }, async (t) => {
  // O runtime de inferência aborta se o processo for desmontado à força
  // enquanto tem threads nativas ativas. Este é o caminho que exercita isso.
  const root = await makeProjectRoot({ model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 });
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = startServer(root, {
    KX_MCP_IDLE_SHUTDOWN_MINUTES: '0.15',
    KX_MCP_CHECK_INTERVAL_MS: '500',
    KX_EMBEDDER_IDLE_UNLOAD_MINUTES: '0',
  });

  await waitForReady(child, 60_000);
  await handshakeAndSearch(child);
  const exit = await waitForExit(child, 120_000);

  assert.notEqual(exit.signal, 'SIGABRT', 'o encerramento não pode abortar');
});

test('o processo permanece vivo enquanto a ociosidade está desativada', { timeout: 60_000 }, async (t) => {
  const root = await makeProjectRoot();
  const child = startServer(root, {
    KX_MCP_IDLE_SHUTDOWN_MINUTES: '0',
    KX_MCP_CHECK_INTERVAL_MS: '100',
  });
  t.after(async () => {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  await waitForReady(child, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  assert.equal(child.exitCode, null, 'sem limite de ociosidade o processo não deve encerrar sozinho');
});

test('fechar a entrada padrão encerra o processo', { timeout: 60_000 }, async (t) => {
  const root = await makeProjectRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = startServer(root, {
    KX_MCP_IDLE_SHUTDOWN_MINUTES: '0',
    KX_MCP_CHECK_INTERVAL_MS: '100',
  });

  await waitForReady(child, 30_000);
  child.stdin?.end();
  const exit = await waitForExit(child, 20_000);

  assert.notEqual(exit.signal, 'SIGABRT', 'o encerramento não pode abortar');
});

test('SIGTERM encerra o processo sem abortar', { timeout: 60_000 }, async (t) => {
  const root = await makeProjectRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = startServer(root, {
    KX_MCP_IDLE_SHUTDOWN_MINUTES: '0',
    KX_MCP_CHECK_INTERVAL_MS: '100',
  });

  await waitForReady(child, 30_000);
  child.kill('SIGTERM');
  const exit = await waitForExit(child, 20_000);

  // O tratamento padrão do Node para SIGTERM já encerra corretamente. O que não
  // pode acontecer é o processo abortar durante a finalização.
  assert.notEqual(exit.signal, 'SIGABRT', 'o encerramento não pode abortar');
});
