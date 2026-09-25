# @commonfabric/fuse

Mount Common Fabric spaces as a FUSE filesystem. Pieces appear as directories
with their cell data exploded into files and subdirectories — browse with `ls`,
read with `cat`, write with `echo`, execute mounted callables with `cf exec`,
and link pieces together with `ln -s`.

## Prerequisites

Install [FUSE-T](https://www.fuse-t.org/) (preferred) or
[macFUSE](https://osxfuse.github.io/) on macOS.

On Linux (Debian/Ubuntu), install FUSE plus the toolchain and runtime library
expected by this package:

```bash
sudo apt-get update
sudo apt-get install -y fuse3 libfuse3-dev pkg-config gcc
```

## Quick Start

```bash
# Mount your home space
cf fuse mount /tmp/cf

# In another terminal, explore
ls /tmp/cf/home/pieces/
cat /tmp/cf/home/pieces/todo-app/result.json
cat /tmp/cf/home/pieces/todo-app/result/items/0/text

# Unmount
cf fuse unmount /tmp/cf
```

## Filesystem Layout

```
/tmp/cf/                              # mount root
  home/                               # space (connected on demand)
    pieces/                            # named projections load on first access
      todo-app/                       # piece directory
        result.json                   # full result cell as JSON
        result/                       # exploded JSON tree
          title                       # file: My Todos
          count                       # file: 3
          items/                      # array → directory with numeric keys
            0/
              text                    # file: Buy milk
              done                    # file: false
            1/
              text                    # file: Walk dog
              done                    # file: true
          items.json                  # [{"text":"Buy milk","done":false}, ...]
          addItem.handler             # executable+writable mounted handler
          search.tool                 # executable mounted pattern tool
        input.json                    # full input cell as JSON
        input/                        # exploded input tree
          submit.handler              # handlers/tools can exist under input too
          search.tool
        meta.json                     # piece ID, entity, running pattern ref
      .index.json                     # piece name → entity ID mapping
      pieces.json                     # discovery manifest with pattern refs
    entities/                         # all live space entities, loaded lazily by ID
    space.json                        # { did, name }
  .spaces.json                        # known space name → DID mapping
```

### JSON Mapping

| JSON Type | Filesystem   | Content                   |
| --------- | ------------ | ------------------------- |
| `string`  | Regular file | Raw UTF-8 (no quotes)     |
| `number`  | Regular file | Decimal string            |
| `boolean` | Regular file | `true` or `false`         |
| `null`    | Regular file | Empty (0 bytes)           |
| `object`  | Directory    | Keys become child entries |
| `array`   | Directory    | `0`, `1`, ... entries     |

Every directory also has a `.json` sibling (e.g., `result/items.json`) that
returns the subtree as JSON. Top-level callable children under `input/` and
`result/` are replaced in these aggregate files with explicit sigils:
`{"/handler":"name"}` and `{"/tool":"name"}`.

## Walkthrough

### Reading

```bash
# List registered pieces in a space
ls home/pieces/

# Read the full result cell as JSON (pipe to jq for pretty printing)
cat home/pieces/todo-app/result.json | jq .

# Read individual fields
cat home/pieces/todo-app/result/title
# => My Todos

cat home/pieces/todo-app/result/items/0/text
# => Buy milk

# Read a nested subtree as JSON
cat home/pieces/todo-app/result/items.json
# => [{"text":"Buy milk","done":false},{"text":"Walk dog","done":true}]

# Check the JSON type via extended attributes
xattr -p user.json.type home/pieces/todo-app/result/count
# => number

# View piece metadata
cat home/pieces/todo-app/meta.json
# => {"id":"of:ba4j...","entityId":"ba4j...","name":"todo-app","patternRef":{"identity":"<hash>","symbol":"default","source":{"ref":"cf:pattern:<hash>","repository":"https://github.com/commonfabric/labs","entry":"/packages/patterns/todo-app.tsx"}}}

# Mounted callables are executable and start with a cf exec shebang
head -n1 home/pieces/todo-app/result/addItem.handler
head -n1 home/pieces/todo-app/result/search.tool

# Aggregate JSON hides callable internals behind explicit sigils
cat home/pieces/todo-app/result.json | jq '.addItem, .search'
# => {"/handler":"addItem"}
# => {"/tool":"search"}
```

The named directories under `pieces/` come from the space's piece registry. They
do not include unregistered or orphan pieces. The `entities/` directory can
enumerate live entity IDs when the server supports identifier listing, but it
does not identify which entities are piece roots. See
[Finding Pieces](../../docs/common/concepts/piece-discovery.md).

The prefix-free `patternRef.identity` + `patternRef.symbol` are the
authoritative reference to the artifact currently running the piece
(`cf:module/<identity>#<symbol>` in display form). `patternRef.source.ref` is
the immutable in-fabric source reference. Optional `source.repository` records
the explicitly supplied repository locator, `source.entry` preserves the
authored path within the compilation root, and `source.origin` carries the
piece's update provenance. The same object appears in `pieces/pieces.json` for
bulk discovery.

### Writing

```bash
# Write a scalar value (type is inferred: number, boolean, or string)
echo -n "Updated title" > home/pieces/todo-app/result/title
echo -n "42" > home/pieces/todo-app/result/count      # writes number 42
echo -n "true" > home/pieces/todo-app/result/done      # writes boolean true

# Replace an entire subtree via .json file
echo '{"text":"New item","done":false}' > home/pieces/todo-app/result/items/0.json

# Replace the whole result cell
echo '{"title":"Fresh","items":[],"count":0}' > home/pieces/todo-app/result.json

# Invoke a stream handler (fire-and-forget)
echo '{"text":"Buy oat milk"}' > home/pieces/todo-app/result/addItem.handler

# Execute the same mounted handler with schema-derived CLI flags
cf exec home/pieces/todo-app/result/addItem.handler invoke --text "Buy oat milk"

# Run a mounted pattern tool (tool input flags come from the pattern schema)
cf exec home/pieces/todo-app/result/search.tool --query "oat milk"

# Or execute either mounted callable directly through its shebang shim
home/pieces/todo-app/result/addItem.handler invoke --text "Buy oat milk"
home/pieces/todo-app/result/search.tool --query "oat milk"

# Top-level help describes the mounted callable instead of invoking it
cf exec home/pieces/todo-app/result/search.tool --help

# The same callable paths also exist under entities/<piece-id>/
cf exec home/entities/of:ba4j.../result/search.tool --query "oat milk"
```

Source-file writes normally preserve the same schema-compatibility guarantees as
`cf piece setsrc`. For an intentional breaking migration, mount with
`--dangerously-allow-incompatible-schema`; source writes through that mount then
bypass the old-to-new pattern and retained-link compatibility proofs.

### Creating and Deleting

```bash
# Create a new key (empty string value)
touch home/pieces/todo-app/result/newField

# Create a new nested object
mkdir home/pieces/todo-app/result/metadata

# Delete a key
rm home/pieces/todo-app/result/oldField

# Delete an array element (re-indexes remaining elements)
rm -r home/pieces/todo-app/result/items/0

# Rename a key
mv home/pieces/todo-app/result/oldName home/pieces/todo-app/result/newName
```

### Symlinks (Cell References)

Cell references (sigil links) appear as symlinks. Creating a symlink writes a
sigil link into the parent cell.

```bash
# Link a field to another piece's input
ln -s ../../other-piece/input/foo home/pieces/todo-app/result/ref

# See where a reference points
ls -l home/pieces/todo-app/result/related
# => related -> ../../entities/ba4jcbvpq3k5.../
```

### Multiple Spaces

Spaces are connected on demand — just `cd` into any space name:

```bash
ls home/pieces/          # connects "home" space automatically
ls work/pieces/          # connects "work" space on first access
cat .spaces.json         # shows all connected spaces
```

You can also access spaces by DID:

```bash
ls "did:key:z6Mkk.../pieces/"
```

## CLI Commands

```bash
# Mount (foreground — Ctrl+C to unmount)
cf fuse mount /tmp/cf

# Mount in background
cf fuse mount /tmp/cf --background

# Linux: export the mount so Docker/root can traverse it
cf fuse mount /tmp/cf --allow-other

# Check active mounts
cf fuse status

# Unmount
cf fuse unmount /tmp/cf

# With explicit connection settings
cf fuse mount /tmp/cf --api-url http://localhost:8000 --identity ./my.key

# Show callable help from the mounted schema
cf exec /tmp/cf/home/pieces/todo-app/result/search.tool --help
```

Environment variables `CF_API_URL` and `CF_IDENTITY` are also supported.

`cf fuse status` reports background mounts with separate supervisor and FUSE
child process IDs:

```text
MOUNTPOINT  SUPERVISOR_PID  CHILD_PID  STATUS   STARTED  LOG
/tmp/cf     12345           12346      mounted  ...      /tmp/cf-fuse-cf.log
```

For background mounts, `cf fuse mount --background` starts a small supervisor
process that does not load libfuse. The supervisor starts the FFI-owning FUSE
child, records the child PID in mount state, and waits for the child to publish
a readiness sidecar before the mount command reports success. The child writes
`starting`, `mounted`, `failed`, `exiting`, and `exited` states plus a mounted
heartbeat; startup succeeds only when the status matches the current mount
attempt and recorded child PID.

The `STATUS` column is no longer taken from the heartbeat/child-status sidecar
alone — it is now gated on the OS mount table (`getfsstat` on darwin,
`/proc/mounts` on linux), the kernel's own ground truth. A wedged daemon keeps
answering liveness probes and its sidecar keeps saying `mounted`, so the sidecar
by itself can lie. Two consequences: a PID-alive entry whose mountpoint is
absent from the table is reported `dead` (the daemon outlived its mount), and a
dead-PID entry still present in the table is shown as `dead` and kept (not
swept) so the stale kernel mount stays visible for cleanup. Only an entry that
is both absent from the table and has no live process is swept. If the table
cannot be read, the row is reported `unknown` and preserved rather than
destroyed.

### Linux: Docker / other-user access

If you need Docker or another user to traverse a Linux FUSE mount, mount with:

```bash
cf fuse mount /tmp/cf --allow-other
```

This enables `allow_other` together with `default_permissions`. The host must
also have `user_allow_other` enabled in `/etc/fuse.conf`.

Handlers remain writable through the mounted `.handler` file. Both mounted
`.handler` and `.tool` files can be executed directly or via `cf exec`.

### macOS: NFS client cache tuning

FUSE-T serves the mount through the macOS NFS client, which caches attributes,
negative name lookups, and directory listings on the client side. Neither lever
a FUSE filesystem normally has reaches that cache: FUSE-T ignores the cache
timeouts the filesystem implementation returns, and it returns success for the
invalidation notifications without acting on them. So without tuning, the
client's age-based 5-60 second defaults apply: a name that was once looked up
and not found can keep reporting `NotFound` for up to a minute after the file
appears daemon-side, and a directory listing can be served stale for tens of
seconds.

FUSE-T mounts therefore default to `attrcache-timeout=1`, which fixes every NFS
attribute-cache window at one second. Measured against a live space (FUSE-T
1.2.7, macOS 26): the stale-`NotFound` window drops from 3-56 seconds to under
half a second, listing staleness drops the same way, stats stay cache-served
(about 2 microseconds each), and sustained daemon-side write storms produce zero
read errors through the mount.

Two flags adjust this; both take effect on macOS/FUSE-T mounts only and are
ignored on Linux and macFUSE, and they are mutually exclusive:

```bash
# Bound cache validity to N whole seconds (default 1). 0 disables the
# tuning and keeps the NFS client's age-based 5-60 second caching.
cf fuse mount /tmp/cf --attrcache-timeout 5
cf fuse mount /tmp/cf --attrcache-timeout 0

# Mount with FUSE-T's noattrcache option instead. On current FUSE-T this
# maps to the NFS nonegnamecache flag: negative name lookups are never
# cached, while positive attribute caching keeps the client defaults.
cf fuse mount /tmp/cf --noattrcache
```

`--attrcache-timeout` relies on a FUSE-T mount option that is present in the
FUSE-T source and release notes but absent from its wiki's option list. The
option was added in FUSE-T 1.0.29 (October 2023); on older FUSE-T installs mount
with `--attrcache-timeout 0` if the default is not accepted. `--noattrcache`
bounds only the negative-lookup staleness; measured on the same stack it left
multi-second stale-`NotFound` windows (the directory attribute cache still
serves the old listing), so prefer the timeout for freshness-sensitive
workloads.

### CFC Annotations

A local FUSE daemon mount can be writable according to its CFC mode and
writeback configuration. Supplying that mount to `cf-harness --fabric-mount`
does not expose the writable path: cf-harness binds the projection read-only at
`/fabric` for browsing and context. The daemon and harness read their mode
settings independently, and no mode admits writes through the harness bind.
Writable harness admission requires a trusted protected transport and atomic
runner commit that are not currently available.

`cf fuse mount --cfc-mode=<mode>` selects the FUSE-side CFC guardrail mode:
`disabled`, `observe`, `enforce-explicit`, or `enforce-strict`. `CF_CFC_MODE`
names the mode when the flag does not. A mount that names a mode nowhere runs at
`enforce-strict`, the rung the first-party presets pin: a mount is a write path
into a real space. A name outside those four is rejected from whichever of the
two named it, and the mount does not start. `observe` and both enforcing modes
publish annotations automatically. `--cfc-annotations` still forces annotation
output for local debugging even when the mode is `disabled`.

By default the local mount exposes both the protected namespace `trusted.cfc.*`
and the compatibility namespace `user.commonfabric.cfc.*`. Use
`--cfc-xattr-namespace=trusted|compat|both` to select the returned spelling;
unknown namespace values are rejected. `trusted.cfc.*` is the enforcement
namespace; `user.commonfabric.cfc.*` is for local compatibility/debugging and
must not be trusted as sandbox enforcement input. `trusted.cfc.generation` is
returned as a raw UTF-8 string. Other CFC annotation values are canonical JSON
with sorted object keys.

Prepared writeback is scaffolded for existing-file writes, `create`/`mkdir`,
`unlink`/`rmdir`, same-cell `rename`, Common Fabric sigil symlink creation, and
metadata-only `setattr` attempts such as chmod/chown/timestamp updates. In
`observe`, missing prepare metadata is logged and writes continue. In
`enforce-explicit`, annotated targets and annotated parent directories require
trusted prepare metadata. In `enforce-strict`, projected writes fail closed when
annotations or prepare metadata are missing, malformed, or stale. Direct
pre-gVisor testing can enable the temporary xattr prepare/finalize path with
`--cfc-writeback-xattrs`; this accepts `trusted.cfc.writeback.prepare` and
`trusted.cfc.writeback.finalize`, plus their `user.commonfabric.cfc.*`
compatibility spellings for host transports that cannot carry `trusted.*`
xattrs. It is not a sandbox trust boundary. Prepared/fail-closed writeback
records are persisted outside the mount so a daemon restart or subtree rebuild
can reconcile them without exposing lower labels. Use
`--cfc-writeback-state=<path>` to choose the recovery file; otherwise CFC modes
use a mountpoint-derived file under `$CF_CFC_WRITEBACK_STATE_DIR`,
`$XDG_STATE_HOME/commonfabric-fuse`, or `~/.cache/commonfabric-fuse`, in that
order. The mount `.status` file includes a `cfc` section with writeback phase
counts and recent diagnostics.

Arbitrary symlink targets and callable-send writeback are still out of scope for
CFC enforcing modes and are rejected there. gVisor remains responsible for
sandbox-visible enforcement.

## Architecture

Foreground `cf fuse mount` starts one FFI-owning FUSE child process and waits
for it without adding a supervisor; direct `deno run packages/fuse/mod.ts` is a
single-process invocation of the same child entrypoint. Background mounts split
lifecycle management into a non-FFI supervisor process and an FFI-owning FUSE
child process so supervisor cleanup and startup readiness can be observed
independently from libfuse. FUSE callbacks are registered via
`Deno.UnsafeCallback` with `nonblocking: true` on the session loop, so WebSocket
subscriptions and FUSE requests run concurrently on Deno's event loop.

Cell data is cached in an in-memory tree (`FsTree`). On a cell change the
affected piece property is rebuilt by reconciling a freshly built subtree onto
the live one in place, so a path that still exists keeps its inode across the
rebuild. The rebuild then asks the kernel to drop only what actually went stale,
naming the changed directory entries with `fuse_lowlevel_notify_inval_entry` and
the inodes whose content changed with `fuse_lowlevel_notify_inval_inode`; caches
for unchanged paths are left intact.

Those notifications reach the kernel on Linux. FUSE-T returns success for both
calls but its NFS backend does not act on either, so a rebuilt subtree stays
cached on macOS until the NFS client's attribute cache expires. That is what the
mount's attribute-cache bound is for; see
[macOS: NFS client cache tuning](#macos-nfs-client-cache-tuning).

Writes are fire-and-forget: the FUSE reply is sent before the cell write
completes, so subscription rebuilds don't block the callback chain (required to
avoid FUSE-T crashes from `notify_inval_entry` during callbacks).

### The `.status` file

`.status` at the mount root reports the daemon's API URL, debug flag, connection
state, per-space materialized piece counts, subtree rebuild metrics, write
statistics, and a `cfc` section carrying writeback phase counts and recent
diagnostics. Each space has a `piecesLoaded` flag. Its piece count remains zero
until the named `pieces/` projection is first accessed.

The file is generated rather than written. `CellBridge.initStatus` registers it
with `FsTree.addGeneratedFile`, giving the tree a function that renders the JSON
from the daemon's current state. Nothing on the write path refreshes it, and no
counter has to be published before a reader can see it: a flush increments
`writeStats.flushed` and stops there.

`FsTree.refreshGenerated` runs the renderer and publishes the result as the
node's content, and the callbacks that report the file's size call it —
`replyEntry` and `getattr`. Reads serve the bytes that were published, never
rendered per read. This is what keeps a reader from seeing a partial document: a
client stops a read at the size it was last given, so bytes from a render that
grew since then would be cut off at that size, and bytes from one that shrank
would be padded out to it with NULs. Publishing where the size is reported keeps
the two halves of that answer from one render.

`open` then fixes those published bytes into the descriptor's handle, and every
read on the descriptor serves them. A reader that has consumed the whole file
issues one more read to see EOF, which a newer, longer render would otherwise
answer with a spliced tail. A getattr carrying a descriptor reports that
descriptor's snapshot length and its publish time both, so a stat from elsewhere
cannot move the size or the modification time out from under a read in progress.

Publishing bumps the node's mtime whenever the rendered bytes change, so a
generated file reports when its content last changed while the rest of the mount
reports the epoch. A status counter can change without changing the document's
length, and a client that validates its cached copy against the timestamp and
the size would otherwise keep serving what it holds — on macOS an NFS client
returning a frozen `.status`, on Linux a page cache that is never invalidated.
The moving mtime is what tells both to re-read. macOS still bounds how soon that
happens by the mount's attribute-cache option, for the same reason rebuilt
subtrees are; see
[macOS: NFS client cache tuning](#macos-nfs-client-cache-tuning).

See [RELIABILITY_DESIGN.md](./RELIABILITY_DESIGN.md) for the package-local plan
to move default mutating operations toward commit-confirmed replies, bounded
deadlines, explicit backpressure, and watchdog/degraded-mode behavior while
preserving normal filesystem semantics.

## Troubleshooting

### FUSE not found / `Could not open libfuse`

Install a FUSE provider:

```bash
# FUSE-T (recommended — no kernel extension required)
brew install fuse-t

# or macFUSE (requires allowing a kernel extension in System Settings)
brew install --cask macfuse
```

After installing macFUSE, go to **System Settings > Privacy & Security** and
allow the kernel extension. A reboot may be required.

### Mount point is not empty / stale mount

If a previous FUSE process crashed, the mount point may be stale:

```bash
umount /tmp/cf          # macOS
# or
fusermount -u /tmp/cf   # Linux

# If umount fails with "not currently mounted" but the dir looks broken:
diskutil unmount force /tmp/cf   # macOS last resort
rm -rf /tmp/cf && mkdir /tmp/cf
```

### `ls` shows stale directory contents

FUSE-T uses NFS under the hood, so the kernel may cache directory listings
briefly. New pieces should appear within 1-2 seconds. If `ls` still shows stale
data:

```bash
# Force a fresh listing (bypass shell hash)
command ls /tmp/cf/home/pieces/

# Or use a stat-based tool
find /tmp/cf/home/pieces/ -maxdepth 1
```

If stale listings or stale `NotFound` results are a recurring problem for a
workload, mount with `--noattrcache` or `--attrcache-timeout` (see
[macOS: NFS client cache tuning](#macos-nfs-client-cache-tuning)).

### Permission denied / Operation not permitted

The Deno process needs FFI and file access:

```bash
deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  packages/fuse/mod.ts /tmp/cf ...
```

If using `cf fuse mount`, these permissions are set automatically.

### `Resource fork` / `._*` files from macOS

macOS Finder creates `._` resource fork files. These are silently rejected by
the filesystem (EACCES). This is expected — use the terminal, not Finder.

### Writes not persisting

Writes are fire-and-forget. If the toolshed is down, writes silently fail. Check
`cf fuse status` or verify the toolshed is reachable:

```bash
curl http://localhost:8000/api/storage/memory
# Should return a JSON error (WebSocket endpoint), not HTML
```

### Debug mode

Add `--debug` for verbose FUSE operation logging:

```bash
cf fuse mount /tmp/cf --debug
# or
deno run ... packages/fuse/mod.ts /tmp/cf --debug
```

## Direct Invocation

You can also run the FUSE filesystem directly without the CLI:

```bash
deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
  packages/fuse/mod.ts /tmp/cf --api-url http://localhost:8000
```
