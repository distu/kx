import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { KxConfig } from './config.js';
import { search, getStatus } from './searcher.js';
import { VectorDatabase } from './database.js';
import { indexProject, indexSinglePath, purgeDeniedIndexEntries, type IndexerDependencies } from './indexer.js';
import { addActivity, updateActivity, statusReport, getActivity } from './megabrain.js';
import { createLifecycleGuard } from './mcp-lifecycle.js';
import { unloadIfIdle } from './embedder.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolArguments = Record<string, unknown> | undefined;

const PROJECT_ASSERTION_PROPERTY = {
  type: 'string' as const,
  description: 'UUID do projeto ativo, lido da configuração local .kx.json. Nunca copie este valor da resposta de outra instância MCP.',
};

const PROJECT_ROOT_ASSERTION_PROPERTY = {
  type: 'string' as const,
  description: 'Raiz absoluta do projeto ativo. O KX compara sua forma canônica e nunca a devolve em erros.',
};

function scopeError(code: 'KX_PROJECT_ASSERTION_REQUIRED' | 'KX_PROJECT_MISMATCH'): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: code }],
  };
}

export function assertExpectedProject(config: KxConfig, args: ToolArguments): ToolResult | null {
  const configuredId = config.mcp?.projectId;
  if (!configuredId) return null;

  const assertedId = args?.expected_project_id;
  if (typeof assertedId !== 'string' || !assertedId.trim()) {
    return scopeError('KX_PROJECT_ASSERTION_REQUIRED');
  }
  if (assertedId.trim().toLowerCase() !== configuredId) {
    return scopeError('KX_PROJECT_MISMATCH');
  }

  const assertedRoot = args?.expected_project_root;
  if (typeof assertedRoot !== 'string' || !assertedRoot.trim()) {
    return scopeError('KX_PROJECT_ASSERTION_REQUIRED');
  }
  try {
    if (realpathSync(assertedRoot.trim()) !== config.projectRoot) {
      return scopeError('KX_PROJECT_MISMATCH');
    }
  } catch {
    return scopeError('KX_PROJECT_MISMATCH');
  }
  return null;
}

