import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  applyCommit,
  close,
  type Engine,
  findHandlerStaleReadSeq,
  open,
} from "../../v2/engine.ts";
import { ExecutionLeaseCycle } from "../../v2/execution-lease.ts";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventEntry,
} from "../../v2.ts";

describe("findHandlerStaleReadSeq()", () => {
  // Every case reads one stream's sidecar, and a peer then appends an entry
  // to it, or the lease holder marks one consequenced. What the answers turn
  // on is whether the read named an entry the sidecar held when the read was
  // taken, and whether the later write is a tail append.

  const space = "did:key:z6MkfindHandlerStaleReadSeqTestSpace";
  const stream = { id: "of:poll", path: ["votes"] };
  const sidecar = streamEntriesDocId(stream);
  const holder = "service:holder-under-test";
  let engine: Engine;
  let path: string;
  let localSeq = 0;

  const entryOf = (eventId: string): StreamEventEntry => ({
    eventId,
    stream,
    payload: { vote: "green" },
  });

  /** Appends `eventId`'s entry to the sidecar from a client session. */
  const append = (eventId: string): number =>
    applyCommit(engine, {
      sessionId: "session:client",
      principal: "user:alice",
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecar,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [entryOf(eventId)] as never[],
          }],
        }],
        eventAppends: [{ id: sidecar, eventId }],
      },
    }).seq;

  /** Marks the entry at `index` consequenced, as the holder's wave does. */
  const mark = (index: number): number =>
    applyCommit(engine, {
      sessionId: holder,
      space,
      commitClass: "derived",
      holder,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecar,
          patches: [{
            op: "add",
            path: `/value/entries/${index}/consequenced`,
            value: true,
          }],
        }],
      },
    }).seq;

  const staleSinceRead = (
    afterSeq: number,
    readPath: readonly string[],
    exempting: string | undefined,
  ): number | null =>
    findHandlerStaleReadSeq(
      engine,
      { id: sidecar, scopeKey: "space", path: readPath, seq: afterSeq },
      exempting,
    );

  const staleSince = (afterSeq: number, index: number): number | null =>
    staleSinceRead(afterSeq, ["value", "entries", String(index)], holder);

  beforeEach(async () => {
    setServerExecutionConfig(true);
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    const lease = new ExecutionLeaseCycle({ engine, space, holder });
    if (!lease.acquire()) throw new Error("test lease acquire failed");
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    close(engine);
    await Deno.remove(path);
  });

  it("returns `null` for a tail append after a read of an entry the sidecar held", () => {
    const seq = append("e1");
    append("e2");
    expect(staleSince(seq, 0)).toBeNull();
  });

  it("returns the append's seq for a read of an index the sidecar did not hold at the read", () => {
    const seq = append("e1");
    const appended = append("e2");
    expect(staleSince(seq, 1)).toBe(appended);
  });

  it("returns the newest append's seq for a read of an index the first of two appends filled", () => {
    const seq = append("e1");
    append("e2");
    const newest = append("e3");
    expect(staleSince(seq, 1)).toBe(newest);
  });

  it("returns `null` for a read of a held entry however many appends follow it", () => {
    append("e1");
    const seq = append("e2");
    append("e3");
    append("e4");
    expect(staleSince(seq, 1)).toBeNull();
  });

  it("returns the seq of a write to a held entry that is not a tail append, when no holder exempts it", () => {
    const seq = append("e1");
    const marked = mark(0);
    expect(staleSinceRead(seq, ["value", "entries", "0"], undefined)).toBe(
      marked,
    );
  });

  it("returns `null` for the holder's own mark of a held entry", () => {
    const seq = append("e1");
    mark(0);
    expect(staleSince(seq, 0)).toBeNull();
  });

  it("returns the append's seq for a read of the whole entries array", () => {
    const seq = append("e1");
    const appended = append("e2");
    expect(staleSinceRead(seq, ["value", "entries"], holder)).toBe(appended);
  });
});
