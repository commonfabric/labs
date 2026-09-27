import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  createBranch,
  type Engine,
  open,
} from "../v2/engine.ts";
import {
  type ClientCommit,
  type PatchOp,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-engine-exact-base";
const SESSION = "session:exact-base";
const PRINCIPAL = "did:key:z6Mk-engine-exact-base-principal";
const ID = "of:exact-base";

/** Builds a commit of one patch to `ID`, declaring `replayBaseSeq` when given. */
const patchCommit = (
  localSeq: number,
  replayBaseSeq: number | undefined,
  patches: PatchOp[] = [{ op: "replace", path: "/value/label", value: "x" }],
  id = ID,
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "patch",
    id,
    patches,
    ...(replayBaseSeq === undefined ? {} : { replayBaseSeq }),
  }],
});

describe("applyCommit()", () => {
  let engine: Engine;
  let path: string;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  /** Commits `commit` as the test's session, returning the applied result. */
  const commitAs = (commit: ClientCommit) =>
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: PRINCIPAL,
      commit,
    });

  /** Seeds `ID` with one `set` and returns the seq it landed at. */
  const seed = () =>
    commitAs({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: ID, value: { value: { label: "seed" } } }],
    }).seq;

  describe("exactBase", () => {
    it("is set on a patch declaring the seq of the head it is applied over", () => {
      const seeded = seed();

      const applied = commitAs(patchCommit(2, seeded));

      expect(applied.revisions.map((revision) => revision.exactBase)).toEqual([
        true,
      ]);
    });

    it("is set on a patch of an absent document declaring 0", () => {
      const applied = commitAs(
        patchCommit(1, 0, [{ op: "add", path: "/value", value: { a: 1 } }]),
      );

      expect(applied.revisions[0].exactBase).toBe(true);
    });

    it("is absent on a patch declaring any other seq", () => {
      const seeded = seed();

      const applied = commitAs(patchCommit(2, seeded - 1));

      expect(applied.revisions[0].exactBase).toBeUndefined();
    });

    it("is absent on a patch declaring the seq of a head its own commit wrote", () => {
      // The second patch lands on the head the first one wrote, at the
      // commit's own seq; a writer cannot hold that document, so declaring
      // the seq does not make the second patch exact.

      const seeded = seed();

      const applied = commitAs({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          ...patchCommit(2, seeded).operations,
          ...patchCommit(2, seeded + 1, [
            { op: "replace", path: "/value/label", value: "y" },
          ]).operations,
        ],
      });

      expect(applied.seq).toBe(seeded + 1);
      expect(applied.revisions.map((revision) => revision.exactBase)).toEqual([
        true,
        undefined,
      ]);
    });

    it("is absent on a patch declaring no base", () => {
      seed();

      const applied = commitAs(patchCommit(2, undefined));

      expect(applied.revisions[0].exactBase).toBeUndefined();
    });

    it("is absent on a patch to a branch that inherits the document", () => {
      // The branch holds no head row of its own for a document it inherits,
      // so a lookup there would read the document as absent.

      const seeded = seed();
      createBranch(engine, "feature");
      const add: PatchOp[] = [{ op: "add", path: "/value", value: { a: 1 } }];

      const overAbsent = commitAs({
        ...patchCommit(2, 0, add),
        branch: "feature",
      });
      const overSeeded = commitAs({
        ...patchCommit(3, seeded, add),
        branch: "feature",
      });

      expect(overAbsent.revisions[0].exactBase).toBeUndefined();
      expect(overSeeded.revisions[0].exactBase).toBeUndefined();
    });

    it("is absent on a replayed commit's revisions", () => {
      const seeded = seed();
      const commit = patchCommit(2, seeded);
      commitAs(commit);

      const replayed = commitAs(commit);

      expect(replayed.replayed).toBe(true);
      expect(replayed.revisions[0].exactBase).toBeUndefined();
    });

    describe("with server execution on", () => {
      beforeEach(() => {
        setServerExecutionConfig(true);
      });

      afterEach(() => {
        resetServerExecutionConfig();
      });

      it("is absent on an event append the engine stamps before storing it", () => {
        // The stored entry gains a `seq` and a `firedAt` its writer never
        // sent, so declaring the sidecar's true head is not enough.

        const stream = { id: "of:exact-base-stream", path: ["votes"] };
        const sidecar = streamEntriesDocId(stream);

        const applied = commitAs({
          ...patchCommit(1, 0, [{
            op: "append",
            path: "/value/entries",
            values: [{ eventId: "evt-1", stream, payload: { vote: "a" } }],
          }], sidecar),
          eventAppends: [{ id: sidecar, eventId: "evt-1" }],
        });

        expect(applied.revisions[0].exactBase).toBeUndefined();
      });

      it("is absent on a delegated patch", () => {
        const seeded = seed();

        const applied = applyCommit(engine, {
          sessionId: "server:outbox",
          space: SPACE,
          commit: patchCommit(1, seeded),
          delegated: {
            actingPrincipal: PRINCIPAL,
            capabilityRef: "cap:grant",
          },
        });

        expect(applied.revisions[0].exactBase).toBeUndefined();
      });
    });
  });
});
