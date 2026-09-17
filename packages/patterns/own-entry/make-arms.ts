/**
 * Writes each arm's board and topic into `arms/<arm>/`, as copies of
 * `packages/patterns/topics/main.tsx` and `topic.tsx` with the edits listed
 * here. Every edit replaces text that must occur exactly once, so a copy
 * differs from its source by these edits and nothing else. An experiment
 * generator, not part of any pattern.
 *
 * Usage: deno run -A packages/patterns/own-entry/make-arms.ts
 */

const HERE = new URL(".", import.meta.url).pathname;
const TOPICS = new URL("../topics/", import.meta.url).pathname;

type Edit = [anchor: string, replacement: string];

const once = (text: string, [anchor, replacement]: Edit, where: string) => {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`${where}: anchor not found:\n${anchor}`);
  if (text.indexOf(anchor, first + 1) >= 0) {
    throw new Error(`${where}: anchor not unique:\n${anchor}`);
  }
  return text.slice(0, first) + replacement +
    text.slice(first + anchor.length);
};

const header = (arm: string, file: string) =>
  `// EXPERIMENT (own-entry, arm \`${arm}\`): a copy of\n` +
  `// packages/patterns/topics/${file} with the edits\n` +
  `// packages/patterns/own-entry/make-arms.ts lists. Not for merge. Comments\n` +
  `// outside those edits are copied unchanged and describe the original.\n`;

// --- Anchors shared by several arms ---------------------------------------

const TOPIC_IMPORT: Edit = [
  `from "../collection-naming/naming.ts";`,
  `from "../../../collection-naming/naming.ts";`,
];
const MAIN_IMPORTS: Edit[] = [
  [
    `from "../collection-naming/mentionable.ts";`,
    `from "../../../collection-naming/mentionable.ts";`,
  ],
  [
    `from "../collection-naming/naming.ts";`,
    `from "../../../collection-naming/naming.ts";`,
  ],
];

const SHORT_NAME =
  `    const shortName = ownName({ table: boardNames, self });`;
const BACKLINKS = `    const referencedBy = backlinksOf({
      table: boardCrossrefs,
      self,
    });`;
const BACKLINKS_DECL = `const backlinksOf = lift((`;
const TOPIC_INPUT_END =
  `  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;
}`;
const TOPIC_PARAMS = `      boardNames,
      [SELF]: self,`;
const TOPIC_RETURN = `      referencedBy,\n`;

const ADD_TOPIC_WIRING =
  `      // The board's mention pivot. A topic reads its inbound references out of
      // the row the board already built for it rather than rebuilding the join.
      boardCrossrefs: crossrefs,
      // The board's names table, so the topic can read its own name out of the
      // row the board already built for it.
      boardNames: table,
    });`;
const ADD_TOPIC_START = `    const piece = Topic({`;
const COMPOSER_TOPIC = `  if (!trimmed || !author) return;
  const piece = Topic({`;
const COMPOSER_TOPIC_UNTYPED: Edit = [
  COMPOSER_TOPIC,
  `  if (!trimmed || !author) return;
  // EXPERIMENT: this arm's topic takes inputs the composer does not wire.
  // deno-lint-ignore no-explicit-any
  const piece = (Topic as any)({`,
];
const ADD_TOPIC_NAME = `    const name = assignName(names, piece);\n`;
const BOARD_TABLE = `  const table = namesTable({ names });`;
const BOARD_DEFAULT = `export default pattern<TopicsInput, TopicsOutput>(`;
const BOARD_OUTPUT_INDEX = `  index: TopicIndexRow[] | Default<[]>;`;
const BOARD_RETURN = `    topicCount,
    crossrefs,
`;

// --- The arms -------------------------------------------------------------

/** q2-unread: the tables stay wired and declared; nothing reads them. */
const q2Unread = {
  topic: [
    [SHORT_NAME, `    const shortName = noShortName({});`],
    [BACKLINKS, `    const referencedBy = noBacklinks({});`],
    [
      BACKLINKS_DECL,
      `/** EXPERIMENT (q2-unread): a name computed without reading the table. */
const noShortName = lift(
  (_: Record<string, never>): string | undefined => undefined,
);

/** EXPERIMENT (q2-unread): inbound references computed without reading the
 * table. */
const noBacklinks = lift((_: Record<string, never>): TopicSummary[] => []);

${BACKLINKS_DECL}`,
    ],
  ] as Edit[],
  main: [] as Edit[],
};

/** q2-read-one: the lifts declare the table as today and read row 0 only. */
const q2ReadOne = {
  topic: [
    [
      SHORT_NAME,
      `    const shortName = firstRowName({ table: boardNames, self });`,
    ],
    [
      BACKLINKS,
      `    const referencedBy = firstRowBacklinks({
      table: boardCrossrefs,
      self,
    });`,
    ],
    [
      BACKLINKS_DECL,
      `/** EXPERIMENT (q2-read-one): declared exactly as \`backlinksOf\` declares its
 * parameter; reads the first row only. Row 0 is topic 0's. */
const firstRowBacklinks = lift((
  { table }: {
    table:
      | { topic: ComparableCell<unknown>; mentionedBy: unknown[] }[]
      | Default<[]>;
    self: ComparableCell<unknown>;
  },
): TopicSummary[] => (table[0]?.mentionedBy ?? []) as TopicSummary[]);

/** EXPERIMENT (q2-read-one): declared exactly as \`ownName\` declares its
 * parameter; reads the first row only. Row 0 is name "1", topic 0's. */
const firstRowName = lift((
  { table }: {
    table: { member: ComparableCell<unknown>; name: string }[] | Default<[]>;
    self: ComparableCell<unknown>;
  },
): string | undefined => table[0]?.name);

${BACKLINKS_DECL}`,
    ],
  ] as Edit[],
  main: [] as Edit[],
};

/**
 * The edits every entry arm shares on the topic: the board allocates the name
 * before it files the topic and stores it there, as the collection-naming
 * exemplar's item does, so a topic shows its number without reading anything
 * of its board. `[SELF]` is a `Reactive<TopicOutput>` rather than a cell, so a
 * pattern cannot spell its own cell as a collection key; the name is the key
 * both sides can compute.
 */
