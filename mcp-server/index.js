#!/usr/bin/env node
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SUPERBEAR_DB_PATH ?? join(__dirname, '..', 'superbear.db');
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const ADMIN_PASSWORD = process.env.SUPERBEAR_API_KEY;
const ISSUER_URL = new URL(process.env.SUPERBEAR_ISSUER_URL ?? `http://localhost:${PORT}`);

if (!ADMIN_PASSWORD) {
  console.error('Error: SUPERBEAR_API_KEY must be set (used as the OAuth authorization password)');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// ── Query helpers ─────────────────────────────────────────────────────────────

function parseJson(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}

function expandJsonFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) if (f in out) out[f] = parseJson(out[f]);
  return out;
}

function findCharacter(name) {
  return (
    db.prepare(`SELECT * FROM characters WHERE lower(name)=lower(?) OR lower(alias)=lower(?) OR lower(real_name)=lower(?) OR lower(slug)=lower(?)`).get(name,name,name,name)
    ?? db.prepare(`SELECT * FROM characters WHERE lower(name) LIKE lower(?) OR lower(alias) LIKE lower(?) OR lower(real_name) LIKE lower(?)`).get(`%${name}%`,`%${name}%`,`%${name}%`)
  );
}

function getCharacter(name) {
  const char = findCharacter(name);
  if (!char) return { error: `No character found matching "${name}"` };

  const appearances = db.prepare('SELECT * FROM character_appearances WHERE character_id=?').all(char.id)
    .map(r => expandJsonFields(r, ['clothing']));

  const psychology = expandJsonFields(
    db.prepare('SELECT * FROM character_psychology WHERE character_id=?').get(char.id),
    ['traits','flaws','vulnerabilities','themes']
  );

  const transformationsSubject = db.prepare(`
    SELECT t.*, c.name as transformer_name
    FROM transformations t LEFT JOIN characters c ON c.id=t.transformer_id
    WHERE t.subject_id=?`).all(char.id);

  const transformationsPerformed = db.prepare(`
    SELECT t.*, c.name as subject_name
    FROM transformations t JOIN characters c ON c.id=t.subject_id
    WHERE t.transformer_id=?`).all(char.id);

  const relationships = db.prepare(`
    SELECT r.*,
      CASE WHEN r.character_a_slug=? THEN r.character_b_slug ELSE r.character_a_slug END as other_slug
    FROM relationships r
    WHERE r.character_a_slug=? OR r.character_b_slug=?`).all(char.slug, char.slug, char.slug);

  return { character: char, appearances, psychology, transformationsSubject, transformationsPerformed, relationships };
}

function listCharacters() {
  return db.prepare(`SELECT slug,name,alias,alignment,status,affiliation,summary FROM characters ORDER BY name`).all();
}

function searchCharacters(query) {
  try {
    return db.prepare(`
      SELECT c.*, snippet(characters_fts,0,'<b>','</b>','…',20) as snippet, bm25(characters_fts) as rank
      FROM characters_fts JOIN characters c ON c.id=characters_fts.rowid
      WHERE characters_fts MATCH ? ORDER BY rank LIMIT 10`).all(query);
  } catch { return []; }
}

function listStories() {
  return db.prepare(`SELECT slug,title,chapter_number,subtitle,published_date,is_canonical,summary,pov_characters FROM stories ORDER BY chapter_number ASC NULLS LAST, published_date`).all()
    .map(r => expandJsonFields(r, ['pov_characters']));
}

function getStoryEvents(chapterOrTitle) {
  let story = null;
  const asNum = parseInt(chapterOrTitle, 10);
  if (!isNaN(asNum)) {
    story = db.prepare('SELECT * FROM stories WHERE chapter_number=?').get(asNum);
  }
  if (!story) {
    story = db.prepare(`SELECT * FROM stories WHERE lower(title) LIKE lower(?) OR lower(slug) LIKE lower(?)`).get(`%${chapterOrTitle}%`,`%${chapterOrTitle}%`);
  }
  if (!story) return { error: `No story found matching "${chapterOrTitle}"` };

  const events = db.prepare(`SELECT * FROM story_events WHERE story_id=? ORDER BY sequence_order`)
    .all(story.id).map(r => expandJsonFields(r, ['characters_involved']));

  return { story: expandJsonFields(story, ['pov_characters']), events };
}

function searchLore(query) {
  const results = [];
  for (const [fts, type] of [['lore_fts','lore'],['bearing_rules_fts','bearing_rule']]) {
    try {
      const rows = db.prepare(`
        SELECT *, snippet(${fts},0,'<b>','</b>','…',20) as snippet, bm25(${fts}) as rank
        FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT 8`).all(query);
      results.push(...rows.map(r => ({ ...r, _type: type })));
    } catch { /* ignore malformed FTS query */ }
  }
  return results.sort((a,b) => a.rank-b.rank).slice(0,15);
}

