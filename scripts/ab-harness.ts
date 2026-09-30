// deno-lint-ignore-file no-explicit-any cf-imports/no-inline-module-import --
// The point of this file is to load the SAME modules from two checkouts whose
// types differ, and where a member may not even be spelled the same in both.
// Typing the dynamic imports to either tree defeats the comparison, and only a
// dynamic import can name a module by a path built from CF_ROOT. The two
// imports that do name a module outright are ordered too: the logger names are
// claimed before anything else can construct one disabled.

/**
 * A/B harness: runs the same probes against two checkouts and diffs the
 * output, so a change to serialization can be judged by what it writes rather
 * than by whether the suite is green.
 *
 * Usage (one tree at a time; diff the two outputs):
 *
 *   CF_ROOT=<worktree> deno run --allow-all --config <worktree>/deno.jsonc ab-harness.ts [probe...]
 *
 * Probes: `encoded` (the bytes a pattern reaches storage as), `liveness`
 * (functions surviving into an emitted graph, reported by path shape), and
 * `provenance` (trust / entry ref / derivation chain across copies). Default:
 * all three. Each has been red for a real defect; a probe that has only ever
 * passed reports nothing and does not belong here.
 *
 * `CF_FIXTURE` selects the pattern source the real-pattern probes compile.
 * Use a REAL one: a hand-built fixture cannot exhibit a bug it has no shape
 * for, and every wrong "verified" on this work came from measuring one.
 *
 * Every line is `key: value`; a value that differs between two runs is the
 * finding. Nothing here asserts -- it reports, because what counts as correct
 * is the comparison, not any single run.
 */

const ROOT = Deno.env.get("CF_ROOT");
if (!ROOT) {
  console.error("set CF_ROOT to a checkout root");
  Deno.exit(2);
}
const R = `${ROOT}/packages/runner/src`;
const want = new Set(
  Deno.args.length ? Deno.args : ["encoded", "liveness", "provenance"],
);

// Claim the logger names that would otherwise be constructed disabled, so an
// error-level report on those paths is actually visible.
const { getLogger } = await import("@commonfabric/utils/logger");
for (const n of ["ensure-piece-running", "runner", "scheduler", "sandbox"]) {
  getLogger(n, { enabled: true, level: "debug" });
}

const { Identity } = await import("@commonfabric/identity");
const { StorageManager } = await import(`${R}/storage/cache.deno.ts`);
const { Runtime } = await import(`${R}/runtime.ts`);
const { pattern, pushFrame, popFrame } = await import(
  `${R}/builder/pattern.ts`
);
const { lift } = await import(`${R}/builder/module.ts`);
// The encodable-form builders, under whichever PATH the tree spells them. The
// two checkouts this runs against may disagree, and naming one would make the
// harness unable to measure the very rename it is checking.
const ju: any = await (async () => {
  try {
    return await import(`${R}/builder/to-encodable-form.ts`);
  } catch {
    return await import(`${R}/builder/json-utils.ts`);
  }
})();
const md: any = await import(`${R}/builder/pattern-metadata.ts`);
// The deep converter, under whichever NAME the tree spells it, for the same
// reason as the encodable-form builders above.
const dm: any = await import("@commonfabric/data-model");
const fabricFromConvertibleJsValue = dm.fabricFromConvertibleJsValue ??
  dm.fabricFromNativeValue;
const { dataUriFromValue } = await import(
  "@commonfabric/data-model/codec-data-uri"
);

/** Identity on a tree with no preflight, so the same probe runs on both. */
let flatten: (v: unknown) => unknown = (v) => v;

try {
  flatten = (await import(`${R}/storage-preflight.ts`)).flattenBuilderArtifacts;
} catch { /* baseline */ }

/**
 * A pattern's serializer, under whichever name the tree spells it. The two
 * checkouts this runs against may disagree, and asking by one name would report
 * a failure in whichever tree uses the other.
 */
const patternForm = (pattern: unknown): unknown =>
  (ju.patternToEncodableForm ?? ju.patternToJSON)(pattern as any);

const say = (k: string, v: unknown) => console.log(`${k}: ${v}`);
const encoded = (v: unknown) => {
  try {
    return dataUriFromValue(fabricFromConvertibleJsValue(v));
  } catch (e) {
    return `THREW ${(e as Error).message}`;
  }
};

const signer = await Identity.fromPassphrase("test operator");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("file:///ab-harness"),
  storageManager,
});

// A three-deep ref-less pattern, plus a sibling lift node at the top.
const frame = pushFrame({ runtime } as never);
const double = lift((x: number) => x * 2);
const Leaf = pattern(({ n }: any) => ({ out: double(n) }));
const Mid = pattern(({ n }: any) => ({ leaf: Leaf({ n }) }));
const Top = pattern(({ n }: any) => ({
  mid: Mid({ n }),
  direct: double(n),
}));

