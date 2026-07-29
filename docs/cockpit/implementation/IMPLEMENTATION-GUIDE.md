# Guia de Implementação - KX Cockpit Fase 0

## Fatos do Repositório (Verificados)

### Path e Estrutura
```
Repositório: /path/to/kx
Branch principal: main (3a532f9)
WIP atual: 165 linhas modificadas em 5 arquivos (src/config.ts, src/megabrain.ts, etc.)
Estado: Worktree ou branch isolada necessária para não destruir WIP
```

### Node e Build
```bash
Node.js: v20.x (via fnm ou nvm)
Package manager: npm (npm install, npm run dev, npm run build)
Type: ES modules (package.json: "type": "module")
TypeScript: sim (tsconfig.json configurado, tsc no build)
Dev runner: tsx (npm run dev executa via ts-node/esm)
```

### Dependências Verificadas
```bash
npm ls hono
hono@4.12.9  ← USAR ESTE (já instalado, TS-first, leve)

npm ls express
express@5.2.1  ← instalado mas Fase 0 usa Hono

npm ls yaml
# VAZIO — INSTALAR: npm install yaml

npm ls better-sqlite3
npm ls sqlite-vec
npm ls commander
npm ls chokidar
npm ls glob
```

### Scripts Disponíveis
```json
{
  "build": "tsc",
  "start": "node --loader ts-node/esm src/index.ts",
  "dev": "tsx src/index.ts"
}
```

**Uso:**
```bash
npm run build        # compila TS → JS
npm run dev          # roda TS direto (dev rápido)
npm start            # roda JS compilado
npm install yaml     # EXECUTAR ANTES DE TASK 1
```

### Estado do Git
```bash
git log --oneline main -5
3a532f9 feat(megabrain): auto-bootstrap do .vault por projeto + isolamento por .kx.json
df532b1 feat(megabrain): tools MCP para gestao de atividades no .vault
... [mais commits]

git status
M  src/config.ts
M  src/megabrain.ts
M  src/searcher.ts
M  src/mcp-server.ts
M  bin/kx-mcp.sh
```

**Ação crítica:** Hash `3a532f9` é o baseline. Se muda, perguntar ao user.

### Branch Isolada
```bash
git checkout -b feat/daemon-phase0 main
# main fica intacta com WIP; você trabalha isolado em feat/daemon-phase0
# Ao terminar, avisar user para revisar + integrar antes de ir pra main
```

---

## O Que Reusar (Código Verificado)

### 1. megabrain.ts — Funções de Leitura

**Arquivo**: `src/megabrain.ts` (linhas 144–353)

**ATENÇÃO: Funções de isolamento são PRIVADAS. Você precisa exportá-las PRIMEIRO.**

```typescript
// src/megabrain.ts (adicionar 'export' antes de linha 20 e 30)
export function vaultRoot(config: KxConfig): string
// Validações:
//   1. config.projectRoot !== homedir()
//   2. existsSync(resolve(config.projectRoot, '.kx.json'))
// Retorna: resolve(config.projectRoot, '.vault')
// Lança: Error se falhar validação
// Uso: obter caminho seguro ao .vault

export function assertInside(base: string, p: string): string
// Validações: 'p' está dentro de 'base' (mesmo volume, sem escape)
// IMPORTANTE: usa resolve(), NÃO realpathSync(). Para bloquear symlinks:
//   const real = realpathSync(p, { throwIfNoEntry: false });
//   if (!real.startsWith(realpathSync(base))) throw ...;
// Retorna: resolve(p) se OK
// Lança: Error se path traversal detectado
// Uso: antes de ler arquivo, validar caminho seguro

export function getActivity(config: KxConfig, slug: string): string
// Parâmetro: config (KxConfig), slug (string, de filename sem .md)
// Retorna: conteúdo .md integral (frontmatter YAML + seções markdown)
// Lança: Error se slug não encontrado
// Uso: em GET /projects/:project/activities/:slug, chamar getActivity()

export function statusReport(config: KxConfig, limit = 20): string
// Parâmetro: config, limite (padrão 20)
// Retorna: string formatada com painel de atividades
// Uso: **internamente em activity-service.ts para CONTAR** — parse string para counts
```

