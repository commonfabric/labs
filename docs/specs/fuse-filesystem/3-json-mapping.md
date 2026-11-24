# 3. JSON-to-Filesystem Mapping

The core design problem: cells contain arbitrary JSON. The filesystem must
represent this as files and directories.

## Mapping Rules

| JSON Type  | Filesystem Representation | Content Format           |
| ---------- | ------------------------- | ------------------------ |
| `string`   | Regular file              | Raw UTF-8 string (no quotes, no newline) |
| `number`   | Regular file              | Decimal string representation |
| `boolean`  | Regular file              | `true` or `false`        |
| `null`     | Regular file              | Empty file (0 bytes)     |
| `object`   | Directory                 | Keys become child entries |
| `array`    | Directory                 | Indices (`0`, `1`, ...) become child entries |

### Scalars as Files

Scalar values are stored as their natural string representation without JSON
encoding. This makes `cat` output human-readable:

```bash
cat result/title    # => My Todos     (not "My Todos")
cat result/count    # => 42           (not 42 — same either way)
cat result/done     # => true
cat result/empty    # => (empty)
```

Strings do **not** include a trailing newline. This preserves round-trip
fidelity: the bytes in the file are exactly the string value. Tools that
add newlines (like `echo`) require `-n` for correct writes.

### Objects as Directories

Each key becomes a child entry. The entry is a file or subdirectory depending
on the value type:

```
result/            # {"title": "My Todos", "count": 3, "meta": {"v": 1}}
  title            # file: My Todos
  count            # file: 3
  meta/            # directory
    v              # file: 1
```

### Arrays as Directories

Array indices become numeric directory entries:

```
result/items/      # [{"text": "Buy milk"}, {"text": "Walk dog"}]
  0/
    text           # file: Buy milk
  1/
    text           # file: Walk dog
```

## Special System Fields

Patterns use symbol-keyed fields to declare metadata and capabilities. These
fields begin with `$` and are treated specially by the filesystem projection.

### `$NAME` — Piece Display Name

`$NAME` is a string computed by the pattern used as the piece's filesystem
directory name. It is not surfaced as a file in the piece directory.

### `$UI` — UI Tree

`$UI` holds a `VNode` — a virtual DOM tree potentially thousands of nodes
deep. Exploding this into a directory tree would flood the filesystem with
noise and make `grep` and `ls` unusable.

Instead, `$UI` is serialized as a single `$UI.json` file. It is skipped
during recursive directory expansion and written once as a compact JSON
snapshot. It is readable but not writable (the UI is computed).

### `$FS` — Filesystem Projection

`$FS` declares how the pattern wants its result represented on disk. When
present it is consumed entirely to produce `index.md` or `index.json` at
the piece root; it does not appear as a file in the result tree.

See [Filesystem Projections](./8-fs-projections.md) for full details.

### `$TYPE` — Pattern Type Tag

`$TYPE` is an internal tag used for type-based discovery. Not surfaced as a
file.

## The `.json` Sibling Convention

Every directory (object or array) has a corresponding `.json` file that provides
the full JSON representation of that subtree. This is essential for:

- Reading an entire object/array as structured data
- Writing structured data back atomically
- Tools that expect JSON input (`jq`, programmatic access)

### Rules

1. For any path `P` that resolves to an object or array, `P.json` returns
   the JSON-serialized value.
2. For the root of a cell, the `.json` file lives alongside the directory:
   - `result.json` — full JSON of the result cell
   - `result/` — directory view of the same data
3. For nested paths, `.json` is a virtual file inside the parent:
   - `result/items.json` — JSON array of all items
   - `result/items/` — directory with `0/`, `1/`, etc.
4. Writing to a `.json` file replaces the entire subtree with the parsed
   JSON value.
5. A `.json` file spells out 128 levels of nested objects and arrays beneath
   itself. Anything below that is written as the string
   `"[Max depth exceeded]"`.
6. A value that appears twice along the same chain of parents — a circular
   reference — is written as the string `"[Circular]"`.

### Nesting Depth

The 128-level bound is measured from the value each `.json` file holds, not
from the root of the piece. A directory at every level of the data carries its
own `.json` sibling, so data below the bound stays readable through the `.json`
sibling of a directory closer to it:

