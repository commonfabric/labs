/**
 * A FabriChat placement of a room whose space is deleted. The memory server
 * refuses the space to everyone for good, which `spaceDeleted()` reads, and
 * the placement's state says so, whatever the viewer's level
 * (`docs/specs/fabrichat/FabriChatPlacement.md`).
 */
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { refusingServer } from "../../runtime/runner/test/support/refusing-server.ts";

const signer = await Identity.fromPassphrase("fabrichat-placement-deleted");
const home = signer.did() as MemorySpace;
const gone = (await Identity.fromPassphrase("fabrichat placement gone room"))
  .did() as MemorySpace;
const PLACEMENT_PATH = fromFileUrl(
  new URL("../system/fabrichat/placement.tsx", import.meta.url),
);
// The patterns package, which the placement's imports reach across.
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

describe("fabrichat-placement-deleted", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let refuse: ReturnType<typeof refusingServer>["refuse"];
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const refusing = refusingServer(server);
    refuse = refusing.refuse;
    storageManager = EmulatedStorageManager.connectTo(
      refusing.server as MemoryV2Server.Server,
      { as: signer },
    );
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await storageManager?.synced();
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  it("reads `deleted` for a room whose space the memory server refuses as deleted", async () => {
    refuse(gone, "deleted");
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: PLACEMENT_PATH, root: PATTERNS },
    );
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const room = runtime.getCell<Record<string, unknown>>(
      gone,
      "deleted room",
      undefined,
      tx,
    );
    const placement = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      { room },
      runtime.getCell<Record<string, unknown>>(
        home,
        "placement of a deleted room",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const state = await waitForCellValue<string>(
      runtime,
      placement.key("$VIEWS").key("chat").key("state"),
      (value) => value === "deleted",
      { stuckLabel: "the placement's state" },
    );
    expect(state).toBe("deleted");
  });
});
