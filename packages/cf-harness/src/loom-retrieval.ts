/**
 * Executes the host's read-only Loom retrieval commands: search, page reads,
 * person resolution, calendar events, ambient context, and the profile. The
 * operator names the CLI and its transport; the model supplies typed
 * arguments and nothing else. Every command runs over a cleared environment
 * and its stdout is parsed as JSON at this boundary, so a tool above only
 * ever handles a decoded payload or a typed failure.
 *
 * The retrieval commands take no `--read-ceiling-file`: loom applies its own
 * facet scope through the broker the host launched, so the ceiling a run
 * measures rows against is assembled here from the run's own ceiling and the
 * loom read-ceiling record the configuration names (`readCeilingFile`).
 */

import type { JSONValue } from "@commonfabric/api";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { isAbsolute } from "@std/path";

import type { HarnessLoomAuthoringTransport } from "./loom-authoring.ts";
import type { ProcessRunner } from "./sandbox/process-runner.ts";
import { createClearedHostProcessEnv } from "./tools/host-process-env.ts";

/** Configuration supplied by the operator, outside the model's tool inputs. */
export interface HarnessLoomRetrievalConfig {
  /** Absolute path to the host's executable Loom CLI. */
  cliPath: string;

  /**
   * The scoped broker, or an explicitly identified local instance. The
   * direct transport's `actor` attributes writes, which no retrieval command
   * performs; it is carried unused so one transport value serves both tool
   * families.
   */
  transport: HarnessLoomAuthoringTransport;

  /**
   * Absolute path to the loom read-ceiling record for this run — the file
   * `facet_scoped_run.py run-ceiling` writes, carrying `loomReadCeiling`,
   * `facets`, and `facetSource`. Its clause list is met with the run's own
   * ceiling before any row is measured. Absent, the run's ceiling stands
   * alone.
   */
  readCeilingFile?: string;

  /**
   * The facet ids the host launched the broker under. When a ceiling record
   * is named, its `facets` must equal these, so a run cannot measure rows
   * against a record written for another scope.
   */
  facets?: string[];
}

/** Commands admitted by the dedicated retrieval tools. */
export type LoomRetrievalCommand =
  | "search"
  | "page.discover"
  | "page.inspect"
  | "page.read"
  | "people"
  | "calendar.list"
  | "context"
  | "profile";

/**
 * The `schemaVersion` of the `loom search --json` payload this module reads.
 * A payload that states another version is refused; one that states none is
 * read as this version, which is what a loom that does not stamp its payload
 * emits.
 */
export const LOOM_SEARCH_SCHEMA_VERSION = 1;

/** Arguments of `loom search`. One of `query` and `person` is required. */
export interface LoomSearchInput {
  /** Search query; a regular expression, case-insensitive. */
  query?: string;

  /** Comma-separated subset of connector ids, source systems, or `fc`. */
  sources?: string;

  /** Lower event-time bound, ISO 8601 or date-only. */
  since?: string;

  /** Upper event-time bound, ISO 8601 or date-only. */
  until?: string;

  /** IANA timezone anchoring wall-clock bounds. */
  tz?: string;

  /** Email, phone, `person:<id>`, or page path scoping the search. */
  person?: string;

  /** Maximum hits, a positive integer. */
  limit?: number;

  /** Sort order. */
  rank?: "recency" | "score";
}

/** Arguments of `loom page discover`. */
export interface LoomPageDiscoverInput {
  /** Page kind filter. */
  kind?: string;

  /** Maximum pages, a positive integer. */
  limit?: number;
}

/** Arguments of `loom page inspect` and `loom page read`. */
export interface LoomPageTargetInput {
  /** Project id, page path, source path, or canonical alias. */
  target: string;
}

/** Arguments of `loom people`, restricted to a lookup. */
export interface LoomPeopleInput {
  /**
   * An email, phone, `handle:<value>`, `person:<id>`, `group:<name-or-id>`,
   * or `People/<Name>/about.md` page path. A bare name resolves nothing, and
   * the verbs `loom people` also takes are refused here.
   */
  query: string;

  /** Whether the card carries the user's private page notes. */
  shape?: "summary" | "card";
}

/** Arguments of `loom calendar list`. */
export interface LoomCalendarListInput {
  /** Window start, `YYYY-MM-DD`. */
  from?: string;

  /** Window end, `YYYY-MM-DD`. */
  to?: string;

  /** Every event, with no window; exclusive with `from` and `to`. */
  all?: boolean;
}

/** Arguments of `loom context where` and `loom context activity`. */
export interface LoomContextInput {
  /** Which read: where the user is, or their focus and AFK state. */
  read: "where" | "activity";

  /** Point in time: `now`, `now-30m`, or ISO 8601. */
  at?: string;

