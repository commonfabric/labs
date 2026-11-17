import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type NormalizedFullLink,
  Runtime,
  type sendEvent,
} from "@commonfabric/runner";
import { withheldStatusTxViewForTestingOnly } from "@commonfabric/runner/for-testing-only";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  callVerb,
  pieceVerbs,
  sendVerbEvent,
  type VerbCall,
} from "../src/verb-call.ts";

const signer = await Identity.fromPassphrase("piece verb-call");

/** The message of a refused or failed call, and `undefined` for a settled
 * one. */
function messageOf(call: VerbCall): string | undefined {
  return call.status === "settled" ? undefined : call.message;
}

/** A counter whose `add` takes an amount and returns the new total, and
 * throws on an amount that is not positive. */
const COUNTER_SOURCE = [
  "import { action, Default, pattern, Stream, Writable } from 'commonfabric';",
  "interface AddEvent { amount: number; }",
  "interface AddResult { total: number; }",
  "interface Input { total?: Writable<number | Default<0>>; }",
  "interface Output { total: number; add: Stream<AddEvent, AddResult>; }",
  "export default pattern<Input, Output>(({ total }) => {",
  "  const add = action<AddEvent, AddResult>((event) => {",
  "    if (!(event.amount > 0)) throw new Error('add: amount must be positive');",
  "    total.set(total.get() + event.amount);",
  "    return { total: total.get() };",
  "  });",
  "  return { total, add };",
  "});",
  "",
].join("\n");

