/**
 * The protocol between the harness and a browser host: the trusted component
 * that owns a web engine, executes the `browser` tool's operations in the
 * sessions it holds, and shows those sessions to the owner. The Weaver is the
 * host this protocol is written for; the harness side reaches it through
 * whatever channel the dispatcher opened, so nothing here names a transport.
 *
 * A session is one web view with storage of its own, shared with no other
 * session and not with the owner's own browser profile. A run has one unnamed
 * session, which a request that names no session addresses, and any number of
 * named sessions, which the harness opens with `session-open` under names it
 * chooses. A named session is of one of two kinds:
 *
 * - `read-only`: it keeps no state. No cookie is stored or sent, and no page
 *   can read what an earlier page wrote to local storage, session storage,
 *   IndexedDB, the Cache API, or a service worker. It may visit any site.
 * - `locked-down`: it is bound to one site when it opens, and may hold the
 *   owner's sign-in there. The host refuses, with `off-site` and before
 *   anything loads, an `open` of an address on another site. When the page
 *   itself commits a document on another site, the session is away until its
 *   main frame commits a document on the bound site again; while away, it
 *   performs only `get url`, `wait` for a load state, `open` of an address on
 *   the bound site, and `session-close`, and its results carry no address, no
 *   title, and no text.
 *
 * A site is a scheme and a registrable domain (the domain one level below a
 * public suffix, by the Public Suffix List), written in lowercase ASCII, as in
 * `"https://example.co.uk"`. The host computes every site; the harness only
 * compares the strings the host reported.
 *
 * Operations on different sessions run concurrently. Operations on one session
 * run one at a time, in the order the harness sent them. An operation names no
 * jar, no endpoint, and no grant.
 *
 * Whatever initiates it — an operation, a page, a redirect — the host loads
 * nothing from, and sends no request to, this device, its local network, or
 * an address written as an IP literal. Before it takes a screenshot, it paints
 * over every field a value was entered into.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import { utf8Compare } from "@commonfabric/text/utf8";

/** Where the page model places an operation's target: a ref from a snapshot. */
export type BrowserHostRef = string;

/**
 * The name the harness gives a session it opens, which is unique among the
 * open sessions of its browsing scope: one to 64 ASCII letters, digits,
 * hyphens, and underscores.
 */
export type BrowserHostSessionName = string;

/** The kinds of named session, as the file header describes them. */
export const BROWSER_HOST_SESSION_KINDS = ["read-only", "locked-down"] as const;

/** One of {@link BROWSER_HOST_SESSION_KINDS}. */
export type BrowserHostSessionKind = typeof BROWSER_HOST_SESSION_KINDS[number];

/**
 * An address the host minted a token for, so that its holder learns the
 * address's site and never the address. The host accepts one that a
 * locked-down session minted only in that session, and one that a read-only
 * session minted in any session of the browsing scope it was minted in.
 */
export interface BrowserHostUrlRef {
  kind: "url-ref";
  ref: string;
}

/**
 * Where `sign-in` copies the owner's sign-in from.
 *
 * - `weaver-profile`: the owner's own browser profile in the host, as it is.
 * - `owner`: the same, after the host asks the owner to sign in there, which
 *   waits for the owner as a hand-off does.
 */
export const BROWSER_HOST_SIGN_IN_SOURCES = [
  "weaver-profile",
  "owner",
] as const;

