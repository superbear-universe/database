# Superbear Universe — Canonical Facts Database

Extracts structured facts from the Markdown source files in `source/` into a SQLite database, then exposes them to Claude via an MCP server.

## How it works

1. **Extraction** (`scripts/extract.js`) reads every character sheet, lore document, and story chapter, calls the Claude API to parse each one into structured data, and writes the results into `superbear.db`.
2. **MCP server** (`mcp-server/index.js`) connects to that database and exposes 11 query tools to Claude via the Model Context Protocol.

---

## Prerequisites

- Node.js 18 or later
- An Anthropic API key (only needed for extraction, not for the MCP server at runtime)
- Claude Desktop (to connect the MCP server)

---

## First-time setup

### 1. Install dependencies

```bash
cd database/scripts && npm install
cd database/mcp-server && npm install
```

### 2. Run extraction

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd database/scripts && node extract.js
```

This processes all files in `source/characters/`, `source/lore/`, and `source/stories/` and creates `database/superbear.db`. The script prints progress as it runs. Expect it to take a few minutes — it calls the Claude API once per file and paces itself to avoid rate limits.

To use a more capable model (default is `claude-haiku-4-5-20251001`):

```bash
EXTRACT_MODEL=claude-sonnet-4-6 node extract.js
```

### 3. Connect the MCP server to Claude Desktop

Add the following to `~/.config/Claude/claude_desktop_config.json` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "superbear-universe": {
      "command": "node",
      "args": ["/absolute/path/to/superbear/database/mcp-server/index.js"]
    }
  }
}
```

Replace the path with the actual absolute path on your machine. Then restart Claude Desktop. You should see the `superbear-universe` server listed as connected.

---

## Keeping the database up to date

### New or edited files

Re-run the extraction script. Files whose content hasn't changed are skipped automatically (hashes are stored in the `_extractions` table), so only new or modified files are re-processed.

```bash
cd database/scripts && node extract.js
```

To force re-extraction of all files regardless of changes:

```bash
node extract.js --force
```

### Deleted files

When source files are removed, run with `--sync` to prune their rows from the database:

```bash
node extract.js --sync
```

This combines a normal extraction run with a cleanup pass that removes any database records whose source file no longer exists on disk.

---

## Running the MCP server on Synology DSM (Web Station)

The MCP server is a plain HTTP process. On a Synology NAS you run it as a persistent background service via Task Scheduler, and optionally front it with a Web Station reverse proxy for HTTPS access.

### 1. Install Node.js

Open **Package Center**, search for **Node.js**, and install it (v18 or later).

### 2. Copy the files to the NAS

Copy the entire `database/` directory to a location on your NAS, for example:

```
/volume1/superbear/database/
```

You can use File Station, `rsync`, or SSH/SCP. Make sure `superbear.db` is present (run extraction locally first, then copy the `.db` file across, or run extraction directly on the NAS with an `ANTHROPIC_API_KEY`).

### 3. Install dependencies

SSH into the NAS and run:

```bash
cd /volume1/superbear/database/mcp-server
npm install
```

**If `npm install` fails with `gyp ERR! not found: make`**, DSM is missing the C build tools that `better-sqlite3` needs to compile from source. Two options:

**Option A — Build on another machine and copy**

`better-sqlite3` is a native addon, so the build machine's glibc must be the same version or older than the NAS's glibc. The safest way to guarantee this is to build inside a Docker container pinned to an older Debian release.

Synology DSM 7.x typically ships with glibc 2.28, so build inside a Debian 10 (Buster) container which targets that version:

```bash
docker run --rm \
  -v "$(pwd)/mcp-server:/app" \
  -w /app \
  node:22-buster \
  npm install
```

If you want to confirm the exact glibc version on your NAS first (`ldd` is not available on DSM), run this over SSH:

```bash
find /lib /lib64 -name "libc.so.6" 2>/dev/null -exec {} --version \; | head -1
```

Then copy the result to the NAS:

```bash
rsync -a mcp-server/node_modules/ admin@[NAS-IP]:/volume1/superbear/database/mcp-server/node_modules/
```

**Option B — Install build tools via Entware**

Entware can be bootstrapped directly over SSH without a package manager:

```bash
# Create a persistent home for Entware and symlink /opt to it
mkdir -p /volume1/@Entware/opt
mount -o bind /volume1/@Entware/opt /opt

# Download and run the bootstrap (x86-64 NAS)
wget -O /tmp/entware.sh https://bin.entware.net/x64-k3.2/installer/generic.sh
sh /tmp/entware.sh

# Add Entware binaries to PATH for this session
export PATH=/opt/bin:/opt/sbin:$PATH

# Install build tools
opkg update && opkg install make gcc binutils
```

Then re-run `npm install`. To make the `PATH` change and the `/opt` bind-mount persistent across reboots, add them to a boot-time Task Scheduler script (same place as the MCP startup task).

### 4. Create a boot-time startup task

1. Open **Control Panel → Task Scheduler**.
2. Click **Create → Triggered Task → User-defined script**.
3. Set:
   - **Task name:** `superbear-mcp`
   - **User:** the user that owns the files (e.g. your admin account)
   - **Event:** Boot-up
4. Under **Task Settings**, enter the script:

```bash
PORT=3000 \
SUPERBEAR_DB_PATH=/volume1/superbear/database/superbear.db \
SUPERBEAR_API_KEY=your-secret-key \
node /volume1/superbear/database/mcp-server/index.js &>> /volume1/superbear/mcp-server.log &
```

Replace `your-secret-key` with a strong random string. The `&>>` redirects logs to a file; the trailing `&` keeps it running in the background.

5. Click **OK**, then select the task and click **Run** to start it immediately without rebooting.

To verify it's running:

```bash
curl http://localhost:3000/mcp
# should return 405 Method Not Allowed (correct — POST is required)
```

### 5. (Optional) HTTPS via Web Station reverse proxy

If you want to expose the server over HTTPS (e.g. for remote access from Claude Desktop on another machine):

1. Open **Web Station → Web Service Portal → Create**.
2. Choose **Nginx** as the back-end server.
3. Under **Reverse Proxy**, set the backend to `http://localhost:3000`.
4. Assign a port (e.g. 443) and upload or provision a TLS certificate.

The MCP endpoint will then be at `https://[your-NAS-domain]/mcp`.

### 6. Connect Claude Desktop

Since the server is accessed over HTTP rather than launched as a child process, use the `url` form in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superbear-universe": {
      "url": "http://[NAS-IP]:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

For HTTPS via Web Station, replace the URL accordingly. Restart Claude Desktop after saving.

---

## Available MCP tools

Once the server is connected, Claude can use the following tools:

| Tool | Description |
|---|---|
| `list_characters` | All characters with a brief summary |
| `get_character(name)` | Full record for one character: appearance, psychology, transformations, relationships |
| `search_characters(query)` | Full-text search across character fields |
| `list_stories` | All stories/chapters ordered by chapter number |
| `get_story_events(chapter_or_title)` | Plot events from a chapter (e.g. `"5"` or `"origin of superbear"`) |
| `search_lore(query)` | Search lore documents and bearing rules |
| `get_bearing_rules(rule_type?)` | Canonical bearing rules, optionally filtered by type: `consent`, `corruption`, `mechanics`, `injury`, `love`, `restoration` |
| `get_artifact(name)` | Details about a named artifact (e.g. `"Power Bear Coffee"`, `"The Seal"`) |
| `get_organization(name)` | Details about a faction (e.g. `"Brotherhood"`) |
| `list_transformations(character_name?)` | All transformations, optionally filtered to one character |
| `search_facts(query)` | Global search across all content types at once |

---

## Database location

The database is written to `database/superbear.db` (relative to the repo root). The MCP server resolves this path automatically. To override it, set the `SUPERBEAR_DB_PATH` environment variable when starting the server.

---

## File structure

```
database/
├── superbear.db              generated by extraction
├── scripts/
│   ├── package.json
│   ├── schema.sql            table definitions and FTS5 indexes
│   ├── db.js                 shared SQLite helpers
│   ├── extract.js            extraction orchestrator
│   └── extractors/
│       ├── character.js      character sheet → characters, appearances, psychology
│       ├── lore.js           lore docs → lore_entries, bearing_rules, artifacts, organizations
│       └── story.js          story chapters → stories, story_events
└── mcp-server/
    ├── package.json
    └── index.js              MCP server with all 11 tools
```