const storedName = (arm: string): Edit[] => [
  [
    `  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;\n`,
    `  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;

  /** EXPERIMENT (${arm}): the name the board allocated for this topic, stored
   * here by the create that filed it. */
  shortName?: string;
`,
  ],
  [
    `      boardNames,\n      [SELF]: self,`,
    `      boardNames,\n      shortName,\n      [SELF]: self,`,
  ],
  [
    SHORT_NAME,
    `    // EXPERIMENT (${arm}): the name is this topic's own stored input.`,
  ],
];

/** The board edits every entry arm shares: the name is allocated first, and
 * the create hands it to the topic. */
const storedNameMain = (arm: string): Edit[] => [
  COMPOSER_TOPIC_UNTYPED,
  [
    ADD_TOPIC_START,
    `    // EXPERIMENT (${arm}): the name is allocated before the topic is
    // created, so the create can store it in the topic.
    const { name, member: piece } = createNamed(names, (allocated) =>
      Topic({
        shortName: allocated,`,
  ],
  [ADD_TOPIC_NAME, ``],
  [
    `  assignName,\n  backfillNames,\n`,
    `  assignName,\n  backfillNames,\n  createNamed,\n`,
  ],
];

/** The per-topic entry rows a board derives, and the helpers they need. */
const entryRows = (arm: string, copies: boolean, handed: boolean) =>
  handed
    ? `/** EXPERIMENT (${arm}): what the board holds about each topic, written
 * into the entry document the create made for that topic. A lift writes its
 * inputs' cells here rather than returning a table, because the entry has to
 * be a document of its own before the topic exists: the create hands the topic
 * that document, and a document a derivation mints later has an address the
 * create cannot know. Returns how many entries it wrote, which is what a
 * reader demands to make it run.
 */
const fillEntries = lift((
  { slots, rows, names }: {
    slots:
      | { name: string; entry: Writable<OwnEntry> }[]
      | Default<[]>;
    rows:
      | {
        topic: ComparableCell<unknown>;
        mentionedBy: ${
      copies ? `ReadonlyCell<{ title: string | Default<"">; }>[]` : "unknown[]"
    };
      }[]
      | Default<[]>;
    // deno-lint-ignore ban-types
    names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
  },
): number => {
  // The id of the document a cell RESOLVES to, as a string. Resolving first
  // is what makes the join survive a member whose document has moved and left
  // a forwarding link: the board's list then holds the old address, the
  // namespace holds the address it was given, and only the resolved document
  // is the same on both sides. \`getEntityId\` alone does not resolve.
  const idOf = (cell: unknown): string | undefined => {
    const resolvable = cell as { resolveAsCell?: () => unknown } | undefined;
    const target = typeof resolvable?.resolveAsCell === "function"
      ? resolvable.resolveAsCell()
      : cell;
    const ref = getEntityId(target);
    return ref === undefined ? undefined : entityRefToString(ref);
  };
  const nameById = new Map<string, string>();
  const idByName = new Map<string, string>();
  for (const [name, member] of Object.entries(names)) {
    if (member === undefined) continue;
    const id = idOf(member);
    if (id === undefined) continue;
    nameById.set(id, name);
    idByName.set(name, id);
  }
  const rowById = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = idOf(row.topic);
    if (id !== undefined) rowById.set(id, row);
  }
  let written = 0;
  for (const slot of slots) {
    const id = idByName.get(slot.name);
    if (id === undefined) continue;
    const row = rowById.get(id);
    ${
      copies
        ? `const mentionedBy = (row?.mentionedBy ?? []).map((source) => {
      const sourceId = idOf(source);
      return {
        title: source.get()?.title ?? "",
        shortName: sourceId === undefined ? "" : nameById.get(sourceId) ?? "",
      };
    });`
        : `const mentionedBy = row?.mentionedBy ?? [];`
    }
    slot.entry.set({ name: slot.name, mentionedBy } as OwnEntry);
    written++;
  }
  return written;
});

`
    : `/** EXPERIMENT (${arm}): one entry per named topic — what the board holds
 * about that topic — each its own document, addressed by the topic it is
 * about. The board derives these once; a topic looks up its own. */
const entryRows = lift((
  { rows, names }: {
    rows:
      | {
        topic: ComparableCell<unknown>;
        mentionedBy: ${
      copies ? `ReadonlyCell<{ title: string | Default<"">; }>[]` : "unknown[]"
    };
      }[]
      | Default<[]>;
    // deno-lint-ignore ban-types
    names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
  },
): OwnEntry[] => {
  // The id of the document a cell RESOLVES to, as a string. Resolving first
  // is what makes the join survive a member whose document has moved and left
  // a forwarding link: the board's list then holds the old address, the
  // namespace holds the address it was given, and only the resolved document
  // is the same on both sides. \`getEntityId\` alone does not resolve.
  const idOf = (cell: unknown): string | undefined => {
    const resolvable = cell as { resolveAsCell?: () => unknown } | undefined;
    const target = typeof resolvable?.resolveAsCell === "function"
      ? resolvable.resolveAsCell()
      : cell;
    const ref = getEntityId(target);
    return ref === undefined ? undefined : entityRefToString(ref);
  };
  const nameById = new Map<string, string>();
  for (const [name, member] of Object.entries(names)) {
    if (member === undefined) continue;
    const id = idOf(member);
    if (id !== undefined) nameById.set(id, name);
  }
  const out: unknown[] = [];
  for (const row of rows) {
    const id = idOf(row.topic);
    const name = id === undefined ? undefined : nameById.get(id);
    if (name === undefined) continue;
    ${
      copies
        ? `const mentionedBy = row.mentionedBy.map((source) => {
      const sourceId = idOf(source);
      return {
        title: source.get()?.title ?? "",
        shortName: sourceId === undefined ? "" : nameById.get(sourceId) ?? "",
      };
    });`
        : `const mentionedBy = row.mentionedBy;`
    }
    out.push(
      Writable.for<OwnEntry>({ ownEntryOf: row.topic }).set({
        name,
        mentionedBy,
      } as OwnEntry),
    );
  }
  return out as OwnEntry[];
});

/** EXPERIMENT (${arm}): the entries, indexed by the name each carries. */
const indexEntries = pattern<
  { rows: Cell<OwnEntry[]> },
  { index: KeyIndex<string, OwnEntry> }
>(({ rows }) => ({ index: rows.keyBy((row) => row.name) }));

`;

