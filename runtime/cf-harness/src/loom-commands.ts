/**
 * Lists and runs the commands a host offers, over the host's command
 * endpoint: `GET <url>/commands` lists them and `POST <url>/command` runs
 * one. Every request carries the run id the host gave this run, so the host
 * attributes the call to the job it started, and every command names the
 * actor the host configured. The host decides what it lists for this caller
 * and what runs. Nothing here names a command.
 *
 * What this module adds is the reading: a manifest row becomes a
 * `HarnessCallableDescriptor`, and a command's answer is checked to be the
 * JSON object the command layer returns.
 */

import type { JSONObject } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type {
  HarnessCallableDescriptor,
  HarnessCallableEffect,
} from "./contracts/callable.ts";
import {
  HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH,
  HARNESS_COMMAND_ID_MAX_LENGTH,
  HARNESS_COMMAND_ID_PATTERN,
  HARNESS_COMMAND_SCHEMA_MAX_BYTES,
  HARNESS_COMMAND_SUMMARY_MAX_LENGTH,
  harnessCommandJsonBytes,
} from "./contracts/client-command.ts";
import { withoutSchemaExtensions } from "./loom-command-signature.ts";

/** Configuration supplied by the host, outside the model's tool inputs. */
export interface HarnessLoomCommandsConfig {
  /** Base URL of the host's command endpoint, `http:` or `https:`. */
  url: string;

  /** The actor every command runs as, passed to the host as given. */
  actor: string;

  /** The host's id for the job this run serves, sent on every request. */
  runId: string;

  /**
   * Ids of the commands the host names as relevant to this run, which
   * `list_commands` shows first and marks. A hint only: it neither adds a
   * command to the listing nor takes one away.
   */
  relevant?: readonly string[];
}

/** The header that carries {@link HarnessLoomCommandsConfig.runId}. */
export const COMMAND_RUN_ID_HEADER = "X-Loom-Agent-Run-Id";

/** One command a host admits, as `list_commands` shows it. */
export interface LoomCommandEntry extends HarnessCallableDescriptor {
  /** What the command acts on: `global`, `loom`, or another host scope. */
  target: string;

  /** The field names the command's answer declares among its outputs. */
  outputs?: string[];

  /**
   * Inputs the host fills from a call's context (`x-source` in the row's
   * schema), which a call may leave out though the schema requires them.
   */
  hostFilled?: string[];
}

/** A host's command manifest, read as the entries an agent may call. */
export interface LoomCommandCatalog {
  entries: LoomCommandEntry[];

  /** Rows left out because they could not be read as a command. */
  malformed: number;
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

/**
 * Why `url` cannot be a command endpoint's base URL, or `undefined` when it
 * can: it must be `http:` or `https:`, and hold no query or fragment, not
 * even an empty one, since the routes are appended to it as written.
 */
export const commandEndpointUrlProblem = (url: unknown): string | undefined => {
  if (typeof url !== "string" || !URL.canParse(url)) {
    return "Commands require an `http:` or `https:` endpoint URL.";
  }
  if (!["http:", "https:"].includes(new URL(url).protocol)) {
    return "Commands require an `http:` or `https:` endpoint URL.";
  }
  if (url.includes("?") || url.includes("#")) {
    return "Commands require an endpoint URL with no query or fragment.";
  }
  return undefined;
};

/** Validates host configuration before it can advertise a command tool. */
export const validateLoomCommandsConfig = (
  config: HarnessLoomCommandsConfig,
): void => {
  const problem = commandEndpointUrlProblem(config.url);
  if (problem !== undefined) throw new Error(problem);
  if (typeof config.actor !== "string" || config.actor === "") {
    throw new Error("Commands require the actor they run as.");
  }
  if (
    typeof config.runId !== "string" || config.runId === "" ||
    /[^\x21-\x7e]/.test(config.runId)
  ) {
    throw new Error(
      "Commands require a run id of printable, unspaced ASCII characters.",
    );
  }
  if (
    config.relevant !== undefined &&
    (!Array.isArray(config.relevant) ||
      !config.relevant.every((id) => typeof id === "string"))
  ) {
    throw new Error("Relevant commands must be a list of command ids.");
  }
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
  // Extension keywords are the host's annotations for its own surfaces; no
  // schema shown to the model carries them. The size bound applies to what
  // is shown, so annotations alone never make a typed schema read as open.
  const stripped = isRecord(inputs)
    ? withoutSchemaExtensions(inputs as JSONObject)
    : undefined;
  const inputSchema = stripped !== undefined &&
      harnessCommandJsonBytes(stripped) <= HARNESS_COMMAND_SCHEMA_MAX_BYTES
    ? stripped
    : true;
  // A compacted entry keeps its target and output names, so both are cut
  // to an identifier's length and the names to a few dozen.
  const outputNames = Array.isArray(outputs)
    ? outputs.filter((name): name is string => typeof name === "string")
      .slice(0, LOOM_COMMAND_OUTPUTS_LIMIT)
      .map((name) => name.slice(0, HARNESS_COMMAND_ID_MAX_LENGTH))
    : [];
  const hostFilled = isRecord(inputs) && isRecord(inputs.properties)
    ? Object.entries(inputs.properties)
      .filter(([, property]) =>
        isRecord(property) && property["x-source"] !== undefined
      )
      .map(([name]) => name)
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
    ...(hostFilled.length > 0 && inputSchema !== true ? { hostFilled } : {}),
  };
};

/**
 * Reads a manifest's command rows as the catalog an agent sees: every row
 * the host listed, in its order, but those that cannot be read as a command,
 * which are left out and counted.
 */
