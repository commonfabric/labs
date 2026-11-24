import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";

// STATIC SWEEP — bypass guard for the type→TypeNode chokepoint.
//
// `typeToTypeNodeWithRegistry` (src/ast/type-building.ts) is the sanctioned way
// to convert a ts.Type into an emittable TypeNode: it normalizes commonfabric
// refs to `__cfHelpers.X` and registers the node in the typeRegistry. A raw
// `checker.typeToTypeNode(...)` call does neither, so any new raw call site is a
// latent source of two bug classes we've already hit:
//   1. inline `import("commonfabric").X` leaking into emitted type args
//   2. unregistered emitted nodes silently degrading generated schemas
//
// This test pins the exact set of raw call sites. When you add or remove one,
// this test fails — forcing a conscious choice: route it through the chokepoint,
// or add it here WITH a justification (it's genuinely internal-only / is the
// chokepoint's own implementation). The goal is that "raw typeToTypeNode" is
// always a reviewed decision, never an accident.
//
// NB: both bug classes share THIS producer set. The registry-degradation class
// can't be caught at the consumer (SchemaGenerator) — by the time a degraded
// node reaches it, the node has already been rewritten to an `unknown`-bearing
// form, indistinguishable from an intentional `unknown`. So the producer-side
// sweep below is the practical guard for the registry class too: migrating an
// emit-reaching site to the chokepoint closes BOTH the import-leak and the
// registry-degradation risk at once (the chokepoint normalizes AND registers).
// Entries that can emit a concrete (non-keyword) type are marked [emit+concrete].

const SRC_ROOT = fromFileUrl(new URL("../src/", import.meta.url));

// Each allowed raw call site, keyed by "relative/path.ts:line", with WHY it is
// allowed to bypass the chokepoint. Update deliberately.
const ALLOWED: Record<string, string> = {
  // The chokepoint's own implementation — this IS the sanctioned wrapper.
  "ast/type-building.ts":
    "chokepoint implementation (typeToTypeNodeWithRegistry)",
  // Internal-only: node is inspected for any/unknown and discarded, never emitted.
  // No emit, no registry consumer → neither bug class applies.
  "transformers/schema-injection.ts":
    "internal-only: node checked for any/unknown, not emitted",
  // Shared low-level helper with try/catch; callers that emit should prefer the
  // chokepoint. Tracked for migration in the universal phase.
  "ast/type-inference.ts":
    "[emit+concrete] low-level typeToTypeNode helper (try/catch); migrate emitting callers",
  // type-shrinking: the emit-reaching shrink paths were migrated to the
  // chokepoint. THREE raw calls remain, each genuinely special (not workarounds):
  //   - getArrayElementTypeNode (~1684): result feeds validateShrinkCoverage ->
  //     reportDiagnostic (validation, never emitted); its `undefined`-on-failure
  //     return is load-bearing for the caller's union-member iteration.
  //   - createIdentityOnlyNullishTypeNode (~2303): nullish-only types (no
  //     commonfabric refs possible) with a custom null-literal/undefined-keyword
  //     fallback, not the chokepoint's `unknown`.
  //   - identity-only union member (~2361): the node is INSPECTED
  //     (isCellLikeTypeNode / preservedWrapperFor) to build a fresh unknown-based
  //     replacement; never emitted directly.
  "transformers/type-shrinking.ts":
    "3 special sites: validation-only (undefined contract), nullish-only custom fallback, inspected-not-emitted",
};

Deno.test("raw checker.typeToTypeNode call sites match the reviewed allowlist", async () => {
  // file (relative) -> count of raw calls
  const found = new Map<string, number>();

  for await (
    const entry of walk(SRC_ROOT, {
      includeDirs: false,
      exts: [".ts"],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = relative(SRC_ROOT, entry.path);
    for (const line of content.split("\n")) {
      // Match `.typeToTypeNode(` but not our own wrapper name.
      if (/\.typeToTypeNode\(/.test(line)) {
        found.set(rel, (found.get(rel) ?? 0) + 1);
      }
    }
  }

  const foundFiles = [...found.keys()].sort();
  const allowedFiles = Object.keys(ALLOWED).sort();

  // Any file with raw calls that ISN'T allowlisted is a new bypass.
  const unexpected = foundFiles.filter((f) => !(f in ALLOWED));
  // Any allowlisted file that no longer has raw calls — stale entry to remove.
  const stale = allowedFiles.filter((f) => !found.has(f));

  assertEquals(
    { unexpected, stale },
    { unexpected: [], stale: [] },
    `Raw checker.typeToTypeNode call sites drifted from the allowlist.\n` +
      (unexpected.length
        ? `NEW bypasses (route through typeToTypeNodeWithRegistry, or allowlist ` +
          `with justification): ${unexpected.join(", ")}\n`
        : "") +
      (stale.length
        ? `STALE allowlist entries (no raw calls remain — remove them): ${
          stale.join(", ")
        }\n`
        : ""),
  );
});