/** The topic's entry type, and what it reads out of it. */
const entryTopic = (arm: string, copies: boolean, handed: boolean): Edit[] => [
  [
    TOPIC_INPUT_END,
    `  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;
${
      handed
        ? `
  /** EXPERIMENT (${arm}): this topic's own entry, the reference the board
   * handed over when it filed the topic. */
  ownEntry?: ReadonlyCell<OwnEntry | undefined>;`
        : `
  /** EXPERIMENT (${arm}): the board's entries, indexed by the name each
   * carries. The topic looks up its own. */
  boardEntryIndex: KeyIndex<string, OwnEntry>;`
    }
}

${
      copies
        ? `/** EXPERIMENT (${arm}): what a topic shows of a topic that mentions it. */
export interface TopicBacklinkCopy {
  title: string;
  shortName: string;
}

`
        : ""
    }/** EXPERIMENT (${arm}): what the board holds about one topic. */
export interface OwnEntry {
  /** The board's name for the topic this entry is about. */
  name: string;

  /** The topics that mention it${
      copies ? ", as copies" : ", as references"
    }. */
  mentionedBy: ${copies ? "TopicBacklinkCopy[]" : "unknown[]"};
}`,
  ],
  ...storedName(arm),
  ...(handed ? [] : [[
    `  lift,\n  NAME,\n`,
    `  type KeyIndex,\n  lift,\n  NAME,\n`,
  ]] as Edit[]),
  [
    `      boardNames,\n      shortName,\n      [SELF]: self,`,
    `      boardNames,
      shortName,
      ${handed ? "ownEntry," : "boardEntryIndex,"}
      [SELF]: self,`,
  ],
  [
    BACKLINKS,
    handed
      ? `    const referencedBy = entryBacklinks({ entry: ownEntry });`
      : `    const referencedBy = entryBacklinks({
      entry: boardEntryIndex.lookup(shortName),
    });`,
  ],
  [
    BACKLINKS_DECL,
    `/** EXPERIMENT (${arm}): the inbound references this topic's entry carries. */
const entryBacklinks = lift((
  { entry }: { entry: OwnEntry | undefined },
): ${copies ? "TopicBacklinkCopy[]" : "TopicSummary[]"} =>
  (entry?.mentionedBy ?? []) as ${
      copies ? "TopicBacklinkCopy[]" : "TopicSummary[]"
    });

${BACKLINKS_DECL}`,
  ],
  ...(copies
    ? [
      [
        `  referencedBy: TopicSummary[] | Default<[]>;`,
        `  referencedBy: TopicBacklinkCopy[] | Default<[]>;`,
      ],
      [
        `                      {referencedBy.map((topic) => (
                        <cf-cell-link $cell={topic} />
                      ))}`,
        `                      {referencedBy.map((topic) => (
                        <cf-text>{topic.shortName} {topic.title}</cf-text>
                      ))}`,
      ],
    ] as Edit[]
    : []),
];

const entryMain = (arm: string, copies: boolean, handed: boolean): Edit[] => [
  ...storedNameMain(arm),
  [
    `  handler,\n`,
    `  handler,\n  type ComparableCell,\n  entityRefToString,\n  getEntityId,\n${
      handed ? "" : "  type Cell,\n  type KeyIndex,\n"
    }`,
  ],
  [
    `  type TopicCrossrefRow,\n  type TopicMentionable,`,
    `  type OwnEntry,\n  type TopicCrossrefRow,\n  type TopicMentionable,`,
  ],
  [BOARD_DEFAULT, `${entryRows(arm, copies, handed)}${BOARD_DEFAULT}`],
  ...(handed
    ? [
      [
        `export interface TopicsInput {\n`,
        `/** EXPERIMENT (${arm}): where the board keeps a topic's entry document
 * once its create has minted one. */
export interface EntrySlot {
  /** The board's name for the topic the entry is about. */
  name: string;

  /** The entry itself, which the create also handed to the topic. */
  entry: Writable<OwnEntry>;
}

export interface TopicsInput {
  /** EXPERIMENT (${arm}): one slot per topic the board has filed. */
  entrySlots?: Writable<EntrySlot[] | Default<[]>>;

`,
      ],
      [
        `export default pattern<TopicsInput, TopicsOutput>(({ topics, names }) => {`,
        `export default pattern<TopicsInput, TopicsOutput>((
  { topics, names, entrySlots },
) => {`,
      ],
      [
        BOARD_TABLE,
        `${BOARD_TABLE}
  // EXPERIMENT (${arm}): what the board holds about each topic, written into
  // the entry document that topic's create minted.
  // deno-lint-ignore no-explicit-any
  const entriesWritten = fillEntries({
    slots: entrySlots as any,
    // deno-lint-ignore no-explicit-any
    rows: crossrefs as any,
    names,
  });`,
      ],
      [
        `    const { name, member: piece } = createNamed(names, (allocated) =>
      Topic({
        shortName: allocated,`,
        `    const { name, member: piece } = createNamed(names, (allocated) => {
      // EXPERIMENT (${arm}): the entry document, minted by the create so the
      // topic can be handed it and nothing broader.
      const entry = Writable.for<OwnEntry>({ ownEntryOf: allocated })
        .set({ name: allocated, mentionedBy: [] } as OwnEntry);
      entrySlots.push({ name: allocated, entry });
      return Topic({
        shortName: allocated,`,
      ],
      [
        ADD_TOPIC_WIRING,
        `      // EXPERIMENT (${arm}): this topic's own entry, and no table.
      ownEntry: entry,
    });
    });`,
      ],
      [
        BOARD_OUTPUT_INDEX,
        `${BOARD_OUTPUT_INDEX}

  /** EXPERIMENT (${arm}): one slot per topic, each holding that topic's own
   * entry document. */
  entrySlots: EntrySlot[] | Default<[]>;

  /** EXPERIMENT (${arm}): how many entries the last fill wrote. Demanding it
   * is what makes the fill run. */
  entriesWritten: number;`,
      ],
      [
        BOARD_RETURN,
        `${BOARD_RETURN}    entrySlots,\n    entriesWritten,\n`,
      ],
    ] as Edit[]
    : [
      [
        BOARD_TABLE,
        `${BOARD_TABLE}
  // EXPERIMENT (${arm}): each topic's entry, derived once for the board, and
  // indexed by the name it carries.
  // deno-lint-ignore no-explicit-any
  const entries = entryRows({ rows: crossrefs as any, names });
  const entryIndex = indexEntries({ rows: entries });`,
      ],
      [
        ADD_TOPIC_WIRING,
        `      // EXPERIMENT (${arm}): the board's entry index, and no table.
      boardEntryIndex: entryIndex.index,
    }));`,
      ],
      [
        BOARD_OUTPUT_INDEX,
        `${BOARD_OUTPUT_INDEX}

  /** EXPERIMENT (${arm}): one entry per named topic. */
  ownEntries: OwnEntry[];

  /** EXPERIMENT (${arm}): the entries indexed by name. */
  entryIndex: KeyIndex<string, OwnEntry>;`,
      ],
      [
        BOARD_RETURN,
        `${BOARD_RETURN}    ownEntries: entries,\n    entryIndex: entryIndex.index,\n`,
      ],
    ] as Edit[]),
];

