---
name: weaver-patterns
description: Make and change patterns for someone's own Weaver from Claude Code, in plain words, including one pattern built on another. Use when someone asks to set up or make patterns for their Weaver, or works in a labs clone's my-patterns/ folder. Not for developing patterns in labs itself (pattern-dev, pattern-deploy, cf).
---

# Patterns for your Weaver

The person you are helping uses Weaver; they cloned `commonfabric/labs` only to
make patterns. Talk in their words (save, undo, share), never in flags, DIDs,
spaces or paths. Run every command yourself, ask before installing anything, and
when something fails, say what it means for them in one sentence and what you
are doing about it.

To write the pattern itself, use `pattern-dev`; this skill is the loop around
it. `cf <command> --help` is the truth for every command below; check it before
relying on a detail here.

## Where things live

- **`my-patterns/`** at the labs root, ignored by git, so pulling labs never
  touches it. One folder per pattern, `my-patterns/<name>/`.
- **Each pattern's piece is found by its slug**, `my-<name>`: the first save
  creates it with `--slug`, every later command names it with `--cell`. Never
  ask the person for a piece id.
- **A pattern lives in the space of the loom it is placed on**, where Weaver
  puts the patterns it makes there, so patterns on one loom can build on each
  other. That is their private **Making** loom unless they name another. A slug
  is found only in its own space.
- **`my-patterns/.claude/settings.json`** carries `CF_API_URL` and `CF_SPACE`
  (their Making loom's host and space), `CF_IDENTITY` and `CF_SERVICE_URL`
  (their Common Fabric service) as `env`, so a pattern on Making needs none of
  those flags, and lists labs' own `CLAUDE.md` and `.claude/rules/` in
  `claudeMdExcludes`, so a session here does not take on labs' developer
  instructions. Claude Code applies both only to a session started in
  `my-patterns/`, and only once the person trusts the folder. The values are a
  copy: the person's service is the authority, and setup refreshes them.
- **`my-patterns/<name>/loom.json`**, only for a pattern that lives anywhere
  else: `{"loom_id", "space", "host"}`. Every `cf` command for that pattern then
  passes `--space <space> --api-url <host>`.
- **`my-patterns/CLAUDE.md`** says what the folder is for.

Both files come from this skill's `templates/`.

## Their service

Everything below that asks the person's Common Fabric service something goes
through `cf fetch`, which signs as them: their service may run on a cloud host
that answers nothing unsigned. `<service>` below is its address, as their
Weaver's settings show it, or `http://localhost:<port>` when it runs on this Mac
(`loom status` names the port); after setup it is `CF_SERVICE_URL`. A command is
`echo '<json>' | cf fetch -X POST <service>/command/<id>`, the JSON being
`{"args": {…}}`, plus `"context": {"loom_id": "…"}` for one that acts on a loom.
Add `"actor": "user"` only where a step below says so: it claims the person is
acting, which only a command they asked for should carry. An answer looks like
`{"ok": true, "outputs": {…}}`; a refusal is `ok: false` with a `code` and a
`reason`, and `cf fetch` exits 1 with the status.

## Setup ("set me up")

Safe to run again whenever something is missing or a save does not show up; each
step checks before it changes anything. Until step 6 writes the settings, every
command names the service and the key itself: `<key>` is
`~/.config/commonfabric/identity.key`, passed as `-i <key>`.

1. **`cf` runs.** It needs Deno; then `deno task cf` works from anywhere in the
   clone, with nothing to install on PATH. `cf` below means that.
2. **Where their service is.** Ask for the address their Weaver's settings show,
   unless `CF_SERVICE_URL` already holds it.
3. **`cf` is the person.** `cf` must act as the same identity as their Weaver,
   or what it makes lands where Weaver cannot see it and the index counts them
   twice. Never make a key (`cf id new` makes a stranger). When `<key>` is
   missing, pair this Mac like any other device of theirs: ask them to open
   Weaver's Settings > Pair a device and copy the code it shows (not paste it
   here, which would keep it in the transcript), then run
   `pbpaste | cf id pair <service> <key>`. Tell them plainly that this Mac now
   holds their key as a file, which any program they run can read, and that
   removing the device in Weaver does not take it back. (A key of its own,
   delegated by their service and revocable, would avoid that; nothing issues
   one yet.) `cf id pair` never replaces a keyfile holding someone else.
