import type {
  CfcSandboxJsonValue,
  CfcSandboxResult,
  CfcStreamChannel,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { SandboxCommandResult } from "./types.ts";

// The trusted CFC result runsc reports for a container, and how it becomes a
// `CfcSandboxResult` the engine mediates on. The direct runsc driver reads it
// from a descriptor.
//
// WHAT IS PUBLIC. runsc writes the final taint twice: `string`, the label's
// `cfc.Label.String`, and `xattrJSON`, its `cfc.MarshalXattr`, which holds
// `confidentiality` and `integrity` arrays and omits each when it is empty.
// For the empty label that is
//
//     {"string":"{conf: ⊤, integ: ∅}","xattrJSON":{}}
//
// and that, give or take empty arrays written out, is the only taint read as
// public. Output is `observed` when ALL of these hold, and withheld
// otherwise:
//
//   - `xattrJSON` is an object. The string alone is never public.
//   - `xattrJSON` holds nothing but `confidentiality` and `integrity`, each an
//     empty array. `denied` when either is present and not an array, which is
//     what runsc's own `UnmarshalXattr` rejects; `opaque` for a key runsc does
//     not write, whatever it holds.
//   - `string`, when present, is exactly runsc's spelling of the empty label.
//     A string that is blank, or spells anything else, is withheld even
//     beside an empty `xattrJSON`: the two forms have to agree.
//
// Shapes runsc does not write are read strictly, since a withheld output is
// safe:
//
//   | `cfcTaint`                                  | verdict |
//   | ------------------------------------------- | ------- |
//   | `{}`                                        | denied  |
//   | `{string: ""}`, `{string: "{}"}`            | opaque  |
//   | `{string: 5, xattrJSON: {}}`                | denied  |
//   | `{string: "", xattrJSON: {}}` (or blank)    | opaque  |
//   | `{xattrJSON: {confidentiality: {}}}`        | denied  |
//   | `{xattrJSON: {confidentiality: null}}`      | denied  |
//   | `{xattrJSON: {conf: [], labels: {}}}`       | opaque  |
//   | `{xattrJSON: {extra: {inner: []}}}`         | opaque  |
//   | `{string: ..., xattrJSON: null}`            | denied  |
//   | `{string: "x", xattrJSON: []}`              | denied  |
//   | `{xattrJSON: {confidentiality: "secret"}}`  | denied  |
//   | `{string: "{conf: ⊤, integ: ∅}"}`           | opaque  |
//
// `test/runsc-cfc-result.test.ts` holds the whole table.

const textEncoder = new TextEncoder();

export const byteLength = (text: string): number =>
  textEncoder.encode(text).length;

export interface RunscCfcLabelSidecar {
  string?: unknown;
  xattrJSON?: unknown;
}

export interface RunscCfcResultSidecar {
  version?: unknown;
  containerId?: unknown;
  sandboxId?: unknown;
  waitStatus?: unknown;
  cfcTaint?: unknown;
}

const observedStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "observed" as const,
  label,
  segments: text.length === 0
    ? []
    : [{ text, label, offset: 0, byteLength: byteLength(text) }],
});

const opaqueStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "opaque" as const,
  label,
  byteLength: byteLength(text),
});

export const deniedCfcResult = (
  code: string,
  message: string,
  details: Record<string, CfcSandboxJsonValue> = {},
): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "denied",
    label: {},
    reason: message,
  },
  stderr: {
    channel: "stderr",
    policy: "denied",
    label: {},
    reason: message,
  },
  exitCode: {
    policy: "denied",
    label: {},
    reason: message,
  },
  diagnostics: [{
    level: "error",
    code,
    message,
    details,
  }],
});

const runscTaintLabel = (taint: RunscCfcLabelSidecar): IFCLabel => {
  const xattr = isObjectNotArray(taint.xattrJSON) ? taint.xattrJSON : {};
  return {
    ...(Array.isArray(xattr.confidentiality)
      ? { confidentiality: xattr.confidentiality }
      : {}),
    ...(Array.isArray(xattr.integrity) ? { integrity: xattr.integrity } : {}),
  };
};

/** How runsc's `cfc.Label.String` spells the empty label. */
const RUNSC_EMPTY_LABEL_STRING = "{conf: ⊤, integ: ∅}";

/** The keys `cfc.MarshalXattr` writes. Each holds an array. */
const RUNSC_XATTR_LABEL_KEYS = ["confidentiality", "integrity"] as const;