/** q7-board-name: the topic also reads the board's declared name through one
 * reference to the board. */
const boardNameTopic: Edit[] = [
  [
    `  ownEntry?: ReadonlyCell<OwnEntry | undefined>;\n}`,
    `  ownEntry?: ReadonlyCell<OwnEntry | undefined>;

  /** EXPERIMENT (q7-board-name): the board that filed this topic. */
  board?: ReadonlyCell<{ naming: { name?: string } } | undefined>;
}`,
  ],
  [
    `      ownEntry,\n      [SELF]: self,`,
    `      ownEntry,\n      board,\n      [SELF]: self,`,
  ],
  [
    `    const referencedBy = entryBacklinks({ entry: ownEntry });`,
    `    const referencedBy = entryBacklinks({ entry: ownEntry });
    const collectionName = collectionNameOf({ board });`,
  ],
  [
    BACKLINKS_DECL,
    `/** EXPERIMENT (q7-board-name): the name the board declares for itself. */
const collectionNameOf = lift((
  { board }: { board: { naming: { name?: string } } | undefined },
): string | undefined => board?.naming?.name);

${BACKLINKS_DECL}`,
  ],
  [
    `export interface TopicOutput extends TopicPiece {\n  [UI]: VNode;\n`,
    `export interface TopicOutput extends TopicPiece {
  [UI]: VNode;

  /** EXPERIMENT (q7-board-name): the board's declared name. */
  collectionName?: string;
`,
  ],
  [TOPIC_RETURN, `${TOPIC_RETURN}      collectionName,\n`],
];

const boardNameMain: Edit[] = [
  [`  pattern,\n`, `  pattern,\n  SELF,\n`],
  [
    `  { topics, names, entrySlots },`,
    `  { topics, names, entrySlots, [SELF]: self },`,
  ],
  [
    `      ownEntry: entry,\n    });`,
    `      ownEntry: entry,
      // EXPERIMENT (q7-board-name): one reference to the board itself.
      board: self,
    });`,
  ],
  [
    `    naming: SEQUENCE_NAMING,\n`,
    `    // EXPERIMENT (q7-board-name): the board declares its name.
    naming: { ...SEQUENCE_NAMING, name: "topics" },
`,
  ],
];

// --- Round 2 -------------------------------------------------------------

/** The copies the editor completes over, without the member reference a
 * universe row carries. */
const UNIVERSE_COPY =
  `/** EXPERIMENT: a universe row as a member reads it — the three display
 * strings and no reference to the member, so reading the universe expands no
 * member. */
export interface UniverseCopy {
  [NAME]: string | Default<"">;
  title: string | Default<"">;
  shortName: string | Default<"">;
}

`;

/**
 * The board edits every round-2 arm shares: the entry document is minted
 * before the topic (so the create can hand it over), and the slot the board
 * keeps carries the topic as well as its name, so a per-entry fill can find
 * that topic's row by identity rather than by a join over the whole table.
 */
