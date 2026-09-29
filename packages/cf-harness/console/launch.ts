#!/usr/bin/env -S deno run -A

/**
 * The console's one launch path: resolve its configuration from the fabric
 * being started, print what each value resolved to and where it came from, and
 * serve.
 *
 *   deno task --cwd packages/cf-harness console:launch --instance loom
 *   deno task --cwd packages/cf-harness console:launch \
 *     --fabric-api-url http://localhost:8000 --store <dir>
 *
 * The console needs an identity, a space, a toolshed URL, the store that
 * toolshed serves, and, on the Docker driver, the two `runsc-cfc` sidecar
 * directories the sandbox's mediation moves over. An operator transcribing
 * those by hand gets a console that starts cleanly and is wrong: a store keyed
 * to a superseded labs pin reads as "no data at cell", and sidecar directories
 * no registered runtime writes drop every input label in silence. So each
 * value is derived from the record that decides it, tagged with where it came
 * from, and printed once before the server binds. Anything that cannot be
 * derived is a named flag whose absence is an error naming it, never a default
 * nobody chose.
 *
 * Which driver the console's sandbox runs on is read from the environment,
 * through the derivation every cf-harness entrypoint shares, and the server
 * reads the same variables the same way. A console on the direct runsc driver
 * reads no Docker runtime table and needs no sidecar directory; the launch
 * prints the `runsc` binary, rootfs and CFC policy the environment named in
 * their place.
 *
 * A loom instance is one source among several rather than the shape of this
 * module: `--instance` reads the identity, space and toolshed URL off that
 * instance's records, and a fabric with no instance behind it names them
 * itself. Arguments after `--` reach the console untouched, so a flag this
 * launcher has no opinion about is still reachable through it rather than
 * through a second launch path.
 *
 * `scripts/start-local-dev.sh --cf-harness` is what calls this for the fabric
 * it is starting, and is how a person starts a console. The console's own flags
 * and routes are in [`README.md`](README.md); the operator procedure is in
 * [`../docs/WEAVER.md`](../docs/WEAVER.md).
 */
import { isDID } from "@commonfabric/identity/did";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE } from "../src/config.ts";
import type { HarnessConnectorGrantSpec } from "../src/contracts/well-known-grants.ts";
import {
  DEFAULT_DOCKER_BINARY,
  registeredCfcSidecarHostDirs,
} from "../src/sandbox/docker-runsc.ts";
import { readDockerRuntimes } from "../src/sandbox/docker-runtimes.ts";
import {
  resolveSandboxRuntimeSelection,
  RUNSC_BINARY_ENV,
  RUNSC_CFC_POLICY_ENV,
  SANDBOX_ROOTFS_ENV,
  SANDBOX_RUNTIME_ENV,
  type SandboxRuntimeSelection,
} from "../src/sandbox/runtime-selection.ts";
import {
  connectorGrantLabel,
  connectorGrantName,
} from "../src/well-known-grants.ts";
import { resolveConnectorGrants } from "./connector-grants.ts";
import type {
  ConsoleHealthFactWithState,
  ConsoleLaunchHealth,
  ConsoleObservedLaunchHealth,
  ConsoleResolvedValue,
} from "./health.ts";
import {
  refuseBatchSandboxFlags,
  runscWithoutPolicyRefusesTurns,
  startConsoleServer,
} from "./server.ts";

export { readDockerRuntimes } from "../src/sandbox/docker-runtimes.ts";

/** The port Weaver's harness-console setting and loom's proxy both address. */
export const WEAVER_PAIRING_PORT = 8135;

/** The Docker runtime whose registration sites the CFC sidecar transports. */
const RUNSC_CFC_RUNTIME = "runsc-cfc";

/**
 * The index and registry this deployment's consoles read. They belong to the
 * deployment rather than to any one fabric, so nothing derives them; they are
 * stated here, printed as what they are, and moved by the environment variables
 * the console already reads.
 */
export const DEPLOYMENT_PATTERN_INDEX_URL =
  "https://us-central1-pattern-index.cloudfunctions.net";
export const DEPLOYMENT_SKILLS_REGISTRY_URL = "https://skills.sh";

/**
 * Proxy variables reach the console as ambient environment and break it two
 * ways: loopback toolshed calls leave the machine, and the pattern index sees
 * a proxy's identity rather than the console's. The launcher removes them from
 * the environment it serves under and reports that it did.
 */
const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/**
 * Every variable the launcher decides. A value it resolves is set; a value it
 * resolves to nothing is removed, because the printed report is a claim about
 * what the console runs under and an inherited variable the report does not
 * mention would make that claim untrue. `CF_HARNESS_SPACE_DB` is here without
 * being set: it names a store file directly, so an inherited one would silently
 * displace the store the report attributes to loom. Pass `-- --space-db <path>`
 * to name one, where it is a decision on the command line rather than ambient.
 */
