import { defer } from "@commonfabric/utils/defer";

import { sendEvent } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { parseLink } from "../src/link-utils.ts";
import { readResultSchemaMeta } from "../src/result-schema-meta.ts";
// The durable `schema` metadata a settled handler dispatch records on its
// receipt cell alongside the value (`handleJavaScriptHandlerResult`,
// `src/runner.ts`). It is descriptive — the root container kind, plus the
// property names when that kind is a record — so what these cases pin is that
// the declared kind is the one that was stored, that a value with no container
// kind of its own goes undeclared, and that reading a receipt back THROUGH its
// own declaration is lossless.
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type {
  Cell,
  IExtendedStorageTransaction,
  JSONSchema,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// The session a caller-supplied id is chosen within, for the sends whose
// subject is something else: the pair is what a stream send accepts, and one
// session is all a test needs whose ids never repeat across it — the replay
// case wants its two sends under the same session, which is what makes them
// one invocation.
const callerSession = "ses:receipt-schema";

/** Outcome of one dispatch, as its commit callback reported it. */
type Outcome = {
  status: string;
  precondition?: string;
  receiptLink?: NonNullable<
    IExtendedStorageTransaction["handlingReceiptLink"]
  >;
};

describe("receipt schema", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  /**
   * Instantiates a one-verb board whose handler returns `returns()`, and hands
   * back the verb's stream.
   */
  async function boardReturning(
    rootName: string,
    returns: () => unknown,
  ): Promise<Cell<unknown>> {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const verb = handler<unknown, Record<string, never>>(
      true,
      true,
      () => returns(),
    );
    const rootPattern = pattern(() => ({ verb: verb({}) }));
    const rootCell = runtime.getCell<{ verb: unknown }>(
      space,
      rootName,
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await root.pull();
    return root.key("verb") as Cell<unknown>;
  }

  /**
   * Dispatches `payload` at `stream` under `eventId` and resolves once the
   * handling's transaction has settled, waking on the commit callback `send`
   * already registers.
   */
  async function dispatch(
    stream: Cell<unknown>,
    payload: unknown,
    eventId: string,
  ): Promise<Outcome> {
    const settled = defer<Outcome>();
    sendEvent(stream, payload, (t: IExtendedStorageTransaction) => {
      const status = t.status();
      settled.resolve({
        status: status.status,
        precondition: (status as { error?: { precondition?: string } }).error
          ?.precondition,
        receiptLink: t.handlingReceiptLink,
      });
    }, { eventId, session: callerSession });
    const outcome = await settled.promise;
    await runtime.scheduler.idleWithPendingCommits();
    return outcome;
  }

  /** The receipt at the address `send` reported, loaded and ready to read. */
  async function receiptOf(outcome: Outcome): Promise<Cell<unknown>> {
    expect(outcome.status).toBe("done");
    const receipt = runtime.getCellFromLink<unknown>(outcome.receiptLink!);
    await receipt.pull();
    return receipt;
  }

  it("declares the root kind and property names of a record return", async () => {
    const stored = { topic: { fid: "fid-1" }, count: 3 };
    const stream = await boardReturning(
      "receipt schema record root",
      () => stored,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:record"),
    );

    const declared = readResultSchemaMeta(receipt) as JSONSchema;
    expect(declared).toEqual({
      type: "object",
      properties: { topic: true, count: true },
    });
    // Every property is admissible, so narrowing a read to the declaration
    // keeps levels below the names it lists rather than trimming to them.
    expect(receipt.asSchema(declared).get()).toEqual(stored);
  });

  it("declares an empty record for a value-less verb", async () => {
    const stream = await boardReturning(
      "receipt schema value-less root",
      () => undefined,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:value-less"),
    );

    // `{}` is what a value-less verb's receipt holds — the existence-only
    // witness — and a record carrying no properties is what describes it.
    expect(receipt.get()).toEqual({});
    expect(readResultSchemaMeta(receipt)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("declares an array root for an array return", async () => {
    const stream = await boardReturning(
      "receipt schema array root",
      () => ["a", "b"],
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:array"),
    );

    // The root kind is the half a selection needs before it can become a
    // fetch selector, since the same selection means different things over a
    // record and over an array.
    const declared = readResultSchemaMeta(receipt) as JSONSchema;
    expect(declared).toEqual({ type: "array" });
    expect(receipt.asSchema(declared).get()).toEqual(["a", "b"]);
  });

  it("declares the record a returned `data:` cell inlines to", async () => {
    // A `data:` cell carries its value in its own identifier, and the write
    // dissolves the link into that value, so the receipt holds a record and
    // is described as one. Left as a link it would go undeclared, and a
    // shaped read would have nothing to narrow against.
    const inline = runtime.getImmutableCell(space, { topic: "x", count: 3 });
    const stream = await boardReturning(
      "receipt schema data uri root",
      () => inline,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:data-uri"),
    );

    const declared = readResultSchemaMeta(receipt) as JSONSchema;
    expect(declared).toEqual({
      type: "object",
      properties: { topic: true, count: true },
    });
    expect(receipt.getRaw()).toEqual({ topic: "x", count: 3 });
    expect(receipt.asSchema(declared).get()).toEqual({ topic: "x", count: 3 });
  });

  it("declares an array root for a returned `data:` cell holding one", async () => {
    const inline = runtime.getImmutableCell(space, ["a", "b"]);
    const stream = await boardReturning(
      "receipt schema data uri array root",
      () => inline,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:data-uri-array"),
    );

    const declared = readResultSchemaMeta(receipt) as JSONSchema;
    expect(declared).toEqual({ type: "array" });
    expect(receipt.asSchema(declared).get()).toEqual(["a", "b"]);
  });

  it("names a property holding a reference without constraining it", async () => {
    const referenced = runtime.getCell<number>(
      space,
      "receipt schema referenced",
      undefined,
      tx,
    );
    referenced.set(7);
    const stream = await boardReturning(
      "receipt schema reference root",
      () => ({ note: referenced, tag: "x" }),
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:reference"),
    );

    // The declaration names both properties and says nothing about which of
    // them is a link: the spelling for that is `asCell`, and `["cell"]` would
    // assert a writable handle on a document nothing can be written through.
    // An unconstrained position reads through to the referenced value the
    // same way an undeclared one does.
    const declared = readResultSchemaMeta(receipt) as JSONSchema;
    expect(declared).toEqual({
      type: "object",
      properties: { note: true, tag: true },
    });
    expect(receipt.asSchema(declared).get()).toEqual({ note: 7, tag: "x" });
  });

  it("declares nothing for a scalar return", async () => {
    const stream = await boardReturning(
      "receipt schema scalar root",
      () => 42,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:scalar"),
    );

    // A scalar has no container kind, and no selection has anything to narrow
    // against it.
    expect(receipt.get()).toBe(42);
    expect(readResultSchemaMeta(receipt)).toBeUndefined();
  });

  it("declares nothing for an incidental cell return", async () => {
    // `set()` returns its cell for chaining, so an expression-body verb
    // returns a live Cell, which the receipt write converts to a link. The
    // root kind then belongs to the link's target rather than to the receipt,
    // and calling the stored envelope a record with a `/` property would make
    // a schema-narrowed read resolve the link and then fail the target's
    // value against `type: "object"`.
    const counter = runtime.getCell<number>(
      space,
      "receipt schema counter",
      undefined,
      tx,
    );
    counter.set(1);
    const stream = await boardReturning(
      "receipt schema cell return root",
      () => counter,
    );
    const receipt = await receiptOf(
      await dispatch(stream, {}, "evt:receipt-schema:cell"),
    );

    expect(readResultSchemaMeta(receipt)).toBeUndefined();
    expect(receipt.get()).toBe(1);

    // The stored link still addresses the returned cell.
    const written = parseLink(receipt.getRaw(), receipt);
    expect(written).toBeDefined();
    const writtenResolved = resolveLink(runtime, runtime.readTx(), written!);
    const target = resolveLink(
      runtime,
      runtime.readTx(),
      counter.getAsNormalizedFullLink(),
    );
    expect(writtenResolved.id).toBe(target.id);
    expect(writtenResolved.path).toEqual(target.path);
  });

  it("keeps the winner's schema when a same-id replay collides", async () => {
    let invocations = 0;
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    // The second delivery returns a DIFFERENT shape, so a loser whose metadata
    // write landed would show up in the schema as well as in the value.
    const verb = handler<unknown, Record<string, never>>(
      true,
      true,
      () => (++invocations === 1 ? { first: true } : { second: true, n: 2 }),
    );
    const rootPattern = pattern(() => ({ verb: verb({}) }));
    const rootCell = runtime.getCell<{ verb: unknown }>(
      space,
      "receipt schema replay root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await root.pull();
    const stream = root.key("verb") as Cell<unknown>;

    const eventId = "evt:receipt-schema:replay";
    const winner = await dispatch(stream, {}, eventId);
    const loser = await dispatch(stream, {}, eventId);

    // The body re-runs — exactly-once is per commit, not per execution — and
    // the create-only mark refuses the whole transaction, metadata included.
    expect(invocations).toBe(2);
    expect(loser.status).toBe("error");
    expect(loser.precondition).toBe("receipt-exists");
    expect(loser.receiptLink?.id).toBe(winner.receiptLink?.id);

    const receipt = await receiptOf(winner);
    expect(receipt.get()).toEqual({ first: true });
    expect(readResultSchemaMeta(receipt)).toEqual({
      type: "object",
      properties: { first: true },
    });
  });
});
