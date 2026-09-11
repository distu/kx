import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type KxConfig } from '../src/config.js';
import { addActivity, updateActivity } from '../src/megabrain.js';
import { registerArtifact, linkArtifact, listArtifacts, listArtifactRecords } from '../src/artifacts.js';

const SESSAO = '11111111-2222-3333-4444-555555555555';

async function makeProject(): Promise<{ root: string; config: KxConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'kx-artifacts-'));
  await mkdir(join(root, '.vault'), { recursive: true });
  await writeFile(join(root, '.kx.json'), JSON.stringify({
    project: 'temporary-artifacts-test',
    index: './index.sqlite',
    sources: [{ type: 'vault', path: './.vault', glob: '**/*.md' }],
    embedding: { model: 'test', dimensions: 2 },
  }));
  return { root, config: loadConfig(root) };
}

test('registra artefato e vincula pela sessao da atividade', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const act = addActivity(config, { titulo: 'Canais de release do edge', sessao: SESSAO });

  const r = registerArtifact(config, {
    url: 'https://claude.ai/code/artifact/abc-123',
    titulo: 'Painel de canais de release',
    descricao: 'Três branches, tags candidatas e rollback por terminal.',
    arquivo: join(root, '.docs', 'canais.html'),
    sessao: SESSAO,
  });

  assert.equal(r.novo, true);
  assert.equal(r.record.versao, 1);
  assert.equal(r.record.atividade, act.slug, 'artefato deve cair na atividade que declarou a sessao');
  assert.equal(r.record.arquivo, '.docs/canais.html', 'arquivo dentro do projeto vira caminho relativo');

  const indice = await readFile(join(root, '.vault', 'ARTEFATOS.md'), 'utf-8');
  assert.match(indice, /Painel de canais de release/);
  assert.match(indice, /https:\/\/claude\.ai\/code\/artifact\/abc-123/);
  assert.match(indice, /Três branches/, 'acentuacao preservada no indice');
  assert.match(indice, new RegExp(`\\[\\[${act.slug}\\]\\]`), 'indice referencia a atividade');

  const nota = await readFile(join(root, '.vault', 'megabrain', `${act.slug}.md`), 'utf-8');
  assert.match(nota, /## Artefatos Publicados/);
  assert.match(nota, /\(https:\/\/claude\.ai\/code\/artifact\/abc-123\) — v1/);

  const readme = await readFile(join(root, '.vault', 'artefatos', 'README.md'), 'utf-8');
  assert.match(readme, /Registro de artefatos publicados/);
});

test('republicar a mesma URL versiona em vez de duplicar', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  addActivity(config, { titulo: 'Atividade alvo', sessao: SESSAO });
  const url = 'https://claude.ai/code/artifact/dup-1';
  registerArtifact(config, { url, titulo: 'Primeira', descricao: 'v1', sessao: SESSAO });
  const segunda = registerArtifact(config, { url, label: 'ajuste de acentos', sessao: SESSAO });

  assert.equal(segunda.novo, false);
  assert.equal(segunda.record.versao, 2);
  assert.equal(segunda.record.titulo, 'Primeira', 'republish sem titulo nao apaga o titulo anterior');
  assert.equal(segunda.record.historico.length, 2);
  assert.equal(segunda.record.historico[1].label, 'ajuste de acentos');
  assert.equal(listArtifactRecords(config).length, 1, 'uma entrada por URL');

  const nota = await readFile(join(root, '.vault', 'megabrain', 'atividade-alvo.md'), 'utf-8');
  assert.equal((nota.match(/artifact\/dup-1/g) || []).length, 1, 'linha da atividade e atualizada, nao duplicada');
  assert.match(nota, /— v2 /);
});

test('artefato sem atividade fica orfao e pode ser vinculado depois', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const r = registerArtifact(config, {
    url: 'https://claude.ai/code/artifact/orfao-9',
    titulo: 'Sem dono',
    sessao: 'sessao-que-ninguem-declarou',
  });
  assert.equal(r.record.atividade, undefined);
  assert.match(await readFile(join(root, '.vault', 'ARTEFATOS.md'), 'utf-8'), /## Sem atividade vinculada\n\n- \*\*Sem dono\*\*/);
  assert.match(listArtifacts(config), /SEM atividade vinculada/);

  const act = addActivity(config, { titulo: 'Dona tardia' });
  const l = linkArtifact(config, 'https://claude.ai/code/artifact/orfao-9', String(act.id));
  assert.equal(l.record.atividade, act.slug, 'aceita o ID numerico da atividade');
  assert.match(await readFile(join(root, '.vault', 'megabrain', `${act.slug}.md`), 'utf-8'), /Sem dono/);
});

test('filtra por atividade e recusa URL malformada', async (t) => {
  const { root, config } = await makeProject();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const a = addActivity(config, { titulo: 'Alfa', sessao: SESSAO });
  registerArtifact(config, { url: 'https://claude.ai/code/artifact/a-1', titulo: 'Da Alfa', sessao: SESSAO });
  updateActivity(config, { slug: a.slug, tipo: 'avanco', texto: 'seguiu' });
  registerArtifact(config, { url: 'https://claude.ai/code/artifact/b-2', titulo: 'Orfao', sessao: 'outra' });

  const soAlfa = listArtifacts(config, { atividade: a.slug });
  assert.match(soAlfa, /Da Alfa/);
  assert.doesNotMatch(soAlfa, /Orfao/);

  assert.throws(() => registerArtifact(config, { url: 'javascript:alert(1)' }), /url invalida/);
  assert.throws(() => registerArtifact(config, { url: 'https://ex.com/a)(b' }), /url invalida/);
  assert.throws(
    () => registerArtifact(config, { url: 'https://claude.ai/code/artifact/x', atividade: 'nao-existe' }),
    /atividade nao encontrada/,
  );
});
