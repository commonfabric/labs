/**
 * Actions a completed task asks the person's client to perform: open a loom
 * the run composed, run a client slash command, or open a web address. The
 * harness validates their shape and carries them; the client decides whether
 * and how each one runs.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** One action the client performs after a completed task. */
export type HarnessClientAction =
  | { kind: "open_loom"; loomId: string }
  | { kind: "command"; line: string }
  | { kind: "open_url"; url: string };

/** Most actions one completed task may carry. */
export const HARNESS_CLIENT_ACTION_LIMIT = 8;

/** Longest client command line an action may carry. */
export const HARNESS_CLIENT_COMMAND_MAX_LENGTH = 500;

/**
 * A client command: one line starting with "/". A carriage return or line
 * feed would let one action carry several commands, so neither is allowed.
 */
export const HARNESS_CLIENT_COMMAND_LINE_PATTERN = /^\/[^\r\n]*$/;

/** A loom identifier as the service mints it. */
const LOOM_ID = /^loom-[a-f0-9]{16}$/;

/** Own string field of a record, ignoring anything inherited. */
const ownString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined =>
  Object.hasOwn(record, key) && typeof record[key] === "string"
    ? record[key] as string
    : undefined;

/** Whether a record holds exactly the named own keys. */
const hasExactlyKeys = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const own = Object.keys(record);
  return own.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
};

/** An http or https address, or undefined for anything else. */
const readHttpUrl = (value: string): string | undefined => {
  if (!URL.canParse(value)) return undefined;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:" ? value : undefined;
};

/**
 * Reads one client action, or undefined when its kind is unknown or any
 * field is missing, extra, or malformed.
 */
export const readHarnessClientAction = (
  value: unknown,
): HarnessClientAction | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (ownString(record, "kind")) {
    case "open_loom": {
      const loomId = ownString(record, "loomId");
      return hasExactlyKeys(record, ["kind", "loomId"]) &&
          loomId !== undefined && LOOM_ID.test(loomId)
        ? { kind: "open_loom", loomId }
        : undefined;
    }
    case "command": {
      const line = ownString(record, "line");
      return hasExactlyKeys(record, ["kind", "line"]) &&
          line !== undefined &&
          HARNESS_CLIENT_COMMAND_LINE_PATTERN.test(line) &&
          line.trim().length > 1 &&
          line.length <= HARNESS_CLIENT_COMMAND_MAX_LENGTH
        ? { kind: "command", line }
        : undefined;
    }
    case "open_url": {
      const url = ownString(record, "url");
      return hasExactlyKeys(record, ["kind", "url"]) && url !== undefined &&
          readHttpUrl(url) !== undefined
        ? { kind: "open_url", url }
        : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Reads a list of client actions, or undefined when it is not an array, holds
 * more than the limit, or any entry is malformed. One bad entry refuses the
 * whole list rather than carrying the rest.
 */
export const readHarnessClientActions = (
  value: unknown,
): HarnessClientAction[] | undefined => {
  if (!Array.isArray(value) || value.length > HARNESS_CLIENT_ACTION_LIMIT) {
    return undefined;
  }
  const actions: HarnessClientAction[] = [];
  for (const entry of value) {
    const action = readHarnessClientAction(entry);
    if (action === undefined) return undefined;
    actions.push(action);
  }
  return actions;
};
