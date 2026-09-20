import type { CellScope, JSONSchema, Pattern } from "@commonfabric/api";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  encodeJsonPointer,
  type EventAppendDeliveryOutcome,
  type IExtendedStorageTransaction,
  isLink,
  type MemorySpace,
  type NormalizedFullLink,
  renderCellReference,
} from "@commonfabric/runner";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefs,
} from "@commonfabric/runner/cfc/schema-refs";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import {
  namesResolvedParts,
  type NormalizedLLMFriendlyRef,
  normalizeLLMFriendlyRef,
} from "./llm-friendly-ref.ts";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "@commonfabric/runner/cfc/schema-sanitization";
import {
  isInstance,
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/utils/types";
import {
  declaredFieldNames,
  declaredFieldsAt,
  isSchemaObject,
  schemaIsArrayShaped,
  schemaIsObjectShaped,
} from "./declared-fields.ts";

import {
  type CallableKind,
  classifyCallableEntry,
} from "../../fuse/callables.ts";
import {
  boundReadValue,
  type CellSelection,
  CellSelectionError,
  deriveSelectedValue,
  isStoredContainer,
  LINK_MARKER_KEY,
} from "./cell-selection.ts";
import { EVENT_ROOT_POSITION, nearestName } from "./refusal.ts";
import type { ExecCommandSpec } from "./exec-schema.ts";
import { timeCliPhase } from "./trace-timing.ts";
import { noteWroteTo, transactionWroteTo } from "./write-receipt.ts";

export const CF_RUNTIME_ERROR_LOG = Symbol.for("cf.cli.runtimeErrorLog");

export interface CliRuntimeErrorRecord {
  message: string;
  stackTrace?: string;
  pieceId?: string;
  patternId?: string;
  spellId?: string;
  space?: string;
}

export interface CallableResolution {
  callableCell: Cell<any>;
  callableKind: CallableKind;
  cellKey: string;
  pieces: PiecesController;
  space: MemorySpace;

  /** This verb's declared result, resolved on demand.
   *
   * A THUNK rather than a value, because reaching it costs a pattern load and
   * almost no call needs it. Two callers do: `--help`, which enumerates what a
   * verb hands back, and a readback whose value closes a circle, which bounds
   * itself with the declaration rather than failing. A readback that renders
   * asks nothing of it, so an ordinary dispatch still loads no pattern.
   *
   * Absent where the resolution cannot match a declaration to the verb — a
   * handler reached on the piece's input cell, a piece surface with no pattern
   * to consult — which says this resolution cannot describe a result rather
   * than promising there is none. */
  declaredResult?: () => Promise<JSONSchema | undefined>;

  /** The verb's declared event schema — the input contract as the handler
   * module in the compiled pattern states it, reference markers intact.
   *
   * The dispatch schemas below cannot serve this purpose: a link-recorded
   * schema keeps only stream markers (`sanitizeSchemaForLinks`,
   * `KeepAsCell.OnlyStream`), so by the time a schema reaches a callable
   * cell, `asCell: ["cell"]` on a declared reference position is gone. This
   * thunk reads the compiled pattern's handler node instead, where the
   * marker survives — the authored declaration the contract ruling made
   * authoritative (docs/history/plans/verb-input-contract.md). The gate consults it
   * ONLY to decide which positions declare references; the payload's shape
   * is still judged against the published schema.
   *
   * A thunk costing a pattern load, like `declaredResult`, and absent under
   * the same conditions. Only a dispatch the published shape refuses pulls
   * it — the load rides the refusal path, never a clean dispatch. */
  declaredEvent?: () => Promise<JSONSchema | undefined>;

  /** The verb's published event schema, when the resolution knows a richer
   * one than the dispatch cell carries.
   *
   * The forced-stream fallback dispatches through a cast cell whose schema is
   * only `{asCell: ["stream"]}` — a shape every payload satisfies — while the
   * link-derived cell still carries whatever payload schema the piece
   * publishes. The pre-dispatch gate validates against this when present, so
   * a malformed payload on that path is refused before the invocation id is
   * spent, exactly as on the ordinary paths. */
  inputSchema?: JSONSchema;
}

/** The phases a handler invocation passes through, reported on early exit so
 * a caller knows whether a retry is pre- or post-dispatch (both are safe with
 * a caller-supplied id; the phase is diagnosis, not a safety gate). */
export type InvocationPhase =
  | "initial_sync"
  | "dispatched"
  | "committed"
  | "readback";

/**
 * What names one handler invocation: the caller's idempotency key for a
 * dispatch, and the session that key was chosen within (`newSessionId`,
 * ./session.ts).
 *
 * The two travel as a pair because an id is the caller's own word — an agent
 * picks `add-comment-1` — and another caller can pick the same one. The pair
 * reaches the durable event id, so a retry naming both collides on the
 * handling's create-only receipt and reads the original outcome back (verb
 * contract WS-D), while the same id under another session is a different
 * invocation entirely.
 *
 * The guarantee is at-most-once *commit*, not at-most-once *execution* — a
 * redelivered event re-runs the handler body and loses the race for the
 * receipt, so a verb whose body has effects outside its transaction (an LLM
 * call, a fetch) repeats those effects on retry even though nothing commits
 * twice.
 */
export interface InvocationIdentity {
  id: string;
  session: string;
}

export interface CallableExecutionDeps {
  uuid?: () => string;

  /** The id and session naming this call's invocation, for a handler send.
   * Absent for a call that names no invocation, which is then dispatched
   * under a runtime-minted event id and has no receipt to come back for. */
  invocation?: InvocationIdentity;

  /** Phase observer for early-exit reporting. */
  onPhase?: (phase: InvocationPhase) => void;

  /** `--no-wait`: await this handling's transaction-local commit
   * acknowledgment, then return WITHOUT the receipt readback (sync + read).
   * The commit acknowledgment cannot be skipped: the handler executes in
   * THIS process's runtime, so exiting before the commit is acknowledged
   * would abandon the invocation un-executed — nothing durable would have
   * happened — not leave it settling elsewhere. What CAN be skipped is
   * fetching the outcome back, because the exit publishes the receipt's
   * address (`InvocationOutcome.receipt`), so collecting it later is an
   * ordinary read; a same-id replay recovers it too, deduplicating against
   * the create-only receipt (verb contract D1/D3), but re-runs the handler
   * body. Requires an `invocationId` — without one there is no receipt to
   * come back for — and only the handler send path supports it (a tool's
   * result is delivered by this process, not read back from a receipt). */
  skipReadback?: boolean;

  /** `--show-links`: annotate the Invocation JSON with a `links` dictionary
   * mapping result paths to their backing cell addresses (verb contract
   * WS-F, F2). Provenance rides BESIDE the value, never inline — an inline
   * marker cannot annotate a scalar, and a scalar can be its own doc — and
   * entries appear only for paths whose backing differs from their enclosing
   * document, so plain JSON inside one doc adds nothing. Rides the receipt
   * readback, which is why it cannot combine with `--no-wait`. */
  showLinks?: boolean;

  /** `--filter`/`--select`/`--schema`: the shape the caller asked the result
   * to arrive in. Answered by the same selection step `cf cell get` reads
   * through, so one grammar covers reads and calls.
   *
   * A schemaless receipt holding a stored container is selected before its
   * linked contents are fetched. Other receipts are materialized before
   * selection to establish whether a result exists. The shared step waits
   * for its computed output with `Cell.pull()`, whose scheduler and
   * linked-document convergence pool are runtime/manager-wide; a shaped call
   * can therefore still share a wait with active work that the plain call's
   * transaction-local acknowledgment does not. Declared object keys are ordered
   * locally from the projection after that readiness boundary, with an open
   * projection's retained extras following in value order. A verb that returns
   * nothing keeps returning nothing — there is no value for a selection to be
   * about. */
  selection?: CellSelection;

  /** @internal Seam for tests, mirroring `getCellValue`'s. */
  deriveSelectedValue?: typeof deriveSelectedValue;
}

/** A backing-cell address published in an Invocation, written in the
 * fabric's canonical reference syntax, `//<space>/<id>[@scope][/path]`
 * or `/<id>[@scope][/path]`. One string carries the id, the
 * space when it differs from the one the call targeted, the scope, and the
 * path inside the backing document, so the address a call hands back is
 * exactly what a later command takes in as `--cell`. */
export type InvocationResultLink = string;

/** The outcome of a handler invocation made with a caller-supplied id. */
export interface InvocationOutcome {
  id: string;

  /** `"settled"` once receipt readback completed. Otherwise the furthest
   * phase the caller chose to observe: `--no-wait` returns at `"committed"`
   * (commit acknowledged, readback skipped), and a caller-bounded wait
   * reports the phase its bound expired in. */
  status: "settled" | InvocationPhase;

  /** Durable address of this handling's receipt — the cell the outcome is
   * written to, and the one `result` is read from.
   *
   * Published from the transaction's handling receipt link, which the commit
   * callback carries, so the address is known BEFORE the outcome is read.
   * That is what makes it available under `--no-wait`: a caller that chose
   * not to wait still holds the address to collect from, and reads it back
   * with `cf cell get --cell <receipt>` rather than re-invoking the verb.
   * The receipt is a COMMIT witness, not an execution witness — a same-id
   * replay
   * runs the handler body again and then loses the race, so effects outside
   * the transaction repeat.
   *
   * On a create-only collision this addresses the ORIGINAL handling's
   * receipt: the loser's commit callback carries the winner's address. That
   * is the runner's guarantee, asserted where it is implemented
   * (`packages/runner/test/scheduler-event-receipts.test.ts`, "cell.send
   * carries a caller-supplied eventId and exposes the receipt link") — the
   * CLI's own tests drive a single address and cannot witness it.
   *
   * Absent when the runtime published no link: with `commitPreconditions`
   * off nothing writes a receipt, and an address naming a cell that does not
   * exist is worse than no address. */
  receipt?: InvocationResultLink;

  /** The verb's result read back from the handling's receipt, when the
   * receipt carried one (a reactive-bearing return, or a plain return under
   * the plainResultReceipts flag). Absent for value-less verbs. */
  result?: unknown;

  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and `result` is the ORIGINAL outcome. */
  deduplicated?: boolean;

  /** Under `--show-links` only: result paths mapped to their backing cell
   * addresses in canonical reference syntax, provenance beside the value the
   * caller can pass straight back to `--cell`. The root `"/"` entry is the
   * result value's own backing document — the receipt, unless the result is
   * itself a reference, in which case the receipt address rides the
   * reserved bare `"receipt"` key; other entries appear only where a path's
   * backing document differs from its enclosing one. */
  links?: Record<string, InvocationResultLink>;
}

/** Durable address of a tool's per-invocation result cell. The scope is part
 * of the address: reopening a user- or session-scoped cell without it
 * resolves the space-scoped instance — a different cell. */
export interface CallableResultRef {
  space: string;
  id: string;
  scope: CellScope;
}

/**
 * `ref` written the way an address argument is written, so a command that
 * prints one and a command that takes one agree on the spelling.
 *
 * `parseScopedIdSegment` reads `<id>@<scope>` and reads a bare id as the space
 * scope, so the bare form is what a space-scoped address renders as — spelling
 * `@space` out would be a second way to write an address that already has one.
 * Every other scope carries its suffix, because reopening a user- or
 * session-scoped cell without it resolves the space-scoped instance, which is
 * a different cell.
 *
 * The space is not part of it: an address argument is read against the space
 * the command is connected to. A caller carrying one across spaces writes
 * {@link canonicalAddress}, the spelling whose reference names its own space.
 */
export function addressArgument(ref: CallableResultRef): string {
  return ref.scope === "space" ? ref.id : `${ref.id}@${ref.scope}`;
}

/**
 * `ref` written as the canonical fabric reference with its space embedded —
 * `//<space>/<id>@scope` — the one token that names the cell from any
 * configuration. `--cell` takes it whole: the embedded space supplies the
 * target space when `--space` is absent, and is checked against it when both
 * are named.
 */
export function canonicalAddress(ref: CallableResultRef): string {
  // check-address-examples-ignore: //<space>/<id>@scope the doc comment writes
  // the shape a caller reads the parts out of, with a hole in the scope slot,
  // rather than one address.

  return renderCellReference({ ...ref, path: [] });
}

export interface ExecutedCallable {
  outputText?: string;

  /** Present for handler sends carrying a caller-supplied invocation id. */
  invocation?: InvocationOutcome;

  /** The tool result cell's address — the handle a caller can revisit later
   * instead of re-running the tool (verb contract Part 2,
   * docs/plans/pattern-verb-contract.md). Handlers gain their equivalent with
   * the invocation protocol's caller-supplied ids. */
  resultRef?: CallableResultRef;
}

/** Read a tool callable's stored `pattern` slot as the pattern the runner
 * will run. Only the record shape is checked here; a record missing the
 * schemas reaches `runtime.run` the same way any malformed stored pattern
 * does. */
function asCallablePattern(value: unknown): Pattern | undefined {
  if (!isObjectNotArray(value)) return undefined;
  return value as Pattern;
}

function asExtraParams(value: unknown): Record<string, unknown> {
  return isObjectNotArray(value) ? value : {};
}

export function runtimeErrorLog(runtime: unknown): CliRuntimeErrorRecord[] {
  if (!isObjectOrArray(runtime)) {
    return [];
  }
  const log = (runtime as { [CF_RUNTIME_ERROR_LOG]?: unknown })[
    CF_RUNTIME_ERROR_LOG
  ];
  return Array.isArray(log) ? log as CliRuntimeErrorRecord[] : [];
}

function errorMessage(error: unknown): string {
  if (
    isObjectOrArray(error) && "reason" in error &&
    (error as { reason?: unknown }).reason != null
  ) {
    // A StorageTransactionAborted carries the abort's cause as `reason`, and
    // its own message is the generic "Transaction was aborted". Prefer the
    // cause: for a pre-dispatch drop — a send refused at the backlog cap, a
    // piece that failed to load — the reason is the whole signal.
    return errorMessage((error as { reason: unknown }).reason);
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (isObjectOrArray(error) && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

/**
 * A verb invocation rejected before dispatch because the supplied payload does
 * not satisfy the verb's declared event schema.
 *
 * Reported as a data error (stderr, exit 1) rather than a Cliffy usage error:
 * the flags parsed fine, the values they carry don't fit the verb.
 */
export class VerbInputValidationError extends Error {
  /**
   * The canonical address of the piece the verb was resolved on, set when the
   * target named a path and the piece was reached through the link stored
   * there. A report that names a piece names this one.
   */
  linkedPiece?: string;

  constructor(readonly verb: string, readonly detail: string) {
    super(`Invalid input for "${verb}": ${detail}`);
    this.name = "VerbInputValidationError";
  }
}

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
 * The address inside the `{"$link": "/of:…"}` object a marked read renders
 * (`composeLinkAddresses`, cell-selection.ts), whether the address stands
 * alone there or the contents the same read projected sit beside it.
 * `undefined` for every other value, a `$link` holding no string included:
 * `{"$link": true}` is the projection-schema marker, not an address.
 */
function printedAddressOf(value: unknown): string | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const address = (value as Record<string, unknown>)[LINK_MARKER_KEY];
  return typeof address === "string" ? address : undefined;
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

/** Every flag-facing surface's view of what a verb's event declares. */
export interface DeclaredEventFields {
  /** The declared properties, merged across every conjunction member. A name
   * declared more than once keeps its FIRST account, in declaration order,
   * which is the rule the refusal vocabulary already follows. */
  properties: Record<string, JSONSchema>;

  /** Names any member marks required. */
  required: Set<string>;
}

/**
 * What a verb's event schema declares at its root, reading a conjunction.
 *
 * `properties` alone answers for the common schema and misses every field an
 * `allOf` member contributes — which the payload door has always read and the
 * flag surfaces never did, so a field could be judged on one door and invisible
 * on the other. This is the one reader both can share.
 *
 * `null` where the position is not object-shaped at all, which is a verb taking
 * a single value rather than fields.
 *
 * A DISJUNCTION contributes nothing, deliberately. A payload need satisfy only
 * one branch, so no single flag list describes the position and no branch's
 * `required` binds it — `declaredFieldsAt` stops at one rather than reading its
 * members, and this inherits that.
 */
export function declaredEventFields(
  schema: JSONSchema | undefined,
): DeclaredEventFields | null {
  if (!isSchemaObject(schema)) return null;
  // A top-level local `$ref` is resolved before the position is read, because
  // a stream's event schema is routinely written through one:
  // `{$ref: "#/$defs/AddEvent", asCell: ["stream"], $defs: {...}}` puts every
  // field in the definition and none at the root. The indirection is only
  // NEEDED for a recursive event type, but a pattern gets it either way, and
  // a verb should not lose its flags over how its schema happens to be spelled.
  //
  // Both payload doors already resolve it — `normalizeAbsentVerbPayload` and
  // `eventSchemaJudgesRootFields` — so reading the root unresolved here was
  // the two doors disagreeing about the same schema: the verb's fields were
  // judged on arrival while every flag surface reported none, leaving the
  // caller a `--value` whose string could not satisfy the object it named.
  //
  // `resolveCfcSchemaRefs` rather than `localRefTarget`, because a `$ref` may
  // carry SIBLINGS and the runtime applies them. It flattens the ref site OVER
  // its target keyword by keyword, so a `properties` written beside the ref
  // replaces the target's rather than joining it — which is the resolution the
  // validator performs, and therefore the field list a payload is judged
  // against. Jumping to the target instead returns the definition alone: for
  // `{$ref → {query}, properties: {limit}}` that names `--query`, which the
  // validator refuses as an undeclared field, and hides `--limit`, which it
  // accepts. Which fields exist is the validator's answer to give; this door
  // reports it rather than deriving a second one.
  //
  // Merging is also what reconciles the two `$defs` scopes, which a ref site
  // and its target do not share.
  //
  // It answers `undefined` where a ref dangles or cycles, which fails toward
  // "not a fields position" — the scalar vocabulary, exactly where an
  // unresolvable event schema sat before.
  const scopeRoot = schema;
  const target = resolveCfcSchemaRefs(schema, scopeRoot);
  if (!isSchemaObject(target)) return null;
  const targetRoot = target !== schema
    ? cfcSchemaResolvedRoot(target, scopeRoot)
    : scopeRoot;
  // The gate the flag surfaces have always applied, widened by exactly one
  // term. A position stating `type: "object"` or carrying `properties` is a
  // fields position, and now so is one carrying `allOf` — because that is
  // where its fields live.
  const statesItsOwnFields = target.type === "object" || !!target.properties;
  if (!statesItsOwnFields && !Array.isArray(target.allOf)) return null;
  // A disjunction BESIDE properties is not a reason to report none. It adds
  // constraints the flag surfaces cannot express, but the properties it sits
  // next to are still declared and still typed, and refusing to name them
  // would take away flags that already worked. `declaredFieldsAt` reads the
  // conjunction and steps over the disjunction, which is the whole of what is
  // wanted here — a root check would only discard the fields beside it.
  const declared = declaredFieldsAt(target, targetRoot);
  // A conjunction earns the object path only by CONTRIBUTING fields. `allOf:
  // [{type: "string"}]` constrains a scalar, and admitting it here would route
  // a single-value verb through flag parsing and offer it a vocabulary of
  // none. A schema that states its own fields keeps the path either way, even
  // when it names no field — that is a fields position that happens to be
  // empty, which is a different thing from not being one.
  if (!statesItsOwnFields && declared.sources.length === 0) return null;
  const properties: Record<string, JSONSchema> = {};
  for (const source of declared.sources) {
    for (const [name, property] of Object.entries(source.properties)) {
      if (!Object.hasOwn(properties, name)) properties[name] = property;
    }
  }
  return { properties, required: declared.required };
}

/**
 * Whether a verb can be invoked carrying no payload at all.
 *
 * A field marked `required` that carries a `default` does not make a payload
 * mandatory: `normalizeAbsentVerbPayload` turns absence into `{}` and the
 * runtime fills the default in. Reading `required` raw would refuse at the
 * flag door a call the payload door accepts and dispatches — the same
 * disagreement between the two doors that `declaredEventFields` settles for
 * WHICH fields exist, asked here about whether any of them is owed.
 *
 * `relaxDefaultedRequired` is the runtime's own answer to "what does a
 * default satisfy", which is why it is borrowed rather than restated.
 */
export function verbRunsWithoutPayload(
  schema: JSONSchema | undefined,
): boolean {
  return declaredEventFields(schema) !== null &&
    requiredEventFieldsOwed(schema).size === 0;
}

/**
 * The fields a caller must actually supply, which is `required` minus every
 * field a default already answers for.
 *
 * The distinction matters at two doors that used to read `required` raw: the
 * one deciding whether a bare invoke is allowed, and the one enforcing
 * per-flag presence. Both would refuse a call the runtime accepts and fills
 * in, and a caller told "Missing required flag --mode" about a field with a
 * default has been sent to supply what the pattern already supplies.
 *
 * Returns the declared `required` unchanged when there is nothing to relax or
 * the schema cannot be relaxed — failing toward the stricter answer, since a
 * wrongly-relaxed field would be refused by the runtime instead, and further
 * from the caller.
 */
export function requiredEventFieldsOwed(
  schema: JSONSchema | undefined,
): Set<string> {
  // Asked first because it settles two things at once: `declaredEventFields`
  // answers non-null only for an object schema, and `relaxDefaultedRequired`
  // takes one. Asking again further down would be re-deciding a question this
  // answer has already closed.
  if (!isSchemaObject(schema)) return new Set();
  const declared = declaredEventFields(schema);
  if (declared === null || declared.required.size === 0) {
    return declared?.required ?? new Set();
  }
  const relaxed = relaxDefaultedRequired(schema, schema, new Map());
  return declaredEventFields(relaxed)?.required ?? declared.required;
}

/**
 * Whether this event schema judges the fields a payload names at its root.
 *
 * It does when it names fields somewhere — directly or through a conjunction —
 * and does not also say extra ones are welcome. A schema naming none judges
 * none, so every field passes; one carrying `additionalProperties` set to
 * anything but `false` has said undeclared fields are fine. `false` is the
 * one value that says the opposite, so a schema carrying it judges.
 *
 * Exported for the flag door, which needs the same answer about the same
 * schema and must not derive it a second way. It asks whether the SCHEMA
 * judges, not whether a given NAME is declared — those differ, and conflating
 * them makes a declared field spelled the wrong way look undeclared-and-open
 * rather than misspelled, which is the difference between a near miss and a
 * silent alias.
 */
export function eventSchemaJudgesRootFields(
  schema: JSONSchema | undefined,
): boolean {
  if (!isSchemaObject(schema)) return false;
  // Resolved the same way `declaredEventFields` resolves it, and for the same
  // reason: these two answer about one position — which fields it has, and
  // whether it judges them — and the flag door asks both. Reading a `$ref`
  // one way here and another way there would let an `additionalProperties`
  // written beside the ref go unseen while the fields it governs are named.
  const scopeRoot = schema;
  const target = resolveCfcSchemaRefs(schema, scopeRoot);
  if (!isSchemaObject(target)) return false;
  if (target.anyOf !== undefined || target.oneOf !== undefined) return false;
  const targetRoot = target !== schema
    ? cfcSchemaResolvedRoot(target, scopeRoot)
    : scopeRoot;
  if (!schemaIsObjectShaped(target, targetRoot)) return false;
  const declared = declaredFieldsAt(target, targetRoot);
  return declared.sources.length > 0 && !declared.honorsUndeclared;
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

/**
 * The round-trip spelling, resolved where the contract declares a reference:
 * at a position whose schema carries a cell marker — which the DECLARED
 * event schema keeps and a link-derived dispatch schema does not, see
 * `CallableResolution.declaredEvent` — a string holding the address a read
 * emits (`/of:…`, the canonical fabric reference) converts to the link
 * envelope dispatch already accepts. So does the `{"$link": "/of:…"}` object
 * a marked read renders that address in, alone or joined by the contents the
 * same read projected: the address inside is what the position takes, and
 * the contents beside it are the target's own fields, which a reference
 * never stores.
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
      let parsed: NormalizedLLMFriendlyRef | undefined;
      try {
        parsed = normalizeLLMFriendlyRef(spelled);
      } catch {
        parsed = undefined;
      }
      // A slug and a space name are refused here as firmly as a non-address
      // is. This value becomes a stored link, which holds the id and the
      // space verbatim and has no session behind it to resolve a name with —
      // so the wider vocabulary `cf`'s own intake takes would land a durable
      // edge pointing at nothing.
      if (
        parsed === undefined || parsed.input || !namesResolvedParts(parsed)
      ) {
        return {
          value,
          refusal:
            `${JSON.stringify(spelled)} at ${path} is not an address — ` +
            `the position declares a reference, and takes the /of:… form ` +
            `a read prints`,
        };
      }
      return {
        value: {
          "/": {
            "link@1": {
              id: parsed.pieceId,
              ...(parsed.embeddedSpace !== undefined &&
                { space: parsed.embeddedSpace }),
              ...(parsed.scope !== undefined && { scope: parsed.scope }),
              ...(parsed.path.length > 0 && { path: parsed.path }),
            },
          },
        },
      };
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
 * The shared pre-dispatch gate. Returns the input to dispatch — the caller's
 * own payload, or `{}` when an absent payload was normalized against an
 * object schema, or a payload whose emitted addresses were converted to link
 * envelopes — and throws `VerbInputValidationError` when that input cannot
 * satisfy the schema. The absent-payload refusal says so explicitly: "send a
 * payload" has to read differently from "fix your payload".
 */
async function assertVerbInputSatisfiesSchema(
  verb: string,
  input: unknown,
  schema: JSONSchema | undefined,
  declaredEvent?: () => Promise<JSONSchema | undefined>,
): Promise<unknown> {
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
    return normalized;
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
    throw new VerbInputValidationError(verb, addressed.refusal);
  }
  // A conversion is re-judged by the published shape, so what goes out is
  // still what the gate accepted.
  let detail = shapeError;
  if (addressed.value !== normalized) {
    const converted = verbInputSchemaError(addressed.value, schema);
    if (converted === undefined) return addressed.value;
    detail = converted;
  }
  if (detail === undefined) return normalized;
  throw new VerbInputValidationError(
    verb,
    input === undefined
      ? `no payload was supplied, and this verb cannot run without one ` +
        `(${detail}) — send a payload`
      : detail,
  );
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

/**
 * A tool's argument schema as a caller sees it: the schema less the `result`
 * slot and every parameter the tool binds through `extraParams`, which a
 * caller cannot set.
 */
export function cloneWithoutBoundToolKeys(
  schema: JSONSchema,
  extraParams: Record<string, unknown>,
): JSONSchema {
  if (!isSchemaObject(schema)) return schema;
  if (schema.type !== "object" && !schema.properties) return schema;

  const rawProperties = schema.properties;
  if (!isObjectNotArray(rawProperties)) {
    return schema;
  }

  const properties = {
    ...(rawProperties as Record<string, JSONSchema>),
  };
  delete properties.result;
  for (const key of Object.keys(extraParams)) {
    delete properties[key];
  }

  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((key) =>
      key !== "result" && !(key in extraParams)
    )
    : undefined;

  return {
    ...schema,
    properties,
    ...(required ? { required } : {}),
  };
}

function mergeToolInput(
  input: unknown,
  extraParams: Record<string, unknown>,
): Record<string, unknown> {
  const base = isObjectNotArray(input)
    ? input
    : input === undefined
    ? {}
    : { value: input };

  return {
    ...base,
    ...extraParams,
  };
}

export function detectCallableKind(
  callableValue: unknown,
  callableCell: Cell<any>,
): CallableKind | null {
  let resolvedValue = callableValue;
  try {
    resolvedValue = callableCell.getRaw() ?? callableCell.get() ??
      callableValue;
  } catch {
    resolvedValue = callableValue;
  }

  const callableKind =
    classifyCallableEntry(callableValue, callableCell.schema) ??
      classifyCallableEntry(resolvedValue, callableCell.schema) ??
      classifyCallableEntry(callableCell, callableCell.schema);
  if (callableKind) {
    return callableKind;
  }

  try {
    const pattern = callableCell.key("pattern").getRaw() ??
      callableCell.key("pattern").get();
    const extraParams = callableCell.key("extraParams").get();
    if (pattern !== undefined && extraParams !== undefined) {
      return "tool";
    }
  } catch {
    // Not a tool-shaped callable cell.
  }

  return null;
}

export function callableCommandSpec(
  callableCell: Cell<any>,
  callableKind: CallableKind,
): ExecCommandSpec {
  if (callableKind === "handler") {
    return {
      callableKind: "handler",
      defaultVerb: "invoke",
      inputSchema: callableCell.schema ?? true,
    };
  }

  const pattern = asCallablePattern(
    callableCell.key("pattern").getRaw() ??
      callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    callableCell.key("extraParams").get(),
  );

  return {
    callableKind: "tool",
    defaultVerb: "run",
    inputSchema: cloneWithoutBoundToolKeys(
      pattern?.argumentSchema ?? true,
      extraParams,
    ),
    outputSchemaSummary: pattern?.resultSchema,
  };
}

/** Serialize a receipt/backing link into the canonical reference syntax.
 * `contextSpace` is the space the call targeted: an address in another space
 * carries its `//<space>/` prefix; one in that space omits the space. */
function toInvocationResultLink(
  link: NormalizedFullLink,
  contextSpace: MemorySpace,
): InvocationResultLink {
  return createLLMFriendlyLink(link, contextSpace);
}

/** Two normalized links address the same backing document iff id, space,
 * and scope all agree; a differing path alone is just a position inside the
 * same doc, which needs no link of its own. */
function sameBackingDocument(
  a: NormalizedFullLink,
  b: NormalizedFullLink,
): boolean {
  return a.id === b.id && a.space === b.space && a.scope === b.scope;
}

/**
 * Walk a settled result's backing links into the `{ "/path": <link> }`
 * dictionary `--show-links` emits (verb contract WS-F, F2).
 *
 * The root `"/"` entry is the backing document of the result VALUE itself,
 * resolved through `resolveAsCell` like every other path — the design's own
 * motivating case is a result that is a reference (a scalar can be its own
 * doc), and `"/"` must expose the document that actually backs it, not the
 * cell it was read through. In the common case the root resolves to the
 * receipt and `"/"` IS the receipt address; when it resolves elsewhere, the
 * receipt address stays available under the reserved bare key `"receipt"` —
 * pointer keys always begin with `/`, so no result path can collide with
 * it.
 *
 * Below the root, every value path is resolved through the receipt cell
 * (`key()` steps plus `resolveAsCell`), and a path earns an entry exactly
 * when its backing document differs from its enclosing one — a path inside
 * the same plain JSON needs no link. Below an emitted entry the comparison
 * rebases onto that entry's document, so a chain of references annotates
 * each hop once. Recursion always continues from the RESOLVED cell, even
 * when no entry is emitted: a same-document link can still redirect to
 * another path, and descendants must be read from the redirect's target.
 * Keys are RFC 6901 JSON pointers (the runner's `encodeJsonPointer`, the
 * same encoding the llm-dialog link strings use), so a property name
 * containing `/` or `~` stays unambiguous.
 *
 * The walk covers the JSON of the value that was read back, and it ENFORCES
 * that rather than assuming it: descent stops at any non-plain object —
 * including a result that is itself one — so a live runtime object reached
 * through the result contributes its own link and nothing below it. That
 * bound is what makes the walk terminate. A result carrying a piece that
 * owns verbs is the case that proves the point — the stream on that piece is
 * a live object whose `runtime`/`scheduler` graph refers back to itself, and
 * walking into it exhausted the stack.
 */
export function collectInvocationResultLinks(
  receiptLink: NormalizedFullLink,
  receiptCell: Cell<any>,
  value: unknown,
  contextSpace: MemorySpace,
): Record<string, InvocationResultLink> {
  const resolvedRoot = receiptCell.resolveAsCell();
  const rootBacking = resolvedRoot.getAsNormalizedFullLink();
  const links: Record<string, InvocationResultLink> = {
    "/": toInvocationResultLink(rootBacking, contextSpace),
  };
  if (!sameBackingDocument(rootBacking, receiptLink)) {
    links["receipt"] = toInvocationResultLink(receiptLink, contextSpace);
  }

  const walk = (
    cell: Cell<any>,
    val: unknown,
    pathSegments: string[],
    base: NormalizedFullLink,
  ): void => {
    // A non-plain object is not part of the result's JSON: it is a live
    // runtime object the readback surfaced (a stream on a returned piece,
    // most commonly). It keeps the entry its parent emitted — the root's
    // "/" when the result itself is live — but the walk never goes inside:
    // its properties are the runtime's, not the result's, and they refer
    // back to themselves.
    if (!isObjectOrArray(val) || isInstance(val)) return;
    const keys = Array.isArray(val)
      ? val.map((_, index) => String(index))
      : Object.keys(val);
    for (const key of keys) {
      const childValue = (val as Record<string, unknown>)[key];
      let child: Cell<any>;
      try {
        child = cell.key(key);
      } catch {
        continue; // Not addressable as a cell — nothing to annotate.
      }
      const resolved = child.resolveAsCell();
      const childLink = resolved.getAsNormalizedFullLink();
      const segments = [...pathSegments, key];
      if (!sameBackingDocument(childLink, base)) {
        links[encodeJsonPointer(["", ...segments])] = toInvocationResultLink(
          childLink,
          contextSpace,
        );
        walk(resolved, childValue, segments, childLink);
      } else {
        // Same backing document — no entry — but descendants are still read
        // from the RESOLVED cell: a same-doc link can redirect to another
        // path, and the children live under its target.
        walk(resolved, childValue, segments, base);
      }
    }
  };

  walk(resolvedRoot, value, [], rootBacking);
  return links;
}

/**
 * Shape a call's result the way the caller asked for it, through the same step
 * `cf cell get` reads through — the one place a `--filter`/`--select`/
 * `--schema` grammar is interpreted, so a caller learns it once.
 *
 * `resultCell` is the cell the value was produced from: a handling's receipt,
 * or a tool's result cell. The step reads through it and therefore reports the
 * source's own links and Fabric metadata, which is what makes an address a
 * caller can act on come back rather than a copy.
 *
 * A selection that materializes nothing over a result that exists is refused
 * rather than reported as an absent result: an omitted `result` key means the
 * verb returned nothing, and a projection that kept nothing is a different
 * fact. `cf cell get` refuses the same condition on the same grounds.
 */
async function selectCallResult(
  resolved: CallableResolution,
  resultCell: Cell<any>,
  selection: CellSelection,
  deps: CallableExecutionDeps,
): Promise<unknown> {
  const selected = await (deps.deriveSelectedValue ?? deriveSelectedValue)(
    resolved.pieces.runtime,
    resolved.space,
    resultCell,
    selection,
  );
  if (selected === undefined) {
    throw new CellSelectionError(
      `Cannot shape the result of "${resolved.cellKey}": the filter/schema ` +
        "expression did not materialize a JSON-renderable value. This is " +
        "not JSON null, and it is not the empty receipt a value-less verb " +
        "settles with — inspect the result and the selection.",
    );
  }
  return selected;
}

/**
 * A result that cannot be written as JSON because it closes a circle, and that
 * nothing in reach bounds: the verb declared no result, or the declaration it
 * did make leaves the closing position unbounded.
 *
 * A distinct type because the condition is a rendering failure over a handling
 * that COMMITTED, which is the one thing the message has to carry — the caller
 * is holding a nonzero exit for a mutation that landed.
 */
export class CyclicResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicResultError";
  }
}

/**
 * Helper for {@link circularResultPath}: the position, as a JSON pointer, that
 * is reachable from inside itself.
 *
 * Ancestors, not visits: a value reachable by two paths is written twice and
 * renders fine, while a value reachable from inside itself has no rendering at
 * all. Own enumerable keys and nothing else, which is what a serializer reads.
 *
 * A node carrying `toJSON` is a leaf here, because it is a leaf to the
 * serializer too: what gets written is whatever that method returns, and the
 * properties underneath are never visited. The runtime objects a readback
 * surfaces — a stream on a returned piece — are exactly that case, and their
 * internals do refer back to themselves.
 */
function locateResultCycle(value: unknown): string | undefined {
  const ancestors = new Set<object>();
  const walk = (node: unknown, path: string[]): string | undefined => {
    if (!isObjectOrArray(node)) return undefined;
    if (ancestors.has(node)) return encodeJsonPointer(["", ...path]);
    if (typeof (node as { toJSON?: unknown }).toJSON === "function") {
      return undefined;
    }
    ancestors.add(node);
    try {
      const keys = Array.isArray(node)
        ? node.map((_, index) => String(index))
        : Object.keys(node);
      for (const key of keys) {
        const found = walk(
          (node as Record<string, unknown>)[key],
          [...path, key],
        );
        if (found !== undefined) return found;
      }
      return undefined;
    } finally {
      ancestors.delete(node);
    }
  };
  return walk(value, []);
}

/**
 * The JSON pointer of the position where `value` closes a circle, or
 * `undefined` where `value` can be written as JSON.
 *
 * Two witnesses have to agree before this reports one. The serializer decides
 * whether the value renders at all — it is the thing whose failure is being
 * prevented, so nothing else gets to overrule it — and the walk beside it
 * decides where. A value the serializer writes is left alone whatever the walk
 * thinks, and a serializer failure the walk cannot place is left alone too:
 * `JSON.stringify` refuses more than circles, and a refusal that is not one is
 * not this path's to answer.
 */
function circularResultPath(value: unknown): string | undefined {
  try {
    JSON.stringify(value);
    return undefined;
  } catch {
    return locateResultCycle(value);
  }
}

/**
 * Bound a readback that closes a circle with the verb's own declared result,
 * and hand back the value that bounds to.
 *
 * The declaration is the boundary the AUTHOR drew, and it is applied in two
 * strengths, the weaker first. Where the declared type re-enters itself, that
 * position IS the one that closes the circle, so rendering an address there
 * cuts exactly where the shape says it should and leaves every other position
 * reading as it already did; the addresses are written by the same walk
 * `--select`/`--schema` compose theirs with, so a derived bound and a
 * hand-written one name the same position the same way.
 *
 * Where the circle is somewhere the declaration does not describe at all, that
 * cut has nowhere to land. A verb that declares a compact row over the piece
 * it hands back is the case: the row re-enters nowhere, and the piece carries
 * a view that reaches every piece it renders and back again. The stronger
 * bound answers that one by reading the declaration as the shape it states —
 * each object position it CLOSES held to the fields it declares, which is the
 * boundary an author writing a narrow result already believes they drew.
 *
 * Both are applied to `value` — the result already in hand — and never read a
 * second one. That is what lets them bound a result a caller ALREADY shaped
 * without widening it: a projection can name the re-entering subtree whole,
 * which selects the circle rather than cutting past it, and the cut then
 * removes the closing position from what they selected rather than answering
 * with the declaration's whole shape in its place. Where a caller's own shape
 * renders, this is never reached at all.
 *
 * Refuses where nothing in reach bounds it: no declaration at all, a
 * declaration that describes no less than the value does, or a `--filter`
 * beside it — a filtered array's elements no longer say which positions they
 * came from, and a bound is written in addresses, which name positions. A
 * refusal names where the circle closes and how to collect the outcome, which
 * beats a stack trace for a handling that already committed.
 */
async function boundCyclicResult(
  resolved: CallableResolution,
  receiptCell: Cell<any>,
  value: unknown,
  cycle: string,
  receiptId: string | undefined,
  deps: CallableExecutionDeps,
): Promise<unknown> {
  // Each wording is its own statement, so a reader of the coverage report can
  // tell which of them a test has ever produced. Inside one expression they
  // could not: a ternary is a single statement, and its untaken arm is
  // credited with the count of the statement holding it, so a wording nothing
  // has ever emitted reads exactly like one every call emits.
  let whyUnbounded: string;
  if (deps.selection?.filter !== undefined) {
    // Decided before the declaration is reached for, because reaching for it
    // costs a pattern load and no derivation from it can be applied here: the
    // selection step refuses a `$link` beside a `--filter` on the same grounds
    // this refusal names, and every derived bound is `$link`s.
    whyUnbounded = "This call's --filter is answered with the elements " +
      "themselves, which no longer say which positions they came from, so " +
      "the addresses a bound is written in cannot be composed beside it.";
  } else {
    const declared = await resolved.declaredResult?.();
    // Two bounds, weakest first, and the order is what keeps the stronger one
    // from narrowing anything it does not have to. `"recursion"` cuts where
    // the declared type re-enters itself and leaves every other position
    // reading what it read; `"shape"` reads the whole declaration as the shape
    // it states, which is the only bound in reach when the circle is somewhere
    // the declaration does not describe at all — a verb declaring a compact
    // row over the piece it returns, whose piece carries a view that reaches
    // back to it. A value that renders under the weaker one never reaches the
    // stronger.
    for (const bound of ["recursion", "shape"] as const) {
      const bounded = await boundReadValue(
        receiptCell,
        declared,
        value,
        resolved.space,
        bound,
      );
      // The bound is only as good as the declaration: a position the
      // declaration left wide can still expand into the circle, and answering
      // with a value that cannot be written would move the same failure one
      // step later.
      if (bounded !== undefined && circularResultPath(bounded) === undefined) {
        return bounded;
      }
    }
    if (declared === undefined) {
      whyUnbounded = "This verb declares no result for `cf` to bound the " +
        "readback with.";
    } else {
      whyUnbounded = "This verb's declared result leaves the closing " +
        "position unbounded.";
    }
  }
  throw new CyclicResultError(
    `Cannot render the result of "${resolved.cellKey}": it closes a circle at ` +
      `"${cycle}", and JSON has no way to write one. The handling ` +
      "COMMITTED — the write landed, and only this rendering failed. " +
      whyUnbounded +
      " Collect the outcome with a shape that bounds it: " +
      (receiptId === undefined
        ? "read the receipt with --select or --schema."
        : `cf cell get --cell ${receiptId} ` +
          `--schema '{"properties":{"<field>":{"$link":true}}}'.`) +
      " Calling the verb again under --select or --schema shapes it at the " +
      "call, but runs the handler body a second time.",
  );
}

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    // Before anything is dispatched, and so before the invocation id can be
    // spent on a handling that would run with no event. An absent payload
    // is normalized to `{}` against an object schema (D5), so what goes out
    // is what the gate judged. A resolution carrying a richer published
    // schema than its dispatch cell (the forced-stream fallback) is judged
    // against that one.
    const dispatchInput = await assertVerbInputSatisfiesSchema(
      resolved.cellKey,
      input,
      resolved.inputSchema ?? resolved.callableCell.schema,
      resolved.declaredEvent,
    );
    const runtimeErrors = runtimeErrorLog(resolved.pieces.runtime);
    const errorCountBefore = runtimeErrors.length;
    const invocation = deps.invocation;
    const invocationId = invocation?.id;
    if (deps.skipReadback && invocation === undefined) {
      // Refused before dispatch: skipping the readback is only sound when a
      // later call can fetch the outcome, and that needs the pair naming it.
      throw new Error("--no-wait requires an invocation id");
    }
    deps.onPhase?.("dispatched");
    // Two settlements come back from one send. `appended` is the caller's
    // own authored act durable: under server execution the event append,
    // which the server then handles; otherwise the handling's commit, the
    // same moment as `handled`. `handled` is the handling's final commit
    // callback — under server execution, the served handling's consequence.
    // The dispatch span runs to the first, the dispatch-to-commit time the
    // `--verbose` phases report, and the readback below waits for the second
    // before it reads the receipt.
    const handled = Promise.withResolvers<IExtendedStorageTransaction>();
    const tx = await timeCliPhase(
      "executeCallable.dispatch",
      () =>
        new Promise<IExtendedStorageTransaction>((resolve, reject) => {
          const onAppended = (
            delivery: EventAppendDeliveryOutcome,
            appendedTx: IExtendedStorageTransaction,
          ) => {
            // A refusal the transaction itself carries — a handling that
            // threw or whose commit was rejected — is reported below off
            // the transaction's status, with the runtime error it
            // recorded; only an append refused on an otherwise clean
            // transaction is reported here.
            if (delivery.delivered || appendedTx.status().status === "error") {
              resolve(appendedTx);
            } else {
              reject(new Error(`event append refused: ${delivery.refused}`));
            }
          };
          // The commit callback settles both: a sender that never reports
          // the append — one whose act IS the commit — is acknowledged
          // here, and the appended report, when it comes, comes first.
          const onCommit = (committedTx: IExtendedStorageTransaction) => {
            resolve(committedTx);
            handled.resolve(committedTx);
          };
          try {
            resolved.callableCell.send(dispatchInput, onCommit, {
              ...(invocation === undefined ? {} : {
                // The id and the session that chose it travel together:
                // an id is the caller's own word, and only the pair
                // decides which receipt this handling files under.
                eventId: invocation.id,
                session: invocation.session,
              }),
              onAppended,
            });
          } catch (error) {
            reject(error);
          }
        }),
    );
    // Acknowledgment is transaction-local (verb contract, Settlement): the
    // callback above fires on THIS caller's durable act. Awaiting
    // runtime.idle()/pieces.synced() here instead would hold an
    // already-committed write hostage to every derived recomputation it
    // triggered elsewhere in the graph.
    deps.onPhase?.("committed");

    const txStatus = tx.status();
    const deduplicated = txStatus.status === "error" &&
      "precondition" in txStatus.error &&
      txStatus.error.precondition === "receipt-exists";
    if (txStatus.status === "error" && !deduplicated) {
      const latestRuntimeError = runtimeErrors.slice(errorCountBefore).at(-1)
        ?.message;
      throw new Error(
        `Handler "${resolved.cellKey}" failed: ${
          latestRuntimeError ?? errorMessage(txStatus.error)
        }`,
      );
    }

    // The handling committed, so the space it committed to is named here —
    // before the early return below, which a call without an invocation id
    // takes. A deduplicated retry is excluded: it settles on the original
    // outcome and commits nothing, so a receipt would name a write this
    // invocation did not perform.
    if (!deduplicated) noteWroteTo(resolved.space);

    if (invocationId === undefined) return {};

    // The handling's receipt address, taken off the transaction the commit
    // callback handed back (verb contract WS-D). It is known HERE — at
    // commit, before anything is read — which is what lets the detached exit
    // below publish an address for an outcome nobody waited for.
    const link = tx.handlingReceiptLink;
    const receiptAddress = link === undefined
      ? undefined
      : toInvocationResultLink(link, resolved.space);

    if (deps.skipReadback) {
      // --no-wait's exit point: the commit is acknowledged, so the
      // handling — and on a collision, the original one — is durable on
      // the server and survives this process. Only the readback
      // (sync + read of the outcome) is skipped; the address of the outcome
      // rides out regardless, so collecting it later is an ordinary read
      // rather than a same-id replay that re-runs the handler body.
      return {
        invocation: {
          id: invocationId,
          status: "committed",
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(receiptAddress !== undefined ? { receipt: receiptAddress } : {}),
        },
      };
    }

    // The readback needs the handling itself to have landed, which under
    // server execution is the served handling's consequence — refused,
    // errored, or dropped there, the readback would find no receipt. Off
    // it, `handled` settled with `tx` above.
    const handledTx = await timeCliPhase(
      "executeCallable.handled",
      () => handled.promise,
    );
    const handledStatus = handledTx.status();
    if (
      handledStatus.status === "error" && handledTx !== tx &&
      !("precondition" in handledStatus.error &&
        handledStatus.error.precondition === "receipt-exists")
    ) {
      throw new Error(
        `Handler "${resolved.cellKey}" failed: ${
          errorMessage(handledStatus.error)
        }`,
      );
    }

    // Read the handling's outcome back off its receipt. On a receipt-exists
    // collision this is the ORIGINAL handling's receipt — same id, same
    // outcome — so a retry settles as a success. The receipt is a COMMIT
    // witness, not an execution witness: the redelivered event still ran the
    // handler body and then lost the race, so nothing committed twice while
    // effects outside the transaction repeated.
    deps.onPhase?.("readback");
    let result: unknown;
    let links: Record<string, InvocationResultLink> | undefined;
    if (link) {
      const receipt = resolved.pieces.runtime.getCellFromLink<any>(link);
      let value: unknown;
      let raw: unknown;
      if (deps.selection !== undefined && receipt.schema === undefined) {
        const stored = receipt.asSchema(false);
        await timeCliPhase(
          "executeCallable.receipt.probe",
          () => stored.pull(),
        );
        raw = stored.getRaw();
      }
      // A stored container establishes presence without loading its children.
      // A root link needs materialization: its target can be absent.
      if (isStoredContainer(raw)) {
        value = raw;
      } else {
        value = await timeCliPhase(
          "executeCallable.receipt.pull",
          () => receipt.pull(),
        );
        raw = receipt.getRaw();
      }
      // A value-less verb's receipt is an empty record — existence-only.
      // Presence is decided on the receipt's STORED value, never on the
      // materialized one: a `FabricInstance` crossing the cell read arrives
      // as a query-result proxy over an empty ordinary stub (the
      // `getPrototypeOf` note in packages/runner/src/query-result-proxy.ts),
      // so prototype and key enumeration on `value` cannot tell a real
      // instance result from the witness. The witness is stored as exactly
      // the plain empty record; every other stored shape — plain JSON, the
      // link a launched or chained-cell result converts to, an instance's
      // codec form, a keyless raw primitive — is a result.
      const valueLess = isObjectNotArray(raw) && !isInstance(raw) &&
        Object.keys(raw).length === 0;
      if (value !== undefined && !valueLess) {
        result = value;
      }
      if (result !== undefined) {
        // Both steps run only where a result exists. Shaping the empty witness
        // would report `{}` for a verb whose whole answer is that it returned
        // nothing, and that omission is the distinction the empty receipt
        // exists to draw.
        if (deps.selection !== undefined) {
          result = await timeCliPhase(
            "executeCallable.select",
            () => selectCallResult(resolved, receipt, deps.selection!, deps),
          );
        }
        // Whatever the value in hand came from — the whole receipt, or the
        // caller's own shape over it — what goes out is written as JSON, and a
        // circle has no JSON writing at all. A selection is no exemption: a
        // projection that names the re-entering subtree whole keeps the circle
        // it selected. The check reads a value already in hand and touches no
        // storage, so a result that renders reaches stdout exactly as it always
        // has, and the bound below engages only where one does not.
        const cycle = circularResultPath(result);
        if (cycle !== undefined) {
          result = await timeCliPhase(
            "executeCallable.boundCyclic",
            () =>
              boundCyclicResult(
                resolved,
                receipt,
                result,
                cycle,
                link.id,
                deps,
              ),
          );
        }
      }
      if (deps.showLinks) {
        // After readback and after the selection, off the same receipt the
        // result came from: the links annotate exactly the value the caller
        // is holding. A projection keeps every surviving path where it was,
        // so each address still names the position it annotates; a `--filter`
        // does not, which is why the command refuses that pair rather than
        // handing back addresses for elements the predicate moved.
        links = collectInvocationResultLinks(
          link,
          receipt,
          result,
          resolved.space,
        );
      }
    }

    return {
      invocation: {
        id: invocationId,
        status: "settled",
        ...(deduplicated ? { deduplicated: true } : {}),
        ...(receiptAddress !== undefined ? { receipt: receiptAddress } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(links !== undefined ? { links } : {}),
      },
    };
  }

  if (deps.skipReadback) {
    // A tool's result is produced and delivered by this process, not read
    // back from a receipt — there is nothing to skip that a later call
    // could recover.
    throw new Error(
      `--no-wait is not available for tool "${resolved.cellKey}": ` +
        "a tool runs to completion in this process",
    );
  }

  const pattern = asCallablePattern(
    resolved.callableCell.key("pattern").getRaw() ??
      resolved.callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    resolved.callableCell.key("extraParams").get(),
  );
  const runtime = resolved.pieces.runtime;
  const runtimeErrors = runtimeErrorLog(runtime);
  const errorCountBefore = runtimeErrors.length;
  const tx = runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink().scope;
  const resultCell = runtime.getCell<unknown>(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    resultScope,
  );
  const running = runtime.run(
    tx,
    pattern,
    mergeToolInput(input, extraParams),
    resultCell,
  );
  // Capture the tool's result off its cell's sink. sink() fires immediately with
  // the current (initially undefined) value and re-fires on every committed
  // change, including the server-pushed writeback of an async tool's result.
  let sinkValue: unknown;
  let hasSinkValue = false;
  const cancelSink = running.sink((value) => {
    if (value !== undefined) {
      sinkValue = value;
      hasSinkValue = true;
    }
  });

  let outputValue: unknown;
  try {
    await runtime.idle();
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    // A tool's result cell is durable, so a transaction that wrote one is a
    // write to the space like a handler's is. Neither `commit()` resolving
    // nor a `done` status proves that: an empty transaction commits
    // successfully too. The journal's novelty for this space is what was
    // actually written, so the receipt follows it.
    if (transactionWroteTo(tx, resolved.space)) noteWroteTo(resolved.space);

    // Drain the tool to a fully settled state — scheduler idle, storage synced,
    // and every in-flight async builtin finished — so the result is final by the
    // time we read it. A synchronous tool has already written its result; an
    // async tool's LLM/fetch call is awaited to completion here, with no poll
    // interval under it and no deadline over it. `settled()` normalizes a failed
    // builtin to "settled", so a broken tool converges here rather than hanging.
    await runtime.settled();

    if (hasSinkValue) {
      outputValue = sinkValue;
    } else {
      // Fully settled with nothing on the sink: read once (a server-pushed value
      // can land without re-triggering the local effect).
      outputValue = await resultCell.pull();
      if (outputValue === undefined) {
        // The tool ran to a fully settled state without producing a result.
        // Keep the caller's contract of a defined result or an explicit
        // failure: surface the runtime error the pattern recorded when there
        // is one, and otherwise fail loudly rather than emitting nothing.
        const latestError = runtimeErrors.slice(errorCountBefore).at(-1)
          ?.message;
        throw new Error(
          latestError !== undefined
            ? `Tool "${resolved.cellKey}" failed: ${latestError}`
            : `Tool "${resolved.cellKey}" produced no result.`,
        );
      }
    }
  } finally {
    cancelSink();
  }

  if (deps.selection !== undefined) {
    // A tool's result reaches stdout through the same selection a handler's
    // does. It is read off the cell the tool wrote, which is where the value
    // above came from, so the shaped answer describes the same result.
    outputValue = await selectCallResult(
      resolved,
      resultCell,
      deps.selection,
      deps,
    );
  }

  // The result cell's durable address rides along: today the cell is
  // otherwise unlinked — reachable by nobody once this process exits (a named
  // defect in the verb-contract design). Handing the address back is the
  // smallest honest handle.
  const resultLink = resultCell.getAsNormalizedFullLink();
  return {
    outputText: JSON.stringify(outputValue, null, 2),
    resultRef: {
      space: resultLink.space,
      id: resultLink.id,
      scope: resultLink.scope,
    },
  };
}
