/**
 * Teste de stress do kx com o pipeline REAL (modelo de embedding de verdade).
 *
 * Gera um projeto sintético descartável, indexa do zero, mede vazão de
 * indexação, latência de busca (p50/p95), busca concorrente, e compara o
 * recall de termo exato da busca híbrida contra a via vetorial pura.
 *
 * Uso: /opt/homebrew/bin/node --import tsx scripts/stress.ts [arquivos-por-tipo]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { indexProject } from '../src/indexer.js';
import { search } from '../src/searcher.js';
import { VectorDatabase } from '../src/database.js';
import { embed, initEmbedder } from '../src/embedder.js';

const FILES_PER_TYPE = parseInt(process.argv[2] || '300', 10);

const TOPICS = [
  'autenticação no gateway com token temporário',
  'provisionamento de terminal na loja física',
  'sincronização de preços entre nuvem e borda',
  'política de desconto por categoria de produto',
  'fila de eventos com retentativa exponencial',
  'circuito de pagamento com estorno parcial',
  'reconciliação noturna do estoque central',
  'observabilidade com métricas por serviço',
];

const SENTENCES = [
  'O serviço valida a requisição antes de propagar o evento para o barramento.',
  'A configuração efetiva é resolvida em camadas, da mais específica para a global.',
  'Falhas transitórias entram na fila de retentativa com atraso exponencial.',
  'O consumidor confirma o offset apenas após persistir o resultado.',
  'Cada loja possui um tópico dedicado provisionado pela pipeline de infraestrutura.',
  'O contrato da API é a fonte de verdade e gera a documentação interativa.',
  'A migração aplica o esquema de forma idempotente em todos os ambientes.',
  'O cache local reduz a latência da consulta de preços no caixa.',
];

function markdownFile(i: number): string {
  const topic = TOPICS[i % TOPICS.length];
  const uniq = `IDENTIFICADOR_UNICO_MD_${i}`;
  const sections = Array.from({ length: 6 }, (_, s) => {
    const body = Array.from({ length: 8 }, (_, k) => SENTENCES[(i + s + k) % SENTENCES.length]).join(' ');
    return `## Seção ${s} de ${topic}\n\n${body}${s === 3 ? ` A chave de controle é ${uniq}.` : ''}`;
  }).join('\n\n');
  return `# Documento ${i}: ${topic}\n\n${sections}\n`;
}

function javaFile(i: number): string {
  const uniq = `CONFIG_FLAG_JAVA_${i}`;
  const methods = Array.from({ length: 8 }, (_, m) => `
  public ResultadoOperacao processaEtapa${m}(ContextoExecucao contexto) {
    // ${SENTENCES[(i + m) % SENTENCES.length]}
    if (contexto.obterFlag("${m === 4 ? uniq : `flag_${m}`}")) {
      return executor.executar(contexto.comEtapa(${m}));
    }
    return ResultadoOperacao.ignorado(${m});
  }`).join('\n');
  return `package br.com.stress.gerado;\n\nimport java.util.List;\n\npublic class Servico${i} {\n${methods}\n}\n`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kx-stress-'));
  console.log(`Corpus sintético em ${root} (${FILES_PER_TYPE} md + ${FILES_PER_TYPE} java + ruído excluível)`);

  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  // Ruído que as exclusões embutidas devem pular sem custo:
  mkdirSync(join(root, 'docs', 'node_modules', 'pacote'), { recursive: true });
  mkdirSync(join(root, 'docs', 'worktrees', 'feat-x'), { recursive: true });

  for (let i = 0; i < FILES_PER_TYPE; i++) {
    writeFileSync(join(root, 'docs', `doc-${i}.md`), markdownFile(i));
    writeFileSync(join(root, 'src', `Servico${i}.java`), javaFile(i));
  }
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(root, 'docs', 'node_modules', 'pacote', `ruido-${i}.md`), markdownFile(i));
    writeFileSync(join(root, 'docs', 'worktrees', 'feat-x', `copia-${i}.md`), markdownFile(i));
  }

  writeFileSync(join(root, '.kx.json'), JSON.stringify({
    project: 'kx-stress',
    index: './stress.sqlite',
    sources: [
      { type: 'docs', path: './docs', glob: '**/*.md' },
      { type: 'code', path: './src', glob: '**/*.java' },
    ],
  }, null, 2));

  const config = loadConfig(root);

  try {
    // ---------- 1. Indexação ----------
    const t0 = performance.now();
    const stats = await indexProject(config, 'full');
    const indexMs = performance.now() - t0;
    console.log('\n[1] INDEXAÇÃO COMPLETA');
    console.log(`    arquivos: ${stats.filesProcessed} | chunks: ${stats.chunksCreated} | ignorados: ${stats.filesSkipped} | erros: ${stats.errors.length}`);
    console.log(`    tempo: ${(indexMs / 1000).toFixed(1)}s | vazão: ${(stats.filesProcessed / (indexMs / 1000)).toFixed(1)} arquivos/s, ${(stats.chunksCreated / (indexMs / 1000)).toFixed(1)} chunks/s`);
    if (stats.filesProcessed !== FILES_PER_TYPE * 2) {
      throw new Error(`esperava ${FILES_PER_TYPE * 2} arquivos indexados (ruído excluído), obtive ${stats.filesProcessed}`);
    }

    // ---------- 2. Latência de busca ----------
    const semanticQueries = Array.from({ length: 30 }, (_, i) => TOPICS[i % TOPICS.length]);
    const exactQueries = Array.from({ length: 30 }, (_, i) => i % 2 === 0
      ? `IDENTIFICADOR_UNICO_MD_${(i * 7) % FILES_PER_TYPE}`
      : `CONFIG_FLAG_JAVA_${(i * 11) % FILES_PER_TYPE}`);

    const latencies: number[] = [];
    for (const query of [...semanticQueries, ...exactQueries]) {
      const s = performance.now();
      await search(config, query, 10);
      latencies.push(performance.now() - s);
    }
    latencies.sort((a, b) => a - b);
    console.log('\n[2] LATÊNCIA DE BUSCA HÍBRIDA (60 consultas seriais)');
    console.log(`    p50: ${percentile(latencies, 50).toFixed(0)} ms | p95: ${percentile(latencies, 95).toFixed(0)} ms | max: ${latencies[latencies.length - 1].toFixed(0)} ms`);

    // ---------- 3. Concorrência ----------
    const tC = performance.now();
    await Promise.all(Array.from({ length: 8 }, (_, w) =>
      (async () => {
        for (let q = 0; q < 15; q++) {
          await search(config, `${TOPICS[(w + q) % TOPICS.length]} variação ${q}`, 10);
        }
      })(),
    ));
    const concMs = performance.now() - tC;
    console.log('\n[3] CONCORRÊNCIA (8 workers x 15 consultas = 120 buscas)');
    console.log(`    total: ${(concMs / 1000).toFixed(1)}s | ${(120 / (concMs / 1000)).toFixed(1)} buscas/s`);

    // ---------- 4. Recall de termo exato: híbrida vs vetorial pura ----------
    await initEmbedder(config.embedding.model);
    const db = new VectorDatabase(config.index, config.embedding.dimensions);
    let hybridHits = 0;
    let vectorHits = 0;
    const sample = exactQueries.slice(0, 20);
    for (const term of sample) {
      const hybrid = await search(config, term, 10);
      if (hybrid.some(r => r.content.includes(term))) hybridHits++;
      const vecOnly = db.search(await embed(term), 10);
      if (vecOnly.some(r => r.content.includes(term))) vectorHits++;
    }
    db.close();
    console.log('\n[4] RECALL@10 DE TERMO EXATO (20 identificadores únicos)');
    console.log(`    vetorial pura: ${vectorHits}/${sample.length} | híbrida (RRF): ${hybridHits}/${sample.length}`);

    // ---------- 5. Reindex incremental (nada mudou) ----------
    const tI = performance.now();
    const incr = await indexProject(config, 'incremental');
    console.log('\n[5] REINDEX INCREMENTAL SEM MUDANÇAS');
    console.log(`    tempo: ${((performance.now() - tI) / 1000).toFixed(1)}s | processados: ${incr.filesProcessed} | pulados: ${incr.filesSkipped}`);

    console.log('\nStress concluído sem erros.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Stress falhou:', error);
  process.exit(1);
});
