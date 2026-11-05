import type {
  AgentSourceConfig,
  CodexAppServerTransport,
  DriverKind,
} from "@commonfabric/agents-connector/types";
import { normalizeSourceId } from "@commonfabric/agents-connector";
import { parse as parseJsonc } from "@std/jsonc";
import { isAbsolute } from "@std/path";
import { isDID } from "@commonfabric/identity";

export const AGENTS_HOST_CONFIG_SCHEMA = "commonfabric.agents-host.config";
export const DEFAULT_COLLECTION_INTERVAL_MS = 15 * 60 * 1_000;
export const MAX_COLLECTION_INTERVAL_MS = 2_147_483_647;

/** A deployed piece the host accepts commands from through its own queue. */
export interface CommandProducerConfig {
  /** Stable, lowercase identity; it names the producer's queue. */
  id: string;
  /** The piece's ID in the destination space. */
  piece: string;
}

export interface AgentsHostConfig {
  schema: typeof AGENTS_HOST_CONFIG_SCHEMA;
  ownerDid: string;
  collectionIntervalMs: number;
  checkoutRoots?: string[];
  sources: AgentSourceConfig[];
  commandProducers?: CommandProducerConfig[];
}

const COMMAND_PRODUCER_FIELDS = new Set(["id", "piece"]);

const SOURCE_FIELDS = new Set([
  "id",
  "driver",
  "enabled",
  "command",
  "configDir",
  "codexBin",
  "codexHome",
  "codexTransport",
  "codexSocket",
  "cwd",
  "env",
  "allowDangerFullAccess",
]);

const DRIVERS = new Set<DriverKind>([
  "claude-agent-sdk",
  "codex-app-server",
  "acp",
]);

const CODEX_TRANSPORTS = new Set<CodexAppServerTransport>([
  "stdio",
  "managed",
  "proxy",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!(key in source)) return undefined;
  return nonEmptyString(source[key], `${label}.${key}`);
}

