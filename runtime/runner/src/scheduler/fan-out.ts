// Server-execution v2 fan-out stage B — the run supply's per-node state:
// the KNOWN-SCOPE RATCHET, the instance-set function over (ratchet ×
// demanders), and B7's PRECISE per-instance dirtiness. Owner ruling
// (2026-08-16): "if a space scoped calculation gets narrowed to user,
// it'll have to run for all users that demand it" — scopes.md §2's
// mechanism sentence: a principal's demand at a broad address is demand
// for THAT principal's instance of every node that narrows beneath it.
//
// The node stays SINGULAR (the spec-model's C11b): instances live in
// keys, basis rows, stamps — and, here, in one per-node record that
// remembers what running has DISCOVERED (never what a schema or a body
// declares — D11's no-static-analysis rule; the ratchet's only writers
// are run outcomes). Nothing here is reached off the serving posture:
// a node acquires this state only when the demand registry supplies
// demanders for it, and the OFF arm's `runSchedulerAction` never does.
//
// The RATCHET is ragged-capable (scopes.md §2 as amended 2026-08-16,
// the panel's Lens 1): the top hop — space→(user|session) — is
// structural, so it is one node-level bit (the broad slot's redirect is
// SHARED state; a node that narrows for one principal narrows for
// everyone). Below it, depth is PER PRINCIPAL: a node may be user-scoped
// for Alice and session-scoped for Bob (a data-dependent second hop),
// so the ratchet is a set of session-deep principals, never a single
// level. It only narrows — per principal — and is forgotten with the
// node (re-learned by the next probe run).

import {
  type CellScope,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  toDirtyKey,
} from "@commonfabric/memory/v2";
import { ANY_INSTANCE } from "@commonfabric/memory/v2/currency-keys";
import { scopeRank } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityNameKey, invalidCauseKey } from "./keys.ts";
import type { ReactivityLog, SpaceScopeAndURI } from "./types.ts";

/** One demanded instance run of a fanned-out node. */
export interface FanOutInstance {
  /** The RESOLUTION identity: a full (principal, session) pair so a
   * narrower read the run discovers still resolves to a REAL demanded
   * instance (design §F). For a user-scoped instance the session is the
   * REPRESENTATIVE one (the smallest demanded session of that principal)
   * — resolution scaffolding, never attribution. */
  readonly identity: ScopeKeyIdentity;

  /** The instance key the run is stamped with: `space` for the probe,
   * `user:<p>` / `session:<p>:<s>` at the ratchet's depth for `p`. */
  readonly key: ScopeKey;
}

interface InstanceRecord {
  /** Whether this instance has an accepted result to retain while gated. */
  hasCommittedResult?: boolean;
  /** Whether a run of this instance has finished without being withdrawn
   * for a read it could not take as state: its output, absent or not, is
   * what it produced. */
  produced?: boolean;
  /** The latest sealed publication; write-free reruns retain its obligation. */
  pendingWaveRun?: object;

  identity: ScopeKeyIdentity;
  log?: ReactivityLog;

  /**
   * What the instance's latest run read where that run ended without
   * handing its writes over, so that `log` is still an earlier run's or
   * absent. A change to a document it read is a change to what the instance
   * was last computed from, as one to a document of `log` is.
   */
  attempt?: ReactivityLog;

  /** Whether a run of the instance is under way. */
  running?: boolean;

  /**
   * The documents `log` and `attempt` read, each by its space, the name of
   * its scope and its id (`entityNameKey()`), and the logs they were
   * collected from. Built when a cause that names no instance first asks,
   * and again once a later run has replaced either log.
   */
  documents?: {
    log: ReactivityLog | undefined;
    attempt: ReactivityLog | undefined;
    read: Set<SpaceScopeAndURI>;
  };

  /**
   * The causes naming no instance that arrived for a document this
   * instance's recorded run read, and that no run of it has taken yet, each
   * by `invalidCauseKey()`. A run of the instance takes only these among the
   * node's causes that name no instance as its trigger reads.
   */
  triggers?: Set<string>;

  /**
   * The causes naming no instance that arrived while the run under way was
   * running, for a document no earlier run of the instance is recorded to
   * have read: the document of each (`entityNameKey()`) by the cause's key.
   * The run under way may have read the document, which is known once it
   * ends (`fanOutRunFinished()`, `fanOutRunAborted()`). Empty whenever no
   * run is under way, so it holds no more than the distinct causes of one
   * run's duration.
   */
  arrived?: Map<string, SpaceScopeAndURI>;

