// W6: the sandbox `Date`/`Math` intrinsics are gated, so authored
// `new Date()` / `Date.now()` / `Math.random()` are the safe API — coarse in a
// handler, throw in a lift/pattern-body, and the deterministic `new Date(arg)`
// form passes straight through. Runs with the capability gate on.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

const ROOT = join(import.meta.dirname!, "..");

// A space of its own for each case. The emulated storage enforces no ACL, and
// nothing here asks the space to exist, so a fresh DID is enough.
async function gatedController(): Promise<PiecesController> {
  const identity = await Identity.generate({ implementation: "noble" });
  const spaceDid = (await Identity.generate({ implementation: "noble" })).did();
  const session = createSession({ identity, spaceDid });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost:8000/"),
    storageManager: StorageManager.emulate({ as: session.as }),
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  });
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  return pieces;
}

async function instantiate(cc: PiecesController, rel: string) {
  const program = await resolveLocalProgram(
    (resolver) => cc.runtime.harness.resolve(resolver),
    { main: join(ROOT, rel), root: ROOT },
  );
  return await cc.create(program, { start: true });
}

describe("W6: gated Date/Math intrinsics", () => {
  it("raw new Date() in a lift throws a TimeCapabilityError", async () => {
    const cc = await gatedController();
    const errors: string[] = [];
    cc.runtime.scheduler.onError((e) => {
      if (e?.name === "TimeCapabilityError") errors.push(e.message);
    });
    let cancel: (() => void) | undefined;
    try {
      const piece = await instantiate(
        cc,
        "integration/fixtures/lift-raw-date-violation.tsx",
      );
      const rc = cc.getResult(piece.getCell());
      cancel = rc.sink(() => {});
      await cc.runtime.idle();
    } catch (e) {
      if ((e as Error)?.name === "TimeCapabilityError") {
        errors.push((e as Error).message);
      } else throw e;
    } finally {
      cancel?.();
      await cc.dispose();
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("ambient clock");
  });

  it("new Date(arg) in a lift passes through (deterministic)", async () => {
    const cc = await gatedController();
    const errors: string[] = [];
    cc.runtime.scheduler.onError((e) => {
      if (e?.name === "TimeCapabilityError") errors.push(e.message);
    });
    let cancel: (() => void) | undefined;
    let label: unknown;
    try {
      const piece = await instantiate(
        cc,
        "integration/fixtures/lift-date-with-arg-ok.tsx",
      );
      const rc = cc.getResult(piece.getCell());
      cancel = rc.sink(() => {});
      await cc.runtime.idle();
      label = rc.key("label").get();
    } finally {
      cancel?.();
      await cc.dispose();
    }
    expect(errors).toEqual([]);
    expect(label).toBe("2024-06-10T06:13:20.000Z");
  });

  it("raw new Date()/Math.random() in a handler work, coarsened to 1s", async () => {
    const cc = await gatedController();
    const errors: string[] = [];
    cc.runtime.scheduler.onError((e) => {
      if (e?.name === "TimeCapabilityError") errors.push(e.message);
    });
    let cancel: (() => void) | undefined;
    let stampedAt: unknown;
    let roll: unknown;
    try {
      const piece = await instantiate(
        cc,
        "integration/fixtures/handler-raw-clock-ok.tsx",
      );
      const rc = cc.getResult(piece.getCell());
      cancel = rc.sink(() => {});
      await cc.runtime.idle();
      (rc.key("stamp") as unknown as { send: (e: unknown) => void }).send({});
      await cc.runtime.idle();
      stampedAt = rc.key("stampedAt").get();
      roll = rc.key("roll").get();
    } finally {
      cancel?.();
      await cc.dispose();
    }
    expect(errors).toEqual([]);
    expect(typeof stampedAt).toBe("number");
    expect(stampedAt as number).toBeGreaterThan(0);
    expect((stampedAt as number) % 1000).toBe(0); // coarsened to one second
    expect(roll as number).toBeGreaterThanOrEqual(1);
    expect(roll as number).toBeLessThanOrEqual(6);
  });

  it("a handler's clock is carried forward to the event it emits", async () => {
    const cc = await gatedController();
    const errors: string[] = [];
    cc.runtime.scheduler.onError((e) => {
      if (e?.name === "TimeCapabilityError") errors.push(e.message);
    });
    let cancel: (() => void) | undefined;
    let stampFirst: unknown;
    let stampSecond: unknown;
    try {
      const piece = await instantiate(
        cc,
        "integration/fixtures/handler-event-time-carryforward.tsx",
      );
      const rc = cc.getResult(piece.getCell());
      cancel = rc.sink(() => {});
      await cc.runtime.idle();
      (rc.key("first") as unknown as { send: (e: unknown) => void }).send({});
      await cc.runtime.idle();
      stampFirst = rc.key("stampFirst").get();
      stampSecond = rc.key("stampSecond").get();
    } finally {
      cancel?.();
      await cc.dispose();
    }
    expect(errors).toEqual([]);
    // The second handler ran later, but read the SAME instant as the first,
    // because the emitting handler's frozen event time was carried forward onto
    // the event it sent — a causal chain shares one time, so it cannot tick.
    expect(typeof stampFirst).toBe("number");
    expect(stampFirst as number).toBeGreaterThan(0);
    expect(stampSecond).toBe(stampFirst);
  });
});
