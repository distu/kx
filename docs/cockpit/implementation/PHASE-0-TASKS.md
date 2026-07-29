# Fase 0 - Breakdown Granular de Tasks

Cada task é verificável e testável isoladamente. Marcar conforme completa.

---

## Pre-Task: Setup Inicial (15 minutos)

**Objetivo:** Preparar ambiente antes de Task 0.

**Passos:**

```bash
cd /path/to/kx

# 1. Verificar hash de main (CRÍTICO)
git log --oneline main -1
# Esperado: 3a532f9 feat(megabrain): auto-bootstrap...
# Se diferente, PERGUNTAR ao user antes de continuar

# 2. Criar branch isolada
git checkout -b feat/daemon-phase0 main

# 3. Confirmar branch nova
git branch
# Deve listar: * feat/daemon-phase0

# 4. Instalar YAML parser (OBRIGATÓRIO)
npm install yaml

# 5. Exportar funções de megabrain.ts (CRÍTICO)
# Editar arquivo src/megabrain.ts:
#   Linha ~20: adicionar 'export' antes de 'function vaultRoot'
#   Linha ~30: adicionar 'export' antes de 'function assertInside'
# Verificar:
npm run build  # deve compilar sem erro

# 6. Criar arquivo de exceções customizadas
cat > src/daemon/errors.ts <<'EOF'
export class ProjectNotFoundError extends Error {
  code = 'PROJECT_NOT_FOUND';
  statusCode = 404;
  constructor(projectId: string) {
    super(`Projeto '${projectId}' não registrado`);
  }
}

export class ProjectMisconfiguredError extends Error {
  code = 'PROJECT_MISCONFIGURED';
  statusCode = 409;
  constructor(projectId: string) {
    super(`Projeto '${projectId}' sem .vault ou .kx.json inválido`);
  }
}

export class ForbiddenError extends Error {
  code = 'FORBIDDEN';
  statusCode = 403;
  constructor(msg: string) {
    super(msg);
  }
}

export class ActivityNotFoundError extends Error {
  code = 'ACTIVITY_NOT_FOUND';
  statusCode = 404;
  constructor(slug: string) {
    super(`Atividade '${slug}' não encontrada`);
  }
}
EOF

# 7. Build final
npm run build
```

**Critério de aceite:**
- [ ] Hash main retorna `3a532f9`
- [ ] Branch isolada: `git branch` mostra `* feat/daemon-phase0`
- [ ] `npm install yaml` executado
- [ ] Funções exportadas de megabrain.ts
- [ ] `npm run build` passa (zero erros)

**Pronto quando:** Todos 5 critérios

---

## Task 0: Preparação de Ambiente

**Objetivo:** Confirmar estado seguro antes de começar desenvolvimento.

**Passos:**
1. Verificar branch isolada: `git branch` (deve listar `* feat/daemon-phase0`)
2. Confirmar WIP seguro: `git log --oneline main -1` (retorna `3a532f9`)
3. Confirmar build: `npm run build` (passa sem erros)
4. Confirmar dev runner: `npm run dev -- --help` (executa sem erro)

**Critério de aceite:**
- [ ] Você está em branch `feat/daemon-phase0`
- [ ] `git status` mostra clean (sem WIP local)
- [ ] `git log --oneline main -1` retorna `3a532f9` (HEAD main não moveu)
- [ ] `npm run build` passa (zero erros)
- [ ] `npm run dev -- --help` executa sem erro

**Teste:**
```bash
git branch
git status
git log --oneline main -1
npm run build
npm run dev -- --help
```

**Pronto quando:** Todos os 3 comandos acima executam sem erro.

---

## Task 1: Criar Estrutura de Diretórios

**Objetivo:** Criar stub files vazios para module skeleton.

**Arquivos a criar:**
```
src/daemon/
├── index.ts
├── server.ts
├── registry.ts
├── project-resolver.ts
├── activity-service.ts
├── middleware/
│   ├── auth.ts
│   ├── isolate.ts
│   └── error-handler.ts
└── types/
    └── daemon.ts
```