  /**
   * The node's count of changes (`FanOutNodeState.changes`) as the
   * instance's latest run left it: at the handing over of its writes, and
   * again once the replica applied them.
   */
  settledAt?: number;
}

/** The latest change to one instance of a document a fanned-out node writes. */
interface SlotChange {
  /** The scope key of the instance. */
  scopeKey: string;

  /** The node's count of changes once it was counted. */
  at: number;

  /** The key of the instance whose run made it, absent where no run of the
   * node did. */
  by?: ScopeKey;
}

export interface FanOutNodeState {
  /** The top hop: some run discovered a scope narrower than `space`.
   * Structural (the shared redirect), so node-level. */
  narrowed: boolean;

  /** Principals whose discovered depth is SESSION (ragged; per principal;
   * only ever grows). A principal outside it runs once, as its user
   * instance, while `narrowed`. */
  readonly sessionPrincipals: Set<string>;

  /** Every instance key this node has run (or is running) at the current
   * ratchet, with its resolution identity and its LAST COMMITTED
   * reactivity log — the union of the logs is the node's subscription
   * (B7: skipped instances keep their reads registered). */
  readonly instances: Map<ScopeKey, InstanceRecord>;

  /** Instance keys whose last run is CURRENT (B7): a change dirties only
   * the instances whose reads covered it. Emptied by an untargeted
   * invalidation. */
  readonly clean: Set<ScopeKey>;

  /**
   * Instance keys that are owed a run: something that concerns the instance
   * asked for one since its latest run started (`dirtyFanOutKey()`,
   * `oweFanOutRuns()`). An instance that is not current and not owed a run
   * is one whose run was given up, its retries spent. It waits for a change
   * to a document its latest finished run or its given-up run read, both of
   * which the node stays subscribed to (`fanOutUnionLog()`), for an
   * invalidation that names no cause or names it, for a viewer asking for
   * it, or for a viewer arriving at a root the node is under. A change to a
   * document only another instance read does not start it.
   */
  readonly owed: Set<ScopeKey>;

  /** Per-key dirtiness generation: a run marks its key clean at finalize
   * only if no cause dirtied it since the run started (a change that
   * lands mid-run must not be absorbed by the run that predates it). */
  readonly dirtyGen: Map<ScopeKey, number>;

  /** How many changes to instances of the documents the node writes it
   * was told of. */
  changes: number;

  /**
   * The latest change to each instance of a document the node writes, by
   * the instance's key (`toDirtyKey()`). What an instance holds is what a
   * run left there for as long as no other run, and nothing else, has
   * changed it since (`fanOutHoldsSlot()`).
   */
  readonly slotChanges: Map<string, SlotChange>;

  /**
   * The run each transaction a run of the node opened writes for: its
   * instance, and once the run handed its writes over, the key it was
   * recorded under then. A change that arrives later is that key's,
   * whatever the ratchet gives the run's identity by then.
   */
  readonly runs: WeakMap<object, { instance: FanOutInstance; key?: ScopeKey }>;
}

export function newFanOutNodeState(): FanOutNodeState {
  return {
    narrowed: false,
    sessionPrincipals: new Set(),
    instances: new Map(),
    clean: new Set(),
    owed: new Set(),
    dirtyGen: new Map(),
    changes: 0,
    slotChanges: new Map(),
    runs: new WeakMap(),
  };
}

/** The key `FanOutNodeState.slotChanges` holds an instance under. */
const slotOf = (scopeKey: string, id: string): string =>
  toDirtyKey(id, scopeKey as ScopeKey);

const pairOrder = (a: ScopeKeyIdentity, b: ScopeKeyIdentity): number => {
  const p = String(a.principal).localeCompare(String(b.principal));
  if (p !== 0) return p;
  return String(a.sessionId ?? "").localeCompare(String(b.sessionId ?? ""));
};

