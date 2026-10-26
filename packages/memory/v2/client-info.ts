/**
 * Bounded, self-reported runtime identity for session attribution.
 * Authentication identifies the reporting principal; it does not attest the
 * running code or the physical device.
 */

import { isPlainObject } from "@commonfabric/utils/types";

/**
 * Reserved report field emitted for readers that require it. Attribution does
 * not use this value to decide whether a client may open a session.
 */
export const MEMORY_CLIENT_GENERATION = 1;

/** Build provenance supplied by the application hosting a runtime. */
export type ClientBuild = {
  /** Application name, such as `shell`, `cf`, or `weaver`. */
  application: string;

  /** Commit of the loaded labs code, or `null` when unavailable. */
  gitSha: string | null;
};

/** Immutable report made by one runtime across its session opens. */
export type ClientInfo = ClientBuild & {
  /** Runtime instance identifier shared by its remote space connections. */
  instanceId: string;

  /** Reserved diagnostic field; emitted as `1`, with no admission meaning. */
  generation: number;

  /** Client-reported instance creation time, in Unix milliseconds. */
  startedAt: number;
};

/** Parses known report fields, returning `null` for an invalid report. */
export function parseClientInfo(value: unknown): ClientInfo | null {
  if (
    !isPlainObject(value) ||
    typeof value.application !== "string" ||
    !/^[\x20-\x7e]{1,64}$/.test(value.application) ||
    (value.gitSha !== null &&
      (typeof value.gitSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(value.gitSha))) ||
    typeof value.instanceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.instanceId) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
  ) return null;
  return {
    application: value.application,
    gitSha: value.gitSha,
    instanceId: value.instanceId,
    generation: value.generation,
    startedAt: value.startedAt,
  };
}

/**
 * Creates a frozen report. Unavailable or abbreviated build hashes report
 * unknown; malformed application names throw before opening a connection.
 */
export function createClientInfo(
  build: ClientBuild = { application: "runner", gitSha: null },
): Readonly<ClientInfo> {
  if (
    typeof build.application !== "string" ||
    !/^[\x20-\x7e]{1,64}$/.test(build.application)
  ) {
    throw new TypeError("Invalid memory client build metadata");
  }
  return Object.freeze({
    application: build.application,
    gitSha: build.gitSha !== null && /^[a-fA-F0-9]{40}$/.test(build.gitSha)
      ? build.gitSha.toLowerCase()
      : null,
    instanceId: crypto.randomUUID(),
    generation: MEMORY_CLIENT_GENERATION,
    startedAt: Math.floor(Date.now()),
  });
}