**Passos:**
```bash
mkdir -p src/daemon/middleware src/daemon/types

# Criar files vazios
touch src/daemon/{index,server,registry,project-resolver,activity-service}.ts
touch src/daemon/middleware/{auth,isolate,error-handler}.ts
touch src/daemon/types/daemon.ts

# Verificar
ls -la src/daemon/
ls -la src/daemon/middleware/
ls -la src/daemon/types/
```

**Critério de aceite:**
- [ ] 9 arquivos existem
- [ ] `npm run build` executa (pode ter erros de tipo, OK em Task 1)
- [ ] Estrutura pronta no file explorer

**Teste:**
```bash
ls -la src/daemon/
npm run build
```

**Pronto quando:** 9 arquivos existem, estrutura visível.

---

## Task 2: Implementar daemon/types/daemon.ts

**Objetivo:** Definir tipos TypeScript com **snake_case obrigatório**.

**Responsabilidade:** Shape de Project, Activity, APIResponse, APIError, Queries.

**Tipos a definir:**

```typescript
// Project (do registry)
export interface Project {
  id: string;          // 'teste', 'fase2'
  name: string;        // 'Teste Fase 0'
  color: string;       // '#4F46E5'
  order: number;       // 1, 2, ...
  path?: string;       // '/tmp/kx-test', lido do registry
}

// Activity (parsado de .md) — SNAKE_CASE OBRIGATÓRIO
export interface Activity {
  id: number;
  slug: string;
  titulo: string;
  squad?: string;
  modulo?: string;
  status: 'em-andamento' | 'pendente' | 'bloqueado' | 'concluida';
  data_inicio?: string;      // YYYY-MM-DD format
  data_entrega?: string;     // YYYY-MM-DD format
  updated?: string;
  branches?: string;         // "repo1:branch1, repo2:branch2"
  last_log?: string;         // última linha de "Log de Progresso"
  type?: string;
  tags?: string[];
}

// Counts (por status)
export interface StatusCounts {
  active: number;      // em-andamento
  blocked: number;     // bloqueado
  pending: number;     // pendente
  done: number;        // concluida
}

// Health Response
export interface HealthResponse {
  status: 'ok' | 'error';
  version: string;
  uptimeSec: number;
  watchers: 'running' | 'paused' | 'error';
}

// API Error
export interface APIErrorResponse {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

// List Activities Query Params
export interface ActivitiesQuery {
  status?: 'all' | 'em-andamento' | 'pendente' | 'bloqueado' | 'concluida';
  sort?: 'recent' | 'entrega' | 'criacao' | 'titulo';
  q?: string;
  limit?: number;
}

// Project List Response
export interface ProjectsListResponse {
  id: string;
  name: string;
  color: string;
  order: number;
  counts: StatusCounts;
  runningSessions: number;
}
```

**Arquivo:** `src/daemon/types/daemon.ts`

**Critério de aceite:**
- [ ] 6+ interfaces definidas
- [ ] Todos tipos usam string/number/boolean/enum (sem `any`)
- [ ] **Campos Activity são snake_case: data_inicio, data_entrega, last_log**
- [ ] `npm run build` passa (zero erros de tipo)

**Teste:**
```bash
npm run build
# ou
npm run dev -- --help
```

**Pronto quando:** `npm run build` não tem erros de tipo.

---

## Task 3: Implementar daemon/registry.ts

**Objetivo:** Carregar e validar `~/.kx/cockpit/projects.json`.

**Responsabilidade:**
1. Criar diretório `~/.kx/cockpit/` se não existir (BOOTSTRAP)
2. Ler arquivo JSON
3. Validar schema (id, name, color, order presentes)
4. Retornar array tipado `Project[]`

**Função principal:**
```typescript
export function loadRegistry(): Project[]
// Lê ~/.kx/cockpit/projects.json
// Cria directory se não existir (mkdirSync recursive)
// Valida schema (cada projeto tem id, name, color, order)
// Retorna array Project[] ordenado por order
// Lança RegistryError se JSON inválido
```

