/**
 * The pre-dispatch gate on a verb's event: what a payload must satisfy before
 * it is sent, judged against the verb's event schema. A payload refused here
 * was never dispatched, so nothing ran and nothing was written.
 *
 * `cf piece call` and the harness's `call_verb` both judge a payload through
 * {@link verbInputSchemaError}, so a call one refuses the other refuses too,
 * with the same words.
 */

import type { JSONSchema } from "@commonfabric/api";
import { isDID } from "@commonfabric/identity/did";
import { isLink } from "@commonfabric/runner";
import { cfcSchemaResolvedRoot } from "@commonfabric/runner/cfc/schema-refs";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "@commonfabric/runner/cfc/schema-sanitization";
import {
  isPieceHandle,
  linkPathSegmentToCellPathSegment,
  parseCellReference,
} from "@commonfabric/runner/shared";
import { isSlugAddress } from "@commonfabric/runner/slugs";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  declaredFieldNames,
  declaredFieldsAt,
  isSchemaObject,
  schemaIsArrayShaped,
  schemaIsObjectShaped,
} from "./declared-fields.ts";
import { EVENT_ROOT_POSITION, nearestName } from "./refusal.ts";

// `localRefTarget` and `relaxDefaultedRequired` live beside the runtime's
// own validator (`@commonfabric/runner/cfc/schema-sanitization`), so this
// gate and the server-side closed-world enforcement (C5) share one
// implementation of "what does a default satisfy" instead of drifting apart.

/**
 * Normalize an absent payload to `{}` where the verb's event schema — after
 * resolving a top-level local `$ref` (a stream's schema is often
 * `{ $ref: "#/$defs/X", asCell: ["stream"], $defs: {...} }`) — is an object
 * schema: directly object-shaped, or an `allOf` conjunction with an
 * object-schema branch (see `schemaIsObjectShaped`; `anyOf`/`oneOf` roots
 * stay untouched). Everything else passes through untouched: schema
 * `undefined` / `true`, boolean `false` (an absent payload must pass; a
 * supplied one is already refused), non-object schemas, and an unresolvable
 * `$ref` (fail-open on uncertainty — refuse only on proof).
 *
 * Why `{}` rather than refusing absence outright (settled 2026-07-30,
 * measured on #5147): the runtime materializes a property's `default` only
 * for a PRESENT object payload — a wholly absent event bypasses default
 * materialization entirely, the handler sees `undefined`, and the receipt
 * still spends the invocation id. Normalizing lets absence flow through the
 * same gate as any payload: `{}` fails the relaxed schema exactly when
 * top-level `required` survives `relaxDefaultedRequired` (refusal, id never
 * spent), and dispatching `{}` where every required property carries a
 * default makes the runtime fill those defaults in — where an absent event
 * would have delivered nothing.
 */
export function normalizeAbsentVerbPayload(
  input: unknown,
  schema: JSONSchema | undefined,
): unknown {
  if (input !== undefined) return input;
  if (!isSchemaObject(schema)) return input;
  const target = localRefTarget(schema, schema);
  if (!isSchemaObject(target)) return input;
  if (!schemaIsObjectShaped(target, schema)) return input;
  return {};
}

/** A field a payload carries at a position whose schema does not declare it,
 * with what that position does declare. */
interface UndeclaredEventField {
  key: string;
  position: string;
  declared: string[];
}

/**
 * Whether `value` is a link this gate may treat as opaque.
 *
 * `isLink` answers on the envelope's SHAPE — a `/` carrying a `link@1` — and
 * says nothing about what rides inside it, so it is true of
 * `{"/": {"link@1": "nope"}}`, of an array, and of `null`. Bypassing both
 * checks on that answer would let malformed data through as a reference and
 * normalize to an empty relative link rather than being refused or judged as
 * the ordinary object it is.
 *
 * A plain record is the line, and it is where the real forms fall: a full
 * address, an id alone, and a relative link carrying only a path are all
 * records, while every malformed spelling above is not. Requiring an `id`
 * would be tighter and wrong — a relative link legitimately has none.
 *
 * Only the envelope form is narrowed. Every other thing `isLink` recognizes —
 * a live `Cell`, a primitive link — is already a value rather than a caller's
 * JSON, and has no payload to malform.
 */
