import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { type NormalizedFullLink } from "../link-utils.ts";
import {
  isRendererTrustedEvent,
  propagateRendererTrustedEvent,
} from "../cfc/ui-contract.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { ServedEventDispatch } from "./types.ts";

// Wake shaping (timing side-channel mitigation, see
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md). The moment a pattern observes
// a change is the last sub-second timing signal the runtime hands it, and it
// arrives on two paths: an *event* delivered to a handler through the
// scheduler's event queue (channel 3), and a *cell flip* propagating through
// the reactive graph — a renderer `$value` keystroke write or a server-pushed
// change — which never touches the event queue (channels 4 and 5). This module
// is the single shaping choke point for both (plan C): one token-bucket engine
// (WakeShaper), with a thin per-path adapter that fixes the semantics each path
// needs.
//
// The threat is a SUSTAINED high-frequency stream (held-key autorepeat,
// rhythmic tapping, a chatty background source) used as a reference oscillator
// to time other operations at sub-second resolution. The capability gate (W1)
// already denies a direct sub-second clock, so the job here is to floor the
// SUSTAINED cadence a pattern can observe while leaving ordinary interaction
// realtime:
//
//   - a per-group token bucket of BURST_CAPACITY tokens, one consumed per
//     delivery, refilling one per MAX_DELIVERY_DELAY_MS window. While tokens
//     remain, each wake is delivered realtime (the burst). Once the bucket
//     empties, further wakes queue and release as ONE batch per window — one
//     timing sample — and the bucket refills during quiet, so a later burst is
//     realtime again.
//   - the group key identifies the observing pattern instance (all of one
//     pattern's wakes of one class share a bucket — the property that defeats
//     the count-the-deliveries attack), namespaced per path: `event:` groups
//     for the event queue, `cell:` groups for cell flips (further split
//     interactive-vs-push by the caller; see shapableWakeGroupKey in
//     invalidation.ts).
//
// Per-path semantics, expressed per hold:
//   - Overflow policy: event holds pass no item key, so every event is kept in
//     arrival order (a counter still counts every click). Cell holds pass the
//     cell identity as the item key, so overflow coalesces last-wins per cell
//     (only the current value of a data cell is meaningful) without dropping
//     any distinct cell.
//   - Leading-edge delivery: event holds deliver synchronously (the deliver
//     thunk only enqueues to the scheduler — no re-entrancy). Cell holds defer
//     to a fresh macrotask, off the storage-notification loop's stack. The
//     trailing flush always runs inside the window tick, which is already a
//     fresh macrotask.
//   - Charge sharing: a cell hold carries the source commit as its charge key,
//     and every reader wake from that one commit rides a single burst token —
//     a token counts one user gesture, not the fan-out of readers it wakes
//     (all of them observe the same instant: one timing sample).
//
// IMPORTANT: only *shapable* wakes (real-world timing: renderer input, server
// pushes) may be routed here. Routing ordinary internal computation through it
// would delay reactivity and break the runtime. Deciding shapability is the
// caller's job (shouldShapeDelivery for events; shapableWakeGroupKey in
// invalidation.ts for cell flips).
//
// Games and other apps that need precise input timing are out of scope.

const logger = getLogger("wake-shaping", { enabled: true, level: "warn" });

// The sustained-rate window: one burst token refills per window, so a sustained
// stream is floored to about one delivery per pattern per window.
export const MAX_DELIVERY_DELAY_MS = 1000;
// Burst headroom: how many rapid wakes are delivered in realtime before the
// sustained cap engages. Refills at one per window, so it is a one-time burst
// allowance restored only by quiet time, not a per-window budget.
export const BURST_CAPACITY = 10;

// Group-key namespaces, one per wake path. Distinct namespaces keep the two
// paths' budgets separate (an `event:` group never shares a bucket with a
// `cell:` group) and make the seams filterable (hasPending(CELL_GROUP_PREFIX)).
export const EVENT_GROUP_PREFIX = "event:";
export const CELL_GROUP_PREFIX = "cell:";

/** One shaped wake. See the module comment for the per-field semantics. */
export interface WakeHold {
  groupKey: string;

  /** Coalescing unit within the group; omitted, the wake is kept FIFO. */
  itemKey?: string;

  /** Same key as the group's last charged hold ⇒ ride that token. */
  chargeKey?: object;

  /** Deliver the leading edge on a fresh macrotask instead of synchronously. */
  defer?: boolean;

  deliver: () => void;
}

// Per-group token-bucket state. A group exists while a deferred delivery is in
// flight or overflow is pending, and stays alive while the bucket refills after
// activity; an idle, fully refilled bucket is closed.
interface ThrottleGroup {
  tokens: number;