**Imports:**
```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import type { Project } from './types/daemon.js';
```

**Arquivo:** `src/daemon/registry.ts`

**Critério de aceite:**
- [ ] Função `loadRegistry()` exportada
- [ ] Valida schema (id, name, color, order)
- [ ] Cria `~/.kx/cockpit/` se não existir (mkdirSync)
- [ ] Cria `projects.json` vazio se não existir: `{ projects: [], version: "1.0.0" }`
- [ ] Retorna `Project[]` ordenado por order
- [ ] Trata JSON inválido (lança erro descritivo)
- [ ] `npm run build` passa

**Teste:**
```bash
mkdir -p ~/.kx/cockpit
cat > ~/.kx/cockpit/projects.json <<'EOF'
{
  "projects": [
    {
      "id": "teste",
      "path": "/tmp/teste",
      "name": "Teste",
      "color": "#FF0000",
      "order": 1
    }
  ]
}
EOF

npm run build
```

**Pronto quando:** `loadRegistry()` retorna `Project[]` com elementos do .json.

---

## Task 4: Implementar daemon/project-resolver.ts

**Objetivo:** Resolver projectId → path + .kx.json + .vault/ com isolamento + symlink protection.

**Responsabilidade:**
1. Recebe projectId (string)
2. Busca no registry (loadRegistry)
3. Carrega .kx.json do projeto (loadConfig)
4. Valida .vault/ existe (vaultRoot)
5. **Usa realpathSync() para bloquear symlinks**
6. Retorna config + vault path seguro

**Funções principais:**
```typescript
export function resolveProject(projectId: string): {
  config: KxConfig;
  vaultRoot: string;
}
// Lança: ProjectNotFoundError, ProjectMisconfiguredError

export function validateProjectPath(vaultRoot: string, filePath: string): string
// Valida que filePath está dentro do vault do projeto (com realpathSync)
// Retorna: caminho absoluto seguro
// Lança: ForbiddenError se path traversal detectado via symlink
```

**Arquivo:** `src/daemon/project-resolver.ts`

**Imports:**
```typescript
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { loadRegistry } from './registry.js';
import { loadConfig, vaultRoot, assertInside } from '../megabrain.js';
import { ProjectNotFoundError, ProjectMisconfiguredError, ForbiddenError } from './errors.js';
import type { KxConfig } from '../config.js';
```

**Lógica de segurança (CRÍTICA):**
```typescript
function validateProjectPath(vaultRoot: string, filePath: string): string {
  // Resolver ambos para paths reais (segue symlinks, detecta loops)
  const real = realpathSync(filePath, { throwIfNoEntry: false });
  const vaultReal = realpathSync(vaultRoot);

  // Verificar containment
  if (!real.startsWith(vaultReal + '/') && real !== vaultReal) {
    throw new ForbiddenError(`Path fora do vault (isolamento): ${filePath}`);
  }

  return real;
}
```

**Critério de aceite:**
- [ ] Função `resolveProject(projectId)` exportada
- [ ] Função `validateProjectPath()` exportada
- [ ] Projeto não registrado → lança `ProjectNotFoundError`
- [ ] `.vault/` ausente → lança `ProjectMisconfiguredError`
- [ ] Path traversal bloqueado: `../../etc/passwd` → lança `ForbiddenError`
- [ ] Symlinks bloqueados via `realpathSync()`
- [ ] `npm run build` passa

**Teste:**
```bash
mkdir -p /tmp/teste/.vault/megabrain
echo 'project: teste' > /tmp/teste/.kx.json

npm run build
```

**Pronto quando:** `resolveProject('teste')` retorna config + vault sem erro.

---

## Task 5: Implementar daemon/activity-service.ts

**Objetivo:** Listar atividades com filtro, sort, busca (REUSAR megabrain.ts).