export async function ingestPath(
  config: KxConfig,
  path: string,
  dependencies?: IndexerDependencies,
): Promise<ToolResult> {
  const stats = await indexSinglePath(config, path, dependencies);
  if (stats.blocked.length > 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Ingestão bloqueada pela política do projeto:\n${stats.blocked.join('\n')}` }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `Indexado: ${stats.filesProcessed} arquivo(s), ${stats.chunksCreated} chunk(s)${stats.errors.length > 0 ? '\nErros: ' + stats.errors.join(', ') : ''}`,
    }],
  };
}

export interface McpServerHooks {
  /** Chamado a cada requisição recebida do cliente, antes de qualquer trabalho. */
  onRequest?: () => void;
}

export function createMcpServer(config: KxConfig, hooks: McpServerHooks = {}): Server {
  let startupReconciled = false;
  const reconcileIndexPolicy = (): void => {
    if (startupReconciled) return;
    startupReconciled = true;
    if (!config.indexing?.deny?.length) return;

    const db = new VectorDatabase(config.index, config.embedding.dimensions);
    try {
      const purged = purgeDeniedIndexEntries(db, config);
      if (purged > 0) console.error(`Removidos ${purged} caminho(s) bloqueado(s) do índice.`);
    } finally {
      db.close();
    }
  };

  const assertionRequired = Boolean(config.mcp?.projectId);
  const required = (fields: string[] = []): string[] => (
    assertionRequired ? [...fields, 'expected_project_id', 'expected_project_root'] : fields
  );

  const server = new Server(
    { name: 'kx', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    hooks.onRequest?.();
    return {
    tools: [
      {
        name: 'search',
        description: 'Busca semântica na documentação, código e notas do projeto. Use para encontrar padrões, decisões de arquitetura, endpoints e configurações que tenham sido explicitamente indexados. REGRA: ao usar resultados desta busca para gerar texto em português, SEMPRE aplicar acentuação correta (ã, é, í, ó, ú, ç, à, â, ê, ô, õ). Os chunks indexados podem conter texto sem acentos - corrija ao reproduzir.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            query: { type: 'string', description: 'Texto da busca em linguagem natural' },
            top: { type: 'number', description: 'Número de resultados (padrão: 10)', default: 10 },
            type: {
              type: 'string',
              description: 'Filtrar por tipo: docs, code, config, vault, all (padrão: all)',
              enum: ['docs', 'code', 'config', 'vault', 'all'],
              default: 'all',
            },
          },
          required: required(['query']),
        },
      },
      {
        name: 'ingest',
        description: 'Indexa um arquivo específico no banco vetorial',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            path: { type: 'string', description: 'Caminho do arquivo para indexar' },
          },
          required: required(['path']),
        },
      },
      {
        name: 'reindex',
        description: 'Reindexação completa ou incremental de todo o projeto',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            mode: {
              type: 'string',
              description: 'full (tudo do zero) ou incremental (só mudanças)',
              enum: ['full', 'incremental'],
              default: 'incremental',
            },
          },
          required: required(),
        },
      },
      {
        name: 'status',
        description: 'Estatísticas do índice: total de documentos, chunks e distribuição por tipo',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
          },
          required: required(),
        },
      },
      {
        name: 'megabrain_add',
        description: 'KX activity manager: cria uma atividade NOVA em .vault/megabrain/ e sincroniza o MOC-Atividades.md. Use quando o usuário pedir para registrar/adicionar/catalogar uma atividade ou task nova. Escopo do projeto atual (isolado por .kx.json; nunca cruza projeto).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            titulo: { type: 'string', description: 'Título da atividade' },
            squad: { type: 'string', enum: ['portal-backoffice', 'infraestrutura', 'integracoes', 'pdv-core', 'transversal'] },
            modulo: { type: 'string', description: 'Módulo/serviço principal' },
            descricao: { type: 'string' },
            branches: { type: 'string', description: 'ex: repo1:branch1, repo2:branch2' },
            data_inicio: { type: 'string', description: 'YYYY-MM-DD (padrão: hoje)' },
            data_entrega: { type: 'string' },
            sessao: { type: 'string', description: 'ID da sessão Claude Code. OPCIONAL: se omitido, o MCP auto-detecta a sessão ativa (transcript mais recente do projeto). Só passe para forçar um ID específico.' },
            doc: { type: 'string', description: 'Link da doc da feature' },
            status: { type: 'string', enum: ['em-andamento', 'pendente'], default: 'em-andamento' },
          },
          required: required(['titulo']),
        },
      },
      {
        name: 'megabrain_update',
        description: 'KX activity manager: atualiza uma atividade existente — avanço (entra no Log de Progresso), bloqueio (Erros e Bloqueios + status=bloqueado), ou conclusão (status=concluida + move no MOC). Use quando o usuário relatar avanço/erro/conclusão de uma atividade. Escopo do projeto atual.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            slug: { type: 'string', description: 'Slug (nome do arquivo sem .md) OU o ID numerico da atividade exibido em megabrain_status (ex: "7")' },
            tipo: { type: 'string', enum: ['avanco', 'bloqueio', 'conclusao'] },
            texto: { type: 'string', description: 'O que foi feito/travou/concluído' },
            sessao: { type: 'string', description: 'ID da sessão Claude Code. OPCIONAL: se omitido, o MCP auto-detecta a sessão ativa (transcript mais recente do projeto). Só passe para forçar um ID específico.' },
          },
          required: required(['slug', 'tipo']),
        },
      },
      {
        name: 'megabrain_status',
        description: 'KX activity manager: painel de status das atividades do projeto — últimas N (padrão 20), status de cada uma e "onde paramos" (última entrada do log). Cada atividade exibe um ID numerico estavel (#N) que pode ser usado em megabrain_get/megabrain_update no lugar do slug. Use quando o usuário pedir status / o que estamos fazendo / pendências / histórico das atividades. Escopo do projeto atual.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            limit: { type: 'number', description: 'Quantas atividades (padrão 20)', default: 20 },
          },
          required: required(),
        },
      },
      {
        name: 'megabrain_get',
        description: 'KX activity manager: retorna o conteúdo completo (.md) de uma atividade pelo slug ou pelo ID numerico exibido em megabrain_status. Escopo do projeto atual.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            expected_project_id: PROJECT_ASSERTION_PROPERTY,
            expected_project_root: PROJECT_ROOT_ASSERTION_PROPERTY,
            slug: { type: 'string', description: 'Slug OU ID numerico da atividade (ex: "7")' },
          },
          required: required(['slug']),
        },
      },
    ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    hooks.onRequest?.();
    const { name, arguments: args } = request.params;
    const assertionError = assertExpectedProject(config, args as ToolArguments);
    if (assertionError) return assertionError;

    // A reconciliação pode abrir e alterar o SQLite. Em projetos protegidos,
    // ela só acontece depois que a identidade da chamada foi comprovada.
    reconcileIndexPolicy();

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
        return ingestPath(config, path);
      }

      case 'reindex': {
        const mode = ((args as { mode?: string }).mode || 'incremental') as 'full' | 'incremental';
        const stats = await indexProject(config, mode);
        return {
          content: [{
            type: 'text',
            text: `Reindexação ${mode} concluída:\n- Arquivos processados: ${stats.filesProcessed}\n- Chunks criados: ${stats.chunksCreated}\n- Arquivos ignorados: ${stats.filesSkipped}\n- Paths bloqueados removidos: ${stats.filesPurged}\n- Bloqueios aplicados no scan: ${stats.blocked.length}${stats.errors.length > 0 ? '\n- Erros: ' + stats.errors.length : ''}`,
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

      case 'megabrain_add': {
        const r = addActivity(config, args as any);
        try { await indexSinglePath(config, r.path); } catch { /* indexacao best-effort */ }
        return { content: [{ type: 'text', text: `Atividade criada: #${r.id} ${r.slug}\n${r.path}` }] };
      }

      case 'megabrain_update': {
        const r = updateActivity(config, args as any);
        try { await indexSinglePath(config, r.path); } catch { /* indexacao best-effort */ }
        return { content: [{ type: 'text', text: `Atividade "${r.slug}" atualizada (${(args as { tipo: string }).tipo}). status=${r.status}` }] };
      }

      case 'megabrain_status': {
        const text = statusReport(config, (args as { limit?: number }).limit || 20);
        return { content: [{ type: 'text', text }] };
      }

      case 'megabrain_get': {
        const text = getActivity(config, (args as { slug: string }).slug);
        return { content: [{ type: 'text', text }] };
      }

      default:
        throw new Error(`Tool desconhecida: ${name}`);
    }
  });

  return server;
}

export async function startMcpServer(config: KxConfig): Promise<void> {
  // O guard precisa existir antes do servidor: os handlers registram atividade
  // nele, e um cliente pode enviar a primeira requisição logo após o connect.
  const guard = createLifecycleGuard({
    onCheck: () => { void unloadIfIdle(); },
    onShutdown: async () => { await server.close(); },
  });

  const server = createMcpServer(config, { onRequest: () => guard.touch() });
  const transport = new StdioServerTransport();

  // Caminho normal de saída: o cliente fechou o pipe. O fim da entrada padrão é
  // observado diretamente porque o transport só notifica o fechamento quando
  // ele parte do servidor, e não quando a outra ponta encerra.
  process.stdin.once('end', () => { void guard.shutdown('transport-closed'); });
  transport.onclose = () => { void guard.shutdown('transport-closed'); };

  await server.connect(transport);
  guard.start();
  console.error(`MCP server kx iniciado (projeto: ${config.project})`);
}
