import type {
  FabricPlainObject,
  FabricValue,
  SchemaPathSelector,
} from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model";
import {
  type EntityRef,
  getModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { NullLiveEnvironment } from "@commonfabric/data-model/codec-common";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { internPathSelector } from "@commonfabric/data-model-schema";
import { isPlainObject, unsafeObjectKeyIn } from "@commonfabric/utils/types";
import type { SessionReadCeiling } from "./v2/read-ceiling.ts";

export const MEMORY_PROTOCOL = "memory" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type SessionToken = string;
export type CellScope = "space" | "user" | "session";

/**
 * Protocol-level failure: a request whose SHAPE or identity preconditions
 * are invalid at this protocol layer (as opposed to a storage conflict or
 * an authorization denial). Defined here in the wire-shape module because
 * the shared scope-key vocabulary below throws it; `engine.ts` re-exports
 * it, so `Engine.ProtocolError` remains the same class object.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * The `scope_key` vocabulary — PROTOCOL vocabulary, defined ONCE here
 * beside {@link CellScope} (ledger LD3, owner 2026-08-03;
 * docs/specs/server-side-execution/key-vocabulary.md §3).
 *
 * A scope key names one INSTANCE of a scoped document: `space` (the one
 * shared instance), `user:<principal>` (one per user), or
 * `session:<principal>:<sessionId>` (one per session). Storage rows are
 * keyed by it, derived-commit write annotations carry it
 * ({@link DerivedWriteAnnotation}), lease-holder reads may name it
 * (protocol.md §2's read row), and the runner's in-memory identity keys
 * are built from it (the key-vocabulary.md §1 nine-site closure).
 * Segments are encodeURIComponent-encoded, so `:` splits segments
 * exactly and a key never contains `/`.
 *
 * Two rules keep this the ONE definition (key-vocabulary.md §4):
 * neither the engine's row keys nor the runner's in-memory keys may
 * restate the format, and a key is only ever CONSTRUCTED from an
 * explicitly supplied identity — the memory server derives that identity
 * from the authenticated session at admission for `authored` traffic; a
 * runner-side run receives it with the work (the demand for derivations,
 * the server-stamped `firedAt` for handlers; in the OFF arm it is the
 * runtime's own authenticated session) — never resolved from ambient
 * state.
 */
export type ScopeKey =
  | "space"
  | `user:${string}`
  | `session:${string}:${string}`;

/**
 * The identity a {@link resolveScopeKey} construction resolves against.
 * Supplied explicitly by the caller — see the construction rule on
 * {@link ScopeKey}.
 */
export type ScopeKeyIdentity = {
  principal?: string;
  sessionId?: SessionId;
};

const encodeScopeKeyPart = (value: string): string => encodeURIComponent(value);
const decodeScopeKeyPart = (part: string): string => decodeURIComponent(part);

/**
 * Whether `part` is a CANONICAL scope-key segment: non-empty and
 * byte-identical to what {@link encodeScopeKeyPart} emits for the
 * segment's own decoding — i.e. an element of the encoder's image, the
 * fixed points of encode∘decode. This is what makes accepted keys safe
 * to embed in delimited composite keys and to percent-decode: no raw
 * `/`, `:`, or any other character the encoder escapes; no malformed
 * escape (decoding an accepted segment never throws); no decodable but
 * non-canonical escape (`%2f` where the encoder emits `%2F`, `%41` for
 * plain `A`), so one identity has exactly ONE accepted spelling and
 * construction stays injective. Malformed input — a bad escape (decode
 * throws) or a lone surrogate (re-encode throws) — REFUSES with false,
 * never a URIError.
 */
const isCanonicalScopeKeyPart = (part: string): boolean => {
  if (part.length === 0) return false;
  try {
    return encodeScopeKeyPart(decodeScopeKeyPart(part)) === part;
  } catch {
    return false;
  }
};

/**
 * Constructor for the `session:<principal>:<sessionId>` key form, shared
 * between scope keys and the engine's commit session keys (which store the
 * same form for principal-carrying sessions).
 */
export const resolvePrincipalSessionKey = (
  principal: string,
  sessionId: SessionId,
): ScopeKey =>
  `session:${encodeScopeKeyPart(principal)}:${encodeScopeKeyPart(sessionId)}`;

/**
 * Principal segment of a `session:<principal>:<sessionId>` key (scope key
 * or stored commit session key — same form). Principal-less commit
 * session keys store the bare session id — no principal — and yield
 * `undefined` here. The segments are encodeURIComponent-encoded, so
 * splitting on ":" is exact.
 */
export const principalOfSessionKey = (key: string): string | undefined => {
  if (!key.startsWith("session:")) return undefined;
  const parts = key.split(":");
  if (parts.length !== 3) return undefined;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
};

/**
 * THE shared `(scope, identity) → scope_key` constructor (LD3,
 * key-vocabulary.md §3). Pure: it is the caller that supplies the
 * identity — see the construction rule on {@link ScopeKey}. Throws
 * {@link ProtocolError} when the requested scope needs an identity
 * component the caller did not supply; it never invents or defaults one.
 */
export const resolveScopeKey = (
  scope: CellScope | undefined,
  identity: ScopeKeyIdentity,
): ScopeKey => {
  switch (scope ?? "space") {
    case "space":
      return "space";
    case "user":
      if (!identity.principal) {
        throw new ProtocolError(
          "user scoped memory operations require a principal",
        );
      }
      return `user:${encodeScopeKeyPart(identity.principal)}`;
    case "session":
      if (!identity.principal) {
        throw new ProtocolError(
          "session scoped memory operations require a principal",
        );
      }
      if (!identity.sessionId) {
        throw new ProtocolError(
          "session scoped memory operations require a session id",
        );
      }
      return resolvePrincipalSessionKey(identity.principal, identity.sessionId);
  }
};

/**
 * Inspect half of the vocabulary: the {@link CellScope} a scope key is an
 * instance of. Total — any string without a `user:`/`session:` prefix
 * reads as the space scope; use {@link isScopeKey} first where a value
 * needs validating rather than classifying.
 */
export const scopeOfScopeKey = (scopeKey: string): CellScope => {
  if (scopeKey.startsWith("session:")) {
    return "session";
  }
  if (scopeKey.startsWith("user:")) {
    return "user";
  }
  return "space";
};

/**
 * The canonical (id, scope key) -> dirty/demand key encoding — the ONE
 * identity every demand/dirtiness surface keys instances by (the memory
 * server's dirty marking, the serving loop's demand registry, the warm
 * request's staged-instance capture). Lives HERE, on the shared
 * browser-safe vocabulary surface beside {@link resolveScopeKey}, so
 * client-bundled modules (the runner's wave carriage among them) can
 * key with it without importing any server-only module.
 */
export const toDirtyKey = (
  id: string,
  scopeKey: ScopeKey = "space",
): string => `${scopeKey}\0${id}`;

/**
 * Whether a scope key is in the APPLICABLE SET of the given identity
 * (protocol.md §3): `space`, `user:<me>`, `session:<me>:<sid>`. Push is
 * filtered per recipient by this predicate — a subscriber receives only
 * rows whose scope_key is applicable to it; the remaining rows are
 * absent, not redacted. The lease-holder exemption (the SpaceServer
 * legitimately reads and receives every instance — protocol.md §2's read
 * row) is decided by the CALLER, not here.
 */
export const scopeKeyApplicableTo = (
  scopeKey: string,
  identity: ScopeKeyIdentity,
): boolean => {
  const scope = scopeOfScopeKey(scopeKey);
  if (scope === "space") return true;
  if (!canResolveScopeKey(scope, identity)) return false;
  return resolveScopeKey(scope, identity) === scopeKey;
};

/**
 * Whether a string is a CANONICAL {@link ScopeKey} — one
 * {@link resolveScopeKey} could have constructed: `space`, or
 * `user:`/`session:` with every identity segment satisfying
 * {@link isCanonicalScopeKeyPart}. Prefix-shaped keys with raw
 * delimiters (`user:a/b`, `user:did:key:x`), malformed escapes
 * (`%`, `%GG`), or non-canonical escapes (`%2f` for the encoder's
 * `%2F`) are REJECTED, not just unusual: admission surfaces gate on
 * this predicate, and descendant surfaces place admitted keys into
 * `/`-delimited composite keys and percent-decode their segments, so
 * a merely prefix-shaped key corrupts that addressing or throws
 * mid-serving. Refusal, never a throw.
 */
export const isScopeKey = (value: string): value is ScopeKey => {
  if (value === "space") return true;
  if (value.startsWith("user:")) {
    return isCanonicalScopeKeyPart(value.slice("user:".length));
  }
  if (value.startsWith("session:")) {
    const parts = value.split(":");
    return parts.length === 3 && isCanonicalScopeKeyPart(parts[1]) &&
      isCanonicalScopeKeyPart(parts[2]);
  }
  return false;
};

/**
 * Whether {@link resolveScopeKey} can construct a key for `scope` from
 * `identity` — i.e. every identity component that scope requires is
 * supplied. The predicate twin of the constructor's throw conditions, for
 * paths that must SKIP unresolvable scopes (e.g. a session with no
 * principal reacting to another principal's user-scoped dirtiness) rather
 * than fail.
 */
export const canResolveScopeKey = (
  scope: CellScope | undefined,
  identity: ScopeKeyIdentity,
): boolean => {
  switch (scope ?? "space") {
    case "space":
      return true;
    case "user":
      return !!identity.principal;
    case "session":
      return !!identity.principal && !!identity.sessionId;
  }
};

/**
 * Protocol-level rejection of a DUPLICATE event append (events.md §4's
 * dedupe horizon): the commit declared an `eventId` that already exists
 * among the stream's entries above its `eventWatermark` (or in a not-yet-
 * consequenced seq-less entry — the stage-G interim arm, which retires as
 * processing marks entries consequenced). Distinguished by NAME from the
 * generic {@link ProtocolError} so a client discharging its offline queue
 * (events.md §5, LT9) can treat "already appended" as delivered rather
 * than as a failure to surface: the first append landed, its consequences
 * are (or will be) the authoritative outcome, and re-raising would
 * re-discharge forever.
 */
export class EventAppendDuplicateError extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "EventAppendDuplicateError";
  }
}