**Pré-requisito:** Adicionar `export` antes de `function vaultRoot` e `function assertInside` em megabrain.ts.

### 2. config.ts — Configuração

**Arquivo**: `src/config.ts` (linhas 62–110)

```typescript
import { loadConfig, resolveConfigPath } from './config.js';
import type { KxConfig } from './config.js';

export function loadConfig(basePath?: string): KxConfig
// Parâmetro: basePath (opcional, padrão process.cwd())
// Retorna: config com project, index, projectRoot, sources, etc.
// Comportamento:
//   - Lookup hierárquico: KX_PROJECT_ROOT env → cwd + pais → ~/.kx.json
//   - Lança process.exit(1) se não encontrar .kx.json
// Uso: no project-resolver ao carregar config de um projeto
```

---

## O Que NÃO Fazer

### 1. Não Reimplementar Funções
```typescript
// ERRADO: criar seu próprio parser YAML
function parseActivity(md: string) { /* ... */ }

// CERTO: reusar getActivity() de megabrain.ts
const md = getActivity(config, slug);
```

### 2. Não Implementar POST/PUT (Fase 5)
```typescript
// Fase 0 não tem:
// POST /projects/:project/activities
// PUT /projects/:project/activities/:slug
```

### 3. Não Usar resolve() para Segurança
```typescript
// Inseguro contra symlinks:
const safe = resolve(vaultRoot, userInput);

// Seguro com realpathSync:
const real = realpathSync(userInput, { throwIfNoEntry: false });
const vaultReal = realpathSync(vaultRoot);
if (!real.startsWith(vaultReal)) throw new ForbiddenError();
return real;
```

### 4. Não Usar Express (Fase 0 usa Hono)
```typescript
// Evitar Express em Fase 0
import express from 'express';

// Usar Hono
import { Hono } from 'hono';
const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));
```

### 5. Não Trazer Sessions Claude Code
```typescript
// Fase 0 não sabe sobre:
// GET /projects/:project/sessions (Fase 2)
// Correlação GitLab/Azure (Fase 4)
```

### 6. Não Meter Credenciais no Git
```typescript
// Nunca hardcode um segredo no código.

// Variável de ambiente
const token = process.env.COCKPIT_TOKEN;
```

---

## Convenções de Código

### TypeScript
- Tipos explícitos em parâmetros e retorno
- Interfaces em `src/daemon/types/daemon.ts`
- Sem `any`; prefira `unknown` se realmente necessário
- Exports nomeados (`export function`), não default exports (exceto index.ts)

### Nomes
```typescript
// Variáveis e funções: camelCase
const projectRoot = ...;
function resolveProject() { ... }

// Tipos e Interfaces: PascalCase
interface Project { ... }
type UpdateKind = 'avanco' | 'bloqueio' | 'conclusao';

// Constantes: UPPER_SNAKE_CASE
const DEFAULT_PORT = 7717;
const VAULT_DIR_NAME = '.vault';
```

### Campos Activity (CRÍTICO: snake_case)
```typescript
interface Activity {
  id: number;
  slug: string;
  titulo: string;
  squad?: string;
  modulo?: string;
  status: 'em-andamento' | 'pendente' | 'bloqueado' | 'concluida';
  data_inicio?: string;      // ← snake_case (2026-07-23)
  data_entrega?: string;     // ← snake_case (2026-07-30)
  updated?: string;
  branches?: string;         // "repo1:branch1, repo2:branch2"
  last_log?: string;         // ← última linha do "Log de Progresso"
  type?: string;
  tags?: string[];
}
```

HTTP retorna **snake_case também** — não converter para camelCase.

