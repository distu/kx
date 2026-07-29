# 04 - Daemon HTTP Local (kxd) - Contrato da API

Backend do Cockpit. Sobe como modo novo do binario `kx` (`kx daemon`). Bind em `127.0.0.1:7717` (configuravel). Framework sugerido: Fastify (leve, TS-first) ou `node:http` puro para dependencia zero. SSE nativo via response streaming.

## Convencoes gerais

- Base URL: `http://127.0.0.1:7717`
- Todas as respostas: `application/json; charset=utf-8`, UTF-8 com acentuacao preservada.
- Autenticacao local opcional: defina `KX_COCKPIT_TOKEN` e envie o header `X-Cockpit-Token: <token>`. Se configurado, requests sem o token recebem `401` (exceto `/health`).
- Erros seguem envelope padrao:

```jsonc
{ "error": { "code": "PROJECT_NOT_FOUND", "message": "Projeto 'foo' nao registrado", "hint": "Adicione em Settings > Projetos" } }
```

- **Isolamento**: todo endpoint de dados exige `:project` no path. Nao existe endpoint que agregue atividades de multiplos projetos numa mesma lista. `/projects` (plural) retorna apenas metadados de abas (nome, cor, contadores), nunca conteudo cruzado.

---

## Endpoints

### Saude e meta

```
GET /health
-> 200 { "status": "ok", "version": "0.1.0", "uptimeSec": 1234, "watchers": "running" }

GET /projects
-> 200 [
     { "id": "fase2", "name": "Projeto A", "color": "#4F46E5", "order": 1,
       "counts": { "active": 3, "blocked": 1, "pending": 2, "done": 40 },
       "runningSessions": 1 },
     { "id": "project-b", "name": "Projeto B", "color": "#059669", "order": 2, ... }
   ]

POST /projects            # registrar/editar aba (usado pela UI de Settings)
  body { "path": "/Users/.../fase2", "name": "...", "color": "#...", "order": 1 }
-> 201 { "id": "fase2", ... }

DELETE /projects/:id      # remove a aba (nao apaga nada em disco)
-> 204

GET /projects/discover    # sugestao de auto-descoberta (nao registra sozinho)
-> 200 [ { "path": "...", "project": "...", "alreadyRegistered": false } ]
```

### Atividades

```
GET /projects/:project/activities
  query:
    status   = active|pending|blocked|done|all   (default: active)
    sort     = recent|entrega|criacao|titulo      (default: recent)
    q        = texto de busca (titulo, modulo, descricao, branch)
    limit    = int (default 50)
    correlate= true|false  (default true: ja traz mrs/azure do cache)
-> 200 [
     {
       "id": 7, "slug": "onboard-v4-...", "titulo": "feature de exemplo...",
       "squad": "pdv-core", "modulo": "Edge Bootstrap", "status": "em-andamento",
       "dataInicio": "2026-07-06", "dataEntrega": "2026-07-15", "updated": "2026-07-10",
       "branches": [ { "repo": "mw", "branch": "feature/onboard-v4" } ],
       "sessions": [ { "sessionId": "af4f...", "state": "running",
                       "resumeCommand": "claude --resume af4f... --dangerously-skip-permissions",
                       "lastActivityAt": 1721748000 } ],
       "devops": { /* estrutura do doc 03, secao 3; null se correlate=false */ },
       "lastLog": "2026-07-10: reconciliacao por boot provada E2E"
     }
   ]

GET /projects/:project/activities/:slug
-> 200 { ...atividade completa..., "markdown": "<conteudo .md integral>" }

POST /projects/:project/activities
  body { "titulo": "...", "squad": "...", "modulo": "...", "descricao": "...",
         "branches": "mw:feature/x, bff:feat/y", "dataInicio": "...", "dataEntrega": "...",
         "sessao": "af4f...", "doc": "...", "status": "em-andamento" }
-> 201 { "slug": "...", "id": 8 }
   # internamente chama addActivity() de megabrain.ts - mesmo formato das tools MCP

POST /projects/:project/activities/:slug/update
  body { "tipo": "avanco|bloqueio|conclusao", "texto": "...", "sessao": "af4f..." }
-> 200 { "slug": "...", "status": "em-andamento|bloqueado|concluida" }
   # internamente chama updateActivity()

POST /projects/:project/activities/:slug/link-session
  body { "sessionId": "af4f..." }
-> 200 { "slug": "...", "sessions": [...] }
```

