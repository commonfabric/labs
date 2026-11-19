---
name: weaver-patterns
description: Make and change patterns for someone's own Weaver from Claude Code, in plain words. Use when someone asks to set up or make patterns for their Weaver, or works in a labs clone's my-patterns/ folder. Not for developing patterns in labs itself (pattern-dev, pattern-deploy, cf).
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
- **`my-patterns/.claude/settings.json`** carries `CF_API_URL`, `CF_SPACE` and
  `CF_IDENTITY` as `env`, so no command needs those flags, and lists labs' own
  `CLAUDE.md` and `.claude/rules/` in `claudeMdExcludes`, so a session here does
  not take on labs' developer instructions. Claude Code applies both only to a
  session started in `my-patterns/`, and only once the person trusts the folder.
  The values are a copy: the person's loom service is the authority, and setup
  refreshes them.
- **`my-patterns/CLAUDE.md`** says what the folder is for.

Both files come from this skill's `templates/`.

## Setup ("set me up")

Safe to run again whenever something is missing or a save does not show up; each
step checks before it changes anything.

1. **`cf` runs.** It needs Deno; then `deno task cf` works from anywhere in the
   clone, with nothing to install on PATH. `cf` below means that.
2. **`cf` is the person.** `cf` must deploy as the same identity as their
   Weaver, or what it makes lands where Weaver cannot see it and the index
   counts them twice. Never make a key (`cf id new` makes a stranger). Their
   loom service says who they are: its `GET /config` gives `identityDid`, and
   `homeSpace` gives the space and the host their panes mount it from
   (`loom status` names the service's port, e.g. 9900). The key is the file
   whose `cf id did <file>` equals `identityDid`, usually
   `~/.config/commonfabric/identity.key`. If no file matches, or `homeSpace` is
   missing, stop and say so; never guess a host or a space.
3. **The person is in the index.** If a `cf pattern` command says this machine
   has not joined, ask them to copy their invite link (not paste it here, which
   would keep it in the transcript) and run
   `pbpaste | deno task cf index join --identity <key>` with the key from
   step 2. A Mac whose loom already joined needs nothing.
4. **Settings remembered.** Write `my-patterns/CLAUDE.md` and
   `my-patterns/.claude/settings.json` from `templates/`, replacing every `<…>`
   placeholder with the value steps 2 and 3 found and the labs root's absolute
   path, and keeping any other settings already there.
5. **Hand over.** New pattern sessions start in `my-patterns/`, and the person
   accepts Claude Code's prompt to trust that folder.

## The loop

- **save** keeps the person's Weaver up to date and nothing else. Check it
  compiles first (`cf check <entry>`). First save:
  `cf piece new <entry> --slug my-<name> --no-index-version`; later saves:
  `cf piece setsrc --cell my-<name> --no-index-version <entry>`. Without
  `--no-index-version` every save becomes a version in the index, which floods
  undo and can be shared on its own. When `setsrc` refuses because the new
  version does not fit the piece's data, offer a fresh piece or keeping the old
  version; nothing carries data over yet.
- **Into their Weaver**, once, after the first save: their loom service places
  the piece on their private **Making** loom, never the loom they have open,
  which may be shared. `loom command run loom.find --name Making --json` finds
  it (`loom command run loom.create --title Making --json` makes it the first
  time), then
  `loom command run loom.add --loom <loom_id> --ref
  pattern:<space>/<pieceId> --focus`
  adds the piece (`cf piece new --json` gives the `pieceId`). Later saves update
  it in place. Tell them it is on their Making loom, on any device their Weaver
  runs on.
- **checkpoint** right after the save that finishes something they asked for:
  `cf pattern checkpoint --cell my-<name> <entry>`. It keeps a version, the
  point undo goes back to: one per request, never one per save. Like any
  version, their sharing setting may share it once it has been in use for a day
  with no newer version and passes the privacy check.
- **undo**: `cf pattern history <entry>` lists the checkpoints;
  `cf pattern rollback <entry> <version>` writes one back, then save. It refuses
  when there are edits no version keeps; ask before forcing it, since forcing
  loses them.
- **share**: `cf pattern share <entry>`, anonymous. The privacy check may
  rewrite the files into a general version; tell them what changed, then save,
  so their Weaver runs what was shared. `cf pattern unshare <entry>` stops
  sharing, though a version already shared stays readable by anyone who has it.
  Putting their name on it is
  `cf pattern publish <entry> --as "<profile name>"`, only when they ask for
  that and confirm the name it shows; it runs the same privacy check, so the
  same tell-then-save follows.
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
- **list**: `cf pattern history` (all of theirs) and `cf pattern mine` (what
  they share, and how many people use it).

When nothing here does what they ask, say it is not built yet rather than
improvising links, copies or Weaver deep links. Not built yet, e.g.: bringing
the Making loom forward in Weaver by itself, beta and stable channels, links.
