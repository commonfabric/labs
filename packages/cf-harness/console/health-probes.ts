/**
 * Read-only host checks for console health. Responses establish only the fact
 * each row names; an unreadable response leaves that fact unknown.
 */

import {
  type HarnessPatternIndexClientFactory,
  PatternIndexError,
} from "../src/pattern-index/client.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { DEFAULT_DOCKER_BINARY } from "../src/sandbox/docker-runsc.ts";
import { readDockerRuntimes } from "../src/sandbox/docker-runtimes.ts";
import type { RunscSandboxConfig } from "../src/sandbox/runsc.ts";
import {
  type ConsoleHealthFact,
  type ConsoleHealthProbe,
  type ConsoleHealthRow,
  consoleHealthUrl,
} from "./health.ts";

/** Checks the running daemon's registration without starting a sandbox. */
export const consoleSandboxHealthProbe = (
  readRuntimes = () => readDockerRuntimes(DEFAULT_DOCKER_BINARY),
): ConsoleHealthProbe => {
  const source = "docker info";
  const detail = "docker info --format '{{json .Runtimes}}'";
  const initial: ConsoleHealthFact[] = [{
    id: "sandbox.docker",
    group: "sandbox",
    label: "Docker Daemon",
    value: "not checked",
    source,
    detail,
  }, {
    id: "sandbox.runtime",
    group: "sandbox",
    label: "Sandbox Runtime",
    value: "not checked",
    source,
    detail,
  }];
  const unavailable = (checkedAt: string): ConsoleHealthRow[] =>
    initial.map((row) => ({
      ...row,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The Docker runtime table could not be read.",
      remedy: "Start Docker and check its runsc-cfc runtime registration.",
    }));
  return {
    id: "sandbox",
    initial,
    unavailable,
    read: async () => {
      const result = await readRuntimes();
      const checkedAt = new Date().toISOString();
      if (!isObjectNotArray(result.runtimes)) {
        return unavailable(checkedAt).map((row) => ({
          ...row,
          reason: result.unreadable ??
            "Docker returned an invalid runtime table.",
        }));
      }
      const registered = Object.hasOwn(result.runtimes, "runsc-cfc");
      return [{
        ...initial[0],
        state: "ok",
        checkedAt,
        value: "responding",
      }, {
        ...initial[1],
        state: registered ? "ok" : "failed",
        checkedAt,
        value: registered ? "runsc-cfc registered" : "runsc-cfc not registered",
        ...(registered ? {} : {
          reason: "The running daemon has no runsc-cfc entry.",
          remedy:
            "Install the runsc-cfc runtime and reload Docker's runtime registration.",
        }),
      }];
    },
  };
};

/** What a look at one host path found. */
export type ConsolePathReading =
  | { found: "file"; executable: boolean }
  | { found: "other" }
  | { found: "absent" }
  | { found: "unreadable"; reason: string };

/**
 * Looks at one host path. Only a path that is not there reads as absent; any
 * other failure to look is unreadable, which leaves the fact it would have
 * established unknown. `stat` replaces `Deno.statSync`.
 */
export const readConsolePath = (
  path: string,
  stat: (path: string) => Deno.FileInfo = Deno.statSync,
): ConsolePathReading => {
  let info: Deno.FileInfo;
  try {
    info = stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { found: "absent" };
    return { found: "unreadable", reason: String(error) };
  }
  return info.isFile
    ? { found: "file", executable: ((info.mode ?? 0) & 0o111) !== 0 }
    : { found: "other" };
};

/**
 * Checks the direct runsc driver without starting a sandbox and without
 * consulting Docker: that its configuration resolves the way a turn resolves
 * it, that the `runsc` binary it names is an executable file, and whether a
 * CFC policy is configured and present. An executable binary does not prove a
 * sandbox can execute a task.
 *
 * `resolve` throws where a turn would be refused. `examine` looks at one
 * path; both run synchronously, so an observation holds no operation open.
 */