const perEntryMain = (arm: string, opts: {
  /** Fold the board's name and a bounded universe into the entry. */
  everything: boolean;
}): Edit[] => [
  COMPOSER_TOPIC_UNTYPED,
  [
    `  assignName,\n  backfillNames,\n`,
    `  assignName,\n  backfillNames,\n  createNamed,\n`,
  ],
  [
    `  handler,\n`,
    `  handler,\n  type Cell,\n  type ComparableCell,\n  computed,\n  entityRefToString,\n  getEntityId,\n  type KeyIndex,\n`,
  ],
  [
    `  type TopicCrossrefRow,\n  type TopicMentionable,`,
    `  type OwnEntry,\n  type TopicCrossrefRow,\n  type TopicMentionable,${
      opts.everything ? `\n  type UniverseCopy,` : ""
    }`,
  ],
  [
    `export interface TopicsInput {\n`,
    `/** EXPERIMENT (${arm}): where the board keeps a topic's entry document,
 * under the name it was filed as. */
export interface EntrySlot {
  /** The board's name for the topic. */
  name: string;

  /** The entry, which the create also handed to the topic. */
  entry: Writable<OwnEntry>;
}

export interface TopicsInput {
  /** EXPERIMENT (${arm}): one slot per topic the board has filed. */
  entrySlots?: Writable<EntrySlot[] | Default<[]>>;

`,
  ],
  [
    BOARD_DEFAULT,
    `/** EXPERIMENT (${arm}): what the pivot reads of one topic — what it points
 * at, and the two display strings a topic that mentions it shows. */
interface PivotSource {
  mentions: ComparableCell<unknown>[] | Default<[]>;
  title: string | Default<"">;
  shortName?: string;
}

/** EXPERIMENT (${arm}): one row of the pivot, addressed by the topic it is
 * about and NAMED, so a per-entry fill finds its row by a key both sides
 * compute. Its members are cells carrying the two display strings, which is
 * what lets one type serve the pivot, the index over it, and the fill. */
interface PivotRow {
  name: string;
  mentionedBy: ReadonlyCell<PivotSource>[];
}

/** EXPERIMENT (${arm}): the board's mention pivot, named. One row per topic,
 * carrying the board's name for it and the topics that mention it as cells.
 * The name comes from the namespace, joined by the identity each side
 * RESOLVES to — \`getEntityId\` alone does not resolve, and a member whose
 * document has moved and left a forwarding link is reached through the old
 * address, so an unresolved join would lose it. */
const pivotTable = lift((
  { sources, names }: {
    sources: ReadonlyCell<PivotSource>[] | Default<[]>;
    // deno-lint-ignore ban-types
    names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
  },
): PivotRow[] => {
  const idOf = (cell: unknown): string | undefined => {
    const resolvable = cell as { resolveAsCell?: () => unknown } | undefined;
    const target = typeof resolvable?.resolveAsCell === "function"
      ? resolvable.resolveAsCell()
      : cell;
    const ref = getEntityId(target);
    return ref === undefined ? undefined : entityRefToString(ref);
  };
  const nameById = new Map<string, string>();
  for (const [name, member] of Object.entries(names)) {
    if (member === undefined) continue;
    const id = idOf(member);
    if (id !== undefined) nameById.set(id, name);
  }
  // Every pass below reads plain arrays: an element read through a reactive
  // array resolves a link every time.
  const list = Array.from(sources);
  const mentions = list.map((topic) => {
    const value = topic?.get();
    return value === undefined ? [] : Array.from(value.mentions ?? []);
  });
  const rows: unknown[] = [];
  list.forEach((topic, index) => {
    const id = idOf(topic);
    const name = id === undefined ? undefined : nameById.get(id);
    if (name === undefined) return;
    const inbound: ReadonlyCell<PivotSource>[] = [];
    list.forEach((source, other) => {
      if (other === index) return;
      if (mentions[other].some((mention) => equals(topic, mention))) {
        inbound.push(source);
      }
    });
    rows.push(
      Writable.for<PivotRow>(topic).set({ name, mentionedBy: inbound }),
    );
  });
  return rows as PivotRow[];
});

/** EXPERIMENT (${arm}): the pivot indexed by the name each row carries — a
 * string key, which is the only kind a member can compute for itself. */
const indexPivot = pattern<
  { rows: Cell<PivotRow[]> },
  { index: KeyIndex<string, PivotRow> }
>(({ rows }) => ({ index: rows.keyBy((row) => row.name) }));

/** EXPERIMENT (${arm}): ONE topic's entry, written from that topic's own row.
 * A mention change re-runs this for the topics whose row changed and for no
 * others, which is the whole point of it being per topic. The titles and names
 * it copies come from the mentioning topics themselves, each of which
 * publishes its own name, so no names table is read here. Returns what it
 * wrote, which is what a reader demands to make it run. */
const fillOneEntry = lift((
  { entry, name, row${opts.everything ? ", collectionName, universe" : ""} }: {
    entry: Writable<OwnEntry>;
    name: string;
    row: PivotRow | undefined;${
      opts.everything
        ? `
    collectionName: string;
    universe: UniverseCopy[];`
        : ""
    }
  },
): number => {
  const mentionedBy = (row?.mentionedBy ?? []).map((source) => {
    const value = source.get();
    return { title: value?.title ?? "", shortName: value?.shortName ?? "" };
  });
  entry.set({
    name,
    mentionedBy,${
      opts.everything
        ? `
    // The board's own name, and its universe, as values — so a topic's whole
    // demand on its board is this one entry.
    collectionName,
    universe,`
        : ""
    }
  });
  return mentionedBy.length;
});

${
      opts.everything
        ? `/** EXPERIMENT (${arm}): the universe, bounded. A member's editor completes
 * over the most recently filed \`UNIVERSE_BOUND\` members rather than over every
 * member, so what a member loads at startup does not grow with the
 * collection. What it costs is completion over the rest, which is the
 * component's to ask for; see the report. */
const boundedUniverse = lift((
  { rows }: {
    rows: {
      [NAME]: string | Default<"">;
      title: string | Default<"">;
      shortName: string | Default<"">;
    }[] | Default<[]>;
  },
): UniverseCopy[] =>
  rows.slice(Math.max(0, rows.length - UNIVERSE_BOUND)).map((row) => ({
    [NAME]: row[NAME] ?? "",
    title: row.title ?? "",
    shortName: row.shortName ?? "",
  })) as UniverseCopy[]
);

/** How many members a bounded universe carries. */
const UNIVERSE_BOUND = 50;

/** What this board calls itself. */
const BOARD_NAME = "topics";

`
        : ""
    }${BOARD_DEFAULT}`,
  ],
  [
    `export default pattern<TopicsInput, TopicsOutput>(({ topics, names }) => {`,
    `export default pattern<TopicsInput, TopicsOutput>((
  { topics, names, entrySlots },
) => {`,
  ],
  [
    BOARD_TABLE,
    `${BOARD_TABLE}${
      opts.everything
        ? `
  // EXPERIMENT (${arm}): the universe, bounded, and derived once.
  const universe = boundedUniverse({ rows: mentionable });`
        : ""
    }
  // EXPERIMENT (${arm}): the named pivot, indexed by name, and one entry per
  // topic written from that topic's own row of it.
  const pivot = pivotTable({ sources: topics, names });
  const byName = indexPivot({ rows: pivot });
  const perEntryWrites = entrySlots.map((slot) => {
    // The lookup is wrapped so the compiler lowers it into a computation that
    // receives the index handle as a cell. Reading \`.index\` in the board body
    // and handing the result straight to a factory leaves the access as a
    // plain property read of the params cell, which is undefined at build
    // time.
    const row = computed(() => byName.index.lookup(slot.name));
    return fillOneEntry({
      entry: slot.entry,
      name: slot.name,
      row,${
      opts.everything
        ? `
      collectionName: BOARD_NAME,
      universe,`
        : ""
    }
    });
  });`,
  ],
  [
    ADD_TOPIC_START,
    `    // EXPERIMENT (${arm}): the entry document is minted before the topic,
    // so the create can hand the topic that document and nothing broader.
    const entry = new Writable<OwnEntry>({
      name: "",
      mentionedBy: [],${
      opts.everything ? `\n      collectionName: "",\n      universe: [],` : ""
    }
    });
    const { name, member: piece } = createNamed(names, (allocated) =>
      Topic({
        shortName: allocated,`,
  ],
  [
    opts.everything
      ? `      // The board's mention index, so the editor has a mention universe. A
      // piece from before the index is rewired to it as a one-time
      // link-bind, the backfill the input declares for itself.
      mentionable,
${ADD_TOPIC_WIRING}`
      : ADD_TOPIC_WIRING,
    `      // EXPERIMENT (${arm}): this topic's own entry, and nothing else of
      // the board.
      ownEntry: entry,
    }));
    entrySlots.push({ name, entry });`,
  ],
  [ADD_TOPIC_NAME, ``],
  [
    BOARD_OUTPUT_INDEX,
    `${BOARD_OUTPUT_INDEX}

  /** EXPERIMENT (${arm}): one slot per topic, each holding that topic's own
   * entry document. */
  entrySlots: EntrySlot[] | Default<[]>;

  /** EXPERIMENT (${arm}): the named pivot the fills read their rows from. */
  pivot: PivotRow[] | Default<[]>;

  /** EXPERIMENT (${arm}): how many references each per-topic fill wrote.
   * Demanding it is what makes the fills run. */
  perEntryWrites: number[];`,
  ],
  [
    BOARD_RETURN,
    `${BOARD_RETURN}    entrySlots,\n    pivot,\n    perEntryWrites,\n`,
  ],
  ...(opts.everything
    ? [
      [
        `    naming: SEQUENCE_NAMING,\n`,
        `    // EXPERIMENT (${arm}): the board declares the name its entries carry.
    naming: { ...SEQUENCE_NAMING, name: BOARD_NAME },
`,
      ],
    ] as Edit[]
    : []),
];