```bash
# Spells out 128 levels from the result root, and marks what is below them.
cat result.json

# Spells out 128 levels from `deeply/nested/value` instead.
cat result/deeply/nested/value.json
```

The directory tree itself is not bounded. Every level of the data has its
directory entry and its leaf files, however deep the nesting goes, so no value
is unreachable — only the aggregate views of it are abbreviated.

Because a truncated `.json` file does not carry the whole subtree, writing one
back replaces the elided part with the marker string. Write to a `.json` file
closer to the data, or to the leaf files, to change something below the bound.

### Callable Sigils In Aggregate JSON

Top-level callable children under `input/` and `result/` are compacted in
aggregate `.json` views instead of exposing their internal runtime structure.

- Mounted handlers become `{"\/handler":"<name>"}`
- Mounted pattern tools become `{"\/tool":"<name>"}`

Example:

```json
{
  "title": "My Todos",
  "addItem": {"/handler":"addItem"},
  "search": {"/tool":"search"}
}
```

This keeps `result.json`, `input.json`, and nested `.json` siblings stable and
human-readable while the real callable entry remains available as
`addItem.handler` or `search.tool`.

### Example

```
pieces/todo-app/
  result.json              # {"items":[...],"count":3}
  result/
    items.json             # [{"text":"Buy milk","done":false},...]
    items/
      0.json               # {"text":"Buy milk","done":false}
      0/
        text               # Buy milk
        done               # false
    count                  # 3
```

### Reading

```bash
# Structured access
cat result.json | jq '.items[0].text'

# Leaf access
cat result/items/0/text
```

### Writing

```bash
# Replace entire result
echo '{"items":[],"count":0}' > result.json

# Replace a single item
echo '{"text":"Updated","done":true}' > result/items/0.json

# Replace a leaf
echo -n "Updated text" > result/items/0/text
```

## Type Preservation on Write

When writing to a scalar file, the filesystem must infer the JSON type:

1. If the content is valid JSON and parses to a non-string type, use that type.
   - `true` / `false` -> boolean
   - `null` -> null
   - Numeric string -> number (if valid finite JSON number)
2. Otherwise, treat as string.

This means:
- `echo -n "42" > count` sets the JSON value to `42` (number)
- `echo -n "hello" > title` sets it to `"hello"` (string)
- `echo -n "true" > done` sets it to `true` (boolean)
- `echo -n '"quoted"' > title` sets it to `"quoted"` (string, quotes stripped)

The `.json` files bypass inference entirely — content is parsed as JSON.

## Type Disambiguation

When reading, the JSON type is not always obvious from the file content. The
filesystem exposes type information via **extended attributes** (xattrs):

```bash
xattr -p user.json.type result/count        # => number
xattr -p user.json.type result/title        # => string
xattr -p user.json.type result/done         # => boolean
xattr -p user.json.type result/items        # => array
xattr -p user.json.type result/items/0      # => object
```

On macOS, use `xattr -p` to read these. On Linux, use `getfattr`.

## Special Values

### Cell References (Sigil Links) as Symlinks

When a cell value contains a reference to another cell, the filesystem
represents it as a **symlink**. This is bidirectional — reading a sigil link
produces a symlink, and creating a symlink writes a sigil link.

#### Sigil Link Structure

A sigil link in cell data looks like:

```json
{ "/": { "link@1": { "id": "of:ba4j...", "path": ["items", "0"], "space": "did:key:z6Mkk..." } } }
```

The fields are:
- `id` — target entity ID (optional; defaults to containing entity)
- `path` — JSON path within the target entity (optional; defaults to root)
- `space` — target space DID (optional; defaults to same space)

#### Reading: Sigil Link -> Symlink

The filesystem maps each sigil link field to a filesystem path component:

```
<mountpoint>/<space>/<view>/<entity-or-piece>/<path...>
```

**Same-space, entity-only** (most common):

```json
{ "/": { "link@1": { "id": "of:ba4jcbvpq3k5..." } } }
```
```
result/related -> ../../entities/of:ba4jcbvpq3k5.../
```

