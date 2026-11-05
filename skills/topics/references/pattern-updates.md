# Production pattern updates

Part of `skills/topics/SKILL.md`, which is the map. This is the rule for
changing the board's or a Topic's pattern source.

Changing content through verbs is normal. Changing the board or Topic pattern
source is a production migration over team-critical data. Before any `setsrc`,
read `docs/development/space-clone-rehearsal.md` and the latest Topics migration
record in `docs/history/topics-board-migration-2026-08-28.md`. Do not use
`--dangerously-allow-incompatible-schema` without explicit team authorization.

Pass `--root` at or above `patterns` on every `piece new` and `setsrc` of the
board or a Topic. Both import the member-naming library from a sibling
directory, and the default program root is the entry's own directory, so without
the flag every such import is refused as escaping the program root and the
deploy fails before it reaches the server.