/** One of {@link BROWSER_HOST_SIGN_IN_SOURCES}. */
export type BrowserHostSignInSource =
  typeof BROWSER_HOST_SIGN_IN_SOURCES[number];

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
     * The address, as the agent wrote it, as a handle resolved it, or as a
     * URL reference: one this session minted, if it is locked down, or one a
     * read-only session of the browsing scope minted. A document opened from a
     * handle's value is reported by its origin alone, in the page of every
     * result, while the session stays on it.
     */
    url: string | BrowserHostHandleValue | BrowserHostUrlRef;
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
  | {
    /**
     * Presses `key`, first focusing the element at `ref` when there is one,
     * once the ref is checked against the current document.
     */
    action: "press";
    key: BrowserHostKey;
    ref?: BrowserHostRef;
  }
  | {
    action: "fill" | "type" | "select";
    ref: BrowserHostRef;
    value: BrowserHostValue;
  }
  | { action: "handoff"; reason: BrowserHostHandoffReason }
  | {
    /**
     * Opens the named session the request names, which no open session of
     * the browsing scope holds, and loads `url` in it. A `read-only` session
     * takes any http or https address; a `locked-down` one takes only an
     * address that has a site, and is bound to that site. A URL reference
     * opens here only if a read-only session of the browsing scope minted it,
     * since one a locked-down session minted opens only in that session.
     */
    action: "session-open";
    kind: BrowserHostSessionKind;
    url: string | BrowserHostUrlRef;
  }
  | {
    /** Ends the named session the request names, and frees its name. */
    action: "session-close";
  }
  | {
    /**
     * Lists every open named session of the browsing scope, including the
     * locked-down sessions kept for it after an earlier job ended. Sent with
     * no session, and waits on no session's operations.
     */
    action: "session-list";
  }
  | {
    /**
     * Reports the `https` site of each of `hosts`, written in Unicode or
     * ASCII, in the same order: the harness's only way to compute a site,
     * so that the host's copy of the Public Suffix List is the only one.
     * Sent with no session, and waits on no session's operations. At most
     * {@link BROWSER_HOST_SITE_OF_MAX_HOSTS} hosts.
     */
    action: "site-of";
    hosts: string[];
  }
  | {
    /**
     * Copies the owner's cookies and local storage for the bound site of a
     * locked-down session into it.
     */
    action: "sign-in";
    from: BrowserHostSignInSource;
  }
  | {
    /**
     * Runs `script` in the page's own world, in the main frame, in a
     * read-only session.
     */
    action: "evaluate";
    script: string;
  }
  | {
    /** Reports facts about the element at `ref`. */
    action: "describe";
    ref: BrowserHostRef;
  };

/** The operations whose answer carries no page. */
export type BrowserHostPagelessOperation = Extract<
  BrowserHostOperation,
  { action: "session-close" | "session-list" | "site-of" }
>;

/** The most hosts one `site-of` may ask about. */
export const BROWSER_HOST_SITE_OF_MAX_HOSTS = 1000;

/** The operations whose answer carries the page the session is on. */
export type BrowserHostPageOperation = Exclude<
  BrowserHostOperation,
  BrowserHostPagelessOperation
>;

/**
 * One operation the harness sends, and the session it addresses: the unnamed
 * session when `session` is absent.
 */
export interface BrowserHostRequest<
  O extends BrowserHostOperation = BrowserHostOperation,
> {
  session?: BrowserHostSessionName;
  operation: O;
}

/** The page a result was observed on, as the host committed it. */
export interface BrowserHostPage {
  /**
   * The URL the engine committed for the main frame, or its origin alone for
   * a document opened from a handle's value, which no observation carries.
   * Empty while the session is away.
   */
  url: string;

  /** The document's title, as the page wrote it. Empty while away. */
  title: string;

  /**
   * The site of the main frame's document, or `null` when its address has
   * none, which `sites` then records as `"null"`. Present in every result
   * from a named session. Absent, together with `sites`, from the unnamed
   * session's results when the host does not report sites.
   */
  site?: string | null;

  /**
   * The sites of the main frame and of every subframe the host knows about,
   * with `"null"` standing for every such frame whose address has no site,
   * distinct and in ascending order by UTF-8. Present exactly when `site` is.
   */
  sites?: string[];

  /** Set when a locked-down session is away. */
  away?: true;

  /**
   * In a locked-down session, and only there, whether the main frame's
   * committed document loaded over https with a server certificate the
   * engine accepted with no exception. False while away.
   */
  tls?: boolean;
}

/** What `session-open` reports of the session it opened. */
export interface BrowserHostSessionInfo {
  kind: BrowserHostSessionKind;