**Responsabilidade:**
1. Ler `.vault/megabrain/*.md`
2. Parsear frontmatter YAML cada .md (usar `yaml` package)
3. Extrair id, slug (filename sem .md), titulo, status, etc.
4. Implementar `countActivitiesByStatus()` para counts
5. Aplicar filtros (status, sort, busca)
6. Retornar `Activity[]`

**Função principal:**
```typescript
export function listActivities(
  config: KxConfig,
  vaultRoot: string,
  filters: ActivitiesQuery
): Activity[]
// config: KxConfig (de resolveProject)
// vaultRoot: caminho do .vault (de resolveProject)
// filters: { status?, sort?, q?, limit?, correlate? }
// Retorna: Activity[] filtrado e ordenado

export function countActivitiesByStatus(
  config: KxConfig,
  vaultRoot: string
): StatusCounts
// Retorna contadores { active, blocked, pending, done }
// Reusar statusReport() de megabrain.ts internamente
```

**Lógica de filtro e sort:**
- **Filtro status**: Comparar `status:` do YAML com enum
- **Sort**:
  - `recent`: por updated DESC
  - `entrega`: por data_entrega ASC (mais perto primeiro)
  - `criacao`: por data_inicio DESC
  - `titulo`: alfanumérico ASC
- **Busca (q)**: case-insensitive em titulo, modulo, branch, tags
- **Limit**: truncar resultado
- **Tiebreaker**: id ASC quando valores de sort iguais

**Arquivo:** `src/daemon/activity-service.ts`

**Imports:**
```typescript
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import * as yaml from 'yaml';
import { getActivity } from '../megabrain.js';
import type { KxConfig } from '../config.js';
import type { Activity, ActivitiesQuery, StatusCounts } from './types/daemon.js';
```

**Critério de aceite:**
- [ ] Função `listActivities()` exportada
- [ ] Função `countActivitiesByStatus()` exportada
- [ ] Lê todos .md de .vault/megabrain/
- [ ] Parseia frontmatter YAML (extrai id, titulo, status, etc.)
- [ ] Slug gerado de filename (task-teste.md → task-teste)
- [ ] **Campos retornados são snake_case: data_inicio, data_entrega, last_log**
- [ ] Filtros aplicados (status, sort, busca)
- [ ] Retorna `Activity[]` com tiebreaker id
- [ ] `npm run build` passa

**Teste:**
```bash
mkdir -p /tmp/teste/.vault/megabrain
cat > /tmp/teste/.vault/megabrain/task-1.md <<'EOF'
---
id: 1
titulo: Task 1
status: em-andamento
data_inicio: 2026-07-23
data_entrega: 2026-07-30
updated: 2026-07-23
---
# Log de Progresso
2026-07-23: criada
EOF

npm run build
```

**Pronto quando:** `listActivities()` retorna array com atividades parseadas corretamente.

---

## Task 6: Implementar Middleware (isolate, error-handler)

**Objetivo:** Middleware reutilizável para validação e tratamento de erro.

### 6a: middleware/isolate.ts

Valida que `:project` existe no registry E que `.vault/` é acessível.

```typescript
export async function isolateMiddleware(c, next) {
  const projectId = c.req.param('project');

  try {
    const { config, vaultRoot } = resolveProject(projectId);
    c.set('project', { id: projectId, config, vaultRoot });
    await next();
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return c.json(
        {
          error: {
            code: 'PROJECT_NOT_FOUND',
            message: `Projeto '${projectId}' não registrado`,
            hint: 'Adicione em Settings > Projetos'
          }
        },
        404
      );
    }
    if (err instanceof ProjectMisconfiguredError) {
      return c.json(
        {
          error: {
            code: 'PROJECT_MISCONFIGURED',
            message: `Projeto '${projectId}' sem .vault ou .kx.json inválido`
          }
        },
        409
      );
    }
    throw err;
  }
}
```

### 6b: middleware/error-handler.ts

Standardize error responses.

