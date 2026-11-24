import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { StorageNotification } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-change");
const space = signer.did();

describe("CFC: a commit reports a label-map rewrite as one change", () => {
  // A commit's changes are processed one by one, each walking the trigger
  // index, and a labeled list's label map holds an entry per element whose
  // index shifts when the list grows at the front. The commit must report the
  // envelope once, however many entries moved (Topics top/1241).

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const listSchema = { type: "array", items: { asCell: ["cell"] } } as const;
  // Each element handle declares its own atom, so the link written from it
  // carries that atom and its slot gets a label-map entry of its own.
  const elementSchema = (atom: string) => ({
    type: "object",
    ifc: { confidentiality: [atom] },
  } as const);

  /** Writes the list as the elements `indices` name, and returns the paths
   * of the changes its commit reported for the list's `cfc` member. */
  const writeList = async (
    rt: Runtime,
    indices: number[],
  ): Promise<{ listId: string; cfcChanges: string[][] }> => {
    const notifications: StorageNotification[] = [];
    const subscription = {
      next(notification: StorageNotification) {
        notifications.push(notification);
        return undefined;
      },
    };
    storageManager!.subscribe(subscription);
    const tx = rt.edit();
    const list = rt.getCell(space, "envelope-change-list", listSchema, tx);
    list.set(
      indices.map((i) =>
        rt.getCell(
          space,
          `envelope-change-el-${i}`,
          elementSchema(`el-${i}`),
          tx,
        )
      ),
    );
    const listId = list.getAsNormalizedFullLink().id;
    expect((await tx.commit().settled).ok).toBeDefined();
    storageManager!.unsubscribe(subscription);
    const cfcChanges = notifications
      .filter((notification) => notification.type === "commit")
      .flatMap((notification) =>
        "changes" in notification ? [...notification.changes] : []
      )
      .filter((change) =>
        change.address.id === listId && change.address.path[0] === "cfc"
      )
      .map((change) => [...change.address.path]);
    return { listId, cfcChanges };
  };

  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from }, (_, i) => from + i);

  it("reports an append and a prepend each as one change at the envelope", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The list declares no ceiling; at this rung the tainted write lands.
      cfcEnforcementMode: "observe",
      // Persisting flow labels is what puts per-slot entries in the document.
      cfcFlowLabels: "persist",
    });

    await writeList(runtime, range(1, 13));

    // Appending element 13 adds its entry; prepending element 0 moves every
    // entry. Either way the label map changed, and the commit says so once.
    const appended = await writeList(runtime, range(1, 14));
    expect(appended.cfcChanges).toEqual([["cfc"]]);
    const prepended = await writeList(runtime, range(0, 14));
    expect(prepended.cfcChanges).toEqual([["cfc"]]);
  });
});
