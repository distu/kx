// Cliente MCP mínimo: sobe o servidor exatamente como o agente faria, a partir
// do .mcp.json do projeto, e chama as tools por JSON-RPC via stdio.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const server = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')).mcpServers.kx;
const projectId = JSON.parse(readFileSync(join(dir, '.kx.json'), 'utf-8')).mcp.projectId;
// A raiz canônica é a que o setup gravou (no Windows, a forma do caminho muda).
const root = server.args[server.args.indexOf('--project-root') + 1];
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, KX_MODELS_DIR: process.env.KX_MODELS_DIR } });

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const lineText = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!lineText.trim()) continue;
    const msg = JSON.parse(lineText);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sandbox', version: '1' } });
console.log('initialize:', init.result.serverInfo.name, init.result.serverInfo.version);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = await rpc('tools/list', {});
console.log('tools:', tools.result.tools.length, tools.result.tools.map((t) => t.name).join(','));

const hit = await rpc('tools/call', { name: 'search', arguments: { expected_project_id: projectId, expected_project_root: root, query: 'circuit-open', top: 3 } });
const text = hit.result.content.map((c) => c.text).join('\n');
console.log('search ok:', !hit.result.isError, '| contém CircuitBreaker:', text.includes('CircuitBreaker'));

const bad = await rpc('tools/call', { name: 'search', arguments: { expected_project_id: '00000000-0000-4000-8000-000000000000', expected_project_root: root, query: 'x' } });
console.log('assert fail-closed:', JSON.stringify(bad.result ?? bad.error).includes('KX_PROJECT_MISMATCH'));

clearTimeout(timeout);
child.kill();
process.exit(!hit.result.isError && text.includes('CircuitBreaker') ? 0 : 1);
