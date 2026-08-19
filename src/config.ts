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

/**
 * Impulso de recência na busca.
 *
 * Documentação, decisões de arquitetura e atas de reunião envelhecem: quando
 * duas fontes cobrem o mesmo assunto, a mais nova costuma ser a vigente. O
 * decaimento é exponencial por meia-vida sobre o mtime do arquivo e entra na
 * fusão como multiplicador limitado (1 até 1+weight) — nunca reordena
 * resultados de relevância muito diferente, só desempata a favor do recente.
 */
export interface RecencyConfig {
  /** Meia-vida em dias: com 90, um doc de 90 dias recebe metade do impulso. */
  halfLifeDays: number;
  /** Intensidade do impulso: 0.3 = documento novíssimo ganha até +30%. */
  weight: number;
}

export interface SearchTuningConfig {
  /** `false` desativa; omitido usa o padrão (meia-vida 90 dias, peso 0.3). */
  recency?: RecencyConfig | false;
}

export interface McpConfig {
  /**
   * Identificador estável e não secreto do domínio do projeto. Quando
   * configurado, toda tool MCP exige a mesma identidade antes de ler ou
   * escrever qualquer dado.
   */
  projectId: string;
}

export interface KxConfig {
  project: string;
  index: string;
  /** Diretório base do .kx.json resolvido (derivado em loadConfig, não vem do JSON do usuário). */
  projectRoot: string;
  sources: SourceConfig[];
  indexing?: IndexingConfig;
  mcp?: McpConfig;
  search?: SearchTuningConfig;
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
  search: { recency: { halfLifeDays: 90, weight: 0.3 } },
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
    if (!existsSync(p)) {
      throw new Error(`Configuração KX não encontrada na raiz explícita: ${p}`);
    }
    return p;
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
  config.mcp = normalizeMcpConfig(config.mcp);
  config.search = normalizeSearchConfig(userConfig.search);

  return config;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeMcpConfig(mcp: unknown): McpConfig | undefined {
  if (mcp === undefined) return undefined;
  if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) {
    throw new Error('mcp deve ser um objeto com a propriedade projectId.');
  }

  const keys = Object.keys(mcp);
  if (keys.length !== 1 || keys[0] !== 'projectId') {
    throw new Error('mcp aceita somente a propriedade obrigatória projectId.');
  }

  const projectId = (mcp as Record<string, unknown>).projectId;
  if (typeof projectId !== 'string' || !UUID_PATTERN.test(projectId.trim())) {
    throw new Error('mcp.projectId deve ser um UUID válido e exclusivo do projeto.');
  }
  return { projectId: projectId.trim().toLowerCase() };
}

function normalizeSearchConfig(search: unknown): SearchTuningConfig {
  const fallback = DEFAULT_CONFIG.search as SearchTuningConfig;
  if (search === undefined) return fallback;
  if (search === null || typeof search !== 'object' || Array.isArray(search)) {
    throw new Error('search deve ser um objeto (ex.: { "recency": { "halfLifeDays": 90, "weight": 0.3 } }).');
  }

  const recency = (search as Record<string, unknown>).recency;
  if (recency === undefined) return fallback;
  if (recency === false) return { recency: false };
  if (recency === null || typeof recency !== 'object' || Array.isArray(recency)) {
    throw new Error('search.recency deve ser false ou um objeto { halfLifeDays, weight }.');
  }

  const halfLifeDays = (recency as Record<string, unknown>).halfLifeDays;
  const weight = (recency as Record<string, unknown>).weight;
  const base = (fallback.recency || { halfLifeDays: 90, weight: 0.3 }) as RecencyConfig;
  const normalized: RecencyConfig = {
    halfLifeDays: typeof halfLifeDays === 'number' && halfLifeDays > 0 ? halfLifeDays : base.halfLifeDays,
    weight: typeof weight === 'number' && weight >= 0 ? weight : base.weight,
  };
  return { recency: normalized };
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
