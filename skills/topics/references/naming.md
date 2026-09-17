# `top/42` — a Topic addressed by the board's name for it

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on member
names and what the deployment carries.

The board gives each Topic a name of its own: a decimal number, dense from `1`,
allocated when the Topic is filed and never reused. It is not a display name — a
Topic's display name stays its title.

The board shows no Topic's number for now. `SHOW_TOPIC_NUMBERS` in
`packages/patterns/topics/topic.tsx` is off while only some Topics have one, and
a Topic then publishes no `shortName` at all — which is what leaves every
surface reading it blank: no header or board card badge, no number on a mention
pill, and nothing offered for `#42` in a Topic's body editor. The numbers
themselves are unaffected: allocated, recorded, stored by the Topic, and
resolvable as below. Wherever numbers are shown, one renders as a badge beside
its Topic's title, out of the number the Topic stores and publishes as
`shortName`, which the board's `index` rows carry.

`addTopic` allocates the number, passes it into the Topic it creates, and
returns it as `name` beside the created `topic`. For the Topics already on the
board, the namespace is what to read: the board's `namesTable` holds one row per
named Topic, carrying `name` and the Topic itself as `member`, and `names` holds
the same pairing as a map from name to Topic. One Topic's own stored number is
read from its durable input, `cf cell get --cell "$TOPIC" shortName --input`,
which the display switch does not gate.

```bash
deno task cf cell get --cell "$TOPICS_BOARD" namesTable --step
```

The number is what a short reference is written with. Once the board's `names`
map is bound as a slug, `<collection>/<member>` names a Topic wherever an
address is taken — `deno task cf cell get //<space>/top/42 title`,
`deno task cf piece describe --cell //<space>/top/42`,
`deno task cf piece call --cell //<space>/top/42 setTitle '{...}'` — and exactly
one segment reaches a member, so `//<space>/top/42/title` is that Topic's
`title` field. A name with no member after it is refused, naming the piece
holding the collection; and `no member 999 in top` is the refusal for a member
the board does not hold. `packages/cli/README.md` is the whole grammar, and
`docs/specs/collection-naming.md` the design.

A member name is the board's, not the fabric's: it means something only through
the collection that issued it, so a citation carries the collection —
`//<space>/top/42`, never a bare `42`. A canonical `/of:` address remains the
thing to pass in a reference position; the member name is for a person to read
and type.

**What the Estuary deployment carries.** The verbs in `references/verbs.md` and
the naming above are what the pattern in this checkout declares. The deployed
board runs whatever commit `/api/meta` reports, and until a pattern update lands
there it has no `names` map, no `top` slug, and no numbered Topic — a Topic
publishes no `shortName` and `/top/42` resolves to nothing. Ask the deployment
before citing a number, and treat `top/42` as unavailable there until the plan's
remaining step is done (`docs/plans/collection-naming-topics.md`). Deploying it
and numbering the Topics already on the board are the team's steps, not an
agent's; `references/namespace-backfill.md` is that procedure.