/**
 * The commit classes of server-execution v2
 * (docs/specs/server-side-execution/protocol.md §1). A closed set of three:
 * `authored` (any authorized session's own writes and event appends),
 * `derived` (the space's lease-holding SpaceServer committing derivation
 * results), `system` (the memory server itself: bootstrap-style direct
 * writes). The class is SERVER-DETERMINED at admission — assigned by which
 * admission path processed the commit, never a client-supplied field — and
 * every commit carries one in both flag arms; only the ON arm enforces the
 * per-class admission rows (protocol.md §2). Protocol vocabulary, so it is
 * defined once here in the wire-shape module (protocol.md §7).
 */
export type CommitClass = "authored" | "derived" | "system";

/** The same closed set, enumerable at run time. */
export const COMMIT_CLASSES: readonly CommitClass[] = [
  "authored",
  "derived",
  "system",
];

/**
 * The well-known watermark doc, one per space (protocol.md §4): "derived
 * state is current through commit seq N." A SPACE-scoped instance
 * (`scope_key = "space"`), updated inside the same transaction as derived
 * commits — never its own commit. Protocol vocabulary: clients read it for
 * settledness (`waitForSettled`, testing.md §3) and sync indicators, the
 * serving loop writes it, so the id is defined once here. The document
 * value is {@link WatermarkDocValue}.
 */
export const SERVER_EXECUTION_WATERMARK_DOC_ID =
  "of:server-execution-watermark";

/** The watermark doc's value shape (protocol.md §4): W is ONE integer per
 * space — not per doc, not per piece, never vectorized. */
export type WatermarkDocValue = { seq: number };

/** The well-known SPACE-scoped discovery index for unresolved event delivery
 * attention. Entries are safe summaries only; the referenced stream entry is
 * authoritative and must be resolved before presenting recovery actions. */
export const SERVER_EXECUTION_ATTENTION_DOC_ID =
  "of:server-execution-attention";

/** Encode an attention-index map key without admitting JavaScript prototype
 * names. JSON string literals are injective for strings and always begin with
 * `"`, so dynamic stream and event identifiers remain ordinary own keys. */
export function eventAttentionIndexKey(value: string): string {
  return JSON.stringify(value);
}

/** Encode one immutable stream-entry identity for the attention index. Event
 * ids may be admitted again below the stream watermark, so the engine-stamped
 * sequence is the part that distinguishes two entries in the same stream.
 * Legacy seq-less entries use the protocol's sequence-zero identity. */
export function eventAttentionEntryKey(
  eventId: string,
  seq: number | undefined,
): string {
  return JSON.stringify([eventId, seq ?? 0]);
}

export type UnresolvedEventAttention = {
  eventId: string;
  seq: number;
  sidecarId: string;
  phase: DeliveryFailurePhase;
  failureClass: DeliveryFailureClass;
  code: DeliveryAttention["code"];
  firstFailureAt: number;
};

/** Durable idempotency record for a resolved attention entry. It survives
 * ordinary stream compaction so a caller replaying after a lost response gets
 * the recorded Retry/Dismiss winner instead of creating a second outcome. */
export type ResolvedEventAttention = {
  eventId: string;
  seq: number;
  sidecarId: string;
  principal: string;
  resolution: EventAttentionResolution;
};

export type EventAttentionIndexValue = {
  entries?: Record<string, Record<string, UnresolvedEventAttention>>;
  resolutions?: Record<string, Record<string, ResolvedEventAttention>>;
};

// Events-down (server-execution v2 Phase 3, D-v2-1;
// docs/specs/server-side-execution/events.md). The event is an AUTHORED
// APPEND to a stream document — the client's only computational commit
// under the flag. Protocol vocabulary, defined once here (protocol.md §7:
// `eventId`/`firedAt` are commit-metadata additions for event appends).

/**
 * The stream-entries SIDECAR doc id for one stream (events.md §1's "stream
 * document", concretely). A pattern's stream VALUE lives at a path inside
 * a piece's result doc, and that doc is derivation-owned — a result
 * recompute writes it wholesale, so durable event entries could never
 * live there. Each stream therefore gets ONE dedicated entries doc,
 * derived DETERMINISTICALLY from the stream's link (id + path + scope) so
 * every party — the firing client, the SpaceServer's drain, a foreign
 * space's outbox delivery — addresses the same doc with no coordination.
 * The sidecar IS the spec's stream document: `eventWatermark` is a field
 * on it (events.md §4), the dropped-event notice annotates its entries
 * (events.md §5 T7), and compaction trims it (§4's allowance).
 *
 * The id is content-derived (`hashStringOf` — type-tagged,
 * length-prefixed, deterministic across processes), so distinct streams
 * never collide and no component can impersonate another.
 */
export const STREAM_ENTRIES_DOC_PREFIX = "of:stream-events:";

/** The stream link a sidecar doc (and each of its entries) names: enough
 * to reconstruct the scheduler event link — `areNormalizedLinksSame`
 * compares id + space + scope + path, and space is implicit (the sidecar
 * lives in the stream's own space). */
export type StreamLinkRef = {
  id: EntityId;
  path: readonly string[];
  scope?: CellScope;
};

export const streamEntriesDocId = (stream: StreamLinkRef): EntityId =>
  `${STREAM_ENTRIES_DOC_PREFIX}${
    hashStringOf({
      id: stream.id,
      path: [...stream.path],
      scope: stream.scope ?? "space",
    })
  }`;

/**
 * `firedAt` — SERVER-STAMPED at admission (events.md §1, protocol.md §2):
 * `user` and `session` come from the authenticated commit envelope (or,
 * for delegated appends, the validated carried actor; for wave-carried
 * same-space entries, the inherited actor the one-trust-environment
 * derived commit wrote — LT1). `session` is the literal `"server"` for a
 * chain with no acting session. `clientSeq` is the ONLY client-minted
 * part: it orders one client session's own appends and steers nothing;
 * server-originated entries never carry it (LT7).
 */
export type StreamEventFiredAt = {
  user?: string;
  session: SessionId | "server";
  clientSeq?: number;
};

export type DeliveryFailurePhase =
  | "dispatch-load"
  | "commit-preparation"
  | "commit-finalization";

export type DeliveryFailureClass =
  | "session-revoked"
  | "connection"
  | "authorization"
  | "protocol"
  | "timeout"
  | "unknown";

/** Durable processing state for an event whose runnable handler has not yet
 * reached a provably safe consequence commit. Failed time is cumulative across
 * recovery attempts; `recovering` time is settlement and is not charged. */
export type DeliveryDeferral = {
  phase: DeliveryFailurePhase;
  failureClass: DeliveryFailureClass;
  firstFailureAt: number;
  lastFailureAt: number;
  accumulatedFailureMs: number;
  failureCount: number;
  activeFailureStartedAt?: number;
  state: "failed" | "recovering";
  recoveryEpoch?: string;

  /** Positive versioned producer evidence that this failure is permanent. */
  permanentEvidence?: true;
};

export type DeliveryAttention = {
  phase: DeliveryFailurePhase;
  failureClass: DeliveryFailureClass;
  code:
    | "delivery-failure-budget-exhausted"
    | "permanent-delivery-failure";
  firstFailureAt: number;
  lastFailureAt: number;
  accumulatedFailureMs: number;
  failureCount: number;
  recovery: "explicit-retry";
};

export type EventAttentionResolution =
  | { kind: "retried"; eventId: string }
  | { kind: "dismissed" };

/**
 * One durable event entry on a stream's sidecar doc (`value.entries[i]`).
 * `payload` is the only client-authored content field (events.md §1);
 * `seq` is ENGINE-STAMPED at apply time with the appending commit's seq —
 * the stream seq the idempotency rule keys on (events.md §4) — and
 * `firedAt` is server-stamped per the class of the admitting commit.
 * `consequenced`/`error`/`status`/`reason` and the OW54 delivery fields are
 * PROCESSING-side fields
 * written only by the space's SpaceServer as the event's consequence
 * (events.md §5: an error/drop IS the consequence); admission REFUSES an
 * incoming append that pre-supplies any of them.
 */
export type StreamEventEntry = {
  eventId: string;

  /** The stream this entry targets — self-describing so the drain, the
   * dropped-notice reader, and compaction never need a reverse map. */
  stream: StreamLinkRef;

  payload?: FabricValue;
  firedAt?: StreamEventFiredAt;

  /** Engine-stamped: the appending commit's seq. */
  seq?: number;

  /** Runtime-injection provenance for the payload's injected keys,
   * carried so the server-side handler run's closed-world gate judges
   * the payload as the firing client's runtime did (same in-process
   * trust as today's client-side enforcement). */
  runtimeInjectedEventKeys?: string[];

  /** The firing RUNTIME's attestation that the sent event was
   * RENDERER-TRUSTED — it carried the process-local renderer-trust mark
   * (`markRendererTrustedEvent`, set by the renderer's dispatch and
   * unreachable from pattern code) when the runtime appended it
   * (server-execution v2 fan-out stage B; the sister of
   * `runtimeInjectedEventKeys`, carried and re-minted with the same
   * in-process trust argument: the entry was committed under the firing
   * client's own admission, and the served dispatch re-marks the payload
   * so the served handler's UI-contract-gated write records the
   * trusted-event policy input the CFC ladder requires — verification-
   * coverage.md OW34). Set ONLY by the runtime, only when the mark was
   * present; a present value must be `true` (admission refuses any
   * other). Absent = not attested. */
  rendererTrusted?: true;

  /** Processing-side (SpaceServer-written): consequences committed. */
  consequenced?: boolean;

  /** Processing-side: the handler threw — the error IS the consequence
   * (events.md §5). */
  error?: string;

  /** Processing-side: how the entry ended, where it did not simply run.
   * `"dropped"` is the dropped-event notice (events.md §5 T7);
   * `"needs-attention"` has its detail in `attention` below. */
  status?: "dropped" | "needs-attention";

  /** The dropped-event notice's reason, the other half of
   * `{ status: "dropped", reason }` on the entry itself. */
  reason?: string;

  /** Processing-side checkpoint. It is not a consequence and advances no
   * watermark. Only the SpaceServer may write it. */
  deliveryDeferral?: DeliveryDeferral;

  /** Authoritative client-safe terminal detail for `needs-attention`. */
  attention?: DeliveryAttention;

  /** Server-owned resolution of an attention notice. */
  resolution?: EventAttentionResolution;

  /** Server-derived audit link on the one retry appended for an original
   * attention notice. Authored clients cannot supply it. */
  retryOf?: string;

  /** Processing-side (OW14, protocol.md §2b's LT4 ruling): failure
   * notices for CROSS-SPACE appends this event's handler emitted whose
   * DELIVERY was refused deterministically at the target — written by
   * the source SpaceServer's outbox BEFORE the refused row retires,
   * deduped by the refused append's eventId. The source event's own
   * consequences stand (they committed long before); this annotates
   * the entry per events.md §5's error-is-the-consequence shape. */
  deliveryFailures?: Array<{
    eventId: string;
    targetSpace: string;
    reason: string;
  }>;
};

