import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isStream } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { isWithdrawnVerb } from "../src/withdrawn-verb.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { resolveLink } from "../src/link-resolution.ts";

const signer = await Identity.fromPassphrase("withdrawn-verb");
const space = signer.did();

const BUMP = [
  "const bump = handler<{ n: number }, { count: Writable<number> }>(",
  "  ({ n }, { count }) => { count.set((count.get() ?? 0) + n); },",
  ");",
];

/**
 * A producer that publishes `tick` beside `count`, or, with `tick` set to
 * `"kept"`, keeps the handler running without publishing it, or, with
 * `"gone"`, has no handler at all.
 */
function producer(tick: "published" | "kept" | "gone"): string {
  return [
    "import { Stream, Writable, handler, pattern } from 'commonfabric';",
    ...BUMP,
    "export default pattern<",
    "  Record<string, never>,",
    tick === "published"
      ? "  { count: Writable<number>; tick?: Stream<{ n: number }> }"
      : "  { count: Writable<number> }",
    ">(() => {",
    "  const count = new Writable<number>(0).for('count');",
    ...(tick === "gone" ? [] : ["  const own = bump({ count });"]),
    tick === "published"
      ? "  return { count, tick: own };"
      : "  return { count };",
    "});",
    "",
  ].join("\n");
}

/** The same producer with `tick` required. */
const REQUIRED_PRODUCER = [
  "import { Stream, Writable, handler, pattern } from 'commonfabric';",
  ...BUMP,
  "export default pattern<",
  "  Record<string, never>,",
  "  { count: Writable<number>; tick: Stream<{ n: number }> }",
  ">(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, tick: bump({ count }) };",
  "});",
  "",
].join("\n");

/** A pattern taking an optional verb as its input. */
const CONSUMER = [
  "import { Stream, pattern } from 'commonfabric';",
  "export default pattern<{ tick?: Stream<{ n: number }> }, { label: string }>(",
  "  () => ({ label: 'consumer' }),",
  ");",
  "",
].join("\n");