4. **Where their pieces go.** `cf fetch -i <key> <service>/config`: its
   `identityDid` must equal `cf id did <key>`, or stop and say this Mac holds
   someone else's key. Then find their Making loom (**Which loom**, below) and
   run `loom.ensure-space` with `{}` and that loom's `loom_id` as context: its
   `space` and `host` are where their patterns go. If it is refused `no_space`,
   their service keeps patterns on its own Mac; use `/config`'s `homeSpace`
   instead. If neither answers, stop and say so; never guess a host or a space.
5. **The person is in the index**, as the same member their service is. If
   `cf index whoami -i <key>` says this machine has not joined, hand the
   service's membership to this Mac, in one line, so the chain never reaches the
   transcript and a refusal stops before the join:
   `chain=$(echo '{"actor":"user"}' | cf fetch -i <key> -X POST <service>/command/index.chain | plutil -extract outputs.chain raw -o - -) && printf '%s' "$chain" | cf index join -i <key> --chain -`.
   Run the same again whenever an index command says the chain lapsed or was
   refused: only the service renews it, and a chain lasts about three months. If
   the service answers `not-a-member`, it has not joined either: ask them to
   copy their invite link and run `pbpaste | cf index join -i <key>`.
6. **Settings remembered.** Write `my-patterns/CLAUDE.md` and
   `my-patterns/.claude/settings.json` from `templates/`, replacing every `<…>`
   placeholder with the value steps 2 to 4 found and the labs root's absolute
   path, and keeping any other settings already there.
7. **Hand over.** New pattern sessions start in `my-patterns/`, and the person
   accepts Claude Code's prompt to trust that folder.

## The loop

- **Which loom**: a pattern goes on their private **Making** loom, never the
  loom they have open, which may be shared, unless they name one. Run
  `loom.find` with `{"name": "Making"}`: use the loom titled exactly Making, the
  most recently used if there are several; if there is none, `loom.create` with
  `{"title": "Making"}`. For a loom they name, `loom.find` with its name, and
  ask which one when several match. Before the first save on any loom other than
  Making, run `loom.ensure-space` on it and write `<name>/loom.json`. Whenever
  it answers `shared: true`, say that putting a new pattern on a shared loom
  from here is not built yet, and offer Making.
- **save** keeps the person's Weaver up to date and nothing else. Check it
  compiles first (`cf check <entry>`). Which save it is depends on what exists,
  not on what this session remembers: if `cf piece inspect --cell my-<name>`
  finds the piece, every save is
  `cf piece setsrc --cell my-<name> --no-index-version <entry>`; only when it
  finds none is it the first,
  `cf piece new <entry> --slug my-<name>
  --no-index-version`. Never pass
  `--force` to take a slug: that strands the piece already on their Making loom.
  A pattern first saved before patterns lived in their loom's space is in
  `homeSpace`: when the inspect finds nothing, inspect there too (with `--space`
  and `--api-url`), and if it is there, write that space to `<name>/loom.json`
  and keep saving there rather than making a second piece. It cannot be built
  on, or build on another, until it is in the same space; say so when they ask,
  as moving it is not built yet. Without `--no-index-version` every save becomes
  a version in the index, which floods undo and can be shared on its own. When
  `setsrc` refuses because the new version does not fit the piece's data, offer
  a fresh piece or keeping the old version; nothing carries data over yet.
- **When a save fails with cf's version note** ("cf is newer than the server"),
  their service runs an older Common Fabric than this copy of labs. Say so in
  those words, check out the commit the note names (or the newest release tag at
  or before it) in this clone, and save again; do not set
  `CF_SKIP_VERSION_CHECK`.
- **Into their Weaver**, after the first save, and again whenever its loom does
  not hold the piece: `loom.add` with
  `{"ref": "pattern:<space>/<pieceId>", "focus": true}` and that loom's
  `loom_id` as context; `<space>` is the one the piece was saved into, and
  `cf piece inspect --cell my-<name>` names the `pieceId`. Adding a piece the
  loom already holds brings it forward rather than adding it twice. Later saves
  update it in place. Tell them which loom it is on, on any device their Weaver
  runs on.
