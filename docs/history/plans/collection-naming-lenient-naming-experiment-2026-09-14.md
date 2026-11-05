---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Record of the local lenient-naming experiment on branch experiment/lenient-naming (head 8a194f9bcf, not pushed) and its follow-up checks: naming the existing members of a collection board, and how a member's name reaches it."
---

<!-- deno-fmt-ignore-file -->
<!--
  The fenced blocks in this record are verbatim quotes: committed output and
  pattern source from the experiment branch, and commands re-run against it.
  The markdown formatter re-indents fenced code and re-aligns tables, so
  running it over this file would rewrite the evidence the record carries.
  The prose outside those blocks is wrapped to the settings the formatter
  would apply, so what this directive protects is the quotes alone.
-->

# The lenient-naming experiment: naming a board's existing members

[`collection-naming-topics.md`](../../plans/collection-naming-topics.md) rules,
in decision 13, that a name reaches a member through the member's own wiring to
the board's names table, and, in decision 14, that a member takes one input
naming its board. This record reports a local experiment that took a board whose
members were filed before it had a namespace, upgraded it to one that names
them, and followed each member's name to the member. It then reports three
follow-up checks: check 3, on when a member's name reaches it; check 4, on the
two forms in which the board stores a name; and a browser check of the same in
the shell.

The experiment ran on a local toolshed with its own store. The board and item
patterns are experiment copies under `packages/patterns/cn-lenient/`, not the
exemplar in `packages/patterns/collection-naming/` and not Topics.

## What the blocks show

The section each statement rests on is named in it.

- A generation-1 board declaring its members' `shortName` as optional `unknown`
  was accepted over seven generation-0 members, and the same board declaring it
  `string` was refused (§ The lenient upgrade and the strict control).
- `cf piece survey --retarget` and `cf piece retarget --apply` moved all seven
  members to the generation-1 item; member A's `board` input then held a default
  record, not a link, and the discovery rig counted all seven unbound (§
  Retarget and § The discovery counts).
- `backfillNames` named the seven in filing order and a second run named none;
  `/top/3` resolved to member C, and C rendered no name (§ Backfill).
- `cf piece repair` refused to write the board link into five members' `board`
  inputs, and a two-pass repair on one of them was refused too; `cf piece link`
  wrote it into each, and the discovery counts went to zero (§ The repair
  refusal, § Binding by link, and § The discovery counts).
- A member wired to the board read its own name only after the board's
  `namesTable` was read with `--step`. Reads of that table without `--step`, and
  a `--step` read of a different board output, did not deliver it. Lazy
  materialization off did not change that; with server execution on, measured on
  copies of the store, the first member read carried the name (§ Check 3).
- The names map holds two link forms, one written by `addItem` and one by
  `backfillNames`. For the cases checked — double naming, reverse lookup,
  resolution and removal — the second form was not a defect (§ Check 4).
- In the shell, a member opened before its board showed no name badge within
  300000 ms, and showed it after the board had been opened. A first run, whose
  reads reported no badge without waiting for one, is kept and shows nothing (§
  The browser check).

## Where the evidence is

Every output quoted here is committed on the local branch
`experiment/lenient-naming` in the worktree
`/Users/mike/projects/labs-throwaway/cn-lenient`. The branch was not pushed, so
each block is copied here, and each names the branch file it comes from and the
commit that added that file. The branch, from its base:

```
$ git log --format='%h %ad %s' --date=iso 51f8c11053^..8a194f9bcf
8a194f9bcf 2026-09-14 22:39:10 -0700 experiment(cn-lenient): browser check of member names in the shell; member V; the single-read run kept and marked broken
96546ecaaf 2026-09-14 22:28:21 -0700 experiment(cn-lenient): member U filed on the original store under the baseline posture; servers stopped
f4e66301e8 2026-09-14 22:26:32 -0700 experiment(cn-lenient): clean variant B servers stopped; pre-start record for baseline session 2 on the original store
48deb92979 2026-09-14 22:26:05 -0700 experiment(cn-lenient): check 3c variant B on the clean copy, server execution on; variant A stop record
ce851235ff 2026-09-14 22:03:45 -0700 experiment(cn-lenient): variant B servers stopped, clean store copy for a second server-execution run
1bbc373c94 2026-09-14 22:03:20 -0700 experiment(cn-lenient): check 3c variant B, server execution on; a broken rig run kept on record, the rig repaired, and the measurement
686781a54a 2026-09-14 22:00:03 -0700 experiment(cn-lenient): check 3c variant A, lazy materialization off, on a copy of the store
fed953bec2 2026-09-14 21:59:00 -0700 experiment(cn-lenient): baseline servers stopped, store copied for the check 3c flag variants
bb2ee37cbf 2026-09-14 21:57:44 -0700 experiment(cn-lenient): check 4b removal across both stored forms; position control rebuilt from raw items after a rig quoting bug
5a1fbfa09b 2026-09-14 21:55:16 -0700 experiment(cn-lenient): check 4b double naming with control, reverse lookup and resolution for both stored forms
932ce1d61e 2026-09-14 21:53:43 -0700 experiment(cn-lenient): check 4a raw inventory of the names map and items list, with the rig's known-case self-check
12cdf0d06b 2026-09-14 21:51:09 -0700 experiment(cn-lenient): check 3a reproduction on two new members, with the two non-demanding controls
bac8fec887 2026-09-14 17:33:05 -0700 experiment(cn-lenient): removal and discovery controls, toolshed stopped
b022052d3a 2026-09-14 17:30:17 -0700 experiment(cn-lenient): verification at zero, displayed names, idempotence control
fc77778368 2026-09-14 17:27:31 -0700 experiment(cn-lenient): two-pass repair probe on one member, refused at the schema and the field-loss guard
b334eb4f86 2026-09-14 17:26:48 -0700 experiment(cn-lenient): Q3 repair refusal and its code, unwired member I, pass-1 fixer
59bbdfc54e 2026-09-14 17:24:53 -0700 experiment(cn-lenient): discovery after backfill, wired-member control, raw links, link baseline, fixer
0f27b34d4a 2026-09-14 17:17:24 -0700 experiment(cn-lenient): Q2 backfill, slug and address spellings, map address probes
b7f3f7e32d 2026-09-14 17:15:35 -0700 experiment(cn-lenient): Q1 board and item legs, id mapping, format probes, first discovery reading
30f96643f1 2026-09-14 17:03:59 -0700 experiment(cn-lenient): generation-0 and lenient generation-1 exemplar, strict control, recording helpers
51f8c11053 2026-09-15 09:52:29 +1000 test(cli): isolate color rendering from inherited environment (#7472)
```

Outside `experiment-output/` and `packages/patterns/cn-lenient/`, the branch
changes nothing, so every server and every `cf` process ran the code of
`51f8c11053`, whichever branch commit it was started at. The browser check's
script is the exception, and § The browser check says where it ran:

```
$ git diff --stat 51f8c11053 8a194f9bcf -- . ':!experiment-output' ':!packages/patterns/cn-lenient'
```

That command, and the other `git log`, `git grep`, `git show` and `jq` commands
quoted with a `$` line in this record, were run on 2026-09-15 against the
committed branch, in its worktree, when this record was written. Every other
block is a committed file's content.

A block shows what a command printed or what a file holds. It cannot show when
something was done, or that something was not done, so statements of those two
kinds rest on the author's account. Among them: that the runs took place on
2026-09-14, Pacific time, where the UTC timestamps in quoted plan rows read
2026-09-15; that the branch was not pushed; that no deployed space, Estuary
included, was contacted; the order of steps where no file records it; that
between filing member U and stopping baseline session 2 nothing ran a `cf`
command against the toolshed; that the browser check's servers were started
after that stop, and that on them the first browser run read member U, member V
was then filed with the `cf piece call` quoted in § Member V, and the second run
read V; that nothing read the board between filing member V and the second
browser run; that the first `cf piece link` of step 21 may have overlapped a
`backfillNames` call; and every statement that something was not compared,
recorded or tried.

Two trims are used. Lines are elided and marked `…`; in particular, every `cf`
process printed an `Experimental flag overrides:` line, a `NEXT STEPS` hint and
`(Use --quiet to suppress hints)` lines, and blocks below replace them with `…`,
except three member reads in § Check 3 and member V's filing in § Member V,
which keep the override line to show their server's posture; § Setup quotes the
line for the experiment's posture. And terminal color codes are removed from the
two browser `run.txt` files, which hold them; every other file was recorded with
them already removed. A `$` line that `rec.sh` recorded is quoted as recorded,
so `$BOARD` and `$OUT` in it are the variables `env.sh` defines.

Four statements in this record were read in code rather than measured, and each
says so where it is made: what the survey's validator reads, in § The discovery
rig; the scheduling explanation in § Check 3; the `equals` caveat in § Check 4;
and the wait bound in § The browser check.

The first three quote `origin/main` at `e1bbc1d549`, which is not a commit of
the experiment branch. The two histories meet at the branch's base,
`51f8c11053`, and that base is the code every server and every `cf` process ran.
Each snippet those three statements quote stands byte for byte at the base as
well as at `e1bbc1d549`, so the code shown is the code the experiment ran. Three
of the four files they quote hold no change at all between the two commits:

```
$ git merge-base e1bbc1d549 8a194f9bcf
51f8c11053771c3acf4099354b776775d489d93d

$ git diff --stat 51f8c11053 e1bbc1d549 -- packages/piece/src/ops/bulk-survey.ts packages/cli/lib/piece.ts packages/patterns/collection-naming/naming.ts
```

The fourth, `packages/runner/src/cell.ts`, does change between them, elsewhere
in the file. The two snippets this record quotes from it — the documentation
comment of `pull()` in § Check 3 and `equals` in § Check 4 — are identical at
both commits:

```
$ git diff --stat 51f8c11053 e1bbc1d549 -- packages/runner/src/cell.ts
 packages/runner/src/cell.ts | 78 +++++++++++++++++++++++++++++++--------------
 1 file changed, 54 insertions(+), 24 deletions(-)

$ for c in 51f8c11053 e1bbc1d549; do git show $c:packages/runner/src/cell.ts | sed -n "/^   \* Pull the cell's value/,/^   \*\//p" | shasum; git show $c:packages/runner/src/cell.ts | sed -n '/^    equals($/,/^    },$/p' | shasum; done
997c1157ccb9284a6b0b214ece1b04ab498c0e45  -
964bb8b40f51d3559ba824a0e3c784355ba568d5  -
997c1157ccb9284a6b0b214ece1b04ab498c0e45  -
964bb8b40f51d3559ba824a0e3c784355ba568d5  -
```

`packages/patterns/collection-naming/naming.ts` is unchanged on the experiment
branch too, and § The patterns quotes the import through which the experiment's
board takes `nameOf` from it, so the `nameOf` quoted in § Check 4 is the source
that board ran:

```
$ git diff --stat 51f8c11053 8a194f9bcf -- packages/patterns/collection-naming/naming.ts
```

The fourth statement, the wait bound, quotes `packages/integration/utils.ts` at
`2919bb0509`, and says so where it is made. That is the commit the browser
check's own README names as the worktree the check ran from, and § The browser
check quotes that README whole.

## Setup

### The recording helper and its environment

Every step recorded through `rec.sh` has its command line, its combined output,
its exit status and its wall-clock seconds in the step's file. Both files were
added in `30f96643f1`, and `env.sh` was changed in `b7f3f7e32d`; this is their
content at `8a194f9bcf`.

`experiment-output/rec.sh`:

```bash
#!/usr/bin/env bash
# rec.sh <log> <command...>
#
# Runs one command from the repository root with env.sh loaded, and appends to
# <log> (and echoes) the command line, its combined stdout and stderr with
# terminal color codes removed, its exit status, and its wall-clock seconds.
set -u
log="$1"; shift
source "$(dirname "$0")/env.sh"
tmp=$(mktemp)
start=$(python3 -c 'import time; print(time.time())')
(cd "$REPO" && eval "$*") >"$tmp" 2>&1
status=$?
end=$(python3 -c 'import time; print(time.time())')
{
  printf '$ %s\n' "$*"
  sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' "$tmp"
  printf '[exit %d, %ss]\n\n' "$status" \
    "$(python3 -c "print(f'{$end - $start:.2f}')")"
} | tee -a "$log"
rm -f "$tmp"
exit "$status"
```

`experiment-output/env.sh`:

```bash
# Sourced by every recorded command. The toolshed is the one this experiment
# started: loopback, port offset 470, its own store under the scratchpad.
export CF_API_URL=http://localhost:8470
export CF_IDENTITY=/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/experiment.key
export CF_SPACE=cn-lenient-exp
export REPO=/Users/mike/projects/labs-throwaway/cn-lenient
export OUT=$REPO/experiment-output
cf() { (cd "$REPO" && deno run -q -A packages/cli/mod.ts "$@"); }
export BOARD=/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI
```

So `cf` in every recorded command is the CLI run from source in the branch's
worktree.

### The servers, their start commands and their flags

