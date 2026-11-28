/**
 * The sandbox a sealed skill-script run executes in: one whose every channel
 * out is off.
 *
 * A run that can reach no network, write no mount, and leave nothing behind
 * for a later call is an untrusted transition: it can compute only over what
 * it was given, and what it returns is its stdout and stderr, still tainted.
 * So it needs no authority, and `run_skill_script` classes such a call `read`
 * (`docs/plans/reviewed-skills.md`, section 4). Anything less sealed is a side
 * effect: CFC has no clause that mediates a network channel, so a run either
 * has none or is treated as able to cause anything.
 */

import type { RunscSandboxConfig } from "../sandbox/runsc.ts";

/**
 * The runsc configuration of one sealed call, derived from the configuration
 * the run's engine built its own runtime from:
 *
 * - no network: runsc's `none`, which gives the container a loopback and no
 *   other interface, and leaves pasta and its forwarded ports out;
 * - no fabric mount, and every other mount, the workspace included, bound
 *   read-only;
 * - a scratch directory of the call's own beside the run's, in the parent
 *   the run's runtime verifies is private, so the runtime built from it, and
 *   closed after the one call, shares no state with the run's.
 *
 * Each call outside a session already gets a fresh container with a fresh
 * `/tmp`, so a sealed call names no session. It runs in the workspace, which
 * it can read and not write, and `/tmp` is its scratch: runsc keeps a call's
 * working directory inside the mounts, and the tmpfs is not one of them.
 */
export const sealedSkillScriptRunscConfig = (
  config: RunscSandboxConfig,
  callId: string,
): RunscSandboxConfig => {
  const {
    networkHelper: _networkHelper,
    unshare: _unshare,
    setpriv: _setpriv,
    forwardedHostPorts: _forwardedHostPorts,
    ...rest
  } = config;
  return {
    ...rest,
    networkMode: "none",
    workspaceReadOnly: true,
    additionalMounts: config.additionalMounts
      .filter((mount) => mount.kind === "host-bind")
      .map((mount) => ({ ...mount, readOnly: true })),
    scratchDir: `${config.scratchDir}-sealed-${callId}`,
  };
};
