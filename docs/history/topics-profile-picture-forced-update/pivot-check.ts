// Confirms, offline, that the board's mention pivot stores its rows at space
// scope: the internal cell the board names `pivot` holds an array there, not a
// link to a session instance, and counts the rows that carry a backlink.
//
//   deno run ... pivot-check.ts <working db> <board id> [out.json]
//
// PIN_ROOT is the checkout imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { openSpace } = await import(`${ROOT}/packages/state-inspector/db.ts`);
const { getValueAt } = await import(
  `${ROOT}/packages/state-inspector/reconstruct.ts`
);

const [dbPath, boardId, outPath] = Deno.args;
const space = openSpace(dbPath);
// deno-lint-ignore no-explicit-any
const documentOf = (id: string, scope = "space"): any =>
  getValueAt(space, { id, scope, branch: "" }).document;
// deno-lint-ignore no-explicit-any
const linkOf = (value: any) => value?.["/"]?.["link@1"];

const board = documentOf(boardId);
// deno-lint-ignore no-explicit-any
const entry = (board?.internal ?? []).find((e: any) =>
  e.partialCause === "pivot"
);
const report: Record<string, unknown> = { board: boardId };
if (entry === undefined) {
  report.ok = false;
  report.reason = "the board has no internal cell caused `pivot`";
} else {
  const link = linkOf(entry.link);
  report.pivot = link?.id;
  report.declaredScope = link?.scope ?? "space";
  const value = link === undefined ? undefined : documentOf(link.id)?.value;
  if (link === undefined) {
    report.ok = false;
    report.reason = "the `pivot` cell is not a link";
  } else if (report.declaredScope !== "space") {
    // The rows are read from the space slot, so a link to any other scope
    // fails here rather than passing on whatever that slot holds.
    report.ok = false;
    report.reason = `the pivot link names scope ${report.declaredScope}`;
  } else if (Array.isArray(value)) {
    report.rows = value.length;
    // deno-lint-ignore no-explicit-any
    const rowIds = value.map((row: any) => linkOf(row)?.id).filter(Boolean);
    let mentioned = 0;
    let mentions = 0;
    const byTopic: Record<string, number> = {};
    for (const rowId of rowIds) {
      const row = documentOf(rowId)?.value;
      const topic = linkOf(row?.topic)?.id;
      const count = Array.isArray(row?.mentionedBy)
        ? row.mentionedBy.length
        : 0;
      if (topic !== undefined) byTopic[topic] = count;
      if (count > 0) mentioned++;
      mentions += count;
    }
    report.rowsResolved = Object.keys(byTopic).length;
    report.topicsMentioned = mentioned;
    report.mentions = mentions;
    report.ok = value.length > 0 &&
      Object.keys(byTopic).length === value.length;
    if (outPath) await Deno.writeTextFile(outPath, JSON.stringify(byTopic));
  } else {
    report.ok = false;
    report.reason = linkOf(value)
      ? `space slot holds a link (scope ${linkOf(value).scope ?? "space"})`
      : `space slot holds ${JSON.stringify(value)?.slice(0, 120)}`;
  }
}
console.log(JSON.stringify(report));
Deno.exit(report.ok ? 0 : 3);