/** The sidecar doc's value shape: the entry log plus the per-stream
 * processing watermark (events.md §4 — written only in the same derived
 * commit as the consequences it covers, never its own commit). */
export type StreamEventsDocValue = {
  entries?: StreamEventEntry[];
  eventWatermark?: number;
};

/**
 * One declared event append on a commit (protocol.md §2's authored
 * event-append row; §7's `eventId` envelope classification): names the
 * sidecar doc and the eventId so admission can locate the appended entry
 * in the commit's operations, run the dedupe-horizon CAS, and stamp
 * `firedAt` + `seq`. Carried on `ClientCommit` for client fires, on wave
 * batches for LT1 same-space carriage, and constructed server-side for
 * delegated deliveries — one stamping site, three identity sources
 * (protocol.md §2's three rows).
 */
export type EventAppendDecl = {
  /** The stream's sidecar doc ({@link streamEntriesDocId}). */
  id: EntityId;

  scope?: CellScope;
  eventId: string;
};

// The client-effect channel (server-execution v2 Phase 4;
// docs/specs/server-side-execution/protocol.md §5). Session-scoped,
// server-computed, client-enacted effects: the SpaceServer writes INTENT
// entries into the acting session's instance of the ONE well-known effects
// doc, the session's client enacts and ACKS by nonce (an ordinary authored
// write into its own instance), and the next wave retires acked entries.
// Protocol vocabulary, defined once here (the LD3 direction).

/**
 * The well-known client-effects doc, one id per space (protocol.md §5,
 * T9): the effects doc is a SESSION-SCOPED INSTANCE of this one doc id —
 * `scope_key = session:<principal>:<sessionId>` — never a path
 * convention. The SpaceServer writes intents into the acting session's
 * instance by naming that key (seal-time addressing annotations); the
 * session's own client resolves the same instance from its authenticated
 * session and never names a key. The document value is
 * {@link SessionEffectsDocValue}. Session-lifetime: a retired session's
 * unacked intents retire with its effects instance under the SAME
 * session-data GC as every other session instance (scopes.md §3).
 */
export const SERVER_EXECUTION_EFFECTS_DOC_ID = "of:server-execution-effects";

/** The navigation target an intent carries (builtins.md §4): an entity
 * link. `space` is absent for a target within the computing space (the
 * common case). A cross-space TARGET is legal — LT3 defers the
 * cross-space CONTEXT (the acting session must be connected to the
 * COMPUTING space), not the destination: "the CONTEXT is same-space
 * even when the navigation TARGET is a cross-space link". */
export type EffectIntentTarget = {
  space?: string;
  id: EntityId;
  path: readonly string[];
  scope?: CellScope;
};

/**
 * One client-effect intent entry (protocol.md §5's shape): `{ nonce,
 * kind, args, issuedIn }`. v2 ships exactly ONE kind — `navigate` — and
 * a new kind is a protocol.md §5 spec edit first.
 *
 * `nonce` is minted server-side as a DETERMINISTIC function of the
 * firing event and the navigateTo instance ({@link effectIntentNonce}),
 * which is what lets the client's OPTIMISTIC enactment (speculation.md
 * §2's local enact) predict the same nonce and converge on the
 * authoritative intent without re-enacting — exactly-once per nonce is
 * the CLIENT's duty (T2.Q2/Q7).
 *
 * `issuedIn` is the derived commit seq that issued the intent —
 * ENGINE-STAMPED at apply time (the stream-entry `seq` precedent): the
 * producer writes the `null` sentinel (the wave's own seq is allocated
 * only at the commit step), and the engine stamps derived-class writes
 * of this doc. Informational: nothing in the ack/retirement lifecycle
 * reads it.
 */
export type EffectIntentEntry = {
  nonce: string;
  kind: "navigate";
  args: { target: EffectIntentTarget };
  issuedIn: number | null;
};

/**
 * The effects doc's value shape (protocol.md §5): the intent append-list
 * plus the session's ack marks. The ACK is an ordinary AUTHORED write by
 * the owning session into its own instance — `acks[nonce] = true`, one
 * mark per nonce so concurrent acks of distinct intents never overwrite
 * each other (ack-by-nonce is once-per-nonce; a scalar last-ack field
 * would lose an earlier unretired ack under two quick intents). The
 * SpaceServer's next-wave retirement removes acked entries AND their
 * marks in one bookkeeping-stamped write (serving-loop.md §3d).
 */
export type SessionEffectsDocValue = {
  entries?: EffectIntentEntry[];
  acks?: Record<string, true>;
};

/**
 * THE nonce constructor (protocol.md §5; T2.Q2's "nonce minted
 * server-side" with T2.Q7's convergence): deterministic over the firing
 * event's durable id and the navigateTo instance's cause-derived result
 * doc id. Both sides compute it — the SERVED half when it writes the
 * intent, the client's SPECULATIVE run when it optimistically enacts —
 * so the optimistic enactment carries the same nonce the authoritative
 * intent arrives with (result-as-pattern children converge by
 * cause-derived identity, speculation.md §2; the instance id is that
 * convergence). One event × one navigateTo instance ⇒ one nonce, so a
 * re-run of either side is idempotent by presence check, in either
 * order: the side that enacts second finds the nonce recorded and
 * stands down.
 */
export const effectIntentNonce = (
  eventId: string,
  instanceId: string,
): string => `nav:${hashStringOf({ eventId, instance: instanceId })}`;

/**
 * Inspect half for instance keys (the retirement writer's parse): the
 * {@link ScopeKeyIdentity} embedded in a `user:`/`session:` scope key,
 * or undefined for `space` and malformed keys. The segments are
 * encodeURIComponent-encoded, so `:`-splitting is exact
 * (key-vocabulary.md §Anchors).
 */
export const identityOfScopeKey = (
  scopeKey: string,
): ScopeKeyIdentity | undefined => {
  if (scopeKey.startsWith("session:")) {
    const parts = scopeKey.split(":");
    if (parts.length !== 3) return undefined;
    try {
      return {
        principal: decodeURIComponent(parts[1]),
        sessionId: decodeURIComponent(parts[2]),
      };
    } catch {
      return undefined;
    }
  }
  if (scopeKey.startsWith("user:")) {
    const part = scopeKey.slice("user:".length);
    if (part.length === 0) return undefined;
    try {
      return { principal: decodeURIComponent(part) };
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * The identity annotation on one write WITHIN a derived-class commit's body
 * (protocol.md §1's transaction identity model, §7's closed metadata list).
 * The wave's envelope carries the SpaceServer's service identity — no user
 * principal, no session — so the identity the envelope can no longer
 * express rides here, per write, at action-run granularity. Two distinct
 * things, never conflated:
 *
 * - ADDRESSING — `scopeKey`, the explicit instance a scoped write lands
 *   in. The engine keys rows by it; admission REQUIRES it on every scoped
 *   write of a derived commit (a service envelope has no session for
 *   `resolveScopeKey` to derive a key from, and silently resolving
 *   `user:<serviceDID>` is the empty-instance trap protocol.md §2 exists
 *   to prevent).
 * - ATTRIBUTION — `actingUser`/`actingSession`, the acting identity of the
 *   action RUN that produced the write (`action × instance`, never the
 *   action). Recorded, not read: no enforcement path consumes it today
 *   (protocol.md §1 — audit/forensics, and the anticipated signature
 *   graduation).
 *
 * Server-internal carriage like `commitClass` and `holder`: `ClientCommit`
 * cannot express annotations, and no session-facing path supplies them.
 * Defined once here in the wire-shape module beside `CommitClass` so the
 * engine and the runner's wave machinery share one shape (the LD3
 * direction; stage E moves the full scope_key format here too).
 */
export type DerivedWriteAnnotation = {
  /** Index into the commit's operations array. */
  op: number;

  scopeKey?: string;
  actingUser?: string;
  actingSession?: string;
};

export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type DocumentPath = readonly string[] & {
  readonly __memoryV2DocumentPath: unique symbol;
};
export type ValuePath = readonly string[] & {
  readonly __memoryV2ValuePath: unique symbol;
};
export type ReadPath = DocumentPath;
export type DocumentSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: DocumentPath };
export type ValueSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: ValuePath };

/**
 * A logical stored document. Today the system only produces and consumes the
 * `value` field; `source` and any additional metadata fields are reserved for
 * future use and carried as opaque payload (a document is validated merely as
 * "an object" — see {@link isEntityDocument}).
 */
export type EntityDocument = {
  value?: FabricValue;
  source?: EntityRef;
  [key: string]: FabricValue;
};

export type Blob = {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
};

