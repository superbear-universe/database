import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';
import {
  initSchema, fileHash, getExtractionHash, recordExtraction,
  rebuildFts, getCharacterId, upsert, syncDeleted
} from './db.js';
import { extractCharacter } from './extractors/character.js';
import { extractLore } from './extractors/lore.js';
import { extractStory } from './extractors/story.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DB_PATH = join(__dirname, '..', 'superbear.db');

const FORCE = process.argv.includes('--force');
const SYNC  = process.argv.includes('--sync');

// Files to skip entirely
const SKIP = new Set(['index.md', 'charactersheet-template.md']);

// Maps filename → canonical slug (for characters that share a slug across sheets)
const SLUG_MAP = {
  'mike_character_sheet_pre_transformation.md': 'mike-superbear',
  'superbear_character_sheet_post_transformation.md': 'mike-superbear',
  'nick_character_sheet_revised.md': 'nick-supercub',
  'supercub_character_sheet.md': 'nick-supercub',
  'corrupted_supercub_character_sheet.md': 'nick-supercub',
};

// Maps filename → appearance phase
const PHASE_MAP = {
  'mike_character_sheet_pre_transformation.md': 'pre',
  'superbear_character_sheet_post_transformation.md': 'hero',
  'nick_character_sheet_revised.md': 'pre',
  'supercub_character_sheet.md': 'hero',
  'corrupted_supercub_character_sheet.md': 'corrupted',
};

function defaultSlug(filename) {
  return filename
    .replace(/_character_sheet_revised_2\.md$/, '')
    .replace(/_character_sheet_revised\.md$/, '')
    .replace(/_character_sheet_post_transformation\.md$/, '')
    .replace(/_character_sheet_pre_transformation\.md$/, '')
    .replace(/_character_sheet\.md$/, '')
    .replace(/\.md$/, '')
    .replace(/_/g, '-');
}

function defaultPhase(filename) {
  if (filename.includes('post_transformation')) return 'post';
  if (filename.includes('corrupted')) return 'corrupted';
  return 'pre';
}

function splitSections(body) {
  const sections = {};
  let current = '__preamble__';
  sections[current] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.replace(/^##\s+/, '').trim();
      sections[current] = [];
    } else {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()])
  );
}

