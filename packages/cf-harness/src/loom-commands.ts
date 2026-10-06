/**
 * Lists and runs the commands a host admits, through the host's Loom CLI over
 * the scoped broker the host launched for the run. The broker is the
 * authority: it lists only the commands its grant admits, refuses every other
 * command it is asked to run, and stamps each command it forwards with the
 * agent actor and the run it was started for. Nothing here names a command.
 *
 * What this module adds is the reading: a manifest row becomes a
 * `HarnessCallableDescriptor`, rows whose own declarations say an agent may
 * not run them are left out, and a command's answer is checked to be the
 * JSON object the command layer returns. Every process runs over a cleared
 * environment; host text on stderr never reaches a caller.
 */

import type { JSONObject } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { isAbsolute } from "@std/path";

import type {
  HarnessCallableDescriptor,
  HarnessCallableEffect,
} from "./contracts/callable.ts";
import {
  HARNESS_COMMAND_CATALOG_LIMIT,
  HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH,
  HARNESS_COMMAND_ID_MAX_LENGTH,
  HARNESS_COMMAND_ID_PATTERN,
  HARNESS_COMMAND_SCHEMA_MAX_BYTES,
  HARNESS_COMMAND_SUMMARY_MAX_LENGTH,
  harnessCommandJsonBytes,
} from "./contracts/client-command.ts";
import type { ProcessRunner } from "./sandbox/process-runner.ts";
import { createClearedHostProcessEnv } from "./tools/host-process-env.ts";

/** Configuration supplied by the operator, outside the model's tool inputs. */
export interface HarnessLoomCommandsConfig {
  /** Absolute path to the host's executable Loom CLI. */
  cliPath: string;

  /** Host-chosen environment variable carrying the current job's identity. */
  jobIdEnvVar?: string;

  /** Current job identity supplied by the embedder, outside the config file. */
  jobId?: string;

  /**
   * The scoped broker the host launched. Only a broker is accepted: it is
   * what stamps the actor and run on every command and narrows what is
   * listed and run, so a run cannot be configured to attribute its own
   * writes.
   */
  transport: { kind: "broker"; queuePath: string };
}

/** One command a host admits, as `list_commands` shows it. */
export interface LoomCommandEntry extends HarnessCallableDescriptor {
  /** What the command acts on: `global`, `loom`, or another host scope. */
  target: string;

  /** The field names the command's answer declares among its outputs. */
  outputs?: string[];
}

/** A host's command manifest, read as the entries an agent may call. */
export interface LoomCommandCatalog {
  entries: LoomCommandEntry[];

  /** Rows left out because their declarations say an agent may not run them. */
  hidden: number;

  /** Rows left out because they could not be read as a command. */
  malformed: number;

  /** Rows left out past the catalog limit. */
  omitted: number;
}

/** One command to run, its arguments checked by the caller. */
export interface LoomCommandInvocation {
  command: string;
  args: JSONObject;

  /** The loom it acts on, passed to the command layer as its context. */
  loomId?: string;

  /** The loom version a write requires; a stale one is refused by the host. */
  expectedVersion?: number;
}

/** Why a host process produced nothing a caller can read. */
export type LoomCommandHostErrorCode = "command_failed" | "malformed_payload";

/** The manifest's commands, or why they could not be read. */
export type LoomCommandListOutput =
  | { status: "ok"; commands: readonly unknown[] }
  | { status: "error"; code: LoomCommandHostErrorCode; message: string };

/**
 * A command's answer, or why there is none. `landed` says whether the
 * command could have taken effect: a run whose answer was lost may have.
 */
export type LoomCommandRunOutput =
  | { status: "ok"; body: JSONObject; bodyBytes: number }
  | {
    status: "error";
    code: LoomCommandHostErrorCode;
    message: string;
    landed: "unknown";
  };

/** Most output names an entry carries from a manifest row. */
export const LOOM_COMMAND_OUTPUTS_LIMIT = 32;

