import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { KxConfig } from './config.js';
import { search, getStatus } from './searcher.js';
import { indexProject, indexSinglePath } from './indexer.js';

export async function startMcpServer(config: KxConfig): Promise<void> {
  const server = new Server(
    { name: 'kx', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description: 'Busca semântica na documentação, código e vault do projeto. Use para encontrar padrões, decisões de arquitetura, endpoints, configurações, credenciais e qualquer informação do projeto. REGRA: ao usar resultados desta busca para gerar texto em português, SEMPRE aplicar acentuação correta (ã, é, í, ó, ú, ç, à, â, ê, ô, õ). Os chunks indexados podem conter texto sem acentos - corrija ao reproduzir.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Texto da busca em linguagem natural' },
            top: { type: 'number', description: 'Número de resultados (padrão: 10)', default: 10 },
            type: {
              type: 'string',
              description: 'Filtrar por tipo: docs, code, config, vault, all (padrão: all)',
              enum: ['docs', 'code', 'config', 'vault', 'all'],
              default: 'all',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'ingest',
        description: 'Indexa um arquivo específico no banco vetorial',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Caminho do arquivo para indexar' },
          },
          required: ['path'],
        },
      },
      {
        name: 'reindex',
        description: 'Reindexação completa ou incremental de todo o projeto',
        inputSchema: {
          type: 'object' as const,
          properties: {
            mode: {
              type: 'string',
              description: 'full (tudo do zero) ou incremental (só mudanças)',
              enum: ['full', 'incremental'],
              default: 'incremental',
            },
          },
        },
      },
      {
        name: 'status',
        description: 'Estatísticas do índice: total de documentos, chunks e distribuição por tipo',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'search': {
        const query = (args as { query: string; top?: number; type?: string }).query;
        const top = (args as { top?: number }).top || 10;
        const type = (args as { type?: string }).type || 'all';

        const results = await search(config, query, top, type);

        const formatted = results.map((r, i) => {
          const score = (1 - r.distance).toFixed(3);
          return `[${i + 1}] (${score}) ${r.path} [${r.source_type}]\n${r.content.slice(0, 500)}${r.content.length > 500 ? '...' : ''}`;
        }).join('\n\n---\n\n');

        const accentReminder = '\n\n---\n\n[REGRA] Texto em português DEVE ter acentuação correta (ã, é, í, ó, ú, ç, à, â, ê, ô, õ). Se os resultados acima contêm texto sem acentos, corrija ao reproduzir em artefatos.';

        return {
          content: [{ type: 'text', text: (formatted || 'Nenhum resultado encontrado.') + accentReminder }],
        };
      }

      case 'ingest': {
        const path = (args as { path: string }).path;
        const stats = await indexSinglePath(config, path);
        return {
          content: [{
            type: 'text',
            text: `Indexado: ${stats.filesProcessed} arquivo(s), ${stats.chunksCreated} chunk(s)${stats.errors.length > 0 ? '\nErros: ' + stats.errors.join(', ') : ''}`,
          }],
        };
      }

      case 'reindex': {
        const mode = ((args as { mode?: string }).mode || 'incremental') as 'full' | 'incremental';
        const stats = await indexProject(config, mode);
        return {
          content: [{
            type: 'text',
            text: `Reindexação ${mode} concluída:\n- Arquivos processados: ${stats.filesProcessed}\n- Chunks criados: ${stats.chunksCreated}\n- Arquivos ignorados: ${stats.filesSkipped}${stats.errors.length > 0 ? '\n- Erros: ' + stats.errors.length : ''}`,
          }],
        };
      }

      case 'status': {
        const stats = getStatus(config);
        const byTypeStr = Object.entries(stats.byType)
          .map(([k, v]) => `  ${k}: ${v} chunks`)
          .join('\n');
        return {
          content: [{
            type: 'text',
            text: `Índice: ${config.project}\n- Documentos únicos: ${stats.totalDocuments}\n- Total de chunks: ${stats.totalChunks}\n- Por tipo:\n${byTypeStr}`,
          }],
        };
      }

      default:
        throw new Error(`Tool desconhecida: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP server kx iniciado (projeto: ${config.project})`);
}
