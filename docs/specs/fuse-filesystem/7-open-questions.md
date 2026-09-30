# 7. Open Questions

## Filesystem Design

### Space Discovery

The mount root lists only discoverable spaces (`home` always, plus whatever
the home space's space list provides in the future). Other spaces are
accessible by name or DID on demand through `lookup`. After the
[random space identity cutover](../../plans/random-space-identities.md) a name
still resolves, by the derivation that survives as a resolver, but resolving one
creates nothing: a name whose space has no history opens nothing. The dormant
[Common Fabric URL](../fabric-urls.md) concept could supply another mapping, but
no such resolver is planned for deployment.

Open questions:
- When the home space gains a space list, what does the data look like?
  The FUSE layer needs to know how to extract space names/DIDs from it.
- Should spaces accessed by name be listed in subsequent `readdir` calls? Or
  should it list only spaces from the home space's list?
- How should space sessions be garbage-collected? (A user might `cd` into
  dozens of spaces; each holds a WebSocket subscription.)

### Schema-Driven Representation

Should the filesystem use cell schemas to improve the representation?

For example, if a schema declares `type: "string"` for a field, the
filesystem knows not to attempt JSON parsing on write — it's always a string.
If a schema declares an enum, the filesystem could expose valid values via
xattrs.

Schema awareness would improve type inference on writes but adds complexity.

### Version History

Should the causal history of cells be exposed?

```
pieces/todo-app/result/.history/
  by4jqkbx.../         # version 1
    .json
    items/...
  by4jqkbx.../         # version 2
    .json
    items/...
```

This would enable `diff` between versions, git-like workflows, and undo.
But it adds significant complexity and storage requirements.

### Binary Data

Cells can contain strings that represent binary data (base64-encoded). Should
the filesystem decode these automatically?

If a schema declares `contentMediaType: "application/octet-stream"` and
`contentEncoding: "base64"`, the file could expose raw bytes instead of the
base64 string.

### Empty Objects vs Empty Arrays

Both `{}` and `[]` map to empty directories. How to distinguish them?

Options:
- **xattr**: `user.json.type` = `object` or `array`
- **Convention**: arrays always have a `.length` virtual file
- **`.json` sibling**: `cat path.json` reveals the actual type

The `.json` sibling approach is sufficient — `cat dir.json` returns `{}` or
`[]`.

### Piece Creation/Deletion via Filesystem

Should `mkdir pieces/new-piece` create a new piece? Should `rm -r
pieces/old-piece` delete one?

Piece creation requires a pattern (source code), so a bare `mkdir` isn't
enough. Possible approach: create the directory, then write a `source.tsx`
file into it, which triggers piece creation.

Piece deletion is more straightforward and could map to `rm -r`.

### Concurrent Writes

What happens when two processes write to the same cell simultaneously
(e.g., one through FUSE and one through the browser)?

The current system uses last-write-wins at the cell level. FUSE writes go
through the same transaction mechanism, so they participate in the same
conflict resolution. No special handling needed, but users should be aware
that concurrent edits may lose data.

### Timestamps (`ctime`, `atime`)

Should `ctime` and `atime` be tracked separately from `mtime`?

They are reported equal to `mtime`. In this filesystem the only metadata that
changes independently of content is the CFC annotation — mode is derived at
stat time, and ownership and link counts are fixed — so a separately-tracked
`ctime` would expose the timing of a node's label and generation changes to
anyone who can `stat` it. The CFC spec treats that as an information channel:
metadata field labels default to the content label, and §18.2.3.5 permits
refining `mtime`/`ctime` "with a specific update event" but forbids labeling a
field below what its metadata reveals. Reporting `ctime = mtime` exposes no
channel beyond content-change timing, so the content-label default is exactly
right. Tracking `ctime` separately would need a threat-model analysis and a
label refinement for a benefit few tools use (`find -cnewer`, `ls -lc`), so it
stays collapsed onto `mtime` until a concrete consumer needs it.

## Implementation

### macOS vs Linux

macOS requires macFUSE or FUSE-T. Linux has native FUSE support. The Rust
`fuser` crate supports both, but there are API differences:

- macOS uses FUSE v2 (2.9); Linux supports FUSE v3
- Extended attribute syscalls differ (`ENOATTR` vs `ENODATA`)
- `setxattr` has an extra `position` parameter on macOS

These are handled by the `fuser` crate internally, but testing on both
platforms is needed.

### Performance Budget

A `getattr` call should complete in <1ms (from in-memory tree).
A `readdir` call should complete in <5ms.
A `read` of a cached value should complete in <1ms.
A `read` requiring a cell fetch should complete in <100ms.

Commit-confirmed mutations have a different budget than cached reads and
metadata. The package-local reliability design currently proposes a 30s soft
deadline for cell content `write`/`flush`, because success now means local
validation, CFC authorization, backend mutation or runtime acceptance, and safe
projection invalidation/reconciliation. A future implementation may tune that
deadline downward, but the old <200ms network-round-trip target is no longer the
default correctness contract for mutating operations.

Open latency work should therefore track two budgets separately: low-latency
cached metadata/read operations, and commit-confirmed mutation deadlines that
include backend acceptance, CFC/writeback reconciliation, and explicit
known-failure versus timed-out-unknown diagnostics.

If the Deno IPC round-trip adds too much latency for `getattr`/`readdir`,
the Rust layer must be fully self-sufficient for these operations (serving
from its in-memory tree without IPC).

### Graceful Degradation

What happens when the toolshed is unreachable?

- Reads should be served from cache (stale data is better than errors).
- Writes should fail with `EIO`.
- The filesystem should attempt reconnection in the background.
- A `.status` virtual file at the root could report connection state.

### Testing Strategy

- **Unit tests**: Deno service cell-to-tree mapping, JSON-to-filesystem
  conversion, type inference.
- **Integration tests**: Mount a FUSE filesystem, perform operations, verify
  cell state. Requires FUSE support in the test environment (CI may need
  Docker with `--cap-add SYS_ADMIN --device /dev/fuse`).
- **Fuzz testing**: Random JSON structures -> filesystem representation ->
  round-trip back to JSON. Verify fidelity.

---

**Previous:** [Reactivity and Caching](./6-reactivity.md)