describe("verb-call", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let piece: NormalizedFullLink;
  let cell: Cell<{ total: number }>;

  /**
   * Starts a runtime under `experimental` and creates the counter piece in
   * it, leaving both for `afterEach()` to close.
   */
  const start = async (
    experimental?: { commitPreconditions?: boolean },
  ): Promise<void> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      ...(experimental === undefined ? {} : { experimental }),
    });
    const pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
    const created = await pieces.create(COUNTER_SOURCE, { input: {} });
    cell = created.getCell() as Cell<{ total: number }>;
    piece = cell.getAsNormalizedFullLink();
  };

  beforeEach(() => start());

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const total = async (): Promise<unknown> => await cell.key("total").pull();

  describe("callVerb()", () => {
    it("runs the handler and returns the result it wrote to its receipt", async () => {
      const call = await callVerb(runtime, piece, "add", { amount: 3 });

      expect(call).toMatchObject({ status: "settled", result: { total: 3 } });
      expect(await total()).toBe(3);
    });

    it("settles a retry naming the same invocation on the original outcome", async () => {
      // The second call collides on the handling's create-only receipt, so
      // nothing commits twice and the first call's result comes back.
      const invocation = { id: "add-once", session: "verb-call-test" };
      await callVerb(runtime, piece, "add", { amount: 3 }, { invocation });

      const retry = await callVerb(runtime, piece, "add", { amount: 3 }, {
        invocation,
      });

      expect(retry).toMatchObject({
        status: "settled",
        deduplicated: true,
        result: { total: 3 },
      });
      expect(await total()).toBe(3);
    });

    it("refuses a name that is not a verb and names the verbs there are", async () => {
      const call = await callVerb(runtime, piece, "total", 5);

      expect(call.status).toBe("refused");
      expect(messageOf(call)).toContain(
        '"total" is not a verb of this piece. Its verbs are "add"',
      );
      expect(await total()).toBe(0);
    });

    it("refuses an event carrying a field the verb does not declare, before sending it", async () => {
      // `amount` alone would add, so a total still 0 shows nothing was sent.
      const call = await callVerb(runtime, piece, "add", {
        amount: 3,
        note: "x",
      });

      expect(call.status).toBe("refused");
      expect(messageOf(call)).toContain('"note"');
      expect(await total()).toBe(0);
    });

    it("refuses a piece whose pattern cannot be read, sending nothing", async () => {
      const call = await callVerb(
        runtime,
        {
          ...piece,
          id: "of:baedreinopatternherexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
        "add",
        { amount: 3 },
      );

      expect(call.status).toBe("refused");
      expect(messageOf(call)).toContain(
        "could not read the piece's pattern:",
      );
      expect(await total()).toBe(0);
    });

    it("returns the reason an event could not be sent, running no handler", async () => {
      const call = await callVerb(runtime, piece, "add", { amount: 3 }, {
        sendEvent: () => {
          throw new Error("transport closed");
        },
      });

      expect(call.status).toBe("failed");
      expect(messageOf(call)).toContain(
        'the event for "add" could not be sent: ',
      );
      expect(messageOf(call)).toContain(
        "transport closed",
      );
      expect(await total()).toBe(0);
    });

    it("returns the message of a handler that threw", async () => {
      const call = await callVerb(runtime, piece, "add", { amount: 0 });

      expect(call.status).toBe("failed");
      expect(messageOf(call)).toContain(
        "add: amount must be positive",
      );
      expect(await total()).toBe(0);
    });

    it("settles with no receipt and no result when the runtime writes no receipt for the handling", async () => {
      // A handling's outcome is written to its receipt only under
      // `commitPreconditions`. Without it the handling still commits, and the
      // call settles on that commit alone: nothing names a receipt, so
      // nothing is read back as the result, and the write it made stands.
      await runtime.dispose();
      await storageManager.close();
      await start({ commitPreconditions: false });

      const call = await callVerb(runtime, piece, "add", { amount: 3 });

      expect(call).toMatchObject({ status: "settled" });
      expect(call).not.toHaveProperty("receipt");
      expect(call).not.toHaveProperty("result");
      expect(await total()).toBe(3);
    });
  });

  describe("pieceVerbs()", () => {
    it("returns the handlers the piece's result declares, and not its data", async () => {
      const verbs = await pieceVerbs(runtime, cell);

      expect(verbs.map(({ name, kind, on }) => ({ name, kind, on }))).toEqual([
        { name: "add", kind: "handler", on: "result" },
      ]);
    });
  });

  describe("sendVerbEvent()", () => {
    /**
     * A `sendEvent` that settles as a client under server execution does:
     * it reports the append delivered with the local echo's transaction,
     * which failed, and then settles the commit callback with the served
     * handling's outcome, which failed when `served` is `"failed"`, and is
     * the echo's own, as a runtime with no speculation overlay reports it,
     * when `served` is `"echo"`.
     */
    const servedAfterFailedEcho =
      (served: "handled" | "failed" | "echo" | "withheld"): typeof sendEvent =>
      (_stream, _event, onCommit, options) => {
        const echo = runtime.edit();
        echo.abort(new Error("the local echo found no handler"));
        const outcome = served === "echo" ? echo : runtime.edit();
        if (served === "failed") {
          outcome.abort(new Error("the served handling threw"));
        }
        void outcome.commit().settled.then(() => {
          options?.onAppended?.({ delivered: true }, echo);
          onCommit?.(
            served === "withheld"
              ? withheldStatusTxViewForTestingOnly(outcome)
              : outcome,
          );
        });
      };

    it("leaves a delivered append's outcome to the served handling when only the local echo failed", async () => {
      const sent = await sendVerbEvent(cell.key("add" as never), {
        amount: 1,
      }, { sendEvent: servedAfterFailedEcho("handled") });

      expect(sent.status).toBe("committed");
      if (sent.status !== "committed") return;
      expect(sent.deduplicated).toBe(false);
      expect(await sent.handled()).toEqual({ status: "handled" });
    });

    it("reports the served handling's failure after a delivered append", async () => {
      const sent = await sendVerbEvent(cell.key("add" as never), {
        amount: 1,
      }, { sendEvent: servedAfterFailedEcho("failed") });

      expect(sent.status).toBe("committed");
      if (sent.status !== "committed") return;
      expect((await sent.handled()).status).toBe("failed");
    });

    it("reports a served handling whose outcome is withheld as `withheld`", async () => {
      const sent = await sendVerbEvent(cell.key("add" as never), {
        amount: 1,
      }, { sendEvent: servedAfterFailedEcho("withheld") });

      expect(sent.status).toBe("committed");
      if (sent.status !== "committed") return;
      expect(await sent.handled()).toEqual({ status: "withheld" });
    });

    it("returns `withheld` from `callVerb()` for such a handling, and reads no receipt", async () => {
      const call = await callVerb(runtime, piece, "add", { amount: 1 }, {
        sendEvent: servedAfterFailedEcho("withheld"),
      });

      expect(call.status).toBe("withheld");
      expect(call).not.toHaveProperty("result");
      expect(call).not.toHaveProperty("receipt");
    });

    it("throws when the append is refused on an otherwise clean transaction", async () => {
      const refusing: typeof sendEvent = (_stream, _event, _onCommit, opts) =>
        opts?.onAppended?.(
          { delivered: false, refused: "quota" },
          runtime.edit(),
        );

      await expect(
        sendVerbEvent(cell.key("add" as never), { amount: 1 }, {
          sendEvent: refusing,
        }),
      ).rejects.toThrow("event append refused: quota");
    });

    it("returns the handling's failure when a refused append's transaction failed", async () => {
      const refusing: typeof sendEvent = (_stream, _event, _onCommit, opts) => {
        const tx = runtime.edit();
        tx.abort(new Error("the handler threw"));
        opts?.onAppended?.({ delivered: false, refused: "quota" }, tx);
      };

      const sent = await sendVerbEvent(cell.key("add" as never), {
        amount: 1,
      }, { sendEvent: refusing });

      expect(sent.status).toBe("failed");
    });

    it("throws what the send itself throws, and reports no commit", async () => {
      const phases: string[] = [];
      const throwing: typeof sendEvent = () => {
        throw new Error("no stream here");
      };

      await expect(
        sendVerbEvent(cell.key("add" as never), { amount: 1 }, {
          sendEvent: throwing,
          onPhase: (phase) => phases.push(phase),
        }),
      ).rejects.toThrow("no stream here");
      expect(phases).toEqual(["dispatched"]);
    });

    it("reports a failed echo as the handling's outcome when the commit callback settles with it", async () => {
      const sent = await sendVerbEvent(cell.key("add" as never), {
        amount: 1,
      }, { sendEvent: servedAfterFailedEcho("echo") });

      expect(sent.status).toBe("committed");
      if (sent.status !== "committed") return;
      expect((await sent.handled()).status).toBe("failed");
    });
  });
});
