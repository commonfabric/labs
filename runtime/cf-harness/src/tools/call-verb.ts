/**
 * `call_verb` sends an event to a verb of a piece the run holds: the one way
 * a pattern changes its own state, reached from a model the way
 * `cf piece call` reaches it from a shell.
 *
 * The verb is found, and its event judged, by the same code `cf piece call`
 * uses — the listing in `@commonfabric/piece/verb-listing` and the gate in
 * `@commonfabric/piece/verb-input` — so a call the command line refuses is
 * refused here too, in the same words, and a refused call sends nothing.
 * `describe_handle` lists the verbs a piece handle has from that same listing,
 * which is where a model learns what to call.
 *
 * The handler runs in the run's own runtime, against the session's space. What
 * it returns comes back the way a `run_pattern` result does: measured against
 * the release ceiling first, then reduced to what the verb's declared result
 * can release as itself, with every other position handed back as a reference
 * into the handling's receipt.
 */

import type { JSONSchema } from "@commonfabric/api";
import { callVerb } from "@commonfabric/piece/verb-call";
import { isLink } from "@commonfabric/runner";
import { describeSinkReleaseRefusal } from "@commonfabric/runner/cfc";
import { localRefTarget } from "@commonfabric/runner/cfc/schema-sanitization";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HANDLE_TOKEN_PATTERN,
  REFERENT_TOKEN_PATTERN,
} from "../contracts/handle-table.ts";
import { handleRefAddressKey, resolveHandleRef } from "../handle-table.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { errorMessage } from "../error-message.ts";
import { scrubBareFabricIdentifiers } from "../fabric-identifier-scrub.ts";
import { schemaShapeOnly } from "../schema-shape.ts";
import {
  addressSealedPositions,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import { resolvePiece, sessionPieces } from "./piece-source.ts";
import { asSerializableValue, sealedPositionLink } from "./run-pattern.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface CallVerbToolInput {
  token: string;
  verb: string;
  event?: unknown;
}

export interface CallVerbToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The verb that ran, echoed so a reply stands on its own. */
  verb: string;

  /**
   * What the verb returned, as far as its declared result releases it: a
   * number, a boolean or a null comes back as itself, and every other
   * position as a reference into {@link resultRef}. Absent when the verb
   * returns nothing, or when the release boundary withheld it.
   */
  result?: unknown;

  /**
   * The handling's receipt, where the verb's result is stored. Absent when
   * the runtime wrote no receipt.
   */
  resultRef?: string;

  /** Why {@link result} is absent although the verb returned one. */
  message?: string;
}

export interface CallVerbToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type CallVerbToolOutput =
  | CallVerbToolSuccessOutput
  | CallVerbToolErrorOutput;

/** The sink a verb's result is released to, named in a release refusal. */
const CALL_VERB_ANSWER_SINK = "call_verb";

