import { Command } from 'commander';
import type { KxConfig } from './config.js';
import { search, getStatus } from './searcher.js';
import { indexProject } from './indexer.js';

export function createCli(config: KxConfig): Command {
  const program = new Command();

  program
    .name('kx')
    .description('Busca semântica no projeto — MCP server + CLI offline')
    .version('1.0.0');

  program
    .command('search <query>')
    .description('Busca semântica na documentação e código')
    .option('-t, --top <number>', 'Número de resultados', '10')
    .option('--type <type>', 'Filtrar: docs, code, config, vault, all', 'all')
    .option('--json', 'Saída em JSON')
    .action(async (query: string, opts: { top: string; type: string; json?: boolean }) => {
      const results = await search(config, query, parseInt(opts.top), opts.type);

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log('Nenhum resultado encontrado.');
        return;
      }

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const score = (1 - r.distance).toFixed(3);
        const preview = r.content.slice(0, 300).replace(/\n/g, '\n  ');

        console.log(`\n[${score}] ${r.path} [${r.source_type}]`);
        console.log(`  ${preview}${r.content.length > 300 ? '...' : ''}`);

        if (i < results.length - 1) {
          console.log('---');
        }
      }
      console.log(`\n${results.length} resultado(s) encontrado(s).`);
    });

  program
    .command('index')
    .description('Indexar projeto (incremental por padrão)')
    .option('--full', 'Reindexação completa')
    .action(async (opts: { full?: boolean }) => {
      const mode = opts.full ? 'full' : 'incremental';
      console.log(`Indexando projeto "${config.project}" (modo: ${mode})...`);

      const start = Date.now();
      const stats = await indexProject(config, mode as 'full' | 'incremental');
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      console.log(`\nIndexação concluída em ${elapsed}s:`);
      console.log(`  Arquivos processados: ${stats.filesProcessed}`);
      console.log(`  Chunks criados: ${stats.chunksCreated}`);
      console.log(`  Arquivos ignorados (sem mudanças): ${stats.filesSkipped}`);

      if (stats.errors.length > 0) {
        console.log(`  Erros: ${stats.errors.length}`);
        for (const err of stats.errors.slice(0, 5)) {
          console.log(`    - ${err}`);
        }
        if (stats.errors.length > 5) {
          console.log(`    ... e mais ${stats.errors.length - 5} erros`);
        }
      }
    });

  program
    .command('status')
    .description('Estatísticas do índice')
    .action(() => {
      try {
        const stats = getStatus(config);
        console.log(`Projeto: ${config.project}`);
        console.log(`Índice: ${config.index}`);
        console.log(`Documentos únicos: ${stats.totalDocuments}`);
        console.log(`Total de chunks: ${stats.totalChunks}`);
        console.log('Por tipo:');
        for (const [type, count] of Object.entries(stats.byType)) {
          console.log(`  ${type}: ${count} chunks`);
        }
      } catch {
        console.log('Índice não encontrado. Execute "kx index" primeiro.');
      }
    });

  return program;
}
