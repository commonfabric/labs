/**
 * Executable mini-model of the server-execution v2 identity/commit
 * machinery (docs/specs/server-side-execution/). NON-NORMATIVE: the
 * spec governs; this model exists so schedule-dependent properties
 * (crash windows, cascade interleavings, push filtering) are checked
 * mechanically instead of by hand-enumerated journeys. Scope and
 * simplifications: ../README.md.
 *
 * Modeled, per the rulings through 2026-08-03: commit classes and
 * envelopes (protocol §1), firedAt stamping + actor inheritance
 * (protocol §2, events §2, LT6), same-space cascade carriage (LT1),
 * delegated carriage + stamping (protocol §2b), the wave with
 * splits (serving-loop §3), eventWatermark idempotency (events §4),
 * the crash-lossy process-local outbox (serving-loop §5 — FP1's
 * home), navigateTo's session-connection requirement (LT3), the
 * effect channel enact/ack window (LT8), and scope_key push
 * filtering (protocol §3).
 */

//
// identities and keys
//

export type UserId = string;
export type SessionId = string;
export type SpaceId = string;
export type DocId = string;
export type EventId = string;

/** Acting identity: session absent = sessionless ("server"). */
export interface Acting {
  user?: UserId;
  session?: SessionId;
}

/**
 * Encodes one component of the scope keys constructed below — RESTATED from
 * the real wire vocabulary (`packages/memory/v2.ts`: `resolveScopeKey` /
 * `resolvePrincipalSessionKey`), never imported (model.ts stays import-free).
 * The real constructor encodeURIComponent-encodes each component, so the
 * literal `:` separators split segments exactly and construction is INJECTIVE
 * for `:`-bearing principals (DIDs) and arbitrary session ids — un-encoded
 * interpolation would collide `("a:b","c")` with `("a","b:c")`. The
 * conformance bridge test in properties.test.ts asserts byte-agreement with
 * the real vocabulary.
 */
const encodeKeyPart = (value: string): string => encodeURIComponent(value);

/** The space scope's key, which takes no component. */
export const SPACE_KEY = "space";

/** The per-user scope's key constructor. */
export const userKey = (u: UserId): string => `user:${encodeKeyPart(u)}`;

/** The per-session scope's key constructor. */
export const sessionKey = (u: UserId, s: SessionId): string =>
  `session:${encodeKeyPart(u)}:${encodeKeyPart(s)}`;

/**
 * Validator mirror — RESTATED from the real `isScopeKey`
 * (`packages/memory/v2.ts`), never imported. Accepts exactly the
 * constructors' image: `space`, `user:<seg>`, `session:<seg>:<seg>`,
 * every segment non-empty and CANONICAL — byte-identical to what
 * `encodeKeyPart` emits for the segment's own decoding. So raw `/` or
 * `:` inside a segment, malformed percent escapes, and decodable but
 * non-canonical escapes (`%2f` where the encoder emits `%2F`, `%41`
 * for plain `A`) all refuse; malformed input returns false, never
 * throws. The conformance bridge test in properties.test.ts asserts
 * pointwise agreement with the real validator on the acceptance AND
 * rejection sets.
 */
export const isCanonicalKey = (value: string): boolean => {
  const canonicalSegment = (segment: string): boolean => {
    if (segment.length === 0) return false;
    try {
      return encodeKeyPart(decodeURIComponent(segment)) === segment;
    } catch {
      return false;
    }
  };
  if (value === SPACE_KEY) return true;
  if (value.startsWith("user:")) {
    return canonicalSegment(value.slice("user:".length));
  }
  if (value.startsWith("session:")) {
    const segments = value.split(":");
    return segments.length === 3 && canonicalSegment(segments[1]) &&
      canonicalSegment(segments[2]);
  }
  return false;
};

/** The scope kinds a handler write can declare (scopes.md §2). */
export type ScopeKind = "space" | "user" | "session";

//
// the program under test
//

/** Handler behavior attached to a stream — the model's "pattern". */
export interface HandlerSpec {
  writes: ScopeKind[];
  cascadeTo?: { space: SpaceId; stream: DocId };
  navigate?: boolean;

  /** events §5's drop predicate: the handler CANNOT RUN when this
   * doc is absent (deleted meanwhile) — the unrunnable case. */
  requiresDoc?: DocId;
}

/** A pure space-scope derivation: `out` mirrors `from`'s value.
 * Its writes are RE-DERIVABLE (serving-loop §3d's drop class). */
export interface DerivationSpec {
  from: DocId;
  out: DocId;
}

//
// world state
//

export interface StreamEntry {
  seq: number;
  eventId: EventId;
  firedAt: { user?: UserId; session: SessionId | "server" };
  consequenced: boolean;

  /** error-is-the-consequence surface (events §5). */
  error?: string;
}

export interface StreamState {
  handler: HandlerSpec;
  entries: StreamEntry[];
  eventWatermark: number;
}

export interface WriteRow {
  doc: DocId;
  scopeKey: string;
  value: number;

  /** acting identity per action run; absent for runs with none. */
  attribution?: Acting;
}

export interface CommitRecord {
  seq: number;
  class: "authored" | "derived";

  /** "session:<u>:<s>" for client commits; "service:<space>" else. */
  envelope: string;

  holder?: string;
  derivedThrough?: number;
  consequenceOf?: EventId[];
  writes: WriteRow[];
  waveId?: number;

