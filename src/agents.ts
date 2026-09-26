/**
 * Detecção de agentes de código instalados e registro do kx como MCP server
 * no escopo do projeto.
 *
 * O registro usa o executável do Node e o caminho absoluto de bin/kx.js em vez
 * do comando `kx`: aplicativos de interface gráfica (Cursor, Claude Desktop)
 * não herdam o PATH do shell, e no Windows um `.cmd` exige wrapper extra.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export type AgentId = 'claude' | 'codex' | 'cursor';

export interface AgentInfo {
  id: AgentId;
  name: string;
  detected: boolean;
  /** Arquivo de configuração MCP do projeto, relativo à raiz. */
  file: string;
}

export interface Launcher {
  command: string;
  args: string[];
}

const AGENTS: Array<{ id: AgentId; name: string; bins: string[]; homes: string[]; file: string }> = [
  { id: 'claude', name: 'Claude Code', bins: ['claude'], homes: ['.claude'], file: '.mcp.json' },
  { id: 'codex', name: 'Codex', bins: ['codex'], homes: ['.codex'], file: '.codex/config.toml' },
  { id: 'cursor', name: 'Cursor', bins: ['cursor'], homes: ['.cursor'], file: '.cursor/mcp.json' },
];

function onPath(bin: string, pathEnv = process.env.PATH ?? ''): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return pathEnv.split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, bin + ext))));
}

export function detectAgents(home = homedir()): AgentInfo[] {
  return AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    file: agent.file,
    detected: agent.bins.some((bin) => onPath(bin)) || agent.homes.some((dir) => existsSync(join(home, dir))),
  }));
}

/** Comando estável para iniciar o MCP do kx em modo fail-closed. */
export function mcpLauncher(projectRoot: string): Launcher {
  const kxEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kx.js');
  return {
    // KX_NODE vem do comando instalado e aponta para runtime/current, que
    // continua válido quando o instalador atualiza o Node.
    command: process.env.KX_NODE || process.execPath,
    args: [kxEntry, 'mcp', '--strict-project-root', '--project-root', projectRoot],
  };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} não contém um objeto JSON.`);
  }
  return parsed as Record<string, unknown>;
}

/** Mescla o servidor `kx` em um arquivo no formato `{ mcpServers: {...} }`, preservando os demais. */
export function writeJsonMcp(path: string, launcher: Launcher): 'created' | 'updated' | 'unchanged' {
  const existed = existsSync(path);
  const data = readJson(path);
  const servers = (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}) as Record<string, unknown>;
  const next = { command: launcher.command, args: launcher.args };
  if (JSON.stringify(servers.kx) === JSON.stringify(next)) return 'unchanged';
  data.mcpServers = { ...servers, kx: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return existed ? 'updated' : 'created';
}

const tomlString = (value: string) => JSON.stringify(value);

/**
 * Escreve a seção `[mcp_servers.kx]` no config.toml do Codex. Substitui só a
 * própria seção (até o próximo cabeçalho) e mantém o resto do arquivo intacto.
 */
export function writeCodexToml(path: string, launcher: Launcher, projectRoot: string): 'created' | 'updated' | 'unchanged' {
  const existed = existsSync(path);
  const current = existed ? readFileSync(path, 'utf-8') : '';
  const section = [
    '[mcp_servers.kx]',
    `command = ${tomlString(launcher.command)}`,
    `args = [${launcher.args.map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(projectRoot)}`,
  ].join('\n');

  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '[mcp_servers.kx]');
  let next: string;
  if (start === -1) {
    const base = current.replace(/\s*$/, '');
    next = base ? `${base}\n\n${section}\n` : `${section}\n`;
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    const before = lines.slice(0, start).join('\n').replace(/\s*$/, '');
    const after = lines.slice(end).join('\n').replace(/^\s*/, '').replace(/\s*$/, '');
    next = [before, section, after].filter(Boolean).join('\n\n') + '\n';
  }
  if (next === current) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return existed ? 'updated' : 'created';
}

export function registerAgent(agent: AgentInfo, projectRoot: string, launcher = mcpLauncher(projectRoot)) {
  const target = join(projectRoot, agent.file);
  const result = agent.id === 'codex'
    ? writeCodexToml(target, launcher, projectRoot)
    : writeJsonMcp(target, launcher);
  return { target, result };
}

/** Verifica se o projeto já registra o kx no arquivo do agente. */
export function isRegistered(agent: AgentInfo, projectRoot: string): boolean {
  const target = join(projectRoot, agent.file);
  if (!existsSync(target)) return false;
  const raw = readFileSync(target, 'utf-8');
  if (agent.id === 'codex') return raw.split(/\r?\n/).some((l) => l.trim() === '[mcp_servers.kx]');
  try {
    const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Boolean(data.mcpServers?.kx);
  } catch {
    return false;
  }
}