  /** itemKey -> deliver thunk; unique keys preserve FIFO, shared keys coalesce. */
  pending: Map<string, () => void>;

  timer: ReturnType<typeof setTimeout> | undefined;

  /** Deferred leading-edge deliveries scheduled but not yet run. */
  inFlight: number;

  /**
   * The charge key of the hold that most recently took a burst token. Holds
   * carrying the same key ride that token instead of spending their own.
   */
  lastBurstCharge: object | undefined;

  /** Source of unique item keys for keep-all (FIFO) holds. */
  uniqueSeq: number;
}

export class WakeShaper {
  #groups = new Map<string, ThrottleGroup>();
  #windowMs: number;
  #capacity: number;
  #disposed = false;
  #drainWaiters: Array<() => void> = [];

  constructor(
    windowMs: number = MAX_DELIVERY_DELAY_MS,
    capacity: number = BURST_CAPACITY,
  ) {
    this.#windowMs = windowMs;
    this.#capacity = Math.max(1, capacity);
  }

  /**
   * Shape a wake. While burst tokens remain (or the hold rides its commit's
   * already-charged token) the wake is delivered realtime; once the bucket
   * empties, wakes queue per item key and release as one batch per window, so
   * the sustained rate is capped and nothing is dropped.
   */
  hold(hold: WakeHold): void {
    if (this.#disposed) return;
    let group = this.#groups.get(hold.groupKey);
    if (!group) {
      group = {
        tokens: this.#capacity,
        pending: new Map(),
        timer: undefined,
        inFlight: 0,
        lastBurstCharge: undefined,
        uniqueSeq: 0,
      };
      this.#groups.set(hold.groupKey, group);
    }
    // Ride the group's already-charged token when this hold carries the same
    // charge key; otherwise take a fresh token if one is available and no
    // overflow is queued ahead (preserving order). All of one commit's readers
    // are held synchronously, so `pending` stays empty across the riders.
    const sameCharge = hold.chargeKey !== undefined &&
      group.lastBurstCharge === hold.chargeKey;
    if (sameCharge || (group.tokens >= 1 && group.pending.size === 0)) {
      if (!sameCharge) {
        group.tokens -= 1;
        group.lastBurstCharge = hold.chargeKey;
      }
      if (hold.defer) {
        // Realtime, but off the caller's stack (the thunk runs a reactive
        // action; delivering inside hold() would re-enter the caller's loop).
        group.inFlight += 1;
        setTimeout(() => {
          if (this.#disposed) return;
          const g = this.#groups.get(hold.groupKey);
          if (g) g.inFlight -= 1;
          this.#runThunk(hold.deliver);
          this.#settle();
        }, 0);
      } else {
        this.#runThunk(hold.deliver);
      }
    } else {
      // Sustained overflow. A caller-supplied item key coalesces last-wins for
      // that item; without one the wake gets a unique key, so the Map keeps
      // every entry in arrival order.
      const itemKey = hold.itemKey ?? `#${group.uniqueSeq++}`;
      group.pending.set(itemKey, hold.deliver);
    }
    // Arm the refill/flush tick after scheduling the leading delivery, so the
    // leading edge always runs before the trailing flush even at a zero window.
    if (group.timer === undefined) {
      group.timer = setTimeout(
        () => this.#onTick(hold.groupKey),
        this.#windowMs,
      );
    }
  }

  #runThunk(deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      logger.error("wake-shaper-deliver-error", () => [error]);
    }
  }

