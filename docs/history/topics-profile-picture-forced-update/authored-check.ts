// The authored-content check for the kept-activity rollout, read offline from
// the pristine and working stores:
//
// - every Topic's argument document may differ only in the three fields the
//   migration keeps (`topicStateVersion`, `commentCount`, `lastActivityAt`)
//   and in `boardCrossrefs`, which the rollout rebinds and which must then
//   link the board's `crossrefs` at space scope;
// - every document a Topic's `comments` or `links` argument links to (each
//   comment and link record) must be unchanged;
// - the board's argument document is reported field by field.
//
//   deno run ... authored-check.ts <pristine db> <working db> <plan.jsonl> <out.jsonl>
//
// The plan is a survey of the board's topics; its rows name the pieces, the
// board among them as the `holder` row.
// PIN_ROOT is the checkout imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { openSpace } = await import(`${ROOT}/packages/state-inspector/db.ts`);
const { getValueAt } = await import(
  `${ROOT}/packages/state-inspector/reconstruct.ts`
);
const { fabricAwareEqual } = await import(
  `${ROOT}/packages/data-model/src/index.ts`
);

const KEPT = new Set([
  "topicStateVersion",
  "commentCount",
  "lastActivityAt",
  "boardCrossrefs",
]);
const [pristinePath, workingPath, planPath, outPath] = Deno.args;
const pristine = openSpace(pristinePath);
const working = openSpace(workingPath);
const rows = (await Deno.readTextFile(planPath)).split("\n").filter(Boolean)
  .slice(1).map((line) => JSON.parse(line));
const board = `of:${rows.find((row) => row.phase === "holder")?.piece}`;

// deno-lint-ignore no-explicit-any
const valueOf = (space: any, id: string) => {
  const at = getValueAt(space, { id, scope: "space", branch: "" });
  return at.pathExists ? at.document.value : undefined;
};
// A piece's own document keeps its fields (`argument` among them) beside
// `value` rather than inside it.
// deno-lint-ignore no-explicit-any
const documentOf = (space: any, id: string) =>
  getValueAt(space, { id, scope: "space", branch: "" }).document;
// deno-lint-ignore no-explicit-any
const linkId = (value: any): string | undefined => value?.["/"]?.["link@1"]?.id;
// deno-lint-ignore no-explicit-any
const changedKeys = (before: any, after: any): string[] =>
  [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => !fabricAwareEqual(before?.[key], after?.[key])).sort();

const out = await Deno.open(outPath, {
  create: true,
  truncate: true,
  write: true,
});
const encoder = new TextEncoder();
const totals = {
  topics: 0,
  argumentsWithOnlyKeptChanges: 0,
  argumentsWithOtherChanges: 0,
  records: 0,
  recordsChanged: 0,
  recordsMissing: 0,
  boardCrossrefsWrong: 0,
  errors: 0,
};

for (const row of rows) {
  const piece = `of:${row.piece}`;
  const entry: Record<string, unknown> = { piece, phase: row.phase };
  try {
    const argId = linkId(documentOf(working, piece)?.argument);
    if (argId === undefined) throw new Error("no argument link");
    if (linkId(documentOf(pristine, piece)?.argument) !== argId) {
      throw new Error("argument link moved");
    }
    const before = valueOf(pristine, argId);
    const after = valueOf(working, argId);
    const changed = changedKeys(before, after);
    entry.argument = argId;
    entry.changed = changed;
    if (row.phase === "topics") {
      totals.topics++;
      const other = changed.filter((key) => !KEPT.has(key));
      if (other.length === 0) totals.argumentsWithOnlyKeptChanges++;
      else {
        totals.argumentsWithOtherChanges++;
        entry.other = other;
      }
      const crossrefs = after?.boardCrossrefs?.["/"]?.["link@1"];
      if (
        crossrefs?.id !== board || (crossrefs.scope ?? "space") !== "space" ||
        JSON.stringify(crossrefs.path) !== '["crossrefs"]'
      ) {
        totals.boardCrossrefsWrong++;
        entry.boardCrossrefs = crossrefs ?? null;
      }
      const recordIds = [...(before?.comments ?? []), ...(before?.links ?? [])]
        .map(linkId).filter((id): id is string => id !== undefined);
      // A record missing from either store is a failure in its own right: two
      // absent values compare equal, and must not pass as unchanged.
      const recordsMissing = recordIds.filter((id) =>
        valueOf(pristine, id) === undefined ||
        valueOf(working, id) === undefined
      );
      const recordsChanged = recordIds.filter((id) =>
        !recordsMissing.includes(id) &&
        !fabricAwareEqual(valueOf(pristine, id), valueOf(working, id))
      );
      totals.records += recordIds.length;
      totals.recordsChanged += recordsChanged.length;
      totals.recordsMissing += recordsMissing.length;
      entry.records = recordIds.length;
      if (recordsChanged.length > 0) entry.recordsChanged = recordsChanged;
      if (recordsMissing.length > 0) entry.recordsMissing = recordsMissing;
    }
  } catch (error) {
    totals.errors++;
    entry.error = String(error).slice(0, 300);
  }
  await out.write(encoder.encode(JSON.stringify(entry) + "\n"));
}
out.close();
console.log(JSON.stringify(totals));
Deno.exit(
  totals.argumentsWithOtherChanges === 0 && totals.recordsChanged === 0 &&
    totals.recordsMissing === 0 && totals.boardCrossrefsWrong === 0 &&
    totals.errors === 0
    ? 0
    : 3,
);
