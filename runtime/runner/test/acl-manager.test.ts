/**
 * Read-path and validation unit tests for `ACLManager`.
 *
 * Deliberately scoped to logic that a mocked runtime can honestly exercise:
 * document addressing and the validation of already-stored values. The WRITE
 * path is not tested here and must not be — a mocked `editWithRetry` cannot
 * observe the commit the runner actually emits, and that blind spot is exactly
 * how a bug shipped in which every post-genesis ACL mutation was refused by the
 * server while this suite stayed green. Write-path coverage lives in
 * `memory-v2-acl-mutation.test.ts`, against a real memory-v2 server, and
 * asserts the emitted operation shape.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ACLManager } from "../src/acl-manager.ts";
import type { Runtime } from "../src/runtime.ts";

const SPACE = "did:key:z6Mk-acl-manager-space";
const ALICE = "did:key:z6Mk-acl-manager-alice";

const createHarness = (initial: unknown) => {
  let requestedId: string | undefined;
  const cell = {
    sync: () => Promise.resolve(),
    get: () => initial,
  };
  const runtime = {
    storageManager: { synced: () => Promise.resolve() },
    getCellFromLink: (link: { id: string }) => {
      requestedId = link.id;
      return cell;
    },
    idle: () => Promise.resolve(),
  } as unknown as Runtime;
  return {
    manager: new ACLManager(runtime, SPACE),
    requestedId: () => requestedId,
  };
};

Deno.test("ACLManager addresses the server's canonical ACL document", async () => {
  const { manager, requestedId } = createHarness({ [ALICE]: "OWNER" });
  await manager.get();
  assertEquals(requestedId(), `of:${SPACE}`);
});

Deno.test("ACLManager returns null for a missing ACL", async () => {
  const { manager } = createHarness(undefined);
  assertEquals(await manager.get(), null);
});

Deno.test("ACLManager rejects malformed and ownerless stored ACLs", async () => {
  for (
    const value of [
      null,
      { [ALICE]: "ADMIN" },
      { [ALICE]: "WRITE" },
      {},
    ]
  ) {
    const { manager } = createHarness(value);
    await assertRejects(
      () => manager.get(),
      Error,
      "malformed or has no concrete OWNER",
    );
  }
});
