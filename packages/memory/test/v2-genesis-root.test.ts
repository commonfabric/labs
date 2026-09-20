import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import * as Engine from "../v2/engine.ts";
import { readGenesisRoot } from "../v2/genesis-root.ts";

const space = "did:key:root-test-space";
const root = {
  source: "system:loom/main.tsx",
  cause: "test-publication",
  argument: { title: "A Loom" },
};

describe("v2-genesis-root", () => {
  it("retains the root reservation atomically across a store restart", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    let engine = await Engine.open({ url: toFileUrl(path) });
    try {
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          genesisRoot: root,
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { ["did:key:manager"]: "OWNER" } },
          }],
        },
      });
      expect(readGenesisRoot(engine)).toEqual(root);
      Engine.close(engine);
      engine = await Engine.open({ url: toFileUrl(path) });
      expect(readGenesisRoot(engine)).toEqual(root);
    } finally {
      Engine.close(engine);
      await Deno.remove(path);
    }
  });
});
