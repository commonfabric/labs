# @commonfabric/cli

## Pattern test read costs

`cf test <file.test.tsx> --verbose --stats-threshold 0` reports read costs for
each step of a single-runtime test, including assertions, explicit renders, and
settles. Initialization is reported separately. Each report groups actions by
authored file, line, and column, then sorts those sources by total proxy
accesses. Actions without an authored source are grouped by builtin name, or by
action ID when no name is available.

The counters measure reactive data property and element reads (including array
method materialization and cached reads), stored-link traversal attempts on
cache misses, distinct storage documents per action run, and compacted
scheduling read dependencies at action completion. The last two columns sum
per-run counts; they are not a union of documents or subscriptions across the
step. Link hops can exceed proxy accesses because schema traversal and runtime
code also follow links. Missing-target reads count; a fast-path target read
followed by a fallback counts twice, since both attempts perform work. These
counters exclude plain JavaScript arithmetic, event-handler transactions, commit
preparation, and the idempotency verification replay.

The total includes every measured scheduler run, including builtin and
coordinator actions and actions removed before the step ends.
`--stats-action-limit` limits displayed rows only. `max/run` identifies the
largest individual run without hiding the accumulated cost of repeated runs. An
assertion can demand work that the preceding action left lazy, so compare
corresponding steps and keep test-harness reads in view.

For timing experiments, `--no-idempotency-check` disables verification replay in
both single-runtime and multi-user tests. Verification stays enabled by default;
a measurement with it disabled does not establish idempotency. Read-cost tables
currently cover the single-runtime runner.

