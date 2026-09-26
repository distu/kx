/**
 * `kx setup` — configurador automático de um projeto.
 *
 * 1. Resolve a raiz (topo do repositório Git ou diretório atual).
 * 2. Gera `.kx.json` com fontes detectadas, denylist de segredos e UUID de
 *    asserção MCP (modo fail-closed). Uma configuração existente é preservada.
 * 3. Registra o kx nos agentes detectados (Claude Code, Codex, Cursor).
 * 4. Indexa e prova o índice com uma busca real.
 */
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { detectAgents, registerAgent, type AgentId } from './agents.js';
import { banner, c, confirm, line, spinner, sym } from './term.js';

const CODE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php',
  'cs', 'swift', 'dart', 'vue', 'svelte', 'sql', 'c', 'h', 'cpp', 'hpp', 'scala', 'ex', 'exs',
];
const CONFIG_EXTENSIONS = ['yml', 'yaml', 'toml', 'properties', 'gradle'];
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', 'out', '.next', '.nuxt', 'vendor',
  'coverage', '.venv', 'venv', '__pycache__', 'worktrees', '.claude', '.idea', '.vscode',
]);

export const DEFAULT_DENY = ['**/.env*', '**/*.pem', '**/*.key', '**/secrets/**', '.vault/private/**'];

export interface SetupOptions {
  yes: boolean;
  index: boolean;
  instructions: boolean;
  agents?: AgentId[];
  projectRoot?: string;
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'projeto';
}

export function findProjectRoot(cwd = process.cwd()): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' });
  const top = git.status === 0 ? git.stdout.trim() : '';
  return realpathSync(top || cwd);
}

/** Conta extensões por uma varredura limitada, sem descer em diretórios de build. */
export function scanExtensions(root: string, limit = 20000): Map<string, number> {
  const counts = new Map<string, number>();
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < limit) {
    const dir = stack.pop() as string;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > limit) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).slice(1).toLowerCase();
        if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const braces = (exts: string[]) => (exts.length === 1 ? exts[0] : `{${exts.join(',')}}`);

/** Monta a `.kx.json` a partir do que existe no projeto. */
export function buildConfig(root: string, counts = scanExtensions(root), uuid = randomUUID()) {
  const project = slugify(basename(root));
  const sources: Array<Record<string, unknown>> = [];
  if (counts.get('md')) {
    sources.push({ type: 'docs', path: '.', glob: '**/*.md', exclude: ['.vault/**'] });
  }
  if (existsSync(join(root, '.vault'))) {
    sources.push({ type: 'vault', path: './.vault', glob: '**/*.md', exclude: ['**/.obsidian/**', '**/.trash/**'] });
  }
  const code = CODE_EXTENSIONS.filter((ext) => counts.get(ext));
  if (code.length) sources.push({ type: 'code', path: '.', glob: `**/*.${braces(code)}` });
  const cfg = CONFIG_EXTENSIONS.filter((ext) => counts.get(ext));
  if (cfg.length) sources.push({ type: 'config', path: '.', glob: `**/*.${braces(cfg)}` });

  return {
    project,
    index: `~/.kx/data/${project}.sqlite`,
    sources,
    indexing: { deny: DEFAULT_DENY },
    mcp: { projectId: uuid },
  };
}

const INSTRUCTIONS = `
## MCP kx

Antes da primeira chamada, leia \`mcp.projectId\` da \`.kx.json\` da raiz ativa.
Passe esse UUID como \`expected_project_id\` e a raiz absoluta ativa como \`expected_project_root\` em toda tool kx.
Se houver \`KX_PROJECT_MISMATCH\`, pare de usar essa instância MCP.

Use a tool \`search\` do kx antes de implementar, revisar ou responder sobre arquitetura, fluxos e decisões.
Para símbolo exato ou path conhecido, prefira \`rg\`.
`;

function parseAgents(value: string | undefined): AgentId[] | undefined {
  if (!value) return undefined;
  const valid: AgentId[] = ['claude', 'codex', 'cursor'];
  return value.split(',').map((v) => v.trim().toLowerCase())
    .filter((v): v is AgentId => (valid as string[]).includes(v));
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    yes: args.includes('--yes') || args.includes('-y'),
    index: !args.includes('--no-index'),
    instructions: args.includes('--with-instructions'),
    agents: parseAgents(opt('--agents')),
    projectRoot: opt('--project-root'),
  };
}

