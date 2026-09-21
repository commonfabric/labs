# Generated cell identity

Anonymous internal cells belong to an accepted authored artifact. An authored
update must not reinterpret an old anonymous writable value as a new slot that
happens to occupy the same builder ordinal. Explicit names remain continuity
anchors. This is an identity and lifecycle contract, not a performance claim.

The builder reserves top-level `$generated` causes for anonymous cells and
duplicate-name disambiguation. In addressing format 1 their effective cause is
the original record with `$artifact: { identity, symbol }` added. The artifact
ref comes from trusted module registration after evaluation. The ordinary
`{ parent, type: "internal", cause }` hash and cell-kind URI scheme are otherwise
unchanged. Named/manual causes and result-path causes retain their addresses.
The reserved `$generated` field remains at the top level so authored manual
causes cannot collide with generated ones.

## Selection and updates

Result metadata `generatedCellIdentity` records `{ version, identity, symbol }`.
Version 0 preserves legacy addressing; version 1 selects the authored namespace.
A new loadable piece uses version 1. A markerless piece uses the stored setup
identity, or the pattern pointer when no setup identity exists. If that reference
already names the requested artifact, preparation uses version 0. Reopening or
re-setting up that unchanged legacy piece retains its state. Setup of a different
authored artifact selects version 1 atomically with the pointer, manifest,
defaults, and result projection. Source transitions preserve the old setup's
addressing marker until setup succeeds, recording version 0 for a markerless
legacy artifact. This also retains the evidence needed by recovery paths that
commit a pointer change before materialization. Aborted setup leaves the
accepted namespace and data unchanged.

The manifest matches the derived address as well as partial cause and kind.
Generated defaults are initialized at the new address; intentionally named
state survives. Reapplying an artifact that previously ran in version 1 revisits
that artifact's namespace, including its retained writable state. Identity is
not a per-edit nonce. Old documents remain available; this mechanism does not
garbage-collect them or retarget external links into them.

Keyless patterns use session-only legacy addressing and persist no generated
namespace. Promotion to a loadable artifact affects subsequent preparation;
earlier prepared instances remain immutable. Unknown or malformed formats
refuse preparation.

## Binding and resume

The runner prepares a separate pattern and direct descriptor copies for each
piece's selection. Private side tables carry that immutable context through
serialization, traversal, and binding copies. Shared artifact descriptors and
nested pattern descriptors are not modified. Central address minting reads
only this prepared context, never partially loaded storage metadata.

Static child identities use the same effective output cause as their value
binding, suppressing only the computed URI kind. A generated parent output
therefore rotates its child anchor and the child's named descendants. Explicit
child links preserve the selected child. List coordinators derive their
containers and children from the prepared parent bindings.

Cold resume loads each result document's metadata before deriving its internal
cells or descending into children. Confirmed absence is distinct from missing
local coverage. Sibling metadata loads run together; a failed metadata load
cannot silently select legacy addressing. Serving graphs shared across user or
session instances distinguish both artifact and addressing format. Ownership,
authorization preflight, setup, execution, and view-only binding use the same
selected addresses.

## Deployment

Memory peers must advertise `versionedGeneratedCellIds`. See the
[admission protocol](memory-v2/04-protocol.md). Deployments must drain old
backends and close their transport sockets before allowing versioned authored
transitions. Tabs reload and CLI clients update. The admission gate is a runtime
compatibility boundary, not general producer fencing. Unchanged legacy pieces
retain their format across runtime deployment.