```typescript
export async function errorHandlerMiddleware(c, next) {
  try {
    await next();
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = err.message || 'Erro interno do servidor';
    const hint = err.hint;

    return c.json(
      {
        error: {
          code,
          message,
          ...(hint && { hint })
        }
      },
      statusCode
    );
  }
}
```

### 6c: middleware/auth.ts (Stub - Opcional Fase 0)

Pode deixar vazio ou stub simples (Fase 5 implementa autenticação real).

```typescript
export async function authMiddleware(c, next) {
  // Fase 0: sem autenticação
  await next();
}
```

**Arquivo:** `src/daemon/middleware/{auth,isolate,error-handler}.ts`

**Critério de aceite:**
- [ ] `isolateMiddleware(c, next)` valida projectId
- [ ] `isolateMiddleware` chama `resolveProject()` (valida .vault!)
- [ ] Retorna 404 PROJECT_NOT_FOUND se projeto não registrado
- [ ] Retorna 409 PROJECT_MISCONFIGURED se .vault ausente
- [ ] `errorHandlerMiddleware(c, next)` standardiza respostas
- [ ] `authMiddleware(c, next)` é stub/passthrough
- [ ] `npm run build` passa

**Pronto quando:** Middleware exporta funções sem erro de tipo.

---

## Task 7: Implementar daemon/server.ts

**Objetivo:** Sobe HTTP server Hono com 4 rotas GET.

**Framework:** Hono 4.12.9 (TS-first, já instalado)

**Rotas:**

```typescript
import { Hono } from 'hono';
import { errorHandlerMiddleware, isolateMiddleware } from './middleware/index.js';
import { loadRegistry } from './registry.js';
import { resolveProject, validateProjectPath } from './project-resolver.js';
import { listActivities, countActivitiesByStatus } from './activity-service.js';
import { getActivity } from '../megabrain.js';
import { ActivityNotFoundError, ForbiddenError } from './errors.js';

export async function startServer(port: number = 7717) {
  const app = new Hono();

  // Middleware (ordem importa)
  app.use(errorHandlerMiddleware);

  // GET /health
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      uptimeSec: Math.floor(process.uptime()),
      watchers: 'running'
    });
  });

  // GET /projects
  app.get('/projects', (c) => {
    const registry = loadRegistry();
    const projects = registry.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      order: p.order,
      counts: countActivitiesByStatus(p.id),
      runningSessions: 0
    }));
    return c.json(projects);
  });

  // GET /projects/:project/activities
  app.get('/projects/:project/activities', isolateMiddleware, (c) => {
    const { config, vaultRoot } = c.get('project');
    const status = c.req.query('status') || 'all';
    const sort = c.req.query('sort') || 'recent';
    const q = c.req.query('q');
    const limit = parseInt(c.req.query('limit') || '50');

    const filters = {
      status: status === 'all' ? undefined : status,
      sort,
      q,
      limit
    };

    const activities = listActivities(config, vaultRoot, filters);
    return c.json(activities);
  });

  // GET /projects/:project/activities/:slug
  app.get('/projects/:project/activities/:slug', isolateMiddleware, (c) => {
    const { config, vaultRoot } = c.get('project');
    const slug = c.req.param('slug');

    // Validar path seguro
    try {
      const filePath = resolve(vaultRoot, 'megabrain', `${slug}.md`);
      validateProjectPath(vaultRoot, filePath);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.json(
          { error: { code: 'FORBIDDEN', message: err.message } },
          403
        );
      }
      throw err;
    }

    // Obter atividade
    const activities = listActivities(config, vaultRoot, { limit: 1 });
    const activity = activities.find(a => a.slug === slug);

    if (!activity) {
      return c.json(
        {
          error: {
            code: 'ACTIVITY_NOT_FOUND',
            message: `Atividade '${slug}' não encontrada`
          }
        },
        404
      );
    }

    // Obter markdown
    const markdown = getActivity(config, slug);

    return c.json({
      ...activity,
      markdown
    });
  });

  // Startup
  app.listen({ host: '127.0.0.1', port }, () => {
    console.log(`[kxd] Listening on http://127.0.0.1:${port}`);
  });
}
```

**Arquivo:** `src/daemon/server.ts`

**Critério de aceite:**
- [ ] Função `startServer(port)` exportada
- [ ] Hono app setado com 4 rotas GET
- [ ] Middleware errorHandler + isolate aplicados
- [ ] Server.listen() binda apenas 127.0.0.1
- [ ] Response headers: Content-Type: application/json (automático Hono)
- [ ] Endpoints retornam **snake_case** (data_inicio, data_entrega, etc.)
- [ ] Tratamento de erro: 404 ACTIVITY_NOT_FOUND, 403 FORBIDDEN, 409 PROJECT_MISCONFIGURED
- [ ] `npm run build` passa

**Teste:** (integrado em Task 8)

**Pronto quando:** Server sobe, rotas retornam payloads esperados.

---

## Task 8: Plugar Daemon em index.ts

**Objetivo:** Adicionar despacho `kx daemon` ao entry point.

**Arquivo:** `src/index.ts`

**Mudança (adicionar antes do else final, ~linha 25):**
```typescript
} else if (command === 'daemon') {
  const port = parseInt(args[1] || '7717', 10);
  const { startServer } = await import('./daemon/server.js');
  await startServer(port);
}
```

**Critério de aceite:**
- [ ] `npm run dev -- kx daemon` sobe server
- [ ] Server listen em 127.0.0.1:7717
- [ ] `npm run dev -- kx daemon --port 9999` respeita porta
- [ ] `npm run build` passa

**Teste:**
```bash
npm run dev -- kx daemon &
DAEMON_PID=$!
sleep 2
curl -s http://127.0.0.1:7717/health | jq .
kill $DAEMON_PID
```

**Pronto quando:** Daemon sobe, curl /health retorna 200.

---

## Task 9: Testes Completos com Curl

**Objetivo:** Validar todos endpoints com dados reais (IDEMPOTENTE).

### Setup (Executar UMA vez, com backup/restore)

```bash
# Criar backup de ambiente anterior (se existir)
if [ -d ~/.kx/cockpit ]; then
  BACKUP=$(mktemp -d)
  cp -r ~/.kx/cockpit "$BACKUP"
  echo "Backup anterior em $BACKUP"
