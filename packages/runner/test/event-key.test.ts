import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { eventKey } from "../src/builder/event-key.ts";
import {
  getTopFrame,
  pattern,
  popFrame,
  pushFrame,
} from "../src/builder/pattern.ts";
import type { Cell } from "../src/builder/types.ts";
import { resolveLink } from "../src/link-resolution.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import { deriveEventKey } from "../src/scheduler/event-identity.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import {
  refuseFirstEventCommit,
  staleReadRefusal,
} from "./support/refuse-event-commit.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const alice = await Identity.fromPassphrase("event-key alice");
const bob = await Identity.fromPassphrase("event-key bob");
const service = await Identity.fromPassphrase("event-key service");
const space = alice.did() as MemorySpace;

/** Which of the probe piece's two streams an event went to. */
type StreamName = "first" | "second";

/** What one run of a probe handler saw. */
type ProbeRun = {
  /** The stream whose handler ran. */
  readonly stream: StreamName;

  /** What `eventKey()` returned. */
  readonly key: string;

  /** What a second `eventKey()` call in the same run returned. */
  readonly again: string;

  /** The event id the handler frame's cause names. */
  readonly causeEventId: string;
};

/**
 * A pattern whose handler, `computed()` and `lift()` each call `eventKey()`,
 * reporting what it returned or the message it threw.
 */
const PROBE_PATTERN = [
  "import {",
  "  computed, eventKey, handler, lift, pattern, Stream, Writable,",
  "} from 'commonfabric';",
  "const probe = (): string => {",
  "  try {",
  "    return `returned ${eventKey()}`;",
  "  } catch (error) {",
  "    return `threw ${(error as Error).message}`;",
  "  }",
  "};",
  "const record = handler<unknown, { seen: Writable<string> }>(",
  "  (_event, { seen }) => { seen.set(probe()); },",
  ");",
  "const viaLift = lift((_n: number) => probe());",
  "export default pattern<",
  "  { seen: Writable<string> },",
  "  {",
  "    seen: string;",
  "    viaComputed: string;",
  "    viaLift: string;",
  "    record: Stream<unknown>;",
  "  }",
  ">(({ seen }) => ({",
  "  seen,",
  "  viaComputed: computed(() => probe()),",
  "  viaLift: viaLift(0),",
  "  record: record({ seen }),",
  "}));",
].join("\n");

const HANDLER_ONLY_MESSAGE = "available only in a handler";

/** A payload naming, everywhere a key could plausibly be read, a forged one. */
const forgedPayload = {
  eventKey: "evk:forged",
  eventId: "evt:forged",
  $event: "evt:forged",
  actor: bob.did(),
  stream: "of:forged",
};

/**
 * Builds a piece with two handlers, one per stream, on `runtime`. Each run of
 * either handler is recorded in `runs` and adds one to a count of that
 * handler's own, so that the run has a write to commit and the two handlers'
 * bindings differ. Returns the link each stream's handler is
 * registered on, a way to queue an event to either, and the handler functions
 * as registered with the scheduler.
 */
function buildProbePiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
  runs: ProbeRun[],
): {
  firstCountDocumentId: string;
  streamLink(stream: StreamName): NormalizedFullLink;
  queue(stream: StreamName, payload: unknown, eventId?: string): void;
  registered: Map<string, EventHandler>;
} {
  const registered = new Map<string, EventHandler>();
  const addEventHandler = runtime.scheduler.addEventHandler.bind(
    runtime.scheduler,
  );
  runtime.scheduler.addEventHandler = (handler, ref, populate) => {
    registered.set(ref.id, handler);
    return addEventHandler(handler, ref, populate);
  };

  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler } = commonfabric;
  const probeFor = (stream: StreamName) =>
    handler<unknown, { count: Cell<number> }>(
      true,
      {
        type: "object",
        properties: { count: { type: "number", asCell: ["cell"] } },
      },
      (_event, { count }) => {
        const cause = getTopFrame()?.cause as { $event: string };
        runs.push({
          stream,
          key: eventKey(),
          again: eventKey(),
          causeEventId: cause.$event,
        });
        count.set((count.get() ?? 0) + 1);
      },
    );
  const first = probeFor("first");
  const second = probeFor("second");
  const rootPattern = commonfabric.pattern(() => {
    const firstCount = cell(0);
    const secondCount = cell(0);
    return {
      firstCount,
      first: first({ count: firstCount }),
      second: second({ count: secondCount }),
    };
  });
  const rootCell = runtime.getCell<
    { firstCount: number; first: unknown; second: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);
  runtime.scheduler.addEventHandler = addEventHandler;

  const resolved = (key: "firstCount" | StreamName) =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key(key).getAsNormalizedFullLink(),
    );

  return {
    firstCountDocumentId: resolved("firstCount").id,
    streamLink: (stream) => resolved(stream),
    queue: (stream, payload, eventId) => {
      runtime.scheduler.queueEvent(
        resolved(stream),
        payload,
        undefined,
        undefined,
        false,
        eventId === undefined ? {} : { eventId },
      );
    },
    registered,
  };
}