export const LAUNCHER_OWNED_VARIABLES = [
  "CF_HARNESS_CONSOLE_PORT",
  "CF_HARNESS_CONSOLE_DIR",
  "CF_HARNESS_FABRIC_API_URL",
  "CF_HARNESS_FABRIC_IDENTITY",
  "CF_HARNESS_FABRIC_SPACE",
  "CF_HARNESS_FABRIC_CFC_POSTURE",
  "CF_HARNESS_FABRIC_CFC_FLOW_LABELS",
  "CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE",
  "CF_HARNESS_RUNSC_CFC_RESULT_DIR",
  "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR",
  "CF_HARNESS_CONNECTOR_GRANTS",
  "CF_HARNESS_PATTERN_INDEX_URL",
  "CF_HARNESS_SKILLS_REGISTRY_URL",
  "CF_HARNESS_ALLOW_SKILL_SCRIPTS",
  "CF_HARNESS_SPACE_DB",
  "MEMORY_DIR",
] as const;

/**
 * One resolved value, with the record that decided it. `source` is what an
 * operator reads to know which file to edit when a value is wrong.
 */
export type ResolvedValue = ConsoleResolvedValue;

/**
 * A loom instance's own records, when the fabric being started is an
 * instance's. Every field is the verbatim content of one record, so resolution
 * itself touches no filesystem and no subprocess.
 */
export interface LoomInstanceRecords {
  /** The instance's name, for error text and the console's directory. */
  id: string;
  /** The instance's `pieces.json`. */
  piecesJson: string;
  /** The absolute path `piecesJson` was read from, for error text. */
  piecesJsonPath: string;
  /**
   * What `loom toolshed-store-dir <instance>` printed: a `file://` URL for the
   * store keyed to the labs pin loom vendors, or an empty string when loom
   * could not instance-scope it.
   */
  toolshedStoreDir: string;
  /**
   * The instance's `sqlite-injection/handles.json` — the receipt its daemon
   * writes for the connector handles it has injected — or `undefined` when
   * the file does not exist yet, which is what an instance that has injected
   * none looks like.
   */
  handlesJson?: string;
  /** The absolute path `handlesJson` would be read from, for error text. */
  handlesJsonPath: string;
}

/** What the launcher read before resolving anything. */
export interface ConsoleLaunchRecords {
  /** Present only when `--instance` named a loom instance. */
  instance?: LoomInstanceRecords;
  /**
   * The runtime table `docker info --format '{{json .Runtimes}}'` reported, or
   * `undefined` when it could not be read. The running daemon's table rather
   * than the configuration on disk: an edited `daemon.json` the daemon has not
   * reloaded names directories nothing writes.
   */
  dockerRuntimes?: unknown;
  /** Why `dockerRuntimes` is absent, for error text. */
  dockerRuntimesUnreadable?: string;
  /**
   * The sandbox runtime the launch environment selects. Absent, or naming
   * `docker`, the console runs on the Docker driver.
   */
  sandbox?: ConsoleLaunchSandbox;
}

/** The sandbox runtime a launch's environment selects. */
export interface ConsoleLaunchSandbox {
  /** As `resolveSandboxRuntimeSelection` derives it from the environment. */
  selection: SandboxRuntimeSelection;
  /**
   * Whether `CF_HARNESS_RUNSC_CFC_POLICY` named the policy, rather than the
   * selection finding the default one under `HOME`.
   */
  policyNamed: boolean;
}

/**
 * What the caller names itself. Each of these wins over whatever record would
 * otherwise decide the same value, and is reported as named rather than
 * derived.
 */
export interface ConsoleLaunchOptions {
  port?: number;
  /**
   * What the launching shell already held. Ranked BELOW what a loom instance
   * records: an exported variable is a fact about the shell, and an instance
   * that has written down its own identity, space, toolshed or store has said
   * something more specific than the ambient one. Ranking them the other way
   * makes a console read a store the instance does not use while reporting the
   * value as though someone chose it.
   */
  inheritedIdentity?: string;
  inheritedSpace?: string;
  inheritedToolshedUrl?: string;
  inheritedStore?: string;
  inheritedPort?: number;
  consoleDir?: string;
  identity?: string;
  space?: string;
  toolshedUrl?: string;
  store?: string;
  patternIndexUrl?: string;
  skillsRegistryUrl?: string;
  noPatternIndex?: boolean;
  noSkillsRegistry?: boolean;
  allowSkillScripts?: boolean;
  inheritedAllowSkillScripts?: boolean;
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  posture?: string;
  flowLabels?: string;
  enforcementMode?: string;
}

/** The environment to serve under, and the printout that accounts for it. */
export interface ConsoleLaunchPlan {
  environment: Record<string, string>;
  resolved: readonly ResolvedValue[];

  /** The same decisions retained for the operator status endpoint. */
  health: ConsoleLaunchHealth;
}

/** Source labels the printout uses for a value nothing recorded. */
const NAMED = "named on the command line";
const LAUNCHER_DEFAULT = "launcher default";

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

