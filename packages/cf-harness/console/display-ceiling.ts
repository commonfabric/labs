/**
 * What the console may show its owner (CFC §8.10.6): a value's label has to
 * fit the console's display ceiling before the value reaches a page.
 *
 * The ceiling is the default one a display has when no authored policy covers
 * it, built by the same `defaultDisplayCeiling` the shell builds its own
 * display's from, so the two cannot drift apart. Its audience is the
 * console's owner, the identity the console's fabric session signs as, which
 * is the person viewing it only while the console is served to that one
 * person. The ceiling admits the atoms naming exactly the owner, and the whole
 * family of prompt caveats, as the CFC specification owner ruled for the
 * default display ceiling (SC-54 in `docs/specs/cfc-spec-changes.md`, whose
 * edit to §8.10.6 is pending). A label naming anyone or anything else does not
 * fit, and neither does a label that could not be read. The fit is the
 * display fit's own, atom by atom, without the exchange rules that would
 * admit a space the owner reads, so it is never wider than the shell's.
 */

import type { DID } from "@commonfabric/identity";
import {
  canRenderLabelUnderPolicy,
  rootRenderPolicyFor,
} from "@commonfabric/html/worker";
import type { CfcConfClause, IFCLabel } from "@commonfabric/runner/cfc";
import { defaultDisplayCeiling } from "@commonfabric/runner/cfc/default-display-ceiling";

/** Whether a value with a label may be shown on the console. */
export type ConsoleDisplayFit = (label: IFCLabel) => boolean;

/**
 * The fit of `label` under a ceiling of `atoms`, and of caveats of the
 * `caveatKinds` listed, as a display's root render policy fits it. A label
 * too malformed to fit at all does not fit.
 */
const fitsCeiling = (ceiling: {
  atoms: readonly CfcConfClause[];
  caveatKinds: readonly string[];
}): ConsoleDisplayFit => {
  const policy = rootRenderPolicyFor(ceiling);
  return (label) => {
    try {
      return policy !== undefined &&
        canRenderLabelUnderPolicy(
          label.confidentiality ?? [],
          label.integrity ?? [],
          () => [],
          policy,
          {},
        );
    } catch {
      return false;
    }
  };
};

/**
 * The fit of a console whose owner it does not know: only a label naming no
 * one, which any display may show.
 */
export const publicConsoleDisplay: ConsoleDisplayFit = fitsCeiling({
  atoms: [],
  caveatKinds: [],
});

/** The fit of the console `owner` sees. */
export const ownerConsoleDisplay = (owner: DID): ConsoleDisplayFit =>
  fitsCeiling(defaultDisplayCeiling(owner));
