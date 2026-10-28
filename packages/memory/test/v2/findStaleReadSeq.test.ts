import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  applyCommit,
  close,
  type Engine,
  findStaleReadSeq,
  open,
} from "../../v2/engine.ts";
import { ExecutionLeaseCycle } from "../../v2/execution-lease.ts";
import {
  type Operation,
  type PatchOp,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../../v2.ts";

describe("findStaleReadSeq()", () => {
  // Every case reads `count` of one document at one address, so what the
  // answers turn on is who wrote the document after the read, and where.

  const space = "did:key:z6MkfindStaleReadSeqTestSpace";
  const id = "of:stale-read-target";
  const holder = "service:holder-under-test";
  let engine: Engine;
  let path: string;
  let localSeq = 0;
  let count = 0;

  const commit = (
    operations: Operation[],
    options: { derivedBy?: string } = {},
  ): number =>
    applyCommit(engine, {
      sessionId: options.derivedBy ?? "session:client",
      space,
      ...(options.derivedBy === undefined ? {} : {
        commitClass: "derived" as const,
        holder: options.derivedBy,
      }),
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    }).seq;

  const set = (options: { derivedBy?: string } = {}): number =>
    commit(
      [{ op: "set", id, value: { value: { count: ++count, other: 0 } } }],
      options,
    );

  const patch = (
    patches: PatchOp[],
    options: { derivedBy?: string } = {},
  ): number => commit([{ op: "patch", id, patches }], options);

  const staleSince = (
    afterSeq: number,
    options: {
      holder?: string;
      path?: readonly string[];
      nonRecursive?: boolean;
      commutes?: (patch: PatchOp) => boolean;
    } = {},
  ): number | null => {
    const { path: readPath = ["value", "count"], ...rest } = options;
    return findStaleReadSeq(engine, {
      id,
      scopeKey: "space",
      afterSeq,
      path: readPath,
      ...rest,
    });
  };

  beforeEach(async () => {
    // A derived-class commit is unclaimable off the flag, and admitted only
    // for the space's live lease holder (protocol.md §1, serving-loop.md §2).
    setServerExecutionConfig(true);
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    count = 0;
    const lease = new ExecutionLeaseCycle({ engine, space, holder });
    if (!lease.acquire()) throw new Error("test lease acquire failed");
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    close(engine);
    await Deno.remove(path);
  });

  it("returns `null` for a document nothing wrote after the seq", () => {
    const seq = set();
    expect(staleSince(seq, { holder })).toBeNull();
  });

  it("returns the seq of an authored `set` after the read's seq", () => {
    const seq = set();
    const written = set();
    expect(staleSince(seq, { holder })).toBe(written);
  });

  it("returns the newest of several conflicting writes", () => {
    const seq = set();
    set();
    const newest = set();
    expect(staleSince(seq, { holder })).toBe(newest);
  });

  it("returns `null` for the holder's own derived write", () => {
    const seq = set();
    set({ derivedBy: holder });
    expect(staleSince(seq, { holder })).toBeNull();
  });

  it("returns the seq of the holder's derived write when no holder is named", () => {
    const seq = set();
    const written = set({ derivedBy: holder });
    expect(staleSince(seq, {})).toBe(written);
  });

  it("returns `null` for a patch to a path disjoint from the read", () => {
    const seq = set();
    patch([{ op: "replace", path: "/value/other", value: 1 }]);
    expect(staleSince(seq, { holder })).toBeNull();
  });

  it("returns the seq of a patch to the read's path", () => {
    const seq = set();
    const written = patch([{ op: "replace", path: "/value/count", value: 9 }]);
    expect(staleSince(seq, { holder })).toBe(written);
  });

  it("returns the seq of a patch to an ancestor of the read's path", () => {
    const seq = set();
    const written = patch([
      { op: "replace", path: "/value", value: { count: 9, other: 0 } },
    ]);
    expect(staleSince(seq, { holder })).toBe(written);
  });

  it("returns `null` for a patch `commutes` excepts, and its seq for one it does not", () => {
    const seq = set();
    const written = patch([{ op: "replace", path: "/value/count", value: 9 }]);
    expect(
      staleSince(seq, {
        holder,
        commutes: (candidate) => candidate.op === "replace",
      }),
    ).toBeNull();
    expect(staleSince(seq, { holder, commutes: () => false })).toBe(written);
  });

  it("returns `null` for a shallow read over a deep write below it, and the seq of a key added beside it", () => {
    const seq = set();
    patch([{ op: "replace", path: "/value/count", value: 9 }]);
    expect(
      staleSince(seq, { holder, path: ["value"], nonRecursive: true }),
    ).toBeNull();
    const added = patch([{ op: "add", path: "/value/extra", value: 1 }]);
    expect(
      staleSince(seq, { holder, path: ["value"], nonRecursive: true }),
    ).toBe(added);
  });
});
