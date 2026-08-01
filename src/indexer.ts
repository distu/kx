import { readFileSync, statSync } from 'fs';
import { glob } from 'glob';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase } from './database.js';
import { initEmbedder, embed } from './embedder.js';
import { chunkMarkdown, chunkCode, chunkConfig } from './chunker.js';
import { isDeniedDocumentPath, resolveIndexPath } from './index-policy.js';

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
}

const defaultDependencies: IndexerDependencies = { initEmbedder, embed };

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

  const files = await glob(source.glob, {
    cwd: source.path,
    absolute: true,
    ignore: source.exclude || [],
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
        stats.blocked.push(decision.reason);
        continue;
      }
      const { filePath: safeFilePath, storedPath } = decision;
      const stat = statSync(safeFilePath);
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

      // Remover antes de tratar conteúdo vazio também elimina chunks antigos.
      db.deleteByPath(storedPath);

      // Pular arquivos vazios ou binários
      if (!content || content.length < 10) {
        stats.filesSkipped++;
        continue;
      }

      // Chunking baseado no tipo
      const chunks = chunkByType(content, source.type, safeFilePath, config);

      // Indexar cada chunk
      for (const chunk of chunks) {
        const embedding = await dependencies.embed(chunk.content);
        db.insertDocument(
          storedPath,
          chunk.index,
          chunk.content,
          source.type,
          mtime,
          embedding,
          chunk.metadata
        );

        stats.chunksCreated++;
      }

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
): Promise<IndexStats> {
  const stats: IndexStats = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0, filesPurged: 0, blocked: [], errors: [] };
  let decision;

  try {
    decision = resolveIndexPath(config, targetPath, true);
  } catch (error) {
    stats.errors.push(error instanceof Error ? error.message : String(error));
    return stats;
  }

  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    if (!decision.allowed) {
      db.deleteByPath(decision.storedPath);
      stats.filesSkipped = 1;
      stats.blocked.push(decision.reason);
      return stats;
    }

    await dependencies.initEmbedder(config.embedding.model);
    const content = readFileSync(decision.filePath, 'utf-8');
    const stat = statSync(decision.filePath);
    const mtime = Math.floor(stat.mtimeMs);
    const storedPath = decision.storedPath;

    db.deleteByPath(storedPath);

    // Determinar tipo pelo path
    let type: SourceConfig['type'] = 'docs';
    if (targetPath.endsWith('.java') || targetPath.endsWith('.ts') || targetPath.endsWith('.tsx')) {
      type = 'code';
    } else if (targetPath.match(/\.(yml|yaml|properties|json|gradle)$/)) {
      type = 'config';
    } else if (targetPath.includes('.vault/')) {
      type = 'vault';
    }

    const chunks = chunkByType(content, type, decision.filePath, config);

    for (const chunk of chunks) {
      const embedding = await dependencies.embed(chunk.content);
      db.insertDocument(storedPath, chunk.index, chunk.content, type, mtime, embedding, chunk.metadata);
      stats.chunksCreated++;
    }

    stats.filesProcessed = 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    stats.errors.push(`${targetPath}: ${msg}`);
  } finally {
    db.close();
  }
  return stats;
}

export function removeSinglePath(config: KxConfig, targetPath: string): void {
  // Deletion deliberately bypasses admission denial: a denied file may have
  // been indexed before the policy was enabled and must still be removable.
  const decision = resolveIndexPath(config, targetPath, false);
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    db.deleteByPath(decision.storedPath);
  } finally {
    db.close();
  }
}

/** Removes indexed paths that have become denied without touching no-policy indexes. */
export function purgeDeniedIndexEntries(db: VectorDatabase, config: KxConfig): number {
  if (!config.indexing?.deny?.length) return 0;
  const deniedPaths = db.listPaths().filter(path => isDeniedDocumentPath(config, path));
  return db.deleteByPaths(deniedPaths);
}
