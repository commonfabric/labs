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
 * Longest web address an action may carry. The Weaver refuses longer ones,
 * so the harness reads actions with the same limit and a session is told at
 * the call rather than waiting on a request no client will show.
 */
export const HARNESS_CLIENT_URL_MAX_LENGTH = 2048;

/**
 * A client command: one line starting with "/". Any line break, Unicode's
 * included (CR, LF, U+0085, U+2028, U+2029), would let one action carry
 * several commands, and the client shows an action as one line for the person
 * to approve, so none is allowed.
 */
export const HARNESS_CLIENT_COMMAND_LINE_PATTERN =
  /^\/[^\r\n\u0085\u2028\u2029]*$/;

/**
 * Any line break, Unicode's included. A URL parser silently drops a raw
 * newline, so a url is checked as given, not as parsed.
 */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

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
          url.length <= HARNESS_CLIENT_URL_MAX_LENGTH &&
          !LINE_BREAK.test(url) && readHttpUrl(url) !== undefined
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

/** How the person's client settled one requested action. */
export type HarnessClientActionOutcomeKind = "done" | "declined" | "failed";

/** The outcomes a client may report, for readers of untrusted input. */
export const HARNESS_CLIENT_ACTION_OUTCOMES:
  readonly HarnessClientActionOutcomeKind[] = ["done", "declined", "failed"];

/** Longest receipt or failure text a settlement may carry. */
export const HARNESS_CLIENT_ACTION_RESULT_MAX_LENGTH = 500;

/**
 * How long a call waits with nobody settling any of its actions before the
 * rest fail as `timeout`. Every settlement restarts the clock.
 */
export const HARNESS_CLIENT_ACTION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** One action's settlement, as the model reads it. */
export interface HarnessClientActionOutcome {
  action: HarnessClientAction;
  outcome: HarnessClientActionOutcomeKind;
  result?: string;
}

/**
 * The host's door for asking the person's client to act mid-turn. It emits
 * one request per action in order, resolves when every one is settled, and
 * settles any still open as declined "canceled" when `signal` aborts.
 * Outcomes come back in input order. Only a host that opted in supplies one.
 */
export type HarnessClientActionRequester = (
  actions: readonly HarnessClientAction[],
  signal?: AbortSignal,
) => Promise<HarnessClientActionOutcome[]>;

/** Whether a value is an outcome a client may report. */
export const isHarnessClientActionOutcomeKind = (
  value: unknown,
): value is HarnessClientActionOutcomeKind =>
  typeof value === "string" &&
  (HARNESS_CLIENT_ACTION_OUTCOMES as readonly string[]).includes(value);
