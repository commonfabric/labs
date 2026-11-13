import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SpaceDeletedFunction } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceDeleted } from "../../src/builder/space-access.ts";
import type { Frame } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import {
  refusingServer,
  type SpaceRefusal,
} from "../support/refusing-server.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("space-deleted signer");
const home = signer.did() as MemorySpace;

/** Returns the DID of a space of its own, named by `name`. */
async function spaceNamed(name: string): Promise<MemorySpace> {
  return (await Identity.fromPassphrase(`space-deleted ${name}`))
    .did() as MemorySpace;
}

describe("spaceDeleted()", () => {
  let server: MemoryV2Server.Server;
  let refuse: (space: string, refusal: SpaceRefusal) => void;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const refusing = refusingServer(server);
    refuse = refusing.refuse;
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(
        refusing.server as MemoryV2Server.Server,
        { as: signer },
      ),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /**
   * Calls `spaceDeleted()` on `target` as code in a `kind` frame of the home
   * space would, and returns what it returns, along with the spaces the frame
   * recorded as waiting for an answer.
   */
  const callIn = (
    kind: "lift" | "handler",
    target: unknown,
  ): { answer: ReturnType<typeof spaceDeleted>; pending: MemorySpace[] } => {
    const frame: Frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: kind,
    });
    try {
      const answer = spaceDeleted(target);
      return { answer, pending: [...(frame.pendingSpaceAnswers ?? [])] };
    } finally {
      popFrame(frame);
    }
  };

  /**
   * Runs, in the home space, a pattern whose computation `answer` returns
   * what `spaceDeleted()` returns for the space `target` names, as a string,
   * and returns the result cell.
   */
  const computedAnswer = async (
    target: MemorySpace,
  ): Promise<Cell<{ answer?: string }>> => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inputSchema = {
      type: "object",
      properties: { target: { type: "string" } },
    } as const;
    const answer = lift(
      (input: { target?: string }) => String(spaceDeleted(input.target)),
      inputSchema,
      { type: "string" },
    );
    const answerPattern = pattern(
      ({ target }) => ({ answer: answer({ target }) }),
      inputSchema,
      { type: "object", properties: { answer: { type: "string" } } },
    );
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      answerPattern,
      { target },
      runtime.getCell(home, `space-deleted answer ${target}`, undefined, tx),
    );
    await tx.commit().settled;
    return result as Cell<{ answer?: string }>;
  };

  /**
   * Runs, in the home space, a pattern whose `ask` handler writes what
   * `spaceDeleted()` returns for the space an event names, as a string, and
   * returns what each run of the handler saw and what the runs committed. With
   * `async`, the handler is an async function that rejects instead of writing
   * when the call returns `undefined`.
   */
  const handlerAnswers = async (options: { async?: boolean } = {}) => {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const seen: (boolean | undefined)[] = [];
    const stateSchema = {
      type: "object",
      properties: { answers: { asCell: ["cell"] } },
      required: ["answers"],
    } as const;
    const ask = handler<{ space: string }, { answers: Cell<string[]> }>(
      {
        type: "object",
        properties: { space: { type: "string" } },
        required: ["space"],
      },
      stateSchema,
      options.async
        ? async ({ space }, { answers }) => {
          const answer = spaceDeleted(space as MemorySpace);
          seen.push(answer);
          if (answer === undefined) throw new Error("No answer for the space");
          answers.push(String(answer));
          await Promise.resolve();
        }
        : ({ space }, { answers }) => {
          const answer = spaceDeleted(space as MemorySpace);
          seen.push(answer);
          answers.push(String(answer));
        },
    );
    const Root = pattern<{ answers: Cell<string[]> }>(
      ({ answers }) => ({ answers, ask: ask({ answers }) }),
      stateSchema,
    );
    const tx = runtime.edit();
    const answers = runtime.getCell<string[]>(
      home,
      `space-deleted answers ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    answers.set([]);
    const result = runtime.run(
      tx,
      Root,
      { answers },
      runtime.getCell(
        home,
        `space-deleted root ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    return {
      seen,
      ask: async (space: MemorySpace) => {
        result.key("ask").send({ space });
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      /**
       * Like `ask`, sending the event as a one-shot, with `retries: false`,
       * and resolving once its final outcome is in.
       */
      askOnce: async (space: MemorySpace) => {
        const settled = Promise.withResolvers<void>();
        runtime.scheduler.queueEvent(
          result.key("ask").resolveAsCell().getAsNormalizedFullLink(),
          { space },
          false,
          () => settled.resolve(),
        );
        await settled.promise;
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      committed: async (): Promise<readonly string[]> => {
        await answers.pull();
        return answers.get();
      },
    };
  };

  describe("in a handler", () => {
    it("returns `true` for a space the memory server refuses as deleted, running the handler again once the server answers", async () => {
      const gone = await spaceNamed("handler gone");
      refuse(gone, "deleted");
      const root = await handlerAnswers();
      await root.ask(gone);

      expect(root.seen).toEqual([undefined, true]);
      expect(await root.committed()).toEqual(["true"]);
    });

    it("returns `false` for a space the memory server admits the runtime to", async () => {
      const kept = await spaceNamed("handler kept");
      const root = await handlerAnswers();
      await root.ask(kept);

      expect(root.seen).toEqual([undefined, false]);
      expect(await root.committed()).toEqual(["false"]);
    });

    it("returns `false` for a space the memory server refuses without the `deleted` marker", async () => {
      const refused = await spaceNamed("handler refused");
      refuse(refused, "unauthorized");
      const root = await handlerAnswers();
      await root.ask(refused);

      expect(root.seen).toEqual([undefined, false]);
      expect(await root.committed()).toEqual(["false"]);
    });

    it("runs an async handler that rejects on the `undefined` again once the server answers, rather than failing its event", async () => {
      const gone = await spaceNamed("handler async");
      refuse(gone, "deleted");
      const root = await handlerAnswers({ async: true });
      await root.ask(gone);

      expect(root.seen).toEqual([undefined, true]);
      expect(await root.committed()).toEqual(["true"]);
    });

    it("drops an unserved event sent with `retries: false` once the answer arrives, running it no second time", async () => {
      const gone = await spaceNamed("handler one-shot");
      refuse(gone, "deleted");
      const root = await handlerAnswers();
      await root.askOnce(gone);

      expect(root.seen).toEqual([undefined]);
      expect(await root.committed()).toEqual([]);
      expect(runtime.storageManager.spaceAnswered?.(gone)).toBe(true);
    });

    it("records a space the server has not answered for as waiting, and records nothing once it has", async () => {
      const gone = await spaceNamed("handler pending");
      refuse(gone, "deleted");
      expect(callIn("handler", gone)).toEqual({
        answer: undefined,
        pending: [gone],
      });

      await runtime.storageManager.awaitSpaceAnswer!(gone);
      expect(callIn("handler", gone)).toEqual({ answer: true, pending: [] });
    });
  });

  describe("in a reactive computation", () => {
    it("returns `undefined` until the memory server answers, then `true` for a deleted space", async () => {
      const gone = await spaceNamed("lift gone");
      refuse(gone, "deleted");
      expect(callIn("lift", gone)).toEqual({ answer: undefined, pending: [] });

      const answer = (await computedAnswer(gone)).key("answer");
      await waitForCellValue(runtime, answer, (v) => v === "true", {
        stuckLabel: "the deleted space's answer to arrive as `true`",
      });
    });

    it("returns `false` for a space the memory server admits the runtime to, and runs again with `true` once the space is deleted", async () => {
      const kept = await spaceNamed("lift kept");
      const answer = (await computedAnswer(kept)).key("answer");
      await waitForCellValue(runtime, answer, (v) => v === "false", {
        stuckLabel: "the admitted space's answer to arrive as `false`",
      });

      refuse(kept, "deleted");
      await waitForCellValue(runtime, answer, (v) => v === "true", {
        stuckLabel: "the answer to follow the deletion to `true`",
      });
    });

    it("leaves the computation's read scope as it is", () => {
      const tx = runtime.edit();
      const before = tx.getNarrowestReadScope();
      const frame = pushFrame({ runtime, tx, space: home, frameKind: "lift" });
      try {
        spaceDeleted(home);
      } finally {
        popFrame(frame);
      }
      expect(tx.getNarrowestReadScope()).toBe(before);
    });
  });

  describe("on a cell", () => {
    it("returns the answer for the space the cell's value lives in", async () => {
      const gone = await spaceNamed("cell gone");
      refuse(gone, "deleted");
      await runtime.storageManager.awaitSpaceAnswer!(gone);
      await runtime.storageManager.awaitSpaceAnswer!(home);

      const cell = runtime.getCell<unknown>(gone, "space-deleted cell");
      expect(callIn("lift", cell).answer).toBe(true);
      expect(callIn("lift", runtime.getCell<unknown>(home, "here")).answer)
        .toBe(false);
    });
  });

  it("returns `undefined`, recording nothing, where no memory server answers for the space", async () => {
    const supplied = await spaceNamed("store supplied");
    runtime.storageManager.installStoreReadThrough?.(supplied, () => undefined);
    expect(callIn("handler", supplied)).toEqual({
      answer: undefined,
      pending: [],
    });
    expect(callIn("lift", supplied).answer).toBeUndefined();
  });

  it("returns `undefined` for a target passed as `undefined`", () => {
    expect(callIn("handler", undefined)).toEqual({
      answer: undefined,
      pending: [],
    });
  });

  it("throws when called without a `target`", () => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: "lift",
    });
    try {
      // The declared type refuses this call; the runtime check is for callers
      // the compiler never saw.
      const declared: SpaceDeletedFunction = spaceDeleted;
      // @ts-expect-error: `target` is required.
      expect(() => declared()).toThrow("requires a `target`");
    } finally {
      popFrame(frame);
    }
  });

  it("throws in a computation whose frame holds no runtime", () => {
    const frame = pushFrame({
      runtime: undefined,
      tx: undefined,
      frameKind: "lift",
    });
    try {
      expect(() => spaceDeleted(undefined)).toThrow(
        "requires an executing runtime",
      );
    } finally {
      popFrame(frame);
    }
  });

  it("throws for a string target that is not a well-formed DID", () => {
    expect(() => callIn("lift", "not a did")).toThrow(
      "takes a cell or a space's DID",
    );
  });

  it("throws for a target that is neither a cell nor a string", () => {
    expect(() => callIn("lift", { space: home })).toThrow(
      "takes a cell as its target",
    );
  });

  it("throws in a pattern body", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceDeleted(undefined);
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });
});
