import { watch, type ChokidarOptions, type FSWatcher } from 'chokidar';
import { isAbsolute, relative, resolve } from 'path';
import { minimatch } from 'minimatch';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase } from './database.js';
import { indexSinglePath, purgeDeniedIndexEntries, removeSinglePath, type IndexStats, type IndexerDependencies } from './indexer.js';

const DEFAULT_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/build/**',
  '**/target/**',
  '**/dist/**',
  '**/.obsidian/**',
  '**/.trash/**',
  '.setup/kx/**',
];

type WatchAction = 'indexed' | 'removed' | 'ignored';

export interface WatchEvent {
  event: 'add' | 'change' | 'unlink';
  filePath: string;
  action: WatchAction;
}

export interface StartWatcherOptions {
  /** Overrides are intended for embedding the watcher and deterministic tests. */
  chokidar?: ChokidarOptions;
  onEvent?: (event: WatchEvent) => void;
}

export interface WatcherHandle {
  watcher: FSWatcher;
  ready: Promise<void>;
  close: () => Promise<void>;
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function matchesPattern(pattern: string, relativePath: string, absolutePath: string): boolean {
  const candidate = isAbsolute(pattern) ? absolutePath : relativePath;
  return minimatch(candidate, toPosixPath(pattern), {
    // Match node-glob's default semantics used by full/incremental indexing:
    // wildcard patterns do not select dotfiles unless the pattern names them.
    dot: false,
    nocase: process.platform === 'darwin' || process.platform === 'win32',
    nonegate: true,
  });
}

function matchesSource(source: SourceConfig, filePath: string): boolean {
  const sourceRoot = resolve(source.path);
  const absolutePath = resolve(filePath);
  if (!isInside(sourceRoot, absolutePath)) return false;

  const relativePath = toPosixPath(relative(sourceRoot, absolutePath));
  if (!relativePath || !matchesPattern(source.glob, relativePath, toPosixPath(absolutePath))) return false;
  return !(source.exclude ?? []).some(pattern => matchesPattern(pattern, relativePath, toPosixPath(absolutePath)));
}

/**
 * Determines the configured source responsible for a watcher event. Sources
 * may overlap; the deepest matching root wins, then declaration order keeps
 * the result stable when roots are identical.
 */
export function selectWatcherSource(config: KxConfig, filePath: string): SourceConfig | null {
  const candidates = config.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => matchesSource(source, filePath))
    .sort((left, right) => resolve(right.source.path).length - resolve(left.source.path).length || left.index - right.index);
  return candidates[0]?.source ?? null;
}

function isInConfiguredSourceRoot(config: KxConfig, filePath: string): boolean {
  const absolutePath = resolve(filePath);
  return config.sources.some(source => isInside(resolve(source.path), absolutePath));
}

function actionForStats(config: KxConfig, filePath: string, stats: IndexStats | null): WatchAction {
  if (stats?.filesProcessed) return 'indexed';
  return isInConfiguredSourceRoot(config, filePath) ? 'removed' : 'ignored';
}

export async function processWatcherChange(
  config: KxConfig,
  filePath: string,
  dependencies?: IndexerDependencies,
  source = selectWatcherSource(config, filePath),
): Promise<IndexStats | null> {
  if (!source) {
    // A source glob or exclusion may have been tightened after a file was
    // indexed. Delete a possible stale entry but never touch paths outside
    // configured source roots.
    if (isInConfiguredSourceRoot(config, filePath)) removeSinglePath(config, filePath);
    return null;
  }
  return indexSinglePath(config, filePath, dependencies, source.type);
}

export function startWatcher(
  config: KxConfig,
  dependencies?: IndexerDependencies,
  options: StartWatcherOptions = {},
): WatcherHandle {
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

  // Chokidar v4 does not expand glob patterns. Observe source roots and apply
  // each source's glob/exclude deterministically before indexing.
  const roots = [...new Set(config.sources.map(source => resolve(source.path)))];

  console.error(`Observando mudanças em ${config.sources.length} fontes...`);

  const watcher = watch(roots, {
    ignored: DEFAULT_IGNORED,
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 5000,
    binaryInterval: 10000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
    ...options.chokidar,
  });

  // SQLite WAL allows concurrent readers, but multiple watcher writes and
  // embedding initializations are safer as one per-index mutation queue.
  let pending = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    pending = pending.catch(() => undefined).then(operation);
  };

  const handleChange = async (filePath: string) => {
    console.error(`Arquivo modificado: ${filePath}`);
    try {
      const source = selectWatcherSource(config, filePath);
      const stats = await processWatcherChange(config, filePath, dependencies, source);
      if (stats && stats.chunksCreated > 0) {
        console.error(`  Reindexado: ${stats.chunksCreated} chunk(s)`);
      }
      options.onEvent?.({ event: 'change', filePath, action: actionForStats(config, filePath, stats) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Erro ao reindexar: ${msg}`);
    }
  };

  watcher.on('change', (filePath) => enqueue(() => handleChange(filePath)));
  watcher.on('add', (filePath) => enqueue(async () => {
    console.error(`Arquivo adicionado: ${filePath}`);
    try {
      const source = selectWatcherSource(config, filePath);
      const stats = await processWatcherChange(config, filePath, dependencies, source);
      if (stats && stats.chunksCreated > 0) console.error(`  Indexado: ${stats.chunksCreated} chunk(s)`);
      options.onEvent?.({ event: 'add', filePath, action: actionForStats(config, filePath, stats) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Erro ao indexar: ${msg}`);
    }
  }));

  watcher.on('unlink', (filePath) => {
    enqueue(async () => {
      if (!isInConfiguredSourceRoot(config, filePath)) {
        options.onEvent?.({ event: 'unlink', filePath, action: 'ignored' });
        return;
      }
      console.error(`Arquivo removido: ${filePath}`);
      try {
        // Chokidar represents a rename as unlink + add. Deletion deliberately
        // bypasses admission denial so stale, newly-denied paths are removed.
        removeSinglePath(config, filePath);
        options.onEvent?.({ event: 'unlink', filePath, action: 'removed' });
      } catch (error) {
        console.error(`  Erro ao remover do índice: ${(error as Error).message}`);
      }
    });
  });

  console.error('File watcher ativo. Ctrl+C para parar.');
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    watcher.once('ready', resolveReady);
    watcher.once('error', rejectReady);
  });
  return {
    watcher,
    ready,
    close: async () => {
      await watcher.close();
      await pending.catch(() => undefined);
    },
  };
}
