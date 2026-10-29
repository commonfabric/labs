---
name: fuse-workflow
description: >
  Guide for hybrid workflows using CF FUSE filesystem mounting alongside the
  browser and CLI. Use when mounting spaces, editing cells via the filesystem,
  developing patterns for filesystem interaction, or combining browser +
  filesystem + CLI workflows. Triggers include "mount a space", "edit cells from
  filesystem", "use FUSE", "hybrid workflow", "filesystem sync", or working with
  pieces across both browser and CLI. For agent-specific patterns (deploying,
  activity logs, annotations), see the fuse-agent skill.
user-invocable: false
---

# FUSE Hybrid Workflows

**This workflow is evolving.** As we discover new dynamics, update this skill to
capture them. Offer to do so when patterns emerge that aren't documented here.

## What CF FUSE Does

Mounts a Common Fabric space as a local filesystem. Cells become files and
directories. Reads and writes are bidirectional — edit a file, the cell updates;
change a cell in the browser, the file updates within ~1 second.

## Quick Start

```bash
# Prerequisites
brew install --cask fuse-t          # macOS only, requires sudo

# Identity (reuse existing, or create a unique one with `id new`)
ls cf.key || deno run -A runtime/cli/mod.ts id new > cf.key

# Environment
export CF_API_URL=http://localhost:8000
export CF_IDENTITY=./cf.key

# Mount
deno task cf fuse mount /tmp/cf

# Explore a space (connects on demand — any name works)
ls /tmp/cf/home/pieces/
ls /tmp/cf/my-space/pieces/

# Unmount
deno task cf fuse unmount /tmp/cf
```

## Filesystem Layout

```
/tmp/cf/
  <space>/                        # connected on first access
    pieces/
      <piece-name>/
        meta.json                 # read-only: id, entityId, name
        input.json                # full input cell as JSON
        input/                    # exploded input — each key is a file or dir
          title                   # raw text (no quotes): "My Title"
          count                   # raw text: "42"
        result.json               # full result cell as JSON
        result/
          items/
            0/
              text                # raw text: "Buy milk"
              done                # raw text: "false"
            0.json                # atomic: {"text":"Buy milk","done":false}
          addItem.handler         # write-only: send JSON to trigger handler
      .index.json                 # name → entity ID mapping
    entities/                     # access by entity ID (on demand)
    space.json                    # { did, name }
  .spaces.json                    # known spaces
  .status                         # connection state
```

## Reading and Writing

```bash
# Read scalar
cat pieces/my-note/input/title           # => My Title

# Read JSON subtree
cat pieces/my-note/input.json            # => full input as JSON
cat pieces/my-note/result/items/0.json   # => single item as JSON

# Write scalar (type auto-detected: number, boolean, null, or string)
echo -n "New Title" > pieces/my-note/input/title

# Write JSON (atomic multi-field update)
echo '{"text":"Updated","done":true}' > pieces/my-note/result/items/0.json

# Trigger handler
echo '{"title":"New Item"}' > pieces/my-note/result/addItem.handler

# Create field
touch pieces/my-note/result/newField     # creates empty string
mkdir pieces/my-note/result/metadata     # creates empty object

# Delete field
rm pieces/my-note/result/oldField
rm -r pieces/my-note/result/items/0      # removes + re-indexes array
```

## The Hybrid Workflow

The power is in combining FUSE, CLI, and browser simultaneously:

### Deploy + Mount + Edit

```bash
# 1. Develop a pattern
deno task cf check patterns/my-app/main.tsx --no-run

# 2. Run its automated pattern tests
deno task cf test patterns/my-app/main.test.tsx

# 3. Deploy to a space with the tests attached
deno task cf piece new patterns/my-app/main.tsx \
  --test patterns/my-app/main.test.tsx -s my-space
# => Created piece bafyreia...

# 4. Mount and interact via filesystem
deno task cf fuse mount /tmp/cf
ls /tmp/cf/my-space/pieces/my-app/result/

# 5. Edit cells from terminal while viewing in browser
echo -n "Updated content" > /tmp/cf/my-space/pieces/my-app/input/title
# => Browser shows the change within ~1 second

# 6. Iterate on the pattern and retain its tests
deno task cf piece setsrc patterns/my-app/main.tsx \
  --test patterns/my-app/main.test.tsx --cell bafyreia...
# => Result updates in both browser AND filesystem
```

For multiple authored test entries, repeat `--test`. Run every entry locally
before deployment and repeat the complete flag set on every `setsrc`.

### Cross-Space Operations

```bash
# Copy data between spaces
cp /tmp/cf/space-a/pieces/notes/result/items.json /tmp/backup.json
cat /tmp/backup.json | jq '.' > /tmp/cf/space-b/pieces/notes/input/items.json

# Grep across an entire space
grep -r "TODO" /tmp/cf/my-space/pieces/*/result/content

# Diff two pieces
diff /tmp/cf/my-space/pieces/note-1/result/content \
     /tmp/cf/my-space/pieces/note-2/result/content
```

