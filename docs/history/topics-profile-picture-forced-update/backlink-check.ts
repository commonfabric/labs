// Confirms, from a session that has not run any topic, that every topic on the
// board's pivot reads back as many backlinks as the pivot counts for it, none
// for an unmentioned topic, and that every rebound topic links the board's
// `crossrefs` at space scope.
//
//   deno run ... backlink-check.ts <board id> <pivot rows json> <rebind jsonl> <out.jsonl>
//
// The pivot rows file is `pivot-check.ts`'s map of topic id to mention count.
// API_URL, SPACE and CF_IDENTITY name the server; PIN_ROOT is the checkout.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { getCellValue, loadPieces } = await import(
  `${ROOT}/packages/cli/lib/piece.ts`
);

const [board, pivotPath, rebindPath, outPath] = Deno.args;
const expected: Record<string, number> = JSON.parse(
  await Deno.readTextFile(pivotPath),
);
const rebinds = (await Deno.readTextFile(rebindPath)).split("\n")
  .filter(Boolean).map((line) => JSON.parse(line));
const base = {
  apiUrl: Deno.env.get("API_URL")!,
  space: Deno.env.get("SPACE")!,
  identity: Deno.env.get("CF_IDENTITY")!,
};
// deno-lint-ignore no-explicit-any
let pieces: any;
const deps = {
  // deno-lint-ignore no-explicit-any
  loadPieces: async (c: any) => pieces ??= await loadPieces(c),
};

const out = await Deno.open(outPath, {
  create: true,
  truncate: true,
  write: true,
});
const encoder = new TextEncoder();
const totals = {
  rebound: rebinds.length,
  reboundAtSpace: 0,
  topics: 0,
  mentioned: 0,
  backlinksRight: 0,
  backlinksWrong: 0,
  errors: 0,
};
for (const rebind of rebinds) {
  if (
    rebind.error === undefined && rebind.linkId === board &&
    rebind.linkScope === null &&
    JSON.stringify(rebind.linkPath) === '["crossrefs"]'
  ) totals.reboundAtSpace++;
}
for (const [topic, count] of Object.entries(expected)) {
  totals.topics++;
  if (count > 0) totals.mentioned++;
  const row: Record<string, unknown> = { topic, expected: count };
  try {
    const value = await getCellValue(
      { ...base, piece: topic },
      ["referencedBy"],
      {},
      deps,
    );
    row.read = Array.isArray(value) ? value.length : null;
    if (row.read === count) totals.backlinksRight++;
    else totals.backlinksWrong++;
  } catch (error) {
    totals.errors++;
    row.error = String(error).slice(0, 300);
  }
  await out.write(encoder.encode(JSON.stringify(row) + "\n"));
}
out.close();
console.log(JSON.stringify(totals));
Deno.exit(
  totals.backlinksWrong === 0 && totals.errors === 0 &&
    totals.reboundAtSpace === totals.rebound
    ? 0
    : 3,
);
