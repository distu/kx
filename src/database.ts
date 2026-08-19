import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface DocumentRow {
  id: number;
  path: string;
  chunk_index: number;
  content: string;
  source_type: string;
  modified_at: number;
  metadata: string;
}

export interface SearchResult {
  path: string;
  chunk_index: number;
  content: string;
  source_type: string;
  /** Distância vetorial. Ausente quando o chunk veio apenas da via lexical. */
  distance?: number;
  modified_at: number;
  metadata: Record<string, unknown>;
}

/** Resultado da via lexical (BM25 via FTS5). Score menor = mais relevante. */
export interface LexicalResult extends Omit<SearchResult, 'distance'> {
  bm25: number;
}

export interface ChunkInsert {
  index: number;
  content: string;
  metadata: Record<string, unknown>;
}

export class VectorDatabase {
  private db: Database.Database;
  private dimensions: number;

  constructor(dbPath: string, dimensions: number = 384) {
    this.dimensions = dimensions;

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // auto_vacuum precisa existir antes da primeira tabela para valer em
    // bancos novos. Em bancos legados é inerte até um VACUUM (comando
    // `kx vacuum`), e então passa a devolver páginas ao sistema.
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    sqliteVec.load(this.db);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        modified_at INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}',
        UNIQUE(path, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
      CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);
    `);

    // Criar tabela virtual de vetores
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
        document_id INTEGER PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);

    this.migrateFullTextIndex();
  }

  /**
   * Índice lexical BM25 sobre o mesmo conteúdo, sem duplicar o texto.
   *
   * FTS5 em modo external-content lê `content` da própria tabela documents;
   * os triggers mantêm o índice em sincronia com qualquer INSERT/DELETE/
   * UPDATE, inclusive os feitos por versões antigas do código. Em bancos
   * criados antes desta migração, o backfill acontece uma única vez na
   * primeira abertura. `remove_diacritics 2` faz "configuracao" casar com
   * "configuração" — essencial num corpus PT-BR com acentuação inconsistente.
   */
  private migrateFullTextIndex(): void {
    const exists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'"
    ).get() as { name: string } | undefined;

    if (!exists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE documents_fts USING fts5(
          content,
          content='documents',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      const total = (this.db.prepare('SELECT COUNT(*) AS c FROM documents').get() as { c: number }).c;
      if (total > 0) {
        console.error(`Construindo índice lexical (FTS5) para ${total} chunks existentes...`);
        this.db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
        console.error('Índice lexical pronto.');
      }
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  /**
   * Devolve páginas livres ao sistema quando o banco tem auto_vacuum ativo.
   * Em bancos legados (sem auto_vacuum) é um no-op silencioso.
   */
  private reclaimFreePages(): void {
    try {
      this.db.pragma('incremental_vacuum(4096)');
    } catch {
      // Banco legado sem auto_vacuum: nada a devolver por aqui.
    }
  }

  clearAll(): void {
    this.db.exec('DELETE FROM vec_documents; DELETE FROM documents;');
    this.reclaimFreePages();
  }

  insertDocument(
    path: string,
    chunkIndex: number,
    content: string,
    sourceType: string,
    modifiedAt: number,
    embedding: Float32Array,
    metadata: Record<string, unknown> = {}
  ): number {
    const existing = this.db.prepare(
      'SELECT id FROM documents WHERE path = ? AND chunk_index = ?'
    ).get(path, chunkIndex) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('DELETE FROM vec_documents WHERE document_id = ?').run(BigInt(existing.id));
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(existing.id);
    }

    const insertDoc = this.db.prepare(`
      INSERT INTO documents (path, chunk_index, content, source_type, modified_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insertDoc.run(
      path, chunkIndex, content, sourceType, modifiedAt, JSON.stringify(metadata)
    );

    const docId = Number(result.lastInsertRowid);

    // Inserir vetor (BigInt obrigatório para sqlite-vec primary key)
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare(
      'INSERT INTO vec_documents (document_id, embedding) VALUES (?, ?)'
    ).run(BigInt(docId), embeddingBuf);

    return docId;
  }