const parseJsonRecord = (
  text: string,
  path: string,
): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `\`${path}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObjectNotArray(parsed)) {
    throw new Error(`\`${path}\` does not hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

const numericField = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value.trim())
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const stringField = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
};

const objectField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];
  return isObjectNotArray(value) ? value as Record<string, unknown> : {};
};

/**
 * The plain filesystem path a store value names.
 *
 * `loom toolshed-store-dir` prints a `file://` URL, because the toolshed reads
 * `MEMORY_DIR` through `new URL()`. Inside this process nothing does: the space
 * store reader treats `MEMORY_DIR` as a directory to walk, and a `file://` URL
 * is not one — it walks nothing, falls through to its other candidate roots,
 * and reads a different store's cells as though they were this space's. So the
 * console is given the path, and the toolshed keeps the URL loom launched it
 * with.
 */
const storeDirectoryPath = (memoryDir: string): string => {
  try {
    return decodeURIComponent(new URL(memoryDir).pathname);
  } catch {
    return memoryDir;
  }
};

/**
 * Resolves the environment the console serves under, and the account of where
 * each value came from.
 *
 * Throws with the flag to set whenever a value is neither recorded by a loom
 * instance nor named by `options`, so an operator reads what to supply rather
 * than discovering later that a run had no labels or no data.
 */
