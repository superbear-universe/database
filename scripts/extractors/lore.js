import { upsert, slugify } from '../db.js';

const MODEL = process.env.EXTRACT_MODEL ?? 'claude-haiku-4-5-20251001';

const TOOL = {
  name: 'extract_lore',
  description: 'Extract structured lore data from a Superbear universe document',
  input_schema: {
    type: 'object',
    properties: {
      lore_entry: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: ['mechanic', 'organization', 'history', 'relationship_rules'] },
          summary: { type: 'string', description: '2-4 sentence summary' }
        },
        required: ['title', 'category', 'summary']
      },
      bearing_rules: {
        type: 'array',
        description: 'Individual canonical rules about how bearing works. Extract each distinct rule as a separate item.',
        items: {
          type: 'object',
          properties: {
            rule_type: { type: 'string', enum: ['consent', 'corruption', 'mechanics', 'injury', 'love', 'restoration'] },
            bearing_form: { type: 'string', enum: ['normal', 'super_accidental', 'super_choice', 'corrupted', 'sir', 'any'] },
            rule_statement: { type: 'string', description: 'The canonical rule stated in one clear sentence' },
            elaboration: { type: 'string', description: 'Additional context or explanation' },
            exceptions: { type: 'string', description: 'Any exceptions or edge cases' }
          },
          required: ['rule_type', 'bearing_form', 'rule_statement']
        }
      },
      artifacts: {
        type: 'array',
        description: 'Named objects or items with special properties',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            current_holder_name: { type: 'string' },
            origin: { type: 'string' },
            function: { type: 'string' },
            current_state: { type: 'string', enum: ['active', 'destroyed', 'spent', 'inert'] },
            location: { type: 'string' },
            significance: { type: 'string' }
          },
          required: ['name', 'function']
        }
      },
      organizations: {
        type: 'array',
        description: 'Named groups or factions',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            leader_name: { type: 'string' },
            ideology: { type: 'string' },
            structure: { type: 'string', description: 'Describe the tier/rank structure' },
            recruitment: { type: 'string' },
            conversion_methods: { type: 'string' },
            known_member_names: { type: 'array', items: { type: 'string' } }
          },
          required: ['name']
        }
      }
    },
    required: ['lore_entry']
  }
};

export async function extractLore(client, frontmatter, sections, fullText, filePath, db) {
  // Strip any apparent AI artifacts (lines starting with "Perfect." or similar)
  const cleanedText = fullText.replace(/^Perfect\..+$/gm, '').trim();

  const prompt = `You are extracting canonical facts from a lore document for the Superbear universe fiction.

Document title: ${frontmatter.title ?? '(untitled)'}
Source file: ${filePath}

Full document text:
${cleanedText}

Extract:
- A lore_entry summary for this document
- bearing_rules: extract EACH distinct rule about how bearing works as a separate item (aim for thoroughness — this document may contain 10-20 rules)
- artifacts: any named objects with special properties (e.g. Power Bear Coffee, The Seal, harnesses)
- organizations: any named groups or factions (e.g. the Brotherhood)

Only extract information explicitly stated in the document.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'extract_lore' },
    messages: [{ role: 'user', content: prompt }]
  });

  const toolUse = response.content.find(c => c.type === 'tool_use');
  if (!toolUse) throw new Error(`No tool_use in response for ${filePath}`);
  const data = toolUse.input;

  const slug = slugify(data.lore_entry.title ?? frontmatter.title ?? filePath);
  upsert(db, 'lore_entries', {
    slug,
    title: data.lore_entry.title,
    category: data.lore_entry.category,
    summary: data.lore_entry.summary,
    full_text: cleanedText,
    source_file: filePath
  }, 'slug');

  for (const rule of data.bearing_rules ?? []) {
    if (!rule.rule_statement) continue;
    upsert(db, 'bearing_rules', {
      rule_type: rule.rule_type,
      bearing_form: rule.bearing_form,
      rule_statement: rule.rule_statement,
      elaboration: rule.elaboration,
      exceptions: rule.exceptions,
      source_file: filePath
    }, 'rule_statement');
  }

  for (const artifact of data.artifacts ?? []) {
    if (!artifact.name) continue;
    upsert(db, 'artifacts', {
      name: artifact.name,
      origin: artifact.origin,
      function: artifact.function,
      current_state: artifact.current_state,
      location: artifact.location,
      significance: artifact.significance,
      source_file: filePath
    }, 'name');
    // Store holder name for resolution after all characters are inserted
    const holderName = artifact.current_holder_name;
    if (holderName) {
      db.prepare('UPDATE artifacts SET current_holder = (SELECT id FROM characters WHERE lower(name) = lower(?) OR lower(alias) = lower(?)) WHERE name = ?')
        .run(holderName, holderName, artifact.name);
    }
  }

  for (const org of data.organizations ?? []) {
    if (!org.name) continue;
    upsert(db, 'organizations', {
      name: org.name,
      ideology: org.ideology,
      structure: org.structure,
      recruitment: org.recruitment,
      conversion_methods: org.conversion_methods,
      known_members: org.known_member_names ? JSON.stringify(org.known_member_names) : null,
      source_file: filePath
    }, 'name');
    // Resolve leader
    const leaderName = org.leader_name;
    if (leaderName) {
      db.prepare('UPDATE organizations SET leader_id = (SELECT id FROM characters WHERE lower(name) = lower(?) OR lower(alias) = lower(?)) WHERE name = ?')
        .run(leaderName, leaderName, org.name);
    }
  }
}