### Sessoes

```
GET /projects/:project/sessions
  query: state = running|idle|ended|unknown|all (default all), sort=recent
-> 200 [ { "sessionId": "af4f...", "title": "KX: Mega Brain", "state": "running",
           "lastActivityAt": 1721748000, "linkedActivitySlug": "onboard-v4-...",
           "resumeCommand": "claude --resume af4f... --dangerously-skip-permissions" } ]

GET /projects/:project/sessions/:sessionId
-> 200 { ...detalhe..., "firstPromptExcerpt": "...", "startedAt": ... }

GET /sessions/orphans   # sessoes ativas sem atividade associada, agrupadas por projeto
-> 200 [ { "project": "fase2", "sessions": [ ... ] } ]
   # alimenta a sugestao "ha uma sessao ativa sem atividade - quer associar?"
```

### Correlacao DevOps (refresh sob demanda)

```
POST /projects/:project/activities/:slug/refresh-devops
-> 200 { ...estrutura devops do doc 03... , "degraded": false }
   # forca ida ao GitLab/Azure ignorando TTL; usado pelo botao "atualizar" da UI

GET /projects/:project/integrations/health
-> 200 { "gitlab": "ok|unauthorized|unreachable", "azure": "ok|...",
         "vpn": "up|down|unknown" }
```

### Stream de eventos (SSE)

```
GET /events?project=fase2         # ou ?project=all para o badge global do icone
Content-Type: text/event-stream

event: activity.updated
data: { "project": "fase2", "slug": "onboard-v4-...", "status": "em-andamento" }

event: session.active
data: { "project": "fase2", "sessionId": "af4f...", "state": "running" }

event: session.ended
data: { "project": "fase2", "sessionId": "af4f..." }

event: mr.changed
data: { "project": "fase2", "slug": "...", "repo": "mw", "iid": 161, "reviewState": "approved" }

event: alarm
data: { "project": "fase2", "kind": "session.ended", "message": "Sessao 'KX...' terminou" }

event: heartbeat
data: { "ts": 1721748000 }
```

O cliente Swift consome via `URLSession` bytes stream. `?project=all` e usado so para o badge/contador do icone da menu bar (contadores agregados, nunca conteudo).

---

## Comportamento em falha (contrato honesto)

| Situacao | Resposta |
|----------|----------|
| Projeto nao registrado | `404 PROJECT_NOT_FOUND` com hint |
| `.kx.json` sumiu / `.vault` ausente | `409 PROJECT_MISCONFIGURED` (mesma barreira do `vaultRoot()`) |
| GitLab/Azure indisponivel | `200` com `devops.degraded=true` e `degradedReason` - nunca 500 por causa de terceiro |
| VPN necessaria caiu | `integrations/health` retorna `vpn: down`; correlacao vira `degraded`; UI mostra faixa de aviso |
| Escrita fora do vault (bug) | `500` com log; a barreira `assertInside()` impede corrupcao |

---

## Ciclo de vida do daemon

```
kx daemon                 # foreground (dev)
kx daemon --port 7717     # porta custom
LaunchAgent: ~/Library/LaunchAgents/dev.example.kxd.plist  (KeepAlive, RunAtLoad)
Logs: ~/.kx/logs/kxd.log
Health: curl -s http://127.0.0.1:7717/health
```

O Cockpit, ao abrir, faz `GET /health`. Se falhar, oferece "iniciar o daemon" (via `launchctl load`) e mostra estado "daemon offline" em vez de tela vazia.