export const resolveConsoleLaunchPlan = (
  records: ConsoleLaunchRecords,
  options: ConsoleLaunchOptions,
): ConsoleLaunchPlan => {
  const { instance } = records;
  const defaults = instance === undefined ? {} : objectField(
    parseJsonRecord(instance.piecesJson, instance.piecesJsonPath),
    "defaults",
  );
  const instanceSource = instance === undefined
    ? undefined
    : `\`${instance.piecesJsonPath}\``;

  // Each of the four the console cannot start without, in one shape: what the
  // caller named, else what the instance recorded, else an error naming the
  // flag and the variable that supply it. A fabric with no instance behind it
  // reaches the same error rather than a different code path.
  const fromPieces = (
    record: Record<string, unknown>,
    key: string,
  ): { value: string; source: string } | undefined => {
    const value = stringField(record, key);
    return value === undefined || instanceSource === undefined
      ? undefined
      : { value, source: instanceSource };
  };
  const required = (
    named: string | undefined,
    recorded: { value: string; source: string } | undefined,
    inherited: string | undefined,
    what: string,
    flag: string,
    variable: string,
  ): { value: string; source: string } => {
    if (named !== undefined) {
      return { value: named, source: NAMED };
    }
    if (recorded !== undefined) {
      return recorded;
    }
    if (inherited !== undefined) {
      return { value: inherited, source: `\`${variable}\`, inherited` };
    }
    throw new Error(
      `no ${what}: set \`${flag}\` or \`${variable}\`` +
        (instance === undefined
          ? ""
          : `, or record it in \`${instance.piecesJsonPath}\``),
    );
  };

  const identity = required(
    options.identity,
    fromPieces(defaults, "identity"),
    options.inheritedIdentity,
    "identity keyfile, which the console signs every write with",
    "--fabric-identity",
    "CF_HARNESS_FABRIC_IDENTITY` or `CF_IDENTITY",
  );
  const space = required(
    options.space,
    fromPieces(defaults, "local_space"),
    options.inheritedSpace,
    "space, which the console writes its pieces into",
    "--fabric-space",
    "CF_HARNESS_FABRIC_SPACE` or `CF_SPACE",
  );
  const toolshedUrl = required(
    options.toolshedUrl,
    fromPieces(objectField(defaults, "server_urls"), "toolshed"),
    options.inheritedToolshedUrl,
    "toolshed URL, which is the fabric the console runs against",
    "--fabric-api-url",
    "CF_HARNESS_FABRIC_API_URL",
  );
  if (isDID(space.value)) {
    throw new Error(
      `the space must be a name rather than a DID: \`assign_slug\` composes ` +
        `a piece's URL from the name, and offers none for ${space.value}`,
    );
  }
  const store = required(
    options.store,
    instance === undefined || nonEmpty(instance.toolshedStoreDir) === undefined
      ? undefined
      : {
        value: instance.toolshedStoreDir,
        source: `\`loom toolshed-store-dir ${instance.id}\``,
      },
    options.inheritedStore,
    "store, which is where the console reads the labels a run wrote",
    "--store",
    "MEMORY_DIR",
  );

  // Every session this console runs holds these, so they are resolved here
  // with the rest of the fabric's own facts rather than attached per task by
  // whatever opens the console.
  const connectorGrants: HarnessConnectorGrantSpec[] = [];
  const connectorResolved: ResolvedValue[] = [];
  const connectorHealth: ConsoleHealthFactWithState[] = [];
  if (instance !== undefined) {
    const resolvedConnectors = resolveConnectorGrants({
      ...(instance.handlesJson !== undefined
        ? { handlesJson: instance.handlesJson }
        : {}),
      handlesJsonPath: instance.handlesJsonPath,
      piecesJson: instance.piecesJson,
      piecesJsonPath: instance.piecesJsonPath,
    });
    connectorGrants.push(...resolvedConnectors.grants);
    const source = "loom connector receipt + pieces.json";
    const detail = `${instance.handlesJsonPath}; ${instance.piecesJsonPath}`;
    connectorHealth.push({
      id: "connectors.inventory",
      group: "connectors",
      label: "Connector Inventory",
      state: instance.handlesJson === undefined ? "unknown" : "ok",
      value: instance.handlesJson === undefined
        ? "No injection receipt has been recorded"
        : `${resolvedConnectors.grants.length} granted; ${resolvedConnectors.unnamed.length} not granted`,
      source,
      detail,
      ...(instance.handlesJson === undefined
        ? {
          remedy:
            "Reconcile the instance's connectors in Loom, then restart the console.",
        }
        : {}),
    });
    for (const grant of resolvedConnectors.grants) {
      connectorResolved.push({
        name: `grant ${connectorGrantLabel(grant)}`,
        value: grant.ref,
        source: `\`${instance.handlesJsonPath}\`, classed by ` +
          `\`${grant.source.piece}\` in \`${instance.piecesJsonPath}\``,
      });
      connectorHealth.push({
        id: `connector.granted.${grant.name}`,
        group: "connectors",
        label: connectorGrantName(grant.source),
        state: "ok",
        value: `granted: ${connectorGrantLabel(grant)}`,
        source: `${source} (${grant.source.piece})`,
        detail,
      });
    }
    for (const [index, handle] of resolvedConnectors.unnamed.entries()) {
      connectorResolved.push({
        name: `grant ${connectorGrantName(handle)}`,
        value: `(none: ${handle.reason})`,
        source: `\`${instance.handlesJsonPath}\``,
      });
      connectorHealth.push({
        id: `connector.refused.${index}`,
        group: "connectors",
        label: connectorGrantName(handle),
        state: handle.state,
        value: "not granted",
        source: `${source} (${handle.piece})`,
        detail,
        reason: handle.reason,
        remedy: handle.remedy,
      });
    }
  }

  const runsc = records.sandbox?.selection.sandboxRuntimeKind === "runsc"
    ? records.sandbox
    : undefined;
  let cfcResultDir: string | undefined;
  let cfcInvocationContextDir: string | undefined;
  if (runsc !== undefined) {
    // The direct driver carries its CFC transport on descriptors, so a
    // directory named here would be printed and exported while nothing reads
    // it.
    const named = options.cfcResultDir !== undefined
      ? "--cfc-result-dir"
      : options.cfcInvocationContextDir !== undefined
      ? "--cfc-invocation-context-dir"
      : undefined;
    if (named !== undefined) {
      throw new Error(
        `\`${named}\` names a sidecar directory of the Docker driver, and ` +
          `\`${SANDBOX_RUNTIME_ENV}\` puts this console on the direct runsc ` +
          `driver, which reads none; drop the flag, or unset ` +
          `\`${SANDBOX_RUNTIME_ENV}\` to run on Docker`,
      );
    }
  } else {
    const sidecars = registeredCfcSidecarHostDirs({
      runtimeName: RUNSC_CFC_RUNTIME,
      runtimes: records.dockerRuntimes,
    });
    const registrationSource = records.dockerRuntimesUnreadable ??
      `no \`${RUNSC_CFC_RUNTIME}\` runtime \`docker info\` reports names it`;
    cfcResultDir = options.cfcResultDir ?? sidecars.resultDir;
    if (cfcResultDir === undefined) {
      throw new Error(
        `no directory is registered for \`--cfc-result-dir\`: ` +
          `${registrationSource}; set \`--cfc-result-dir\` to the directory ` +
          `the runtime writes its result sidecars to`,
      );
    }
    cfcInvocationContextDir = options.cfcInvocationContextDir ??
      sidecars.invocationContextDir;
    if (cfcInvocationContextDir === undefined) {
      throw new Error(
        `no directory is registered for ` +
          `\`--cfc-invocation-context-dir\`: ${registrationSource}; set ` +
          `\`--cfc-invocation-context-dir\` to the directory the runtime ` +
          `reads invocation contexts from`,
      );
    }
  }

  if (
    options.patternIndexUrl !== undefined && options.noPatternIndex === true
  ) {
    throw new Error(
      "`--pattern-index-url` and `--no-pattern-index` contradict each other; " +
        "name an index or waive it, not both",
    );
  }
  if (
    options.skillsRegistryUrl !== undefined && options.noSkillsRegistry === true
  ) {
    throw new Error(
      "`--skills-registry-url` and `--no-skills-registry` contradict each " +
        "other; name a registry or waive it, not both",
    );
  }
  // Not derived and not required: these belong to the deployment rather than
  // to the fabric, so the constant is the answer and the flag moves it.
  const patternIndexUrl = options.noPatternIndex === true
    ? undefined
    : options.patternIndexUrl ?? DEPLOYMENT_PATTERN_INDEX_URL;
  const skillsRegistryUrl = options.noSkillsRegistry === true
    ? undefined
    : options.skillsRegistryUrl ?? DEPLOYMENT_SKILLS_REGISTRY_URL;

  // The port loom's `/harness-console/*` proxy resolves its target with, in
  // its order: the instance's own record, then the console's variable, then
  // the port Weaver pairs with. Reading the same inputs the same way is what
  // makes recording a port in one place move both sides.
  const recordedPort = numericField(defaults, "harness_console_port");
  const port = options.port ?? recordedPort ?? options.inheritedPort ??
    WEAVER_PAIRING_PORT;
  const consoleDir = options.consoleDir ??
    (instance === undefined
      ? `.cf-harness-console-${port}`
      : `.cf-harness-console-${instance.id}-${port}`);
  const posture = options.posture ?? "max-enforcement";
  const flowLabels = options.flowLabels ?? "persist";
  const enforcementMode = options.enforcementMode ??
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE;

  const deploymentDefault = "labs deployment default";
  const registrationSourceName =
    `\`${RUNSC_CFC_RUNTIME}\` as \`docker info\` reports it`;

  // The operator's one decision about skill scripts. Nothing about the fabric
  // implies it, so it is off unless someone says otherwise, and the printout
  // says which of the two ways they said it.
  const allowSkillScripts = options.allowSkillScripts === true ||
    options.inheritedAllowSkillScripts === true;
  const allowSkillScriptsSource = options.allowSkillScripts === true
    ? NAMED
    : options.inheritedAllowSkillScripts === true
    ? "`CF_HARNESS_ALLOW_SKILL_SCRIPTS`, inherited"
    : LAUNCHER_DEFAULT;

  const resolved: ResolvedValue[] = [
    ...(instance === undefined ? [] : [{
      name: "instance",
      value: instance.id,
      source: NAMED,
    }]),
    {
      name: "port",
      value: String(port),
      source: options.port !== undefined
        ? NAMED
        : recordedPort !== undefined && instanceSource !== undefined
        ? instanceSource
        : options.inheritedPort !== undefined
        ? "`CF_HARNESS_CONSOLE_PORT`, inherited"
        : `${LAUNCHER_DEFAULT} (the port Weaver pairs with)`,
    },
    {
      name: "console dir",
      value: consoleDir,
      source: options.consoleDir === undefined
        ? `${LAUNCHER_DEFAULT} (one directory per fabric and port)`
        : NAMED,
    },
    { name: "space", value: space.value, source: space.source },
    { name: "identity", value: identity.value, source: identity.source },
    { name: "toolshed", value: toolshedUrl.value, source: toolshedUrl.source },
    {
      name: "store",
      value: storeDirectoryPath(store.value),
      source: store.source,
    },
    ...(runsc !== undefined ? runscResolvedValues(runsc) : [
      {
        name: "cfc results",
        value: cfcResultDir!,
        source: options.cfcResultDir === undefined
          ? registrationSourceName
          : NAMED,
      },
      {
        name: "cfc contexts",
        value: cfcInvocationContextDir!,
        source: options.cfcInvocationContextDir === undefined
          ? registrationSourceName
          : NAMED,
      },
    ]),
    {
      name: "posture",
      value: `${posture}, flow labels ${flowLabels}, ${enforcementMode}`,
      source: options.posture === undefined &&
          options.flowLabels === undefined &&
          options.enforcementMode === undefined
        ? LAUNCHER_DEFAULT
        : NAMED,
    },
    {
      name: "index",
      value: patternIndexUrl ?? "(none: --no-pattern-index)",
      source:
        patternIndexUrl === undefined || options.patternIndexUrl !== undefined
          ? NAMED
          : deploymentDefault,
    },
    {
      name: "skills",
      value: skillsRegistryUrl ?? "(none: --no-skills-registry)",
      source: skillsRegistryUrl === undefined ||
          options.skillsRegistryUrl !== undefined
        ? NAMED
        : deploymentDefault,
    },
    {
      name: "skill scripts",
      value: allowSkillScripts ? "run in the sandbox" : "not run",
      source: allowSkillScriptsSource,
    },
    ...connectorResolved,
    {
      name: "proxy",
      value: "removed from the environment",
      source: "launcher",
    },
  ];

  const environment: Record<string, string> = {
    CF_HARNESS_CONSOLE_PORT: String(port),
    CF_HARNESS_CONSOLE_DIR: consoleDir,
    CF_HARNESS_FABRIC_API_URL: toolshedUrl.value,
    CF_HARNESS_FABRIC_IDENTITY: identity.value,
    CF_HARNESS_FABRIC_SPACE: space.value,
    CF_HARNESS_FABRIC_CFC_POSTURE: posture,
    CF_HARNESS_FABRIC_CFC_FLOW_LABELS: flowLabels,
    CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE: enforcementMode,
    ...(cfcResultDir !== undefined && cfcInvocationContextDir !== undefined
      ? {
        CF_HARNESS_RUNSC_CFC_RESULT_DIR: cfcResultDir,
        CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: cfcInvocationContextDir,
      }
      : {}),
    MEMORY_DIR: storeDirectoryPath(store.value),
    ...(connectorGrants.length > 0
      ? { CF_HARNESS_CONNECTOR_GRANTS: JSON.stringify(connectorGrants) }
      : {}),
    ...(patternIndexUrl !== undefined
      ? { CF_HARNESS_PATTERN_INDEX_URL: patternIndexUrl }
      : {}),
    ...(skillsRegistryUrl !== undefined
      ? { CF_HARNESS_SKILLS_REGISTRY_URL: skillsRegistryUrl }
      : {}),
    ...(allowSkillScripts ? { CF_HARNESS_ALLOW_SKILL_SCRIPTS: "1" } : {}),
  };

  return {
    environment,
    resolved,
    health: { resolved, connectors: connectorHealth },
  };
};