/**
 * The instance-set function (design §B2), over the ratchet and the
 * demanders D:
 *
 * - not narrowed → ONE run, the PROBE: identity = min(D) (deterministic;
 *   resolution scaffolding only — no annotation may depend on it), key
 *   `space`;
 * - narrowed → one run per distinct principal p in D at its depth: key
 *   `user:p` with the representative session, or — if p is session-deep
 *   — one run per (p, s) pair in D, key `session:p:s`.
 *
 * Demanders without a principal (anonymous sessions) cannot own an
 * instance and are dropped; an empty D is the caller's fallback (the
 * wave-level identity), never this function's concern.
 */
export function fanOutInstances(
  state: Pick<FanOutNodeState, "narrowed" | "sessionPrincipals">,
  demanders: readonly ScopeKeyIdentity[],
): FanOutInstance[] {
  const owned = demanders
    .filter((d) => d.principal !== undefined)
    .sort(pairOrder);
  if (owned.length === 0) return [];
  if (!state.narrowed) {
    return [{ identity: owned[0], key: "space" }];
  }
  const instances: FanOutInstance[] = [];
  const seen = new Set<string>();
  for (const demander of owned) {
    const principal = demander.principal!;
    if (state.sessionPrincipals.has(principal)) {
      if (demander.sessionId === undefined) continue;
      const key = resolveScopeKey("session", demander);
      if (seen.has(key)) continue;
      seen.add(key);
      instances.push({ identity: demander, key });
    } else {
      const key = resolveScopeKey("user", demander);
      if (seen.has(key)) continue;
      seen.add(key);
      // Sorted, so the first pair of a principal carries its smallest
      // session — the representative.
      instances.push({ identity: demander, key });
    }
  }
  return instances;
}

/** The depth the ratchet holds for `identity`'s principal, as a scope. */
export function ratchetDepthFor(
  state: Pick<FanOutNodeState, "narrowed" | "sessionPrincipals">,
  identity: ScopeKeyIdentity,
): CellScope {
  if (!state.narrowed) return "space";
  return identity.principal !== undefined &&
      state.sessionPrincipals.has(identity.principal)
    ? "session"
    : "user";
}

/**
 * Learn a run's DISCOVERED scope (design §B3, the discovery re-arm's
 * ratchet half): only ever narrows — the top hop for everyone, the second
 * hop for this run's principal. Returns true when the ratchet moved (the
 * caller then re-derives the instance set: siblings appear and run in
 * the same pass).
 */
export function ratchetDiscovered(
  state: FanOutNodeState,
  identity: ScopeKeyIdentity,
  discovered: CellScope,
): boolean {
  let moved = false;
  if (scopeRank(discovered) > scopeRank("space") && !state.narrowed) {
    state.narrowed = true;
    moved = true;
  }
  if (
    discovered === "session" && identity.principal !== undefined &&
    !state.sessionPrincipals.has(identity.principal)
  ) {
    state.sessionPrincipals.add(identity.principal);
    moved = true;
  }
  return moved;
}

/** The key `identity` runs under at the CURRENT ratchet — the instance a
 * finished run's outcome is recorded against (a run stamped `user:p` that
 * discovered session is recorded as `session:p:s_rep`, the instance that
 * now exists; its stamped key has left the set). Undefined when the
 * identity cannot resolve the depth (a sessionless pair at session
 * depth). */
export function keyAtRatchet(
  state: Pick<FanOutNodeState, "narrowed" | "sessionPrincipals">,
  identity: ScopeKeyIdentity,
): ScopeKey | undefined {
  try {
    return resolveScopeKey(ratchetDepthFor(state, identity), identity);
  } catch {
    return undefined;
  }
}

/** Every instance key `identity` covers at ANY depth on its own chain —
 * the keys a cause resolving to one of them dirties. */
function keysOnChain(identity: ScopeKeyIdentity): Set<string> {
  const keys = new Set<string>(["space"]);
  try {
    keys.add(resolveScopeKey("user", identity));
    keys.add(resolveScopeKey("session", identity));
  } catch {
    // whatever resolved is the chain
  }
  return keys;
}

/**
 * Whether a cause names no instance: a change to a document of the scope
 * `space`, or to an address the ambient identity would resolve.
 */
const namesNoInstance = (
  cause: Pick<IMemorySpaceAddress, "scopeKey">,
): boolean => cause.scopeKey === undefined || cause.scopeKey === "space";

