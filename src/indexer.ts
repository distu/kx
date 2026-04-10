import { readFileSync, statSync } from 'fs';
import { glob } from 'glob';
import { relative } from 'path';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase } from './database.js';
import { initEmbedder, embed } from './embedder.js';
import { chunkMarkdown, chunkCode, chunkConfig } from './chunker.js';

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  filesSkipped: number;
  errors: string[];
}

export async function indexProject(
  config: KxConfig,
  mode: 'full' | 'incremental' = 'incremental'
): Promise<IndexStats> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  await initEmbedder(config.embedding.model);

  const stats: IndexStats = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    errors: [],
  };

  for (const source of config.sources) {
    const sourceStats = await indexSource(db, config, source, mode);
    stats.filesProcessed += sourceStats.filesProcessed;
    stats.chunksCreated += sourceStats.chunksCreated;
    stats.filesSkipped += sourceStats.filesSkipped;
    stats.errors.push(...sourceStats.errors);
  }

  db.close();
  return stats;
}

async function indexSource(
  db: VectorDatabase,
  config: KxConfig,
  source: SourceConfig,
  mode: 'full' | 'incremental'
): Promise<IndexStats> {
  const stats: IndexStats = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
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
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs);

      // No modo incremental, pular se não mudou
      if (mode === 'incremental') {
        const lastMtime = db.getModifiedAt(filePath);
        if (lastMtime !== null && lastMtime >= mtime) {
          stats.filesSkipped++;
          continue;
        }
      }

      const content = readFileSync(filePath, 'utf-8');

      // Pular arquivos vazios ou binários
      if (!content || content.length < 10) {
        stats.filesSkipped++;
        continue;
      }

      // Deletar chunks antigos
      db.deleteByPath(filePath);

      // Chunking baseado no tipo
      const chunks = chunkByType(content, source.type, filePath, config);

      // Indexar cada chunk
      for (const chunk of chunks) {
        const embedding = await embed(chunk.content);
        const relativePath = relative(process.cwd(), filePath);

        db.insertDocument(
          relativePath,
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
  targetPath: string
): Promise<IndexStats> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  await initEmbedder(config.embedding.model);

  const stats: IndexStats = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0, errors: [] };

  try {
    const content = readFileSync(targetPath, 'utf-8');
    const stat = statSync(targetPath);
    const mtime = Math.floor(stat.mtimeMs);

    db.deleteByPath(targetPath);

    // Determinar tipo pelo path
    let type: SourceConfig['type'] = 'docs';
    if (targetPath.endsWith('.java') || targetPath.endsWith('.ts') || targetPath.endsWith('.tsx')) {
      type = 'code';
    } else if (targetPath.match(/\.(yml|yaml|properties|json|gradle)$/)) {
      type = 'config';
    } else if (targetPath.includes('.vault/')) {
      type = 'vault';
    }

    const chunks = chunkByType(content, type, targetPath, config);

    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      const relativePath = relative(process.cwd(), targetPath);
      db.insertDocument(relativePath, chunk.index, chunk.content, type, mtime, embedding, chunk.metadata);
      stats.chunksCreated++;
    }

    stats.filesProcessed = 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    stats.errors.push(`${targetPath}: ${msg}`);
  }

  db.close();
  return stats;
}
