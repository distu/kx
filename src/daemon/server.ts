// Daemon HTTP local do KX Cockpit (kxd).
// Bind exclusivo em 127.0.0.1. Reusa megabrain.ts/config.ts; nunca chama process.exit por erro de dados.
// Isolamento por projeto: toda rota de dados exige :project, resolvido pelo registry, e a config
// so carrega apos validar o .kx.json do projectRoot.
// Leitura: GET /health, /projects, /projects/:p/activities[/:slug], /projects/:p/sessions.
// Escrita: POST /projects/:p/sessions/:sessionId/promote (cria atividade no KX activity manager).
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { KxConfig } from '../config.js';
import { loadConfig } from '../config.js';
import {
  listActivities, countByStatus, getActivity, listActivitySessions, addActivity,
} from '../megabrain.js';
import { listSessions } from './sessions.js';
import { loadRegistry, findProject, registryFilePath, type ProjectEntry } from './registry.js';

const START = Date.now();
const VERSION = '0.2.0-sessions';
const COCKPIT_TOKEN = process.env.KX_COCKPIT_TOKEN?.trim();

// status externo (EN) -> interno do KX activity manager (PT). Aceita tambem o valor PT direto.
const STATUS_MAP: Record<string, string> = {
  active: 'em-andamento', blocked: 'bloqueado', pending: 'pendente', done: 'concluida',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}
function fail(res: ServerResponse, status: number, code: string, message: string, hint?: string): void {
  json(res, status, { error: { code, message, ...(hint ? { hint } : {}) } });
}
function authorized(req: IncomingMessage): boolean {
  if (!COCKPIT_TOKEN) return true;
  const header = req.headers['x-cockpit-token'];
  return typeof header === 'string' && header === COCKPIT_TOKEN;
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolveBody) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) data = data.slice(0, 1_000_000); });
    req.on('end', () => { try { resolveBody(data ? JSON.parse(data) : {}); } catch { resolveBody({}); } });
    req.on('error', () => resolveBody({}));
  });
}

// Carrega config so se o .kx.json existir (evita o process.exit(1) de loadConfig).
function safeLoad(path: string): KxConfig | null {
  if (!existsSync(resolve(path, '.kx.json'))) return null;
  return loadConfig(path);
}

type Resolved =
  | { ok: true; entry: ProjectEntry; config: KxConfig }
  | { ok: false; status: number; code: string; message: string; hint?: string };

function resolveProject(id: string): Resolved {
  const entry = findProject(id);
  if (!entry) {
    return { ok: false, status: 404, code: 'PROJECT_NOT_FOUND',
      message: `Projeto '${id}' nao registrado`, hint: `Ver ${registryFilePath()}` };
  }
  const config = safeLoad(entry.path);
  if (!config) {
    return { ok: false, status: 409, code: 'PROJECT_MISCONFIGURED', message: 'configuração do projeto ausente' };
  }
  return { ok: true, entry, config };
}