  /** LT1: same-space cascade entries carried as WRITE-LEVEL rows of
   * THIS commit (eventId + inherited firedAt) — so the oracle can
   * reject an implementation persisting the append separately. */
  entryWrites?: Array<{
    stream: DocId;
    eventId: EventId;
    firedAt: StreamEntry["firedAt"];
  }>;

  /** the watermark DOC write — rides ONLY the last split, and only
   * when W advanced (serving-loop §3). */
  watermarkDoc?: boolean;
}

export interface Intent {
  nonce: number;
  issuedIn: number;
  target: string;
  acked: boolean;
}

export interface SpaceState {
  seq: number;
  streams: Record<DocId, StreamState>;

  /** `${doc}/${scopeKey}` -> value. */
  docs: Record<string, number>;

  /** sessionKey -> intents (the effects doc's per-session instance). */
  effects: Record<string, Intent[]>;

  W: number;
  commits: CommitRecord[];
  leaseHolder: string | null;

  /** lease tenure counter: bumps at every (re)acquire (model-only
   * audit — lets properties detect a stale-tenure admission). */
  tenure: number;

  /** per-doc-instance head seq — what the wave commit CASes
   * against (serving-loop §3d). */
  docHeads: Record<string, number>;

  derivations: DerivationSpec[];

  /** FP1 (RULED): pending cross-space appends as DURABLE rows,
   * written inside the wave's own transaction and deleted on
   * delivery-ack — they survive a crash. */
  outboundAppends: OutboxEntry[];
}

export interface OutboxEntry {
  targetSpace: SpaceId;
  targetStream: DocId;
  eventId: EventId;
  actingPrincipal?: UserId;
  actingSession?: SessionId;
  capabilityRef: string;
}

export interface ServerState {
  alive: boolean;

  /** the EFFECT half of the outbox stays process-local (serving-loop
   * §5 as ruled — crash recovery re-misses from memo keys); appends
   * no longer live here (FP1 ruled: durable rows on SpaceState). */
  outbox: OutboxEntry[];

  /** audit trail of append entries destroyed by crashes — with FP1
   * ruled (durable rows) this MUST stay empty on every schedule. */
  lostAppends: OutboxEntry[];

  /** bumped per genuinely-new process (DR1: holder's process part). */
  processGen: number;

  /** derived commits sealed + sent but not yet admitted — in flight
   * at the store's door, the lease-fencing race's carrier. */
  pendingProbes: Array<{ holder: string; tenure: number }>;

  /** a computed-but-uncommitted wave (in-memory: a crash loses it,
   * an authored commit can land under it — serving-loop §3d). */
  pendingWave: PendingWave | null;
}

/** One processed event's staged contribution to the wave. */
export interface EventContribution {
  eventId: EventId;
  stream: DocId;

  /** null for cascade entries minted this wave (seq at commit). */
  entrySeq: number | null;

  parent?: EventId;
  writes: WriteRow[];
  cascadesSame: Array<{
    stream: DocId;
    eventId: EventId;
    firedAt: StreamEntry["firedAt"];
  }>;
  cascadesCross: OutboxEntry[];
  intents: Array<{ key: string; target: string }>;

  /** events §5 DROP — the handler could not run at all. */
  dropped?: string;

  /** handler-run error (error-is-the-consequence). */
  errored?: string;

  /** events §4: an admitted at-or-below-horizon duplicate — skipped
   * at processing, counted, never run. */
  skipped?: boolean;
}

export interface PendingWave {
  waveId: number;

  /** store seq at compute start — the wave's read basis. */
  basisSeq: number;

  contributions: EventContribution[];

  /** re-derivable derivation outputs (drop class, §3d). */
  pureWrites: WriteRow[];

  exhausted: boolean;
}

export interface ClientSession {
  user: UserId;
  session: SessionId;
  connected: SpaceId[];

  /** overlay record of enacted nonces — reload-WIPED (LT8). */
  enactedNonces: number[];

  /** model-only audit: nonce -> times actually enacted. */
  enactCount: Record<number, number>;
}

export interface World {
  spaces: Record<SpaceId, SpaceState>;
  servers: Record<SpaceId, ServerState>;
  clients: Record<SessionId, ClientSession>;

  /** chain root per event (audit-only; inheritance ground truth). */
  rootOf: Record<EventId, Acting>;

  nextEvent: number;
  nextNonce: number;

  /** spec-breach detections (must stay empty on legal schedules). */
  violations: string[];

  trace: string[];

  /** config: split every wave commit in two (serving-loop §3). */
  splitWaves: boolean;

  /** DR1's in-process discipline: abort in-flight commits BEFORE
   * reacquiring (serving-loop §2's stop-committing MUST). */
  leaseDiscipline: boolean;

  /** admitted derived probes sealed under an ENDED tenure — must
   * stay 0 whenever the discipline is on. */
  staleAdmissions: number;

  /** all admitted probes (audit — also keeps a successful delivery
   * from state-colliding with the pre-seal world in the explorer). */
  admittedProbes: number;

  /** max events processed per wave (null = unbounded) —
   * serving-loop §3's budget-exhaustion rule. */
  waveBudget: number | null;

  /** superseded pure derived writes dropped at commit (§3d). */
  supersededWrites: number;

  /** events rolled back to unconsequenced at commit (§3d REQUEUE). */
  requeues: number;

  /** duplicate events skipped at processing time (events §4). */
  skippedIdempotent: number;
}

//
// construction
//

export interface SpaceSpec {
  streams: Record<DocId, HandlerSpec>;
  derivations?: DerivationSpec[];
}

