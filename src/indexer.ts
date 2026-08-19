import { readFileSync, statSync } from 'fs';
import { glob } from 'glob';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase, type ChunkInsert } from './database.js';
import { initEmbedder, embed, embedBatch } from './embedder.js';
import { chunkMarkdown, chunkCode, chunkConfig } from './chunker.js';
import { BUILTIN_IGNORE_GLOBS, MAX_INDEXABLE_FILE_BYTES, isDeniedDocumentPath, resolveIndexPath } from './index-policy.js';

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  filesSkipped: number;
  filesPurged: number;
  blocked: string[];
  errors: string[];
}

export interface IndexerDependencies {
  initEmbedder: (model: string) => Promise<void>;
  embed: (text: string) => Promise<Float32Array>;
  /** Opcional: lote real. Sem ele, o indexador serializa via `embed`. */
  embedBatch?: (texts: string[]) => Promise<Float32Array[]>;
}

const defaultDependencies: IndexerDependencies = { initEmbedder, embed, embedBatch };

/**
 * Resolve a função de lote: usa a nativa quando o chamador injetou uma, e
 * serializa sobre `embed` caso contrário — testes injetam apenas `embed`.
 */
function embedManyWith(dependencies: IndexerDependencies): (texts: string[]) => Promise<Float32Array[]> {
  if (dependencies.embedBatch) return dependencies.embedBatch;
  return async (texts: string[]) => {
    const results: Float32Array[] = [];
    for (const text of texts) results.push(await dependencies.embed(text));
    return results;
  };
}

export async function indexProject(
  config: KxConfig,
  mode: 'full' | 'incremental' = 'incremental',
  dependencies: IndexerDependencies = defaultDependencies,
): Promise<IndexStats> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);

  const stats: IndexStats = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    filesPurged: 0,
    blocked: [],
    errors: [],
  };

  try {
    // A purge happens before scanning or embedding so a denylist applies to
    // stale chunks too, including when no filesystem event follows a config edit.
    stats.filesPurged = purgeDeniedIndexEntries(db, config);
    await dependencies.initEmbedder(config.embedding.model);
    if (mode === 'full') db.clearAll();

    for (const source of config.sources) {
      const sourceStats = await indexSource(db, config, source, mode, dependencies);
      stats.filesProcessed += sourceStats.filesProcessed;
      stats.chunksCreated += sourceStats.chunksCreated;
      stats.filesSkipped += sourceStats.filesSkipped;
      stats.blocked.push(...sourceStats.blocked);
      stats.errors.push(...sourceStats.errors);
    }

    return stats;
  } finally {
    db.close();
  }
}

