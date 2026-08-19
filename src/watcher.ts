import { watch as watchWithChokidar, type ChokidarOptions, type FSWatcher } from 'chokidar';
import { readdirSync, statSync, watch as watchTree, type FSWatcher as NativeWatcher } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { minimatch } from 'minimatch';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase } from './database.js';
import { BUILTIN_EXCLUDED_DIRS, resolveIndexPath } from './index-policy.js';
import { indexSinglePath, purgeDeniedIndexEntries, removeSinglePath, type IndexStats, type IndexerDependencies } from './indexer.js';

/**
 * Directory names that never hold indexable sources and that dominate the cost
 * of watching: worktree copies, backups and build artifacts multiply the
 * observed tree by tens of thousands of entries without contributing a single
 * new document. Matching happens per path segment relative to the observed
 * root, so a source pointed explicitly inside one of them is still watched.
 */

const IGNORED_GLOBS = ['.setup/kx/**'];

/**
 * Upper bound for both the settle timers and the mutation backlog. Embedding is
 * sequential and far slower than filesystem events can arrive, so unbounded
 * bookkeeping turns any bulk operation (git checkout, build, mass rename) into
 * unbounded heap growth. Dropping the excess is recoverable — `kx index`
 * reconciles — while an out of memory abort is not.
 */
const MAX_PENDING_OPERATIONS = 500;

/** Quiet period before a touched path is read, so partial writes are not indexed. */
const DEFAULT_SETTLE_MS = 2000;

/** Heap level that makes a pathological backlog visible in the log early. */
const HEAP_WARN_MB = 512;

const HEAP_PROBE_INTERVAL_MS = 60_000;

type WatchAction = 'indexed' | 'removed' | 'ignored';

export interface WatchEvent {
  event: 'add' | 'change' | 'unlink';
  filePath: string;
  action: WatchAction;
}

export interface StartWatcherOptions {
  /** Overrides are intended for embedding the watcher and deterministic tests. */
  chokidar?: ChokidarOptions;
  /** Quiet period applied before reading a touched path. */
  settleMs?: number;
  onEvent?: (event: WatchEvent) => void;
}

export interface WatcherHandle {
  /** Present only while the fallback backend is in use. */
  watcher?: FSWatcher;
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

/**
 * Decides whether a path should be skipped entirely. Segments are compared
 * relative to the observed root so that ignoring `worktrees` never disables a
 * source whose own root already lives inside a worktree.
 */
export function createIgnoreMatcher(roots: string[]): (candidate: string) => boolean {
  const deepestFirst = [...new Set(roots.map(root => resolve(root)))].sort((left, right) => right.length - left.length);

  return (candidate: string): boolean => {
    const absolutePath = resolve(candidate);
    const root = deepestFirst.find(entry => isInside(entry, absolutePath));
    if (root === undefined) return false;

    const relativePath = toPosixPath(relative(root, absolutePath));
    if (!relativePath) return false;
    if (relativePath.split('/').some(segment => BUILTIN_EXCLUDED_DIRS.has(segment))) return true;
    return IGNORED_GLOBS.some(pattern => minimatch(relativePath, pattern, { dot: true, nonegate: true }));
  };
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
  db?: VectorDatabase,
): Promise<IndexStats | null> {
  if (!source) {
    // A source glob or exclusion may have been tightened after a file was
    // indexed. Delete a possible stale entry but never touch paths outside
    // configured source roots.
    if (isInConfiguredSourceRoot(config, filePath)) removeSinglePath(config, filePath, db);
    return null;
  }
  return indexSinglePath(config, filePath, dependencies, source.type, db);
}

/**
 * Recursive `fs.watch` maps to FSEvents on macOS and to
 * ReadDirectoryChangesW on Windows: one handle per tree, no descriptor per
 * directory and no periodic stat of the whole tree.
 */
function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function startWatcher(
  config: KxConfig,
  dependencies?: IndexerDependencies,
  options: StartWatcherOptions = {},
): WatcherHandle {
  // One connection for the whole watcher lifetime: opening and closing SQLite
  // per filesystem event reloads the vector extension on every keystroke.
  const db = new VectorDatabase(config.index, config.embedding.dimensions);

  // Reconcile once at startup: ignored or unchanged files must not retain
  // plaintext chunks from before an opt-in deny policy was added.
  if (config.indexing?.deny?.length) {
    const purged = purgeDeniedIndexEntries(db, config);
    if (purged > 0) console.error(`Removidos ${purged} caminho(s) bloqueado(s) do índice.`);
  }

  const roots = [...new Set(config.sources.map(source => resolve(source.path)))];
  const isIgnored = createIgnoreMatcher(roots);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  console.error(`Observando mudanças em ${config.sources.length} fontes...`);

  // The queue coalesces by path, so a file touched repeatedly while it drains
  // is reindexed once, and it is bounded so a burst cannot grow the heap
  // without limit.
  const queue = new Map<string, () => Promise<void>>();
  const settleTimers = new Map<string, NodeJS.Timeout>();
  let draining: Promise<void> | null = null;
  let dropped = 0;

  const reportDropped = () => {
    dropped++;
    if (dropped === 1 || dropped % 500 === 0) {
      console.error(
        `Fila cheia (${MAX_PENDING_OPERATIONS}); ${dropped} evento(s) descartado(s). Rode 'kx index' para reconciliar.`,
      );
    }
  };

  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (queue.size > 0) {
        const next = queue.entries().next();
        if (next.done) break;
        const [key, operation] = next.value;
        queue.delete(key);
        try {
          await operation();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`  Erro ao processar ${key}: ${msg}`);
        }
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  };