### Agent Workflows

Multiple agents can read/write cells via the filesystem while a human works in
the browser. Each agent sees the same live data:

```bash
# Agent reads a piece's state
cat /tmp/cf/my-space/pieces/assistant/result.json | jq '.messages'

# Agent writes to a handler
echo '{"message":"Hello from agent"}' > \
  /tmp/cf/my-space/pieces/assistant/result/sendMessage.handler

# Agent waits for a piece to reach a state. Resolve the entity ID once, then
# address the piece by it: a name gains a count suffix on every state change, so
# a pieces/<name>/... path goes stale on the very change being waited for. The
# entity ID is the piece ID, and it never changes.
ENTITY_ID=$(jq -r .entityId /tmp/cf/my-space/pieces/task/meta.json)

until [ "$(cat /tmp/cf/my-space/entities/$ENTITY_ID/result/status)" = "done" ]; do
  sleep 1
done
```

Wait on the condition and let the loop end when it holds, rather than printing
on a `while true` loop. This polls because no change-notification surface
through the mount is known to work — `fswatch` and `watchman` are untested
against FUSE-T. The loop cannot detect a dead transport, which stalls it
indefinitely; `.status` at the mount root reports `connection.disconnected`.

For a subscription rather than a poll, go through the runtime instead of the
filesystem: `cf piece render --cell <id> --watch` subscribes to the cell and
re-renders on each change. That surface renders UI, so it fits watching a piece
render rather than reading a single scalar.

### Pattern Development Loop

Combine pattern-dev with FUSE for a tight feedback loop:

```bash
# 1. Write pattern in patterns/my-pattern/main.tsx
# 2. Type check
deno task cf check patterns/my-pattern/main.tsx --no-run
# 3. Write and run automated pattern tests
deno task cf test patterns/my-pattern/main.test.tsx
# 4. Deploy with every test entry attached
deno task cf piece new patterns/my-pattern/main.tsx \
  --test patterns/my-pattern/main.test.tsx -s dev-space
# 5. Mount
deno task cf fuse mount /tmp/cf
# 6. Set input via filesystem (faster than cf cell set for complex data)
cat test-data.json > /tmp/cf/dev-space/pieces/my-pattern/input.json
# 7. Read result
cat /tmp/cf/dev-space/pieces/my-pattern/result.json | jq '.'
# 8. Iterate: edit, run tests, then setsrc with every --test flag
```

## Important Gotchas

### Identity Mismatch

The CLI identity key creates a _different space_ than the browser. If you deploy
with `cf.key` but browse with your browser identity, you'll see different
spaces.

**Fix:** Use the browser's space name when mounting:

```bash
# Find your browser space name from the URL or shell UI
ls /tmp/cf/2026-03-09-ben/pieces/   # connects on demand
```

### No `step` Needed via FUSE

Unlike `cf cell set` which requires `cf piece step` to trigger recomputation,
FUSE writes go through `cell.set()` directly, which triggers reactive updates
automatically.

### Writes Are Fire-and-Forget

FUSE returns success before the cell write completes. If toolshed is down or the
transport has disconnected, writes silently fail. Check the browser or re-read
the cell to confirm writes landed.

**Diagnosing silent write failures:** If writes succeed (no error) but values
revert or stay empty, check the FUSE log for transport errors:

```bash
tail -20 /tmp/ct-fuse-<mount-name>.log
# Look for: "ConnectionError: memory/v2 transport closed"
```

If the transport is dead, the FUSE process is running but can't commit to the
backend. Fix: unmount and remount:

```bash
cf fuse unmount /tmp/my-mount
cf fuse mount /tmp/my-mount --background
```

Long-running FUSE mounts (24h+) can lose their transport connection under
sustained agent load. Remount before each experiment run to be safe.

### FUSE-T Cache TTL

Changes from the browser appear in the filesystem within ~1 second (FUSE-T NFS
cache). Not instant. If you need to force a re-read, `cat` the `.json` file (not
the exploded directory).

FUSE-T mounts default to `attrcache-timeout=1`, which bounds all client-side
staleness (attributes, negative name lookups, directory listings) at about one
second — measured p99 read latency during daemon-side write storms is a few
milliseconds, with sub-second transients while a subtree rebuilds. If a mount
was created with `--attrcache-timeout 0` (untuned), a path stat'd while absent
can keep reporting `NotFound` for up to a minute and `ls` can be tens of seconds
stale; remount with the default before debugging "missing" files. See
`runtime/fuse/README.md` "macOS: NFS client cache tuning".

### Large Pieces

Pieces with large `$UI` trees or complex schemas produce huge `result.json`
files (100KB+). Reading them works but is slow. Prefer reading specific fields
via the exploded directory: `cat result/title` instead of `cat result.json`.

