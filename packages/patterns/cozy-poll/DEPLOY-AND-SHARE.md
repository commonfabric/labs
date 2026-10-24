# Deploying & sharing cozy-poll state

This pattern's data lives in **`PerSpace` cells** (`users`, `options`, `votes`,
`adminName`, `question`). That state belongs to **one deployed piece instance**
in one space — addressed by `(space, causal-cell-id)` — not to "the pattern" in
the abstract. So "share the state" means "everyone points at the same piece,"
and "copy the state" means "move those cell values into a new piece." This doc
covers both, plus the identity caveat that bites first.

## The canonical piece

This is a freshly forked **generic** poll — it has **no shared canonical
instance yet**. Whoever deploys it first establishes one; record the space,
piece id, and URL here so everyone iterates on the same instance. **Those values
are a deployment pointer, not a stable identifier.** A piece is tied to one
space/server and can be reset or wedged; if it 404s, `inspect` fails, or it
stops responding to clicks, re-establish it (see "Re-establishing" / "Recovering
a wedged piece" below) and update this block.

```
space:  <your-space, e.g. cozy-poll-2026-06-01>
piece:  <fid1:… printed by `cf piece new`>
url:    https://<your-toolshed-host>/<space>/<piece>
```

Set these once so you don't repeat flags (substitute your own identity key path
and your piece/space):

```bash
export CF_API_URL=https://<your-toolshed-host>/
export CF_IDENTITY=/path/to/your-identity.key   # e.g. ~/.config/commonfabric/identity.key
PIECE=<fid1:… from `cf piece new`>
SPACE=<your-space>

# Keep this complete set on every source deployment in this guide.
COZY_POLL_TEST_ARGS=(
  --test packages/patterns/cozy-poll/main.test.tsx
  --test packages/patterns/cozy-poll/multi-user.test.tsx
)
```

Before any `piece new` or `piece setsrc` command below, run every authored
pattern test and stop if one fails:

```bash
deno task cf test packages/patterns/cozy-poll/main.test.tsx
deno task cf test packages/patterns/cozy-poll/multi-user.test.tsx
```

The quoted `"${COZY_POLL_TEST_ARGS[@]}"` expansion below repeats every `--test`
entry. Deployment packages and type-checks the tests but does not run them,
which is why both the test commands and the flags are required.

## Option A — deploy your version onto the shared state (recommended)

To push code changes **and keep the accumulated state**, update the source of
the existing piece in place. Do **not** run `cf piece new` — that mints a fresh,
empty instance.

```bash
deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  "${COZY_POLL_TEST_ARGS[@]}" \
  packages/patterns/cozy-poll/main.tsx
```

Why this preserves state: cell ids are derived from the causal generation chain,
not from contents, and scope is excluded from that computation. Swapping the
program with `setsrc` keeps the same result cell, so `users`/`votes`/`options`
survive. **Adding a new `PerSpace` field is safe** — on an existing piece it
just hydrates to its `Default<>` while the populated fields keep their data.

Caveat: this holds as long as an input's identity in the recipe stays stable.
Adding fields is safe; heavily reordering/renaming pattern inputs can in
principle shift the causal chain and orphan old data. Don't treat the piece as a
database you can refactor freely without thinking about it. If state must be
durable even against re-`new`ing, store it in a separate dedicated data piece
the poll links to (not yet implemented here).

## Option B — copy the state into your own piece

If you want your **own** instance seeded with the current data (e.g. to
experiment without touching the shared poll):

```bash
# 1. Create your own empty piece (note the new ID it prints).
MINE=$(deno task cf piece new packages/patterns/cozy-poll/main.tsx \
  "${COZY_POLL_TEST_ARGS[@]}" \
  -s "$SPACE" | grep '^fid1:')

# 2. Copy each PerSpace field from the canonical piece into yours.
#    `--input` reads/writes the input cell where these live.
for field in question users options votes adminName; do
  deno task cf cell get --piece "$PIECE" -s "$SPACE" "$field" --input -q \
    | deno task cf cell set --piece "$MINE" -s "$SPACE" "$field" --input -q
done

# 3. Recompute so derived values (counts, ranking, nudges) refresh.
deno task cf piece step --piece "$MINE" -s "$SPACE"
deno task cf piece inspect --piece "$MINE" -s "$SPACE" --summary
```