/**
 * Whether a run of the instance `record` describes is recorded to have read
 * the document `document` names, at any path: the run whose log it holds, or
 * a later one that ended without handing its writes over. An instance with
 * neither has no recorded reads.
 *
 * The decision is by document and not by path. A cause carries one read path
 * of the node's whose value changed, which may be another instance's, and
 * neither the path that changed nor the values, so which of this instance's
 * read paths the change reaches is not known here.
 */
function readsDocument(
  record: InstanceRecord,
  document: SpaceScopeAndURI,
): boolean {
  const { log, attempt } = record;
  if (log === undefined && attempt === undefined) return false;
  let documents = record.documents;
  if (
    documents === undefined || documents.log !== log ||
    documents.attempt !== attempt
  ) {
    const read = new Set<SpaceScopeAndURI>();
    for (const recorded of [log, attempt]) {
      if (recorded === undefined) continue;
      for (const address of recorded.reads) read.add(entityNameKey(address));
      for (const address of recorded.shallowReads) {
        read.add(entityNameKey(address));
      }
    }
    documents = record.documents = { log, attempt, read };
  }
  return documents.read.has(document);
}

/**
 * The document a cause that names no instance is for
 * (`entityNameKey()`), and `undefined` for a cause that names one.
 */
const documentOf = (
  cause: Pick<IMemorySpaceAddress, "space" | "id" | "scope" | "scopeKey">,
): SpaceScopeAndURI | undefined =>
  namesNoInstance(cause) ? entityNameKey(cause) : undefined;

/**
 * How `cause` concerns the instance at `key`, and `undefined` where it does
 * not. A cause that names an instance concerns the instances on that
 * instance's chain (`named`), never the probe. One that names none, for
 * `document`, concerns an instance recorded to have read the document
 * (`read`), and one whose run is under way and may have (`running`).
 */
function concernOf(
  key: ScopeKey,
  record: InstanceRecord,
  cause: Pick<IMemorySpaceAddress, "scopeKey">,
  document: SpaceScopeAndURI | undefined,
): "named" | "read" | "running" | undefined {
  if (document === undefined) {
    return key !== "space" && keysOnChain(record.identity).has(cause.scopeKey!)
      ? "named"
      : undefined;
  }
  if (readsDocument(record, document)) return "read";
  return record.running === true ? "running" : undefined;
}

/**
 * B7 — precise per-instance dirtiness. A cause address that NAMES its
 * instance (`scopeKey`, stage A's keyed notification addresses) dirties
 * exactly the instances whose identity resolves that address's scope to
 * that key — Bob's write to `user:bob/X` dirties Bob's user instance and
 * Bob's session instances (they read `user:bob` too), never Alice's.
 *
 * A cause that names no instance dirties the instances recorded to have read
 * its document, and is recorded on each of them for its next run to take as
 * a trigger read (`takeFanOutTriggers()`). The node's subscription is the
 * union of its instances' reads, so such a cause can be for a document only
 * one viewer's run read, and an instance that did not read it cannot depend
 * on it. The reads of a run under way are not recorded until it ends, so for
 * an instance that is running the cause is kept for `fanOutRunFinished()` or
 * `fanOutRunAborted()` to decide by that run's reads.
 *
 * Returns whether the cause concerns the node: whether it dirtied an
 * instance, or is kept for a run under way. A cause that does neither is for
 * a document no instance is recorded to have read, and leaves every instance
 * as it was. A node holding no instance yet has no record to decide by, and
 * every cause concerns it.
 */
export function dirtyFanOutForCause(
  state: FanOutNodeState,
  cause: Pick<
    IMemorySpaceAddress,
    "space" | "id" | "scope" | "scopeKey" | "path"
  >,
): boolean {
  let concerned = state.instances.size === 0;
  const document = documentOf(cause);
  const trigger = invalidCauseKey(cause);
  for (const [key, record] of state.instances) {
    const concern = concernOf(key, record, cause, document);
    if (concern === undefined) continue;
    concerned = true;
    if (concern === "running") {
      (record.arrived ??= new Map()).set(trigger, document!);
      continue;
    }
    if (concern === "read") (record.triggers ??= new Set()).add(trigger);
    dirtyFanOutKey(state, key);
  }
  return concerned;
}

/**
 * Hands over the causes naming no instance recorded for the instance at
 * `key` (`dirtyFanOutForCause()`), leaving none recorded. `undefined` where
 * there are none.
 */
