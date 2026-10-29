import { parse as parseJsonc } from "@std/jsonc";

export const GITHUB_HOST_CONFIG_SCHEMA = "commonfabric.github-host.config.v1";
export const DEFAULT_GITHUB_COLLECTION_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_INTERVAL_MS = 2_147_483_647;

export interface GithubHostConfig {
  schema: typeof GITHUB_HOST_CONFIG_SCHEMA;
  account: string;
  collectionIntervalMs: number;
  graphqlEndpoint: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  return value as Record<string, unknown>;
}

/** Validate a decoded laptop GitHub host configuration. */
export function parseGithubHostConfig(value: unknown): GithubHostConfig {
  const config = record(value);
  for (const key of Object.keys(config)) {
    if (
      !["schema", "account", "collectionIntervalMs", "graphqlEndpoint"]
        .includes(
          key,
        )
    ) {
      throw new Error(`configuration has an unknown field: ${key}`);
    }
  }
  if (config.schema !== GITHUB_HOST_CONFIG_SCHEMA) {
    throw new Error(
      `configuration.schema must be "${GITHUB_HOST_CONFIG_SCHEMA}"`,
    );
  }
  if (typeof config.account !== "string" || !config.account.trim()) {
    throw new Error("configuration.account must be a non-empty string");
  }
  if (/\r|\n/.test(config.account)) {
    throw new Error("configuration.account must not contain line breaks");
  }
  const collectionIntervalMs = config.collectionIntervalMs ??
    DEFAULT_GITHUB_COLLECTION_INTERVAL_MS;
  if (
    !Number.isSafeInteger(collectionIntervalMs) ||
    Number(collectionIntervalMs) < 0 ||
    Number(collectionIntervalMs) > MAX_INTERVAL_MS
  ) {
    throw new Error(
      `configuration.collectionIntervalMs must be an integer from 0 through ${MAX_INTERVAL_MS}`,
    );
  }
  const graphqlEndpoint = config.graphqlEndpoint ??
    "https://api.github.com/graphql";
  if (typeof graphqlEndpoint !== "string") {
    throw new Error("configuration.graphqlEndpoint must be a URL");
  }
  if (/\r|\n/.test(graphqlEndpoint)) {
    throw new Error(
      "configuration.graphqlEndpoint must not contain line breaks",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(graphqlEndpoint);
  } catch (error) {
    throw new Error("configuration.graphqlEndpoint must be a URL", {
      cause: error,
    });
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("configuration.graphqlEndpoint must use HTTPS");
  }
  return {
    schema: GITHUB_HOST_CONFIG_SCHEMA,
    account: config.account.trim(),
    collectionIntervalMs: Number(collectionIntervalMs),
    graphqlEndpoint: endpoint.href,
  };
}

/** Load and validate a JSONC laptop GitHub host configuration. */
export async function loadGithubHostConfig(
  path: string,
): Promise<GithubHostConfig> {
  let contents: string;
  try {
    contents = await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(`could not read configuration file ${path}`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = parseJsonc(contents);
  } catch (error) {
    throw new Error(`configuration file is not valid JSONC: ${path}`, {
      cause: error,
    });
  }
  return parseGithubHostConfig(value);
}