  /** Window start for `activity` segments. */
  since?: string;

  /** Window end for `activity` segments. */
  until?: string;
}

/** Arguments of `loom profile`. */
export interface LoomProfileInput {
  /** Prefer a live runtime read over the observed cache. */
  fresh?: boolean;
}

/** The typed input each command takes. */
export interface LoomRetrievalInputMap {
  search: LoomSearchInput;
  "page.discover": LoomPageDiscoverInput;
  "page.inspect": LoomPageTargetInput;
  "page.read": LoomPageTargetInput;
  people: LoomPeopleInput;
  "calendar.list": LoomCalendarListInput;
  context: LoomContextInput;
  profile: LoomProfileInput;
}

/** Why a command produced no payload. */
export type LoomRetrievalErrorCode =
  | "invalid_input"
  | "command_failed"
  | "host_refused"
  | "not_found"
  | "contested"
  | "schema_version_mismatch";

/** A host response checked at the command's serialization boundary. */
export type LoomRetrievalCommandOutput =
  | { status: "ok"; payload: JSONValue }
  | {
    status: "error";
    code: LoomRetrievalErrorCode;
    message: string;
    hostCode?: string;
  };

/** The loom read-ceiling record a facet-scoped run is dispatched with. */
export interface LoomReadCeilingRecord {
  /** The clause list loom's broker holds the run's connector reads to. */
  loomReadCeiling: CfcConfClause[];

  /** The facet ids the record was built for. */
  facets: string[];

  /** Where those facets came from. */
  facetSource: string;
}

/** Whether a decoded JSON value is an object with named properties. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/** A facet id as loom spells one: lowercase, digits, and hyphens. */
const FACET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A calendar date as `loom calendar list` parses one. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The longest free-text value forwarded to the CLI. */
const MAX_VALUE_LENGTH = 500;

/** Whether a string carries an ASCII control character. */
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

/** Whether a list holds facet ids only. */
const isFacetList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 &&
  value.every((facet) => typeof facet === "string" && FACET_ID.test(facet));

/** Validates host configuration before it can advertise a retrieval tool. */
export const validateLoomRetrievalConfig = (
  config: HarnessLoomRetrievalConfig,
): void => {
  if (!isAbsolute(config.cliPath)) {
    throw new Error("Loom retrieval requires an absolute `cliPath`.");
  }
  if (
    config.readCeilingFile !== undefined && !isAbsolute(config.readCeilingFile)
  ) {
    throw new Error(
      "Loom retrieval requires an absolute `readCeilingFile` when one is named.",
    );
  }
  if (config.facets !== undefined && !isFacetList(config.facets)) {
    throw new Error(
      "Loom retrieval `facets` must be a nonempty facet id list.",
    );
  }
  if (config.transport.kind === "broker") {
    if (!isAbsolute(config.transport.queuePath)) {
      throw new Error(
        "Loom retrieval requires an absolute broker `queuePath`.",
      );
    }
  } else if (config.transport.kind === "direct") {
    const { instanceDir, runId } = config.transport;
    if (
      !isAbsolute(instanceDir) || !runId || runId.trim() !== runId ||
      runId.length > 128 || hasControlCharacter(runId)
    ) {
      throw new Error(
        "Direct Loom retrieval requires an instance directory and run identity.",
      );
    }
  } else {
    throw new Error("Loom retrieval requires a supported transport.");
  }
};

/**
 * Reads an explicit operator-owned configuration file; absence grants
 * nothing.
 */
export const readLoomRetrievalConfig = async (
  path: string | undefined,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<HarnessLoomRetrievalConfig | undefined> => {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error("The Loom retrieval configuration path must be absolute.");
  }
  const value: unknown = JSON.parse(await readTextFile(path));
  if (
    !isRecord(value) || typeof value.cliPath !== "string" ||
    !isRecord(value.transport)
  ) {
    throw new Error(
      "Loom retrieval requires a host CLI and a transport configuration.",
    );
  }
  const config = value as unknown as HarnessLoomRetrievalConfig;
  validateLoomRetrievalConfig(config);
  return config;
};

/**
 * Reads the loom read-ceiling record at `path`. A record that is named and
 * cannot be read as one throws rather than reading as no ceiling: the record
 * is the only statement of the scope the broker holds the run to.
 */
