import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type NormalizedFullLink,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { callVerb } from "../src/verb-call.ts";

const signer = await Identity.fromPassphrase("piece verb-call");

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
      expect((call as { message: string }).message).toContain(
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
      expect((call as { message: string }).message).toContain('"note"');
      expect(await total()).toBe(0);
    });

    it("returns the message of a handler that threw", async () => {
      const call = await callVerb(runtime, piece, "add", { amount: 0 });

      expect(call.status).toBe("failed");
      expect((call as { message: string }).message).toContain(
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
});