### Estrutura de Erro
```typescript
interface APIError {
  error: {
    code: string;        // 'PROJECT_NOT_FOUND', 'FORBIDDEN', etc.
    message: string;     // mensagem curta em PT-BR
    hint?: string;       // dica opcional
  };
}
```

### Custom Error Classes
```typescript
// src/daemon/errors.ts
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
    super(`Projeto '${projectId}' sem .vault/`);
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
```

### Logging
```typescript
// Simples console (redirecionado para ~/.kx/logs/kxd.log em launchd)
console.log(`[kxd] Carregando projeto ${projectId}`);
console.error(`[kxd] Erro ao ler vault: ${error.message}`);

// No daemon startup, criar directory de logs
import { mkdirSync } from 'fs';
const logDir = resolve(homedir(), '.kx', 'logs');
mkdirSync(logDir, { recursive: true });
```

### Commits em Português
```bash
git commit -m "feat(daemon): implementar GET /health com uptime"
git commit -m "refactor(activity-service): parsear YAML com filtro status"
git commit -m "fix(isolate): usar realpathSync para bloquear symlinks"

# Formato: tipo(escopo): descrição
# Tipos: feat, fix, refactor, docs, test, chore, perf
# Sem emoji, sem "WIP", sem co-authored-by
```

---

## Quando Commitar

**Regra:** Após CADA task, se `npm run build` passa:

```bash
# Task 1 completa
npm run build
git add src/daemon/
git commit -m "feat(daemon): criar estrutura de diretórios"

# Task 2 completa
npm run build
git add src/daemon/types/
git commit -m "feat(daemon): definir tipos TypeScript Activity, Project"

# ... e assim por diante
```

**Não commitar:**
- Código que não compila
- Imports não usados
- Console.log de debug

---

## Framework: Hono 4.12.9

**Por que Hono (não Express)?**
- TS-first, tipos perfeitos
- Já instalado (4.12.9)
- Leve (middleware, routing)
- Suporta async/await nativamente

**Estrutura básica:**
```typescript
import { Hono } from 'hono';

const app = new Hono();

// Middleware
app.use(isolateMiddleware);
app.use(errorHandler);

// Rotas
app.get('/health', (c) => {
  return c.json({ status: 'ok', version: '0.1.0', uptimeSec: ... });
});

// Startup
app.listen({ host: '127.0.0.1', port: 7717 }, () => {
  console.log('kxd listening on http://127.0.0.1:7717');
});
```

---

## Ordem Recomendada de Implementação

1. **Pre-Task**: Exportar `vaultRoot()` e `assertInside()` de megabrain.ts
2. **Pre-Task**: `npm install yaml`
3. **Task 0**: Preparação (branch + hash check)
4. **Task 1**: Estrutura diretórios + arquivo errors.ts
5. **Task 2**: Tipos (snake_case obrigatório)
6. **Task 3**: Registry (carrega projects.json, bootstrap directory)
7. **Task 4**: Project Resolver (resolve id → path + vaultRoot + realpathSync)
8. **Task 5**: Activity Service (lê .md, parseia YAML, countActivitiesByStatus)
9. **Task 6**: Middleware (isolate valida vaultRoot, error-handler padroniza)
10. **Task 7**: Server HTTP Hono (4 rotas GET)
11. **Task 8**: Plugar daemon em index.ts
12. **Task 9**: Testes curl (10 testes, idempotentes com backup/restore)
13. **Task 10**: Logs + Definition of Done

**Duração:** ~4h45min

---

## Pré-Implementação (15 minutos)

Antes de começar Task 1, execute:

```bash
cd /path/to/kx

# 1. Verificar hash de main
git log --oneline main -1
# Esperado: 3a532f9

# 2. Criar branch isolada
git checkout -b feat/daemon-phase0 main
git branch  # confirmar * feat/daemon-phase0

# 3. Instalar YAML
npm install yaml

# 4. Exportar funções de megabrain.ts
# Editar src/megabrain.ts, linhas 20 e 30:
#   export function vaultRoot(...)
#   export function assertInside(...)

# 5. Criar arquivo errors.ts
cat > src/daemon/errors.ts <<'EOF'
// src/daemon/errors.ts
// Exceções customizadas para daemon

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

# 6. Verificar build
npm run build
# Esperado: zero erros (pode ter warnings de tipo)
```

