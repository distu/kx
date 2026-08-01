import { readFileSync, existsSync, realpathSync } from 'fs';
import { resolve, dirname, isAbsolute } from 'path';
import { homedir } from 'os';

export interface SourceConfig {
  type: 'docs' | 'code' | 'config' | 'vault';
  path: string;
  glob: string;
  exclude?: string[];
  /**
   * Peso opcional de prioridade na busca (padrao implicito: 1, sem efeito).
   * Só é considerado quando > 1 e explicitamente configurado — projetos que
   * não definem `weight` em nenhuma fonte têm busca 100% inalterada.
   */
  weight?: number;
}

/**
 * Regras globais, explicitamente opt-in, para impedir que determinados
 * arquivos entrem no índice. Os padrões são caminhos POSIX relativos à raiz
 * do projeto (por exemplo, um diretório `private` recursivo ou arquivos de
 * ambiente em qualquer diretório).
 */
export interface IndexingConfig {
  deny?: string[];
}

export interface KxConfig {
  project: string;
  index: string;
  /** Diretório base do .kx.json resolvido (derivado em loadConfig, não vem do JSON do usuário). */
  projectRoot: string;
  sources: SourceConfig[];
  indexing?: IndexingConfig;
  embedding: {
    model: string;
    dimensions: number;
  };
  chunking: {
    markdown: { maxTokens: number; overlap: number };
    code: { maxTokens: number; overlap: number };
    config: { maxTokens: number; overlap: number };
  };
}

const DEFAULT_CONFIG: KxConfig = {
  project: 'default',
  index: '~/.kx/data/default.sqlite',
  projectRoot: process.cwd(),
  sources: [],
  embedding: {
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
  },
  chunking: {
    markdown: { maxTokens: 512, overlap: 50 },
    code: { maxTokens: 1024, overlap: 0 },
    config: { maxTokens: 256, overlap: 0 },
  },
};

function findConfig(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const candidate = resolve(dir, '.kx.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveConfigPath(basePath?: string): string {
  const explicit = basePath || process.env.KX_PROJECT_ROOT;
  if (explicit) {
    const p = resolve(explicit, '.kx.json');
    if (existsSync(p)) return p;
  }

  const found = findConfig(process.cwd());
  if (found) return found;

  const home = resolve(homedir(), '.kx.json');
  if (existsSync(home)) return home;

  console.error('Configuração não encontrada. Procurado em:');
  if (explicit) console.error(`  - ${resolve(explicit, '.kx.json')} (KX_PROJECT_ROOT)`);
  console.error(`  - ${process.cwd()}/.kx.json e diretórios pais`);
  console.error(`  - ${home} (fallback global)`);
  console.error('Crie um .kx.json em algum desses locais.');
  process.exit(1);
}

export function loadConfig(basePath?: string): KxConfig {
  const configPath = resolveConfigPath(basePath);
  const base = dirname(configPath);

  const raw = readFileSync(configPath, 'utf-8');
  const userConfig = JSON.parse(raw) as Partial<KxConfig>;

  const config: KxConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    embedding: { ...DEFAULT_CONFIG.embedding, ...userConfig.embedding },
    chunking: {
      markdown: { ...DEFAULT_CONFIG.chunking.markdown, ...userConfig.chunking?.markdown },
      code: { ...DEFAULT_CONFIG.chunking.code, ...userConfig.chunking?.code },
      config: { ...DEFAULT_CONFIG.chunking.config, ...userConfig.chunking?.config },
    },
  };

  // Resolver paths relativos
  // Use the canonical root so a source reached through a system symlink (for
  // example temporary directories on macOS) remains project-relative after
  // `realpathSync` is applied by the central indexing gate.
  config.projectRoot = realpathSync(base);
  config.index = resolve(base, config.index);
  config.sources = config.sources.map(s => ({
    ...s,
    path: resolve(base, s.path),
  }));

  config.indexing = normalizeIndexingConfig(config.indexing);

  return config;
}

function normalizeIndexingConfig(indexing: IndexingConfig | undefined): IndexingConfig | undefined {
  if (indexing?.deny === undefined) return indexing;
  if (!Array.isArray(indexing.deny) || indexing.deny.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
    throw new Error('indexing.deny deve ser uma lista de padrões glob não vazios.');
  }

  const deny = indexing.deny.map(pattern => {
    let normalized = pattern.trim().replaceAll('\\', '/');
    while (normalized.startsWith('./')) normalized = normalized.slice(2);
    if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`indexing.deny aceita somente caminhos relativos à raiz do projeto: ${pattern}`);
    }
    return normalized;
  });

  return { ...indexing, deny };
}