describe("eventKey()", () => {
  let runtimes: {
    runtime: Runtime;
    storage: ReturnType<typeof StorageManager.emulate>;
  }[];

  /**
   * Opens a runtime acting as `signer`, on storage of its own, which the test
   * disposes of afterward.
   */
  const openRuntime = (
    signer: Identity,
    options: { servingPosture?: boolean } = {},
  ): Runtime => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...(options.servingPosture ? { servingPosture: true } : {}),
      commitBackpressure: {
        baseDelayMs: 1,
        maxDelayMs: 4,
        jitter: 0,
        retryWindowMs: 60_000,
      },
    });
    runtimes.push({ runtime, storage });
    return runtime;
  };

  /**
   * Builds the probe piece at `label` on `runtime`, commits it, and returns it
   * with the list its runs are recorded in.
   */
  const standUp = async (runtime: Runtime, label: string) => {
    const runs: ProbeRun[] = [];
    const tx = runtime.edit();
    const piece = buildProbePiece(runtime, tx, label, runs);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    return { piece, runs };
  };

  beforeEach(() => {
    runtimes = [];
  });

  afterEach(async () => {
    for (const { runtime, storage } of runtimes) {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    }
  });

  describe("in a handler the scheduler dispatches", () => {
    it("returns the key derived from the dispatched event id, the actor and the stream, whatever the payload names", async () => {
      const runtime = openRuntime(alice);
      const { piece, runs } = await standUp(runtime, "event-key-derivation");

      piece.queue("first", forgedPayload, "evt:event-key:derivation");
      await runtime.idle();

      expect(runs.length).toBe(1);
      const [run] = runs;
      expect(run.causeEventId).toBe("evt:event-key:derivation");
      expect(run.key).toBe(
        deriveEventKey(
          "evt:event-key:derivation",
          alice.did(),
          piece.streamLink("first"),
        ),
      );
      expect(run.again).toBe(run.key);
    });

    it("returns different keys for two events on one stream", async () => {
      const runtime = openRuntime(alice);
      const { piece, runs } = await standUp(runtime, "event-key-two-events");

      piece.queue("first", {});
      piece.queue("first", {});
      await runtime.idle();

      expect(runs.map((run) => run.stream)).toEqual(["first", "first"]);
      expect(runs[0].causeEventId).not.toBe(runs[1].causeEventId);
      expect(runs[0].key).not.toBe(runs[1].key);
    });

    it("returns different keys for one event id sent to two streams", async () => {
      const runtime = openRuntime(alice);
      const { piece, runs } = await standUp(runtime, "event-key-two-streams");

      piece.queue("first", {}, "evt:event-key:shared");
      piece.queue("second", {}, "evt:event-key:shared");
      await runtime.idle();

      expect(runs.map((run) => run.stream)).toEqual(["first", "second"]);
      expect(runs[0].causeEventId).toBe(runs[1].causeEventId);
      expect(runs[0].key).not.toBe(runs[1].key);
    });

    it("returns the same key on every run of an event a conflict retries", async () => {
      const runtime = openRuntime(alice);
      const { piece, runs } = await standUp(runtime, "event-key-retry");
      const injector = refuseFirstEventCommit(
        runtime,
        staleReadRefusal(
          space,
          piece.firstCountDocumentId,
          () => Promise.resolve(),
        ),
      );
      try {
        piece.queue("first", {});
        await runtime.scheduler.idleWithPendingCommits();
      } finally {
        injector.restore();
      }

      expect(injector.refusals()).toBe(1);
      expect(runs.length).toBe(2);
      expect(runs[1].causeEventId).toBe(runs[0].causeEventId);
      expect(runs[1].key).toBe(runs[0].key);
    });
  });

  describe("across runtimes", () => {
    it("returns the same key on two runtimes for the same event, actor and stream", async () => {
      const one = openRuntime(alice);
      const onOne = await standUp(one, "event-key-two-runtimes");
      const two = openRuntime(alice);
      const onTwo = await standUp(two, "event-key-two-runtimes");
      expect(onTwo.piece.streamLink("first")).toEqual(
        onOne.piece.streamLink("first"),
      );

      onOne.piece.queue("first", {}, "evt:event-key:everywhere");
      onTwo.piece.queue("first", {}, "evt:event-key:everywhere");
      await one.idle();
      await two.idle();

      expect(onOne.runs.length).toBe(1);
      expect(onTwo.runs.length).toBe(1);
      expect(onTwo.runs[0].key).toBe(onOne.runs[0].key);
    });

    it("returns a different key when another actor sends the same event id to the same stream", async () => {
      const aliceRuntime = openRuntime(alice);
      const onAlice = await standUp(aliceRuntime, "event-key-replay");
      const bobRuntime = openRuntime(bob);
      const onBob = await standUp(bobRuntime, "event-key-replay");
      expect(onBob.piece.streamLink("first")).toEqual(
        onAlice.piece.streamLink("first"),
      );

      onAlice.piece.queue("first", {}, "evt:event-key:replayed");
      onBob.piece.queue("first", {}, "evt:event-key:replayed");
      await aliceRuntime.idle();
      await bobRuntime.idle();

      expect(onBob.runs[0].causeEventId).toBe(onAlice.runs[0].causeEventId);
      expect(onBob.runs[0].key).not.toBe(onAlice.runs[0].key);
      expect(onBob.runs[0].key).toBe(
        deriveEventKey(
          "evt:event-key:replayed",
          bob.did(),
          onBob.piece.streamLink("first"),
        ),
      );
    });

    it("binds a served run with no actor to no principal, not to the serving runtime's own", async () => {
      const serving = openRuntime(service, { servingPosture: true });
      const { piece, runs } = await standUp(serving, "event-key-no-actor");

      piece.queue("first", {}, "evt:event-key:no-actor");
      await serving.idle();

      const link = piece.streamLink("first");
      expect(runs.length).toBe(1);
      expect(runs[0].key).toBe(
        deriveEventKey("evt:event-key:no-actor", undefined, link),
      );
      expect(runs[0].key).not.toBe(
        deriveEventKey("evt:event-key:no-actor", service.did(), link),
      );
    });
  });

  describe("in a handler called directly", () => {
    it("derives the key from the fallback id the frame's cause names, fresh for each call", async () => {
      const runtime = openRuntime(alice);
      const { piece, runs } = await standUp(runtime, "event-key-direct");
      const link = piece.streamLink("first");
      const handler = piece.registered.get(link.id);
      expect(handler).toBeDefined();

      for (let i = 0; i < 2; i++) {
        const tx = runtime.edit();
        handler!(tx, {});
        expect((await tx.commit()).error).toBeUndefined();
      }

      expect(runs.length).toBe(2);
      for (const run of runs) {
        expect(run.causeEventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(run.key).toBe(
          deriveEventKey(run.causeEventId, alice.did(), link),
        );
        expect(run.again).toBe(run.key);
      }
      expect(runs[1].key).not.toBe(runs[0].key);
    });
  });

  describe("outside a handler", () => {
    /** Runs `fn` under a pushed frame carrying `props`, returning its result. */
    const inFrame = <T>(
      props: {
        kind: "handler" | "lift";
        eventKey?: string;
        runtime?: Runtime;
        tx?: IExtendedStorageTransaction;
      },
      fn: () => T,
    ): T => {
      const frame = pushFrame({
        ...(props.runtime !== undefined ? { runtime: props.runtime } : {}),
        ...(props.tx !== undefined ? { tx: props.tx } : {}),
        ...(props.kind === "handler"
          ? {
            inHandler: true,
            frameKind: "handler" as const,
            ...(props.eventKey !== undefined
              ? { eventKey: props.eventKey }
              : {}),
          }
          : { frameKind: "lift" as const }),
      });
      try {
        return fn();
      } finally {
        popFrame(frame);
      }
    };

    it("throws outside any frame", () => {
      expect(() => eventKey()).toThrow(HANDLER_ONLY_MESSAGE);
    });

    it("throws in a `lift()` frame", () => {
      expect(() => inFrame({ kind: "lift" }, eventKey)).toThrow(
        HANDLER_ONLY_MESSAGE,
      );
    });

    it("throws in a pattern body, even one built inside a handler", () => {
      // The handler frame beneath carries a key, and lends the pattern body
      // its runtime and transaction, so what the call has to refuse on is the
      // body's own frame not being a handler's.

      const runtime = openRuntime(alice);
      const tx = runtime.edit();
      const frame = { kind: "handler" as const, eventKey: "evk:beneath" };
      expect(inFrame({ ...frame, runtime, tx }, () => {
        expect(eventKey()).toBe("evk:beneath");
        let seen: unknown = "not called";
        expect(() =>
          pattern(() => {
            seen = eventKey();
            return {};
          })
        ).toThrow(HANDLER_ONLY_MESSAGE);
        return seen;
      })).toBe("not called");
      tx.abort(new Error("test-only"));
    });

    it("throws in a compiled `computed()` and `lift()`, and returns a key to the handler", async () => {
      const runtime = openRuntime(alice);
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PROBE_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ seen: string }>(
        space,
        "event-key-probe-argument",
        undefined,
      );
      const result = runtime.getCell<{
        seen: string;
        viaComputed: string;
        viaLift: string;
        record: unknown;
      }>(space, "event-key-probe-result", compiled.resultSchema);
      {
        const tx = runtime.edit();
        argument.withTx(tx).set({ seen: "no event yet" });
        expect((await tx.commit()).error).toBeUndefined();
      }
      {
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        expect((await tx.commit()).error).toBeUndefined();
      }
      const cancel = result.sink(() => {});
      try {
        await runtime.idle();
        const refusal = `threw \`eventKey()\` is ${HANDLER_ONLY_MESSAGE}`;
        expect(result.key("viaComputed").get()).toContain(refusal);
        expect(result.key("viaLift").get()).toContain(refusal);

        result.key("record").send(forgedPayload);
        await runtime.idle();
        expect(result.key("seen").get()).toMatch(/^returned evk:./);
      } finally {
        cancel();
      }
    });
  });
});
