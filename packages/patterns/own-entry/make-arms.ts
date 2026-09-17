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
  const idOf = (cell: unknown): string | undefined => {
    const ref = getEntityId(cell);
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
  const idOf = (cell: unknown): string | undefined => {
    const ref = getEntityId(cell);
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