  /**
   * The site a locked-down session is bound to, or the site of a read-only
   * session's first address, which is `null` when that address has none.
   */
  site: string | null;
}

/** One open named session, as `session-list` reports it. */
export interface BrowserHostSessionListing extends BrowserHostSessionInfo {
  name: BrowserHostSessionName;

  /** Whether the session is a locked-down one that is away. */
  away: boolean;
}

/** What `describe` reports about an element. */
export interface BrowserHostElement {
  /** The element's accessibility role. */
  role: string;

  /** The element's tag name, in lowercase. */
  tag: string;

  /** The `type` of an `input` element. */
  inputType?: string;

  /** The element's `autocomplete` attribute. */
  autocomplete?: string;

  /** The element's accessible name, as the page wrote it. */
  name: string;

  /** Whether activating the element submits its form. */
  isSubmit: boolean;

  /** What the fields of the element's form, if any, ask for. */
  formHas: {
    /** A password field. */
    password: boolean;

    /** A field whose `autocomplete` is `one-time-code`. */
    oneTimeCode: boolean;

    /** A field whose `autocomplete` is one of the `cc-` tokens. */
    card: boolean;
  };
}

/**
 * The ways a host declines or fails an operation. Each is a fixed word, so a
 * refusal carries no page-authored text in its code.
 *
 * - `stale-ref`: the ref names an element of a document the page has since
 *   replaced; take a new snapshot.
 * - `owner-only-field`: the target is a password field, a one-time-code field,
 *   or a challenge; only the owner may enter a value there, through a
 *   hand-off. The one exception is a handle's value entered into a
 *   one-time-code field of a locked-down session, which the host enters.
 * - `session-ended`: the session is gone — the owner closed it, or the host
 *   detached.
 * - `off-site`: in a locked-down session, the address is not on the bound
 *   site, the target element is in a frame whose document is not on the bound
 *   site, or the session is away and the operation is not one it performs
 *   then.
 * - `wrong-kind`: the session's kind does not allow the operation.
 * - `invalid`: the operation does not describe anything the host can do.
 * - `failed`: the operation was attempted and did not complete.
 */
export const BROWSER_HOST_REFUSALS = [
  "stale-ref",
  "owner-only-field",
  "session-ended",
  "off-site",
  "wrong-kind",
  "invalid",
  "failed",
] as const;

/** One of {@link BROWSER_HOST_REFUSALS}. */
export type BrowserHostRefusal = typeof BROWSER_HOST_REFUSALS[number];

/** What a host returns for an operation it performed on a page. */
export interface BrowserHostPageResult {
  status: "ok";
  page: BrowserHostPage;

  /** The operation's observation as text, when it has one. */
  text?: string;

  /** A screenshot's pixels. */
  image?: { mediaType: "image/png"; base64: string };

  /** How the owner ended a hand-off, or a sign-in from the `owner`. */
  handoff?: "done" | "declined";

  /**
   * The committed address, as a token, for every `get url` in a named
   * session, which reports the address as `text` too except while away.
   */
  urlRef?: BrowserHostUrlRef;
}

/** What a host returns for a `session-open` it performed. */
export interface BrowserHostSessionOpenResult extends BrowserHostPageResult {
  /** The session that opened. */
  session: BrowserHostSessionInfo;
}

/** What a host returns for a `sign-in` it performed. */
export interface BrowserHostSignInResult extends BrowserHostPageResult {
  /** How many cookies were copied into the session. */
  signIn: { copied: number };
}

/** What a host returns for an `evaluate` it performed. */
export interface BrowserHostEvaluateResult extends BrowserHostPageResult {
  /** The JSON encoding of the script's completion value. */
  text: string;
}

/** What a host returns for a `describe` it performed. */
export interface BrowserHostDescribeResult extends BrowserHostPageResult {
  /** The element at the ref. */
  element: BrowserHostElement;
}

/** What a host returns for a `session-list` it performed. */
export interface BrowserHostSessionListResult {
  status: "ok";

  /** Every open named session of the browsing scope. */
  sessions: BrowserHostSessionListing[];
}

