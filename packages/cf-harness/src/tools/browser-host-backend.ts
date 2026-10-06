/**
 * The `browser` tool's host backend: turning a validated call into one
 * operation for the browser host attached to the run, and the host's result
 * into the tool's output.
 *
 * The host executes the operation in the one session it holds for this run and
 * shows it to the owner. What this side decides is what the operation carries
 * and where it may go: a handle's value is resolved here, trusted-side, and
 * marked as a handle value, so the host keeps it out of later observations,
 * and no operation names this device, its network, or an IP literal.
 */

import {
  BROWSER_HOST_HANDOFF_REASONS,
  BROWSER_HOST_KEYS,
  BROWSER_HOST_LOAD_STATES,
  BROWSER_HOST_SCROLL_DIRECTIONS,
  type BrowserHostOperation,
  type BrowserHostRefusal,
  type BrowserHostResult,
  type BrowserHostValue,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "../contracts/browser-host.ts";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc";
import {
  cfcObservationFitsCeiling,
  type CfcObservedConfidentiality,
  type IFCLabel,
  joinCfcObservedConfidentiality,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { REFERENT_HANDLE_TOKEN_PREFIX } from "../contracts/handle-table.ts";
import { createHarnessImageAttachmentFromBase64 } from "../image-attachments.ts";
import type {
  BrowserToolAction,
  BrowserToolErrorCode,
  BrowserToolInput,
  BrowserToolOutput,
} from "./browser.ts";
import { httpOriginOf, resolveReturnReferent } from "./handle-values.ts";
import type { HarnessToolContext } from "./types.ts";

const MAX_HOST_OUTPUT_CHARS = 20_000;

/** The error code each host refusal is reported under. */
const REFUSAL_CODES: Record<BrowserHostRefusal, BrowserToolErrorCode> = {
  "stale-ref": "stale_ref",
  "owner-only-field": "owner_only_field",
  "session-ended": "session_ended",
  "invalid": "invalid_input",
  "failed": "command_failed",
};

/**
 * The actions refused once a hand-off was sent: each changes the page, leaves
 * it for an address no one checked, or sends it again.
 */
const ACTING_ACTIONS: ReadonlySet<BrowserToolAction> = new Set([
  "back",
  "forward",
  "reload",
  "click",
  "check",
  "press",
  "fill",
  "type",
  "select",
]);

/** What the harness keeps about each host's session. */
interface HostSession {
  /**
   * The session label: the join of the labels of every value sent to the
   * host, since what a page shows from then on may be derived from any of
   * them.
   */
  label: CfcObservedConfidentiality;

  /**
   * The web origin of the page the run last saw a result on, or `undefined`
   * before any or when that page had none.
   */
  origin?: string | undefined;

  /**
   * Set when the first hand-off is sent, however it ends: from then on a page
   * may hold the owner's sign-in. `origin` is the web origin the page was on
   * when it was handed off, which confines the session, or `undefined` when
   * it was on none the run knew.
   */
  handedOff?: { origin: string | undefined };
}

const sessions = new WeakMap<HarnessBrowserHost, HostSession>();

const sessionOf = (host: HarnessBrowserHost): HostSession => {
  let session = sessions.get(host);
  if (session === undefined) {
    session = { label: [] };
    sessions.set(host, session);
  }
  return session;
};

/**
 * Whether a hand-off was sent in `host`'s session, after which a page may
 * hold the owner's signed-in account rather than the public web.
 */
export const browserHostHandedOff = (host: HarnessBrowserHost): boolean =>
  sessions.get(host)?.handedOff !== undefined;

/** Where the page was handed off, as the messages that cite it say it. */
const handedOffOn = (handedOff: { origin: string | undefined }): string =>
  handedOff.origin === undefined
    ? "the page was handed to the owner on no web origin this run knows"
    : `the page was handed to the owner on ${handedOff.origin}`;

/**
 * How a page with no web origin is reported and labeled: the serialization
 * the web gives an opaque origin, so nothing of such a page's URL, which the
 * page may have chosen, reaches a label or a result's page.
 */
const OPAQUE_ORIGIN = "null";

/** The URL a result reports for a page the host committed at `url`. */
const reportedUrl = (url: string): string =>
  httpOriginOf(url) === undefined ? OPAQUE_ORIGIN : url;

/** The name suffixes that resolve on this device or its network. */
const LOCAL_NAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".ts.net",
];

/**
 * Whether `hostname`, a parsed URL's, names this device, its network, or an
 * address written as an IP literal. A name is judged by its spelling; the
 * host refuses what it resolves to.
 */
const isLocalHost = (hostname: string): boolean => {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || !name.includes(".") ||
    name.startsWith("[") || /^[\d.]+$/.test(name) ||
    LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

/**
 * Why the page may not go to `url`, or `undefined` when it may: an http(s)
 * address on the open web, and after a hand-off, on the web origin it ended
 * on.
 */
const destinationError = (
  host: HarnessBrowserHost,
  url: string,
): string | undefined => {
  const origin = httpOriginOf(url);
  if (origin === undefined) {
    return "open only allows http(s) URLs";
  }
  if (isLocalHost(new URL(url).hostname)) {
    return "open only reaches the open web: not this device, its network, or an IP address";
  }
  const handedOff = sessionOf(host).handedOff;
  if (handedOff !== undefined && origin !== handedOff.origin) {
    return `${handedOffOn(handedOff)}, so it ${
      handedOff.origin === undefined
        ? "may open no site"
        : "stays on that origin"
    }`;
  }
  return undefined;
};

/**
 * An operation whose value, if it enters one, is still to be resolved: the
 * shape of the call, settled before anything is read.
 */
type PlannedOperation =
  | { operation: BrowserHostOperation; binding?: undefined }
  | {
    operation?: undefined;
    binding: {
      field: "url" | "value";
      handle: string;
      complete(resolved: {
        text: string;
        description: string;
      }): BrowserHostOperation | string;
    };
  };

type PlanResult =
  | { plan: PlannedOperation; error?: undefined }
  | { plan?: undefined; error: string };

const isRef = (ref: unknown): ref is string =>
  typeof ref === "string" && ref.startsWith("@");

const refError = (action: string): string =>
  `${action} requires a ref starting with @, taken from a snapshot`;

/** The member of `values` that `value` is, or `undefined` when it is none. */
const memberOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): T | undefined => values.find((member) => member === value);

const isPoint = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The host a URL pattern names, as `scheme://host/...` does, a glob for its
 * scheme included, or `undefined` for a pattern that names none. A bracketed
 * IPv6 literal is returned bracketed.
 */
const patternHost = (pattern: string): string | undefined => {
  const authority = /^[^/?#]*:\/\/([^/?#]*)/.exec(pattern)?.[1];
  if (authority === undefined) {
    return undefined;
  }
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host.startsWith("[") ? host : host.split(":")[0];
};

/**
 * Why `handle` cannot give a value to a page, or `undefined` when it can: a
 * host takes only a return referent, a string a browser child found on the
 * web, since nothing yet holds a value from the owner's space to the page it
 * was meant for.
 */
const handleError = (field: string, handle: string): string | undefined =>
  handle.trim().startsWith(REFERENT_HANDLE_TOKEN_PREFIX)
    ? undefined
    : `${field} takes a return referent (cfh:v:) on this run's browser: a browser host enters no value from the owner's space`;

/**
 * The operation `input` describes, or the handle it binds and how the value
 * completes the operation once resolved. `input` has already passed the
 * tool's field checks, so every field it carries is one its action reads.
 */
const planHostOperation = (
  host: HarnessBrowserHost,
  input: BrowserToolInput,
  action: BrowserToolAction,
): PlanResult => {
  const done = (operation: BrowserHostOperation): PlanResult => ({
    plan: { operation },
  });
  const handedOff = sessionOf(host).handedOff;
  if (ACTING_ACTIONS.has(action) && handedOff !== undefined) {
    return {
      error: `${
        handedOffOn(handedOff)
      }, so it may hold their sign-in, and only reading it and opening that site are allowed: ${action} is refused`,
    };
  }
  switch (action) {
    case "open": {
      if (input.urlHandle !== undefined) {
        const error = handleError("urlHandle", input.urlHandle);
        if (error !== undefined) {
          return { error };
        }
        return {
          plan: {
            binding: {
              field: "url",
              handle: input.urlHandle,
              complete: ({ text, description }) =>
                destinationError(host, text) ?? {
                  action: "open",
                  url: { kind: "handle-value", text, description },
                },
            },
          },
        };
      }
      if (typeof input.url !== "string" || input.url === "") {
        return { error: "open requires a url" };
      }
      const error = destinationError(host, input.url);
      return error === undefined
        ? done({ action: "open", url: input.url })
        : { error };
    }
    case "back":
    case "forward":
    case "reload":
    case "console":
    case "errors":
    case "screenshot":
      return done({ action });
    case "scroll": {
      const direction = memberOf(
        BROWSER_HOST_SCROLL_DIRECTIONS,
        input.direction,
      );
      if (direction === undefined) {
        return {
          error: `scroll requires a direction: ${
            BROWSER_HOST_SCROLL_DIRECTIONS.join(", ")
          }`,
        };
      }
      if (input.ref !== undefined && !isRef(input.ref)) {
        return { error: refError(action) };
      }
      return done({
        action,
        direction,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
      });
    }
    case "snapshot":
      return done({ action, interactive: input.interactive === true });
    case "get": {
      if (input.kind === "title" || input.kind === "url") {
        return input.target === undefined
          ? done({ action, kind: input.kind })
          : { error: `get ${input.kind} does not take a target` };
      }
      if (input.kind === "text") {
        return typeof input.target === "string" && input.target !== ""
          ? done({ action, kind: "text", target: input.target })
          : {
            error:
              "get text requires a target: a CSS selector such as body, or an @ref from a snapshot",
          };
      }
      return { error: "get requires kind title, url, or text" };
    }
    case "wait": {
      if (input.ms !== undefined) {
        return {
          error:
            "this run's browser waits for something to happen rather than for a time: wait for a ref, a loadState, or a urlPattern",
        };
      }
      const forms = [input.ref, input.loadState, input.urlPattern]
        .filter((form) => form !== undefined);
      if (forms.length !== 1) {
        return {
          error: "wait requires exactly one of ref, loadState, or urlPattern",
        };
      }
      if (input.ref !== undefined) {
        return isRef(input.ref)
          ? done({ action, ref: input.ref })
          : { error: refError(action) };
      }
      if (input.loadState !== undefined) {
        const state = memberOf(BROWSER_HOST_LOAD_STATES, input.loadState);
        return state !== undefined ? done({ action, loadState: state }) : {
          error:
            "wait loadState must be domcontentloaded, load, or networkidle",
        };
      }
      const urlPattern = input.urlPattern;
      if (
        typeof urlPattern !== "string" || urlPattern === "" ||
        /^file:/i.test(urlPattern)
      ) {
        return { error: "wait urlPattern requires a non-file pattern" };
      }
      const named = patternHost(urlPattern);
      return named !== undefined && isLocalHost(named)
        ? {
          error:
            "wait urlPattern names the open web only: not this device, its network, or an IP address",
        }
        : done({ action, urlPattern });
    }
    case "click": {
      if (input.x !== undefined || input.y !== undefined) {
        if (input.ref !== undefined) {
          return {
            error: "click takes a ref or a point (x and y), never both",
          };
        }
        return isPoint(input.x) && isPoint(input.y)
          ? done({ action, x: input.x, y: input.y })
          : {
            error:
              "click at a point requires both x and y, each a non-negative number of screenshot pixels",
          };
      }
      return isRef(input.ref)
        ? done({ action, ref: input.ref })
        : { error: refError(action) };
    }
    case "check":
      return isRef(input.ref)
        ? done({ action, ref: input.ref })
        : { error: refError(action) };
    case "press": {
      const key = memberOf(BROWSER_HOST_KEYS, input.key);
      return key !== undefined ? done({ action, key }) : {
        error: `press requires one of the keys ${BROWSER_HOST_KEYS.join(", ")}`,
      };
    }
    case "fill":
    case "type":
    case "select": {
      const ref = input.ref;
      if (!isRef(ref)) {
        return { error: refError(action) };
      }
      const withValue = (value: BrowserHostValue): BrowserHostOperation => ({
        action,
        ref,
        value,
      });
      if (input.valueHandle !== undefined) {
        const error = handleError("valueHandle", input.valueHandle);
        if (error !== undefined) {
          return { error };
        }
        return {
          plan: {
            binding: {
              field: "value",
              handle: input.valueHandle,
              complete: ({ text, description }) =>
                withValue({ kind: "handle-value", text, description }),
            },
          },
        };
      }
      return typeof input.value === "string"
        ? done(withValue({ kind: "text", text: input.value }))
        : { error: `${action} requires a value or a valueHandle` };
    }
    case "handoff": {
      const reason = memberOf(BROWSER_HOST_HANDOFF_REASONS, input.reason);
      return reason !== undefined ? done({ action, reason }) : {
        error: `handoff requires a reason: ${
          BROWSER_HOST_HANDOFF_REASONS.join(", ")
        }`,
      };
    }
  }
};

const truncate = (text: string, label: string): string => {
  if (text.length <= MAX_HOST_OUTPUT_CHARS) {
    return text;
  }
  const omitted = text.length - MAX_HOST_OUTPUT_CHARS;
  return `${
    text.slice(0, MAX_HOST_OUTPUT_CHARS)
  }\n[cf-harness truncated ${label}: ${omitted} chars omitted]`;
};

/** The longest page title the model is shown; a title is the page's words. */
const MAX_TITLE_CHARS = 200;

/**
 * `title`, cut to {@link MAX_TITLE_CHARS} characters as a reader counts them,
 * never inside one: an emoji joined from several, or a letter and its accents,
 * is one.
 */
const truncateTitle = (title: string): string => {
  const characters = Array.from(
    new Intl.Segmenter().segment(title),
    ({ segment }) => segment,
  );
  return characters.length <= MAX_TITLE_CHARS
    ? title
    : `${characters.slice(0, MAX_TITLE_CHARS).join("")}…`;
};

/**
 * The confidentiality of what a page at `url` shows: the unscreened
 * prompt-injection caveat, sourced to the page's origin, since a page's text
 * and pixels may carry instructions.
 */
const pageConfidentiality = (url: string): CfcObservedConfidentiality => [
  cfcAtom.caveat(
    CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
    cfcAtom.resource("WebPage", httpOriginOf(url) ?? OPAQUE_ORIGIN),
  ),
];

/**
 * The label of the `browser` tool's `output` on a run with `host`, or
 * `undefined` when the output shows nothing labeled: the session label, joined
 * for a successful result with the page's caveat.
 */
export const browserHostResultLabel = (
  host: HarnessBrowserHost,
  output: unknown,
): IFCLabel | undefined => {
  const page = isObjectNotArray(output) && output.status === "ok" &&
      isObjectNotArray(output.page) && typeof output.page.url === "string"
    ? pageConfidentiality(output.page.url)
    : [];
  const confidentiality = joinCfcObservedConfidentiality([
    page,
    sessions.get(host)?.label,
  ]);
  return confidentiality.length === 0
    ? undefined
    : { confidentiality: [...confidentiality] };
};

/** Whether the run enforces CFC rather than observing it or not at all. */
const enforcing = (context: HarnessToolContext): boolean =>
  context.cfcEnforcementMode === "enforce-explicit" ||
  context.cfcEnforcementMode === "enforce-strict";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Executes one validated `browser` call on `host` and returns the tool's
 * output. `action` is the call's action, already established by the tool's
 * field checks.
 *
 * The call waits for the host however long it takes — a hand-off waits for
 * the owner — and ends early only when the run's signal aborts.
 */
export const invokeBrowserOnHost = async (
  context: HarnessToolContext,
  host: HarnessBrowserHost,
  input: BrowserToolInput,
  action: BrowserToolAction,
  outputId: string,
): Promise<BrowserToolOutput> => {
  const errorOutput = (
    code: BrowserToolErrorCode,
    message: string,
  ): BrowserToolOutput => ({ outputId, status: "error", code, message });
  if (input.timeoutMs !== undefined) {
    return errorOutput(
      "invalid_input",
      "timeoutMs does not apply to this run's browser: an action ends when the page does what was asked, or the owner answers",
    );
  }
  // Before a hand-off, the host is a fresh browser with no sign-in, and what
  // it shows is the public web, whose label is public. Once one is sent, a
  // page may show the owner's account, which no CFC label describes, so a
  // run under enforcement gives the page back to the owner and observes
  // nothing more of it.
  const session = sessionOf(host);
  if (
    session.handedOff !== undefined && action !== "handoff" &&
    enforcing(context)
  ) {
    return errorOutput(
      "invalid_input",
      `${
        handedOffOn(session.handedOff)
      }, so it may show their account, which no CFC label describes; a run under ${context.cfcEnforcementMode} can only hand the page back to them`,
    );
  }
  // The whole call is planned before anything is read, so a call that cannot
  // execute never reads a handle's value.
  const planned = planHostOperation(host, input, action);
  if (planned.error !== undefined) {
    return errorOutput("invalid_input", planned.error);
  }
  let operation: BrowserHostOperation;
  if (planned.plan.binding === undefined) {
    operation = planned.plan.operation;
  } else {
    const { binding } = planned.plan;
    const resolution = resolveReturnReferent(
      context,
      binding.handle,
      binding.field === "url" ? "browser urlHandle" : "browser valueHandle",
    );
    if (resolution.error !== undefined) {
      return errorOutput("invalid_input", resolution.error);
    }
    const completed = binding.complete({
      text: resolution.value,
      description: "a value an agent found",
    });
    if (typeof completed === "string") {
      return errorOutput("invalid_input", completed);
    }
    session.label = joinCfcObservedConfidentiality([
      session.label,
      resolution.label.confidentiality,
    ]);
    operation = completed;
  }
  // The owner may sign in whether the hand-off ends finished, declined, or
  // not at all, so the session is confined from the moment it is sent.
  if (operation.action === "handoff") {
    session.handedOff ??= { origin: session.origin };
  }
  let result: BrowserHostResult;
  try {
    const answer: unknown = await host.perform(operation, context.signal);
    if (!isBrowserHostResult(answer)) {
      return errorOutput(
        "host_unavailable",
        "the browser host answered with something that is not a result",
      );
    }
    result = answer;
  } catch (error) {
    context.signal?.throwIfAborted();
    return errorOutput(
      "host_unavailable",
      `the browser host could not be reached: ${errorMessage(error)}`,
    );
  }
  if (result.status !== "ok") {
    return errorOutput(
      REFUSAL_CODES[result.status],
      truncate(result.message, "message"),
    );
  }
  // An open or a read checks where the page is meant to be; this checks
  // where the engine committed it, which the owner, a redirect, or the page
  // itself may have moved.
  const origin = httpOriginOf(result.page.url);
  const elsewhere = session.handedOff !== undefined &&
    (origin === undefined || origin !== session.handedOff.origin);
  if (elsewhere && operation.action !== "handoff") {
    return errorOutput(
      "command_failed",
      "the action ran, but the page is not on the web origin it was handed to the owner on, so none of it is returned",
    );
  }
  if (!elsewhere) {
    session.origin = origin;
  }
  // A run whose read ceiling admits nothing a web page shows is told the
  // action ran, and given none of the page.
  if (
    !cfcObservationFitsCeiling(
      pageConfidentiality(result.page.url),
      context.cfcReadMaxConfidentiality,
    )
  ) {
    return errorOutput(
      "command_failed",
      "the action ran, but this run's read ceiling admits nothing a web page shows: a page's text and pixels may carry instructions",
    );
  }
  // The page a hand-off ended on may already show the owner's account, so a
  // run under enforcement, or one whose page the owner left the origin on,
  // learns how the hand-off ended and where, and nothing the page shows.
  if (operation.action === "handoff" && (enforcing(context) || elsewhere)) {
    return {
      outputId,
      status: "ok",
      output: result.handoff ?? "the hand-off ended",
      page: { url: origin ?? OPAQUE_ORIGIN, title: "" },
      ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
    };
  }
  let imageAttachment;
  if (result.image !== undefined) {
    if (context.imageAttachmentSnapshotDir === undefined) {
      return errorOutput(
        "command_failed",
        "this run keeps no artifacts, so a screenshot has nowhere to be held",
      );
    }
    try {
      imageAttachment = await createHarnessImageAttachmentFromBase64({
        snapshotDir: context.imageAttachmentSnapshotDir,
        base64: result.image.base64,
        mediaType: result.image.mediaType,
      });
    } catch (error) {
      return errorOutput(
        "command_failed",
        `the screenshot could not be kept: ${errorMessage(error)}`,
      );
    }
  }
  return {
    outputId,
    status: "ok",
    output: truncate(result.text ?? "done", "output"),
    page: {
      url: reportedUrl(result.page.url),
      title: truncateTitle(result.page.title),
    },
    ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
    ...(imageAttachment !== undefined ? { imageAttachment } : {}),
  };
};