/** DR1: holder = service identity + process-instance component. */
export const holderId = (space: SpaceId, processGen: number): string =>
  `service:${space}#p${processGen}`;

export function makeWorld(opts: {
  spaces: Record<SpaceId, SpaceSpec>;
  clients: Array<{ user: UserId; session: SessionId; connected: SpaceId[] }>;
  splitWaves?: boolean;
  leaseDiscipline?: boolean;
  waveBudget?: number;
}): World {
  const spaces: Record<SpaceId, SpaceState> = {};
  const servers: Record<SpaceId, ServerState> = {};
  for (const [id, spec] of Object.entries(opts.spaces)) {
    const streams: Record<DocId, StreamState> = {};
    for (const [doc, handler] of Object.entries(spec.streams)) {
      streams[doc] = { handler, entries: [], eventWatermark: 0 };
    }
    spaces[id] = {
      seq: 0,
      streams,
      docs: {},
      effects: {},
      W: 0,
      commits: [],
      leaseHolder: holderId(id, 0),
      tenure: 1,
      docHeads: {},
      derivations: spec.derivations ?? [],
      outboundAppends: [],
    };
    servers[id] = {
      alive: true,
      outbox: [],
      lostAppends: [],
      processGen: 0,
      pendingProbes: [],
      pendingWave: null,
    };
  }
  const clients: Record<SessionId, ClientSession> = {};
  for (const c of opts.clients) {
    clients[c.session] = {
      user: c.user,
      session: c.session,
      connected: [...c.connected],
      enactedNonces: [],
      enactCount: {},
    };
  }
  return {
    spaces,
    servers,
    clients,
    rootOf: {},
    nextEvent: 1,
    nextNonce: 1,
    violations: [],
    trace: [],
    splitWaves: opts.splitWaves ?? false,
    leaseDiscipline: opts.leaseDiscipline ?? true,
    staleAdmissions: 0,
    admittedProbes: 0,
    waveBudget: opts.waveBudget ?? null,
    supersededWrites: 0,
    requeues: 0,
    skippedIdempotent: 0,
  };
}

const clone = <T>(x: T): T => structuredClone(x);

//
// admission
//

/** protocol §2 row 2: stamp firedAt from the authenticated envelope. */
function admitClientAppend(
  w: World,
  space: SpaceId,
  stream: DocId,
  client: ClientSession,
): void {
  const sp = w.spaces[space];
  const st = sp.streams[stream];
  sp.seq += 1;
  const eventId = `e${w.nextEvent++}`;
  st.entries.push({
    seq: sp.seq,
    eventId,
    firedAt: { user: client.user, session: client.session },
    consequenced: false,
  });
  w.rootOf[eventId] = { user: client.user, session: client.session };
  sp.commits.push({
    seq: sp.seq,
    class: "authored",
    envelope: sessionKey(client.user, client.session),
    writes: [],
  });
}

/**
 * protocol §2 row 3 + §2b: delegated append — validate the grant,
 * stamp firedAt from the CARRIED acting identity, dedupe by eventId
 * above the target's eventWatermark.
 */
function admitDelegatedAppend(w: World, entry: OutboxEntry): void {
  const sp = w.spaces[entry.targetSpace];
  const st = sp.streams[entry.targetStream];
  // events §4: admission uniqueness applies ONLY above the dedupe
  // horizon. An at-or-below duplicate ADMITS as a new entry and is
  // skipped at PROCESSING time (skippedIdempotent) — admission must
  // not bless a stronger, permanent dedupe than the contract.
  const dup = st.entries.some(
    (e) => e.eventId === entry.eventId && e.seq > st.eventWatermark,
  );
  if (dup) return; // the uniqueness CAS above the horizon
  sp.seq += 1;
  st.entries.push({
    seq: sp.seq,
    eventId: entry.eventId,
    firedAt: {
      // A userless (OW15 sessionless-space-scope) delivery stamps NO
      // user key at all — key ABSENCE, not `user: undefined` (round-2
      // thread T32: the pinned carve-out is "no user key", and a
      // present-but-undefined key let the pin pass vacuously).
      ...(entry.actingPrincipal === undefined
        ? {}
        : { user: entry.actingPrincipal }),
      session: entry.actingSession ?? "server",
    },
    consequenced: false,
  });
  sp.commits.push({
    seq: sp.seq,
    class: "authored",
    envelope: `service:src-of-${entry.eventId}`,
    writes: [],
  });
}

/** protocol §2 derived row: the one equality check. Exported for
 * negative tests. Returns true iff admitted. */
export function admitDerived(
  sp: SpaceState,
  commit: { holder?: string; envelope: string },
): boolean {
  return commit.holder !== undefined && commit.holder === sp.leaseHolder &&
    commit.envelope.startsWith("service:");
}

//
// the wave (serving-loop §3, §3d; events §2, §4)
//

/** Stage one event's handler run into a contribution — no world
 * mutation beyond id minting; everything applies at COMMIT. */