function getBearingRules(ruleType) {
  if (ruleType) {
    return db.prepare('SELECT * FROM bearing_rules WHERE rule_type=? ORDER BY bearing_form, rule_statement').all(ruleType);
  }
  return db.prepare('SELECT * FROM bearing_rules ORDER BY rule_type, bearing_form').all();
}

function getArtifact(name) {
  const artifact = db.prepare(`SELECT a.*, c.name as holder_name FROM artifacts a LEFT JOIN characters c ON c.id=a.current_holder WHERE lower(a.name) LIKE lower(?)`).get(`%${name}%`);
  if (!artifact) return { error: `No artifact found matching "${name}"` };
  return artifact;
}

function getOrganization(name) {
  const org = db.prepare(`SELECT o.*, c.name as leader_name FROM organizations o LEFT JOIN characters c ON c.id=o.leader_id WHERE lower(o.name) LIKE lower(?)`).get(`%${name}%`);
  if (!org) return { error: `No organization found matching "${name}"` };
  const members = parseJson(org.known_members);
  return { ...org, known_members: members };
}

function listTransformations(characterName) {
  if (characterName) {
    const char = findCharacter(characterName);
    if (!char) return { error: `No character found matching "${characterName}"` };
    return db.prepare(`
      SELECT t.*, subj.name as subject_name, trans.name as transformer_name
      FROM transformations t
      JOIN characters subj ON subj.id=t.subject_id
      LEFT JOIN characters trans ON trans.id=t.transformer_id
      WHERE t.subject_id=? OR t.transformer_id=?
      ORDER BY t.id`).all(char.id, char.id);
  }
  return db.prepare(`
    SELECT t.*, subj.name as subject_name, trans.name as transformer_name
    FROM transformations t
    JOIN characters subj ON subj.id=t.subject_id
    LEFT JOIN characters trans ON trans.id=t.transformer_id
    ORDER BY t.transformation_type, t.id`).all();
}

function searchFacts(query) {
  const results = [];
  const tables = [
    ['characters_fts', 'character'],
    ['lore_fts', 'lore'],
    ['bearing_rules_fts', 'bearing_rule'],
    ['stories_fts', 'story'],
    ['story_events_fts', 'story_event'],
  ];
  for (const [fts, type] of tables) {
    try {
      const rows = db.prepare(`
        SELECT *, snippet(${fts},0,'<b>','</b>','…',20) as snippet, bm25(${fts}) as rank
        FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT 5`).all(query);
      results.push(...rows.map(r => ({ ...r, _type: type })));
    } catch { /* ignore */ }
  }
  return results.sort((a,b) => a.rank-b.rank).slice(0,20);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_characters',
    description: 'List all characters in the Superbear universe with a brief summary each.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_character',
    description: 'Get full details about a character: appearance, psychology, transformations, relationships. Use for questions about a specific character.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Character name, alias, or slug (e.g. "Nick", "Superbear", "mike-superbear")' } },
      required: ['name']
    }
  },
  {
    name: 'search_characters',
    description: 'Full-text search across character names, summaries, affiliations, and occupations.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'list_stories',
    description: 'List all stories/chapters with metadata. Ordered by chapter number.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_story_events',
    description: 'Get the plot events from a specific story chapter. Use to answer "what happened in chapter X?"',
    inputSchema: {
      type: 'object',
      properties: { chapter_or_title: { type: 'string', description: 'Chapter number (e.g. "5") or title keywords' } },
      required: ['chapter_or_title']
    }
  },
  {
    name: 'search_lore',
    description: 'Search lore documents and bearing rules by keyword. Use for questions about universe mechanics, the Brotherhood, consent rules, etc.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'get_bearing_rules',
    description: 'Get canonical rules about how bearing works, optionally filtered by type (consent, corruption, mechanics, injury, love, restoration).',
    inputSchema: {
      type: 'object',
      properties: {
        rule_type: { type: 'string', enum: ['consent','corruption','mechanics','injury','love','restoration'], description: 'Optional filter' }
      }
    }
  },
  {
    name: 'get_artifact',
    description: 'Get details about a named artifact (e.g. "Power Bear Coffee", "The Seal", "harness").',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'get_organization',
    description: 'Get details about an organization (e.g. "Brotherhood").',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'list_transformations',
    description: 'List all known transformations. Optionally filter by character name (as subject or transformer).',
    inputSchema: {
      type: 'object',
      properties: { character_name: { type: 'string', description: 'Optional: filter by this character' } }
    }
  },
  {
    name: 'search_facts',
    description: 'Global full-text search across all canon content: characters, lore, bearing rules, stories, and story events. Use when you need to search across multiple content types at once.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
];

// ── Server factory ────────────────────────────────────────────────────────────