This is a **one-time snapshot copy**, not a live link — the two pieces diverge
after this. There is no automatic carry-over of `PerSpace` data between pieces.

## Identity: why a fresh viewer "isn't recognized"

`myName` is **`PerUser`** — keyed by the authenticated **DID**, not the space.
`adminName` (first joiner) and the `users` directory are `PerSpace`. Two
consequences trip everyone up:

1. **CLI and browser are different identities unless you make them the same.**
   If you join/seed from the `cf` CLI (one DID) and then open the piece in a
   browser (a different passphrase/passkey DID), the browser's `myName` is empty
   — it shows you the join card and won't treat you as host. To act as the same
   person in both, import your CLI key into the browser (`Import CLI Key`); see
   [`docs/features/shared-identity.md`](../../../docs/features/shared-identity.md).
   Verify with `cf id did "$CF_IDENTITY"` and, in the page's console,
   `globalThis.app.state().identity?.did()`.

2. **Names are unique (name-as-identity).** `joinAs` rejects a name already in
   `users`. So if a test/seed already claimed your preferred name, you can't
   re-join under it from another identity — pick a different name, or clear the
   stale entry.

3. **Host role is claimable.** The host seat (`adminName`) goes to the _first_
   joiner, but any joined participant can take it over with the **Become host**
   button (`claimHost` sets `adminName` to themselves). So a stuck/squatted host
   seat no longer requires an operator reset — just join and click Become host.
   (You can still reset `adminName` to `""` directly if no one is joined.)

### Resetting / re-seeding state (host or operator)

There is no "reset everything" handler (`resetVotes` only clears votes). To wipe
or seed the shared cells directly, write the input cells. **This mutates shared
state — coordinate before running against the canonical piece.**

```bash
echo '[]' | deno task cf cell set --piece "$PIECE" -s "$SPACE" users     --input -q
echo '""' | deno task cf cell set --piece "$PIECE" -s "$SPACE" adminName --input -q
echo '[]' | deno task cf cell set --piece "$PIECE" -s "$SPACE" options   --input -q
echo '[]' | deno task cf cell set --piece "$PIECE" -s "$SPACE" votes     --input -q
deno task cf piece step --piece "$PIECE" -s "$SPACE"
```

After this, the first person to join in the browser becomes host as their own
browser identity.

## Re-establishing the canonical piece (if it's lost)

```bash
deno task cf piece new packages/patterns/cozy-poll/main.tsx \
  "${COZY_POLL_TEST_ARGS[@]}" -s "$SPACE"
# → prints a new fid1:… — update PIECE above and the "canonical piece" section.
```

You need `WRITE`/`OWNER` on the space (ACL-gated). A denied write is rejected by
the kernel and changes nothing.

## Recovering a wedged piece

A piece can get into a bad **process** state — e.g. a write that wedges the
scheduler mid-settle. Symptom: the UI renders but **clicks do nothing**, with no
console errors (a settle loop instead flickers / logs warnings). Observed once
when a "reset votes" click wedged the running instance.

`setsrc` does **not** fix this: it swaps the program but reuses the same process
cell, so the bad reactive state persists. The cure is a fresh process:

```bash
# 1. Confirm it's instance-specific: deploy the same code to a NEW piece and
#    open it. If the fresh piece works, the old one's process is wedged.
NEW=$(deno task cf piece new packages/patterns/cozy-poll/main.tsx \
  "${COZY_POLL_TEST_ARGS[@]}" \
  -s "$SPACE" | grep '^fid1:')

# 2. The data usually survives in the old piece's cells — copy it across with
#    the Option B loop (get --input | set --input) into the fresh piece.
#    Tip: don't copy users/adminName — leave them empty so the first joiner
#    becomes host; or copy them and use "Become host" to reclaim the role.

# 3. Make the fresh piece canonical: update the "canonical piece" block above.
```

Avoid writing to the cells of a piece someone is actively using in the browser —
direct `set` races their live session.