function isOpaqueReference(value: unknown): boolean {
  if (!isLink(value)) return false;
  const payload = (value as Record<string, Record<string, unknown>> | null)
    ?.["/"]?.["link@1"];
  // No payload here means this is not the envelope form at all — a live cell,
  // which reaches this gate from code rather than from a caller's JSON and has
  // nothing to malform. Every link a PAYLOAD can carry is the envelope form,
  // since the primitive spelling is that same sigil.
  if (payload === undefined) return true;
  return isObjectNotArray(payload);
}

/** Whether a schema node marks its position as a cell or a stream, which is
 * where a caller may write a link in place of a value. */
function carriesCellMarker(node: Record<string, unknown>): boolean {
  return node.asCell !== undefined || node.asStream !== undefined;
}

/**
 * The first field the payload carries that the schema at its position does not
 * declare, walking the PAYLOAD (finite JSON the caller supplied, so the walk
 * terminates on its own) and consulting the schema beside it.
 *
 * Whether a position describes the object a payload holds there is
 * {@link schemaIsObjectShaped}'s question, asked here rather than answered
 * again: a stated `type: "object"`, a `properties` map with no type beside it,
 * a type union admitting an object, and a conjunction with an object-shaped
 * member all describe one. Every one of them drops what it does not name, so
 * every one of them is judged.
 *
 * Three positions are passed over, each because the schema stops proving what
 * the runtime will do with what sits under it:
 *
 * - a disjunction (`anyOf`/`oneOf`), here or inside a conjunction, where a
 *   payload need satisfy only one branch and a field missing from the branch
 *   this walk inspected may be named by another. Choosing among branches is
 *   the caller's, not this gate's;
 * - a position marked `asCell`/`asStream` below the root, where the value may
 *   be a link (whose `"/"` is not a field anybody declared) and an inline value
 *   is carried across the boundary rather than filtered at dispatch. The ROOT's
 *   own marker is ignored, because the stream marker is what makes the schema a
 *   verb's in the first place and the payload under it is the event;
 * - a position describing neither the object nor the array the payload holds
 *   there.
 *
 * A key several members of a conjunction constrain is passed over too, one
 * level down: the walk cannot say which member's schema governs beneath it.
 *
 * Every one of them fails open. A refusal spends nothing and can be retried,
 * but a call this gate wrongly refuses cannot be made at all, so the direction
 * to be wrong in is the permissive one.
 */
