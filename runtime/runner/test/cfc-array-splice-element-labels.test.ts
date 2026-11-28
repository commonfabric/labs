import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-splice-element-labels",
);
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

/** A derived value entry holding `secret` at `path`, as a seed stores it. */
const derivedEntry = (path: string[], secret: string) => ({
  path,
  label: { confidentiality: [secret] },
  origin: "derived",
  observes: "value",
});

describe("CFC per-element label entries of a rewritten array", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  /** The confidentiality of the value entries stored exactly at `path`. */
  const valueConfidentialityAt = (id: string, path: string[]): string[] =>
    entriesOf(id)
      .filter((entry) =>
        JSON.stringify(entry.path) === JSON.stringify(path) &&
        entry.observes !== "shape"
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /**
   * Stores `value` at a fresh document named `name` with `entries` as its
   * label map, and returns the document's id.
   */
  const seed = async (
    name: string,
    value: FabricValue,
    entries: ReturnType<typeof derivedEntry>[],
  ): Promise<string> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    const tx = runtime.edit();
    const id = runtime.getCell(space, name, undefined, tx)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit().settled).ok).toBeDefined();
    return id;
  };

  /**
   * Sets the document named `name` to `value`. A writer that `reads` first
   * reads the whole stored value, so its join holds every stored clause; one
   * that does not reads nothing of it.
   */
  const write = async (
    name: string,
    value: FabricValue,
    { reads }: { reads: boolean },
  ): Promise<void> => {
    const tx = runtime!.edit();
    const cell = runtime!.getCell(space, name, undefined, tx);
    if (reads) cell.get();
    cell.set(value);
    expect((await tx.commit().settled).ok).toBeDefined();
  };

  describe("removal at the start", () => {
    it("labels the element moved onto an equal value with the entries it had", async () => {
      const id = await seed("remove-first-read", ["x", "y", "y"], [
        derivedEntry(["1"], "alice-secret"),
        derivedEntry(["2"], "bob-secret"),
      ]);
      await write("remove-first-read", ["y", "y"], { reads: true });
      expect(valueConfidentialityAt(id, ["1"])).toContain("bob-secret");
    });

    it("moves each element's entries to its new index for a writer that read nothing", async () => {
      const id = await seed("remove-first-blind", ["x", "y", "y"], [
        derivedEntry(["0"], "carol-secret"),
        derivedEntry(["1"], "alice-secret"),
        derivedEntry(["2"], "bob-secret"),
      ]);
      await write("remove-first-blind", ["y", "y"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["1"])).toEqual(["bob-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toEqual([]);
    });
  });

  describe("removal in the middle", () => {
    it("moves the entries of the elements after the removed one", async () => {
      const id = await seed("remove-middle", ["a", "x", "y", "y"], [
        derivedEntry(["0"], "dave-secret"),
        derivedEntry(["2"], "alice-secret"),
        derivedEntry(["3"], "bob-secret"),
      ]);
      await write("remove-middle", ["a", "y", "y"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["dave-secret"]);
      expect(valueConfidentialityAt(id, ["1"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toEqual(["bob-secret"]);
    });
  });

  describe("insertion", () => {
    it("moves the entries of the elements after the inserted one", async () => {
      const id = await seed("insert-first", ["y", "y"], [
        derivedEntry(["0"], "alice-secret"),
        derivedEntry(["1"], "bob-secret"),
      ]);
      await write("insert-first", ["x", "y", "y"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual([]);
      expect(valueConfidentialityAt(id, ["1"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toEqual(["bob-secret"]);
    });
  });

  describe("reorder", () => {
    it("moves the entries of the element a shortest edit script keeps", async () => {
      const id = await seed("reorder", ["x", "y", "z"], [
        derivedEntry(["0"], "alice-secret"),
        derivedEntry(["1"], "bob-secret"),
        derivedEntry(["2"], "carol-secret"),
      ]);
      await write("reorder", ["y", "x", "z"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["bob-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toEqual(["carol-secret"]);
    });

    it("moves the entries of an element the script removes and adds again elsewhere", async () => {
      const id = await seed("reorder-first-to-last", ["x", "y", "z"], [
        derivedEntry(["0"], "alice-secret"),
        derivedEntry(["1"], "bob-secret"),
        derivedEntry(["2"], "carol-secret"),
      ]);
      await write("reorder-first-to-last", ["y", "z", "x"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["bob-secret"]);
      expect(valueConfidentialityAt(id, ["1"])).toEqual(["carol-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toEqual(["alice-secret"]);
    });

    it("leaves an equal element's entries at an index the diff did not write", async () => {
      const id = await seed("reorder-equal-tail", ["x", "y", "x"], [
        derivedEntry(["0"], "alice-secret"),
        derivedEntry(["1"], "bob-secret"),
        derivedEntry(["2"], "carol-secret"),
      ]);
      await write("reorder-equal-tail", ["y", "x", "x"], { reads: false });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["bob-secret"]);
      expect([
        ...valueConfidentialityAt(id, ["1"]),
        ...valueConfidentialityAt(id, ["2"]),
      ].sort()).toEqual(["alice-secret", "carol-secret"]);
      expect(valueConfidentialityAt(id, ["2"])).toHaveLength(1);
    });
  });

  describe("entries beneath an element", () => {
    it("moves an entry beneath a moved element with it", async () => {
      const id = await seed("nested", [["x"], ["y"], ["y"]], [
        derivedEntry(["1", "0"], "alice-secret"),
        derivedEntry(["2", "0"], "bob-secret"),
      ]);
      await write("nested", [["y"], ["y"]], { reads: false });
      expect(valueConfidentialityAt(id, ["0", "0"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["1", "0"])).toEqual(["bob-secret"]);
    });
  });

  describe("elements left in place", () => {
    it("keeps the entries of the common prefix and stamps nothing there", async () => {
      const id = await seed("remove-last", ["y", "y", "z"], [
        derivedEntry(["0"], "alice-secret"),
        derivedEntry(["1"], "bob-secret"),
      ]);
      await write("remove-last", ["y", "y"], { reads: true });
      expect(valueConfidentialityAt(id, ["0"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["1"])).toEqual(["bob-secret"]);
    });

    it("keeps the entries beneath an element edited in place where the diff wrote nothing", async () => {
      const id = await seed("edit-in-place", [["a", "s"], ["b", "t"], "z"], [
        derivedEntry(["0", "0"], "alice-secret"),
        derivedEntry(["0", "1"], "bob-secret"),
      ]);
      await write("edit-in-place", [["a", "u"], ["b", "t"]], { reads: false });
      expect(valueConfidentialityAt(id, ["0", "0"])).toEqual(["alice-secret"]);
      expect(valueConfidentialityAt(id, ["0", "1"])).toEqual([]);
    });
  });
});