The experiment's steps 00–28 ran against one toolshed and shell. From
`experiment-output/00-setup.txt` (added in `30f96643f1`), its lines other than
the fifth, which is the toolshed's `/api/meta` document:

```
git HEAD: 51f8c11053771c3acf4099354b776775d489d93d
deno 2.9.4 (stable, release, aarch64-apple-darwin)
toolshed pid 38091 on 127.0.0.1:8470, shell pid 38106 on 127.0.0.1:5643 (started by this experiment via scripts/start-local-dev.sh --port-offset 470, HOST=127.0.0.1)
MEMORY_DIR=file:///private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/store/
…
38091 deno run --unstable-otel -A --env-file=.env index.ts --port=8470
Experimental flag overrides: serverExecution=false
```

The fifth line, reduced to its flags:

```
$ git show 8a194f9bcf:experiment-output/00-setup.txt | sed -n 5p | jq -c '{gitSha, shellServerExecutionDefine, experimental}'
{"gitSha":"51f8c11053771c3acf4099354b776775d489d93d","shellServerExecutionDefine":null,"experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":true,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":false}}
```

The line each `cf` process printed under that posture, from
`experiment-output/01-deploy-v0.txt` (added in `b7f3f7e32d`):

```
Experimental flag overrides: modernCellRep=false, commitPreconditions=true, plainResultReceipts=true, computedCellIds=true, lazyMaterialization=true, serverExecution=false, contentAddressedSchemas=true, readerSchemaPrecedence=true
```

The checks recorded five server sessions with
`experiment-output/checks/rigs/record-servers.sh` (added in `fed953bec2`), whose
`/api/meta` and log lines are:

```bash
  echo "--- /api/meta posture"
  curl -s http://127.0.0.1:8470/api/meta | jq -c '{gitSha, experimental}'
  echo "--- toolshed log override line"
  grep 'Experimental flag overrides' "$REPO/packages/toolshed/local-dev-toolshed.log"
```

The start command each record names, and the flags each toolshed reported:

```
$ git grep -n -e '^--- variant' -e '^--- baseline session' 8a194f9bcf -- experiment-output/checks
8a194f9bcf:experiment-output/checks/00-servers-baseline-1.txt:1:--- baseline session 1: servers this check started (recorded start command, store at the recorded path)
8a194f9bcf:experiment-output/checks/11-servers-3c-lazy-off.txt:1:--- variant A: EXPERIMENTAL_LAZY_MATERIALIZATION=false HOST=127.0.0.1 MEMORY_DIR=file://<scratchpad>/cn-checks/store-lazy-off/ ./scripts/start-local-dev.sh --port-offset 470
8a194f9bcf:experiment-output/checks/14-servers-3c-server-exec-on.txt:1:--- variant B: EXPERIMENTAL_SERVER_EXECUTION=true HOST=127.0.0.1 MEMORY_DIR=file://<scratchpad>/cn-checks/store-server-exec-on/ ./scripts/start-local-dev.sh --port-offset 470
8a194f9bcf:experiment-output/checks/19-servers-3c-server-exec-on-clean.txt:1:--- variant B, clean copy: EXPERIMENTAL_SERVER_EXECUTION=true HOST=127.0.0.1 MEMORY_DIR=file://<scratchpad>/cn-checks/store-server-exec-on-clean/ ./scripts/start-local-dev.sh --port-offset 470
8a194f9bcf:experiment-output/checks/22-servers-baseline-2.txt:8:--- baseline session 2 (original store): HOST=127.0.0.1 MEMORY_DIR=file:///private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/store/ ./scripts/start-local-dev.sh --port-offset 470
```

| session | record, and the commit that added it | `/api/meta` and the toolshed's override line |
| --- | --- | --- |
| baseline 1 (checks 3a, 4) | `checks/00-servers-baseline-1.txt`, `12cdf0d06b` | block A |
| variant A (lazy materialization off) | `checks/11-servers-3c-lazy-off.txt`, `686781a54a` | block B |
| variant B (server execution on) | `checks/14-servers-3c-server-exec-on.txt`, `1bbc373c94` | block C |
| variant B, clean copy | `checks/19-servers-3c-server-exec-on-clean.txt`, `48deb92979` | block D |
| baseline 2 (member U) | `checks/22-servers-baseline-2.txt`, `f4e66301e8` (changed in `96546ecaaf`) | block E |

Block A, from `checks/00-servers-baseline-1.txt`:

```
--- /api/meta posture
{"gitSha":"bac8fec8875301a24af3897865198fc3755c8ebd","experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":true,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":false}}
--- toolshed log override line
Experimental flag overrides: serverExecution=false
```

Block B, from `checks/11-servers-3c-lazy-off.txt`:

```
--- /api/meta posture
{"gitSha":"fed953bec253056a2d359efc6c7f6466819d6b20","experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":false,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":false}}
--- toolshed log override line
Experimental flag overrides: lazyMaterialization=false, serverExecution=false
```

Block C, from `checks/14-servers-3c-server-exec-on.txt`:

```
--- /api/meta posture
{"gitSha":"686781a54a28c290e58913677d10c7cbb3bacae7","experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":true,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":true}}
--- toolshed log override line
Experimental flag overrides: serverExecution=true
```

Block D, from `checks/19-servers-3c-server-exec-on-clean.txt`:

```
--- /api/meta posture
{"gitSha":"1bbc373c940c22528954725f706bebb411c15308","experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":true,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":true}}
--- toolshed log override line
Experimental flag overrides: serverExecution=true
```

Block E, from `checks/22-servers-baseline-2.txt`, with the check of the
launching shell's environment that precedes it:

```
--- 22: before starting baseline session 2 on the ORIGINAL store
listeners on 8470/5643: []
launching shell: no EXPERIMENTAL_*, CF_ADOPT_SERVER_FLAGS, SERVER_EXECUTION_STORE_READ_THROUGH, HOST, MEMORY_DIR, PORT_OFFSET set: 0 matching variables
packages/toolshed/.env lines naming EXPERIMENTAL or SERVER_EXEC: 0
…
--- /api/meta posture
{"gitSha":"f4e66301e8554624d08a712d09c478fa3a7f6d16","experimental":{"commitPreconditions":true,"computedCellIds":true,"contentAddressedSchemas":true,"lazyMaterialization":true,"modernCellRep":false,"plainResultReceipts":true,"readerSchemaPrecedence":true,"serverExecution":false}}
--- toolshed log override line
Experimental flag overrides: serverExecution=false
```

The browser check ran on servers started once more, and no file records their
`/api/meta` document; § The browser check quotes what its `README.txt` states
about them. Each `gitSha` above is the base or a branch commit, and the empty
diff above shows the code is `51f8c11053`'s at every one of them.

`cf` also printed a version warning on the failed commands quoted here, since
the CLI ran at the worktree's current commit and the toolshed at the commit it
was started at. From `experiment-output/03-q1-board-check-strict.txt` (added in
`b7f3f7e32d`):

```
Version context: cf is newer than the server at http://localhost:8470 — the server
    (51f8c11053771c3acf4099354b776775d489d93d) is 1 commit(s) behind this cf (30f96643f1feddd9b3919657e5ae8e359aae4222).
```

The blocks below elide that warning where it appears.

### The patterns

Five pattern files, added in `30f96643f1` under `packages/patterns/cn-lenient/`.
`v0-board.tsx` and `v0-item.tsx` are generation 0: a board with an item list and
no namespace, whose `addItem` wires nothing into an item. Its create, from
`v0-board.tsx`:

```tsx
      const piece = Item({ title: trimmed, body: body ?? "", createdAt });
      items.push(piece);
      return { item: piece };
```

`v1-board.tsx` is generation 1. Its row demand over a member, its create, and
the two verbs it carries for the experiment's controls:

```tsx
/** One row of the board's index: the item itself. */
export interface ItemIndexRow {
  /** The item's title. */
  title: string | Default<"">;

  /** When the item was filed (epoch milliseconds). */
  createdAt: number;

  /**
   * The member's own view of its name. Optional `unknown`: a generation-0
   * member publishes nothing here, and the board never relies on it.
   */
  shortName?: unknown;
}
…
        const piece = Item({
          title: trimmed,
          body: body ?? "",
          createdAt,
          board: self,
        });
        const name = assignName(names, piece);
        items.push(piece);
        return { item: piece, name };
…
    const fileUnwired = action<AddItemEvent, FileUnwiredResult>(
      ({ title, body, agentName }) => {
…
        const piece = Item({
          title: trimmed,
          body: body ?? "",
          createdAt: Date.now(),
        });
        items.push(piece);
        return { item: piece };
      },
    );
…
    const removeItem = action<RemoveItemEvent, RemoveItemResult>(
      ({ name, agentName }) => {
…
        const target = (names.get() ?? {})[name];
        if (target === undefined) reject("removeItem", `no member ${name}`);
        const listed = items.get();
        for (let position = 0; position < listed.length; position++) {
          const member = items.key(position).resolveAsCell();
          if (equals(member, target as object)) {
            items.removeByValue(items.key(position));
            return { position };
          }
        }
        return reject("removeItem", `member ${name} is not in the list`);
      },
    );
```

The board takes `nameOf`, `namesTable` and `backfillNames` from `naming.ts`, and
its `rows` output puts each member's title beside the name the names table gives
it:

```tsx
import {
  assignName,
  backfillNames,
  nameOf,
…
} from "../collection-naming/naming.ts";
…
        name: nameOf(member, table) ?? "",
…
    const table = namesTable({ names });
    const rows = boardRows({ members: items, table });
```

`v1-item.tsx` is the generation-1 item. It takes decision 14's one `board`
input, optional, and reads its own name out of the board's names table:

```tsx
export interface ItemBoardDemand {
  /** The board's names table, one row per named member. */
  namesTable: NamesTableRow[] | Default<[]>;
}
…
  board?: ReadonlyCell<ItemBoardDemand>;
…
    const shortName = ownName({ table: board!.key("namesTable"), self });
```

and renders it as a badge beside the title:

```tsx
              {shortName
                ? (
                  <cf-badge size="sm" color="primary" data-member-name="">
                    {shortName}
                  </cf-badge>
                )
                : null}
```

`v1-board-strict.tsx` is the control. Its whole difference from `v1-board.tsx`
is a comment and one type:

```
$ git diff --no-index packages/patterns/cn-lenient/v1-board.tsx packages/patterns/cn-lenient/v1-board-strict.tsx
diff --git a/packages/patterns/cn-lenient/v1-board.tsx b/packages/patterns/cn-lenient/v1-board-strict.tsx
index d145e5210f..f654179b90 100644
--- a/packages/patterns/cn-lenient/v1-board.tsx
+++ b/packages/patterns/cn-lenient/v1-board-strict.tsx
@@ -1,4 +1,8 @@
 /**
+ * EXPERIMENT CONTROL (strict): v1-board.tsx with the member demand typed
+ * `shortName?: string` instead of optional `unknown`, the one line that
+ * differs. Expected to be refused over generation-0 members.
+ *
  * EXPERIMENT (lenient naming), generation 1: the generation-0 board after it
  * adopts `naming.ts`, written to be applicable over the members it already
  * holds.
@@ -56,7 +60,7 @@ export interface ItemIndexRow {
    * The member's own view of its name. Optional `unknown`: a generation-0
    * member publishes nothing here, and the board never relies on it.
    */
-  shortName?: unknown;
+  shortName?: string;
 }
 
 /** What the board reads of a stored item: exactly the row it publishes. */
```

The members are called by their titles' letters below: A to G filed by
generation 0, H by generation 1's `addItem`, I and J by `fileUnwired`, K and L
by check 3's rig, M by check 4's, N, P, Q and R by check 3's flag variants, and
U and V for the browser check.

## The experiment

### Generation 0

From `experiment-output/01-deploy-v0.txt` (added in `b7f3f7e32d`), the board's
deploy, with two transformer warnings about `packages/patterns/notes/note.tsx`
elided:

```
$ cf piece new packages/patterns/cn-lenient/v0-board.tsx --root "$REPO"
…
wrote to space cn-lenient-exp
fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI
…
[exit 0, 6.78s]
```

`experiment-output/02-file-v0-members.txt` (added in `b7f3f7e32d`) holds the
`addItem` calls that filed "Legacy item A" to "Legacy item G", and then the
board's index, whole. The `createdAt` each row carries is when the item was
filed, in the description both boards compiled it to (§ The lenient upgrade and
the strict control), and it ascends from A to G, so the index is in filing
order:

```
$ cf cell get $BOARD index --select "@,title,createdAt"
…
[
  {
    "$link": "/of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco",
    "title": "Legacy item A",
    "createdAt": 1789430663000
  },
  {
    "$link": "/of:fid1:2d-0sZs3u9kXK_FYvHa0zeFKmvE9Dl4vMpyS_iWXlgQ",
    "title": "Legacy item B",
    "createdAt": 1789430664000
  },
  {
    "$link": "/of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4",
    "title": "Legacy item C",
    "createdAt": 1789430665000
  },
  {
    "$link": "/of:fid1:6_rf-QTHfh1ZF7y3lTaTCS7GOVPP8Ch35qW7458QZeU",
    "title": "Legacy item D",
    "createdAt": 1789430666000
  },
  {
    "$link": "/of:fid1:MOw7HWau2bDYPUGVloMy06OS8uMlldBZWb_mIWUWflM",
    "title": "Legacy item E",
    "createdAt": 1789430667000
  },
  {
    "$link": "/of:fid1:P8hC0z70UnuuOIchd-o_waRkj6Dh70_YC9Eu3Bp1tXk",
    "title": "Legacy item F",
    "createdAt": 1789430668000
  },
  {
    "$link": "/of:fid1:_Y1OtmESlCPxogjFFvSDA7n0uz_2FIjYmSDTvhk6AbU",
    "title": "Legacy item G",
    "createdAt": 1789430669000
  }
]
[exit 0, 0.57s]
```

### The lenient upgrade and the strict control

Four `cf piece setsrc --check` runs, each in its own file added in `b7f3f7e32d`.
The generation-0 source over the board, as a control that the check accepts what
the board already runs, from
`experiment-output/03-q1-board-check-control-v0.txt`:

```
$ cf piece setsrc --check --cell $BOARD --root "$REPO" packages/patterns/cn-lenient/v0-board.tsx
…
packages/patterns/cn-lenient/v0-board.tsx can replace the source for piece of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI
…
[exit 0, 0.67s]
```

The lenient board, from `experiment-output/03-q1-board-check-lenient.txt`:

```
$ cf piece setsrc --check --cell $BOARD --root "$REPO" packages/patterns/cn-lenient/v1-board.tsx
…
packages/patterns/cn-lenient/v1-board.tsx can replace the source for piece of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI
…
[exit 0, 0.99s]
```

The strict board, from `experiment-output/03-q1-board-check-strict.txt`:

```
$ cf piece setsrc --check --cell $BOARD --root "$REPO" packages/patterns/cn-lenient/v1-board-strict.tsx
…
packages/patterns/cn-lenient/v1-board-strict.tsx cannot replace the source for piece of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI:
piece source is incompatible with retained input: input link at items.0 schema is not compatible: input link at items.0.shortName: the candidate no longer accepts every previous type
…
[exit 1, 1.01s]
```

The row demand each board compiled to, from
`experiment-output/03-q1-compiled-item-demand.txt`. The strict board's
`description` is the lenient one's because the comment above the property is
unchanged:

```
##### v0-board argumentSchema.$defs.ItemIndexRow
{"type":"object","properties":{"title":{"type":"string","default":"","description":"The item's title."},"createdAt":{"type":"number","description":"When the item was filed (epoch milliseconds)."}},"required":["title","createdAt"]}
##### v1-board argumentSchema.$defs.ItemIndexRow
{"type":"object","properties":{"title":{"type":"string","default":"","description":"The item's title."},"createdAt":{"type":"number","description":"When the item was filed (epoch milliseconds)."},"shortName":{"type":"unknown","description":"The member's own view of its name. Optional `unknown`: a generation-0\nmember publishes nothing here, and the board never relies on it."}},"required":["title","createdAt"]}
##### v1-board-strict argumentSchema.$defs.ItemIndexRow
{"type":"object","properties":{"title":{"type":"string","default":"","description":"The item's title."},"createdAt":{"type":"number","description":"When the item was filed (epoch milliseconds)."},"shortName":{"type":"string","description":"The member's own view of its name. Optional `unknown`: a generation-0\nmember publishes nothing here, and the board never relies on it."}},"required":["title","createdAt"]}
```

The generation-1 item over member A, checked before the board moved, from
`experiment-output/03-q1-item-check-before-board.txt`:

```
$ cf piece setsrc --check --cell /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco --root "$REPO" packages/patterns/cn-lenient/v1-item.tsx
…
packages/patterns/cn-lenient/v1-item.tsx can replace the source for piece of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco
…
[exit 0, 0.87s]
```

The lenient board applied, and the board read back, from
`experiment-output/04-q1-board-apply-lenient.txt` (added in `b7f3f7e32d`), with
the index read and the middle five rows of `rows` elided:

```
$ cf piece setsrc --cell $BOARD --root "$REPO" packages/patterns/cn-lenient/v1-board.tsx
…
wrote to space cn-lenient-exp
Committed source update for piece of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI (Pattern Ref: cf:module/z3gey2ZhM6fzUDcpVBUILpMR5JUxZtW61KEGi6mnwOA#default, Revision: 4b99decd-93d6-4a51-9ae0-63d3e1ae3f01, Seq: 49)
…
[exit 0, 1.25s]
…
$ cf cell get $BOARD names
…
{}
[exit 0, 0.46s]

$ cf cell get $BOARD rows --step
…
[
  {
    "name": "",
    "title": "Legacy item A"
  },
…
  {
    "name": "",
    "title": "Legacy item G"
  }
]
[exit 0, 0.85s]

$ cf cell get $BOARD itemCount --step
…
7
[exit 0, 0.67s]
```

### Retarget

From `experiment-output/05-q1-item-leg-retarget.txt` (added in `b7f3f7e32d`):
the survey that stamps the retarget, the plan's header row and first member row,
the dry run, the apply, and the survey that checks the plan:

```
$ cf piece survey --cell $BOARD --path items --retarget "items=packages/patterns/cn-lenient/v1-item.tsx" --root "$REPO" --out "$OUT/plans/retarget.jsonl"
…
Wrote 8 plan rows to /Users/mike/projects/labs-throwaway/cn-lenient/experiment-output/plans/retarget.jsonl
…
items: 7 on HTSPZc-y2sFD8uFNE_AtQUN9jAvUNpcYi3X2H7TYHX4#default
…
holder: 1 on z3gey2ZhM6fzUDcpVBUILpMR5JUxZtW61KEGi6mnwOA#default
…
[exit 0, 0.89s]

--- plan file ---
{"kind":"piece-plan","v":1,"space":"did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB","takenAt":"2026-09-15T00:06:07.566Z","selector":"collection","enumerated":{"collection":7,"registry":1,"registeredOutside":0}}
{"piece":"fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds","phase":"items","expect":{"patternIdentity":"HTSPZc-y2sFD8uFNE_AtQUN9jAvUNpcYi3X2H7TYHX4","symbol":"default","retained":true},"op":{"kind":"retarget","source":{"main":"/Users/mike/projects/labs-throwaway/cn-lenient/packages/patterns/cn-lenient/v1-item.tsx","root":"/Users/mike/projects/labs-throwaway/cn-lenient"},"patternIdentity":"mXo6c40OWD0v4xN-EPLEFSQCFCg3PRdUeBmk_kvNjOE","symbol":"default"}}
…
$ cf piece retarget --plan "$OUT/plans/retarget.jsonl"
…
outstanding: 7 · written: 0
…
[exit 0, 0.48s]

$ cf piece retarget --plan "$OUT/plans/retarget.jsonl" --apply --out "$OUT/plans/retarget-applied.json"
…
applied: 7 · written: 7
…
[exit 0, 1.38s]

--- applied report ---
$ cf piece survey --cell $BOARD --path items --diff "$OUT/plans/retarget.jsonl"
…
moved as planned: 7
still outstanding: 0
moved to something the plan did not ask for: 0
unchanged, with no operation planned: 1

items: 7 on mXo6c40OWD0v4xN-EPLEFSQCFCg3PRdUeBmk_kvNjOE#default
…
[exit 0, 0.98s]
```

What a retargeted member holds in its `board` input. From
`experiment-output/07-probe-formats.txt` (added in `b7f3f7e32d`), for member A:
the input's address is a position inside A's own argument document, and its
value is the input's default; a demand for `shortName` alone is refused; a read
of `title` and `shortName` returns the title; and A renders no badge:

```
$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco board --input --select '@'
…
{
  "$link": "/of:fid1:xz6jlpbON5SiFC-XFYRqJhGMuHEAiW3rvHyPn0_a2-Q/board"
}
[exit 0, 0.49s]

$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco board --input
…
{
  "namesTable": []
}
[exit 0, 0.47s]
…
$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco shortName --step
…
Cannot read piece result at "shortName": stored data is present, but its schema could not resolve all required values. The piece was stepped, but the required value still did not materialize.
…
[exit 1, 0.64s]

$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco --step --select 'title,shortName'
…
{
  "title": "Legacy item A"
}
[exit 0, 0.66s]

$ cf piece render --cell /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item A</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.61s]
```

The stored argument document itself, read offline from the store, in
`experiment-output/12-raw-links-after-backfill.txt` (added in `59bbdfc54e`):

```
$ cf inspect value-at <store>/engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite of:fid1:xz6jlpbON5SiFC-XFYRqJhGMuHEAiW3rvHyPn0_a2-Q --full-depth
{
  "body": "filed by generation 0",
  "createdAt": 1789430663000,
  "title": "Legacy item A",
  "board": {
    "namesTable": []
  }
}
```

A member has two addresses in these files. `experiment-output/06-id-mapping.txt`
(added in `b7f3f7e32d`) resolves the index row's address for A to the piece id
`cf piece inspect` reports, with everything after `patternRef` elided:

```
$ cf piece inspect --cell /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco --json
…
{
  "id": "fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds",
  "name": "Legacy item A",
  "patternRef": {
    "identity": "mXo6c40OWD0v4xN-EPLEFSQCFCg3PRdUeBmk_kvNjOE",
…
```

§ Check 4 reads what each of the two documents holds.

### Backfill

From `experiment-output/09-q2-backfill.txt` (added in `0f27b34d4a`): the
backfill, the map it wrote, the board's rows after it, whole, and a second run.
A `--select` probe and a read of the names table between them are elided. The
rows give the whole mapping, `1` to A through `7` to G, which is the filing
order the board's index reads in § Generation 0:

```
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}'
…
  "result": {
    "assigned": [
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7"
    ]
  }
}
…
[exit 0, 1.17s]

$ cf cell get $BOARD names
…
{
  "1": {},
  "2": {},
  "3": {},
  "4": {},
  "5": {},
  "6": {},
  "7": {}
}
[exit 0, 0.43s]
…
$ cf cell get $BOARD rows --step
…
[
  {
    "name": "1",
    "title": "Legacy item A"
  },
  {
    "name": "2",
    "title": "Legacy item B"
  },
  {
    "name": "3",
    "title": "Legacy item C"
  },
  {
    "name": "4",
    "title": "Legacy item D"
  },
  {
    "name": "5",
    "title": "Legacy item E"
  },
  {
    "name": "6",
    "title": "Legacy item F"
  },
  {
    "name": "7",
    "title": "Legacy item G"
  }
]
[exit 0, 0.63s]

$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}'
…
  "result": {
    "assigned": []
  }
}
…
[exit 0, 0.73s]
```

The namespace given a slug and resolved, from
`experiment-output/10-q2-slug-resolution.txt` (added in `0f27b34d4a`). `/top/3`
and `/@cn-lenient-exp/top/3` reached C; the `//` form, an unknown member and a
path with no member were refused; and C, named, rendered no badge:

```
$ cf piece set-slug top "$BOARD/names"
…
Set slug top to /of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI/names
…
$ cf cell get /top/3 --select '@,title'
…
{
  "$link": "/of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08",
  "title": "Legacy item C"
}
[exit 0, 1.83s]

$ cf cell get /@cn-lenient-exp/top/3 --select '@,title'
…
{
  "$link": "/of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08",
  "title": "Legacy item C"
}
[exit 0, 2.13s]

$ cf cell get //cn-lenient-exp/top/3 --select '@,title'
Target must include a piece handle, e.g. "/of:fid1:abc123/path".
[exit 1, 1.56s]

$ cf cell get /top/99 title
…
no member 99 in top
…
[exit 1, 2.35s]

$ cf cell get /top title
…
no member title in top
…
[exit 1, 2.23s]

$ cf piece render --cell /@cn-lenient-exp/top/3
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item C</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 3.85s]
```

### A member filed wired

Member H was filed by the generation-1 `addItem`, which wires its `board`. Its
stored argument document, from
`experiment-output/12-raw-links-after-backfill.txt` (added in `59bbdfc54e`):

```
$ cf inspect value-at <store>/engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite of:fid1:Mfl9IGQ5S1ob6M4lZ37d9EBmDNgrozvcwyhuJPxUIVY --full-depth
{
  "board": {
    "$link": {
      "id": "of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI",
      "scope": "space",
      "schema": {
        "$ref": "cid:fid1:FgK0iTcnCDid68uSdD-xGnKecJ2AKUER2kfJPsP-bAM"
      }
    }
  },
  "body": "filed by generation 1, wired at create",
  "createdAt": 1789431499000,
  "title": "New item H"
}
```

From `experiment-output/13-wired-member-control.txt` (added in `59bbdfc54e`),
with the middle rows of the table and H's second read after it elided: H was
named `8`; two `--step` reads of H and a render carried no name; after one
`--step` read of the board's `namesTable`, the next read and the render did:

```
$ cf piece call $BOARD addItem --json '{"title":"New item H","body":"filed by generation 1, wired at create","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "8"
  }
}
…
[exit 0, 5.27s]

$ cf cell get /of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY --step --select 'title,shortName'
…
{
  "title": "New item H"
}
[exit 0, 1.41s]

$ cf cell get /of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY --step --select 'title,shortName'
…
{
  "title": "New item H"
}
[exit 0, 1.54s]

$ cf piece render --cell /top/8
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">New item H</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 1, wired at create"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 1.04s]
…
--- after stepping the board derived table ---
$ cf cell get $BOARD namesTable --step --select name
…
[
  {
    "name": "1"
  },
…
  {
    "name": "8"
  }
]
[exit 0, 1.86s]

$ cf cell get /of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY --step --select 'title,shortName'
…
{
  "title": "New item H",
  "shortName": "8"
}
[exit 0, 1.96s]
…
$ cf piece render --cell /top/8
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">8</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">New item H</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 1, wired at create"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 1.31s]
```

§ Check 3 repeats this on new members with controls.

### The discovery rig

`experiment-output/rigs/discover.sh` counts three gaps from reads alone. It was
added in `b7f3f7e32d` and changed in `59bbdfc54e`; its definitions and member
loop at `8a194f9bcf`:

```bash
#   noEntry   members that no key of the board's `names` map resolves to
#   unbound   members whose `board` input address is a position inside the
#             member's own argument document, which is what an absent binding
#             reads as; a bound one names a document outside it
#   disagree  members whose own `shortName` (read from the member with --step)
#             differs from the name the map gives them; absent on both sides
#             counts as agreement
…
# Re-derive the board's names table first. A member reads its name out of that
# derived table, and with server execution off nothing re-derives it after a
# write to `names` until something steps the board; without this read a
# member's own view lags the map and `disagree` counts the lag.
cf cell get "$BOARD" namesTable --step --select name >/dev/null 2>>"$errlog"
…
  piece="/of:$(cf piece inspect --cell "$resultAddress" --json 2>>"$errlog" |
    jq -r '.id // "READ-FAILED"')"
  boardInput=$(cf cell get "$resultAddress" board --input --select '@' 2>>"$errlog" |
    jq -r '.["$link"] // "READ-FAILED"')
  own=$(cf cell get "$resultAddress" --step --select 'shortName' 2>>"$errlog" |
    jq -c '.shortName // null')
…
      noEntry: ($mapName == null),
      unbound: ($boardInput | test("/board$") or . == "READ-FAILED"),
      disagree: ($own != $mapName)
```

In its rows, `result` is the address of the member's index row and `piece` the
id `cf piece inspect` reports for it.

Three things about which rig produced which count. Step 08 ran the version added
in `b7f3f7e32d`: its file opens with `names map as addresses: {}`, the line that
version prints. `59bbdfc54e` changed the `noEntry` definition, added the table
read and changed that line:

```
$ git diff b7f3f7e32d 59bbdfc54e -- experiment-output/rigs/discover.sh
…
-#   noEntry   members whose address is the value of no key in the board's
-#             `names` map (read from the durable map, not the derived table)
+#   noEntry   members that no key of the board's `names` map resolves to
…
+cf cell get "$BOARD" namesTable --step --select name >/dev/null 2>>"$errlog"
…
-echo "names map as addresses: $(echo "$map" | jq -c .)"
+echo "names map, key -> piece address: $map"
…
```

Step 14 was recorded twice, and the version that produced the first file,
`14-q4-discover-after-backfill.txt`, is not in the branch's history; the second
file's label calls its rig fixed. The comment the name comparison in
`experiment-output/rigs/discover.sh` carries at `8a194f9bcf` says why the forms
differ:

```bash
  # An entry written by addItem renders as the member's result cell and one
  # written by backfillNames as its piece id, so both are normalized through
  # `cf piece inspect`, as the members are below.
```

The rig reads each member's input one member at a time. `cf piece survey` takes
a validator, and the validator is applied to each piece's result. From
`experiment-output/07-probe-survey-validator.txt` (added in `b7f3f7e32d`), with
`experiment-output/rigs/has-short-name.schema.json` (added in `b7f3f7e32d`)
holding
`{"type":"object","required":["shortName"],"properties":{"shortName":{"type":"string"}}}`,
every member and the holder failed at step 07, before the backfill of step 09;
six of the eight identical failures are elided:

```
$ cf piece survey --cell $BOARD --path items --validator "$OUT/rigs/has-short-name.schema.json" --json
…
  "validatorFailures": [
    {
      "piece": "fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds",
      "problem": "stored result is present, but the schema could not resolve all required values"
    },
…
    {
      "piece": "fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI",
      "problem": "stored result is present, but the schema could not resolve all required values"
    }
  ],
  "complete": true
}
…
[exit 0, 2.79s]
```

Read in code: on `origin/main` at `e1bbc1d549`, and identical at the branch's
base, `validateResult` in `packages/piece/src/ops/bulk-survey.ts` reads the
result document and nothing else:

```ts
  const result = await controller.result.getCell();
  const shaped = result.asSchema(validator);
```

### The discovery counts

Every summary line the rig wrote, in file order:

```
$ git grep -e '^{"label"' 8a194f9bcf -- 'experiment-output/*.txt'
8a194f9bcf:experiment-output/08-q4-discover-before-backfill.txt:{"label":"after upgrade and retarget, before backfill","members":7,"noEntry":7,"unbound":7,"disagree":0,"cfProcesses":16,"seconds":10.7}
8a194f9bcf:experiment-output/14-q4-discover-after-backfill-fixed-rig.txt:{"label":"after backfill, before any repair (H filed wired by generation 1); fixed rig","members":8,"noEntry":0,"unbound":7,"disagree":7,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":43,"seconds":85.8}
8a194f9bcf:experiment-output/14-q4-discover-after-backfill.txt:{"label":"after backfill, before any repair (H filed wired by generation 1)","members":8,"noEntry":1,"unbound":7,"disagree":7,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":34,"seconds":72.9}
8a194f9bcf:experiment-output/19-q4-discover-after-repair-attempts.txt:{"label":"after the repair attempts, with unwired I filed; A and B bound by cf piece link","members":9,"noEntry":1,"unbound":6,"disagree":5,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":46,"seconds":35.3}
8a194f9bcf:experiment-output/22-verify-discover-all-bound.txt:{"label":"verify: after second backfill and eight cf piece link binds","members":9,"noEntry":0,"unbound":0,"disagree":0,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":48,"seconds":33.2}
8a194f9bcf:experiment-output/26-control-removal-discover.txt:{"label":"control: after removing member 2 from the list","members":8,"noEntry":0,"unbound":0,"disagree":0,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":45,"seconds":31.6}
8a194f9bcf:experiment-output/27-control-discovery-fires.txt:{"label":"control: after filing unwired J past verification","members":9,"noEntry":1,"unbound":1,"disagree":0,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":48,"seconds":30.9}
8a194f9bcf:experiment-output/27-control-discovery-fires.txt:{"label":"control: after backfilling J, which stays unbound","members":9,"noEntry":0,"unbound":1,"disagree":1,"boardInputsSeen":["/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"],"cfProcesses":50,"seconds":34.0}
```

After the backfill, the fixed rig's rows for A and H, from
`experiment-output/14-q4-discover-after-backfill-fixed-rig.txt` (added in
`59bbdfc54e`): A has a name in the map, its input is a position in its own
argument document, and it reads no name; H is bound and reads `8`:

```
{"piece":"/of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds","result":"/of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco","title":"Legacy item A","mapName":"1","ownShortName":null,"indexShortName":null,"boardInput":"/of:fid1:xz6jlpbON5SiFC-XFYRqJhGMuHEAiW3rvHyPn0_a2-Q/board","noEntry":false,"unbound":true,"disagree":true}
…
{"piece":"/of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","result":"/of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY","title":"New item H","mapName":"8","ownShortName":"8","indexShortName":{},"boardInput":"/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI","noEntry":false,"unbound":false,"disagree":false}
```

### The repair refusal

Members A and B were bound first by `cf piece link`, to have a baseline. From
`experiment-output/15-q3-link-baseline.txt` (added in `59bbdfc54e`), with a
runtime warning in the table read and B's two reads elided:

```
$ cf piece link $BOARD /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco/board
…
wrote to space cn-lenient-exp
Linked /of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI to /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco/board
…
[exit 0, 3.77s]

$ cf piece link $BOARD /of:fid1:2d-0sZs3u9kXK_FYvHa0zeFKmvE9Dl4vMpyS_iWXlgQ/board
…
[exit 0, 3.60s]
…
$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco board --input --select '@'
…
{
  "$link": "/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"
}
[exit 0, 2.05s]

$ cf cell get /of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco --step --select 'title,shortName'
…
{
  "title": "Legacy item A",
  "shortName": "1"
}
[exit 0, 5.88s]
…
$ cf piece render --cell /top/1
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">1</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item A</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 5.60s]
```

The fixer given to `cf piece repair`,
`experiment-output/rigs/bind-board.fixer.ts` (added in `59bbdfc54e`), with its
doc comments elided:

```ts
const BOARD_ID = "of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI";
…
const isSigilLink = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const envelope = (value as Record<string, unknown>)["/"];
  return envelope !== null && typeof envelope === "object" &&
    "link@1" in (envelope as Record<string, unknown>);
};

export default (
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  if (isSigilLink(document.board)) return { ...document };
  return {
    ...document,
    board: { "/": { "link@1": { id: BOARD_ID, path: [] } } },
  };
};
```

From `experiment-output/16-q3-repair.txt` (added in `b334eb4f86`), with two
runtime warnings, the per-row hint lines and the summary lines that repeat the
refusals elided: the plan, three members conforming and five refused with one
text, then the apply, which wrote nothing:

```
$ cf piece repair --cell $BOARD --path items --fixer "$OUT/rigs/bind-board.fixer.ts" --out "$OUT/plans/repair.jsonl"
…
Wrote 8 plan rows to /Users/mike/projects/labs-throwaway/cn-lenient/experiment-output/plans/repair.jsonl
…
conforms: 3 · refused: 5
…
refused: fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 The fixer returned an incomplete document: /board/namesTable would be lost by the write.
…
Repair found rows it must refuse.
…
[exit 1, 6.68s]
…
--- applied report, rows summarized ---
{"piece":"fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds","verdict":"conforms","problem":null,"changes":null}
{"piece":"fid1:-1jyIzihBlFm7T5Xpzry007L9_qmfZbJt8y560dEk7g","verdict":"conforms","problem":null,"changes":null}
{"piece":"fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08","verdict":"refused","problem":"The fixer returned an incomplete document: /board/namesTable would be lost by the write.","changes":null}
{"piece":"fid1:RiO4_BhWcBCqjwHktb_cfai15Velm4wHvb8wibqLQ5I","verdict":"refused","problem":"The fixer returned an incomplete document: /board/namesTable would be lost by the write.","changes":null}
{"piece":"fid1:5dZsyPc3kfkSdwk0HJmuoTvVugqlF06jI348OmCbWPg","verdict":"refused","problem":"The fixer returned an incomplete document: /board/namesTable would be lost by the write.","changes":null}
{"piece":"fid1:gVkUag4vXiUzgkjGhxgNDHLVh2yeo6BHkszz1tpRtac","verdict":"refused","problem":"The fixer returned an incomplete document: /board/namesTable would be lost by the write.","changes":null}
{"piece":"fid1:LXvm0j99-fedrXzxws7aQAimVyPdUVUi3fecEYsuvRU","verdict":"refused","problem":"The fixer returned an incomplete document: /board/namesTable would be lost by the write.","changes":null}
{"piece":"fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","verdict":"conforms","problem":null,"changes":null}
{"applied":0,"complete":false}
```

The code that writes that text, as the experiment recorded it in
`experiment-output/16-q3-repair-refusing-code.txt` (added in `b334eb4f86`), with
the function's doc comment elided:

```
--- the code that refuses: packages/piece/src/ops/bulk-repair.ts at 59bbdfc54e (unchanged from origin/main 51f8c11053), lostFields and its call ---
…
function lostFields(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
  out: string[] = [],
): readonly string[] {
  if (isLink(before)) return out;
  if (isPlainRecord(before) && isPlainRecord(after)) {
    for (const key of Object.keys(before)) {
      const beforeValue = before[key];
      if (
        !Object.hasOwn(after, key) ||
        (after[key] === undefined && beforeValue !== undefined)
      ) {
        out.push(displayPath([...path, key]));
        continue;
      }
      lostFields(beforeValue, after[key], [...path, key], out);
    }
    return out;
  }
…
    const lost = lostFields(document, first);
    if (lost.length > 0) {
      return {
        kind: "refused",
        problem: `The fixer returned an incomplete document: ` +
          `${lost.join(", ")} would be lost by the write.`,
      };
    }
```