  #onTick(groupKey: string): void {
    const group = this.#groups.get(groupKey);
    if (!group) return;
    group.tokens = Math.min(this.#capacity, group.tokens + 1); // refill one
    if (group.pending.size > 0) {
      // Trailing flush: release the whole coalesced batch as one timing sample
      // (in insertion order), consuming the refilled token.
      const batch = [...group.pending.values()];
      group.pending = new Map();
      group.tokens -= 1;
      for (const deliver of batch) this.#runThunk(deliver);
    }
    if (
      group.pending.size === 0 && group.inFlight === 0 &&
      group.tokens >= this.#capacity
    ) {
      // Fully refilled and idle: close the group (a fresh bucket next time).
      this.#groups.delete(groupKey);
    } else {
      group.timer = setTimeout(() => this.#onTick(groupKey), this.#windowMs);
    }
    this.#settle();
  }

  #settle(): void {
    if (this.hasPending()) return;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Whether any wake is currently held (queued overflow or a deferred leading
   * delivery in flight). With `groupPrefix`, only groups in that namespace are
   * considered (e.g. CELL_GROUP_PREFIX for the cell path alone).
   */
  hasPending(groupPrefix?: string): boolean {
    for (const [key, group] of this.#groups) {
      if (groupPrefix !== undefined && !key.startsWith(groupPrefix)) continue;
      if (group.inFlight > 0 || group.pending.size > 0) return true;
    }
    return false;
  }

  /** Resolves once every held wake (in flight or queued) has been delivered. */
  whenDrained(): Promise<void> {
    if (!this.hasPending()) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  dispose(): void {
    this.#disposed = true;
    for (const group of this.#groups.values()) {
      if (group.timer !== undefined) clearTimeout(group.timer);
    }
    this.#groups.clear();
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

//
// Event-path adapter (channel 3)
//

export interface DeliverOpts {
  eventId?: string;
  originTx?: IExtendedStorageTransaction;
  time?: number;

  /** Runtime-injection provenance, carried through a held delivery unchanged
   * so shaping can never strip the closed-world gate's exemption. Renderer
   * events (the only shapable class) are never injection sites, so this is
   * defensive plumbing, not a live path. */
  runtimeInjectedEventKeys?: readonly string[];

  /** The serving drain's per-event carriage (Phase 3), carried through a
   * held delivery unchanged — same defensive plumbing as above (drained
   * store entries are never renderer-trusted, so shaping never holds
   * them in practice). */
  served?: ServedEventDispatch;

  /** The client-echo cascade thread (QueuedEvent.parentEventId), carried
   * through a held delivery unchanged — defensive plumbing like `served`
   * (a cascade send from a handler frame is never renderer-trusted). */
  parentEventId?: string;
}

export type DeliverFn = (
  eventLink: NormalizedFullLink,
  event: unknown,
  retries: boolean,
  onCommit: ((tx: IExtendedStorageTransaction) => void) | undefined,
  opts: DeliverOpts,
) => void;

// A delivery is shapable when it carries renderer (user-input) provenance.
//
// A handler that is triggered by an already-rate-limited source and relays
// onward is not shaped a second time — but that transitivity is provided by the
// existing design, not by a mark here: a pattern relays through its `$event`,
// which the runtime materializes as an untrusted immutable-cell copy
// (runner.ts), so a relayed send is not renderer-trusted and
// shouldShapeDelivery returns false; and on the cell path a reader woken by a
// renderer-input write runs in a fresh, unmarked transaction, so its own
// downstream writes are ordinary internal commits and are never re-shaped. A
// downstream wake therefore cannot fire faster than the rate-limited source
// that caused it.
export function shouldShapeDelivery(event: unknown): boolean {
  return isRendererTrustedEvent(event);
}

const CLOCK_FIELD_NAMES = new Set(["timestamp", "timeStamp"]);

function hasClockFieldDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClockFieldDeep);
  if (isObjectOrArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (CLOCK_FIELD_NAMES.has(key)) return true;
      if (hasClockFieldDeep(child)) return true;
    }
  }
  return false;
}

function scrubClockFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubClockFields);
  if (isObjectOrArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (CLOCK_FIELD_NAMES.has(key)) continue;
      out[key] = scrubClockFields(child);
    }
    return out;
  }
  return value;
}

/**
 * Return a copy of the event with any injected wall-clock field removed at every
 * depth, so the payload reveals no sub-second timing. DOM events are already
 * serialized without their high-resolution `timeStamp`; the remaining leak is a
 * `timestamp`/`timeStamp` a UI component places anywhere in the event — including
 * nested inside `detail` (e.g. geolocation's `detail.location.timestamp`). The
 * CustomEvent `detail` is delivered through an unfiltered JSON round-trip, so the
 * scrub is a denylist applied at all depths rather than to two fixed keys.
 * Returns the same reference when there is nothing to strip.
 */
export function stripClockFields(event: unknown): unknown {
  if (!isObjectOrArray(event)) return event;
  if (!hasClockFieldDeep(event)) return event;
  return scrubClockFields(event);
}

function linkKey(
  link: NormalizedFullLink,
  identity: ScopeKeyIdentity,
): string {
  // Mirror the identity used by areNormalizedLinksSame (space, scope, id, and
  // element-wise path), with the scope segment resolved to the scope INSTANCE
  // (key-vocabulary.md §5's stage-F serving-hazard list): name-keyed, shaper
  // groups collapsed across principals — cross-principal budget consumption
  // and a timing channel correlating one principal's activity with another's
  // wakes. At cardinality 1 the resolved instance partitions exactly as the
  // name did (key-vocabulary.md §2). JSON-encode the path so distinct paths
  // cannot collide (e.g. ["a","b"] vs ["a b"]).
  return `${link.space}|${resolveScopeKey(link.scope, identity)}|${link.id}|${
    JSON.stringify(link.path)
  }`;
}