export type PatchOp =
  | { op: "replace"; path: string; value: FabricValue }
  | { op: "add"; path: string; value: FabricValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | {
    op: "splice";
    path: string;
    index: number;
    remove: number;
    add: FabricValue[];
  }
  // A tail-relative append: `values` are inserted at the array's current tail,
  // with the array (and the path to it) created if absent. Carries no index, so
  // concurrent appends merge against durable state rather than clobbering via a
  // position computed from a stale base. `createsKey` — see below.
  | { op: "append"; path: string; values: FabricValue[]; createsKey?: true }
  // Set-add by identity: each of `values` is appended at the tail only if no
  // existing element of the array equals it (by stored-value equality), with the
  // array created if absent. Idempotent and commutative, so concurrent adds of
  // distinct elements merge and a repeated add is a no-op against durable state.
  | { op: "add-unique"; path: string; values: FabricValue[]; createsKey?: true }
  // Remove every element of the array at `path` that equals `value` by
  // stored-value equality. Idempotent (removing an absent value is a no-op) and
  // resolved against durable state, so it merges with concurrent writes instead
  // of clobbering via a whole-array rewrite. For a list of links this removes
  // the membership entry by its (deterministic) link, without reading the list.
  | { op: "remove-by-value"; path: string; value: FabricValue }
  // Numeric increment: `by` (which may be negative) is added to the number at
  // `path`, treating an absent value as 0 and creating the path if absent.
  // Applied against durable state, so concurrent increments sum rather than
  // clobber via last-write-wins. `createsKey` — see below.
  | { op: "increment"; path: string; by: number; createsKey?: true };

// `createsKey` (append / add-unique / increment): set by the writer when the op
// MATERIALIZES a previously-absent path — its own transaction base held no value
// at `path`, so applying it adds `path`'s last segment as a key to the parent
// container. It does not change how the op applies (these ops already
// create-if-absent); it tells the conflict matcher to invalidate a shape-only
// (nonRecursive) reader of the parent, whose key set changed. Absent/false means
// the target already existed, so only its value changed and no parent shape
// reader need conflict. The writer's base is authoritative for "never miss a
// genuine conflict": the first commit that creates a key necessarily saw it
// absent and sets the flag; a later append to the now-present key does not. A
// stale base can only set the flag when the key already existed durably, which
// over-conflicts a parent shape reader conservatively (an extra retry), never
// missing one. See docs/specs/memory-v2/08-conflict-granularity.md.

export type SetOperation = {
  op: "set";
  id: EntityId;
  scope?: CellScope;
  value: EntityDocument;
};

export type PatchOperation = {
  op: "patch";
  id: EntityId;
  scope?: CellScope;
  patches: PatchOp[];
};

export type DeleteOperation = {
  op: "delete";
  id: EntityId;
  scope?: CellScope;
};

export type OpCursor = {
  epoch: number;
  version: number;
};

export const CODEMIRROR_CHANGESET_CODEC = "codemirror-changeset@1";

export type OperationFieldAddress = {
  id: EntityId;
  scope?: CellScope;
  path: ValuePath;
};

export type ApplyOpOperation = OperationFieldAddress & {
  op: "apply-op";
  codec: string;
  submissionId: string;
  base: OpCursor | null;
  baselineHash?: string;
  payload: FabricValue;
};

export type ReleaseOpFieldOperation = OperationFieldAddress & {
  op: "release-op-field";
  codec: string;
  cursor: OpCursor;
};

export type IntegratedOperation = {
  opId: string;
  cursor: OpCursor;
  submissionId: string;
  payload: FabricValue;
};

export type ApplyOpResolution = {
  operationIndex: number;
  address: OperationFieldAddress & {
    branch: BranchName;
    scopeKey: string;
  };
  codec: string;
  submissionId: string;
  from: OpCursor;
  to: OpCursor;
  operations: IntegratedOperation[];
  duplicate: boolean;
};

export type OperationFieldQuery = OperationFieldAddress & {
  branch?: BranchName;
  after?: OpCursor;
  principal?: string;
  sessionId?: SessionId;
};

export type OperationFieldSnapshot = OperationFieldAddress & {
  branch: BranchName;
  scopeKey: string;
  active: boolean;
  codec: string | null;
  cursor: OpCursor | null;
  baselineHash: string;
  materialized: FabricValue;
  operations: IntegratedOperation[];

  /** Lowest cursor from which the retained integrated suffix is contiguous. */
  retainedFrom?: OpCursor;

  /** Replace local codec state from `materialized` before continuing. */
  reset?: boolean;
};

/**
 * A SQLite write folded into the commit, applied inside the same transaction as
 * the cell ops (atomic). It is NOT an entity revision — it has no `id` and never
 * enters the revision/head/snapshot/dirty machinery (see SqliteDbRef below /
 * docs/specs/sqlite-builtin/plans/atomic-writes.md).
 */
export type SqliteOperation = {
  op: "sqlite";
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
};

export type Operation =
  | SetOperation
  | PatchOperation
  | DeleteOperation
  | ApplyOpOperation
  | ReleaseOpFieldOperation
  | SqliteOperation;

export type ConfirmedRead = {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchName;
  path: ReadPath;
  seq: number;

  /**
   * When true, this is a SHALLOW (shape-only) read — the reader observed the
   * container at `path` (its key set / existence) but did NOT depend on the deep
   * values of its descendants. The engine then conflicts only with writes
   * AT-OR-ABOVE `path` (including key add/remove, whose patch injects the parent
   * path), not with disjoint deep-value writes strictly below `path`. Strict
   * subset of the recursive overlap ⇒ never a false-negative. Absent/false ⇒
   * recursive read (the historical behavior).
   */
  nonRecursive?: boolean;
};

export type PendingRead = {
  id: EntityId;
  scope?: CellScope;
  path: ReadPath;

  /**
   * The reader's pending-stack dependency set for this document. An array
   * lists EVERY pending layer the read's materialized view sat on; each
   * element must have resolved to an accepted commit for this commit to be
   * applicable, and the staleness (conflict) check runs exactly once, from
   * the basis the server selects (03-commit-model.md §3.6.3): the declared
   * `basisSeq` when present, else the resolution of the HIGHEST element —
   * the document's top-of-stack layer below the reader, which the array
   * MUST include. A scalar is the degenerate single-layer form (also what
   * pre-`pendingReadStacks` peers emit: top-of-stack only, carrying no
   * lower-layer dependencies).
   */
  localSeq: number | number[];

  /**
   * The reader's confirmed basis for THIS document, in the SERVER's
   * space-log seq space (an accepted-commit `seq`, NOT the session's
   * localSeq space): the seq of the last accepted write to this document
   * that the client's confirmed view reflected at build time, or 0 for a
   * document its subscriptions never covered.
   *
   * When present, the staleness scan covers the FULL interval
   * `(basisSeq, head]`, excluding only the own-session layers this read's
   * `localSeq` array NAMES — the accepted layers whose inclusion in the
   * reader's materialized view the array attests. Any own write the array
   * does not name conflicts like a foreign write: a higher localSeq
   * accepted first (out-of-order submission), or an omitted layer whose
   * write is durably integrated — so the server verifies that `basisSeq`
   * plus the named layers fully account for the document's durable history
   * at the read path, rather than trusting client discipline. (What it
   * cannot verify is the phantom direction: an omitted REJECTED
   * contributor left nothing durable to compare against — that stays in
   * the fabricated-read trust class.) This is
   * the CT-1910 repair
   * (`PendingStacks_Repaired.cfg` certifies it); when absent (a legacy
   * client), staleness is based at the HIGHEST dependency's resolution seq,
   * whose known unsoundness is recorded against INV-1 in
   * docs/specs/memory-v2/09-invariants.md.
   */
  basisSeq?: number;

  /** See {@link ConfirmedRead.nonRecursive}. */
  nonRecursive?: boolean;
};

export type CommitPrecondition =
  | {
    kind: "origin-committed";

    /** localSeq of a commit from the SAME session in this space. */
    originLocalSeq: number;
  }
  | {
    kind: "entity-absent";
    id: EntityId;
    scope?: CellScope;
  }
  /** Security-critical exact value pin, including null for absent/deleted. */
  | {
    kind: "entity-value-hash";
    id: EntityId;
    scope?: CellScope;
    valueHash: string | null;
  };

/** A generic root reserved atomically with a fresh space's ACL. */
export type GenesisRoot = {
  source: string;
  sourceRoots?: string[];
  cause: string;
  argument?: Record<string, FabricValue>;
};

export type ClientCommit = {
  genesisRoot?: GenesisRoot;
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  preconditions?: CommitPrecondition[];
  codeCID?: Reference;
  branch?: BranchName;
  merge?: {
    sourceBranch: BranchName;
    sourceSeq: number;
    baseBranch: BranchName;
    baseSeq: number;
  };

  /** Server-execution v2 Phase 3 (events.md §1): the commit's declared
   * event appends. Only flag-ON clients produce this; admission under
   * the flag runs the dedupe-horizon CAS and stamps `firedAt` + `seq`
   * into the appended entries ({@link EventAppendDecl}). Refused when
   * the flag is off. */
  eventAppends?: EventAppendDecl[];
};

export type SessionOpenResult = {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: SessionOpenAuthMetadata;
};

export type MemoryProtocolFlags = {
  genesisRoot?: boolean;
  modernCellRep: boolean;

  /**
   * Expression result stores are keyed on their owning piece and output spot.
   * Servers require this marker when admitting a session; clients require it
   * from servers so incompatible writers cannot share their computed cells.
   */
  stableExpressionResultIds: boolean;

  commitPreconditions: boolean;

  /** The server integrates durable collaborative operation streams. */
  applyOp: boolean;

  /** Versioned operation codecs registered by this server build. */
  operationCodecs?: readonly string[];

  /** Hash-keyed per-frame schema table. */
  syncSchemaTableV2: boolean;

  /** The peer can exchange versioned binary gzip message envelopes. */
  messageCompressionV1: boolean;

  /**
   * Server capability (CFC Phase 3.c): commit-folded `sqlite` writes to
   * rule-bearing tables are re-derived through the shared row-label evaluator
   * against the committed rows, rolling back on violation (see
   * `v2/sqlite/commit-eval.ts`). The RUNNER keys its write-gate relaxation for
   * the non-attributable shapes (INSERT…SELECT, upsert, columnless INSERT,
   * rule-input UPDATE) on the SERVER advertising this — an old server that
   * never evaluates keeps a new runner failing closed. Inherent to the build
   * (not configuration), so a server of this version always advertises it.
   */
  sqliteCommitRowLabelEval: boolean;

  /** SQLite queries authorize the carried reader and select its scoped database. */
  sqliteQueryReader?: boolean;

  /**
   * Server capability (CT-1872 1c): pending reads may carry an ARRAY
   * `localSeq` naming every pending layer the read sat on (resolution
   * required for each element; staleness based at the highest — see
   * `PendingRead.localSeq`). A client that sees this absent (an older
   * server) falls back to scalar top-of-stack emission, and MUST hold each
   * such send until every omitted lower dependency has settled — otherwise
   * the old server could durably accept a commit the client cascade-rejects
   * (03-commit-model.md §3.5). Inherent to the build, so a server of this
   * version always advertises it.
   */
  pendingReadStacks: boolean;

  /**
   * Server capability (CT-1927): the server stages a `caughtUpLocalSeq`
   * catch-up obligation for every accept and every conflict rejection —
   * other rejection kinds carry none — so the batched fan-out's next frame to the
   * committing session carries a marker covering the verdict (an
   * otherwise-empty frame if nothing it watches is dirty). The CLIENT keys
   * verdict parking on this: it holds an accepted commit's promotion
   * (pending overlay to confirmed mirror) until the marker covers it, so
   * promotion extrapolates over a base reflecting the foreign novelty the
   * accept was applied on top of. A client that sees this absent (an older
   * server that stamps markers only for conflicts) applies verdicts
   * immediately, as before. Inherent to the build, so a server of this
   * version always advertises it.
   */
  verdictCatchUpMarkers: boolean;

  /** The server can list live space-scoped entity identifiers without values. */
  entityIdListing: boolean;

  /** The server can page one stable entity-identifier snapshot. */
  entityIdPagination: boolean;

  /** The server can test one entity identifier without loading its value. */
  entityIdLookup: boolean;

  /**
   * The server diffs a reconnecting client's delivery against the client's
   * DECLARED holdings — the `holdings` a resuming `session.open` and a
   * re-establishing `session.watch.set` may carry (04-protocol.md §4.1.2,
   * §4.3.5) — instead of against its own per-session delivery memory or
   * from nothing. Inherent to the build, so a server of this version always
   * advertises it. A client that sees it absent splits by consumer
   * (04-protocol.md §4.1.1): a session with no holdings provider declares
   * nothing and keeps the declaration-less paths (a resumed session diffed
   * against the server's memory of it, a fresh one delivered in full),
   * while a provider-bearing session connects initially but terminates at
   * restore rather than silently rejoining those paths
   * (`SpaceSession.restore`).
   */
  sessionHoldings: boolean;

  /** Server-selected view delivery with independent execution demand. */
  viewScopedReplicationV1?: boolean;

  /**
   * Server capability: a `session.open` descriptor's `readCeiling` is
   * recorded on the session and served runs as that session read under it.
   * Build-inherent, so a server of this version always advertises it. A
   * client carrying a ceiling REQUIRES it: an older server would accept the
   * descriptor and serve every query unbounded, so absent parses to false
   * and the client refuses to open the session.
   */
  sessionReadCeiling?: boolean;
};

/**
 * Wire-format flags object.
 */
export type WireMemoryProtocolFlags = {
  genesisRoot?: boolean;
  modernCellRep?: boolean;

  /** Expression result identity contract required for session admission. */
  stableExpressionResultIds?: boolean;

  commitPreconditions?: boolean;
  applyOp?: boolean;
  operationCodecs?: readonly string[];
  syncSchemaTableV2?: boolean;
  messageCompressionV1?: boolean;
  sqliteCommitRowLabelEval?: boolean;
  sqliteQueryReader?: boolean;
  pendingReadStacks?: boolean;
  verdictCatchUpMarkers?: boolean;
  entityIdListing?: boolean;
  entityIdPagination?: boolean;
  entityIdLookup?: boolean;
  sessionHoldings?: boolean;
  viewScopedReplicationV1?: boolean;
  sessionReadCeiling?: boolean;
};

export type HelloMessage = {
  type: "hello";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
};

export type HelloOkMessage = {
  type: "hello.ok";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
  sessionOpen?: SessionOpenAuthMetadata;
};

export type SessionOpenChallenge = {
  value: string;
  expiresAt: number;
};

export type SessionOpenAuthMetadata = {
  challenge: SessionOpenChallenge;
  audience: string;
};

export type SessionDescriptor = {
  /** Assert the immutable custom-root reservation when mounting or resuming. */
  genesisRoot?: GenesisRoot;
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;

  /**
   * The read ceiling every `db.query` served for this session reads under
   * (`docs/specs/sqlite-builtin/06-cfc.md`, "Runtime read ceiling";
   * server-side execution `protocol.md` §1). A client runtime under server
   * execution executes no query of its own — the space server's runtime
   * serves them — so the ceiling it is configured with travels here, once,
   * with the session, and the serving runtime stamps it onto every run it
   * serves AS this session. Signed into the session.open invocation with the
   * rest of this descriptor. Fresh per open, never inherited by a resume: a
   * client that resumes re-declares it. Admitted only by a server
   * advertising `sessionReadCeiling`; a client with one refuses a server
   * without it rather than opening a session whose reads nothing bounds.
   */
  readonly readCeiling?: SessionReadCeiling;

  /**
   * The session-level delegated READ binding (OW31, READ side RULED
   * 2026-08-19: the service identity reads a space's ACL only; every
   * other served read runs under the acting USER's identity). A session
   * opened with `actingAs: "space-owner"` by a principal in the memory
   * ACL's DELEGATING class (`acl.delegatingDids` — under the flag, the
   * co-hosted process identity; the LT5 trust footing of the write
   * plane's carried actors) has its READ-class capability decisions
   * resolved as the space's ACL OWNER — the user whose space it is —
   * which the server resolves itself from the ACL (the ruled
   * service-identity ACL read). WRITE/OWNER-class requirements keep
   * resolving against the ENVELOPE principal: the binding grants no
   * write path (served writes ride the wave's §2b delegated carriage).
   * A non-delegating principal sending the marker is refused. Spaces
   * with no valid concrete-owner ACL bind nothing (today's rules
   * apply). Signed into the session.open invocation with the rest of
   * this descriptor.
   */
  actingAs?: "space-owner";
};

/**
 * One document a reconnecting client declares it HOLDS — the client's own
 * statement of its replica, in exactly the terms the server's delivery
 * diff compares (`sameSnapshot`: id, scope instance, seq, deletedness),
 * so the server can rebuild the diff base from the client rather than
 * from its own memory of the session. `scope` names the scope; the
 * instance resolves from the session's identity as it does for every
 * wire frame (protocol.md §1). `seq` is the server seq of the covering
 * commit the client has confirmed for the document; `deleted` marks a
 * known tombstone at that seq. `branch` names the branch the holding is of
 * (absent = the default branch): the diff keys by branch, so a same-id
 * document on another branch is a different holding and never stands in
 * for this one. A document the client does not list is one it does not
 * hold, whatever the server remembers delivering.
 */
export type SessionHolding = {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchName;
  seq: number;
  deleted?: true;
};

export type SessionOpenRequest = {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
  invocation?: FabricPlainObject;
  authorization?: FabricValue;

  /**
   * The client's declared holdings for this space (see
   * {@link SessionHolding}), sent when RESUMING a session. A server that
   * resumes the session replaces its per-session delivery memory with
   * these before computing the catch-up frame, so the frame re-delivers
   * whatever the client does not hold — a document the server remembers
   * sending but the client failed to absorb, or lost with a replaced
   * replica — and elides what it does. Outside the signed descriptor:
   * it shapes only what this session is re-sent, never what it may read.
   */
  holdings?: SessionHolding[];
};

export type GraphQueryRoot = {
  id: EntityId;
  scope?: CellScope;

  /**
   * The explicit scope INSTANCE this read names (protocol.md §2's read
   * row; the read half of §1's transaction identity model, ledger LD5).
   * The ONE read-side addition to the wire: admissible only for a live
   * lease holder on the co-hosted memory server — a non-holder naming one
   * is REJECTED — and a read naming none resolves from the authenticated
   * session as today (the shared `resolveScopeKey`). Exists because a
   * SpaceServer reading under its service envelope would otherwise
   * silently resolve `user:<serviceDID>` — an empty instance, not an
   * error (the silent-empty-instance trap).
   */
  entityScopeKey?: ScopeKey;

  selector: SchemaPathSelector;
};

export type GraphQuery = {
  roots: GraphQueryRoot[];
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
};

export type EntitySnapshot = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;

  /**
   * The scope INSTANCE this snapshot is of (server-execution v2 stage A,
   * OW17's wire leg): present ONLY in responses to a lease-holder session
   * that named explicit instances (`GraphQueryRoot.entityScopeKey`), so
   * two instances of one (branch, id, scope) — which such a session may
   * legitimately hold at once — stay distinguishable. Every other
   * session's responses carry scope NAMES only and resolve instances from
   * their own identity as always (protocol.md §1); the OFF-arm wire is
   * byte-identical.
   */
  scopeKey?: ScopeKey;

  seq: number;
  document: EntityDocument | null;

  /** As on {@link SessionSyncUpsert}: the covering commit's class,
   * populated only under the server-execution flag and only for
   * `seq > 0` (a seq-0 snapshot has no covering commit). */
  coverClass?: CommitClass;
};

