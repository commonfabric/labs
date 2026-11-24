// The client durability barrier covers pattern-manager program work
// (verification-coverage.md OW45, seat S-B — the client half of the
// home-profile program-write loss): `Scheduler.idleWithPendingCommits`
// is the client's "safe to navigate or reload" checkpoint — its
// contract is "once it resolves, tearing the page down loses no
// writes" — but a program-materialization commit travels through the
// pattern manager's OWN async chains: a by-identity load that
// cold-compiles and re-persists a space's program docs, and the
// compile-cache write-back that IS the program commit. Pre-fix those
// chains lived outside the barrier (that is why
// `flushCompileCacheWrites` exists as a separate call), so a client
// that reached idle and reloaded killed the trailing create's program
// commit — the space then served nothing forever (rootcause §1; the
// serving-side halves are OW31 S-A and OW46 S-D).
//
// Pinned here at both levels:
//  1. the barrier CONSULTS the pattern manager and holds until its
//     pending work settles (and plain `idle()` — reactive quiescence
//     only, by contract — does NOT);
//  2. the accessors read the REAL registries those chains register
//     into — the in-progress compilation map (the compile-and-run
//     floating-promise phase), the single-flight load slot, and the
//     persistence set — so an entry in any of the three holds the
//     barrier, and once the barrier resolves no pattern work is in
//     flight.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("scheduler idle pattern work");
const space = signer.did();