function stageEvent(
  w: World,
  space: SpaceId,
  doc: DocId,
  eventId: EventId,
  firedAt: StreamEntry["firedAt"],
  entrySeq: number | null,
  parent: EventId | undefined,
): EventContribution {
  const sp = w.spaces[space];
  const h = sp.streams[doc].handler;
  const c: EventContribution = {
    eventId,
    stream: doc,
    entrySeq,
    parent,
    writes: [],
    cascadesSame: [],
    cascadesCross: [],
    intents: [],
  };
  // events §5 DROP: the handler CANNOT RUN (precondition gone)
  if (
    h.requiresDoc !== undefined &&
    sp.docs[`${h.requiresDoc}/${SPACE_KEY}`] === undefined
  ) {
    c.dropped = "dropped: required doc deleted (events §5)";
    return c;
  }
  const acting: Acting = {
    user: firedAt.user,
    session: firedAt.session === "server" ? undefined : firedAt.session,
  };
  const val = entrySeq ?? sp.seq + 1;
  // consequences land in the acting principal's instances (scopes §5)
  for (const kind of h.writes) {
    if (kind === "space") {
      c.writes.push({
        doc: `${doc}-out`,
        scopeKey: SPACE_KEY,
        value: val,
        attribution: acting.user !== undefined ? clone(acting) : undefined,
      });
    } else if (kind === "user") {
      if (acting.user === undefined) {
        c.errored = "user-scoped write with no acting user (events §2)";
        continue;
      }
      c.writes.push({
        doc: `${doc}-out`,
        scopeKey: userKey(acting.user),
        value: val,
        attribution: clone(acting),
      });
    } else {
      if (acting.user === undefined || acting.session === undefined) {
        c.errored = "session-scoped write by sessionless actor (scopes §5)";
        continue;
      }
      c.writes.push({
        doc: `${doc}-out`,
        scopeKey: sessionKey(acting.user, acting.session),
        value: val,
        attribution: clone(acting),
      });
    }
  }
  // cascade: inheritance, uniform (events §2, LT6)
  if (h.cascadeTo) {
    const childId = `e${w.nextEvent++}`;
    w.rootOf[childId] = w.rootOf[eventId] ?? clone(acting);
    if (h.cascadeTo.space === space) {
      // LT1: same-space — a write-level entry in this very wave
      c.cascadesSame.push({
        stream: h.cascadeTo.stream,
        eventId: childId,
        firedAt: clone(firedAt),
      });
    } else {
      // cross-space: outbox, post-commit, at-least-once (§2b)
      c.cascadesCross.push({
        targetSpace: h.cascadeTo.space,
        targetStream: h.cascadeTo.stream,
        eventId: childId,
        actingPrincipal: acting.user,
        actingSession: acting.session,
        capabilityRef: `cap:${doc}`,
      });
    }
  }
  // navigateTo: acting session must be CONNECTED to this space (LT3)
  if (h.navigate) {
    if (acting.user === undefined || acting.session === undefined) {
      c.errored = "navigateTo under sessionless actor (builtins §4)";
    } else {
      const client = w.clients[acting.session];
      if (client === undefined || !client.connected.includes(space)) {
        c.errored =
          "cross-space navigateTo: acting session not connected (LT3)";
      } else {
        c.intents.push({
          key: sessionKey(acting.user, acting.session),
          target: `${space}/${doc}`,
        });
      }
    }
  }
  return c;
}

/** Phase 1: drain the input batch to (budgeted) quiescence against
 * the snapshot — nothing durable moves (serving-loop §3, §3d). */
function computeWave(w: World, space: SpaceId): void {
  const sp = w.spaces[space];
  const srv = w.servers[space];
  if (!srv.alive || sp.leaseHolder === null) return;
  if (srv.pendingWave !== null) return; // serial waves per space
  const pw: PendingWave = {
    waveId: sp.seq + 1000,
    basisSeq: sp.seq,
    contributions: [],
    pureWrites: [],
    exhausted: false,
  };
  // queue: committed unconsequenced entries in seq order
  const queue: Array<{
    doc: DocId;
    eventId: EventId;
    firedAt: StreamEntry["firedAt"];
    entrySeq: number | null;
    parent?: EventId;
  }> = [];
  for (const [doc, st] of Object.entries(sp.streams)) {
    for (const entry of st.entries) {
      if (entry.consequenced || entry.seq <= st.eventWatermark) continue;
      queue.push({
        doc,
        eventId: entry.eventId,
        firedAt: entry.firedAt,
        entrySeq: entry.seq,
      });
    }
  }
  queue.sort((a, b) => (a.entrySeq ?? 1e9) - (b.entrySeq ?? 1e9));
  let processed = 0;
  while (queue.length > 0) {
    if (w.waveBudget !== null && processed >= w.waveBudget) {
      pw.exhausted = true; // budget exhaustion: commit anyway (§3)
      break;
    }
    const item = queue.shift()!;
    // events §4: a duplicate of an already-consequenced event (an
    // at-or-below-horizon redelivery that admission let through)
    // SKIPS at processing — never runs, counted skippedIdempotent
    const duplicateOfConsequenced = sp.streams[item.doc].entries.some(
      (e) =>
        e.eventId === item.eventId && e.consequenced &&
        (item.entrySeq === null || e.seq !== item.entrySeq),
    );
    if (duplicateOfConsequenced) {
      pw.contributions.push({
        eventId: item.eventId,
        stream: item.doc,
        entrySeq: item.entrySeq,
        parent: item.parent,
        writes: [],
        cascadesSame: [],
        cascadesCross: [],
        intents: [],
        skipped: true,
      });
      processed += 1;
      continue;
    }
    const c = stageEvent(
      w,
      space,
      item.doc,
      item.eventId,
      item.firedAt,
      item.entrySeq,
      item.parent,
    );
    pw.contributions.push(c);
    processed += 1;
    // same-space cascades process in the SAME wave (LT1), budget
    // permitting — else their committed entries wait for the next
    for (const casc of c.cascadesSame) {
      queue.push({
        doc: casc.stream,
        eventId: casc.eventId,
        firedAt: casc.firedAt,
        entrySeq: null,
        parent: c.eventId,
      });
    }
  }
  if (queue.length > 0) pw.exhausted = true;
  // pure derivations recompute when their input moved (re-derivable)
  for (const d of sp.derivations) {
    const cur = sp.docs[`${d.from}/${SPACE_KEY}`];
    if (cur !== undefined && sp.docs[`${d.out}/${SPACE_KEY}`] !== cur) {
      pw.pureWrites.push({ doc: d.out, scopeKey: SPACE_KEY, value: cur });
    }
  }
  if (pw.contributions.length === 0 && pw.pureWrites.length === 0) return;
  srv.pendingWave = pw;
}