// Vincula cada session id -> atividade do KX activity manager (para destaque no Cockpit).
function sessionLinkMap(config: KxConfig): Map<string, { slug: string; id: number; titulo: string; status: string }> {
  const map = new Map<string, { slug: string; id: number; titulo: string; status: string }>();
  for (const a of listActivitySessions(config)) {
    for (const s of a.sessions) map.set(s, { slug: a.slug, id: a.id, titulo: a.titulo, status: a.status });
  }
  return map;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (parts[0] !== 'health' && !authorized(req)) {
      return fail(res, 401, 'UNAUTHORIZED', 'token do Cockpit ausente ou inválido');
    }

    // ---- POST: promover sessao -> atividade no KX activity manager ----
    // POST /projects/:project/sessions/:sessionId/promote
    if (method === 'POST' && parts[0] === 'projects' && parts.length === 5
        && parts[2] === 'sessions' && parts[4] === 'promote') {
      const pid = decodeURIComponent(parts[1]);
      const sessionId = decodeURIComponent(parts[3]);
      const r = resolveProject(pid);
      if (!r.ok) return fail(res, r.status, r.code, r.message, r.hint);
      const body = await readBody(req);
      // titulo: do corpo, ou o titulo da propria sessao, ou fallback.
      let titulo: string = (body.titulo || '').trim();
      if (!titulo) {
        const s = listSessions(r.entry.path).find((x) => x.sessionId === sessionId);
        titulo = (s?.title || '').trim() || `Sessao ${sessionId.slice(0, 8)}`;
      }
      try {
        const created = addActivity(r.config, {
          titulo, squad: body.squad, modulo: body.modulo, descricao: body.descricao,
          branches: body.branches, doc: body.doc, sessao: sessionId,
          status: body.status === 'pendente' ? 'pendente' : 'em-andamento',
        });
        return json(res, 201, { project: pid, promotedFrom: sessionId, slug: created.slug, id: created.id });
      } catch (e) {
        return fail(res, 409, 'PROMOTE_FAILED', (e as Error).message);
      }
    }

    if (method !== 'GET') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', `metodo ${method} nao suportado nesta rota`);
    }

    // ---- GET /health ----
    if (parts.length === 1 && parts[0] === 'health') {
      return json(res, 200, {
        status: 'ok', version: VERSION,
        uptimeSec: Math.floor((Date.now() - START) / 1000),
        projects: loadRegistry().length,
      });
    }

    // ---- GET /projects ----
    if (parts.length === 1 && parts[0] === 'projects') {
      const out = loadRegistry().map((p) => {
        const config = safeLoad(p.path);
        if (!config) return { id: p.id, name: p.name, color: p.color, order: p.order, counts: null, degraded: 'PROJECT_MISCONFIGURED' };
        try {
          const c = countByStatus(config);
          const total = Object.values(c).reduce((a, b) => a + b, 0);
          const running = listSessions(p.path).filter((s) => s.state === 'running').length;
          return {
            id: p.id, name: p.name, color: p.color, order: p.order,
            counts: { active: c['em-andamento'] || 0, blocked: c['bloqueado'] || 0, pending: c['pendente'] || 0, done: c['concluida'] || 0, total },
            runningSessions: running,
          };
        } catch (e) {
          return { id: p.id, name: p.name, color: p.color, order: p.order, counts: null, degraded: (e as Error).message };
        }
      });
      return json(res, 200, out);
    }

    // ---- GET /projects/:project/sessions ----
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'sessions') {
      const pid = decodeURIComponent(parts[1]);
      const r = resolveProject(pid);
      if (!r.ok) return fail(res, r.status, r.code, r.message, r.hint);
      const link = sessionLinkMap(r.config);
      const sessions = listSessions(r.entry.path).map((s) => {
        const a = link.get(s.sessionId) || null;
        return { ...s, inMegabrain: !!a, highlight: !!a, linkedActivity: a };
      });
      const filter = url.searchParams.get('state'); // running|idle|ended|all
      const filtered = filter && filter !== 'all' ? sessions.filter((s) => s.state === filter) : sessions;
      const limitRaw = parseInt(url.searchParams.get('limit') || '60', 10);
      const limit = Number.isNaN(limitRaw) ? 60 : Math.max(1, Math.min(limitRaw, 1000));
      return json(res, 200, {
        project: pid, total: filtered.length, count: Math.min(filtered.length, limit),
        running: sessions.filter((s) => s.state === 'running').length,
        idle: sessions.filter((s) => s.state === 'idle').length,
        orphans: sessions.filter((s) => !s.inMegabrain).length,
        highlighted: sessions.filter((s) => s.highlight).length,
        sessions: filtered.slice(0, limit),
      });
    }

    // ---- GET /projects/:project/activities [/:slug] ----
    if (parts[0] === 'projects' && parts.length >= 3 && parts[2] === 'activities') {
      const pid = decodeURIComponent(parts[1]);
      const r = resolveProject(pid);
      if (!r.ok) return fail(res, r.status, r.code, r.message, r.hint);
      const { config } = r;

      if (parts.length === 4) {
        const slug = decodeURIComponent(parts[3]);
        try { return json(res, 200, { project: pid, slug, markdown: getActivity(config, slug) }); }
        catch (e) { return fail(res, 404, 'ACTIVITY_NOT_FOUND', (e as Error).message); }
      }

      let rows = listActivities(config);
      const status = url.searchParams.get('status') || 'active';
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const sort = url.searchParams.get('sort') || 'recent';
      const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Number.isNaN(limitRaw) ? 50 : Math.max(1, Math.min(limitRaw, 500));

      if (status !== 'all') {
        const target = STATUS_MAP[status] || status;
        rows = rows.filter((a) => a.status === target);
      }
      if (q) rows = rows.filter((a) => `${a.titulo} ${a.squad} ${a.slug}`.toLowerCase().includes(q));
      if (sort === 'titulo') rows = rows.slice().sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt'));

      const total = rows.length;
      const sliced = rows.slice(0, limit);
      return json(res, 200, {
        project: pid, status, sort, total, count: sliced.length,
        activities: sliced.map((a) => ({
          id: a.id, slug: a.slug, titulo: a.titulo, status: a.status,
          squad: a.squad, updated: a.updated, lastLog: a.last,
        })),
      });
    }

    return fail(res, 404, 'NOT_FOUND', `rota desconhecida: ${url.pathname}`);
  } catch (e) {
    fail(res, 500, 'INTERNAL', (e as Error).message);
  }
});

export function startDaemon(argv: string[] = []): void {
  let port = 7717;
  const pi = argv.indexOf('--port');
  if (pi >= 0 && argv[pi + 1]) {
    const p = parseInt(argv[pi + 1], 10);
    if (!Number.isNaN(p)) port = p;
  }
  const projects = loadRegistry();
  server.listen(port, '127.0.0.1', () => {
    console.error(`[kxd] daemon on http://127.0.0.1:${port} (${VERSION})`);
    console.error(`[kxd] projetos: ${projects.map((p) => p.id).join(', ') || '(nenhum)'}`);
  });
  server.on('error', (e) => { console.error(`[kxd] erro no servidor: ${(e as Error).message}`); process.exit(1); });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