/** A pattern publishing a builtin's verb, which listens at a key of the builtin's own document. */
const DIALOG = [
  "import { Writable, llmDialog, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>>(() => {",
  "  const messages = new Writable<any[]>([]).for('messages');",
  "  const dialog = llmDialog({ messages });",
  "  return { cancel: dialog.cancelGeneration };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

const EVENT = {
  type: "object",
  properties: { n: { type: "number" } },
} as const;

/** What a holder reads: one optional verb, or one required verb. */
const holderSchema = (key: string, required = false): JSONSchema => ({
  type: "object",
  properties: { [key]: { ...EVENT, asCell: ["stream"] } },
  ...(required && { required: [key] }),
});

describe("withdrawn-verb", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt.dispose();
    await storageManager?.close();
  });

  /** Runs `source` on the result cell `cause` names, re-seating it if it runs already. */
  const run = async (
    source: string,
    cause: string,
    argument: Record<string, unknown> = {},
  ): Promise<Cell<Record<string, unknown>>> => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(programOf(source), {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, pattern, argument, cell);
    await tx.commit().settled;
    await running.pull();
    await rt.idle();
    return cell;
  };

  /** A document holding `value`, as a holder pattern would store it. */
  const holderOf = async (
    cause: string,
    value: Record<string, unknown>,
  ): Promise<Cell<Record<string, unknown>>> => {
    const tx = rt.edit();
    const holder = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    holder.set(value);
    await tx.commit().settled;
    return holder;
  };

  /** The handle a read of `cell`'s `tick` mints, which resolves to the stream's document. */
  const streamHandleOf = (cell: Cell<Record<string, unknown>>) =>
    (cell.asSchema(holderSchema("tick")).get() as { tick?: unknown }).tick;

  const read = (holder: Cell<Record<string, unknown>>, key = "tick") =>
    holder.asSchema(holderSchema(key)).get() as Record<string, unknown>;

  const countOf = (cell: Cell<Record<string, unknown>>) =>
    (cell.asSchema({
      type: "object",
      properties: { count: { type: "number" } },
    }).get() as { count: number }).count;

  it("reads a verb a producer publishes as its handle, through a link to its field and to its stream", async () => {
    const producerCell = await run(producer("published"), "published");
    const byField = await holderOf("by-field", {
      tick: producerCell.key("tick"),
    });
    const byStream = await holderOf("by-stream", {
      tick: streamHandleOf(producerCell),
    });

    expect(isStream(read(byField).tick)).toBe(true);
    expect(isStream(read(byStream).tick)).toBe(true);
  });

  it("leaves out an optional verb a re-seated producer stops publishing, read through a link to its field", async () => {
    const producerCell = await run(producer("published"), "field-link");
    const holder = await holderOf("field-holder", {
      tick: producerCell.key("tick"),
    });

    await run(producer("gone"), "field-link");

    expect(Object.hasOwn(read(holder), "tick")).toBe(false);
  });

  it("leaves out an optional verb whose stream its owner no longer has, read through a link to the stream", async () => {
    const producerCell = await run(producer("published"), "stream-link");
    const holder = await holderOf("stream-holder", {
      tick: streamHandleOf(producerCell),
    });

    await run(producer("gone"), "stream-link");

    expect(Object.hasOwn(read(holder), "tick")).toBe(false);
  });

  it("leaves out a verb whose stream its owner's manifest names only at another scope", async () => {
    // A manifest entry vouches for one instance of a document: the same id
    // at another scope is another document, which the stream the holder
    // reaches is not.

    const producerCell = await run(producer("published"), "scoped");
    const stream = streamHandleOf(producerCell) as Cell<unknown>;
    const holder = await holderOf("scoped-holder", { tick: stream });
    const streamId = stream.getAsNormalizedFullLink().id;
    const tx = rt.edit();
    const manifest = producerCell.withTx(tx).getMetaRaw("internal") as {
      link: { "/": { "link@1": Record<string, unknown> } };
    }[];
    producerCell.withTx(tx).setMetaRaw(
      "internal",
      manifest.map((entry) =>
        entry.link["/"]["link@1"].id === streamId
          ? {
            ...entry,
            link: {
              "/": {
                "link@1": { ...entry.link["/"]["link@1"], scope: "user" },
              },
            },
          }
          : entry
      ) as never,
      rawMetaWriteAuthorization,
    );
    await tx.commit().settled;

    expect(Object.hasOwn(read(holder), "tick")).toBe(false);
  });

  it("keeps a working handle to a stream its owner still runs after it stops publishing it", async () => {
    const producerCell = await run(producer("published"), "kept");
    const holder = await holderOf("kept-holder", {
      tick: streamHandleOf(producerCell),
    });

    await run(producer("kept"), "kept");

    const tick = read(holder).tick as { send(event: unknown): void };
    expect(isStream(tick)).toBe(true);
    tick.send({ n: 5 });
    await rt.idle();
    // The handler's commit is still on its way to storage once the scheduler
    // is idle, and teardown closes storage.
    await storageManager.synced();
    expect(countOf(producerCell)).toBe(5);
  });

  it("keeps the handle of a required verb its producer stops publishing", async () => {
    const producerCell = await run(REQUIRED_PRODUCER, "required");
    const holder = await holderOf("required-holder", {
      tick: producerCell.key("tick"),
    });

    await run(producer("gone"), "required");

    const view = holder.asSchema(holderSchema("tick", true)).get() as {
      tick?: unknown;
    };
    expect(isStream(view.tick)).toBe(true);
  });

  it("runs a holder's reader again when the producer stops publishing the verb", async () => {
    const producerCell = await run(producer("published"), "reactive");
    const holder = await holderOf("reactive-holder", {
      tick: producerCell.key("tick"),
    });
    const seen: boolean[] = [];
    const cancel = holder.asSchema(holderSchema("tick")).sink((value) => {
      seen.push(Object.hasOwn(value as object, "tick"));
    });

    await run(producer("gone"), "reactive");
    cancel();

    expect(seen.at(0)).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });

  it("reads a verb its producer publishes again as its handle, through a link to its field and to its stream", async () => {
    const producerCell = await run(producer("published"), "readded");
    const byField = await holderOf("readded-field", {
      tick: producerCell.key("tick"),
    });
    const byStream = await holderOf("readded-stream", {
      tick: streamHandleOf(producerCell),
    });
    const seen: boolean[] = [];
    const cancel = byStream.asSchema(holderSchema("tick")).sink((value) => {
      seen.push(Object.hasOwn(value as object, "tick"));
    });

    await run(producer("gone"), "readded");
    expect(seen.at(-1)).toBe(false);
    await run(producer("published"), "readded");
    cancel();

    expect(seen.at(-1)).toBe(true);
    expect(isStream(read(byField).tick)).toBe(true);
    expect(isStream(read(byStream).tick)).toBe(true);
  });

  it("reads an unwired optional verb input as absent, and as a handle once it is wired", async () => {
    const consumerCell = await run(CONSUMER, "consumer");
    const argument = consumerCell.getArgumentCell<Record<string, unknown>>()!;
    expect(Object.hasOwn(read(argument), "tick")).toBe(false);

    const producerCell = await run(producer("published"), "wired");
    const tx = rt.edit();
    argument.withTx(tx).key("tick").set(producerCell.key("tick") as never);
    await tx.commit().settled;

    expect(isStream(read(argument).tick)).toBe(true);
  });

  it("keeps the handle of a builtin's verb, whose location stores nothing", async () => {
    // A builtin's handler listens at a key of the builtin's own document.
    // That document carries no `argument` meta, which is what keeps the
    // empty location from reading as a field a piece does not publish.

    const dialogCell = await run(DIALOG, "dialog");
    const cancel = read(dialogCell, "cancel").cancel as Cell<unknown>;
    const tx = rt.edit();
    const end = resolveLink(rt, tx, cancel.getAsNormalizedFullLink(), "value");
    const builtinDocument = rt.getCellFromLink(
      { ...end, path: [], schema: undefined },
      undefined,
      tx,
    );

    expect(isStream(cancel)).toBe(true);
    expect(end.path).toEqual(["cancelGeneration"]);
    expect(builtinDocument.getMetaRaw("argument")).toBeUndefined();
    await tx.commit().settled;
  });

  it("does not count a stream's own document as withdrawn while its owner names it", async () => {
    const producerCell = await run(producer("published"), "own");
    const stream = streamHandleOf(producerCell) as Cell<unknown>;
    const tx = rt.edit();

    expect(isWithdrawnVerb(rt, tx, stream.getAsNormalizedFullLink()))
      .toBe(false);
    await tx.commit().settled;
  });

  describe("over an empty document a holder links to", () => {
    // Each case writes the owner facts by hand, so what the judgement reads is
    // exactly what the case names.

    /**
     * Returns whether a holder's `tick` slot, linking to the root of the empty
     * document `cause` names, names a withdrawn verb, after `withMeta` writes
     * that document's and its owner's meta.
     */
    const withdrawnOver = async (
      cause: string,
      withMeta: (
        target: Cell<unknown>,
        owner: Cell<unknown>,
      ) => void = () => {},
    ): Promise<boolean> => {
      const write = rt.edit();
      const target = rt.getCell<unknown>(space, cause, undefined, write);
      const owner = rt.getCell<unknown>(
        space,
        `${cause} owner`,
        undefined,
        write,
      );
      withMeta(target, owner);
      const holder = rt.getCell<Record<string, unknown>>(
        space,
        `${cause} holder`,
        undefined,
        write,
      );
      holder.set({ tick: target.getAsLink() });
      await write.commit().settled;

      const tx = rt.edit();
      try {
        return isWithdrawnVerb(
          rt,
          tx,
          holder.key("tick").getAsNormalizedFullLink(),
        );
      } finally {
        await tx.commit().settled;
      }
    };

    /** Writes `owner` as `target`'s owner, with `manifest` as its manifest. */
    const ownedBy = (manifest?: unknown[]) =>
    (
      target: Cell<unknown>,
      owner: Cell<unknown>,
    ) => {
      target.setMetaRaw(
        "result",
        owner.getAsLink(),
        rawMetaWriteAuthorization,
      );
      if (manifest !== undefined) {
        owner.setMetaRaw(
          "internal",
          manifest as never,
          rawMetaWriteAuthorization,
        );
      }
    };

    it("returns `false` when no owner claims the document", async () => {
      // The document exists, holding no value and no `result` back-link.
      expect(
        await withdrawnOver(
          "unowned",
          (target) =>
            target.setMetaRaw("internal", [], rawMetaWriteAuthorization),
        ),
      ).toBe(false);
    });

    it("returns `false` when the owner keeps no manifest", async () => {
      expect(await withdrawnOver("no manifest", ownedBy())).toBe(false);
    });

    it("returns `true` when neither the owner's manifest nor its argument names the document", async () => {
      expect(await withdrawnOver("unnamed", ownedBy(["not an entry"])))
        .toBe(true);
    });

    it("returns `false` when the owner's manifest names the document", async () => {
      expect(
        await withdrawnOver(
          "named",
          (target, owner) =>
            ownedBy(["not an entry", { link: target.getAsLink() }])(
              target,
              owner,
            ),
        ),
      ).toBe(false);
    });
  });
});