export const callVerbToolDescriptor: HarnessToolDescriptor = {
  toolId: "call_verb",
  title: "Call Verb",
  description:
    "Send an event to a named verb of the piece behind a handle token, running its handler; returns the verb's result, with values that are not numbers, booleans or nulls as handle or reference tokens. The piece may be in this run's space or one admitted to it.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "The piece's cfh:a: handle token.",
      },
      verb: {
        type: "string",
        description: "The verb's name, as describe_handle lists it.",
      },
      event: {
        description: "Omit for a verb that takes none.",
      },
    },
    required: ["token", "verb"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      verb: { type: "string" },
      result: {},
      resultRef: { type: "string" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["fabric", "piece", "verb"],
};

/**
 * Why `event` names a piece this run holds no handle to, or `undefined` when
 * it names none. A string that is a whole handle token arrived unswapped, so
 * the table does not hold it; a string that is an address is held only if the
 * table holds that address; and a link written out as JSON is refused, since a
 * reference reaches a verb from a model only as a handle. Nothing here repeats
 * the address it refuses.
 */
const firstUnheldReference = (
  event: unknown,
  holds: (address: string) => boolean,
  path = "<event>",
): string | undefined => {
  if (typeof event === "string") {
    const whole = (pattern: RegExp) =>
      new RegExp(`^${pattern.source}$`).test(event);
    if (whole(HANDLE_TOKEN_PATTERN) || whole(REFERENT_TOKEN_PATTERN)) {
      return `${event} at ${path} is not a handle this run holds`;
    }
    return handleRefAddressKey(event) !== undefined && !holds(event)
      ? `${path} names a piece this run holds no handle to; pass its cfh:a: token`
      : undefined;
  }
  if (isLink(event)) {
    return `${path} is a link written out in full; pass the piece's cfh:a: token instead`;
  }
  if (Array.isArray(event)) {
    for (const [index, element] of event.entries()) {
      const found = firstUnheldReference(element, holds, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObjectNotArray(event)) {
    for (const [key, value] of Object.entries(event)) {
      const found = firstUnheldReference(value, holds, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** The schema the result sanitizer keeps a `{"@link": …}` object under. */
const OPAQUE_LINK_SCHEMA = {
  type: "object",
  properties: { "@link": { type: "string" } },
  required: ["@link"],
  additionalProperties: false,
} as const satisfies JSONSchema;

/**
 * Every path within a receipt's stored value at which it holds a link rather
 * than a value: the positions where the verb returned a reference to another
 * cell, a piece it created or was handed among them.
 */
export const storedLinkPaths = (
  raw: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[][] => {
  if (isLink(raw)) return [[...path]];
  if (Array.isArray(raw)) {
    return raw.flatMap((element, index) =>
      storedLinkPaths(element, [...path, index])
    );
  }
  if (isObjectNotArray(raw)) {
    return Object.entries(raw).flatMap(([key, child]) =>
      storedLinkPaths(child, [...path, key])
    );
  }
  return [];
};

/** `value` with `replacement` at `path`, or `value` itself where the path
 * does not reach. Copies only the containers along the path. */
export const replacedAt = (
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): unknown => {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number" && head < value.length) {
    const copy = [...value];
    copy[head] = replacedAt(value[head], rest, replacement);
    return copy;
  }
  if (isObjectNotArray(value) && Object.hasOwn(value, String(head))) {
    return {
      ...value,
      [head]: replacedAt(value[String(head)], rest, replacement),
    };
  }
  return value;
};

/** The keywords whose members a value is judged against as well. */
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * Whether `schema` declares the step `head` of a path — a property of that
 * name, any property through `additionalProperties`, or an array element —
 * itself or in any member of a combinator. `root` is the document local
 * references resolve against.
 */
const declaresStep = (
  schema: JSONSchema,
  root: JSONSchema,
  head: string | number,
): boolean => {
  const node = localRefTarget(schema, root);
  if (!isObjectNotArray(node)) return false;
  const declaredByMember = COMBINATORS.some((key) => {
    const members = node[key];
    return Array.isArray(members) &&
      members.some((member) => declaresStep(member as JSONSchema, root, head));
  });
  if (declaredByMember) return true;
  if (typeof head === "number") return node.items !== undefined;
  return (isObjectNotArray(node.properties) &&
    Object.hasOwn(node.properties, head)) ||
    isObjectNotArray(node.additionalProperties);
};

/**
 * `schema` declaring an opaque link at `path`, so the result sanitizer keeps
 * the `{"@link": …}` object a reference is handed back as instead of judging
 * it against the shape of what it points at. An array's elements share one
 * schema, so an element position admits the link beside what it already
 * admitted. A position declared inside a combinator is rewritten in every
 * member that declares it, so a union whose branch holds the reference admits
 * it there. `root` is the document local references resolve against.
 */
const withOpaqueLinkAt = (
  schema: JSONSchema,
  root: JSONSchema,
  path: readonly (string | number)[],
): JSONSchema => {
  if (path.length === 0) return OPAQUE_LINK_SCHEMA;
  const node = localRefTarget(schema, root);
  if (!isObjectNotArray(node)) return schema;
  const [head, ...rest] = path;
  const rewritten: Record<string, unknown> = { ...node };
  let hasMembers = false;
  for (const key of COMBINATORS) {
    const members = node[key];
    if (!Array.isArray(members)) continue;
    hasMembers = true;
    rewritten[key] = members.map((member) =>
      declaresStep(member as JSONSchema, root, head)
        ? withOpaqueLinkAt(member as JSONSchema, root, path)
        : member
    );
  }
  if (typeof head === "number") {
    const items = node.items as JSONSchema | undefined;
    if (items !== undefined) {
      const element = withOpaqueLinkAt(items, root, rest);
      rewritten.items = rest.length === 0
        ? { anyOf: [items, element] }
        : element;
    }
    return rewritten as JSONSchema;
  }
  const properties = isObjectNotArray(node.properties)
    ? node.properties as Record<string, JSONSchema>
    : {};
  const additional = isObjectNotArray(node.additionalProperties)
    ? node.additionalProperties as JSONSchema
    : undefined;
  // A position only a combinator member declares is left to that member: a
  // property added here would hold every branch to it. One the schema closes
  // and does not declare stays closed, so the declared result still refuses
  // a value there.
  const closed = node.additionalProperties === false;
  if (
    Object.hasOwn(properties, head) || additional !== undefined ||
    (!hasMembers && !closed)
  ) {
    rewritten.properties = {
      ...properties,
      [head]: withOpaqueLinkAt(
        properties[head] ?? additional ?? {},
        root,
        rest,
      ),
    };
  }
  return rewritten as JSONSchema;
};

export const callVerbTool: HarnessToolDefinition<
  CallVerbToolInput,
  CallVerbToolOutput
> = {
  descriptor: callVerbToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("call_verb");
    const fail = (message: string): CallVerbToolErrorOutput => ({
      outputId,
      status: "error",
      message: scrubBareFabricIdentifiers(message),
    });
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return fail("call_verb requires a token naming a piece");
    }
    const name = typeof input.verb === "string" ? input.verb.trim() : "";
    if (name.length === 0) {
      return fail("call_verb requires the name of a verb");
    }
    // This tool writes, so it reaches only what the run was handed: the piece
    // and every piece the event names must be behind a handle the run holds.
    // A held token reached this tool as the address it stands for; one the
    // model wrote out in full is held only if the table holds that address.
    // A refusal never repeats the address, which the outbound swap would
    // otherwise mint a handle for.
    const table = context.handleTable;
    const holds = (address: string): boolean => {
      const entry = table === undefined
        ? undefined
        : resolveHandleRef(table, address);
      return entry !== undefined && entry.capability === undefined;
    };
    if (!holds(ref)) {
      return fail(
        "call_verb can only reach a piece behind a handle this run holds; pass the cfh:a: token run_pattern, resolve_piece, a verb's result or an input gave you",
      );
    }
    const unheld = firstUnheldReference(input.event, holds);
    if (unheld !== undefined) {
      return fail(
        `the event for "${name}" was refused before it was sent: ${unheld}`,
      );
    }

    const session = await sessionPieces("call_verb", context);
    if (!session.ok) return fail(session.message);
    const { pieces } = session;
    // Anything the run reaches through the pieces it was given is in its
    // scope. A space reaches the session only by being admitted to it, so a
    // piece in another space is callable wherever that space is admitted.
    const piece = await resolvePiece(
      "call_verb",
      pieces,
      ref,
      (space) => Object.hasOwn(session.foreignSpaces, space),
    );
    if (!piece.ok) return fail(piece.message);

    // Awaited to its settlement rather than raced with the run's abort: a
    // handler that commits after the tool had answered "cancelled" would be
    // a write the run reported as not made.
    const { runtime } = pieces;
    const called = await callVerb(
      runtime,
      piece.cell.getAsNormalizedFullLink(),
      name,
      input.event,
    );
    // SHORTCUT (2026-10-12): a failing handler's message, its thrown text
    // included, reaches the model as written. A handler over data the model
    // cannot read may carry that data in what it throws, and a pattern's
    // author can write instructions there. To harden, measure the failure
    // against the release ceiling as the result below is, and withhold it
    // where the ceiling refuses it.
    if (called.status !== "settled") return fail(called.message);

    const receipt = called.receipt;
    if (receipt === undefined) return { outputId, status: "ok", verb: name };
    const space = pieces.getSpace();
    const resultRef = createLLMFriendlyLink(receipt, space);

    // The receipt is read through a transaction of its own, so what it read
    // is exactly what the ceiling is measured against, and the transaction is
    // abandoned once it has been measured.
    const unreadable = (why: string): CallVerbToolSuccessOutput => ({
      outputId,
      status: "ok",
      verb: name,
      resultRef,
      message: scrubBareFabricIdentifiers(
        `the verb ran, and its result could not be returned: ${why}`,
      ),
    });
    if (called.unread !== undefined) return unreadable(called.unread);
    const releaseTx = runtime.edit();
    let raw: unknown;
    let value: unknown;
    let withheld: boolean;
    try {
      const measured = runtime.getCellFromLink(receipt).withTx(releaseTx);
      await measured.pull();
      raw = measured.getRaw();
      value = asSerializableValue(measured.get());
      const releaseGateRejects = runtime.cfcEnforcementMode !== "disabled" &&
        runtime.cfcEnforcementMode !== "observe";
      withheld = releaseGateRejects &&
        describeSinkReleaseRefusal(
            releaseTx,
            releaseTx,
            CALL_VERB_ANSWER_SINK,
            [],
          ) !== undefined;
    } catch (error) {
      return unreadable(errorMessage(error));
    } finally {
      releaseTx.abort("call_verb release measurement");
    }
    if (value === undefined || called.result === undefined) {
      return { outputId, status: "ok", verb: name, resultRef };
    }
    if (withheld) {
      return {
        outputId,
        status: "ok",
        verb: name,
        resultRef,
        message:
          "the verb's result was withheld: what it carries is above the run's release ceiling",
      };
    }
    try {
      // The declared result reduced to structure decides what releases as
      // itself, so a string comes back as a reference however the author
      // constrained it. A position the receipt stores as a link is a
      // reference the verb returned, and goes back as the address of what it
      // points at — the piece a verb created comes back as that piece's
      // handle, not as a copy of its fields.
      const declared = schemaShapeOnly(called.outputSchema ?? {});
      let shaped = declared;
      for (const path of storedLinkPaths(raw)) {
        const target = runtime.getCellFromLink({
          ...receipt,
          path: [...receipt.path, ...path.map(String)],
        }).resolveAsCell().getAsNormalizedFullLink();
        value = replacedAt(value, path, {
          "@link": createLLMFriendlyLink(target, space),
        });
        shaped = withOpaqueLinkAt(shaped, declared, path);
      }
      if (isObjectNotArray(declared) && declared.$defs !== undefined) {
        shaped = { ...(shaped as object), $defs: declared.$defs } as JSONSchema;
      }
      const sanitized = validateAndSanitizeStructuredResult({
        schema: shaped,
        value,
        opaqueHandleId: outputId,
      });
      return {
        outputId,
        status: "ok",
        verb: name,
        result: addressSealedPositions(
          sanitized.value,
          sanitized.sealedPaths,
          (path) => sealedPositionLink(receipt, path, space),
        ),
        resultRef,
      };
    } catch (error) {
      return unreadable(errorMessage(error));
    }
  },
};
