/**
 * `parseDID` reaches pattern code through the `commonfabric` builder surface
 * (declared in `api/index.ts`, bound in `builder/factory.ts`). How it splits a
 * DID is tested with its implementation in `@commonfabric/identity`; these
 * tests pin that the pattern-facing binding is that implementation, and that a
 * compiled pattern can call it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { parseDID } from "@commonfabric/identity/did";

import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const alice = await Identity.fromPassphrase("parse-did alice");

/** A DID whose method-specific identifier holds colons of its own. */
const WEB = "did:web:example.com:8080";

/** A DID with no colon after its method. */
const BARE = "did:key";

/**
 * One value of each kind the parse sorts, a non-DID string and a non-string
 * last.
 */
const CANDIDATES = [WEB, BARE, "alice", 42];

/**
 * What a pattern reads back for each of {@link CANDIDATES}, in order, the
 * probe writing the `undefined` a non-DID parses to as `null`.
 */
const PARSES = [
  { did: WEB, method: "web", id: "example.com:8080" },
  { did: BARE, method: "key", id: "" },
  null,
  null,
];

/**
 * A pattern whose `computed()` and handler each parse every candidate they are
 * given, and whose body parses the first two.
 */
const PROBE_PATTERN = [
  "import {",
  "  computed, handler, parseDID, pattern, Stream, Writable,",
  "} from 'commonfabric';",
  "type Parse = { did: string; method: string; id: string } | null;",
  "const check = handler<",
  "  { candidates: (string | number)[] },",
  "  { seen: Writable<Parse[]> }",
  ">((event, { seen }) => {",
  "  seen.set(event.candidates.map((c) => parseDID(c) ?? null));",
  "});",
  "export default pattern<",
  "  {",
  "    candidates: (string | number)[];",
  "    web: string;",
  "    bare: string;",
  "    seen: Writable<Parse[]>;",
  "  },",
  "  {",
  "    seen: Parse[];",
  "    viaComputed: Parse[];",
  "    viaBody: Parse[];",
  "    check: Stream<unknown>;",
  "  }",
  ">(({ candidates, web, bare, seen }) => ({",
  "  seen,",
  "  viaComputed: computed(() => candidates.map((c) => parseDID(c) ?? null)),",
  "  viaBody: [parseDID(web) ?? null, parseDID(bare) ?? null],",
  "  check: check({ seen }),",
  "}));",
].join("\n");

describe("parseDID()", () => {
  it("is bound on the pattern surface to the `@commonfabric/identity` parse", () => {
    expect(createBuilder().commonfabric.parseDID).toBe(parseDID);
  });

  describe("in a compiled pattern", () => {
    let runtime: Runtime;
    let storage: ReturnType<typeof StorageManager.emulate>;

    beforeEach(() => {
      storage = StorageManager.emulate({ as: alice });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });

    afterEach(async () => {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    });

    it("returns the identity parse's parts in a `computed()`, in a handler and in a pattern body", async () => {
      const space = alice.did();
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PROBE_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{
        candidates: (string | number)[];
        web: string;
        bare: string;
        seen: unknown[];
      }>(space, "parse-did-probe-argument", undefined);
      const result = runtime.getCell<{
        seen: unknown[];
        viaComputed: unknown[];
        viaBody: unknown[];
        check: unknown;
      }>(space, "parse-did-probe-result", compiled.resultSchema);
      {
        const tx = runtime.edit();
        argument.withTx(tx).set({
          candidates: CANDIDATES,
          web: WEB,
          bare: BARE,
          seen: [],
        });
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      {
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      const cancel = result.sink(() => {});
      try {
        await runtime.idle();
        expect(result.key("viaComputed").get()).toEqual(PARSES);
        expect(result.key("viaBody").get()).toEqual(PARSES.slice(0, 2));

        result.key("check").send({ candidates: CANDIDATES });
        await runtime.idle();
        expect(result.key("seen").get()).toEqual(PARSES);
      } finally {
        cancel();
      }
    });
  });
});
