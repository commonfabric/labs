/**
 * Property checks over explored schedules of the v2 identity/commit
 * model. Each test names the spec passages it binds. One test is a
 * CHARACTERIZATION of open ledger item FP1 (field-provenance.md §6):
 * it asserts the defect IS reachable; when the ruling closes FP1,
 * that test flips to asserting closure.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isScopeKey,
  resolvePrincipalSessionKey,
  resolveScopeKey,
} from "@commonfabric/memory/v2";
import {
  admitDerived,
  applicableSet,
  apply,
  applyFanout,
  explore,
  type FanoutState,
  fanoutStateKey,
  type FanoutStep,
  holderId,
  isCanonicalKey,
  makeFanout,
  makeWorld,
  pushRowsFor,
  sessionKey,
  SPACE_KEY,
  type Step,
  userKey,
  type World,
} from "./model.ts";

const U1 = "did:u1";
const S1 = "sess1";
const U2 = "did:u2";
const S2 = "sess2";

function noViolations(worlds: World[]) {
  for (const w of worlds) {
    assertEquals(w.violations, [], `violations in trace ${w.trace.join(" ")}`);
  }
}

/** Every stream entry's firedAt equals its chain root (events §2). */
function assertInheritance(w: World) {
  for (const sp of Object.values(w.spaces)) {
    for (const st of Object.values(sp.streams)) {
      for (const e of st.entries) {
        const root = w.rootOf[e.eventId];
        assert(root !== undefined, `no root for ${e.eventId}`);
        assertEquals(e.firedAt.user, root.user, "root user preserved");
        assertEquals(
          e.firedAt.session,
          root.session ?? "server",
          "root session preserved (or sessionless)",
        );
      }
    }
  }
}

//
// C1: same-space cascade (trace T3's shape)
//