export type GraphQueryResult = {
  serverSeq: number;
  entities: EntitySnapshot[];
};

export type EntityIdListResult = {
  serverSeq: number;
  ids: EntityId[];
  nextAfter?: EntityId;
};

/** Maximum number of entity identifiers carried by one protocol response. */
export const MAX_ENTITY_ID_PAGE_SIZE = 1_000;

export type EntityIdListOptions = {
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupResult = {
  serverSeq: number;
  exists: boolean;
};

export type QueryWatchSpec = {
  id: string;
  kind: "query";
  query: GraphQuery;
};

export type GraphWatchSpec = {
  id: string;
  kind: "graph";
  query: GraphQuery;
};

export type OperationWatchSpec = {
  id: string;
  kind: "operation";
  query: Omit<OperationFieldQuery, "principal" | "sessionId">;
};

export type WatchSpec = QueryWatchSpec | GraphWatchSpec | OperationWatchSpec;

export type OperationFieldDelivery = {
  watchId: string;
  field: OperationFieldSnapshot;
};

export type SessionSyncUpsert = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;

  /**
   * The scope INSTANCE this upsert is of (server-execution v2 stage A,
   * OW17's wire leg — the ONE write-side addition to the frame shape).
   * Populated ONLY on frames to a session whose lease-holder read
   * exemption is live (`SessionState.leaseHolderReads`, armed by an
   * admitted `entityScopeKey` read — protocol.md §2's read row): that
   * session legitimately receives EVERY instance it serves, including
   * two instances of one (branch, id, scope), which the scope NAME alone
   * cannot distinguish. Every other session's frames carry names only
   * and resolve instances from their own identity as always
   * (protocol.md §1, §3); the OFF-arm wire is byte-identical.
   */
  scopeKey?: ScopeKey;

  seq: number;
  doc?: EntityDocument;
  deleted?: true;

  /**
   * The commit CLASS of the covering commit — the commit whose write
   * produced this snapshot's `seq` (`commit.seq` is unique, and every
   * revision's seq IS its commit's seq, so the seq names exactly one
   * commit). Consumed by the speculation overlay's arrival-witness
   * predicate (speculation.md §4, RULED 2026-08-22): a cover AT an
   * entry's floor witnesses the authoritative derivation's arrival only
   * when it is derived-class — an authored structure write at the floor
   * is the entry's own setup, not the derivation. Populated only under
   * the server-execution flag; absent on the OFF arm (the OFF wire is
   * byte-identical), on pre-predicate servers, and on `seq: 0` entries
   * (no covering commit). Absence reads as "class unknown", which never
   * witnesses arrival at the floor.
   */
  coverClass?: CommitClass;
};

export type SessionSyncRemove = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;

  /** As on {@link SessionSyncUpsert}: the instance, lease-holder frames only. */
  scopeKey?: ScopeKey;
};