fi

# Registry
mkdir -p ~/.kx/cockpit
cat > ~/.kx/cockpit/projects.json <<'EOF'
{
  "projects": [
    {
      "id": "fase0",
      "path": "/tmp/kx-phase0",
      "name": "Teste Fase 0",
      "color": "#4F46E5",
      "order": 1
    }
  ],
  "version": "1.0.0"
}
EOF

# Projeto
mkdir -p /tmp/kx-phase0/.vault/megabrain
echo 'project: fase0' > /tmp/kx-phase0/.kx.json

# 2 atividades
cat > /tmp/kx-phase0/.vault/megabrain/task-1.md <<'EOF'
---
id: 1
titulo: Task 1 - Daemon HTTP
squad: infraestrutura
modulo: Fase 0
status: em-andamento
data_inicio: 2026-07-23
data_entrega: 2026-07-28
updated: 2026-07-23
---
# Log de Progresso
2026-07-23: Implementação
EOF

cat > /tmp/kx-phase0/.vault/megabrain/task-2.md <<'EOF'
---
id: 2
titulo: Task 2 - Testes Curl
squad: infraestrutura
modulo: Fase 0
status: pendente
data_inicio: 2026-07-24
data_entrega: 2026-07-30
updated: 2026-07-24
---
# Log de Progresso
2026-07-24: Testes
EOF
```

### Testes (Executar com daemon rodando)

```bash
# Sube daemon
npm run dev -- kx daemon &
DAEMON_PID=$!
sleep 2