function makeServer() {
  const server = new Server(
    { name: 'superbear-universe', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let result;
    try {
      switch (name) {
        case 'list_characters':        result = listCharacters(); break;
        case 'get_character':          result = getCharacter(args.name); break;
        case 'search_characters':      result = searchCharacters(args.query); break;
        case 'list_stories':           result = listStories(); break;
        case 'get_story_events':       result = getStoryEvents(args.chapter_or_title); break;
        case 'search_lore':            result = searchLore(args.query); break;
        case 'get_bearing_rules':      result = getBearingRules(args.rule_type); break;
        case 'get_artifact':           result = getArtifact(args.name); break;
        case 'get_organization':       result = getOrganization(args.name); break;
        case 'list_transformations':   result = listTransformations(args.character_name); break;
        case 'search_facts':           result = searchFacts(args.query); break;
        default: result = { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      result = { error: err.message };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  });

  return server;
}

// ── OAuth provider ────────────────────────────────────────────────────────────

const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

class InMemoryClientsStore {
  _clients = new Map();
  async getClient(id) { return this._clients.get(id); }
  async registerClient(meta) { this._clients.set(meta.client_id, meta); return meta; }
}

class SuperbearAuthProvider {
  clientsStore = new InMemoryClientsStore();
  _pending = new Map(); // nonce -> { client, params }
  _codes   = new Map(); // code  -> { client, params }
  _tokens  = new Map(); // token -> AuthInfo

  async authorize(client, params, res) {
    const nonce = randomUUID();
    this._pending.set(nonce, { client, params });
    res.send(loginPage(nonce));
  }

  async challengeForAuthorizationCode(_client, code) {
    const data = this._codes.get(code);
    if (!data) throw new Error('Invalid authorization code');
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code) {
    const data = this._codes.get(code);
    if (!data) throw new Error('Invalid authorization code');
    this._codes.delete(code);

    const token = randomUUID();
    this._tokens.set(token, {
      token,
      clientId: client.client_id,
      scopes: data.params.scopes ?? [],
      expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL,
      resource: data.params.resource,
    });

    return { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL };
  }

  async exchangeRefreshToken() {
    throw new Error('Refresh tokens not supported; please re-authorize');
  }

  async verifyAccessToken(token) {
    const info = this._tokens.get(token);
    if (!info || info.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid or expired token');
    }
    return info;
  }

  async revokeToken(_client, request) {
    this._tokens.delete(request.token);
  }

  // Called by the /authorize/confirm POST route
  confirmAuthorization(nonce, password) {
    if (password !== ADMIN_PASSWORD) return null;
    const pending = this._pending.get(nonce);
    if (!pending) return null;
    this._pending.delete(nonce);
    const code = randomUUID();
    this._codes.set(code, pending);
    return { code, params: pending.params };
  }
}

function loginPage(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Superbear MCP — Authorize</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;max-width:380px;margin:5rem auto;padding:0 1rem;color:#1a1a1a}
    h1{font-size:1.25rem;margin-bottom:.25rem}
    p{color:#555;margin:.25rem 0 1.5rem;font-size:.9375rem}
    label{display:block;font-size:.875rem;font-weight:500;margin-bottom:.375rem}
    input[type=password]{display:block;width:100%;padding:.5rem .75rem;border:1px solid #ccc;border-radius:.375rem;font-size:1rem;margin-bottom:1rem}
    button{padding:.5rem 1.25rem;background:#2563eb;color:#fff;border:none;border-radius:.375rem;font-size:.9375rem;cursor:pointer}
    button:hover{background:#1d4ed8}
  </style>
</head>
<body>
  <h1>Superbear MCP</h1>
  <p>Enter your password to authorize access.</p>
  <form method="POST" action="/authorize/confirm">
    <input type="hidden" name="nonce" value="${nonce}">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

// ── Express app ───────────────────────────────────────────────────────────────

const provider = new SuperbearAuthProvider();
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// OAuth endpoints: /.well-known/oauth-authorization-server, /authorize, /token, /register, /revoke
app.use(mcpAuthRouter({
  provider,
  issuerUrl: ISSUER_URL,
  resourceName: 'Superbear Universe',
  scopesSupported: [],
}));

// Login form submission
app.post('/authorize/confirm', (req, res) => {
  const { nonce, password } = req.body;
  const result = provider.confirmAuthorization(nonce, password);

  if (!result) {
    res.status(401).send('Incorrect password.');
    return;
  }

  const target = new URL(result.params.redirectUri);
  target.searchParams.set('code', result.code);
  if (result.params.state) target.searchParams.set('state', result.params.state);
  res.redirect(target.toString());
});

// MCP endpoint — protected by OAuth bearer token
app.all('/mcp', requireBearerAuth({ verifier: provider }), async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on('finish', () => server.close());
});

app.listen(PORT, () => {
  console.error(`Superbear MCP server listening on port ${PORT}`);
  console.error(`Issuer: ${ISSUER_URL}`);
});