/** Silencia os logs de progresso do indexador enquanto o spinner está ativo. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

export async function runSetup(args: string[]): Promise<number> {
  const options = parseSetupArgs(args);
  const ask = (q: string, d: boolean) => (options.yes ? Promise.resolve(d) : confirm(q, d));
  const root = options.projectRoot ? realpathSync(resolve(options.projectRoot)) : findProjectRoot();

  banner('setup', `configurando ${root}`);

  // 1. Configuração
  const configPath = join(root, '.kx.json');
  if (existsSync(configPath)) {
    line(`  ${sym.ok} .kx.json já existe ${c.dim('— preservada')}`);
  } else {
    const config = buildConfig(root);
    if (!config.sources.length) {
      line(`  ${sym.warn} Nenhum arquivo indexável encontrado em ${root}.`);
      return 1;
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    line(`  ${sym.ok} .kx.json criada ${c.dim(`· projeto "${config.project}" · ${config.sources.length} fonte(s)`)}`);
    for (const s of config.sources) line(`      ${c.dim(`${String(s.type).padEnd(6)} ${s.glob}`)}`);
    line(`      ${c.dim(`denylist de segredos + asserção MCP ${config.mcp.projectId.slice(0, 8)}…`)}`);
  }

  // 2. Agentes
  const detected = detectAgents().filter((a) => (options.agents ? options.agents.includes(a.id) : a.detected));
  if (!detected.length) {
    line(`  ${sym.warn} Nenhum agente detectado ${c.dim('(Claude Code, Codex, Cursor) — use --agents claude,codex,cursor')}`);
  }
  for (const agent of detected) {
    if (!(await ask(`Registrar o kx no ${agent.name}?`, true))) continue;
    const { result } = registerAgent(agent, root);
    const verb = result === 'created' ? 'criado' : result === 'updated' ? 'atualizado' : 'já estava registrado';
    line(`  ${sym.ok} ${agent.name.padEnd(11)} ${c.dim(`${agent.file} · ${verb}`)}`);
  }

  // 3. Instruções para o agente (opt-in: mexe em arquivo versionado)
  const wantsInstructions = options.instructions || (!options.yes && await confirm('Adicionar instruções de uso do kx ao CLAUDE.md/AGENTS.md?', false));
  if (wantsInstructions) {
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const target = join(root, file);
      if (file === 'AGENTS.md' && !existsSync(target)) continue;
      const current = existsSync(target) ? readFileSync(target, 'utf-8') : '';
      if (current.includes('## MCP kx')) continue;
      appendFileSync(target, INSTRUCTIONS);
      line(`  ${sym.ok} ${file} ${c.dim('· instruções adicionadas')}`);
    }
  }

  // 4. Índice + prova
  if (options.index) {
    const { loadConfig } = await import('./config.js');
    const { indexProject } = await import('./indexer.js');
    const { search } = await import('./searcher.js');
    const config = loadConfig(root);

    const spin = spinner('Indexando (o modelo de ~23 MB é baixado na primeira vez)');
    const started = Date.now();
    const stats = await quietly(() => indexProject(config, 'incremental'));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    spin.stop(`${sym.ok} Índice pronto ${c.dim(`· ${stats.filesProcessed} arquivos · ${stats.chunksCreated} chunks · ${secs}s`)}`);
    if (stats.errors.length) line(`  ${sym.warn} ${stats.errors.length} arquivo(s) com erro ${c.dim('— veja `kx index`')}`);

    const query = config.project.replace(/-/g, ' ');
    const t0 = Date.now();
    const results = await quietly(() => search(config, query, 3));
    const ms = Date.now() - t0;
    line();
    line(`  ${c.dim('prova:')} ${c.lime('kx search')} ${c.warm(`"${query}"`)} ${c.dim(`· ${ms} ms`)}`);
    for (const r of results) {
      line(`    ${c.cyan(`[${r.score.toFixed(4)}]`)} ${isAbsolute(r.path) ? relative(root, r.path) : r.path} ${c.dim(`[${r.source_type}|${r.matchedBy}]`)}`);
    }
    if (!results.length) line(`    ${c.dim('nenhum resultado para a consulta de prova')}`);
  }

  line();
  line(`  ${c.bold('Projeto configurado.')} Reinicie o agente para ele carregar o MCP do kx.`);
  line(`  ${c.dim('Buscar:')} kx search "sua pergunta"   ${c.dim('Diagnóstico:')} kx doctor   ${c.dim('Manter atualizado:')} kx watch`);
  line();
  return 0;
}