// A REAL pattern, compiled from repo source by a standalone Engine: no entry
// ref, so the pattern serializer takes the GRAPH branch, and its nodes carry
// artifacts in positions a hand-built fixture does not have (`inputs.op`).
// A synthetic fixture cannot exhibit what it has no shape for; every claim
// below is made against this one.
const { Engine } = await import(`${R}/harness/engine.ts`);
const { resolveLocalProgram } = await import(
  "@commonfabric/runner/local-program.deno"
);
const FIXTURE = Deno.env.get("CF_FIXTURE") ??
  `${ROOT}/packages/patterns/factory-outputs/parking-coordinator/main.test.tsx`;
const engine = new Engine(runtime);
const realProgram = await resolveLocalProgram(
  (resolver) => engine.resolve(resolver),
  { main: FIXTURE, root: ROOT },
);
const Real: any = (await engine.compileAndEvaluateModules(realProgram)).main
  ?.default;

if (want.has("encoded")) {
  say("encoded/refless-graph", encoded(flatten(patternForm(Top as any))));
  say("encoded/refless-factory", encoded(flatten(Top)));
  say("encoded/refless-graph-raw", encoded(patternForm(Top as any)));
  say("encoded/depth1-graph", encoded(flatten(patternForm(Leaf as any))));
  say("encoded/real-graph", encoded(flatten(patternForm(Real))));
  say("encoded/real-factory", encoded(flatten(Real)));
}

if (want.has("liveness")) {
  // A module still carrying a serializer has not been serialized; at the
  // boundary that is a live object on its way to storage.
  const scan = (nodes: any[], d: number, acc: string[]): string[] => {
    for (const n of nodes ?? []) {
      const m = n?.module;
      if (
        typeof m?.toEncodableForm === "function" ||
        typeof m?.toJSON === "function"
      ) {
        acc.push(`d${d}:${m.type}`);
      }
      const impl = m?.implementation;
      if (impl && typeof impl === "object" && Array.isArray(impl.nodes)) {
        scan(impl.nodes, d + 1, acc);
      }
    }
    return acc;
  };
  const live = scan((patternForm(Top as any) as any).nodes, 1, []);
  say("liveness/synthetic-boundary", live.length ? live.join(",") : "none");

  // Position-agnostic: any function anywhere in the emitted form is something
  // the graph serializer did not reach. Reported by PATH SHAPE (indices
  // elided) so two runs are comparable and a new route is legible.
  const shapes = (root: unknown) => {
    const found = new Map<string, number>();
    const seen = new Set<unknown>();
    const walk = (v: any, path: string) => {
      if (v === null || (typeof v !== "object" && typeof v !== "function")) {
        return;
      }
      if (typeof v === "function") {
        found.set(path, (found.get(path) ?? 0) + 1);
        return;
      }
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) {
        walk(v[k], `${path}.${Number.isInteger(+k) ? "#" : k}`);
      }
    };
    walk(root, "$");
    return found;
  };
  for (
    const [label, value] of [
      ["real-boundary", patternForm(Real)],
      ["real-boundary-flattened", flatten(patternForm(Real))],
    ] as const
  ) {
    const found = shapes(value);
    const total = [...found.values()].reduce((a, b) => a + b, 0);
    say(
      `liveness/${label}`,
      total === 0
        ? "none"
        : `${total} in ${found.size} shapes: ${
          [...found.keys()].sort().join(" ")
        }`,
    );
  }
}

if (want.has("provenance")) {
  // Trust, the entry ref, and the derivation chain live in identity-keyed side
  // tables (`pattern-metadata.ts`), so they are invisible to hashing and to
  // any comparison of written bytes. A copy that never reaches
  // `noteDerivedCopy` answers nothing to all three.
  const ask = (k: string, v: unknown) =>
    say(
      `provenance/${k}`,
      `entryRef=${JSON.stringify(md.getArtifactEntryRef(v) ?? null)}` +
        ` trustedPattern=${md.isTrustedPattern(v)}` +
        ` trustedArtifact=${md.isTrustedBuilderArtifact(v)}` +
        ` derives=${md.resolveOriginal(v) !== v}`,
    );
  const boundary: any = patternForm(Top as any);
  ask("live-factory", Top);
  ask("flattened-factory", flatten(Top));
  ask("boundary-graph", boundary);
  ask("live-node0-module", (Top as any).nodes?.[0]?.module);
  ask("live-node0-subgraph", (Top as any).nodes?.[0]?.module?.implementation);
  ask("boundary-node0-module", boundary.nodes?.[0]?.module);
  ask("boundary-node0-subgraph", boundary.nodes?.[0]?.module?.implementation);
  const realBoundary: any = patternForm(Real);
  ask("real-boundary-node0-module", realBoundary.nodes?.[0]?.module);
  ask(
    "real-boundary-node0-subgraph",
    realBoundary.nodes?.[0]?.module?.implementation,
  );
}
popFrame(frame);

await runtime.dispose();
await storageManager.close();
