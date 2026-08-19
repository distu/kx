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
  /** Bloqueio silencioso da política embutida, não da denylist do usuário. */
  builtin?: boolean;
}

export type IndexPathDecision = AllowedIndexPath | DeniedIndexPath;

/**
 * Exclusões embutidas: diretórios que nunca contêm fonte indexável.
 *
 * Worktrees multiplicam os mesmos arquivos por dezenas de cópias, artefatos
 * de build são derivados do código-fonte já indexado, e dependências
 * vendorizadas são de terceiros. Nada disso deveria custar embedding, disco
 * ou uma vaga no top-K. A comparação é por segmento relativo à raiz da fonte
 * observada, então uma fonte configurada explicitamente DENTRO de um desses
 * diretórios continua indexável — a intenção declarada vence o padrão.
 */
export const BUILTIN_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'worktrees',
  'build',
  'target',
  'dist',
  'out',
  'coverage',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  '.obsidian',
  '.trash',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  'DerivedData',
  '.terraform',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  '.parcel-cache',
  '.backups',
  '.dart_tool',
]);

/**
 * Extensões de artefatos compilados, binários e derivados. Indexá-los só
 * polui: ou são ilegíveis (bytecode, binário), ou são derivados de uma fonte
 * que já está no índice (minificados, source maps).
 */
export const BUILTIN_EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.class', '.jar', '.war', '.ear',
  '.min.js', '.min.css', '.map',
  '.pyc', '.pyo',
  '.o', '.a', '.so', '.dylib', '.dll', '.exe', '.node', '.wasm',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav',
  '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db',
  '.ipa', '.apk', '.aab', '.dmg', '.pkg',
]);

/**
 * Maior arquivo indexável. Acima disso é dump, log ou artefato gerado:
 * indexar não ajuda a busca e ler o arquivo inteiro como string pode nem ser
 * possível (o V8 limita strings a ~512 MB — um dump SQL real estourou isso).
 */
export const MAX_INDEXABLE_FILE_BYTES = 10 * 1024 * 1024;

/** Lockfiles: gigantes, gerados, e sem valor semântico para busca. */
export const BUILTIN_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Podfile.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'gradle.lockfile',
  'poetry.lock',
  'uv.lock',
  'pubspec.lock',
]);

/**
 * Padrões de glob equivalentes às exclusões de diretório, para o scan de
 * indexação nem descer nessas árvores (node_modules com dezenas de milhares
 * de entradas custa caro só de listar).
 */
export const BUILTIN_IGNORE_GLOBS: readonly string[] = [...BUILTIN_EXCLUDED_DIRS]
  .map(dir => `**/${dir}/**`);

/**
 * Razão de exclusão embutida para um caminho relativo à raiz da fonte, ou
 * `null` quando o caminho é aceitável. Segmentos de diretório são comparados
 * com a lista embutida; o nome do arquivo, com extensões e lockfiles.
 */
export function builtinExclusionReason(sourceRelativePath: string): string | null {
  const posix = sourceRelativePath.replaceAll('\\', '/');
  const segments = posix.split('/');
  const fileName = segments[segments.length - 1] ?? '';

  for (const segment of segments.slice(0, -1)) {
    if (BUILTIN_EXCLUDED_DIRS.has(segment)) {
      return `diretório excluído por padrão: ${segment}`;
    }
  }

  if (BUILTIN_EXCLUDED_FILES.has(fileName)) {
    return `lockfile excluído por padrão: ${fileName}`;
  }

  const lower = fileName.toLowerCase();
  for (const ext of BUILTIN_EXCLUDED_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return `extensão excluída por padrão: ${ext}`;
    }
  }

  return null;
}

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

  // A raiz mais profunda que contém o arquivo é a fonte "dona" dele. As
  // exclusões embutidas são medidas em relação a ela, então apontar uma
  // fonte para dentro de `worktrees/x` continua funcionando: os segmentos
  // relativos a essa fonte não incluem `worktrees`.
  const owningRoot = roots
    .filter(root => isInside(root, filePath))
    .sort((left, right) => right.length - left.length)[0];

  if (owningRoot === undefined) {
    throw new Error(`caminho fora das fontes configuradas: ${targetPath}`);
  }

  const storedPath = toDocumentPath(config, filePath);

  const builtinReason = builtinExclusionReason(relative(owningRoot, filePath));
  if (builtinReason !== null) {
    return { allowed: false, filePath, storedPath, reason: builtinReason, builtin: true };
  }

  if (isDeniedDocumentPath(config, storedPath)) {
    return { allowed: false, filePath, storedPath, reason: `caminho bloqueado por indexing.deny: ${storedPath}` };
  }

  return { allowed: true, filePath, storedPath };
}
