## Development Workflow

```bash
# Check syntax (fast)
deno task cf check pattern.tsx --no-run

# Check graph construction
deno task cf check pattern.tsx

# Run every authored automated pattern test
deno task cf test pattern.test.tsx

# Deploy with every test entry attached
deno task cf piece new ... --test pattern.test.tsx pattern.tsx

# Update existing and retain the complete source package
deno task cf piece setsrc ... --test pattern.test.tsx --cell PIECE_ID pattern.tsx

# Ship a file that is not code alongside the source
deno task cf piece setsrc ... --test pattern.test.tsx --datafile data/cities.json --cell PIECE_ID pattern.tsx

# Inspect data
deno task cf piece inspect ... --cell PIECE_ID

# Link data between deployed pieces (shares cells across patterns)
deno task cf piece link ... editor-id/items viewer-id/items
```

**Tips:**
- Use `check` first to catch TypeScript errors
- Write automated pattern tests for new or changed behavior, run every test
  entry with `cf test`, and repeat `--test` for every entry during deployment.
  Deployment packages and type-checks attached tests but does not run them.
- A file that is not code travels with the source when the pattern reads it.
  `dataFile(path)` from `commonfabric` names the file relative to the module
  that reads it, the way an import specifier does, and that call is the
  declaration: every command that builds the program from local files —
  `setsrc`, `check`, `test`, `dev` — attaches what the source names, the way it
  already follows what the source imports. The bytes are stored verbatim, never
  parsed, compiled, or importable, and come back from `cf piece getsrc` with
  the rest of the package. A file named this way must be on disk where the call
  resolves to, or the build refuses and says which module asked for it.
- `--datafile` attaches a file the source cannot name: one read by a computed
  path, or one that ships with a program that does not read it. It is
  repeatable, and it adds to what the source declares rather than replacing
  it. Repeat every flag on each `setsrc`; an update defines the complete
  source revision.
- Deploy once, then use `setsrc` for updates
- Repeat the complete set of `--test` flags on every `setsrc`. Each update
  defines a complete source revision, so omitted test roots are not retained.
- `setsrc` preserves `WriteAuthorizedBy` authority across changed modules when
  the old and new recursive source closures contain the same normalized module
  path; a piece following a `system:` origin gets the same when it adopts a
  release. The handoff is scoped to the space whose authenticated cache
  documents record it; loading delegation metadata from another space grants no
  authority. Renaming or moving a module intentionally does not inherit that
  authority.
- `setsrc` rejects backward-incompatible argument or result schema changes
  before updating the piece. Existing fields must keep compatible types. New
  argument fields must be optional or have defaults, because existing
  invocations do not bind them. New result fields may be required without
  defaults because the candidate pattern generates them during setup. This
  admits the candidate migration; it does not give a newer reader a fallback
  if an older concurrently running generation later writes the old result
  shape. Add a result default as well when mixed-generation rollback tolerance
  is required. Input `anyOf` and type-array unions may be widened and result
  `anyOf` and type-array unions may be narrowed, including Common Fabric schema
  types such as `undefined`. For open argument objects, the piece's durable
  arguments are also validated against newly named fields before the update
  commits.
  Defaults introduced by an accepted update are migrated recursively through
  present objects, array items, and typed dynamic fields. Durable input links
  are preserved only when the producer-owned Piece result contract fits the
  destination contract; carried/narrowed view schemas and one currently
  materialized value are not sufficient. Existing links are rechecked inside
  the update transaction, and Piece result writes preserve those contracts.
  Cell capabilities are part of the proof: restricted handles cannot be
  amplified or stripped into ordinary read/write aliases, and redirected
  writes use the producer-owned capability and payload schema. Redirected
  descendant writes are staged against the complete producer argument or
  internal schema and every public result projection, so container and parent
  constraints remain valid as well as the written leaf.
  A destination default can satisfy a link only beneath ancestors that remain
  valid after default insertion; path links through correlated schemas (for
  example, a discriminated union) are rejected when no durable proof is
  possible. Because an absent Fabric path reads as `undefined`, a linked source
  object field must be unconditionally object-shaped and required unless the
  destination accepts `undefined`. Array indices can always be sparse, even
  when covered by `minItems`, so their destinations must accept `undefined`; a
  source-side default alone does not prove raw path presence.
  This migrates the piece's current state; clients holding an older argument
  link must refresh it before writing again so they use the updated schema.
  Concurrent updates are applied atomically; a stale update fails instead of
  overwriting a newer source.
  If an intentional breaking migration requires replacing the source anyway,
  pass `--dangerously-allow-incompatible-schema`. This bypasses the old-to-new
  pattern schema proof and the retained-link contract proof, and — because
  those proofs are all the loaded previous pattern feeds — lets the update
  proceed when the piece's current pattern cannot be loaded at all; it does
  not bypass compilation, normal value validation, atomic stale-update
  checks, or source-history availability (a piece with recorded revisions
  whose current source cannot be restored is still refused).
  `piece follow` reports a current pattern that cannot be loaded as an
  incompatibility and takes the same flag to accept it, which puts such a
  piece on an origin in one step.
  `piece new` accepts the same flag for deploy-script symmetry, but a fresh
  piece has no predecessor schema to compare.
- Test one feature at a time. Manual CLI and browser checks complement automated
  pattern tests; they do not replace them.
