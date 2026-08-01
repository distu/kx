import { realpathSync } from 'fs';
import { isAbsolute, basename, dirname, relative, resolve } from 'path';
import { minimatch } from 'minimatch';
import type { KxConfig } from './config.js';

export interface AllowedIndexPath {
  allowed: true;
  filePath: string;
  storedPath: string;
}

export interface DeniedIndexPath {
  allowed: false;
  filePath: string;
  storedPath: string;
  reason: string;
}

export type IndexPathDecision = AllowedIndexPath | DeniedIndexPath;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function configuredRoot(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}

function canonicalizePath(candidate: string, requireExists: boolean): string {
  if (requireExists) return realpathSync(candidate);
  // Watcher unlink events arrive after the file has gone away. Canonicalize its
  // existing parent so deletion still works through system symlinked paths.
  try {
    return resolve(realpathSync(dirname(candidate)), basename(candidate));
  } catch {
    return candidate;
  }
}

export function toDocumentPath(config: KxConfig, filePath: string): string {
  return relative(config.projectRoot, filePath).replaceAll('\\', '/');
}

/**
 * Returns true only when the user has explicitly enabled a deny policy and
 * the project-relative path matches it. Existing configurations with no
 * `indexing.deny` retain their previous behaviour.
 */
export function isDeniedDocumentPath(config: KxConfig, storedPath: string): boolean {
  const patterns = config.indexing?.deny;
  if (!patterns || patterns.length === 0) return false;

  // A project-relative policy cannot safely classify an external source. When
  // the opt-in safety policy is active, fail closed instead of silently
  // indexing an out-of-project file.
  if (storedPath === '..' || storedPath.startsWith('../') || isAbsolute(storedPath)) return true;

  return patterns.some(pattern => minimatch(storedPath, pattern.replaceAll('\\', '/'), {
    dot: true,
    nocase: process.platform === 'darwin' || process.platform === 'win32',
    nonegate: true,
  }));
}

/**
 * Central admission gate for every path that can be read and indexed.
 * Callers must use this instead of checking only configured source roots.
 */
export function resolveIndexPath(
  config: KxConfig,
  targetPath: string,
  requireExists: boolean,
): IndexPathDecision {
  const candidate = resolve(config.projectRoot, targetPath);
  const filePath = canonicalizePath(candidate, requireExists);
  const roots = [
    ...config.sources.map(source => configuredRoot(source.path)),
    configuredRoot(resolve(config.projectRoot, '.vault', 'megabrain')),
  ];

  if (!roots.some(root => isInside(root, filePath))) {
    throw new Error(`caminho fora das fontes configuradas: ${targetPath}`);
  }

  const storedPath = toDocumentPath(config, filePath);
  if (isDeniedDocumentPath(config, storedPath)) {
    return { allowed: false, filePath, storedPath, reason: `caminho bloqueado por indexing.deny: ${storedPath}` };
  }

  return { allowed: true, filePath, storedPath };
}
