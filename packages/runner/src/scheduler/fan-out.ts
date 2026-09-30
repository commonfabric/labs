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
} from "@commonfabric/memory/v2";
import { scopeRank } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { ReactivityLog } from "./types.ts";

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
  /** The latest sealed publication; write-free reruns retain its obligation. */
  pendingWaveRun?: object;

  identity: ScopeKeyIdentity;
  log?: ReactivityLog;
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
   * the instances whose reads covered it; everything not in here runs on
   * the next pass. Emptied by an untargeted invalidation. */
  readonly clean: Set<ScopeKey>;

  /** Per-key dirtiness generation: a run marks its key clean at finalize
   * only if no cause dirtied it since the run started (a change that
   * lands mid-run must not be absorbed by the run that predates it). */
  readonly dirtyGen: Map<ScopeKey, number>;
}

export function newFanOutNodeState(): FanOutNodeState {
  return {
    narrowed: false,
    sessionPrincipals: new Set(),
    instances: new Map(),
    clean: new Set(),
    dirtyGen: new Map(),
  };
}

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
 * B7 — precise per-instance dirtiness. A cause address that NAMES its
 * instance (`scopeKey`, stage A's keyed notification addresses) dirties
 * exactly the instances whose identity resolves that address's scope to
 * that key — Bob's write to `user:bob/X` dirties Bob's user instance and
 * Bob's session instances (they read `user:bob` too), never Alice's. A
 * cause with no key — a space doc, or an address the ambient identity
 * would resolve — dirties every instance. Returns the keys dirtied.
 */
export function dirtyFanOutForCause(
  state: FanOutNodeState,
  cause: Pick<IMemorySpaceAddress, "scope" | "scopeKey">,
): void {
  const causeKey = cause.scopeKey;
  if (causeKey === undefined || causeKey === "space") {
    dirtyFanOutAll(state);
    return;
  }
  for (const [key, record] of state.instances) {
    if (key === "space") continue;
    if (keysOnChain(record.identity).has(causeKey)) {
      dirtyFanOutKey(state, key);
    }
  }
}

export function dirtyFanOutAll(state: FanOutNodeState): void {
  for (const key of [...state.clean, ...state.instances.keys()]) {
    dirtyFanOutKey(state, key);
  }
}

export function dirtyFanOutKey(state: FanOutNodeState, key: ScopeKey): void {
  state.clean.delete(key);
  state.dirtyGen.set(key, (state.dirtyGen.get(key) ?? 0) + 1);
}

/** The instances of the current set that must run: never run at this
 * ratchet, or dirtied since. */
export function fanOutInstancesToRun(
  state: FanOutNodeState,
  instances: readonly FanOutInstance[],
): FanOutInstance[] {
  return instances.filter((instance) => !state.clean.has(instance.key));
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
  for (const key of [...state.instances.keys()]) {
    if (!live.has(key)) {
      state.instances.delete(key);
      state.clean.delete(key);
      state.dirtyGen.delete(key);
    }
  }
}

/** Record that `instance` is starting a run: its dirtiness generation at
 * start, compared at finalize. */
export function fanOutRunStarted(
  state: FanOutNodeState,
  instance: FanOutInstance,
): number {
  if (!state.instances.has(instance.key)) {
    state.instances.set(instance.key, { identity: instance.identity });
  }
  return state.dirtyGen.get(instance.key) ?? 0;
}

/**
 * Record a finished run's outcome: the ratchet learns the discovered
 * scope; the run's key at the (possibly moved) ratchet is marked clean —
 * unless a cause dirtied the STAMPED key while it ran — and holds the
 * committed log. Returns whether the ratchet moved.
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
    log: ReactivityLog | undefined;
  },
): boolean {
  const moved = ratchetDiscovered(state, instance.identity, outcome.discovered);
  const key = keyAtRatchet(state, instance.identity) ?? instance.key;
  const dirtiedMeanwhile =
    (state.dirtyGen.get(instance.key) ?? 0) !== outcome.startGen;
  if (key !== instance.key) {
    // Re-keyed by the ratchet: the stamped instance has left the set.
    state.instances.delete(instance.key);
    state.clean.delete(instance.key);
    state.dirtyGen.delete(instance.key);
  }
  const record = state.instances.get(key) ?? { identity: instance.identity };
  record.identity = instance.identity;
  if (outcome.log !== undefined) record.log = outcome.log;
  state.instances.set(key, record);
  if (!dirtiedMeanwhile) {
    state.clean.add(key);
  } else {
    state.clean.delete(key);
  }
  return moved;
}

/** The union of every current instance's last log — the node's ONE
 * subscription (stage A's union resubscribe, persisted per instance so a
 * pass that skips clean instances keeps their reads registered). */
export function fanOutUnionLog(state: FanOutNodeState): ReactivityLog {
  const reads: IMemorySpaceAddress[] = [];
  const shallowReads: IMemorySpaceAddress[] = [];
  const writes: IMemorySpaceAddress[] = [];
  for (const record of state.instances.values()) {
    if (record.log === undefined) continue;
    reads.push(...record.log.reads);
    shallowReads.push(...record.log.shallowReads);
    writes.push(...record.log.writes);
  }
  return { reads, shallowReads, writes };
}
