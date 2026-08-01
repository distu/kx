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
  distance: number;
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
  }

  clearAll(): void {
    this.db.exec('DELETE FROM vec_documents; DELETE FROM documents;');
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

    // Deletar vetor antigo se existir
    this.db.prepare('DELETE FROM vec_documents WHERE document_id = ?').run(docId);

    // Inserir vetor (BigInt obrigatório para sqlite-vec primary key)
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare(
      'INSERT INTO vec_documents (document_id, embedding) VALUES (?, ?)'
    ).run(BigInt(docId), embeddingBuf);

    return docId;
  }

  search(queryEmbedding: Float32Array, topK: number = 10, sourceType?: string): SearchResult[] {
    let query: string;
    const embBuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    const params: unknown[] = [embBuf, topK];

    if (sourceType && sourceType !== 'all') {
      query = `
        SELECT d.path, d.chunk_index, d.content, d.source_type, d.metadata, v.distance
        FROM vec_documents v
        JOIN documents d ON d.id = v.document_id
        WHERE v.embedding MATCH ? AND k = ?
          AND d.source_type = ?
        ORDER BY v.distance ASC
      `;
      params.push(sourceType);
    } else {
      query = `
        SELECT d.path, d.chunk_index, d.content, d.source_type, d.metadata, v.distance
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
      distance: number;
    }>;

    return rows.map(row => ({
      path: row.path,
      chunk_index: row.chunk_index,
      content: row.content,
      source_type: row.source_type,
      distance: row.distance,
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

    return deleteMany(paths);
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

  close(): void {
    this.db.close();
  }
}
