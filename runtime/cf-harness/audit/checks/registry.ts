/**
 * Every check that runs over one run, in id order.
 *
 * Group A reads what a run did (`structural.ts`); Group C reads what it
 * declared it was doing (`posture.ts`); Group E reads whether the defects we
 * already know about are still there (`known-defects.ts`). All three are
 * per-run, so all three are in the one list `auditRunFamily` walks. Group D is
 * not here: its checks are about a corpus or about a deployment, and
 * `deployment.ts` evaluates them once per invocation rather than once per run.
 */

import { KNOWN_DEFECT_CHECKS } from "./known-defects.ts";
import { POSTURE_CHECKS } from "./posture.ts";
import { type AuditCheck, STRUCTURAL_CHECKS } from "./structural.ts";

/** Every per-run check. */
export const RUN_CHECKS: readonly AuditCheck[] = [
  ...STRUCTURAL_CHECKS,
  ...POSTURE_CHECKS,
  ...KNOWN_DEFECT_CHECKS,
].sort((left, right) =>
  left.id.localeCompare(right.id, undefined, { numeric: true })
);
