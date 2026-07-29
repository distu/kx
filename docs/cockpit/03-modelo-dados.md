# 03 - Modelo de Dados

O Cockpit nao inventa um modelo novo: ele **estende** o modelo de atividade que ja existe no KX activity manager e adiciona duas projecoes derivadas (indice de sessoes, correlacao DevOps) que sao **cache**, nao fonte de verdade.

## Camadas de dados

| Camada | Fonte de verdade? | Onde vive | Quem escreve |
|--------|-------------------|-----------|--------------|
| Atividade (`.md`) | SIM | `.vault/megabrain/<slug>.md` por projeto | `megabrain.ts` (via tools MCP ou via daemon) |
| MOC | SIM (derivado ordenado) | `.vault/_index/MOC-Atividades.md` | `megabrain.ts` |
| Indice de sessoes | NAO (cache) | memoria + `~/.kx/cockpit/state.sqlite` | Session Service do daemon |
| Correlacao DevOps | NAO (cache com TTL) | memoria + `state.sqlite` | Integration Service do daemon |
| Preferencias de UI | SIM (do app) | `UserDefaults` + `~/.kx/cockpit/projects.json` | Cockpit |

Principio D3: se o cache divergir do `.md`, o `.md` vence. O cache pode ser reconstruido a qualquer momento a partir do disco e das APIs.

---

## 1. Atividade (modelo canonico existente)

Ja implementado em `megabrain.ts`. Campos do frontmatter + secoes:

```yaml
---
type: atividade
id: 7                       # ID numerico estavel (nunca muda)
titulo: "feature de exemplo - reconciliacao por IP"
squad: pdv-core             # portal-backoffice|infraestrutura|integracoes|pdv-core|transversal
modulo: "Edge Bootstrap"
status: em-andamento        # em-andamento|pendente|bloqueado|concluida
data_inicio: 2026-07-06
data_entrega: 2026-07-15
tags: [atividade]
updated: 2026-07-10
sessoes_claude: ["uuid-1", "uuid-2"]   # sessoes que tocaram a atividade
---
# Secoes: Descricao, Squad e Modulo, Arquitetura e Documentacao,
# Branches (tabela repo|branch), Sessoes Claude Code (tabela), Log de Progresso,
# Erros e Bloqueios, Status (checkboxes), Links Relacionados
```

**Slug**: `slugify(titulo)` - NFD, remove acentos, lowercase, nao-alfanumerico -> `-`, max 60 chars.

### Campos que o Cockpit passa a EXIGIR/enriquecer

Para viabilizar a correlacao, tres campos ganham semantica mais estruturada (todos ja existem como texto; a mudanca e convencao + parsing, sem quebrar o formato atual):

| Campo | Hoje | Convencao para o Cockpit |
|-------|------|--------------------------|
| `branches` | "repo1:branch1, repo2:branch2" (texto) | Mesma sintaxe; o daemon parseia em `[{repo, branch}]` para casar com MRs |
| Novo: `azure_items` | inexistente | Lista de IDs de work item: `azure_items: [12345, 12346]` no frontmatter (opcional) |
| Novo: `repos_slug` | inexistente | Mapa opcional `repo curto -> path GitLab` quando o nome do repo != caminho no GitLab |

Retrocompatibilidade: atividades antigas sem `azure_items` simplesmente nao mostram correlacao Azure - degradacao graciosa, nada quebra.

---

## 2. Indice de sessoes (derivado dos `.jsonl`)

Projecao construida pelo Session Service. Uma entrada por sessao do Claude Code observada, por projeto.

