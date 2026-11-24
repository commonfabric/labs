import { assert, assertEquals } from "@std/assert";

import ts from "typescript";

import { CommonFabricTransformerPipeline } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { batchTypeCheckFixtures } from "./utils.ts";

/**
 * CT-1868 lineage regression — the hermetic, tracked form of the transform-time
 * lineage probe recorded in
 * `docs/history/packages/ts-transformers/APRIME-LINEAGE-HANDOFF.md` §3/§11.
 *
 * The transformer pipeline must arrive at BuilderCallHoisting with every
 * hoisted / authored builder call — its inner call AND its callback — still
 * carrying a recoverable AUTHORED source position. Before the fix these arrived
 * bare (`pos: -1`, no sourceMapRange, no original chain), so transform-time /
 * debug source resolution had nothing to read. The fix carries lineage across
 * the closure strategies, the expression-rewrite emitters and the
 * SchemaInjection rebuilds (see `preserveLineage` / `preserveSourceMapRange` in
 * `src/ast/utils.ts` — sourceMapRange is the carrier; the SchemaInjection
 * rebuilds stay `create*` and wrap in `preserveSourceMapRange`).
 *
 * This drives the REAL pipeline over a multi-origin fixture, then checks the
 * transformed AST three ways (each closing a review-found gap):
 *   1. per-{tag, role} recovery — every hoisted const, in-place authored
 *      builder, and export-default call/callback recovers a position;
 *   2. per-tag CONTENT binding — each hoist's recovered text must contain its
 *      OWN origin's distinctive marker, claimed exactly once (a global
 *      any-marker check would let permuted anchors pass, because the
 *      export-default span contains every marker);
 *   3. rewritten-SITE recovery — the post-hoist call sites
 *      (`__cfLift_N(...)` / `__cfHandler_N(...)` applications and the
 *      `*WithPattern(__cfPattern_N, …)` enclosing calls) must recover to the
 *      SAME origin as their hoisted const, pinning the outer-call lineage the
 *      full-`preserveLineage` sites (lift-applied outer, mapWithPattern) and
 *      the capture-scaffold outer carry.
 * Recovery mirrors the probe's precedence (own position → own sourceMapRange →
 * original-chain terminal); CONTENT is the ground truth — a position pointing
 * at the wrong text is still broken lineage.
 *
 * Bite matrix (verified by reverting each fix file to its pre-fix state):
 * pattern-builder, capture-scaffold, array-method-transform and
 * schema-injection each individually FAIL this test when reverted. Known
 * boundary: rewrite-helpers' zero-input wrapper branch
 * (`createReactiveWrapperForExpression`'s non-input-bound path) is NOT
 * position-pinned here — a corpus-wide probe shows it firing for branch-root
 * shapes with non-destructured pattern input (e.g. jsx-direct-branch-roots'
 * `!state.task.done`), which resisted reproduction in this destructured-input
 * fixture; its preservations are kept §6a-symmetric and should get a direct
 * unit pin alongside CT-1870's injection acceptance.
 */