function listMd(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && !SKIP.has(f))
    .sort()
    .map(f => ({ filename: f, fullPath: join(dir, f), relPath: relative(REPO_ROOT, join(dir, f)) }));
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  const client = new Anthropic();

  const charDir   = join(REPO_ROOT, 'source/characters');
  const loreDir   = join(REPO_ROOT, 'source/lore');
  const storyDir  = join(REPO_ROOT, 'source/stories');

  const charFiles  = listMd(charDir);
  const loreFiles  = listMd(loreDir);
  const storyFiles = listMd(storyDir);

  const allRelPaths = [...charFiles, ...loreFiles, ...storyFiles].map(f => f.relPath);

  // Deferred data for second-pass resolution
  const pendingTransformations = []; // { charSlug, transformation }
  const pendingRelationships   = []; // { charSlug, other_character_name, relationship_type, description, source_file }

  // ── Pass 1: Characters ────────────────────────────────────────────────────

  console.log(`\n── Characters (${charFiles.length} files) ──`);
  for (const { filename, fullPath, relPath } of charFiles) {
    const raw = readFileSync(fullPath, 'utf8');
    const hash = fileHash(raw);

    if (!FORCE && getExtractionHash(db, relPath) === hash) {
      console.log(`  skip (unchanged): ${filename}`);
      continue;
    }

    console.log(`  extracting: ${filename}`);
    const { data: frontmatter, content: body } = matter(raw);
    const sections = splitSections(body);
    const slug = SLUG_MAP[filename] ?? defaultSlug(filename);
    const phase = PHASE_MAP[filename] ?? defaultPhase(filename);

    try {
      const result = await extractCharacter(client, frontmatter, sections, relPath, slug, phase, db);

      if (result.transformation) {
        pendingTransformations.push({ charSlug: slug, transformation: result.transformation, source_file: relPath });
      }
      for (const rel of result.relationships) {
        pendingRelationships.push({ charSlug: slug, ...rel, source_file: relPath });
      }

      recordExtraction(db, relPath, hash);
    } catch (err) {
      console.error(`  ERROR (${filename}):`, err.message);
    }

    await delay(300);
  }

  // ── Pass 2: Lore ──────────────────────────────────────────────────────────

  console.log(`\n── Lore (${loreFiles.length} files) ──`);
  for (const { filename, fullPath, relPath } of loreFiles) {
    const raw = readFileSync(fullPath, 'utf8');
    const hash = fileHash(raw);

    if (!FORCE && getExtractionHash(db, relPath) === hash) {
      console.log(`  skip (unchanged): ${filename}`);
      continue;
    }

    console.log(`  extracting: ${filename}`);
    const { data: frontmatter, content: body } = matter(raw);
    const sections = splitSections(body);

    try {
      await extractLore(client, frontmatter, sections, body, relPath, db);
      recordExtraction(db, relPath, hash);
    } catch (err) {
      console.error(`  ERROR (${filename}):`, err.message);
    }

    await delay(300);
  }

  // ── Pass 3: Stories ───────────────────────────────────────────────────────

  console.log(`\n── Stories (${storyFiles.length} files) ──`);
  for (const { filename, fullPath, relPath } of storyFiles) {
    const raw = readFileSync(fullPath, 'utf8');
    const hash = fileHash(raw);

    if (!FORCE && getExtractionHash(db, relPath) === hash) {
      console.log(`  skip (unchanged): ${filename}`);
      continue;
    }

    console.log(`  extracting: ${filename}`);
    const { data: frontmatter, content: body } = matter(raw);

    try {
      await extractStory(client, frontmatter, body, relPath, db);
      recordExtraction(db, relPath, hash);
    } catch (err) {
      console.error(`  ERROR (${filename}):`, err.message);
    }

    await delay(300);
  }

  // ── Pass 4: Resolve transformations & relationships ───────────────────────

  console.log('\n── Resolving transformations and relationships ──');

  const VALID_TRANSFORMATION_TYPES = new Set([
    'accidental_super', 'normal_bearing', 'super_bearing_choice',
    'corrupted_forced', 'corrupted_seduced', 'corrupted_coerced', 'sir_transformation'
  ]);

  for (const { charSlug, transformation, source_file } of pendingTransformations) {
    const subjectId = getCharacterId(db, charSlug);
    if (!subjectId) { console.warn(`  warn: no character found for slug "${charSlug}"`); continue; }

    const transformerId = transformation.transformer_name
      ? getCharacterId(db, transformation.transformer_name)
      : null;

    const transformationType = VALID_TRANSFORMATION_TYPES.has(transformation.transformation_type)
      ? transformation.transformation_type
      : null;

    const existing = db.prepare('SELECT id FROM transformations WHERE subject_id = ?').get(subjectId);
    if (existing) {
      db.prepare(`UPDATE transformations SET
        transformer_id = ?, transformer_name = ?, transformation_type = ?,
        catalyst = ?, method_description = ?, emotional_tone = ?,
        key_sensations = ?, outcome = ?, chapter_reference = ?, source_file = ?
        WHERE subject_id = ?`).run(
        transformerId, transformation.transformer_name, transformationType,
        transformation.catalyst, transformation.method_description, transformation.emotional_tone,
        transformation.key_sensations, transformation.outcome, transformation.chapter_reference,
        source_file, subjectId
      );
    } else {
      db.prepare(`INSERT INTO transformations
        (subject_id, transformer_id, transformer_name, transformation_type, catalyst,
         method_description, emotional_tone, key_sensations, outcome, chapter_reference, source_file)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        subjectId, transformerId, transformation.transformer_name, transformationType,
        transformation.catalyst, transformation.method_description, transformation.emotional_tone,
        transformation.key_sensations, transformation.outcome, transformation.chapter_reference,
        source_file
      );
    }
  }

  for (const { charSlug, other_character_name, relationship_type, description, source_file } of pendingRelationships) {
    const otherSlug = other_character_name?.toLowerCase().replace(/\s+/g, '-') ?? null;
    if (!otherSlug) continue;

    // Normalise so A < B alphabetically to avoid duplicates
    const [a, b] = charSlug < otherSlug ? [charSlug, otherSlug] : [otherSlug, charSlug];

    upsert(db, 'relationships', {
      character_a_slug: a,
      character_b_slug: b,
      relationship_type,
      description,
      source_file
    }, 'character_a_slug, character_b_slug, relationship_type');
  }

  // Resolve artifact holders and org leaders now that all characters exist
  db.prepare(`UPDATE artifacts SET current_holder = (
    SELECT id FROM characters WHERE lower(name) = lower(artifacts.name) OR lower(alias) = lower(artifacts.name)
  ) WHERE current_holder IS NULL`).run();

  // ── FTS rebuild ───────────────────────────────────────────────────────────

  console.log('\n── Rebuilding FTS indexes ──');
  rebuildFts(db);

  // ── Sync pass ─────────────────────────────────────────────────────────────

  if (SYNC) {
    console.log('\n── Syncing (removing orphaned records) ──');
    syncDeleted(db, allRelPaths);
  }

  console.log('\nExtraction complete.');
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
