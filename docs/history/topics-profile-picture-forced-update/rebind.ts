// Binds each topic's `boardCrossrefs` argument to the board's `crossrefs`
// output, the one-time link-bind `mentionable` got, and records what the
// topic's argument holds there afterwards. A topic whose argument does not then
// link the board's `crossrefs` at space scope fails, and so does its batch.
//
//   deno run ... rebind.ts <board id> <ids file> <out.jsonl>
//
// API_URL, SPACE and CF_IDENTITY name the server; PIN_ROOT is the checkout
// imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { linkPieces, loadPieces } = await import(
  `${ROOT}/packages/cli/lib/piece.ts`
);

const [board, idsPath, outPath] = Deno.args;
const ids = (await Deno.readTextFile(idsPath)).split("\n").filter(Boolean);
const config = {
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
  append: true,
  write: true,
});
const encoder = new TextEncoder();
let failed = 0;
for (const id of ids) {
  const row: Record<string, unknown> = { id };
  const started = performance.now();
  try {
    await linkPieces(config, board, ["crossrefs"], id, ["boardCrossrefs"], {
      start: false,
    }, deps);
    const cell = await pieces.getPieceCell(id, false);
    const argument = pieces.getArgument(cell);
    await argument.sync();
    const link = argument.getRaw()?.boardCrossrefs?.["/"]?.["link@1"];
    row.linkId = link?.id ?? null;
    row.linkScope = link?.scope ?? null;
    row.linkPath = link?.path ?? null;
    if (
      row.linkId !== board || row.linkScope !== null ||
      JSON.stringify(row.linkPath) !== '["crossrefs"]'
    ) {
      failed++;
      row.error =
        "boardCrossrefs does not link the board's crossrefs at space scope";
    }
  } catch (error) {
    failed++;
    row.error = String(error).slice(0, 400);
  }
  row.ms = Math.round(performance.now() - started);
  await out.write(encoder.encode(JSON.stringify(row) + "\n"));
}
out.close();
console.log(JSON.stringify({ rebound: ids.length - failed, failed }));
Deno.exit(failed === 0 ? 0 : 3);