# T1: Health
echo "=== T1: Health ==="
curl -s http://127.0.0.1:7717/health | jq .
# Esperado: { status: "ok", version: "0.1.0", uptimeSec: ?, watchers: "running" }

# T2: Projects
echo "=== T2: Projects ==="
curl -s http://127.0.0.1:7717/projects | jq .
# Esperado: [{ id: "fase0", counts: { active: 1, pending: 1, blocked: 0, done: 0 } }]

# T3: All Activities
echo "=== T3: All Activities ==="
curl -s http://127.0.0.1:7717/projects/fase0/activities | jq .
# Esperado: array com 2 items

# T4: Filter em-andamento
echo "=== T4: Filter ==="
curl -s 'http://127.0.0.1:7717/projects/fase0/activities?status=em-andamento' | jq .
# Esperado: 1 item (task-1)

# T5: Sort por entrega
echo "=== T5: Sort Entrega ==="
curl -s 'http://127.0.0.1:7717/projects/fase0/activities?sort=entrega' | jq .
# Esperado: task-1 primeira (2026-07-28 < 2026-07-30)

# T6: Busca
echo "=== T6: Search ==="
curl -s 'http://127.0.0.1:7717/projects/fase0/activities?q=Testes' | jq .
# Esperado: 1 item (task-2)

# T7: Detalhe (com markdown)
echo "=== T7: Detail ==="
curl -s 'http://127.0.0.1:7717/projects/fase0/activities/task-1' | jq .
# Esperado: contém markdown, campos snake_case

# T8: Projeto Não Existe
echo "=== T8: Not Found ==="
curl -s 'http://127.0.0.1:7717/projects/nao-existe/activities' | jq .
# Esperado: 404 { error: { code: "PROJECT_NOT_FOUND" } }

# T9: Path Traversal
echo "=== T9: Path Traversal ==="
curl -s 'http://127.0.0.1:7717/projects/fase0/activities/../../etc/passwd' | jq .
# Esperado: 403 { error: { code: "FORBIDDEN" } }

# T10: Project Misconfigured
echo "=== T10: Misconfigured ==="
rm -rf /tmp/kx-phase0/.vault
curl -s 'http://127.0.0.1:7717/projects/fase0/activities' | jq .
# Esperado: 409 { error: { code: "PROJECT_MISCONFIGURED" } }

# Cleanup
kill $DAEMON_PID
```

### Cleanup e Restore (IMPORTANTE)

```bash
# Restaurar ambiente anterior
rm -rf ~/.kx/cockpit
if [ -n "$BACKUP" ]; then
  cp -r "$BACKUP" ~/.kx/cockpit
  rm -rf "$BACKUP"
fi

