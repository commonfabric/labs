import { fromFileUrl } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

/** The ways `locked-down-process.ts` can end; its header describes each. */
export type LockedDownEnding =
  | "succeed"
  | "reject"
  | "abandon"
  | "contain"
  | "throw";

/**
 * Runs `locked-down-process.ts` in its own Deno process, ending the way
 * `ending` names, and returns its exit status and output.
 */
export async function runLockedDownProcess(
  ending: LockedDownEnding,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../../../../", import.meta.url)),
    args: (tempLock) => [
      "run",
      "--no-check",
      "--lock",
      tempLock,
      "--frozen=true",
      fromFileUrl(new URL("./locked-down-process.ts", import.meta.url)),
      ending,
    ],
    env: { NO_COLOR: "1" },
  });
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}