  /**
   * Substitui todos os chunks de um documento numa única transação.
   *
   * O caminho antigo fazia SELECT + 2 DELETEs + 2 INSERTs autocomitados por
   * chunk; em reindexações sucessivas isso inflou a freelist de um banco real
   * para 94% do arquivo. Uma transação por arquivo reduz o churn de páginas e
   * o custo de fsync, e deixa o documento sempre em estado consistente.
   */
  replaceDocument(
    path: string,
    sourceType: string,
    modifiedAt: number,
    chunks: ChunkInsert[],
    embeddings: Float32Array[],
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(`chunks (${chunks.length}) e embeddings (${embeddings.length}) divergem para ${path}`);
    }

    const selectIds = this.db.prepare('SELECT id FROM documents WHERE path = ?');
    const deleteVec = this.db.prepare('DELETE FROM vec_documents WHERE document_id = ?');
    const deleteDocs = this.db.prepare('DELETE FROM documents WHERE path = ?');
    const insertDoc = this.db.prepare(`
      INSERT INTO documents (path, chunk_index, content, source_type, modified_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVec = this.db.prepare('INSERT INTO vec_documents (document_id, embedding) VALUES (?, ?)');

    const replace = this.db.transaction(() => {
      const ids = selectIds.all(path) as Array<{ id: number }>;
      for (const { id } of ids) deleteVec.run(BigInt(id));
      deleteDocs.run(path);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = insertDoc.run(
          path, chunk.index, chunk.content, sourceType, modifiedAt, JSON.stringify(chunk.metadata),
        );
        const embedding = embeddings[i];
        const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        insertVec.run(BigInt(Number(result.lastInsertRowid)), embeddingBuf);
      }
    });

    replace();
  }

  search(queryEmbedding: Float32Array, topK: number = 10, sourceType?: string): SearchResult[] {
    let query: string;
    const embBuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    const params: unknown[] = [embBuf, topK];

    if (sourceType && sourceType !== 'all') {
      query = `
        SELECT d.path, d.chunk_index, d.content, d.source_type, d.metadata, d.modified_at, v.distance
        FROM vec_documents v
        JOIN documents d ON d.id = v.document_id
        WHERE v.embedding MATCH ? AND k = ?
          AND d.source_type = ?
        ORDER BY v.distance ASC
      `;
      params.push(sourceType);
    } else {
      query = `
        SELECT d.path, d.chunk_index, d.content, d.source_type, d.metadata, d.modified_at, v.distance
        FROM vec_documents v
        JOIN documents d ON d.id = v.document_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance ASC
      `;
    }

    const rows = this.db.prepare(query).all(...params) as Array<{
      path: string;
      chunk_index: number;
      content: string;
      source_type: string;
      metadata: string;
      modified_at: number;
      distance: number;
    }>;

    return rows.map(row => ({
      path: row.path,
      chunk_index: row.chunk_index,
      content: row.content,
      source_type: row.source_type,
      distance: row.distance,
      modified_at: row.modified_at,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  /**
   * Constrói uma expressão MATCH segura a partir de texto livre.
   *
   * Cada termo vira uma string entre aspas — operadores (AND, NEAR, ":", "-")
   * viram literais em vez de sintaxe, então nenhuma query do usuário quebra o
   * parser do FTS5. Termos compostos como CIRCUIT_OPEN ou circuit-open viram
   * frases (tokens adjacentes), que é exatamente como o tokenizer os indexou.
   * OR entre termos privilegia recall; o BM25 reordena por relevância e a
   * fusão RRF protege a precisão.
   */
  private static buildMatchExpression(rawQuery: string): string | null {
    const terms = rawQuery
      .split(/\s+/)
      .map(term => term.replace(/"/g, '').trim())
      .filter(term => term.length >= 2);
    if (terms.length === 0) return null;
    return terms.map(term => `"${term}"`).join(' OR ');
  }

  searchLexical(rawQuery: string, topK: number = 10, sourceType?: string): LexicalResult[] {
    const match = VectorDatabase.buildMatchExpression(rawQuery);
    if (match === null) return [];

    const filter = sourceType && sourceType !== 'all' ? 'AND d.source_type = ?' : '';
    const sql = `
      SELECT d.path, d.chunk_index, d.content, d.source_type, d.metadata, d.modified_at,
             bm25(documents_fts) AS bm25
      FROM documents_fts
      JOIN documents d ON d.id = documents_fts.rowid
      WHERE documents_fts MATCH ? ${filter}
      ORDER BY bm25 ASC
      LIMIT ?
    `;
    const params: unknown[] = [match];
    if (filter) params.push(sourceType);
    params.push(topK);

    let rows: Array<{
      path: string; chunk_index: number; content: string; source_type: string;
      metadata: string; modified_at: number; bm25: number;
    }>;
    try {
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    } catch {
      // Uma expressão patológica não pode derrubar a busca: a via vetorial
      // continua respondendo sozinha.
      return [];
    }

    return rows.map(row => ({
      path: row.path,
      chunk_index: row.chunk_index,
      content: row.content,
      source_type: row.source_type,
      modified_at: row.modified_at,
      bm25: row.bm25,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  deleteByPath(path: string): void {
    const ids = this.db.prepare('SELECT id FROM documents WHERE path = ?').all(path) as Array<{ id: number }>;
    for (const { id } of ids) {
      this.db.prepare('DELETE FROM vec_documents WHERE document_id = ?').run(BigInt(id));
    }
    this.db.prepare('DELETE FROM documents WHERE path = ?').run(path);
  }

  /** Paths are returned without content so policy reconciliation never reads it. */
  listPaths(): string[] {
    return (this.db.prepare('SELECT DISTINCT path FROM documents').all() as Array<{ path: string }>)
      .map(row => row.path);
  }

  /**
   * Deletes both document text and embeddings in one SQLite transaction.
   * The caller supplies already policy-matched paths.
   */
  deleteByPaths(paths: string[]): number {
    if (paths.length === 0) return 0;

    const deleteMany = this.db.transaction((targetPaths: string[]) => {
      let removed = 0;
      for (const path of targetPaths) {
        const ids = this.db.prepare('SELECT id FROM documents WHERE path = ?').all(path) as Array<{ id: number }>;
        for (const { id } of ids) {
          this.db.prepare('DELETE FROM vec_documents WHERE document_id = ?').run(BigInt(id));
        }
        this.db.prepare('DELETE FROM documents WHERE path = ?').run(path);
        if (ids.length > 0) removed++;
      }
      return removed;
    });

    const removed = deleteMany(paths);
    if (removed > 0) this.reclaimFreePages();
    return removed;
  }

  getModifiedAt(path: string): number | null {
    const row = this.db.prepare(
      'SELECT MAX(modified_at) as mtime FROM documents WHERE path = ?'
    ).get(path) as { mtime: number | null } | undefined;
    return row?.mtime ?? null;
  }

  getStats(): { totalDocuments: number; totalChunks: number; byType: Record<string, number> } {
    const total = this.db.prepare('SELECT COUNT(DISTINCT path) as cnt FROM documents').get() as { cnt: number };
    const chunks = this.db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number };
    const types = this.db.prepare(
      'SELECT source_type, COUNT(*) as cnt FROM documents GROUP BY source_type'
    ).all() as Array<{ source_type: string; cnt: number }>;

    const byType: Record<string, number> = {};
    for (const t of types) {
      byType[t.source_type] = t.cnt;
    }

    return {
      totalDocuments: total.cnt,
      totalChunks: chunks.cnt,
      byType,
    };
  }

  /**
   * Compacta o banco e devolve o espaço livre ao sistema de arquivos.
   * Ativa o auto_vacuum incremental de quebra (o VACUUM materializa o pragma
   * em bancos legados), para a freelist não voltar a crescer sem limite.
   */
  vacuum(): { beforeBytes: number; afterBytes: number; freedBytes: number } {
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    const before = (this.db.pragma('page_count', { simple: true }) as number) * pageSize;
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.exec('VACUUM;');
    const after = (this.db.pragma('page_count', { simple: true }) as number) * pageSize;
    return { beforeBytes: before, afterBytes: after, freedBytes: Math.max(0, before - after) };
  }

  close(): void {
    this.db.close();
  }
}