# Remover dados de teste
rm -rf /tmp/kx-phase0
```

**Arquivo de Testes:** `tests/curl-tests.sh` (criar para documentação)

**Critério de aceite:**
- [ ] T1–T7: 200 OK com payload esperado
- [ ] T8: 404 PROJECT_NOT_FOUND
- [ ] T9: 403 FORBIDDEN
- [ ] T10: 409 PROJECT_MISCONFIGURED
- [ ] Testes idempotentes (backup/restore funciona)
- [ ] Saída REAL copiada para relatório

**Pronto quando:** 10 testes passam 100%, ambiente restaurado.

---

## Task 10: Logs + Definition of Done

**Objetivo:** Setup logging + final checklist.

### Setup Logging

Adicionar ao `src/daemon/server.ts` no startup:

```typescript
import { createWriteStream, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

export async function startServer(port: number = 7717) {
  // Setup logging
  const logDir = resolve(homedir(), '.kx', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, 'kxd.log');
  const logStream = createWriteStream(logFile, { flags: 'a' });

  function log(msg: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    console.log(msg);
    logStream.write(line);
  }

  // SIGTERM handler (graceful shutdown)
  process.on('SIGTERM', () => {
    log('[kxd] Received SIGTERM, shutting down');
    logStream.end();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('[kxd] Received SIGINT, shutting down');
    logStream.end();
    process.exit(0);
  });

  const app = new Hono();
  // ... resto do server ...

  app.listen({ host: '127.0.0.1', port }, () => {
    log(`Daemon kxd iniciado em http://127.0.0.1:${port}`);
  });
}
```

### Definition of Done Checklist Final

```markdown
## Código
- [ ] npm run build: 0 erros TypeScript
- [ ] npm run dev -- kx daemon: sem warnings críticos
- [ ] Nenhum `any`, todos tipos explícitos
- [ ] Commits todos em PT-BR, sem emoji
- [ ] WIP original não destruído (main -1 = 3a532f9)

## Testes
- [ ] T1–T10 curl todos passando 100%
- [ ] curl output REAL copiado para relatório final
- [ ] Isolamento testado (cross-project bloqueado)
- [ ] Path traversal testado (403 FORBIDDEN retornado)
- [ ] Symlinks bloqueados via realpathSync
- [ ] Project misconfigured testado (409 PROJECT_MISCONFIGURED)

## Documentação e Segurança
- [ ] ~/.kx/logs/kxd.log criado ao rodar daemon
- [ ] Logs com formato [TIMESTAMP] mensagem
- [ ] Nenhum segredo, token ou credencial em Git
- [ ] Código sem console.log de debug
- [ ] Imports sem unused (eslint-ready)

## Dados e Contrato
- [ ] Activity responses usam snake_case (data_inicio, data_entrega)
- [ ] Todos endpoints retornam JSON
- [ ] Error responses padronizadas: { error: { code, message, hint? } }

## Pronto para Revisão
- [ ] npm run build: zero erros
- [ ] Testes 100% passando
- [ ] Branch feat/daemon-phase0 pronta
- [ ] Relatório com curl output copiado
- [ ] WIP main seguro
```

**Critério de aceite:**
- [ ] Todos itens acima
- [ ] Relatório criado e salvo

**Pronto quando:** Todos itens marcados, daemon rodando, testes passando.

---

## Resumo do Fluxo (4h45min)

| Task | Descrição | Est. | Pronto Quando |
|------|-----------|------|--------------|
| Pre | Setup: export functions, npm install yaml | 15min | npm run build passa |
| 0 | Preparação ambiente | 5min | branch isolada, hash verificado |
| 1 | Estrutura diretórios | 10min | 9 files criados |
| 2 | Types/interfaces (snake_case!) | 20min | 6+ interfaces, testes compilam |
| 3 | Registry.ts | 30min | loadRegistry() funciona |
| 4 | Project-resolver.ts (realpathSync) | 30min | resolveProject() isolado, symlinks bloqueados |
| 5 | Activity-service.ts | 45min | listActivities() com filtros |
| 6 | Middleware (isolate, error-handler) | 20min | 3 middlewares exportam |
| 7 | Server.ts Hono (4 rotas) | 60min | 4 rotas GET rodando |
| 8 | Plugar em index.ts | 10min | `kx daemon` sobe |
| 9 | Testes curl (10 testes) | 30min | 10 testes passando, env restaurado |
| 10 | Logs + checklist | 15min | Pronto para revisão |
| **TOTAL** | **Fase 0 Completa** | **~4h45min** | **Daemon em produção local** |

---

## Ao Terminar

Reporte ao usuário:

```
Fase 0 do daemon kxd está completa e testada.

Daemon sobe em http://127.0.0.1:7717.

Endpoints:
- GET /health
- GET /projects
- GET /projects/:project/activities (filtro + sort)
- GET /projects/:project/activities/:slug

Isolamento por projeto validado.
Path traversal bloqueado com realpathSync().
10 testes curl 100% passando.

Pronto para revisão antes de MR.
```

**NÃO passe para fases posteriores** — serão outra sessão.

---

**Última Atualização**: 2026-07-23
**Escopo**: Fase 0 SOMENTE (leitura, sem POST/PUT)
**Framework**: Hono 4.12.9
**Isolamento**: realpathSync() obrigatório
