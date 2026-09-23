import type {
  CfcSandboxJsonValue,
  CfcSandboxResult,
  CfcStreamChannel,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { SandboxCommandResult } from "./types.ts";

// The trusted CFC result runsc reports for a container, and how it becomes a
// `CfcSandboxResult` the engine mediates on. Shared by the docker-runsc
// driver (which reads it from a sidecar file) and the direct runsc driver
// (which reads it from a descriptor): one parser, one set of verdicts.

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

const hasNonEmptyXattrValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isObjectNotArray(value)) {
    return Object.values(value).some(hasNonEmptyXattrValue);
  }
  return value !== undefined && value !== null;
};

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

const isPublicRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (isObjectNotArray(taint.xattrJSON)) {
    return !Object.values(taint.xattrJSON).some(hasNonEmptyXattrValue);
  }
  // With no xattr form only runsc's own spelling of the empty label is
  // public. An empty or unfamiliar string is not evidence of anything and
  // withholds the output.
  return typeof taint.string === "string" &&
    taint.string.trim() === RUNSC_EMPTY_LABEL_STRING;
};

/**
 * Whether the taint carries a representation this parser can read at all:
 * runsc always writes `string`, and `xattrJSON`, when present, is an object.
 * Anything else is a sidecar this code does not understand, and an
 * unreadable taint is denied rather than read as "nothing to withhold".
 */
const isWellFormedRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (taint.string !== undefined && typeof taint.string !== "string") {
    return false;
  }
  if (taint.xattrJSON !== undefined && !isObjectNotArray(taint.xattrJSON)) {
    return false;
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