**Same-space, entity + path:**

```json
{ "/": { "link@1": { "id": "of:ba4jcbvpq3k5...", "path": ["items", "0", "text"] } } }
```
```
result/related -> ../../entities/of:ba4jcbvpq3k5.../items/0/text
```

**Cross-space:**

```json
{ "/": { "link@1": { "id": "of:ba4j...", "space": "did:key:z7Nll..." } } }
```
```
result/related -> ../../../did:key:z7Nll.../entities/of:ba4j.../
```

Cross-space symlinks may be broken if the target space hasn't been accessed
yet. This is informative, not an error — `ls -l` shows the target, and
accessing the symlink triggers lazy space resolution.

**Self-referencing (id omitted):**

When `id` is absent, the link refers to a path within the same entity. The
symlink is relative within the same entity directory:

```json
{ "/": { "link@1": { "path": ["settings", "theme"] } } }
```
```
result/config -> settings/theme
```

#### Writing: Symlink -> Sigil Link

Creating a symlink (`ln -s`) writes a sigil link into the parent cell:

```bash
# Link a field to another entity
ln -s ../../entities/of:ba4jcbvpq3k5.../ result/related

# Link to a specific path in another entity
ln -s ../../entities/of:ba4jcbvpq3k5.../items/0 result/source

# Cross-space link
ln -s ../../../other-space/entities/of:ba4j.../ result/external
```

The filesystem parses the symlink target path to extract `(space, id, path)`,
then writes the corresponding sigil link:

```json
{ "/": { "link@1": { "id": "of:ba4jcbvpq3k5...", "path": ["items", "0"] } } }
```

**Parsing rules:**

1. The target must be a relative path within the mountpoint (absolute paths
   and paths escaping the mountpoint are rejected with `EINVAL`).
2. The path is resolved relative to the symlink's parent directory to find
   which space, entity, and JSON path it points to.
3. Fields that match the current context are omitted: if the target is in
   the same space, `space` is omitted. If no JSON path, `path` is omitted.

**Overwriting existing values:** Creating a symlink at a path that already
has a value (file or directory) replaces that value with the sigil link. The
old value is lost — this is equivalent to `cell.set()` at that path.

#### Symlink + `.json` Interaction

Reading the `.json` sibling of a path that contains a symlink returns the
raw sigil link JSON, not the resolved target value:

```bash
cat result/related.json
# => {"/":{\"link@1\":{\"id\":\"of:ba4jcbvpq3k5...\"}}}
```

Writing a sigil link JSON to a `.json` file also works — this is an
alternative to `ln -s` for programmatic use:

```bash
echo '{"/":{\"link@1\":{\"id\":\"of:ba4j...\"}}}' > result/related.json
```

### Callable Markers

Top-level callable children under `input/` and `result/` are surfaced as
synthetic files and are replaced with explicit sigils in the aggregate `.json`
siblings for those directories:

```json
{
  "addItem": { "/handler": "addItem" },
  "search": { "/tool": "search" }
}
```

- `{"\/handler":"name"}` means the mounted filesystem exposes `name.handler`
- `{"\/tool":"name"}` means the mounted filesystem exposes `name.tool`
- only top-level callable children are rewritten this way; nested ordinary data
  is serialized as-is

Mounted callable files are readable and executable. Each is a shell script
whose first line is `#!/bin/sh` and whose last line runs
`cf exec <mounted-callable-file> "$@"`, so running the file directly and running
`cf exec` on it both resolve the backing callable schema and execute it. The
shell runs the launcher rather than the shebang naming it, because a shebang
line ends its interpreter at the first space and the launcher's path may hold
one.

Callable files also embed the handler's input schema as readable comments:

```sh
#!/bin/sh
# schema: {"type":"string"}
# input: string
exec '/path/to/cf-exec' exec "$0" "$@"
```

Reading the file with `cat` or `head` reveals the expected input type before
invoking. For compound types, `# input:` shows a TypeScript-ish shape such
as `{ detail: { value: string } }`. Handlers with no payload show `void`.

---

**Previous:** [Path Scheme](./2-path-scheme.md) | **Next:** [Read/Write Semantics](./4-read-write.md)