function parseCommand(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.command must be a non-empty string array`);
  }
  return value.map((item, index) =>
    nonEmptyString(item, `${label}.command[${index}]`)
  );
}

function parseEnvironment(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, `${label}.env`);
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.env.${key} must be a string`);
    }
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function parseSource(value: unknown, index: number): AgentSourceConfig {
  const label = `sources[${index}]`;
  const source = record(value, label);
  for (const key of Object.keys(source)) {
    if (!SOURCE_FIELDS.has(key)) {
      throw new Error(`${label} has an unknown field: ${key}`);
    }
  }

  const rawId = nonEmptyString(source.id, `${label}.id`).trim();
  const id = normalizeSourceId(rawId);
  if (rawId !== id) {
    throw new Error(`${label}.id must already be normalized as "${id}"`);
  }

  if (
    typeof source.driver !== "string" ||
    !DRIVERS.has(source.driver as DriverKind)
  ) {
    throw new Error(`${label}.driver is not supported`);
  }
  const driver = source.driver as DriverKind;

  if (typeof source.enabled !== "boolean") {
    throw new Error(`${label}.enabled must be a boolean`);
  }

  const command = parseCommand(source.command, label);
  if (driver === "acp" && source.enabled && command === undefined) {
    throw new Error(`${label}.command is required for an enabled ACP source`);
  }

  let codexTransport: CodexAppServerTransport | undefined;
  if (source.codexTransport !== undefined) {
    if (
      typeof source.codexTransport !== "string" ||
      !CODEX_TRANSPORTS.has(
        source.codexTransport as CodexAppServerTransport,
      )
    ) {
      throw new Error(`${label}.codexTransport is not supported`);
    }
    codexTransport = source.codexTransport as CodexAppServerTransport;
  }

  if (
    source.allowDangerFullAccess !== undefined &&
    typeof source.allowDangerFullAccess !== "boolean"
  ) {
    throw new Error(`${label}.allowDangerFullAccess must be a boolean`);
  }

  const configDir = optionalString(source, "configDir", label);
  const codexBin = optionalString(source, "codexBin", label);
  const codexHome = optionalString(source, "codexHome", label);
  const codexSocket = optionalString(source, "codexSocket", label);
  const cwd = optionalString(source, "cwd", label);
  const env = parseEnvironment(source.env, label);

  return {
    id,
    driver,
    enabled: source.enabled,
    ...(command ? { command } : {}),
    ...(configDir ? { configDir } : {}),
    ...(codexBin ? { codexBin } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(codexTransport ? { codexTransport } : {}),
    ...(codexSocket ? { codexSocket } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(source.allowDangerFullAccess !== undefined
      ? { allowDangerFullAccess: source.allowDangerFullAccess }
      : {}),
  };
}

function parseCommandProducer(
  value: unknown,
  index: number,
): CommandProducerConfig {
  const label = `commandProducers[${index}]`;
  const producer = record(value, label);
  for (const key of Object.keys(producer)) {
    if (!COMMAND_PRODUCER_FIELDS.has(key)) {
      throw new Error(`${label} has an unknown field: ${key}`);
    }
  }
  const rawId = nonEmptyString(producer.id, `${label}.id`).trim();
  const id = normalizeSourceId(rawId);
  if (rawId !== id) {
    throw new Error(`${label}.id must already be normalized as "${id}"`);
  }
  return { id, piece: nonEmptyString(producer.piece, `${label}.piece`).trim() };
}

export function parseAgentsHostConfig(value: unknown): AgentsHostConfig {
  const config = record(value, "configuration");
  for (const key of Object.keys(config)) {
    if (
      key !== "schema" && key !== "ownerDid" &&
      key !== "collectionIntervalMs" && key !== "sources" &&
      key !== "checkoutRoots" && key !== "commandProducers"
    ) {
      throw new Error(`configuration has an unknown field: ${key}`);
    }
  }
  if (config.schema !== AGENTS_HOST_CONFIG_SCHEMA) {
    throw new Error(
      `configuration.schema must be "${AGENTS_HOST_CONFIG_SCHEMA}"`,
    );
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error("configuration.sources must be a non-empty array");
  }
  const ownerDid = nonEmptyString(config.ownerDid, "configuration.ownerDid")
    .trim();
  if (!isDID(ownerDid)) {
    throw new Error("configuration.ownerDid must be a DID");
  }
  const collectionIntervalMs = "collectionIntervalMs" in config
    ? config.collectionIntervalMs
    : DEFAULT_COLLECTION_INTERVAL_MS;
  if (
    typeof collectionIntervalMs !== "number" ||
    !Number.isSafeInteger(collectionIntervalMs) ||
    collectionIntervalMs < 0 ||
    collectionIntervalMs > MAX_COLLECTION_INTERVAL_MS
  ) {
    throw new Error(
      `configuration.collectionIntervalMs must be an integer from 0 through ${MAX_COLLECTION_INTERVAL_MS}`,
    );
  }

  const sources = config.sources.map(parseSource);
  let checkoutRoots: string[] = [];
  if (config.checkoutRoots !== undefined) {
    if (!Array.isArray(config.checkoutRoots)) {
      throw new Error("configuration.checkoutRoots must be a string array");
    }
    checkoutRoots = config.checkoutRoots.map((root, index) => {
      const path = nonEmptyString(
        root,
        `configuration.checkoutRoots[${index}]`,
      );
      if (!isAbsolute(path)) {
        throw new Error(
          `configuration.checkoutRoots[${index}] must be an absolute path`,
        );
      }
      return path;
    });
    if (new Set(checkoutRoots).size !== checkoutRoots.length) {
      throw new Error("configuration.checkoutRoots contains a duplicate path");
    }
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`configuration has duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }
  if (!sources.some((source) => source.enabled)) {
    throw new Error("configuration must enable at least one source");
  }
  let commandProducers: CommandProducerConfig[] = [];
  if (config.commandProducers !== undefined) {
    if (!Array.isArray(config.commandProducers)) {
      throw new Error("configuration.commandProducers must be an array");
    }
    commandProducers = config.commandProducers.map(parseCommandProducer);
    const producerIds = new Set<string>();
    const producerPieces = new Set<string>();
    for (const producer of commandProducers) {
      if (producerIds.has(producer.id)) {
        throw new Error(
          `configuration has duplicate command producer id: ${producer.id}`,
        );
      }
      producerIds.add(producer.id);
      // Two producers naming one piece would each link a queue into the same
      // `commands` input, and the later link would replace the earlier.
      if (producerPieces.has(producer.piece)) {
        throw new Error(
          `configuration has duplicate command producer piece: ${producer.piece}`,
        );
      }
      producerPieces.add(producer.piece);
    }
  }
  return {
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    ownerDid,
    collectionIntervalMs,
    ...(checkoutRoots.length > 0 ? { checkoutRoots } : {}),
    sources,
    ...(commandProducers.length > 0 ? { commandProducers } : {}),
  };
}

export async function loadAgentsHostConfig(
  path: string,
): Promise<AgentsHostConfig> {
  let contents: string;
  try {
    contents = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`configuration file does not exist: ${path}`, {
        cause: error,
      });
    }
    throw new Error(`could not read configuration file ${path}: ${error}`, {
      cause: error,
    });
  }
  let decoded: unknown;
  try {
    decoded = parseJsonc(contents);
  } catch (error) {
    throw new Error(`configuration file is not valid JSONC: ${path}`, {
      cause: error,
    });
  }
  return parseAgentsHostConfig(decoded);
}