/** The topic side of "one entry for everything": the entry carries the name,
 * the board's name and the universe, and no other input is wired. */
const everythingTopic: Edit[] = [
  [
    `/** EXPERIMENT (r3-one-entry): what the board holds about one topic. */
export interface OwnEntry {`,
    `${UNIVERSE_COPY}/** EXPERIMENT (r3-one-entry): what the board holds about one topic —
 * everything the topic reads of its board, in one document. */
export interface OwnEntry {
  /** The board's own name, as a value. */
  collectionName: string | Default<"">;

  /** The universe the editor completes over, as COPIES of a bounded slice of
   * the board's — so what a topic reads of its board is this one document, and
   * what it reads does not grow with the board. What it costs the board is a
   * copy per topic; the report measures that.
   */
  universe: UniverseCopy[] | Default<[]>;
`,
  ],
  [
    `    const referencedBy = entryBacklinks({ entry: ownEntry });`,
    `    const referencedBy = entryBacklinks({ entry: ownEntry });
    // EXPERIMENT (r3-one-entry): both out of the same entry.
    const collectionName = entryCollectionName({ entry: ownEntry });
    const universe = entryUniverse({ entry: ownEntry });`,
  ],
  [
    BACKLINKS_DECL,
    `/** EXPERIMENT (r3-one-entry): the board's name, out of the entry. */
const entryCollectionName = lift((
  { entry }: { entry: { collectionName: string | Default<""> } | undefined },
): string | undefined => entry?.collectionName);

/** EXPERIMENT (r3-one-entry): the universe, out of the entry. One reference
 * to one bounded document; the rows carry no member reference, so reading them
 * expands no topic. */
const entryUniverse = lift((
  { entry }: {
    entry: { universe: UniverseCopy[] | Default<[]> } | undefined;
  },
): UniverseCopy[] => (entry?.universe ?? []) as UniverseCopy[]);

${BACKLINKS_DECL}`,
  ],
  [
    `                        $mentionable={mentionable}`,
    `                        $mentionable={universe}`,
  ],
  [
    `export interface TopicOutput extends TopicPiece {\n  [UI]: VNode;\n`,
    `export interface TopicOutput extends TopicPiece {
  [UI]: VNode;

  /** EXPERIMENT (r3-one-entry): the board's declared name, out of the entry. */
  collectionName?: string;

  /** EXPERIMENT (r3-one-entry): how many members the entry's universe carries,
   * so a measurement can see that the editor has one. */
  universeCount?: number;
`,
  ],
  [
    TOPIC_RETURN,
    `${TOPIC_RETURN}      collectionName,\n      universeCount,\n`,
  ],
  [
    `    const universe = entryUniverse({ entry: ownEntry });`,
    `    const universe = entryUniverse({ entry: ownEntry });
    const universeCount = universe.length;`,
  ],
];

/** r1-pruned: the board's universe, bounded, wired as the universe input. */
const prunedMain: Edit[] = [
  [
    `  const mentionable = mentionableIndex({ members: topics });`,
    `  const mentionable = boundedUniverse({
    rows: mentionableIndex({ members: topics }),
  });`,
  ],
  [
    BOARD_DEFAULT,
    `/** EXPERIMENT (r1-pruned): the universe, bounded to the most recently filed
 * members, so what a member loads at startup does not grow with the board. */
const boundedUniverse = lift((
  { rows }: {
    rows: {
      [NAME]: string | Default<"">;
      title: string | Default<"">;
      shortName: string | Default<"">;
      piece: unknown;
    }[] | Default<[]>;
  },
): MentionableRow[] =>
  rows.slice(Math.max(0, rows.length - 50)) as MentionableRow[]
);

${BOARD_DEFAULT}`,
  ],
];

/** r1-lazy: the editor completes over a session copy the open verb takes, so
 * the universe is read when the editor opens rather than at startup. */
const lazyTopic: Edit[] = [
  [
    `    const referencesDraft = new Writable.perSession<TopicMentionRefMap>({});`,
    `    const referencesDraft = new Writable.perSession<TopicMentionRefMap>({});
    // EXPERIMENT (r1-lazy): the universe the editor completes over, taken when
    // the editor opens rather than read at startup.
    const universeDraft = new Writable.perSession<
      TopicMentionable[] | ReadonlyCell<TopicMentionable[]>
    >([]);`,
  ],
  [
    `    const startEditBody = action(() => {
      bodyDraft.set(body.get());`,
    `    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      // EXPERIMENT (r1-lazy): the universe, copied into session state here.
      universeDraft.set(mentionable);`,
  ],
  [
    `                        $mentionable={mentionable}`,
    `                        $mentionable={universeDraft}`,
  ],
];

/** r6-table-copies: no handed reference. The board publishes its entries as a
 * table of copies and wires the whole table into every topic, which finds its
 * own row by the name it stores. */
