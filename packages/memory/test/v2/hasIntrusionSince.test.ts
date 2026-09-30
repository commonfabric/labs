import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  applyCommit,
  close,
  type Engine,
  hasIntrusionSince,
  open,
} from "../../v2/engine.ts";
import { ExecutionLeaseCycle } from "../../v2/execution-lease.ts";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../../v2.ts";

describe("hasIntrusionSince()", () => {
  // Every case writes the same document at the same address, so what the
  // answers turn on is the class and holder of the commit that wrote it.

  const space = "did:key:z6MkhaveIntrusionSinceTestSpace";
  const id = "of:intrusion-target";
  const holder = "service:holder-under-test";
  let engine: Engine;
  let path: string;
  let localSeq = 0;
  let value = 0;

  const write = (
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
        operations: [{ op: "set", id, value: { value: ++value } }],
      },
    }).seq;

  const intrusionSince = (sinceSeq: number, options: { holder?: string }) =>
    hasIntrusionSince(engine, {
      id,
      scopeKey: "space",
      sinceSeq,
      ...options,
    });

  beforeEach(async () => {
    // A derived-class commit is unclaimable off the flag, and admitted only
    // for the space's live lease holder (protocol.md §1, serving-loop.md §2).
    setServerExecutionConfig(true);
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
    value = 0;
    const lease = new ExecutionLeaseCycle({ engine, space, holder });
    if (!lease.acquire()) throw new Error("test lease acquire failed");
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    close(engine);
    await Deno.remove(path);
  });

  it("returns `false` for a document nothing wrote after the seq", () => {
    const seq = write();
    expect(intrusionSince(seq, { holder })).toBe(false);
  });

  it("returns `true` for an authored write after the seq", () => {
    const seq = write();
    write();
    expect(intrusionSince(seq, { holder })).toBe(true);
  });

  it("returns `false` for the holder's own derived write after the seq", () => {
    const seq = write();
    write({ derivedBy: holder });
    expect(intrusionSince(seq, { holder })).toBe(false);
  });

  it("returns `true` for the holder's own derived write when no `holder` is given", () => {
    // The exemption fails CLOSED. A caller naming no holder has nothing to
    // recognize its own commits by, and a `holder = NULL` comparison would
    // exempt every derived write instead of none of them.

    const seq = write();
    write({ derivedBy: holder });
    expect(intrusionSince(seq, {})).toBe(true);
  });

  it("returns `true` for an authored write among the holder's own derived ones", () => {
    const seq = write();
    write({ derivedBy: holder });
    write();
    write({ derivedBy: holder });
    expect(intrusionSince(seq, { holder })).toBe(true);
  });
});