Se tudo passa, você está pronto para Task 0.

---

## Definition of Done Checklist

Marcar conforme progride:

```markdown
## Build e Type Safety
- [ ] npm run build passa (zero erros TypeScript)
- [ ] npm run dev -- kx daemon --help não falha

## Código
- [ ] src/daemon/server.ts: sobe HTTP 127.0.0.1:7717 com Hono
- [ ] src/daemon/registry.ts: carrega ~/.kx/cockpit/projects.json
- [ ] src/daemon/project-resolver.ts: resolve id → path + vaultRoot + realpathSync
- [ ] src/daemon/activity-service.ts: lê .md, parseia YAML, filtra/ordena
- [ ] src/daemon/middleware/isolate.ts: valida :project + chama vaultRoot()
- [ ] src/daemon/middleware/error-handler.ts: standardiza respostas de erro
- [ ] src/daemon/errors.ts: todas exceções customizadas definidas
- [ ] src/daemon/types/daemon.ts: tipos completos (snake_case obrigatório)
- [ ] src/index.ts: despacho `kx daemon` plugado

## Testes Locais (Curl)
- [ ] curl /health → 200 + {status, version, uptimeSec, watchers}
- [ ] curl /projects → 200 + array com projetos + counts
- [ ] curl /projects/:project/activities → 200 + array
- [ ] curl /projects/:project/activities?status=... → filtrado
- [ ] curl /projects/:project/activities?sort=... → ordenado
- [ ] curl /projects/:project/activities?q=... → buscado
- [ ] curl /projects/:project/activities/:slug → 200 + markdown
- [ ] curl /projects/nao-existe/activities → 404 PROJECT_NOT_FOUND
- [ ] curl /projects/:project/activities/../../etc/passwd → 403 FORBIDDEN
- [ ] curl /projects/:project/activities (sem .vault) → 409 PROJECT_MISCONFIGURED

## Isolamento
- [ ] Dois projetos no registry: dados nunca cruzam
- [ ] Path traversal testado: realpathSync() bloqueia
- [ ] Projeto misconfigured: 409 imediato, não 500

## Documentação e Git
- [ ] Commits todos em PT-BR, sem emoji
- [ ] Cada commit compilável (npm run build passa)
- [ ] Nenhum segredo em Git
- [ ] WIP original não destruído (main -1 = 3a532f9)

## Logs
- [ ] ~/.kx/logs/kxd.log criado ao rodar daemon
- [ ] Logs com startup, errors, uptime
- [ ] Formato: [TIMESTAMP] [LEVEL] mensagem

## Pronto para Revisão
- [ ] npm run build: 0 erros
- [ ] 10 testes curl: 100% passando
- [ ] WIP original seguro
- [ ] Reportar ao user: "Fase 0 pronta, aguardando revisão antes de MR"
```

---

## Referências Rápidas

| Recurso | Localização |
|---------|-------------|
| Especificação de API | `./04-daemon-http-api.md` |
| Modelo de Dados | `./03-modelo-dados.md` |
| Roadmap Fases | `./10-roadmap-fases.md` |
| Tasks Granulares | `./PHASE-0-TASKS.md` |
| Código megabrain.ts | `../../src/megabrain.ts` |
| Código config.ts | `../../src/config.ts` |
| Kickstart | `./KICKSTART-PROMPT.md` |
| Hono Docs | https://hono.dev |
| Node FS API | https://nodejs.org/api/fs.html |

---

**Última Atualização**: 2026-07-23
**Framework**: Hono 4.12.9
**Node**: v20.x
**Port**: 127.0.0.1:7717
