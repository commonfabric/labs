# The Topics board from the command line

`topics.ts` is a command-line client for the team's Topics board, run from a
labs checkout as `deno task -q topics`. It searches, reads, and writes Topics
with one command each: `search`, `similar`, `show`, `sync`, `new`, `comment`,
`body`, `title`, `link`, `unlink`, `mention`, and `unmention`; `watch` shows the
board live for a person to watch, and `browse` lets a person read and write it.
`deno task -q topics --help` lists them, and `skills/topics/SKILL.md` is the
guide to using it; this file is how it works. It is team tooling for this
pattern, not part of the product's `cf`.

## Reads come from a local copy

The copy is a file under `$XDG_CACHE_HOME` (or `~/.cache`), in
`commonfabric/topics/`, one per deployment, space, and board. It holds raw
documents of the board's space, each with the revision it was read at and the
Contextual Flow Control (CFC) label envelope it stores beside its value: the
board's input document, each Topic's input document, the comment and link
documents those link, and the content-addressed label documents an envelope
names by reference. Every command first refreshes it. A refresh opens a memory
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
document as `argument`. Where each entry leads is resolved once and kept, and
the documents that only link onward are kept and watched for their labels. A
piece's content is not kept, since the board's namespace never moves a number to
another Topic, but its revision is: the server sends a piece along with the
document that links to it, whole, unless the watch says it is held, and a piece
is tens of kilobytes. A write names the entry rather than the piece, so it
reaches whatever piece the entry leads to when it is made.

A Topic's title and body, each comment, and each link carry what CFC says of
them, when their document stores labels (`labels.ts`): who may learn any of a
part, what integrity vouches for all of it as it stands, and which principals
that integrity says wrote it. The runtime's own functions read the envelope,
resolve a label it holds by reference from its content-addressed document, which
the copy fetches when it lacks it and which has to hash to its address, and find
the part's label as a content read of the part resolves it, restricted further
by the slots it was reached through, as their documents stand now: the board's
entry for the Topic, a document that only links onward, and the link to a
comment held in a document of its own. Every field a view shows of a part is
labeled, its timestamps and a Topic's mentions included. What vouches for a part
is the integrity that holds of every field of it, read as the runtime's renderer
reads a label's integrity, and who wrote it is each principal an `authored-by`
attestation among that integrity names exactly, as the runtime reads one, so a
name on only some of a comment names no author. A part whose envelope or label
document cannot be read, or whose authorship is spelled otherwise than the
runtime writes it, is marked unreadable, which is not the same as unlabeled.

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
failing to save, ends the view with the error. What the process says on the
console or standard error while the view has the screen, such as the memory
client's warnings while its connection is down, is held rather than drawn over
the screen, and said once the screen is given back; the browser says the latest
in its status line.

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
glyph that names it. `showBoard` in `watch.ts` is the runner both full-screen
views share: it takes the terminal, opens the session, follows the board, and
draws the frames a view asks for, and `watch` is the simplest view it runs.
`prose.ts` lays out the Markdown a Topic holds with `cf view`'s own Markdown
renderer, so the two draw it alike, and reflows it to the width at hand: a
paragraph's lines are joined and wrapped, a list item's or a quote's further
rows hang at its indent, a code block's lines are cut rather than reflowed, a
table is laid out to the width as a web browser lays one out, each cell wrapped
in its column, and a link, or a Topic cited as `top/42`, is a terminal
hyperlink. `watch.ts` runs the terminal, the session, and the frames an
animation needs, drawing only when something changes or is still moving, and
writing only the rows that changed. The copy is saved after every change, so the
next command starts from it.

## `browse` lets a person read and write the board

`browse` is the board for a person, in the manner of Turbo Vision: a menu bar
along the top, a status line of keys along the bottom, and between them a window
listing the Topics beside a window reading one whole. Every part can be clicked,
scrolled with the wheel, or reached from the keyboard, and F1 lists the keys. A
click shows what it holds pressed, a button pushed down, and acts once released
over it; on a menu or a list the pointer moves its selection, and the keys with
it. A dialog's button is pressed by its highlighted letter, as in `cf view`:
alone where no field has the keys, and with Alt anywhere. While a button has the
focus, Left and Right move it along the dialog's buttons. Where a Mac terminal
leaves Option as Option, as Terminal and iTerm2 do unless told otherwise, what
Option types with a key that has an Alt binding counts as Alt, except while
typing into a field or a search begun in the list.
`deno task -q topics browse top/42` opens a Topic, which can be named in any of
the ways the other commands take one.