Single-user test modules can export `readBudgets` with separate `initialization`
and default `steps` limits. Each accepts `total` (settled transaction-attempt
proxy accesses) and `perRun` (maximum reactive-body proxy accesses). An
executable step's `readBudget` replaces the default limits. Zero is valid,
equality passes, and a violation fails the test with attributed diagnostics even
when functional assertions pass. Limits require module-level opt-in; multi-user
declarations are rejected. See the
[budget contract](../../docs/features/read-accounting.md#pattern-test-budgets)
for measured transactions, exclusions, and settlement behavior.

## Pattern test CFC posture and labeled fixtures

`cf test` accepts `--cfc-flow-labels <off|derive|observe|persist>` and
`--cfc-enforcement-mode <disabled|observe|enforce-explicit|enforce-strict>`.
`derive` is an alias for the runtime's `observe` flow mode: compute the join
without persisting derived labels. `--cfc-shell-posture` selects
`enforce-explicit` and `persist`, the shell's two CFC dial defaults. It
conflicts with either individual dial, in either argument order. The shorthand
changes these two dials only; it does not simulate the browser or enable every
CFC gate. An omitted dial retains the pattern-test preset (enforcement
`enforce-explicit`, flow labels `off`). Every runtime prints its resolved
posture, including each multi-user participant. Programmatic callers use
`TestRunnerOptions.cfcFlowLabels` with the runtime names `off`, `observe`, or
`persist`.

A pattern test can create its own labeled store without a connector. Declare a
column's `ifc` alongside its SQLite type and seed rows in an action:

```tsx
// Shown at module scope.
import {
  action,
  assert,
  pattern,
  sqliteDatabase,
  table,
  TESTS,
} from "commonfabric";

export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      orders: table({
        id: "integer primary key",
        glaze: {
          type: "string",
          sqlType: "text",
          ifc: { confidentiality: ["bakery-private"] },
        },
      }),
    },
  });
  const rows = db.query<{ id: number; glaze: string }>(
    "SELECT id, glaze FROM orders ORDER BY id LIMIT 11",
  );
  return {
    [TESTS]: [
      {
        action: action(() => {
          db.exec("INSERT INTO orders VALUES (?, ?)", [1, "maple"]);
        }),
      },
      { assertion: assert(() => rows.result?.[0]?.glaze === "maple") },
    ],
  };
});
```

With enforcement at `enforce-explicit`, SQLite query results carry the declared
column labels with flow labels `off` or `persist`. The flow dial controls their
downstream derivation and persistence. Query result assertions settle
asynchronous SQLite work; put one before a render step when measuring the mapped
view separately from querying and row materialization.

The verbose timing table always includes `prepareCfc`, `deriveFlowJoin`,
`collectConsumedLabel`, and `preparedDigestFor`, even below the top-ten cutoff.
A zero count means that interval did not call the operation. These are
cumulative elapsed spans, nested inside preparation where applicable; do not add
them as independent CPU time. The digest span covers canonicalization and
hashing, including commit-time rechecks. Read counts retain their reactive-body
boundary; preparation spans cover work outside that boundary. Explicit render
steps print both timing and read tables. `--timing-measures-out` also captures
the spans and the `runTestPattern/step/render_N/materialize` phase boundaries.

The
[mapped-render regression benchmark](../../docs/development/BENCHMARKS.md#labeled-pattern-test-mapped-render)
uses this fixture mechanism at both postures.

## View pager

`cf view [file]` is an interactive pager for transformed TypeScript, source
files, and unified diffs. Named Markdown, JSON, JSONC, JSON Lines, YAML, and
Python files use their own syntax highlighting. Web manifests, TLDraw documents,
Deno lock files, editor workspace files, and Swift package resolutions use the
JSON highlighting their suffixes do not announce. A `.cfg` file uses JSON
highlighting when the source in view opens a JSON object; that suffix is shared
with unrelated syntaxes, so its name alone leaves it as plain text. Transformed
compiler output piped without a filename keeps TypeScript highlighting when its
module header identifies it. Python interpreter shebangs select Python for
otherwise unrecognized names. Node, Deno, and Bun shebangs select the TypeScript
and JavaScript language family. Other filename-free source and named files with
unrecognized syntax are shown as plain text. For piped source, `--filename`
selects syntax as though the input had that name. `--language` selects a
language by its stable identifier or alias. Both options keep the pipe read-only
and suppress unified-diff auto-detection. An explicit language takes priority
when both options are present. Use `--diff` instead when the pipe is a unified
diff.

The binary language handles known binary filenames, input containing a NUL byte,
and input that is not valid UTF-8. It starts in a read-only rendered view with
16 bytes per hex-dump row. Printable ASCII bytes appear at the right of each
row. Other bytes use the same control-picture glyphs as the pager's
non-printable display mode. Use `--language binary` or its `bytes` alias to
select it explicitly for piped input. Interactive views retain at most 256 KiB
and report the omitted byte count when the complete size is known. Use `--plain`
to stream the complete dump without building it in memory.

Each language selects how bytes are decoded. Text languages currently require
valid UTF-8. The binary language keeps each raw byte unchanged. An explicit
language also selects its decoder, so an invalid UTF-8 sequence reported under
an explicit text language is an error rather than silently becoming binary. A
UTF-8 byte order mark is removed before parsing and restored when an edited file
is saved. Binary workspace files and Git blobs remain outside text diff editing
and TypeScript semantic lookup.

Automatic content detection is limited to binary input, structurally identified
raw unified diffs, and standard Git commit output. A raw diff starts at the
first nonblank line. Recognized shebangs and transformed compiler headers remain
explicit selectors. A shared extension such as `.cfg` consults the source for
the one pattern its metadata names. JSON-, YAML-, Markdown-, Python-, and other
language-shaped source is otherwise not guessed from its syntax.

A diff shows its whole-diff change totals at the top right corner of its first
line: the added line count and the removed line count, colored like additions
and removals.

Dialogs share Up / Down, Page Up / Page Down, and Home / End for navigation.
Ctrl-F / Ctrl-B also page down / up. Pages follow the dialog's visible height,
with one row of overlap. While browsing, `j` / `k` and `J` / `K` move down / up,
Space and `b` / `B` page down / up, and `g` / `G` jump to the top / bottom.
Ctrl-N / Ctrl-P move down / up, and Ctrl-D / Ctrl-U move half a page.
Confirmation prompts use navigation keys to move button focus; Space activates
the focused button. Printable keys enter text while a filter is active.

Press `i` in a diff to open its file and commit list. The list starts in browse
mode. Press `/` to filter it by file name, commit hash, or commit subject. In
browse mode, Space pages through the entries, and `g` and `G` select the first
and last entry. The `f`, `F`, `E`, `T`, and `M` file-visibility keys remain
active. On a commit row, `f` hides all of that commit's files. Pressing it again
shows them. Each commit row reports its total added and removed lines under the
selected count policy. The list's summary reports added and removed lines for
the complete diff and for the files that are currently shown.

Use `<` and `>` to move to the preceding or following commit header in the main
view or the index list. From within a commit, `<` returns to that commit's
header. These keys follow the order of commits in the input, including separate
commits piped from `git show` or `git log -p`.

Press `D` in that list to cycle its line-count policy. Normal counts include
every added and removed line. The second policy removes pairs within one file
whose text differs only in whitespace. The third also removes lines containing
only whitespace or comments. It compares the remaining lines without comments or
whitespace across the complete diff, so code moved between files does not count
as an addition and a removal.

Markdown files can switch between the source and a rendered terminal view with
`V`. The rendered view formats headings, emphasis, links, quotes, lists, task
markers, tables, rules, and code. The same view is available for Markdown files
inside a unified diff; diff markers, addition and deletion tints, line
positions, and hunk expansion remain in place.

Press `\` in the interactive pager to cycle through unwrapped lines, hard
wrapping, and word wrapping. Hard wrapping fills every screen row before it
continues. Word wrapping breaks at whitespace and repeats the line's leading
punctuation and whitespace on each continuation row.

Redirected text output keeps the source text verbatim by default and adds ANSI
color only when the selected color mode permits it. Binary output uses its
hex-dump view by default. Pass `--rendered` to start in, or print, another
language's rendered representation when one is available. Editing from a
rendered view returns to source first.

```bash
cf check pattern.tsx --show-transformed --no-run | cf view
cf view .github/workflows/deno.yml
cf view scripts/analyze.py
git diff upstream/main | cf view
cf view --rendered README.md
generate-source | cf view --filename generated.py
generate-markdown | cf view --language markdown --rendered
generate-bytes | cf view --language binary
```

## Interactive shell

`cf sh` opens shuttle: a prompt carrying a **place**, lines read against it, and
one connection held open for the whole run. `cfsh` is a forward to the same
command — the space elided, one name at two spellings — so `cfsh -s my-space`
and `cf sh -s my-space` are one thing. Shuttle is what the thing is called; `sh`
is what you type, the way Fabric is called Fabric and typed `cf`.

It takes the three flags every command with a space and an identity takes —
`--api-url`, `--identity`, `--space`, with `CF_API_URL`, `CF_IDENTITY` and
`CF_SPACE` behind them — so a session that already exports those needs no flags.
The design is
[`docs/plans/shuttle/README.md`](../../docs/plans/shuttle/README.md).

A place is the context that fills in the levels a reference leaves out: a space,
optionally a piece, optionally a path inside it — and a **scope**, the
per-identity overlay every read goes through. Both halves stick as you navigate,
and both show in the prompt.

```text
shuttle / @space> cd slugs
shuttle /slugs/ @space> cd board
shuttle board @space> get title
"verb contracts"
```

The prompt names shuttle rather than the command, the product being what a
prompt says it is. It is the short surface: it leaves the space out, since one
shuttle serves one space for its whole run, and shortens nothing else. A piece
shows by the name the space's index confirmed for it, and by its handle where no
name was confirmed. `pwd` is the complete address — every level, the piece by
handle, the scope written even when it is the base — which is what to copy.

A `pieces` listing uses the registered target's full reference when its space,
scope, or path differs from the current place. A target in another space keeps
that address in the listing; `cd` refuses it because a shuttle connection serves
one space. It does not substitute the current space for the target's space.

`cd` reads before it moves: a slug resolves to the piece it names, a handle is
looked up in the space's identifier index, and a path that is not there is
refused with the keys that are. A scope on its own is read the same way — the
same id under two scopes is two documents, so `cd .@session` is a move onto a
place like any other. `@` is data off that head, so `cd @session` reaches a key
of that name, and a refusal that finds none offers `.@session`. The place holds
the piece rather than the slug, so a slug repointed mid-session moves the name
and never the place. `slugs` and `pieces` are reserved as the first segment of a
rooted reference as well as at the root, so `cd /slugs/board` is the same as
`cd /` then `cd slugs/board`. That is the one place the shell reads a reference
differently from the rest of `cf`, which takes those two as ordinary slugs;
[#6992](https://github.com/commonfabric/labs/issues/6992) retires the difference
by refusing them as slug values.

A relative operand is the cell reference grammar's
([`docs/specs/cell-reference-grammar.md`](../../docs/specs/cell-reference-grammar.md)),
read by that grammar's own reader: a head — `.` for where you stand, or a run of
`..` — and then a path in which every segment is a key. `a/../b` is three keys,
`~1` escapes a `/` inside one, and a trailing `/` inside a piece names the empty
key. The head's climbs walk back the way you came, so `cd ..` from a piece
reached through `slugs/` returns to `slugs/`. `#argument` on a head or on a
piece segment selects the piece's arguments cell, which `get` reads and `cd` and
`ls` refuse, a place always standing in a result. A listing prints a key that
would read as anything else behind the `.` head — `./..`, `./-x` — and `pwd`
writes the place as `//<space>/<piece>@<scope>/…`.

| Verb                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd <ref>`                    | Moves the place, once the fabric says it is there. Takes relative references — `.` for where you stand, a run of `..` climbing back the way you came, `.@scope` for the scope, and a literal path after them — and `-`, `/`, rooted and complete references, slugs, `%n` rows, and `#name` entry points.                                                                                                                                                                                                                                                        |
| `ls [<ref>]`                  | Lists what stands at a place, defaulting to where you stand: a space root's facets, the slugs the index records, the space's pieces, or the keys under a cell. The operand is `get`'s, less the `#argument` member, and listing a target renumbers the rows, so `%n` selects what it just showed; `cd %n` moves only within the current space. Rows are numbered, a row that is one of the piece's callables says so, a piece shows the name it carries beside the handle that reaches it, and one screenful is written. `--limit <rows>` overrides the height. |
| `pwd`                         | The complete address of the place, both dimensions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `get [<ref>]`                 | Reads the value at a cell, defaulting to where you stand. `#argument` on a head or a piece segment reads the piece's arguments cell, as in `get .#argument/title` or `get /slugs/board#argument/title`. Takes `cf cell get`'s read options — `--filter`, `--select`, `--schema`, `--json` — and writes one screenful of JSON, or the whole value under `--json`.                                                                                                                                                                                                |
| `set <ref> <value>`           | Writes a value at a cell, which copies rather than links. The value is JSON, and a bare word is the string it spells. `-` is refused, standard input being the keyboard.                                                                                                                                                                                                                                                                                                                                                                                        |
| `edit [<ref>]`                | Opens a cell's value in `$EDITOR` and writes back what you save. A value JSON cannot carry is refused before the editor opens, and text that will not parse is refused with the file it is still in.                                                                                                                                                                                                                                                                                                                                                            |
| `link <ref> <ref>`            | Writes a reference at the second cell naming the first, `ln -s`'s order. The one spelling that makes a cell read another cell.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `call <ref> <name> [input…]`  | Invokes a piece's verb. The verb name opens the callable's own section, so its schema-derived flags follow bare and `--` closes it. A callable handle off `verbs` carries the name already, as in `call %4`.                                                                                                                                                                                                                                                                                                                                                    |
| `verbs [<ref>]`               | Lists a piece's callables, numbering each so `call %n` invokes it. `--all` shows the rows the marks hide.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `describe [<ref>]`            | The page `cf piece describe` writes: what the piece is, what it holds, and what it takes. `--all` as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wish <#name>`                | Resolves a named entry point, exactly as `cf wish` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `watch [<ref>]`               | Arms a watch on a cell and opens the value view onto it. `q` closes the view and leaves the watch armed; an armed watch writes one line above the prompt per settled change. A cell already watched is refused. The view scrolls with `j`/`k` and the arrows and `g`/`G`, finds text with `/` and `n`/`N`, opens the watched cell in `$EDITOR` with `e`, and runs any shuttle line with `:` — the line runs where a line typed at the prompt runs, and what it produced joins the transcript when the view gives the screen back.                               |
| `watches`                     | Lists the watches this run has armed, numbering each so `unwatch %n` disarms one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unwatch <handle>`            | Disarms the watch a `watches` row numbered. The row carries the cell its watch is armed on, so it names the watch it showed.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `more`                        | Writes the next page of a listing or a value that did not fit, a listing continuing under the numbers it already gave its rows.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `xpwd`                        | The external working location, whole — the one working position outside the fabric.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `xcd <path>`                  | Moves the external working location, and writes where it landed. The operand is read on that plane already, so `xcd ../foo` and `xcd /tmp` stay on the plane it stands on. A whole schemed path names its own plane, which may be the one it stands on (`xcd file:~/data`) or another (`xcd https://example.test/a/b/`). A scheme is legal only on an absolute complete path.                                                                                                                                                                                   |
| `where [<dimension> <value>]` | With no operand, the whole ambient record: the connection, the place `pwd` prints, the external location `xpwd` prints, and what this run is watching. With a dimension and a value, it sets the light ones — `where scope @session` moves the scope as `cd .@session` does, and `where external file:/tmp` moves the external location as `xcd` does. The api endpoint, the identity and the space are fixed at launch, and restarting is what switches them.                                                                                                  |
| `help [<verb>]`               | Lists the verbs, or writes one verb's page. `<verb> --help` writes the same page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`watch` is the live half. It arms a **watch** — a subscription on one cell that
outlives the view that opened it — and opens the value view onto that cell: the
value as JSON, scrollable with `j`/`k` and the arrows, `g` and `G` for its ends,
and `q` or `ctrl-c` to come back to the prompt. `/` finds text in the rendering
and `n`/`N` move between the matches; `e` opens the watched cell in `$EDITOR`,
which is the trip `edit` makes; and `:` runs any shuttle line without leaving
the view — where a line typed at the prompt runs, against the place the shell
stands at, and under the same `ctrl-c`, which stops the line rather than closing
the frame while one is in flight. What a line produced joins the transcript when
the view gives the screen back, the frame carrying its first line until
something replaces it. The frame's bottom edge offers what it answers to in
whichever of those states it is in. What the design's key table has beyond them
is drilling — `enter` and `backspace` — which wants a row to drill from and
arrives with the list view. The two halves are separable on purpose: `q` closes
the view and the watch stays armed, and every settled change to a watched cell
then writes one line above the prompt naming the cell that changed, as in
`watch board/replies @space: changed`. It says that the cell moved rather than
what it moved to: `get` reads the value out, and the view shows it moving.
Scrollback is never rewritten: liveness lives in those lines, and the view draws
on a screen of its own.

A change is what is reported rather than a value: the first reading of a cell is
the baseline and writes nothing, and a recomputation that landed on what was
there writes nothing either. A repaint and a line come once per quiet runtime
rather than once per value on the way there, and nothing waits on a clock to
decide that. `watches` numbers what is armed and `where` names it; `unwatch %n`
disarms one.

Foreign piece rows retain their complete targets when selected; `cd` refuses to
move into a foreign space. A listing numbers its rows, and `%n` names a row
until the next listing replaces the numbering — `more` continues the current one
rather than starting another. `cd %3` and `get %1/title` act on what a listing
showed, and `call %4` invokes a callable row without the receiver or the name
being written again: a row carries its kind, and the place the listing was read
at is the receiver. A row nothing stands at, a callable among them, is a row
`cd` refuses and `call` invokes.

Reaching into a piece starts it, so what a read serves is what a running pattern
holds rather than what was last committed. Every verb that touches a piece
reaches in — `cd` onto one, `get` and `ls` inside one, and each of the writes
and calls — while a place that is no piece starts nothing, there being no
pattern behind a facet. A piece is started once for the run, counted by the
piece the walk resolved to rather than by the path that reached it: two lines
writing two fields of one piece start it once, and two lines reaching two
members of one collection start two.

Shuttle holds a second working position, outside the fabric: `xcd` moves it and
`xpwd` prints it. Its argument is on that plane already, so a plain path moves
it without naming a scheme — `xcd ../foo`, `xcd /tmp` — and a whole schemed path
names its own plane, which may be the one it stands on or another. A scheme is
legal only on an absolute complete path, so `xcd file:/tmp/out` names a place
and `xcd file:out` is refused. A run starts on the `file:` plane, at the
directory the shell was started from. The two positions move independently: `cd`
leaves the external location where it was, and `xcd` leaves the place where it
was.

A line is split POSIX-style — whitespace separates, quotes group — so a value
holding a space is one operand when it is quoted, and anything shuttle prints as
an operand is quoted where it has to be. Every refusal carries its reason. A
read that failed is different: it is reported and the prompt reads the next
line, since a shell whose server went away is still a shell.

`ls` and `get` each write one page and hold the rest, because a listing of a
populated space and the result of a piece are both larger than a screen. The
page is the terminal's height less the prompt's own row, less one more for the
status line saying how many lines were held back; `more` writes the next one.
The bound is in screen rows rather than in lines, so a line wider than the
terminal costs the rows it wraps onto — a value that is one long string is
bounded as readily as one that is two hundred lines. A piece's `$UI` node is
stood in for rather than written out, unless the line names the fields it wants
— it is a vnode tree with data URIs in it, and `--select '$UI'` is what reads
it.

The keys are read while a line is running, so a slow server holds up neither the
keyboard nor the screen. What you type during the wait is drawn as you type it,
into the line that will run next; `enter` under a running line is held and runs
that line the moment the prompt is free, against the place the line before it
settled on. `ctrl-c` cancels the line in flight and drops what was typed ahead
of it. Cancelling reaches the line and not the server: a read already sent
finishes into nothing, and the checks along the way are what stop it taking
effect, so a `cd` you cancelled leaves you where you were.

Everything a run writes lands above the line being edited, with the prompt drawn
again beneath it — a line's own outcome, the warnings a connection writes for
itself, and a pattern's `console.log` once a piece runs in the session. That one
door holds every character a terminal acts on to the glyph naming it, a line
break excepted, so nothing a user program logged can move the cursor off the row
it was given.

After the split, a token opening with `-` is an option up to a bare `--`, and
every other token is an operand. `-` on its own stays an operand, being the
previous place and the stdin sentinel, and a bare `--` ends the options, so a
key called `-x` is reached by `cd -- -x` or by `./-x`, which is what a listing
prints for it. The parse is `cf`'s own — the one a `cf` command reads its flags
through — so a flag is spelled and refused here as it is on a `cf` command line,
and `--help` is the option every verb takes.

`call` reads that rule the other way, because its operands carry a callable's
own flags. The parse stops at its first operand, so
`call topics/3 search
--query milk` hands `--query` to the callable rather than
refusing it, and the bare `--` closes the callable's section instead of quoting
an operand. Its own options are still its own: they are the ones written before
the receiver, so `call --help` writes this verb's page.

A callable's page is not reached by writing an option where its name goes. A
name in that shape is one nobody can type: the option grammar reads such a token
as an option wherever one may be written, and the single place it does not —
inside the callable's own section, past the name — is a place a name cannot be.
So `call topics/3 --help` is refused rather than sent to the fabric as a
callable called `--help`, and the refusal says why; where the name was `--help`
or `-h` it also points at `verbs`, which lists what the piece can be asked to
do.

The line editor is `lib/view`'s `EditBuffer` over its own key decoder, bound to
Emacs keys: `ctrl-a`/`ctrl-e` and `home`/`end` for the ends of the line,
`ctrl-b`/`ctrl-f` and the arrows for a character, `alt-b`/`alt-f` for a word,
`backspace` and `delete`/`ctrl-d` to delete, `ctrl-w`/`alt-backspace` and
`alt-d` to kill a word, `ctrl-k` and `ctrl-u` to kill to the end of the line and
to kill the line, `ctrl-y`/`alt-y` to yank and cycle, `up`/`ctrl-p` and
`down`/`ctrl-n` to walk the lines you have typed, `ctrl-c` to abandon the line
or cancel the work in flight, and `ctrl-d` on an empty line to end the session.

`up` and `down` walk this run's own lines — nothing is written to disk and
nothing survives the process. What they walk is those lines and the line you
were typing, so `down` back past the newest returns it, and a half-typed change
to a recalled line is still there when you come back to it. A line with nothing
on it is not recorded, nor is one you just ran again, and neither end wraps
round. Running a line or pressing `ctrl-c` returns you to the line being typed.

`tab` completes the token the line ends in: a verb where you have typed none,
and after a verb whatever that verb takes at the position you are typing at — a
verb name for `help`, and the rows that stand where you stand for the verbs that
reach one. A verb taking two operands answers per position rather than once:
both ends of a `link` are places, `set`'s path is a place and the JSON value
after it is nothing anything could list, and `call`'s receiver is a place while
the callable's name after it belongs to that receiver rather than to where you
stand. What it writes is what `ls` prints for the same row, so a name needing
quotes arrives quoted and a name a reading would take arrives behind the `.`
head; where several rows agree only as far as a partial that would need quoting,
nothing is written and you type on. Completing under a place is a read, so it
runs beside the keys the way a line does: `enter` typed under it is held and
runs the line it completed, `ctrl-c` cancels it, and a read that failed writes
nothing rather than saying so. What it completes is the token at the end of the
line, so a cursor elsewhere leaves the line alone — and the token is the one the
split reads, so a space you quoted or escaped stays inside its token rather than
starting a new one.

Nothing turns a candidate down for its shape. What bounds a completion is which
rows stand where you stand, so `cd slugs/bo` at a space root writes nothing —
not because a rule forbids the `/`, but because no row standing at the root is
called that. A row whose own operand carries a `/` completes exactly as any
other does.

The code is `lib/shuttle/`: `run.ts` composes a session, `place.ts` holds the
place and what `cd` refuses, `connection.ts` the one `PiecesController` a
process holds, `line.ts` the split and the printing that inverts it,
`options.ts` the option grammar over the tokens after a verb, `listing.ts` what
`ls` reads and what each row turns out to be, `handles.ts` what a `%n` operand
names in it, `verbs.ts` the dispatch — which writes nothing — `vocabulary.ts`
the shuttle, the deps and the acts every verb is written in, `editor.ts` the
round trip `edit` makes through `$EDITOR`, `help.ts` the form a verb's account
of itself prints in, `page.ts` how much of a rendering one page holds,
`value.ts` how a value the fabric holds is written, `session.ts` what the last
listing numbered, what `more` writes next and which pieces the run has started,
`prompt.ts` the loop that reads keys and runs a line beside them, `history.ts`
the lines that loop has read and the traversal over them, `editing.ts` the table
of what a key does to a line being typed, which that loop and a view's command
line both read, `completion.ts` what `tab` finishes, `watch.ts` what a watch is
and the line each settled change writes above the prompt, `lens.ts` the value
view and every key it answers to, `announce.ts` what a connection and a pattern
write onto that loop's out-of-band line, `record.ts` the form `where` and `pwd`
share, and `paint.ts` and `terminal.ts` the escape sequences and the raw mode
under it.

Each of those is driven by a unit test with nothing behind it — no server, no
piece, and no terminal — so what the shell does when all of them are real is a
claim no case there makes.
[`integration/shuttle-over-a-terminal.sh`](integration/shuttle-over-a-terminal.sh)
is where that claim lives: it deploys a fixture into a fresh space, opens
`cf sh` on a pseudo-terminal, and reads back the drawing a line at a time — what
the shell said, and the prompt it then drew.

The writing verbs are read twice there, and the transcript is the weaker of the
two readings. A `set` that receipted a write it never made, and a `call` that
settled without running the handler, both draw exactly what a working one draws
— so the session's writes are read again from outside once it has ended, over a
connection it never held. What the shell said is the claim; what the fabric
holds afterwards is the evidence.

That second reading is taken at the end, so what it establishes is the state at
the end rather than that every write landed: a cell written more than once
carries only its last value, and a value another line would have produced anyway
reads the same as one this line produced. So the walkthrough says which write
each reading speaks for. One `set` goes to `settings/note`, a path nothing else
in the session touches, and that one is established end to end at its own
address; the writes the sweep cannot speak for rest on the shell's own read on
the line after each, which catches a receipt with no write behind it but cannot
see whether the write committed.

## Cell references

`cf cell` holds the commands that act on a cell: `get` and `set` for its value,
`get-label` and `set-label` for the CFC label on it. Each takes a reference.

A reference names a cell, and one grammar covers every part of the name:

```
//<space>/<piece>[#<member>][@<qualifier>…][/<path>]
/<piece>[#<member>][@<qualifier>…][/<path>]
```

`<space>` is a space name or a DID; `<piece>` is a slug or a handle
(`of:fid1:...`). `did:key:...` and `fid1:...` both say what they are, so neither
can be mistaken for a name and one token holds whichever spelling the caller
has. `//my-space/tracker/items/0` and `//did:key:z6Mk.../of:fid1:abc.../items/0`
are the same shape.

This is the one reference syntax of the fabric — the same structure names the
same cell in patterns, in the shell, and here. What differs between those
readers is what each can resolve, not what the grammar admits: a pattern
resolves a link from the string alone, so it needs the self-identifying
spellings; `cf` opens a session before it reads anything, so it resolves a name
and a slug as well.

A positional reference is relative to the selected cell. `.` names the current
position, `../title` climbs once, and `.././..` climbs once then names the key
`..`. Only the head climbs: `a/../b` names three keys. A trailing slash names
the empty key, including `./` at the current position. `.#argument/title`
selects the arguments document from its root; `.@session/title` changes scope
while keeping the position. A bare `title` is the same as `./title`.

Qualifiers repeat as `@name=value`, with each name appearing once. Scope has the
abbreviations `@space`, `@user`, `@session`, and `@inherit`; the last requires a
context. `@pin=<43 base64url characters>` is reserved for module identity and
ignored by runtime cell resolution; shuttle refuses pinned operands. The
`/@did:…/` space alias stays readable; the `/@name/` alias is refused with a
message directing callers to `//name/`. A space embedded in it names the target
space: it supplies the space when `--space` is absent, and when both are given
they must agree — a mismatch is refused rather than resolved, at parse time when
the two are written the same way and once the session opens when only a
derivation can compare them. An address printed by one command therefore
composes into the next with no flag beside it, whatever space the reader has
configured.

A slug may name a collection rather than a piece.
`cf piece set-slug top /of:fid1:…/names` points `top` at the map a board keeps
its members in, keyed by member name, and `/top/2` then names member `2`. Where
the slug points is what decides how the path after it reads. A slug that points
at a piece names that piece, and the path is a cell path inside it, as it is
after a handle: `/tracker/items/0` is `items/0` inside the piece `tracker`
names, whatever `items` holds. A slug that points anywhere else names a
collection: the first segment selects a member, the cell that member holds is
the piece, and the segments after it are a cell path inside that member. So
`cf cell get /top/2 title` reads member `2`'s title,
`cf piece describe --cell /top/2` describes it, and
`cf piece call --cell /top/2 <verb>` calls it. Exactly one segment reaches a
member, so a field of a member never answers to the collection's namespace:
`/top/2/title` is the `title` field of member `2`, never a member named `title`
of whatever `2` holds. This is how an address reads wherever a `--cell` or
positional one names the target, at both `cf piece link` endpoints, and for the
source of `set-slug`.

A collection's name with no member after it is refused, naming the piece that
holds the collection; a member the collection does not hold is refused as
`no member 999 in top`. The map itself is addressed by the `piece/path` handle
`cf piece slugs` prints for the name, never by the name, which addresses
members: `cf cell get /of:fid1:…/names` reads the map and prints the member
names it holds. `cf piece inspect` takes a piece id rather than a cell inside
one, so it has no spelling for the map at all; given the name instead, as
`cf piece inspect --cell /top`, it meets the collection's refusal the way every
other command does. A write takes a path inside the member the address reaches,
and the value on stdin: `echo '"Oven schedule"' | cf cell set /top/2 title`. A
`cf cell set` whose address stops at `/top/2` is refused, because the address
alone reaches the member's whole cell and replacing that is what a path spells
out. The one spelling that does replace a whole cell is an explicit empty
positional, `cf cell set <address> ""`, which has always named the root.

Beside the reference, the CLI's bare form — `pieceId[@scope]`,
`pieceId[@scope]/path` at link endpoints, and slugs — is a convenience alias for
interactive use. New reference-syntax capabilities land in the reference first;
the alias does not grow a capability the reference lacks.

`cf piece render --cell /tracker` renders the UI of the piece the slug names.
`cf piece render --cell /top/2` renders the selected collection member's UI,
using the scope stored in its link. Rendering takes a whole piece: a reference
such as `/tracker/title` that continues inside the piece is refused. `--watch`
reports later UI changes from the resolved piece, and `--no-start` renders its
stored state without starting it.

### Calling the piece a path links to

`cf piece call` takes a piece, so a path on its target is read as a pointer: the
link stored at that path is followed, and the call goes to the piece the link
names.

```
cf piece call //profile-space/of:fid1:…/inbox/piece receive '{"id":"offer-1"}'
cf piece call --cell //profile-space/of:fid1:…/inbox/piece receive '{…}'
```

The link is resolved by the runtime, as a read through the same path resolves
it, so the caller never reads a `$link` or rebuilds an address. The linked piece
may sit in another space on the same host: the call opens a connection to that
space under the same `--identity`, and that space's ACL and the CFC policy
decide whether it is allowed, as for a call addressed there directly. `--space`
and a space embedded in the reference name the space the _path_ sits in, and
must agree with each other as everywhere else; the linked piece's space comes
from the stored link and is never written.

A path that leads to no piece is refused with exit code 1, before anything is
dispatched:

- `The path "…" on piece … names no piece: …` — no link is stored there (a plain
  value, or nothing), or the linked document is not a piece. `names no piece` is
  the stable phrase to match on to tell "no pointer here" from every other
  failure.
- `The path "…" on piece … links to a cell inside a piece (…), not to a piece.`
  — a link is stored there, and it names a cell rather than a piece.

Only `cf piece call` follows a path this way. The other commands that take a
piece and nothing inside it — `cf piece verbs`, `describe`, `inspect`, `step`
and the rest — refuse a path on a handle.

### Writing the target

On `cf cell get`, `cf cell set`, and `cf piece call`, the reference goes in the
first positional, which is the spelling to reach for: a reference begins with
`/` and a relative path never does, so the two positions cannot collide.

```
cf cell get /tracker items/0/title
cf cell get //my-space/tracker/items/0 title
cf piece call /tracker addItem '{"title":"Milk"}'
```

`--cell` takes the same word where a flag suits better, and is where the bare
and slug spellings go — there no path competes for the position. `--piece` is a
deprecated name for `--cell`: one option under two names, so the two can never
disagree, and it goes on working. It carries no expiration date — write new
commands against `--cell`, but nothing is scheduled to stop taking `--piece`.
Naming the target twice — the flag beside a positional reference — is refused
rather than resolved.

`--url` is a convenience for pasting a URL out of a browser. It is not a
spelling of its own: the host becomes the `--api-url` and the rest becomes a
reference, and both are read on exactly as if they had been written, so
`--url https://cf.dev/my-space/tracker/items` means
`--api-url https://cf.dev //my-space/tracker/items`.

Those three each sit under the noun they act on: `get` and `set` name a cell, so
they are `cf cell` subcommands, while `call` invokes a verb on a piece and is a
`cf piece` one. The bare `cf get`, `cf set` and `cf call` still answer, hidden
and superseded — see [Superseded spellings](#superseded-spellings).

A target may select `#argument` on its piece segment, before any qualifiers or
path, which selects the piece's arguments cell the way `--input` does — on a
reference, on a bare id, and on a slug alike, since all three designate the same
piece. Only commands that take `--input` accept it. `#result` selects the result
document. Within a path, `#` is data: `/piece/a#argument` selects the result's
literal key `a#argument`, while `/piece#argument/a` selects argument key `a`. A
`--url` carries no fragment into the reference it decomposes to, whatever the
URL names, so a `#argument` written on one is dropped rather than refused. A URL
that names the piece admits no `--cell` or positional address beside it, and
`--input` is what reaches the arguments cell there; a URL that names only the
space leaves the target to arrive as it always does — a positional address, or
`--cell` — carrying the suffix like any other.

`cf piece apply` replaces a piece's whole input rather than one path within it.
It validates the document against the pattern's `argumentSchema` and re-executes
the pattern with it, so a field the schema requires and the document omits is
refused before anything is written. `cf cell set` names one path instead. On a
result-cell write it validates that selected path, which makes `set` the right
operation for changing one result value.

An input-cell write is currently sharper:
`cf cell set --piece <id> --input
<path>` resolves that path through the piece's
input contract and revalidates the complete input document. It can therefore be
refused over an unrelated allocated field whose value is readable and violates
the schema. A field whose stored or supplied value is a link this replica cannot
read — a per-user instance another principal owns, a document not replicated
here — is not judged by that check: its value is owned elsewhere and is checked
when a reactive read materializes it. A write that itself resolves through a
link is also checked against its destination's contract, which still refuses a
required field it cannot reach. Addressing the raw argument cell by id avoids
that whole-document check, but it is an unsafe recovery tool: it can erase
link-bearing data that a later `cf cell set` will refuse to restore because the
serialized link has no durable source contract. The superseded `cf set` spelling
mounts this same command and has identical validation behavior.

## Linking piece inputs

`cf piece link <source>/<path> <target>/<path>` stores a live connection in the
target piece's argument. Rebinding a terminal path replaces that connection; it
does not write through the previous producer. Binding a Stream stores its handle
without sending an event.

After the binding commits, linking starts the target piece and materializes its
result. `--no-start` stores the binding without starting the target. A rejected
binding leaves a stopped target stopped.

The Piece API checks the binding before committing it. A producer with durable
schema metadata must supply values the consumer can read. A writable consumer
must also restrict its writes to values the producer accepts. Capability and
scope constraints apply, and a rejected binding leaves the previous argument
unchanged. `--allow-non-existing` only overrides the CLI's path-existence check;
it does not waive contract validation.

Ordinary cells and externally injected handles, including SQLite sources, can
lack durable producer schema metadata. These remain supported as dynamic
bindings, with destination scope checks but without a static producer payload or
capability proof. A known Piece document whose producer contract cannot be
recovered is refused. A piece without an argument schema imposes no consumer
schema constraints, and plain-cell targets retain their ordinary binding
behavior. Successful linking does not establish compatibility with a future
producer schema; producer enforcement still applies when values are accessed or
written.

## Updating piece source

Run `cf piece setsrc --check` before every source update to a piece whose state
matters. It compiles the complete candidate package, compares it with the exact
piece named on the command line, and exits nonzero on refusal. The check issues
no storage writes: candidate compilation and current-source recovery reuse
verified caches without persisting artifacts or repairs. It creates no module
update delegation. The target, entry, root, export, test, data-file, and
repository flags on the check must match the apply.

Reads still use the normal storage synchronization path. On a deployment with
server execution, those reads can demand server-side materialization; other
clients and background work can also change the space while a check runs.
Preflight does not provide a frozen storage snapshot.

Apply persists compilation artifacts before setup. It commits new module update
authority atomically with the source pointer and revision; a refused setup
publishes no proposed authority. Successful source updates require an owned,
durable setup transaction. Against a deployment that runs the serving loop, that
transaction is the serving runtime's: the command sends the resolved program and
the piece's id to the deployment's pattern-lifecycle route, and the update
commits there, directly to the store (see
[Where a piece is created](#where-a-piece-is-created)). The check stays in this
process on every deployment.

Preflight uses setup's stored-argument validation: optional fields holding
`undefined` count as absent, and unreadable linked values defer to reactive
reads. A compatible verdict therefore does not prove that every linked value has
loaded. It also runs the CFC schema-envelope merge the setup transaction
performs at commit, in dry run, over both documents that take it: the envelope
stored on the piece's argument document against the candidate's argument schema,
and the envelope stored on the piece's own document against its result schema,
the latter only where setup would rewrite the result projection, since a
candidate that leaves the projection as it is takes no result merge at commit. A
stored claim the candidate cannot reconcile with — an owner-protected field
whose `writeAuthorizedBy` claim names a different binding, say — is reported by
the check in the merge's own words rather than discovered as a commit rejection
at apply. A committed direct handle retained under an unchanged input contract
keeps its producer's policy; the check does not require the consumer to
redeclare that policy. New links and changed handle contracts require the full
producer-contract proof. A successful render after apply is required.

```bash
cf piece setsrc --cell fid1:piece --root packages/patterns \
  --check packages/patterns/example/main.tsx
cf piece setsrc --cell fid1:piece --root packages/patterns \
  packages/patterns/example/main.tsx
cf piece render --cell fid1:piece >/dev/null
```

The source commit and refresh of the running piece are separate operations. If
the commit lands but refresh fails, `setsrc` prints the commit receipt on
stdout, prints the failure and recovery checks on stderr, and exits nonzero.
That status means “source changed, running deploy unverified,” not rollback: use
`piece render`, `piece inspect`, and `piece getsrc` to determine the live state.
A receipt alone is never proof that the updated piece starts.

In either case the receipt names the committed pattern ref, the source revision,
and the seq at which the space's commit log accepted the update. That seq is
what `cf inspect value-at --seq` and `diff --from` take, so the piece can be
read at exactly the commit that applied the update, or diffed against what has
landed since.

## Where a piece is created

Against a deployment that runs the serving loop — one whose published posture
selects `EXPERIMENTAL_SERVER_EXECUTION`, which the connection adopts —
`cf piece new` does not compile or commit in this process. It resolves the
program from disk, pins its fabric imports, and sends it to the deployment's
pattern-lifecycle route, signed with the identity the command connects as; the
space's serving runtime compiles it, creates the piece, and answers with the
receipt the command prints. Where the deployment enforces ACLs, the identity
must hold WRITE or OWNER on the space; a deployment with enforcement off admits
any signed caller, as its memory server does. Setup, slug, and creation receipt
commit together, so a taken name refuses before anything is created.
Registration then invokes the default pattern's `addPiece` handler and waits for
its durable consequence and registry readback. A failure names the created piece
and a retry key; repeat `cf piece new` with `--request-key <key>` to resume that
creation. The space root is the serving loop's to ensure rather than this
command's. What stays in this process after the receipt is what opening a piece
does anyway: the start, which `--no-start` skips; `--no-start` also asks the
serving loop not to derive the piece until something demands it. The receipt
returns once the piece is durable and registered, including with `--no-start`;
the serving loop derives it on demand, so a reader that needs the derived value
pulls it. Against any other deployment, and under `cf test`, the command
performs every step itself, as before. `cf piece setsrc` requests the same way
against a serving deployment: it resolves and pins the program, sends it with
the piece's id, and prints the receipt of the setup transaction the serving
runtime committed — directly to the store, since a source update publishes
module update authority that requires a transaction committing to storage
itself. What stays in this process is the refresh a client-side update runs
after its commit: the command starts the piece it holds and reports that outcome
beside the receipt, exiting non-zero when the refresh fails over a durable
commit. A piece addressed at a scope keeps the client-side path.
`cf piece setsrc --check` performs every step in this process on every
deployment. The contract, including the refusals and their codes, is
[`server-pattern-lifecycle.md`](../../docs/features/server-pattern-lifecycle.md).

## Piece discovery

`cf piece describe --cell <piece>` documents a piece's readable fields and
callable operations. `cf piece verbs --cell <piece>` lists operations to call;
it does not describe the piece's readable data. To read field values, use
`cf cell get --cell <piece> <field>`, with a projection for a large collection.
Both discovery commands read the piece's pinned pattern. That pattern reference
identifies its contract independently of the server's runtime commit.

`cf piece ls` lists the pieces in the selected space's piece registry. It reads
the default pattern and starts each registered piece to obtain its name and
pattern metadata. It does not enumerate every stored piece root.

`cf piece inspect --pattern-identity` prints one piece's source pin — pattern
identity, export symbol, current source revision when the piece keeps a log, the
origin it follows when it follows one, and whether the identity's source is
retained in the space — without running the piece and without pulling its input,
result, or link graph.

`cf piece survey` reads a holder's own collection — the enumeration `piece ls`
cannot provide — one cheap identity read per member, the holder last, and emits
a plan for the bulk operations in `docs/plans/piece-bulk-operations.md`. On a
collection survey the registry is its cross-check: a registered piece on an
in-scope identity that the collection lacks makes the survey exit nonzero,
naming the piece. A `--list` survey reads exactly the pieces named and makes no
containment claim; each entry takes either reference form, and a canonical
entry's embedded space composes the way it does on `--cell` — supplying the
space when `--space` is absent, agreeing with it otherwise. Read-only.

The holder is a piece and `--path` names the collection inside it, so neither
the holder's address nor a `--list` entry carries a path of its own, and one
that does is refused rather than dropped. A collection's member is therefore
addressed as a holder by its own handle rather than as `/top/2`.

To watch the surface work rather than read about it,
`integration/bulk-ops-demo.sh` narrates the whole of it — survey, repair,
retarget, and the reversal — end to end against a running server.

`cf piece repair` runs a caller-supplied fixer — a TypeScript module whose
default export is a pure transform from a piece's stored input document to the
document it should hold — over the same selection surface the survey takes. Dry
by default, reporting the exact per-piece diff and writing nothing; under
`--apply` it writes each row in its own transaction, and a plan from a dry run
drives the apply row for row under its document-hash preconditions (`--plan`).
The design is `docs/plans/piece-bulk-operations.md`, stage 2.

`cf piece retarget` applies a survey plan's retarget rows: the plan is the whole
input — it names the pieces, the reference each must still be on, and the source
each moves to — so the command carries no selection of its own. Serial in plan
order, each row's precondition proved in the session that writes it, stopping at
the first failure with every unattempted piece named. Dry by default. Sessions
are grouped (`--group-size`), so a group boundary is a resume point: a piece
already on its row's target reads as landed and is not rewritten, which makes
re-invoking the same command the resume. Applying implies no verdict — the
verification is `cf piece survey --diff`, a separate invocation by design.

Each write detaches its piece from the origin it follows: what it runs
afterwards is the source the plan names. That is recorded rather than gated —
the survey reads the origin into the row's `expect.origin` and every report row
for that piece carries it, on the dry run as much as under `--apply`, so what an
apply would detach is in hand while it is still a decision. A row the run wrote
carries a second value, the origin its write actually detached, which is the one
to re-attach from: only the pattern reference is a precondition, so a piece
whose origin alone moved since the survey is still written and detached off what
it holds at the write. The report names both when they differ, and says so.
Re-attaching afterwards is by hand.

`--apply` refuses to start over a row whose prior source is not retained
(`expect.retained: false`), because such a piece cannot be returned once it has
moved — accepting that after the move is asking past the point of no return.
Each one must be named on `--accept-unretained <piece>`: repeatable, per piece,
with no blanket form, and an acceptance covering no unretained row of the plan
is itself refused. The other way past is to supply the legacy source, so a
reversal has something to restore. A dry run is not gated — it moves nothing,
and reporting where such a piece stands is how an operator finds out there is
something to decide. `cf piece rollback` holds acceptances to the same rule at
the other moment, in the same spelling.

`cf piece rollback` reverses a retarget from that same plan, needing no second
artifact: each row's precondition becomes the reference the retarget produced,
and its operation restores the retained revision carrying the reference the row
recorded. It runs on the retarget's engine, so preconditions, stops, naming, and
resume are the same. A piece whose prior source is not retained has no restore
to run: such a row refuses the derivation by name, and the only way past is
`--accept-unretained <piece>`, which leaves that one piece out and says so —
repeatable, per piece, with no blanket form. The other way past is to supply the
legacy source and retarget onto it.

`cf piece restore` returns one piece to a revision of its own append-only source
log, in front of the runtime's restore of a retained revision. Without
`--revision` the run lists what the piece could be returned to — the id, when it
was accepted, the reference it carries, whether its source is still retained,
and whether the piece runs it now; with one but without `--apply` it is the
preflight for that revision alone. A piece already standing where the restore
would leave it — running the named revision's reference and following no origin
— is reported as such and not rewritten. A piece that runs that reference while
still following an origin is not there: restoring severs the origin, so the run
writes and names the origin it would cut.

`cf piece slugs` lists the space's slug index: every name assigned through
`--slug` or `set-slug`, each resolved to where it points — the piece it names,
or for a slug into a cell inside a piece, that piece and the path, printed
`fid1:…/names` in the table and as a `path` array in the JSON. The index records
assignments made since it existed, so a slug written by an older client still
resolves but is not listed — a slug document's id is derived from its name, and
nothing can enumerate names it was never told.

Completion for a `piece/path` slot — both `cf piece link` endpoints and the
source of `set-slug` — offers the space's slugs and piece ids before the
separator and that piece's cell keys after it. After a slug naming a collection
it offers nothing: reading the member names means reading the map, and that is a
second load for a keystroke to start.

`cf piece set-slug <slug> <source>` takes any address as its source. A handle
with a path, `/of:fid1:…/names`, names a cell inside that piece, which is how a
collection gets its name. A slug with a path after it resolves as a target does,
so `set-slug two /top/2` names member `2`. A bare slug names whatever that slug
points at, piece or not, which is how a collection's name is aliased; a scope
written on a bare slug is refused, because the slug's own redirect names the
scope of the cell it points at. `--resolve-before-linking` resolves the source
cell's link before writing, so the new slug points at what the source's cell
points at rather than at the cell.

A name that already points somewhere is refused, and the refusal names what it
points at, so the address someone opens is never taken by accident and the
caller can see what taking it would cost. `--force` takes it anyway, and clears
the name from the piece it takes it from, so no piece is left claiming a name it
no longer holds. The check is a claim rather than a look: the name is read
inside the transaction the assignment commits in, so two runs claiming one free
name end with one holder rather than with whichever committed last.

`cf piece new --slug` assigns through the same claim and refuses the same way,
naming the piece it just created so an operator can name it another way. Its
`--force` takes the name and is accepted only alongside `--slug`, which is the
only thing it applies to.

`cf piece ls` and `cf piece search` return a `reference` alongside the legacy
`id`. This canonical cell reference preserves the registered target's space,
scope, document, and path, and can be used as a CLI cell address. The human
table includes it in the `REFERENCE` column. Use `reference` to distinguish
targets with the same document ID in different spaces or scopes. Listing retains
the reference even when the target cannot be read.

`cf piece search` also starts from the registry. It searches readable input and
result data, but returns registered pieces only. `cf piece map` likewise shows
connections among registered pieces rather than walking the complete stored
graph.

A piece outside the registry can be found only through a searchable collection
that deliberately publishes it, by following links from a known piece, or by
using an exact piece address, including its scope, that is already known. A
piece with none of those paths is an orphan and cannot be discovered through the
piece commands. See
[Finding Pieces](../../docs/common/concepts/piece-discovery.md) for the complete
boundary.

## Piece data search

`cf piece search <query>` reads every registered piece in the selected space and
returns the pieces whose input or result data contains the query. Matching uses
full Unicode case folding and canonical normalization over nested object keys
and scalar values. Canonically equivalent text matches, and a match cannot stop
partway through one character's multi-letter fold. Readable nested cell values
are included when they belong to the piece being searched. A cell owned by
another piece is searched only with that owner, not with every piece that links
to it. Ownership compares the complete space, scope, and document identity;
equal document IDs in different spaces or scopes remain different owners. Data
owned by a piece absent from the piece registry is not attributed to its
referrers. A cell with no piece ownership metadata remains searchable through
each piece that links to it. Opaque, write-only, comparable, stream, and SQLite
cell handles are not read. Piece IDs, names, and pattern metadata are returned
for context, but they do not count as searchable data.

```bash
cf piece search --space team-space "invoice 1042"
cf piece search --space team-space --json invoice
```

The command accepts the same identity, API URL, space, and combined URL options
as `cf piece ls`. Human-readable output uses the same columns as `piece ls`.
`--json` returns an array for scripts, including an empty array when no piece
matches. If part of a piece cannot be read, the command reports a warning on
standard error and continues searching that piece and the rest of the space.

## Piece CFC labels

`cf cell get-label` returns the effective CFC label view for a result path. Pass
`--input` to select the input cell — a `--cell` value selecting `#argument` on
its piece segment selects it too. The paths in the returned view are relative to
the selected path, and the view includes declared, derived, and link-carried
labels. An unlabeled value returns JSON `null`.

The path is followed through any links it crosses, so the view describes the doc
that actually holds the value rather than the doc the path started in. That is
what a labeled read commonly needs: a `db.query` result splits each row into its
own entity doc and stores the row's labels there, so `q/result/0/txnDate`
crosses a link at `result/0` and its label is two docs away. Selecting the row
instead of the column returns one entry per labeled column.

```bash
cf cell get-label --cell ID messages/0/body
cf cell get-label --cell ID credentials --input
```

`cf cell set-label` reads a declared label update from standard input and
returns the updated effective view. The input is an object with a
`confidentiality` array, an `integrity` array, or both. An optional `observes`
field selects `value`, `shape`, `enumerate`, or `followRef` consumption.

```bash
echo '{"confidentiality":["team"]}' \
  | cf cell set-label --cell ID notes
echo '{"integrity":[],"observes":"value"}' \
  | cf cell set-label --cell ID draft --input
```

The command updates the label through the same checked write path used by
ordinary runtime operations. It does not edit raw CFC metadata. The
stored-schema rules reject a confidentiality update that would make data less
restricted and an integrity update that would silently make data more trusted.
An absent path is also rejected rather than creating policy metadata without a
value. An `observes` update is rejected when it would combine with an existing
observation class instead of preserving the requested class. Omitting `observes`
from a later update preserves an existing unambiguous class.

The path is followed through the links it crosses, as `get-label` reads it, so
the update lands on the doc that holds the value rather than the doc the path
started in. The classes it is checked against are the effective ones, which
merge both documents: the resolved doc's stored classes, and any the selected
slot's own schema declares. Asking for `shape` where either declares `value` is
refused rather than replacing it.

## Invocation sessions

An invocation id is the caller's own word for one call, and another caller can
choose the same one. What separates them is the session it was chosen within:
the pair decides which outcome a replay reads, and it is what keeps an outcome's
address unguessable. `cf invocation-session` is where a session comes from.

```bash
export CF_INVOCATION_SESSION=$(cf invocation-session new)
```

`new` prints one id on stdout and nothing else, so a command substitution
captures exactly it. Mint one per agent run and carry it in the environment
rather than in `--invocation-session <id>`, which every `cf piece call` also
accepts: an environment variable stays out of the process listing an argument
shows up in. A call naming an invocation id with no session in scope is refused:
an id is replayable only within the session it was chosen in, and a session
minted on the spot would make the replay name a different invocation. A call
naming neither gets both, minted for that one call.

## Agent runner

`cf agent` groups the commands over agent requests, and prints its help when
given no subcommand. `cf agent runner` is the per-user process that runs agent
requests. A pattern's `agent()` call becomes an `AgentRun` record in the
requesting space, listed in the requester's home-space agent queue
(`wish '#agent_queue'`,
[`HOME_SPACE.md`](../../docs/common/conventions/HOME_SPACE.md#agent-queue)). The
runner holds the requester's identity, sits on the machine where their Loom
instance lives, and pulls: nothing on a toolshed connects to it.

```bash
# Shown for illustration only.
cf agent runner --identity ./my.key --api-url https://toolshed.example \
  --local-api-url http://localhost:8000 \
  --loom-retrieval-config /etc/loom/retrieval.json
```

| Option                      | Meaning                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--identity`, `CF_IDENTITY` | The keyfile of the user whose requests this runner runs.                                                                          |
| `--api-url`, `CF_API_URL`   | The toolshed serving that user's home space.                                                                                      |
| `--local-api-url`           | The toolshed the runner sits beside, recorded as the runner's `host`. Defaults to `--api-url`.                                    |
| `--loom-retrieval-config`   | The host-owned JSON file backing the read-only Loom tools. Without it the runner offers no `loom_*` tool.                         |
| `--tools`                   | Comma-separated tool names the runner offers. Defaults to what its configuration backs.                                           |
| `--max-concurrent`          | How many runs the process holds at once. Defaults to 1.                                                                           |
| `--lease-seconds`           | How far a claim's lease reaches past the run's last durable write. Defaults to 300.                                               |
| `--work-root`               | Where run workspaces and artifacts go. Defaults to `$CF_HARNESS_HOME/agent-runs`, falling back to `$HOME/.cf-harness/agent-runs`. |
| `--model`                   | The model name passed to `cf-harness`.                                                                                            |

The model provider is the one `cf-harness` is configured with under its harness
home directory. The runner uses the `context` prompt role, so the default
`enforce-strict` mode admits only `submit_result`; set
`CF_HARNESS_CFC_ENFORCEMENT_MODE=enforce-explicit` to use read tools.

What the runner does, in order:

1. Connects to the home toolshed as the identity, creates the home pattern if
   the home space has none, and writes the queue's `agentRunner` entry
   `{ host, tools, registrationId, registeredAt }`. It refreshes the entry, with
   `lastClaimAt`, on every claim and clears it on stop only while its
   `registrationId` still matches.
2. Subscribes to the queue's `entries` and to every record they name, reading
   each record from the toolshed its entry's `host` names. It acts on a change
   to either; it has no polling timer.
3. Claims the oldest `queued` record whose `tools` it offers, while it holds
   fewer than `--max-concurrent` runs. A claim is one commit: `state: claimed`,
   `claim: { runner, leaseUntil }`, and `attempts` incremented. Two runners
   racing for one record conflict, and the loser finds the record claimed.
4. Runs the request with `cf-harness`: the request's inputs as input cells, its
   `maxConfidentiality` as the fabric session's read ceiling, its task under the
   prompt-slot role `context`. Each transcript event the harness persists renews
   `claim.leaseUntil`.
5. Hands the model's structured result to the harness's result writer, and
   writes the record's terminal fields: `result`, `outcome`, `usage`,
   `usageCoverage`, `modelTurns`, `toolCalls`, `runRef`.

| A run that…                                           | ends                         |
| ----------------------------------------------------- | ---------------------------- |
| produced a result the writer wrote                    | `completed`                  |
| hit the model-turn limit                              | `failed`, `LIMIT_REACHED`    |
| failed in the model, a tool, or its result            | `failed`, `PROVIDER_FAILURE` |
| had its result write refused by the space's policy    | `refused`, `REFUSED`         |
| was cancelled (`cancelRequestedAt` set on the record) | `cancelled`, `CANCELLED`     |

A `claimed` or `running` record whose `leaseUntil` has passed is treated as
having stopped writing. The runner wakes at known lease deadlines, or another
runner sees it on start or a queue change; it queues it again when its
`attempts` is 1 and ends it `failed` as `RUNNER_LOST` when its `attempts` is 2.
If `cancelRequestedAt` is set, recovery ends the expired record as `cancelled`
instead. A live lease stays with its runner.

A runner opens one full connection to its home deployment. For queued records,
it opens a storage-only runtime for each distinct record host and reuses that
runtime for later records from the same host. This is the one command that the
next section's rule does not bound to a single deployment.

## One deployment per process

A `cf` process talks to one deployment. Opening a connection writes settings
that belong to the deployment into state that belongs to the process — the
endpoint an LLM call reaches, the base URL a pattern's relative `fetch` resolves
against, the ambient experimental flags a runtime applies — and none of it is
scoped to the connection that wrote it. So a connection to a second deployment
is refused, naming both, rather than rewriting what the first one set while the
first connection carries on against the new settings. `claimProcessDeployment`
in `lib/process-deployment.ts` is where that is decided, and `loadPieces` claims
on the way to opening a connection. What counts as the same deployment is the
spelling `cf` normalizes an API URL to, so a trailing slash or a query string
does not make a second one. Two deployments therefore need two processes, and
restarting is how one process changes deployment — a claim stands whether or not
the connection it was made for opened, so a well-formed host that answers
nothing holds it too.

One invocation of `cf` reaches one deployment, so the limit costs a command
nothing. What it constrains is a caller holding a connection across many
commands, and two more pieces of state constrain that caller the same way with
no check behind them, because a second connection to one deployment is
indistinguishable from the several a single verb already opens: the hint posture
`--quiet` sets, which stands as the last caller left it, and the write receipt's
memo, which names a space once for the life of the process.

## Output Conventions

- stdout carries command output only; hints and diagnostics go to stderr.
  `cf cell get` prints JSON and represents an absent value as `null`.
- ANSI colors are emitted only when stdout is a TTY. `--no-color` or
  `NO_COLOR=1` disables them everywhere (including Cliffy help/usage output);
  `FORCE_COLOR=1`/`CLICOLOR_FORCE=1` forces them when piped. The policy is
  applied in `lib/color-mode.ts` and guarded by `test/color-mode.test.ts`. The
  rendering checks use child processes with explicit color environment settings,
  so the suite can run with `NO_COLOR` set or unset. The
  [Cliffy dependency guidance](../../docs/development/DEPENDENCIES.md#cliffy)
  owns the import-map constraint that keeps this behavior working.
- `-q/--quiet` (on `piece`/`wish` subcommands) suppresses the stderr hint and
  next-step blocks. It deliberately does NOT change the log floor: consumers
  parse `--quiet` runs' stderr for runtime warnings (Loom's stale-root heal
  greps for `load-pattern-by-identity-source-miss`). Use `--log-level error` to
  drop warnings; the two compose.
- `cf piece call` accepts its payload as an inline JSON argument, `-` for stdin,
  an implicit pipe (no payload argument), or schema-derived flags in the
  callable's section — directly after the verb, before any `--`.
- A `cf cell get` path that doesn't resolve prints a one-line error on stderr
  and exits 1 — it is a data error, not a usage error. A `piece link` that fails
  endpoint or contract validation reports the same way.
- The launcher spawns the child CLI with `deno run --quiet` so Deno's own
  warnings (npm "Ignored build scripts" banner) never reach users.

### What a call refuses before it dispatches

When ordinary callable lookup finds no verb, `cf piece call` checks the deployed
pattern's catalog before attempting a stream cast. A name absent from an
available catalog is refused without dispatching: stderr lists the public verbs,
including labeled wrappers and deprecated verbs, and commands to discover and
read fields. The call exits 1 and writes no invocation result. Stored callables
remain callable without a catalog, and unavailable pattern metadata leaves the
stream fallback usable.

An unknown-verb refusal, rejected payload, or pre-dispatch argument validation
failure suppresses the deferred CLI-ahead version note. Other failures can carry
neutral version context: commit distance alone does not establish
incompatibility or explain a failure. For a local server you control, restarting
it from the CLI's checkout aligns the versions. Warnings for an older CLI,
diverged versions, or unknown ancestry retain their connection-time behavior.

`cf piece call` judges the payload against the verb's declared event schema
before anything is sent, so a refusal costs nothing: the invocation id was never
spent and the corrected retry can reuse it.

A field the verb does not declare is one of the things it refuses. The runtime
hands a handler the fields its event schema names and drops the rest, so a
payload carrying a field nobody declared would otherwise run the handler without
it and report the call settled. The refusal names the field, the position it sat
at, the vocabulary that position takes, and the declared name it is one edit
from:

```console
$ cf piece call --cell ID addItem '{"titel":"Milk","done":false}'
Invalid input for "addItem": "titel" at <event> is not a field this verb
declares. Did you mean "title"? <event> takes "title", "done"
```

Positions below the root are spelled the way a `--schema` position is —
`<event>.item`, `<event>.tags[1]` — so one vocabulary covers both refusals.

`cf exec` refuses the same mistake in the same words when it arrives as a flag,
which is how the mounted-file door spells a field. Only the spelling differs,
because that is what the caller typed and must retype; the position is always
`<event>`, since a flag can name nothing below the root:

```console
$ cf exec /tmp/cf/home/pieces/notes/result/addItem.handler invoke --titel Milk
"--titel" at <event> is not a field this verb declares. Did you mean
"--title"? <event> takes "--title", "--done"
```

What the two doors LET THROUGH matches as well, which is the half worth relying
on: a flag naming an undeclared field is accepted exactly where the same field
would be accepted in a payload, and refused exactly where it would be refused.
Both doors read that from one place, so neither can drift into its own opinion
of what a schema permits.

Every position that names its fields is judged, whether it states
`type: "object"`, carries a `properties` map with no type beside it, states a
type union admitting an object, or reaches its map through a conjunction, whose
fields are the union across its members. A **disjunction** (`anyOf`, `oneOf`) is
passed over — a payload need satisfy only one branch — and so is a position
marked as a cell or a stream, which may hold a link rather than a value. A call
reaching either goes out rather than being refused on a guess.

The declared vocabulary is what `cf piece call --cell ID <verb> --help` prints,
which is the list to check when a field comes back refused. It names the fields
the verb's handler READS, which can be fewer than its TypeScript event type
declares: a field the body never touches is one the runtime would have dropped,
and the refusal says so rather than accepting it and losing it.

A verb that publishes **no event schema at all**, or one whose schema carries no
`properties` key, takes any payload: with nothing declared, nothing is dropped
either. That is not the same as a schema whose `properties` is empty — that one
declares that there are no fields, so the runtime delivers none and every field
a caller sends is refused.

### Transforming command output

Reading is one operation reached from four starting points, and every one of
them takes the same three flags — `--filter`, `--select` and `--schema` — with
the same grammar, the same conflict rule and the same error messages. The
vocabulary is learned once and written wherever you arrived from.

`cf cell get` filters an array before it reaches stdout and projects the result
to a smaller shape:

```bash
cf cell get --cell ID items --filter '.status == "open"'
cf cell get --cell ID items \
  --filter '.status == "open" and .score >= 10' \
  --select id,title,author.name
```

A path read first resolves the piece's canonical result and metadata, then pulls
the selected path. It does not first synchronize the producer's entire result
schema. Reading the root still requests the whole result. `--step` also starts
the piece and waits for asynchronous work, including session-scoped store
queries and their reactive updates, to settle before reading. Its execution can
demand inputs beyond the selected output. Missing-path diagnostics can require a
broader root read.

`cf piece call` writes them **past the `--` that closes the callable's
section**. The callable name opens that section, so everything between the two
belongs to the verb, and a projection reaches the read step by stepping past the
marker:

```bash
cf piece call --cell ID addTopic '{"title":"Ship it"}' -- --select topic.title
cf piece call --cell ID listTopics -- --filter '.status == "open"'
```

`wish` writes them beside the target it resolves:

```bash
cf wish '#profile' -i ./claude.key --select name,avatar
cf wish '#mentionable' -i ./claude.key -s my-space --filter '.status == "open"'
```

`exec` writes them the same way, past the marker that closes the section the
mounted file opened:

```bash
cf exec /tmp/cf/…/result/search.tool --query milk -- --select id,title
cf exec /tmp/cf/…/result/add.handler --title Milk -- --select 'entry@'
```

That is one rule rather than two. The read options come after the thing they
shape on every command that has them, and the marker appears exactly where
something else owns flags in between:

```text
cf cell get  <addr> [path]           --select …
cf wish <target>                --select …
cf piece call <target> <verb> <input> -- --select …
cf exec <mountedFile> <input>   -- --select …
```

A projection written before the verb is refused rather than accepted quietly —
it would name positions in a result nothing has identified yet — and so is one
written inside the callable's section, where the verb's own fields are read.
Each refusal names the section the flag belongs to and prints the line that
works.

A mounted callable run through its own shebang — `./search.tool --query milk` —
cannot carry them, because the shim appends its arguments after the file. Reach
for the `cf exec` spelling when you want to shape what comes back.

Everything below describes all four. What differs is only what the selection is
about:

| Command         | What the selection shapes                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `cf cell get`   | the value at the cell its address and path name                                                          |
| `cf piece call` | the **result of the call** — a handler's `result` inside the Invocation JSON, or a tool's JSON on stdout |
| `wish`          | the cell the query resolved to, before the walk that strips handles                                      |
| `exec`          | the same result `cf piece call` shapes, for the verb the mounted file names                              |

See [what a selection means for a call](#what-a-selection-means-for-a-call) for
the cases where the call's difference shows. `exec` is the same invocation
reached through a mount, so it meets the value-less verb and the readiness
coupling described there; it has neither `--no-wait` nor `--show-links`, so the
two cases about those flags do not arise. `wish` adds one of its own: a query
that matched nothing is an ordinary outcome rather than an error, so the
selection is never reached and the empty result comes back as it always did. A
selection that keeps nothing over a target that DID resolve is refused, because
"the wish matched nothing" and "your projection kept nothing" are different
facts.

`--filter` is jq-inspired rather than a full jq interpreter. It applies only to
arrays and accepts value paths (`.status`, `.author.name`, `.["display-name"]`,
`.tags[-1]`), JSON literals, `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`,
`not`, and parentheses. Like jq, only `false` and `null` are falsey, so a
missing path simply does not match. A stored `undefined` is treated like a
missing value and is also falsey. Filtering happens before schema projection.

Two flags project, one per input language:

- `--select` takes a comma-separated field list such as `id,title,author.name`,
  in which a segment ending in `@` asks for an address rather than contents;
- `--schema` takes an inline JSON Schema object or `@path/to/schema.json`, and
  also accepts the same field list `--select` takes.

A command that names both has not said which shape it wants, and is refused
before the read or the call.

For an array result, the field list describes each item. An inline/file JSON
Schema describes the complete returned value, so a schema combined with
`--filter` must have an array root. Object `properties` are an allowlist by
default; use `"additionalProperties": true` to retain unspecified properties.
Projection schemas support structural `properties`, `items`, and scalar leaf
schemas. A position that names an object keyword (`properties`,
`additionalProperties`, `required`) projects an object and one that names
`items` projects an array, at every level of nesting and whether or not it also
states `type` — `{"properties":{"topic":{"properties":{"title":true}}}}` returns
`topic.title`. Neither `true` nor `{}` names a container, and both keep
everything at the position they sit at. A scalar leaf whose declared type does
not match the stored value is omitted by the runtime rather than reported as an
error, at any position; prefer `true` leaves unless that type filtering is
intentional. Schema combinators and references are rejected in caller-supplied
projection schemas. Concise dotted paths follow the declared source schema
through nested arrays, so `comments.body` selects `body` from every comment
without retaining comment siblings. The projection preserves source-declared
nullable items and properties, including `type` arrays and `anyOf` unions. When
the source schema does not identify a nested container, the concise form applies
the same field mask across arrays encountered in the value so siblings still
cannot leak; use an explicit JSON Schema when the output schema itself must be
fixed. If a present source value cannot materialize the transform, the command
exits nonzero and states that the failure is not JSON `null`. An absent optional
source remains the ordinary successful `null` CLI response, as does a valid
projected null.

**A field list names positions of the source, so the source's schema decides
whether a name can be there at all.** A position states its vocabulary by
carrying a `properties` map, so one declaring no fields (`properties: {}`)
refuses every name while a position with no map declares nothing and refuses
none. A path the schema proves nothing can appear at is refused before the read,
naming the position, the vocabulary that position declares, and — where the
vocabulary holds a name close enough — the one the path is a typo of. Three
shapes are proven: a field a position neither declares nor admits, a field named
below a scalar, and a field named below a verb, which dispatches rather than
holding a value. A field that is merely absent is a different fact and still
returns nothing at exit 0 — an optional field nobody has written, an interface
an item does not implement, a link that has not synced. The refusal therefore
fires only where the schema settles the question, and a position it does not
settle reads as it always did: an open `additionalProperties`, a
`patternProperties` map that names a pattern, a disjunction, an untyped
position, a position that only may hold an array (untyped beside an `items`, or
typed as both an array and an object), a tuple-shaped array, whose `prefixItems`
give its elements no one vocabulary, a reference site that declares fields of
its own, and a name several `allOf` members declare. A reference that does not
resolve is passed over as well, and what the caller then reads is the read's own
report of the reference rather than anything about the field. A JSON `--schema`
states a shape of its own rather than naming the source's fields and is not held
to the source's vocabulary, which is the spelling for reading a position the
source does not declare.

Both transforms run as a short-lived computed pattern in the caller's session.
When the declared source schema fixes the root container shape, the pattern
constructs its first storage read from the union of predicate-observed and
projected paths. Structurally declared properties, including local `$ref` item
schemas, are pruned to that union: predicate-only fields can decide membership
without appearing in the result, and omitted linked subgraphs are not hydrated.
A schemaless source first loads its stored root without following children; an
object or array establishes its projection shape directly. Root links and
instances need materialization, as do ambiguous schema unions, whose schema can
transform the stored value. Ambiguous source-schema compositions remain intact
and can retain a wider selector. The runtime's list filter/map builtins
therefore handle CFC exactly as authored pattern expressions do: predicate
observations label array membership, projection reads propagate labels, and
filtered elements retain their source links. Projection map/lift nodes construct
the requested shape from a source-schema-selected read rather than returning a
widening identity alias. Nested non-stream Cell handles are materialized before
the predicate/projection JavaScript runs; stream handles remain capabilities.
The source cell's schema remains authoritative for Common Fabric metadata. A
caller cannot introduce or override `ifc`, `asCell`, `scope`, or `default`
through `--schema`.

#### Which keywords a `--schema` projection may contain

**The reader constructs the schema it applies rather than forwarding the one a
caller typed**, keyword by keyword. Four things can happen to a keyword.

- **Honored** — `type`, `properties`, `items`, `additionalProperties`, `$link`.
  These drive the projection and are what the constructed schema is built from.
- **Consulted** — `required`, `minProperties`, `maxProperties`, `minItems`,
  `maxItems`, `uniqueItems`. Each names a container, so writing one at an
  untyped position says which container that position describes. The constraint
  itself goes no further: nothing a caller writes in one reaches the read.
  `{"required":["id"]}` therefore projects an object without requiring `id` of
  it, and `{"minItems":2}` projects an array without imposing a length.
- **Tolerated** — the annotation keywords, `title`, `description`, `examples`,
  `deprecated`, `tags`, `tier`, `$id`, `$schema`, `$comment`. Accepted, and a
  read through a projection carrying one returns what the same projection
  returns without it.
- **Refused** — everything else, by name and with the position it sat at, plus
  the keyword it is nearest to. A misspelled `properties` is refused rather than
  silently returning the whole object or nothing at all.

The `required` a projected read applies comes from the **source** schema rather
than from the caller, restricted to the projected properties whose narrowing
cannot reject the property itself: a property the caller narrows to a scalar
type the value does not match drops out, and so does an array whose `items` the
caller narrows the same way, because one rejected element rejects the array
holding it. A narrowed position is then simply omitted from what comes back
instead of emptying the read around it.

A property the caller projects as a container keeps its derived `required` only
where the source declares that container and nothing else. `{"type":"array"}`
qualifies; `{"type":["array","string"]}` does not, nor does an `anyOf` whose
branches disagree, nor an undeclared position, nor an `allOf` — each of those
can hold something a container projection rejects, and the whole point of
deriving the key this way is that a rejected position is omitted rather than
emptying the object holding it.

A source that spells its shape as `{"$ref": "#/$defs/Thing"}` is followed to
what it names, at the document root and at any depth below it, so a named
interface carries the same `required` an inline one does. A reference that does
not resolve, or one that closes a circle, proves nothing and derives nothing —
the conservative direction, since the cost of declining is a key that would have
survived and the cost of guessing is the whole read.

#### Asking for an address instead of contents

A projection marks a position to get that position's address rather than what is
behind it. A JSON `--schema` marks with `"$link": true`:

```bash
cf cell get --cell ID notes --schema '{"type":"array","items":{"$link":true}}'
```

```json
[{ "$link": "/of:fid1:…" }]
```

The address is one string in the fabric's reference syntax —
`//<space>/<piece>[#member][@qualifier…][/path]` or its space-relative form
`/<piece>[#member][@qualifier…][/path]` — which is exactly what `cf piece call`
and `cf cell get` take in the positional they read a target from, scheme
included, so an address emitted by one command composes into the next unchanged,
without being reassembled. A different or unknown reader space requires the
`//did:key:…/` prefix. Scope follows the piece as `@space`, `@user`, or
`@session` unless the supplied context already implies it, and the path follows
as ordinary segments. An address emitted without a reader context carries both
space and scope explicitly. No schema is inlined and no write-redirect flag
rides along.

**Every address this CLI publishes is that one string** — a `$link` marker's
value, a `--select` suffix's, a `--show-links` entry's, and the Invocation
JSON's `receipt`. A caller that reaches into an address for an `id`, a `space`,
or a `scope` reads the string whole instead, and passes it on whole. The failure
mode is quiet: these values usually arrive inside an `unknown` or a `JSONValue`,
so code that indexes them merges cleanly, type-checks, and then reads
`undefined` at runtime against a real fabric.

The address names the deepest stored link crossed on the way to the marked
position, plus the segments that remain below that link. Marking `title` under
each element of a `notes` array whose entries are links returns the note's own
id followed by `/title`, not the board's id followed by `/notes/0/title`: a link
is a durable identity, while a position in a containing document is a slot, and
reordering the collection above it leaves the same path naming a different
value. Where the stored link carries a path of its own, that path comes first
and the segments below it follow — a link to `{"path":["content"]}` marked at
`title` renders `/content/title`. Where nothing is linked on the way, the value
lives in the source document itself and the address is its position there.

The marker sits beside a projection when both are wanted —
`{"$link":true,"type":"object","properties":{"title":true}}` returns the address
and the title — and replaces the contents when it is alone. It is accepted
anywhere `properties` is, except under `additionalProperties`, whose membership
the stored value rather than the selection decides.

A field list marks with a trailing `@`, which is that same marker at the
position the segment names:

```bash
cf cell get --cell ID --select 'topic@,topic.title'
```

```json
{ "topic": { "$link": "/of:fid1:…", "title": "First note" } }
```

The two paths union into the one position, and `topic@.title` says the same
thing in one path. `@` is special only as the final character of a segment:
`user@home` names a field, and `\@` writes a literal `@` where a trailing one
would otherwise mark, so `a\@` names the field `a@`. Naming a position both
ways, `topic,topic@`, returns the address beside the whole contents.

A field list applies to each element wherever it crosses an array, and an
address is one of the things it applies. Where the marked position holds an
array the answer is one address per element, so `notes@` is the concise spelling
of `{"type":"array","items":{"$link":true}}`:

```bash
cf cell get --cell ID --select 'notes@'
```

```json
{ "notes": [{ "$link": "/of:fid1:…" }] }
```

Those element documents are what a caller cannot work out for themselves; the
array position's own address is only the source address plus the path they just
typed. Where the marked position holds anything else, `topic@` among them, the
address is that position's own. Marking below an array — `notes.title@` — is
element-wise for the same reason, and answers with each note's own id followed
by `/title`.

A marked position that holds a link to a single piece — `inbox.piece@` — is one
of those: the address printed is the position's own (`/of:…/inbox/piece`), not
the address of the piece the link points at. That address is what
`cf piece call` takes to reach the linked piece, since it follows the link
stored at the path it is given; see
[Calling the piece a path links to](#calling-the-piece-a-path-links-to).

A path that is only `@` names the position the read is already at, which no
field path reaches because it sits above every field:

```bash
cf cell get --cell ID topic --select '@,title'
```

```json
{ "$link": "/of:fid1:…", "title": "First note" }
```

It composes exactly as a suffix one level down does: `@` alone replaces the
contents with the address, `@` beside a field path returns both in the one
result, and a source that holds an array answers with one address per element. A
leading `@` followed by anything else is an `@file`, which `--schema` reads and
`--select` does not, so `--select '@fields.json'` is refused and pointed there.

A marked position is never fetched: it contributes a rejecting selector to the
same path union the projection builds, and the address is composed from links
already stored in the documents the read visited rather than by following one. A
marked collection therefore costs one document read rather than one per element.
Neither spelling can be combined with `--filter`: the elements a predicate keeps
no longer say which positions they came from, and an address names a position.

#### What a selection means for a call

A selection over a schemaless handler receipt starts by loading the receipt
without following its children. If it holds an object or array, the CLI selects
from that container directly. An address-only selection can therefore return a
stored child link without loading the child. The verb's declared result remains
available for cycle bounding; it does not replace the selection's source schema.

Root links, instances, scalars, and receipts read through an explicit schema are
materialized before selection. A root link can resolve to an absent value, so
its stored existence alone does not establish a result. Tool calls also
materialize their result before selection.

A shaped readback uses the same shared read step as `cf cell get`. Its
`Cell.pull()` calls drive transitive computation and linked-document loads
through the runtime scheduler and its manager-wide convergence pool, so work
already active in that runtime can still share the wait. Declared object keys
are then ordered locally from the projection before rendering, and the keys an
open projection retains beyond its declaration follow them in the value's own
order; that step starts no graph or storage work. When isolating the read
matters, shape the collect instead. Call plain (or `--no-wait`), then collect
from the receipt with `cf cell get --cell <receipt id> --select …`.

Selections also follow these rules:

- **A value-less verb still reports nothing.** Its receipt is the empty witness,
  and the Invocation JSON omits `result` to say so. A selection is about a
  value, so with none there the step never runs and `result` stays absent — it
  does not become `{}`, and it is not an error. A selection that keeps nothing
  from a result that _does_ exist is a different fact, and it is refused rather
  than reported as an absent result.
- **`--no-wait` refuses all three flags.** That mode exits once the commit is
  acknowledged — the handling's commit, or under server execution the event
  append the server then handles — and skips the receipt readback, so there is
  no result to shape. The refusal names the flags that need the readback,
  alongside `--show-links` for the same reason. What it still returns is the
  envelope's `receipt` — the address of the cell holding the outcome, known at
  commit — so the shaping flags apply to the `cf cell get` that collects it.
- **`--show-links` composes with a projection, not with `--filter`.** Links are
  collected after the selection, over exactly the value the caller is holding: a
  projection leaves every surviving path where it was, so each address still
  names the position it annotates, and a path the projection dropped simply gets
  no entry. A predicate does not — the elements it keeps land at positions that
  are no longer the ones they came from — so `--filter --show-links` is refused,
  the same refusal a `$link` marker meets for the same reason.

#### A result that points back at itself

A verb returning the piece it created hands back a value that can be reached
from inside itself, whenever that piece carries a back-reference — `parent`
beside `children`, the shape
[self-reference](../../docs/common/concepts/self-reference.md) documents. A
circle has no JSON rendering at all, so a readback that follows one has nothing
to write.

Where the caller named no shape, `cf` derives one from the verb's declared
result. The declaration is the boundary the author drew: the position where the
declared type re-enters itself is the position that closes the circle, so that
position renders its address and everything else reads as it always did.

```json
{
  "item": {
    "title": "Rotate signing key",
    "status": "open",
    "children": [],
    "parent": { "$link": "/of:fid1:…/parent" }
  }
}
```

A verb can also declare a result far narrower than the value behind it — a
compact row over the piece it hands back, which is how an author keeps a create
from expanding that piece's prose and every sibling it references. The circle a
readback of that piece closes is then at a position the declaration does not
name at all, and the declaration re-enters nowhere, so there is no address to
render anywhere in it. The bound for that one is the declared shape itself:
every object position the declaration closes is held to the fields it declares,
and the row comes back. A position the declaration leaves open — an index
signature beside its named members — still reads every key stored at it, because
those keys are declared too.

```json
{ "topic": { "title": "Rotate signing key", "createdAt": 1756400000000 } }
```

Three things follow:

- **It is the same `$link` a caller writes by hand.** The derived bound composes
  its addresses through the same walk the selection step above composes a
  written `$link` with, so `--schema` over the same position produces the same
  address.
- **A caller's own shape wins wherever it renders.** `--filter`, `--select` and
  `--schema` are applied to the receipt first, and a projection that narrows
  past the circle — `--select item.title` — is answered exactly as written, with
  nothing derived added to it. A projection that names the re-entering subtree
  whole — `--select item` — keeps the circle it selected and is bounded on the
  way out, but the bound is a cut into what was selected rather than a shape
  that replaces it: the closing position renders its address, and no position
  the caller did not name comes back beside it. A position they asked for the
  address of — `--select 'item@,item.parent'` — is still answered with that
  address, which was their whole answer there and is not a field of what sits
  behind it. `--select item.parent` names the closing position itself, and is
  answered with that one address alone.
- **Nothing else pays for it.** A result that renders is written out exactly as
  it was read, and the compiled pattern a declared result is matched through is
  loaded only where a readback cannot render. The bound itself is a cut into the
  value already in hand — no pattern graph and no transaction — leaving the
  address walk a written `$link` is composed through as the only work beside it.

Where nothing bounds the circle — the verb declares no result, the declaration
it made describes no less than the value does, or a `--filter` is in play — the
call reports the position the circle closes at, states that the handling
committed, and names the receipt to collect the outcome from. It exits nonzero:
the outcome could not be rendered. The write still landed, which is the property
the message leads with.

A `--filter` is the case with no bound to reach for rather than one that failed:
the predicate hands back the elements themselves, which no longer say which
positions they came from, and a bound is written in addresses, which name
positions — the refusal `--filter --show-links` earns above, for the same
reason. Narrowing past the circle with a projection beside the predicate —
`--filter '.status == "open"' --select title` — renders.

## Built Binary

`deno task build-binaries cf` compiles the CLI to `dist/cf` — fully
cwd-independent, with no Deno startup noise and roughly half the per-invocation
cost. (`--cli-only` is a legacy alias for the same thing.)

It exists for CI, which downloads it in `cli-integration-test` (on
`$GITHUB_PATH`) and `pattern-unit-test` (as `CF_BINARY`). A CI run never edits
the source the binary was built from, so it cannot go stale mid-run.

That does not hold for a working tree you are editing, and there is no
invalidation story to catch it — see "Why not `dist/cf`" under Installing `cf`
on PATH. Use `bin/cf` or `deno task cf` locally. If you do build it, rebuild
after every `git pull`: a stale binary rejects newer flags and can hit
wire-protocol skew against an updated server.

## Launcher Contract

`packages/cli/launcher.ts` is the stable Deno launcher for consumers that need
to run the Common Fabric CLI from another repo or from a sandbox. It keeps the
selected Labs checkout as the source of truth while making the child CLI process
use an explicit Deno config/import map.

The launcher itself intentionally uses only Deno built-ins so callers can invoke
it before the Labs import map is active.

Launcher options are parsed before the first non-launcher argument or `--`. Use
`--` when a `cf` argument has the same name as a launcher option:

```bash
deno task cf -- --config piece-config.json
```

Launcher `--config` is the child Deno config/import map used to start the CLI.
It is not a `cf` command or pattern config.

The child CLI working directory defaults to `INIT_CWD` when present, otherwise
the launcher's current directory. This preserves `deno task cf` behavior from a
caller directory. Direct sandbox or wrapper callers should pass `--cwd` when
they need to ignore a stale inherited `INIT_CWD`.

The child CLI process inherits the parent environment. The launcher only adds
`CF_CLI_NAME=cf`, so caller-provided `CF_API_URL`, `CF_IDENTITY`, experimental
flags, and CFC/sandbox-related environment variables continue to flow through.

From the Labs checkout:

```bash
deno task cf --help
deno task cf check packages/cli/fixtures/pattern.tsx --no-run
```

From a sibling consumer such as Pattern Factory:

```bash
deno run --allow-run --allow-env --allow-read ../labs/packages/cli/launcher.ts \
  -- check workspace/<run-id>/pattern/main.tsx --no-run
```

From a vendored consumer such as Loom:

```bash
deno run --allow-run --allow-env --allow-read vendor/labs/packages/cli/launcher.ts \
  --labs-root vendor/labs \
  --config deno.jsonc \
  -- check .ops/patterns/example.tsx --no-run
```

Use `--launcher-help` for launcher-specific help. Normal CLI flags such as
`--help` are passed through to `cf`.

## JSON command contract

An invocation that contains `--json` reserves stdout for JSON. Status text and
errors go to stderr. If a command does not support `--json`, it rejects the
option without printing command help to stdout. Static `--help` and `--json`
cannot be combined. Callable schema help is the exception because it is JSON:
use `cf exec <mounted-file> --help --json` or
`cf piece call ... <callable> --help --json`.

The supported output switches are:

- `cf space ... --json` serializes the clone manifest, verify result, or
  fingerprint. `cf space verify` and `cf space reset` exit nonzero when the
  clone does not match its baseline, so a rehearsal script can gate on them; the
  printed report, not usage help, is the output in that case. The procedure
  these commands serve is `docs/development/space-clone-rehearsal.md`.
- `cf inspect ... --json` serializes an inspector result. `inspect html` does
  not have a JSON representation, so `html` and `--json` are mutually exclusive.
  `inspect graph --dot` and `--json` are also mutually exclusive.
- `cf piece ls`, `piece search`, `piece inspect`, `piece survey`,
  `piece repair`, `piece view`, and `piece render` use `--json` as an output
  switch. `piece survey` reserves stdout for the plan it emits (or, under
  `--json`, the full survey result); its tally and findings go to stderr.
  `piece repair` reserves stdout the same way — the emitted plan, or under
  `--json` the full report in the canonical FabricValue encoding — with its
  verdict tally and dry-run diff going to stderr. `piece retarget` and
  `piece rollback` reserve stdout for their report in every mode — a line per
  row as each settles, one canonical document under `--json`, or nothing beside
  `--out` — and start the pieces they write, so the runtime's console goes to
  stderr whether or not `--json` is on the line. `piece restore` reserves stdout
  for its revision listing, or the whole outcome as JSON under `--json`.
  `piece render --watch --json` writes only JSON render records to stdout; watch
  status goes to stderr. Rendering a piece without a UI fails instead of
  returning an empty successful JSON stream.
- `cf cell get` and `cf wish` always return JSON. Their `--json` options are
  accepted, documented no-ops for callers that select JSON explicitly.
- `cf check --json` compiles without evaluating and prints one object with a
  `files` array. Each entry has the input `path` and the compiled module bodies
  in `output`.

`cf check --json`, `--show-transformed`, and `--pattern-json` are three mutually
exclusive stdout modes. The command buffers all three modes until every input
succeeds. A failure therefore leaves stdout empty instead of mixing successful
output with later errors.

For `cf exec`, `--json` belongs after the mounted callable path. For
`cf piece call`, it belongs after the callable name. In both commands, it
selects complete JSON input — and in both, that is the opposite side of the
callable from where the read options go, which shape what comes back rather than
what goes in:

```bash
cf exec /tmp/cf/home/pieces/notes/result/search.tool --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' |
  cf exec /tmp/cf/home/pieces/notes/result/search.tool --json

cf piece call ... search --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' | cf piece call ... search --json
```

Bare `--json` reads stdin. An inline value immediately after it is parsed as the
complete input. `cf piece call` also accepts a single positional JSON value.
Schema-derived piece-call flags are written in the section the callable name
opened, for example `cf piece call ... search --query milk`, and
`--json-file <path>` stands in the same place. These rules keep the options
before the callable name for `cf piece call` itself and the arguments after the
name for the invoked callable.

`--` belongs to the commands that have a callable section to close. On
`cf piece call` and `cf exec` it closes the section the callable name opened and
opens the read step's, so the only words that follow it are `--select`,
`--schema` and `--filter`; anything else there is refused with the line that
puts it back in the section. `--help` is the exception, and deliberately:
written past the marker it still reaches the callable and prints that verb's own
page, since a caller wanting this command's page writes it with no verb at all.

`cf cell get`, `cf cell set` and `cf wish` have no callable section, so a `--`
written on one of those is refused rather than read: the parser sets every word
after it aside, and the command would otherwise return a value the caller did
not ask for and exit zero. The refusal names the words that were set aside and
the line that works.

## Command visibility

A registered command appears in `cf --help` unless it is one of the two kinds
below. The direct `fuse-daemon` and `fuse-supervisor` entry points are visible
because packaged launchers use them. Shell completion drops commands whose
description opens with `Internal:`, because those are spawned by `cf fuse` and
never typed at a prompt.

### Superseded spellings

Each command sits under the noun it acts on. Where that moved a command, the
spelling it had is still accepted and still completes its own flags and
arguments, so a script written against it keeps working; it is hidden from
`cf --help` and never offered as a completion, and a run that reaches it says on
stderr what to write instead — its help page included, whether `--help` asked
for that page or a refusal printed it, since the page is otherwise a screen of
examples in the spelling that is going away. A line refused during argument
parsing never reaches the command, and carries the notice only where the refusal
prints a help page with it — the reads that reserve stdout for machine-readable
output print none, so `cf get --bogus` says nothing. **These spellings are not
guaranteed to work after 2026-09-11**, so migrate before then: a later change
removes them, and nothing holds them open past that date.

| Write this               | Instead of               |
| ------------------------ | ------------------------ |
| `cf cell get`            | `cf get`                 |
| `cf cell set`            | `cf set`                 |
| `cf cell get-label`      | `cf piece get-label`     |
| `cf cell set-label`      | `cf piece set-label`     |
| `cf piece call`          | `cf call`                |
| `cf space recreate-root` | `cf piece recreate-root` |
| `cf space set-home`      | `cf piece set-home`      |

This is a migration aid rather than a second surface: nothing here teaches the
right column as an alternative spelling to keep using. `--piece` is a different
case — a deprecated name for `--cell` that carries no end date and no notice.

## Evaluating patterns from another tool

`cf init` writes a TypeScript environment an external tool can evaluate patterns
in: the configuration and type declarations an editor, a scratch checkout, or a
generated workspace needs to resolve `commonfabric` the way this repository
does. It reaches no space — everything it does is to the current directory,
where it writes three things:

- `.cf-types/`, holding the declarations for `commonfabric`, `turndown`,
  `cf-env` and the JSX runtime, one `index.d.ts` each.
- `.cf-docs/`, holding a copy of the top-level pattern documentation.
- `tsconfig.json` — **written whole, over whatever was already there.**

The configuration is generated from the runtime's own compiler options and is
not merged with the file it replaces, so a directory that is already a
TypeScript project loses its `compilerOptions`, its `include`, and everything
else it had, without a prompt and without a backup. A second run replaces the
generated one in turn, discarding any edit made to it. Run it in a directory
that exists for patterns, or in a copy.

## Installing `cf` on PATH

Interactively, the CLI has always been invoked as `deno task cf`. Shell
completion is the first thing that needs a `cf` on PATH on a developer machine:
the function it installs calls `cf completion complete` by name on every Tab, so
**completion does nothing at all without one** — including for
`deno task cf <TAB>`, which the same function services. Because a failing
completion is swallowed by design (it must never paste text into the command
line), a missing `cf` shows up as "completion doesn't work", not as an error.
`cf completion bash|zsh` therefore warns on stderr when it cannot find itself on
PATH.

(CI does resolve `cf` by name — `integration/integration.sh` runs `command cf`
against a binary the workflow puts on `$GITHUB_PATH` — but it builds that PATH
itself, and local runs of those same scripts set `CF_CLI_INTEGRATION_USE_LOCAL`
to force the source CLI.)

`bin/cf` is the install, with `bin/cfsh` beside it for the interactive shell.
Both run from source, so neither goes stale against the checkout. One route,
once per machine, mise or not:

```bash
deno task install-cf              # --dry-run to see what it would do
```

It is a real file in a directory on PATH, so every shell sees it: a login shell,
an agent's non-interactive one, `make`, an editor's task runner. The repo's
`mise.toml` pins Deno and declares no PATH entry, since a per-directory entry
reaches only shells whose mise hook ran for that directory and needs
`mise trust` in every new worktree. Where `cf` is not on PATH at all,
`deno task cf` runs the same CLI and needs nothing.

`install-cf` copies `bin/cf` and `bin/cfsh` to a directory already on your PATH
— refusing to guess if there isn't one, since installing somewhere unreachable
would reproduce the silent failure this exists to prevent. A copy rather than a
link, because the lookup below travels with the script: no particular checkout
has to survive for the install to keep working. `cfsh` carries no lookup of its
own — it forwards to `cf sh` and finds `cf` by name — so the copy needs nothing
rewritten on the way through. Re-run it to upgrade. It never edits your shell
rc; it prints the completion line for you to add.

It copies **this** checkout's `bin/cf` — the one whose task you invoked, which
may carry changes not yet on `main` — while baking the **primary** checkout in
as the outside-a-checkout default, so removing the worktree you installed from
does not strand it.

### Which checkout runs

Several checkouts coexisting is normal — worktrees, and a vendored labs inside
another repo (a supported, tested layout: see `test/launcher.test.ts`). So the
copy above does **not** pin `cf` to the checkout you installed it from. It
selects, in order:

1. **`$CF_LABS_ROOT`**, when set — the explicit override for when your cwd
   cannot say what you mean, such as working on a pattern under `/tmp`. A value
   that is not a checkout is an error, not a quiet fall-through. It chooses
   which CLI runs; it does not change your working directory.
2. **The nearest checkout walking up from `$PWD`.** A directory is tested as a
   checkout before it is tested as a host vendoring one at `vendor/labs`, so
   standing inside `<host>/vendor/labs` selects that labs rather than
   re-deriving it from the host.
3. **A default fixed at install time**, then **the checkout the script itself
   lives in** — for when you are not standing in one at all. An installed copy
   carries the default (`install-cf` points it at the primary checkout, since
   worktrees are removed routinely); the in-repo file and any symlink to it fall
   through to their own checkout. Both are ignored unless they are still real
   checkouts, so a stale default cannot silently send you somewhere that no
   longer exists. With none of them usable, `cf` says so and exits 2 rather than
   guessing.

`cf which` answers "which one would run?" — it prints the CLI path on stdout and
the reason on stderr, and is handled by the wrapper rather than forwarded, since
asking the CLI which CLI would run begs the question:

```bash
$ cf which
/path/to/checkout                                  # stdout
cf: entry /path/to/checkout/packages/cli/mod.ts    # stderr
cf: selected by nearest checkout above the current directory

$ cf which 2>/dev/null    # just the checkout, for scripts
```

stdout is the checkout because that is the part that varies; the entry inside it
is always `packages/cli/mod.ts`, which _is_ the CLI (it ends in
`if (import.meta.main)` and nothing outside `packages/cli/` imports it as a
library).

Rule 2 is what lets one installed copy serve every checkout. The consequence
worth knowing: `cf` inside checkout B runs B's code even though you installed
the copy from A. That is the point, but it means a stack trace is the quickest
way to confirm which checkout answered.

### Why not `dist/cf`

The compiled binary is roughly twice as fast per invocation (~0.33s versus
~0.6s), which is tempting when every Tab press is a full CLI invocation. **Do
not put `dist` on your PATH anyway.** There is no invalidation story for it:
`tasks/build-binaries.ts` has no up-to-date check, nothing compares the binary
against its sources, and the whole mechanism is the "rebuild after every
`git pull`" instruction in the Built Binary section above. A stale `dist/cf`
rejects newer flags and can hit wire-protocol skew against an updated server —
see "FUSE mount wrapper mismatch" in `skills/cf/SKILL.md` for an instance of
this actually biting.

Nor is mtime a usable substitute: `revertWorkspace` restores `deno.jsonc` and
the compile-cache version module _after_ the binary is written, so `dist/cf` is
older than its own inputs the moment the build finishes.

CI is a different case and legitimately uses the binary — a workflow run never
mutates the source it was built from. `cli-integration-test` puts it on
`$GITHUB_PATH` and `pattern-unit-test` passes it as `CF_BINARY`. That reasoning
does not transfer to a working tree you are actively editing.

## Shell completion

`cf completion <shell>` prints a completion script for bash or zsh. It requires
`cf` on PATH — see "Installing `cf` on PATH" above.

```bash
# zsh — eager form, in ~/.zshrc after compinit. Required for the `deno` binding
# described below; the fpath form does not activate it until `cf` completes once.
source <(cf completion zsh)

# zsh — fpath form. Completes `cf` itself; add the two lines under
# "deno task cf" below if you also want `deno task cf` to complete.
cf completion zsh > "${fpath[1]}/_cf"
autoload -U compinit && compinit

# bash
cf completion bash > /usr/local/etc/bash_completion.d/cf
# or, for the current shell only:
source <(cf completion bash)
```

Completion covers the command tree — subcommands, flags, and enumerated values
such as `--log-level` — plus live values read from the fabric:

| Slot                                                         | Completes to                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `--cell`                                                     | the space's slugs, then its piece ids                         |
| `cf piece call <callable>`                                   | the piece's callables, annotated with the doc comment on each |
| `cf cell get`/`cf cell set <path>`                           | cell keys, one path segment at a time                         |
| `cf cell get --select`/`--schema`                            | field paths into the value, and their `@` form                |
| `piece set-slug <slug>`                                      | the space's slugs                                             |
| `piece link <source>/<target>`                               | `pieceId/path/to/field` endpoints                             |
| `--space`, a positional space                                | space DIDs of local memory-v2 stores                          |
| `inspect <entity>`, `inspect graph --root`                   | that space's entities, as `cf inspect entities` lists them    |
| `cf wish <target>`, `cf wish --scope`                        | the vocabulary `cf wish --help` enumerates                    |
| `--identity`, pattern arguments                              | `*.key` / `*.tsx` files, via the shell                        |
| `--datafile`, `--out`, `--output`, `space clone --from`      | any file, via the shell                                       |
| `--dir`, a source `--root`, `space clone --to`, a mountpoint | a directory, via the shell                                    |
| `--remote`                                                   | what `--api-url` takes, in the `--remote=<url>` spelling      |

A callable is annotated with what its author said it is for, falling back to its
kind where they wrote nothing. A wrapper or deprecated verb — the two
`cf piece verbs` holds back unless `--all` — is offered with its marks leading
that annotation, joined the way the listing joins them and both shown where a
verb carries both, since either is callable and a name that works should be
reachable.

A projection's grammar is its own and not the cell path's: a list splits on `,`
and a path on `.`, and a trailing `@` asks for a position's address rather than
its value. A path below an array names a field of each element, however many
array layers deep it sits, because that is what the projection does with one.

A bare `@` asks the read for its own address and is accepted wherever an element
of the list begins — with one exception `--schema` makes: an argument _starting_
with `@` is its `@file` form, so `--schema @` is an empty path while
`--schema revision,@` is the suffix. A field named `true` or `false` is offered
wherever it is not the whole argument: written alone it is a boolean JSON Schema
to `--schema` and refused by `--select`, and written as `revision,true` it is an
ordinary name to both. Completion restates none of that — it puts each
prospective candidate back through the flag's own parser and offers what comes
back as a field list, so the two sets cannot drift. `cf piece call`'s and
`cf exec`'s projections shape a verb's result rather than the piece's root, and
are not completed from it; `cf wish`'s resolution writes to the space, and a Tab
must not.

An option name can mean two things on two commands, so the ones that do are
completed per command rather than by name. `--root` is a source directory on the
commands that compile one and an entity on `cf inspect graph`; `--to` is a clone
directory on `cf space clone` and a sequence number on `cf inspect diff`;
`--from` and `--scope` divide the same way. Where the value is a sequence number
the slot offers nothing, which is the honest answer for a word no set can name —
offering the wrong set is worse than offering none.

A positional divides the same way. Every `cf inspect` subcommand that opens a
local space completes it from local stores, but `inspect pull` names a space on
the remote and resolves it through the remote's own listing, so it offers
nothing rather than a local DID the command would reject — listing the remote is
a network round trip a keystroke must not start. The entity beside a space comes
from the view that subcommand will read: its `--branch` and `--scope`, except on
`inspect overlay`, which takes no `--scope` and reports every scope, so its
candidates span every scope too.

`--remote` says the same thing about every `inspect` slot at once. It is a
global option there and it decides where the space comes from: the token is
resolved through the remote's own listing and the snapshot it names is fetched,
so a local DID, a local entity and a local `graph --root` are each a candidate
that read rejects. Every one of those slots answers nothing while it is on the
line, in either of its spellings — `--remote=<url>` or bare.

An option's value completes the same whether it is written after a space or
after `=`, and every spelling of a target reaches the same slots behind it: the
bare id, the slug, the reference (space-qualified or not, with an embedded
path), and a reference written positionally in place of the flag — each of them
carrying the `#argument` member and `@scope` qualifier.

Past a `stopEarly()` boundary — after `cf piece call`'s callable name, after
`cf exec`'s mounted file — nothing is offered. The CLI's own flags are refused
there, so offering them would name something the command rejects; the words that
do belong there are the callable's, and completing those is not yet built.

Live values need an identity and an api-url. Both are read from the line being
typed (`-i`, `-a`, `-u`) before falling back to `CF_IDENTITY`/`CF_API_URL`, so
`cf piece call -s other-space --cell <TAB>` lists that space's pieces rather
than the environment's. A space DID embedded in a reference supplies one the
line did not name. When nothing is resolvable, or the server is unreachable,
completion yields nothing — it never prints an error into the command line. Each
request costs one CLI invocation plus one round trip, so value completion is as
fast as the fabric it queries.

A path-shaped slot — a cell path, a link endpoint, a projection path — completes
one segment at a time and holds the cursor for the next separator. bash gets
that by having the binding registered `complete -o nospace`, with a candidate
that should end the word carrying its own space: `compopt` is the per-completion
switch and it is bash 4 and later, while macOS ships bash 3.2, so the space is
inverted rather than suppressed. zsh does it natively.

The inversion is registered on the `cf` binding alone. A `deno` line can be
handed back to whatever completed `deno` beforehand, and that completion's own
spacing has to survive the handoff, so the `deno` binding keeps bash's default
and `deno task cf` pays a keystroke per path segment where `cf` does not. On
bash 4 and later `compopt` reaches that binding too and the cost disappears;
under bash 3.2 there is no per-completion switch to reach it with, and taking
the space away from every `deno test` and `deno run` completion is the larger
loss.

A candidate that opens with `#` — every `cf wish` target but the root — is
inserted backslash-escaped in bash, as `\#profile`. Written bare it would be a
comment, and the target would never reach the command; the escape is one word to
the shell and the bare target to the CLI, and completing it again reads back the
same target. zsh quotes what it inserts, so it arrives escaped there without the
script doing anything.

### `deno task cf` and other invocations

The scripts bind `deno` as well as `cf`, so `deno task cf piece <TAB>` completes
the same way the binary does; `deno run … packages/cli/mod.ts` and the
`launcher.ts` form (including arguments after `--`) are recognized too. The
binding is cooperative: a `deno` line that is not a CLI invocation is handed
back to whatever completed `deno` beforehand, so `deno test` and
`deno task build-binaries` keep their own completions. Pass `--no-deno-task` to
bind only `cf`.

The binding is installed by the script body, so it needs the script to be
_evaluated_, not merely autoloadable. bash's `bash_completion.d` and zsh's
`source <(…)` both do that. zsh's fpath form does not: `_cf` is autoloaded on
the first `cf` completion, so until then `deno task cf <TAB>` does nothing. To
keep the fpath install and still bind `deno`, add this after `compinit`:

```zsh
_cf_deno_previous="${_comps[deno]:-}"   # preserve deno's own completion
compdef _cf deno
```

Capturing eagerly matters: `_cf` records the previous completer when it loads,
and by then `_comps[deno]` is already `_cf`. It refuses to chain to itself
(which would recurse and hang the terminal) and keeps any value recorded
earlier, so the line above survives.

### Implementation

Cliffy ships a `CompletionsCommand`, but its dynamic hook passes the callback
only `(command, parent)` — no cursor word and no access to the options already
typed — so it cannot answer "the callables of the piece named by the `--cell` on
this line". `lib/completion/` therefore emits its own scripts, which are
deliberately thin: they forward the raw command line and let
`cf completion complete` decide everything. A sourced completion function lives
in a user's shell profile and is not updated when the CLI is rebuilt, so it must
not encode a command tree that can go stale.

Resolution walks Cliffy's live `Command` tree rather than a hand-maintained
table, so a newly registered subcommand or flag completes as soon as it exists.
Two facts cannot be read off that tree and are carried explicitly in
`lib/completion/`: the pre-parse globals `--log-level` and `--no-color` (both
stripped from `argv` before Cliffy parses, in `lib/log-level.ts` and
`lib/color-mode.ts`), and the provider table binding slots to live data.

`deno task check-completion-slots` is what keeps the provider table from falling
behind that tree. It walks the same commands and names every value-taking option
and every positional with no provider, no enumerated set, and no recorded reason
for having none — and the same subtraction the other way, so a provider entry
matching no slot fails too. It asks per command rather than per option name,
since a provider scoped to one command answers nothing on the others declaring
the same flag. It cannot decide that a slot should complete; it requires that
somebody decided.

The tests divide the same way. `test/completion-*.test.ts` cover everything
answerable without a fabric — line resolution, candidate shaping, and the
degrade-to-empty path. Every provider that reads state — a fabric, the local
memory-v2 stores, or the environment — is exercised by
`integration/completion-over-the-cli.sh` at one of the slots it answers: it
deploys a fixture and asserts what a Tab offers at each slot of the chain. Two
slots sharing a provider are covered by that one step, since `piece survey`'s
and `piece repair`'s `--list` take exactly what `--cell` takes. Which slots a
provider is keyed to is the other question, and
`deno task check-completion-slots` is what asks it, per command.

The remaining table entries hand the shell a constant `files` or `dirs`
directive, which a fabric cannot change: those are asserted one by one, kind and
glob, in `test/completion-providers.test.ts`. The set that has to be asserted is
derived there rather than remembered — every slot the tree declares is probed
with no fabric configured, and one that hands the shell a directive no case pins
fails the test. A case pins one command where the provider says it answers per
command, and every command at once where it does not — the same distinction the
slot gate draws, and a provider held to it by a test of its own.

That split is not tidiness: a provider that reaches a fabric and comes back with
the wrong set is invisible to a unit test and invisible at the prompt, because
failure here is silent by design. The script also carries `gap` assertions for
slots that answer nothing today, so one starting to answer fails loudly rather
than passing quietly.

## Space invitations

`cf space invite` uses generic invitation service version 1. All commands take
`--api-url`, `--identity`, and an explicit space DID through `--space`, or the
corresponding `CF_API_URL`, `CF_IDENTITY`, and `CF_SPACE` variables. They return
JSON and require no existing memory session to redeem.

- `cf space invite create --access READ --ttl 3600 --max-uses 2` creates an
  invitation. Access is READ or WRITE, TTL is 1–2,592,000 seconds, and max uses
  is 1–1,000 (default 1). Output includes the bearer code; `--shell <origin>`
  also produces a join URL whose code is in the fragment.
- `cf space invite redeem <invite-id> --code-file <path>` reads the code from a
  file; `--code-file -` reads stdin. The signing identity receives the grant.
- `cf space invite list` lists active metadata without codes or verifiers.
- `cf space invite revoke <invite-id>` ends admission without removing grants.
- `cf space invite receipts [invite-id]` lists unique invitation/DID pairs.

Creation saves its credentials before sending HTTP. With
`--request-file <path>`, the command requires a private parent directory (0700)
and exclusively creates a private file (0600), or loads an existing private
regular file. Existing files are never overwritten; symlinks, malformed data,
and mismatched host, space, signing identity, access, TTL, or max uses are
refused before sending. Retry with the same creation flags and `--request-file`
to reuse the exact invitation after a lost response or CLI restart. `--shell`
only changes the output link and may differ on a retry. Retained requests are
read through one verified open file descriptor. The CLI refuses reuse when it
cannot verify the opened file's identity.

Without `--request-file`, each creation saves a new file under
`$XDG_STATE_HOME/commonfabric/space-invites`, defaulting to
`$HOME/.local/state/commonfabric/space-invites`; the directory is private
(0700). The absolute recovery path is printed to stderr before sending and
returned as `requestFile` in successful JSON output. The file contains the
bearer code and remains local until the caller removes it. Keep it private and
retain it while a creation outcome is uncertain. Saving and syncing the file
precedes HTTP; this supports process restart recovery, without promising
recovery from filesystem or power failure. Errors never print the file contents.

Only explicit owners can create, list, revoke, or list receipts. One distinct
DID uses one slot in each invitation; a same-DID retry uses none. Copying the
same identity to another client preserves its DID. A receipt with null current
access means access was removed; retrying cannot restore it. See
[the service contract](../toolshed/README.md#space-invitations) for the SDK,
proof, deployment, and storage rules.
