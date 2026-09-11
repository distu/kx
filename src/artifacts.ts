// KX artifact registry — indice dos artefatos web publicados pelos agentes (Claude Code, Codex)
// dentro de um projeto, vinculados a atividade do KX activity manager em que o trabalho aconteceu.
//
// ISOLAMENTO (mesma regra de ouro do activity manager): tudo derivado de config.projectRoot;
// recusa o global (~) e projetos sem .kx.json; nenhuma operacao aceita path arbitrario.
//
// Fonte de verdade: .vault/artefatos/artefatos.json (estruturado, append/merge por URL).
// Derivado: .vault/ARTEFATOS.md (legivel por humano e indexado pela busca do kx).
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'fs';
import { resolve, relative, isAbsolute, dirname, basename } from 'path';
import type { KxConfig } from './config.js';
import {
  vaultRoot, ensureVaultDir, assertInside, todayISO, slugify,
  detectClaudeSession, parseNote, mbDir,
} from './megabrain.js';

const SCHEMA_VERSION = 1;

export interface ArtifactVersion {
  versao: number;
  data: string;
  label?: string;
  sessao?: string;
}

export interface ArtifactRecord {
  url: string;
  titulo: string;
  descricao: string;
  /** Caminho do arquivo fonte, relativo a raiz do projeto quando estiver dentro dele. */
  arquivo?: string;
  /** Slug da atividade do activity manager. Vazio = ainda nao vinculado. */
  atividade?: string;
  agente: string;
  sessao?: string;
  criado: string;
  atualizado: string;
  versao: number;
  historico: ArtifactVersion[];
}

interface Store {
  versao_schema: number;
  projeto: string;
  artefatos: ArtifactRecord[];
}

export interface RegisterArgs {
  url: string;
  titulo?: string;
  descricao?: string;
  arquivo?: string;
  /** Slug ou ID numerico da atividade. Omitido: resolve pela sessao ativa. */
  atividade?: string;
  agente?: string;
  label?: string;
  sessao?: string;
}

// ---- paths ----
function artifactsDir(config: KxConfig): string {
  return ensureVaultDir(config, 'artefatos');
}
function storeFile(config: KxConfig): string {
  return assertInside(vaultRoot(config), resolve(artifactsDir(config), 'artefatos.json'));
}
function indexFile(config: KxConfig): string {
  return assertInside(vaultRoot(config), resolve(vaultRoot(config), 'ARTEFATOS.md'));
}
function readmeFile(config: KxConfig): string {
  return assertInside(vaultRoot(config), resolve(artifactsDir(config), 'README.md'));
}

