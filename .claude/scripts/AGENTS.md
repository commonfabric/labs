# Claude Code hook scripts

`.claude/settings.json` lists which of these scripts run, and on which tool
call. A hook that refuses a call exits with status 2 and prints the reason. A
hook that only reports writes JSON to standard output and exits with status 0.

## What a hook may do

A hook matches a pattern in the tool call and answers. A hook must not predict
what a command will do. Predicting that means reimplementing a shell, and the
implementation will always be behind the real one. The three blocking hooks
removed in July all had that shape.

A hook that only reports must not write to the working tree. `git status`
rewrites the index whenever a tracked file is racily clean, and `deno check`
rewrites `deno.lock` when a checked file names a specifier the lock does not
hold. `--no-optional-locks` and `--no-lock` prevent those writes, so the hooks
that run those commands pass them.

Use `common/guard.ts` rather than writing the matching again.
`stripLiterals()` removes the heredocs and quoted strings from a command, so
that text the command carries as data is not read as a program to run. It
keeps the command substitutions inside a double-quoted string, which a shell
runs. `atCommandPosition()` matches where a shell takes the next word as the
name of a program to run.

## What checks them

`tasks/claude-hooks.test.ts` runs each hook over a set of commands and records
which it refuses. Refusing a correct command is the more expensive mistake,
because it stops work. Add the command to that test before changing a pattern.

`deno task check-skill-facts` reads the backticked citations in these files and
fails when one no longer resolves. Write a path in a message in backticks so
that the check covers it. The check builds its list of paths from `git
ls-files`, so a path the repository ignores rather than tracks is not in it:
name the tracked part of such a path and write the rest as prose.

`deno task check` type-checks every file here. A unit test of a hook's own
functions sits beside the hook, as `pattern-user-post-bash.test.ts` does, and
the `tasks` workspace member's test task runs it, since `.claude/` belongs to
no member.

`deno fmt` and `deno lint` both exclude `.claude/`, so neither reports anything
about a file here.

## What a message says

`docs/development/code-comment-style.md` governs the text of these messages, as
it governs error and log messages elsewhere. A refusal names the command to run
instead. The reader is an agent that will act on the message immediately, and a
message that only refuses leaves it to guess.
