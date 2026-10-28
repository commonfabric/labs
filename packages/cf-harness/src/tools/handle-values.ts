/**
 * Turning a handle the run holds into the value it stands for, trusted-side
 * and at the point of use.
 *
 * A tool field that takes a value has a sibling that takes a handle instead.
 * The model writes the handle token; the prompt loop's inbound swap rewrites
 * it into the canonical LLM-friendly link string before the tool runs, so
 * what arrives here is normally an address. Either spelling is accepted, and
 * neither the value nor anything derived from it appears in a message this
 * returns.
 *
 * Accepting either spelling is why the reference is checked against the run's
 * handle table rather than read on sight. The inbound swap has already turned
 * tokens into addresses by the time a tool runs, so a tool cannot tell an
 * address that arrived that way from one the model wrote out itself — guessed,
 * or read off a page. Membership in the table is what separates them: a handle
 * this run was given has an entry, an address the model composed does not, and
 * only the first resolves. Without that check a handle field is a general read
 * of every cell in the run's space.
 *
 * A referent token (`cfh:v:`) resolves through {@link resolveReturnReferent}
 * instead, in the browser tool's value fields, when it names a string a
 * child's structured return sealed: that is how a parent hands one child's
 * finding, a URL, say, to another child's tool without reading it. A field
 * that takes an address refuses one.
 */

import {
  cfcObservationFitsCeiling,
  type IFCLabel,
} from "@commonfabric/runner/cfc";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";

import {
  handleRefAddressKey,
  resolveHandleRef,
  resolveHandleToken,
  resolveReferentToken,
} from "../handle-table.ts";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  REFERENT_HANDLE_TOKEN_PREFIX,
} from "../contracts/handle-table.ts";
import type { HarnessToolContext } from "./types.ts";
import type { HarnessHandleCapability } from "../contracts/handle-table.ts";

export type HandleValueResolution =
  | { value: string; error?: undefined }
  | { value?: undefined; error: string };

/** A string a child's structured return sealed, and the label it carries. */
export type ReturnReferentResolution =
  | { value: string; label: IFCLabel; error?: undefined }
  | { value?: undefined; label?: undefined; error: string };

/** The part of the tool context a handle resolution reads. */
export type HandleValueResolutionContext = Pick<
  HarnessToolContext,
  "getFabricSession" | "handleTable" | "cfcReadMaxConfidentiality"
>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The origin of `url` when it is an http(s) URL, and `undefined` otherwise.
 * Origin is the whole of what a destination check compares and the whole of
 * what a refusal about one may name: it says where a value would go without
 * carrying the path, query, or fragment a caller chose.
 */
export const httpOriginOf = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return parsed.origin;
};

/**
 * Whether `url` is an http(s) URL that opens with its scheme and holds no
 * whitespace or control character. A URL parser strips some of those
 * characters and encodes the rest, while a browser driver is handed the
 * string as written, so a check of the parsed URL alone can pass a string
 * the browser reads differently. Other normalizations a parser makes, such
 * as mapping a host name's characters, are not refused here.
 */
export const isHttpUrl = (url: string): boolean =>
  /^https?:\/\/[^\s\p{Cc}]*$/iu.test(url) && httpOriginOf(url) !== undefined;

/** The flag with which an operator allows a destination for a handle's value. */
export const HANDLE_VALUE_ORIGIN_FLAG = "--handle-value-origin";

/** Why a run that allows no destination sends a handle's value nowhere. */
export const NO_HANDLE_VALUE_DESTINATION_MESSAGE =
  `this run allows no destination for a handle's value; an operator allows one with ${HANDLE_VALUE_ORIGIN_FLAG} <origin>`;

/**
 * The refusal for a destination outside the allowlist. It names the origin
 * and nothing else: the operator needs to know which origin to allow, and the
 * path, query, and value that would have gone there are none of the model's
 * business.
 */
export const originNotAllowedMessage = (origin: string): string =>
  `${origin} is not an allowlisted destination for a handle's value; an operator allows one with ${HANDLE_VALUE_ORIGIN_FLAG} <origin>`;

/**
 * The string value behind `handle`, or an explanation of why the run cannot
 * read one. `label` names the field being resolved — "browser valueHandle",
 * say — and opens every message, so a refusal says which position failed.
 *
 * Every failure is stated in terms of the reference, never the referent: a
 * value that is absent, of the wrong type, or in another space is reported as
 * such without any part of it being rendered. Only a `string` resolves; a
 * number or an object is refused rather than stringified, because a coerced
 * rendering is the value by another name.
 *
 * What a caller does with the value afterwards is its own problem: nothing
 * here keeps a materialized value from returning through whatever the tool
 * later reads. A page holds what was typed into it, so a snapshot of that page
 * carries it back. Governing that is the labels' job on the read side, and it
 * is not yet wired.
 */