export function takeFanOutTriggers(
  state: FanOutNodeState,
  key: ScopeKey,
): ReadonlySet<string> | undefined {
  const record = state.instances.get(key);
  const triggers = record?.triggers;
  if (record !== undefined) record.triggers = undefined;
  return triggers;
}

/**
 * Gives the instance at `key` back those of `causes` that name no instance,
 * which a run of it took and that run's retry takes again.
 */
export function restoreFanOutTriggers(
  state: FanOutNodeState,
  key: ScopeKey,
  causes: readonly IMemorySpaceAddress[],
): void {
  const record = state.instances.get(key);
  if (record === undefined) return;
  for (const cause of causes) {
    if (!namesNoInstance(cause)) continue;
    (record.triggers ??= new Set()).add(invalidCauseKey(cause));
  }
}

export function dirtyFanOutAll(state: FanOutNodeState): void {
  for (const key of [...state.clean, ...state.instances.keys()]) {
    dirtyFanOutKey(state, key);
  }
}

export function dirtyFanOutKey(state: FanOutNodeState, key: ScopeKey): void {
  state.clean.delete(key);
  // An instance the node holds no record of has left, or never ran and runs
  // as a first run whatever is recorded, so nothing is kept for its key.
  if (!state.instances.has(key)) return;
  state.owed.add(key);
  state.dirtyGen.set(key, (state.dirtyGen.get(key) ?? 0) + 1);
}

/**
 * Whether `cause` concerns the node, as `dirtyFanOutForCause()` would return
 * for it, without dirtying an instance or recording anything.
 */
export function fanOutCauseConcerns(
  state: FanOutNodeState,
  cause: Pick<IMemorySpaceAddress, "space" | "id" | "scope" | "scopeKey">,
): boolean {
  if (state.instances.size === 0) return true;
  const document = documentOf(cause);
  for (const [key, record] of state.instances) {
    if (concernOf(key, record, cause, document) !== undefined) return true;
  }
  return false;
}

/**
 * Whether a pass runs the instance at `key`: it is not current, and it
 * either never ran at this ratchet or is owed a run
 * (`FanOutNodeState.owed`).
 */
export function fanOutOwesRun(state: FanOutNodeState, key: ScopeKey): boolean {
  return !state.clean.has(key) &&
    (state.owed.has(key) || !state.instances.has(key));
}

/**
 * Records that each instance at `keys` that is not current is owed a run,
 * or every such instance where `keys` is absent: demand for it arrived. A
 * run under way that finishes current settles what this owed, and the
 * instance does not run again for it. One that is given up leaves the
 * instance owed, and it runs once more, with a fresh retry budget.
 */
export function oweFanOutRuns(
  state: FanOutNodeState,
  keys: Iterable<ScopeKey> = state.instances.keys(),
): void {
  for (const key of keys) {
    if (!state.clean.has(key)) state.owed.add(key);
  }
}

/** The instances of the current set that must run: never run at this
 * ratchet, or not current and owed a run (`FanOutNodeState.owed`). */
export function fanOutInstancesToRun(
  state: FanOutNodeState,
  instances: readonly FanOutInstance[],
): FanOutInstance[] {
  return instances.filter((instance) => fanOutOwesRun(state, instance.key));
}

/**
 * Retire instance state for keys that left the current set (a demander
 * departed, or the ratchet re-keyed the principal): their reads leave the
 * union subscription on the next resubscribe.
 */
export function pruneFanOutInstances(
  state: FanOutNodeState,
  current: readonly FanOutInstance[],
): void {
  const live = new Set(current.map((instance) => instance.key));
  let departed = false;
  for (const key of [...state.instances.keys()]) {
    if (!live.has(key)) {
      state.instances.delete(key);
      state.clean.delete(key);
      state.owed.delete(key);
      state.dirtyGen.delete(key);
      departed = true;
    }
  }
  if (!departed) return;
  // A change to an instance no remaining run can reach is asked about by
  // none of them. A viewer who returns runs again before it is asked.
  const reachable = new Set<string>([ANY_INSTANCE]);
  for (const instance of current) {
    for (const key of keysOnChain(instance.identity)) reachable.add(key);
  }
  for (const [slot, { scopeKey }] of [...state.slotChanges]) {
    if (!reachable.has(scopeKey)) state.slotChanges.delete(slot);
  }
}

