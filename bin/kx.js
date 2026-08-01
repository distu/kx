#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

// Se não recebeu --cwd, usa o diretório atual do chamador
const cwdArgIndex = process.argv.indexOf('--cwd');
if (cwdArgIndex !== -1 && process.argv[cwdArgIndex + 1]) {
  const projectRoot = process.argv[cwdArgIndex + 1];
  process.env.KX_PROJECT_ROOT = projectRoot;
  process.chdir(projectRoot);
  process.argv.splice(cwdArgIndex, 2);
}

// Registrar tsx a partir do caminho correto
const tsxApi = await import(resolve(packageRoot, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs'));
tsxApi.register();

// Executar
await import(resolve(packageRoot, 'src', 'index.ts'));