/** Phase 2: the wave commit — per-doc CAS against the basis, with
 * PER-WRITE-CLASS conflict handling (serving-loop §3d). */
function commitWave(w: World, space: SpaceId): void {
  const sp = w.spaces[space];
  const srv = w.servers[space];
  const pw = srv.pendingWave;
  if (pw === null || !srv.alive) return;
  srv.pendingWave = null;
  // lease lost mid-wave: the in-flight transaction ABORTS (§2)
  if (sp.leaseHolder !== holderId(space, srv.processGen)) return;
  const conflicted = (rows: WriteRow[]) =>
    rows.some(
      (r) => (sp.docHeads[`${r.doc}/${r.scopeKey}`] ?? 0) > pw.basisSeq,
    );
  // REQUEUE set (raced, not unrunnable): a contribution whose
  // non-re-derivable writes lost the per-doc CAS rolls back whole,
  // plus its same-wave cascade descendants (only the committing
  // attempt's cascades escape the wave — events §4)
  const byId = new Map(pw.contributions.map((c) => [c.eventId, c]));
  const requeued = new Set<EventId>();
  for (const c of pw.contributions) {
    if (c.dropped === undefined && conflicted(c.writes)) {
      requeued.add(c.eventId);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of pw.contributions) {
      if (requeued.has(c.eventId)) continue;
      if (c.parent !== undefined && requeued.has(c.parent)) {
        requeued.add(c.eventId);
        grew = true;
      }
    }
  }
  const committed = pw.contributions.filter((c) => !requeued.has(c.eventId));
  // a requeued cascade whose PARENT also rolled back never got a
  // durable entry: it vanishes entirely (fresh ids next attempt)
  const survivingRequeues = [...requeued].filter((id) => {
    const c = byId.get(id)!;
    return c.parent === undefined || !requeued.has(c.parent);
  });
  w.requeues += survivingRequeues.length;
  const writes: WriteRow[] = [];
  const consequenceOf: EventId[] = [];
  // pure derived writes: superseded ⇒ DROPPED, sound because
  // re-derivable — the racing commit is the next wave's input (§3d)
  for (const row of pw.pureWrites) {
    if ((sp.docHeads[`${row.doc}/${row.scopeKey}`] ?? 0) > pw.basisSeq) {
      w.supersededWrites += 1;
    } else {
      writes.push(row);
    }
  }
  for (const c of committed) {
    if (c.skipped === true) {
      w.skippedIdempotent += 1; // no consequences, no consequenceOf
      continue;
    }
    for (const write of c.writes) writes.push(write);
    consequenceOf.push(c.eventId);
  }
  if (committed.length === 0 && writes.length === 0) return;
  // seq allocation: ONE per split (each split is a separate accepted
  // commit); same-space cascade entries ride the FIRST split at ITS
  // seq as write-level rows (LT1); the watermark DOC write rides
  // only the LAST split (serving-loop §3)
  const splitting = w.splitWaves && writes.length > 1;
  const mid = splitting ? Math.ceil(writes.length / 2) : writes.length;
  const firstSeq = sp.seq + 1;
  const lastSeq = splitting ? firstSeq + 1 : firstSeq;
  sp.seq = lastSeq;
  const entryWrites: NonNullable<CommitRecord["entryWrites"]> = [];
  for (const c of committed) {
    for (const casc of c.cascadesSame) {
      sp.streams[casc.stream].entries.push({
        seq: firstSeq,
        eventId: casc.eventId,
        firedAt: clone(casc.firedAt),
        consequenced: false,
      });
      entryWrites.push({
        stream: casc.stream,
        eventId: casc.eventId,
        firedAt: clone(casc.firedAt),
      });
    }
  }
  // entry effects: consequenced/error/drop notices; watermark AFTER
  // (match by seq too — an admitted at-or-below-horizon duplicate
  // SHARES its eventId with the original entry)
  for (const c of committed) {
    // committed ⇒ the entry exists: client-fired entries pre-exist,
    // and a committed cascade's entry was pushed above (its parent
    // is committed — a requeued parent folds the child into the
    // requeue set)
    const entry = sp.streams[c.stream].entries.find(
      (e) =>
        e.eventId === c.eventId &&
        (c.entrySeq === null || e.seq === c.entrySeq),
    )!;
    entry.consequenced = true;
    if (c.dropped !== undefined) entry.error = c.dropped;
    else if (c.errored !== undefined) entry.error = c.errored;
  }
  // eventWatermark: highest seq S such that EVERY entry at or below
  // S is consequenced — a requeued entry holds it back, and entries
  // sharing one commit seq advance only together
  for (const st of Object.values(sp.streams)) {
    const seqs = [...new Set(st.entries.map((e) => e.seq))].sort(
      (a, b) => a - b,
    );
    let wm = st.eventWatermark;
    for (const s of seqs) {
      if (s <= wm) continue;
      if (st.entries.filter((e) => e.seq === s).every((e) => e.consequenced)) {
        wm = s;
      } else break;
    }
    st.eventWatermark = wm;
  }
  const firstRows = writes.slice(0, mid);
  const lastRows = writes.slice(mid);
  const applyRows = (rows: WriteRow[], s: number) => {
    for (const row of rows) {
      sp.docs[`${row.doc}/${row.scopeKey}`] = row.value;
      sp.docHeads[`${row.doc}/${row.scopeKey}`] = s;
    }
  };
  applyRows(firstRows, firstSeq);
  if (splitting) applyRows(lastRows, lastSeq);
  for (const c of committed) {
    for (const it of c.intents) {
      const list = sp.effects[it.key] ?? (sp.effects[it.key] = []);
      list.push({
        nonce: w.nextNonce++,
        issuedIn: firstSeq,
        target: it.target,
        acked: false,
      });
    }
    // FP1 (RULED): append entries are DURABLE rows written inside
    // this very wave transaction — deleted only on delivery-ack
    for (const x of c.cascadesCross) sp.outboundAppends.push(clone(x));
  }
  // W advances only at TRUE quiescence — an exhausted wave's commit
  // carries no watermark movement, and a requeued event holds W back
  // exactly as an unprocessed one does (serving-loop §3)
  const quiescent = !pw.exhausted &&
    Object.values(sp.streams).every((st) =>
      st.entries.every((e) => e.consequenced)
    );
  if (quiescent) sp.W = lastSeq;
  const base: Omit<CommitRecord, "writes" | "seq"> = {
    class: "derived",
    envelope: `service:${space}`,
    holder: sp.leaseHolder,
    derivedThrough: sp.W,
    consequenceOf: [...consequenceOf],
    waveId: pw.waveId,
  };
  if (splitting) {
    // every split repeats derivedThrough AND the full consequenceOf
    // (serving-loop §3, as ruled after the provenance run); each
    // split is its own accepted commit with its own seq; entries
    // ride the first, the watermark doc only the last
    sp.commits.push({
      ...clone(base),
      seq: firstSeq,
      writes: firstRows,
      ...(entryWrites.length > 0 ? { entryWrites } : {}),
    });
    sp.commits.push({
      ...clone(base),
      seq: lastSeq,
      writes: lastRows,
      ...(quiescent ? { watermarkDoc: true } : {}),
    });
  } else {
    sp.commits.push({
      ...base,
      seq: firstSeq,
      writes,
      ...(entryWrites.length > 0 ? { entryWrites } : {}),
      ...(quiescent ? { watermarkDoc: true } : {}),
    });
  }
}