- **build on** ("feed my digest from the triage pattern", "make this read what
  that one finds"): one pattern takes another's output as its input. Both must
  live in one space, so the new one goes on the loom the other is on; if the
  other is in a different space, say building across looms is not built yet.
  First give the new pattern an input type with only the fields it reads, not
  the other pattern's whole output, so a change to the rest cannot break it.
  Then:
  - **This one** (a particular pattern of theirs): save the new pattern, then
    `cf piece link my-<other>/<output field> my-<name>/<input field>`.
  - **Whichever one** (a pattern meant for other people, who each have their
    own): put a `#tag` in the doc comment on the other pattern's output type
    (`/** The emails a #triage pattern kept. */`), save it, and in the new
    pattern read it with `wish({ query: "#triage", scope: ["."] })`, which finds
    a tagged piece in the same space. When the wish finds nothing, say so rather
    than linking a piece instead.

  Never read again a source another pattern already reads (their mail, their
  calendar): build on that pattern. Never copy its data into the new one, write
  a piece id into source, or save its real output as a test fixture; a fixture
  is made-up data in the shape of the input type.
- **checkpoint** right after the save that finishes something they asked for:
  `cf pattern checkpoint --cell my-<name> <entry>`. It keeps a version, the
  point undo goes back to: one per request, never one per save. Like any
  version, their sharing setting may share it once it has been in use for a day
  with no newer version and passes the privacy check: findable, or on beta if
  they last shared this pattern on beta themselves.
- **undo**: `cf pattern history <entry>` lists the checkpoints;
  `cf pattern rollback <entry> <version>` writes one back, then save. It refuses
  when there are edits no version keeps; ask before forcing it, since forcing
  loses them.
- **share** ("it's good, share it"): `cf pattern share <entry>`, anonymous, on
  **beta**: once the privacy check passes, it is reachable by its link, and
  nobody finds it. The privacy check may rewrite the files into a general
  version; tell them what changed, then save, so their Weaver runs what was
  shared. `cf pattern unshare <entry>` stops sharing, though a version already
  shared stays readable by anyone who has it. Putting their name on it is
  `cf pattern publish <entry> --as "<profile name>"`, only when they ask for
  that and confirm the name it shows; it runs the same privacy check, so the
  same tell-then-save follows.
- **stable** ("it's stable", "release it"): `cf pattern stable <entry>` makes
  the newest shared version what search and the catalog show. Nothing new is
  exposed. To go back to an older shared version: rollback, save, share, then
  stable; numbers only move forward.
- **link** ("a link for Ana", a share link for another person; not **build
  on**): `cf pattern link <entry>` gives stable, or beta when nothing is stable
  yet; `--beta` when they ask for beta. It names the pattern, not them, unless
  they published it under their name. Someone with Claude Code opens a link as
  below (**open**, from a link); opening one in Weaver is not built yet, so say
  so.
- **open**: getting a pattern into a folder, with commands that already exist.
  `cf` reads paths from the folder the session started in, `my-patterns/`, so a
  pattern's folder is `<name>/`.
  - **One of theirs** they made here is already in `<name>/`. On another Mac,
    the same path is the same history: `cf pattern history <name>/main.tsx`
    lists its versions, and `cf pattern rollback <name>/main.tsx <version>` with
    the newest one writes the files into the empty folder. That needs the entry
    file's name, so keep it `main.tsx`.
  - **One in their Weaver with no history** (their Weaver's agent made it):
    `cf piece getsrc --cell <piece> <name>/` gets its source, and
    `cf piece set-slug my-<name> <piece>` gives the piece its slug, so every
    save after that is the usual `setsrc --cell my-<name>`, and keeps it as
    theirs.
  - **Someone else's, as a remix**:
    `cf piece new --from-index <patternId> --slug my-<name>` gives them their
    own piece of it, then `cf piece getsrc --cell my-<name> <name>/` writes the
    files. `cf` remembers where that piece came from, so sharing it later
    credits the original.
  - **From a link** someone sent (`a-k3x9`, `a-k3x9@beta`, `a-k3x9@3`): the
    same, with `cf piece new --from-link <link> --slug my-<name>`. It takes the
    version the link names now, and credits it the same way.
- **list**: `cf pattern history` (all of theirs) and `cf pattern mine` (what
  they share, and how many people use it).

When nothing here does what they ask, say it is not built yet rather than
improvising links, copies or Weaver deep links; the links **build on** makes are
the one exception. Not built yet, e.g.: bringing the Making loom forward in
Weaver by itself, opening a link in Weaver.
