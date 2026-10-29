# CLI-Based Debugging

When patterns misbehave, the CLI often provides faster diagnosis than browser DevTools. This approach isolates data logic from UI rendering issues.

## Local Checks Before Deploying

```bash
# Check syntax only (fast)
deno task cf check pattern.tsx --no-run

# Check graph construction
deno task cf check pattern.tsx

# Run every authored automated pattern test
deno task cf test pattern.test.tsx

# View transformer output (debug compile issues — see below)
deno task cf check pattern.tsx --show-transformed
```

## Identity for CLI Commands

Every command below passes `-i "$CF_IDENTITY"`. Set it once per shell to the
unique key you use for normal development — see
[LOCAL_DEV_SERVERS.md](../LOCAL_DEV_SERVERS.md) for the full recipe:

```bash
mkdir -p .cf
deno run -A runtime/cli/mod.ts id new > .cf/shared-dev.key
export CF_IDENTITY="$PWD/.cf/shared-dev.key"
```

Without it set, `-i "$CF_IDENTITY"` expands to an empty argument and the
command fails immediately with `Missing value for option "--identity"`. Don't
reach for `id derive "implicit trust"` here: that is the local server's own
operator key, reserved for operator actions.

## Deploying a Test Piece

```bash
# Deploy with every test entry attached — returns the piece id used below
deno task cf piece new -i "$CF_IDENTITY" --api-url URL --space SPACE \
  --test pattern.test.tsx pattern.tsx

# Set test data
echo '{"title": "Test", "done": false}' | \
  deno task cf cell set -i "$CF_IDENTITY" --api-url URL --space SPACE --cell ID testItem
```

Write automated tests for new or changed pattern behavior and run every entry
before deployment. Repeat `--test` for multiple entries. The deployment command
packages and type-checks attached tests but does not run them.

## When to Use CLI vs Browser

**Use CLI when:**
- Data transformations produce wrong results
- Computed values don't update as expected
- Handlers don't modify state correctly
- You need to test specific input combinations
- Debugging reactivity chains
- You need to inspect the exact source emitted by `ts-transformers`

**Use Browser when:**
- UI doesn't render correctly
- Bidirectional binding issues (visual symptoms)
- Visual/styling problems
- Event handling doesn't trigger (click handlers, etc.)

## Stale Computed Values After `cf cell set`

**Gotcha:** `cf cell set` updates data but does NOT trigger computed re-evaluation. You must run `piece step` after `set` to get fresh computed values.

```bash
# WRONG: Returns stale computed values
echo '[...]' | deno task cf cell set --cell ID expenses ...
deno task cf cell get --cell ID totalSpent ...  # May return old value!

# CORRECT: Run piece step to trigger recompute
echo '[...]' | deno task cf cell set --cell ID expenses ...
deno task cf piece step --cell ID ...  # Runs scheduling step, triggers recompute
deno task cf cell get --cell ID totalSpent ...  # Now correct
```

`piece inspect` says which values those are. Its `--- Cached Result Fields ---`
section names every result field whose resolution crosses a computed cell. It
prints each computed cell's last-derived commit beside the commit the argument
document stands at. A computed cell which points on to live state still counts,
because the cached choice of which live state to follow can itself be stale.
Commit numbers only order within one space; the output names both spaces and
refuses the comparison when they differ. Result fields the section does not
name resolve entirely through live state.

## Inspect Transformed Output

When the question is "what did the compiler emit?", use `cf check` with
`--show-transformed` instead of reaching for ad hoc test harness code.

```bash
deno task cf check ./patterns/my-pattern.tsx --root $(pwd) --show-transformed
```

This is the fastest way to inspect how `ts-transformers` rewrote:

- JSX expressions
- reactive array-method chains like `.map()` / `.filter()`
- `computed()` wrapping
- downstream schema/capability lowering effects

It also works on fixture inputs while debugging the compiler itself:

```bash
deno task cf check \
  base/ts-transformers/test/fixtures/jsx-expressions/jsx-property-access.input.tsx \
  --root $(pwd) \
  --show-transformed
```

## Quick Diagnostic Sequence

```bash
# 1. What's the full state?
deno task cf piece inspect --cell <piece-id> -i "$CF_IDENTITY" -a URL -s space

# 2. What are the inputs? (--input selects the arguments cell; a positional
# /input would read a result field of that name)
deno task cf cell get --cell <piece-id> --input -i "$CF_IDENTITY" -a URL -s space

# 3. What's a specific computed value?
deno task cf cell get --cell <piece-id> myComputedField -i "$CF_IDENTITY" -a URL -s space

# 4. Set known input, trigger recompute, verify output ("" writes the whole
# input cell; --input selects it)
echo '{"items":[{"title":"test","done":false}]}' | \
  deno task cf cell set --cell <piece-id> "" --input -i "$CF_IDENTITY" -a URL -s space
deno task cf piece step --cell <piece-id> -i "$CF_IDENTITY" -a URL -s space
deno task cf cell get --cell <piece-id> itemCount -i "$CF_IDENTITY" -a URL -s space
```

## Common CLI Debugging Patterns

**"Computed value is stale":**
1. Set input via CLI
2. **Run `piece step` to trigger re-evaluation**
3. Get computed value via CLI
4. If CLI shows correct value but browser doesn't - issue is UI layer
5. If CLI shows wrong value - issue is in computed logic

**"Handler doesn't work":**
1. Inspect state before calling handler
2. Call handler via CLI with test payload
3. Inspect state after
4. Compare to see if state changed as expected

**"Don't know what data structure to expect":**
1. Deploy minimal pattern
2. `piece inspect` shows actual runtime structure
3. Use this to understand Cell wrapping, array shapes, etc.

**"Filtering/sorting not working":**
1. Set test data with known values via CLI
2. Get the filtered/sorted computed value
3. Verify the transformation logic in isolation

## The setsrc Workflow for Debugging

When iterating on fixes, always use `setsrc` instead of `new`:

```bash
# Make a fix, rerun every test, then retain the complete attached test package:
deno task cf test pattern.test.tsx
deno task cf piece setsrc --cell <piece-id> pattern.tsx \
  --test pattern.test.tsx -i "$CF_IDENTITY" -a URL -s space

# Test again
deno task cf cell get --cell <piece-id> brokenField -i "$CF_IDENTITY" -a URL -s space
```

This keeps you working with the same piece instance, preserving any test data you've set up.
Repeat the complete set of `--test` flags on every update. Omitted test roots are
not retained in the new source revision.

## See Also

- ./workflow.md - General debugging workflow