/** Record that `instance` is starting a run: its dirtiness generation at
 * start, compared at finalize. The run is the one the instance was owed. */
export function fanOutRunStarted(
  state: FanOutNodeState,
  instance: FanOutInstance,
): number {
  let record = state.instances.get(instance.key);
  if (record === undefined) {
    record = { identity: instance.identity };
    state.instances.set(instance.key, record);
  }
  record.running = true;
  record.arrived = undefined;
  state.owed.delete(instance.key);
  return state.dirtyGen.get(instance.key) ?? 0;
}

/**
 * Records that the run of `instance` the pass started has returned. A run
 * that neither finished nor was recorded as aborted, as one whose
 * registration retired, leaves nothing kept for it.
 */
export function fanOutRunEnded(
  state: FanOutNodeState,
  instance: FanOutInstance,
): void {
  const record = state.instances.get(instance.key);
  if (record === undefined || record.running !== true) return;
  record.running = false;
  record.arrived = undefined;
}

/**
 * Weighs the causes naming no instance that arrived while the run of
 * `record` that just ended was under way, against what the record now says
 * the instance read. Returns whether one was for a document it read; each
 * such cause is recorded for the instance's next run to take.
 */
function weighArrived(
  record: InstanceRecord,
  arrived: ReadonlyMap<string, SpaceScopeAndURI> | undefined,
): boolean {
  let read = false;
  for (const [cause, document] of arrived ?? []) {
    if (!readsDocument(record, document)) continue;
    (record.triggers ??= new Set()).add(cause);
    read = true;
  }
  return read;
}

/**
 * Records that the run of `instance` under way ended without handing its
 * writes over, having read `attempt`: it threw `RetryImmediately`, or a read
 * of its was unavailable. The instance stays not current. It is owed a run
 * again only where the caller retries it (`dirtyFanOutKey()`), or where a
 * cause that arrived while it ran was for a document it read.
 */
export function fanOutRunAborted(
  state: FanOutNodeState,
  instance: FanOutInstance,
  attempt: ReactivityLog,
): void {
  const record = state.instances.get(instance.key);
  if (record === undefined) return;
  const arrived = record.arrived;
  record.running = false;
  record.arrived = undefined;
  record.attempt = attempt;
  if (weighArrived(record, arrived)) dirtyFanOutKey(state, instance.key);
}

/**
 * Records that `transaction` is the one a run of `instance` writes
 * through, so that a change the replica reports with it as the source is
 * known for that run's.
 */
export function fanOutRunOpened(
  state: FanOutNodeState,
  instance: FanOutInstance,
  transaction: object,
): void {
  state.runs.set(transaction, { instance });
}

/**
 * Records a change to the instance of the document `id` at `scopeKey`,
 * one of those the node writes. `source` is the transaction whose commit
 * changed it, absent for a change that is no commit of this runtime.
 */
export function fanOutSlotChanged(
  state: FanOutNodeState,
  scopeKey: string,
  id: string,
  source: object | undefined,
): void {
  const by = source === undefined ? undefined : state.runs.get(source)?.key;
  state.slotChanges.set(slotOf(scopeKey, id), {
    scopeKey,
    at: ++state.changes,
    ...(by !== undefined && { by }),
  });
}

/**
 * Records that the replica applied the writes of the run that wrote
 * through `source`: every instance its writes reach holds, from here,
 * what that run left there.
 */
export function fanOutRunApplied(
  state: FanOutNodeState,
  source: object,
): void {
  const key = state.runs.get(source)?.key;
  const record = key === undefined ? undefined : state.instances.get(key);
  if (record !== undefined) record.settledAt = state.changes;
}

/**
 * Whether the instance of the document `id` at `scopeKey` holds what the
 * latest run of the instance `key` left there: that run made the latest
 * change to it, or nothing has changed it since that run handed its writes
 * over. A run that hands over a write equal to what the instance held, or
 * no write of it at all, changes nothing, and the instance is then as much
 * that run's as the one's that changed it last. A run whose reads the
 * replica no longer bore out when it took the writes is refused and runs
 * again, so a run that stands read the instance as it holds it.
 */
