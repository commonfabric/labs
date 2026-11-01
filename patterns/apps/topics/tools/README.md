# The Topics board from the command line

`topics.ts` is a command-line client for the team's Topics board, run from a
labs checkout as `deno task -q topics`. It searches, reads, and writes Topics
with one command each: `search`, `similar`, `show`, `sync`, `new`, `comment`,
`body`, `title`, `link`, `mention`, and `unmention`; `watch` shows the board
live for a person to watch. `deno task -q topics --help` lists them, and
`skills/topics/SKILL.md` is the guide to using it; this file is how it works. It
is team tooling for this pattern, not part of the product's `cf`.

## Reads come from a local copy

The copy is a file under `$XDG_CACHE_HOME` (or `~/.cache`), in
`commonfabric/topics/`, one per deployment, space, and board. It holds raw
documents of the board's space, each with the revision it was read at: the
board's input document, each Topic's input document, and the comment and link
documents those link. Every command first refreshes it. A refresh opens a memory
session of its own and watches every document the copy holds, declaring the
revision it holds each one at, so the server sends back only the documents whose
revision moved; documents a changed one newly links are fetched in a further
round. A refresh that finds nothing changed sends no document bodies, in one
watch for every few thousand documents held. The first, on a machine with no
copy, reads the whole board, and `sync --rebuild` does the same over an existing
one.

Topics are assembled from those documents by following links the way the runtime
resolves them: the board's `names` map links each Topic's piece, usually through
a document that only links onward to it, and a piece document links its input
document as `argument`. Where each entry leads is resolved once and kept.
Watching the documents in between would make the server send each piece document
whole on every refresh, and the board's namespace never moves a number to
another Topic. A write names the entry rather than the piece, so it reaches
whatever piece the entry leads to when it is made.

Nothing runs the Topics pattern, so a read computes nothing and commits nothing.
A board read through `cf cell get <board> index`, by contrast, runs the board in
the CLI's runtime and writes one commit per Topic on every read. `--offline`
reads the copy as it stands, without the refresh. A Topic whose input document
does not hold a title, comments, and links where the Topics pattern stores them
is named in a warning, since it reads as blank, and so is a board entry that
leads to no Topic the copy has read. `pattern-layout.test.ts` runs this
checkout's board and reads what its own verbs wrote through the copy, which is
what fails when the pattern changes where it stores a Topic.

## `similar` ranks Topics by the words they share with a text

`search` lists a Topic only when every term matches it, so it needs the right
few words. `similar` takes a whole text instead, such as an issue filed
elsewhere or the body of a Topic about to be filed, and lists the Topics most
like it, most similar first. `similar.ts` does the ranking on the machine, from
the Topics a read assembles, and the text is sent nowhere.

A Topic is compared by its title and body, which state its problem, and not by
its thread of updates; the title's words are counted twice, since it names the
problem in the fewest words. Words are runs of letters, their marks, and digits,
compared without case or Unicode compatibility differences. A word used `n`
times in a text weighs `1 + ln(n)` times `ln((T + 1) / (t + 1))`, where `T`
Topics are on the board and `t` of them use the word, so a word every Topic uses
weighs nothing. The similarity is the cosine of the angle between the text's
weights and the Topic's (TF-IDF), from 0 to 1, and Topics equally similar are
listed most recently active first. A Topic that states the same problem with the
same distinctive words ranks near the top even when the sentences differ. One
that uses none of the same words, or only other forms of them (`fails` against
`failure`), does not, since words are not reduced to their stems; nor is a name
such as `readTopics` split into its words. The listing names the shared words
that weigh most, so a reader can see why a Topic ranks where it does.

Each run ranks the whole board afresh. Matching many texts in a row is one
`sync` and then one `similar --offline` per text, which reads the copy without
asking the server anything.

## `watch` follows the board as it changes

`watch` takes over the whole terminal and shows each change to the board as it
happens: a card per new Topic, comment, edit, retraction, rename, rewritten
body, and link or reference added or taken back, newest at the top, its content
typing itself in, and beside it the Topics in order of their last activity, the
one that changed lit for a moment. Every Topic's number is a hyperlink that
opens the Topic in a browser, on the deployment the board is on. It opens on the
local copy as it stands, with the copy's recent history as dimmed cards, and
goes live once its session is open. `q` or Control-C quits, as does the terminal
hanging up or the process being signaled to end, and the terminal is given back
before the session closes. The session ending of its own accord, or the copy
failing to save, ends the view with the error.

`live.ts` keeps the copy current over one memory session. It watches every
document the copy holds or knows to be missing, and the server pushes each
change as it commits. The first watch declares the revisions the copy holds, as
many as one request may, so the server sends only what moved since the copy was
saved; documents past that limit are watched in further watches, which the
server answers with the documents whole. A pushed document no newer than the
copy's is ignored, and otherwise applied, and the board assembled again, which
reads whatever a changed document newly links as it stands and watches it from
then on, along with wherever an entry the board names stops leading anywhere. A
few hundred watches added that way are set again as one, so the watches stay few
however long the view runs. `events.ts` compares one assembly with the next to
name what happened, and `screen.ts` draws a frame from that, a row at a time, in
`cf view`'s palette, with any character a terminal would act on drawn as the
glyph that names it. `watch.ts` runs the terminal, the session, and the frames
an animation needs, drawing only when something changes or is still moving, and
writing only the rows that changed. The copy is saved after every change, so the
next command starts from it.

## Writes go through `cf`

A write runs the Topics verb through the checkout's own `cf piece call`, with
the payload on its standard input, then runs `cf piece step` on the Topic it
wrote to, then refreshes the copy and fails unless the write reads back; a
comment or a link reads back only when there is one more of it than before. The
step is there because a Topic stores the comment count and last activity the
board lists only when a run of it completes, and `cf piece call` returns before
that. Each `cf` is a process of its own, which starts a runtime, so a write
takes several seconds longer than a read.

Each run is a new invocation under an invocation session minted once per board,
into a file under `$XDG_STATE_HOME` (or `~/.local/state`) that only its owner
can read, so that it outlives a cleared cache. The invocation's id is printed
before the write dispatches. A failed call may have committed unless
`cf piece call` reports that it never dispatched, so any other failure repeats
the id: naming it with `--invocation <id>` settles on the first outcome rather
than writing a second time, and the report says so.

## Configuration

The board, its space, and the deployment default to the team's on Estuary;
`TOPICS_API_URL`, `TOPICS_SPACE`, and `TOPICS_BOARD` name another. The identity
is `--identity`, else `CF_IDENTITY`, else `~/.config/commonfabric/identity.key`;
a relative path is read from the directory the command was typed in, for reads
and writes alike. The agent name an authored write carries is `--agent-name`,
else `CF_AGENT_NAME`.
