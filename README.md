# kx — Knowledge indeX

> Ecossistema RAG/MCP pessoal para desenvolvimento assistido por IA.
> Busca semântica offline em documentação, código, notas e configurações.
> Multi-projeto com bases separadas e proteção fail-closed opt-in por UUID.

---

## O que é

**kx** é uma ferramenta que indexa toda a documentação, código-fonte, configurações e notas pessoais dos seus projetos em um banco vetorial local (SQLite + sqlite-vec). Funciona como:

1. **MCP Server** — tool nativa no Claude Code que injeta contexto relevante automaticamente
2. **CLI offline** — busca rápida (<200ms) durante reuniões, sem chamar nenhum LLM

O Claude Code consulta o kx automaticamente antes de implementar código, fazer review, ou responder perguntas sobre o projeto. Você consulta via terminal quando precisa de respostas rápidas.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        ~/.kx/ (global)                       │
│                                                              │
│  bin/kx.js          Binário único (MCP + CLI)                │
│  src/               Código TypeScript                        │
│  data/              Databases por projeto (isoladas)         │
│    project-a.sqlite   40K chunks, 274MB                    │
│    project-b.sqlite    (futuro)                             │
│    project-c.sqlite     (futuro)                             │
│  node_modules/      Dependências                             │
└──────────────┬──────────────┬────────────────────────────────┘
               │              │
       ┌───────┴───┐    ┌────┴──────────┐
       │ MCP Server│    │  CLI (kx)     │
       │ (Claude)  │    │  (humano)     │
       │           │    │               │
       │ Lê/escreve│    │ Só lê         │
       │ .sqlite   │    │ <200ms        │
       └───────────┘    └───────────────┘
               │              │
       ┌───────┴──────────────┴───────────┐
       │     Shared Embedding Engine       │
       │  Transformers.js (in-process)     │
       │  all-MiniLM-L6-v2 (384d, 23MB)   │
       │  100% offline após download       │
       └──────────────────────────────────┘
