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

/**
 * Python's whitespace, as Loom's `str.isspace`, `str.strip` and `re` `\\s`
 * read it: U+0009..U+000D, U+001C..U+001F, U+0020, U+0085, U+00A0, U+1680,
 * U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. JavaScript's `\\s`
 * differs (it lacks U+001C..U+001F and U+0085, and adds U+FEFF), so the set
 * is spelled out here.
 */
const PYTHON_SPACE_CLASS =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_SPACE = new RegExp(`[${PYTHON_SPACE_CLASS}]`);
const PYTHON_SPACE_ENDS = new RegExp(
  `^[${PYTHON_SPACE_CLASS}]+|[${PYTHON_SPACE_CLASS}]+$`,
  "g",
);

/**
 * A character a client opening a url as given cannot be shown faithfully:
 * Python whitespace, any C0 or C1 control, and the Unicode line and
 * paragraph separators (Loom's `_URL_UNSAFE`).
 */
const URL_UNSAFE = new RegExp(
  `[${PYTHON_SPACE_CLASS}\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]`,
);

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

/** One DNS label as Loom holds it: letters, digits, inner hyphens, 1..63. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether the dot-separated `labels` are an IPv4 address as `ipaddress`
 * reads one: four decimal octets 0..255, none with a leading zero.
 */
const isIpv4 = (labels: readonly string[]): boolean =>
  labels.length === 4 &&
  labels.every((octet) =>
    /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255
  );

/** Whether `text` is an IPv6 address literal (no zone), as `ipaddress` reads. */
const isIpv6 = (text: string): boolean => {
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = (half: string): string[] => half === "" ? [] : half.split(":");
  const parts = halves.map(groups);
  const last = parts[parts.length - 1];
  let slots = 0;
  // A trailing dotted IPv4 quad stands for two groups.
  const tail = last[last.length - 1];
  if (tail !== undefined && tail.includes(".")) {
    const quad = tail.split(".");
    if (
      quad.length !== 4 ||
      !quad.every((n) => /^(0|[1-9][0-9]{0,2})$/.test(n) && Number(n) < 256)
    ) return false;
    last.pop();
    slots = 2;
  }
  const all = parts.flat();
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  slots += all.length;
  return halves.length === 2 ? slots < 8 : slots === 8;
};

/**
 * Whether the authority of an http(s) address is one Loom's final validator
 * accepts (loom#6768 fdf37da4), read from the string as given rather than
 * from URL parsing, which lowercases and punycodes the host. Userinfo is
 * stripped as Python's `urlsplit(...).hostname` does (everything up to the
 * last `@`); the port, if any, is 1..65535; no `%` appears anywhere; a
 * bracketed host must be an IPv6 literal, any other every dot-separated
 * label of letters, digits and inner hyphens, with no empty label.
 */
const authorityIsWellFormed = (value: string): boolean => {
  const authority = /^https?:\/\/([^/?#]*)/.exec(value)?.[1];
  if (authority === undefined || authority.includes("%")) return false;
  // `urlsplit` raises on a bracket with no partner anywhere in the netloc.
  if (authority.includes("[") !== authority.includes("]")) return false;
  const hostinfo = authority.slice(authority.lastIndexOf("@") + 1);
  let host: string;
  let port: string;
  // Brackets are read on the host, after the userinfo, as Loom reads them.
  if (hostinfo.includes("[") || hostinfo.includes("]")) {
    const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(hostinfo);
    if (bracketed === null) return false;
    host = bracketed[1];
    port = bracketed[2] ?? "";
    if (!isIpv6(host)) return false;
  } else {
    const colon = hostinfo.indexOf(":");
    host = colon < 0 ? hostinfo : hostinfo.slice(0, colon);
    port = colon < 0 ? "" : hostinfo.slice(colon + 1);
    const labels = host.split(".");
    if (!labels.every((label) => HOST_LABEL.test(label))) return false;
    // A host ending in an all-digit label must be an IPv4 address, as
    // Loom's `ipaddress.IPv4Address` reads one (four octets, no leading zero).
    if (/^[0-9]+$/.test(labels[labels.length - 1]) && !isIpv4(labels)) {
      return false;
    }
  }
  if (port === "") return true;
  return /^[0-9]+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
};

/**
 * An http or https address as Loom's final validator reads it, or undefined.
 * Whitespace, controls and separators (`URL_UNSAFE`) are refused on the
 * string as given (URL parsing would encode them),
 * and the scheme is matched case-sensitively as Loom's `re.match` does.
 */
const readHttpUrl = (value: string): string | undefined =>
  !URL_UNSAFE.test(value) && authorityIsWellFormed(value) ? value : undefined;

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
          line.replace(PYTHON_SPACE_ENDS, "").length > 1 &&
          !PYTHON_SPACE.test(line[1]) &&
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
