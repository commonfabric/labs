/**
 * Audit probe: which owner names does call-kind's array-method detection
 * actually see across real fixture compilations?
 *
 * Background: `OPAQUE_REF_OWNER_NAMES` (OpaqueRefMethods / OpaqueRef) matches
 * method-declaration owners from the pre-#3153 api shape. `OpaqueRefMethods`
 * no longer exists in api, and `OpaqueRef<T> = T` is an identity alias that
 * can't own method declarations — so the suspicion is the set never matches
 * in production and is kept green only by harness simulations. Meanwhile
 * array methods on branded receivers live on `IDerivable` (via OpaqueCell),
 * which is in NEITHER owner set — a possible live gap.
 *
 * This probe runs the full transformer pipeline on every fixture input with
 * temporary instrumentation in `isMethodDeclarationOwnedBy` (call-kind.ts)
 * recording (method, owner, set, matched) for every owner check whose method
 * name is a known array-method name.
 *
 * Usage (from base/ts-transformers, with the instrumentation in place):
 *   deno run -A test/diagnostics/probe-array-method-owner-names.ts
 *   deno run -A test/diagnostics/probe-array-method-owner-names.ts <substr>
 *
 * The instrumentation is not committed; re-apply it in
 * `isMethodDeclarationOwnedBy` (call-kind.ts) after `findOwnerName`:
 *
 *   const probe = (globalThis as {
 *     __cfProbeOwnerRecords?: Array<
 *       { method: string; owner: string; set: string; matched: boolean }
 *     >;
 *   }).__cfProbeOwnerRecords;
 *   if (probe) {
 *     probe.push({
 *       method: declaration.name.text,
 *       owner: owner ?? "<none>",
 *       set: ownerNames === ARRAY_OWNER_NAMES ? "arrayOwners" : "other",
 *       matched: !!owner && ownerNames.has(owner),
 *     });
 *   }
 *
 * Output: TSV on stdout (one row per owner check). Summary on stderr.
 *
 * Diagnostic; not a test. Safe to delete once the owner-set question closes.
 */

import { join } from "@std/path";
import { walk } from "@std/fs";

import { transformSource } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

const FIXTURE_ROOT = join(import.meta.dirname!, "..", "fixtures");

interface OwnerRecord {
  method: string;
  owner: string;
  set: string;
  matched: boolean;
}

async function loadFixtureFiles(
  match?: string,
): Promise<Array<{ rel: string; text: string }>> {
  const out: Array<{ rel: string; text: string }> = [];
  for await (const entry of walk(FIXTURE_ROOT, { exts: [".tsx", ".ts"] })) {
    if (!entry.isFile) continue;
    if (
      !entry.name.endsWith(".input.tsx") && !entry.name.endsWith(".input.ts")
    ) continue;
    const rel = entry.path.slice(FIXTURE_ROOT.length + 1);
    if (match && !rel.includes(match)) continue;
    out.push({ rel, text: await Deno.readTextFile(entry.path) });
  }
  return out;
}

async function main() {
  const matchArg = Deno.args[0];
  const files = await loadFixtureFiles(matchArg);
  console.error(`Loaded ${files.length} fixture(s).`);

  const records: Array<OwnerRecord & { fixture: string }> = [];
  const sink: OwnerRecord[] = [];
  (globalThis as { __cfProbeOwnerRecords?: OwnerRecord[] })
    .__cfProbeOwnerRecords = sink;

  let processed = 0;
  let transformFailures = 0;

  for (const file of files) {
    processed++;
    const before = sink.length;
    try {
      await transformSource(file.text, { types: COMMONFABRIC_TYPES });
    } catch (err) {
      transformFailures++;
      console.error(
        `[skip] ${file.rel}: transform failed: ${
          (err as Error).message?.slice(0, 80)
        }`,
      );
      continue;
    }
    for (const rec of sink.slice(before)) {
      records.push({ ...rec, fixture: file.rel });
    }
  }

  console.log("fixture\tmethod\towner\tset\tmatched");
  for (const r of records) {
    console.log(
      `${r.fixture}\t${r.method}\t${r.owner}\t${r.set}\t${r.matched}`,
    );
  }

  const byKey = new Map<string, number>();
  for (const r of records) {
    const key = `${r.set}\towner=${r.owner}\tmatched=${r.matched}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  console.error(
    `\nProcessed ${processed}, transform failures ${transformFailures}.`,
  );
  console.error(`Total owner checks recorded: ${records.length}`);
  for (const [key, count] of [...byKey.entries()].sort()) {
    console.error(`  ${key}\tcount=${count}`);
  }
  const opaqueMatches = records.filter(
    (r) => r.set === "opaqueRefOwners" && r.matched,
  );
  console.error(
    opaqueMatches.length === 0
      ? "\nVERDICT: OPAQUE_REF_OWNER_NAMES never matched on any fixture compilation."
      : `\nVERDICT: OPAQUE_REF_OWNER_NAMES matched ${opaqueMatches.length} time(s).`,
  );
}

await main();
