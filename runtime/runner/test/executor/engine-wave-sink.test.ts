import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  AdmittedCommitNotice,
  ServedAclChange,
} from "@commonfabric/memory/v2/server";

import {
  commitForeignWaveBatch,
  EngineWaveCommitSink,
  foreignWaveCommitNotice,
} from "../../src/executor/engine-wave-sink.ts";
import type { WaveSpaceCommit } from "../../src/executor/wave.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const space = "did:key:z6MkEngineWaveSinkSpace" as MemorySpace;
const acting = "did:key:z6MkEngineWaveSinkActor" as const;
const holder = "did:key:z6MkEngineWaveSinkHolder";

/** A foreign batch that sets `id` to `value`, made as the space's owner. */
const foreignBatch = (id: string, value: number): WaveSpaceCommit => ({
  space,
  home: false,
  basisSeq: 0,
  rebasedHeads: [],
  operations: [{ op: "set", id, value: { value: { v: value } } }],
  preconditions: [],
  annotations: [],
  consequenceOf: [],
  basisInstances: [],
  holder: undefined,
  delegated: {
    actingPrincipal: acting,
    capabilityRef: "event-consequence:engine-wave-sink",
  },
});

/** An access-list change in the space, made as its owner. */
const aclChange: ServedAclChange = {
  space,
  actingPrincipal: acting,
  capabilityRef: "event-consequence:engine-wave-sink",
  sourceEvent: { space, sidecarId: "of:stream", eventId: "engine-wave-sink" },
  change: () => ({ [acting]: "OWNER" }),
};

describe("engine-wave-sink", () => {
  let engine: Engine.Engine;
  let engines = 0;

  beforeEach(async () => {
    engine = await Engine.open({
      url: new URL(`memory://engine-wave-sink-${++engines}`),
    });
    // The space's genesis access list, which a foreign batch lands behind.
    Engine.applyCommit(engine, {
      sessionId: "genesis-session",
      space,
      principal: space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [acting]: "OWNER" } },
        }],
      },
    });
  });

  afterEach(() => {
    Engine.close(engine);
  });

  describe("commitForeignWaveBatch()", () => {
    it("returns the engine's refusal of a batch numbered as a different one, and applies nothing", () => {
      const envelope = { sessionId: holder, localSeq: 1 };
      const first = commitForeignWaveBatch(
        engine,
        foreignBatch("of:first", 1),
        envelope,
      );
      const replayed = commitForeignWaveBatch(
        engine,
        foreignBatch("of:second", 2),
        envelope,
      );

      expect(first).toEqual({ ok: { seq: 2 } });
      expect(replayed.error?.name).toBe("WaveCommitRejected");
      expect(replayed.error?.message).toContain("commit replay mismatch");
      expect(Engine.serverSeq(engine)).toBe(2);
      expect(Engine.readState(engine, { id: "of:second" })).toBeNull();
    });
  });

  describe("foreignWaveCommitNotice()", () => {
    it("returns the warm authored notice of a commit the store holds, and `undefined` past it", () => {
      const batch = foreignBatch("of:target", 1);
      const result = commitForeignWaveBatch(engine, batch, {
        sessionId: holder,
        localSeq: 1,
      });
      const seq = result.ok!.seq;

      expect(foreignWaveCommitNotice(engine, batch, seq)).toMatchObject({
        space,
        seq,
        class: "authored",
        sessionId: holder,
        warm: true,
      });
      expect(foreignWaveCommitNotice(engine, batch, seq + 1)).toBeUndefined();
    });
  });

  describe("EngineWaveCommitSink", () => {
    describe("commitWave()", () => {
      it("reports a committed foreign batch's notice, and nothing for a refused one", async () => {
        const reported: AdmittedCommitNotice[] = [];
        const sink = new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
          reportCommit: (notice) => reported.push(notice),
        });

        const committed = await sink.commitWave(foreignBatch("of:target", 1));
        const refused = await sink.commitWave(
          foreignBatch(`of:${space}`, 2),
        );

        expect(refused.error?.name).toBe("AclDocumentWriteRefused");
        expect(reported).toHaveLength(1);
        expect(reported[0]).toMatchObject({
          space,
          seq: committed.ok!.seq,
          class: "authored",
          sessionId: holder,
          warm: true,
        });
      });
    });

    describe("commitSpaceAccessChange()", () => {
      it("refuses every change when constructed without an access-list hook", async () => {
        const sink = new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
        });

        const result = await sink.commitSpaceAccessChange(aclChange);

        expect(result.error?.name).toBe("AclDocumentWriteRefused");
        expect(result.error?.message).toContain("no access-list hook");
      });

      it("returns the failure of a hook that throws as a refused commit", async () => {
        const envelopes: { sessionId: string; localSeq: number }[] = [];
        const sink = new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
          commitServedAclChange: (_change, envelope) => {
            envelopes.push(envelope);
            return Promise.reject(new Error("the server went away"));
          },
        });

        const result = await sink.commitSpaceAccessChange(aclChange);

        expect(envelopes).toEqual([{ sessionId: holder, localSeq: 1 }]);
        expect(result.error?.name).toBe("WaveCommitRejected");
        expect(result.error?.message).toContain("the server went away");
      });
    });
  });
});
