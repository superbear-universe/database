import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function initSchema(db) {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

export function fileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function getExtractionHash(db, relPath) {
  return db.prepare('SELECT content_hash FROM _extractions WHERE source_file = ?').get(relPath)?.content_hash ?? null;
}

export function recordExtraction(db, relPath, hash) {
  db.prepare(`
    INSERT INTO _extractions (source_file, content_hash, extracted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      content_hash = excluded.content_hash,
      extracted_at = excluded.extracted_at
  `).run(relPath, hash, new Date().toISOString());
}

export function upsert(db, table, data, conflictCol) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null || v === 0);
  if (entries.length === 0) return { lastInsertRowid: null, changes: 0 };
  const keys = entries.map(([k]) => k);
  const values = entries.map(([, v]) => v);
  const placeholders = keys.map(() => '?').join(', ');
  const conflictCols = new Set(conflictCol.split(',').map(s => s.trim()));
  const updates = keys.filter(k => !conflictCols.has(k)).map(k => `${k} = excluded.${k}`).join(', ');
  const conflictClause = updates.length
    ? `ON CONFLICT(${conflictCol}) DO UPDATE SET ${updates}`
    : `ON CONFLICT(${conflictCol}) DO NOTHING`;
  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ${conflictClause}`
  ).run(...values);
}

export function rebuildFts(db) {
  for (const fts of ['characters_fts', 'lore_fts', 'bearing_rules_fts', 'stories_fts', 'story_events_fts']) {
    db.prepare(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`).run();
  }
}

export function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function getCharacterId(db, nameOrSlug) {
  if (!nameOrSlug) return null;
  return db.prepare(`
    SELECT id FROM characters
    WHERE lower(slug) = lower(?)
       OR lower(name) = lower(?)
       OR lower(alias) = lower(?)
       OR lower(real_name) = lower(?)
  `).get(nameOrSlug, nameOrSlug, nameOrSlug, nameOrSlug)?.id ?? null;
}

export function syncDeleted(db, activeFiles) {
  const stored = db.prepare('SELECT source_file FROM _extractions').all().map(r => r.source_file);
  const active = new Set(activeFiles);
  const orphaned = stored.filter(f => !active.has(f));

  if (orphaned.length === 0) {
    console.log('sync: no orphaned records');
    return;
  }

  const contentTables = ['characters', 'lore_entries', 'bearing_rules', 'artifacts', 'organizations', 'stories', 'transformations', 'relationships'];
  for (const relPath of orphaned) {
    for (const table of contentTables) {
      const result = db.prepare(`DELETE FROM ${table} WHERE source_file = ?`).run(relPath);
      if (result.changes > 0) console.log(`sync: deleted ${result.changes} rows from ${table} for ${relPath}`);
    }
    db.prepare('DELETE FROM _extractions WHERE source_file = ?').run(relPath);
    console.log(`sync: removed extraction record for ${relPath}`);
  }
}
