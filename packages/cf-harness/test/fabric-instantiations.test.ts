import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  createBuilder,
  type PatternInstantiation,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  createFabricInstantiationRecorder,
  type FabricInstantiationRecord,
  keylessInstantiation,
} from "../src/fabric-instantiations.ts";
import { comparableEntityHash } from "../src/fabric-observations.ts";

const signer = await Identity.fromPassphrase(
  "cf-harness fabric instantiations",
);

const PIECE_ENTITY =
  "of:fid1:Lu5lEvAZXeeCOI6SprXO9EG6gDFeZbLWP-MexaaM_qc" as const;
const RESULT_ENTITY =
  "of:fid1:UE15KVR134soSqpqNiVDvSO9n87JkezzA7JqAmIhtCo" as const;
const OTHER_ENTITY =
  "of:fid1:7GMOF6h3BimRJUhhUOh3D6oropwtvBc_F13FUorne7E" as const;

/** A kinded id, which the canonical entity-hash seam refuses. */
const COMPUTED_ENTITY =
  "computed:fid1:7GMOF6h3BimRJUhhUOh3D6oropwtvBc_F13FUorne7E" as const;

/** A source-compiled program, which carries a content-addressed identity. */
const COMPILED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "interface Input { n: number; }",
      "interface Output { doubled: number; }",
      "export default pattern<Input, Output>(({ n }) => ({",
      "  doubled: computed(() => n * 2),",
      "}));",
      "",
    ].join("\n"),
  }],
};

const instantiation = (
  identity: string,
  id: string,
): PatternInstantiation => ({
  identity,
  symbol: "default",
  cell: {
    id: id as PatternInstantiation["cell"]["id"],
    space: signer.did(),
    scope: "space",
    path: [],
  },
});

const record = (
  sequence: number,
  identity: string,
  entity: string,
): FabricInstantiationRecord => ({
  sequence,
  identity,
  symbol: "default",
  cell: comparableEntityHash(entity)!,
  link: instantiation(identity, entity).cell,
});

describe("fabric-instantiations", () => {
  describe("createFabricInstantiationRecorder()", () => {
    it("records the identity, symbol, entity and link of each instantiation it observes", () => {
      const recorder = createFabricInstantiationRecorder();
      recorder.observe(instantiation("keyless:abc", PIECE_ENTITY));

      expect(recorder.instantiations.since(0)).toEqual([{
        sequence: 1,
        identity: "keyless:abc",
        symbol: "default",
        cell: comparableEntityHash(PIECE_ENTITY)!,
        link: instantiation("keyless:abc", PIECE_ENTITY).cell,
      }]);
    });

    it("returns only the instantiations recorded after the given sequence", () => {
      const recorder = createFabricInstantiationRecorder();
      recorder.observe(instantiation("keyless:first", PIECE_ENTITY));
      const since = recorder.instantiations.sequence();
      recorder.observe(instantiation("keyless:second", RESULT_ENTITY));

      expect(recorder.instantiations.since(since).map((one) => one.identity))
        .toEqual(["keyless:second"]);
    });

    it("keeps keyless evidence past general-buffer eviction", () => {
      // One session-only root followed by enough durable roots to roll the
      // general buffer over: `since` forgets the keyless record, and
      // `keylessSince` is the read that must not.
      const recorder = createFabricInstantiationRecorder();
      recorder.observe(instantiation("keyless:evicted", PIECE_ENTITY));
      for (let i = 0; i < 200; i++) {
        recorder.observe(instantiation(`zDurable${i}`, RESULT_ENTITY));
      }

      expect(
        recorder.instantiations.since(0).some((one) =>
          one.identity === "keyless:evicted"
        ),
      ).toBe(false);
      expect(
        keylessInstantiation(recorder.instantiations.keylessSince(0))
          ?.identity,
      ).toBe("keyless:evicted");
    });

    it("records nothing for an instantiation whose entity does not reduce", () => {
      // A kinded id names a different entity from the `of:` id over the same
      // hash, so the canonical helper refuses it rather than aliasing.
      const recorder = createFabricInstantiationRecorder();
      recorder.observe(instantiation("keyless:abc", COMPUTED_ENTITY));

      expect(recorder.instantiations.since(0)).toEqual([]);
      expect(recorder.instantiations.sequence()).toBe(0);
    });
  });

  describe("keylessInstantiation()", () => {
    it("returns the keyless record however deep in the window it sits", () => {
      const found = keylessInstantiation([
        record(1, "zContentAddressed", PIECE_ENTITY),
        record(2, "keyless:abc", OTHER_ENTITY),
      ]);
      expect(found?.identity).toBe("keyless:abc");
    });

    it("returns the first keyless record when several were materialized", () => {
      const found = keylessInstantiation([
        record(1, "keyless:abc", PIECE_ENTITY),
        record(2, "keyless:def", RESULT_ENTITY),
      ]);
      expect(found?.identity).toBe("keyless:abc");
    });

    it("returns undefined when every root is content-addressed", () => {
      const found = keylessInstantiation([
        record(1, "zContentAddressed", PIECE_ENTITY),
        record(2, "zAlsoContentAddressed", RESULT_ENTITY),
      ]);
      expect(found).toBeUndefined();
    });

    it("returns undefined over an empty window", () => {
      expect(keylessInstantiation([])).toBeUndefined();
    });
  });

  describe("against a runtime that installs the recorder", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let recorder: ReturnType<typeof createFabricInstantiationRecorder>;

    beforeEach(async () => {
      recorder = createFabricInstantiationRecorder();
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        onPatternInstantiated: recorder.observe,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `fabric-instantiations-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("reports the piece a hand-built pattern created as keyless-stamped", async () => {
      // A pattern built from a builder value was never compiled into a stored
      // artifact, so the runner stamps its root with a session-synthetic
      // pointer — the shape a fresh runtime cannot load.
      const { commonfabric } = createBuilder();
      const handBuilt = commonfabric.pattern<{ value: number }>((
        { value },
      ) => ({ value }));
      await pieces.runPersistent(handBuilt, { value: 1 });
      await runtime.idle();

      const found = keylessInstantiation(recorder.instantiations.since(0));
      expect(found?.identity.startsWith("keyless:")).toBe(true);
    });

    it("reports nothing keyless for a piece created from a compiled program", async () => {
      await pieces.create(COMPILED_PROGRAM, { input: { n: 21 } });
      await runtime.idle();

      const records = recorder.instantiations.since(0);
      expect(records.length).toBeGreaterThan(0);
      expect(keylessInstantiation(records)).toBeUndefined();
    });
  });
});
