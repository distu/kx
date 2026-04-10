import type { KxConfig } from './config.js';
import { VectorDatabase, type SearchResult } from './database.js';
import { initEmbedder, embed } from './embedder.js';

export async function search(
  config: KxConfig,
  query: string,
  topK: number = 10,
  sourceType?: string
): Promise<SearchResult[]> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  await initEmbedder(config.embedding.model);

  const queryEmbedding = await embed(query);
  const results = db.search(queryEmbedding, topK, sourceType);

  db.close();
  return results;
}

export function getStatus(config: KxConfig) {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  const stats = db.getStats();
  db.close();
  return stats;
}