```jsonc
{
  "sessionId": "af4fcf69-...-uuid",      // = nome do arquivo .jsonl (sem extensao)
  "project": "fase2",                     // resolvido pelo project-slug -> .kx.json
  "projectRoot": "/Users/.../fase2",
  "transcriptPath": "~/.claude/projects/<slug>/af4f...jsonl",
  "title": "KX: Mega Brain",             // do /rename, se houver; senao 1o prompt resumido
  "firstPromptExcerpt": "Veja bem, o meu MCP-KX...",
  "startedAt": 1721740000,
  "lastActivityAt": 1721748000,          // mtime do arquivo
  "state": "running|idle|ended|unknown", // heuristica no doc 06
  "linkedActivitySlug": "onboard-v4-...", // null se nao associada
  "resumeCommand": "claude --resume af4f... --dangerously-skip-permissions"
}
```

Chave primaria: `sessionId`. Nunca cruza projetos: o `project` e derivado do path e validado contra o registry.

---

## 3. Correlacao DevOps (derivado das APIs)

Cache por atividade, com TTL (ex.: 60s para MRs, 5min para work items). Estrutura entregue ao cliente ja resolvida:

```jsonc
{
  "activitySlug": "onboard-v4-...",
  "mergeRequests": [
    {
      "repo": "project-a-pdv-core-middleware",
      "iid": 161,
      "title": "feat: feature de exemplo reconciliacao por IP",
      "state": "opened|merged|closed",
      "reviewState": "approved|changes_requested|awaiting_review|no_reviewers",
      "webUrl": "https://gitlab.com/.../merge_requests/161",
      "sourceBranch": "feature/onboard-v4",
      "updatedAt": 1721747000
    }
  ],
  "azureItems": [
    {
      "id": 12345,
      "type": "User Story|Task|Bug",
      "title": "Onboard de terminal novo",
      "state": "Active|Resolved|Closed",
      "url": "https://example-org.visualstudio.com/.../_workitems/edit/12345",
      "assignedTo": "A pessoa desenvolvedora"
    }
  ],
  "refreshedAt": 1721748000,
  "degraded": false,        // true se alguma fonte falhou (VPN down, token expirado)
  "degradedReason": null    // "gitlab: 401" | "azure: timeout" | "vpn: unreachable"
}
```

`degraded` e obrigatorio: quando a VPN cai ou um token expira, o Cockpit mostra a correlacao que tem + um aviso honesto, nunca some com a atividade nem finge estado atualizado.

---

## 4. Schema do cache (`~/.kx/cockpit/state.sqlite`)

Banco proprio do daemon, separado dos bancos de RAG por projeto. So cache/estado - descartavel.

```sql
-- Sessoes observadas
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  project         TEXT NOT NULL,
  project_root    TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  title           TEXT,
  first_prompt    TEXT,
  started_at      INTEGER,
  last_activity   INTEGER,
  state           TEXT DEFAULT 'unknown',
  linked_slug     TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_last ON sessions(last_activity DESC);

-- Correlacao DevOps (cache com TTL)
CREATE TABLE devops_cache (
  activity_slug TEXT NOT NULL,
  project       TEXT NOT NULL,
  kind          TEXT NOT NULL,        -- 'mr' | 'azure'
  payload       TEXT NOT NULL,        -- JSON do item
  refreshed_at  INTEGER NOT NULL,
  PRIMARY KEY (activity_slug, project, kind)
);

-- Eventos recentes (para SSE replay / debug)
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT NOT NULL,
  type       TEXT NOT NULL,           -- activity.updated | session.active | mr.changed | alarm
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_project ON events(project, created_at DESC);
```

Isolamento: toda linha carrega `project`; toda query do daemon filtra por `project`. O cliente sempre pede por projeto; nao existe endpoint que retorne atividades de projetos misturados.

---

## 5. Migracao / retrocompatibilidade

- **Nao ha migracao destrutiva.** O `state.sqlite` e criado do zero e pode ser apagado a qualquer momento (reconstroi observando disco + APIs).
- Atividades existentes funcionam sem nenhuma alteracao. Os campos novos (`azure_items`, `repos_slug`) sao opcionais e so ativam a correlacao Azure/refinamento quando presentes.
- Uma tool auxiliar (`megabrain_link_azure`) pode ser adicionada depois para popular `azure_items` conversando com o daemon - fora do escopo desta fase.