describe("idleWithPendingCommits covers pattern work (OW45 S-B)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("holds the commit-aware barrier while pattern work is pending; plain idle() stays reactive-only", async () => {
    // Stub the two methods the barrier consults, gating settlement on
    // an external promise — the scheduler half of the pin. (The
    // accessor half — that these reflect real loads and write-backs —
    // is the next test.)
    const gate = Promise.withResolvers<void>();
    let pending = true;
    let settleCalls = 0;
    const manager = runtime.patternManager as unknown as {
      hasPendingPatternWork: () => boolean;
      pendingPatternWorkSettled: () => Promise<void>;
    };
    manager.hasPendingPatternWork = () => pending;
    manager.pendingPatternWorkSettled = () => {
      settleCalls += 1;
      return gate.promise;
    };

    // Plain idle(): reactive quiescence only, by contract — must not
    // consult or wait for pattern work (the serving loop's settle
    // probes ride this and must not chase client persistence).
    await runtime.scheduler.idle();
    expect(settleCalls).toBe(0);

    let resolved = false;
    const barrier = runtime.scheduler.idleWithPendingCommits().then(() => {
      resolved = true;
    });
    // Give the barrier ample turns: it must be HELD by the pending
    // pattern work, not resolve in a later microtask.
    for (let i = 0; i < 20; i++) {
      await clock.tick(5);
    }
    expect(resolved).toBe(false);
    expect(settleCalls).toBeGreaterThanOrEqual(1);

    pending = false;
    gate.resolve();
    await barrier;
    expect(resolved).toBe(true);
  });

  it("the accessors reflect real work: a registered load holds the barrier, and after the barrier no pattern work is in flight", async () => {
    // The LOAD half, driven at the single-flight registry the load path
    // registers into (an in-flight load's whole lifecycle can complete
    // inside one fake-clock drain, so probing a real load from outside
    // is racy by construction; the registry entry IS the registration
    // the accessor must reflect): an entry present ⇒ pattern work
    // pending ⇒ the commit-aware barrier holds until it settles.
    const manager = runtime.patternManager.accessForTestingOnly;
    const gate = Promise.withResolvers<Pattern | undefined>();
    manager.inProgressByIdentityLoads.set(
      `${space}\0ow45-synthetic-load`,
      gate.promise,
    );
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(true);
    let loadBarrierResolved = false;
    const loadBarrier = runtime.scheduler.idleWithPendingCommits().then(() => {
      loadBarrierResolved = true;
    });
    for (let i = 0; i < 10; i++) {
      await clock.tick(5);
    }
    expect(loadBarrierResolved).toBe(false);
    manager.inProgressByIdentityLoads.delete(`${space}\0ow45-synthetic-load`);
    gate.resolve(undefined);
    await loadBarrier;
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(false);

    // The WRITE-BACK half, driven at the same registry
    // `persistCompileCacheTracked` registers into (`compileCacheWrites`
    // — the pre-existing set `flushCompileCacheWrites` and shutdown
    // replication already consume, so real persistence populating it is
    // already load-bearing behavior): an in-flight program
    // materialization holds the barrier until durable. (A REAL compile
    // is not driven here: under the suite's fake clock the compiler's
    // real I/O and the logical timers cannot be sequenced
    // deterministically from outside.)
    const writeManager = runtime.patternManager.accessForTestingOnly;
    const writeGate = Promise.withResolvers<void>();
    writeManager.compileCacheWrites.add(writeGate.promise);
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(true);
    let writeBarrierResolved = false;
    const writeBarrier = runtime.scheduler.idleWithPendingCommits().then(
      () => {
        writeBarrierResolved = true;
      },
    );
    for (let i = 0; i < 10; i++) {
      await clock.tick(5);
    }
    expect(writeBarrierResolved).toBe(false);
    writeManager.compileCacheWrites.delete(writeGate.promise);
    writeGate.resolve();
    await writeBarrier;
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(false);

    // The COMPILATION half (review finding on the first revision):
    // `compile-and-run` launches `compileOrGetPattern` as a FLOATING
    // promise, so during the TypeScript compile NOTHING else holds the
    // scheduler — `inProgressCompilations` (registered synchronously at
    // compileOrGetPattern, resolved only after persistence) is the only
    // visibility that phase has, and the barrier must consult it.
    const compileManager = runtime.patternManager.accessForTestingOnly;
    const compileGate = Promise.withResolvers<unknown>();
    compileManager.inProgressCompilations.set(
      "ow45-synthetic-compile",
      { promise: compileGate.promise as Promise<never>, spaces: new Set() },
    );
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(true);
    let compileBarrierResolved = false;
    const compileBarrier = runtime.scheduler.idleWithPendingCommits().then(
      () => {
        compileBarrierResolved = true;
      },
    );
    for (let i = 0; i < 10; i++) {
      await clock.tick(5);
    }
    expect(compileBarrierResolved).toBe(false);
    compileManager.inProgressCompilations.delete("ow45-synthetic-compile");
    compileGate.resolve(undefined);
    await compileBarrier;
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(false);
  });

  it("a REJECTING registry promise still settles the barrier — failures are the caller's to surface, never the barrier's to hang on", async () => {
    // The settle uses Promise.allSettled on purpose: a failed compile /
    // load / write-back rejects its registry promise, and the barrier
    // must treat that as SETTLED (the original caller surfaces the
    // failure). A regression to Promise.all would reject the settle
    // chain — the recheck continuation never runs, the barrier hangs,
    // and the rejection surfaces uncaught. Pinned bounded: the barrier
    // races a generous logical-time deadline and must win.
    //
    // The synthetic entry carries the REAL registries' cleanup
    // contract — retire-on-settle in a `finally` (pattern-manager
    // registers every chain that way): a settled promise never stays
    // registered beyond its cleanup microtask, which is also what
    // keeps the barrier's recheck fixpoint from spinning on a
    // settled-but-registered entry.
    const manager = runtime.patternManager.accessForTestingOnly;
    const failing = Promise.withResolvers<unknown>();
    const tracked = failing.promise.finally(() => {
      manager.inProgressCompilations.delete("ow45-rejecting-compile");
    });
    manager.inProgressCompilations.set(
      "ow45-rejecting-compile",
      { promise: tracked as Promise<never>, spaces: new Set() },
    );
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(true);
    let resolved = false;
    const barrier = runtime.scheduler.idleWithPendingCommits().then(() => {
      resolved = true;
    });
    // Reject AFTER the barrier's first evaluation attached its settle
    // handler (the synchronous branch ran at creation, so the rejection
    // is handled — no unhandled-rejection noise under allSettled).
    failing.reject(new Error("ow45 synthetic compile failure"));
    let deadline = false;
    await Promise.race([
      barrier,
      (async () => {
        for (let i = 0; i < 40 && !resolved; i++) {
          await clock.tick(25);
        }
        deadline = !resolved;
      })(),
    ]);
    expect(resolved).toBe(true);
    expect(deadline).toBe(false);
    expect(runtime.patternManager.hasPendingPatternWork()).toBe(false);
  });
});