/** What a host returns for a `session-close` it performed. */
export interface BrowserHostSessionCloseResult {
  status: "ok";
}

/** What a host returns for a `site-of` it performed. */
export interface BrowserHostSiteOfResult {
  status: "ok";

  /**
   * The `https` site of each host asked about, in the same order, or `null`
   * for a host that has none.
   */
  sites: (string | null)[];
}

/** What a host returns for an operation of type `O` that it performed. */
export type BrowserHostOkResult<
  O extends BrowserHostOperation = BrowserHostOperation,
> = O extends { action: "session-list" } ? BrowserHostSessionListResult
  : O extends { action: "session-close" } ? BrowserHostSessionCloseResult
  : O extends { action: "site-of" } ? BrowserHostSiteOfResult
  : O extends { action: "session-open" } ? BrowserHostSessionOpenResult
  : O extends { action: "sign-in" } ? BrowserHostSignInResult
  : O extends { action: "evaluate" } ? BrowserHostEvaluateResult
  : O extends { action: "describe" } ? BrowserHostDescribeResult
  : BrowserHostPageResult;

/** What a host returns for an operation it declined or failed. */
export interface BrowserHostRefusalResult {
  status: BrowserHostRefusal;
  message: string;
  page?: BrowserHostPage;
}

/** What a host returns for one operation of type `O`. */
export type BrowserHostResult<
  O extends BrowserHostOperation = BrowserHostOperation,
> = BrowserHostOkResult<O> | BrowserHostRefusalResult;

/**
 * The harness side of an attached host: what the `browser` tool calls when a
 * run has one. `perform` settles when the host answers or `signal` aborts,
 * and never on a clock of its own, since an operation that needs the owner
 * waits for the owner.
 *
 * An implementation is where a host's answer enters the harness: it resolves
 * only with a {@link BrowserHostResult}, having checked whatever crossed its
 * channel with {@link isBrowserHostResult} against the request, so a caller
 * reads the result as its type says. It resolves a request that
 * {@link browserHostRequestProblem} finds a problem with as `invalid`, without
 * sending it. Requests to different sessions are performed concurrently, and
 * requests to one session in the order `perform` was called.
 */