function runWave(w: World, space: SpaceId): void {
  computeWave(w, space);
  commitWave(w, space);
}

//
// push filtering (protocol §3)
//

export function applicableSet(c: ClientSession): string[] {
  return [SPACE_KEY, userKey(c.user), sessionKey(c.user, c.session)];
}

/** Rows of a commit that a subscriber receives — the filter itself. */
export function pushRowsFor(
  commit: CommitRecord,
  c: ClientSession,
): WriteRow[] {
  const ok = new Set(applicableSet(c));
  return commit.writes.filter((r) => ok.has(r.scopeKey));
}

//
// transitions
//

export type Step =
  | { kind: "fire"; session: SessionId; space: SpaceId; stream: DocId }
  | { kind: "wave"; space: SpaceId }
  | { kind: "waveCompute"; space: SpaceId }
  | { kind: "waveCommit"; space: SpaceId }
  | { kind: "clientWrite"; session: SessionId; space: SpaceId; doc: DocId }
  | { kind: "clientDelete"; session: SessionId; space: SpaceId; doc: DocId }
  | { kind: "deliver"; space: SpaceId }
  | { kind: "crash"; space: SpaceId }
  | { kind: "recover"; space: SpaceId }
  | {
    kind: "derivationEmit";
    space: SpaceId;
    stream: DocId;
    acting: Acting;
  }
  | { kind: "enact"; session: SessionId; space: SpaceId }
  | { kind: "ack"; session: SessionId; space: SpaceId }
  | { kind: "reload"; session: SessionId }
  | { kind: "expireLease"; space: SpaceId }
  | { kind: "reacquire"; space: SpaceId }
  | { kind: "restartProcess"; space: SpaceId }
  | { kind: "sealProbe"; space: SpaceId }
  | { kind: "deliverProbe"; space: SpaceId };

