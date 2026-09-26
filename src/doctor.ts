/**
 * `kx doctor` — verifica a instalação de ponta a ponta, executando de fato
 * cada dependência (não só checando se o arquivo existe).
 *
 * Código de saída 1 quando algo obrigatório falha; usado pelo instalador e
 * pela CI para provar que a instalação funciona.
 */
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { detectAgents, isRegistered } from './agents.js';
import { kxVersion } from './version.js';
import { banner, c, line, sym } from './term.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  label: string;
  status: Status;
  detail: string;
}

export { kxVersion };

function findConfigUp(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, '.kx.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function attempt(label: string, fn: () => Promise<string> | string, onError: Status = 'fail'): Promise<Check> {
  try {
    return { label, status: 'ok', detail: await fn() };
  } catch (error) {
    return { label, status: onError, detail: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}

export async function runDoctor(args: string[]): Promise<number> {
  const warm = args.includes('--warm');
  const json = args.includes('--json');
  const checks: Check[] = [];

  checks.push({
    label: 'Node.js',
    status: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'fail',
    detail: `${process.version} · ABI ${process.versions.modules} · ${process.platform}-${process.arch}`,
  });

  checks.push(await attempt('SQLite nativo', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    const version = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
    db.close();
    return `better-sqlite3 · SQLite ${version}`;
  }));

  checks.push(await attempt('sqlite-vec', async () => {
    const { default: Database } = await import('better-sqlite3');
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const version = (db.prepare('select vec_version() as v').get() as { v: string }).v;
    db.close();
    return `extensão carregada · ${version}`;
  }));

  checks.push(await attempt('Modelo de embedding', async () => {
    const { embed, initEmbedder } = await import('./embedder.js');
    const { env } = await import('@huggingface/transformers');
    const modelDir = join(process.env.KX_MODELS_DIR || String(env.cacheDir), 'Xenova', 'all-MiniLM-L6-v2');
    if (warm) {
      const original = console.error;
      console.error = () => {};
      try {
        await initEmbedder();
        const vector = await embed('kx doctor');
        if (vector.length !== 384) throw new Error(`dimensão inesperada: ${vector.length}`);
      } finally {
        console.error = original;
      }
      return 'all-MiniLM-L6-v2 · 384d · embedding gerado';
    }
    if (!existsSync(modelDir)) throw new Error('ainda não baixado (acontece no primeiro index, ou rode kx doctor --warm)');
    return 'all-MiniLM-L6-v2 · em cache local';
  }, 'warn'));

  const configPath = findConfigUp(process.cwd());
  if (!configPath) {
    checks.push({ label: 'Projeto', status: 'warn', detail: 'nenhuma .kx.json aqui — rode kx setup na raiz do projeto' });
  } else {
    const projectCheck = await attempt('Projeto', async () => {
      const { loadConfig } = await import('./config.js');
      const config = loadConfig(dirname(configPath));
      const guard = config.mcp ? 'asserção MCP ativa' : 'modo legado (sem mcp.projectId)';
      if (!existsSync(config.index)) return `${config.project} · ${guard} · índice ainda não criado (kx index)`;
      const { getStatus } = await import('./searcher.js');
      const stats = getStatus(config) as { totalDocuments: number; totalChunks: number };
      return `${config.project} · ${guard} · ${stats.totalDocuments} docs · ${stats.totalChunks} chunks`;
    });
    checks.push(projectCheck);

    const root = dirname(configPath);
    for (const agent of detectAgents()) {
      if (!agent.detected && !isRegistered(agent, root)) continue;
      checks.push({
        label: agent.name,
        status: isRegistered(agent, root) ? 'ok' : 'warn',
        detail: isRegistered(agent, root) ? `registrado em ${agent.file}` : 'instalado, mas sem kx neste projeto — rode kx setup',
      });
    }
  }

  const failed = checks.some((check) => check.status === 'fail');
  if (json) {
    process.stdout.write(`${JSON.stringify({ version: kxVersion(), ok: !failed, checks }, null, 2)}\n`);
    return failed ? 1 : 0;
  }

  banner('doctor', `kx ${kxVersion()}`);
  const icon = { ok: sym.ok, warn: sym.warn, fail: sym.fail };
  for (const check of checks) {
    line(`  ${icon[check.status]} ${check.label.padEnd(20)} ${c.dim(check.detail)}`);
  }
  line();
  line(failed ? `  ${c.red('Há falhas obrigatórias acima.')}` : `  ${c.lime('Tudo certo.')}`);
  line();
  return failed ? 1 : 0;
}
