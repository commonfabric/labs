/**
 * What a new console session would run under, as the server discloses it.
 *
 * A session's own policy reaches a client through `/api/status`, which can
 * only describe sessions that exist. An unattended client deciding whether
 * this console is the one it was told to measure has to decide that before it
 * starts a session, and the two questions want the same fields.
 *
 * The seeded system prompt crosses as a digest and never as text. A prompt is
 * the operator's, it can hold anything, and a client checking that this
 * console runs *the* prompt needs to compare rather than to read.
 */

import { encodeHex } from "@std/encoding/hex";

import { sha256 } from "@commonfabric/content-hash";

import type { HarnessChatPolicy } from "../src/contracts/interactive-chat.ts";

/** What the server was configured with, for {@link consolePolicyReport}. */
export interface ConsolePolicyInput {
  policy: HarnessChatPolicy;
  fabricSpace: string;
  artifactRoot: string;

  /** The seeded system prompt, when the server was started with one. */
  systemPrompt?: string;

  /** The durable session store, absent when sessions are held in memory. */
  sessionDbPath?: string;
}

/**
 * The effective session policy, as `GET /api/policy` returns it.
 *
 * Every optional part of the configuration is reported as `null` rather than
 * left out, so a client reading a field can tell a server that has none from
 * one whose answer predates the field.
 */
export interface ConsolePolicyReport {
  /** The seeded system prompt's SHA-256, or `null` for a server with none. */
  systemPromptSha256: string | null;

  /**
   * The tools a new session's policy asks for. The prompt loop withholds one
   * again when its backing is absent, so this is what the console asks for
   * rather than what a turn ends up holding.
   */
  allowedToolIds: readonly string[];

  allowedSubagentProfiles: readonly string[];
  fabricSpace: string;
  artifactRoot: string;

  /** The durable session store, or `null` when sessions are held in memory. */
  sessionDbPath: string | null;
}

/** `text`'s SHA-256, hex encoded. */
const sha256Hex = (text: string): string =>
  encodeHex(sha256(new TextEncoder().encode(text)));

/** What a new session would run under, holding no prompt text. */
export const consolePolicyReport = (
  input: ConsolePolicyInput,
): ConsolePolicyReport => ({
  systemPromptSha256: input.systemPrompt === undefined
    ? null
    : sha256Hex(input.systemPrompt),
  allowedToolIds: [...input.policy.allowedToolIds],
  allowedSubagentProfiles: [...input.policy.allowedSubagentProfiles],
  fabricSpace: input.fabricSpace,
  artifactRoot: input.artifactRoot,
  sessionDbPath: input.sessionDbPath ?? null,
});