export type SessionSync = {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  caughtUpLocalSeq?: number;
  upserts: SessionSyncUpsert[];
  removes: SessionSyncRemove[];
  operationFields?: OperationFieldDelivery[];

  /** Complete view eligibility, applied atomically after this frame's documents. */
  viewPlans?: ViewPlan[];
};

/** Local execution eligibility for one current renderer interest. */
export type ViewPlan = {
  id: string;
  revision: number;
  generation: number;
  eligibleActions: string[];
  pieces: { id: string; scope: CellScope; patternIdentity?: string }[];
  /** Settled execution failures upstream of this rendered view. */
  errors?: ViewExecutionError[];
  /** Complete documents admitted as inputs, independently of other watches. */
  inputs?: { id: string; scope: CellScope }[];
  /** Observed writers and the settled bases of their transitive inputs. */
  producers?: {
    id: string;
    writes: { id: string; scope: CellScope; path: string[] }[];
    basis?: {
      reads: ViewValueBasis[];
      outputs: ViewValueBasis[];
    };
  }[];
};

/** A serving failure selected under the viewing session's identity. */
export type ViewExecutionError = {
  nodeId: string;
  pieceId: string;
  message: string;
  stack?: string;
  patternId?: string;
  spellId?: string;
};

/** An observed path value, including absence and path reachability. */
export type ViewValueBasis = {
  id: string;
  scope: CellScope;
  path: string[];
  fingerprint: string;
};

export type WatchSetResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type WatchAddResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type SessionAckResult = {
  serverSeq: number;
};

export type TransactRequest = {
  type: "transact";
  requestId: string;
  space: string;
  sessionId: SessionId;
  commit: ClientCommit;
};

export type GraphQueryRequest = {
  type: "graph.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  query: GraphQuery;
};

export type OperationFieldQueryResult = {
  serverSeq: number;
  field: OperationFieldSnapshot;
};

export type OperationFieldQueryRequest = {
  type: "op.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  query: Omit<OperationFieldQuery, "principal" | "sessionId">;
};

export type EntityIdListRequest = {
  type: "entity-id.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupRequest = {
  type: "entity-id.exists";
  requestId: string;
  space: string;
  sessionId: SessionId;
  id: EntityId;
};

//
// SQLite builtins (docs/specs/sqlite-builtin)
//

/** Wire form of SQLite bind parameters. */
export type SqliteParamsWire =
  | ReadonlyArray<FabricValue>
  | Record<string, FabricValue>;

/** Key-safe transport for named SQLite parameters whose names are reserved by
 * the Fabric object codec. Mutually exclusive with `params` on a query. */
export type SqliteNamedParamsWire = Array<[string, FabricValue]>;

/** Reference to a cell-derived SQLite database: an opaque id (the handle cell's
 *  entity id) plus the declared table schemas (for additive create/migrate).
 *
 *  `scope` is the SqliteDb cell's declared scope (space/user/session). The
 *  server folds it (with the request's principal / session id) into the on-disk
 *  filename so a `user`/`session`-scoped db gets a per-user / per-session file;
 *  `space` (or absent) keeps the original unqualified name. */
export type SqliteDbRef = {
  id: string;
  tables?: Record<string, FabricValue>;
  scope?: CellScope;

  /** The db's owner — the principal that created the SqliteDb cell. Resolves
   *  the per-row label rule's `dbOwner()` term (CFC Phase 3); a FIXED db
   *  property, captured once at handle creation, never the acting reader. */
  owner?: string;
};

/** Whether `value` is a SQLite db handle. The `id` is the whole of the test:
 *  it is the one field every consumer needs and the one the runner's own
 *  handle read validates, and the rest of the shape is optional. Shared so
 *  that a reader deciding "is this a database?" and the runner deciding "may
 *  I query it?" cannot drift apart. */
export function isSqliteDbRef(value: unknown): value is SqliteDbRef {
  return !!value && typeof value === "object" &&
    typeof (value as SqliteDbRef).id === "string";
}

/** A reader carried by a trusted serving principal for a SQLite query. */
export type SqliteQueryReader = ScopeKeyIdentity & { principal: string };

export type SqliteQueryRequest = {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
  namedParams?: SqliteNamedParamsWire;
  reader?: SqliteQueryReader;
};

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export type SqliteResultColumn = {
  output: string;
  table: string | null;
  column: string | null;
};

/** Whether a column's `ifc` annotation is present and non-empty — the single
 *  predicate for "this column participates in CFC labeling". Shared by the
 *  server's declares-ifc gate (which decides whether to capture column origins)
 *  and the runner's per-column label schema, so the two can't drift. */
export function columnDeclaresIfc(ifc: unknown): boolean {
  return !!ifc && typeof ifc === "object" && Object.keys(ifc).length > 0;
}

/** Whether a table schema carries a per-row label rule (CFC Phase 3). */
export function tableDeclaresRowLabel(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  const spec = (table as { rowLabel?: unknown }).rowLabel;
  return !!spec && typeof spec === "object";
}

/** Whether a read of this db needs sound per-result-column provenance for CFC
 *  labeling: any column declares `ifc` (Phase 2) OR any table declares a
 *  per-row label rule (Phase 3 — the rule's input columns are located by TRUE
 *  origin, never output name). The single gate shared by the server (capture
 *  origins) and the runner (expect them), so the two can't drift. Unlabeled
 *  dbs — the common case — return false and pay nothing. */
export function dbNeedsColumnProvenance(
  tables: Record<string, unknown> | undefined,
): boolean {
  if (tables === undefined) return false;
  for (const table of Object.values(tables)) {
    if (tableDeclaresRowLabel(table)) return true;
    const props = (table as { properties?: Record<string, unknown> })
      ?.properties;
    if (!props) continue;
    for (const col of Object.values(props)) {
      if (columnDeclaresIfc((col as { ifc?: unknown })?.ifc)) return true;
    }
  }
  return false;
}

/** A native SQLite result row. Column names are arbitrary SQLite aliases,
 *  including names that the Fabric object domain reserves. Values remain
 *  Fabric values, but the row object itself is not a `FabricPlainObject`. */
export type SqliteNativeRow = Record<string, FabricValue>;

export type SqliteQueryResult = {
  rows: SqliteNativeRow[];

  /** Per-result-column origin, present ONLY when the db needs provenance for
   *  CFC labeling — any column declares `ifc` (Phase 2) or any table declares
   *  a per-row label rule (Phase 3); see `dbNeedsColumnProvenance`. An aliased
   *  or joined column maps back to its declared `(table, column)`. Undefined
   *  otherwise, so unlabeled queries pay nothing. */
  columns?: SqliteResultColumn[];
};

/** A SQLite row as carried by the memory protocol. Ordinary rows retain the
 * object representation accepted by older clients. Rows whose column names
 * are unsafe object keys use entries so the JSON codec can carry them without
 * losing or rejecting a legal SQLite alias. */
export type SqliteRowWire =
  | SqliteNativeRow
  | Array<[string, FabricValue]>;

/** The transport form of a SQLite query result. */
export type SqliteQueryWireResult = {
  rows: SqliteRowWire[];
  columns?: SqliteResultColumn[];
};

/** Convert a native query row to the backward-compatible memory wire form. */
export function sqliteRowToWire(row: SqliteNativeRow): SqliteRowWire {
  return unsafeObjectKeyIn(row) === undefined ? row : Object.entries(row);
}

/** Reconstruct a query row after it crosses the memory protocol. */
export function sqliteRowFromWire(row: SqliteRowWire): SqliteNativeRow {
  return Array.isArray(row) ? Object.fromEntries(row) as SqliteNativeRow : row;
}

// NOTE: there is no `sqlite.execute` write verb. Writes go through the commit
// fold (a `sqlite` op inside `transact`, applied atomically with cell ops by the
// engine) — never a standalone, non-atomic write RPC. See db.exec in the runner.

/**
 * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
 * link <piece> <field> sqlite:<absPath>` issues this so the server attaches the
 * given file (read-only) for the handle id instead of the cell-derived path. The
 * descriptor is server-side state — it is NOT written into the handle cell value.
 */
export type SqliteRegisterDiskSourceRequest = {
  type: "sqlite.register-disk-source";
  requestId: string;
  space: string;
  sessionId: SessionId;

  /** Handle cell id (content-derived from (serviceSpace, absPath); see cf). */
  id: string;

  /** Absolute path to the on-disk SQLite file. */
  path: string;
};

export type SqliteRegisterDiskSourceResult = {
  registered: true;
};

/** Live render roots interpreted under the subscribing session's identity. */
export type ViewQuery = Pick<GraphQuery, "roots" | "branch">;

/** Desired view owned independently from a session's explicit watches. */
export type ViewInterest = {
  /** Renderer mount identity, unique within a session. */
  id: string;
  /** Monotonic revision of this mount's roots and contracts. */
  revision: number;
  /** Visible roots, which also hold execution demand. */
  query: ViewQuery;
  /** Whether the server should select data for local interaction previews. */
  mode: "render" | "speculate";
  /** Shared component read contract version supplied by this client build. */
  componentContractVersion: string;
};

/** Server-owned handle that expires with a session or view revision. */
export type SessionViewHandle = {
  sessionId: string;
  sessionEpoch: string;
  viewEpoch: string;
  viewId: string;
  revision: number;
};

/** Authenticated view interest exposed to the co-hosted execution planner. */
export type SessionViewInterest = {
  handle: SessionViewHandle;
  principal?: string;
  /** Whether a connection currently owns the retained session. */
  attached: boolean;
  view: ViewInterest;
  selectionGeneration?: number;
};

export type WatchSetRequest = {
  type: "session.watch.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];

  /** Replaces view interests; omitted preserves them and an empty array clears. */
  views?: ViewInterest[];

  /**
   * The client's declared holdings (see {@link SessionHolding}): when
   * present, the response's `sync` is the DIFFERENCE between the new watch
   * union and these, rather than the whole union — a client that lost its
   * server session (an expired resume, a restarted server) re-establishes
   * its watches without downloading again every document it still holds.
   */
  holdings?: SessionHolding[];
};

export type WatchAddRequest = {
  type: "session.watch.add";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];
};

export type SessionAckRequest = {
  type: "session.ack";
  requestId: string;
  space: string;
  sessionId: SessionId;
  seenSeq: number;
};

export type EventAttentionResolveRequest = {
  type: "event.attention.resolve";
  requestId: string;
  space: string;
  sessionId: SessionId;
  eventId: string;
  seq: number;
  sidecarId: string;
  action: "retry" | "dismiss";
};

export type EventAttentionResolveResult = {
  serverSeq: number;
  resolution: EventAttentionResolution;
};

