import type { CellScope } from "./types.ts";

/**
 * Both pattern construction paths that detect a reactive cell being captured
 * from an outer frame raise the SAME conceptual violation: a callback (a map /
 * filter / flatMap / computed body) closed over a `Cell`/`Reactive` that
 * belongs to a different frame, instead of receiving it as an explicit
 * reactive input.
 *
 * Historically the two sites threw two differently-worded errors, neither of
 * which named the offending site, the cell, or the consuming module — so
 * authors saw a bare SES stack and couldn't tell whether the two strings were
 * the same problem. This module produces one diagnostic shared by both sites,
 * enriched with whatever context is available at throw time.
 *
 * Note: the most common trigger — `(cell.get() ?? []).map(cb)` where `cb`
 * captures a sibling cell — is now lowered to `mapWithPattern` by the
 * transformer (CT-1626), so it no longer reaches here. This diagnostic is for
 * the residual shapes that genuinely cannot be auto-rewritten and need author
 * intervention.
 */

export interface CapturedCellInfo {
  path?: readonly PropertyKey[];
  scope?: CellScope;
  name?: unknown;
}

function describeCapturedCell(info: CapturedCellInfo): string {
  const parts: string[] = [];
  if (typeof info.name === "string" && info.name.length > 0) {
    parts.push(`'${info.name}'`);
  }
  if (info.path && info.path.length > 0) {
    parts.push(`at path [${info.path.map((p) => String(p)).join(", ")}]`);
  }
  if (info.scope) {
    parts.push(`${info.scope}-scoped`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** One-line, length-capped rendering of a callback body preview. */
function summarizeImplementation(preview: string): string {
  const collapsed = preview.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}\u2026` : collapsed;
}

/**
 * Build the unified closure-capture diagnostic message.
 *
 * @param options.capturedCell identity of the offending cell, if available.
 * @param options.sourceLocation authored `file:line:col` of the capturing
 *   callback, if it could be resolved at the call site.
 * @param options.implementationPreview source text of the capturing callback.
 *   Names the offending site when no location is available, which is the
 *   common case while a module is still evaluating.
 */
export function closureCaptureErrorMessage(
  options: {
    capturedCell?: CapturedCellInfo;
    sourceLocation?: string | null;
    implementationPreview?: string | null;
  } = {},
): string {
  const cellDesc = options.capturedCell
    ? describeCapturedCell(options.capturedCell)
    : "";
  const summary = options.implementationPreview
    ? summarizeImplementation(options.implementationPreview)
    : "";
  const locationLine = options.sourceLocation
    ? `\n  at ${options.sourceLocation}`
    : summary
    ? `\n  in ${summary}`
    : "";

  return (
    `Reactive cell${cellDesc} from an outer scope was captured by a closure ` +
    `and cannot be connected across reactive frames.${locationLine}\n` +
    "help: a callback (e.g. inside .map / .filter / .flatMap / computed) must " +
    "receive reactive cells as explicit inputs, not close over them.\n" +
    "  - Most array-method callbacks are handled automatically when the " +
    "receiver is reactive — prefer `cell.map(...)`, or let the compiler lower " +
    "`(cell.get() ?? []).map(...)` to `mapWithPattern`.\n" +
    "  - For a hand-built callback, use `cell.mapWithPattern(pattern, params)` " +
    "and thread captured cells through `params`, or `computed()` which " +
    "extracts captures for you."
  );
}
