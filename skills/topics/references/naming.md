# `top/42` — a Topic addressed by the board's name for it

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on member
names and what the deployment carries.

The board gives each Topic a name of its own: a decimal number, dense from `1`,
allocated when the Topic is filed and never reused. It is not a display name — a
Topic's display name stays its title.

A Topic publishes the number it stores, as `shortName`, and every surface that
shows one reads that one property: the header and board card badges, the number
on a mention pill, and what `#42` offers in a Topic's body editor. It renders as
a badge beside the Topic's title, and the board's `index` rows carry it. A Topic
nobody has numbered publishes none, and each of those surfaces reads nothing for
it.

`addTopic` allocates the number, passes it into the Topic it creates, and
returns it as `name` beside the created `topic`. For the Topics already on the
board, the namespace is what to read: the board's `namesTable` holds one row per
Topic the NAMESPACE has numbered, carrying `name` and the Topic itself as
`member`, and `names` holds the same pairing as a map from number to Topic.
Neither says whether that Topic stores its number; that is the Topic's own
record, and a separate read: `cf cell get --cell "$TOPIC" shortName` reads what
the Topic publishes, and the same command with `--input` reads the durable value
it publishes from.

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
the naming above are what the pattern in this checkout declares; the deployed
board runs whatever commit `/api/meta` reports. Ask the deployment before citing
a number.

It carries the namespace. The `names` map is complete and dense with no
duplicates and no gaps, the `top` slug is bound, and every Topic on the board
stores the number the namespace holds for it, so `top/<n>` resolves there and
`namesTable` names every Topic.

It carries the publication. Every Topic on the board publishes the number it
stores as `shortName`, and so does every Topic the board creates, so a Topic's
header and its board card show the number as a badge, a mention pill shows it,
and `#42` offers it in a Topic's body editor. A Topic's own `shortName` field
reads what it publishes, and `namesTable` remains the reverse lookup for a
caller holding a Topic rather than a number.