/** Whether a decoded JSON value is an object with named properties. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/** Validates host configuration before it can advertise a command tool. */
export const validateLoomCommandsConfig = (
  config: HarnessLoomCommandsConfig,
): void => {
  if (
    config.jobIdEnvVar !== undefined &&
    (typeof config.jobIdEnvVar !== "string" ||
      !/^[A-Z_][A-Z0-9_]*$/.test(config.jobIdEnvVar) ||
      ["PATH", "LOOM_PAGE_RPC_QUEUE"].includes(config.jobIdEnvVar))
  ) {
    throw new Error(
      "Loom commands require a valid, nonreserved `jobIdEnvVar`.",
    );
  }
  if (!isAbsolute(config.cliPath)) {
    throw new Error("Loom commands require an absolute `cliPath`.");
  }
  const transport: unknown = config.transport;
  if (!isRecord(transport) || transport.kind !== "broker") {
    throw new Error(
      "Loom commands require the broker transport, which stamps the run's actor.",
    );
  }
  if (
    typeof transport.queuePath !== "string" || !isAbsolute(transport.queuePath)
  ) {
    throw new Error("Loom commands require an absolute broker `queuePath`.");
  }
};

/**
 * Reads an explicit operator-owned configuration file; absence grants
 * nothing.
 */
export const readLoomCommandsConfig = async (
  path: string | undefined,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
  jobId?: string,
): Promise<HarnessLoomCommandsConfig | undefined> => {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error("The Loom commands configuration path must be absolute.");
  }
  const value: unknown = JSON.parse(await readTextFile(path));
  if (!isRecord(value) || typeof value.cliPath !== "string") {
    throw new Error("Loom commands require a host CLI and a transport.");
  }
  const config = { ...value } as unknown as HarnessLoomCommandsConfig;
  if (jobId === undefined) delete config.jobId;
  else config.jobId = jobId;
  validateLoomCommandsConfig(config);
  return config;
};

/**
 * Whether a manifest row's own declarations say an agent may not run it. A
 * broker-stamped run reaches the command layer as an `agent:` actor with
 * origin `session`, so a row is left out when it is a pattern's verb (an
 * agent calls a piece's verbs through the piece it holds), a developer
 * command, one whose actors are all people, one that refuses or does not
 * require the `session` origin, or one that runs only over a person's
 * consent grant. The broker's grant decides what may run; this decides only
 * what is shown, and a row the host declares nothing about is shown.
 */
export const isHiddenFromAgents = (row: Record<string, unknown>): boolean => {
  const strings = (key: string): string[] =>
    Array.isArray(row[key])
      ? (row[key] as unknown[]).filter((entry) => typeof entry === "string")
      : [];
  const actors = strings("actors");
  const required = strings("origins_required");
  return row.origin === "pattern" ||
    row.developer === true ||
    (actors.length > 0 &&
      !actors.some((actor) => actor.startsWith("agent:"))) ||
    strings("origins_refused").includes("session") ||
    (required.length > 0 && !required.includes("session")) ||
    (row.grant !== undefined && row.grant !== null && row.grant !== false &&
      row.grant !== "");
};

/** Helper for projection, which keeps a nonempty string cut to `max`. */
const boundedText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;

/**
 * Reads one manifest row as the entry an agent sees, or `undefined` when the
 * row names no command id the contract's grammar admits. An argument schema
 * that is not an object, or is larger than a catalog entry may carry, is shown
 * as open (`true`); the command layer still validates what it is given.
 */
export const loomCommandEntryOfRow = (
  row: Record<string, unknown>,
): LoomCommandEntry | undefined => {
  const { id, inputs, scope, outputs, effect } = row;
  if (
    typeof id !== "string" || id.length > HARNESS_COMMAND_ID_MAX_LENGTH ||
    !HARNESS_COMMAND_ID_PATTERN.test(id)
  ) {
    return undefined;
  }
  const title = boundedText(row.title, HARNESS_COMMAND_SUMMARY_MAX_LENGTH);
  const description = boundedText(
    row.help,
    HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH,
  );
  const inputSchema = isRecord(inputs) &&
      harnessCommandJsonBytes(inputs) <= HARNESS_COMMAND_SCHEMA_MAX_BYTES
    ? inputs as JSONObject
    : true;
  // A compacted entry keeps its target and output names, so both are cut
  // to an identifier's length and the names to a few dozen.
  const outputNames = Array.isArray(outputs)
    ? outputs.filter((name): name is string => typeof name === "string")
      .slice(0, LOOM_COMMAND_OUTPUTS_LIMIT)
      .map((name) => name.slice(0, HARNESS_COMMAND_ID_MAX_LENGTH))
    : [];
  return {
    name: id,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    inputSchema,
    ...(effect === "read" || effect === "change"
      ? { effect: effect as HarnessCallableEffect }
      : {}),
    target: typeof scope === "string" && scope.length > 0
      ? scope.slice(0, HARNESS_COMMAND_ID_MAX_LENGTH)
      : "global",
    ...(outputNames.length > 0 ? { outputs: outputNames } : {}),
  };
};