export const readLoomReadCeilingRecord = async (
  path: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<LoomReadCeilingRecord> => {
  const value: unknown = JSON.parse(await readTextFile(path));
  if (!isRecord(value)) {
    throw new Error("The loom read-ceiling record is not a JSON object.");
  }
  const { loomReadCeiling, facets, facetSource } = value;
  if (!Array.isArray(loomReadCeiling) || loomReadCeiling.length === 0) {
    throw new Error(
      "The loom read-ceiling record carries no `loomReadCeiling` clause list.",
    );
  }
  if (!isFacetList(facets)) {
    throw new Error("The loom read-ceiling record names no facets.");
  }
  if (typeof facetSource !== "string" || facetSource.length === 0) {
    throw new Error("The loom read-ceiling record names no `facetSource`.");
  }
  return {
    loomReadCeiling: loomReadCeiling as CfcConfClause[],
    facets,
    facetSource,
  };
};

/** Helper for the argv builder, which reads a free-text value or throws. */
const textValue = (
  input: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined => {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new Error(`\`${key}\` is required.`);
    return undefined;
  }
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_VALUE_LENGTH || hasControlCharacter(value) ||
    value.startsWith("-")
  ) {
    throw new Error(
      `\`${key}\` must be a nonempty string that does not open with \`-\`.`,
    );
  }
  return value;
};

/** Helper for the argv builder, which reads a positive integer or throws. */
const countValue = (
  input: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`\`${key}\` must be a positive integer.`);
  }
  return value;
};

/** Helper for the argv builder, which reads one of a fixed set or throws. */
const choiceValue = <T extends string>(
  input: Record<string, unknown>,
  key: string,
  choices: readonly T[],
  required = false,
): T | undefined => {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new Error(`\`${key}\` is required.`);
    return undefined;
  }
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`\`${key}\` must be one of ${choices.join(", ")}.`);
  }
  return value as T;
};

/** Helper for the argv builder, which reads a boolean flag or throws. */
const flagValue = (input: Record<string, unknown>, key: string): boolean => {
  const value = input[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`\`${key}\` must be a boolean.`);
  }
  return value;
};

/** Helper for the argv builder, which refuses keys a command does not take. */
const admitKeys = (
  input: Record<string, unknown>,
  allowed: readonly string[],
): void => {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(`Unknown field \`${extra[0]}\`.`);
  }
};

