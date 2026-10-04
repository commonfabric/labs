/**
 * RuntimeClient - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 */

import type { CellScope, JSONValue } from "@commonfabric/api";
import type { FabricPlainObject, FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { DID, Identity } from "@commonfabric/identity";
import { Program } from "@commonfabric/js-compiler/interface";
import type {
  ApplyOpResolution,
  OpCursor,
  OperationFieldSnapshot,
  PresenceRecord,
} from "@commonfabric/memory/v2";
import type { PresenceEvent } from "@commonfabric/memory/v2/client";
import { NameSchema } from "@commonfabric/runner/schemas";
import type {
  ActionRunTraceEntry,
  JSONSchema,
  PatternCoverageData,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commonfabric/runner/shared";
import type { SpaceHostRegistration } from "@commonfabric/runner/space-host";

import { CellHandle } from "./cell-handle.ts";
import {
  InitializedRuntimeConnection,
  type PendingRequestDiagnostic,
  type RequestTimelineEntry,
  RuntimeConnection,
  type SubscriptionDiagnostics,
} from "./client/connection.ts";
import { EventEmitter } from "./client/emitter.ts";
import { RuntimeTransport } from "./client/transport.ts";
import { PieceHandle } from "./piece-handle.ts";
import {
  type CellRef,
  ConsoleMessage,
  type CustodySealPreview,
  ErrorNotification,
  type EventAttentionListResponse,
  type EventAttentionNotice,
  type EventAttentionResolveResponse,
  EventIntentOutcomeNotice,
  EventIntentOutcomeNotification,
  EventNeedsAttentionNotification,
  InitializationData,
  type LoggerCountsData,
  type LoggerFlagsData,
  type LoggerMetadata,
  type LoggerTimingData,
  type LogLevel,
  NavigateRequestNotification,
  type OperationUpdateNotification,
  type PatternSourcesResponse,
  PendingWritesNotification,
  type PieceSourceAction,
  type PieceSourceRevisionSourceView,
  type PieceSourceView,
  type PieceUpdateSourceResponse,
  type PresenceJoinResponse,
  type PresenceUpdateNotification,
  type PresenceWireEvent,
  RequestType,
  type RuntimeSecurityContext,
  type SlugRefusal,
  type SnapshotShareAudienceRef,
  type SnapshotSharePreview,
  type SpaceAccessLostNotification,
  type SpaceAclCapability,
  type SpaceAclView,
  TelemetryNotification,
  type UploadBlobResponse,
} from "./protocol/mod.ts";
import type {
  SharedSpaceCatalogHome,
  SharedSpaceCatalogRead,
  SharedSpaceMembershipChange,
  SharedSpaceMembershipResult,
  SharedSpaceRegistration,
  SharedSpaceRegistrationResult,
} from "./shared-space-catalog-contract.ts";
import { assertNoKeyMaterial } from "./shared/key-material.ts";
import {
  type EveryFieldOf,
  normalizeOrigin,
  normalizeSpaceHostMap,
} from "./shared/security-context.ts";
import { cellRefToInstanceId, cellRefToKey } from "./shared/utils.ts";

/**
 * What a client is told about the page it runs in. None of it is posture, and
 * none of it crosses the wire: it is read back from the client by what renders
 * on the page.
 */
export interface RuntimeClientPageSettings {
  /**
   * Where `cf-iframe` loads its sandbox's outer frame from, for a page whose
   * own Content Security Policy refuses inline script and so refuses the
   * `srcdoc` frame the sandbox otherwise inlines. The page serves the document
   * at this URL; `common-iframe-sandbox`'s `outerFrameUrl` says what it has
   * to be. Unset, the outer frame is inlined.
   */
  iframeOuterFrameUrl?: string;
}

export interface RuntimeClientOptions
  extends
    Omit<InitializationData, "apiUrl" | "identity">,
    RuntimeClientPageSettings {
  apiUrl: URL;
  identity: Identity;
}

/**
 * What a client needs to join a runtime someone else stood up.
 *
 * Its own type rather than {@link RuntimeClientOptions} because of one field:
 * `identity` is a DID here, never an `Identity`. An attaching client states
 * which principal the runtime acts as and supplies no signer, so a document
 * holding one of these structurally cannot hand a key across -- there is no
 * key in it to hand. `RuntimeClientOptions` keeps the `Identity`, and is what
 * initialization takes.
 *
 * The rest, apart from the page's settings, is the security posture this
 * client asserts. None of it is declared to the runtime: the runtime is
 * running under a posture of its own, and an assertion that differs anywhere
 * is refused.
 *
 * The page's settings ({@link RuntimeClientPageSettings}) are no part of that.
 * They say something of the document that attaches, the client keeps them,
 * and the runtime is neither sent them nor asked to agree: two documents that
 * join one runtime may differ in them.
 */
export interface RuntimeAttachOptions extends
  Omit<
    RuntimeSecurityContext,
    "apiUrl" | "spaceHostMap" | "identity"
  >,
  RuntimeClientPageSettings {
  /** The backend this client believes the runtime reads from. */
  apiUrl: URL;

  /** The per-space hosts this client believes the runtime resolves against. */
  spaceHostMap?: Record<string, string>;

  /** The principal this client believes the runtime acts as. */
  identity: DID;
}

export type RuntimeClientEvents = {
  console: [ConsoleMessage];
  navigaterequest: [{ cell: CellHandle }];
  error: [ErrorNotification];
  spaceaccesslost: [{ space: DID }];
  telemetry: [RuntimeTelemetryMarkerResult];
  pendingwriteschange: [{ pending: boolean }];
  eventneedsattention: [EventAttentionNotice];
  /** Refused event admission; this does not revoke read access. */
  eventintentoutcome: [EventIntentOutcomeNotice];
};

/**
 * The same posture, in the form a client that joins a runtime states it.
 *
 * Written out field by field rather than spread, because what is dropped is
 * the point: the acting principal becomes the DID it derives to, and the
 * signing `Identity` is left behind. A client that attaches asserts which
 * principal the runtime acts as and supplies no key, and this is where a
 * page's signer stops.
 *
 * Everything else is named, which the `satisfies` clause holds: a posture
 * field this one drops is one the client asserts nothing about, and the
 * runtime's own value for it then goes unchecked.
 *
 * The page's settings come across as they are. They are not posture and an
 * attach asserts nothing by them; they are here because the client an attach
 * makes keeps them as the one initialization makes does.
 */
export function attachOptionsFrom(
  options: RuntimeClientOptions,
): RuntimeAttachOptions {
  return {
    apiUrl: options.apiUrl,
    spaceHostMap: options.spaceHostMap,
    identity: options.identity.did(),
    spaceDid: options.spaceDid,
    experimental: options.experimental,
    cfcEnforcementMode: options.cfcEnforcementMode,
    cfcFlowLabels: options.cfcFlowLabels,
    cfcReadMaxConfidentiality: options.cfcReadMaxConfidentiality,
    cfcReadOnExceed: options.cfcReadOnExceed,
    cfcTrustConfig: options.cfcTrustConfig,
    renderDeclassificationPolicy: options.renderDeclassificationPolicy,
    renderConfidentialityCeiling: options.renderConfidentialityCeiling,
    trustSnapshot: options.trustSnapshot,
    iframeOuterFrameUrl: options.iframeOuterFrameUrl,
  } satisfies EveryFieldOf<RuntimeAttachOptions>;
}

/**
 * The page settings in `options`, apart from everything else there. Named
 * field by field, as the posture is, so that a setting added to the type is a
 * type error here until a client carries it.
 */
function pageSettingsFrom(
  options: RuntimeClientPageSettings,
): RuntimeClientPageSettings {
  return {
    iframeOuterFrameUrl: options.iframeOuterFrameUrl,
  } satisfies EveryFieldOf<RuntimeClientPageSettings>;
}

export const $conn = Symbol("$request");

/**
 * Refuses a render-declassification policy that names no known posture.
 *
 * It is a security knob, so a host's own config error surfaces here, early and
 * loudly. The worker side additionally fails CLOSED -- an unknown value there
 * becomes `deny` -- for peers that do not come through this entry point.
 *
 * @throws If `policy` is present and is neither `allow` nor `deny`.
 */
function assertRenderDeclassificationPolicy(policy: unknown): void {
  if (policy === undefined || policy === "allow" || policy === "deny") return;
  throw new Error(
    `Invalid renderDeclassificationPolicy: ${
      JSON.stringify(policy)
    } (expected "allow" or "deny")`,
  );
}

/**
 * A consumer's hold on one presence room, obtained from
 * {@link RuntimeClient.joinPresenceRoom}. Every handle on one room shares
 * the room's membership and its record: the name is the room's, and each
 * handle owns the facets it sets, which leave the record when it leaves. A
 * facet two handles both set is the focused handle's, and among handles
 * alike in focus the one that set it last. Changes coalesce at the
 * browser's animation-frame boundary into one publication.
 */
export interface PresenceRoomHandle {
  /** The id the relay assigned this membership; changes on reconnect. */
  readonly participantId: string;

  /** The room joined, derived from the field or as requested. */
  readonly room: string;

  /** Every other member that has published, at its latest record. */
  readonly participants: readonly PresenceRecord[];

  /** Sets the display name the record carries. Empty publishes nothing. */
  setName(name: string): void;

  /** Sets one facet of this handle's, replacing its previous value. */
  setFacet(facet: string, value: FabricPlainObject): void;

  /** Removes one facet of this handle's. */
  clearFacet(facet: string): void;

  /**
   * Marks this handle as the one holding the user's attention, which makes
   * its facets win those another handle on the room sets under the same
   * name. A room's record may carry one caret, and this is how two editors
   * of one field on a page settle whose it is.
   */
  setFocused(focused: boolean): void;

  /**
   * Listens for the room's events after they are applied to
   * `.participants`. A `failure` ends the room: nothing follows it, and a
   * consumer that still wants the room leaves and joins again.
   */
  subscribe(listener: (event: PresenceEvent) => void): () => void;

  /**
   * Releases this handle. The room is left once its last handle has;
   * calling it again does nothing.
   */
  leave(): Promise<void>;
}

/** One handle's share of a room: its facets and its listeners. */
type PresenceHandleState = {
  /** Each facet with when it was last set, on the client's single counter. */
  facets: Map<string, { value: FabricPlainObject; revision: number }>;
  focused: boolean;
  listeners: Set<(event: PresenceEvent) => void>;
  left: boolean;
};

/** What the client holds for one joined room. */
type PresenceRoomState = {
  /** The room's identity on this client: its space and room id. */
  key: string;

  /** The id of the membership the room is held through. */
  subscriptionId: string;
  room: string;
  participantId: string;
  participants: Map<string, PresenceRecord>;
  handles: Set<PresenceHandleState>;
  name: string;

  /** The scheduled publication, or `undefined` when none is pending. */
  frame: number | undefined;

  /**
   * Set by a `failure`, or once the room is dropped from the client's
   * indexes, after which nothing is published or delivered.
   */
  ended: boolean;
};

/**
 * A join the worker has not answered. A later join through the same cell, or
 * of the same named room, waits on it rather than asking the worker again.
 */
type PendingPresenceJoin = {
  /** The id the membership is requested under, and held under once joined. */
  subscriptionId: string;

  /**
   * Events the worker sent the membership ahead of the join's reply, in the
   * order they arrived. They are applied to the room once it exists.
   */
  early: PresenceWireEvent[];

  /**
   * The handles of the callers waiting on the join. The room takes them the
   * moment it exists, so no other handle's leave can empty it while those
   * callers are still being handed it.
   */
  handles: Set<PresenceHandleState>;

  /**
   * Settles on the room the join reached: the one it joined, or, when the
   * worker names a room another join already holds or is joining by name,
   * that one. The two cells are then aliases of one field, and their handles
   * share the room rather than racing it with two memberships.
   */
  room: Promise<PresenceRoomState>;
};

const presenceRoomKey = (space: string, room: string): string =>
  `${space}\0${room}`;

const scheduleAnimationFrame = (callback: () => void): number => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(() => callback());
  }
  queueMicrotask(callback);
  return 0;
};

