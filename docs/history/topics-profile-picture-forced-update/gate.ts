// Opens the compatibility gate on exactly the retarget rows whose only
// incompatibility is the profile-picture narrowing, and on no others.
//
//   deno run ... gate.ts <plan in> <plan out> <report out> \
//     <candidate root> <candidate main> <variant root> <variant main>
//
// For every row that carries a retarget op, the update check runs (no writes)
// with the candidate source:
//
// - compatible: the row passes through unforced;
// - refused with the expected finding (a `picture` type narrowing, or the
//   `createdBy` union alternative that carries it) AND compatible with the
//   variant, which differs from the candidate only in typing the author's
//   `picture` as `unknown`: the row passes through with
//   `op.allowIncompatible`, the gate open for this one update;
// - anything else: the row is held, left out of the plan out, and the run
//   exits 3.
//
// The variant check is the decisive one: the candidate's refusal names only
// the first failing link, and the variant passing proves no other path of the
// piece is incompatible. Rows without an op pass through untouched.
//
// API_URL, SPACE and CF_IDENTITY name the server; PIN_ROOT is the checkout
// imports resolve against.

const ROOT = Deno.env.get("PIN_ROOT")!;
const { checkPiecePattern, loadPieces } = await import(
  `${ROOT}/packages/cli/lib/piece.ts`
);

const [
  planIn,
  planOut,
  reportOut,
  candidateRoot,
  candidateMain,
  variantRoot,
  variantMain,
] = Deno.args;

const EXPECTED = [
  /^piece source is incompatible with retained input: input link at [\w.]+ schema is not compatible: input link at [\w.]*\.picture: the candidate no longer accepts every previous type$/,
  /^piece source is incompatible with retained input: input link at [\w.]+ schema is not compatible: input link at [\w.]*\.createdBy: a schema alternative accepted previously is not accepted by the candidate$/,
];

const base = {
  apiUrl: Deno.env.get("API_URL")!,
  space: Deno.env.get("SPACE")!,
  identity: Deno.env.get("CF_IDENTITY")!,
};
// deno-lint-ignore no-explicit-any
let pieces: any;
const deps = {
  // deno-lint-ignore no-explicit-any
  loadPieces: async (config: any) => pieces ??= await loadPieces(config),
};

/** The update check's report for `piece` against one source. */
const check = (piece: string, rootPath: string, mainPath: string) =>
  checkPiecePattern(
    { ...base, piece: `of:${piece}` },
    { mainPath, rootPath },
    deps,
  );

const lines = (await Deno.readTextFile(planIn)).split("\n").filter(Boolean);
const [header, ...rows] = lines.map((line) => JSON.parse(line));
const kept: unknown[] = [header];
const report = await Deno.open(reportOut, {
  create: true,
  truncate: true,
  write: true,
});
const encoder = new TextEncoder();
const counts = { unforced: 0, forced: 0, held: 0, untouched: 0 };

for (const row of rows) {
  if (row.op === undefined) {
    kept.push(row);
    counts.untouched++;
    continue;
  }
  const entry: Record<string, unknown> = { piece: row.piece, phase: row.phase };
  try {
    const candidate = await check(row.piece, candidateRoot, candidateMain);
    entry.candidate = candidate.candidate.identity;
    if (candidate.compatible) {
      entry.gate = "unforced";
    } else if (!EXPECTED.some((pattern) => pattern.test(candidate.message))) {
      entry.gate = "held";
      entry.message = candidate.message;
    } else {
      entry.message = candidate.message;
      const variant = await check(row.piece, variantRoot, variantMain);
      entry.variant = variant.compatible ? "compatible" : variant.message;
      entry.gate = variant.compatible ? "forced" : "held";
    }
  } catch (error) {
    entry.gate = "held";
    entry.error = String(error).slice(0, 600);
  }
  if (entry.candidate !== undefined && entry.candidate !== row.op.patternIdentity) {
    // The source on disk no longer builds the identity the plan pinned.
    entry.gate = "held";
    entry.error = `candidate ${entry.candidate} is not the plan's ${row.op.patternIdentity}`;
  }
  counts[entry.gate as keyof typeof counts]++;
  if (entry.gate === "forced") {
    kept.push({ ...row, op: { ...row.op, allowIncompatible: true } });
  } else if (entry.gate === "unforced") {
    const { allowIncompatible: _, ...op } = row.op;
    kept.push({ ...row, op });
  }
  await report.write(encoder.encode(JSON.stringify(entry) + "\n"));
}
report.close();
await Deno.writeTextFile(
  planOut,
  kept.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
console.log(JSON.stringify(counts));
Deno.exit(counts.held === 0 ? 0 : 3);