export function fanOutHoldsSlot(
  state: Pick<FanOutNodeState, "instances" | "slotChanges">,
  key: ScopeKey,
  scopeKey: string,
  id: string,
): boolean {
  const settledAt = state.instances.get(key)?.settledAt;
  for (const slot of [slotOf(scopeKey, id), slotOf(ANY_INSTANCE, id)]) {
    const change = state.slotChanges.get(slot);
    if (change === undefined || change.by === key) continue;
    if (settledAt === undefined || change.at > settledAt) return false;
  }
  return true;
}

/**
 * Record a finished run's outcome: the ratchet learns the discovered
 * scope; the run's key at the (possibly moved) ratchet is marked clean —
 * unless a cause dirtied the STAMPED key while it ran — and holds the
 * committed log. A cause naming no instance that arrived while the run was
 * under way, for a document the run turns out to have read, leaves the key
 * dirty as well and is recorded for the instance's next run to take.
 * Returns whether the ratchet moved.
 *
 * Reached only from a run whose commit was KICKED (a thrown non-retry
 * error still commits its transaction through the ordinary path — OFF's
 * shape); a run that ends in `RetryImmediately` never reaches it, so its
 * key stays non-clean and the loop defers it (run.ts, review F1).
 */
export function fanOutRunFinished(
  state: FanOutNodeState,
  instance: FanOutInstance,
  outcome: {
    discovered: CellScope;
    startGen: number;
    log: ReactivityLog;

    /** The transaction the run wrote through (`fanOutRunOpened()`). */
    transaction?: object;
  },
): boolean {
  const moved = ratchetDiscovered(state, instance.identity, outcome.discovered);
  const key = keyAtRatchet(state, instance.identity) ?? instance.key;
  // What arrived for the stamped instance while it ran is its next run's,
  // under whichever key that run has.
  const stamped = state.instances.get(instance.key);
  const arrived = stamped?.arrived;
  if (stamped !== undefined) {
    stamped.running = false;
    stamped.arrived = undefined;
  }
  let dirtiedMeanwhile =
    (state.dirtyGen.get(instance.key) ?? 0) !== outcome.startGen;
  const record = state.instances.get(key) ?? { identity: instance.identity };
  if (key !== instance.key) {
    // Re-keyed by the ratchet: the stamped instance has left the set.
    state.instances.delete(instance.key);
    state.clean.delete(instance.key);
    state.owed.delete(instance.key);
    state.dirtyGen.delete(instance.key);
    if (stamped?.triggers !== undefined) {
      record.triggers = new Set([
        ...(record.triggers ?? []),
        ...stamped.triggers,
      ]);
    }
  }
  record.identity = instance.identity;
  record.log = outcome.log;
  record.attempt = undefined;
  if (weighArrived(record, arrived)) dirtiedMeanwhile = true;
  record.settledAt = state.changes;
  const run = outcome.transaction === undefined
    ? undefined
    : state.runs.get(outcome.transaction);
  if (run !== undefined) run.key = key;
  state.instances.set(key, record);
  if (!dirtiedMeanwhile) {
    state.clean.add(key);
    state.owed.delete(key);
  } else {
    state.clean.delete(key);
    state.owed.add(key);
  }
  return moved;
}

/** The union of every current instance's last log — the node's ONE
 * subscription (stage A's union resubscribe, persisted per instance so a
 * pass that skips clean instances keeps their reads registered). The reads
 * of a run that handed nothing over are in it too (`InstanceRecord.attempt`):
 * a change to one of them is what runs a given-up instance again, and it
 * has to arrive for that. */
export function fanOutUnionLog(state: FanOutNodeState): ReactivityLog {
  const reads: IMemorySpaceAddress[] = [];
  const shallowReads: IMemorySpaceAddress[] = [];
  const writes: IMemorySpaceAddress[] = [];
  for (const record of state.instances.values()) {
    if (record.log === undefined) continue;
    for (const read of record.log.reads) reads.push(read);
    for (const read of record.log.shallowReads) shallowReads.push(read);
    for (const write of record.log.writes) writes.push(write);
  }
  for (const { attempt } of state.instances.values()) {
    if (attempt === undefined) continue;
    for (const read of attempt.reads) reads.push(read);
    for (const read of attempt.shallowReads) shallowReads.push(read);
  }
  return { reads, shallowReads, writes };
}