// One authored builder per origin path, each with a distinctive authored
// snippet so a recovered position can be matched back to where it was written:
//   ORIGIN-C  module-scope handler, applied in JSX   → in-place authored handler
//   ORIGIN-A  computed() with a capture              → LiftApplied → __cfLift
//   ORIGIN-N  computed() template for NAME           → LiftApplied → __cfLift
//   ORIGIN-B  inline reactive binary expr in JSX     → expression-site → __cfLift
//   ORIGIN-F  inline negation of a reactive property access in JSX →
//             zero-input reactive wrapper (rewrite-helpers' non-input-bound
//             branch) → __cfLift
//   ORIGIN-G  pattern-body binary over a dynamic opaque access → __cfLift
//   ORIGIN-E  inline captured action in JSX          → handler scaffold → __cfHandler
//   ORIGIN-D  .map with an element callback in JSX   → array-method → __cfPattern
const FIXTURE = `import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface ProbeInput {
  count: number | Default<0>;
  flag: boolean | Default<false>;
  task: { done: boolean };
  label: string | Default<"probe">;
  items: string[] | Default<[]>;
}

// ORIGIN-C: authored module-scope handler
const bump = handler<unknown, { count: Writable<number> }>((_, state) => {
  state.count.set(state.count.get() + 1);
});

export default pattern<ProbeInput>(({ count, flag, label, items, task }) => {
  // ORIGIN-A: authored computed with a capture
  const doubled = computed(() => count * 2);
  // ORIGIN-G: binary over a dynamic opaque access — the zero-input wrapper
  const pick = items[count] + "!";
  return {
    // ORIGIN-N: authored computed template
    [NAME]: computed(() => \`probe \${label}\`),
    [UI]: (
      <div>
        {/* ORIGIN-B: inline reactive binary expression */}
        <span>{count * 3}</span>
        {/* ORIGIN-F: branch-root negation of a reactive property access */}
        <i>{flag || !task.done ? "on" : "off"}</i>
        <b>{doubled}</b>
        <em>{pick}</em>
        <ul>
          {/* ORIGIN-D: array map with element callback */}
          {items.map((item) => <li>{item}</li>)}
        </ul>
        <cf-button onClick={bump({ count })}>bump</cf-button>
        {/* ORIGIN-E: inline captured action */}
        <cf-button onClick={action(() => count * 4)}>quad</cf-button>
      </div>
    ),
    count,
    flag,
    label,
    items,
    task,
  };
});
`;

/**
 * Best-available authored position for a (possibly synthetic) node, mirroring
 * the probe's recovery precedence: the node's own text range, else its explicit
 * sourceMapRange, else the terminal of its original-node chain. Returns
 * undefined when none of the three yields a real (`>= 0`) position — i.e.
 * broken lineage.
 */
function recoverPosition(
  node: ts.Node,
): { pos: number; end: number } | undefined {
  if (node.pos >= 0) return { pos: node.pos, end: node.end };

  // ts.getSourceMapRange returns the node itself when no explicit range is set.
  const smr = ts.getSourceMapRange(node);
  if ((smr as unknown) !== (node as unknown) && smr.pos >= 0) {
    return { pos: smr.pos, end: smr.end };
  }

  const original = ts.getOriginalNode(node);
  if (original !== node && original.pos >= 0) {
    return { pos: original.pos, end: original.end };
  }
  return undefined;
}

function findCallbackArgument(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return call.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
}

interface BuilderSite {
  readonly tag: string;

  /** The builder call whose authored position must be recoverable. For a
   * hoisted `const __cfLift_N = __cfHelpers.lift(...)` this is the INNER
   * call; for a top-level authored builder it is the call itself. */
  readonly call: ts.CallExpression;

  readonly callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
}

const HOISTED_NAME = /^__cf(Lift|Pattern|Handler)_\d+$/;

/**
 * Every hoisted builder-artifact const (`const __cf{Lift,Pattern,Handler}_N =
 * <builder call>`), every top-level authored builder const, and the
 * `export default <builder call>`. This is exactly the set
 * BuilderCallHoistingTransformer visits and that transform-time source
 * injection will read.
 */
function collectBuilderSites(root: ts.SourceFile): BuilderSite[] {
  const sites: BuilderSite[] = [];

  for (const stmt of root.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) && decl.initializer &&
          ts.isCallExpression(decl.initializer)
        ) {
          const name = decl.name.text;
          // Hoisted synthetics plus the authored module-scope `bump` handler.
          if (HOISTED_NAME.test(name) || name === "bump") {
            sites.push({
              tag: name,
              call: decl.initializer,
              callback: findCallbackArgument(decl.initializer),
            });
          }
        }
      }
    }

    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      let expr = stmt.expression;
      while (
        ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
        ts.isSatisfiesExpression(expr)
      ) {
        expr = expr.expression;
      }
      if (ts.isCallExpression(expr)) {
        sites.push({
          tag: "export-default",
          call: expr,
          callback: findCallbackArgument(expr),
        });
      }
    }
  }

  return sites;
}