/**
 * What a console on the direct runsc driver runs under, each value beside the
 * variable that named it. These pass through to the console as inherited
 * rather than being set by the launch, and are printed so the report
 * accounts for them.
 */
const runscResolvedValues = (
  sandbox: ConsoleLaunchSandbox,
): ResolvedValue[] => {
  const { selection } = sandbox;
  const inherited = (variable: string) => `\`${variable}\`, inherited`;
  return [{
    name: "sandbox",
    value: "runsc",
    source: inherited(SANDBOX_RUNTIME_ENV),
  }, {
    name: "runsc",
    value: selection.sandboxRunscBinary ?? "`runsc`, looked for on `PATH`",
    source: selection.sandboxRunscBinary !== undefined
      ? inherited(RUNSC_BINARY_ENV)
      : "harness default",
  }, {
    name: "rootfs",
    value: selection.sandboxRootfs ?? "(the driver's default)",
    source: selection.sandboxRootfs !== undefined
      ? inherited(SANDBOX_ROOTFS_ENV)
      : "harness default",
  }, {
    name: "cfc policy",
    // The console takes no loop enforcement mode, so its turns run at the
    // harness default.
    value: selection.sandboxCfcPolicy ??
      (runscWithoutPolicyRefusesTurns(DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE)
        ? `(none: every turn is refused at \`${DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE}\`)`
        : "(none: `runsc` runs without `--cfc`)"),
    source: sandbox.policyNamed
      ? inherited(RUNSC_CFC_POLICY_ENV)
      : "harness default",
  }];
};

