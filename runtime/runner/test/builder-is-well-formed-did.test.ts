/**
 * `isWellFormedDID` reaches pattern code through the `commonfabric` builder
 * surface (declared in `api/index.ts`, bound in `builder/factory.ts`). What it
 * decides is tested with its implementation in `@commonfabric/identity`; these
 * tests pin that the pattern-facing binding is that implementation, and that a
 * compiled pattern can call it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";

import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const alice = await Identity.fromPassphrase("is-well-formed-did alice");

/** A DID in DID Core syntax. */
const GOOD = "did:key:z6MkExample";

/** A string that starts with `did:` but has a space in it. */
const SPACED = "did:key:z6Mk Example";

/** One value of each kind the predicate sorts, a non-string last. */
const CANDIDATES = [GOOD, SPACED, 42];

/** What the predicate returns for each of {@link CANDIDATES}, in order. */
const VERDICTS = [true, false, false];

/**
 * A pattern whose `computed()` and handler each ask `isWellFormedDID()` of
 * every candidate they are given, and whose body asks it of the first two.
 */
const PROBE_PATTERN = [
  "import {",
  "  computed, handler, isWellFormedDID, pattern, Stream, Writable,",
  "} from 'commonfabric';",
  "const check = handler<",
  "  { candidates: (string | number)[] },",
  "  { seen: Writable<boolean[]> }",
  ">((event, { seen }) => {",
  "  seen.set(event.candidates.map((c) => isWellFormedDID(c)));",
  "});",
  "export default pattern<",
  "  {",
  "    candidates: (string | number)[];",
  "    good: string;",
  "    spaced: string;",
  "    seen: Writable<boolean[]>;",
  "  },",
  "  {",
  "    seen: boolean[];",
  "    viaComputed: boolean[];",
  "    viaBody: boolean[];",
  "    check: Stream<unknown>;",
  "  }",
  ">(({ candidates, good, spaced, seen }) => ({",
  "  seen,",
  "  viaComputed: computed(() => candidates.map((c) => isWellFormedDID(c))),",
  "  viaBody: [isWellFormedDID(good), isWellFormedDID(spaced)],",
  "  check: check({ seen }),",
  "}));",
].join("\n");

describe("isWellFormedDID()", () => {
  it("is bound on the pattern surface to the `@commonfabric/identity` predicate", () => {
    expect(createBuilder().commonfabric.isWellFormedDID).toBe(isWellFormedDID);
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

    it("returns the identity predicate's verdicts in a `computed()`, in a handler and in a pattern body", async () => {
      const space = alice.did();
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PROBE_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{
        candidates: (string | number)[];
        good: string;
        spaced: string;
        seen: boolean[];
      }>(space, "is-well-formed-did-probe-argument", undefined);
      const result = runtime.getCell<{
        seen: boolean[];
        viaComputed: boolean[];
        viaBody: boolean[];
        check: unknown;
      }>(space, "is-well-formed-did-probe-result", compiled.resultSchema);
      {
        const tx = runtime.edit();
        argument.withTx(tx).set({
          candidates: CANDIDATES,
          good: GOOD,
          spaced: SPACED,
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
        expect(result.key("viaComputed").get()).toEqual(VERDICTS);
        expect(result.key("viaBody").get()).toEqual(VERDICTS.slice(0, 2));

        result.key("check").send({ candidates: CANDIDATES });
        await runtime.idle();
        expect(result.key("seen").get()).toEqual(VERDICTS);
      } finally {
        cancel();
      }
    });
  });
});
