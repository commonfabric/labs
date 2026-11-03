/**
 * Whether a runtime names sub-pattern instances, read from its experimental
 * options. It stands apart from `instance-name.ts`, which works on cells, so
 * that a client that only has to tell a server its naming mode does not read
 * the cell machinery.
 */

import { applyLocalExperimentalDefaults } from "../experimental-defaults.ts";
import type { ExperimentalOptions } from "../runtime.ts";

/**
 * Whether a runtime whose experimental options are `experimental` compiles a
 * pattern factory call bound to a `const` as a named instance. It is the one
 * read of the `instanceNames` flag: the compile and the key its compiled code
 * is cached under both take it from here, so that the two cannot disagree.
 */
export function namesInstances(
  experimental: { readonly instanceNames?: boolean | undefined },
): boolean {
  return experimental.instanceNames === true;
}

/**
 * Whether a runtime of this build given the experimental options
 * `experimental` names instances, once its local defaults fill in what
 * `experimental` leaves unset, as `namesInstances()` reads the flag. With no
 * argument, whether a runtime given no option names them.
 */
export function namesInstancesByDefault(
  experimental: { readonly instanceNames?: boolean | undefined } = {},
): boolean {
  const resolved: ExperimentalOptions = {
    instanceNames: experimental.instanceNames,
  };
  applyLocalExperimentalDefaults(resolved);
  return namesInstances(resolved);
}