/**
 * Reads a manifest's command rows as the catalog an agent sees: hidden rows
 * and unreadable rows left out and counted, and at most the contract's
 * catalog limit of entries kept, in the manifest's order.
 */
export const loomCommandCatalogOf = (
  commands: readonly unknown[],
): LoomCommandCatalog => {
  const entries: LoomCommandEntry[] = [];
  let hidden = 0;
  let malformed = 0;
  let omitted = 0;
  for (const row of commands) {
    const entry = isRecord(row) ? loomCommandEntryOfRow(row) : undefined;
    if (entry === undefined) {
      malformed += 1;
    } else if (isHiddenFromAgents(row as Record<string, unknown>)) {
      hidden += 1;
    } else if (entries.length < HARNESS_COMMAND_CATALOG_LIMIT) {
      entries.push(entry);
    } else {
      omitted += 1;
    }
  }
  return { entries, hidden, malformed, omitted };
};

/** Helper for both commands, which runs the CLI over the broker queue. */
const runCli = (
  config: HarnessLoomCommandsConfig,
  args: string[],
  runner: ProcessRunner,
  stdinText?: string,
) => {
  const env = createClearedHostProcessEnv();
  env.LOOM_PAGE_RPC_QUEUE = config.transport.queuePath;
  if (config.jobIdEnvVar !== undefined && config.jobId !== undefined) {
    env[config.jobIdEnvVar] = config.jobId;
  }
  return runner.run({
    command: config.cliPath,
    args,
    env,
    clearEnv: true,
    ...(stdinText !== undefined ? { stdinText } : {}),
  });
};

/** Reads the host's manifest through `loom command list --json`. */
export const listLoomCommands = async (
  config: HarnessLoomCommandsConfig,
  runner: ProcessRunner,
): Promise<LoomCommandListOutput> => {
  validateLoomCommandsConfig(config);
  const unread: LoomCommandListOutput = {
    status: "error",
    code: "command_failed",
    message: "The host's command list could not be read.",
  };
  let response;
  try {
    response = await runCli(config, ["command", "list", "--json"], runner);
  } catch {
    return unread;
  }
  // A listing the CLI did not finish is not the host's catalog, whatever it
  // printed.
  if (response.exitCode !== 0) return unread;
  let manifest: unknown;
  try {
    manifest = JSON.parse(response.stdout);
  } catch {
    return unread;
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.commands)) {
    return {
      status: "error",
      code: "malformed_payload",
      message: "The host's command list does not name its commands.",
    };
  }
  return { status: "ok", commands: manifest.commands };
};

/**
 * Runs one command through `loom command run <id> --args-json - --json`. The
 * command layer answers every command it reached with a JSON object carrying
 * a boolean `ok`, a refusal included, so anything else is an answer that was
 * lost — and a lost answer may follow a command that took effect.
 */
export const runLoomCommand = async (
  config: HarnessLoomCommandsConfig,
  invocation: LoomCommandInvocation,
  runner: ProcessRunner,
): Promise<LoomCommandRunOutput> => {
  validateLoomCommandsConfig(config);
  const argv = [
    "command",
    "run",
    invocation.command,
    "--args-json",
    "-",
    "--json",
    ...(invocation.loomId !== undefined ? ["--loom", invocation.loomId] : []),
    ...(invocation.expectedVersion !== undefined
      ? ["--expect", String(invocation.expectedVersion)]
      : []),
  ];
  const lost = (
    code: LoomCommandHostErrorCode,
    message: string,
  ): LoomCommandRunOutput => ({
    status: "error",
    code,
    message,
    landed: "unknown",
  });
  let stdout: string;
  try {
    ({ stdout } = await runCli(
      config,
      argv,
      runner,
      JSON.stringify(invocation.args),
    ));
  } catch {
    return lost("command_failed", "The host command's answer was lost.");
  }
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return lost("command_failed", "The host command's answer was lost.");
  }
  if (!isRecord(body) || typeof body.ok !== "boolean") {
    return lost(
      "malformed_payload",
      "The host command's answer is not a command result.",
    );
  }
  return {
    status: "ok",
    body: body as JSONObject,
    bodyBytes: harnessCommandJsonBytes(body),
  };
};
