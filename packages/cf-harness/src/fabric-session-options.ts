/**
 * Resolves host-owned Fabric session options for batch and interactive runs.
 * A complete API, identity, and space binding carries the runtime's CFC posture.
 */

import { resolve } from "@std/path";

import type { CfcConfClause } from "@commonfabric/runner/cfc";

import type { HarnessFabricSessionConfig } from "./config.ts";
import { readCeilingFromInput } from "./contracts/run-manifest.ts";
import { parseHarnessForeignSpaces } from "./foreign-spaces.ts";

/** Options which configure a Fabric session and its read posture. */
export const HARNESS_FABRIC_SESSION_OPTION_NAMES = [
  "fabric-api-url",
  "fabric-identity",
  "fabric-space",
  "fabric-foreign-spaces",
  "fabric-cfc-enforcement-mode",
  "fabric-cfc-flow-labels",
  "fabric-cfc-posture",
  "max-confidentiality",
] as const;

/**
 * Resolves flags over environment defaults, with relative identity paths based
 * on `cwd`. Throws for a partial binding or an invalid session option.
 */
export const resolveHarnessFabricSessionConfig = (
  args: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): HarnessFabricSessionConfig | undefined => {
  const fabricSessionFlagValue = (
    flag:
      | "fabric-api-url"
      | "fabric-identity"
      | "fabric-space"
      | "fabric-foreign-spaces"
      | "fabric-cfc-enforcement-mode"
      | "fabric-cfc-flow-labels"
      | "fabric-cfc-posture",
    envValue: string | undefined,
  ): string | undefined => {
    const raw = typeof args[flag] === "string"
      ? args[flag].trim()
      : (envValue?.trim() || undefined);
    if (raw === "") {
      throw new Error(`--${flag} requires a non-empty value`);
    }
    return raw;
  };
  const fabricApiUrl = fabricSessionFlagValue(
    "fabric-api-url",
    env.CF_HARNESS_FABRIC_API_URL,
  );
  const fabricIdentity = fabricSessionFlagValue(
    "fabric-identity",
    env.CF_HARNESS_FABRIC_IDENTITY,
  );
  const fabricSpace = fabricSessionFlagValue(
    "fabric-space",
    env.CF_HARNESS_FABRIC_SPACE,
  );
  const foreignSpaces = parseHarnessForeignSpaces(fabricSessionFlagValue(
    "fabric-foreign-spaces",
    env.CF_HARNESS_FABRIC_FOREIGN_SPACES,
  ));
  const fabricCfcEnforcementMode = fabricSessionFlagValue(
    "fabric-cfc-enforcement-mode",
    env.CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE,
  );
  if (
    fabricCfcEnforcementMode !== undefined &&
    fabricCfcEnforcementMode !== "enforce-explicit" &&
    fabricCfcEnforcementMode !== "enforce-strict"
  ) {
    // The runtime preset enforces explicit labels; this setting may raise
    // enforcement to strict.
    throw new Error(
      `--fabric-cfc-enforcement-mode must be enforce-explicit or enforce-strict: ${fabricCfcEnforcementMode}`,
    );
  }
  const fabricCfcFlowLabels = fabricSessionFlagValue(
    "fabric-cfc-flow-labels",
    env.CF_HARNESS_FABRIC_CFC_FLOW_LABELS,
  );
  if (
    fabricCfcFlowLabels !== undefined && fabricCfcFlowLabels !== "off" &&
    fabricCfcFlowLabels !== "observe" && fabricCfcFlowLabels !== "persist"
  ) {
    throw new Error(
      `--fabric-cfc-flow-labels must be off, observe, or persist: ${fabricCfcFlowLabels}`,
    );
  }
  const fabricCfcPosture = fabricSessionFlagValue(
    "fabric-cfc-posture",
    env.CF_HARNESS_FABRIC_CFC_POSTURE,
  );
  if (
    fabricCfcPosture !== undefined && fabricCfcPosture !== "max-enforcement"
  ) {
    throw new Error(
      `--fabric-cfc-posture must be max-enforcement: ${fabricCfcPosture}`,
    );
  }
  const rawMaxConfidentiality = typeof args["max-confidentiality"] === "string"
    ? args["max-confidentiality"].trim()
    : undefined;
  let maxConfidentiality: readonly CfcConfClause[] | undefined;
  if (rawMaxConfidentiality !== undefined) {
    let parsedCeiling: unknown;
    try {
      parsedCeiling = JSON.parse(rawMaxConfidentiality);
    } catch (error) {
      throw new Error(
        `--max-confidentiality must be JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    maxConfidentiality = readCeilingFromInput(
      parsedCeiling,
      undefined,
      { ceiling: "--max-confidentiality", onExceed: "--max-confidentiality" },
    ).maxConfidentiality;
  }
  let fabricSession: HarnessFabricSessionConfig | undefined;
  if (
    fabricApiUrl !== undefined || fabricIdentity !== undefined ||
    fabricSpace !== undefined
  ) {
    const missing = [
      ...(fabricApiUrl === undefined ? ["--fabric-api-url"] : []),
      ...(fabricIdentity === undefined ? ["--fabric-identity"] : []),
      ...(fabricSpace === undefined ? ["--fabric-space"] : []),
    ];
    if (missing.length > 0) {
      throw new Error(
        `--fabric-api-url, --fabric-identity, and --fabric-space configure one fabric session and go together; missing ${
          missing.join(", ")
        }`,
      );
    }
    try {
      new URL(fabricApiUrl!);
    } catch {
      throw new Error(`--fabric-api-url must be a valid URL: ${fabricApiUrl}`);
    }
    fabricSession = {
      apiUrl: fabricApiUrl!,
      identityKeyPath: resolve(cwd, fabricIdentity!),
      space: fabricSpace!,
      ...(foreignSpaces !== undefined ? { foreignSpaces } : {}),
      ...(fabricCfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: fabricCfcEnforcementMode }
        : {}),
      ...(fabricCfcFlowLabels !== undefined
        ? { cfcFlowLabels: fabricCfcFlowLabels }
        : {}),
      ...(fabricCfcPosture !== undefined
        ? { cfcPosture: fabricCfcPosture }
        : {}),
      ...(maxConfidentiality !== undefined
        ? { cfcReadMaxConfidentiality: maxConfidentiality }
        : {}),
    };
  } else if (
    fabricCfcEnforcementMode !== undefined ||
    fabricCfcFlowLabels !== undefined || fabricCfcPosture !== undefined
  ) {
    throw new Error(
      "--fabric-cfc-enforcement-mode, --fabric-cfc-flow-labels, and --fabric-cfc-posture configure the fabric session's runtime and need --fabric-api-url, --fabric-identity, and --fabric-space",
    );
  } else if (foreignSpaces !== undefined) {
    throw new Error(
      "`--fabric-foreign-spaces` needs `--fabric-api-url`, `--fabric-identity`, and `--fabric-space`",
    );
  } else if (maxConfidentiality !== undefined) {
    // A ceiling with no session bounds nothing, and one accepted here would
    // read as working all run.
    throw new Error(
      "--max-confidentiality bounds the fabric session's reads and needs --fabric-api-url, --fabric-identity, and --fabric-space",
    );
  }
  return fabricSession;
};