/** Helper for the argv builder, which appends an option when it has a value. */
const option = (flag: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [flag, String(value)];

/**
 * Whether a `loom people` query is a lookup rather than one of the verbs
 * that positional also carries. A lookup names an identifier: an address,
 * a phone number, a typed `kind:value` reference, or a page path.
 */
const isPeopleLookup = (query: string): boolean =>
  query.includes("@") || query.includes(":") || query.includes("/") ||
  /^\+?\d[\d\s().-]{4,}$/.test(query);

/**
 * Builds the argv of one command from its typed input, or throws for an
 * input the command does not take. `--json` is always passed, and
 * `--concise` wherever `loom page` accepts it, since a full inspection
 * exceeds any bound a tool result can carry.
 */
export const loomRetrievalArgv = (
  command: LoomRetrievalCommand,
  input: unknown,
): string[] => {
  if (!isRecord(input)) {
    throw new Error("The command input must be an object.");
  }
  switch (command) {
    case "search": {
      admitKeys(input, [
        "query",
        "sources",
        "since",
        "until",
        "tz",
        "person",
        "limit",
        "rank",
      ]);
      const query = textValue(input, "query");
      const person = textValue(input, "person");
      if (query === undefined && person === undefined) {
        throw new Error("A search needs a `query` or a `person`.");
      }
      return [
        "search",
        ...(query === undefined ? [] : [query]),
        "--json",
        ...option("--sources", textValue(input, "sources")),
        ...option("--since", textValue(input, "since")),
        ...option("--until", textValue(input, "until")),
        ...option("--tz", textValue(input, "tz")),
        ...option("--person", person),
        ...option("--limit", countValue(input, "limit")),
        ...option("--rank", choiceValue(input, "rank", ["recency", "score"])),
      ];
    }
    case "page.discover":
      admitKeys(input, ["kind", "limit"]);
      return [
        "page",
        "discover",
        "--json",
        "--concise",
        ...option("--kind", textValue(input, "kind")),
        ...option("--limit", countValue(input, "limit")),
      ];
    case "page.inspect":
      admitKeys(input, ["target"]);
      return [
        "page",
        "inspect",
        textValue(input, "target", true) as string,
        "--json",
        "--concise",
      ];
    case "page.read":
      admitKeys(input, ["target"]);
      return [
        "page",
        "read",
        textValue(input, "target", true) as string,
        "--json",
      ];
    case "people": {
      admitKeys(input, ["query", "shape"]);
      const query = textValue(input, "query", true) as string;
      if (!isPeopleLookup(query)) {
        throw new Error(
          "`query` must name a person identifier: an email, phone, typed reference, or page path.",
        );
      }
      return [
        "people",
        query,
        "--json",
        ...option("--shape", choiceValue(input, "shape", ["summary", "card"])),
      ];
    }
    case "calendar.list": {
      admitKeys(input, ["from", "to", "all"]);
      const all = flagValue(input, "all");
      const bounds = (["from", "to"] as const).flatMap((key) => {
        const value = textValue(input, key);
        if (value === undefined) return [];
        if (!CALENDAR_DATE.test(value)) {
          throw new Error(`\`${key}\` must be a \`YYYY-MM-DD\` date.`);
        }
        return [`--${key}`, value];
      });
      if (all && bounds.length > 0) {
        throw new Error("`all` excludes `from` and `to`.");
      }
      return ["calendar", "list", "--json", ...(all ? ["--all"] : bounds)];
    }
    case "context": {
      admitKeys(input, ["read", "at", "since", "until"]);
      const read = choiceValue(input, "read", ["where", "activity"], true);
      const since = textValue(input, "since");
      const until = textValue(input, "until");
      if (read === "where" && (since !== undefined || until !== undefined)) {
        throw new Error("`since` and `until` apply to `activity` only.");
      }
      return [
        "context",
        read as string,
        "--json",
        ...option("--at", textValue(input, "at")),
        ...option("--since", since),
        ...option("--until", until),
      ];
    }
    case "profile":
      admitKeys(input, ["fresh"]);
      return [
        "profile",
        "--json",
        ...(flagValue(input, "fresh") ? ["--fresh"] : []),
      ];
  }
};

/** Exit codes that name a person-resolution outcome rather than a failure. */
const PERSON_EXIT_CODES: Record<number, LoomRetrievalErrorCode> = {
  1: "not_found",
  3: "contested",
};

/**
 * Executes one command through argv over a cleared environment and parses
 * its stdout as JSON. Host text — stderr, error strings — never reaches the
 * result: it may quote paths and identifiers of the host, and the typed code
 * is what a caller can act on.
 */
export const runLoomRetrievalCommand = async (
  config: HarnessLoomRetrievalConfig,
  command: LoomRetrievalCommand,
  input: unknown,
  runner: ProcessRunner,
): Promise<LoomRetrievalCommandOutput> => {
  validateLoomRetrievalConfig(config);
  let argv: string[];
  try {
    argv = loomRetrievalArgv(command, input);
  } catch (error) {
    return {
      status: "error",
      code: "invalid_input",
      message: (error as Error).message,
    };
  }
  const env = createClearedHostProcessEnv();
  if (config.transport.kind === "broker") {
    env.LOOM_PAGE_RPC_QUEUE = config.transport.queuePath;
    env.LOOM_SEARCH_BROKER_QUEUE = config.transport.queuePath;
  } else {
    env.LOOM_INSTANCE_DIR = config.transport.instanceDir;
    env.LOOM_DISPATCH_ID = config.transport.runId;
  }
  const failed = (message: string): LoomRetrievalCommandOutput => ({
    status: "error",
    code: "command_failed",
    message,
  });
  let response;
  try {
    response = await runner.run({
      command: config.cliPath,
      args: argv,
      env,
      clearEnv: true,
    });
  } catch {
    return failed("The host command could not be started.");
  }
  let payload: JSONValue;
  try {
    payload = JSON.parse(response.stdout);
  } catch {
    const personOutcome = (command === "people" ||
        (command === "search" && isRecord(input) && input.person !== undefined))
      ? PERSON_EXIT_CODES[response.exitCode]
      : undefined;
    if (personOutcome !== undefined) {
      return {
        status: "error",
        code: personOutcome,
        message: personOutcome === "not_found"
          ? "No live person holds that identifier."
          : "More than one live person holds that identifier; name one by `person:<id>`.",
      };
    }
    return failed("The host command did not return a JSON payload.");
  }
  if (isRecord(payload) && payload.ok === false) {
    return {
      status: "error",
      code: "host_refused",
      message: "The host refused the command.",
      ...(typeof payload.code === "string" ? { hostCode: payload.code } : {}),
    };
  }
  // `loom profile` exits 1 when a fallback tier supplied the profile, and
  // the payload says so in `hasProfile`; a nonzero exit without that word is
  // a failure whatever was printed, as it is for every other command.
  const profileFallback = command === "profile" && response.exitCode === 1 &&
    isRecord(payload) && payload.hasProfile === false;
  if (response.exitCode !== 0 && !profileFallback) {
    return failed("The host command did not succeed.");
  }
  if (
    command === "search" && isRecord(payload) &&
    Object.hasOwn(payload, "schemaVersion") &&
    payload.schemaVersion !== LOOM_SEARCH_SCHEMA_VERSION
  ) {
    return {
      status: "error",
      code: "schema_version_mismatch",
      message:
        `The search payload states a schemaVersion other than ${LOOM_SEARCH_SCHEMA_VERSION}.`,
    };
  }
  return { status: "ok", payload };
};
