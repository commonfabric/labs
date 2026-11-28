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

import { isAbsolute, join, relative, SEPARATOR } from "@std/path";

import type { RunscSandboxConfig } from "../sandbox/runsc.ts";

/**
 * Where each of `hostPaths` appears in the sandbox, under every mount that
 * shows it: the workspace, or a host bind. Every side should be canonical, or
 * a link on one makes the path look outside the mount.
 */
export const sandboxPathsUnderMounts = (
  mounts: readonly { hostPath: string; sandboxPath: string }[],
  hostPaths: readonly string[],
): string[] =>
  hostPaths.flatMap((hostPath) =>
    mounts.flatMap((mount) => {
      const inside = relative(mount.hostPath, hostPath);
      const outside = isAbsolute(inside) || inside === ".." ||
        inside.startsWith(`..${SEPARATOR}`);
      return outside ? [] : [join(mount.sandboxPath, inside)];
    })
  );

/**
 * The runsc configuration of one sealed call, derived from the configuration
 * the run's engine built its own runtime from:
 *
 * - no network: runsc's `none`, which gives the container a loopback and no
 *   other interface, and leaves pasta and its forwarded ports out;
 * - no fabric mount, and every other mount, the workspace included, bound
 *   read-only;
 * - each of `maskedPaths` covered, so the run's artifact root, which no
 *   model-facing tool may read, is not read through a script either (see
 *   {@link sandboxPathsUnderMounts});
 * - a scratch directory of the call's own beside the run's, in the parent
 *   the run's runtime verifies is private, so the runtime built from it, and
 *   closed after the one call, shares no state with the run's.
 *
 * Each call outside a session already gets a fresh container, so a sealed
 * call names no session. Its working directory is the workspace, which it can
 * read and not write, because runsc keeps a call's working directory inside
 * the mounts. What it writes lands in the container's `/tmp` or in the
 * in-memory overlay over its root filesystem, and both go with the container.
 */
export const sealedSkillScriptRunscConfig = (
  config: RunscSandboxConfig,
  callId: string,
  maskedPaths: readonly string[] = [],
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
    ...(maskedPaths.length > 0 ? { maskedPaths: [...maskedPaths] } : {}),
    additionalMounts: config.additionalMounts
      .filter((mount) => mount.kind === "host-bind")
      .map((mount) => ({ ...mount, readOnly: true })),
    scratchDir: `${config.scratchDir}-sealed-${callId}`,
  };
};
