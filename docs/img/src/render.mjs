// Renderiza os diagramas do README a partir destes HTMLs, em 2x.
//   npm i --no-save playwright-core && npx playwright install chromium
//   node docs/img/src/render.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
for (const name of ['arquitetura', 'busca-hibrida']) {
  await page.goto(pathToFileURL(join(here, `${name}.html`)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#shot').screenshot({ path: join(here, '..', `${name}.png`) });
  console.log(`docs/img/${name}.png`);
}
await browser.close();