export type ResponseMessage<Result> = {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
};

export type SessionEffectMessage = {
  type: "session/effect";
  space: string;
  sessionId: SessionId;
  effect: SessionSync;
};

export type SessionRevokedMessage = {
  type: "session/revoked";
  space: string;
  sessionId: SessionId;
  reason: "taken-over" | "unauthorized";
};

export type V2Error = {
  name: string;
  message: string;
  precondition?: string;
  retryAfterSeq?: number;

  /** First stale confirmed read per branch, entity, and session-resolved scope. */
  conflicts?: Array<{
    of: string;
    scope: CellScope;
    /** Absent for the default branch. */
    branch?: BranchName;
    seq: number;
    conflictSeq: number;
  }>;

  /**
   * Present on an `AuthorizationError` that a fresh handshake can heal — the
   * connection-challenge and invocation-freshness anti-replay races (an expired,
   * already-used, or mismatched challenge; a stale signed `exp`). Each reconnect
   * runs a new `hello` that issues a fresh challenge, so these do not recur. Its
   * absence marks a permanent denial (an audience mismatch, a malformed
   * invocation, or an ACL capability shortfall) that retrying cannot fix — the
   * client stops reopening the session and surfaces the error instead of looping.
   */
  retriable?: boolean;

  /** Positive evidence that the server made a durable, no-commit verdict. */
  permanentEvidence?: true;

  /** Engine revision whose ACL state produced an authorization denial. */
  aclRevision?: number;
};

export type V2Result<Value> = { ok: Value } | { error: V2Error };

export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | OperationFieldQueryRequest
  | EntityIdListRequest
  | EntityIdLookupRequest
  | SqliteQueryRequest
  | SqliteRegisterDiskSourceRequest
  | WatchSetRequest
  | WatchAddRequest
  | SessionAckRequest
  | EventAttentionResolveRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<FabricValue>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryLiveEnvironment = new NullLiveEnvironment(
  true,
  "no cell decoding at the memory boundary",
);

// These ambient flags and the memory protocol flags below are catalogued, with
// their defaults and removal paths, in docs/development/EXPERIMENTAL_OPTIONS.md.
// Update that registry when adding or removing one.
let commitPreconditionsEnabled = true;
let syncSchemaTableEnabled = true;
let messageCompressionEnabled = true;
let ownWriteEchoEnabled = true;

export {
  SERVER_EXECUTION_DEFAULT_ENABLED,
} from "./v2/server-execution-default.ts";
export {
  parseSessionReadCeiling,
  type ReadCeilingClause,
  type ReadCeilingLabels,
  type ReadCeilingOnExceed,
  readCeilingShapeError,
  SESSION_READ_CEILING_LABELS,
  type SessionReadCeiling,
} from "./v2/read-ceiling.ts";

// The ambient flag's inputs, resolved by getServerExecutionConfig():
// - the live ENABLER count (below), which forces the flag on — every
//   explicitly-enabled Runtime and the ExecutorHost claim one;
// - else an explicit OVERRIDE (`setServerExecutionConfig`: the direct test
//   seam, and the Runtime constructor's sanctioned explicit-false arm);
// - else the AMBIENT BASELINE, which is OFF: a BARE construction — no
//   preset, no explicit flag, nothing else in the process enabling it —
//   resolves the OFF arm, because a bare construction has no serving host
//   (the unit-test shape: single-process, the derive-and-commit model by
//   construction). The FIRST-PARTY default is a different thing: every
//   deployed-topology entry point resolves an unset flag to
//   `SERVER_EXECUTION_DEFAULT_ENABLED` (v2/server-execution-default.ts) and
//   constructs its runtimes explicitly, so in a deployed process the
//   ambient state follows that default through the enabler count.
let serverExecutionOverride: boolean | undefined = undefined;

/**
 * Ambient runtime flag for server-execution v2
 * (`EXPERIMENTAL_SERVER_EXECUTION`; docs/specs/server-side-execution/). OFF is
 * today's behavior byte-for-byte. The runner owns the feature, but the
 * per-class commit admission rows (protocol.md §2) are enforced by the memory
 * server under the flag, so the value lives beside the memory protocol flags.
 * Not a handshake capability: admission
 * enforcement is server-local, so nothing about it is negotiated per
 * connection.
 *
 * `enabled` undefined clears the explicit override (back to the ambient
 * baseline); a boolean sets it. A live enabler (below) wins over an
 * override either way.
 */
export function setServerExecutionConfig(enabled?: boolean): void {
  serverExecutionOverride = enabled;
}

export function getServerExecutionConfig(): boolean {
  if (serverExecutionEnablers > 0) return true;
  return serverExecutionOverride ?? false;
}

/** HARD reset of the test seam: override cleared, enabler count zero — the
 * flag reads the ambient baseline (OFF) again. Never called by product
 * code. */
export function resetServerExecutionConfig(): void {
  serverExecutionOverride = undefined;
  serverExecutionEnablers = 0;
}

// The flag is a process-global admission input with SEVERAL owners in a
// serving process (each explicitly-enabled Runtime, plus the
// ExecutorHost itself), so its production lifecycle is reference-counted
// HERE — beside the flag — rather than in any one owner: an owner-local
// count cannot see the others, and an unconditional reset from one owner
// un-claims `derived` for every other owner's in-flight commit. The
// direct set/reset functions above remain the test seam (reset is a HARD
// reset: override cleared, count zero).
let serverExecutionEnablers = 0;

/** Live enabler count — consulted by the one sanctioned explicit-disable
 * arm (a Runtime constructed with `serverExecution: false` writes the
 * ambient flag only when NO enabler is live). */
export function serverExecutionEnablerCount(): number {
  return serverExecutionEnablers;
}

/**
 * Claim the ambient server-execution flag, reference-counted. Returns
 * the matching release; the flag falls back to the override/baseline
 * resolution only when the LAST live enabler releases. The release is
 * idempotent per handle, so exception-safe callers can release from both
 * a rollback and a finally.
 */
export function acquireServerExecutionEnabler(): () => void {
  serverExecutionEnablers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    serverExecutionEnablers = Math.max(0, serverExecutionEnablers - 1);
  };
}

/**
 * Ambient runtime flag for commit preconditions. The runner owns the feature,
 * but the memory protocol needs the value during client/server handshakes.
 */
export function setCommitPreconditionsConfig(enabled?: boolean): void {
  commitPreconditionsEnabled = enabled ?? true;
}

export function getCommitPreconditionsConfig(): boolean {
  return commitPreconditionsEnabled;
}

export function resetCommitPreconditionsConfig(): void {
  commitPreconditionsEnabled = true;
}

/**
 * Ambient protocol capability for hash-keyed frame-local schema tables in sync
 * payloads. This is a wire-size optimization only; peers that do not advertise
 * the v2 capability keep receiving the historical fully-expanded `SessionSync`
 * shape.
 */
export function setSyncSchemaTableConfig(enabled?: boolean): void {
  syncSchemaTableEnabled = enabled ?? true;
}

export function getSyncSchemaTableConfig(): boolean {
  return syncSchemaTableEnabled;
}

export function resetSyncSchemaTableConfig(): void {
  syncSchemaTableEnabled = true;
}

/**
 * Ambient capability for binary gzip envelopes on memory WebSocket messages.
 * Disabling it keeps both peers on ordinary text frames as a rollout backstop.
 */
export function setMessageCompressionConfig(enabled?: boolean): void {
  messageCompressionEnabled = enabled ?? true;
}

export function getMessageCompressionConfig(): boolean {
  return messageCompressionEnabled;
}

export function resetMessageCompressionConfig(): void {
  messageCompressionEnabled = true;
}

/**
 * Ambient server behavior for own-write echo on sync frames (CT-1965): a
 * session's own accepted patch-produced heads ride the covering frame as full
 * post-apply documents, so promotion retires the pending overlay against
 * delivered truth instead of extrapolating merged state it never saw. Set- and
 * delete-produced heads stay elided — the client provably holds their outcome.
 * Off restores full echo suppression (the pre-CT-1965 behavior). Not a
 * protocol capability: every client generation handles the echoed frames.
 */
export function setOwnWriteEchoConfig(enabled?: boolean): void {
  ownWriteEchoEnabled = enabled ?? true;
}

export function getOwnWriteEchoConfig(): boolean {
  return ownWriteEchoEnabled;
}

export function resetOwnWriteEchoConfig(): void {
  ownWriteEchoEnabled = true;
}

export const getMemoryProtocolFlags = (): MemoryProtocolFlags => ({
  genesisRoot: true,
  modernCellRep: getModernCellRepConfig(),
  stableExpressionResultIds: true,
  commitPreconditions: getCommitPreconditionsConfig(),
  applyOp: true,
  operationCodecs: [CODEMIRROR_CHANGESET_CODEC],
  messageCompressionV1: getMessageCompressionConfig(),
  // A build-inherent capability, not configuration: this build's engine always
  // evaluates row-label rules at commit (sqlite/commit-eval.ts), so it always
  // advertises the fact. Peers that see it absent (an older server) keep their
  // write gate failing closed.
  sqliteCommitRowLabelEval: true,
  sqliteQueryReader: true,
  // Likewise build-inherent: this build's engine resolves array-localSeq
  // pending reads (resolvePendingReads), so it always advertises it. Clients
  // that see it absent scalarize to top-of-stack before sending.
  pendingReadStacks: true,
  // Likewise build-inherent: this build's server stages the catch-up
  // obligation for every verdict (accepts included), so it always
  // advertises it. Clients that see it absent apply verdicts immediately.
  verdictCatchUpMarkers: true,
  // The engine answers this request from its identifier index without
  // selecting stored entity values.
  entityIdListing: true,
  entityIdPagination: true,
  entityIdLookup: true,
  // Build-inherent: this build's server takes a client's declared holdings
  // as the delivery diff base wherever they are sent.
  sessionHoldings: true,
  viewScopedReplicationV1: getServerExecutionConfig(),
  // Build-inherent: this build's server records a session's declared read
  // ceiling and its serving runtime stamps it onto the runs it serves.
  sessionReadCeiling: true,
  syncSchemaTableV2: getSyncSchemaTableConfig(),
});

/**
 * Compares data-model wire contracts. Capability flags govern accepted
 * operations separately; `stableExpressionResultIds` governs session admission.
 */
export const compatibleMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean => left.modernCellRep === right.modernCellRep;

/**
 * Parses and normalizes incoming wire-protocol flags. Returns `null` if the
 * input is not a recognizable flags object.
 */