/**
 * The per-instance shaper group key for a pattern reader/handler. It combines
 * the owning space with the pieceId: the pieceId is `${scope}:${id}`, and the
 * id is content-addressed, so two instances of the same pattern in different
 * spaces can share a pieceId. Without the space, their wakes would collide into
 * one shaper bucket and one space's activity would consume or delay the other's
 * per-pattern burst budget (and expose a cross-space timing correlation). The
 * space is JSON-tuple-encoded with the pieceId so the two fields cannot run
 * together ambiguously. Returns undefined when no pieceId is known (internal
 * machinery), so the caller applies its own fallback.
 */
export function shaperInstanceGroupKey(
  identity: { ownerSpace?: string; pieceId?: string } | undefined,
): string | undefined {
  if (!identity?.pieceId) return undefined;
  return JSON.stringify([identity.ownerSpace ?? null, identity.pieceId]);
}

/**
 * Shape an event delivery (channel 3). `groupKey` identifies the owning pattern
 * instance (all of a pattern's input shares one bucket); when undefined the
 * stream itself is the group. Strips any injected clock field from the payload
 * (carrying the renderer-trust marker across to the stripped copy), keeps every
 * event (unique item keys — overflow is FIFO, not last-wins), and delivers
 * synchronously: `deliver` only enqueues to the scheduler, so there is no
 * re-entrancy. eventId/originTx ride through the hold so a released event keeps
 * its causal origin (the durable event id stays transaction-derived, speculation
 * lineage can still cancel it, and the W4 backlog collapse keeps distinguishing
 * origins).
 */
export function holdShapedEvent(
  shaper: WakeShaper,
  deliver: DeliverFn,
  groupKey: string | undefined,
  eventLink: NormalizedFullLink,
  identity: ScopeKeyIdentity,
  event: unknown,
  retries: boolean,
  onCommit: ((tx: IExtendedStorageTransaction) => void) | undefined,
  opts: DeliverOpts = {},
): void {
  const stripped = stripClockFields(event);
  // Stripping a clock field returns a fresh object; carry the renderer-trust
  // marker across so the delivered event still authorizes UI-contract writes.
  if (stripped !== event) propagateRendererTrustedEvent(event, stripped);
  const eventId = opts.eventId;
  const originTx = opts.originTx;
  // The event's time is captured at the original send and carried through the
  // hold, so a shaped (delayed) delivery still stamps the instant the user
  // acted rather than the instant the shaper released it.
  const time = opts.time;
  // Injection provenance rides the hold unchanged, so a shaped delivery
  // cannot silently strip the closed-world gate's exemption.
  const runtimeInjectedEventKeys = opts.runtimeInjectedEventKeys;
  // The served carriage rides too (round-2 thread T31): its own doc
  // promises "carried through a held delivery unchanged", and dropping
  // it here would strip the acting identity / stream-entry location /
  // failure hook from a shaped served dispatch.
  const served = opts.served;
  shaper.hold({
    // FLAGGED (PR #5439 thread r3731191482, unresolved semantic): the
    // fallback linkKey resolves the scope instance from the RUNTIME's
    // identity. On a serving runtime that is the ambient service
    // identity, so same-id scoped streams from different principals
    // would share one throttle bucket (cross-principal budget coupling
    // and a timing channel). The correct partition is the EVENT ACTOR's
    // identity — which does not exist as data until Phase 3 puts events
    // on the wire with a server-stamped `firedAt` actor (events.md;
    // plan Phase 3). Phase 1 has no server-side event producers, so the
    // coupling has no instances yet; when Phase 3 lands the actor
    // carriage, thread it here in place of the runtime identity.
    groupKey: EVENT_GROUP_PREFIX + (groupKey ?? linkKey(eventLink, identity)),
    deliver: () =>
      deliver(eventLink, stripped, retries, onCommit, {
        eventId,
        originTx,
        time,
        runtimeInjectedEventKeys,
        served,
      }),
  });
}

//
// Cell-path adapter (plan B, channels 4 and 5)
//

/**
 * Shape a cell-flip wake (plan B). `groupKey` identifies the observing pattern
 * instance and input class (see shapableWakeGroupKey in invalidation.ts);
 * `itemKey` is the cell identity, so sustained overflow coalesces last-wins per
 * cell without dropping any distinct cell; `chargeKey` is the source commit, so
 * one gesture's fan-out of reader wakes rides a single burst token. Delivery of
 * the leading edge is deferred to a fresh macrotask — the thunk runs a reactive
 * action, never inside the storage-notification loop.
 */
export function holdShapedCell(
  shaper: WakeShaper,
  groupKey: string,
  itemKey: string,
  chargeKey: object,
  deliver: () => void,
): void {
  shaper.hold({
    groupKey: CELL_GROUP_PREFIX + groupKey,
    itemKey,
    chargeKey,
    defer: true,
    deliver,
  });
}
