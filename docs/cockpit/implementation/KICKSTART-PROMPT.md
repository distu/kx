# KX Cockpit - Fase 0 Kickstart

## Missão

Você está implementando o **daemon HTTP local (kxd)** que é o motor central do KX Cockpit — uma torre de controle de atividades do projeto por aba (isolamento via `.kx.json`).

**Escopo da Fase 0: SOMENTE daemon kxd + endpoints de leitura**

- Modo `kx daemon` (novo) que sobe HTTP em `127.0.0.1:7717`
- Framework: Hono 4.12.9 (já instalado, TS-first, leve)
- Registry de projetos em `~/.kx/cockpit/projects.json`
- GET `/health` (uptime)
- GET `/projects` (lista abas, conta atividades por status)
- GET `/projects/:project/activities` (listagem com filtro/sort, reusar `megabrain.ts`)
- GET `/projects/:project/activities/:slug` (detalhe com markdown integral)
- Isolamento sagrado: nenhum cruzamento de projeto, path traversal bloqueado com `realpathSync()`
- Logging em `~/.kx/logs/kxd.log`

**NÃO implementar em Fase 0:**
- POST/PUT (escrita é Fase 5)
- Sessions ou correlação GitLab/Azure (Fase 2+)

**Fases posteriores (NÃO implementar):**
- Fase 1: App SwiftUI + hotkeys (Cockpit visual)
- Fase 2: Session Service (rastreio de sessões Claude Code)
- Fase 3: Event Bus (SSE, watchers de tempo real)
- Fase 4: Integration Service (correlação GitLab/Azure)
- Fase 5: Write API (POST/PUT de atividades)

**Limite claro:** A nova sessão para ao terminar testes curl da Fase 0 e reporta "Fase 0 pronta, aguardando revisão antes de MR".

---

## Leitura Obrigatória (15 minutos)

Antes de qualquer código, leia NESTA ORDEM:

1. **`/path/to/kx/docs/cockpit/README.md`** — princípios, glossário, "o que é KX activity manager"
2. **`02-arquitetura.md`** — decisões D1 (daemon local), D3 (source of truth = .md), D6 (isolamento), D7 (porta)
3. **`03-modelo-dados.md`** — frontmatter YAML de atividade, campos obrigatórios, slug gerado
4. **`04-daemon-http-api.md`** — endpoints exatos, payloads, contrato HTTP, handling de erro
5. **`10-roadmap-fases.md`** — critério "Pronto quando" da Fase 0
6. **`prototype/index.html`** — maquete visual (referência, não implementar UI agora)
7. **Este arquivo** + IMPLEMENTATION-GUIDE.md + PHASE-0-TASKS.md (guia detalhado)

---

## Guardrails Críticos (NÃO VIOLAR)

### 1. Não Destruir WIP Não Commitado

O repo `kx` tem WIP em `main`. Você DEVE:

```bash
cd /path/to/kx

# VERIFICAR hash de main ANTES de qualquer coisa
git log --oneline main -1
# Esperado: 3a532f9 feat(megabrain): auto-bootstrap...
# Se diferente, PARAR e perguntar user

git status  # confirmar WIP existe

# OPÇÃO A (recomendada): Branch isolada a partir de main
git checkout -b feat/daemon-phase0 main
# Agora main fica intacta com WIP; você trabalha isolado

# OPÇÃO B (se preferir worktree): worktree isolada
git worktree add /tmp/kx-daemon main
cd /tmp/kx-daemon
```

Após terminar, a sessão avisa o user para integrar (rebase/merge) na main só após revisão.

### 2. Exportar Funções de Isolamento (CRÍTICO)

**Pré-requisito verificado em IMPLEMENTATION-GUIDE.md:**

Arquivo `src/megabrain.ts` tem `vaultRoot()` e `assertInside()` como **privadas** (linhas 20-41).
Você PRECISA exportá-las **antes de Task 1**:

```typescript
// src/megabrain.ts (adicionar linha 20)
export function vaultRoot(config: KxConfig): string { ... }
export function assertInside(base: string, p: string): string { ... }
```

**NÃO reimplemente.** Reusar exatas.

### 3. Instalar YAML Parser

```bash
npm install yaml
```

Necessário antes de Task 1. `yaml` package é usado em `activity-service.ts`.

### 4. Reusar megabrain.ts e config.ts (Exatos)

**NÃO reimplemente parsing ou lógica.** Use as funções já existentes:

```typescript
import { getActivity } from './megabrain.js';
import { loadConfig, vaultRoot, assertInside } from './megabrain.js';  // ← AMBAS de megabrain
import type { KxConfig } from './config.js';

// getActivity() retorna markdown integral
// statusReport() retorna string formatada (para contadores, parse a string)
// vaultRoot() valida .vault existe
// assertInside() bloqueia path traversal com realpathSync()
```

### 5. Framework: Hono 4.12.9

Já instalado. Use **Hono** ao invés de Express (melhor TS, leve, alinha com doc).

```bash
npm ls hono  # ← confirmado 4.12.9
```

### 6. Isolamento Sagrado com realpathSync()

Path traversal DEVE ser bloqueado com `realpathSync()` (não apenas `resolve()`):

```typescript
function validateProjectPath(vaultRoot: string, filePath: string): string {
  const real = realpathSync(filePath, { throwIfNoEntry: false });
  const vaultReal = realpathSync(vaultRoot);
  if (!real.startsWith(vaultReal)) {
    throw new ForbiddenError('Path fora do vault');
  }
  return real;
}
```

### 7. Campos Activity: Snake_Case

**CRÍTICO:** Documentação oficial usa snake_case. Seu código DEVE usar também:

```typescript
interface Activity {
  id: number;
  slug: string;
  titulo: string;
  squad?: string;
  modulo?: string;
  status: 'em-andamento' | 'pendente' | 'bloqueado' | 'concluida';
  data_inicio?: string;      // ← snake_case, NÃO dataInicio
  data_entrega?: string;     // ← snake_case, NÃO dataEntrega
  updated?: string;
  branches?: string;         // "repo1:branch1, repo2:branch2"
  updated?: string;
}
```

HTTP retorna snake_case também.

### 8. Bind Apenas 127.0.0.1

```typescript
// src/daemon/server.ts
app.listen({ host: '127.0.0.1', port: 7717 }, () => {
  console.log('kxd listening on http://127.0.0.1:7717');
});
// ← NUNCA 0.0.0.0, NUNCA :: (IPv6 sem loopback)
```

### 9. Nenhum Segredo no Git

Tokens, credenciais, senhas → nunca `.git/`. Se precisar testar autenticação, usar Keychain.

### 10. Commits em Português, Sem Emoji

Formato: `tipo(escopo): descrição`

```bash
git commit -m "feat(daemon): implementar GET /health com uptime"
git commit -m "refactor(activity-service): parsear YAML com filtro status"
```

**Nunca**: "adicionar daemon", "Add daemon (WIP)"

---

## Fluxo de Alto Nível (Sem Microgerenciar)

### Setup Inicial (5 minutos)

```bash
cd /path/to/kx

# Verificar hash
git log --oneline main -1
# Esperado: 3a532f9

# Branch isolada
git checkout -b feat/daemon-phase0 main

# Dependências
npm install yaml
npm ls hono  # verificar
npm ls express  # verificar

# Exportar funções de megabrain.ts
# (Manual ou commit depois de abrir arquivo)
```

### Ordem de Implementação

1. **Task 0**: Preparação (branch + hash check)
2. **Task 1**: Estrutura de diretórios (stubs vazios)
3. **Task 2**: Tipos TypeScript (Activity, Project, etc. com **snake_case**)
4. **Task 3**: Registry (carrega `~/.kx/cockpit/projects.json`)
5. **Task 4**: Project Resolver (resolve id → path + vaultRoot com `realpathSync()`)
6. **Task 5**: Activity Service (lê .md, parseia YAML, filtra)
7. **Task 6**: Middleware (isolate, error-handler, auth stub)
8. **Task 7**: Server HTTP com Hono (4 rotas GET)
9. **Task 8**: Plugar daemon em index.ts
10. **Task 9**: Testes locais com curl (10 testes)
11. **Task 10**: Logs + checklist final

**Duração estimada**: 4h45min

---

## Critérios de Aceite Finais (Definition of Done Fase 0)

Antes de reportar "Pronto", verificar:

- [ ] `git log main -1` retorna `3a532f9` (WIP seguro)
- [ ] Branch isolada: `git branch` mostra `* feat/daemon-phase0`
- [ ] `npm install yaml` executado
- [ ] `vaultRoot()` e `assertInside()` exportadas de `megabrain.ts`
- [ ] `npm run build` passa sem erros TypeScript
- [ ] `npm run dev -- kx daemon` sobe em 127.0.0.1:7717
- [ ] 10 testes curl passam 100% (output copiado)
- [ ] Isolamento testado: projeto não registrado → 404, path traversal → 403
- [ ] Projeto misconfigured (sem .vault/) → 409
- [ ] Logs criados em ~/.kx/logs/kxd.log
- [ ] Commits todos em PT-BR, cada um compilável
- [ ] Nenhum segredo ou token em Git
- [ ] **Campos Activity usam snake_case** (data_inicio, data_entrega, etc.)

---

## Ao Terminar: Teste Real + Relatório

1. Suba daemon e rode 10 testes curl (ver PHASE-0-TASKS.md Task 9)
2. **Copie saída REAL** (não resumo) no relatório
3. Crie relatório estruturado:

```markdown
# Fase 0 - Daemon HTTP Pronto

## Status
Pronto para revisão.

## Testes Executados
[colar saída dos 10 curl]

## Commits Criados
[git log da branch]

## Próximas Fases
Fases 1-5 não implementadas.

## Aguardando
Revisão antes de MR para main.
```

---

## Procedimento Final

Ao terminar, **PARE** e reporte ao usuário:

```
Fase 0 do daemon kxd está completa e testada.

Daemon sobe em http://127.0.0.1:7717.
Endpoints:
- GET /health
- GET /projects
- GET /projects/:project/activities (filtro + sort)
- GET /projects/:project/activities/:slug

Isolamento por projeto validado.
Testes curl 100% passando.

Aguardando revisão antes de abrir MR.
```

**NÃO passe para as fases posteriores** — elas serão outra sessão.

---

## Referências Rápidas

| Recurso | Localização |
|---------|-------------|
| Especificação de API | `./04-daemon-http-api.md` |
| Modelo de Dados | `./03-modelo-dados.md` |
| Roadmap Fases | `./10-roadmap-fases.md` |
| Código megabrain.ts | `../../src/megabrain.ts` linhas 144-353 |
| Código config.ts | `../../src/config.ts` linhas 62-110 |
| Guia Implementação | `./implementation/IMPLEMENTATION-GUIDE.md` |
| Tasks Granulares | `./implementation/PHASE-0-TASKS.md` |
| Node/Build | `../../package.json` |
| TypeScript config | `../../tsconfig.json` |

---

**Mantenedor**: KX Cockpit Equipe
**Última Atualização**: 2026-07-23
**Framework**: Hono 4.12.9
**Porta**: 127.0.0.1:7717