/**
 * RuntimeClient provides a main-thread interface to a Runtime running elsewhere.
 */
export class RuntimeClient extends EventEmitter<RuntimeClientEvents> {
  #conn: InitializedRuntimeConnection;
  readonly #principal: DID | undefined;
  readonly #pageSettings: RuntimeClientPageSettings;
  readonly #sessionInstanceId = crypto.randomUUID();
  #pendingWrites = false;
  #operationSubscriptions = new Map<
    string,
    (field: OperationFieldSnapshot) => void
  >();

  /** Joined rooms by their key. */
  #presenceRooms = new Map<string, PresenceRoomState>();

  /** Joined rooms by the membership each is held through. */
  #presenceBySubscription = new Map<string, PresenceRoomState>();

  /** Orders facet writes across every handle, for the merge to rank by. */
  #presenceWrites = 0;

  /**
   * The room each derived-room join settled on, by the cell the join was made
   * through, so a second join through the same cell finds the room without
   * asking the worker again. Two alias cells of one field map to one room.
   */
  #presenceByCell = new Map<string, PresenceRoomState>();

  /**
   * Named-room joins whose room is not yet decided, by the key of the room
   * each names.
   */
  #presenceJoinsByRoom = new Map<string, PendingPresenceJoin>();

  /**
   * Derived-room joins whose room is not yet decided, by the cell each was
   * made through. An alias's join stays here until the room it shares has
   * settled too.
   */
  #presenceJoinsByCell = new Map<string, PendingPresenceJoin>();

  /**
   * Joins the worker has not answered, by the membership each requests, so
   * that the membership's early events are held for the room.
   */
  #presenceJoinsBySubscription = new Map<string, PendingPresenceJoin>();

  private constructor(
    conn: InitializedRuntimeConnection,
    principal: DID | undefined,
    pageSettings: RuntimeClientPageSettings = {},
  ) {
    super();
    this.#conn = conn;
    this.#principal = principal;
    this.#pageSettings = pageSettings;
    this.#conn.on("console", this.#onConsole);
    this.#conn.on("navigaterequest", this.#onNavigateRequest);
    this.#conn.on("error", this.#onError);
    this.#conn.on("spaceaccesslost", this.#onSpaceAccessLost);
    this.#conn.on("eventintentoutcome", this.#onEventIntentOutcome);
    this.#conn.on("telemetry", this.#onTelemetry);
    this.#conn.on("pendingwriteschange", this.#onPendingWritesChange);
    this.#conn.on("operationupdate", this.#onOperationUpdate);
    this.#conn.on("presenceupdate", this.#onPresenceUpdate);
    this.#conn.on("eventneedsattention", this.#onEventNeedsAttention);
  }

  /** Acting principal established by the runtime connection posture. */
  actingPrincipalDid(): DID | undefined {
    return this.#principal;
  }

  /**
   * Where the page serves the outer frame of `cf-iframe`'s sandbox, as the
   * host said when it made this client, or `undefined` for a page that
   * serves none.
   */
  iframeOuterFrameUrl(): string | undefined {
    return this.#pageSettings.iframeOuterFrameUrl;
  }

  /** Returns an opaque identity for the scoped document instance in `ref`. */
  cellInstanceId(ref: CellRef): string {
    if (ref.scope !== undefined && ref.scope !== "space" && !this.#principal) {
      throw new Error(
        `Cannot identify a ${ref.scope}-scoped Cell without a runtime identity.`,
      );
    }
    return cellRefToInstanceId(ref, {
      principal: this.#principal ?? "",
      sessionId: this.#sessionInstanceId,
    });
  }

  /**
   * Whether the worker runtime has issued commits that the server has not yet
   * confirmed. Mirrored from the worker's storage manager on every transition,
   * so it is synchronously readable — e.g. from a beforeunload handler, where
   * no async round-trip is possible. Tearing the page down while this is true
   * loses those writes.
   */
  hasPendingWrites(): boolean {
    return this.#pendingWrites;
  }

