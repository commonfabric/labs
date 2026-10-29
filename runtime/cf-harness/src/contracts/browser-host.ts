/**
 * The protocol between the harness and a browser host: the trusted component
 * that owns a web engine, executes the `browser` tool's operations in a
 * session it holds, and shows that session to the owner. The Weaver is the
 * host this protocol is written for; the harness side reaches it through
 * whatever channel the dispatcher opened, so nothing here names a transport.
 *
 * A session is the host's, bound to one turn, and never named in an
 * operation: the host executes every operation in the one session the
 * channel is attached to. An operation names no jar, no endpoint, and no
 * grant.
 *
 * Whatever initiates it — an operation, a page, a redirect — the host loads
 * nothing from, and sends no request to, this device, its local network, or
 * an address written as an IP literal. Before it takes a screenshot, it paints
 * over every field a value was entered into.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** Where the page model places an operation's target: a ref from a snapshot. */
export type BrowserHostRef = string;

/** A direction `scroll` moves the page, or the scrollable element at a ref. */
export const BROWSER_HOST_SCROLL_DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
] as const;

/** One of {@link BROWSER_HOST_SCROLL_DIRECTIONS}. */
export type BrowserHostScrollDirection =
  typeof BROWSER_HOST_SCROLL_DIRECTIONS[number];

/** A load state `wait` can wait for. */
export const BROWSER_HOST_LOAD_STATES = [
  "domcontentloaded",
  "load",
  "networkidle",
] as const;

/** One of {@link BROWSER_HOST_LOAD_STATES}. */
export type BrowserHostLoadState = typeof BROWSER_HOST_LOAD_STATES[number];

/**
 * A value a handle resolved to, which no model that saw it chose for the
 * page: a string a browser child returned, which the agent passes on by its
 * handle. `description` says where it came from. The host enters it and keeps
 * it out of every later observation of the page.
 */
export interface BrowserHostHandleValue {
  kind: "handle-value";
  text: string;
  description: string;
}

/**
 * A value an operation enters into a page: `text` the agent composed, which
 * the host enters as given, or a handle's value.
 *
 * Nothing here asks the owner whether a value may go to a page: a question at
 * every step teaches a person to agree without reading.
 */
export type BrowserHostValue =
  | { kind: "text"; text: string }
  | BrowserHostHandleValue;

/**
 * The keys `press` may name: keys that move, submit, or dismiss, none of
 * which puts a character into the page.
 */
export const BROWSER_HOST_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

/** One of {@link BROWSER_HOST_KEYS}. */
export type BrowserHostKey = typeof BROWSER_HOST_KEYS[number];

/**
 * Why an agent hands the page to the owner. The host shows the owner fixed
 * words for the reason beside the page's committed origin, never words an
 * agent wrote, so a hand-off cannot speak in the host's voice.
 *
 * - `sign-in`: the page wants the owner signed in.
 * - `one-time-code`: the page wants a code sent to the owner.
 * - `challenge`: the page wants a person to prove they are one.
 * - `choice`: the next step is the owner's to choose.
 */
export const BROWSER_HOST_HANDOFF_REASONS = [
  "sign-in",
  "one-time-code",
  "challenge",
  "choice",
] as const;

/** One of {@link BROWSER_HOST_HANDOFF_REASONS}. */
export type BrowserHostHandoffReason =
  typeof BROWSER_HOST_HANDOFF_REASONS[number];

/** One operation the host executes in the session. */
export type BrowserHostOperation =
  | {
    action: "open";

    /**
     * The address, as the agent wrote it, or as a handle resolved it. A
     * document opened from a handle's value is reported by its origin alone,
     * in the page of every result, while the session stays on it.
     */
    url: string | BrowserHostHandleValue;
  }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | {
    action: "scroll";
    direction: BrowserHostScrollDirection;
    ref?: BrowserHostRef;
  }
  | { action: "snapshot"; interactive: boolean }
  | { action: "get"; kind: "title" | "url" }
  | { action: "get"; kind: "text"; target: string }
  | { action: "console" }
  | { action: "errors" }
  | { action: "screenshot" }
  | { action: "wait"; ref: BrowserHostRef }
  | { action: "wait"; loadState: BrowserHostLoadState }
  | { action: "wait"; urlPattern: string }
  | { action: "click"; ref: BrowserHostRef }
  | { action: "click"; x: number; y: number }
  | { action: "check"; ref: BrowserHostRef }
  | { action: "press"; key: BrowserHostKey }
  | {
    action: "fill" | "type" | "select";
    ref: BrowserHostRef;
    value: BrowserHostValue;
  }
  | { action: "handoff"; reason: BrowserHostHandoffReason };

