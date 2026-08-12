import assert from 'node:assert/strict';
import test from 'node:test';
import {
  idleUnloadMinutes,
  initEmbedder,
  isEmbedderLoaded,
  unloadEmbedder,
  embed,
} from '../src/embedder.js';

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES;
  if (value === undefined) delete process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES;
  else process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES;
    else process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES = previous;
  }
}

test('a liberação por ociosidade vem desativada e aceita configuração por ambiente', () => {
  withEnv(undefined, () => assert.equal(idleUnloadMinutes(), 0, 'desativada por padrão'));
  withEnv('30', () => assert.equal(idleUnloadMinutes(), 30));
  withEnv('0', () => assert.equal(idleUnloadMinutes(), 0));
});

test('valores inválidos na configuração caem no padrão', () => {
  withEnv('abc', () => assert.equal(idleUnloadMinutes(), 0));
  withEnv('-5', () => assert.equal(idleUnloadMinutes(), 0));
  withEnv('', () => assert.equal(idleUnloadMinutes(), 0));
});

test('liberar sem nada carregado é uma operação nula', async () => {
  assert.equal(isEmbedderLoaded(), false);
  assert.equal(await unloadEmbedder(), false);
  assert.equal(isEmbedderLoaded(), false);
});

test('o modelo é carregado sob demanda e pode ser liberado', { timeout: 120_000 }, async () => {
  process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES = '0';
  try {
    assert.equal(isEmbedderLoaded(), false, 'nada deve estar carregado antes do primeiro uso');

    await initEmbedder();
    assert.equal(isEmbedderLoaded(), true);

    const vector = await embed('consulta de verificação');
    assert.equal(vector.length, 384, 'o modelo padrão produz vetores de 384 dimensões');

    assert.equal(await unloadEmbedder(), true);
    assert.equal(isEmbedderLoaded(), false);
  } finally {
    delete process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES;
    await unloadEmbedder();
  }
});

test('embed recarrega de forma transparente após a liberação', { timeout: 120_000 }, async () => {
  process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES = '0';
  try {
    await initEmbedder();
    await unloadEmbedder();
    assert.equal(isEmbedderLoaded(), false);

    const vector = await embed('consulta após liberação');

    assert.equal(vector.length, 384);
    assert.equal(isEmbedderLoaded(), true, 'o uso deve recarregar o modelo');
  } finally {
    delete process.env.KX_EMBEDDER_IDLE_UNLOAD_MINUTES;
    await unloadEmbedder();
  }
});
