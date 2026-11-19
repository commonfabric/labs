---
name: weaver-patterns
description: Make and change patterns for someone's own Weaver from Claude Code, in plain words, with no git, flags or paths. Use when a person (not a labs developer) says "set me up to make patterns for my Weaver", asks to make, change, undo, share or list their patterns, or is working in a labs clone's my-patterns/ folder. Developers deploying patterns from their own checkout want the cf and pattern-deploy skills instead.
---

# Patterns for your Weaver

The person you are helping uses Weaver; they are not developing labs. They
cloned `commonfabric/labs` only to make patterns. Talk in their words (save,
undo, share, link), never in flags, DIDs, spaces or paths, and run every command
yourself. When something fails, say what it means for them in one sentence and
what you are doing about it.

To write the pattern itself, use the `pattern-dev` skill; this one is only the
loop around it.

## Where things live

- **`my-patterns/`** at the root of the labs clone. Git ignores it, so pulling
  labs never touches the person's work. One folder per pattern:
  `my-patterns/<name>/`.
- **`my-patterns/.claude/settings.json`** holds the person's settings as `env`
  (`CF_API_URL`, `CF_SPACE`, `CF_IDENTITY`), which Claude Code passes to every
  command, so `cf` needs no flags. It also lists the labs root `CLAUDE.md` in
  `claudeMdExcludes`, so a session here does not take on labs' developer
  instructions. Both only apply to a session started in `my-patterns/`; a
  session started at the labs root has neither.
- **`my-patterns/CLAUDE.md`** says what the folder is for.

Both files come from this skill's `templates/`.

## Setup ("set me up")

Run it again whenever something is missing; each step checks before it changes
anything, and says in a sentence what it did.

1. **`cf` works.** Deno, then `deno task install-cf` from the labs root. Ask
   before installing anything.
2. **`cf` is the person.** `cf` must deploy as the same identity as their
   Weaver, or what it makes lands where their Weaver cannot see it and the index
   counts them twice. Never make a new key (`cf id new` makes a stranger). Their
   loom service says who they are: `GET /config` on it (`http://127.0.0.1:9900`
   on a default install; `loom status` names the `local-loom` port) gives
   `identityDid`, and `homeSpace` gives the space and the host panes mount it
   from. The key file is the one whose `cf id did <file>` equals `identityDid`;
   `~/.config/commonfabric/identity.key` is where it usually is. If no file
   matches, or `homeSpace` is missing, stop and say so plainly; do not guess a
   host or space, since a piece deployed elsewhere never shows up in their
   panes.
3. **The person is in the index.** If a `cf pattern` command reports that this
   identity has not joined, ask for their invite link, have them paste it into
   the chat, and pipe it in (`cf index join` reads it from stdin, never from the
   command line). An identity that already joined through Weaver needs nothing.
4. **Settings remembered.** Write `my-patterns/CLAUDE.md` and
   `my-patterns/.claude/settings.json` from `templates/`, filling in the API URL
   and space from `homeSpace`, the key path, and the absolute path of the labs
   root `CLAUDE.md`. Keep any other settings already there.
5. **Hand over.** Tell them to start new pattern sessions in `my-patterns/`. In
   the Claude desktop app,
   `claude://code/new?folder=<absolute path of my-patterns>` opens one there.

## The loop

What exists today, in the person's words. Check `cf <command> --help` before
relying on a detail here; the CLI is the truth.

- **save**: first time, `cf piece new <entry>` into their space; after that,
  `cf piece setsrc` on the same piece. Never save something that does not
  compile; fix it first. `setsrc` can refuse when the new version does not fit
  the piece's data: ask whether to start fresh, keep the old version, or carry
  the data over.
- **checkpoint**: when a change they asked for is finished and working,
  `cf pattern checkpoint <entry>` keeps it as a private version, the point
  **undo** goes back to. One per thing they asked for, not one per save.
- **undo**: `cf pattern history <entry>` lists the versions;
  `cf pattern rollback <entry> <version>` restores one, then save again.
- **share**: `cf pattern share <entry>`. It runs the index's privacy check and
  may rewrite the pattern into a general version; tell them what changed and
  why.
- **list**: `cf pattern history` (everything of theirs the index keeps) and
  `cf pattern mine` (what they share, and how many people use it).

Not built yet, so say so rather than improvising: opening a pattern by name into
a folder, remixing someone else's, opening a save straight into Weaver, beta and
stable channels, and links.
