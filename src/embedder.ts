import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { numberFromEnv } from './env.js';

/**
 * Carga do modelo de embedding com ciclo de vida.
 *
 * A biblioteca custa cerca de 28 MB apenas para ser importada, e o modelo
 * carregado custa mais de 130 MB. O import é dinâmico para que processos que
 * nunca fazem busca não paguem nem o primeiro custo.
 *
 * A liberação por inatividade existe, mas vem desativada por padrão. A memória
 * do modelo é quase toda nativa, do runtime de inferência, e medições mostram
 * que encerrar a sessão devolve pouco ao sistema: o alocador nativo mantém a
 * arena reservada. Ligar a liberação, portanto, custa uma recarga de vários
 * segundos na busca seguinte sem reduzir de fato o consumo. Quem recupera a
 * memória de um processo ocioso é o encerramento do processo.
 */

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_IDLE_UNLOAD_MINUTES = 0;

type DisposablePipeline = FeatureExtractionPipeline & { dispose?: () => Promise<void> };

let extractor: DisposablePipeline | null = null;
let loading: Promise<DisposablePipeline> | null = null;
let currentModel = DEFAULT_MODEL;
let idleTimer: NodeJS.Timeout | null = null;
let lastUsedAt = 0;

/**
 * Minutos de ociosidade antes de liberar o modelo. `0`, o padrão, desativa a
 * liberação automática.
 */
export function idleUnloadMinutes(): number {
  return numberFromEnv('KX_EMBEDDER_IDLE_UNLOAD_MINUTES', DEFAULT_IDLE_UNLOAD_MINUTES, { min: 0 });
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * Renova a janela de ociosidade.
 *
 * O timer é `unref`ado para que um processo de vida curta, como uma busca pela
 * linha de comando, não fique preso esperando a janela expirar. A contrapartida
 * é que um laço de eventos bloqueado em entrada e saída pode não avaliar o
 * timer no instante previsto; por isso `unloadIfIdle` existe, para que um
 * processo de vida longa possa acionar a liberação a partir do próprio ciclo de
 * verificação.
 */
function scheduleIdleUnload(): void {
  clearIdleTimer();
  lastUsedAt = Date.now();
  const minutes = idleUnloadMinutes();
  if (minutes <= 0) return;

  idleTimer = setTimeout(() => {
    void unloadEmbedder();
  }, minutes * 60_000);
  idleTimer.unref?.();
}

/**
 * Libera o modelo se a janela de ociosidade já tiver expirado. Pensado para ser
 * chamado periodicamente por quem já tem um ciclo de verificação ativo.
 */
export async function unloadIfIdle(): Promise<boolean> {
  if (!extractor) return false;
  const minutes = idleUnloadMinutes();
  if (minutes <= 0) return false;
  if (Date.now() - lastUsedAt < minutes * 60_000) return false;
  return unloadEmbedder();
}

export async function initEmbedder(model: string = DEFAULT_MODEL): Promise<void> {
  await loadExtractor(model);
}

/**
 * Carrega o modelo no máximo uma vez por janela. A promessa compartilhada
 * impede que chamadas concorrentes instanciem dois modelos.
 */
async function loadExtractor(model: string): Promise<DisposablePipeline> {
  if (extractor && model === currentModel) {
    scheduleIdleUnload();
    return extractor;
  }
  if (loading && model === currentModel) return loading;

  currentModel = model;
  // Import dinâmico: processos que nunca buscam não pagam o custo da biblioteca.
  loading = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    console.error(`Carregando modelo de embedding: ${model}...`);
    // A sobrecarga genérica do Transformers.js fica excessivamente complexa em
    // algumas versões do TypeScript; a API retornada continua tipada abaixo.
    const loaded = await (pipeline as any)('feature-extraction', model, {
      dtype: 'fp32',
    }) as DisposablePipeline;
    console.error('Modelo carregado.');
    return loaded;
  })();

  try {
    extractor = await loading;
  } finally {
    loading = null;
  }

  scheduleIdleUnload();
  return extractor;
}

/**
 * Libera o modelo. Idempotente: retorna `false` quando não havia nada
 * carregado.
 *
 * A memória do modelo é majoritariamente nativa (runtime ONNX), não do heap do
 * V8, então o `dispose` encerra a sessão de inferência mas a devolução ao
 * sistema depende da coleta subsequente. Por isso esta função é uma redução de
 * pressão, não uma garantia de queda imediata de RSS.
 */
export async function unloadEmbedder(): Promise<boolean> {
  clearIdleTimer();
  if (!extractor) return false;

  const released = extractor;
  extractor = null;
  try {
    await released.dispose?.();
  } catch (error) {
    // Liberar é best-effort: a referência já foi solta para o coletor, e uma
    // falha aqui não deve derrubar o processo.
    console.error('Falha ao liberar o modelo de embedding:', error);
  }
  return true;
}

export function isEmbedderLoaded(): boolean {
  return extractor !== null;
}

export async function embed(text: string): Promise<Float32Array> {
  // Recarrega de forma transparente caso o modelo tenha sido liberado entre o
  // `initEmbedder` do chamador e o uso efetivo.
  const active = extractor ?? await loadExtractor(currentModel);
  scheduleIdleUnload();

  const output = await active(text, {
    pooling: 'mean',
    normalize: true,
  });

  return new Float32Array(output.data as Float64Array);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