/**
 * The rewritten post-hoist call SITES, keyed by the hoisted name they
 * reference: `__cfLift_N(captures)` / `__cfHandler_N(captures)` applications
 * (hoisted name as callee) and `receiver.*WithPattern(__cfPattern_N, …)`
 * enclosing calls (hoisted name in argument position). These are the nodes the
 * outer-call preservations (lift-applied outer, capture-scaffold outer,
 * mapWithPattern rebuild) exist for — a collector that only reads the hoisted
 * consts leaves those anchors unguarded (review finding on CT-1868).
 */
function collectRewrittenSites(
  root: ts.SourceFile,
): Map<string, ts.CallExpression> {
  const sites = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        HOISTED_NAME.test(node.expression.text)
      ) {
        if (!sites.has(node.expression.text)) {
          sites.set(node.expression.text, node);
        }
      } else {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && HOISTED_NAME.test(arg.text)) {
            if (!sites.has(arg.text)) sites.set(arg.text, node);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return sites;
}

async function transformFixtureToAst(): Promise<{
  transformed: ts.SourceFile;

  /** The pre-transform source file, whose text the recovered positions index
   * into (it carries the `transformCfDirective` helper-import prelude). */
  original: ts.SourceFile;
}> {
  const fileName = "/ct1868-lineage-fixture.tsx";
  // Reuse the shared harness to build a program with the commonfabric + env
  // type definitions (and the `transformCfDirective` helper-import prelude).
  const { program } = await batchTypeCheckFixtures(
    { [fileName]: FIXTURE },
    { types: COMMONFABRIC_TYPES },
  );
  const original = program.getSourceFile(fileName);
  assert(original, "fixture source file present in program");

  const pipeline = new CommonFabricTransformerPipeline();
  const result = ts.transform(original, pipeline.toFactories(program));
  const transformed = result.transformed[0];
  assert(transformed, "pipeline returned a transformed source file");
  // NB: do NOT dispose the result yet — disposal can clear the emit-node data
  // that holds sourceMapRange, which recoverPosition reads.
  return { transformed, original };
}

/** Distinctive authored markers for the hoisted-lift origins. Each hoisted
 * lift must claim exactly one, and collectively all must be claimed — the
 * per-tag binding a single global containment check cannot provide (the
 * export-default span contains all of them). */
const LIFT_MARKERS = [
  "count * 2", // ORIGIN-A
  "probe ${label}", // ORIGIN-N
  "count * 3", // ORIGIN-B
  "!task.done", // ORIGIN-F (zero-input wrapper route)
  'items[count] + "!"', // ORIGIN-G (pattern-body initializer)
];

