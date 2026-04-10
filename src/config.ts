import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

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

export function loadConfig(basePath?: string): KxConfig {
  const base = basePath || process.cwd();
  const configPath = resolve(base, '.kx.json');

  if (!existsSync(configPath)) {
    console.error(`Configuração não encontrada: ${configPath}`);
    console.error('Crie um .kx.json na raiz do projeto.');
    process.exit(1);
  }

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