const tableTopic: Edit[] = [
  [
    TOPIC_INPUT_END,
    `  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;

  /** EXPERIMENT (r6-table-copies): the board's entry table, whole. Every row
   * carries values only — no reference to any topic — so a reader of the
   * table expands no topic, and a topic finds its own row by the name it
   * stores. */
  boardEntries?: ReadonlyCell<OwnEntry[] | Default<[]>>;
}

/** EXPERIMENT (r6-table-copies): what a topic shows of a topic that mentions
 * it. */
export interface TopicBacklinkCopy {
  title: string;
  shortName: string;
}

/** EXPERIMENT (r6-table-copies): one row of the board's entry table. */
export interface OwnEntry {
  name: string;
  mentionedBy: TopicBacklinkCopy[];
}`,
  ],
  ...storedName("r6-table-copies"),
  [
    `      boardNames,\n      shortName,\n      [SELF]: self,`,
    `      boardNames,\n      shortName,\n      boardEntries,\n      [SELF]: self,`,
  ],
  [
    BACKLINKS,
    `    const referencedBy = ownRowBacklinks({
      table: boardEntries,
      name: shortName,
    });`,
  ],
  [
    BACKLINKS_DECL,
    `/** EXPERIMENT (r6-table-copies): this topic's inbound references, found in
 * the board's table by the name this topic stores. The declared parameter is
 * the WHOLE table, as today's lookup declares it, and every position in it is
 * a value rather than a reference. */
const ownRowBacklinks = lift((
  { table, name }: {
    table: { name: string; mentionedBy: TopicBacklinkCopy[] }[] | Default<[]>;
    name?: string;
  },
): TopicBacklinkCopy[] =>
  (table.find((row) => row.name === name)?.mentionedBy ??
    []) as TopicBacklinkCopy[]
);

${BACKLINKS_DECL}`,
  ],
  [
    `  referencedBy: TopicSummary[] | Default<[]>;`,
    `  referencedBy: TopicBacklinkCopy[] | Default<[]>;`,
  ],
  [
    `                      {referencedBy.map((topic) => (
                        <cf-cell-link $cell={topic} />
                      ))}`,
    `                      {referencedBy.map((topic) => (
                        <cf-text>{topic.shortName} {topic.title}</cf-text>
                      ))}`,
  ],
];

const tableMain: Edit[] = [
  ...storedNameMain("r6-table-copies"),
  [
    `  handler,\n`,
    `  handler,\n  type ComparableCell,\n  entityRefToString,\n  getEntityId,\n`,
  ],
  [
    `  type TopicCrossrefRow,\n  type TopicMentionable,`,
    `  type OwnEntry,\n  type TopicCrossrefRow,\n  type TopicMentionable,`,
  ],
  [
    BOARD_DEFAULT,
    `/** EXPERIMENT (r6-table-copies): the board's entry table: one row per named
 * topic, carrying the topics that mention it as COPIES. One document of
 * values, so a topic reading the whole table expands no topic. */
const entryTable = lift((
  { rows, names }: {
    rows:
      | {
        topic: ComparableCell<unknown>;
        mentionedBy: ReadonlyCell<{
          title: string | Default<"">;
          shortName?: string;
        }>[];
      }[]
      | Default<[]>;
    // deno-lint-ignore ban-types
    names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
  },
): OwnEntry[] => {
  const idOf = (cell: unknown): string | undefined => {
    const resolvable = cell as { resolveAsCell?: () => unknown } | undefined;
    const target = typeof resolvable?.resolveAsCell === "function"
      ? resolvable.resolveAsCell()
      : cell;
    const ref = getEntityId(target);
    return ref === undefined ? undefined : entityRefToString(ref);
  };
  const nameById = new Map<string, string>();
  for (const [name, member] of Object.entries(names)) {
    if (member === undefined) continue;
    const id = idOf(member);
    if (id !== undefined) nameById.set(id, name);
  }
  const out: OwnEntry[] = [];
  for (const row of rows) {
    const id = idOf(row.topic);
    const name = id === undefined ? undefined : nameById.get(id);
    if (name === undefined) continue;
    out.push({
      name,
      mentionedBy: row.mentionedBy.map((source) => {
        const value = source.get();
        return { title: value?.title ?? "", shortName: value?.shortName ?? "" };
      }),
    });
  }
  return out;
});

${BOARD_DEFAULT}`,
  ],
  [
    BOARD_TABLE,
    `${BOARD_TABLE}
  // EXPERIMENT (r6-table-copies): the entry table, derived once for the board.
  // deno-lint-ignore no-explicit-any
  const entries = entryTable({ rows: crossrefs as any, names });`,
  ],
  [
    ADD_TOPIC_WIRING,
    `      // EXPERIMENT (r6-table-copies): the whole entry table, of values.
      boardEntries: entries,
    }));`,
  ],
  [
    BOARD_OUTPUT_INDEX,
    `${BOARD_OUTPUT_INDEX}

  /** EXPERIMENT (r6-table-copies): one entry row per named topic. */
  ownEntries: OwnEntry[];`,
  ],
  [BOARD_RETURN, `${BOARD_RETURN}    ownEntries: entries,\n`],
];

/** r4-adopt: the create hands nothing, as a board from before the design
 * would not have; a board verb mints the missing entries, and each topic
 * takes its own through a verb of its own. */
const adoptTopic: Edit[] = [
  [
    `  ownEntry?: ReadonlyCell<OwnEntry | undefined>;`,
    `  /** EXPERIMENT (r4-adopt): declared WRITABLE, because this topic's own
   * \`adoptEntry\` verb writes the reference here. A topic filed before the
   * design holds none, and its argument is not something its board can
   * reach — a board writes a member's result and never its argument — so
   * either the topic takes the entry itself, through this input, or an
   * operator writes the argument from outside.
   */
  ownEntry?: Writable<OwnEntry | undefined>;`,
  ],
  [
    `/** EXPERIMENT (r4-adopt): the inbound references this topic's entry carries. */`,
    `/** EXPERIMENT (r4-adopt): take the entry the board minted for this topic.
 * One transaction. Idempotent in the sense that matters: taking the same
 * entry again writes the same reference. */
const adoptEntryHandler = handler<
  { entry: unknown },
  { ownEntry: Writable<OwnEntry | undefined> }
>(({ entry }, { ownEntry }) => {
  if (entry === undefined || entry === null) {
    throw new Error("adoptEntry rejected: entry must be a reference");
  }
  ownEntry.set(entry as OwnEntry);
});

/** EXPERIMENT (r4-adopt): the inbound references this topic's entry carries. */`,
  ],
  [
    `    const addComment = addCommentHandler({ upgrade, comments });`,
    `    // EXPERIMENT (r4-adopt): how a topic filed before the design is handed
    // its entry, without an operator reaching into its argument.
    const adoptEntry = adoptEntryHandler({ ownEntry });

    const addComment = addCommentHandler({ upgrade, comments });`,
  ],
  [
    `  /** Stop referencing a piece: removes every \`mention\`-made entry naming it.`,
    `  /** EXPERIMENT (r4-adopt): take the entry the board minted for this topic. */
  adoptEntry: Stream<{ entry: unknown }>;

  /** Stop referencing a piece: removes every \`mention\`-made entry naming it.`,
  ],
  [`      referencedBy,\n`, `      referencedBy,\n      adoptEntry,\n`],
];

