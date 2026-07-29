import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

let extractor: FeatureExtractionPipeline | null = null;

export async function initEmbedder(model: string = 'Xenova/all-MiniLM-L6-v2'): Promise<void> {
  if (extractor) return;
  console.error(`Carregando modelo de embedding: ${model}...`);
  // A sobrecarga genérica do Transformers.js fica excessivamente complexa em
  // algumas versões do TypeScript; a API retornada continua tipada abaixo.
  extractor = await (pipeline as any)('feature-extraction', model, {
    dtype: 'fp32',
  }) as FeatureExtractionPipeline;
  console.error('Modelo carregado.');
}

export async function embed(text: string): Promise<Float32Array> {
  if (!extractor) {
    throw new Error('Embedder não inicializado. Chame initEmbedder() primeiro.');
  }

  const output = await extractor(text, {
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
