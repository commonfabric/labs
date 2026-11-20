import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import { ACL_ID_PATTERN, readAclHeads } from "../v2/acl-heads.ts";

/** A synthetic document whose stored text is over the inline limit. */
const largeDocument = (n: number) => ({
  value: { label: `synthetic access document ${n} `.repeat(4) },
});

describe("readAclHeads", () => {
  let engine: Engine;

  beforeEach(async () => {
    engine = await open({ url: new URL("memory:acl-heads") });
  });

  afterEach(() => {
    close(engine);
  });

  const write = (localSeq: number, id: string, value: unknown): void => {
    applyCommit(engine, {
      sessionId: "session:acl-heads",
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value }],
      } as never,
    });
  };

  it("reads the heads `LIKE` matches, whatever the case of the prefix, and no other", () => {
    const ids = [
      "of:did:key:synthetic-lower",
      "OF:DID:key:synthetic-upper",
      "Of:dId:key:synthetic-mixed",
      "of:did;key:after-the-range",
      "of:dic:key:before-the-range",
      "of:didkey:no-separator",
      "of:synthetic-other",
    ];
    ids.forEach((id, index) => write(index + 1, id, largeDocument(index)));

    const expected = engine.database.prepare(
      `SELECT id FROM head
       WHERE branch = '' AND scope_key = 'space' AND id LIKE ?
       ORDER BY id`,
    ).all<{ id: string }>(ACL_ID_PATTERN).map((row) => row.id);
    expect(expected).toEqual([
      "OF:DID:key:synthetic-upper",
      "Of:dId:key:synthetic-mixed",
      "of:did:key:synthetic-lower",
    ]);

    const heads = readAclHeads(engine.database);
    expect(heads.map((head) => head.id)).toEqual(expected);
    for (const head of heads) {
      const index = ids.indexOf(head.id);
      expect(head.op).toBe("set");
      expect(head.data).toBe(encodeMemoryBoundary(largeDocument(index)));
    }
  });
});
