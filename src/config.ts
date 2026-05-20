import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

export interface SourceConfig {
  type: 'docs' | 'code' | 'config' | 'vault';
  path: string;
  glob: string;
  exclude?: string[];
}

export interface KxConfig {
  project: string;
  index: string;
  sources: SourceConfig[];
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
  config.index = resolve(base, config.index);
  config.sources = config.sources.map(s => ({
    ...s,
    path: resolve(base, s.path),
  }));

  return config;
}
