// CLI do registro de artefatos. Vive separada da CLI principal de proposito: e chamada por
// hook a cada publicacao de artefato, e a CLI principal carrega o stack de SQLite/embeddings
// no topo — um ABI mismatch do better-sqlite3 derrubaria o registro sem necessidade.
// Aqui nada de nativo e carregado; a indexacao pos-registro e opcional e best-effort.
import { Command } from 'commander';
import type { KxConfig } from './config.js';
import { registerArtifact, linkArtifact, listArtifacts } from './artifacts.js';

async function indexBestEffort(config: KxConfig, path: string): Promise<void> {
  try {
    const { indexSinglePath } = await import('./indexer.js');
    await indexSinglePath(config, path);
  } catch {
    // Indexar e conveniencia: o registro no vault ja esta gravado e o watcher pega depois.
  }
}

export function createArtifactCli(config: KxConfig): Command {
  const program = new Command();
  program
    .name('kx artifact')
    .description('Registro de artefatos web publicados pelos agentes, vinculados a atividade');

  program
    .command('add')
    .description('Registra (ou versiona) um artefato publicado')
    .requiredOption('--url <url>', 'URL do artefato publicado')
    .option('--titulo <titulo>', 'Titulo do artefato')
    .option('--descricao <descricao>', 'Do que se trata')
    .option('--arquivo <path>', 'Arquivo fonte que originou o artefato')
    .option('--atividade <slug|id>', 'Atividade do activity manager (padrao: resolve pela sessao)')
    .option('--agente <nome>', 'Quem publicou (claude-code, codex, ...)', 'claude-code')
    .option('--label <label>', 'Rotulo desta publicacao')
    .option('--sessao <id>', 'ID da sessao Claude Code')
    .option('--quiet', 'Nao imprime nada em caso de sucesso (uso em hook)')
    .action(async (o: Record<string, string | undefined>) => {
      const r = registerArtifact(config, {
        url: o.url as string, titulo: o.titulo, descricao: o.descricao, arquivo: o.arquivo,
        atividade: o.atividade, agente: o.agente, label: o.label, sessao: o.sessao,
      });
      await indexBestEffort(config, r.indexPath);
      if (o.quiet) return;
      const vinculo = r.record.atividade
        ? `atividade ${r.atividadeTitulo || r.record.atividade}`
        : 'SEM atividade vinculada (use "kx artifact link")';
      console.log(`${r.novo ? 'Artefato registrado' : 'Artefato versionado'}: ${r.record.titulo} (v${r.record.versao})`);
      console.log(`  ${r.record.url}`);
      console.log(`  ${vinculo}`);
      console.log(`  indice: ${r.indexPath}`);
    });

  program
    .command('link')
    .description('Vincula um artefato ja registrado a uma atividade')
    .requiredOption('--url <url>', 'URL do artefato')
    .requiredOption('--atividade <slug|id>', 'Atividade de destino')
    .action(async (o: { url: string; atividade: string }) => {
      const r = linkArtifact(config, o.url, o.atividade);
      await indexBestEffort(config, r.indexPath);
      console.log(`Artefato "${r.record.titulo}" vinculado a ${r.atividadeTitulo || r.record.atividade}.`);
    });

  program
    .command('list')
    .description('Lista os artefatos registrados no projeto')
    .option('--atividade <slug|id>', 'Filtrar por atividade')
    .option('--limit <n>', 'Quantos exibir (padrao 30)', '30')
    .action((o: { atividade?: string; limit?: string }) => {
      console.log(listArtifacts(config, { atividade: o.atividade, limit: parseInt(o.limit || '30', 10) }));
    });

  return program;
}
