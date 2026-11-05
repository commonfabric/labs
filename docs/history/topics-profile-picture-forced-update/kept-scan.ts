// Read-only scan of the Topics board after the kept-activity migration: for
// each topic, the kept `commentCount` and `lastActivityAt` inputs, the values
// the topic publishes, and the state version, against the values computed from
// the topic's own records. Nothing is stepped and nothing is written.
//
//   deno run ... kept-scan.ts <out.jsonl> <first> <last>
//   deno run ... kept-scan.ts <out.jsonl> --ids <file of piece ids>
//
// SCAN_API_URL and SCAN_SPACE name the server and space; PIN_ROOT is the
// checkout imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { getCellValue, loadPieces } = await import(
  `${ROOT}/packages/cli/lib/piece.ts`
);
const { parseSelectProjection } = await import(
  `${ROOT}/packages/cli/lib/cell-selection.ts`
);

const [outPath, firstArg, lastArg] = Deno.args;
// Each target is a board member number, read through the board, or a piece id,
// read directly.
const targets: (number | string)[] = firstArg === "--ids"
  ? (await Deno.readTextFile(lastArg)).split("\n").filter(Boolean)
  : Array.from(
    { length: Number(lastArg) - Number(firstArg) + 1 },
    (_, i) => Number(firstArg) + i,
  );

const base = {
  apiUrl: Deno.env.get("SCAN_API_URL")!,
  space: Deno.env.get("SCAN_SPACE")!,
  identity: Deno.env.get("CF_IDENTITY")!,
};

let pieces: unknown;
const shared = {
  // deno-lint-ignore no-explicit-any
  loadPieces: async (config: any) => pieces ??= await loadPieces(config),
};

const resultSelection = {
  projection: parseSelectProjection("commentCount,lastActivityAt"),
};
const inputSelection = {
  projection: parseSelectProjection(
    "createdAt,bodyUpdatedAt,titleUpdatedAt," +
      "comments.sentAt,comments.editedAt,comments.removedAt," +
      "links.addedAt,links.removedAt",
  ),
};

// A source before the migration declares none of these, so they are read on
// their own and an undeclared field reads as null.
const keptSelections = ["topicStateVersion", "commentCount", "lastActivityAt"]
  .map((field) => ({ projection: parseSelectProjection(field) }));

type Stamped = { sentAt?: number; editedAt?: number; removedAt?: number };

const out = await Deno.open(outPath, {
  create: true,
  append: true,
  write: true,
});
const encoder = new TextEncoder();

for (const target of targets) {
  const config = { ...base, piece: typeof target === "number" ? "top" : target };
  const member = typeof target === "number" ? [String(target)] : [];
  const row: Record<string, unknown> = typeof target === "number"
    ? { n: target }
    : { id: target };
  try {
    const published = await getCellValue(config, member, {
      selection: resultSelection,
    }, shared) as { commentCount?: number; lastActivityAt?: number };
    const input = await getCellValue(config, member, {
      input: true,
      selection: inputSelection,
    }, shared) as {
      createdAt?: number;
      bodyUpdatedAt?: number;
      titleUpdatedAt?: number;
      comments?: Stamped[];
      links?: { addedAt?: number; removedAt?: number }[];
    };
    let kept: {
      topicStateVersion?: number;
      commentCount?: number;
      lastActivityAt?: number;
    } = {};
    for (const selection of keptSelections) {
      try {
        kept = {
          ...kept,
          ...await getCellValue(config, member, {
            input: true,
            selection,
          }, shared) as typeof kept,
        };
      } catch (error) {
        if (!String(error).includes("CellSelectionError")) throw error;
      }
    }
    const comments = input.comments ?? [];
    const links = input.links ?? [];
    let newest = Math.max(
      input.createdAt ?? 0,
      input.bodyUpdatedAt ?? 0,
      input.titleUpdatedAt ?? 0,
    );
    for (const c of comments) {
      newest = Math.max(
        newest,
        c.sentAt ?? 0,
        c.editedAt ?? 0,
        c.removedAt ?? 0,
      );
    }
    for (const l of links) {
      newest = Math.max(newest, l.addedAt ?? 0, l.removedAt ?? 0);
    }
    row.version = kept.topicStateVersion ?? null;
    row.keptCount = kept.commentCount ?? null;
    row.keptActivity = kept.lastActivityAt ?? null;
    row.publishedCount = published.commentCount ?? null;
    row.publishedActivity = published.lastActivityAt ?? null;
    row.count = comments.filter((c) => c.removedAt === undefined).length;
    row.activity = newest;
    row.right = row.keptCount === row.count &&
      row.keptActivity === row.activity &&
      row.publishedCount === row.count &&
      row.publishedActivity === row.activity;
  } catch (error) {
    row.error = String(error).slice(0, 300);
  }
  await out.write(encoder.encode(JSON.stringify(row) + "\n"));
}
out.close();
Deno.exit(0);