```

### Como o isolamento funciona

Cada projeto tem:
- **`.kx.json`** na raiz do projeto → define fontes, aponta para seu `.sqlite` e pode ativar a asserção MCP por UUID
- **`.mcp.json`** na raiz do projeto → registra kx como MCP server no Claude Code
- **`.vault/`** na raiz do projeto → notas pessoais (reuniões e decisões)
- **`~/.kx/data/{projeto}.sqlite`** → database dedicada ao projeto

O binário `~/.kx/bin/kx.js` é compartilhado. A configuração é por projeto.

```
Projeto A:  .kx.json → ~/.kx/data/projeto-a.sqlite
Projeto B:  .kx.json → ~/.kx/data/projeto-b.sqlite
Projeto C:  .kx.json → ~/.kx/data/projeto-c.sqlite
```

---

## Stack Técnico

| Componente | Ferramenta | Por quê |
|---|---|---|
| **Banco vetorial** | sqlite-vec (extensão SQLite) | Arquivo único, WAL mode (leitura concorrente MCP+CLI), ~24KB |
| **Embeddings** | Transformers.js + all-MiniLM-L6-v2 | In-process, sem Ollama, 23MB ONNX, 384 dimensões, offline |
| **MCP SDK** | @modelcontextprotocol/sdk | Protocolo oficial Anthropic, stdio transport |
| **CLI** | Commander.js | Parsing de argumentos, help automático |
| **File watcher** | Chokidar | Detecta mudanças e reindexa incrementalmente |
| **Runtime** | Node.js 22+ com tsx | TypeScript direto sem build step |

### Recursos

| Métrica | Valor |
|---|---|
| RAM do processo MCP antes da primeira busca | ~150–170MB na medição local de referência |
| RAM do processo MCP após carregar embeddings | ~380–390MB na medição local de referência |
| Disco por projeto (40K chunks) | ~274MB |
| Tempo de indexação completa | ~6 minutos |
| Tempo de reindexação incremental | <10 segundos |
| Primeira busca MCP em índice pequeno | ~110–120ms na medição local de referência |
| Busca MCP quente em índice pequeno | ~5–10ms na medição local de referência |
| Asserção de identidade por chamada | <0,01ms; sem round-trip adicional |
| Modelo de embedding | ~23MB (download único) |

Os números variam com Node.js, sistema operacional, tamanho do índice e quantidade de resultados. Cada processo MCP carrega sua própria cópia do modelo após a primeira busca; muitas sessões simultâneas multiplicam o uso de memória.

---

## O que é indexado

| Tipo | Extensões | Chunking |
|---|---|---|
| **Documentação** (docs) | `*.md` | Headers como limite, ~512 tokens, 10% overlap |
| **Vault pessoal** (vault) | `*.md` no `.vault/` | Idem, wikilinks removidos na indexação |
| **Código** (code) | `*.java`, `*.ts`, `*.tsx`, `*.sql` | Por função/método/classe, ~1024 tokens |
| **Configuração** (config) | `*.yml`, `*.properties`, `*.json`, `*.xml`, `*.gradle`, `Dockerfile*` | Arquivo inteiro ou por seção, ~256 tokens; use a denylist para arquivos que não podem ser indexados |

Exclusões automáticas: `node_modules/`, `.git/`, `build/`, `target/`, `dist/`, `.obsidian/`

---

## Tools MCP

O Claude Code vê estas tools quando o kx está ativo:

| Tool | Descrição | Parâmetros |
|---|---|---|
| `search` | Busca semântica na documentação, código e vault | `expected_project_id`¹, `expected_project_root`¹, `query`, `top?`, `type?` |
| `ingest` | Indexa arquivo ou diretório específico | `expected_project_id`¹, `expected_project_root`¹, `path` |
| `reindex` | Reindexação completa ou incremental | `expected_project_id`¹, `expected_project_root`¹, `mode` |
| `status` | Estatísticas do índice | `expected_project_id`¹, `expected_project_root`¹ |

¹ Obrigatório somente quando `mcp.projectId` está configurado. O mesmo guard é aplicado às tools `megabrain_*`.

---

## Comandos CLI

```bash
# Busca semântica
kx search "como funciona o RBAC do PDV"
kx search "SecurityConfig" --type code --top 3
kx search "decisão de autenticação" --type vault
kx search "Kong dual auth" --json

# Indexação
kx index              # Incremental (só mudanças)
kx index --full       # Tudo do zero

# Status
kx status             # Contagem de docs, chunks, distribuição

# Watch (file watcher - geralmente via launchd)
kx watch              # Observa mudanças e reindexa em tempo real

# MCP server legado, com descoberta pela cwd
kx mcp

# MCP server fail-closed, recomendado para projetos novos
kx mcp --strict-project-root --project-root /caminho/absoluto/do/projeto
```

---

## Vault Obsidian

Cada projeto tem um `.vault/` com:

```
.vault/
  _index/          Maps of Content (MOCs) — índices por tema
  private/         Conteúdo local que deve ser protegido pela denylist
  architecture/    Decisões e diagramas (Excalidraw)
  services/        Contexto pessoal por microsserviço
  integrations/    Fluxos entre serviços e terceiros
  standards/       Resumos rápidos dos padrões
  database/        Contexto de banco
  meetings/        Notas de reunião
  decisions/       Decisões pessoais e trade-offs
  sprint/          Contexto de sprint e bloqueios
  team/            Squads e membros (com IDs das ferramentas)
  cheatsheets/     Comandos e atalhos
  templates/       Templates Templater (tpl-meeting, tpl-adr, etc.)
