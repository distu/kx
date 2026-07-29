# 05 - Integracoes DevOps (Azure + GitLab)

Objetivo: por atividade, mostrar branches -> MRs (com estado de review) -> itens do Azure DevOps, em tempo quase-real, sem o a pessoa desenvolvedora abrir GitLab nem Azure. Toda esta logica vive no **Integration Service do daemon** (nunca no cliente).

## Principios

1. **Credencial nunca no cliente.** O Cockpit recebe so estado resolvido ("aprovado", "aguardando review"), jamais tokens.
2. **Credencial isolada por projeto.** Cada projeto tem seus proprios tokens/organizacao/repos. O daemon carrega o token do projeto certo; nunca usa o de um projeto em outro. (Ex.: organização usa org `example-org` + grupo GitLab `example-group/team-a/project-a`; outro projeto usa os seus.)
3. **CLI primeiro, API como fallback** (decisao D4): `glab` e `az` reusam auth ja configurada na maquina, menos codigo e menos risco de vazar segredo. Quando a CLI nao cobre, cai para REST com token do Keychain.
4. **Degradacao graciosa.** VPN caida, token expirado, 429: retorna o que tem + `degraded=true` + motivo. Nunca 500, nunca sumir com a atividade.

---

## Onde ficam os tokens

| Origem | Uso |
|--------|-----|
| Keychain do macOS (`security add-generic-password`) | Preferido para tokens do Cockpit/daemon |
| `.vault/_secrets/` do projeto | Quando o projeto ja mantem o segredo la (nunca versionado) |
| Sessao `glab` / `az login` ja ativa na maquina | Preferido: a CLI ja resolve auth, o daemon so invoca |

Config por projeto (em `~/.kx/cockpit/projects.json`, sem segredo - so ponteiros):

```jsonc
{
  "id": "fase2",
  "gitlab": {
    "group": "example-group/team-a/project-a",
    "repos": {                     // nome curto usado em branches -> path GitLab
      "mw":  "project-a-pdv-core-middleware",
      "bff": "project-a-pdv-core-bff"
    },
    "auth": "glab"                 // "glab" | "keychain:cockpit-gitlab-fase2"
  },
  "azure": {
    "org": "https://example-org.visualstudio.com",
    "project": "example-project",
    "auth": "az"                   // "az" | "env:AZURE_DEVOPS_EXT_PAT" | "keychain:..."
  },
  "requiresVpn": true              // se true, checa VPN antes de tentar
}
```

---

## GitLab: branch -> MR -> estado de review

### Descoberta

Para cada `{repo, branch}` da atividade:

```bash
# CLI preferida (reusa auth glab)
glab mr list --repo <group>/<repoPath> --source-branch <branch> --output json
```

Mapa de campos GitLab -> modelo do Cockpit:

| Cockpit | GitLab |
|---------|--------|
| `iid` | `iid` |
| `title` | `title` |
| `state` | `state` (opened/merged/closed) |
| `webUrl` | `web_url` |
| `sourceBranch` | `source_branch` |
| `updatedAt` | `updated_at` |
| `reviewState` | derivado (ver abaixo) |

### Derivacao de `reviewState`

GitLab nao entrega um unico campo "review state"; derivamos:

```
approvals = GET /projects/:id/merge_requests/:iid/approvals
reviewers = mr.reviewers

reviewState =
  "approved"           se approvals.approved == true (ou approved_by nao vazio e satisfaz regra)
  "changes_requested"  se ha review/thread nao resolvido pedindo mudanca
  "awaiting_review"    se ha reviewers atribuidos e nenhum aprovou ainda
  "no_reviewers"       se nenhum reviewer atribuido
```

Observacao do ecossistema: em um ambiente houve periodos com `required_approvals=0` temporario. O daemon exibe o estado real (approvals=0 aprovado != review humano feito) e nao mascara isso - honestidade > conveniencia.

### Links verificados

Regra do projeto: nunca montar URL de MR na mao. O daemon usa o `web_url` retornado pela API/CLI. Para link de arquivo/linha, usa SHA do commit (branch com barra quebra o blob).

---

## Azure DevOps: work items associados

### Origem da associacao

Duas vias, nesta ordem:

1. **Explicita** (preferida): campo `azure_items: [12345, 12346]` no frontmatter da atividade (doc 03). O daemon busca cada ID.
2. **Inferida** (opcional/futuro): parsear ID de work item citado no nome da branch (ex.: `feature/12345-onboard`) ou no titulo do MR. Marcado como "inferido" na UI para o a pessoa desenvolvedora confirmar.

### Consulta

```bash
az boards work-item show --id 12345 \
  --org https://example-org.visualstudio.com --project "example-project" --output json
```

Mapa:

| Cockpit | Azure |
|---------|-------|
| `id` | `id` |
| `type` | `fields["System.WorkItemType"]` |
| `title` | `fields["System.Title"]` |
| `state` | `fields["System.State"]` |
| `assignedTo` | `fields["System.AssignedTo"].displayName` |
| `url` | `_links.html.href` |

Nota: o um ambiente tem um modelo de status proprio (workflow U1..U92, `CONCLUIDO=U91`). O daemon exibe o `System.State` cru + opcionalmente traduz via um mapa configuravel por projeto, sem inventar.

---

## Cache e refresh

| Dado | TTL padrao | Gatilho de refresh |
|------|-----------|--------------------|
| MRs de uma atividade | 60s | abrir a aba, hover na atividade, evento de git local, botao "atualizar" |
| Work items | 5min | idem, menos agressivo (mudam menos) |
| Health VPN/integracoes | 30s | antes de qualquer consulta se `requiresVpn=true` |

Refresh e **assincrono e nao-bloqueante**: a UI mostra o cache imediatamente e atualiza via evento `mr.changed` quando o refresh volta. Nunca trava a lista esperando GitLab.

---

## Checagem de VPN (projetos que exigem)

Para projetos com `requiresVpn=true`, antes de consultar Azure/GitLab internos o daemon verifica conectividade (TCP/HTTP curto ao host interno). Se cair:

- `integrations/health` retorna `vpn: down`.
- A correlacao vira `degraded` com `degradedReason: "vpn: unreachable"`.
- A UI mostra uma faixa discreta "VPN do ambiente desconectada - correlacao pausada" e um botao de reconectar.

O Cockpit NAO tenta reconectar VPN sozinho por padrao; oferece o comando. (A automacao de reconexao e uma politica do ambiente do usuario, fora do escopo do daemon.)

---

## Matriz de falhas -> UX

| Falha | `degradedReason` | O que a UI mostra |
|-------|------------------|-------------------|
| Token GitLab expirado | `gitlab: 401` | Badge "reautenticar GitLab" no Settings do projeto |
| Rate limit | `gitlab: 429` | "atualizando em Ns" + usa cache |
| VPN caida | `vpn: unreachable` | Faixa de aviso + correlacao congelada com timestamp |
| Work item inexistente | `azure: 404 (id 12345)` | Item marcado como "nao encontrado" (id pode ter mudado) |
| `az`/`glab` nao instalado | `cli: missing` | Instrucao de instalar a CLI no Settings |