The list narrows as a search is typed into it (`query.ts`). A plain word matches
as a `search` term does; `by:` keeps the Topics someone wrote on, `in:` limits
where words match, `is:unread`, `is:open`, and `is:settled` keep what their
names say, and a number puts that Topic first. Settled Topics, those whose
titles begin with a mark such as `[RESOLVED]`, are left out until asked for. The
authors window lists everyone who has written, or their families, `Egory` for
every `Egory <worktree>`, and picking one lists what they wrote, as clicking a
name anywhere does.

The reader shows a Topic's title, who filed it, its body, its links, the Topics
it mentions or cites and those that mention or cite it, one referred to both
ways listed once, the Topics most like it by the ranking `similar` uses, and its
thread. Links are terminal hyperlinks; a Topic of the board opens in the reader,
with Alt-← and Alt-→ to go back and forth, and any other link opens in the web
browser. Alt-↓ and Alt-↑, or `]` and `[` in the reader, open the next and
previous Topic as the list orders them, and Home and End go to the top and
bottom of the list, the reader, or a dialog, except that in a search begun they
move in the search, where Control-Home and Control-End go to the list's ends.
What CFC says of a part is marked: ◈ where confidentiality limits who may learn
it, ✓ with the principal where integrity says who wrote it, set apart from the
name in the byline, which is what its writer typed, and ◇ where nothing vouches
for that name. The browser, like `watch` and the output of `show`, `search`, and
`similar`, is a display that no authored policy covers, so a part is shown only
when its label fits the default display ceiling for the identity viewing, as the
runtime's own display fit decides. Anything else, and anything whose labels
cannot be read, is withheld: it is blanked as the board comes in, so that
nothing the view draws, searches, or edits holds it, and a view puts a
placeholder saying why in its place, where the commands leave it blank.

The view follows the board as `watch` does. A Topic that changes lights up, and
the one being read is drawn again as it stands. A Topic's activity is the
`lastActivityAt` stored on it, which, as the Topics README says, is reliable
once every writer runs the current Topic module. Which Topics have activity the
person has not read, which **View ▸ Mark all read** clears, is remembered
between runs, along with drafts, writes not yet known to have landed, and the
name writes are signed with, in a file under `$XDG_STATE_HOME` (or
`~/.local/state`) beside the invocation session (`browse.ts`), readable only by
its owner. Each change to a draft or a pending write stamps it later than any
version before it, and one thrown away is remembered by the stamp of the version
thrown away. Each save takes a lock beside the file and merges what another
browser saved there meanwhile, keeping the newer of each draft and pending
write, ours where they tie, leaving out any version thrown away, and writing
back as it was whatever a newer build saved there that this one does not read.
The browser follows the file and takes in what another browser saves, so a draft
that one posted is not offered here, and an editor open on it closes, or takes
in the newer text another saved. A Topic counts as read once the reader shows
it.

What a person writes is a draft until it is saved: closing its editor keeps it,
a change the board makes meanwhile leaves it as it is, and quitting keeps it for
the next run. An editor shows the Markdown as it will read beside it, and says
when the body or title it edits has changed on the board since the edit began,
showing the board's version and asking before saving over it.

Saving a draft takes it out of the drafts and keeps it as a pending write, under
the invocation minted with that version of the draft, until the write is known
to have landed, so that two browsers saving the same version write it once;
meanwhile the editor for it will not open, so nothing is posted twice. A write
runs the same command the client runs from the command line, one at a time
(`writes.ts`), and each attempt is counted, and saved, before it is made; one
that cannot be saved first is not made. A write that landed is forgotten, and so
is one that landed and reads back otherwise than it was made
(`UnconfirmedWrite`), which is reported as an error. A first attempt that
certainly failed, before it was dispatched, gives its text back as a draft. A
write that may have landed (`UnsettledWrite`: its answer was lost or the Topic
did not run), and a later attempt that failed, since an earlier one may have
landed, are kept, with what went wrong, for **File ▸ Unfinished writes** to
settle by naming the invocation again, which never writes twice; writes left
unfinished are offered for settling when the browser next goes live. Quitting
waits for the writes under way, saying so, and names any that may not have
finished; asking to quit again stops waiting.

`browser.ts` holds the state, answers keys and clicks, and draws a frame onto a
grid of cells (`canvas.ts`), each cell knowing what clicking it does, from the
parts in `widgets.ts`: menus, framed windows with scroll bars, dialogs with
shadows, and buttons. Text fields edit with `cf view`'s edit buffer
(`field.ts`), and keys, the mouse, and pastes are read by `cf view`'s decoder.

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