async function indexSource(
  db: VectorDatabase,
  config: KxConfig,
  source: SourceConfig,
  mode: 'full' | 'incremental',
  dependencies: IndexerDependencies,
): Promise<IndexStats> {
  const stats: IndexStats = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    filesPurged: 0,
    blocked: [],
    errors: [],
  };

  const embedMany = embedManyWith(dependencies);

  // As exclusões embutidas entram no próprio scan: não descer em node_modules
  // ou worktrees economiza a listagem de dezenas de milhares de entradas.
  const files = await glob(source.glob, {
    cwd: source.path,
    absolute: true,
    ignore: [...(source.exclude || []), ...BUILTIN_IGNORE_GLOBS],
    nodir: true,
  });

  console.error(`[${source.type}] ${source.path}: ${files.length} arquivos encontrados`);

  for (const filePath of files) {
    try {
      // Resolve symlinks antes de ler: uma fonte configurada não pode escapar
      // para um arquivo externo apenas por meio de um link simbólico.
      const decision = resolveIndexPath(config, filePath, true);
      if (!decision.allowed) {
        db.deleteByPath(decision.storedPath);
        stats.filesSkipped++;
        // Bloqueio embutido (artefato de build, binário) é silencioso: só a
        // denylist do usuário merece aparecer no relatório de bloqueios.
        if (!decision.builtin) stats.blocked.push(decision.reason);
        continue;
      }
      const { filePath: safeFilePath, storedPath } = decision;
      const stat = statSync(safeFilePath);
      if (stat.size > MAX_INDEXABLE_FILE_BYTES) {
        // Dump, log ou artefato gerado: não é conteúdo de busca e a leitura
        // inteira como string pode exceder o limite do runtime.
        db.deleteByPath(storedPath);
        stats.filesSkipped++;
        continue;
      }
      const mtime = Math.floor(stat.mtimeMs);

      // No modo incremental, pular se não mudou
      if (mode === 'incremental') {
        const lastMtime = db.getModifiedAt(storedPath);
        if (lastMtime !== null && lastMtime >= mtime) {
          stats.filesSkipped++;
          continue;
        }
      }

      const content = readFileSync(safeFilePath, 'utf-8');

      // Pular arquivos vazios ou binários — removendo chunks antigos.
      if (!content || content.length < 10) {
        db.deleteByPath(storedPath);
        stats.filesSkipped++;
        continue;
      }

      // Chunking baseado no tipo
      const chunks = chunkByType(content, source.type, safeFilePath, config);

      // Embeddings em lote e escrita numa transação única por arquivo.
      const embeddings = await embedMany(chunks.map(chunk => chunk.content));
      db.replaceDocument(storedPath, source.type, mtime, chunks as ChunkInsert[], embeddings);
      stats.chunksCreated += chunks.length;

      stats.filesProcessed++;

      if (stats.filesProcessed % 50 === 0) {
        console.error(`  Processados: ${stats.filesProcessed} arquivos, ${stats.chunksCreated} chunks...`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stats.errors.push(`${filePath}: ${msg}`);
    }
  }

  return stats;
}

function chunkByType(
  content: string,
  type: string,
  filePath: string,
  config: KxConfig
) {
  switch (type) {
    case 'docs':
    case 'vault':
      return chunkMarkdown(content, config.chunking.markdown.maxTokens, config.chunking.markdown.overlap);
    case 'code':
      return chunkCode(content, config.chunking.code.maxTokens, filePath);
    case 'config':
      return chunkConfig(content, config.chunking.config.maxTokens);
    default:
      return chunkMarkdown(content, config.chunking.markdown.maxTokens, config.chunking.markdown.overlap);
  }
}

export async function indexSinglePath(
  config: KxConfig,
  targetPath: string,
  dependencies: IndexerDependencies = defaultDependencies,
  sourceType?: SourceConfig['type'],
  sharedDb?: VectorDatabase,
): Promise<IndexStats> {
  const stats: IndexStats = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0, filesPurged: 0, blocked: [], errors: [] };
  let decision;

  try {
    decision = resolveIndexPath(config, targetPath, true);
  } catch (error) {
    stats.errors.push(error instanceof Error ? error.message : String(error));
    return stats;
  }

  // A long-lived caller (the watcher) owns its connection: reopening SQLite and
  // reloading the vector extension per event is pure overhead.
  const db = sharedDb ?? new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    if (!decision.allowed) {
      db.deleteByPath(decision.storedPath);
      stats.filesSkipped = 1;
      if (!decision.builtin) stats.blocked.push(decision.reason);
      return stats;
    }

    const stat = statSync(decision.filePath);
    if (stat.size > MAX_INDEXABLE_FILE_BYTES) {
      db.deleteByPath(decision.storedPath);
      stats.filesSkipped = 1;
      return stats;
    }
    await dependencies.initEmbedder(config.embedding.model);
    const content = readFileSync(decision.filePath, 'utf-8');
    const mtime = Math.floor(stat.mtimeMs);
    const storedPath = decision.storedPath;

    // O watcher conhece a fonte que aceitou o evento. Preservar esse tipo
    // evita que o chunking dependa de uma lista de extensões incompleta.
    const type = sourceType ?? inferSourceType(targetPath);

    const chunks = chunkByType(content, type, decision.filePath, config);
    const embeddings = await embedManyWith(dependencies)(chunks.map(chunk => chunk.content));
    db.replaceDocument(storedPath, type, mtime, chunks as ChunkInsert[], embeddings);
    stats.chunksCreated = chunks.length;

    stats.filesProcessed = 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    stats.errors.push(`${targetPath}: ${msg}`);
  } finally {
    if (!sharedDb) db.close();
  }
  return stats;
}

function inferSourceType(targetPath: string): SourceConfig['type'] {
  if (targetPath.endsWith('.java') || targetPath.endsWith('.ts') || targetPath.endsWith('.tsx')) {
    return 'code';
  }
  if (targetPath.match(/\.(yml|yaml|properties|json|gradle)$/)) {
    return 'config';
  }
  if (targetPath.includes('.vault/')) {
    return 'vault';
  }
  return 'docs';
}

export function removeSinglePath(config: KxConfig, targetPath: string, sharedDb?: VectorDatabase): void {
  // Deletion deliberately bypasses admission denial: a denied file may have
  // been indexed before the policy was enabled and must still be removable.
  const decision = resolveIndexPath(config, targetPath, false);
  const db = sharedDb ?? new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    db.deleteByPath(decision.storedPath);
  } finally {
    if (!sharedDb) db.close();
  }
}

/** Removes indexed paths that have become denied without touching no-policy indexes. */
export function purgeDeniedIndexEntries(db: VectorDatabase, config: KxConfig): number {
  if (!config.indexing?.deny?.length) return 0;
  const deniedPaths = db.listPaths().filter(path => isDeniedDocumentPath(config, path));
  return db.deleteByPaths(deniedPaths);
}