export const parseMemoryProtocolFlags = (
  value: unknown,
): MemoryProtocolFlags | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const genesisRoot = value.genesisRoot;
  if (genesisRoot !== undefined && typeof genesisRoot !== "boolean") {
    return null;
  }
  const stableExpressionResultIds = value.stableExpressionResultIds;
  if (
    stableExpressionResultIds !== undefined &&
    typeof stableExpressionResultIds !== "boolean"
  ) {
    return null;
  }

  const commitPreconditions = value.commitPreconditions;
  if (
    commitPreconditions !== undefined &&
    typeof commitPreconditions !== "boolean"
  ) {
    return null;
  }

  const applyOp = value.applyOp;
  if (applyOp !== undefined && typeof applyOp !== "boolean") {
    return null;
  }

  const operationCodecs = value.operationCodecs;
  if (
    operationCodecs !== undefined &&
    (!Array.isArray(operationCodecs) ||
      operationCodecs.some((codec) =>
        typeof codec !== "string" || !/@[1-9][0-9]*$/.test(codec)
      ) || new Set(operationCodecs).size !== operationCodecs.length)
  ) {
    return null;
  }

  const sqliteQueryReader = value.sqliteQueryReader;
  if (
    sqliteQueryReader !== undefined && typeof sqliteQueryReader !== "boolean"
  ) {
    return null;
  }

  const modernCellRep = value.modernCellRep;
  if (
    modernCellRep !== undefined &&
    typeof modernCellRep !== "boolean"
  ) {
    return null;
  }

  const syncSchemaTableV2 = value.syncSchemaTableV2;
  if (
    syncSchemaTableV2 !== undefined &&
    typeof syncSchemaTableV2 !== "boolean"
  ) {
    return null;
  }

  const messageCompressionV1 = value.messageCompressionV1;
  if (
    messageCompressionV1 !== undefined &&
    typeof messageCompressionV1 !== "boolean"
  ) {
    return null;
  }

  const sqliteCommitRowLabelEval = value.sqliteCommitRowLabelEval;
  if (
    sqliteCommitRowLabelEval !== undefined &&
    typeof sqliteCommitRowLabelEval !== "boolean"
  ) {
    return null;
  }

  const pendingReadStacks = value.pendingReadStacks;
  if (
    pendingReadStacks !== undefined &&
    typeof pendingReadStacks !== "boolean"
  ) {
    return null;
  }

  const verdictCatchUpMarkers = value.verdictCatchUpMarkers;
  if (
    verdictCatchUpMarkers !== undefined &&
    typeof verdictCatchUpMarkers !== "boolean"
  ) {
    return null;
  }

  const entityIdListing = value.entityIdListing;
  if (
    entityIdListing !== undefined &&
    typeof entityIdListing !== "boolean"
  ) {
    return null;
  }

  const entityIdPagination = value.entityIdPagination;
  if (
    entityIdPagination !== undefined &&
    typeof entityIdPagination !== "boolean"
  ) {
    return null;
  }

  const entityIdLookup = value.entityIdLookup;
  if (
    entityIdLookup !== undefined &&
    typeof entityIdLookup !== "boolean"
  ) {
    return null;
  }

  const viewScopedReplicationV1 = value.viewScopedReplicationV1;
  if (
    viewScopedReplicationV1 !== undefined &&
    typeof viewScopedReplicationV1 !== "boolean"
  ) {
    return null;
  }

  const sessionReadCeiling = value.sessionReadCeiling;
  if (
    sessionReadCeiling !== undefined &&
    typeof sessionReadCeiling !== "boolean"
  ) {
    return null;
  }

  const sessionHoldings = value.sessionHoldings;
  if (
    sessionHoldings !== undefined &&
    typeof sessionHoldings !== "boolean"
  ) {
    return null;
  }

  return {
    modernCellRep: modernCellRep === true,
    genesisRoot: value.genesisRoot === true,
    stableExpressionResultIds: stableExpressionResultIds === true,
    commitPreconditions: commitPreconditions === true,
    applyOp: applyOp === true,
    ...(operationCodecs === undefined
      ? {}
      : { operationCodecs: [...operationCodecs].sort() as string[] }),
    syncSchemaTableV2: syncSchemaTableV2 === true,
    messageCompressionV1: messageCompressionV1 === true,
    // Absent (an older peer) parses to false: the capability must be
    // POSITIVELY advertised for the runner to relax its write gate.
    sqliteCommitRowLabelEval: sqliteCommitRowLabelEval === true,
    sqliteQueryReader: sqliteQueryReader === true,
    // Absent (an older server) parses to false: clients scalarize pending
    // reads to top-of-stack unless the array capability is advertised.
    pendingReadStacks: pendingReadStacks === true,
    // Absent (an older server that stamps markers only for conflicts)
    // parses to false: clients apply verdicts immediately instead of
    // parking them on marker coverage.
    verdictCatchUpMarkers: verdictCatchUpMarkers === true,
    entityIdListing: entityIdListing === true,
    entityIdPagination: entityIdPagination === true,
    entityIdLookup: entityIdLookup === true,
    // Absent (an older server) parses to false: a provider-less session
    // declares nothing and reconnects on the declaration-less paths; a
    // provider-bearing one terminates at restore (see the flag's doc).
    sessionHoldings: sessionHoldings === true,
    viewScopedReplicationV1: viewScopedReplicationV1 === true,
    // Absent (an older server) parses to false: a client carrying a read
    // ceiling refuses such a server rather than reading unbounded.
    sessionReadCeiling: sessionReadCeiling === true,
  };
};

/**
 * Builds the wire-format flags object for a `hello`/`hello.ok` message.
 */
export const wireMemoryProtocolFlags = (
  flags: MemoryProtocolFlags,
): WireMemoryProtocolFlags => ({
  genesisRoot: flags.genesisRoot,
  modernCellRep: flags.modernCellRep,
  stableExpressionResultIds: flags.stableExpressionResultIds,
  commitPreconditions: flags.commitPreconditions,
  applyOp: flags.applyOp,
  ...(flags.operationCodecs === undefined
    ? {}
    : { operationCodecs: flags.operationCodecs }),
  syncSchemaTableV2: flags.syncSchemaTableV2,
  messageCompressionV1: flags.messageCompressionV1,
  sqliteCommitRowLabelEval: flags.sqliteCommitRowLabelEval,
  sqliteQueryReader: flags.sqliteQueryReader,
  pendingReadStacks: flags.pendingReadStacks,
  verdictCatchUpMarkers: flags.verdictCatchUpMarkers,
  entityIdListing: flags.entityIdListing,
  entityIdPagination: flags.entityIdPagination,
  entityIdLookup: flags.entityIdLookup,
  sessionHoldings: flags.sessionHoldings,
  viewScopedReplicationV1: flags.viewScopedReplicationV1,
  sessionReadCeiling: flags.sessionReadCeiling,
});

/**
 * Encodes a wire payload. The encoding embeds every string value
 * byte-verbatim (`fvj1:` tag + canonical JSON; strings self-represent, and
 * neither reserved schema-reference prefix contains a JSON-escapable
 * character). Three consumers depend on that property as a cheap substring
 * gate and must move in lockstep with any codec change (fvj2, escaping of
 * tag-like strings): the client receive-path expansion gate (v2/client.ts),
 * `containsReservedSchemaRefSubstring` (v2/sync-schema-ref.ts), and the
 * engine's commit/stored-row probes (v2/engine.ts). A pinning test in
 * test/v2-sync-schema-table.test.ts fails loudly if verbatim embedding ever
 * stops holding.
 */
export const encodeMemoryBoundary = (value: FabricValue): string =>
  jsonFromFabricValue(value);

export const commitPreconditionValueHash = (value: FabricValue): string =>
  hashStringOf(encodeMemoryBoundary(value));

export const decodeMemoryBoundary = <Value extends FabricValue = FabricValue>(
  source: string,
): Value & FabricValue => {
  const decoded = fabricFromJsonValue(
    source,
    memoryLiveEnvironment,
  );

  return decoded as Value;
};

export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;

export const toValuePath = (path: readonly string[]): ValuePath =>
  path as ValuePath;

/**
 * Builds a document-level selector (path rooted under `"value"`) from a schema
 * path selector. The result is interned-and-frozen via `internPathSelector()`,
 * to get the benefits of hash caching.
 */
export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector =>
  internPathSelector({
    ...selector,
    path: toDocumentPath(["value", ...selector.path]),
  }) as DocumentSchemaPathSelector;

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isPlainObject(value);

/**
 * Read a stored document payload: decode it, and refuse a root that is not a
 * tree of paths.
 *
 * `decode` is the caller's, because the readers disagree on which payloads they
 * accept and only on that: the engine reads what it wrote, through
 * {@link decodeMemoryBoundary}, while an offline reader over a durable file may
 * also meet untagged plain-JSON rows and route accordingly. Everything else is
 * one rule shared here, since a reader that tests the payload for truthiness
 * instead takes an empty string for an absent one and rebuilds a document the
 * engine would have rejected.
 *
 * An absent payload never reaches the decoder. Handing one a placeholder string
 * makes the rule depend on which decoder was passed — `decodeMemoryBoundary`
 * refuses any untagged payload, a plain-JSON decoder accepts one — and two
 * readers that disagree about an absent payload do not share a rule at all. An
 * absent document is `null`, which the root check below refuses on its own.
 */
export const decodeStoredDocumentPayload = (
  decode: (source: string) => unknown,
  data: string | null,
): EntityDocument => {
  const parsed = data === null ? null : decode(data);
  if (!isEntityDocument(parsed)) {
    const shape = parsed === null
      ? "null"
      : Array.isArray(parsed)
      ? "an array"
      : `a ${typeof parsed}`;
    throw new TypeError(
      `memory v2 stored documents must be plain object roots; got ${shape}`,
    );
  }
  return parsed;
};

/**
 * Read a stored patch-list payload through the same rule. An absent payload is
 * refused rather than read as the empty list: nothing writes a patch row
 * without one, so an absent payload is a malformed row, and applying it as a
 * no-op would leave the document reading current.
 */
export const decodeStoredPatchListPayload = (
  decode: (source: string) => unknown,
  data: string | null,
): PatchOp[] => {
  if (data === null) {
    throw new TypeError("memory v2 stored patches must carry a payload");
  }
  const parsed = decode(data);
  if (!Array.isArray(parsed)) {
    throw new TypeError("memory v2 stored patches must be arrays");
  }
  return parsed as PatchOp[];
};

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, FabricValue> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};