// ---- store ----
function readStore(config: KxConfig): Store {
  const f = storeFile(config);
  if (!existsSync(f)) return { versao_schema: SCHEMA_VERSION, projeto: config.project, artefatos: [] };
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as Partial<Store>;
    return {
      versao_schema: raw.versao_schema || SCHEMA_VERSION,
      projeto: raw.projeto || config.project,
      artefatos: Array.isArray(raw.artefatos) ? raw.artefatos : [],
    };
  } catch (e) {
    // Arquivo corrompido nunca pode apagar o historico em silencio: falha alto.
    throw new Error(`.vault/artefatos/artefatos.json ilegivel (${(e as Error).message}). Corrija ou remova o arquivo.`);
  }
}
function writeStore(config: KxConfig, store: Store): void {
  writeFileSync(storeFile(config), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

// ---- normalizacao ----
// URL entra no markdown: rejeita o que nao for http(s) e o que carregar quebra de linha
// ou parenteses, que romperiam o link e poderiam injetar conteudo na linha seguinte.
function normalizeUrl(url: string): string {
  const u = (url || '').trim();
  if (!/^https?:\/\/[^\s<>()]+$/i.test(u)) {
    throw new Error(`url invalida: ${JSON.stringify(url)} (esperado http(s) sem espacos ou parenteses)`);
  }
  return u;
}
// Campo de texto livre que vai para tabela/lista markdown: uma linha so, sem pipe solto.
function oneLine(s: string | undefined, max = 400): string {
  return (s || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, max);
}
// O caminho chega absoluto do hook e pode vir por symlink (no macOS, /var -> /private/var),
// enquanto projectRoot ja esta canonicalizado: sem resolver os dois pelo realpath, todo arquivo
// do projeto pareceria estar fora dele.
function relToProject(config: KxConfig, p?: string): string | undefined {
  if (!p) return undefined;
  const abs = isAbsolute(p) ? p : resolve(config.projectRoot, p);
  // O arquivo pode nem existir mais (scratchpad limpo, arquivo movido): canonicaliza o
  // ancestral mais proximo que existe e recompoe o resto do caminho.
  const real = (x: string): string => {
    try { return realpathSync(x); } catch { /* segue subindo */ }
    const parent = dirname(x);
    return parent === x ? x : resolve(real(parent), basename(x));
  };
  const rel = relative(config.projectRoot, abs);
  if (!rel.startsWith('..')) return rel;
  const relReal = relative(real(config.projectRoot), real(abs));
  return relReal.startsWith('..') ? abs : relReal; // fora do projeto (ex: scratchpad): absoluto
}

// ---- vinculo com a atividade ----
interface ActivityInfo { slug: string; id: number; titulo: string; status: string; }

function readActivities(config: KxConfig): ActivityInfo[] {
  const dir = mbDir(config);
  const out: ActivityInfo[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const { fm } = parseNote(readFileSync(resolve(dir, f), 'utf-8'));
    out.push({
      slug: f.replace(/\.md$/, ''),
      id: parseInt(fm.id || '', 10) || 0,
      titulo: fm.titulo || f.replace(/\.md$/, ''),
      status: fm.status || 'em-andamento',
    });
  }
  return out;
}

// Resolve a atividade a que o artefato pertence. Explicito vence; depois, a atividade que
// registrou a sessao Claude Code corrente (vinculo exato, nao heuristica). Sem match,
// devolve undefined — o artefato fica em "sem atividade vinculada" ate alguem ligar.
function resolveActivity(config: KxConfig, a: RegisterArgs): string | undefined {
  const acts = readActivities(config);
  const ref = (a.atividade || '').trim();
  if (ref) {
    if (/^#?\d+$/.test(ref)) {
      const byId = acts.find(x => String(x.id) === ref.replace('#', ''));
      if (!byId) throw new Error(`atividade nao encontrada: ID ${ref}`);
      return byId.slug;
    }
    const slug = slugify(ref);
    if (!acts.some(x => x.slug === slug)) throw new Error(`atividade nao encontrada: ${ref}`);
    return slug;
  }
  const sessao = a.sessao || detectClaudeSession(config);
  if (!sessao) return undefined;
  const dir = mbDir(config);
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const { fm } = parseNote(readFileSync(resolve(dir, f), 'utf-8'));
    if ((fm.sessoes_claude || '').includes(sessao)) return f.replace(/\.md$/, '');
  }
  return undefined;
}

// Espelha o artefato dentro do .md da atividade, para quem abre a atividade ver o link
// sem passar pelo indice. Idempotente: uma linha por URL, atualizada no lugar.
function syncActivityNote(config: KxConfig, slug: string, rec: ArtifactRecord): void {
  const file = assertInside(vaultRoot(config), resolve(mbDir(config), `${slug}.md`));
  if (!existsSync(file)) return;
  let md = readFileSync(file, 'utf-8');
  const line = `- [${oneLine(rec.titulo, 120)}](${rec.url}) — v${rec.versao} (${rec.atualizado})`;
  if (!md.includes('## Artefatos Publicados')) {
    const section = `## Artefatos Publicados\n\n${line}\n\n`;
    md = md.includes('## Links Relacionados')
      ? md.replace('## Links Relacionados', `${section}## Links Relacionados`)
      : `${md.trimEnd()}\n\n${section}`;
  } else {
    const esc = rec.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = new RegExp(`^- \\[.*\\]\\(${esc}\\).*$`, 'm');
    md = existing.test(md)
      ? md.replace(existing, line)
      : md.replace('## Artefatos Publicados\n\n', `## Artefatos Publicados\n\n${line}\n`);
  }
  md = md.replace(/^updated:.*$/m, `updated: ${todayISO()}`);
  writeFileSync(file, md, 'utf-8');
}

// ---- REGISTER ----
export interface RegisterResult {
  record: ArtifactRecord;
  novo: boolean;
  indexPath: string;
  atividadeTitulo?: string;
}

export function registerArtifact(config: KxConfig, a: RegisterArgs): RegisterResult {
  const url = normalizeUrl(a.url);
  const store = readStore(config);
  const hoje = todayISO();
  const sessao = a.sessao || detectClaudeSession(config);
  const atividade = resolveActivity(config, a);
  const agente = oneLine(a.agente || 'claude-code', 40);

  let rec = store.artefatos.find(x => x.url === url);
  const novo = !rec;
  if (!rec) {
    rec = {
      url,
      titulo: oneLine(a.titulo, 160) || 'Artefato sem titulo',
      descricao: oneLine(a.descricao),
      arquivo: relToProject(config, a.arquivo),
      atividade,
      agente,
      sessao,
      criado: hoje,
      atualizado: hoje,
      versao: 1,
      historico: [{ versao: 1, data: hoje, label: oneLine(a.label, 60) || undefined, sessao }],
    };
    store.artefatos.push(rec);
  } else {
    rec.versao += 1;
    rec.atualizado = hoje;
    // Republish so sobrescreve o que veio preenchido — nunca zera titulo/descricao ja bons.
    if (a.titulo) rec.titulo = oneLine(a.titulo, 160);
    if (a.descricao) rec.descricao = oneLine(a.descricao);
    if (a.arquivo) rec.arquivo = relToProject(config, a.arquivo);
    if (atividade) rec.atividade = atividade;
    if (sessao) rec.sessao = sessao;
    rec.agente = agente;
    rec.historico.push({ versao: rec.versao, data: hoje, label: oneLine(a.label, 60) || undefined, sessao });
  }

  writeStore(config, store);
  ensureReadme(config);
  const indexPath = renderIndex(config, store);
  if (rec.atividade) syncActivityNote(config, rec.atividade, rec);

  const acts = readActivities(config);
  return { record: rec, novo, indexPath, atividadeTitulo: acts.find(x => x.slug === rec!.atividade)?.titulo };
}

// ---- LINK (vincular/mover artefato ja registrado para uma atividade) ----
export function linkArtifact(config: KxConfig, url: string, atividade: string): RegisterResult {
  const u = normalizeUrl(url);
  const store = readStore(config);
  const rec = store.artefatos.find(x => x.url === u);
  if (!rec) throw new Error(`artefato nao registrado: ${u}`);
  const slug = resolveActivity(config, { url: u, atividade });
  if (!slug) throw new Error(`atividade nao resolvida: ${atividade}`);
  rec.atividade = slug;
  rec.atualizado = todayISO();
  writeStore(config, store);
  const indexPath = renderIndex(config, store);
  syncActivityNote(config, slug, rec);
  const acts = readActivities(config);
  return { record: rec, novo: false, indexPath, atividadeTitulo: acts.find(x => x.slug === slug)?.titulo };
}

// ---- INDICE MARKDOWN ----
function renderIndex(config: KxConfig, store: Store): string {
  const acts = readActivities(config);
  const byAct = new Map<string, ArtifactRecord[]>();
  const orfaos: ArtifactRecord[] = [];
  const ordenados = [...store.artefatos].sort((a, b) => (b.atualizado || '').localeCompare(a.atualizado || ''));
  for (const r of ordenados) {
    if (r.atividade) {
      if (!byAct.has(r.atividade)) byAct.set(r.atividade, []);
      byAct.get(r.atividade)!.push(r);
    } else {
      orfaos.push(r);
    }
  }

  const bloco = (r: ArtifactRecord): string => {
    const versoes = r.historico
      .map(h => `v${h.versao} (${h.data}${h.label ? `, ${h.label}` : ''})`)
      .join(', ');
    const origem = [
      `agente ${r.agente}`,
      r.arquivo ? `arquivo \`${r.arquivo}\`` : '',
      r.sessao ? `sessão \`${r.sessao}\`` : '',
    ].filter(Boolean).join(' · ');
    return [
      `- **${r.titulo}** — \`v${r.versao}\` · atualizado em ${r.atualizado} · ${r.url}`,
      `  - Do que se trata: ${r.descricao || '(sem descrição)'}`,
      `  - Origem: ${origem}`,
      `  - Versões: ${versoes}`,
    ].join('\n');
  };

  // Atividades com artefato, na ordem do artefato mais recente de cada uma.
  const secoes: string[] = [];
  for (const [slug, arts] of byAct) {
    const info = acts.find(x => x.slug === slug);
    const cab = `### ${info?.id ? `#${info.id} — ` : ''}${info?.titulo || slug} · [[${slug}]]${info?.status ? ` · ${info.status}` : ''}`;
    secoes.push(`${cab}\n\n${arts.map(bloco).join('\n\n')}`);
  }

  const md = `---
type: indice
topic: artefatos-publicados
projeto: ${config.project}
total: ${store.artefatos.length}
updated: ${todayISO()}
tags: [artefatos, claude-code, codex]
---

# Artefatos publicados — ${config.project}

> Índice automático das páginas publicadas (artefatos web) que os agentes geraram neste
> projeto: link, versão em que cada uma está, do que trata e a atividade em que nasceu.
> Serve para responder depois "qual era aquele link que a gente publicou sobre X".
>
> Gerado por \`kx artifact\` — **não editar à mão**, a edição é sobrescrita na próxima
> publicação. Fonte de verdade: \`.vault/artefatos/artefatos.json\`.
> Como funciona, e como registrar um artefato na mão: [[artefatos/README]].

## Por atividade

${secoes.length ? secoes.join('\n\n') : '(nenhum artefato vinculado a atividade ainda)'}

## Sem atividade vinculada

${orfaos.length ? orfaos.map(bloco).join('\n\n') : '(nenhum)'}
`;
  const f = indexFile(config);
  writeFileSync(f, md, 'utf-8');
  return f;
}

// ---- README (bootstrap, escrito uma vez por projeto) ----
function ensureReadme(config: KxConfig): void {
  const f = readmeFile(config);
  if (existsSync(f)) return;
  writeFileSync(f, `---
type: referencia
topic: artefatos-publicados
tags: [artefatos, kx, claude-code, codex]
---

# Registro de artefatos publicados

## O que é

Toda vez que um agente (Claude Code ou Codex) publica um **artefato** — aquela página que
abre no navegador em \`claude.ai/code/artifact/...\` — o link é registrado aqui e vinculado à
**atividade** do KX activity manager em que o trabalho estava acontecendo.

O objetivo é simples: meses depois, perguntar ao agente "qual era o link daquele painel de
release que a gente publicou?" e ter resposta, com a versão certa e o contexto de quando
nasceu — em vez de garimpar no histórico de conversa.

## Onde fica o quê

| Arquivo | Papel |
|---|---|
| \`.vault/ARTEFATOS.md\` | Índice legível, agrupado por atividade. Gerado automaticamente — não editar |
| \`.vault/artefatos/artefatos.json\` | Fonte de verdade estruturada (uma entrada por URL, com histórico de versões) |
| \`.vault/megabrain/<atividade>.md\` | Cada atividade ganha a seção \`## Artefatos Publicados\` com os links dela |

O \`.vault/\` não é versionado no repositório de código, então nenhum link vaza para o Git
do projeto.

## Como é alimentado

**Automático (Claude Code)**: o hook \`PostToolUse\` global \`register-artifact.mjs\` observa
a ferramenta \`Artifact\`. Quando ela publica, o hook extrai a URL, o título e a descrição e
chama \`kx artifact add\`. Nada precisa ser pedido — acontece sozinho, em qualquer projeto
que tenha \`.kx.json\` e \`.vault/\`.

**Manual (Codex, ou qualquer outro agente/pessoa)**:

\`\`\`bash
kx artifact add --url https://claude.ai/code/artifact/<id> \\
  --titulo "Painel de canais de release" \\
  --descricao "Três branches, tags candidatas e rollback por terminal" \\
  --agente codex
\`\`\`

## Como consultar

\`\`\`bash
kx artifact list              # todos, mais recentes primeiro
kx artifact list --atividade <slug-ou-id>
\`\`\`

Pelo MCP, as tools \`megabrain_artifacts\` (listar), \`megabrain_artifact_add\` (registrar) e
\`megabrain_artifact_link\` (vincular a outra atividade). O índice também entra na busca
semântica do kx, então \`search("artefato sobre release do edge")\` encontra.

## Vínculo com a atividade

O vínculo é feito pela **sessão**: cada atividade guarda no frontmatter os IDs de sessão do
Claude Code que trabalharam nela (\`sessoes_claude\`). Quando o artefato é publicado, o
registro procura a atividade que declarou aquela sessão.

Se nenhuma atividade reivindicou a sessão, o artefato cai em **"Sem atividade vinculada"** —
não se perde. Para adotá-lo depois:

\`\`\`bash
kx artifact link --url <url> --atividade <slug-ou-id>
\`\`\`

## Versões

Republicar o mesmo arquivo mantém a mesma URL. Cada republicação incrementa a versão
(\`v1\`, \`v2\`, …) e registra data e rótulo no histórico. A versão é contada pelo registro,
não vem do servidor: ela responde "quantas vezes publicamos isto", que é a pergunta útil.
`, 'utf-8');
}

// ---- LIST ----
export function listArtifacts(config: KxConfig, opts: { atividade?: string; limit?: number } = {}): string {
  const store = readStore(config);
  const acts = readActivities(config);
  let rows = [...store.artefatos].sort((a, b) => (b.atualizado || '').localeCompare(a.atualizado || ''));
  if (opts.atividade) {
    const ref = opts.atividade.trim();
    const slug = /^#?\d+$/.test(ref)
      ? acts.find(x => String(x.id) === ref.replace('#', ''))?.slug
      : slugify(ref);
    rows = rows.filter(r => r.atividade === slug);
  }
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 30;
  const total = rows.length;
  rows = rows.slice(0, limit);
  if (!total) {
    return `KX artifact registry (${config.project}): nenhum artefato registrado${opts.atividade ? ` para "${opts.atividade}"` : ''}.`;
  }
  const bar = '='.repeat(76);
  const body = rows.map(r => {
    const info = acts.find(x => x.slug === r.atividade);
    const vinculo = r.atividade
      ? `atividade ${info?.id ? `#${info.id} ` : ''}${info?.titulo || r.atividade}`
      : 'SEM atividade vinculada';
    return `v${r.versao} · ${r.titulo}\n     ${r.url}\n     ${vinculo} · ${r.agente} · atualizado ${r.atualizado}` +
      (r.descricao ? `\n     ${r.descricao.slice(0, 160)}` : '');
  }).join('\n\n');
  return `${bar}\nKX artifact registry — ${config.project} (${rows.length} de ${total})\n${bar}\n\n${body}\n\n${bar}`;
}

// ---- Leitura estruturada (Cockpit/daemon) ----
export function listArtifactRecords(config: KxConfig): ArtifactRecord[] {
  return [...readStore(config).artefatos]
    .sort((a, b) => (b.atualizado || '').localeCompare(a.atualizado || ''));
}