const adoptMain: Edit[] = [
  // The create hands nothing: this models a board from before the design.
  [
    `    // EXPERIMENT (r4-adopt): the entry document is minted before the topic,
    // so the create can hand the topic that document and nothing broader.
    const entry = new Writable<OwnEntry>({
      name: "",
      mentionedBy: [],
    });
    const { name, member: piece } = createNamed(names, (allocated) =>`,
    `    const { name, member: piece } = createNamed(names, (allocated) =>`,
  ],
  [
    `      // EXPERIMENT (r4-adopt): this topic's own entry, and nothing else of
      // the board.
      ownEntry: entry,
    }));
    entrySlots.push({ name, entry });`,
    `    }));`,
  ],
  // The verb that mints what the creates did not.
  [
    `  const backfill = action<BackfillNamesEvent, BackfillNamesResult>(`,
    `  // EXPERIMENT (r4-adopt): mint an entry for every named topic that has
  // none, in one transaction. The entries exist after this; handing each
  // topic its own is a separate step, because a board cannot write a
  // member's argument.
  const backfillEntries = action<
    BackfillNamesEvent,
    { minted: string[] }
  >(({ agentName }) => {
    if (!topicAuthorFromAgent(agentName)) {
      rejectMutation("backfillEntries", "agentName must be non-blank");
    }
    const held = new Set(
      (entrySlots.get() ?? []).map((slot) => slot.name),
    );
    const minted: string[] = [];
    for (const [name, member] of Object.entries(names.get() ?? {})) {
      if (member === undefined || held.has(name)) continue;
      const entry = new Writable<OwnEntry>({ name, mentionedBy: [] });
      entrySlots.push({ name, entry });
      minted.push(name);
    }
    return { minted };
  });

  const backfill = action<BackfillNamesEvent, BackfillNamesResult>(`,
  ],
  [
    `  /** EXPERIMENT (r4-adopt): the named pivot the fills read their rows from. */`,
    `  /** EXPERIMENT (r4-adopt): mint an entry for every named topic that has
   * none. Returns the names it minted for; empty on a second run. */
  backfillEntries: Stream<BackfillNamesEvent, { minted: string[] }>;

  /** EXPERIMENT (r4-adopt): the named pivot the fills read their rows from. */`,
  ],
  [
    `    backfillNames: backfill,\n`,
    `    backfillNames: backfill,\n    backfillEntries,\n`,
  ],
];

const ARMS: Record<string, { topic: Edit[]; main: Edit[] }> = {
  "q2-unread": q2Unread,
  "q2-read-one": q2ReadOne,
  "q3-index": {
    topic: entryTopic("q3-index", false, false),
    main: entryMain("q3-index", false, false),
  },
  "q4-handed": {
    topic: entryTopic("q4-handed", false, true),
    main: entryMain("q4-handed", false, true),
  },
  "q6-copies": {
    topic: entryTopic("q6-copies", true, true),
    main: entryMain("q6-copies", true, true),
  },
  "q7-board-name": {
    topic: [...entryTopic("q7-board-name", true, true), ...boardNameTopic],
    main: [...entryMain("q7-board-name", true, true), ...boardNameMain],
  },
  "r1-pruned": {
    topic: entryTopic("r1-pruned", true, true),
    main: [...entryMain("r1-pruned", true, true), ...prunedMain],
  },
  "r1-lazy": {
    topic: [...entryTopic("r1-lazy", true, true), ...lazyTopic],
    main: entryMain("r1-lazy", true, true),
  },
  "r2-per-entry": {
    topic: entryTopic("r2-per-entry", true, true),
    main: perEntryMain("r2-per-entry", { everything: false }),
  },
  "r3-one-entry": {
    topic: [...entryTopic("r3-one-entry", true, true), ...everythingTopic],
    main: perEntryMain("r3-one-entry", { everything: true }),
  },
  // The two halves that measured best, together: entries filled one per
  // topic, and the universe bounded and left as its own input rather than
  // copied into every entry.
  "r5-best": {
    topic: entryTopic("r5-best", true, true),
    main: [...perEntryMain("r5-best", { everything: false }), ...prunedMain],
  },
  "r4-adopt": {
    topic: [...entryTopic("r4-adopt", true, true), ...adoptTopic],
    main: [
      ...perEntryMain("r4-adopt", { everything: false }),
      ...prunedMain,
      ...adoptMain,
    ],
  },
  "r6-table-copies": {
    topic: tableTopic,
    main: tableMain,
  },
};

const topicSource = Deno.readTextFileSync(`${TOPICS}topic.tsx`);
const mainSource = Deno.readTextFileSync(`${TOPICS}main.tsx`);
for (const [arm, edits] of Object.entries(ARMS)) {
  let topic = once(topicSource, TOPIC_IMPORT, `${arm}/topic.tsx`);
  for (const edit of edits.topic) topic = once(topic, edit, `${arm}/topic.tsx`);
  let main = mainSource;
  for (const edit of [...MAIN_IMPORTS, ...edits.main]) {
    main = once(main, edit, `${arm}/main.tsx`);
  }
  const dir = `${HERE}arms/${arm}`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}/topic.tsx`, header(arm, "topic.tsx") + topic);
  Deno.writeTextFileSync(`${dir}/main.tsx`, header(arm, "main.tsx") + main);
  console.log(`wrote ${dir}`);
}
