/**
 * Saída de terminal para os comandos interativos (setup, doctor).
 *
 * Cores só quando a saída é um TTY e NO_COLOR não está definido. Tudo vai
 * para stdout: esses comandos não rodam no modo MCP, onde stdout é protocolo.
 */
import { createInterface } from 'readline';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open: string, close: string) => (text: string) =>
  useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  lime: wrap('38;2;214;255;63', '39'),
  cyan: wrap('38;2;92;225;255', '39'),
  red: wrap('38;2;255;90;54', '39'),
  warm: wrap('38;2;255;246;230', '39'),
};

export const sym = {
  ok: c.lime('✔'),
  fail: c.red('✘'),
  warn: c.warm('!'),
  step: c.cyan('›'),
};

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function banner(title: string, subtitle: string): void {
  line();
  line(`  ${c.bold(c.warm('k'))}${c.bold(c.lime('x'))}  ${c.bold(title)}`);
  line(`      ${c.dim(subtitle)}`);
  line();
}

/** Pergunta sim/não. Sem TTY, devolve o padrão sem bloquear. */
export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = fallback ? 'S/n' : 's/N';
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`  ${c.cyan('?')} ${question} ${c.dim(`(${hint})`)} `, resolveAnswer);
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === 's' || normalized === 'sim' || normalized === 'y' || normalized === 'yes';
}

/** Indicador de progresso de uma linha; sem TTY vira log simples. */
export function spinner(label: string): { stop: (final: string) => void } {
  if (!process.stdout.isTTY) {
    line(`  ${sym.step} ${label}...`);
    return { stop: (final: string) => line(`  ${final}`) };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\r  ${c.cyan(frames[i++ % frames.length])} ${label} ${c.dim(`${secs}s`)}   `);
  }, 90);
  return {
    stop: (final: string) => {
      clearInterval(timer);
      process.stdout.write(`\r\x1b[2K  ${final}\n`);
    },
  };
}
