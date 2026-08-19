import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { VectorDatabase } from '../src/database.js';
import { search, type SearchDependencies } from '../src/searcher.js';

const DAY_MS = 86_400_000;

// Embeddings 2D determinísticos: a query aponta sempre para [0, 1]; docs
// "semanticamente próximos" usam [0, 1] e docs "distantes" usam [1, 0].
const NEAR = new Float32Array([0, 1]);
const FAR = new Float32Array([1, 0]);

const dependencies: SearchDependencies = {
  initEmbedder: async () => {},
  embed: async () => NEAR,
};

async function makeProject(searchConfig?: Record<string, unknown>): Promise<{ root: string; config: KxConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'kx-hybrid-'));
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'hybrid-test',
    index: './index.sqlite',
    sources: [{ type: 'docs', path: '.', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
    ...(searchConfig ? { search: searchConfig } : {}),
  }));
  return { root, config: loadConfig(root) };
}

function insert(config: KxConfig, path: string, content: string, embedding: Float32Array, modifiedAt = Date.now()): void {
  const db = new VectorDatabase(config.index, config.embedding.dimensions);
  try {
    db.insertDocument(path, 0, content, 'docs', modifiedAt, embedding);
  } finally {
    db.close();
  }
}

test('a via lexical resgata identificador exato que a vetorial não alcança', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  // O doc com o identificador é vetorialmente ORTOGONAL à query: só o BM25 o encontra.
  insert(config, 'docs/relay.md', 'O relay aborta com circuit-open quando o tópico da loja não foi provisionado no cluster.', FAR);
  for (let i = 0; i < 5; i++) {
    insert(config, `docs/generico-${i}.md`, `Documento genérico número ${i} sobre configuração do serviço em nuvem.`, NEAR);
  }

  const results = await search(config, 'circuit-open', 3, 'all', dependencies);
  // Num índice minúsculo o overfetch do KNN devolve tudo, então o doc também
  // aparece na via vetorial (em rank fraco). O que importa: o rank 1 lexical
  // vence os docs vetorialmente próximos que não contêm o termo.
  assert.equal(results[0].path, 'docs/relay.md', 'o identificador exato deveria vencer via BM25');
  assert.ok(results[0].matchedBy === 'lexical' || results[0].matchedBy === 'ambas');
});

test('resultado encontrado pelas duas vias soma os dois ranks e sobe', async (t) => {
  const { root, config } = await makeProject({ recency: false });
  t.after(async () => rm(root, { recursive: true, force: true }));

  insert(config, 'docs/ambas.md', 'Guia de provisionamento do terminal na loja com onboard completo.', NEAR);
  insert(config, 'docs/so-vetor.md', 'Documento vagamente relacionado ao assunto, sem os termos da consulta.', NEAR);

  const results = await search(config, 'provisionamento onboard terminal', 5, 'all', dependencies);
  assert.equal(results[0].path, 'docs/ambas.md');
  assert.equal(results[0].matchedBy, 'ambas');
  assert.ok(results[0].score > (results.find(r => r.path === 'docs/so-vetor.md')?.score ?? 0));
});

test('recência desempata a favor do documento mais novo e pode ser desligada', async (t) => {
  const now = Date.now();

  // Mesmo conteúdo semântico, mtimes muito diferentes. Conteúdos distintos
  // por um sufixo para o dedup não colapsá-los.
  const scenario = async (searchConfig: Record<string, unknown> | undefined) => {
    const { root, config } = await makeProject(searchConfig);
    insert(config, 'docs/decisao-antiga.md', 'Decisão de arquitetura sobre autenticação no gateway. (v1)', NEAR, now - 720 * DAY_MS);
    insert(config, 'docs/decisao-nova.md', 'Decisão de arquitetura sobre autenticação no gateway. (v2)', NEAR, now - 1 * DAY_MS);
    const results = await search(config, 'qualquer consulta vetorial', 5, 'all', dependencies);
    await rm(root, { recursive: true, force: true });
    return results;
  };

  const comRecencia = await scenario(undefined);
  assert.equal(comRecencia[0].path, 'docs/decisao-nova.md', 'com recência, a decisão nova vence');
  assert.ok(comRecencia[0].score > comRecencia[1].score);

  const semRecencia = await scenario({ recency: false });
  // Sem recência, o desempate é a ordem do KNN — os scores ficam praticamente
  // iguais (diferem só pelo rank vizinho). O essencial: nenhum boost aplicado.
  const nova = semRecencia.find(r => r.path === 'docs/decisao-nova.md');
  const antiga = semRecencia.find(r => r.path === 'docs/decisao-antiga.md');
  assert.ok(nova && antiga);
  assert.ok(Math.abs(nova.score - antiga.score) < 0.001, 'sem recência não há boost temporal');
});

test('duplicatas byte-idênticas colapsam num único resultado', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const duplicated = 'Runbook de provisionamento de tópicos Kafka por loja, replicado entre repositórios.';
  insert(config, 'repo-a/runbook.md', duplicated, NEAR);
  insert(config, 'repo-b/runbook.md', duplicated, NEAR);
  insert(config, 'docs/outro.md', 'Conteúdo distinto sobre o mesmo tema de provisionamento.', NEAR);

  const results = await search(config, 'provisionamento kafka', 10, 'all', dependencies);
  const copies = results.filter(r => r.content === duplicated);
  assert.equal(copies.length, 1, 'apenas uma cópia do conteúdo duplicado deve ocupar o top-K');
  assert.ok(results.some(r => r.path === 'docs/outro.md'));
});

test('peso de fonte continua promovendo docs canônicos na fusão', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kx-hybrid-weight-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'hybrid-weight-test',
    index: './index.sqlite',
    sources: [
      { type: 'docs', path: './canonico', glob: '**/*.md', weight: 5 },
      { type: 'docs', path: './comum', glob: '**/*.md' },
    ],
    embedding: { model: 'test', dimensions: 2 },
    search: { recency: false },
  }));
  const config = loadConfig(root);

  insert(config, 'comum/doc.md', 'Arquitetura de eventos da plataforma na versão comum.', NEAR);
  insert(config, 'canonico/doc.md', 'Arquitetura de eventos da plataforma na fonte canônica.', NEAR);

  const results = await search(config, 'arquitetura de eventos', 5, 'all', dependencies);
  assert.equal(results[0].path, 'canonico/doc.md');
});
