// Registry de projetos do KX Cockpit (daemon kxd).
// Cada projeto vira uma aba no Cockpit. Fonte: ~/.kx/cockpit/projects.json.
// Se ausente, faz bootstrap descobrindo .kx.json nas raízes configuradas (nunca desce dentro
// de um projeto ja identificado). Isolamento: cada entrada aponta para o projectRoot proprio;
// o servidor valida o .kx.json antes de carregar qualquer config.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';

export interface ProjectEntry {
  id: string;      // = campo "project" do .kx.json (chave estavel, nao o path)
  name: string;
  color: string;
  order: number;
  path: string;    // projectRoot (diretorio do .kx.json)
}

const COCKPIT_DIR = resolve(homedir(), '.kx', 'cockpit');
// Permite apontar o registry para outro arquivo (util em testes/isolamento).
const REGISTRY_FILE = resolve(process.env.KX_COCKPIT_REGISTRY || resolve(COCKPIT_DIR, 'projects.json'));
const DISCOVERY_ROOTS = (process.env.KX_DISCOVERY_ROOTS || '')
  .split(process.platform === 'win32' ? ';' : ':')
  .map(root => root.trim())
  .filter(Boolean)
  .map(root => resolve(root));
if (DISCOVERY_ROOTS.length === 0) {
  DISCOVERY_ROOTS.push(resolve(homedir(), 'Projects'), resolve(homedir(), 'projects'));
}
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.vault', '.claude', 'coverage']);
const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#38bdf8', '#a855f7', '#ef4444', '#14b8a6'];

function readProjectName(kxJsonPath: string): string | null {
  try {
    const p = JSON.parse(readFileSync(kxJsonPath, 'utf-8'));
    return typeof p.project === 'string' && p.project.trim() ? p.project.trim() : null;
  } catch {
    return null;
  }
}

// Walk bounded: para de descer ao encontrar um .kx.json (um projeto nao contem outro).
function discover(root: string, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(root)) return;
  if (existsSync(join(root, '.kx.json'))) { out.push(root); return; }
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith('.')) continue;
    const p = join(root, e);
    try { if (statSync(p).isDirectory()) discover(p, depth - 1, out); } catch { /* ignora */ }
  }
}

export function bootstrapRegistry(): ProjectEntry[] {
  const found: string[] = [];
  for (const r of DISCOVERY_ROOTS) discover(r, 6, found);
  const seen = new Set<string>();
  const projects: ProjectEntry[] = [];
  let i = 0;
  for (const path of found.sort()) {
    const name = readProjectName(join(path, '.kx.json'));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    projects.push({ id: name, name, color: PALETTE[i % PALETTE.length], order: i + 1, path });
    i++;
  }
  saveRegistry(projects);
  return projects;
}

export function loadRegistry(): ProjectEntry[] {
  if (existsSync(REGISTRY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
      if (Array.isArray(data.projects) && data.projects.length) return data.projects as ProjectEntry[];
    } catch { /* recria via bootstrap abaixo */ }
  }
  return bootstrapRegistry();
}

export function saveRegistry(projects: ProjectEntry[]): void {
  const dir = dirname(REGISTRY_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify({ projects }, null, 2) + '\n', 'utf-8');
}

export function findProject(id: string): ProjectEntry | undefined {
  return loadRegistry().find(p => p.id === id);
}

export function registryFilePath(): string {
  return REGISTRY_FILE;
}
