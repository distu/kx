import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Versão do pacote, lida do package.json para não divergir do que foi instalado. */
export function kxVersion(): string {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf-8')) as { version: string }).version;
}
