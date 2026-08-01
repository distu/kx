import { watch } from 'chokidar';
import type { KxConfig } from './config.js';
import { VectorDatabase } from './database.js';
import { indexSinglePath, purgeDeniedIndexEntries, removeSinglePath, type IndexStats, type IndexerDependencies } from './indexer.js';

export async function processWatcherChange(
  config: KxConfig,
  filePath: string,
  dependencies?: IndexerDependencies,
): Promise<IndexStats | null> {
  if (!filePath.match(/\.(md|java|ts|tsx|yml|yaml|properties|json|gradle|env)$/)) {
    return null;
  }
  return indexSinglePath(config, filePath, dependencies);
}

export function startWatcher(config: KxConfig): void {
  // Reconcile once at startup: ignored or unchanged files must not retain
  // plaintext chunks from before an opt-in deny policy was added.
  if (config.indexing?.deny?.length) {
    const db = new VectorDatabase(config.index, config.embedding.dimensions);
    try {
      const purged = purgeDeniedIndexEntries(db, config);
      if (purged > 0) console.error(`Removidos ${purged} caminho(s) bloqueado(s) do índice.`);
    } finally {
      db.close();
    }
  }

  // Observar apenas arquivos relevantes via globs específicos
  const globs: string[] = [];
  for (const source of config.sources) {
    globs.push(`${source.path}/${source.glob}`);
  }

  console.error(`Observando mudanças em ${config.sources.length} fontes...`);

  const watcher = watch(globs, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/build/**',
      '**/target/**',
      '**/dist/**',
      '**/.obsidian/**',
      '**/.trash/**',
      '.setup/kx/**',
    ],
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 5000,
    binaryInterval: 10000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  const handleChange = async (filePath: string) => {
    console.error(`Arquivo modificado: ${filePath}`);
    try {
      const stats = await processWatcherChange(config, filePath);
      if (stats && stats.chunksCreated > 0) {
        console.error(`  Reindexado: ${stats.chunksCreated} chunk(s)`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Erro ao reindexar: ${msg}`);
    }
  };

  watcher.on('change', handleChange);
  watcher.on('add', handleChange);

  watcher.on('unlink', (filePath) => {
    console.error(`Arquivo removido: ${filePath}`);
    try { removeSinglePath(config, filePath); }
    catch (error) { console.error(`  Erro ao remover do índice: ${(error as Error).message}`); }
  });

  console.error('File watcher ativo. Ctrl+C para parar.');
}