  const enqueue = (key: string, operation: () => Promise<void>) => {
    if (!queue.has(key) && queue.size >= MAX_PENDING_OPERATIONS) {
      reportDropped();
      return;
    }
    queue.set(key, operation);
    void drain();
  };

  const isAlreadyIndexed = (absolutePath: string): boolean => {
    try {
      return db.getModifiedAt(resolveIndexPath(config, absolutePath, false).storedPath) !== null;
    } catch {
      return false;
    }
  };

  const emit = (event: WatchEvent['event'], filePath: string, action: WatchAction) => {
    options.onEvent?.({ event, filePath, action });
  };

  const indexFile = async (absolutePath: string, event: WatchEvent['event']) => {
    console.error(`Arquivo ${event === 'add' ? 'adicionado' : 'modificado'}: ${absolutePath}`);
    try {
      const source = selectWatcherSource(config, absolutePath);
      const stats = await processWatcherChange(config, absolutePath, dependencies, source, db);
      if (stats && stats.chunksCreated > 0) {
        console.error(`  ${event === 'add' ? 'Indexado' : 'Reindexado'}: ${stats.chunksCreated} chunk(s)`);
      }
      emit(event, absolutePath, actionForStats(config, absolutePath, stats));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Erro ao indexar: ${msg}`);
    }
  };

  const forgetFile = async (absolutePath: string) => {
    if (!isInConfiguredSourceRoot(config, absolutePath)) {
      emit('unlink', absolutePath, 'ignored');
      return;
    }
    console.error(`Arquivo removido: ${absolutePath}`);
    try {
      // A rename arrives as a removal plus a creation. Deletion deliberately
      // bypasses admission denial so stale, newly-denied paths are removed.
      removeSinglePath(config, absolutePath, db);
      emit('unlink', absolutePath, 'removed');
    } catch (error) {
      console.error(`  Erro ao remover do índice: ${(error as Error).message}`);
    }
  };

  /**
   * A directory can surface as a single event when it is moved or copied in
   * one operation, so its files are expanded explicitly. The bounded queue
   * still caps the work that a very large drop can schedule.
   */
  const expandDirectory = (directoryPath: string): void => {
    let entries;
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = resolve(directoryPath, entry.name);
      if (isIgnored(childPath)) continue;
      if (entry.isDirectory()) expandDirectory(childPath);
      else enqueue(childPath, () => indexFile(childPath, isAlreadyIndexed(childPath) ? 'change' : 'add'));
    }
  };

  const inspect = async (absolutePath: string): Promise<void> => {
    let isDirectory = false;
    try {
      isDirectory = statSync(absolutePath).isDirectory();
    } catch {
      await forgetFile(absolutePath);
      return;
    }
    if (isDirectory) {
      expandDirectory(absolutePath);
      return;
    }
    await indexFile(absolutePath, isAlreadyIndexed(absolutePath) ? 'change' : 'add');
  };

  const schedule = (absolutePath: string): void => {
    const running = settleTimers.get(absolutePath);
    if (running) clearTimeout(running);
    else if (settleTimers.size >= MAX_PENDING_OPERATIONS) {
      reportDropped();
      return;
    }
    settleTimers.set(absolutePath, setTimeout(() => {
      settleTimers.delete(absolutePath);
      enqueue(absolutePath, () => inspect(absolutePath));
    }, settleMs));
  };

  const useFallback = options.chokidar !== undefined || !supportsRecursiveWatch();
  const nativeHandles: NativeWatcher[] = [];
  let fallbackWatcher: FSWatcher | undefined;

  if (useFallback) {
    fallbackWatcher = watchWithChokidar(roots, {
      ignored: isIgnored,
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
      ...options.chokidar,
    });
    fallbackWatcher.on('add', (filePath: string) => enqueue(filePath, () => indexFile(filePath, 'add')));
    fallbackWatcher.on('change', (filePath: string) => enqueue(filePath, () => indexFile(filePath, 'change')));
    fallbackWatcher.on('unlink', (filePath: string) => enqueue(filePath, () => forgetFile(filePath)));
  } else {
    for (const root of roots) {
      try {
        const handle = watchTree(root, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const absolutePath = resolve(root, filename.toString());
          if (isIgnored(absolutePath)) return;
          schedule(absolutePath);
        });
        handle.on('error', (error: Error) => console.error(`Erro ao observar ${root}: ${error.message}`));
        nativeHandles.push(handle);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Não foi possível observar ${root}: ${msg}`);
      }
    }
  }

  // A pathological backlog must show up in the log before it becomes an out of
  // memory abort that the supervisor restarts in a loop.
  const heapProbe = setInterval(() => {
    const heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapUsedMb >= HEAP_WARN_MB) {
      console.error(`Heap em ${heapUsedMb} MB com ${queue.size} evento(s) na fila e ${dropped} descartado(s).`);
    }
  }, HEAP_PROBE_INTERVAL_MS);
  heapProbe.unref();

  console.error('File watcher ativo. Ctrl+C para parar.');
  const ready = fallbackWatcher
    ? new Promise<void>((resolveReady, rejectReady) => {
      fallbackWatcher!.once('ready', resolveReady);
      fallbackWatcher!.once('error', rejectReady);
    })
    : Promise.resolve();

  return {
    watcher: fallbackWatcher,
    ready,
    close: async () => {
      clearInterval(heapProbe);
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
      for (const handle of nativeHandles) handle.close();
      if (fallbackWatcher) await fallbackWatcher.close();
      await drain().catch(() => undefined);
      db.close();
    },
  };
}