export const resolveHandleValue = async (
  context: HandleValueResolutionContext,
  handle: string,
  label: string,
  options: { capability?: HarnessHandleCapability } = {},
): Promise<HandleValueResolution> => {
  const trimmed = handle.trim();
  if (trimmed === "") {
    return { error: `${label} requires a handle naming a value` };
  }
  if (trimmed.startsWith(REFERENT_HANDLE_TOKEN_PREFIX)) {
    return {
      error: `${label} takes an address handle (cfh:a:), not a referent`,
    };
  }
  if (context.getFabricSession === undefined) {
    return {
      error:
        `${label} requires a fabric session to resolve a handle, and this run has none`,
    };
  }
  const isToken = trimmed.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX);
  if (!isToken && handleRefAddressKey(trimmed) === undefined) {
    return { error: `${label} does not name a reference this run holds` };
  }
  // Both spellings go through the table, and for the same reason: what
  // reaches a tool is an address either way, so holding the handle is the
  // only thing that distinguishes a delegated reference from a composed one.
  const entry = context.handleTable === undefined
    ? undefined
    : (isToken
      ? resolveHandleToken(context.handleTable, trimmed)
      : resolveHandleRef(context.handleTable, trimmed));
  if (entry === undefined) {
    return { error: `${label} does not name a handle this run holds` };
  }
  if (
    entry.capability === "skill-context" &&
    options.capability !== "skill-context"
  ) {
    return {
      error:
        `${label} cannot consume a skill-context handle; only delegate_task skillHandle can`,
    };
  }
  const ref = entry.ref;
  let pieces;
  try {
    pieces = (await context.getFabricSession()).pieces;
  } catch (error) {
    return {
      error: `${label} could not establish the fabric session: ${
        errorMessage(error)
      }`,
    };
  }
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return { error: `${label} does not name a reference this run holds` };
  }
  if (link.space !== space) {
    return {
      error: `${label} can only read a reference in this run's own space`,
    };
  }
  // The link came out of the parser and names this run's own space, so it is
  // a well-formed full link and constructing a cell over it cannot fail.
  const cell = pieces.runtime.getCellFromLink({ ...link, schema: undefined });
  try {
    await cell.sync();
  } catch (error) {
    return {
      error: `${label} could not load the referenced value: ${
        errorMessage(error)
      }`,
    };
  }
  // `get()` reads through the schema, so a required value that never
  // materialized throws here rather than at `sync()`. That is an ordinary
  // outcome for a reference into a space still settling, and it belongs in
  // the refusal channel like every other way a read can fail.
  let value;
  try {
    value = cell.get();
  } catch (error) {
    return {
      error: `${label} could not read the referenced value: ${
        errorMessage(error)
      }`,
    };
  }
  if (value === undefined) {
    return { error: `${label} names an address that holds nothing` };
  }
  if (typeof value !== "string") {
    return {
      error:
        `${label} must name a string value; the reference holds a value of type ${typeof value}`,
    };
  }
  return { value };
};

/**
 * The string a child's structured return sealed behind the referent token
 * `handle`, with the label the child found it under, or an explanation of why
 * the run cannot read one. `label` names the field being resolved and opens
 * every message, which, as {@link resolveHandleValue}'s do, never render the
 * referent.
 */
export const resolveReturnReferent = (
  context: Pick<
    HandleValueResolutionContext,
    "handleTable" | "cfcReadMaxConfidentiality"
  >,
  handle: string,
  label: string,
): ReturnReferentResolution => {
  const referent = context.handleTable === undefined
    ? undefined
    : resolveReferentToken(context.handleTable, handle.trim());
  if (referent === undefined) {
    return { error: `${label} does not name a handle this run holds` };
  }
  if (referent.kind !== "return") {
    return {
      error:
        `${label} can only take a referent a child's return sealed; this one holds a ${referent.kind}`,
    };
  }
  if (typeof referent.value !== "string") {
    return {
      error:
        `${label} must name a string value; the referent holds a value of type ${typeof referent
          .value}`,
    };
  }
  // The child that found the value labeled it; a run whose ceiling it is
  // above may not observe it, and so may not send it anywhere either.
  if (
    !cfcObservationFitsCeiling(
      referent.label.confidentiality ?? [],
      context.cfcReadMaxConfidentiality,
    )
  ) {
    return {
      error: `${label} names a value labeled above this run's read ceiling`,
    };
  }
  return { value: referent.value, label: referent.label };
};
