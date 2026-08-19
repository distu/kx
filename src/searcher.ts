import { createHash } from 'node:crypto';
import { relative } from 'path';
import type { KxConfig, RecencyConfig, SourceConfig } from './config.js';
import { VectorDatabase, type SearchResult } from './database.js';
import { initEmbedder, embed } from './embedder.js';
import { purgeDeniedIndexEntries } from './indexer.js';

export interface SearchDependencies {
  initEmbedder: (model: string) => Promise<void>;
  embed: (text: string) => Promise<Float32Array>;
}

const defaultDependencies: SearchDependencies = { initEmbedder, embed };

/** Como o chunk foi encontrado: pela via vetorial, pela lexical, ou por ambas. */
export type MatchOrigin = 'vetorial' | 'lexical' | 'ambas';

export interface HybridSearchResult extends SearchResult {
  /** Score final da fusão (RRF x peso da fonte x recência). Maior = melhor. */
  score: number;
  matchedBy: MatchOrigin;
}

/**
 * Constante k do Reciprocal Rank Fusion, no valor canônico da literatura
 * (Cormack et al.). Valores maiores achatam a diferença entre posições;
 * 60 é o equilíbrio validado em praticamente todo estudo de fusão desde então.
 */
const RRF_K = 60;

/** Sobre-busca por via, para a fusão ter material dos dois lados. */
const OVERFETCH_MIN = 50;
const OVERFETCH_FACTOR = 5;
const OVERFETCH_CAP = 200;

/**
 * A reconciliação da denylist varre todos os paths do índice (centenas de ms
 * em índices grandes). Ela precisa acontecer quando uma política muda, não a
 * cada consulta: uma vez por (índice, política) dentro do processo cobre o
 * primeiro uso após qualquer edição de configuração sem taxar as demais.
 */
const reconciledPolicies = new Set<string>();

function policyKey(config: KxConfig): string {
  return `${config.index}::${(config.indexing?.deny ?? []).join('|')}`;
}

function reconcileOnce(db: VectorDatabase, config: KxConfig): void {
  const key = policyKey(config);
  if (reconciledPolicies.has(key)) return;
  reconciledPolicies.add(key);
  purgeDeniedIndexEntries(db, config);
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

/**
 * Peso da fonte como multiplicador sublinear do score fundido.
 *
 * O peso configurado (2..5) marca fontes canônicas. Aplicado linearmente ao
 * RRF ele catapultaria qualquer resultado fraco da fonte pesada acima do
 * melhor resultado das demais; o log2 preserva a intenção (canônico vence em
 * empate ou proximidade) sem soterrar relevância real: peso 5 vira ~3.3x.
 */
function weightMultiplier(weight: number): number {
  if (weight <= 1) return 1;
  return 1 + Math.log2(weight);
}

/**
 * Impulso de recência: decaimento exponencial por meia-vida sobre o mtime.
 *
 * Multiplicador limitado a [1, 1+weight]. A literatura de freshness ranking
 * converge para decaimento exponencial, e para nunca somar o termo temporal
 * diretamente ao score de relevância — escala diferente domina a fusão. Como
 * multiplicador limitado, um documento recém-editado ganha no máximo +30%
 * (padrão), o suficiente para desempatar a decisão nova contra a antiga sem
 * enterrar um resultado muito mais relevante.
 */
function recencyMultiplier(modifiedAt: number, recency: RecencyConfig | false | undefined, now: number): number {
  if (!recency || !modifiedAt || modifiedAt <= 0) return 1;
  const ageDays = Math.max(0, (now - modifiedAt) / 86_400_000);
  return 1 + recency.weight * Math.pow(2, -ageDays / recency.halfLifeDays);
}

interface FusionEntry {
  result: SearchResult;
  vectorRank?: number;
  lexicalRank?: number;
}

function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Busca híbrida: vetorial (sqlite-vec) + lexical (FTS5/BM25), fundidas por
 * Reciprocal Rank Fusion e moduladas por peso de fonte e recência.
 *
 * A via vetorial acha paráfrase e conceito; a lexical acha o que a vetorial
 * comprovadamente perde — identificadores exatos, nomes de configuração,
 * mensagens de erro. RRF ignora as escalas incomensuráveis dos dois scores e
 * funde por posição no ranking. Duplicatas byte-idênticas (docs replicadas
 * entre repositórios) são colapsadas na melhor colocada, liberando vagas do
 * top-K para conteúdo distinto.
 */
export async function search(
  config: KxConfig,
  query: string,
  topK: number = 10,
  sourceType?: string,
  dependencies: SearchDependencies = defaultDependencies,
): Promise<HybridSearchResult[]> {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    // A busca pode ser o primeiro comando KX após uma mudança de política.
    // Reconciliar uma vez por política mantém a garantia sem custo por query.
    reconcileOnce(db, config);
    await dependencies.initEmbedder(config.embedding.model);
    const queryEmbedding = await dependencies.embed(query);

    const overfetch = Math.min(Math.max(topK * OVERFETCH_FACTOR, OVERFETCH_MIN), OVERFETCH_CAP);
    const vectorHits = db.search(queryEmbedding, overfetch, sourceType);
    const lexicalHits = db.searchLexical(query, overfetch, sourceType);

    const entries = new Map<string, FusionEntry>();

    vectorHits.forEach((hit, i) => {
      const key = `${hit.path}#${hit.chunk_index}`;
      entries.set(key, { result: hit, vectorRank: i + 1 });
    });

    lexicalHits.forEach((hit, i) => {
      const key = `${hit.path}#${hit.chunk_index}`;
      const existing = entries.get(key);
      if (existing) {
        existing.lexicalRank = i + 1;
      } else {
        const { bm25: _bm25, ...result } = hit;
        entries.set(key, { result, lexicalRank: i + 1 });
      }
    });

    const now = Date.now();
    const recency = config.search?.recency;

    const scored = [...entries.values()].map(entry => {
      let rrf = 0;
      if (entry.vectorRank !== undefined) rrf += 1 / (RRF_K + entry.vectorRank);
      if (entry.lexicalRank !== undefined) rrf += 1 / (RRF_K + entry.lexicalRank);

      const weight = resolveWeight(entry.result.path, config.sources, config.projectRoot);
      const score = rrf
        * weightMultiplier(weight)
        * recencyMultiplier(entry.result.modified_at, recency, now);

      const matchedBy: MatchOrigin = entry.vectorRank !== undefined && entry.lexicalRank !== undefined
        ? 'ambas'
        : entry.vectorRank !== undefined ? 'vetorial' : 'lexical';

      return { ...entry.result, score, matchedBy };
    });

    scored.sort((a, b) => b.score - a.score);

    // Dedup por conteúdo: a melhor colocada representa o grupo.
    const seen = new Set<string>();
    const deduped: HybridSearchResult[] = [];
    for (const result of scored) {
      const hash = contentHash(result.content);
      if (seen.has(hash)) continue;
      seen.add(hash);
      deduped.push(result);
      if (deduped.length >= topK) break;
    }

    return deduped;
  } finally {
    db.close();
  }
}

export function getStatus(config: KxConfig) {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  const stats = db.getStats();
  db.close();
  return stats;
}