export interface HarnessBrowserHost {
  /** Performs `request.operation` in the session `request` addresses. */
  perform<O extends BrowserHostOperation>(
    request: BrowserHostRequest<O>,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult<O>>;
}

/** Whether `value` is a {@link BrowserHostSessionName}. */
export const isBrowserHostSessionName = (
  value: unknown,
): value is BrowserHostSessionName =>
  typeof value === "string" && SESSION_NAME.test(value);

/**
 * Whether `page` is one the named session `session` describes could report: a
 * read-only session's page carries neither `tls` nor `away`, and a locked-down
 * session's page carries `tls` and is away exactly when it is on another site
 * than the bound one. {@link isBrowserHostResult} checks this only for
 * `session-open`, the one request whose result states the session, so the
 * harness checks every other result against what it knows of the session.
 */
export const browserHostPageFitsSession = (
  page: BrowserHostPage,
  session: BrowserHostSessionInfo,
): boolean =>
  session.kind === "read-only"
    ? page.tls === undefined && page.away === undefined
    : page.tls !== undefined &&
      (page.away === true) === (page.site !== session.site);

/**
 * Whether `value` is written as a site is: `http` or `https`, then a domain of
 * at least two labels in lowercase ASCII, each starting and ending with a
 * letter or digit and the last holding a letter, so never an IP literal, with
 * no port and no trailing dot or slash. It does not check that the domain is
 * registrable, which only the Public Suffix List decides.
 */
export const isBrowserHostSite = (value: unknown): value is string =>
  typeof value === "string" && SITE.test(value);

/**
 * What is wrong with `request` as the harness would send it, or `undefined`
 * when nothing is: a malformed session name, a `session-open` or
 * `session-close` that names no session, a `session-list` or `site-of` that
 * names one, or a `site-of` asking about more than
 * {@link BROWSER_HOST_SITE_OF_MAX_HOSTS} hosts.
 */
export const browserHostRequestProblem = (
  request: BrowserHostRequest,
): string | undefined => {
  const { session, operation } = request;
  if (session !== undefined && !isBrowserHostSessionName(session)) {
    return "a session name is 1 to 64 ASCII letters, digits, hyphens, " +
      "and underscores";
  }
  if (
    (operation.action === "session-open" ||
      operation.action === "session-close") && session === undefined
  ) {
    return `\`${operation.action}\` names a session`;
  }
  if (SCOPE_ACTIONS.has(operation.action) && session !== undefined) {
    return `\`${operation.action}\` is sent with no session`;
  }
  if (
    operation.action === "site-of" &&
    operation.hosts.length > BROWSER_HOST_SITE_OF_MAX_HOSTS
  ) {
    return "`site-of` asks about at most " +
      `${BROWSER_HOST_SITE_OF_MAX_HOSTS} hosts`;
  }
  return undefined;
};

/**
 * The queue a channel orders `request` in, where a withdrawal the host has
 * not acknowledged holds back the requests after it: the session's name, `""`
 * for the unnamed session, or `undefined` for a `session-list` or `site-of`,
 * which concerns the browsing scope rather than a session and so waits in
 * none.
 */
export const browserHostQueueOf = (
  request: BrowserHostRequest,
): string | undefined =>
  SCOPE_ACTIONS.has(request.operation.action)
    ? undefined
    : request.session ?? "";

/**
 * Whether `value` is a result a host could have sent for `request`: a known
 * status with the fields that status and the operation carry, and a page as
 * the session reports one wherever a page appears. A host is trusted to
 * execute operations, not to be free of bugs, so what crosses the channel is
 * checked before the harness reads it. Fields it does not know are ignored,
 * and so are known fields on a result that does not carry them, except that a
 * URL reference is refused anywhere but an ok `get url` in a named session,
 * and text and pixels are refused beside an away page.
 */
export const isBrowserHostResult = <O extends BrowserHostOperation>(
  value: unknown,
  request: BrowserHostRequest<O>,
): value is BrowserHostResult<O> => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const named = request.session !== undefined;
  const page = value.page;
  if (page !== undefined && !isPage(page, named)) {
    return false;
  }
  const { operation } = request;
  const { text, image, handoff, urlRef } = value;
  const away = page?.away === true;
  // A named session's `get url` reports the address as a token, and as text
  // too unless the session is away.
  const namedGetUrl = value.status === "ok" && named &&
    operation.action === "get" && operation.kind === "url";
  if (
    (away && (text !== undefined || image !== undefined)) ||
    (namedGetUrl
      ? !isUrlRef(urlRef) || (!away && typeof text !== "string")
      : urlRef !== undefined)
  ) {
    return false;
  }
  if (value.status !== "ok") {
    return typeof value.status === "string" && REFUSALS.has(value.status) &&
      typeof value.message === "string";
  }
  if (operation.action === "session-list") {
    return Array.isArray(value.sessions) &&
      value.sessions.every(isSessionListing);
  }
  if (operation.action === "session-close") {
    return true;
  }
  if (operation.action === "site-of") {
    const { sites } = value;
    return Array.isArray(sites) && sites.length === operation.hosts.length &&
      sites.every((site) =>
        site === null || (isBrowserHostSite(site) && site.startsWith("https:"))
      );
  }
  if (page === undefined) {
    return false;
  }
  const pageResult = (text === undefined || typeof text === "string") &&
    (handoff === undefined || handoff === "done" || handoff === "declined") &&
    (image === undefined ||
      (isObjectNotArray(image) && image.mediaType === "image/png" &&
        typeof image.base64 === "string"));
  if (!pageResult) {
    return false;
  }
  switch (operation.action) {
    case "session-open":
      return isSessionInfo(value.session) &&
        value.session.kind === operation.kind &&
        browserHostPageFitsSession(page, value.session);
    case "sign-in":
      return isObjectNotArray(value.signIn) &&
        isCount(value.signIn.copied) &&
        (handoff !== undefined) === (operation.from === "owner");
    case "evaluate":
      return typeof text === "string";
    case "describe":
      return isElement(value.element);
    default:
      return true;
  }
};