Deno.test(
  "CT-1868: builder lineage recovers authored positions at the hoisting stage",
  async () => {
    const { transformed, original } = await transformFixtureToAst();
    const sourceText = original.text;

    const sites = collectBuilderSites(transformed);
    const rewritten = collectRewrittenSites(transformed);

    // Sanity: the fixture must actually exercise every origin path, or a
    // silent pipeline change (e.g. a builder no longer hoisting) would
    // vacuously pass.
    const tags = sites.map((s) => s.tag);
    assert(
      tags.filter((t) => t.startsWith("__cfLift_")).length >= 5,
      `expected >= 5 hoisted lifts (ORIGIN-A/N/B/F/G), got: ${tags.join(", ")}`,
    );
    assert(
      tags.some((t) => t.startsWith("__cfPattern_")),
      `expected a hoisted pattern (ORIGIN-D), got: ${tags.join(", ")}`,
    );
    assert(
      tags.some((t) => t.startsWith("__cfHandler_")),
      `expected a hoisted handler (ORIGIN-E inline action), got: ${
        tags.join(", ")
      }`,
    );
    assert(tags.includes("bump"), "expected the authored `bump` handler");
    assert(
      tags.includes("export-default"),
      "expected the export-default pattern",
    );

    const recoveredByTag = new Map<string, string>();
    const recover = (tag: string, role: string, node: ts.Node): string => {
      const pos = recoverPosition(node);
      assert(
        pos,
        `${tag} ${role}: reached the hoisting stage with no recoverable ` +
          `authored position (broken lineage)`,
      );
      return sourceText.slice(pos.pos, pos.end);
    };

    // 1 + 2. Per-{tag, role} recovery AND per-tag content binding.
    const claimedLiftMarkers = new Map<string, string>();
    for (const site of sites) {
      const callText = recover(site.tag, "call", site.call);
      recoveredByTag.set(site.tag, callText);

      if (site.tag !== "export-default") {
        assert(site.callback, `${site.tag}: expected a callback argument`);
      }
      const callbackText = site.callback
        ? recover(site.tag, "callback", site.callback)
        : undefined;

      if (site.tag.startsWith("__cfLift_")) {
        const markers = LIFT_MARKERS.filter((m) => callText.includes(m));
        assertEquals(
          markers.length,
          1,
          `${site.tag}: recovered call text must contain exactly one lift ` +
            `origin marker, got [${markers.join(", ")}] in: ${callText}`,
        );
        const marker = markers[0]!;
        assert(
          !claimedLiftMarkers.has(marker),
          `${site.tag}: origin marker "${marker}" already claimed by ${
            claimedLiftMarkers.get(marker)
          } — permuted anchors`,
        );
        claimedLiftMarkers.set(marker, site.tag);
        if (callbackText !== undefined) {
          assert(
            callbackText.includes(marker),
            `${site.tag} callback: recovered text should carry the same ` +
              `origin marker "${marker}", got: ${callbackText}`,
          );
        }
      } else if (site.tag.startsWith("__cfHandler_")) {
        assert(
          callText.includes("count * 4"),
          `${site.tag}: expected the ORIGIN-E action body, got: ${callText}`,
        );
      } else if (site.tag.startsWith("__cfPattern_")) {
        assert(
          callText.includes("(item) =>"),
          `${site.tag}: expected the ORIGIN-D map callback, got: ${callText}`,
        );
      } else if (site.tag === "bump") {
        assert(
          callbackText !== undefined &&
            callbackText.includes("state.count.set"),
          `bump callback: expected the authored handler body, got: ${callbackText}`,
        );
      } else if (site.tag === "export-default") {
        assert(
          callText.includes("count, flag, label, items, task"),
          `export-default: expected the authored pattern call, got: ${callText}`,
        );
      }
    }
    assertEquals(
      claimedLiftMarkers.size,
      LIFT_MARKERS.length,
      `every lift origin must be claimed by exactly one hoist; claimed: ${
        [...claimedLiftMarkers.keys()].join(", ")
      }`,
    );

    // 3. Rewritten post-hoist SITES: each must recover, and to the SAME
    // origin as its hoisted const.
    for (const site of sites) {
      if (!HOISTED_NAME.test(site.tag)) continue;
      const siteCall = rewritten.get(site.tag);
      assert(
        siteCall,
        `${site.tag}: no rewritten call site found referencing the hoist`,
      );
      const siteText = recover(`site:${site.tag}`, "call", siteCall);
      const hoistText = recoveredByTag.get(site.tag)!;
      const sharedMarker = [...LIFT_MARKERS, "count * 4", "(item) =>"].find(
        (m) => hoistText.includes(m),
      );
      assert(sharedMarker, `${site.tag}: hoist text carries no known marker`);
      assert(
        siteText.includes(sharedMarker),
        `site:${site.tag}: rewritten site recovered to a different origin ` +
          `than its hoist (expected marker "${sharedMarker}"), got: ${siteText}`,
      );
    }
  },
);
