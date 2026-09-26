<!-- @reviewed 2026-07-14 -->

# Skill Fact Audit

A skill's map — canonical homes, exact symbols, file paths — is its
highest-value and highest-rot content (see
[`skill-authoring.md`](./skill-authoring.md), "facts rot — make them testable").
Two mechanisms keep it honest, and they are complementary, not alternatives:

- **Tripwire (deterministic floor).** `deno task check-skill-facts`
  (`tasks/check-skill-facts.ts`) — a cheap, instant, zero-token CI gate over
  every markdown file under `skills/`, every `AGENTS.md`, every rule under
  `.claude/rules/`, and every hook script under `.claude/scripts/`, which fails
  if an import specifier or repo path one of them cites stops _resolving_: a
  bare import of a package with no root export, a missing subpath, or a
  vanished path. Runs in CI as the `check-skill-facts` gate of the `repo-gates`
  suite. Catches resolvability rot only, and deliberately hardcodes no fact list
  — every fact it checks is derived from the text itself, so a document gains
  coverage by being written, not by being registered anywhere.
- **Audit (LLM ceiling).** A periodic / on-change pass that reads a skill against
  the current tree and judges the _semantic_ rot the tripwire cannot see: a
  canonical home that moved or was renamed, advice that is now wrong, a new home
  the skill should mention, framing that has drifted from how the system actually
  works. This half **appreciates** as models improve — at the limit it is the
  more useful of the two.

The auditor is **cf-review itself** — do not build a parallel reviewer. cf-review
already verifies a skill's facts against the tree (it did so unprompted when it
reviewed its own PR). The audit is just cf-review pointed at a skill.

## The same pair covers the guides and the rules

The `AGENTS.md` guides and the path-scoped rules under `.claude/rules/` are the
same kind of document as a skill: a summary handed to an agent, whose value
comes from naming a path or a symbol rather than restating what is there. The
tripwire already scans all three. Point the audit at them on the same terms —
what a rule says about a gate is as capable of quietly becoming untrue as what
a skill says about a canonical home, and neither shows up as a broken citation.

A rule has one defense a skill does not: it should be short enough to re-read
in full while you are changing the thing it describes. A rule that has grown
past that is drifting whether or not anyone has noticed yet.

## What the tripwire treats as a citation

Skills use backticks for far more than paths, so the tripwire only checks a
backticked token when it is shaped like a path and is rooted at a directory that
really exists — either at the repo root or inside the citing skill's own
directory. Both rootings are in use: `skills/cf` names
`scripts/check-local-dev.sh` at the repo root, while `skills/agent-browser` names
`scripts/form-automation.sh`, which lives in `skills/agent-browser/scripts/`.

Everything else is left alone. A token with whitespace is a command line rather
than a path. A token with no directory separator has nothing to root it. Prose
(`async/await`), flags (`-s/--space`), module specifiers
(`lit/directives/class-map.js`) and paths inside a mounted filesystem
(`input/contacts.json`) do not start with a real directory, so they are skipped.

The backticks are what mark a token as a citation, wherever it sits. A path
written bare is not checked, which is why the paths in fenced code blocks mostly
go unseen — fenced content is rarely backticked. Backtick one inside a fence and
it is checked like any other.

The rooting requirement cuts both ways: a real path written in an abbreviated
form that omits the directory rooting it is skipped as well, so it rots unseen.
Write paths from the repo root to get them checked.

Membership comes from git rather than from the filesystem, so the question is
"is this path part of the repo" rather than "does this path exist on this
machine". Ignored build output never makes a citation resolve, so the check does
not depend on whether you happen to have built, and a wrong-case citation is
caught on a case-insensitive filesystem instead of surviving until CI. A path the
index still holds but the working tree has lost does not count either, so a
citation breaks as soon as its target moves away rather than lingering until the
deletion is staged.

To cite a path as an illustration rather than a real location, write it as a
placeholder — `packages/<pkg>/mod.ts`, `cf-{name}/cf-{name}.figma.ts`,
`packages/**`. The tripwire skips those by design, and that is the intended
opt-out; there is no allowlist, and none of the skills has needed one.

## Triggers

- **On change** — when a PR touches `skills/**`, give it a cf-review pass. (A
  norm today; can become a CI job that runs cf-review on the skill diff once
  agent-in-CI infra is settled.)
- **Periodic** — on a schedule (e.g. monthly), run the prompt below over each
  `skills/**/SKILL.md` and open an issue or fix-PR per drift found. Wire it
  through the repo's scheduled-agent / routine capability.

## Audit prompt

> Read `<skill>/SKILL.md` and audit every load-bearing fact against the current
> tree. For each canonical home, symbol, path, package export, and behavioral
> claim it asserts: is it still true? Has a home moved, been renamed, or been
> removed? Is any "do not" advice stale? Is there a _new_ canonical home or
> footgun the skill should name but doesn't? Does the framing still match how the
> system actually works, and is it still coherent with
> `docs/development/skill-authoring.md`? Verify against the tree (read the code /
> exports) — don't speculate. Report drift as: location · the claim · what is
> actually true now · the one-line fix. If everything resolves, say so and stop.

## Why this isn't all in the tripwire

Deterministic extraction of "is this fact still _true_" from prose is brittle, so
the tripwire asks only the narrow question it can answer exactly: does this name
still resolve? The rot that matters most is invisible to it. The worst case — the
home moved, but both the old and the new name still exist — resolves perfectly
well and is still wrong. So is advice that has quietly become bad, and so is a
new canonical home or footgun the skill should name but doesn't. The tripwire
stays narrow on purpose; the audit carries the judgment.

One row it cannot cover by construction: the cf-review anti-dup table's
cell↔link entry names a **bare internal symbol** (`convertCellsToLinks` in
`packages/runner/src/cell.ts`) — an internal runner function with no package
export, so there's nothing for the resolvability check to resolve. That symbol's
accuracy is the audit's job, not the tripwire's. (Noted from @mpsalisbury's
review of #3829.)
