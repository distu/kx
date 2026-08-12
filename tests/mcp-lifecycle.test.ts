import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleGuard, type ShutdownReason } from '../src/mcp-lifecycle.js';

/**
 * Relógio e PID de pai controlados pelo teste, para que o comportamento seja
 * verificado sem esperar tempo real e sem encerrar o processo de teste.
 */
function makeHarness(overrides: Parameters<typeof createLifecycleGuard>[0] = {}) {
  let clock = 1_000;
  let parentPid = 4242;
  const exits: number[] = [];
  const reasons: ShutdownReason[] = [];

  const guard = createLifecycleGuard({
    now: () => clock,
    getParentPid: () => parentPid,
    exit: (code) => { exits.push(code); },
    log: () => {},
    onShutdown: (reason) => { reasons.push(reason); },
    ...overrides,
  });

  return {
    guard,
    exits,
    reasons,
    advance: (ms: number) => { clock += ms; },
    setParentPid: (pid: number) => { parentPid = pid; },
  };
}

test('não encerra enquanto a ociosidade está dentro do limite', () => {
  const h = makeHarness({ idleShutdownMs: 60_000, watchParent: false });

  h.advance(59_999);
  h.guard.check();

  assert.deepEqual(h.exits, []);
  assert.deepEqual(h.reasons, []);
});

test('encerra quando a ociosidade atinge o limite', async () => {
  const h = makeHarness({ idleShutdownMs: 60_000, watchParent: false });

  h.advance(60_000);
  h.guard.check();
  await Promise.resolve();

  assert.deepEqual(h.reasons, ['idle']);
  assert.deepEqual(h.exits, [0]);
});

test('atividade adia o encerramento por ociosidade', async () => {
  const h = makeHarness({ idleShutdownMs: 60_000, watchParent: false });

  h.advance(59_000);
  h.guard.touch();
  h.advance(59_000);
  h.guard.check();
  await Promise.resolve();

  assert.deepEqual(h.exits, [], 'o touch deveria ter reiniciado a janela');

  h.advance(1_000);
  h.guard.check();
  await Promise.resolve();

  assert.deepEqual(h.reasons, ['idle']);
});

test('encerra quando o processo é reparentado para o supervisor do sistema', async () => {
  const h = makeHarness({ idleShutdownMs: 0, watchParent: true });

  h.setParentPid(1);
  h.guard.check();
  await Promise.resolve();

  assert.deepEqual(h.reasons, ['orphaned']);
  assert.deepEqual(h.exits, [0]);
});

test('encerra quando o pai muda para outro processo', async () => {
  const h = makeHarness({ idleShutdownMs: 0, watchParent: true });

  h.setParentPid(9999);
  h.guard.check();
  await Promise.resolve();

  assert.deepEqual(h.reasons, ['orphaned']);
});

test('ociosidade desativada com zero mantém o processo vivo indefinidamente', () => {
  const h = makeHarness({ idleShutdownMs: 0, watchParent: false });

  h.advance(30 * 24 * 60 * 60 * 1000);
  h.guard.check();

  assert.deepEqual(h.exits, []);
});

test('encerra uma única vez mesmo sob verificações repetidas', async () => {
  const h = makeHarness({ idleShutdownMs: 1_000, watchParent: false });

  h.advance(5_000);
  h.guard.check();
  h.guard.check();
  await h.guard.shutdown('signal');

  assert.deepEqual(h.reasons, ['idle']);
  assert.deepEqual(h.exits, [0]);
});

test('falha ao liberar recursos não impede a saída', async () => {
  const h = makeHarness({
    idleShutdownMs: 1_000,
    watchParent: false,
    onShutdown: () => { throw new Error('falha simulada na liberação'); },
  });

  h.advance(2_000);
  await h.guard.shutdown('idle');

  assert.deepEqual(h.exits, [0]);
});

test('sem ociosidade e sem vigilância do pai, nenhum timer é agendado', () => {
  const h = makeHarness({ idleShutdownMs: 0, watchParent: false });

  h.guard.start();

  assert.equal(h.guard.isRunning(), false);
});

test('start agenda o timer e stop o cancela', () => {
  const h = makeHarness({ idleShutdownMs: 60_000, watchParent: false, checkIntervalMs: 10_000 });

  h.guard.start();
  assert.equal(h.guard.isRunning(), true);

  h.guard.start();
  assert.equal(h.guard.isRunning(), true, 'start repetido não deve acumular timers');

  h.guard.stop();
  assert.equal(h.guard.isRunning(), false);
});

test('idleMs reflete o tempo desde a última atividade', () => {
  const h = makeHarness({ idleShutdownMs: 0, watchParent: false });

  h.advance(7_000);
  assert.equal(h.guard.idleMs(), 7_000);

  h.guard.touch();
  assert.equal(h.guard.idleMs(), 0);
});