const isEmptyRunscXattr = (xattr: Record<string, unknown>): boolean =>
  Object.entries(xattr).every(([key, value]) =>
    (RUNSC_XATTR_LABEL_KEYS as readonly string[]).includes(key) &&
    Array.isArray(value) && value.length === 0
  );

const isPublicRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (!isObjectNotArray(taint.xattrJSON)) {
    // The string form alone: not public, whatever it spells. main withheld
    // runsc's spelling of the empty label here, and an empty or unfamiliar
    // string is not evidence of anything.
    return false;
  }
  if (!isEmptyRunscXattr(taint.xattrJSON)) {
    return false;
  }
  if (typeof taint.string !== "string") {
    return true;
  }
  return taint.string === RUNSC_EMPTY_LABEL_STRING;
};

/**
 * Whether the taint carries a representation this parser can read at all:
 * runsc always writes `string`, and `xattrJSON`, when present, is an object
 * whose `confidentiality` and `integrity`, when present, are arrays.
 * Anything else is a sidecar this code does not understand, and an
 * unreadable taint is denied rather than read as "nothing to withhold".
 */
const isWellFormedRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (taint.string !== undefined && typeof taint.string !== "string") {
    return false;
  }
  if (taint.xattrJSON !== undefined) {
    const xattr = taint.xattrJSON;
    if (!isObjectNotArray(xattr)) {
      return false;
    }
    if (
      RUNSC_XATTR_LABEL_KEYS.some((key) =>
        Object.hasOwn(xattr, key) && !Array.isArray(xattr[key])
      )
    ) {
      return false;
    }
  }
  return taint.string !== undefined || taint.xattrJSON !== undefined;
};

export const cfcResultFromRunscSidecar = (
  parsed: RunscCfcResultSidecar,
  expectedContainerID: string,
  commandResult: SandboxCommandResult,
): CfcSandboxResult => {
  if (parsed.version !== 1) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_version",
      "runsc CFC result sidecar has an unsupported version",
      { containerId: expectedContainerID },
    );
  }
  if (parsed.containerId !== expectedContainerID) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_container_mismatch",
      "runsc CFC result sidecar did not match the container ID",
      {
        expectedContainerId: expectedContainerID,
        actualContainerId: typeof parsed.containerId === "string"
          ? parsed.containerId
          : "",
      },
    );
  }
  if (!isObjectNotArray(parsed.cfcTaint)) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_missing_taint",
      "runsc CFC result sidecar did not include final CFC taint",
      { containerId: expectedContainerID },
    );
  }

  const cfcTaint = parsed.cfcTaint;
  if (!isWellFormedRunscTaint(cfcTaint)) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_malformed_taint",
      "runsc CFC result sidecar carried a final taint this harness cannot read",
      { containerId: expectedContainerID },
    );
  }
  const label = runscTaintLabel(cfcTaint);
  const details: Record<string, CfcSandboxJsonValue> = {
    containerId: expectedContainerID,
  };
  if (typeof parsed.sandboxId === "string") {
    details.sandboxId = parsed.sandboxId;
  }
  if (typeof parsed.waitStatus === "number") {
    details.waitStatus = parsed.waitStatus;
  }
  if (typeof cfcTaint.string === "string") {
    details.runscTaint = cfcTaint.string;
  }
  if (cfcTaint.xattrJSON !== undefined) {
    details.runscTaintXattrJSON = cfcTaint.xattrJSON as CfcSandboxJsonValue;
  }

  if (isPublicRunscTaint(cfcTaint)) {
    return {
      version: 1,
      stdout: observedStream("stdout", commandResult.stdout, label),
      stderr: observedStream("stderr", commandResult.stderr, label),
      exitCode: {
        policy: "observed",
        label,
        value: commandResult.exitCode,
      },
      diagnostics: [{
        level: "info",
        code: "runsc_cfc_result",
        message: "runsc reported final CFC taint for sandbox output",
        label,
        details,
      }],
    };
  }

  return {
    version: 1,
    stdout: opaqueStream("stdout", commandResult.stdout, label),
    stderr: opaqueStream("stderr", commandResult.stderr, label),
    exitCode: {
      policy: "opaque",
      label,
    },
    diagnostics: [{
      level: "info",
      code: "runsc_cfc_result",
      message:
        "runsc reported tainted sandbox output; raw streams are withheld from model context",
      label,
      details,
    }],
  };
};
