/**
 * Mergeable Push Validation Transformer
 *
 * Flags a handler that reads a collection (an explicit `.get()` or an
 * iteration) and mergeable-`push`es to that same collection, when the read
 * actually matters to the push.
 *
 * A mergeable `push` commits as a tail-relative `append` and drops the op's own
 * array read from conflict detection so disjoint appends merge. An explicit
 * read of the same collection stays in the conflict set, so two concurrent
 * appends conflict and the loser retries. The capability analysis classifies
 * how the read relates to the push, and the diagnostic says the matching
 * thing:
 *
 * - `read-dependent-push` — the push depends on the read through a guard (the
 *   dedup-then-push shape) or through the pushed value. The intent is better
 *   expressed as an identity-addressed `addUnique` (no retry) for a uniqueness
 *   condition, or a read-modify-write `set` for other content-dependent
 *   appends.
 * - `independent-read-modify-write` — the read feeds a different write to the
 *   same collection (the append-then-trim shape). The append still forfeits
 *   merging; the remedy is to keep the independent read-modify-write in its
 *   own handler.
 *
 * A read unrelated to both the push and any sibling write is not reported: the
 * append does forfeit merging, but there is usually no better expression, so
 * warning would be noise. It is a warning, not an error: the shape stays safe
 * today (the kept read forces the retry), so this nudges toward the better
 * expression without failing the build.
 */

import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { getCapabilitySummaryCallbackArgument } from "../ast/mod.ts";
import {
  analyzeFunctionCapabilities,
  type MergeablePushMisuse,
} from "../policy/mod.ts";

function diagnosticMessage(finding: MergeablePushMisuse): string {
  const label = finding.path.length > 0
    ? `'${finding.path.join(".")}'`
    : "the collection";
  if (finding.kind === "read-dependent-push") {
    return (
      `This handler both reads ${label} and mergeable-'push'es to it, and ` +
      "the push depends on that read through a guard or the pushed value. " +
      "The explicit read keeps the append in the conflict set, so it " +
      "conflicts and retries under write contention instead of merging. " +
      "For a uniqueness condition, address the element by identity with " +
      "'elementById(...)' and 'addUnique(...)' instead. For other " +
      "content-dependent appends, use a read-modify-write 'set'."
    );
  }
  return (
    `This handler mergeable-'push'es to ${label} and independently reads ` +
    "it for another write to the same collection. That read keeps the " +
    "append in the conflict set, so it conflicts and retries under write " +
    "contention instead of merging. Keep the independent read-modify-write " +
    "in its own handler so the append stays mergeable."
  );
}

export class MergeablePushValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    // A single callback can be reachable from more than one call site: the
    // lift-applied shape `lift(cb)(input)` exposes both the applied outer call
    // and the unapplied inner `lift(cb)` call, and both resolve to the same
    // callback. Check each callback once so the "one warning per handler"
    // guarantee holds regardless of how many call sites reference it.
    const checked = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callback = getCapabilitySummaryCallbackArgument(
          node,
          context.checker,
        );
        if (callback && !checked.has(callback)) {
          checked.add(callback);
          this.#checkCallback(callback, context);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return context.sourceFile;
  }

  #checkCallback(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
  ): void {
    // One warning per collection per handler: several pushes to the same read
    // collection share a root cause, so one site stands for them. When the
    // sites classify differently, the read-dependent diagnosis is the
    // stronger, more actionable one, so it wins.
    const byCollection = new Map<string, MergeablePushMisuse>();
    analyzeFunctionCapabilities(callback, {
      checker: context.checker,
      typeRegistry: context.state.typeRegistry,
      mergeablePushMisuseSink: (finding) => {
        const key = JSON.stringify([finding.rootName, ...finding.path]);
        const existing = byCollection.get(key);
        if (
          !existing ||
          (existing.kind !== "read-dependent-push" &&
            finding.kind === "read-dependent-push")
        ) {
          byCollection.set(key, finding);
        }
      },
    });
    for (const finding of byCollection.values()) {
      context.reportDiagnostic({
        severity: "warning",
        type: "mergeable-push:read-then-push",
        message: diagnosticMessage(finding),
        node: finding.node,
      });
    }
  }
}