export function apply(w0: World, step: Step): World {
  const w = clone(w0);
  w.trace.push(JSON.stringify(step));
  switch (step.kind) {
    case "fire": {
      const c = w.clients[step.session];
      if (!c.connected.includes(step.space)) {
        w.violations.push("fire without connection");
        break;
      }
      admitClientAppend(w, step.space, step.stream, c);
      break;
    }
    case "wave":
      runWave(w, step.space);
      break;
    case "waveCompute":
      computeWave(w, step.space);
      break;
    case "waveCommit":
      commitWave(w, step.space);
      break;
    case "clientWrite": {
      // an ordinary authored doc write (UI binding — README §3.6):
      // ACL assumed granted; this is what races the wave (§3d)
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      if (!c.connected.includes(step.space)) break;
      sp.seq += 1;
      const key = `${step.doc}/${SPACE_KEY}`;
      sp.docs[key] = sp.seq;
      sp.docHeads[key] = sp.seq;
      sp.commits.push({
        seq: sp.seq,
        class: "authored",
        envelope: sessionKey(c.user, c.session),
        writes: [{ doc: step.doc, scopeKey: SPACE_KEY, value: sp.seq }],
      });
      break;
    }
    case "clientDelete": {
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      if (!c.connected.includes(step.space)) break;
      const key = `${step.doc}/${SPACE_KEY}`;
      if (sp.docs[key] === undefined) break;
      sp.seq += 1;
      delete sp.docs[key];
      sp.docHeads[key] = sp.seq;
      sp.commits.push({
        seq: sp.seq,
        class: "authored",
        envelope: sessionKey(c.user, c.session),
        writes: [],
      });
      break;
    }
    case "deliver": {
      // FP1 (RULED): delivery reads the DURABLE rows; the shift is
      // the delete-on-delivery-ack (a queue that empties)
      const srv = w.servers[step.space];
      const sp = w.spaces[step.space];
      if (!srv.alive || sp.outboundAppends.length === 0) break;
      const entry = sp.outboundAppends.shift()!;
      admitDelegatedAppend(w, entry);
      break;
    }
    case "crash": {
      const srv = w.servers[step.space];
      srv.alive = false;
      // FP1 (RULED): durable append rows SURVIVE — only the
      // process-local effect half and the in-memory wave die
      for (const append of srv.outbox) srv.lostAppends.push(append);
      srv.outbox = [];
      srv.pendingWave = null; // in-memory wave dies with the process
      break;
    }
    case "recover":
      w.servers[step.space].alive = true;
      break;
    case "derivationEmit": {
      // a demanded derivation run emits an event; identity is the
      // demand-supplied instance identity, inherited uniformly (LT6)
      const sp = w.spaces[step.space];
      const st = sp.streams[step.stream];
      sp.seq += 1;
      const eventId = `e${w.nextEvent++}`;
      st.entries.push({
        seq: sp.seq,
        eventId,
        firedAt: {
          user: step.acting.user,
          session: step.acting.session ?? "server",
        },
        consequenced: false,
      });
      w.rootOf[eventId] = clone(step.acting);
      break;
    }
    case "enact": {
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      const key = sessionKey(c.user, c.session);
      for (const it of sp.effects[key] ?? []) {
        if (!it.acked && !c.enactedNonces.includes(it.nonce)) {
          c.enactedNonces.push(it.nonce);
          c.enactCount[it.nonce] = (c.enactCount[it.nonce] ?? 0) + 1;
        }
      }
      break;
    }
    case "ack": {
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      const key = sessionKey(c.user, c.session);
      for (const it of sp.effects[key] ?? []) {
        if (!it.acked && c.enactedNonces.includes(it.nonce)) it.acked = true;
      }
      break;
    }
    case "reload": {
      // the overlay is process-memory: the enacted-nonce record dies
      // (speculation §1; the LT8-accepted window)
      w.clients[step.session].enactedNonces = [];
      break;
    }
    case "expireLease": {
      // the memory server's clock expires the row: matches NOBODY
      // (protocol §2; serving-loop §2)
      w.spaces[step.space].leaseHolder = null;
      break;
    }
    case "reacquire": {
      // same process, new tenure. DR1: holder value UNCHANGED (the
      // process component is stable within a process lifetime); the
      // discipline aborts in-flight commits BEFORE reacquiring.
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      if (!srv.alive || sp.leaseHolder !== null) break;
      if (w.leaseDiscipline) srv.pendingProbes = [];
      sp.leaseHolder = holderId(step.space, srv.processGen);
      sp.tenure += 1;
      break;
    }
    case "restartProcess": {
      // a genuinely-new process: the holder's process component is
      // fresh (DR1), so the equality check fences the old reign's
      // in-flight commits. The old process's sent commits stay in
      // flight (they are the fence's test subjects).
      const srv = w.servers[step.space];
      srv.processGen += 1;
      srv.alive = true;
      break;
    }
    case "sealProbe": {
      // a derived commit sealed and SENT under the current lease —
      // not yet admitted (in flight at the store's door)
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      if (
        !srv.alive || sp.leaseHolder !== holderId(step.space, srv.processGen)
      ) {
        break;
      }
      srv.pendingProbes.push({ holder: sp.leaseHolder, tenure: sp.tenure });
      break;
    }
    case "deliverProbe": {
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      const probe = srv.pendingProbes.shift();
      if (probe === undefined) break;
      const admitted = admitDerived(sp, {
        holder: probe.holder,
        envelope: `service:${step.space}`,
      });
      if (admitted) {
        w.admittedProbes += 1;
        if (probe.tenure < sp.tenure) w.staleAdmissions += 1;
      }
      break;
    }
  }
  return w;
}

//
// schedule exploration
//

function stableStringify(x: unknown): string {
  return JSON.stringify(x, function (this: unknown, _k, v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = o[k];
      return out;
    }
    return v;
  });
}

function stateKey(w: World): string {
  const { trace: _t, ...rest } = w;
  return stableStringify(rest);
}

/**
 * Exhaustive DFS over the given step menu, bounded by maxSteps, with
 * visited-state pruning. Deterministic; no clocks, no randomness.
 */
export function explore(
  w0: World,
  menu: Step[],
  opts: { maxSteps: number },
): { finals: World[]; all: World[]; statesSeen: number } {
  const finals: World[] = [];
  const all: World[] = [];
  const visited = new Set<string>();
  const stack: Array<{ w: World; depth: number }> = [{ w: w0, depth: 0 }];
  while (stack.length > 0) {
    const { w, depth } = stack.pop()!;
    const key = stateKey(w);
    if (visited.has(key)) continue;
    visited.add(key);
    all.push(w);
    let extended = false;
    if (depth < opts.maxSteps) {
      for (const step of menu) {
        const next = apply(w, step);
        if (stateKey(next) !== key) {
          extended = true;
          stack.push({ w: next, depth: depth + 1 });
        }
      }
    }
    if (!extended) finals.push(w);
  }
  return { finals, all, statesSeen: visited.size };
}

