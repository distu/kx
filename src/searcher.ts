import { relative } from 'path';
import type { KxConfig, SourceConfig } from './config.js';
import { VectorDatabase, type SearchResult } from './database.js';
import { initEmbedder, embed } from './embedder.js';

// Sobre-busca aplicada apenas quando ao menos uma fonte configura `weight` > 1,
// para permitir que resultados priorizados "subam" no ranking mesmo que não
// estivessem entre os topK brutos por distância pura.
const OVERFETCH_FACTOR = 5;
const OVERFETCH_CAP = 200;

function hasWeightedSources(sources: SourceConfig[]): boolean {
  return sources.some(s => typeof s.weight === 'number' && s.weight > 1);
}

/**
 * Resolve o peso efetivo de um documento pelo prefixo de path mais específico
 * entre as fontes configuradas com `weight` > 1. Sem match, peso é 1 (neutro).
 */
function resolveWeight(docPath: string, sources: SourceConfig[], projectRoot: string): number {
  let bestWeight = 1;
  let bestPrefixLen = -1;

  for (const source of sources) {
    if (typeof source.weight !== 'number' || source.weight <= 1) continue;

    const sourceRelPath = relative(projectRoot, source.path);
    const matches = sourceRelPath === '' || docPath === sourceRelPath
      || docPath.startsWith(`${sourceRelPath}/`);

    if (matches && sourceRelPath.length > bestPrefixLen) {
      bestPrefixLen = sourceRelPath.length;
      bestWeight = source.weight;
    }
  }

  return bestWeight;
}

export async function search(
  config: KxConfig,
  query: string,
  topK: number = 10,
  sourceType?: string
): Promise<SearchResult[]> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  await initEmbedder(config.embedding.model);

  const queryEmbedding = await embed(query);

  // Caminho padrão: nenhuma fonte com peso configurado -> comportamento
  // idêntico ao anterior, byte a byte (zero mudança para quem não configurar).
  if (!hasWeightedSources(config.sources)) {
    const results = db.search(queryEmbedding, topK, sourceType);
    db.close();
    return results;
  }

  const overfetchK = Math.min(topK * OVERFETCH_FACTOR, OVERFETCH_CAP);
  const rawResults = db.search(queryEmbedding, overfetchK, sourceType);

  const reranked = rawResults
    .map(r => {
      const weight = resolveWeight(r.path, config.sources, config.projectRoot);
      return { result: r, adjustedDistance: r.distance / weight };
    })
    .sort((a, b) => a.adjustedDistance - b.adjustedDistance)
    .slice(0, topK)
    .map(r => r.result);

  db.close();
  return reranked;
}

export function getStatus(config: KxConfig) {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  const stats = db.getStats();
  db.close();
  return stats;
}