function c1World(splitWaves = false) {
  return makeWorld({
    spaces: {
      A: {
        streams: {
          s1: { writes: ["session"], cascadeTo: { space: "A", stream: "s2" } },
          s2: { writes: ["session"], navigate: true },
        },
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
    splitWaves,
  });
}

const C1_MENU: Step[] = [
  { kind: "fire", session: S1, space: "A", stream: "s1" },
  { kind: "wave", space: "A" },
  { kind: "enact", session: S1, space: "A" },
  { kind: "ack", session: S1, space: "A" },
];

Deno.test("C1: cascade inherits the root actor; intents reach the clicking session; LT1 carriage in one wave", () => {
  const w0 = apply(c1World(), C1_MENU[0]);
  const { finals, all } = explore(w0, C1_MENU.slice(1), { maxSteps: 6 });
  noViolations(all);
  assert(finals.length > 0);
  for (const w of all) assertInheritance(w);
  for (const w of finals) {
    const sp = w.spaces.A;
    // both events consequenced, in ONE wave commit's consequenceOf
    const derived = sp.commits.filter((c) => c.class === "derived");
    assert(derived.length >= 1, "a wave committed");
    const withConseq = derived.filter((c) => (c.consequenceOf ?? []).length);
    for (const c of withConseq) {
      assertEquals(
        c.consequenceOf!.length,
        2,
        "same-space cascade processed in the SAME wave (LT1, T3.Q8)",
      );
      // LT1's carriage is VISIBLE in the commit representation: the
      // cascade's durable entry rides THIS commit as a write-level
      // row at THIS commit's seq (the P1 oracle fix)
      assertEquals(c.entryWrites?.length, 1, "entry carried in the commit");
      const entry = sp.streams.s2.entries.find(
        (e) => e.eventId === c.entryWrites![0].eventId,
      );
      assertEquals(entry?.seq, c.seq, "entry seq == its wave commit's seq");
    }
    // no outbox involvement for a same-space cascade (LT1)
    assertEquals(w.servers.A.outbox.length, 0);
    assertEquals(w.servers.A.lostAppends.length, 0);
    // every session write landed in the ROOT session's instance
    for (const c of derived) {
      for (const row of c.writes) {
        assertEquals(row.scopeKey, sessionKey(U1, S1), "scopes §5");
        assertEquals(row.attribution?.user, U1);
        assertEquals(row.attribution?.session, S1);
      }
    }
    // every intent is in the clicking session's effects instance
    for (const [key, intents] of Object.entries(sp.effects)) {
      if (intents.length > 0) assertEquals(key, sessionKey(U1, S1));
    }
    // no handler errors on this legal chain
    for (const st of Object.values(sp.streams)) {
      for (const e of st.entries) {
        assertEquals(e.error, undefined, "no error on a session-bearing chain");
      }
    }
  }
});

Deno.test("C1-split: every split commit repeats the FULL consequenceOf (serving-loop §3)", () => {
  const w0 = apply(c1World(true), C1_MENU[0]);
  const { finals } = explore(w0, [{ kind: "wave", space: "A" }], {
    maxSteps: 3,
  });
  let sawSplit = false;
  for (const w of finals) {
    const derived = w.spaces.A.commits.filter((c) => c.class === "derived");
    const byWave = new Map<number, typeof derived>();
    for (const c of derived) {
      const list = byWave.get(c.waveId!) ?? [];
      list.push(c);
      byWave.set(c.waveId!, list);
    }
    for (const group of byWave.values()) {
      if (group.length > 1) sawSplit = true;
      const first = JSON.stringify(group[0].consequenceOf);
      const seqs = new Set(group.map((c) => c.seq));
      assertEquals(seqs.size, group.length, "each split has its OWN seq");
      for (const c of group) {
        assertEquals(JSON.stringify(c.consequenceOf), first);
        assertEquals(c.derivedThrough, group[0].derivedThrough);
      }
      if (group.length > 1) {
        const last = group.reduce((a, b) => (a.seq > b.seq ? a : b));
        for (const c of group) {
          assertEquals(
            c.watermarkDoc === true,
            c === last,
            "the watermark DOC write rides ONLY the last split",
          );
        }
      }
    }
  }
  assert(sawSplit, "the split configuration actually split a wave");
});

Deno.test("C1-LT8: a reload between enact and ack can re-enact — bounded, and accepted", () => {
  const w0 = apply(c1World(), C1_MENU[0]);
  const menu: Step[] = [...C1_MENU.slice(1), { kind: "reload", session: S1 }];
  const { all } = explore(w0, menu, { maxSteps: 8 });
  noViolations(all);
  let sawReEnact = false;
  for (const w of all) {
    const reloads = w.trace.filter((t) => t.includes('"reload"')).length;
    for (const n of Object.values(w.clients[S1].enactCount)) {
      assert(
        n <= 1 + reloads,
        "each re-enactment requires a reload (the LT8 window, nothing more)",
      );
      if (n >= 2) sawReEnact = true;
    }
  }
  assert(sawReEnact, "the LT8 window is real: a schedule re-enacts");
});

//
// C2: cross-space chain (trace T4's shape) + FP1
//

function c2World() {
  return makeWorld({
    spaces: {
      A: {
        streams: {
          s1: { writes: [], cascadeTo: { space: "B", stream: "t1" } },
        },
      },
      B: {
        streams: {
          t1: { writes: ["session"], navigate: true },
        },
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
}

Deno.test("C2: identity crosses the boundary (LT2); session write lands in B under (U1,S1); navigateTo in B errors (LT3)", () => {
  const w0 = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  const menu: Step[] = [
    { kind: "wave", space: "A" },
    { kind: "deliver", space: "A" },
    { kind: "wave", space: "B" },
  ];
  const { finals, all } = explore(w0, menu, { maxSteps: 6 });
  noViolations(all);
  for (const w of all) assertInheritance(w);
  const done = finals.filter((w) =>
    Object.values(w.spaces.B.streams.t1.entries).some((e) => e.consequenced)
  );
  assert(done.length > 0, "some schedule completes the chain");
  for (const w of done) {
    const entry = w.spaces.B.streams.t1.entries[0];
    // stamped at B from the CARRIED actor, not the delegating envelope
    assertEquals(entry.firedAt.user, U1);
    assertEquals(entry.firedAt.session, S1);
    // session-scoped consequence landed in (U1,S1)'s instance IN B
    const rows = w.spaces.B.commits.flatMap((c) => c.writes);
    assert(rows.some((r) => r.scopeKey === sessionKey(U1, S1)));
    // LT3: navigateTo computed in B, where S1 is NOT connected → error
    assert(
      entry.error?.includes("LT3"),
      "cross-space navigateTo is the deferral error",
    );
    assertEquals(Object.keys(w.spaces.B.effects).length, 0, "no intent");
  }
});

Deno.test("C2-FP1 (CLOSED — ruled 2026-08-03): durable append rows survive every crash; no schedule loses an append; delivery stays exactly-once", () => {
  const w0 = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  const menu: Step[] = [
    { kind: "wave", space: "A" },
    { kind: "deliver", space: "A" },
    { kind: "crash", space: "A" },
    { kind: "recover", space: "A" },
    { kind: "wave", space: "B" },
  ];
  const { all } = explore(w0, menu, { maxSteps: 8 });
  noViolations(all);
  // The FORMER gap (this test was its characterization): a crash
  // between wave commit and delivery destroyed the process-local
  // append. RULED closed: appends are durable rows in the wave's
  // own transaction, deleted on delivery-ack. Now: NO reachable
  // state has a lost append, and every state where A's event is
  // consequenced still has the append either pending (durable) or
  // delivered.
  for (const w of all) {
    assertEquals(
      w.servers.A.lostAppends.length,
      0,
      `an append was lost in trace ${w.trace.join(" ")}`,
    );
    if (
      w.spaces.A.streams.s1.entries.length > 0 &&
      w.spaces.A.streams.s1.entries.every((e) => e.consequenced)
    ) {
      assert(
        w.spaces.A.outboundAppends.length > 0 ||
          w.spaces.B.streams.t1.entries.length > 0,
        "the append is either still pending (durable) or delivered",
      );
    }
    // and delivery stays exactly-once on EVERY schedule, crashes
    // included (the eventId horizon dedupes redelivery)
    assert(w.spaces.B.streams.t1.entries.length <= 1, "never duplicated");
  }
  // non-vacuity: crash-then-recover-then-deliver actually delivers
  let w = apply(w0, { kind: "wave", space: "A" });
  w = apply(w, { kind: "crash", space: "A" });
  w = apply(w, { kind: "recover", space: "A" });
  w = apply(w, { kind: "deliver", space: "A" });
  assertEquals(
    w.spaces.B.streams.t1.entries.length,
    1,
    "recovery re-sends the durable row (serving-loop §6 step 5)",
  );
});

Deno.test("C2-dedupe: at-least-once redelivery is idempotent at the target (events §4)", () => {
  // Deliver twice by re-enqueueing the same entry manually.
  let w = apply(c2World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s1",
  });
  w = apply(w, { kind: "wave", space: "A" });
  const entry = structuredClone(w.spaces.A.outboundAppends[0]);
  w = apply(w, { kind: "deliver", space: "A" });
  w.spaces.A.outboundAppends.push(entry); // the retry
  w = apply(w, { kind: "deliver", space: "A" });
  assertEquals(
    w.spaces.B.streams.t1.entries.length,
    1,
    "above-horizon duplicate REJECTED by the uniqueness CAS",
  );
  w = apply(w, { kind: "wave", space: "B" });
  const rowsBefore = w.spaces.B.commits.flatMap((c) => c.writes).length;
  w.spaces.A.outboundAppends.push(entry); // late retry, post-processing
  w = apply(w, { kind: "deliver", space: "A" });
  // events §4: an at-or-below-horizon duplicate ADMITS as a new
  // entry — admission must not bless a stronger, permanent dedupe
  // than the contract (the Codex P2 fix)
  assertEquals(
    w.spaces.B.streams.t1.entries.length,
    2,
    "the late duplicate ADMITS (the horizon bounds admission's CAS)",
  );
  w = apply(w, { kind: "wave", space: "B" });
  assertEquals(
    w.skippedIdempotent,
    1,
    "processing SKIPS the duplicate, counted skippedIdempotent",
  );
  assertEquals(
    w.spaces.B.streams.t1.entries[1].consequenced,
    true,
    "the skipped entry is passed by the watermark (non-wedging)",
  );
  assertEquals(
    w.spaces.B.commits.flatMap((c) => c.writes).length,
    rowsBefore,
    "no consequences from the skipped duplicate",
  );
});

//
// C3: sessionless chains and uniform inheritance (LT6)
//

Deno.test("C3: derivation-emitted events carry the demand identity uniformly (LT6); sessionless writes error", () => {
  const base = makeWorld({
    spaces: {
      A: { streams: { s: { writes: ["session", "user"], navigate: true } } },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  const cases: Array<{
    acting: { user?: string; session?: string };
    wantSession: string;
    sessionWriteOk: boolean;
    userWriteOk: boolean;
    navigateOk: boolean;
  }> = [
    // space-scope run: no identity at all
    {
      acting: {},
      wantSession: "server",
      sessionWriteOk: false,
      userWriteOk: false,
      navigateOk: false,
    },
    // user-instance run: acting user, no session
    {
      acting: { user: U1 },
      wantSession: "server",
      sessionWriteOk: false,
      userWriteOk: true,
      navigateOk: false,
    },
    // session-instance run: fully session-bearing (LT6 uniform)
    {
      acting: { user: U1, session: S1 },
      wantSession: S1,
      sessionWriteOk: true,
      userWriteOk: true,
      navigateOk: true,
    },
  ];
  for (const c of cases) {
    let w = apply(base, {
      kind: "derivationEmit",
      space: "A",
      stream: "s",
      acting: c.acting,
    });
    w = apply(w, { kind: "wave", space: "A" });
    const entry = w.spaces.A.streams.s.entries[0];
    assertEquals(entry.firedAt.session, c.wantSession);
    const rows = w.spaces.A.commits.flatMap((x) => x.writes);
    assertEquals(
      rows.some((r) => r.scopeKey.startsWith("session:")),
      c.sessionWriteOk,
    );
    assertEquals(
      rows.some((r) => r.scopeKey.startsWith("user:")),
      c.userWriteOk,
    );
    const intents = Object.values(w.spaces.A.effects).flat();
    assertEquals(intents.length > 0, c.navigateOk);
    if (!c.sessionWriteOk || !c.navigateOk) {
      assert(entry.error !== undefined, "the specced runtime error surfaced");
    }
    assertEquals(w.violations, []);
  }
});

//
// C4: push privacy and settledness
//

Deno.test("C4: a subscriber receives only its applicable set (protocol §3); settledness is sound (protocol §4)", () => {
  const w0 = makeWorld({
    spaces: {
      A: { streams: { s: { writes: ["space", "user", "session"] } } },
    },
    clients: [
      { user: U1, session: S1, connected: ["A"] },
      { user: U2, session: S2, connected: ["A"] },
    ],
  });
  let w = apply(w0, { kind: "fire", session: S1, space: "A", stream: "s" });
  const fireSeq = w.spaces.A.seq;
  w = apply(w, { kind: "wave", space: "A" });
  const s2 = w.clients[S2];
  for (const commit of w.spaces.A.commits) {
    const rows = pushRowsFor(commit, s2);
    const ok = new Set(applicableSet(s2));
    for (const r of rows) assert(ok.has(r.scopeKey));
    // U1's scoped rows are ABSENT for S2
    assert(!rows.some((r) => r.scopeKey === userKey(U1)));
    assert(!rows.some((r) => r.scopeKey === sessionKey(U1, S1)));
    // the space row IS delivered
    if (commit.class === "derived") {
      assert(rows.some((r) => r.scopeKey === "space"));
    }
  }
  // settledness: W >= the fire's seq implies its consequences committed
  assert(w.spaces.A.W >= fireSeq);
  assert(w.spaces.A.streams.s.entries.every((e) => e.consequenced));
});

//
// C6: admission negatives
//

Deno.test("C6: derived admission is the lease equality check — forgeries and non-holders rejected (protocol §2, serving-loop §2)", () => {
  const w = makeWorld({
    spaces: { A: { streams: {} } },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  const sp = w.spaces.A;
  const me = holderId("A", 0);
  assert(admitDerived(sp, { holder: me, envelope: "service:A" }));
  assert(
    !admitDerived(sp, { holder: holderId("B", 0), envelope: "service:B" }),
  );
  assert(!admitDerived(sp, { holder: undefined, envelope: "service:A" }));
  // a client cannot even represent a derived commit: envelope check
  assert(
    !admitDerived(sp, { holder: me, envelope: sessionKey(U1, S1) }),
  );
  sp.leaseHolder = null; // expired lease matches NOBODY (protocol §2)
  assert(!admitDerived(sp, { holder: me, envelope: "service:A" }));
});

//
// C7: the lease fence (DR1, serving-loop §2)
//

const C7_MENU: Step[] = [
  { kind: "sealProbe", space: "A" },
  { kind: "expireLease", space: "A" },
  { kind: "restartProcess", space: "A" },
  { kind: "reacquire", space: "A" },
  { kind: "deliverProbe", space: "A" },
];

function c7World(leaseDiscipline: boolean) {
  return makeWorld({
    spaces: { A: { streams: {} } },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
    leaseDiscipline,
  });
}

Deno.test("C7a: DR1 verified — per-process holder + in-process discipline admits NO stale-tenure commit on any schedule", () => {
  const { all } = explore(c7World(true), C7_MENU, { maxSteps: 9 });
  for (const w of all) {
    assertEquals(
      w.staleAdmissions,
      0,
      `stale admission in trace ${w.trace.join(" ")}`,
    );
  }
  // and the fence is not vacuous: some schedule does deliver a live
  // probe successfully
  assert(
    all.some((w) => w.admittedProbes > 0),
    "live probes still flow",
  );
});

Deno.test("C7b: the residue the MUST exists for — discipline OFF makes a same-process stale admission reachable; cross-process stays fenced regardless", () => {
  const { all } = explore(c7World(false), C7_MENU, { maxSteps: 9 });
  const stale = all.filter((w) => w.staleAdmissions > 0);
  assert(
    stale.length > 0,
    "the same-process pause window is real without the discipline — " +
      "this is WHY serving-loop §2's stop-committing MUST exists",
  );
  // and the CROSS-process path stays fenced even with the discipline
  // off — the directed schedule: seal under p0, expire, RESTART
  // (fresh process component p1), reacquire as p1, deliver the p0
  // probe → the one equality check rejects it (DR1's free fence)
  let w = c7World(false);
  w = apply(w, { kind: "sealProbe", space: "A" });
  w = apply(w, { kind: "expireLease", space: "A" });
  w = apply(w, { kind: "restartProcess", space: "A" });
  w = apply(w, { kind: "reacquire", space: "A" });
  w = apply(w, { kind: "deliverProbe", space: "A" });
  assertEquals(w.staleAdmissions, 0, "process component fences cross-process");
  assertEquals(w.admittedProbes, 0, "the stale probe was rejected");
  assertEquals(w.servers.A.pendingProbes.length, 0, "probe consumed");
});

//
// C8: mid-wave conflicts, per write class (§3d)
//

function c8World() {
  return makeWorld({
    spaces: {
      A: {
        streams: { s: { writes: ["space"] } }, // consequence → s-out
        derivations: [{ from: "d-in", out: "d-out" }], // pure
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
}

Deno.test("C8a: a superseded PURE derived write is DROPPED — the intruding authored write survives, the next wave recomputes over it (serving-loop §3d; protocol §1 threat model)", () => {
  let w = c8World();
  w = apply(w, { kind: "clientWrite", session: S1, space: "A", doc: "d-in" });
  w = apply(w, { kind: "waveCompute", space: "A" });
  // the race: an authored write to the DERIVED OUTPUT lands mid-wave
  w = apply(w, { kind: "clientWrite", session: S1, space: "A", doc: "d-out" });
  const intruder = w.spaces.A.docs["d-out/space"];
  w = apply(w, { kind: "waveCommit", space: "A" });
  assertEquals(w.supersededWrites, 1, "the stale derived write dropped");
  assertEquals(
    w.spaces.A.docs["d-out/space"],
    intruder,
    "the authored write was NOT clobbered by the stale wave",
  );
  // the racing commit is the next wave's input: recompute wins
  w = apply(w, { kind: "wave", space: "A" });
  assertEquals(
    w.spaces.A.docs["d-out/space"],
    w.spaces.A.docs["d-in/space"],
    "the next wave recomputed the derivation over the intrusion",
  );
});

Deno.test("C8b: a raced handler CONSEQUENCE is REQUEUED — never lost, never doubled, watermark holds until it lands (serving-loop §3d; events §4)", () => {
  let w = c8World();
  w = apply(w, { kind: "fire", session: S1, space: "A", stream: "s" });
  const eventId = w.spaces.A.streams.s.entries[0].eventId;
  w = apply(w, { kind: "waveCompute", space: "A" });
  // the race: an authored write to the CONSEQUENCE TARGET lands
  w = apply(w, { kind: "clientWrite", session: S1, space: "A", doc: "s-out" });
  w = apply(w, { kind: "waveCommit", space: "A" });
  assertEquals(w.requeues, 1, "the event rolled back to unconsequenced");
  const entry = w.spaces.A.streams.s.entries[0];
  assertEquals(entry.consequenced, false, "requeued, not consequenced");
  assertEquals(entry.error, undefined, "a raced event is NEVER dropped (T3)");
  assertEquals(
    w.spaces.A.streams.s.eventWatermark < entry.seq,
    true,
    "the watermark cannot pass an unconsequenced event",
  );
  // the retry wave lands it exactly once
  w = apply(w, { kind: "wave", space: "A" });
  const appearances = w.spaces.A.commits.flatMap((c) => c.consequenceOf ?? [])
    .filter((id) => id === eventId).length;
  assertEquals(appearances, 1, "consequences committed exactly once");
  assertEquals(w.spaces.A.streams.s.entries[0].consequenced, true);
});

Deno.test("C8c: exactly-once under exhaustive racing — no event's consequences ever commit twice, and W never passes an unconsequenced event", () => {
  const w0 = apply(c8World(), {
    kind: "fire",
    session: S1,
    space: "A",
    stream: "s",
  });
  const menu: Step[] = [
    { kind: "waveCompute", space: "A" },
    { kind: "waveCommit", space: "A" },
    { kind: "clientWrite", session: S1, space: "A", doc: "s-out" },
    { kind: "clientWrite", session: S1, space: "A", doc: "d-in" },
    { kind: "wave", space: "A" },
  ];
  const { all } = explore(w0, menu, { maxSteps: 7 });
  noViolations(all);
  for (const w of all) {
    const counts = new Map<string, number>();
    for (const c of w.spaces.A.commits) {
      for (const id of c.consequenceOf ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    for (const [id, n] of counts) {
      assert(n <= 1, `event ${id} consequenced ${n}× in ${w.trace.join(" ")}`);
    }
    // W soundness: every entry at or below W is consequenced
    for (const st of Object.values(w.spaces.A.streams)) {
      for (const e of st.entries) {
        if (e.seq <= w.spaces.A.W) {
          assert(e.consequenced, "W passed an unconsequenced event");
        }
      }
    }
  }
});

//
// C9: DROP vs REQUEUE — the T3 distinction
//

Deno.test("C9: an UNRUNNABLE event DROPS (notice + watermark advance, non-wedging); a RACED event never does (events §5; serving-loop §3d)", () => {
  const base = makeWorld({
    spaces: {
      A: { streams: { t: { writes: ["space"], requiresDoc: "pre" } } },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  // happy path first: precondition present → runs normally
  let ok = apply(base, {
    kind: "clientWrite",
    session: S1,
    space: "A",
    doc: "pre",
  });
  ok = apply(ok, { kind: "fire", session: S1, space: "A", stream: "t" });
  ok = apply(ok, { kind: "wave", space: "A" });
  assertEquals(ok.spaces.A.streams.t.entries[0].error, undefined);
  // drop path: the doc the handler must write against is DELETED
  let w = apply(base, {
    kind: "clientWrite",
    session: S1,
    space: "A",
    doc: "pre",
  });
  w = apply(w, { kind: "fire", session: S1, space: "A", stream: "t" });
  w = apply(w, { kind: "clientDelete", session: S1, space: "A", doc: "pre" });
  w = apply(w, { kind: "wave", space: "A" });
  const entry = w.spaces.A.streams.t.entries[0];
  assert(entry.error?.includes("dropped"), "the drop notice is the surface");
  assertEquals(entry.consequenced, true, "watermark passes it — non-wedging");
  assert(w.spaces.A.streams.t.eventWatermark >= entry.seq);
  const rows = w.spaces.A.commits.filter((c) => c.class === "derived")
    .flatMap((c) => c.writes);
  assertEquals(rows.length, 0, "no consequences from a dropped event");
  assertEquals(w.requeues, 0, "an unrunnable event is never requeued");
});

//
// C10: budget exhaustion — W pinned, continuation
//

Deno.test("C10: an exhausted wave commits WITHOUT advancing W; continuation waves finish; W jumps only at true quiescence (serving-loop §3)", () => {
  let w = makeWorld({
    spaces: { A: { streams: { s: { writes: ["space"] } } } },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
    waveBudget: 1,
  });
  w = apply(w, { kind: "fire", session: S1, space: "A", stream: "s" });
  w = apply(w, { kind: "fire", session: S1, space: "A", stream: "s" });
  w = apply(w, { kind: "wave", space: "A" });
  // one event processed, one left: the commit carries NO W movement
  const derived1 = w.spaces.A.commits.filter((c) => c.class === "derived");
  assertEquals(derived1.length, 1);
  assertEquals(derived1[0].derivedThrough, 0, "derivedThrough pinned at old W");
  assertEquals(w.spaces.A.W, 0, "W did not advance");
  assertEquals(
    w.spaces.A.streams.s.entries.filter((e) => e.consequenced).length,
    1,
    "the processed event's consequences DID commit (with its watermark)",
  );
  // continuation wave reaches quiescence: W jumps
  w = apply(w, { kind: "wave", space: "A" });
  assert(w.spaces.A.W > 0, "W advances at true quiescence");
  assert(w.spaces.A.streams.s.entries.every((e) => e.consequenced));
  // exactly-once across the exhaustion boundary
  const counts = new Map<string, number>();
  for (const c of w.spaces.A.commits) {
    for (const id of c.consequenceOf ?? []) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const n of counts.values()) assertEquals(n, 1);
});

//
// C8d + C0: rollback closure and the guard rails
//

Deno.test("C8d: a requeued parent's same-wave cascade NEVER escapes — rollback closes over descendants (events §4; serving-loop §3d)", () => {
  const w0 = makeWorld({
    spaces: {
      A: {
        streams: {
          s1: { writes: ["space"], cascadeTo: { space: "A", stream: "s2" } },
          s2: { writes: ["space"] },
        },
      },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  let w = apply(w0, { kind: "fire", session: S1, space: "A", stream: "s1" });
  w = apply(w, { kind: "waveCompute", space: "A" });
  // race the PARENT's consequence target mid-wave
  w = apply(w, { kind: "clientWrite", session: S1, space: "A", doc: "s1-out" });
  w = apply(w, { kind: "waveCommit", space: "A" });
  assertEquals(w.requeues, 1, "parent requeued; the child folds into it");
  assertEquals(
    w.spaces.A.streams.s2.entries.length,
    0,
    "only the committing attempt's cascades escape the wave",
  );
  assertEquals(w.spaces.A.streams.s1.entries[0].consequenced, false);
  // the retry lands cleanly, cascade escapes exactly once
  w = apply(w, { kind: "wave", space: "A" });
  assertEquals(w.spaces.A.streams.s2.entries.length, 1);
  assert(w.spaces.A.streams.s1.entries[0].consequenced);
  assert(w.spaces.A.streams.s2.entries[0].consequenced);
});

Deno.test("C0-guards: connection guards; no-actor space writes carry no attribution; mid-wave lease loss aborts; sessionless delegated stamping", () => {
  const w0 = makeWorld({
    spaces: {
      A: { streams: { s: { writes: ["space"] } } },
      B: { streams: {} },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  // a session cannot act on a space it holds no connection to
  let w = apply(w0, { kind: "fire", session: S1, space: "B", stream: "s" });
  assertEquals(w.violations, ["fire without connection"]);
  w = apply(w0, { kind: "clientWrite", session: S1, space: "B", doc: "d" });
  assertEquals(w.spaces.B.commits.length, 0);
  w = apply(w0, { kind: "clientDelete", session: S1, space: "B", doc: "d" });
  assertEquals(w.spaces.B.commits.length, 0);
  // deleting a doc that does not exist is a no-op, not a commit
  w = apply(w0, { kind: "clientDelete", session: S1, space: "A", doc: "g" });
  assertEquals(w.spaces.A.commits.length, 0);
  // a space-scope write from a run with NO acting user: addressing
  // yes, attribution NONE (protocol §1)
  w = apply(w0, {
    kind: "derivationEmit",
    space: "A",
    stream: "s",
    acting: {},
  });
  w = apply(w, { kind: "wave", space: "A" });
  const row = w.spaces.A.commits.flatMap((c) => c.writes)[0];
  assertEquals(row.scopeKey, "space");
  assertEquals(row.attribution, undefined, "no actor ⇒ no attribution");
  // lease lost between compute and commit: the wave ABORTS (§2)
  let w2 = apply(w0, { kind: "fire", session: S1, space: "A", stream: "s" });
  w2 = apply(w2, { kind: "waveCompute", space: "A" });
  w2 = apply(w2, { kind: "expireLease", space: "A" });
  w2 = apply(w2, { kind: "waveCommit", space: "A" });
  assertEquals(
    w2.spaces.A.commits.filter((c) => c.class === "derived").length,
    0,
    "in-flight transaction aborted on lease loss",
  );
  assertEquals(w2.spaces.A.streams.s.entries[0].consequenced, false);
  // a SESSIONLESS chain's cross-space append stamps session="server"
  // at the target while carrying the acting user (events §2)
  const w3base = makeWorld({
    spaces: {
      A: {
        streams: { s: { writes: [], cascadeTo: { space: "B", stream: "t" } } },
      },
      B: { streams: { t: { writes: ["user"] } } },
    },
    clients: [{ user: U1, session: S1, connected: ["A"] }],
  });
  let w3 = apply(w3base, {
    kind: "derivationEmit",
    space: "A",
    stream: "s",
    acting: { user: U1 },
  });
  w3 = apply(w3, { kind: "wave", space: "A" });
  w3 = apply(w3, { kind: "deliver", space: "A" });
  const t = w3.spaces.B.streams.t.entries[0];
  assertEquals(t.firedAt.session, "server");
  assertEquals(t.firedAt.user, U1);
  // OW15 (protocol §2's Phase-3 floor carve-out, SHAPE RULED
  // 2026-08-05; the model pin the register row owes): a chain with NO
  // actor ANYWHERE — a space-scope derivation's emission — crosses
  // spaces and admits with firedAt = { session: "server" } and NO user
  // key. The engine-side floor negatives (userless-undeclared refused,
  // contradiction refusals, grant mandatory) are implementation-side
  // pins (memory/test/v2-event-append.test.ts) — the model's admission
  // deliberately models the POST-carve-out semantics only.
  let w4 = apply(w3base, {
    kind: "derivationEmit",
    space: "A",
    stream: "s",
    acting: {},
  });
  w4 = apply(w4, { kind: "wave", space: "A" });
  w4 = apply(w4, { kind: "deliver", space: "A" });
  const sessionless = w4.spaces.B.streams.t.entries[0];
  assertEquals(sessionless.firedAt.session, "server");
  // Key ABSENCE, not a present-but-undefined key (round-2 thread T32):
  // the OW15 carve-out stamps NO user key at all, and the old
  // value-equality read passed vacuously against `{ user: undefined }`.
  assertEquals("user" in sessionless.firedAt, false, "no user key (OW15)");
});

//
// conformance bridge: model keys === the wire vocabulary
//

Deno.test("bridge: model scope-key constructors byte-agree with the real wire vocabulary (LD3, key-vocabulary §3)", () => {
  // The model RESTATES the constructors (model.ts stays import-free);
  // this bridge is what keeps the restatement honest. Corpus includes
  // `:`-bearing principals (DIDs contain `:`), `/`-bearing components,
  // pre-encoded-looking strings (must stay distinct from their decoded
  // forms), and non-ASCII.
  const principals = [
    "did:u1",
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "a:b",
    "a/b",
    "a%3Ab",
    "user with spaces",
    "ünïcode:∆",
  ];
  const sessionIds = ["sess1", "b:c", "s/1", "s%2F1", "s ü:∆"];
  assertEquals(SPACE_KEY, resolveScopeKey("space", {}));
  assertEquals(SPACE_KEY, resolveScopeKey(undefined, {}));
  for (const p of principals) {
    assertEquals(userKey(p), resolveScopeKey("user", { principal: p }));
    for (const s of sessionIds) {
      assertEquals(
        sessionKey(p, s),
        resolveScopeKey("session", { principal: p, sessionId: s }),
      );
      assertEquals(sessionKey(p, s), resolvePrincipalSessionKey(p, s));
    }
  }
  // The injectivity witness the un-encoded constructors failed: encoding
  // keeps the literal `:` separators exact, so these no longer collide.
  assert(sessionKey("a:b", "c") !== sessionKey("a", "b:c"));
  assert(userKey("session:x") !== sessionKey("x", "x"));

  // Validator half of the bridge: the model's restated validator and the
  // real `isScopeKey` agree POINTWISE — every constructed key is in both
  // acceptance sets, and the rejection sets coincide over the corpus of
  // prefix-shaped non-keys: raw delimiters inside a segment, malformed
  // escapes, decodable-but-non-canonical escapes, missing/empty segments.
  for (const p of principals) {
    for (
      const key of [
        userKey(p),
        ...sessionIds.map((s) => sessionKey(p, s)),
      ]
    ) {
      assert(isScopeKey(key), `real validator rejects constructed ${key}`);
      assert(isCanonicalKey(key), `model validator rejects constructed ${key}`);
    }
  }
  const rejectionCorpus = [
    "",
    "user",
    "session",
    "user:",
    "session:x",
    "session:x:",
    "Space",
    " space",
    "space ",
    "user:a/b",
    "session:a/b:c",
    "session:a:b/c",
    "user:did:key:alice",
    "session:a:b:c",
    "user:%",
    "user:%2",
    "user:%GG",
    "session:%GG:s",
    "user:a%2fb",
    "user:%41",
    "user:a b",
    "user:a+b",
    "user:\uD800",
    "user:%ED%A0%80",
  ];
  for (const value of rejectionCorpus) {
    assertEquals(
      isScopeKey(value),
      false,
      `real validator admits ${JSON.stringify(value)}`,
    );
    assertEquals(
      isCanonicalKey(value),
      false,
      `model validator admits ${JSON.stringify(value)}`,
    );
  }
});

//
// C11: narrowing / fan-out (Phase 2 pre-gate, OW3)
//
// One extension covers the OW3 trio (verification-coverage §3):
// instance sets stay CLEAN PRODUCTS over principals (scopes §2's
// monotonicity), the enforcement/attribution unit under fan-out is the
// RUN — `action × instance`, never the action (serving-loop §3c) —
// and W never forks (scopes §9): one integer, waiting on DEMANDED
// siblings only, undemanded instances never holding it back
// (scopes §2's watermark × fan-out composition).
//

const FAN_MENU = (): FanoutStep[] => [
  { kind: "fanInput" },
  { kind: "fanNarrow", by: U1 },
  { kind: "fanNarrow", by: U2 },
  { kind: "fanDemand", user: U1 },
  { kind: "fanDemand", user: U2 },
  { kind: "fanWave" },
];

function exploreFanout(
  s0: FanoutState,
  maxSteps: number,
): FanoutState[] {
  const all: FanoutState[] = [];
  const visited = new Set<string>();
  const stack: Array<{ s: FanoutState; depth: number }> = [
    { s: s0, depth: 0 },
  ];
  while (stack.length > 0) {
    const { s, depth } = stack.pop()!;
    const key = fanoutStateKey(s);
    if (visited.has(key)) continue;
    visited.add(key);
    all.push(s);
    if (depth < maxSteps) {
      for (const step of FAN_MENU()) {
        const next = applyFanout(s, step);
        if (fanoutStateKey(next) !== key) {
          stack.push({ s: next, depth: depth + 1 });
        }
      }
    }
  }
  return all;
}

Deno.test("C11a: instance sets are CLEAN PRODUCTS over principals — never ragged, on every reachable schedule (scopes §2)", () => {
  const all = exploreFanout(makeFanout([U1, U2]), 7);
  assert(all.length > 50, `state space too small (${all.length})`);
  const legalInstanceKeys = new Set([userKey(U1), userKey(U2)]);
  for (const s of all) {
    assertEquals(s.violations, []);
    const keys = Object.keys(s.instances);
    if (s.narrowed) {
      // Narrow for EVERYONE: no broad value instance survives, and
      // every value instance is a principal's — a subset of the clean
      // product, never a key outside it.
      assert(!keys.includes(SPACE_KEY), "broad value after narrowing");
      for (const key of keys) {
        assert(legalInstanceKeys.has(key), `ragged instance key ${key}`);
      }
    } else {
      // Broad for EVERYONE: no principal instance exists before the
      // one shared redirect fact does.
      for (const key of keys) {
        assertEquals(key, SPACE_KEY, `pre-narrowing instance ${key}`);
      }
    }
  }
});

Deno.test("C11d: a step naming a principal outside the configured set is REJECTED — the menu cannot smuggle instances past the clean-product invariant (r3739139513)", () => {
  const s0 = makeFanout([U1]);
  // Pre-fix, fanNarrow/fanDemand minted the foreign user's instance:
  // the clean-product check quantifies over `principals`, so the
  // out-of-set state passed the violations assertion unseen.
  assertEquals(applyFanout(s0, { kind: "fanNarrow", by: U2 }), s0);
  assertEquals(applyFanout(s0, { kind: "fanDemand", user: U2 }), s0);
  // And after a legitimate narrowing, a foreign demand still cannot
  // mint an out-of-set instance key.
  const narrowed = applyFanout(s0, { kind: "fanNarrow", by: U1 });
  assertEquals(
    applyFanout(narrowed, { kind: "fanDemand", user: U2 }),
    narrowed,
  );
});

Deno.test("C11b: the fan-out unit is the RUN — `action × instance`, one principal's writes per run, never merged (serving-loop §3c)", () => {
  const all = exploreFanout(makeFanout([U1, U2]), 7);
  for (const s of all) {
    for (const run of s.runs) {
      // Every run names exactly ONE instance and wrote exactly that
      // instance — the granularity CFC labels and attribution ride at.
      assertEquals(run.wrote, run.instanceKey);
    }
  }
  // And fan-out genuinely happens: some schedule runs BOTH principals'
  // instances (the N-runs-as-N-principals-in-one-wave shape).
  assert(
    all.some((s) =>
      s.runs.some((r) => r.instanceKey === userKey(U1)) &&
      s.runs.some((r) => r.instanceKey === userKey(U2))
    ),
    "no schedule exercised cardinality 2",
  );
});

Deno.test("C11c: W never forks — one integer, waiting on DEMANDED siblings only; undemanded instances never hold it back (scopes §2, §9)", () => {
  const all = exploreFanout(makeFanout([U1, U2]), 7);
  for (const s of all) {
    // Type-level: FanoutState.W is a single number (a per-instance
    // watermark shape cannot even be expressed); behaviorally the rule
    // binds the ADVANCE, not the standing state — protocol §4: a fresh
    // subscription arriving AFTER W may still trigger a recompute that
    // lands in a LATER derived commit, so a post-W new demand with a
    // stale instance is a legal state. What must hold: a wave never
    // ADVANCES W while any instance demanded at advance time is stale.
    assert(typeof s.W === "number");
    const advanced = applyFanout(s, { kind: "fanWave" });
    if (advanced.W > s.W) {
      for (const key of advanced.demanded) {
        assertEquals(
          advanced.instances[key] ?? 0,
          advanced.input,
          `the wave advanced W to ${advanced.W} with demanded ${key} stale`,
        );
      }
    }
  }
  // Undemanded-never-holds: a schedule exists where U2's instance is
  // stale (or absent) while W covers the input — because only U1
  // demanded.
  assert(
    all.some((s) =>
      s.narrowed && s.W === s.input && s.W > 0 &&
      s.demanded.includes(userKey(U1)) &&
      !s.demanded.includes(userKey(U2)) &&
      (s.instances[userKey(U2)] ?? 0) < s.input
    ),
    "no schedule showed an undemanded sibling left behind while W " +
      "advanced",
  );
  // Demanded-holds: a schedule exists where BOTH are demanded and W
  // lags the input until the wave runs both.
  assert(
    all.some((s) =>
      s.demanded.includes(userKey(U1)) &&
      s.demanded.includes(userKey(U2)) && s.W < s.input
    ),
    "no schedule showed W waiting on demanded siblings",
  );
});