A two-pass repair on member C alone, from
`experiment-output/18-q3-two-pass-repair-probe-C.txt` (added in `fc77778368`),
with the plan rows and hint lines elided. The first pass, whose fixer
`experiment-output/rigs/clear-board-record.fixer.ts` (added in `b334eb4f86`)
replaces a plain-record `board` with `null`, was planned and then refused by the
input schema at apply; the stored document was unchanged; the second pass,
binding the link, was refused as before; and C's input still named a position in
its own argument document, and C read no name:

```
=== pass 1: record -> null, member C only ===
…
would-change: 1
…
~ fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 /board {namesTable:[]} -> null
…
[exit 0, 1.93s]

$ cf piece repair --list fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 --fixer "$OUT/rigs/clear-board-record.fixer.ts" --plan "$OUT/plans/pass1-C.jsonl" --apply
…
failed: fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 updated input does not match its schema: board: value does not match type object; the stored document still needs the repair
…
[exit 1, 1.61s]

$ cf inspect value-at <store db> of:fid1:HpQDLUfu63LS6xpeEcnJS2myeM5J1MvlixyLennhX7o --full-depth
{
  "body": "filed by generation 0",
  "createdAt": 1789430665000,
  "title": "Legacy item C",
  "board": {
    "namesTable": []
  }
}
=== pass 2: null -> link, member C only ===
…
refused: fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 The fixer returned an incomplete document: /board/namesTable would be lost by the write.
…
[exit 1, 2.11s]
…
$ cf cell get /of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4 board --input --select '@'
…
{
  "$link": "/of:fid1:HpQDLUfu63LS6xpeEcnJS2myeM5J1MvlixyLennhX7o/board"
}
[exit 0, 0.97s]

$ cf cell get /of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4 --step --select 'title,shortName'
…
{
  "title": "Legacy item C"
}
[exit 0, 1.24s]
```

Member I, filed by `fileUnwired` for a later backfill, stores the same default
record. From `experiment-output/17-probe-unwired-member-I.txt` (added in
`b334eb4f86`):

```
I argument document: of:fid1:08d1gHa1TPMbnzaqfM2R7JoQr-OMWi_A6vRWTAQ3p3I
$ cf inspect value-at <store db> of:fid1:08d1gHa1TPMbnzaqfM2R7JoQr-OMWi_A6vRWTAQ3p3I --full-depth
{
  "board": {
    "namesTable": []
  },
  "body": "filed with no name and no board",
  "createdAt": 1789431971000,
  "title": "Unwired item I"
}
```

### Binding by link

A second backfill named I, from
`experiment-output/20-backfill-second-run-names-I.txt` (added in `b022052d3a`):

```
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}' -- --select assigned
…
  "result": {
    "assigned": [
      "9"
    ]
  }
}
…
[exit 0, 0.85s]

$ cf cell get /top/9 --select '@,title'
…
{
  "$link": "/of:fid1:IAYwyD1xoP-F1OFac-dFf93NPfkMk4nZS8Jw2qVR95k",
  "title": "Unwired item I"
}
[exit 0, 0.51s]
```

The remaining six members bound by `cf piece link`, from
`experiment-output/21-q3-link-remaining.txt` (added in `b022052d3a`), with each
command's output but its exit line elided. The file's first line is its own
note:

```
note: the first link below may have overlapped a concurrent backfillNames call (20-backfill-second-run-names-I.txt)
$ cf piece link $BOARD /of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4/board
…
[exit 0, 0.64s]
…
$ cf piece link $BOARD /of:fid1:6_rf-QTHfh1ZF7y3lTaTCS7GOVPP8Ch35qW7458QZeU/board
…
[exit 0, 0.59s]
…
$ cf piece link $BOARD /of:fid1:MOw7HWau2bDYPUGVloMy06OS8uMlldBZWb_mIWUWflM/board
…
[exit 0, 0.73s]
…
$ cf piece link $BOARD /of:fid1:P8hC0z70UnuuOIchd-o_waRkj6Dh70_YC9Eu3Bp1tXk/board
…
[exit 0, 0.61s]
…
$ cf piece link $BOARD /of:fid1:_Y1OtmESlCPxogjFFvSDA7n0uz_2FIjYmSDTvhk6AbU/board
…
[exit 0, 0.60s]
…
$ cf piece link $BOARD /of:fid1:bIBmWMSnBJJzKGkiANIaD55zkuhnmuwlqK1cm7r5ctY/board
…
[exit 0, 0.55s]

--- per-link wall-clock seconds, both baseline files ---
```

The section the file's last line opens is empty. The count after these binds is
the `22-verify-discover-all-bound.txt` line in § The discovery counts. The board
and three members rendered, from `experiment-output/23-verify-display.txt`
(added in `b022052d3a`), with the board's cards for B to H elided:

```
$ cf piece render --cell $BOARD
…
<cf-screen><cf-vstack gap="2" padding="4" slot="header"><cf-heading level="3">Items</cf-heading></cf-vstack><cf-vstack gap="2" padding="4"><span style="display:contents"><cf-card><cf-hstack align="center" gap="3"><cf-badge color="primary" data-member-name size="sm">1</cf-badge><cf-text block="true" style="flex: 1; font-weight: 600;">Legacy item A</cf-text></cf-hstack></cf-card>…<cf-card><cf-hstack gap="3" align="center"><cf-badge color="primary" data-member-name size="sm">9</cf-badge><cf-text block="true" style="flex: 1; font-weight: 600;">Unwired item I</cf-text></cf-hstack></cf-card></span></cf-vstack></cf-screen>
[exit 0, 0.68s]

$ cf piece render --cell /@cn-lenient-exp/top/3
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">3</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item C</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.57s]

$ cf piece render --cell /@cn-lenient-exp/top/7
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">7</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item G</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.67s]

$ cf piece render --cell /@cn-lenient-exp/top/9
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">9</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Unwired item I</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed with no name and no board"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.54s]
```

The board render's elision is inside one line and marked `…` there.

### The controls

**Idempotence.** From `experiment-output/24-control-idempotence.txt` (added in
`b022052d3a`): the repair over the bound board conformed for all nine and wrote
nothing, the backfill assigned nothing, and linking C again left its input
naming the board:

```
$ cf piece repair --cell $BOARD --path items --fixer "$OUT/rigs/bind-board.fixer.ts" --out "$OUT/plans/repair-rerun.jsonl"
…
conforms: 9
…
[exit 0, 0.76s]

$ cf piece repair --cell $BOARD --path items --fixer "$OUT/rigs/bind-board.fixer.ts" --plan "$OUT/plans/repair-rerun.jsonl" --apply --json > "$OUT/plans/repair-rerun-applied.json"
…
[exit 0, 0.81s]

{"applied":0,"complete":true,"verdicts":{"conforms":9}}
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}' -- --select assigned
…
  "result": {
    "assigned": []
  }
}
…
[exit 0, 0.71s]

$ cf piece link $BOARD /of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4/board
…
[exit 0, 0.64s]

$ cf cell get /of:fid1:w3e4oha_2fU_KdxPUK9yLFyIHlsGqshRIyN25ZUnUE4 board --input --select '@'
…
{
  "$link": "/of:fid1:Jr9t6W5DMi375rRJOgxQGugGDmlUPSd9rCQKG1LnuwI"
}
[exit 0, 0.46s]
```

**Removal.** From `experiment-output/25-control-removal.txt` (added in
`bac8fec887`), with the two nine-line snapshots, the index and the rows elided:
member 2 left the list from position 1, the `/top/<n>` snapshots taken before
and after were identical, and `/top/2` still reached B, which still read its
name:

```
$ cf piece call $BOARD removeItem --json '{"name":"2","agentName":"exp"}' -- --select position
…
  "result": {
    "position": 1
  }
}
…
[exit 0, 1.31s]
…
--- diff of the two snapshots (empty means every name reaches the same member) ---
[diff exit 0]
…
$ cf cell get /top/2 --step --select 'title,shortName'
…
{
  "title": "Legacy item B",
  "shortName": "2"
}
[exit 0, 0.76s]
```

The count after it is the `26-control-removal-discover.txt` line in § The
discovery counts: eight members, all three counts zero.

**Discovery detects a new gap.** From
`experiment-output/27-control-discovery-fires.txt` (added in `bac8fec887`):
member J, filed by `fileUnwired` after verification, counted as `noEntry` and
`unbound`; a backfill named it `10`, after which it counted as `unbound` and
`disagree`. The two counts are the two `27-control-discovery-fires.txt` lines in
§ The discovery counts, and J's row after the backfill is:

```
{"piece":"/of:fid1:Setttm0Fi0GYI7523mUlB3eCHXu9vXSM2Cd5CLQr0lI","result":"/of:fid1:avs4VWbr3b62rSl90eCqP57WFSixQ3zNcgs7YoJO-Yg","title":"Unwired item J","mapName":"10","ownShortName":null,"indexShortName":null,"boardInput":"/of:fid1:Q8cqbQaHXQ3BK6iHlemserb9UCpUsmzVD4YXCsl7FtU/board","noEntry":false,"unbound":true,"disagree":true}
```

The experiment's toolshed and shell were then stopped, as
`experiment-output/28-toolshed-stopped.txt` (added in `bac8fec887`) records:

```
--- after stopping ---
pid 38090: not running
pid 38091: not running
pid 38106: not running
listeners on 8470: [] on 5643: []
curl http://localhost:8470/_health -> 000
```

## Check 3: when a member's name reaches it

Check 3 repeats what § A member filed wired showed for H, on members filed for
the check, with two controls, and then under two flag variants. It ran on
servers started for the checks on the experiment's store; their flags are block
A in § Setup.

### The rig

`experiment-output/checks/rigs/check3a.sh` was added in `12cdf0d06b` and changed
in `1bbc373c94`. At `8a194f9bcf`:

```bash
#!/usr/bin/env bash
# check3a.sh <log> <title> <minimal|controls>
#
# Files one member through the board's addItem, then records in order which
# reads reach it: the member read with --step, the board's namesTable read
# with --step, and the member read again. `controls` inserts two reads before
# the table step that do not demand the table: the table read WITHOUT --step,
# and a --step read of a different board output (itemCount), each followed by
# a member read.
#
# No sleeps and no timed waits. Each step is one cf process; with --step it
# returns after its own runtime's pull, synced, idle, synced sequence
# (getCellValue in packages/cli/lib/piece.ts). The condition under test is
# which of those processes ran, not how long passed between them.
set -u
OUTDIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$OUTDIR/env.sh"
rec="$OUTDIR/rec.sh"
log="$1"; title="$2"; mode="${3:-minimal}"
json() { awk 'f==0 && /^[{[]$/ {f=1} f==1 {print} f==1 && /^[]}]$/ {exit}'; }
section() { printf -- '--- %s ---\n' "$1" | tee -a "$log"; }

section "file the member through addItem"
out=$("$rec" "$log" "cf piece call \$BOARD addItem --json '{\"title\":\"$title\",\"body\":\"check 3\",\"agentName\":\"exp\"}' -- --select name")
name=$(printf '%s\n' "$out" | json | jq -r '.result.name')
if [ -z "$name" ] || [ "$name" = null ]; then
  printf 'RESULT addItem returned no name; stopping\n' | tee -a "$log"
  exit 1
fi
section "the member's address, read through /top/$name without --step (reads the board's names map, starts nothing)"
out=$("$rec" "$log" "cf cell get /top/$name --select '@,title'")
member=$(printf '%s\n' "$out" | json | jq -r '.["$link"]')
readMember() { "$rec" "$log" "cf cell get $member --step --select 'title,shortName'" >/dev/null; }
section "member read with --step; nothing has stepped the board since the create"
readMember
"$rec" "$log" "cf piece render --cell $member" >/dev/null
if [ "$mode" = controls ]; then
  section "control 1: the board's namesTable read WITHOUT --step"
  "$rec" "$log" "cf cell get \$BOARD namesTable --select name" >/dev/null
  readMember
  section "control 2: the board started, a different output pulled (itemCount --step)"
  "$rec" "$log" "cf cell get \$BOARD itemCount --step" >/dev/null
  readMember
fi
section "the board's namesTable read WITH --step"
"$rec" "$log" "cf cell get \$BOARD namesTable --step --select name" >/dev/null
section "member read with --step after the table step"
readMember
"$rec" "$log" "cf piece render --cell $member" >/dev/null
printf 'RESULT name=%s member=%s mode=%s\n' "$name" "$member" "$mode" | tee -a "$log"
```

The change in `1bbc373c94` is the four-line guard on an empty name, so members K
and L below ran without it:

```
$ git diff 12cdf0d06b 1bbc373c94 -- experiment-output/checks/rigs/check3a.sh
diff --git a/experiment-output/checks/rigs/check3a.sh b/experiment-output/checks/rigs/check3a.sh
index 2bf4361e78..ddb96ff0b2 100755
--- a/experiment-output/checks/rigs/check3a.sh
+++ b/experiment-output/checks/rigs/check3a.sh
@@ -23,6 +23,10 @@ section() { printf -- '--- %s ---\n' "$1" | tee -a "$log"; }
…
+if [ -z "$name" ] || [ "$name" = null ]; then
+  printf 'RESULT addItem returned no name; stopping\n' | tee -a "$log"
+  exit 1
+fi
…
```

### Member K, with no controls

From `experiment-output/checks/01-check3a-minimal-K.txt` (added in
`12cdf0d06b`), with the table's rows `1` to `10` elided:

```
--- file the member through addItem ---
$ cf piece call $BOARD addItem --json '{"title":"Check3 item K","body":"check 3","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "11"
  }
}
…
[exit 0, 3.13s]
…
--- member read with --step; nothing has stepped the board since the create ---
$ cf cell get /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk --step --select 'title,shortName'
…
{
  "title": "Check3 item K"
}
[exit 0, 0.68s]

$ cf piece render --cell /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3 item K</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.60s]

--- the board's namesTable read WITH --step ---
$ cf cell get $BOARD namesTable --step --select name
…
[
…
  {
    "name": "11"
  }
]
[exit 0, 0.70s]

--- member read with --step after the table step ---
$ cf cell get /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk --step --select 'title,shortName'
…
{
  "title": "Check3 item K",
  "shortName": "11"
}
[exit 0, 0.55s]

$ cf piece render --cell /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">11</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3 item K</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.55s]

RESULT name=11 member=/of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk mode=minimal
```

### Member L, with the two controls

From `experiment-output/checks/02-check3a-controls-L.txt` (added in
`12cdf0d06b`), with each table's rows before its last two, and both renders
before the last, elided. The table read without `--step` ended at `11` while L
was named `12`; neither it nor a `--step` read of `itemCount` was followed by a
member read carrying the name; the table read with `--step` ended at `12`, and
the member read after it carried `12`:

```
--- file the member through addItem ---
$ cf piece call $BOARD addItem --json '{"title":"Check3 item L","body":"check 3","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "12"
  }
}
…
[exit 0, 2.85s]
…
--- member read with --step; nothing has stepped the board since the create ---
$ cf cell get /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M --step --select 'title,shortName'
…
{
  "title": "Check3 item L"
}
[exit 0, 0.56s]
…
--- control 1: the board's namesTable read WITHOUT --step ---
$ cf cell get $BOARD namesTable --select name
…
[
…
  {
    "name": "10"
  },
  {
    "name": "11"
  }
]
[exit 0, 0.49s]

$ cf cell get /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M --step --select 'title,shortName'
…
{
  "title": "Check3 item L"
}
[exit 0, 0.56s]

--- control 2: the board started, a different output pulled (itemCount --step) ---
$ cf cell get $BOARD itemCount --step
…
11
[exit 0, 0.72s]

$ cf cell get /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M --step --select 'title,shortName'
…
{
  "title": "Check3 item L"
}
[exit 0, 0.60s]

--- the board's namesTable read WITH --step ---
$ cf cell get $BOARD namesTable --step --select name
…
[
…
  {
    "name": "11"
  },
  {
    "name": "12"
  }
]
[exit 0, 0.69s]

--- member read with --step after the table step ---
$ cf cell get /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M --step --select 'title,shortName'
…
{
  "title": "Check3 item L",
  "shortName": "12"
}
[exit 0, 0.55s]

$ cf piece render --cell /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">12</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3 item L</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.74s]

RESULT name=12 member=/of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M mode=controls
```

### Why, read in code and not measured

The discovery rig's comment, quoted in § The discovery rig, gives the
explanation: with server execution off, nothing re-derives the board's names
table after a write to `names` until something steps the board. Nothing in this
record measures that explanation. What bears on it in code, on `origin/main` at
`e1bbc1d549`, and identical at the branch's base:

The documentation comment of `pull()` in `packages/runner/src/cell.ts`, whose
next paragraph also describes a push-based mode:

```ts
  /**
   * Pull the cell's value, ensuring all dependencies are computed first.
   *
   * In pull-based scheduling mode, computations don't run automatically when
   * their inputs change - they only run when pulled by an effect. This method
   * registers a temporary effect that reads the cell's value, triggering the
   * scheduler to compute all transitive dependencies first.
```

What a `--step` read does, in `getCellValue` in `packages/cli/lib/piece.ts`:

```ts
      const targetCell = options.input
        ? await piece.input.getCell(path)
        : (await piece.result.getCell()).key(...path);
      await timeCliPhase(
        "getCellValue.step.target.pull",
        () => targetCell.pull(),
      );
```

Which runtime runs the board's derivation when a member's read demands it, and
why the member's own pull did not recompute the table, is not established here.

### The flag variants

Both variants ran on copies of the store, taken with every server stopped. From
`experiment-output/checks/10-store-copies-for-3c.txt` (added in `fed953bec2`):

```
--- 10: store copies for check 3c, taken with every server on 8470/5643 stopped
listeners on 8470/5643 at copy time: []
copied store -> scratchpad/cn-checks/store-lazy-off
copied store -> scratchpad/cn-checks/store-server-exec-on
--- file checksums (source, then each copy)
/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/store
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-checks/store-lazy-off
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-checks/store-server-exec-on
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
```

**Variant A, lazy materialization off** (flags: block B in § Setup). From
`experiment-output/checks/12-check3c-lazy-off-minimal.txt` (added in
`686781a54a`), with the table's rows before `14` and the renders elided; the
render after the table step carried the `14` badge and the one before it none:

```
$ cf piece call $BOARD addItem --json '{"title":"Check3c lazy-off item N","body":"check 3","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "14"
  }
}
…
--- member read with --step; nothing has stepped the board since the create ---
$ cf cell get /of:fid1:hMRhwKJpyR4H33mBMLtLM4kQ6g2JB71GRabiEGuvbFc --step --select 'title,shortName'
Experimental flag overrides: modernCellRep=false, commitPreconditions=true, plainResultReceipts=true, computedCellIds=true, lazyMaterialization=false, serverExecution=false, contentAddressedSchemas=true, readerSchemaPrecedence=true
{
  "title": "Check3c lazy-off item N"
}
[exit 0, 0.53s]
…
--- the board's namesTable read WITH --step ---
$ cf cell get $BOARD namesTable --step --select name
…
  {
    "name": "14"
  }
]
[exit 0, 0.67s]

--- member read with --step after the table step ---
$ cf cell get /of:fid1:hMRhwKJpyR4H33mBMLtLM4kQ6g2JB71GRabiEGuvbFc --step --select 'title,shortName'
…
{
  "title": "Check3c lazy-off item N",
  "shortName": "14"
}
[exit 0, 0.52s]
…
RESULT name=14 member=/of:fid1:hMRhwKJpyR4H33mBMLtLM4kQ6g2JB71GRabiEGuvbFc mode=minimal
```

The renders the prose above describes, from the same file:

```
$ cf piece render --cell /of:fid1:hMRhwKJpyR4H33mBMLtLM4kQ6g2JB71GRabiEGuvbFc
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3c lazy-off item N</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.60s]
…
$ cf piece render --cell /of:fid1:hMRhwKJpyR4H33mBMLtLM4kQ6g2JB71GRabiEGuvbFc
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">14</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3c lazy-off item N</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.49s]
```

**Variant B, server execution on** (flags: block C in § Setup). The first run on
its copy filed member P and then failed in the rig. Its file,
`experiment-output/checks/15-check3c-server-exec-on-RIG-BROKEN-member-P.txt`
(added in `1bbc373c94`), ends with a note, quoted whole:

```
--- NOTE (added after the run): this run is a rig failure, not a measurement.
An in-place perl edit meant to add a no-name guard to rigs/check3a.sh used | as the s||| delimiter,
so the escaped \| in its pattern acted as alternation and split the name= assignment across two lines.
The rig therefore read an empty name although addItem returned "name": "14" (above), and every
member read ran with an empty address. State it did change on copy B: member P was filed as 14, and
the board's namesTable was read with --step (the table above includes 14). P is not used again.
The rig is repaired in the same commit, and the measurement is 16-check3c-server-exec-on-minimal.txt.
```

The measurement on that copy, from
`experiment-output/checks/16-check3c-server-exec-on-minimal.txt` (added in
`1bbc373c94`): member Q, named `15`, carried its name at the first member read,
before any table read in the rig:

```
$ cf piece call $BOARD addItem --json '{"title":"Check3c server-exec-on item Q","body":"check 3","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "15"
  }
}
…
--- member read with --step; nothing has stepped the board since the create ---
$ cf cell get /of:fid1:KcGKqXr8RAVidrz3dj7Rmkniu2Pjne1zpRJuD2--wbg --step --select 'title,shortName'
Experimental flag overrides: modernCellRep=false, commitPreconditions=true, plainResultReceipts=true, computedCellIds=true, lazyMaterialization=true, serverExecution=true, contentAddressedSchemas=true, readerSchemaPrecedence=true
{
  "title": "Check3c server-exec-on item Q",
  "shortName": "15"
}
[exit 0, 0.52s]

$ cf piece render --cell /of:fid1:KcGKqXr8RAVidrz3dj7Rmkniu2Pjne1zpRJuD2--wbg
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">15</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3c server-exec-on item Q</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.50s]
…
```

The run was repeated on a fresh copy. From
`experiment-output/checks/18-store-copy-server-exec-on-clean.txt` (added in
`ce851235ff`), whose checksums equal the source rows of step 10:

```
--- 18: a second, clean copy for server execution on
The first variant-B copy was touched by a broken rig run (15) that stepped the board's namesTable in the same
server session before member Q was filed (16). This copy is taken from the main store, which no server has
opened since record 10 (its checksum must equal the source checksum recorded there).
copied store -> scratchpad/cn-checks/store-server-exec-on-clean
/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/store
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
/private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-checks/store-server-exec-on-clean
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
```

On it (flags: block D in § Setup), from
`experiment-output/checks/20-check3c-server-exec-on-clean-minimal.txt` (added in
`48deb92979`), member R, named `14`, carried its name at the first member read:

```
$ cf piece call $BOARD addItem --json '{"title":"Check3c server-exec-on clean item R","body":"check 3","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "14"
  }
}
…
--- member read with --step; nothing has stepped the board since the create ---
$ cf cell get /of:fid1:_nzAvBOHuyGisqFFT1apkcH5xnI8Iff7gvMsOY0p67A --step --select 'title,shortName'
Experimental flag overrides: modernCellRep=false, commitPreconditions=true, plainResultReceipts=true, computedCellIds=true, lazyMaterialization=true, serverExecution=true, contentAddressedSchemas=true, readerSchemaPrecedence=true
{
  "title": "Check3c server-exec-on clean item R",
  "shortName": "14"
}
[exit 0, 0.55s]

$ cf piece render --cell /of:fid1:_nzAvBOHuyGisqFFT1apkcH5xnI8Iff7gvMsOY0p67A
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">14</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3c server-exec-on clean item R</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.53s]
…
```

The server-execution result was measured on the two copies only, not on the
experiment's own store. Neither file shows what the server ran between the
create and the first member read.

## Check 4: the two stored link forms

Check 4 asked whether the names map holds one form of link or two, and whether a
second form breaks double naming, reverse lookup, resolution or removal. It ran
on the servers of block A in § Setup.

### What each entry holds

`experiment-output/checks/rigs/map-entries.sh` (added in `932ce1d61e`) reads the
board's argument document raw from the store, and for each link says what the
document it names holds. Before it reads the map it checks its own normalization
on a known case, and its duplicate check on a map built to hold a duplicate:

```bash
kindOf() {
  cf inspect value-at "$DB" "$1" 2>/dev/null | json | jq -r '
    if (type == "object") and has("$link") and (keys | length == 1)
    then "slot: whole value is a link to " + .["$link"].id
    elif (type == "object") and has("$NAME") then "result document ($NAME present)"
    else "other: " + (tostring | .[0:120]) end'
}
dupes() { jq -c 'to_entries | group_by(.value) | map(select(length > 1) | {piece: .[0].value, keys: map(.key)})'; }
…
[ "$hs" = "$hr" ] && [ "$hs" != "$ar" ] && echo "self-check: PASS (same member same piece, different member different piece)" || echo "self-check: FAIL"
synthetic=$(jq -nc --arg a "$hs" --arg b "$hr" --arg c "$ar" '{"8": $a, "dup": $b, "1": $c}')
echo "duplicate check on synthetic map $synthetic -> $(echo "$synthetic" | dupes)"
```

Its output after K and L were filed, from
`experiment-output/checks/03-check4a-map-entries.txt` (added in `932ce1d61e`),
with the entries and list elements not named below elided. Entry `1`, written by
`backfillNames`, links to a result document with a schema; entries `8` and `11`,
written by `addItem`, link with a space and scope to a slot document whose whole
value is a link to the result document; and the two elements of `items` quoted
are slot documents:

```
=== 4a: before any check-4 write (after K and L were filed)
--- rig self-check on a known case
H slot   of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY -> of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4 (slot: whole value is a link to of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4)
H result of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4 -> of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4 (result document ($NAME present))
A result of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds -> of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds
self-check: PASS (same member same piece, different member different piece)
duplicate check on synthetic map {"8":"of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","dup":"of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","1":"of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds"} -> [{"piece":"of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","keys":["8","dup"]}]
--- names map, raw
names/1
  raw link: {"id":"of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds","schema":{"$ref":"cid:fid1:OBwM0WZ3XW9OsxydwJBcpf5TIEEa8m4Z2idxYK35v0o"}}
  names:    of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds
  holds:    result document ($NAME present)
  piece:    of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds (Legacy item A)
…
names/8
  raw link: {"id":"of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY","space":"did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB","scope":"space"}
  names:    of:fid1:i2tcmNM0OsNHoJl5C3cPBENX6o5ILXCAwrNMtXBktIY
  holds:    slot: whole value is a link to of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4
  piece:    of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4 (New item H)
…
names/11
  raw link: {"id":"of:fid1:bZgWhDPC55udFVueTB2U0yj9Z5u4vexCs3dheW2tjeE","space":"did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB","scope":"space"}
  names:    of:fid1:bZgWhDPC55udFVueTB2U0yj9Z5u4vexCs3dheW2tjeE
  holds:    slot: whole value is a link to of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk
  piece:    of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk (Check3 item K)
…
--- items list, raw (the index rows are these elements)
items/0  of:fid1:q4tbuY-jxhm6UC0KxqIUS_XuqDk9wJKMXGG-BOv2Eco
  holds: slot: whole value is a link to of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds
  piece: of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds  named by key(s): 1
…
items/9  of:fid1:bZgWhDPC55udFVueTB2U0yj9Z5u4vexCs3dheW2tjeE
  holds: slot: whole value is a link to of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk
  piece: of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk  named by key(s): 11
…
--- duplicate check on the real map (key -> piece)
{"1":"of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds","2":"of:fid1:-1jyIzihBlFm7T5Xpzry007L9_qmfZbJt8y560dEk7g","3":"of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08","4":"of:fid1:RiO4_BhWcBCqjwHktb_cfai15Velm4wHvb8wibqLQ5I","5":"of:fid1:5dZsyPc3kfkSdwk0HJmuoTvVugqlF06jI348OmCbWPg","6":"of:fid1:gVkUag4vXiUzgkjGhxgNDHLVh2yeo6BHkszz1tpRtac","7":"of:fid1:LXvm0j99-fedrXzxws7aQAimVyPdUVUi3fecEYsuvRU","8":"of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4","9":"of:fid1:IAYwyD1xoP-F1OFac-dFf93NPfkMk4nZS8Jw2qVR95k","10":"of:fid1:Setttm0Fi0GYI7523mUlB3eCHXu9vXSM2Cd5CLQr0lI","11":"of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk","12":"of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M"}
duplicates: []
```

In the same file, entries `2` to `7`, `9` and `10` hold the form of entry `1`,
and entry `12` the form of entry `11`:

```
$ git show 8a194f9bcf:experiment-output/checks/03-check4a-map-entries.txt | grep -A3 '^names/' | grep -e '^names/' -e 'holds:'
names/1
  holds:    result document ($NAME present)
names/2
  holds:    result document ($NAME present)
names/3
  holds:    result document ($NAME present)
names/4
  holds:    result document ($NAME present)
names/5
  holds:    result document ($NAME present)
names/6
  holds:    result document ($NAME present)
names/7
  holds:    result document ($NAME present)
names/8
  holds:    slot: whole value is a link to of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4
names/9
  holds:    result document ($NAME present)
names/10
  holds:    result document ($NAME present)
names/11
  holds:    slot: whole value is a link to of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk
names/12
  holds:    slot: whole value is a link to of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M
```

An entry of the `addItem` form names a member's slot document and one of the
backfill form its result document, and the discovery rig's comment quoted in §
The discovery rig normalizes both through `cf piece inspect` for that reason.

### Double naming, reverse lookup and resolution

`experiment-output/checks/rigs/check4b-naming.sh` (added in `5a1fbfa09b`) states
its plan in its header:

```bash
# Double naming, reverse lookup and resolution across the two stored forms.
# Addresses 8, 11 and 12 were written by addItem and name slot documents;
# 3 and every other backfilled key name result documents
# (03-check4a-map-entries.txt).
#
# Double naming is asked twice: with every listed member already named, and
# with one unnamed member M added so the backfill has something to name. The
# second run is the control that shows the check can assign at all, and its
# assigned list must hold M's key alone.
```

From `experiment-output/checks/04-check4b-double-naming-lookup-resolution.txt`
(added in `5a1fbfa09b`), with the rows before the last elided in both reads of
`rows`: a backfill with members of both forms listed assigned nothing; member M,
filed unnamed, showed an empty name; the next backfill assigned `13` alone; C
(backfill form) and K (`addItem` form) each read and rendered its own name; and
`/@cn-lenient-exp/top/<n>` reached the right member for two names of each form:

```
--- 4b.1 backfillNames with addItem-named H (8), K (11), L (12) listed and every listed member named ---
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}' -- --select assigned
…
  "result": {
    "assigned": []
  }
}
…
--- 4b.3 board rows (nameOf over the names table, by identity) before M is named ---
$ cf cell get $BOARD rows --step
…
  {
    "name": "",
    "title": "Check4 unwired item M"
  }
]
[exit 0, 0.64s]

--- 4b.4 backfillNames with M unnamed and H, K, L still listed ---
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}' -- --select assigned
…
  "result": {
    "assigned": [
      "13"
    ]
  }
}
…
--- 4b.5 board rows after the backfill ---
$ cf cell get $BOARD rows --step
…
  {
    "name": "13",
    "title": "Check4 unwired item M"
  }
]
[exit 0, 0.78s]

--- 4b.6 member-side reverse lookup (ownName): C is backfill form (3), K is addItem form (11) ---
$ cf cell get /of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 --step --select 'title,shortName'
…
{
  "title": "Legacy item C",
  "shortName": "3"
}
[exit 0, 0.61s]

$ cf cell get /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk --step --select 'title,shortName'
…
{
  "title": "Check3 item K",
  "shortName": "11"
}
[exit 0, 0.55s]

$ cf piece render --cell /@cn-lenient-exp/top/3
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">3</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Legacy item C</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="filed by generation 0"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.57s]

$ cf piece render --cell /@cn-lenient-exp/top/11
…
<cf-screen><cf-vstack gap="1" padding="4" slot="header"><cf-hstack align="center" gap="2"><cf-badge color="primary" data-member-name size="sm">11</cf-badge><cf-text block="true" style="font-size: 1.25rem; font-weight: 600;">Check3 item K</cf-text></cf-hstack></cf-vstack><cf-vstack gap="3" padding="4"><cf-markdown content="check 3"></cf-markdown></cf-vstack></cf-screen>
[exit 0, 0.53s]

--- 4b.7 resolution of /@cn-lenient-exp/top/<n>: 3 and 13 backfill form, 8 and 11 addItem form ---
$ cf cell get /@cn-lenient-exp/top/3 --select '@,title'
…
{
  "$link": "/of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08",
  "title": "Legacy item C"
}
[exit 0, 0.55s]

$ cf cell get /@cn-lenient-exp/top/8 --select '@,title'
…
{
  "$link": "/of:fid1:JPf_Duoi35gkNencdBjMmbyY-Owy7zmXBAzbRTN9bg4",
  "title": "New item H"
}
[exit 0, 0.45s]

$ cf cell get /@cn-lenient-exp/top/11 --select '@,title'
…
{
  "$link": "/of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk",
  "title": "Check3 item K"
}
[exit 0, 0.45s]

$ cf cell get /@cn-lenient-exp/top/13 --select '@,title'
…
{
  "$link": "/of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE",
  "title": "Check4 unwired item M"
}
[exit 0, 0.45s]
```

The map read again after that backfill, from
`experiment-output/checks/05-check4b-map-entries-after-backfill.txt` (added in
`5a1fbfa09b`): entry `13` has the backfill form, and the real map holds no
duplicate. The `?` in its first block is what the rig prints when
`cf piece inspect --json` returns no `name` (`jq -r '.name // "?"'`), which this
record does not look into:

```
names/13
  raw link: {"id":"of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE","schema":{"$ref":"cid:fid1:OBwM0WZ3XW9OsxydwJBcpf5TIEEa8m4Z2idxYK35v0o"}}
  names:    of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE
  holds:    result document ($NAME present)
  piece:    of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE (?)
…
duplicates: []
```

### Removal

`experiment-output/checks/rigs/check4b-removal.sh` (added in `bb2ee37cbf`)
states what each snapshot must show:

```bash
# Removal across both stored forms. Removes A (key 1, backfill form, list
# position 0, so every later member shifts) and K (key 11, addItem form, with
# L and M after it). Three snapshots are taken before and after:
#   names  the raw map from the store; must be byte-identical
#   top    /top/<n> resolved for every key; must be identical if entries
#          record members, and would shift if any recorded a position
#   index  index/<k> by position; MUST differ, which is the control showing
#          the diff reports a shift when one exists
```

From `experiment-output/checks/06-check4b-removal.txt` (added in `bb2ee37cbf`),
with the snapshots and the middle rows elided: A left position 0 and K position
8; the raw map and the resolution of every name were the same before and after;
the index snapshots differed only in length; the board's rows no longer held `1`
or `11`; C and L read their names, and so did A and K, read by address; and a
backfill assigned nothing:

```
--- remove A (key 1, backfill form, position 0) ---
$ cf piece call $BOARD removeItem --json '{"name":"1","agentName":"exp"}' -- --select position
…
  "result": {
    "position": 0
  }
}
…
--- remove K (key 11, addItem form) ---
$ cf piece call $BOARD removeItem --json '{"name":"11","agentName":"exp"}' -- --select position
…
  "result": {
    "position": 8
  }
}
…
--- diff names.json (before -> after) ---
[diff exit 0]
--- diff top.txt (before -> after) ---
[diff exit 0]
--- diff index.txt (before -> after) ---
11,12d10
< index/10 
< index/11 
[diff exit 1]
--- board rows after removal ---
$ cf cell get $BOARD rows --step
…
[
  {
    "name": "3",
    "title": "Legacy item C"
  },
…
  {
    "name": "10",
    "title": "Unwired item J"
  },
  {
    "name": "12",
    "title": "Check3 item L"
  },
  {
    "name": "13",
    "title": "Check4 unwired item M"
  }
]
[exit 0, 0.64s]

--- member-side names after removal: C (3) and L (12) shifted, A (1) and K (11) removed ---
$ cf cell get /of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 --step --select 'title,shortName'
…
{
  "title": "Legacy item C",
  "shortName": "3"
}
[exit 0, 0.59s]

$ cf cell get /of:fid1:y_bApWi0efB70rAyPPzCOKc0NY7UGitPRNpnEkVeF4M --step --select 'title,shortName'
…
{
  "title": "Check3 item L",
  "shortName": "12"
}
[exit 0, 0.55s]

$ cf cell get /of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds --step --select 'title,shortName'
…
{
  "title": "Legacy item A",
  "shortName": "1"
}
[exit 0, 0.59s]

$ cf cell get /of:fid1:wkBkIjs-ITFUgA4cL0YR_iTjNvgTyxhwwssGTgmyjkk --step --select 'title,shortName'
…
{
  "title": "Check3 item K",
  "shortName": "11"
}
[exit 0, 0.64s]

--- backfillNames after removal ---
$ cf piece call $BOARD backfillNames --json '{"agentName":"exp"}' -- --select assigned
…
  "result": {
    "assigned": []
  }
}
…
```

The index snapshot was not the control the rig meant it to be. From
`experiment-output/checks/08-check4b-removal-position-control.txt` (added in
`bb2ee37cbf`), with the twelve and ten listing lines elided from the two
position lists that precede its diff:

```
--- 08: position control for the removal check, rebuilt from the raw items listings
The index/<k> snapshot in 06-check4b-removal.txt recorded empty values: rigs/check4b-removal.sh called
cf directly with the literal string \$BOARD (escaped for rec.sh's eval, but snap() does not go through rec.sh),
so every read failed and the diff there reports only the line count. The rig line is corrected in this commit.
The control below uses the raw items list that rigs/map-entries.sh read from the store before the removal
(05-check4b-map-entries-after-backfill.txt) and after it (07-check4b-map-entries-after-removal.txt).

--- names snapshot sizes (non-empty, so the byte-identical diff in 06 compared real content)
    2597 removal/before.names.json
    2597 removal/after.names.json
    5194 total
13
13
…
--- diff positions (before -> after); must differ, since removing position 0 shifts every later member
1,12c1,10
< items/0 of:fid1:PkKraMpNf_dZiHcM3uRBsmrEF2d87bjc_LfUoTo2Mds key 1
< items/1 of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 key 3
…
< items/11 of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE key 13
---
> items/0 of:fid1:4mJA1Tui7pVOao8OKKVoRlJGNnF9YlgeWPZvuzn5h08 key 3
…
> items/9 of:fid1:DCxaVr9_Pmw1j9SeCNcLBmCRtsenyWVzVTQk2PEjsTE key 13
[diff exit 1]
```