const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The operations about the browsing scope rather than one session. */
const SCOPE_ACTIONS: ReadonlySet<string> = new Set(["session-list", "site-of"]);

/** One label of a domain, which starts and ends with a letter or digit. */
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

const SITE = new RegExp(
  `^https?://(?:${LABEL}\\.)+(?=[a-z0-9-]*[a-z])${LABEL}$`,
);

const REFUSALS: ReadonlySet<string> = new Set(BROWSER_HOST_REFUSALS);

const SESSION_KINDS: ReadonlySet<unknown> = new Set(BROWSER_HOST_SESSION_KINDS);

/**
 * Helper for {@link isBrowserHostResult}, which checks a page. Only a named
 * session may be away or report `tls`, and an away page carries no address,
 * no title, and `tls` false.
 */
const isPage = (value: unknown, named: boolean): value is BrowserHostPage => {
  if (
    !isObjectNotArray(value) || typeof value.url !== "string" ||
    typeof value.title !== "string"
  ) {
    return false;
  }
  const { site, sites, away, tls } = value;
  if (site === undefined && sites === undefined) {
    return !named && away === undefined && tls === undefined;
  }
  return isSiteList(sites) &&
    (site === null || isBrowserHostSite(site)) &&
    sites.includes(site ?? "null") &&
    (tls === undefined || (named && typeof tls === "boolean")) &&
    (away === undefined ||
      (away === true && named && value.url === "" && value.title === "" &&
        tls === false));
};

/**
 * Helper for {@link isPage}, which checks that `value` is a list of sites, or
 * `"null"` for frames with none, in strictly ascending order, and so holds
 * each at most once.
 */
const isSiteList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((site): site is string =>
    site === "null" || isBrowserHostSite(site)
  ) &&
  value.every((site, index) =>
    index === 0 || utf8Compare(value[index - 1], site) < 0
  );

/** Helper for {@link isBrowserHostResult}, which checks a count of things. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Helper for {@link isBrowserHostResult}, which checks a URL reference. */
const isUrlRef = (value: unknown): value is BrowserHostUrlRef =>
  isObjectNotArray(value) && value.kind === "url-ref" &&
  typeof value.ref === "string";

/**
 * Helper for {@link isBrowserHostResult}, which checks what `session-open`
 * reports. A locked-down session is always bound to a site.
 */
const isSessionInfo = (value: unknown): value is BrowserHostSessionInfo =>
  isObjectNotArray(value) && SESSION_KINDS.has(value.kind) &&
  (value.site === null
    ? value.kind === "read-only"
    : isBrowserHostSite(value.site));

/**
 * Helper for {@link isBrowserHostResult}, which checks one entry of what
 * `session-list` reports. Only a locked-down session can be away.
 */
const isSessionListing = (value: unknown): value is BrowserHostSessionListing =>
  isObjectNotArray(value) && isSessionInfo(value) &&
  isBrowserHostSessionName(value.name) && typeof value.away === "boolean" &&
  (value.kind === "locked-down" || value.away === false);

/**
 * Helper for {@link isBrowserHostResult}, which checks what `describe`
 * reports.
 */
const isElement = (value: unknown): value is BrowserHostElement => {
  if (
    !isObjectNotArray(value) || typeof value.role !== "string" ||
    typeof value.tag !== "string" || typeof value.name !== "string" ||
    typeof value.isSubmit !== "boolean" ||
    (value.inputType !== undefined && typeof value.inputType !== "string") ||
    (value.autocomplete !== undefined &&
      typeof value.autocomplete !== "string")
  ) {
    return false;
  }
  const { formHas } = value;
  return isObjectNotArray(formHas) && typeof formHas.password === "boolean" &&
    typeof formHas.oneTimeCode === "boolean" &&
    typeof formHas.card === "boolean";
};
