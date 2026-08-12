/**
 * Leitura de configuração numérica vinda do ambiente.
 *
 * Uma variável definida como string vazia é tratada como ausente: shells e
 * gerenciadores de processo frequentemente exportam `VAR=` para "não
 * configurado", e interpretar isso como zero mudaria o comportamento
 * silenciosamente.
 */
export interface NumberFromEnvOptions {
  /** Menor valor aceito. Abaixo disso, o padrão prevalece. */
  min?: number;
}

export function numberFromEnv(
  name: string,
  fallback: number,
  options: NumberFromEnvOptions = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return fallback;
  return parsed;
}
