import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  readState,
  selectRetirableEffectsInstances,
} from "../v2/engine.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  type EffectIntentEntry,
  type Operation,
  resetServerExecutionConfig,
  resolvePrincipalSessionKey,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-engine-effects-doc-space";
const ALICE = "user:alice";
const ALICE_SESSION = "sess-alice";
const ALICE_KEY = resolvePrincipalSessionKey(ALICE, ALICE_SESSION);
const BOB = "user:bob";
const BOB_SESSION = "sess-bob";
const BOB_KEY = resolvePrincipalSessionKey(BOB, BOB_SESSION);

const intentOf = (nonce: string): EffectIntentEntry => ({
  nonce,
  kind: "navigate",
  args: { target: { id: "of:target", path: [] } },
  issuedIn: null,
});

describe("engine effects document", () => {
  let path: string;
  let engine: Engine;
  let holder: string;
  let localSeq: number;

  beforeEach(async () => {
    setServerExecutionConfig(true);
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    holder = executionLeaseHolder(`service:${SPACE}`);
    expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
    localSeq = 1;
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    close(engine);
    await Deno.remove(path);
  });

  /** A session's own authored write of its instance of the effects doc. */
  const authoredSet = (
    principal: string,
    sessionId: string,
    value: unknown,
  ) =>
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: localSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
          scope: "session",
          value: { value } as never,
        }],
      } as ClientCommit,
    });

  const derived = (
    operation: Operation,
    annotations: { op: number; scopeKey: string }[] = [],
  ) =>
    applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commitClass: "derived",
      holder,
      commit: {
        localSeq: localSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [operation],
      },
      ...(annotations.length === 0 ? {} : { annotations }),
      waveBasis: {
        basisSeq: (engine.statement("selectServerSeq").get() as { seq: number })
          .seq,
        rebasedHeads: [],
      },
    });

  const instanceValue = (scopeKey: string) =>
    readState(engine, { id: SERVER_EXECUTION_EFFECTS_DOC_ID, scopeKey })
      ?.document?.value as SessionEffectsDocValue | undefined;

  describe("selectRetirableEffectsInstances()", () => {
    it("returns an instance holding a mark that is not `true`, pruning the mark and retiring nothing", () => {
      authoredSet(ALICE, ALICE_SESSION, {
        entries: [intentOf("nav:kept")],
        acks: { "nav:kept": "yes" },
      });

      expect(selectRetirableEffectsInstances(engine)).toEqual([{
        scopeKey: ALICE_KEY,
        remainingEntries: [intentOf("nav:kept")],
        retiredNonces: [],
      }]);
    });

    it("returns no instance for a session whose value is not an object, while returning another session's acked one", () => {
      authoredSet(BOB, BOB_SESSION, "garbage");
      authoredSet(ALICE, ALICE_SESSION, {
        entries: [intentOf("nav:acked"), intentOf("nav:open")],
        acks: { "nav:acked": true },
      });

      expect(instanceValue(BOB_KEY)).toBe("garbage");
      expect(selectRetirableEffectsInstances(engine)).toEqual([{
        scopeKey: ALICE_KEY,
        remainingEntries: [intentOf("nav:open")],
        retiredNonces: ["nav:acked"],
      }]);
    });
  });

  describe("derived writes", () => {
    it("stamps an intent written by a patch that is not an append", () => {
      const applied = derived({
        op: "patch",
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
        scope: "session",
        patches: [{
          op: "add",
          path: "/value/entries",
          value: [intentOf("nav:replaced")] as never,
        }],
      }, [{ op: 0, scopeKey: ALICE_KEY }]);

      expect(instanceValue(ALICE_KEY)?.entries).toEqual([
        { ...intentOf("nav:replaced"), issuedIn: applied.seq },
      ]);
    });
  });
});
