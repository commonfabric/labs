import { encodeBase64 } from "@std/encoding/base64";
import type { IFCLabel } from "@commonfabric/runner/cfc";
import type { SandboxCommandResult } from "../../src/sandbox/types.ts";

/** A sandbox read whose released stream encodes these exact image bytes. */
export const observedImageRead = (
  bytes: Uint8Array,
  label: IFCLabel = {},
): SandboxCommandResult => {
  const text = encodeBase64(bytes);
  return {
    stdout: text,
    stderr: "",
    exitCode: 0,
    cfcResult: {
      version: 1,
      stdout: {
        channel: "stdout",
        policy: "observed",
        label,
        segments: [{ text, label }],
      },
      stderr: { channel: "stderr", policy: "observed", label, segments: [] },
      exitCode: { policy: "observed", label, value: 0 },
    },
  };
};
