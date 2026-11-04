/**
 * Patterns that do not evaluate today, and so cannot be gated.
 *
 * A file that throws while being evaluated yields no contract, gets no
 * baseline, and is therefore exempt from the update gate *by construction* —
 * it can never evaluate, so it can never be recorded, so it can never be
 * checked. Without this list those files would sit in the same "skipped"
 * bucket as `schemas.tsx` and other helper modules that are legitimately not
 * pattern entries, and nothing would distinguish "was never a pattern" from
 * "is a broken pattern".
 *
 * So the list is debt, made visible. The gate fails on an evaluation error
 * that is NOT listed here, and fails when a listed entry starts evaluating
 * again — so the list can only shrink, never quietly grow. It also fails on
 * an entry naming a required pattern: an unevaluable pattern is exempt from
 * the gate entirely, which the aggressively auto-updating roots may never be
 * (`pattern-break-registry-guards.ts`).
 *
 * An entry is the pattern key (path relative to `patterns`). An
 * entry may name a real `export default pattern(...)` rather than a helper
 * module, so anyone who created a piece from one back when it worked has a
 * piece that this gate does not protect.
 */
export const UNEVALUABLE_PATTERNS: ReadonlySet<string> = new Set([]);
