PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Idempotency tracking

CREATE TABLE IF NOT EXISTS _extractions (
  id            INTEGER PRIMARY KEY,
  source_file   TEXT NOT NULL UNIQUE,
  content_hash  TEXT NOT NULL,
  extracted_at  TEXT NOT NULL
);

-- Characters

CREATE TABLE IF NOT EXISTS characters (
  id                INTEGER PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  alias             TEXT,
  real_name         TEXT,
  age_description   TEXT,
  sexuality         TEXT,
  nationality       TEXT,
  occupation_before TEXT,
  occupation_after  TEXT,
  alignment         TEXT CHECK(alignment IN ('hero','villain','neutral','corrupted')),
  status            TEXT,
  affiliation       TEXT,
  first_appearance  TEXT,
  summary           TEXT,
  source_file       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_appearances (
  id                  INTEGER PRIMARY KEY,
  character_id        INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  phase               TEXT NOT NULL CHECK(phase IN ('pre','post','hero','corrupted','civilian')),
  build               TEXT,
  height              TEXT,
  hair                TEXT,
  eyes                TEXT,
  facial_hair         TEXT,
  body_hair           TEXT,
  skin_tone           TEXT,
  posture             TEXT,
  clothing            TEXT,
  suit_colors         TEXT,
  suit_details        TEXT,
  notable_features    TEXT,
  overall_impression  TEXT,
  UNIQUE(character_id, phase)
);

CREATE TABLE IF NOT EXISTS character_psychology (
  id              INTEGER PRIMARY KEY,
  character_id    INTEGER NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  traits          TEXT,
  flaws           TEXT,
  core_wound      TEXT,
  secret_desires  TEXT,
  vulnerabilities TEXT,
  motivations     TEXT,
  themes          TEXT
);

CREATE TABLE IF NOT EXISTS transformations (
  id                    INTEGER PRIMARY KEY,
  subject_id            INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  transformer_id        INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  transformer_name      TEXT,
  transformation_type   TEXT CHECK(transformation_type IN (
    'accidental_super','normal_bearing','super_bearing_choice',
    'corrupted_forced','corrupted_seduced','corrupted_coerced','sir_transformation'
  )),
  catalyst              TEXT,
  method_description    TEXT,
  emotional_tone        TEXT,
  key_sensations        TEXT,
  outcome               TEXT,
  chapter_reference     TEXT,
  source_file           TEXT
);

CREATE TABLE IF NOT EXISTS relationships (
  id                  INTEGER PRIMARY KEY,
  character_a_slug    TEXT NOT NULL,
  character_b_slug    TEXT NOT NULL,
  relationship_type   TEXT,
  description         TEXT,
  canonical_rules     TEXT,
  source_file         TEXT,
  UNIQUE(character_a_slug, character_b_slug, relationship_type)
);

-- Lore

CREATE TABLE IF NOT EXISTS lore_entries (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  category    TEXT CHECK(category IN ('mechanic','organization','history','relationship_rules')),
  summary     TEXT,
  full_text   TEXT,
  source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bearing_rules (
  id              INTEGER PRIMARY KEY,
  rule_type       TEXT NOT NULL CHECK(rule_type IN ('consent','corruption','mechanics','injury','love','restoration')),
  bearing_form    TEXT CHECK(bearing_form IN ('normal','super_accidental','super_choice','corrupted','sir','any')),
  rule_statement  TEXT NOT NULL UNIQUE,
  elaboration     TEXT,
  exceptions      TEXT,
  source_file     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  current_holder  INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  origin          TEXT,
  function        TEXT,
  current_state   TEXT CHECK(current_state IN ('active','destroyed','spent','inert')),
  location        TEXT,
  significance    TEXT,
  source_file     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  leader_id           INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  ideology            TEXT,
  structure           TEXT,
  recruitment         TEXT,
  conversion_methods  TEXT,
  known_members       TEXT,
  source_file         TEXT NOT NULL
);

-- Stories

CREATE TABLE IF NOT EXISTS stories (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  chapter_number  INTEGER,
  subtitle        TEXT,
  published_date  TEXT,
  is_canonical    INTEGER NOT NULL DEFAULT 1,
  summary         TEXT,
  pov_characters  TEXT,
  source_file     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_events (
  id                    INTEGER PRIMARY KEY,
  story_id              INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  sequence_order        INTEGER NOT NULL,
  event_type            TEXT CHECK(event_type IN (
    'transformation','confrontation','revelation','relationship','rescue','corruption','other'
  )),
  summary               TEXT NOT NULL,
  characters_involved   TEXT,
  location              TEXT,
  significance          TEXT,
  direct_quote          TEXT
);

-- Tagging

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS fact_tags (
  id          INTEGER PRIMARY KEY,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,
  record_id   INTEGER NOT NULL,
  UNIQUE(tag_id, table_name, record_id)
);

-- FTS5 (content-backed; rebuilt at end of extraction via INSERT ... VALUES('rebuild'))

CREATE VIRTUAL TABLE IF NOT EXISTS characters_fts USING fts5(
  name, alias, real_name, occupation_before, occupation_after, affiliation, status, summary,
  content=characters, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS lore_fts USING fts5(
  title, category, summary, full_text,
  content=lore_entries, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS bearing_rules_fts USING fts5(
  rule_type, bearing_form, rule_statement, elaboration,
  content=bearing_rules, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS stories_fts USING fts5(
  title, subtitle, summary,
  content=stories, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS story_events_fts USING fts5(
  event_type, summary, significance, direct_quote,
  content=story_events, content_rowid=id
);