The rig has one commit, so the version that wrote the empty index snapshot is
not in the branch's history:

```
$ git log --format='%h %s' 8a194f9bcf -- experiment-output/checks/rigs/check4b-removal.sh
bb2ee37cbf experiment(cn-lenient): check 4b removal across both stored forms; position control rebuilt from raw items after a rig quoting bug
```
What the removal shows is carried by the raw-map diff, the `/top/<n>` diff and
the rebuilt position diff, not by the index snapshot.

### An `equals` caveat, read in code and not verified

Reverse lookup, the board's `rows` and `backfillNames` all match members by
`equals`. On `origin/main` at `e1bbc1d549`, and identical at the branch's base,
`nameOf` in `packages/patterns/collection-naming/naming.ts` calls it:

```ts
  return table.find((row) => equals(member, row.member as object))?.name;
```

and the `equals` a pattern imports, defined in `packages/runner/src/cell.ts`,
resolves the two sides before comparing only when a transaction frame is on the
stack:

```ts
    equals(
      a: AnyCell<any> | object | undefined,
      b: AnyCell<any> | object | undefined,
    ): boolean {
      const frame = getTopFrame();
      return areLinksSame(
        a,
        b,
        undefined,
        !!frame?.tx,
        frame?.tx,
        frame?.runtime,
      );
    },
```

Whether any comparison in this check ran with no transaction frame on the stack,
and whether one that did would match a member against an entry of the `addItem`
form, which names a slot document rather than the result document, was not
tested.

### What check 4 established

For the cases checked — a backfill over members of both forms, reverse lookup
and rendering for one member of each form, resolution of two names of each form,
and removal of one member of each form — the second form was not a defect. §
Stated limitations bounds that.

## Members U and V, and the browser check

### Member U

Member U was filed on the experiment's own store, not a copy, under the posture
of block E in § Setup. Before those servers started, the store's checksums
equaled the source rows of step 10, from
`experiment-output/checks/22-servers-baseline-2.txt` (added in `f4e66301e8` and
changed in `96546ecaaf`):

```
original store checksums (must equal the source rows of 10-store-copies-for-3c.txt; no server has opened it since):
  051be1f690dd41a470da9b3343914df45382c52b  ./engine-v3/engine-v3/did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB.sqlite
  3328d2168233d3c33a0a643d3b23c21e60440629  ./engine-v3/engine-v3/did:key:z6MkihzwuBQSonCGs58K3VGob3DUAvetPhi5Jqd1iyT1GMrR.sqlite
```

From `experiment-output/checks/23-member-U.txt` (added in `96546ecaaf`), with
the offline reads of U's slot and result documents elided: U was named `14`, and
the store then held fourteen map keys and eleven list elements:

```
--- file U through addItem (the last state-changing step)
$ cf piece call $BOARD addItem --json '{"title":"Browser check item U","body":"filed for the browser check","agentName":"exp"}' -- --select name
…
  "result": {
    "name": "14"
  }
}
…
[exit 0, 3.11s]
…
{"names14":{"$link":{"id":"of:fid1:8ZwJCJLVr3KP1ExL019T8DLf4JUI4j1M2s_M8D945d8","space":"did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB","scope":"space"}},"lastItem":{"$link":{"id":"of:fid1:8ZwJCJLVr3KP1ExL019T8DLf4JUI4j1M2s_M8D945d8","space":"did:key:z6MkgNmoqpu73iTtJSJFa39hHMBLMsGTatk3xPSn4FCLB4TB","scope":"space"}},"nameKeys":14,"itemCount":11}
[exit 0, 0.36s]
…
RESULT U name=14 slot=of:fid1:8ZwJCJLVr3KP1ExL019T8DLf4JUI4j1M2s_M8D945d8 piece=of:fid1:rCBwIa2gUZUvl9tB1zjZuKTzIAXV6OpVf-DIYGlQKII address=/@cn-lenient-exp/top/14
```

The same file gives the command for restarting the servers on that store:

```
  cd /Users/mike/projects/labs-throwaway/cn-lenient && \
  HOST=127.0.0.1 \
  MEMORY_DIR=file:///private/tmp/claude-501/-Users-mike-projects-labs-worktrees-b3/d415fe6c-1531-4630-8f48-1d73d4dd2641/scratchpad/cn-lenient/store/ \
  ./scripts/start-local-dev.sh --port-offset 470
```

### Member V

From `experiment-output/checks/24-member-V.txt` (added in `8a194f9bcf`), whose
override line is kept here as the file's only record of that session's posture
from the client side:

```
$ cf piece call $BOARD addItem --json '{"title":"Browser check item V","body":"filed for the bounded browser check","agentName":"exp"}' -- --select name
Experimental flag overrides: modernCellRep=false, commitPreconditions=true, plainResultReceipts=true, computedCellIds=true, lazyMaterialization=true, serverExecution=false, contentAddressedSchemas=true, readerSchemaPrecedence=true
…
  "result": {
    "name": "15"
  }
}
…
[exit 0, 3.13s]
```

### The browser check

`experiment-output/checks/browser/README.txt` (added in `8a194f9bcf`), whole:

```
Browser check of member names in the shell, run by the coordinating session from
a detached worktree of origin/main at 2919bb0509 (packages/shell/integration/
cn-lenient-look.test.ts, copied here as the final version). The local toolshed
and shell ran on the original store with lazyMaterialization=true and
serverExecution=false (/api/meta), started with the command in
23-member-U.txt's report and stopped afterwards.

run1-single-read-broken (member U, name 14): the script read the badges once,
right after the member's title rendered. That instrument was wrong: its
look.json records no badge on the member page after the board, but
3-member-after-board.png shows the "14" badge. The badge renders after the
title, so a single read can miss it. Run 1's "no badge" results prove nothing.

run2-bounded-wait (member V, name 15, filed in ../24-member-V.txt; nothing read
the board between filing V and this run): the script waits for the badge with
waitForCondition, whose built-in bound is 300000 ms
(packages/integration/utils.ts). Results are in look.json:
memberFirstBadgeAppeared=false (bound reached; the run took 5m1s),
boardBadgeAppeared=true, memberAfterBoardBadgeAppeared=true.
```

No file records the `/api/meta` document of that server session; the README's
statement above is the record of it. The README's sentences about run 1's
screenshot are the README's: the screenshot is not reproduced here, and nothing
below rests on what it shows.

The script's final version,
`experiment-output/checks/browser/cn-lenient-look.test.ts` (added in
`8a194f9bcf`), with its imports, settings and first helper elided.
`badgeAppears` returns `false` only when the wait's error says it did not
resolve within its bound:

```ts
  /**
   * Whether a member badge reading `name` appears before `waitForCondition`'s
   * own bound runs out. A badge renders after the title, so this waits for it
   * rather than reading the page once.
   */
  const badgeAppears = async (name: string): Promise<boolean> => {

    try {
      await waitForCondition(
        shell.page(),
        (probe, expected: string) =>
          probe.collect("[data-member-name]").some((badge) =>
            probe.deepText(badge).trim() === expected
          ),
        { args: [name] },
      );
      return true;
    } catch (error) {
      if (String(error).includes("did not resolve within")) return false;
      throw error;
    }
  };

  it("member first, then the board, then the member again", async () => {
…
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: memberView,
      urlPath: memberPath,
      identity,
    });
    await titled(MEMBER_TITLE);
    record.memberFirstBadgeAppeared = await badgeAppears(MEMBER);
    await shell.page().screenshot(join(OUT, "1-member-first.png"));

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE, pieceSlug: SLUG },
      urlPath: `/@${SPACE}/${SLUG}`,
      identity,
    });
    record.boardBadgeAppeared = await badgeAppears(MEMBER);
    record.boardTitle = await shell.page().evaluate(() => document.title);
    await shell.page().screenshot(join(OUT, "2-board.png"));

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: memberView,
      urlPath: memberPath,
      identity,
    });
    await titled(MEMBER_TITLE);
    record.memberAfterBoardBadgeAppeared = await badgeAppears(MEMBER);
    await shell.page().screenshot(join(OUT, "3-member-after-board.png"));
```

The wait's bound, read in code at `2919bb0509` in
`packages/integration/utils.ts`, the commit the README names:

```ts
const WAIT_FOR_CONDITION_TIMEOUT = 300_000; // 5 minutes
…
              `waitForCondition did not resolve within ${WAIT_FOR_CONDITION_TIMEOUT}ms`,
```

**Run 1, a broken instrument.** The version of the script run 1 used is not
committed: the script file has one commit, `8a194f9bcf`, and holds the final
version, whose comment on `badgeAppears` above says it waits for the badge
"rather than reading the page once". Run 1's `look.json` has keys the final
version does not write, and records empty lists where the final version records
a boolean. From
`experiment-output/checks/browser/run1-single-read-broken/look.json` (added in
`8a194f9bcf`):

```
{
  "member": "14",
  "memberTitle": "Browser check item U",
  "memberFirst": [],
  "board": "Items (11)",
  "memberAfterBoard": []
}
```

and its log, with color codes removed:

```
$ git show 8a194f9bcf:experiment-output/checks/browser/run1-single-read-broken/run.txt | perl -pe 's/\e\[[0-9;]*m//g'
running 1 test from ./packages/shell/integration/cn-lenient-look.test.ts
a named member, seen in the shell ...
  member first, then the board, then the member again ... ok (1s)
a named member, seen in the shell ... ok (2s)

ok | 1 passed (1 step) | 0 failed (2s)

```

A read that waits, as `badgeAppears` does, reports no badge only once the wait's
300000 ms bound has passed, which is why run 2 below took 5m1s. Run 1 reported
no badge on the member page twice and finished in 2 s, so its reads did not wait
for a badge, and its empty results do not show whether one appeared. No
conclusion is drawn from run 1.

**Run 2, a bounded wait.** Member V, named `15`. From
`experiment-output/checks/browser/run2-bounded-wait/look.json` (added in
`8a194f9bcf`):

```
{
  "member": "15",
  "memberTitle": "Browser check item V",
  "memberFirstBadgeAppeared": false,
  "boardBadgeAppeared": true,
  "boardTitle": "Items (12)",
  "memberAfterBoardBadgeAppeared": true
}
```

and its log, with color codes removed:

```
$ git show 8a194f9bcf:experiment-output/checks/browser/run2-bounded-wait/run.txt | perl -pe 's/\e\[[0-9;]*m//g'
running 1 test from ./packages/shell/integration/cn-lenient-look.test.ts
a named member, seen in the shell ...
  member first, then the board, then the member again ...'a named member, seen in the shell' has been running for over (1m0s)
'a named member, seen in the shell' has been running for over (2m0s)
'a named member, seen in the shell' has been running for over (4m0s)
 ok (5m1s)
a named member, seen in the shell ... ok (5m1s)

ok | 1 passed (1 step) | 0 failed (5m1s)

```

Member V, opened first, showed no badge reading `15` before the wait's bound;
the board, opened next, showed one; and V, opened again, showed one. Each step
was run once. The three screenshots of each run are in the branch beside its
`look.json` and are not reproduced here.

## Stated limitations

- **Experiment patterns, a small board.** The patterns are the experiment's
  copies in `packages/patterns/cn-lenient/`, not the exemplar and not Topics,
  and the board listed between 7 and 12 members at any read quoted here.
- **One local server session at a time**, loopback, on one machine. Timings are
  that setup's and are not compared across files.
- **Check 3's explanation is not measured.** The scheduling explanation in §
  Why, read in code and not measured, is the rigs' and the code comment's; no
  run isolated it.
- **The flag variants are single members on copies.** Variant A is member N;
  variant B is member Q on a copy a broken run had touched and member R on a
  clean copy. Server execution was not run on the experiment's own store.
- **The browser check is one run per case.** `memberFirstBadgeAppeared: false`
  means no badge within 300000 ms, not that none would ever appear. Run 1 draws
  no conclusion.
- **Check 4 covers the cases it lists.** One member of each form was looked up,
  and one removed. The `equals` caveat is untested, the index snapshot in its
  removal step recorded nothing, and the `?` name in step 05 was not looked
  into.
- **The discovery counts come from three rig versions.** Step 08 ran the first
  committed version; the first step-14 file ran a version not in the branch's
  history; the rest ran the version at `8a194f9bcf`. `unbound` is the rig's own
  test of an address's suffix, not a runtime property.
- **The repair was tried with one fixer shape**, and the two-pass probe on one
  member.
- **Resolution was compared by address and title.** Where `/top/<n>` snapshots
  matched, the resolved documents' contents were not compared.
- **`removeItem` and `fileUnwired` exist only in the experiment's board**, to
  build the controls.
