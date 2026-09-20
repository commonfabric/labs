# Deploying, updating & sharing lunch-poll state

How to deploy the lunch poll, apply ordinary compatible updates, migrate the
name-keyed poll to profile-cell identity, share it, verify it actually worked,
and recover it when it breaks. Written for someone (human or agent) operating
the poll for the first time — read top to bottom once.

> **Status (2026-09-02): the current Estuary piece runs the profile-identity,
> keyed-vote source from `main` at `94eb22057`.** Its question and 14 options
> (including generated art) are intact. The roster, host, and votes are empty:
> everyone must re-join, the first joiner becomes host, and votes start fresh.
> Ordinary compatible source updates use Option A. Option B remains the safe
> fresh-piece recovery/migration path. Joins are profile-gated: an identity with
> no resolvable `#profile` cannot join, and `joinMessage` reports why.

## Where the data lives (mental model)

A poll's durable state belongs to **one deployed piece instance in one space**,
addressed by `(space, causal-cell-id)` — not to "the pattern" in the abstract.
So "share the state" = "everyone points at the same piece"; "copy the state" =
"move that piece's values into a new piece." It all lives in **`PerSpace` input
cells**, shared by everyone in the space: `question`, `options`, `votes`,
`users` (each entry carrying its participant's profile cell as identity),
`host`, and **`visits`** (the "Recently eaten" log + embedded vote snapshots
that feed "Lunch stats").

There is no stored per-user joined flag: whether you have joined is derived by
comparing your `#profile` against the roster, so the same identity is recognised
on any device and nothing can go stale.

All of these survive an in-place `setsrc` only when the old and new schemas are
compatible (Option A). The profile-identity rollout is not compatible, so it
moves the values into a fresh piece (Option B). When migrating the name-keyed
piece, strip the visit log's legacy links into that source piece's roster; the
display snapshots and tallies remain intact.

## The live pieces

**These are deployment pointers, not stable identifiers.** A piece is tied to
one space on one server, and it can be reset, wedged, or lost. When one stops
answering, re-establish it (see "Recovering the piece") and update this block.

### `estuary` — the stately instance, holding the real poll

`estuary.saga-castor.ts.net` carries the team's current poll and a legacy
name-keyed source piece. The **current** poll runs profile-cell identity and
keyed votes; after the 2026-09-02 source update its participants must re-join:

```
space:  team-lunch
piece:  fid1:gi7f-G8Z353Q_f_yLs_T3kB7A06TZjUmhf-M59bqvrE
url:    https://estuary.saga-castor.ts.net/team-lunch/fid1:gi7f-G8Z353Q_f_yLs_T3kB7A06TZjUmhf-M59bqvrE
```

The **legacy name-keyed** poll is a read-only migration source. Its identity
links are not portable through `cf cell get | cf cell set`; use only the
link-free fields and stripped visit procedure in Option B. Treat its state as
production data.

```
space:  team-lunch
piece:  fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4
url:    https://estuary.saga-castor.ts.net/team-lunch/fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4
```

This host deploys by manual dispatch, so its build trails `main`; see
[`docs/development/deploying.md`](../../../docs/development/deploying.md). The
host's build and the piece's source move independently — a host upgrade leaves
the piece on whatever source it was deployed with. `/api/meta` gives the commit
the host runs, and `cf piece inspect` gives the source ref the piece is on:

```bash
curl -s https://estuary.saga-castor.ts.net/api/meta
```

**Its space holds real data, so an update here is rehearsal-grade.** Rehearse
against a clone before any `setsrc` the compatibility checker rejects — see
[`docs/development/space-clone-rehearsal.md`](../../../docs/development/space-clone-rehearsal.md).
Estuary serves production, so its whole-space dump endpoint is off and the
snapshot has to be taken on the host itself. The space DID is
`did:key:z6MkhAKxuP8cXuDNjyUJ2xgmjjgENQGm7zzo5Tg3V7vyYnzr`, and reaching the
host needs a key in the infra repository's `ssh_authorized_keys`.

```bash
sqlite3 <store>/engine-v3/engine-v3/<did>.sqlite "VACUUM INTO '<destination>'"
```

### `rapids` — the fast-moving instance

`rapids.saga-castor.ts.net` redeploys on every push to `main`, so it runs close
to tip and can move under you mid-session. Iterate here, in **a space of your
own**: a scratch space costs nothing and leaves the shared ones alone.

The `team-lunch` space on this host is unusable as it stands. Its stored root
pattern does not compile against the current API, so every command that loads
the space's piece registry fails there — `cf piece ls` and `cf piece inspect`
with `Could not load pattern <identity>#default`, and `cf piece new` with:

```
Could not initialize the space's default pattern: ...
The new piece cannot be registered in the space's piece list without it.
If this space's root pattern predates a runtime format change, repair it with: cf space recreate-root
```

Commands that address a piece by id and never read the registry still work
there: `cf cell get` and `cf piece getsrc` both do. The poll piece that used to
serve this space does not start either — a nested `participant-identity-card`
argument is missing a required field, so setup refuses it (see "A piece that
saved its source and will not start"). Re-establishing a poll on this host means
repairing the space root first, with `cf space recreate-root`, and then
`cf piece new`. `recreate-root` rewrites the space's root pattern for everyone
in it, so agree on it before running it against a shared space.

## Environment setup

```bash
export CF_API_URL=https://estuary.saga-castor.ts.net/   # estuary; rapids.saga-castor.ts.net to iterate; http://localhost:8000 for local dev
export CF_IDENTITY=./your-identity.key
PIECE=fid1:gi7f-G8Z353Q_f_yLs_T3kB7A06TZjUmhf-M59bqvrE   # estuary current poll — every operation in this guide targets it
LEGACY_PIECE=fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4   # populated name-keyed poll; Option B's migration SOURCE only
SPACE=team-lunch

# Keep this complete set on every source deployment in this guide.
LUNCH_POLL_TEST_ARGS=(
  --test packages/patterns/lunch-poll/art-sync.test.tsx
  --test packages/patterns/lunch-poll/generated-art.test.tsx
  --test packages/patterns/lunch-poll/lunch-stats.test.tsx
  --test packages/patterns/lunch-poll/main.test.tsx
  --test packages/patterns/lunch-poll/multi-user.test.tsx
  --test packages/patterns/lunch-poll/participant-identity-card.test.tsx
  --test packages/patterns/lunch-poll/poll-option-card.test.tsx
)
```

`CF_API_URL` is the one variable to re-read before every command that writes.
The exported value is what stands between a smoke test and the same commands
landing on the team's real poll, and nothing in the command line itself says
which host it reached. Pass `-a`/`--api-url` per command when you are moving
between hosts in one session.

Before any `piece new` or `piece setsrc` command below, run every authored
pattern test and stop if one fails:

```bash
deno task cf test packages/patterns/lunch-poll/art-sync.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/generated-art.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/lunch-stats.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/main.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/multi-user.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/participant-identity-card.test.tsx --root packages/patterns
deno task cf test packages/patterns/lunch-poll/poll-option-card.test.tsx --root packages/patterns
```

The quoted `"${LUNCH_POLL_TEST_ARGS[@]}"` expansion below repeats every `--test`
entry. Deployment packages and type-checks the tests but does not run them,
which is why both the test commands and the flags are required.

**Identity key:**

- **Local dev** — mint your own unique key (use `deno run`, **not** `deno task`,
  when redirecting — the task wrapper prints ANSI preamble that pollutes the
  file):
  ```bash
  mkdir -p .cf
  deno run -A packages/cli/mod.ts id new > .cf/shared-dev.key
  chmod 600 .cf/shared-dev.key
  export CF_IDENTITY="$PWD/.cf/shared-dev.key"   # replaces the ./your-identity.key placeholder above
  ```
  The local toolshed accepts any identity; import the same key in the browser
  (`Import CLI Key` on the login screen) when the CLI and browser should act as
  one user. Do NOT derive the shared `"implicit trust"` passphrase for deploys —
  that fixed, publicly-derivable DID is reserved for acting as the local
  server's own operator identity, and it collapses you into the server
  principal. See `docs/features/shared-identity.md`.
- **Prod** — deploy with your own identity, or mint a fresh one
  (`deno run -A packages/cli/mod.ts id new > prod.key`) and share that key with
  whoever should be able to update the piece. Whoever deployed owns it; the
  **host** is a separate, in-poll role (first joiner — see Identity below).

**Command spellings:** the data commands are `cf cell get`, `cf cell set` and
`cf piece call`. The piece-lifecycle commands keep the `cf piece` prefix: `new`,
`setsrc`, `getsrc`, `step`, `inspect`, `render`, `ls`, `rm`, `verbs`.
`recreate-root` rebuilds a space rather than a piece, so it is
`cf space recreate-root`.

## Option A — ordinary compatible source updates

**Do not use this option for the profile-cell identity rollout.** Its accepted
`argument.visits[]` break is in the root argument contract, so `setsrc` refuses
the populated predecessor. Use Option B even though the vintage replay proves
that its stored rows remain readable.

For an ordinary compatible change, update the source of the existing piece to
**keep all accumulated state**. Do **not** run `cf piece new` for that case — it
mints a fresh, empty instance. Run the exact update once with `--check`; only a
clean, zero-exit preflight authorizes the apply:

```bash
# Runs all seven tests and the dry-run compatibility check;
# leaves the piece unchanged.
packages/patterns/lunch-poll/deploy-safe.sh

# Repeats the same gates, applies, then requires a successful render.
packages/patterns/lunch-poll/deploy-safe.sh --apply
```

The helper requires the `CF_API_URL`, `CF_IDENTITY`, `SPACE`, and `PIECE`
variables from Environment setup. Its default is deliberately preflight-only.
The check compiles and stores unattached, content-addressed candidate artifacts
in the space, but it does not move the piece's source pointer, restage its
arguments, or create a source revision. The equivalent commands are:

```bash
deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  --check \
  packages/patterns/lunch-poll/main.tsx

# Apply only after the command above exits 0.
deno task cf piece setsrc --piece "$PIECE" -s "$SPACE" \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  packages/patterns/lunch-poll/main.tsx

# A deploy is not complete until the piece actually starts.
deno task cf piece render --piece "$PIECE" -s "$SPACE" >/dev/null
```

Keep every target, root, test, data-file, repository, and export flag identical
between preflight and apply. A check against a different package or piece proves
nothing about the write you apply.

**For a compatible update, what survives (verified):** all the `PerSpace` cells
(`users`/`votes`/`options`/`visits`/…). Cell ids derive from the causal
generation chain (not contents, scope excluded), so `setsrc` keeps the same
result cell and its populated inputs. **Adding a new `PerSpace` field is safe**
— on an existing piece it hydrates to its `Default<>` while populated fields
keep their data.

> **Reset the votes after an update that changes how a vote is addressed.** A
> vote lives at an address derived from its key — its voter's profile entity and
> the option — and a poll may be carrying votes stored under some other scheme,
> which no key names. Those rows still render and still tally, but the handlers
> cannot reach them: casting over one adds a second, keyed vote beside it and
> the voter counts twice. `setsrc` keeps them, so the host clears the board once
> after the update (see "Resetting / re-seeding state"), and everyone votes
> again. Votes are shown a day at a time anyway, so a reset costs the group
> nothing they were still looking at.

**Removing one is refused wherever the pattern publishes it.** A `PerSpace`
field that also reaches the result is held by the result contract, and the
compatibility check rejects a source that drops it, without touching the piece:

```
Pattern schemas are not backward compatible:
- result.motto: existing result field was removed
```

A field the pattern only reads goes freely while the argument object stays open,
which is the default: giving up an input leaves whatever the piece stored unread
rather than breaking a reader. A closed argument object refuses it, since it
could no longer hold the value the piece is carrying.

`--dangerously-allow-incompatible-schema` replaces the source anyway. Do not use
it to force this identity migration: the supported disposition is a fresh piece
plus the explicit copy below. More generally, heavily **reordering or renaming**
pattern inputs can shift the causal chain and orphan old data. Don't refactor
the input interface casually against a piece you care about.

> **Precondition:** `setsrc` loads the piece's _currently deployed_ source
> before it compares schemas, so a piece whose deployed generation no longer
> compiles against today's API cannot be updated in place at all. It fails while
> loading that source, with whatever the stale source imports, e.g.
> `Module '"./commonfabric.js"' has no exported member '<name>'`.
> `--dangerously-allow-incompatible-schema` does **not** help: it only skips the
> compatibility proof, which runs _after_ the load. Recover with `cf piece new`
> (see "Recovering the piece").

> **Allocated `viewer` state can block a populated poll.** A browser opening the
> poll can materialize the per-user `viewer` allocation. Candidate-schema
> validation may then refuse `--check` even when the same source passes on a
> fresh piece. Stop on that refusal. Confirm the diagnosis on a disposable piece
> and, if needed, check the piece's own deployed bytes against itself. Clearing
> production cells is not a preflight; it spends the state you are trying to
> protect.

> **`setsrc` can partially succeed.** Saving the source and refreshing the
> running piece are separate steps, and the second can fail on its own. The
> command prints the durable commit receipt but now exits nonzero when refresh
> fails:
>
> ```
> Piece source was saved, but refreshing the running piece failed: [Error: updated arguments do not match the candidate schema: profileAvatar: value does not match type string]
> Committed source update for piece bafy… (Pattern Ref: cf:module/Qy36SQqu…#default, Revision: 0f2c…)
> Source revision 0f2c… committed as cf:module/Qy36SQqu…#default, but refreshing the running piece failed: updated arguments do not match the candidate schema: profileAvatar: value does not match type string
> ```
>
> The piece is now on the new source, but its running state is unverified. Read
> the whole output, not its tail and not stdout alone: the receipt is on stdout
> while the refresh failure is on stderr. A committed receipt proves only that
> the source update landed. The nonzero exit must stop automation; use
> `cf piece render` to learn whether a clean start recovers or the piece remains
> wedged. See "A piece that saved its source and will not start".

## Option B — migrate the populated name-keyed poll to a fresh piece

Use this for the profile-cell identity rollout, or to get your **own** instance
seeded with the team's accumulated data without touching the shared poll:

```bash
# 1. Pick the copy TARGET. The team rollout copies into the current piece:
MINE="$PIECE"
# To seed your OWN instance instead, mint a fresh piece as the target:
#   MINE=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
#     --root packages/patterns "${LUNCH_POLL_TEST_ARGS[@]}" \
#     -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Resolve your piece's argument document. This is the cell the copy writes
#    into; `cf cell set --input` cannot do it (see the note below).
ARG=$(deno task cf cell get --piece "$MINE" -s "$SPACE" --input --select '@' -q \
  | grep -oE '/of:fid1:[A-Za-z0-9_-]+')

# 3. Dry-run the exact source package against the target before copying data.
deno task cf piece setsrc --piece "$MINE" -s "$SPACE" \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  --check \
  packages/patterns/lunch-poll/main.tsx

# 4. Copy only link-free PerSpace fields. Roster, host, and votes start empty.
for field in question options; do
  deno task cf cell get --piece "$LEGACY_PIECE" -s "$SPACE" "$field" --input -q \
    | deno task cf cell set -s "$SPACE" "$ARG/$field" -q
done

# 5. Copy the visit log after deleting every identity link (see below).
deno task cf cell get --piece "$LEGACY_PIECE" -s "$SPACE" visits --input -q \
  | deno eval '
      const v = JSON.parse(await new Response(Deno.stdin.readable).text());
      for (const e of v) {
        delete e.loggedBy;
        for (const s of e.votes ?? []) {
          delete s.voterLink;
          delete s.voterProfile;
        }
      }
      console.log(JSON.stringify(v));
    ' \
  | deno task cf cell set -s "$SPACE" "$ARG/visits" -q

# 6. Recompute so derived values (counts, ranking) refresh.
deno task cf piece step --piece "$MINE" -s "$SPACE"
deno task cf piece inspect --piece "$MINE" -s "$SPACE" --summary
```

> **Why the copy writes to `$ARG` and not `cf cell set --input`.** A
> `cf cell set --input` write validates the piece's whole input object, and this
> pattern's `viewer` slot is a per-user allocation site rather than a plain
> value. Every field fails on that slot rather than on the field being written,
> which bites any lunch-poll piece, including one created seconds ago, and a
> nested path (`users/0/name`) fails alongside a top-level one. A write
> addressed to the argument document itself is not validated that way, which is
> what step 2 resolves and what the loop above uses. That escape hatch also
> permits destructive clears, so it is not a general-purpose update path.

> **A JSON link is not a restorable backup.** A value read by `cf cell get` can
> be refused when written back, including into the piece that minted it, with
> `source has no durable schema contract`. This is measured for roster profile
> links. Never clear `users`, `host`, `votes`, or identity-bearing visits on the
> theory that captured JSON can restore them. Treat that JSON as an audit
> snapshot only, and rehearse any link-bearing copy on a disposable piece before
> touching the source.

> **Why the host seat is left behind.** The name-keyed predecessor has no
> profile-cell host identity worth carrying. Leave the new seat empty: the first
> person to re-join with a profile becomes host. A later joined participant can
> use **Become host**.

> **Why the predecessor's `visits` needs the edit.** Each legacy entry's
> `loggedBy`, and each embedded vote's `voterLink`, is a live `Cell<User>` link
> into the **source** piece's roster. The destination cannot prove a contract
> for a link it did not mint:
>
> ```
> input link at visits.0.loggedBy schema is not compatible: source has no durable schema contract
> ```
>
> The profile-first schema makes those identity fields optional, and the names
> travel separately in `loggedByName` and `voter`, so deleting the legacy links
> costs the "who logged this" navigation and nothing else — the "Recently eaten"
> log and the "Lunch stats" tallies come across intact. Do not assume a later
> profile-first-to-profile-first copy can preserve links: `cf cell get` does not
> carry the durable source contract required to write those links back. Prove
> every link-bearing field on the disposable target or strip it.

This is a **one-time snapshot copy**, not a live link — the pieces diverge
after.

## Verifying a deploy actually worked

A piece has two faces, and they answer differently:

- **The input cell (`--input`) is always current.** It is the durable argument,
  and a handler's write lands there immediately.
- **The result cell can lag.** Some outputs hold a value cached at the last
  recompute — `hostName`, `myName`, `mostRecentTitle`, `recentVisits` and
  `placeStats` all do. Others track the argument live, among them `question`,
  `options`, `users`, `votes` and the counts (`userCount`, `optionCount`,
  `voteCount`, `historyCount`). Nothing in the output's name or type says which
  kind it is, and one handler call can move both at once: after a `logVisit`
  with no recompute, `historyCount` reads 3 while `recentVisits` still lists 2.

So don't sort outputs into the two groups. Read `--input` when you want the
stored value, and pass `--step` when you want a result:

```bash
# The stored visit log — what a write actually landed.
deno task cf cell get --piece "$PIECE" -s "$SPACE" visits --input -q

# A derived output, recomputed in the same CLI session before it is read.
deno task cf cell get --piece "$PIECE" -s "$SPACE" recentVisits --step -q
```

`--step` starts and recomputes the piece before reading, so it also writes; a
plain `cf piece step` before the read does the same job. Reserve both for a
piece you are allowed to move.

**Smoke test after deploy.** Joining requires a resolved profile, and a fresh
CLI identity usually has none — so the first thing to verify is that the join
path ANSWERS rather than silently doing nothing:

```bash
# joinAs takes no arguments: it joins as the calling identity's own profile.
deno task cf piece call --piece "$PIECE" -s "$SPACE" joinAs '{}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
# Read the verdict — do NOT assume the join landed:
deno task cf cell get --piece "$PIECE" -s "$SPACE" joinMessage
```

- **`""` (empty)** — the join landed: this identity's `#profile` resolved.
  Continue with the host-gated steps below.
- **"Join needs a resolved profile — create or pick one first."** — the deploy
  is live and the gate is working; this CLI identity has no resolvable profile,
  so it cannot join (there is no typed-name path). Continue the host-gated steps
  from an identity whose profile resolves — a browser session with a profile, or
  a CLI key imported into one (see "Identity & joining" below).

With a joined identity, exercise the host-gated flow end to end:

```bash
deno task cf piece call --piece "$PIECE" -s "$SPACE" addOption '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
deno task cf piece call --piece "$PIECE" -s "$SPACE" logVisit '{"title":"Test Cafe"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"
# Confirm the entry landed (no browser needed):
deno task cf cell get --piece "$PIECE" -s "$SPACE" visits --input -q
```

Put the inline JSON argument last: a flag after it makes `cf piece call` report
`Use a single inline JSON argument or "--" before schema-derived flags.`

`cf piece render` renders the same tree a browser would show, so it is the
cheapest whole-UI check — and, because it starts the piece, the cheapest way to
find out that a piece will not start at all.

## Identity & joining

Your identity in a poll is your shared **profile cell** — the thing
`wish({ query: "#profile" })` resolves. The roster, every vote, and the host
pointer all hold that cell and compare it with `equals()`. A display name is
only a label. Consequences that bite:

1. **Joining requires a profile.** The card offers a one-click **Join as
   \<name\>** once yours resolves; when it does not, it renders the profile
   create/pick surface instead. There is no free-text path, so nobody can join
   as you by typing your name. The **first person to join becomes host**.

2. **CLI and browser are different identities unless you make them the same.**
   The `cf` CLI runs as one DID and a browser session as another, each with its
   own profile, so a CLI-seeded join is a different participant from your
   browser one. To act as the same person in both, import your CLI key in the
   browser via **Import CLI Key**; see
   [`docs/features/shared-identity.md`](../../../docs/features/shared-identity.md).
   Verify with `cf id did "$CF_IDENTITY"`.

3. **Names may repeat.** Two people called "Alex" are two participants with
   independent votes and host status, and renaming yourself keeps every vote you
   have cast.

4. **Host role is claimable.** Any joined participant can take the host seat
   with **Become host** (`claimHost`). A squatted/stale host seat doesn't need
   an operator reset — just join and click Become host.

## Resetting / re-seeding state (host or operator)

**Coordinate before running this against the shared piece — it mutates state
everyone sees, and a direct write races anyone's live browser session.**

Prefer the handlers. They are host-gated, they keep the derived values honest,
and they are the only path the browser also takes:

- **Votes:** use the in-app `resetVotes` (host) — or call it via CLI.
- **History:** use the **`clearHistory` handler** (host-gated) — it empties the
  `visits` log and its embedded vote snapshots:
  ```bash
  deno task cf piece call --piece "$PIECE" -s "$SPACE" clearHistory '{}'
  deno task cf piece step --piece "$PIECE" -s "$SPACE"
  ```
- **Whole-poll reset:** create a fresh piece. Do not raw-clear `users`, `host`,
  `votes`, or identity-bearing visits in place. Their JSON export is useful for
  audit and manual reconstruction, but its links may not be accepted on restore.
  A new piece makes the reset explicit and leaves the old piece available for
  read-only recovery work.

## Recovering the piece

### Re-establishing (if it's lost / 404s)

```bash
deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  --root packages/patterns "${LUNCH_POLL_TEST_ARGS[@]}" -s "$SPACE"
# → prints a new fid1:… — update the "live pieces" block above.
```

You need `WRITE`/`OWNER` on the space (ACL-gated); a denied write changes
nothing. The command also needs the space's root pattern to load, because it
registers the new piece in the space's piece list — see the `rapids` note above
for what it says when that fails.

### A piece that saved its source and will not start

The piece answers `cf cell get`, but anything that starts it —
`cf piece render`, `cf piece step`, `cf cell get --step` — refuses with a
stored-argument complaint naming a field of a nested pattern. For example, a
piece saved from the name-keyed predecessor can report:

```
updated arguments do not match the candidate schema: myName: value does not match type string
```

That field belongs to the predecessor's stored `participant-identity-card`
argument, not the current card contract. Its argument document no longer
satisfies the saved source. There is no in-place repair: another `setsrc` saves
the source and fails the refresh the same way, and a direct write to the
sub-pattern's argument document is refused with
`updated result write destination has no durable schema contract`. Move to a
fresh piece, as below.

### Recovering a wedged piece

A piece can also get into a bad **process** state — UI renders but **clicks do
nothing**, no console errors (a settle loop flickers / logs warnings). Observed
once when a "reset votes" click wedged the running instance. `setsrc` does
**not** fix this either (it reuses the same process cell); the cure is a fresh
process:

```bash
# 1. Confirm it's instance-specific: deploy the same code to a NEW piece. If the
#    fresh piece works, the old one's process is wedged.
NEW=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx \
  --root packages/patterns \
  "${LUNCH_POLL_TEST_ARGS[@]}" \
  -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

# 2. Copy only the link-free state with the Option B procedure. Strip identity
#    links from visits; leave users, host, and votes empty so participants
#    re-join and the first joiner becomes host.

# 3. Make the fresh piece the shared one: update the "live pieces" block above.
```

### Home space won't load (profile setup, `main`-style builds)

Unrelated to the poll itself, but bites colleagues setting up a profile: if a
home space fails to load because its handlers or setup are refused at start, the
space's **stored** root pattern is a stale compiled artifact. Fix: open the
header menu → **Toggle debug mode** (🐛) → click the red **Recreate Root
Pattern** button in the debugger drawer, then reload. (Console fallback:
`localStorage.setItem("showDebuggerView","true")` then reload.) The poll's join
card has no free-text bypass. Repair and reload the home space, then create or
pick a shared profile before joining the poll.

## Performance notes

Measured on the 14-option, one-viewer reproduction below (server-execution OFF,
the arm the estuary poll runs; September 2026): the reactive graph after option
creation is about 1,360 nodes and 3,350 edges, a vote settles in roughly 85 to
145 ms headless and 200 to 450 ms in a browser, and the worker spends only about
75 ms of CPU per vote. Where that time goes is the runtime, not this pattern: on
every settle the poll's root document is re-read through its schema in full,
about 8,500 schema visits over some 525 linked documents at depth 42, 100 to 300
ms each and several times per vote, and the per-traversal schema memo starts
empty each time. The cost scales with the size of the rendered tree (options,
votes, history), so pattern-side changes that shrink the graph without shrinking
the rendered tree do not move it. Cold load pulls about 940 cells in parallel
waves, roughly 2 s warm and 7 s cold locally, and barely changes under 80 ms of
added round-trip latency.

One latency-sensitive failure is the pattern's own: under a slow link the join
button can render before the viewer's profile document has been pulled, the
first join click then reads that profile as absent and leaves "Join needs a
resolved profile" on screen, and a second click succeeds. Run the same workload
with:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts --production
```

The probe pins `EXPERIMENTAL_SERVER_EXECUTION=false` for itself unless the
variable is already set: headless, the ON posture would wait forever on a
toolshed that is not running.

Per-option cuisine art is generated in the browser, and only on the **host's**
client: `generated-art.tsx` requests `/api/ai/img` via `fetchBinary` under a 30s
mutex, and skips the request entirely for any option that already carries a
stored image. The host keeps a thumbnail with the card's keep action, which
fires `setOptionImage` to persist the data URL onto that option's `imageUrl`;
every other viewer reads the stored value rather than generating its own. Art
therefore costs at most one request per option across the whole poll, not one
per option per viewer.

For the deeper aggregate + write-conflict findings that still apply to a poll
with many options and voters, see willkelly's perf investigation in
[labs#4141](https://github.com/commonfabric/labs/pull/4141) (keyed-collection /
runtime-aggregate direction).