### Mount Stability

The FUSE daemon can crash if patterns throw uncaught errors during reactive
updates. If the mount stops responding but the process is still running:

```bash
pkill -f "runtime/fuse/mod.ts"
umount /tmp/cf 2>/dev/null
# Remount
deno task cf fuse mount /tmp/cf
```

### macOS Resource Forks

Finder and some macOS tools create `._` resource fork files. The FUSE mount
rejects these with EACCES. Use CLI tools, not Finder, to browse mounted spaces.

### Handler Invocation via FUSE

```bash
"MOUNT/SPACE/pieces/📝 Note Name/setTitle.handler" --value "New Title"
```

**Void handlers can be invoked with no args:**

```bash
"MOUNT/SPACE/pieces/Contact Book/result/onAddContact.handler"
```

Use `--value null` only if you specifically need the older explicit form.

**After ANY handler call — re-read pieces.json immediately:**

```bash
cat "MOUNT/SPACE/pieces/pieces.json"
# Piece names include count suffixes that update on every mutation:
# Reading List (0) → Reading List (1) → Reading List (2)
# All previously constructed FUSE paths are invalid after a mutation.
```

### Writing to `[FS]` note pieces

Use Read/Write/Edit tools directly on `index.md`. Never use handler invocation
for notes.

```
1. Read  "MOUNT/SPACE/pieces/📝 Note Name/index.md"  — capture frontmatter
2. Edit  targeted changes to body only, leaving frontmatter intact
   OR
   Write  full replacement — must include frontmatter (entityId + title from step 1)
```

**Preserve the frontmatter.** Losing `entityId` corrupts the piece.

### Input cell writes (Python pattern)

For bulk writes to input cell arrays (e.g. populating a Contact Book):

```python
import json

contacts = [
    {"name": "Alice", "email": "alice@example.com", "phone": "", "company": "",
     "tags": ["team"], "notes": "Context here", "createdAt": 1234567890000},
    # ...
]

try:
    open("MOUNT/SPACE/pieces/Contact Book/input/contacts.json", "w").write(
        json.dumps(contacts)
    )
except FileNotFoundError:
    pass  # FUSE close quirk — write succeeded despite the error

# Verify success:
import subprocess
result = subprocess.run(
    ["cat", "MOUNT/SPACE/pieces/Contact Book/result/contacts.json"],
    capture_output=True, text=True
)
data = json.loads(result.stdout)
print(f"{len(data)} contacts written")
```

**`input/` directory layout** — two things coexist, only one is the write
target:

- `input/contacts.json` — writable flat JSON array (**correct write target**)
- `input/contacts/` — directory of individual cell-slot files (read-only view)
- Writing to `input/contacts/N` does not work as expected

---

## Pattern Source: `.src/` Directory

Every piece exposes its pattern source under `.src/` in the FUSE mount. Read to
understand how a piece works; write to modify it live.

```
MOUNT/SPACE/pieces/My Piece/
  .src/
    main.tsx       ← pattern source — readable and writable
    data/
      cities.json  ← an attached data file — readable and writable
    error.log      ← synthetic, read-only — pattern execution errors
```

Every file of the deployed source package appears here at its stored path: the
entry, its imports, any attached test entries, and any attached data files.

**Read source:**

```bash
cat "MOUNT/SPACE/pieces/My Piece/.src/main.tsx"
```

**Temporarily modify live source for diagnosis** (use Python — shell redirect
fails on FUSE):

```python
path = "MOUNT/SPACE/pieces/My Piece/.src/main.tsx"
src = open(path).read()
# ... modify src ...
open(path, "w").write(modified_src)
# Write triggers setsrc automatically — no cf piece setsrc needed
```

FUSE preserves the existing attached test roots and data files during this
write, but it does not run the tests and cannot change which entries are
attached or which files are data. Editing a data file this way replaces its
bytes and leaves it a data file. Treat the live edit as a diagnostic experiment.
Before completing the change, make it in the repository checkout, run every test
against that changed source, and deploy it with explicit `cf piece setsrc` plus
the complete set of `--test` and `--datafile` flags.

**Check for errors after modifying:**

```bash
cat "MOUNT/SPACE/pieces/My Piece/.src/error.log"
# Empty = no errors; non-empty = compile or runtime error in new source
```

---

## Reference

- `runtime/fuse/mod.ts` — FUSE daemon entry point
- `runtime/fuse/cell-bridge.ts` — cell-to-filesystem bridge
- `runtime/fuse/tree-builder.ts` — JSON-to-tree conversion
- `docs/specs/fuse-filesystem/` — 7-part specification
- Use the `cf` skill, or read `skills/cf/SKILL.md`, for CLI command reference
- Use the `pattern-dev` skill, or read `skills/pattern-dev/SKILL.md`, for
  pattern development