function firstUndeclaredEventField(
  value: unknown,
  schema: JSONSchema | undefined,
  root: JSONSchema,
  position: string,
  atRoot: boolean,
): UndeclaredEventField | undefined {
  if (!isObjectOrArray(value)) return undefined;
  // A link is not an object whose fields can be judged. Its `/` key is the
  // envelope's own structure, not a name the caller chose, and the document it
  // points at is not read at dispatch — so there is nothing here to compare a
  // declaration against. Descending anyway reported `/` as an undeclared field
  // and refused every reference a caller named.
  if (isOpaqueReference(value)) return undefined;
  if (!isSchemaObject(schema)) return undefined;
  if (!atRoot && carriesCellMarker(schema)) return undefined;
  const scopeRoot = root;
  const node = localRefTarget(schema, scopeRoot);
  if (!isSchemaObject(node)) return undefined;
  if (!atRoot && carriesCellMarker(node)) return undefined;
  if (node.anyOf !== undefined || node.oneOf !== undefined) return undefined;
  const nodeRoot = node !== schema
    ? cfcSchemaResolvedRoot(node, scopeRoot)
    : scopeRoot;

  if (Array.isArray(value)) {
    if (!schemaIsArrayShaped(node)) return undefined;
    const prefixItems = Array.isArray(node.prefixItems)
      ? node.prefixItems as JSONSchema[]
      : undefined;
    for (let index = 0; index < value.length; index++) {
      const child = prefixItems !== undefined && index < prefixItems.length
        ? prefixItems[index]
        : node.items as JSONSchema | undefined;
      const found = firstUndeclaredEventField(
        value[index],
        child,
        nodeRoot,
        `${position}[${index}]`,
        false,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (!schemaIsObjectShaped(node, nodeRoot)) return undefined;
  const declared = declaredFieldsAt(node, nodeRoot);
  if (declared.sources.length === 0) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const declaringSources = (key: string) =>
    declared.sources.filter((source) => Object.hasOwn(source.properties, key));
  if (!declared.honorsUndeclared) {
    for (const [key] of entries) {
      if (declaringSources(key).length === 0) {
        return {
          key,
          position,
          declared: declaredFieldNames(declared.sources),
        };
      }
    }
  }
  for (const [key, child] of entries) {
    const matches = declaringSources(key);
    const childSchema = matches.length === 1
      ? matches[0].properties[key]
      : matches.length === 0
      ? node.additionalProperties as JSONSchema | undefined
      : undefined;
    const found = firstUndeclaredEventField(
      child,
      childSchema,
      matches.length === 1 ? matches[0].root : nodeRoot,
      `${position}.${key}`,
      false,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Refuse a payload carrying a field the verb does not declare, naming the
 * field, the position it sat at, the vocabulary that position takes, and the
 * declared name it is one edit from.
 *
 * The comparison needs no source of truth beyond the schema already in hand:
 * the verb's event schema names exactly the fields the verb declares. What it
 * adds is treating an undeclared one as a reason to refuse, which nothing else
 * on this path does — the runtime's own read drops the field and delivers the
 * rest, so the handler runs, the receipt is written, and the caller is told the
 * call settled with a field it wrote never having arrived. A TypeScript author
 * never meets that; a caller writing JSON by hand or by model meets it first.
 *
 * Which positions drop, measured against the read a handler's event goes
 * through (`SchemaObjectTraverser.#traverseObjectWithSchema`, runner
 * traverse.ts, whose `addOptionalProperty` is a no-op on the
 * `validateAndTransform` path), for an object holding one declared and one
 * undeclared field:
 *
 * | The schema at a position | What the handler receives |
 * | --- | --- |
 * | `{type: "object"}` | both fields |
 * | `{type: "object", properties: {declared}}` | the declared field |
 * | `{type: ["object", "null"], properties: {declared}}` | the declared field |
 * | `{allOf: [{type: "object", properties: {declared}}]}` | the declared field |
 * | `{properties: {declared}}` | nothing |
 * | `{type: "object", properties: {}}` | nothing |
 * | `{anyOf: [...]}` | both fields |
 * | any of those plus `additionalProperties` | both fields |
 *
 * So a position with no property map is open by construction and refuses
 * nothing — a verb declaring no fields THAT way takes anything. Every position
 * that has one drops what none of its maps name, whether or not it also states
 * a type and whether it reaches the map directly or through a conjunction.
 *
 * The two rows delivering NOTHING are two readings of "declares no fields", and
 * both refuse every field written there. A bare `properties` map drops the
 * fields it declares as well, which is a defect of its own and not one a gate
 * over undeclared fields can speak to.
 *
 * @internal Exported for the tests that pin the refusal's wording.
 */
export function undeclaredVerbFieldError(
  input: unknown,
  schema: JSONSchema | undefined,
): string | undefined {
  if (schema === undefined || schema === true) return undefined;
  const found = firstUndeclaredEventField(
    input,
    schema,
    schema,
    EVENT_ROOT_POSITION,
    true,
  );
  if (found === undefined) return undefined;
  const nearest = nearestName(found.key, found.declared);
  return `"${found.key}" at ${found.position} is not a field this verb ` +
    "declares. " +
    (nearest === undefined ? "" : `Did you mean "${nearest}"? `) +
    (found.declared.length === 0
      ? `${found.position} declares no fields at all`
      : `${found.position} takes ${
        found.declared.map((key) => `"${key}"`).join(", ")
      }`);
}

/**
 * Reject a payload that cannot satisfy the verb's event schema, before it is
 * sent.
 *
 * Pre-dispatch is the only place this can be caught. The runner does not
 * reject a mismatched payload: `generateHandlerSchema` puts the event under
 * `$event` and requires only `$ctx`, so a payload that fails the event schema
 * reads back as `undefined` rather than making the argument invalid — the
 * handler body then runs with no event, writes its receipt, and the invocation
 * reports settled. Refusing here keeps that from consuming the idempotency
 * key: an id that was never dispatched is still spendable by the corrected
 * retry.
 *
 * An absent payload reaches this function only after
 * `normalizeAbsentVerbPayload`: against an object schema it arrives as `{}`
 * and is judged like any supplied payload; against everything else it stays
 * `undefined` and passes — `$event` is genuinely optional in the generated
 * handler schema, and value-less verbs are a supported shape.
 *
 * A field the verb does not declare is judged FIRST, ahead of the schema
 * validation. Both can hold at once — a misspelled required field is missing
 * and undeclared in one stroke — and of the two answers only one names
 * something the caller actually wrote. "`titel` is not a field, did you mean
 * `title`" sends them to the character they typed; "`title` is missing" sends
 * them looking for a field that is already there.
 */
export function verbInputSchemaError(
  input: unknown,
  schema: JSONSchema | undefined,
): string | undefined {
  if (input === undefined) return undefined;
  if (schema === undefined || schema === true) return undefined;
  const undeclared = undeclaredVerbFieldError(input, schema);
  if (undeclared !== undefined) return undeclared;
  // The option the dispatch gate has always passed
  // (`closedWorldEventRejection`, packages/runner/src/runner.ts). Without it
  // this validator measures the envelope against the schema of the value it
  // points at, which no link can satisfy. Passing it is what stops the two
  // gates disagreeing about one payload — the CLI refusing what the runtime
  // would have accepted and dispatched.
  const relaxed = relaxDefaultedRequired(schema, schema, new Map());
  return validateSchemaValue(relaxed, input, relaxed, {
    acceptOpaqueValue: (value) => isOpaqueReference(value),
  });
}

/** The key a caller writes beside `properties` to ask for an address. */
export const LINK_MARKER_KEY = "$link";

/**
 * The link an address written at a reference position names, or `undefined`
 * when the string is not one: the canonical reference form, naming its piece
 * by handle and any space by DID, and selecting no member.
 *
 * A slug and a space name are refused as firmly as a non-address is. The
 * link this becomes is stored, holding the id and the space verbatim with no
 * session behind it to resolve a name with — so the wider vocabulary `cf`'s
 * own intake takes would land a durable edge pointing at nothing.
 */
function addressedLink(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  let parsed;
  try {
    parsed = parseCellReference(trimmed);
  } catch {
    return undefined;
  }
  if (
    parsed.member === "argument" || isSlugAddress(parsed.id) ||
    !isPieceHandle(parsed.id) ||
    (parsed.space !== undefined && !isDID(parsed.space))
  ) {
    return undefined;
  }
  const path = parsed.path.map(linkPathSegmentToCellPathSegment);
  return {
    id: parsed.id,
    ...(parsed.space !== undefined && { space: parsed.space }),
    ...(parsed.scope !== undefined && { scope: parsed.scope }),
    ...(path.length > 0 && { path }),
  };
}

/**
 * The address inside the `{"$link": "/of:…"}` object a marked read renders
 * (`composeLinkAddresses`, `packages/cli/lib/cell-selection.ts`), whether the
 * address stands alone there or the contents the same read projected sit
 * beside it. `undefined` for every other value, a `$link` holding no string
 * included: `{"$link": true}` is the projection-schema marker, not an
 * address.
 */
function printedAddressOf(value: unknown): string | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const address = (value as Record<string, unknown>)[LINK_MARKER_KEY];
  return typeof address === "string" ? address : undefined;
}

/**
 * The round-trip spelling, resolved where the contract declares a reference:
 * at a position whose schema carries a cell marker — which the DECLARED
 * event schema keeps and a link-derived dispatch schema does not, see
 * `CallableResolution.declaredEvent` in `packages/cli/lib/callable.ts` — a
 * string holding the address a read emits (`/of:…`, the canonical fabric
 * reference) converts to the link envelope dispatch already accepts. So does
 * the `{"$link": "/of:…"}` object a marked read renders that address in, alone
 * or joined by the contents the same read projected: the address inside is
 * what the position takes, and the contents beside it are the target's own
 * fields, which a reference never stores.
 * An address printed by one command is now a verb argument in the next,
 * which is the property the CLI surface states for commands, one level in.
 *
 * The same positions refuse the two payloads that could only ever be
 * mistakes there. A string that is NOT an address is refused naming what
 * the position takes — silence would leave it to schema validation, whose
 * "does not match type object" says nothing about references. And a plain
 * object is refused outright: a shape-matching copy at a reference position
 * stores a DETACHED DOCUMENT inside the caller's own piece and reports
 * success (#5560), which no caller has ever meant. Both refusals spend
 * nothing; the corruption they prevent is durable.
 *
 * The walk descends the payload beside the schema exactly as the
 * undeclared-field gate does — objects by `properties`, arrays by `items`
 * and `prefixItems`, conjunctions member-wise, local `$ref`s through
 * `localRefTarget` against the document root threaded beside — and passes
 * over disjunction interiors, where choosing a branch is the caller's.
 * Everything it does not recognize flows through untouched.
 */
export function resolveEmittedAddressArguments(
  value: unknown,
  schema: JSONSchema | undefined,
  scopeRoot?: JSONSchema,
  path = "<event>",
  atRoot = true,
): { value: unknown; refusal?: string } {
  if (!isSchemaObject(schema)) return { value };
  const root = scopeRoot ?? schema;
  const node = localRefTarget(schema, root);
  if (!isSchemaObject(node)) return { value };
  const nodeRoot = node !== schema ? cfcSchemaResolvedRoot(node, root) : root;

  // The marker rides the `$ref` SITE (`{$ref: …, asCell: […]}`), where the
  // authored cell wrapper was declared, so the pre-resolution node is
  // checked as well as the target.
  if (!atRoot && (carriesCellMarker(schema) || carriesCellMarker(node))) {
    const spelled = printedAddressOf(value) ?? value;
    if (typeof spelled === "string") {
      const link = addressedLink(spelled);
      if (link === undefined) {
        return {
          value,
          refusal:
            `${JSON.stringify(spelled)} at ${path} is not an address — ` +
            `the position declares a reference, and takes the /of:… form ` +
            `a read prints`,
        };
      }
      return { value: { "/": { "link@1": link } } };
    }
    if (isObjectNotArray(value) && !isOpaqueReference(value)) {
      return {
        value,
        refusal: `${path} declares a reference, and an inline copy would ` +
          `store a detached document rather than an edge — send the ` +
          `address a read printed`,
      };
    }
    return { value };
  }

  if (node.anyOf !== undefined || node.oneOf !== undefined) return { value };

  if (Array.isArray(node.allOf)) {
    let current = value;
    for (const member of node.allOf) {
      const resolved = resolveEmittedAddressArguments(
        current,
        member as JSONSchema,
        nodeRoot,
        path,
        atRoot,
      );
      if (resolved.refusal !== undefined) return resolved;
      current = resolved.value;
    }
    return { value: current };
  }

  if (isObjectNotArray(value)) {
    const properties = isObjectNotArray(node.properties)
      ? node.properties as Record<string, JSONSchema>
      : undefined;
    // A record schema declares its values on `additionalProperties` and names
    // no key at all, so a key absent from `properties` falls back to it — the
    // same fallback the undeclared-field walk makes. Without it a map of
    // references (`{additionalProperties: {asCell: […]}}`) converts nothing.
    const additional = isObjectNotArray(node.additionalProperties)
      ? node.additionalProperties as JSONSchema
      : undefined;
    if (!properties && !additional) return { value };
    let changed = false;
    const next: Record<string, unknown> = { ...value };
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties?.[key] ?? additional;
      if (childSchema === undefined) continue;
      const resolved = resolveEmittedAddressArguments(
        child,
        childSchema,
        nodeRoot,
        `${path}.${key}`,
        false,
      );
      if (resolved.refusal !== undefined) return resolved;
      if (resolved.value !== child) {
        next[key] = resolved.value;
        changed = true;
      }
    }
    return { value: changed ? next : value };
  }

  if (Array.isArray(value)) {
    const prefix = Array.isArray(node.prefixItems)
      ? node.prefixItems as JSONSchema[]
      : undefined;
    const items = isSchemaObject(node.items as JSONSchema | undefined)
      ? node.items as JSONSchema
      : undefined;
    let changed = false;
    const next: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const element = value[index];
      const childSchema = prefix?.[index] ?? items;
      if (childSchema === undefined) {
        next.push(element);
        continue;
      }
      const resolved = resolveEmittedAddressArguments(
        element,
        childSchema,
        nodeRoot,
        `${path}[${index}]`,
        false,
      );
      if (resolved.refusal !== undefined) return resolved;
      if (resolved.value !== element) changed = true;
      next.push(resolved.value);
    }
    return { value: changed ? next : value };
  }

  return { value };
}

/**
 * The shared pre-dispatch gate. Returns the event to dispatch — the caller's
 * own payload, or `{}` when an absent payload was normalized against an
 * object schema, or a payload whose emitted addresses were converted to link
 * envelopes — or the refusal saying why that event cannot satisfy the schema.
 * The absent-payload refusal says so explicitly: "send a payload" has to read
 * differently from "fix your payload".
 *
 * `schema` is the event schema the payload is judged against, and
 * `declaredEvent` the verb's declared event contract, consulted only where it
 * can change the answer — see below.
 */
export async function verbEventForDispatch(
  input: unknown,
  schema: JSONSchema | undefined,
  declaredEvent?: () => Promise<JSONSchema | undefined>,
): Promise<{ value: unknown } | { refusal: string }> {
  const normalized = normalizeAbsentVerbPayload(input, schema);
  const shapeError = verbInputSchemaError(normalized, schema);

  // The published schema cannot state the one thing that decides a reference
  // position: link sanitization keeps only stream markers, so `asCell` on a
  // declared reference never reaches the dispatch cell. Only the compiled
  // pattern still carries it (`declaredEvent`), and reaching it costs a
  // pattern load — so the question is when a load can change the answer.
  //
  // Sanitization strips the MARKER and keeps the SHAPE. A declared reference
  // is a `$ref` to the target's object schema, so it stays an object-shaped
  // position, and a string there is refused by the published schema before
  // this gate ever asks the contract. Two payloads therefore need the
  // contract and no others: one the published shape REFUSED (a string where
  // an object is declared — the emitted address, the case conversion exists
  // for), and one it ACCEPTED that carries an inline object below its root
  // (a shape-valid copy — the #5560 corruption, which validates precisely
  // because it matches the target's shape). Everything else — a flat payload
  // of scalars, an envelope the walk passes through — has no position whose
  // reading a contract could change, so it dispatches without a load.
  //
  // The residue this leaves is a reference whose target itself admits a
  // string, where the published schema accepts a bare string and no consult
  // happens. Converting there would be a guess about whether the caller
  // meant an address or a value, and declining is the safe half of it.
  if (shapeError === undefined && !carriesInlineObject(normalized)) {
    return { value: normalized };
  }

  // Against the contract, an emitted address string at a reference position
  // converts to the link envelope dispatch already accepts, and the two
  // payloads that could only ever be mistakes there are refused naming the
  // position: a string that is no address, and an inline copy that would
  // store a detached document rather than an edge (#5560).
  const contract = isObjectOrArray(normalized)
    ? await declaredEvent?.()
    : undefined;
  const addressed = resolveEmittedAddressArguments(normalized, contract);
  if (addressed.refusal !== undefined) {
    return { refusal: addressed.refusal };
  }
  // A conversion is re-judged by the published shape, so what goes out is
  // still what the gate accepted.
  let detail = shapeError;
  if (addressed.value !== normalized) {
    const converted = verbInputSchemaError(addressed.value, schema);
    if (converted === undefined) return { value: addressed.value };
    detail = converted;
  }
  if (detail === undefined) return { value: normalized };
  return {
    refusal: input === undefined
      ? `no payload was supplied, and this verb cannot run without one ` +
        `(${detail}) — send a payload`
      : detail,
  };
}

/**
 * Whether `value` carries a plain object BELOW its root — the payload shape
 * that can still hold a detached copy at a declared reference position after
 * the published schema has accepted it.
 *
 * A link envelope is a reference already, not a copy, so it stops the descent
 * rather than triggering a contract consult on every well-formed reference
 * argument. The root itself is excluded because the event object always is
 * one; what matters is what sits inside it, at any depth, through arrays.
 */
function carriesInlineObject(value: unknown, atRoot = true): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => carriesInlineObject(element, false));
  }
  if (!isObjectNotArray(value)) return false;
  if (isOpaqueReference(value)) return false;
  if (!atRoot) return true;
  return Object.values(value).some((child) =>
    carriesInlineObject(child, false)
  );
}
