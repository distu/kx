import assert from 'node:assert/strict';
import test from 'node:test';
import { numberFromEnv } from '../src/env.js';

const NAME = 'KX_TEST_NUMBER_FROM_ENV';

function withValue(value: string | undefined, run: () => void): void {
  const previous = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[NAME];
    else process.env[NAME] = previous;
  }
}

test('usa o padrão quando a variável não está definida', () => {
  withValue(undefined, () => assert.equal(numberFromEnv(NAME, 7), 7));
});

test('trata string vazia ou só espaços como não definida', () => {
  withValue('', () => assert.equal(numberFromEnv(NAME, 7), 7));
  withValue('   ', () => assert.equal(numberFromEnv(NAME, 7), 7));
});

test('lê valores numéricos, incluindo zero e frações', () => {
  withValue('0', () => assert.equal(numberFromEnv(NAME, 7, { min: 0 }), 0));
  withValue('0.5', () => assert.equal(numberFromEnv(NAME, 7, { min: 0 }), 0.5));
  withValue('120', () => assert.equal(numberFromEnv(NAME, 7), 120));
});

test('usa o padrão quando o valor não é um número finito', () => {
  withValue('abc', () => assert.equal(numberFromEnv(NAME, 7), 7));
  withValue('Infinity', () => assert.equal(numberFromEnv(NAME, 7), 7));
  withValue('NaN', () => assert.equal(numberFromEnv(NAME, 7), 7));
});

test('usa o padrão quando o valor fica abaixo do mínimo', () => {
  withValue('-1', () => assert.equal(numberFromEnv(NAME, 7, { min: 0 }), 7));
  withValue('-1', () => assert.equal(numberFromEnv(NAME, 7), -1, 'sem mínimo, negativos são aceitos'));
});
