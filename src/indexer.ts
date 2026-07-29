import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { glob } from 'glob';
import { isAbsolute, relative, resolve } from 'path';
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

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function configuredRoot(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}

/**
 * Ingestão individual é deliberadamente limitada às fontes do .kx.json e ao
 * diretório gerenciado do KX activity manager. Isso impede que uma chamada MCP indexe
 * arquivos arbitrários do sistema e os torne pesquisáveis pelo projeto.
 */
function allowedPath(config: KxConfig, targetPath: string, requireExists: boolean): string {
  const candidate = resolve(config.projectRoot, targetPath);
  const normalized = requireExists ? realpathSync(candidate) : candidate;
  const roots = [
    ...config.sources.map(source => configuredRoot(source.path)),
    configuredRoot(resolve(config.projectRoot, '.vault', 'megabrain')),
  ];
  if (!roots.some(root => isInside(root, normalized))) {
    throw new Error(`caminho fora das fontes configuradas: ${targetPath}`);
  }
  return normalized;
}

function documentPath(config: KxConfig, filePath: string): string {
  return relative(config.projectRoot, filePath).replaceAll('\\', '/');
}

export async function indexProject(
  config: KxConfig,
  mode: 'full' | 'incremental' = 'incremental'
): Promise<IndexStats> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);

  const stats: IndexStats = {
    filesProcessed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    errors: [],
  };

  try {
    await initEmbedder(config.embedding.model);
    if (mode === 'full') db.clearAll();

    for (const source of config.sources) {
      const sourceStats = await indexSource(db, config, source, mode);
      stats.filesProcessed += sourceStats.filesProcessed;
      stats.chunksCreated += sourceStats.chunksCreated;
      stats.filesSkipped += sourceStats.filesSkipped;
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
      // Resolve symlinks antes de ler: uma fonte configurada não pode escapar
      // para um arquivo externo apenas por meio de um link simbólico.
      const safeFilePath = allowedPath(config, filePath, true);
      const storedPath = documentPath(config, safeFilePath);
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
        const embedding = await embed(chunk.content);
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
  targetPath: string
): Promise<IndexStats> {
  const stats: IndexStats = { filesProcessed: 0, chunksCreated: 0, filesSkipped: 0, errors: [] };
  let filePath: string;

  try {
    filePath = allowedPath(config, targetPath, true);
  } catch (error) {
    stats.errors.push(error instanceof Error ? error.message : String(error));
    return stats;
  }

  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    await initEmbedder(config.embedding.model);
    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    const mtime = Math.floor(stat.mtimeMs);
    const storedPath = documentPath(config, filePath);

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

    const chunks = chunkByType(content, type, targetPath, config);

    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
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
  const filePath = allowedPath(config, targetPath, false);
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    db.deleteByPath(documentPath(config, filePath));
  } finally {
    db.close();
  }
}