  /** Prepares the snapshot and audience the trusted host asks the user to share. */
  async prepareSnapshotShare(
    source: CellRef,
    audience: SnapshotShareAudienceRef,
    appendBooksTo?: { recommended: CellRef; received: CellRef },
  ): Promise<SnapshotSharePreview> {
    return await this.#conn.request<RequestType.SnapshotSharePrepare>({
      type: RequestType.SnapshotSharePrepare,
      source,
      audience,
      appendBooksTo,
    });
  }

  /** Commits a preview after the trusted host receives the user's confirmation. */
  async commitSnapshotShare<T = unknown>(id: string): Promise<CellHandle<T>> {
    const response = await this.#conn.request<RequestType.SnapshotShareCommit>({
      type: RequestType.SnapshotShareCommit,
      id,
    });
    return new CellHandle<T>(this, response.cell);
  }

  /** Discards a preview when the host closes or replaces its confirmation. */
  async cancelSnapshotShare(id: string): Promise<void> {
    await this.#conn.request<RequestType.SnapshotShareCancel>({
      type: RequestType.SnapshotShareCancel,
      id,
    });
  }

  /**
   * Prepares a custody seal of `draft` into the room whose terms and policy
   * are named, for the trusted host to show before the actor confirms. The
   * worker reads and checks every cell, and keeps the consent; the preview is
   * what crosses. When `box` is named, the seal writes the link to the
   * instance's box into it as it commits.
   */
  async prepareCustodySeal(cells: {
    draft: CellRef;
    terms: CellRef;
    policy: CellRef;
    allowedSources: CellRef;
    box?: CellRef;
  }): Promise<CustodySealPreview> {
    return await this.#conn.request<RequestType.CustodySealPrepare>({
      type: RequestType.CustodySealPrepare,
      draft: cells.draft,
      terms: cells.terms,
      policy: cells.policy,
      allowedSources: cells.allowedSources,
      ...(cells.box === undefined ? {} : { box: cells.box }),
    });
  }

  /**
   * Seals a prepared preview after the trusted host receives the actor's
   * confirmation, answering with the actor's receipt, the instance's box
   * that the room's projector reads, and the instance sealed into.
   */
  async commitCustodySeal<T = unknown>(id: string): Promise<{
    receipt: CellHandle<T>;
    box: CellHandle<unknown>;
    instance: string;
  }> {
    const response = await this.#conn.request<RequestType.CustodySealCommit>({
      type: RequestType.CustodySealCommit,
      id,
    });
    return {
      receipt: new CellHandle<T>(this, response.receipt),
      box: new CellHandle(this, response.box),
      instance: response.instance,
    };
  }

  /**
   * Asks the worker to publish a custody instance's answer once, from the
   * room's projected answer, into the instance's answer slot. The seal
   * publishes only when every exchange rule of the room's policy requires the
   * seal's witness and releases only to the seal, a rule of that policy
   * releases the projected answer to the seal, the answer is a string of at
   * most 1,024 characters, a number or a boolean, and every seat has sealed.
   * It refuses the request otherwise, when the room changes while it
   * publishes, and once the instance's answer is published.
   */
  async publishCustodyAnswer(cells: {
    terms: CellRef;
    policy: CellRef;
    output: CellRef;
  }): Promise<{ instance: string; answer: JSONValue }> {
    return await this.#conn.request<RequestType.CustodyAnswerPublish>({
      type: RequestType.CustodyAnswerPublish,
      terms: cells.terms,
      policy: cells.policy,
      output: cells.output,
    });
  }

  /**
   * Reads a custody instance's published answer, verified to be the seal's
   * write, or `undefined` while none is published.
   */
  async readCustodyAnswer(cells: {
    terms: CellRef;
    policy: CellRef;
  }): Promise<JSONValue | undefined> {
    const response = await this.#conn.request<RequestType.CustodyAnswerRead>({
      type: RequestType.CustodyAnswerRead,
      terms: cells.terms,
      policy: cells.policy,
    });
    return response.answer;
  }

  /** Discards a custody seal preview the host closed or replaced. */
  async cancelCustodySeal(id: string): Promise<void> {
    await this.#conn.request<RequestType.CustodySealCancel>({
      type: RequestType.CustodySealCancel,
      id,
    });
  }

  async operationCodecs<T>(
    cell: CellHandle<T>,
    operationSessionId?: string,
  ): Promise<readonly string[]> {
    const response = await this.#conn.request<
      RequestType.OperationCapabilities
    >({
      type: RequestType.OperationCapabilities,
      cell: cell.ref(),
      ...(operationSessionId === undefined ? {} : { operationSessionId }),
    });
    return response.codecs;
  }

  async queryOperationField<T>(
    cell: CellHandle<T>,
    after?: OpCursor,
    operationSessionId?: string,
  ): Promise<OperationFieldSnapshot> {
    const response = await this.#conn.request<RequestType.OperationQuery>({
      type: RequestType.OperationQuery,
      cell: cell.ref(),
      ...(operationSessionId === undefined ? {} : { operationSessionId }),
      ...(after === undefined ? {} : { after }),
    });
    return response.field;
  }

  async applyOperation<T>(
    cell: CellHandle<T>,
    operation: {
      codec: string;
      submissionId: string;
      base: OpCursor | null;
      baselineHash?: string;
      payload: FabricValue;
    },
    operationSessionId?: string,
  ): Promise<ApplyOpResolution> {
    const response = await this.#conn.request<RequestType.OperationApply>({
      type: RequestType.OperationApply,
      cell: cell.ref(),
      ...(operationSessionId === undefined ? {} : { operationSessionId }),
      ...operation,
      payload: operation.payload,
    });
    return response.resolution;
  }

  async subscribeOperationField<T>(
    cell: CellHandle<T>,
    callback: (field: OperationFieldSnapshot) => void,
    after?: OpCursor,
    operationSessionId?: string,
  ): Promise<() => void> {
    const subscriptionId = crypto.randomUUID();
    this.#operationSubscriptions.set(subscriptionId, callback);
    try {
      const response = await this.#conn.request<
        RequestType.OperationSubscribe
      >({
        type: RequestType.OperationSubscribe,
        subscriptionId,
        cell: cell.ref(),
        ...(operationSessionId === undefined ? {} : { operationSessionId }),
        ...(after === undefined ? {} : { after }),
      });
      if (!response.value) {
        throw new Error("operation subscription was not installed");
      }
    } catch (error) {
      this.#operationSubscriptions.delete(subscriptionId);
      try {
        await this.#conn.request<RequestType.OperationUnsubscribe>({
          type: RequestType.OperationUnsubscribe,
          subscriptionId,
        });
      } catch {
        // The connection may have failed with the subscribe response. The
        // local registration is already gone; a best-effort compensating
        // unsubscribe prevents a worker-side subscription from leaking when
        // only that response was lost.
      }
      throw error;
    }
    return () => {
      if (!this.#operationSubscriptions.delete(subscriptionId)) return;
      void this.#conn.request<RequestType.OperationUnsubscribe>({
        type: RequestType.OperationUnsubscribe,
        subscriptionId,
      }).catch(() => undefined);
    };
  }

  /**
   * Joins the presence room of `cell`'s resolved field — or `options.room`,
   * under the cell's space — and returns a handle on it. A second join of
   * the same room shares its membership. Rejects when the runtime's storage
   * or its server does not support presence.
   */
  async joinPresenceRoom<T>(
    cell: CellHandle<T>,
    options: { room?: string } = {},
  ): Promise<PresenceRoomHandle> {
    const ref = cell.ref();
    const requested = options.room;
    const cellKey = cellRefToKey(ref);
    // A named room is known before the worker is asked, and a derived one
    // only from its reply, so a derived join is found by the cell it was made
    // through, and a named one by the room.
    const [rooms, joins, key] = requested === undefined
      ? [this.#presenceByCell, this.#presenceJoinsByCell, cellKey]
      : [
        this.#presenceRooms,
        this.#presenceJoinsByRoom,
        presenceRoomKey(ref.space, requested),
      ];
    const handle: PresenceHandleState = {
      facets: new Map(),
      focused: false,
      listeners: new Set(),
      left: false,
    };
    let room = rooms.get(key);
    if (room?.ended) {
      this.#forgetPresenceRoom(room);
      room = undefined;
    }
    if (room === undefined) {
      const join = joins.get(key) ??
        this.#joinPresence(ref, cellKey, requested);
      join.handles.add(handle);
      room = await join.room;
      if (room.ended) {
        void this.#releasePresenceHandle(room, handle);
        throw new Error("presence room ended while it was being joined");
      }
    } else {
      room.handles.add(handle);
    }
    return {
      get participantId() {
        return room.participantId;
      },
      get room() {
        return room.room;
      },
      get participants() {
        return [...room.participants.values()];
      },
      setName: (name) => {
        if (handle.left || room.name === name) return;
        room.name = name;
        this.#schedulePresencePublish(room);
      },
      setFacet: (facet, value) => {
        if (handle.left) return;
        handle.facets.set(facet, { value, revision: ++this.#presenceWrites });
        this.#schedulePresencePublish(room);
      },
      clearFacet: (facet) => {
        if (handle.left || !handle.facets.delete(facet)) return;
        this.#schedulePresencePublish(room);
      },
      setFocused: (focused) => {
        if (handle.left || handle.focused === focused) return;
        handle.focused = focused;
        this.#schedulePresencePublish(room);
      },
      subscribe: (listener) => {
        if (!handle.left) handle.listeners.add(listener);
        return () => {
          handle.listeners.delete(listener);
        };
      },
      leave: async () => {
        if (handle.left) return;
        handle.left = true;
        handle.listeners.clear();
        await this.#releasePresenceHandle(room, handle);
      },
    };
  }

  async releaseOperationField<T>(
    cell: CellHandle<T>,
    codec: string,
    cursor: OpCursor,
    operationSessionId?: string,
  ): Promise<void> {
    const response = await this.#conn.request<RequestType.OperationRelease>({
      type: RequestType.OperationRelease,
      cell: cell.ref(),
      ...(operationSessionId === undefined ? {} : { operationSessionId }),
      codec,
      cursor,
    });
    if (!response.value) {
      throw new Error("operation field was not released");
    }
  }

  async closeOperationSession(operationSessionId: string): Promise<void> {
    await this.#conn.request<RequestType.OperationSessionClose>({
      type: RequestType.OperationSessionClose,
      operationSessionId,
    });
  }

  /**
   * The runtime's lifetime signal. It aborts when the runtime is disposed.
   * Consumers observe it to stop work and to recognize that a disposal-raced
   * operation was cancelled rather than failed.
   */
  get signal(): AbortSignal {
    return this.#conn.signal;
  }

  /**
   * Joins a runtime a first client already stood up, over a transport already
   * connected to that runtime's worker.
   *
   * What `options` says of the runtime's security posture is asserted rather
   * than declared: the runtime is running under a posture of its own, and an
   * attach whose assertion differs anywhere is refused. Everything else in
   * `options` describes this client, and reaches nothing across the wire.
   *
   * @throws If the runtime refuses the attach, or if there is no runtime to
   *   attach to.
   */
  static async attach(
    transport: RuntimeTransport,
    options: RuntimeAttachOptions,
  ): Promise<RuntimeClient> {
    assertRenderDeclassificationPolicy(options.renderDeclassificationPolicy);
    const context: RuntimeSecurityContext = {
      identity: options.identity,
      // Normalized as the runtime normalizes what it was initialized with, so
      // that agreeing on a backend does not depend on agreeing on how to spell
      // one.
      apiUrl: normalizeOrigin(options.apiUrl.toString()),
      spaceHostMap: normalizeSpaceHostMap(options.spaceHostMap),
      spaceDid: options.spaceDid,
      experimental: options.experimental,
      cfcEnforcementMode: options.cfcEnforcementMode,
      cfcFlowLabels: options.cfcFlowLabels,
      cfcReadMaxConfidentiality: options.cfcReadMaxConfidentiality,
      cfcReadOnExceed: options.cfcReadOnExceed,
      cfcTrustConfig: options.cfcTrustConfig,
      renderDeclassificationPolicy: options.renderDeclassificationPolicy,
      renderConfidentialityCeiling: options.renderConfidentialityCeiling,
      trustSnapshot: options.trustSnapshot,
    } satisfies EveryFieldOf<RuntimeSecurityContext>;
    // The far side refuses this too, and refusing before the send is what
    // matters for a shell: `key-material.ts` records why, and the short of it
    // is that a `MessagePort` between two WKWebViews throws `DataCloneError`
    // on a key rather than carrying it. A frame refused here never reaches a
    // port, so that failure has nothing to happen to.
    assertNoKeyMaterial(context);
    const attached = await (new RuntimeConnection(transport)).attach(context);
    return new RuntimeClient(
      attached,
      options.trustSnapshot?.actingPrincipal ?? options.identity,
      pageSettingsFrom(options),
    );
  }

  static async initialize(
    transport: RuntimeTransport,
    options: RuntimeClientOptions,
  ): Promise<RuntimeClient> {
    assertRenderDeclassificationPolicy(options.renderDeclassificationPolicy);
    // The `satisfies` clause requires every `InitializationData` key, so a
    // field added to that type is a type error here until this literal names
    // it. `initialize()` checks the values.
    const data = {
      apiUrl: options.apiUrl.toString(),
      spaceHostMap: options.spaceHostMap,
      identity: options.identity.keyPair,
      spaceDid: options.spaceDid,
      experimental: options.experimental,
      cfcEnforcementMode: options.cfcEnforcementMode,
      cfcFlowLabels: options.cfcFlowLabels,
      cfcReadMaxConfidentiality: options.cfcReadMaxConfidentiality,
      cfcReadOnExceed: options.cfcReadOnExceed,
      cfcTrustConfig: options.cfcTrustConfig,
      renderDeclassificationPolicy: options.renderDeclassificationPolicy,
      renderConfidentialityCeiling: options.renderConfidentialityCeiling,
      trustSnapshot: options.trustSnapshot,
      forwardWorkerConsole: options.forwardWorkerConsole,
      patternCoverage: options.patternCoverage,
      concurrentWatchRefresh: options.concurrentWatchRefresh,
      awaitHealth: options.awaitHealth,
    } satisfies EveryFieldOf<InitializationData>;
    const initialized = await (new RuntimeConnection(transport)).initialize(
      data,
    );
    return new RuntimeClient(
      initialized,
      options.trustSnapshot?.actingPrincipal ?? options.identity.did(),
      pageSettingsFrom(options),
    );
  }

  getCellFromRef<T>(
    ref: CellRef,
  ): CellHandle<T> {
    return new CellHandle<T>(this, ref);
  }

  // TODO(unused)
  // Currently unused in shell, but a PiecesController-like layer
  // could be built using this
  async getCell<T>(
    space: DID,
    cause: FabricValue,
    schema?: JSONSchema,
  ): Promise<CellHandle<T>> {
    const response = await this.#conn.request<RequestType.GetCell>({
      type: RequestType.GetCell,
      space,
      cause,
      schema,
    });

    return new CellHandle<T>(this, response.cell);
  }

  /**
   * Reads a validated Home catalog snapshot without starting Home UI.
   * Failed, refused, or malformed reads reject; only a successful storage
   * read can report an absent catalog.
   */
  getSharedSpaceCatalog(
    home: SharedSpaceCatalogHome,
  ): Promise<SharedSpaceCatalogRead> {
    return this.#conn.request<RequestType.GetSharedSpaceCatalog>({
      type: RequestType.GetSharedSpaceCatalog,
      home,
    });
  }

  /**
   * Registers an application-validated space in Home, preserving membership.
   * Resolves after the transaction commits; errors leave completion unknown.
   */
  registerSharedSpace(
    home: SharedSpaceCatalogHome,
    registration: SharedSpaceRegistration,
  ): Promise<SharedSpaceRegistrationResult> {
    return this.#conn.request<RequestType.RegisterSharedSpace>({
      type: RequestType.RegisterSharedSpace,
      home,
      registration,
    });
  }

  /**
   * Commits or confirms an explicit collection choice. A lost reply is
   * confirmed by repeating the same action, never by rebasing its revision.
   */
  changeSharedSpaceMembership(
    home: SharedSpaceCatalogHome,
    change: SharedSpaceMembershipChange,
  ): Promise<SharedSpaceMembershipResult> {
    return this.#conn.request<RequestType.ChangeSharedSpaceMembership>({
      type: RequestType.ChangeSharedSpaceMembership,
      home,
      change,
    });
  }

  async getHomeSpaceCell(): Promise<CellHandle<unknown>> {
    const response = await this.#conn.request<RequestType.GetHomeSpaceCell>({
      type: RequestType.GetHomeSpaceCell,
    });
    return new CellHandle(this, response.cell);
  }

  /**
   * Ensure the home space's default pattern is running and return a CellHandle to it.
   * This starts the pattern if needed and waits for it to be ready.
   */
  async ensureHomePatternRunning(): Promise<CellHandle<unknown>> {
    const response = await this.#conn.request<
      RequestType.EnsureHomePatternRunning
    >({
      type: RequestType.EnsureHomePatternRunning,
    });
    return new CellHandle(this, response.cell);
  }

  /**
   * Wait until the worker runtime is quiescent AND every issued commit has
   * been confirmed by the server (or terminally failed). This is the client's
   * "safe to navigate or reload" checkpoint: once it resolves, tearing the
   * page down loses no writes. Waits for the joint fixpoint of reactive
   * quiescence and commit durability (Scheduler.idleWithPendingCommits), not
   * for pulls or subscription convergence — that is `allSynced()`.
   */
  async idle(): Promise<void> {
    await this.#conn.request<RequestType.Idle>({ type: RequestType.Idle });
  }

  /** Discover retained terminal delivery notices after navigation or a fresh
   * worker, resolving each index hint against its authoritative stream entry. */
  async listEventAttention(space: DID): Promise<EventAttentionNotice[]> {
    const response = await this.#conn.request<RequestType.ListEventAttention>({
      type: RequestType.ListEventAttention,
      space,
    }) as EventAttentionListResponse;
    return response.notices;
  }

  /** Retry or dismiss one notice under this runtime's authenticated session. */
  async resolveEventAttention(
    notice: Pick<
      EventAttentionNotice,
      "space" | "eventId" | "seq" | "sidecarId"
    >,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResponse["resolution"]> {
    const response = await this.#conn.request<
      RequestType.ResolveEventAttention
    >({
      type: RequestType.ResolveEventAttention,
      space: notice.space,
      eventId: notice.eventId,
      seq: notice.seq,
      sidecarId: notice.sidecarId,
      action,
    }) as EventAttentionResolveResponse;
    return response.resolution;
  }

  /**
   * Await all in-flight compile-cache write-backs in the worker. Narrower than
   * `idle()`: it flushes only the compile cache, so a subsequent load of an
   * already-compiled pattern reads the cached entry instead of recompiling
   * in-client, without waiting for runtime quiescence.
   */
  async flushCompileCacheWrites(): Promise<void> {
    await this.#conn.request<RequestType.FlushCompileCacheWrites>({
      type: RequestType.FlushCompileCacheWrites,
    });
  }

  /**
   * Creates a piece in the given space, from a URL, a program, or the source
   * of a single-file one.
   *
   * `options.argument` is the piece's input, which is a record: a piece is
   * created with named inputs or with none. `options.cause` derives the
   * piece identity within its space. Reusing a cause reapplies setup to the
   * same piece and requires the same pattern identity; a different pattern
   * is rejected. Omitting the cause creates a new identity.
   */
  async createPiece<T = unknown>(
    input: string | URL | Program,
    space: DID,
    options?: { argument?: FabricPlainObject; run?: boolean; cause?: string },
  ): Promise<PieceHandle<T>> {
    const source = input instanceof URL
      ? { url: input.href }
      : typeof input === "string"
      ? {
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: input,
          }],
        },
      }
      : { program: input };

    const response = await this.#conn.request<
      RequestType.PieceCreate
    >({
      type: RequestType.PieceCreate,
      space,
      source,
      argument: options?.argument,
      run: options?.run,
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });

    return new PieceHandle<T>(this, response.piece);
  }

  // Piece operations name their space explicitly — there is no
  // implicit/default space at this layer. The worker resolves each
  // operation against that space's piece context over the same
  // connection.

  /**
   * The space's root pattern.
   *
   * `start` defaults to true, which is what a view that renders the root
   * needs. Pass false to read what the root exported without running it —
   * far cheaper on a space whose root reaches a large piece, and enough for
   * a caller that only wants an exported sub-page or listing.
   */
  async getSpaceRootPattern(
    space: DID,
    options: { start?: boolean } = {},
  ): Promise<PieceHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.GetSpaceRootPattern
    >({
      type: RequestType.GetSpaceRootPattern,
      space,
      ...(options.start === undefined ? {} : { start: options.start }),
    });
    return new PieceHandle<NameSchema>(this, response.piece);
  }

  /**
   * Creates a space owned by this runtime's identity, records it in the
   * identity's Home space list under `label`, and returns its DID once the
   * space's genesis commit is confirmed. The space's key is generated and used
   * inside the worker, and never crosses to this side.
   */
  async createSpace(label?: string): Promise<DID> {
    const response = await this.#conn.request<RequestType.CreateSpace>({
      type: RequestType.CreateSpace,
      ...(label === undefined ? {} : { label }),
    });
    return response.space;
  }

  async recreateSpaceRootPattern(
    space: DID,
  ): Promise<PieceHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.RecreateSpaceRootPattern
    >({
      type: RequestType.RecreateSpaceRootPattern,
      space,
    });
    return new PieceHandle<NameSchema>(this, response.piece);
  }

  async getPiece<T = unknown>(
    pieceId: string,
    space: DID,
    runIt?: boolean,
    scope?: CellScope,
  ): Promise<PieceHandle<T> | null> {
    const response = await this.#conn.request<RequestType.PieceGet>({
      type: RequestType.PieceGet,
      pieceId: pieceId,
      runIt,
      space,
      scope,
    });

    if (!response) return null;

    return new PieceHandle<T>(this, response.piece);
  }

  /**
   * Read a piece's source state: the pattern it runs, the origin it tracks, the
   * history metadata it carries, and its authored source files.
   */
  async getPieceSource(
    pieceId: string,
    space: DID,
    scope?: CellScope,
  ): Promise<PieceSourceView> {
    const response = await this.#conn.request<RequestType.PieceGetSource>({
      type: RequestType.PieceGetSource,
      pieceId,
      space,
      scope,
    });
    return response.source;
  }

  /** Read the retained authored files for one recorded source revision. */
  async getPieceSourceRevision(
    pieceId: string,
    space: DID,
    revisionId: string,
    scope?: CellScope,
  ): Promise<PieceSourceRevisionSourceView> {
    const response = await this.#conn.request<
      RequestType.PieceGetSourceRevision
    >({
      type: RequestType.PieceGetSourceRevision,
      pieceId,
      space,
      revisionId,
      scope,
    });
    return response.source;
  }

  /**
   * Create a copy that follows the selected piece's source. `options.scope` is
   * the scope the source piece sits in within `sourceSpace`.
   */
  async clonePiece(
    pieceId: string,
    sourceSpace: DID,
    destinationSpace: DID,
    options: { copyData?: boolean; scope?: CellScope } = {},
  ): Promise<PieceHandle> {
    const response = await this.#conn.request<RequestType.PieceClone>({
      type: RequestType.PieceClone,
      pieceId,
      sourceSpace,
      destinationSpace,
      scope: options.scope,
      ...(options.copyData === true ? { copyData: true } : {}),
    });
    return new PieceHandle(this, response.piece);
  }

  /**
   * Change a piece's source lifecycle state and return the resulting source
   * view. An incompatible candidate is returned as a warning without mutation.
   */
  async updatePieceSource(
    pieceId: string,
    space: DID,
    action: PieceSourceAction,
    options: { confirmationToken?: string; scope?: CellScope } = {},
  ): Promise<PieceUpdateSourceResponse> {
    return await this.#conn.request<RequestType.PieceUpdateSource>({
      type: RequestType.PieceUpdateSource,
      pieceId,
      space,
      action,
      scope: options.scope,
      ...(options.confirmationToken === undefined
        ? {}
        : { confirmationToken: options.confirmationToken }),
    });
  }

  /** Read a space's ACL and whether the active principal may change it. */
  async getSpaceAcl(space: DID): Promise<SpaceAclView> {
    const response = await this.#conn.request<RequestType.SpaceGetAcl>({
      type: RequestType.SpaceGetAcl,
      space,
    });
    return response.access;
  }

  /** Add or replace one entry in a space ACL. */
  async setSpaceAclEntry(
    space: DID,
    user: string,
    capability: SpaceAclCapability,
  ): Promise<SpaceAclView> {
    const response = await this.#conn.request<RequestType.SpaceSetAclEntry>({
      type: RequestType.SpaceSetAclEntry,
      space,
      user,
      capability,
    });
    return response.access;
  }

  /** Remove one entry from a space ACL. */
  async removeSpaceAclEntry(
    space: DID,
    user: string,
  ): Promise<SpaceAclView> {
    const response = await this.#conn.request<RequestType.SpaceRemoveAclEntry>({
      type: RequestType.SpaceRemoveAclEntry,
      space,
      user,
    });
    return response.access;
  }

  async getPieceSlug(
    pieceId: string,
    space: DID,
    scope?: CellScope,
  ): Promise<string | undefined> {
    const response = await this.#conn.request<RequestType.PieceGetSlug>({
      type: RequestType.PieceGetSlug,
      pieceId,
      space,
      scope,
    });
    return response.slug;
  }

  /**
   * Where a slug reference lands: the piece it reached, and the segments the
   * walk did not spend. The piece comes back unstarted — {@link getPiece},
   * addressed by its id, is what starts one.
   *
   * A name nobody bound, a member a collection does not hold, and a target
   * that is no piece all come back as a `refusal`: they answer the question
   * asked, and a caller has to tell them from a fault in the asking, which
   * wants a retry rather than a report.
   *
   * @param member One member name, absent where the reference stops at the
   *   slug. A member's own fields are a cell path inside the piece it
   *   resolves to, never a second member name.
   * @throws When the asking itself fails — a transport that dropped, a
   *   document that will not decode — or when the answer is neither a piece
   *   nor a refusal.
   */
  async resolveSlug<T = unknown>(
    slug: string,
    space: DID,
    member?: string,
  ): Promise<
    | { piece: PieceHandle<T>; pathAfter: string[]; refusal?: undefined }
    | { piece?: undefined; pathAfter?: undefined; refusal: SlugRefusal }
  > {
    const response = await this.#conn.request<RequestType.SlugResolve>({
      type: RequestType.SlugResolve,
      slug,
      member,
      space,
    });

    // The type makes a response carrying both arms unconstructable; a message
    // off the wire is not type-checked, so the same exclusivity is asserted
    // here rather than restated. Exactly one arm: both and neither are the
    // same fault, and reading the refusal first would report either of them
    // as an ordinary "no such member".
    const landed = response.piece !== undefined;
    const refused = response.refusal !== undefined;
    if (landed === refused) {
      throw new Error(
        `Resolving the slug "${slug}" answered with ${
          landed
            ? "both a piece and a refusal"
            : "neither a piece nor a refusal"
        }.`,
      );
    }
    if (response.refusal) return { refusal: response.refusal };
    if (response.piece === undefined || response.pathAfter === undefined) {
      // A landing is the piece AND what the walk did not spend. Defaulting
      // the path would turn a truncated answer into "the member was spent",
      // which is the fact a citation is offered on.
      throw new Error(
        `Resolving the slug "${slug}" answered with a piece and no path.`,
      );
    }
    return {
      piece: new PieceHandle<T>(this, response.piece),
      pathAfter: response.pathAfter,
    };
  }

  async removePiece(
    pieceId: string,
    space: DID,
    scope?: CellScope,
  ): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PieceRemove>({
      type: RequestType.PieceRemove,
      pieceId: pieceId,
      space,
      scope,
    });
    return res.value;
  }

  /**
   * Get the pieces list cell.
   * Subscribe to this cell to get reactive updates of registered pieces in the
   * space. This is not a storage-wide piece listing.
   */
  async getPiecesListCell<T>(space: DID): Promise<CellHandle<T[]>> {
    const response = await this.#conn.request<RequestType.PieceGetAll>({
      type: RequestType.PieceGetAll,
      space,
    });

    return new CellHandle<T[]>(this, response.cell);
  }

  /**
   * Wait for the space's pieces controller to be synced with storage.
   *
   * Note: storage sync is connection-wide, so this awaits all open
   * spaces; `space` only selects which space's piece context (and its
   * space-cell sync) to await — and lazily opens that context if this
   * is the first operation to touch the space.
   */
  async synced(space: DID): Promise<void> {
    await this.#conn.request<RequestType.PieceSynced>({
      type: RequestType.PieceSynced,
      space,
    });
  }

  /**
   * Record a runtime-learned HTTP or HTTPS host hint for a space
   * (site-table v0). This makes a just-learned space-to-host fact effective
   * on the live runtime. The durable record belongs in the home-space table;
   * this is the immediate, in-session half. Returns whether the worker
   * accepted or confirmed the hint. A seed or accepted late hint fixes the
   * route for the session. The first hint can replace a read-only provisional
   * default-host provider and replay its reads. Callers must not mount the space
   * under this hint when the method returns false.
   */
  async registerSpaceHost(space: DID, host: string): Promise<boolean> {
    const res = await this.#conn.request<RequestType.RegisterSpaceHost>({
      type: RequestType.RegisterSpaceHost,
      space,
      host,
    });
    return res.value;
  }

  /**
   * Record a host hint for a space as {@link registerSpaceHost} does, and
   * return the reason along with a refusal. `known-different-host` carries the
   * host the space is routed to. `default-route-in-use` is about this session alone:
   * the space issued a stateful operation through the default host, and a
   * runtime created later can still take the hint. Callers must not mount the
   * space under this hint unless `accepted` is true.
   */
  async registerSpaceHostDetailed(
    space: DID,
    host: string,
  ): Promise<SpaceHostRegistration> {
    const res = await this.#conn.request<
      RequestType.RegisterSpaceHostDetailed
    >({
      type: RequestType.RegisterSpaceHostDetailed,
      space,
      host,
    });
    return res.registration;
  }

  /**
   * Asks the memory server once more for `space`, if it refused this
   * runtime's session there, and resolves once the server has decided. An
   * admission runs again every computation whose `spaceAccess(target)`
   * answer turned on the refusal, and repeats the loads the refusal failed; a
   * refusal leaves the space refused. It is for a host with word that the
   * runtime's principal was granted access, such as a notice naming the
   * space, and does nothing for a space the runtime has not opened. It
   * rejects on any failure other than a refusal.
   */
  async retrySpaceAccess(space: DID): Promise<void> {
    await this.#conn.request<RequestType.RetrySpaceAccess>({
      type: RequestType.RetrySpaceAccess,
      space,
    });
  }

  /**
   * Wait for convergence across EVERY space this worker has opened.
   * Spaceless by design (like idle) — for quiescence checks that don't
   * care about any particular space, e.g. test/debug harnesses.
   */
  async allSynced(): Promise<void> {
    await this.#conn.request<RequestType.RuntimeSynced>({
      type: RequestType.RuntimeSynced,
    });
  }

  async getGraphSnapshot(): Promise<SchedulerGraphSnapshot> {
    const res = await this.#conn.request<RequestType.GetGraphSnapshot>({
      type: RequestType.GetGraphSnapshot,
    });
    return res.snapshot;
  }

  getSubscriptionDiagnostics(): SubscriptionDiagnostics {
    return this.#conn.getSubscriptionDiagnostics();
  }

  /**
   * Snapshot of in-flight IPC requests (sent to the worker, not yet answered).
   * Main-thread state only — needs no worker round-trip, so it works even when
   * the worker is wedged. Exposed on `commonfabric.rt` so an integration-test
   * probe on a stuck page can name the request a UI await is blocked on.
   */
  getPendingRequests(): PendingRequestDiagnostic[] {
    return this.#conn.getPendingRequestDiagnostics();
  }

  /**
   * Bounded send/settle timeline of the first IPC requests on this
   * connection — the boot window. Main-thread state only, like
   * getPendingRequests. Where the per-type histograms say a request was slow,
   * this says when it was sent and what overlapped it.
   */
  getRequestTimeline(): RequestTimelineEntry[] {
    return this.#conn.getRequestTimelineDiagnostics();
  }

  resetSubscriptionDiagnostics(): void {
    this.#conn.resetSubscriptionDiagnostics();
  }

  /**
   * Snapshot pending writes and session progress without awaiting idle or sync.
   * Null means the worker's storage manager does not expose diagnostics.
   */
  async getStorageDiagnostics() {
    const res = await this.#conn.request<RequestType.GetStorageDiagnostics>({
      type: RequestType.GetStorageDiagnostics,
    });
    return res.diagnostics;
  }

  async getLoggerCounts(): Promise<{
    counts: LoggerCountsData;
    metadata: LoggerMetadata;
    timing: LoggerTimingData;
    flags: LoggerFlagsData;
    cfc: Record<string, number>;
  }> {
    const res = await this.#conn.request<RequestType.GetLoggerCounts>({
      type: RequestType.GetLoggerCounts,
    });
    return {
      counts: res.counts,
      metadata: res.metadata,
      timing: res.timing,
      flags: res.flags,
      cfc: res.cfc,
    };
  }

  /**
   * Pull the worker runtime's accumulated pattern-coverage spans and hit counts,
   * or `null` when this worker was not started with coverage on. The integration
   * harness calls this once at teardown (through `commonfabric.rt`) and merges
   * the result with the other realms' coverage. See docs/development/COVERAGE.md.
   */
  async getPatternCoverage(): Promise<PatternCoverageData | null> {
    const res = await this.#conn.request<RequestType.GetPatternCoverage>({
      type: RequestType.GetPatternCoverage,
    });
    return res.data;
  }

  /**
   * Set log level for a logger in the worker.
   * @param level - The log level to set
   * @param loggerName - Optional logger name. If not provided, sets level for all loggers.
   */
  async setLoggerLevel(level: LogLevel, loggerName?: string): Promise<void> {
    await this.#conn.request<RequestType.SetLoggerLevel>({
      type: RequestType.SetLoggerLevel,
      level,
      loggerName,
    });
  }

  /**
   * Enable or disable a logger in the worker.
   * @param enabled - Whether to enable or disable the logger
   * @param loggerName - Optional logger name. If not provided, sets enabled for all loggers.
   */
  async setLoggerEnabled(enabled: boolean, loggerName?: string): Promise<void> {
    await this.#conn.request<RequestType.SetLoggerEnabled>({
      type: RequestType.SetLoggerEnabled,
      enabled,
      loggerName,
    });
  }

  /**
   * Enable or disable telemetry data emission from the worker.
   * When disabled, telemetry events will not be sent over IPC.
   * @param enabled - Whether to enable or disable telemetry
   */
  async setTelemetryEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetTelemetryEnabled>({
      type: RequestType.SetTelemetryEnabled,
      enabled,
    });
  }

  /**
   * Measures subsequent reactive action bodies in the worker. Read samples
   * appear in action statistics and in completion events when telemetry is on.
   */
  async setReadStatsEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetReadStatsEnabled>({
      type: RequestType.SetReadStatsEnabled,
      enabled,
    });
  }

  /** Changes memory WebSocket compression without reconnecting. */
  async setMemoryMessageCompression(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetMemoryMessageCompression>({
      type: RequestType.SetMemoryMessageCompression,
      enabled,
    });
  }

  /**
   * Enable or disable forwarding of the worker runtime's console output to the
   * main thread for the running worker. Takes effect immediately, without a
   * reload. When disabled the worker restores its native console methods, so
   * there is no per-log cost while off.
   */
  async setForwardWorkerConsole(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetForwardWorkerConsole>({
      type: RequestType.SetForwardWorkerConsole,
      enabled,
    });
  }

  /**
   * Reset logger baselines for both counts and timing in the worker.
   * After calling this, loggers will track deltas from this baseline.
   */
  async resetLoggerBaselines(): Promise<void> {
    await this.#conn.request<RequestType.ResetLoggerBaselines>({
      type: RequestType.ResetLoggerBaselines,
    });
  }

  /**
   * Enable or disable collection of settle stats in the worker scheduler.
   * When disabled, the last captured settle stats are cleared.
   */
  async setSettleStatsEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetSettleStatsEnabled>({
      type: RequestType.SetSettleStatsEnabled,
      enabled,
    });
  }

  /**
   * Return settle stats captured during the last worker scheduler execute() call.
   * Returns null if settle stats are disabled or no execute() has been captured yet.
   */
  async getSettleStats(): Promise<SettleStats | null> {
    const res = await this.#conn.request<RequestType.GetSettleStats>({
      type: RequestType.GetSettleStats,
    });
    return res.stats;
  }

  /**
   * Return recent settle stats history captured from worker execute() calls.
   * Entries are ordered oldest first.
   */
  async getSettleStatsHistory(): Promise<readonly SettleStatsHistoryEntry[]> {
    const res = await this.#conn.request<RequestType.GetSettleStatsHistory>({
      type: RequestType.GetSettleStatsHistory,
    });
    return res.history;
  }

  /**
   * Return recent exact action-run history captured from worker scheduler runs.
   * Entries are ordered oldest first.
   */
  async getActionRunTrace(): Promise<readonly ActionRunTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetActionRunTrace>({
      type: RequestType.GetActionRunTrace,
    });
    return res.trace;
  }

  /**
   * Enable or disable collection of exact action-run history in the worker scheduler.
   * When disabled, the current action-run history buffer is cleared.
   */
  async setActionRunTraceEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetActionRunTraceEnabled>({
      type: RequestType.SetActionRunTraceEnabled,
      enabled,
    });
  }

  /**
   * Enable or disable collection of structured trigger-trace entries in the worker scheduler.
   * When disabled, the current trigger trace buffer is cleared.
   */
  async setTriggerTraceEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetTriggerTraceEnabled>({
      type: RequestType.SetTriggerTraceEnabled,
      enabled,
    });
  }

  /**
   * Return recent structured trigger-trace entries captured from worker storage changes.
   * Entries are ordered oldest first.
   */
  async getTriggerTrace(): Promise<readonly TriggerTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetTriggerTrace>({
      type: RequestType.GetTriggerTrace,
    });
    return res.trace;
  }

  /**
   * Configure transaction-level write stack tracing in the worker.
   * Passing an empty matcher list disables the probe and clears prior entries.
   */
  async setWriteStackTraceMatchers(
    matchers: WriteStackTraceMatcher[],
  ): Promise<void> {
    await this.#conn.request<RequestType.SetWriteStackTraceMatchers>({
      type: RequestType.SetWriteStackTraceMatchers,
      matchers,
    });
  }

  /**
   * Return recent transaction-level write stack trace entries from the worker.
   * Entries are ordered oldest first.
   */
  async getWriteStackTrace(): Promise<readonly WriteStackTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetWriteStackTrace>({
      type: RequestType.GetWriteStackTrace,
    });
    return res.trace;
  }

  /**
   * Run non-idempotent computation detection.
   * Returns a report of non-idempotent actions found.
   */
  async getPatternSources(): Promise<PatternSourcesResponse> {
    return await this.#conn.request<RequestType.GetPatternSources>({
      type: RequestType.GetPatternSources,
    });
  }

  async setBreakpoints(actionIds: string[]): Promise<void> {
    await this.#conn.request<RequestType.SetBreakpoints>({
      type: RequestType.SetBreakpoints,
      actionIds,
    });
  }

  /**
   * Uploads a blob to the given space. `body` is given as a view or as a whole
   * buffer, and is copied into the immutable value that crosses, so the caller
   * may keep using it.
   */
  async uploadBlob(options: {
    space: DID;
    contentType: string;
    body: Uint8Array | ArrayBufferLike;
    suffix?: string;
  }): Promise<UploadBlobResponse> {
    return await this.#conn.request<RequestType.UploadBlob>({
      type: RequestType.UploadBlob,
      space: options.space,
      contentType: options.contentType,
      body: new FabricBytes(options.body),
      suffix: options.suffix,
    });
  }

  async detectNonIdempotent(
    durationMs?: number,
  ): Promise<SchedulerDiagnosisResult> {
    const res = await this.#conn.request<RequestType.DetectNonIdempotent>({
      type: RequestType.DetectNonIdempotent,
      durationMs,
    });
    return res.result;
  }

  async dispose(): Promise<void> {
    this.#operationSubscriptions.clear();
    await this.#conn.dispose();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  [$conn](): InitializedRuntimeConnection {
    return this.#conn;
  }

  #onConsole = (data: ConsoleMessage): void => {
    this.emit("console", data);
  };

  #onNavigateRequest = (data: NavigateRequestNotification): void => {
    this.emit("navigaterequest", {
      cell: new CellHandle(this, data.targetCellRef),
    });
  };

  #onError = (data: ErrorNotification): void => {
    this.emit("error", data);
  };

  #onEventIntentOutcome = (
    { space, eventId, kind, reason }: EventIntentOutcomeNotification,
  ): void => {
    this.emit("eventintentoutcome", { space, eventId, kind, reason });
  };

  #onSpaceAccessLost = ({ space }: SpaceAccessLostNotification): void => {
    this.emit("spaceaccesslost", { space });
  };

  #onTelemetry = (data: TelemetryNotification): void => {
    this.emit("telemetry", data.marker);
  };

  #onPendingWritesChange = (
    data: PendingWritesNotification,
  ): void => {
    this.#pendingWrites = data.pending;
    this.emit("pendingwriteschange", { pending: data.pending });
  };

  #onOperationUpdate = (data: OperationUpdateNotification): void => {
    this.#operationSubscriptions.get(data.subscriptionId)?.(
      data.field,
    );
  };

  #onPresenceUpdate = (data: PresenceUpdateNotification): void => {
    const join = this.#presenceJoinsBySubscription.get(data.subscriptionId);
    if (join !== undefined) {
      join.early.push(data.event);
      // The join's own membership has failed, so a later caller joins afresh
      // rather than waiting on it.
      if (data.event.kind === "failure") this.#forgetPresenceJoin(join);
      return;
    }
    const room = this.#presenceBySubscription.get(data.subscriptionId);
    if (room !== undefined) this.#receivePresence(room, data.event);
  };

  /**
   * Applies one of the worker's events to the room and delivers it to the
   * room's handles. An event that changes nothing is not delivered, and an
   * ended room takes none.
   */
  #receivePresence(room: PresenceRoomState, wire: PresenceWireEvent): void {
    if (room.ended) return;
    let event: PresenceEvent;
    switch (wire.kind) {
      case "snapshot":
        room.participantId = wire.participantId;
        room.participants = new Map(
          wire.participants.map((participant) => [
            participant.participantId,
            participant,
          ]),
        );
        event = wire;
        break;
      case "upsert": {
        const held = room.participants.get(wire.participant.participantId);
        if (held !== undefined && held.revision >= wire.participant.revision) {
          return;
        }
        room.participants.set(wire.participant.participantId, wire.participant);
        event = wire;
        break;
      }
      case "remove":
        if (!room.participants.delete(wire.participantId)) return;
        event = wire;
        break;
      case "failure": {
        const error = new Error(wire.error.message);
        error.name = wire.error.name;
        event = { kind: "failure", error };
        this.#endPresenceRoom(room);
        break;
      }
    }
    this.#deliverPresence(room, event);
  }

  /**
   * Starts a join of the room `requested` names, or of `ref`'s derived room
   * when it names none, and indexes the join until its room is decided or
   * its membership fails.
   */
  #joinPresence(
    ref: CellRef,
    cellKey: string,
    requested: string | undefined,
  ): PendingPresenceJoin {
    const settled = Promise.withResolvers<PresenceRoomState>();
    const join: PendingPresenceJoin = {
      subscriptionId: crypto.randomUUID(),
      early: [],
      handles: new Set(),
      room: settled.promise,
    };
    if (requested === undefined) {
      this.#presenceJoinsByCell.set(cellKey, join);
    } else {
      this.#presenceJoinsByRoom.set(
        presenceRoomKey(ref.space, requested),
        join,
      );
    }
    this.#presenceJoinsBySubscription.set(join.subscriptionId, join);
    this.#settlePresenceJoin(join, ref, cellKey, requested).then(
      settled.resolve,
      settled.reject,
    );
    return join;
  }

  /**
   * Helper for `#joinPresence()`, which waits out the worker's reply and
   * returns the room the join reached, holding the handles waiting on the
   * join. A derived room the client already holds, or is joining by name,
   * makes this join's membership redundant: it is left, and the join returns
   * that room. The join stops being found the moment its room is decided or
   * it fails, so a later caller finding that room ended joins afresh.
   */
  async #settlePresenceJoin(
    join: PendingPresenceJoin,
    ref: CellRef,
    cellKey: string,
    requested: string | undefined,
  ): Promise<PresenceRoomState> {
    try {
      let response: PresenceJoinResponse;
      try {
        response = await this.#conn.request<RequestType.PresenceJoin>({
          type: RequestType.PresenceJoin,
          subscriptionId: join.subscriptionId,
          cell: ref,
          ...(requested === undefined ? {} : { room: requested }),
        });
      } catch (error) {
        // The worker may have joined and lost only its reply. A best-effort
        // leave keeps a membership nobody holds from outliving the
        // connection.
        this.#leavePresence(join.subscriptionId);
        throw error;
      } finally {
        this.#presenceJoinsBySubscription.delete(join.subscriptionId);
      }
      const key = presenceRoomKey(ref.space, response.room);
      if (requested === undefined) {
        // A room another join holds or is joining is one this cell aliases.
        const held = this.#presenceRooms.get(key);
        if (held !== undefined && !held.ended) {
          this.#leavePresence(join.subscriptionId);
          this.#sharePresenceRoom(held, join, cellKey);
          return held;
        }
        const named = this.#presenceJoinsByRoom.get(key);
        if (named !== undefined) {
          this.#leavePresence(join.subscriptionId);
          const room = await named.room;
          this.#sharePresenceRoom(room, join, cellKey);
          return room;
        }
      }
      const room: PresenceRoomState = {
        key,
        subscriptionId: join.subscriptionId,
        room: response.room,
        participantId: response.participantId,
        participants: new Map(
          response.participants.map((participant) => [
            participant.participantId,
            participant,
          ]),
        ),
        handles: join.handles,
        name: "",
        frame: undefined,
        ended: false,
      };
      for (const event of join.early) this.#receivePresence(room, event);
      // A failure ahead of the reply let a replacement join start, which may
      // hold the room's key by now. The ended room is handed only to its own
      // callers, and the last of them to release it leaves the membership.
      if (room.ended) return room;
      this.#presenceRooms.set(key, room);
      this.#presenceBySubscription.set(room.subscriptionId, room);
      if (requested === undefined) this.#presenceByCell.set(cellKey, room);
      return room;
    } finally {
      this.#forgetPresenceJoin(join);
    }
  }

  /**
   * Helper for `#settlePresenceJoin()`, which hands the room another join
   * reached to the handles waiting on an alias's join, and indexes it by the
   * alias cell. An ended room takes neither.
   */
  #sharePresenceRoom(
    room: PresenceRoomState,
    join: PendingPresenceJoin,
    cellKey: string,
  ): void {
    if (room.ended) return;
    for (const handle of join.handles) room.handles.add(handle);
    this.#presenceByCell.set(cellKey, room);
  }

  /**
   * Takes `handle` off the room, republishing the room's record without its
   * facets, or leaving the room when it was the last handle. A handle the
   * room does not hold releases nothing.
   */
  async #releasePresenceHandle(
    room: PresenceRoomState,
    handle: PresenceHandleState,
  ): Promise<void> {
    if (!room.handles.delete(handle)) return;
    if (room.handles.size > 0) {
      if (handle.facets.size > 0) this.#schedulePresencePublish(room);
      return;
    }
    this.#forgetPresenceRoom(room);
    await this.#conn.request<RequestType.PresenceLeave>({
      type: RequestType.PresenceLeave,
      subscriptionId: room.subscriptionId,
    }).catch(() => undefined);
  }

  #leavePresence(subscriptionId: string): void {
    void this.#conn.request<RequestType.PresenceLeave>({
      type: RequestType.PresenceLeave,
      subscriptionId,
    }).catch(() => undefined);
  }

  #schedulePresencePublish(room: PresenceRoomState): void {
    if (room.frame !== undefined || room.ended) return;
    room.frame = scheduleAnimationFrame(() => {
      room.frame = undefined;
      this.#publishPresence(room);
    });
  }

  /**
   * Sends the room's record as it stands: the room's name and every
   * handle's facets merged. A facet two handles set is the focused
   * handle's, and among handles alike in focus the one that set it last.
   * Nothing is sent without a name. A refusal ends the room with a
   * `failure`.
   */
  #publishPresence(room: PresenceRoomState): void {
    if (
      room.ended || room.name.length === 0 || room.handles.size === 0 ||
      this.#presenceRooms.get(room.key) !== room
    ) {
      return;
    }
    const facets: Record<string, FabricPlainObject> = {};
    const ranks = new Map<string, [number, number]>();
    for (const handle of room.handles) {
      for (const [facet, { value, revision }] of handle.facets) {
        const rank: [number, number] = [handle.focused ? 1 : 0, revision];
        const held = ranks.get(facet);
        if (
          held !== undefined &&
          (held[0] > rank[0] || (held[0] === rank[0] && held[1] > rank[1]))
        ) {
          continue;
        }
        ranks.set(facet, rank);
        facets[facet] = value;
      }
    }
    void this.#conn.request<RequestType.PresencePublish>({
      type: RequestType.PresencePublish,
      subscriptionId: room.subscriptionId,
      name: room.name,
      facets,
    }).catch((cause) => {
      if (room.ended) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#endPresenceRoom(room);
      this.#deliverPresence(room, { kind: "failure", error });
    });
  }

  #deliverPresence(room: PresenceRoomState, event: PresenceEvent): void {
    for (const handle of [...room.handles]) {
      for (const listener of [...handle.listeners]) {
        try {
          listener(event);
        } catch (cause) {
          console.error("presence listener threw:", cause);
        }
      }
    }
  }

  #endPresenceRoom(room: PresenceRoomState): void {
    room.ended = true;
    if (
      room.frame !== undefined &&
      typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(room.frame);
    }
    room.frame = undefined;
  }

  /**
   * Drops the room from every index, and marks it ended so that nothing more
   * is published or delivered through it, and no alias's join shares it.
   */
  #forgetPresenceRoom(room: PresenceRoomState): void {
    room.ended = true;
    if (this.#presenceRooms.get(room.key) === room) {
      this.#presenceRooms.delete(room.key);
    }
    for (const [cellKey, held] of [...this.#presenceByCell]) {
      if (held === room) this.#presenceByCell.delete(cellKey);
    }
    if (this.#presenceBySubscription.get(room.subscriptionId) === room) {
      this.#presenceBySubscription.delete(room.subscriptionId);
    }
  }

  /** Drops a join from the indexes a later join would find it by. */
  #forgetPresenceJoin(join: PendingPresenceJoin): void {
    const indexes = [this.#presenceJoinsByRoom, this.#presenceJoinsByCell];
    for (const joins of indexes) {
      for (const [key, held] of [...joins]) {
        if (held === join) joins.delete(key);
      }
    }
  }

  #onEventNeedsAttention = (
    data: EventNeedsAttentionNotification,
  ): void => {
    const { type: _type, ...notice } = data;
    this.emit("eventneedsattention", notice);
  };
}