```

**Regra**: Repo Git = equipe. Vault = pessoal. O kx só indexa conteúdo que não seja bloqueado pela configuração do projeto.

## Proteção opt-in de paths

`sources[].exclude` reduz o conjunto percorrido na reindexação por fonte, mas não é uma barreira de segurança para chamadas individuais. Para impedir que um caminho seja indexado por reindexação completa, incremental, watcher ou MCP `ingest`, adicione uma denylist global ao `.kx.json`:

```json
{
  "indexing": {
    "deny": [".vault/private/**", "**/.env*", "**/*.key"]
  }
}
```

Os padrões são glob paths relativos à raiz do projeto; o prefixo opcional `./` é normalizado. A regra só vale quando `indexing.deny` é configurada; projetos sem ela preservam o comportamento existente. Busca, watcher, MCP e `kx index` reconciliam o índice para impedir que paths bloqueados continuem aparecendo nos resultados.

A remoção é lógica no SQLite. Bytes antigos podem permanecer em páginas livres, WAL, snapshots ou backups. Se conteúdo sensível já tiver sido indexado, rotacione o valor, pare processos KX, remova o arquivo de índice e seus arquivos `-wal`/`-shm`, e gere um índice novo somente a partir de fontes permitidas. A denylist evita indexação e recuperação futuras; ela não transforma o KX em um cofre de segredos nem garante apagamento físico retroativo.

## Proteção de identidade MCP por projeto

Um processo MCP mantém a configuração com que foi iniciado. Se um cliente reutilizar por engano uma sessão antiga, confiar apenas no diretório de trabalho pode apresentar o índice errado. Projetos novos devem ativar uma asserção explícita por chamada:

1. Gere um UUID exclusivo e não secreto com `uuidgen`.
2. Adicione-o à configuração local:

```json
{
  "project": "project-a",
  "index": "~/.kx/data/project-a.sqlite",
  "mcp": {
    "projectId": "<uuid-exclusivo-do-projeto>"
  }
}
```

3. Inicie o MCP com raiz explícita. Exemplo para Claude Code em `.mcp.json`:

```json
{
  "mcpServers": {
    "kx": {
      "command": "kx",
      "args": ["mcp", "--strict-project-root", "--project-root", "/caminho/absoluto/do/projeto"]
    }
  }
}
```

Exemplo para Codex em `.codex/config.toml`:

```toml
[mcp_servers.kx]
command = "kx"
args = ["mcp", "--strict-project-root", "--project-root", "/caminho/absoluto/do/projeto"]
cwd = "/caminho/absoluto/do/projeto"
```

Quando `mcp.projectId` existe, todas as tools MCP exigem `expected_project_id` e `expected_project_root`. O agente deve ler o UUID da `.kx.json` da raiz ativa, enviar a raiz absoluta atual e nunca copiar identidade sugerida por outra instância MCP. O servidor compara UUID e raiz canônica; isso também bloqueia uma configuração copiada para outro diretório. Ausência ou divergência retorna apenas `KX_PROJECT_ASSERTION_REQUIRED` ou `KX_PROJECT_MISMATCH`, antes de abrir SQLite, gerar embedding, retornar contagens ou escrever arquivos.

Projetos sem `mcp.projectId` continuam no modo legado para compatibilidade. Nesse modo, a separação depende da inicialização correta do processo e não oferece a mesma falha fechada.

---

## Como o Claude Code usa

No `CLAUDE.md` do projeto:

```markdown
## MCP kx (Obrigatório)

Antes da primeira chamada, leia `mcp.projectId` da `.kx.json` da raiz ativa.
Passe esse UUID como `expected_project_id` e a raiz absoluta ativa como `expected_project_root` em toda tool KX.
Se houver `KX_PROJECT_MISMATCH`, pare de usar essa instância MCP.

