/**
 * A FabriChat room that is some other social space's chat: a room with no
 * `about`, running in a space whose root is a container that lists the space's
 * participants. What `wish({ query: "#default" })` resolves to is the space
 * cell's root, which a pattern test's space has none of, so this is checked
 * here, against a runtime and storage of the test's own;
 * `../fabrichat/join.test.tsx` covers a room that is its space's root.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat-placed-room");
const space = signer.did();

const ROOM_PATH = fromFileUrl(
  new URL("../fabrichat/room.tsx", import.meta.url),
);

// The patterns package, which the room's imports reach across.
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

// Reads a room's participants as links, not copies.
const participantListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("fabrichat-placed-room", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
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

  it("lists the participants its space's root lists, for a room with no `about`", async () => {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: ROOM_PATH, root: PATTERNS },
    );
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    // The container, the space's root, lists one participant.
    const participant = runtime.getCell<{ name: string }>(
      space,
      "container participant",
      undefined,
      tx,
    );
    participant.set({ name: "Placed" });
    const container = runtime.getCell<{ participants: Cell<unknown>[] }>(
      space,
      "container",
      undefined,
      tx,
    );
    container.set({ participants: [participant] });
    runtime.getSpaceCell(space, undefined, tx).key("defaultPattern").set(
      container,
    );
    const room = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      {},
      runtime.getCell<Record<string, unknown>>(
        space,
        "placed room",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();

    const listed = room.key("participants").asSchema(participantListSchema)
      .get() as Cell<unknown>[];
    expect(listed.length).toBe(1);
    expect(listed[0].equalLinks(participant)).toBe(true);
  });
});