/** The page a result was observed on, as the host committed it. */
export interface BrowserHostPage {
  /**
   * The URL the engine committed for the main frame, or its origin alone for
   * a document opened from a handle's value, which no observation carries.
   */
  url: string;

  /** The document's title, as the page wrote it. */
  title: string;
}

/**
 * The ways a host declines or fails an operation. Each is a fixed word, so a
 * refusal carries no page-authored text in its code.
 *
 * - `stale-ref`: the ref names an element of a document the page has since
 *   replaced; take a new snapshot.
 * - `owner-only-field`: the target is a password or one-time-code field, or a
 *   challenge; only the owner may enter a value there, through a hand-off.
 * - `session-ended`: the session is gone — the owner closed it, or the host
 *   detached.
 * - `invalid`: the operation does not describe anything the host can do.
 * - `failed`: the operation was attempted and did not complete.
 */
export const BROWSER_HOST_REFUSALS = [
  "stale-ref",
  "owner-only-field",
  "session-ended",
  "invalid",
  "failed",
] as const;

/** One of {@link BROWSER_HOST_REFUSALS}. */
export type BrowserHostRefusal = typeof BROWSER_HOST_REFUSALS[number];

/** What a host returns for one operation. */
export type BrowserHostResult =
  | {
    status: "ok";
    page: BrowserHostPage;

    /** The operation's observation as text, when it has one. */
    text?: string;

    /** A screenshot's pixels. */
    image?: { mediaType: "image/png"; base64: string };

    /** How the owner ended a hand-off. */
    handoff?: "done" | "declined";
  }
  | {
    status: BrowserHostRefusal;
    message: string;
    page?: BrowserHostPage;
  };

/**
 * The harness side of an attached host: what the `browser` tool calls when a
 * run has one. `perform` settles when the host answers or `signal` aborts,
 * and never on a clock of its own, since an operation that needs the owner
 * waits for the owner.
 *
 * An implementation is where a host's answer enters the harness: it resolves
 * only with a {@link BrowserHostResult}, having checked whatever crossed its
 * channel with {@link isBrowserHostResult}, so a caller reads the result as
 * its type says.
 */
export interface HarnessBrowserHost {
  /** Executes `operation` in the host's session for this run. */
  perform(
    operation: BrowserHostOperation,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult>;
}

/**
 * Whether `value` is a result a host could have sent: a known status with the
 * fields that status carries. A host is trusted to execute operations, not to
 * be free of bugs, so what crosses the channel is checked before the harness
 * reads it.
 */
export const isBrowserHostResult = (
  value: unknown,
): value is BrowserHostResult => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const page = value.page;
  const pageValid = page === undefined ||
    (isObjectNotArray(page) && typeof page.url === "string" &&
      typeof page.title === "string");
  if (!pageValid) {
    return false;
  }
  if (value.status === "ok") {
    const image = value.image;
    return page !== undefined &&
      (value.text === undefined || typeof value.text === "string") &&
      (value.handoff === undefined || value.handoff === "done" ||
        value.handoff === "declined") &&
      (image === undefined ||
        (isObjectNotArray(image) && image.mediaType === "image/png" &&
          typeof image.base64 === "string"));
  }
  return typeof value.status === "string" && REFUSALS.has(value.status) &&
    typeof value.message === "string";
};

const REFUSALS: ReadonlySet<string> = new Set(BROWSER_HOST_REFUSALS);
