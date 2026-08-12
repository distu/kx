/**
 * Ciclo de vida do processo MCP.
 *
 * Um servidor MCP em stdio encerra quando o cliente fecha o pipe. Este guard
 * cobre os casos em que isso não acontece: o processo fica órfão, ou o cliente
 * permanece vivo por muito tempo sem usar a conexão. Nos dois casos o processo
 * segue residente sem ter a quem servir.
 *
 * As dependências externas são injetáveis para que o comportamento seja
 * verificável em teste sem esperar tempo real e sem encerrar o processo de
 * teste.
 */

import { numberFromEnv } from './env.js';

const DEFAULT_IDLE_SHUTDOWN_MINUTES = 480;
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;
/** PID do `launchd` no macOS e do `init` no Linux: o pai de todo órfão. */
const REPARENTED_PPID = 1;

export type ShutdownReason = 'idle' | 'orphaned' | 'transport-closed' | 'signal';

export interface LifecycleOptions {
  /** Milissegundos sem requisição antes de encerrar. `0` desativa. */
  idleShutdownMs?: number;
  /** Verificação de órfão. `false` desativa. */
  watchParent?: boolean;
  checkIntervalMs?: number;
  /** Prazo para a limpeza terminar antes de o processo encerrar assim mesmo. */
  cleanupTimeoutMs?: number;
  now?: () => number;
  getParentPid?: () => number;
  /** Chamado a cada verificação, para trabalho periódico de manutenção. */
  onCheck?: () => void;
  onShutdown?: (reason: ShutdownReason) => void | Promise<void>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export interface LifecycleGuard {
  /** Marca atividade. Chamado a cada requisição recebida do cliente. */
  touch(): void;
  start(): void;
  stop(): void;
  /** Executa uma rodada de verificação. Exposto para teste determinístico. */
  check(): void;
  shutdown(reason: ShutdownReason): Promise<void>;
  isRunning(): boolean;
  idleMs(): number;
}

/** Minutos de ociosidade tolerados. `0` desativa o encerramento por ociosidade. */
export function idleShutdownMinutes(): number {
  return numberFromEnv('KX_MCP_IDLE_SHUTDOWN_MINUTES', DEFAULT_IDLE_SHUTDOWN_MINUTES, { min: 0 });
}

export function parentWatchdogEnabled(): boolean {
  return process.env.KX_MCP_PARENT_WATCHDOG !== '0';
}

/** Intervalo entre verificações. */
export function checkIntervalMs(): number {
  const configured = numberFromEnv('KX_MCP_CHECK_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS, { min: 0 });
  return configured > 0 ? configured : DEFAULT_CHECK_INTERVAL_MS;
}

/**
 * Encerra o processo por sinal, e não por `process.exit`.
 *
 * `process.exit` desmonta o processo no ato, e o runtime de inferência nativo
 * usado pelo embedder aborta se for desmontado enquanto tem threads ativas.
 * Esperar a saída natural também não serve: o transport mantém a entrada
 * padrão aberta, então o laço de eventos nunca esvazia por conta própria.
 *
 * O tratamento padrão de `SIGTERM` encerra de forma determinística e sem
 * desmontagem, com ou sem o modelo carregado.
 */
function terminateSelf(code: number): void {
  process.exitCode = code;
  process.kill(process.pid, 'SIGTERM');
}

/** Resolve quando a limpeza termina ou quando o prazo se esgota, o que vier antes. */
async function withTimeout(work: void | Promise<void>, timeoutMs: number): Promise<void> {
  if (!(work instanceof Promise)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createLifecycleGuard(options: LifecycleOptions = {}): LifecycleGuard {
  const now = options.now ?? Date.now;
  const getParentPid = options.getParentPid ?? (() => process.ppid);
  const exit = options.exit ?? terminateSelf;
  const log = options.log ?? ((message: string) => console.error(message));
  const idleShutdownMs = options.idleShutdownMs ?? idleShutdownMinutes() * 60_000;
  const watchParent = options.watchParent ?? parentWatchdogEnabled();
  const interval = options.checkIntervalMs ?? checkIntervalMs();
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

  // Comparar com o PID original detecta tanto a reparentação para o supervisor
  // do sistema quanto para qualquer outro processo.
  const originalParentPid = getParentPid();
  let lastActivity = now();
  let timer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const idleMs = (): number => now() - lastActivity;

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const shutdown = async (reason: ShutdownReason): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stop();
    log(`kx mcp encerrando (motivo: ${reason})`);

    try {
      await withTimeout(options.onShutdown?.(reason), cleanupTimeoutMs);
    } catch (error) {
      // Encerrar é o objetivo: uma limpeza que falhe ou trave não pode deixar o
      // processo residente, que é a situação que este guard existe para evitar.
      log(`Falha ao finalizar recursos: ${String(error)}`);
    }

    exit(0);
  };

  const check = (): void => {
    if (shuttingDown) return;

    if (watchParent) {
      const parent = getParentPid();
      if (parent === REPARENTED_PPID || parent !== originalParentPid) {
        void shutdown('orphaned');
        return;
      }
    }

    if (idleShutdownMs > 0 && idleMs() >= idleShutdownMs) {
      void shutdown('idle');
      return;
    }

    try {
      options.onCheck?.();
    } catch (error) {
      // Manutenção periódica é acessória: não pode derrubar o guard.
      log(`Falha na verificação periódica: ${String(error)}`);
    }
  };

  const start = (): void => {
    if (timer) return;
    if (!watchParent && idleShutdownMs <= 0) return;
    // O timer é mantido referenciado de propósito. Um timer `unref`ado não
    // influencia o prazo de espera do laço de eventos: enquanto o processo está
    // bloqueado lendo a entrada padrão, ele só seria avaliado quando algum
    // outro evento acordasse o laço — ou seja, justamente nunca, no cenário
    // ocioso que este guard precisa detectar. Manter a referência não altera o
    // ciclo de vida do processo, que já é mantido vivo pelo transport.
    timer = setInterval(check, interval);
  };

  return {
    touch: () => { lastActivity = now(); },
    start,
    stop,
    check,
    shutdown,
    isRunning: () => timer !== null,
    idleMs,
  };
}