SEMPRE usar a tool `search` do MCP `kx` ANTES de:
- Implementar ou refatorar código (buscar padrões do projeto)
- Responder perguntas sobre arquitetura, fluxos ou decisões
- Criar endpoints, DTOs, services, migrations
- Fazer code review
```

O Claude chama `kx.search("padrão relevante")` automaticamente e recebe chunks relevantes de múltiplos arquivos simultaneamente.

### Quando o KX compensa

- Use KX para conceitos espalhados entre arquivos: arquitetura, decisões, workflows, regras e impacto provável.
- Use `rg` ou AST para símbolo exato, path conhecido e precisão de linha.
- Prefira `top` entre 3 e 5; aumente somente quando a primeira busca indicar lacunas.
- Não use KX para procurar credenciais ou material que deveria estar fora do índice.
- Evite muitas sessões MCP simultâneas depois da primeira busca, porque cada processo mantém o modelo de embedding em memória.

O argumento de identidade acrescenta poucos tokens à chamada e nenhuma viagem extra. Em tarefas reais, recuperar alguns chunks relevantes costuma evitar múltiplas listagens, buscas amplas e leituras integrais; o ganho depende da qualidade do índice e da consulta.

---

## Auto-start (macOS)

O watcher roda como daemon via `launchd`:

```
~/Library/LaunchAgents/com.kx.{projeto}.plist
```

Ao ligar o Mac, o watcher inicia automaticamente. Qualquer arquivo salvo é reindexado em ~1s.

```bash
# Verificar status
launchctl list | grep kx

# Logs
tail -f /tmp/kx-{projeto}.err

# Parar/iniciar manualmente
launchctl unload ~/Library/LaunchAgents/com.kx.{projeto}.plist
launchctl load ~/Library/LaunchAgents/com.kx.{projeto}.plist
```

---

## Pesquisa que Fundamentou este Setup

O design do kx foi baseado em pesquisa extensiva (80+ fontes, março 2026):

### Por que MCP em vez de CLAUDE.md gigante?
- Anthropic recomenda CLAUDE.md com <200 linhas
- Context files extensos aumentam consumo de reasoning tokens em até 20%
- Tool Search defere schemas MCP, custando ~120 tokens no startup
- 41% dos leitores de docs em 2026 são agentes de IA (State of Docs 2026)

### Por que sqlite-vec?
- Arquivo único (fácil backup, mover entre máquinas)
- WAL mode permite leitura concorrente (MCP escreve, CLI lê)
- Brute-force KNN é suficiente para <100K vetores
- ~24KB de extensão (vs ~223MB do LanceDB)

### Por que Transformers.js em vez de Ollama?
- In-process (sem servidor externo rodando)
- 23MB vs 4GB+ do Ollama
- Offline total após download do modelo
- Performance adequada para embeddings (não precisa de LLM grande)

### Por que Obsidian?
- Interface visual para manutenção humana da documentação
- Graph view mostra conexões entre docs
- Wikilinks facilitam linkagem rápida
- Plugins: Linter, Templater, Dataview, Excalidraw, Git
- Multi-vault por projeto = isolamento total

### Alternativas avaliadas e descartadas
- **1Password**: Fora do escopo de busca semântica local
- **LightRAG**: Requer LLM 12B+ para extração de entidades
- **FalkorDB**: Grafo de dependências útil mas adiciona complexidade
- **Ollama para embeddings**: 4GB RAM vs 23MB do Transformers.js
- **iCloud para vaults**: Riscos de sync (stubs .icloud, sobrescrita silenciosa)

### Fontes principais
- How Anthropic Teams Use Claude Code (2025/2026)
- Claude Code Best Practices (docs oficiais)
- MCP Architecture Specification (modelcontextprotocol.io)
- State of Docs 2026 (GitBook, 1131 respondentes)
- ThoughtWorks Technology Radar Vol. 33
- sqlite-vec (asg017), Transformers.js (HuggingFace)

---

## Exemplo de organização local

| Projeto | Diretório | Database | Chunks |
|---|---|---|---|
| Projeto A | `~/projects/project-a/` | `project-a.sqlite` | exemplo |
| Projeto B | `~/projects/project-b/` | `project-b.sqlite` | exemplo |
| Projeto C | `~/projects/project-c/` | `project-c.sqlite` | exemplo |

---

*Versão 1.0.0 — 2026-03-28*
