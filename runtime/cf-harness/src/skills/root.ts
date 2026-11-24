/**
 * The skills tree a run scans, and where it came from.
 *
 * Naming no tree is not the same as wanting none: a run with no skills root
 * gives its `pattern-author` children no authoring guidance at all, which is
 * not what an operator who simply did not pass a flag asked for. The default
 * is the checkout the harness runs out of, resolved here so that every surface
 * — the CLI, the console, a child engine — reaches the same answer.
 */

import { join } from "@std/path";

import { harnessCheckoutRoot } from "../checkout.ts";
import type { HarnessSkillsRootRecord } from "../contracts/skill.ts";

/** The checkout's own skills tree, when the harness runs out of a checkout. */
export const checkoutSkillsRoot = (): string | undefined => {
  const checkout = harnessCheckoutRoot();
  return checkout === undefined ? undefined : join(checkout, "skills");
};

/**
 * The skills-root dial a run resolves: what the operator configured, or the
 * checkout's own tree, or nothing at all — in which case the run offers no
 * skill registry and no profile preloads.
 *
 * This is the one derivation of the dial, so a surface stating its tool policy
 * and the engine building the registry reach the same answer.
 */
export const resolveHarnessSkillsRoot = (
  configured?: string,
): HarnessSkillsRootRecord | undefined => {
  if (configured !== undefined) {
    return {
      type: "cf-harness.skills-root-record",
      source: "configured",
      hostPath: configured,
    };
  }
  const hostPath = checkoutSkillsRoot();
  return hostPath === undefined ? undefined : {
    type: "cf-harness.skills-root-record",
    source: "checkout-default",
    hostPath,
  };
};
