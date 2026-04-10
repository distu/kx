# kx — Knowledge indeX

> Ecossistema RAG/MCP pessoal para desenvolvimento assistido por IA.
> Busca semântica offline em documentação, código, vault e configurações.
> Multi-projeto com isolamento total entre bases.

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
- **`.kx.json`** na raiz do projeto → define fontes e aponta para seu `.sqlite`
- **`.mcp.json`** na raiz do projeto → registra kx como MCP server no Claude Code
- **`.vault/`** na raiz do projeto → vault Obsidian pessoal (secrets, reuniões, decisões)
- **`~/.kx/data/{projeto}.sqlite`** → database isolada, zero colisão

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
| RAM por projeto (MCP ativo) | ~200MB |
| Disco por projeto (40K chunks) | ~274MB |
| Tempo de indexação completa | ~6 minutos |
| Tempo de reindexação incremental | <10 segundos |
| Tempo de query (CLI, sem LLM) | <200ms |
| Modelo de embedding | ~23MB (download único) |

---

## O que é indexado

| Tipo | Extensões | Chunking |
|---|---|---|
| **Documentação** (docs) | `*.md` | Headers como limite, ~512 tokens, 10% overlap |
| **Vault pessoal** (vault) | `*.md` no `.vault/` | Idem, wikilinks removidos na indexação |
| **Código** (code) | `*.java`, `*.ts`, `*.tsx`, `*.sql` | Por função/método/classe, ~1024 tokens |
| **Configuração** (config) | `*.yml`, `*.properties`, `*.json`, `*.xml`, `*.gradle`, `Dockerfile*`, `.env*` | Arquivo inteiro ou por seção, ~256 tokens |

Exclusões automáticas: `node_modules/`, `.git/`, `build/`, `target/`, `dist/`, `.obsidian/`

---

## Tools MCP

O Claude Code vê estas tools quando o kx está ativo:

| Tool | Descrição | Parâmetros |
|---|---|---|
| `search` | Busca semântica na documentação, código e vault | `query`, `top?` (default 10), `type?` (docs/code/config/vault/all) |
| `ingest` | Indexa arquivo ou diretório específico | `path` |
| `reindex` | Reindexação completa ou incremental | `mode` (full/incremental) |
| `status` | Estatísticas do índice | — |

---

## Comandos CLI

```bash
# Busca semântica
kx search "como funciona o RBAC do PDV"
kx search "SecurityConfig" --type code --top 3
kx search "credenciais cluster QA" --type vault
kx search "Kong dual auth" --json

# Indexação
kx index              # Incremental (só mudanças)
kx index --full       # Tudo do zero

# Status
kx status             # Contagem de docs, chunks, distribuição

# Watch (file watcher - geralmente via launchd)
kx watch              # Observa mudanças e reindexa em tempo real

# MCP server (geralmente via .mcp.json)
kx mcp                # Inicia MCP server via stdio
```

---

## Vault Obsidian

Cada projeto tem um `.vault/` com:

```
.vault/
  _index/          Maps of Content (MOCs) — índices por tema
  _secrets/        Credenciais dev/homolog (tokens, senhas, endpoints)
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

**Regra**: Repo Git = equipe. Vault = pessoal. O kx indexa ambos.

---

## Como o Claude Code usa

No `CLAUDE.md` do projeto:

```markdown
## MCP kx (Obrigatório)

SEMPRE usar a tool `search` do MCP `kx` ANTES de:
- Implementar ou refatorar código (buscar padrões do projeto)
- Responder perguntas sobre arquitetura, fluxos ou decisões
- Criar endpoints, DTOs, services, migrations
- Fazer code review
```

O Claude chama `kx.search("padrão relevante")` automaticamente e recebe chunks relevantes de múltiplos arquivos simultaneamente.

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
- **1Password**: Desnecessário para credenciais dev/homolog
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

## Projetos Ativos

| Projeto | Diretório | Database | Chunks |
|---|---|---|---|
| Projeto A (Fase 2) | `~/projects/organization/organization-a/git/fase2/` | `project-a.sqlite` | 40.154 |
| Projeto B | `~/projects/project-b/` | `project-b.sqlite` | (pendente) |
| Projeto C | `~/projects/organization-b/` | `project-c.sqlite` | (pendente) |

---

*Versão 1.0.0 — 2026-03-28*
*Autor: A pessoa desenvolvedora*
