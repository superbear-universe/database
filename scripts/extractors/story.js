import { upsert, slugify } from '../db.js';

const MODEL = process.env.EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001';

const TOOL = {
  name: 'extract_story',
  description: 'Extract structured data from a story chapter',
  input_schema: {
    type: 'object',
    properties: {
      is_canonical: { type: 'boolean', description: 'true if this is a numbered main-story chapter' },
      summary: { type: 'string', description: '3-4 sentence summary of what happens' },
      pov_character_names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of POV or main characters in this chapter'
      },
      events: {
        type: 'array',
        description: 'Key plot events in chronological order',
        items: {
          type: 'object',
          properties: {
            event_type: {
              type: 'string',
              enum: ['transformation', 'confrontation', 'revelation', 'relationship', 'rescue', 'corruption', 'other']
            },
            summary: { type: 'string', description: '1-2 sentence description of the event' },
            character_names: { type: 'array', items: { type: 'string' } },
            location: { type: 'string' },
            significance: { type: 'string', description: 'Why this event matters canonically' },
            direct_quote: { type: 'string', description: 'A notable line of dialogue (optional)' }
          },
          required: ['event_type', 'summary']
        }
      }
    },
    required: ['summary', 'events', 'is_canonical']
  }
};

function stripImages(text) {
  return text
    .replace(/!\[.*?\]\(https?:\/\/[^)]+\)/g, '')
    .replace(/\[(?:<<\s*Previous|Next\s*>>|First)[^\]]*\]\([^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseChapterNumber(subtitle) {
  if (!subtitle) return null;
  const m = subtitle.match(/chapter\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function storySlug(title, chapterNum) {
  if (chapterNum != null) return `chapter-${chapterNum}`;
  return slugify(title).slice(0, 60);
}

export async function extractStory(client, frontmatter, rawBody, filePath, db) {
  const prose = stripImages(rawBody);
  const chapterNumber = parseChapterNumber(frontmatter.subtitle);

  const prompt = `You are extracting canonical facts from a story chapter in the Superbear universe fiction.

Chapter title: ${frontmatter.title ?? '(untitled)'}
Subtitle: ${frontmatter.subtitle ?? ''}
Published: ${frontmatter.date ?? ''}
Source file: ${filePath}

Story text:
${prose}

Extract a summary, the key events in order, and the main POV characters.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'extract_story' },
    messages: [{ role: 'user', content: prompt }]
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  if (!toolUse) throw new Error(`No tool_use in response for ${filePath}`);
  const data = toolUse.input;

  const slug = storySlug(frontmatter.title ?? filePath, chapterNumber);
  const storyResult = upsert(db, 'stories', {
    slug,
    title: frontmatter.title ?? slug,
    chapter_number: chapterNumber,
    subtitle: frontmatter.subtitle,
    published_date: frontmatter.date ? String(frontmatter.date).slice(0, 10) : null,
    is_canonical: data.is_canonical ? 1 : 0,
    summary: data.summary,
    pov_characters: data.pov_character_names ? JSON.stringify(data.pov_character_names) : null,
    source_file: filePath
  }, 'slug');

  const storyId = storyResult.lastInsertRowid || db.prepare('SELECT id FROM stories WHERE slug = ?').get(slug).id;

  // Clear old events for this story on re-extraction
  db.prepare('DELETE FROM story_events WHERE story_id = ?').run(storyId);

  const VALID_EVENT_TYPES = new Set(['transformation','confrontation','revelation','relationship','rescue','corruption','other']);

  for (let i = 0; i < (data.events ?? []).length; i++) {
    const ev = data.events[i];
    const eventType = VALID_EVENT_TYPES.has(ev.event_type) ? ev.event_type : 'other';
    db.prepare(`
      INSERT INTO story_events (story_id, sequence_order, event_type, summary, characters_involved, location, significance, direct_quote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      storyId, i + 1, eventType, ev.summary,
      ev.character_names ? JSON.stringify(ev.character_names) : null,
      ev.location, ev.significance, ev.direct_quote ?? null
    );
  }
}
