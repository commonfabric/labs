/**
 * Measures the commit of a write that grows a labeled list by one element, as
 * the list grows.
 *
 * Each element is a link whose handle declares its own atom, so its slot gets a
 * label-map entry of its own. The label map stores its entries sorted by
 * pointer string, so growing the list shifts most of them. A reader of the
 * list's value and one reader of its CFC envelope per element are subscribed,
 * as a pattern that draws each element with its label has them: each reported
 * change under the envelope is judged against every one of those readers.
 *
 * Each sample alternates the list between its two lengths and times the commit
 * through settlement. The `notifyOptimistic` share of it, from the runtime's
 * own timings, is written as a diagnostic per size.
 */

import { Identity } from "@commonfabric/identity";
import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "@commonfabric/logger";

import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("cfc-envelope-change-bench");
const space = signer.did();
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
  cfcEnforcementMode: "observe",
  cfcFlowLabels: "persist",
});

const listSchema = { type: "array", items: { asCell: ["cell"] } } as const;
const elementSchema = (atom: string) => ({
  type: "object",
  ifc: { confidentiality: [atom] },
} as const);

const writeList = async (cause: string, count: number): Promise<string> => {
  const tx = runtime.edit();
  const elements = [];
  for (let i = 0; i < count; i++) {
    elements.push(
      runtime.getCell(space, `${cause}-el-${i}`, elementSchema(`el-${i}`), tx),
    );
  }
  const list = runtime.getCell(space, cause, listSchema, tx);
  list.set(elements);
  await tx.commit().settled;
  return list.getAsNormalizedFullLink().id;
};

/** Subscribes an action that reads `path` of the list document. */
const subscribeReader = async (id: string, path: string[]) => {
  const read = (tx: IExtendedStorageTransaction) => {
    tx.read({
      space,
      scope: "space",
      id: id as `${string}:${string}`,
      type: "application/json",
      path,
    });
  };
  const setup = runtime.edit();
  read(setup);
  const log = txToReactivityLog(setup);
  await setup.commit().settled;
  runtime.scheduler.subscribe(read, log, { isEffect: false });
};

const notifyTime = (): { count: number; totalMs: number } => {
  const stats = getTimingStatsBreakdown()["storage.v2"]?.[
    "commitOperations/notifyOptimistic"
  ];
  return { count: stats?.count ?? 0, totalMs: stats?.totalTime ?? 0 };
};

for (const size of [50, 200]) {
  const cause = `envelope-change-bench-${size}`;
  const id = await writeList(cause, size);
  await subscribeReader(id, ["value"]);
  for (let i = 0; i < size; i++) await subscribeReader(id, ["cfc"]);

  let grown = false;
  const step = async () => {
    grown = !grown;
    await writeList(cause, grown ? size + 1 : size);
  };

  resetAllTimingStats();
  for (let i = 0; i < 10; i++) await step();
  const { count, totalMs } = notifyTime();
  benchDiagnostic(JSON.stringify({
    elements: size,
    commits: 10,
    notifyOptimisticCalls: count,
    notifyOptimisticMsPerGrowOrShrink: Number((totalMs / 10).toFixed(2)),
  }));

  Deno.bench({
    name: `${size} elements`,
    group: "cfc envelope change notification",
    fn: async (timer) => {
      timer.start();
      await step();
      timer.end();
    },
  });
}

globalThis.addEventListener("unload", () => {
  void (async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  })();
});