//
// narrowing / fan-out sub-model (Phase 2 pre-gate, OW3)
//
// The three bound rules ONE extension covers (verification-coverage
// OW3): instance sets are CLEAN PRODUCTS over principals, never ragged
// (scopes §2's monotonicity — narrowing is for everyone or no one);
// the CFC/attribution unit under fan-out is the RUN, `action ×
// instance`, never the action (serving-loop §3c); and nothing forks W
// (scopes §9 — W stays ONE integer, waiting on DEMANDED siblings only,
// undemanded instances never holding it back — scopes §2's
// watermark × fan-out composition). Self-contained: one scoped node
// downstream of one shared space-scoped input, exhaustively driven by
// the property suite's own DFS. Uses the SAME key constructors as the
// main model (bridge-checked against the wire vocabulary).
//

export interface FanoutState {
  /** The principals that exist (each may demand its own instance). */
  principals: UserId[];

  /** The ONE broad-slot redirect fact (scopes §2: the link INTO the
   * narrower scope is itself shared state at the broader scope, so one
   * written redirect narrows the node for EVERY reader at once). */
  narrowed: boolean;

  /** Demanded instance keys (a subscription per principal). */
  demanded: string[];

  /** instanceKey -> the input generation its value is current through.
   * Pre-narrowing the only legal key is `space`; post-narrowing only
   * `user:<p>` keys (the never-ragged shape the properties pin). */
  instances: Record<string, number>;

  /** The shared upstream input's generation (an authored input). */
  input: number;

  /** ONE watermark integer for the whole node (scopes §9). */
  W: number;

  /** Every run, as `action × instance` (serving-loop §3c): one entry
   * per RUN with the single instance it ran as and wrote. */
  runs: Array<{ instanceKey: string; wrote: string }>;

  violations: string[];
}

export type FanoutStep =
  | { kind: "fanInput" }
  | { kind: "fanNarrow"; by: UserId }
  | { kind: "fanDemand"; user: UserId }
  | { kind: "fanWave" };

export function makeFanout(principals: UserId[]): FanoutState {
  return {
    principals: [...principals],
    narrowed: false,
    demanded: [SPACE_KEY],
    instances: {},
    input: 1,
    W: 0,
    runs: [],
    violations: [],
  };
}

export function applyFanout(s0: FanoutState, step: FanoutStep): FanoutState {
  const s = structuredClone(s0);
  switch (step.kind) {
    case "fanInput": {
      // The shared space-scoped upstream advances: every instance of
      // the node is now stale against it.
      s.input += 1;
      return s;
    }
    case "fanNarrow": {
      // A run (as `by`) DISCOVERS the narrowing (scopes §2, ruled): the
      // discovering wave writes exactly two things — the broad-slot
      // redirect (the one shared fact) and the discovering run's OWN
      // instance value. Sibling instances materialize on THEIR OWN
      // demand. The broad slot stops being a value instance the same
      // moment for every reader — the clean-product shape.
      // A step naming a principal OUTSIDE the configured set is
      // REJECTED (no-op; review thread r3739139513): it would mint an
      // instance outside the clean product the invariants quantify
      // over, so the violation checker could never see it — the menu
      // must not be able to smuggle states past the properties.
      if (!s.principals.includes(step.by)) return s;
      if (s.narrowed) return s;
      s.narrowed = true;
      delete s.instances[SPACE_KEY];
      s.demanded = s.demanded.filter((key) => key !== SPACE_KEY);
      const own = userKey(step.by);
      s.instances[own] = s.input;
      s.runs.push({ instanceKey: own, wrote: own });
      if (!s.demanded.includes(own)) s.demanded.push(own);
      s.demanded.sort();
      return s;
    }
    case "fanDemand": {
      // Same out-of-set rejection as fanNarrow (r3739139513).
      if (!s.principals.includes(step.user)) return s;
      const key = s.narrowed ? userKey(step.user) : SPACE_KEY;
      if (!s.demanded.includes(key)) {
        s.demanded.push(key);
        s.demanded.sort();
      }
      return s;
    }
    case "fanWave": {
      // The wave derives every DEMANDED stale instance — one RUN per
      // instance, each reading/writing ONLY its own (serving-loop §3c:
      // the unit is `action × instance`; a merged run would be the
      // over-tainting the section forbids). W advances to the input
      // batch head iff every DEMANDED instance is current — demanded
      // siblings are waited on, undemanded ones NEVER hold W back
      // (scopes §2's composition; §9's no-forks).
      for (const key of s.demanded) {
        if ((s.instances[key] ?? 0) !== s.input) {
          s.instances[key] = s.input;
          s.runs.push({ instanceKey: key, wrote: key });
        }
      }
      const demandedCurrent = s.demanded.every(
        (key) => (s.instances[key] ?? 0) === s.input,
      );
      if (demandedCurrent) s.W = s.input;
      return s;
    }
  }
}

/** The visited-state key for the fan-out DFS (runs are audit trail —
 * kept in the key so distinct histories stay distinct for the run-unit
 * property). */
export function fanoutStateKey(s: FanoutState): string {
  return stableStringify(s);
}
