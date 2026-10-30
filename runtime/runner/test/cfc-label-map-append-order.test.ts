import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { equal } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-map-append");
const space = signer.did();

describe("CFC: the stored label map keeps an element's entries in place", () => {
  // A commit tells its readers what changed by comparing the document's old
  // and new values position by position (`storage/differential.ts`). The
  // label map is an array, so an entry that moves to another index is
  // reported as a change at both. Appending to a list must therefore leave
  // the entries of the elements already there at their indices; otherwise one
  // appended element re-reports the label map of the whole list, and the
  // commit's notification grows with the list instead of with the append
  // (a sent inbox message took seconds to draw this way, Topics top/1241).

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const storedEntries = (id: string): unknown[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: unknown[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const listSchema = { type: "array", items: { asCell: ["cell"] } } as const;
  // Each element handle declares its own atom, so the link written from it
  // carries that atom and its slot gets an entry of its own (CFC §8.2).
  const elementSchema = (atom: string) => ({
    type: "object",
    ifc: { confidentiality: [atom] },
  } as const);

  const writeList = async (rt: Runtime, count: number): Promise<string> => {
    const tx = rt.edit();
    const elements = [];
    for (let i = 0; i < count; i++) {
      elements.push(
        rt.getCell(space, `append-el-${i}`, elementSchema(`el-${i}`), tx),
      );
    }
    const list = rt.getCell(space, "append-list", listSchema, tx);
    list.set(elements);
    expect((await tx.commit().settled).ok).toBeDefined();
    return list.getAsNormalizedFullLink().id;
  };

  it("appending an element moves no existing entry", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The list declares no ceiling; at this rung the tainted write lands.
      cfcEnforcementMode: "observe",
      // Persisting flow labels is what puts per-slot entries in the document.
      cfcFlowLabels: "persist",
    });

    // Twelve elements, then a thirteenth: as a pointer string the new slot
    // `/12` falls between `/1` and `/2`, which is where an order by pointer
    // string would put its entries.
    const listId = await writeList(runtime, 12);
    const before = storedEntries(listId);
    await writeList(runtime, 13);
    const after = storedEntries(listId);

    // Precondition: the slots carry entries of their own, at least one each.
    expect(before.length).toBeGreaterThanOrEqual(12);
    expect(after.length).toBeGreaterThan(before.length);

    // The append writes the new slot and the list's length; every entry that
    // describes an element already there stays at its index. Entries the
    // whole list shares (its `length`) may change in place.
    const elementEntriesMoved: number[] = [];
    for (let i = 0; i < before.length; i++) {
      const path = (before[i] as { path?: string[] }).path ?? [];
      const describesElement = path.length > 0 && /^\d+$/.test(path[0]!);
      if (
        describesElement &&
        !equal(before[i], after[i])
      ) {
        elementEntriesMoved.push(i);
      }
    }
    expect(elementEntriesMoved).toEqual([]);
  });
});