/** The lines the launcher prints before the server binds. */
export const consoleLaunchReport = (
  plan: ConsoleLaunchPlan,
): readonly string[] => {
  const width = plan.resolved.reduce(
    (widest, entry) => Math.max(widest, entry.name.length),
    0,
  );
  return [
    "  cf-harness console, resolved from the fabric it runs against:",
    ...plan.resolved.map((entry) =>
      `  ${entry.name.padEnd(width)}  ${entry.value}   [${entry.source}]`
    ),
  ];
};

const loomDataDirectory = (env: Record<string, string | undefined>): string => {
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  if (xdg !== undefined) {
    return join(xdg, "loom");
  }
  const home = nonEmpty(env.HOME);
  if (home === undefined) {
    throw new Error(
      "neither `XDG_DATA_HOME` nor `HOME` is set, so loom's instance " +
        "directory cannot be located",
    );
  }
  return join(home, ".local", "share", "loom");
};

export const readOptionalFile = async (
  path: string,
): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Runs `loom toolshed-store-dir <instance>`, which never mutates and prints
 * the store the instance's toolshed serves. A `loom` that exits nonzero is
 * reported with its own diagnostic, since it is the one that knows why.
 */
export const readToolshedStoreDir = async (
  loomBinary: string,
  instance: string,
): Promise<string> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(loomBinary, {
      args: ["toolshed-store-dir", instance],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw new Error(
      `could not run \`${loomBinary} toolshed-store-dir ${instance}\`: ` +
        `${error instanceof Error ? error.message : String(error)}; set ` +
        `\`--loom-bin\` to loom's executable`,
    );
  }
  if (!output.success) {
    throw new Error(
      `\`${loomBinary} toolshed-store-dir ${instance}\` failed: ` +
        new TextDecoder().decode(output.stderr).trim(),
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
};

const positiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
};

/**
 * The three readings a launch makes of the machine it runs on. Named as one
 * interface because they are what separates deciding the console's
 * configuration from finding out what the machine says: everything else in
 * `prepareConsoleLaunch` is argument and environment, which a caller supplies.
 */
export interface ConsoleLaunchIo {
  readTextFile: (path: string) => Promise<string | undefined>;
  readToolshedStoreDir: (
    loomBinary: string,
    instance: string,
  ) => Promise<string>;
  readDockerRuntimes: () => Promise<
    { runtimes?: unknown; unreadable?: string }
  >;
}

const REAL_IO: ConsoleLaunchIo = {
  readTextFile: readOptionalFile,
  readToolshedStoreDir,
  readDockerRuntimes: () => readDockerRuntimes(DEFAULT_DOCKER_BINARY),
};

/**
 * Reads what the fabric records and resolves the console's environment from
 * it, stopping short of serving: the plan, and the arguments after `--` that
 * belong to the console rather than to this launcher.
 */
export const prepareConsoleLaunch = async (
  args: readonly string[],
  env: Record<string, string | undefined>,
  io: ConsoleLaunchIo = REAL_IO,
): Promise<{ plan: ConsoleLaunchPlan; consoleArgs: string[] }> => {
  const parsed = parseArgs([...args], {
    string: [
      "instance",
      "loom-bin",
      "port",
      "console-dir",
      "fabric-identity",
      "fabric-space",
      "fabric-api-url",
      "store",
      "pattern-index-url",
      "skills-registry-url",
      "cfc-result-dir",
      "cfc-invocation-context-dir",
      "fabric-cfc-posture",
      "fabric-cfc-flow-labels",
      "fabric-cfc-enforcement-mode",
    ],
    boolean: [
      "no-pattern-index",
      "no-skills-registry",
      "allow-skill-scripts",
    ],
    "--": true,
  });
  // Before anything is read: the launcher selects the sandbox from the
  // environment, as the console does, and a selection flag it ignored would
  // launch a console on a sandbox other than the one it was asked for.
  refuseBatchSandboxFlags(parsed);
  // A flag present but empty is a value someone typed that did not survive
  // parsing — `--port -1` leaves `port` empty, because `-1` reads as a flag of
  // its own — so it is refused rather than falling through to the default the
  // person was overriding.
  const flag = (name: string): string | undefined => {
    const value = parsed[name];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = nonEmpty(value);
    if (trimmed === undefined) {
      throw new Error(
        `\`--${name}\` was given no value; a value starting with \`-\` needs ` +
          `the \`--${name}=<value>\` spelling`,
      );
    }
    return trimmed;
  };

  // `--instance` alone opts into reading a loom instance's records. An
  // inherited `LOOM_INSTANCE_ID` does not: the console comes along because
  // someone asked for it, and the ambient variable is a fact about the process
  // tree rather than a decision.
  const instanceId = flag("instance");
  const loomBinary = flag("loom-bin") ?? nonEmpty(env.LOOM_BIN) ?? "loom";
  let instance: LoomInstanceRecords | undefined;
  if (instanceId !== undefined) {
    const piecesJsonPath = join(
      loomDataDirectory(env),
      "instances",
      instanceId,
      "pieces.json",
    );
    const piecesJson = await io.readTextFile(piecesJsonPath);
    if (piecesJson === undefined) {
      throw new Error(
        `loom instance \`${instanceId}\` has no \`${piecesJsonPath}\`; name ` +
          `a running instance with \`--instance\``,
      );
    }
    const handlesJsonPath = join(
      loomDataDirectory(env),
      "instances",
      instanceId,
      "sqlite-injection",
      "handles.json",
    );
    const handlesJson = await io.readTextFile(handlesJsonPath);
    instance = {
      id: instanceId,
      piecesJson,
      piecesJsonPath,
      toolshedStoreDir: await io.readToolshedStoreDir(loomBinary, instanceId),
      ...(handlesJson !== undefined ? { handlesJson } : {}),
      handlesJsonPath,
    };
  }

  // Two vocabularies name these, and both are already exported on the machines
  // this runs on: the console's own, which its flags and README use, and the
  // `cf` CLI's, which a person who has ever run `cf` has set. Reading both is
  // what stops a value that is plainly present from reading as absent; the
  // console's own name wins, being the one that names this surface.
  const inheritedIdentity = nonEmpty(env.CF_HARNESS_FABRIC_IDENTITY) ??
    nonEmpty(env.CF_IDENTITY);
  const inheritedSpace = nonEmpty(env.CF_HARNESS_FABRIC_SPACE) ??
    nonEmpty(env.CF_SPACE);

  // Read the way the server reads it, from the same environment, so the
  // launch and the console describe one sandbox.
  const selection = await resolveSandboxRuntimeSelection(env, {}, {
    cwd: Deno.cwd(),
  });
  // Only the Docker driver has a runtime table to read. Not configurable
  // there: that sandbox runs `docker`, so a launcher reading the table from
  // anything else would print directories the runs never reach.
  const docker = selection.sandboxRuntimeKind === "runsc"
    ? {}
    : await io.readDockerRuntimes();

  const plan = resolveConsoleLaunchPlan({
    ...(instance !== undefined ? { instance } : {}),
    sandbox: {
      selection,
      policyNamed: nonEmpty(env[RUNSC_CFC_POLICY_ENV]) !== undefined,
    },
    ...(docker.runtimes !== undefined
      ? { dockerRuntimes: docker.runtimes }
      : {}),
    ...(docker.unreadable !== undefined
      ? { dockerRuntimesUnreadable: docker.unreadable }
      : {}),
  }, {
    ...(flag("fabric-identity") !== undefined
      ? { identity: flag("fabric-identity")! }
      : {}),
    ...(inheritedIdentity !== undefined ? { inheritedIdentity } : {}),
    ...(flag("fabric-space") !== undefined
      ? { space: flag("fabric-space")! }
      : {}),
    ...(inheritedSpace !== undefined ? { inheritedSpace } : {}),
    ...(flag("fabric-api-url") !== undefined
      ? { toolshedUrl: flag("fabric-api-url")! }
      : {}),
    ...(nonEmpty(env.CF_HARNESS_FABRIC_API_URL) !== undefined
      ? { inheritedToolshedUrl: nonEmpty(env.CF_HARNESS_FABRIC_API_URL)! }
      : {}),
    ...(flag("store") !== undefined ? { store: flag("store")! } : {}),
    ...(nonEmpty(env.MEMORY_DIR) !== undefined
      ? { inheritedStore: nonEmpty(env.MEMORY_DIR)! }
      : {}),
    ...(flag("port") !== undefined
      ? { port: positiveInteger(flag("port")!, "--port") }
      : {}),
    ...(nonEmpty(env.CF_HARNESS_CONSOLE_PORT) !== undefined
      ? {
        inheritedPort: positiveInteger(
          nonEmpty(env.CF_HARNESS_CONSOLE_PORT)!,
          "CF_HARNESS_CONSOLE_PORT",
        ),
      }
      : {}),
    ...(flag("console-dir") !== undefined
      ? { consoleDir: flag("console-dir")! }
      : {}),
    ...(flag("pattern-index-url") !== undefined
      ? { patternIndexUrl: flag("pattern-index-url")! }
      : {}),
    ...(flag("skills-registry-url") !== undefined
      ? { skillsRegistryUrl: flag("skills-registry-url")! }
      : {}),
    noPatternIndex: parsed["no-pattern-index"] === true,
    noSkillsRegistry: parsed["no-skills-registry"] === true,
    allowSkillScripts: parsed["allow-skill-scripts"] === true,
    inheritedAllowSkillScripts:
      nonEmpty(env.CF_HARNESS_ALLOW_SKILL_SCRIPTS) === "1",
    ...(flag("cfc-result-dir") !== undefined
      ? { cfcResultDir: flag("cfc-result-dir")! }
      : {}),
    ...(flag("cfc-invocation-context-dir") !== undefined
      ? { cfcInvocationContextDir: flag("cfc-invocation-context-dir")! }
      : {}),
    ...(flag("fabric-cfc-posture") !== undefined
      ? { posture: flag("fabric-cfc-posture")! }
      : {}),
    ...(flag("fabric-cfc-flow-labels") !== undefined
      ? { flowLabels: flag("fabric-cfc-flow-labels")! }
      : {}),
    ...(flag("fabric-cfc-enforcement-mode") !== undefined
      ? { enforcementMode: flag("fabric-cfc-enforcement-mode")! }
      : {}),
  });

  // The launch prints what it resolved, and this is one of the values it
  // resolves, so a console argument setting it again would leave that report
  // describing a console that does something else. Every other server flag
  // still passes through.
  const consoleArgs = (parsed["--"] ?? []).map(String);
  // Both spellings: a boolean flag still parses `--flag=true` and `--flag=1`,
  // so an exact-token check leaves the enabling form through and the printed
  // report then describes a console that does something else.
  const passedThrough = consoleArgs.find((argument) =>
    argument === "--allow-skill-scripts" ||
    argument.startsWith("--allow-skill-scripts=")
  );
  if (passedThrough !== undefined) {
    throw new Error(
      `\`${passedThrough}\` cannot be passed through to the console: ` +
        `\`--allow-skill-scripts\` is one of the values this launch ` +
        `resolves and prints, so name it before \`--\` instead`,
    );
  }

  return { plan, consoleArgs };
};

/**
 * Reads what the fabric records, prints the account of what it resolved to,
 * and serves under it.
 */
export const launchConsole = async (
  args: readonly string[] = Deno.args,
  env: Record<string, string | undefined> = Deno.env.toObject(),
  serve: (
    consoleArgs: string[],
    health: ConsoleObservedLaunchHealth,
  ) => Promise<void> = (consoleArgs, health) =>
    startConsoleServer(consoleArgs, undefined, undefined, health),
  io: ConsoleLaunchIo = REAL_IO,
): Promise<void> => {
  const { plan, consoleArgs } = await prepareConsoleLaunch(args, env, io);
  const health = { ...plan.health, checkedAt: new Date().toISOString() };

  console.log("");
  for (const line of consoleLaunchReport(plan)) {
    console.log(line);
  }

  for (const variable of [...PROXY_VARIABLES, ...LAUNCHER_OWNED_VARIABLES]) {
    Deno.env.delete(variable);
  }
  for (const [name, value] of Object.entries(plan.environment)) {
    Deno.env.set(name, value);
  }
  // These are the decisions that produced the running console's grants. A
  // status request reports this observation even if the files later change.
  await serve(consoleArgs, health);
};

/**
 * What a launch that could not start says. A misconfigured launch is an
 * operator's problem to fix and the message is the whole of what they need,
 * so the stack behind it — which names this file rather than their mistake —
 * is dropped.
 */
export const launchFailureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Running the file serves; importing it (the tests do) serves nothing.
if (import.meta.main) {
  try {
    await launchConsole();
  } catch (error) {
    console.error(launchFailureMessage(error));
    Deno.exit(1);
  }
}