export const consoleRunscHealthProbe = (
  resolve: () => RunscSandboxConfig,
  examine: (path: string) => ConsolePathReading = readConsolePath,
): ConsoleHealthProbe => {
  const source = "runsc configuration";
  const initial: ConsoleHealthFact[] = [{
    id: "sandbox.runsc",
    group: "sandbox",
    label: "Runsc Binary",
    value: "not checked",
    source,
  }, {
    id: "sandbox.runtime",
    group: "sandbox",
    label: "Sandbox Runtime",
    value: "not checked",
    source,
  }];
  const unavailable = (checkedAt: string): ConsoleHealthRow[] =>
    initial.map((row) => ({
      ...row,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The runsc configuration could not be examined.",
    }));
  return {
    id: "sandbox",
    initial,
    unavailable,
    read: () => {
      const checkedAt = new Date().toISOString();
      let config: RunscSandboxConfig;
      try {
        config = resolve();
      } catch (error) {
        return Promise.resolve([{
          ...initial[0],
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason:
            "The runsc configuration did not resolve, so no binary was examined.",
        }, {
          ...initial[1],
          state: "failed",
          checkedAt,
          value: "configuration refused",
          reason: error instanceof Error ? error.message : String(error),
          remedy:
            "Correct the runsc settings in the console's environment (CF_HARNESS_RUNSC_BINARY, CF_HARNESS_SANDBOX_ROOTFS, CF_HARNESS_RUNSC_CFC_POLICY) or its host mounts, then restart the console.",
        }]);
      }
      const policy = config.cfcPolicyPath;
      const detail = `runsc ${config.runscBinary}; rootfs ${config.rootfs}; ` +
        `CFC policy ${policy ?? "none"}`;
      const binary = examine(config.runscBinary);
      const binaryRow: ConsoleHealthRow = binary.found === "unreadable"
        ? {
          ...initial[0],
          detail: config.runscBinary,
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason: binary.reason,
        }
        : binary.found === "file" && binary.executable
        ? {
          ...initial[0],
          detail: config.runscBinary,
          state: "ok",
          checkedAt,
          value: "executable",
        }
        : {
          ...initial[0],
          detail: config.runscBinary,
          state: "failed",
          checkedAt,
          value: binary.found === "absent" ? "missing" : "not executable",
          reason: binary.found === "absent"
            ? "Nothing exists at the runsc binary path."
            : "The runsc binary path is not an executable file.",
          remedy:
            "Install runsc there, or set CF_HARNESS_RUNSC_BINARY to an executable runsc, then restart the console.",
        };
      const policyReading = policy === undefined ? undefined : examine(policy);
      const runtimeRow: ConsoleHealthRow = policyReading === undefined
        ? {
          ...initial[1],
          detail,
          state: "degraded",
          checkedAt,
          value: "direct runsc driver, no CFC policy",
          reason:
            "runsc runs without --cfc, so a command's output carries no CFC result.",
          remedy:
            "Install a CFC policy, or set CF_HARNESS_RUNSC_CFC_POLICY to one, then restart the console.",
        }
        : policyReading.found === "file"
        ? {
          ...initial[1],
          detail,
          state: "ok",
          checkedAt,
          value: "direct runsc driver, CFC policy configured",
        }
        : policyReading.found === "unreadable"
        ? {
          ...initial[1],
          detail,
          state: "unknown",
          checkedAt,
          value: "not verified",
          reason: policyReading.reason,
        }
        : {
          ...initial[1],
          detail,
          state: "failed",
          checkedAt,
          value: "CFC policy missing",
          reason: "No file exists at the configured CFC policy path.",
          remedy:
            "Install the policy there, or set CF_HARNESS_RUNSC_CFC_POLICY to one, then restart the console.",
        };
      return Promise.resolve([binaryRow, runtimeRow]);
    },
  };
};

/** Checks health and membership independently using the console's client. */
export const consolePatternIndexHealthProbes = (
  baseUrl: string,
  clientFactory: HarnessPatternIndexClientFactory,
): readonly ConsoleHealthProbe[] => {
  const displayUrl = consoleHealthUrl(baseUrl);
  const facts: ConsoleHealthFact[] = [{
    id: "index.reachable",
    group: "index",
    label: "Pattern Index Reachability",
    value: "not checked",
    source: "index /health",
    detail: `GET health at ${displayUrl}`,
  }, {
    id: "index.enrolled",
    group: "index",
    label: "Pattern Index Enrollment",
    value: "not checked",
    source: "index /enrollmentStatus",
    detail: `GET enrollmentStatus at ${displayUrl}, for the console identity`,
  }];
  return facts.map((fact, index) => {
    const unavailable = (
      checkedAt: string,
      error?: unknown,
    ): ConsoleHealthRow[] => [{
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: error instanceof PatternIndexError
        ? `The index answered HTTP ${error.status}; this does not establish ${
          index === 0 ? "health" : "membership"
        }.`
        : "The index observation could not be completed or its response was not valid.",
      remedy:
        "Check the configured index URL, network access, and console identity file.",
    }];
    return {
      id: fact.id,
      initial: [fact],
      unavailable,
      read: async () => {
        const client = await clientFactory();
        const result =
          await (index === 0 ? client.health() : client.enrollmentStatus());
        const checkedAt = new Date().toISOString();
        if (!isObjectNotArray(result)) return unavailable(checkedAt);
        const record = result as Record<string, unknown>;
        const field = index === 0 ? "ok" : "enrolled";
        if (
          !Object.hasOwn(record, field) || typeof record[field] !== "boolean" ||
          (index !== 0 &&
            (!Object.hasOwn(record, "did") || record.did !== client.did))
        ) return unavailable(checkedAt);
        const confirmed = record[field];
        return [{
          ...fact,
          state: confirmed ? "ok" : "failed",
          checkedAt,
          value: index === 0
            ? confirmed ? "responding" : "reports unhealthy"
            : confirmed
            ? "console identity enrolled"
            : "console identity not enrolled",
          ...(confirmed ? {} : {
            reason: index === 0
              ? "The index reports that its health check failed."
              : "The index reports no enrollment for the console identity.",
            remedy: index === 0
              ? "Check the pattern index deployment."
              : `Enroll the console's identity through ${
                displayUrl.replace(/\/+$/, "")
              }/enroll.`,
          }),
        }];
      },
    };
  });
};
