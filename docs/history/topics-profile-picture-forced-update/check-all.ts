// Runs the update check (no writes) of one source against many pieces in one
// session, and records every report.
//   deno run ... check-all.ts <out.jsonl> <root> <main> <ids file>
const ROOT = Deno.env.get("PIN_ROOT")!;
const { checkPiecePattern, loadPieces } = await import(
  `${ROOT}/packages/cli/lib/piece.ts`
);
const [outPath, rootPath, mainPath, idsPath] = Deno.args;
const ids = (await Deno.readTextFile(idsPath)).split("\n").filter(Boolean);
const base = {
  apiUrl: Deno.env.get("SCAN_API_URL")!,
  space: Deno.env.get("SCAN_SPACE")!,
  identity: Deno.env.get("CF_IDENTITY")!,
};
// deno-lint-ignore no-explicit-any
let pieces: any;
const deps = {
  // deno-lint-ignore no-explicit-any
  loadPieces: async (config: any) => pieces ??= await loadPieces(config),
};
const out = await Deno.open(outPath, { create: true, append: true, write: true });
const enc = new TextEncoder();
for (const id of ids) {
  const row: Record<string, unknown> = { id };
  const started = performance.now();
  try {
    const report = await checkPiecePattern(
      { ...base, piece: id },
      { mainPath, rootPath },
      deps,
    );
    row.compatible = report.compatible;
    if (!report.compatible) row.message = String(report.message).slice(0, 600);
    row.candidate = report.candidate.identity.slice(0, 8);
  } catch (error) {
    row.error = String(error).slice(0, 600);
  }
  row.ms = Math.round(performance.now() - started);
  await out.write(enc.encode(JSON.stringify(row) + "\n"));
}
out.close();
Deno.exit(0);
