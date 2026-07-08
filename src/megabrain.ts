// KX activity manager — gestao de atividades do projeto dentro do .vault/ (mesmo formato do skill /organization-megabrain).
// ISOLAMENTO (regra de ouro): tudo derivado de config.projectRoot; recusa o global (~) e projetos
// sem .vault/; nenhuma operacao aceita path arbitrario nem escapa do .vault/ do projeto atual.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve, sep } from 'path';
import { homedir } from 'os';
import type { KxConfig } from './config.js';

export type UpdateKind = 'avanco' | 'bloqueio' | 'conclusao';
export interface AddArgs {
  titulo: string; squad?: string; modulo?: string; descricao?: string;
  branches?: string; data_inicio?: string; data_entrega?: string; sessao?: string;
  doc?: string; status?: 'em-andamento' | 'pendente';
}
export interface UpdateArgs { slug: string; tipo: UpdateKind; texto?: string; sessao?: string; }

const SQUADS = ['portal-backoffice', 'infraestrutura', 'integracoes', 'pdv-core', 'transversal'];

// ---- isolamento ----
function vaultRoot(config: KxConfig): string {
  const root = resolve(config.projectRoot);
  if (root === resolve(homedir())) {
    throw new Error('KX activity manager indisponivel: config global (~). Rode dentro de um projeto com .kx.json.');
  }
  // Isolamento: so opera em projeto kx real (tem .kx.json no projectRoot). O .vault/ pode
  // ainda nao existir — e criado sob demanda no add (bootstrap automatico por projeto).
  if (!existsSync(resolve(root, '.kx.json'))) {
    throw new Error(`KX activity manager indisponivel: ${root} nao e um projeto kx (.kx.json ausente).`);
  }
  return resolve(root, '.vault');
}
function ensureVaultDir(config: KxConfig, sub: string): string {
  const d = assertInside(vaultRoot(config), resolve(vaultRoot(config), sub));
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
function assertInside(base: string, p: string): string {
  const b = resolve(base); const r = resolve(p);
  if (r !== b && !r.startsWith(b + sep)) throw new Error(`path fora do vault (isolamento): ${p}`);
  return r;
}
function mbDir(config: KxConfig): string {
  // NAO cria (leitura). Para escrita, usar ensureVaultDir(config, 'megabrain').
  return assertInside(vaultRoot(config), resolve(vaultRoot(config), 'megabrain'));
}
function mocFile(config: KxConfig): string {
  return assertInside(vaultRoot(config), resolve(vaultRoot(config), '_index', 'MOC-Atividades.md'));
}
// Bootstrap: cria o MOC-Atividades.md com as secoes canonicas se ainda nao existir.
function ensureMoc(config: KxConfig): string {
  const f = mocFile(config);
  if (!existsSync(f)) {
    ensureVaultDir(config, '_index');
    writeFileSync(f, `---\ntype: moc\ntopic: atividades\nupdated: ${todayISO()}\n---\n\n` +
      `# Atividades - Map of Content (KX activity manager)\n\n` +
      `> Fonte de verdade sobre o que esta em andamento, pendente e concluido.\n\n` +
      `## Em Andamento\n\n## Pendente / Não Iniciado\n\n## Concluídas Recentemente\n\n## Por Squad\n\n`, 'utf-8');
  }
  return f;
}

// ---- helpers ----
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function normSquad(s?: string): string {
  const v = slugify(s || 'transversal');
  return SQUADS.includes(v) ? v : 'transversal';
}
interface Parsed { fm: Record<string, string>; body: string; }
function parse(md: string): Parsed {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s?(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return { fm, body: m[2] };
}
function statusLabel(st: string): string {
  return st === 'concluida' ? 'CONCLUIDA' : st === 'bloqueado' ? 'BLOQUEADO' : 'em andamento';
}

// ---- ADD ----
export function addActivity(config: KxConfig, a: AddArgs): { path: string; slug: string } {
  if (!a.titulo || !a.titulo.trim()) throw new Error('titulo obrigatorio');
  const dir = ensureVaultDir(config, 'megabrain');
  const slug = slugify(a.titulo);
  const file = assertInside(vaultRoot(config), resolve(dir, `${slug}.md`));
  if (existsSync(file)) throw new Error(`atividade ja existe: ${slug} (use megabrain_update).`);
  const squad = normSquad(a.squad);
  const di = a.data_inicio || todayISO();
  const st = a.status === 'pendente' ? 'pendente' : 'em-andamento';
  const sess = a.sessao ? `["${a.sessao}"]` : '[]';
  const sessRow = a.sessao ? `| ${a.sessao} | ${todayISO()} | Criacao da atividade |` : '| | | |';
  const md = `---
type: atividade
titulo: ${a.titulo}
squad: ${squad}
modulo: ${a.modulo || ''}
status: ${st}
data_inicio: ${di}
data_entrega: ${a.data_entrega || ''}
tags: [atividade]
updated: ${todayISO()}
sessoes_claude: ${sess}
---

# Atividade: ${a.titulo}

## Descricao

${a.descricao || '(a preencher)'}

## Squad e Modulo

- Squad: [[team/squads/${squad}]]
- Modulo/Servico: ${a.modulo || ''}

## Arquitetura e Documentacao

- Doc da feature: ${a.doc || ''}
- ADR relacionado:
- Diagrama:

## Branches

| Repositorio | Branch |
|---|---|
${(a.branches || '').split(',').map(b => b.trim()).filter(Boolean).map(b => { const [r, br] = b.split(':').map(x => x.trim()); return `| ${r || b} | ${br || ''} |`; }).join('\n') || '| | |'}

## Sessoes Claude Code

| ID da Sessao | Data | Resumo |
|---|---|---|
${sessRow}

## Log de Progresso

### ${di}

- Atividade criada.

## Erros e Bloqueios

-

## Status

- [${st === 'em-andamento' ? 'x' : ' '}] Em andamento
- [ ] Bloqueado
- [${st === 'pendente' ? 'x' : ' '}] Pendente / nao iniciado
- [ ] Concluido

## Links Relacionados

- [[MOC-Atividades]]
`;
  writeFileSync(file, md, 'utf-8');
  mocSync(config, slug, a.titulo, squad, st === 'pendente' ? 'pendente' : 'andamento');
  return { path: file, slug };
}

// ---- UPDATE ----
export function updateActivity(config: KxConfig, u: UpdateArgs): { path: string; status: string } {
  const file = assertInside(vaultRoot(config), resolve(mbDir(config), `${slugify(u.slug)}.md`));
  if (!existsSync(file)) throw new Error(`atividade nao encontrada: ${u.slug}`);
  let md = readFileSync(file, 'utf-8');
  const { fm } = parse(md);
  const today = todayISO();

  // registrar sessao se veio
  if (u.sessao && !((fm.sessoes_claude || '[]').includes(u.sessao))) {
    const cur = (fm.sessoes_claude || '[]').replace(/^\[|\]$/g, '').trim();
    const next = cur ? `[${cur}, "${u.sessao}"]` : `["${u.sessao}"]`;
    md = md.replace(/^sessoes_claude:.*$/m, `sessoes_claude: ${next}`);
    md = md.replace(/(## Sessoes Claude Code\n\n\| ID da Sessao \| Data \| Resumo \|\n\|---\|---\|---\|\n)/,
      `$1| ${u.sessao} | ${today} | ${u.tipo}: ${(u.texto || '').slice(0, 60)} |\n`);
  }

  if (u.tipo === 'avanco') {
    const bullet = `- ${u.texto || '(avanco sem descricao)'}`;
    if (md.includes(`### ${today}`)) {
      md = md.replace(new RegExp(`(### ${today}\\n)`), `$1${bullet}\n`);
    } else {
      md = md.replace(/(## Log de Progresso\n)/, `$1\n### ${today}\n\n${bullet}\n`);
    }
  } else if (u.tipo === 'bloqueio') {
    md = md.replace(/(## Erros e Bloqueios\n\n)/, `$1- [${today}] ${u.texto || '(bloqueio sem descricao)'}\n`);
    md = md.replace(/^status:.*$/m, 'status: bloqueado');
    md = setStatusBox(md, 'Bloqueado');
  } else if (u.tipo === 'conclusao') {
    md = md.replace(/^status:.*$/m, 'status: concluida');
    md = setStatusBox(md, 'Concluido');
    const bullet = `- ${u.texto || 'Atividade concluida.'}`;
    if (md.includes(`### ${today}`)) md = md.replace(new RegExp(`(### ${today}\\n)`), `$1${bullet}\n`);
    else md = md.replace(/(## Log de Progresso\n)/, `$1\n### ${today}\n\n${bullet}\n`);
  }
  md = md.replace(/^updated:.*$/m, `updated: ${today}`);
  writeFileSync(file, md, 'utf-8');

  const p2 = parse(md);
  if (u.tipo === 'conclusao') mocSync(config, slugify(u.slug), p2.fm.titulo || u.slug, normSquad(p2.fm.squad), 'concluida');
  return { path: file, status: p2.fm.status || 'em-andamento' };
}
function setStatusBox(md: string, on: 'Em andamento' | 'Bloqueado' | 'Concluido' | 'Pendente / nao iniciado'): string {
  return md.replace(/## Status\n\n([\s\S]*?)(\n## )/, (_m, block, tail) => {
    const lines = block.trimEnd().split('\n').map((l: string) => {
      const label = l.replace(/^- \[[ x]\] /, '');
      return `- [${label.startsWith(on) ? 'x' : ' '}] ${label}`;
    });
    return `## Status\n\n${lines.join('\n')}${tail}`;
  });
}

// ---- MOC sync (cirurgico) ----
function mocSync(config: KxConfig, slug: string, titulo: string, squad: string, alvo: 'andamento' | 'pendente' | 'concluida'): void {
  const f = ensureMoc(config); // cria o MOC scaffold se nao existir (bootstrap por projeto)
  let moc = readFileSync(f, 'utf-8');
  const line = `- [[${slug}]] — ${titulo} (squad ${squad}${alvo === 'concluida' ? ', ' + todayISO() : ''})`;
  // remove linha antiga do slug em qualquer secao gerenciada
  moc = moc.split('\n').filter(l => !new RegExp(`^- \\[\\[${slug}\\]\\]`).test(l.trim())).join('\n');
  const section = alvo === 'concluida' ? '## Concluídas Recentemente'
    : alvo === 'pendente' ? '## Pendente / Não Iniciado' : '## Em Andamento';
  moc = insertAfterHeader(moc, section, line);
  // Por Squad (mantem em todas as fases)
  const sqLine = new RegExp(`^(- \\[\\[team/squads/${squad}\\]\\]:.*)$`, 'm');
  if (sqLine.test(moc)) {
    if (!new RegExp(`\\[\\[${slug}\\]\\]`).test(moc.match(sqLine)![1])) {
      moc = moc.replace(sqLine, `$1, [[${slug}]]`);
    }
  }
  moc = moc.replace(/^updated:.*$/m, `updated: ${todayISO()}`);
  writeFileSync(f, moc, 'utf-8');
}
function insertAfterHeader(moc: string, header: string, line: string): string {
  const idx = moc.indexOf(header);
  if (idx < 0) return moc; // secao nao existe; nao inventa
  const nl = moc.indexOf('\n', idx);
  const before = moc.slice(0, nl + 1);           // "...header\n"
  const after = moc.slice(nl + 1).replace(/^\n+/, ''); // remove linhas em branco iniciais
  return `${before}\n${line}\n${after}`;
}

// ---- STATUS / LIST ----
interface ActRow { slug: string; titulo: string; status: string; squad: string; updated: string; last: string; }
function readAll(config: KxConfig): ActRow[] {
  const dir = mbDir(config);
  const rows: ActRow[] = [];
  if (!existsSync(dir)) return rows; // projeto sem atividades ainda (bootstrap so no add)
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const md = readFileSync(resolve(dir, f), 'utf-8');
    const { fm, body } = parse(md);
    // ultima entrada do log (onde paramos) — SO a secao Log de Progresso, ate o proximo ##
    const logMatch = body.match(/## Log de Progresso\n([\s\S]*?)(?:\n## |$)/);
    const logSection = logMatch ? logMatch[1] : '';
    const bullets = [...logSection.matchAll(/^- (.+)$/gm)].map(m => m[1]).filter(b => !/^\[\[/.test(b));
    const last = bullets.length ? bullets[bullets.length - 1] : '';
    rows.push({
      slug: f.replace(/\.md$/, ''), titulo: fm.titulo || f, status: fm.status || 'em-andamento',
      squad: fm.squad || '', updated: fm.updated || fm.data_inicio || '', last,
    });
  }
  return rows.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}
export function statusReport(config: KxConfig, limit = 20): string {
  const rows = readAll(config).slice(0, limit);
  if (!rows.length) return `KX activity manager (${config.project}): nenhuma atividade catalogada em .vault/megabrain/.`;
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const bar = '='.repeat(76);
  const head = `KX activity manager — ${config.project}  (ultimas ${rows.length} atividades)\n` +
    `andamento: ${counts['em-andamento'] || 0}  |  bloqueado: ${counts['bloqueado'] || 0}  |  ` +
    `pendente: ${counts['pendente'] || 0}  |  concluida: ${counts['concluida'] || 0}`;
  const body = rows.map((r, i) => {
    const icon = r.status === 'concluida' ? '[x]' : r.status === 'bloqueado' ? '[!]' : r.status === 'pendente' ? '[ ]' : '[~]';
    const n = String(i + 1).padStart(2, '0');
    const where = r.last ? `\n     onde paramos: ${r.last.slice(0, 150)}` : '';
    return `${n}. ${icon} ${r.titulo}\n     ${statusLabel(r.status)} · squad ${r.squad} · updated ${r.updated} · [[${r.slug}]]${where}`;
  }).join('\n\n');
  return `${bar}\n${head}\n${bar}\n\n${body}\n\n${bar}`;
}
export function getActivity(config: KxConfig, slug: string): string {
  const file = assertInside(vaultRoot(config), resolve(mbDir(config), `${slugify(slug)}.md`));
  if (!existsSync(file)) throw new Error(`atividade nao encontrada: ${slug}`);
  return readFileSync(file, 'utf-8');
}
