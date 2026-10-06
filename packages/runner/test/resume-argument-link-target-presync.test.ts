import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "resume argument link target presync",
);
const space = signer.did();

// Reload churn regression (home-rehydration-churn 2/2/2, v2 cutover ×
// CT-1843): a resumed sub-pattern whose computed reads THROUGH an argument
// link (the profile picker's default badge derefs `defaultProfile` into a
// doc nothing else references) commits its first run against a cold replica
// of the link TARGET — read basis seq 0 vs the server's newer seq, a
// guaranteed ConflictError. v1 was immune (populate's aborted first runs
// subscribed the target before the first real commit). The v2 equivalent:
// the resume pre-sync (`Runner.#syncCellsForRunningPattern()`) must name
// the document the computed reads through the argument link, under the
// schema the transformer narrowed the computed to, before the settle runs.
//
// Two managers with their OWN replicas loopback-connected to one in-process
// server (same shape as inspace-child-owner-seed.test.ts): a shared emulate
// manager's replicas would be warm and mask the cold-read entirely.

// The picker flow in miniature: `profile` is its own document; `def` is its
// own document whose VALUE is a link to `profile`; the child pattern's
// computed reads through `def` into the profile document. On resume the
// child's argument redirect chain pre-syncs the `def` document, but the
// profile document behind its link is what the computed's first run reads.
// The picker flow in miniature: the parent's `def` argument arrives as a
// LINK to a document owned by nothing in the resumed pattern tree (the real
// defaultProfile links to a profile-home doc from another lineage). The
// badge computed reads THROUGH that link. On resume the argument chain
// pre-syncs the argument documents themselves; the linked target is what
// the computed's first run reads.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, pattern } from 'commonfabric';",
        "",
        "type Profile = { name?: string };",
        "",
        "export const badge = pattern<{ def: Profile }, { label: string }>(",
        "  ({ def }) => {",
        "    const label = computed(() => `n:${def.name ?? 'none'}`);",
        "    return { label };",
        "  },",
        ");",
        "",
        "export default pattern<{ def: Profile }, {",
        "  child: { label: string };",
        "}>(({ def }) => {",
        "  const child = badge({ def });",
        "  return { child };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "resume argument link target presync parent";

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

describe("resume pre-sync covers what a body reads through an argument link", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("resumes without commit conflicts and reads through the link", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    try {
      // Session 1: create and settle the durable state. The profile document
      // is created OUTSIDE the pattern (nothing in the resumed tree owns it)
      // and reaches the pattern only as a link in its run inputs.
      const tx1 = rt1.edit();
      const profileCell = rt1.getCell<{ name?: string }>(
        space,
        "external profile doc",
        undefined,
        tx1,
      );
      profileCell.withTx(tx1).set({ name: "Ada" });
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, { def: profileCell }, resultCell1);
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit().settled;
      expect(commit1.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      expect(r1.key("child").key("label").get()).toBe("n:Ada");

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Session 2 (own cold replicas): resume the piece. The badge computed's
      // first run reads through `def` into the profile document; unless the
      // resume pre-sync pulled that link target, the commit carries a seq-0
      // read of a document the server holds at a newer seq — a guaranteed
      // ConflictError (this is the reload churn the browser gate counts).
      const parentLink = r1.getAsNormalizedFullLink();
      getLogger("storage.v2").resetCounts();
      const conflictsBefore = commitConflictCount();

      const parentCell2 = rt2.getCellFromLink(parentLink);
      await parentCell2.sync();
      const started = await rt2.start(parentCell2);
      expect(started).toBeTruthy();

      // The fix's contract: the resume pre-sync followed the argument link
      // and pulled the profile document before the settle, so a first run
      // demanded during the settle reads it warm instead of committing a
      // seq-0 basis (the reload-churn conflict).
      const profileLink = profileCell.getAsNormalizedFullLink();
      const replicaB = managerB.open(space) as unknown as {
        get?: (uri: string, scope?: unknown) => unknown;
      };
      expect(
        replicaB.get?.(profileLink.id, profileLink.scope),
        "resume pre-sync must name what the computed reads before the settle",
      ).toBeDefined();

      // Render-like demand: an effect that READS the label synchronously
      // during the settle (the shell renders immediately; unlike pull() it
      // does not await loads). This is what demands the badge computed's
      // first run while the profile document may still be cold.
      const label2 = rt2.getCellFromLink(parentLink)
        .key("child")
        .key("label");
      const render = (actionTx: unknown) => {
        // deno-lint-ignore no-explicit-any
        label2.withTx(actionTx as any).get();
      };
      rt2.scheduler.subscribe(render, {
        reads: [toMemorySpaceAddress(label2.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });

      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      await label2.pull();
      expect(label2.get()).toBe("n:Ada");

      expect(
        commitConflictCount() - conflictsBefore,
        "a resumed pattern must not commit-conflict against its own durable state",
      ).toBe(0);
    } finally {
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