export const loomCommandCatalogOf = (
  commands: readonly unknown[],
): LoomCommandCatalog => {
  const entries: LoomCommandEntry[] = [];
  let malformed = 0;
  for (const row of commands) {
    const entry = isRecord(row) ? loomCommandEntryOfRow(row) : undefined;
    if (entry === undefined) {
      malformed += 1;
    } else {
      entries.push(entry);
    }
  }
  return { entries, malformed };
};

/** Most names a refused unknown command is offered in its place. */
export const LOOM_COMMAND_SUGGESTION_LIMIT = 3;

/** Helper for suggestions, which counts the edits between two names. */
const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
};

/**
 * The catalog's names nearest `name`, nearest first and at most
 * {@link LOOM_COMMAND_SUGGESTION_LIMIT}: a name that contains `name`, or
 * that `name` contains, before any other, then by edit distance, then by
 * name.
 */
export const nearestCommandNames = (
  name: string,
  names: readonly string[],
): string[] =>
  names
    .map((candidate) => ({
      candidate,
      contained: candidate.includes(name) || name.includes(candidate) ? 0 : 1,
      distance: editDistance(name, candidate),
    }))
    .sort((left, right) =>
      left.contained - right.contained || left.distance - right.distance ||
      (left.candidate < right.candidate ? -1 : 1)
    )
    .slice(0, LOOM_COMMAND_SUGGESTION_LIMIT)
    .map(({ candidate }) => candidate);

/**
 * Helper for both commands, which sends one request to the host's endpoint
 * with the run's id and reads the answer's text. A request that cannot be
 * sent, or whose answer cannot be read, throws.
 */
const request = async (
  config: HarnessLoomCommandsConfig,
  path: "commands" | "command",
  body: JSONObject | undefined,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; text: string }> => {
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      [COMMAND_RUN_ID_HEADER]: config.runId,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
    ...(signal !== undefined ? { signal } : {}),
  });
  return { ok: response.ok, text: await response.text() };
};

/** Reads the host's manifest through `GET <url>/commands`. */
export const listLoomCommands = async (
  config: HarnessLoomCommandsConfig,
  signal?: AbortSignal,
): Promise<LoomCommandListOutput> => {
  validateLoomCommandsConfig(config);
  const unread: LoomCommandListOutput = {
    status: "error",
    code: "command_failed",
    message: "The host's command list could not be read.",
  };
  let response;
  try {
    response = await request(config, "commands", undefined, signal);
  } catch {
    return unread;
  }
  // A refused listing is not the host's catalog, whatever its body says.
  if (!response.ok) return unread;
  let manifest: unknown;
  try {
    manifest = JSON.parse(response.text);
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
 * Runs one command through `POST <url>/command`, as the configured actor,
 * with the loom and expected version as the command's context. The command
 * layer answers every command it reached with a JSON object carrying a
 * boolean `ok`, a refusal included and whatever the HTTP status, so anything
 * else is an answer that was lost — and a lost answer may follow a command
 * that took effect.
 */
export const runLoomCommand = async (
  config: HarnessLoomCommandsConfig,
  invocation: LoomCommandInvocation,
  signal?: AbortSignal,
): Promise<LoomCommandRunOutput> => {
  validateLoomCommandsConfig(config);
  const context: JSONObject = {
    ...(invocation.loomId !== undefined ? { loom_id: invocation.loomId } : {}),
    ...(invocation.expectedVersion !== undefined
      ? { expected_version: invocation.expectedVersion }
      : {}),
  };
  const lost = (
    code: LoomCommandHostErrorCode,
    message: string,
  ): LoomCommandRunOutput => ({
    status: "error",
    code,
    message,
    landed: "unknown",
  });
  let text: string;
  try {
    ({ text } = await request(config, "command", {
      id: invocation.command,
      args: invocation.args,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      actor: config.actor,
    }, signal));
  } catch {
    return lost("command_failed", "The host command's answer was lost.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
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

/** The run's catalog as a caller reads it, or why it could not be read. */
export type LoomCommandCatalogRead =
  | { status: "ok"; catalog: LoomCommandCatalog }
  | { status: "error"; code: LoomCommandHostErrorCode; message: string };

/**
 * The catalog one run reads its commands from. The host is asked on first
 * use and the catalog held for the rest of the run, so a run of many
 * commands lists once; `refresh` asks again and holds what it reads. A read
 * that fails is not held, so the next use asks the host again. A read is
 * shared by every caller, so no one caller's cancellation ends it.
 */
export interface LoomCommandCatalogSource {
  /** The held catalog, read from the host when none is held yet. */
  current(): Promise<LoomCommandCatalogRead>;

  /** The host's catalog as it stands, held in place of the old one. */
  refresh(): Promise<LoomCommandCatalogRead>;
}

/** A catalog source over the host's `GET <url>/commands`. */
export const createLoomCommandCatalogSource = (
  config: HarnessLoomCommandsConfig,
): LoomCommandCatalogSource => {
  let held: Promise<LoomCommandCatalogRead> | undefined;
  const read = async (): Promise<LoomCommandCatalogRead> => {
    const listed = await listLoomCommands(config);
    return listed.status === "ok"
      ? { status: "ok", catalog: loomCommandCatalogOf(listed.commands) }
      : listed;
  };
  // Concurrent callers share one read; a failed one is let go once it
  // settles, unless a refresh has already replaced it.
  const hold = (reading: Promise<LoomCommandCatalogRead>) => {
    held = reading;
    const release = () => {
      if (held === reading) held = undefined;
    };
    reading.then((result) => {
      if (result.status === "error") release();
    }, release);
    return reading;
  };
  return {
    current: () => held ?? hold(read()),
    refresh: () => hold(read()),
  };
};
