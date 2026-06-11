import { upsert, getCharacterId } from '../db.js';

const MODEL = process.env.EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001';

const TOOL = {
  name: 'extract_character',
  description: 'Extract structured data from a character sheet',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Primary display name (e.g. "Nick", "Superbear")' },
      real_name: { type: 'string', description: 'Civilian/birth name if different from name' },
      alias: { type: 'string', description: 'Hero/villain name or alternate identity' },
      age_description: { type: 'string', description: 'e.g. "early 30s", "ancient/unknown"' },
      sexuality: { type: 'string' },
      nationality: { type: 'string' },
      occupation_before: { type: 'string' },
      occupation_after: { type: 'string' },
      alignment: { type: 'string', enum: ['hero', 'villain', 'neutral', 'corrupted'] },
      status: { type: 'string', description: 'e.g. "active", "corrupted", "diminished"' },
      affiliation: { type: 'string' },
      first_appearance: { type: 'string' },
      summary: { type: 'string', description: '2-3 sentence summary of this character' },
      appearance: {
        type: 'object',
        properties: {
          build: { type: 'string' },
          height: { type: 'string' },
          hair: { type: 'string' },
          eyes: { type: 'string' },
          facial_hair: { type: 'string' },
          body_hair: { type: 'string' },
          skin_tone: { type: 'string' },
          posture: { type: 'string' },
          clothing: { type: 'array', items: { type: 'string' } },
          suit_colors: { type: 'string' },
          suit_details: { type: 'string' },
          notable_features: { type: 'string' },
          overall_impression: { type: 'string' }
        }
      },
      psychology: {
        type: 'object',
        properties: {
          traits: { type: 'array', items: { type: 'string' } },
          flaws: { type: 'array', items: { type: 'string' } },
          core_wound: { type: 'string' },
          secret_desires: { type: 'string' },
          vulnerabilities: { type: 'array', items: { type: 'string' } },
          motivations: { type: 'string' },
          themes: { type: 'array', items: { type: 'string' } }
        }
      },
      transformation: {
        type: 'object',
        description: 'Transformation this character underwent. Omit if not applicable.',
        properties: {
          transformer_name: { type: 'string', description: 'Name of the being who performed the transformation (null if self/accidental)' },
          transformation_type: {
            type: 'string',
            enum: ['accidental_super', 'normal_bearing', 'super_bearing_choice', 'corrupted_forced', 'corrupted_seduced', 'corrupted_coerced', 'sir_transformation']
          },
          catalyst: { type: 'string', description: 'e.g. "Power Bear Coffee", "harness", "cigar smoke"' },
          method_description: { type: 'string' },
          emotional_tone: { type: 'string' },
          key_sensations: { type: 'string' },
          outcome: { type: 'string' },
          chapter_reference: { type: 'string' }
        }
      },
      relationships: {
        type: 'array',
        description: 'Key relationships mentioned in this sheet',
        items: {
          type: 'object',
          properties: {
            other_character_name: { type: 'string' },
            relationship_type: { type: 'string', enum: ['romantic_partners', 'mentor_cub', 'enemy', 'friend', 'corrupted_from', 'ally', 'other'] },
            description: { type: 'string' }
          },
          required: ['other_character_name', 'relationship_type']
        }
      }
    },
    required: ['name', 'summary', 'alignment']
  }
};

export async function extractCharacter(client, frontmatter, sections, filePath, slug, phase, db) {
  const sectionsJson = JSON.stringify(sections, null, 2);
  const prompt = `You are extracting canonical facts from a character sheet for the Superbear universe fiction.

Character sheet title: ${frontmatter.title ?? '(untitled)'}
Source file: ${filePath}
Expected appearance phase: ${phase} (pre=before transformation, hero=superhero form, corrupted=corrupted form)

Here are the sections of the character sheet:
${sectionsJson}

Extract all available structured data. For "appearance", describe the ${phase === 'pre' ? 'pre-transformation' : phase === 'hero' ? 'hero/post-transformation' : 'corrupted'} body. For transformation, extract details about the transformation this character underwent (if any). For relationships, extract only explicitly stated relationships to named characters.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'extract_character' },
    messages: [{ role: 'user', content: prompt }]
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  if (!toolUse) throw new Error(`No tool_use in response for ${filePath}`);
  const data = toolUse.input;

  // Upsert character row
  upsert(db, 'characters', {
    slug,
    name: data.name,
    alias: data.alias,
    real_name: data.real_name,
    age_description: data.age_description,
    sexuality: data.sexuality,
    nationality: data.nationality,
    occupation_before: data.occupation_before,
    occupation_after: data.occupation_after,
    alignment: data.alignment,
    status: data.status,
    affiliation: data.affiliation,
    first_appearance: data.first_appearance,
    summary: data.summary,
    source_file: filePath
  }, 'slug');

  // Always SELECT after upsert: lastInsertRowid is unreliable after DO UPDATE because SQLite
  // retains the rowid of the most recent INSERT across all tables, not the updated row's rowid.
  const charId = db.prepare('SELECT id FROM characters WHERE slug = ?').get(slug)?.id;
  if (!charId) throw new Error(`Character not found after upsert for slug: ${slug}`);

  // Upsert appearance
  if (data.appearance) {
    upsert(db, 'character_appearances', {
      character_id: charId,
      phase,
      build: data.appearance.build,
      height: data.appearance.height,
      hair: data.appearance.hair,
      eyes: data.appearance.eyes,
      facial_hair: data.appearance.facial_hair,
      body_hair: data.appearance.body_hair,
      skin_tone: data.appearance.skin_tone,
      posture: data.appearance.posture,
      clothing: data.appearance.clothing ? JSON.stringify(data.appearance.clothing) : null,
      suit_colors: data.appearance.suit_colors,
      suit_details: data.appearance.suit_details,
      notable_features: data.appearance.notable_features,
      overall_impression: data.appearance.overall_impression
    }, 'character_id, phase');
  }

  // Upsert psychology (one row per character, merge on re-run)
  if (data.psychology) {
    const existing = db.prepare('SELECT id FROM character_psychology WHERE character_id = ?').get(charId);
    if (existing) {
      db.prepare(`
        UPDATE character_psychology SET
          traits = ?, flaws = ?, core_wound = ?, secret_desires = ?,
          vulnerabilities = ?, motivations = ?, themes = ?
        WHERE character_id = ?
      `).run(
        data.psychology.traits ? JSON.stringify(data.psychology.traits) : null,
        data.psychology.flaws ? JSON.stringify(data.psychology.flaws) : null,
        data.psychology.core_wound,
        data.psychology.secret_desires,
        data.psychology.vulnerabilities ? JSON.stringify(data.psychology.vulnerabilities) : null,
        data.psychology.motivations,
        data.psychology.themes ? JSON.stringify(data.psychology.themes) : null,
        charId
      );
    } else {
      db.prepare(`
        INSERT INTO character_psychology (character_id, traits, flaws, core_wound, secret_desires, vulnerabilities, motivations, themes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        charId,
        data.psychology.traits ? JSON.stringify(data.psychology.traits) : null,
        data.psychology.flaws ? JSON.stringify(data.psychology.flaws) : null,
        data.psychology.core_wound,
        data.psychology.secret_desires,
        data.psychology.vulnerabilities ? JSON.stringify(data.psychology.vulnerabilities) : null,
        data.psychology.motivations,
        data.psychology.themes ? JSON.stringify(data.psychology.themes) : null
      );
    }
  }

  // Return transformation and relationships for second-pass resolution
  return {
    charId,
    slug,
    transformation: data.transformation ?? null,
    relationships: data.relationships ?? []
  };
}
