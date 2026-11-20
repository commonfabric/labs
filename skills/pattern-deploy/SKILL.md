---
name: pattern-deploy
description: Deploy patterns and test with CLI
user-invocable: false
---

# Deploy Phase

Use the `cf` skill, or read `skills/cf/SKILL.md`, for comprehensive CLI
documentation. Use the command shapes from its Quick Command Reference rather
than guessing flags; this skill only covers the deploy workflow and exit
criteria.

## Read First

- `skills/cf/SKILL.md` — the Environment Setup section (`CF_API_URL`,
  `CF_IDENTITY`, identity key creation) is the prerequisite for every command
  below
- `docs/development/LOCAL_DEV_SERVERS.md` - Local dev setup
- `docs/common/workflows/development.md` - Workflow commands

## Find Identity Key

```bash
ls -la ./cf.key 2>/dev/null || ls -la *.key 2>/dev/null || find . -name "*.key" -maxdepth 2 2>/dev/null
```

If no key exists, create one per the cf skill
(`deno run -A runtime/cli/mod.ts id new > cf.key` for a unique key — note the cf
skill's warning: never redirect `deno task cf` output into a key file, the
wrapper pollutes it with ANSI preamble). Never overwrite an existing key file —
identity-scoped data (PerUser state, favorites) becomes invisible under a new
identity.

## Commands

With `CF_API_URL` and `CF_IDENTITY` exported (see the cf skill), you can drop
`--api-url`/`--identity`; `--space` is always required.

**Check syntax without deploying:**

```bash
deno task cf check pattern.tsx --no-run
```

**Run and collect automated pattern tests:**

```bash
deno task cf test patterns/[name]/main.test.tsx
```

New or changed pattern behavior must have automated coverage. Find every
authored `*.test.tsx` entry, run each one, and repeat `--test` for each entry in
the deployment commands below. Manual handler checks do not replace this step.

**Deploy new pattern (first time only):**

```bash
deno task cf piece new patterns/[name]/main.tsx --test patterns/[name]/main.test.tsx --identity cf.key --api-url $CF_API_URL --space <space>
# Output: Created piece bafyreia... <- SAVE this piece ID
```

**Versions are kept for you.** Once the person has joined a pattern index that
keeps versions, each `piece new <file>` and `piece setsrc` of their own pattern
whose source changed is kept as a private version, and the deploy prints one
line saying which; a `setsrc --origin` deploy, or one of someone else's pattern
unchanged, keeps none. Nobody runs a save command. To undo a bad step,
`cf pattern history <entry>` lists the versions and
`cf pattern rollback <entry> <version>` restores one over the files (then
`setsrc` to update the piece). Rollback refuses over edits never deployed.
Deploys never share by themselves. When the person's sharing setting covers what
they build, the index shares a version anonymously once they have used it in a
loom for a day with no newer version and it passes the privacy check, and the
deploy line says so (`version.autoShare: "when_used"` under `--json`). Run
`cf pattern share` only when the person asks to share it sooner, or to share it
with the setting off. In a tight edit loop, pass `--no-index-version` so deploys
do not wait on the index.

**Sharing**, so others can find it, takes the same identity, API URL, space and
packaging flags (`--test`, `--datafile`) it was deployed with, so the shared id
is the deployed one:

```bash
deno task cf pattern share patterns/[name]/main.tsx --test patterns/[name]/main.test.tsx --json --identity cf.key --api-url $CF_API_URL --space <space>
```

Sharing is anonymous: others see a pseudonym of this pattern alone.
`cf pattern publish` instead shows the person's name, which cannot be unseen:
run it only when they ask, and pass `--as "<name>"` only after they agree to the
name it prints. The person joins once by piping their invite link to
`cf index join` (the link carries a secret; keep it off the command line). A
second machine does not redeem another invite: the first runs
`cf delegation issue --index --to <DID>` and the second
`cf index join --chain <file>`. Sharing checks the pattern for personal details
and may rewrite the files into a general version; when `localCheck.applied` is
`true`, tell the person what changed (`git diff`, or the kept version that
`cf pattern rollback` restores), and update the deployed piece with the
rewritten files (`cf piece setsrc`, below) so it runs the source the index
shared. `outcome: "blocked"` shared nothing, and `next` says what to do before
running it again. The rest is in `runtime/cli/README.md`, "Keeping, sharing and
publishing in the pattern index".

**Update deployed pattern (all subsequent iterations):**

```bash
deno task cf piece setsrc patterns/[name]/main.tsx --test patterns/[name]/main.test.tsx --cell <ID> --identity cf.key --api-url $CF_API_URL --space <space>
```

`--cell` is required for `setsrc` — never "update" by re-running `piece new`,
which creates a duplicate piece.

`--test` packages and type-checks a test but does not run it. Every `setsrc`
defines the complete source revision, so repeat all test flags on every update
or the new revision will omit those test roots.

A pattern reads a file that is not code — a fixture, a lookup table — with
`dataFile(path)` from `commonfabric`, naming it relative to the module that
reads it. That call is the declaration, so `new`, `setsrc`, `check` and `test`
all attach the file without being told. It is never parsed, compiled, or
importable, and `getsrc` returns it byte for byte. It must sit inside the
deployment root, and be UTF-8 text, which `dataFile(path)` reads, or an image, a
font, or a sound, which `dataFile.url(path)` reads as a `data:` URL
(`dataFile.urls(directory)` reads a directory of them). Repeatable
`--datafile <path>` remains for a file the source cannot name: one read by a
computed path, or one that ships with a pattern that does not read it. The same
complete-revision rule applies to those, so repeat every data-file flag on each
update too.

**Inspect piece state:**

```bash
deno task cf piece inspect --cell <ID> --identity cf.key --api-url $CF_API_URL --space <space>
```

**Test handler via CLI:**

```bash
deno task cf piece call --cell PIECE_ID handlerName
deno task cf piece step --cell PIECE_ID    # Required with server execution off
deno task cf piece inspect --cell PIECE_ID  # Now shows updated state
```

**Important:** With server execution off, always run `piece step` after
`cf
piece call` or `cf cell set`. Without it, computed values remain stale and
`inspect`/`get` return old data. Under server execution those reads pull current
values from the server, and the step adds nothing.

## When Deploy Fails

- If `piece new` or `setsrc` errors, re-run `deno task cf check` locally first.
- Verify `CF_API_URL` is reachable (see the cf skill's troubleshooting table).
- If you accidentally ran `new` twice, remove the duplicate with
  `deno task cf piece rm --cell <ID> ...` before continuing.
- Never retry `new` to "fix" a failed `setsrc`.

## Get Help

```bash
deno task cf --help
deno task cf piece --help
```

## Done When

- Piece deploys without errors
- Every automated pattern test passes
- Every authored test entry is attached to the deployed source revision
- State inspects correctly
- Handlers respond to CLI calls
