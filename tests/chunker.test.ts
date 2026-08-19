import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkCode, chunkConfig, chunkMarkdown, recursiveSplit, EMBED_SAFE_TOKENS } from '../src/chunker.js';

// O orçamento em tokens estimados equivale a 3 caracteres por token.
const MAX_CHARS = EMBED_SAFE_TOKENS * 3;

function assertBounded(chunks: Array<{ content: string }>, context: string): void {
  for (const chunk of chunks) {
    assert.ok(
      chunk.content.length <= MAX_CHARS,
      `${context}: chunk de ${chunk.content.length} chars excede o orçamento de ${MAX_CHARS}`,
    );
  }
}

test('nenhum chunk excede o orçamento seguro do modelo, mesmo com maxTokens configurado maior', () => {
  const paragraph = 'A política de parcelamento define o gatilho de ativação por SKU e loja. ';
  const content = Array.from({ length: 40 }, (_, i) => `## Seção ${i}\n\n${paragraph.repeat(60)}`).join('\n\n');

  // 1024 era a configuração real que causava 51% de truncamento silencioso.
  const chunks = chunkMarkdown(content, 1024, 50);
  assert.ok(chunks.length > 0);
  assertBounded(chunks, 'markdown');
});

test('texto sem nenhuma estrutura (linha única gigante) é dividido por caractere', () => {
  // O bug original: dividir pelo primeiro separador presente e retornar sem
  // verificar as partes deixou chunks de ~1 MB no índice real.
  const giant = 'x'.repeat(200_000);
  const parts = recursiveSplit(giant, EMBED_SAFE_TOKENS, 0);
  assert.ok(parts.length >= Math.floor(200_000 / MAX_CHARS));
  for (const part of parts) {
    assert.ok(part.length <= MAX_CHARS, `parte de ${part.length} chars excede ${MAX_CHARS}`);
  }
  // Nada se perde na divisão sem overlap.
  assert.equal(parts.join('').length, 200_000);
});

test('parágrafo único acima do limite desce a escada de separadores', () => {
  const sentence = 'O consumidor processa o evento e grava o resultado na tabela de saída. ';
  const singleParagraph = sentence.repeat(80); // sem \n\n interno
  const parts = recursiveSplit(singleParagraph, EMBED_SAFE_TOKENS, 0);
  assert.ok(parts.length > 1, 'deveria ter dividido o parágrafo gigante');
  for (const part of parts) {
    assert.ok(part.length <= MAX_CHARS);
  }
});

test('overlap não reintroduz estouro de orçamento', () => {
  const sentence = 'Registro de decisão arquitetural sobre o fluxo de pagamento na loja. ';
  const content = sentence.repeat(200);
  const parts = recursiveSplit(content, 100, 50);
  for (const part of parts) {
    assert.ok(part.length <= 300, `parte de ${part.length} chars excede 100 tokens estimados`);
  }
});

test('código Java com método gigante é dividido de forma limitada', () => {
  const header = 'package br.com.exemplo;\nimport java.util.List;\n';
  const bigBody = '  private void processa() {\n' + '    linha.deProcessamento(compridaOSuficiente);\n'.repeat(3000) + '  }\n';
  const content = `${header}\npublic class Grande {\n${bigBody}}\n`;
  const chunks = chunkCode(content, 1024, 'Grande.java');
  assert.ok(chunks.length > 1);
  assertBounded(chunks, 'java');
});

test('configuração longa também respeita o orçamento', () => {
  const content = Array.from({ length: 2000 }, (_, i) => `chave.numero.${i}=valor-${i}`).join('\n');
  const chunks = chunkConfig(content, 4096);
  assert.ok(chunks.length > 1);
  assertBounded(chunks, 'config');
});
