import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import {
  type Cell,
  createSpaceRootIfAbsent,
  inSpaceRootCause,
  isCell,
  type MemorySpace,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { vetSpace } from "../../src/ops/space-vetting.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("space vetting owner");

/** A principal who is not the identity vetting. */
const someoneElse = (await Identity.fromPassphrase("space vetting other"))
  .did();

/** The origin of the host the test's runtime is served by. */
const HOST = "https://home.example";

/**
 * The authored patterns, served at the host's patterns route, which is where
 * a `system:` source resolves. A space's root is provisioned from there.
 */
const sources = new PatternsRoute(
  fromFileUrl(new URL("../../../patterns", import.meta.url)),
);

/** A stand-in for a room, which a `fabrichat-room` space's root runs. */
const roomProgram: RuntimeProgram = {
  main: "/room.tsx",
  files: [{
    name: "/room.tsx",
    contents: `
import { handler, pattern, Writable } from "commonfabric";

const sendMessage = handler<{ text: string }, { messages: Writable<string[]> }>(
  (event, { messages }) => {
    messages.push(event.text);
  },
);

export default pattern(() => {
  const messages = new Writable<string[]>([]).for("messages");
  return {
    about: { kind: "group" },
    messages,
    sendMessage: sendMessage({ messages }),
  };
});`,
  }],
};

/**
 * The root a loom daemon's sidecar reserves for a social Loom's space in its
 * genesis commit, and provisions afterward: the Loom pattern, at the Loom's
 * own publication cause, named by the publication's `seed`.
 */
function loomPublicationRoot(seed: string) {
  return {
    source: "system:loom/main.tsx",
    sourceRoots: [
      "system:loom/main.test.tsx",
      "system:loom/presentation-refusals.test.tsx",
      "system:loom/multi-user.test.tsx",
      "system:loom/url-view.test.tsx",
    ],
    cause: JSON.stringify({
      purpose: "loom-publication-root",
      publication: seed,
    }),
    argument: { title: "Vetted" },
  };
}

/** What vetting returned, as a value a test compares whole. */
function outcome(
  vetted: string | Cell<unknown>,
): string | { root: string } {
  return isCell(vetted)
    ? { root: vetted.getAsNormalizedFullLink().id }
    : vetted;
}

/** The address of `cell`'s document, as {@link outcome} names a root. */
function addressOf(cell: Cell<unknown>): { root: string } {
  return { root: cell.getAsNormalizedFullLink().id };
}

describe("vetSpace()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** Serves a pattern source request from the authored patterns. */
  const serveSources: RuntimeFetch = async (input, init) =>
    (await sources.serve(new Request(input, init))) ??
      new Response("Pattern sources unavailable", { status: 404 });

  /**
   * A space created the way a loom daemon's sidecar creates a social Loom's:
   * granting `grants`, owned by the identity unless `owner` says otherwise,
   * its genesis commit reserving the Loom root at the Loom's publication
   * cause and declaring `spaceKind`, `loom` by default or no kind for `null`;
   * then provisioned, so that its root is the Loom at that cause.
   */
  async function loomSpace(
    grants: ACL,
    { owner, spaceKind = "loom" }: {
      owner?: string;
      spaceKind?: string | null;
    } = {},
  ): Promise<{ space: MemorySpace; root: Cell<unknown> }> {
    const genesisRoot = loomPublicationRoot(crypto.randomUUID());
    const space = await runtime.createSpace({
      grants,
      ...(owner === undefined ? {} : { owner: owner as never }),
      root: genesisRoot,
      ...(spaceKind === null ? {} : { spaceKind }),
    });
    const { error } = await createSpaceRootIfAbsent(
      runtime,
      space,
      genesisRoot,
      { fetch: serveSources },
    );
    if (error) throw error;
    await runtime.idle();
    return { space, root: runtime.getCell(space, genesisRoot.cause) };
  }

  /**
   * A space granting `grants`, whose genesis commit reserves its root at the
   * address `inSpaceRootCause()` derives there and declares `spaceKind`,
   * `fabrichat-room` by default or no kind for `null`. Its root is a room at
   * the reserved address, or elsewhere in the space when not `reserved`.
   */
  async function roomSpace(
    grants: ACL,
    { reserved = true, spaceKind = "fabrichat-room" }: {
      reserved?: boolean;
      spaceKind?: string | null;
    } = {},
  ): Promise<{ space: MemorySpace; root: Cell<unknown> }> {
    const space = await runtime.createSpace({
      grants,
      root: (created) => ({ cause: inSpaceRootCause(created) }),
      ...(spaceKind === null ? {} : { spaceKind }),
    });
    const root = await placeRoom(space, reserved);
    return { space, root };
  }

  /**
   * Places a room in `space` and links it as the space's root, at the address
   * the space's genesis reserves when `reserved`, and at a fresh one when not.
   */
  async function placeRoom(
    space: MemorySpace,
    reserved: boolean,
  ): Promise<Cell<unknown>> {
    // Disposing a controller disposes the runtime, which `afterEach` does
    // directly, so the controller is left to the runtime.
    const rooms = new PiecesController(
      createSession({ identity, spaceDid: space }),
      runtime,
    );
    await rooms.synced();
    return await installCustomRoot(
      runtime,
      rooms,
      roomProgram,
      reserved ? { cause: inSpaceRootCause(space) } : {},
    );
  }

  /** Links `space`'s root to `target`, as any member with `WRITE` can. */
  async function repoint(space: MemorySpace, target: unknown): Promise<void> {
    const { error } = await runtime.editWithRetry((tx) =>
      runtime.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
        target as never,
      )
    );
    expect(error).toBeUndefined();
    await runtime.idle();
  }

  describe("a `loom` space", () => {
    it("returns the Loom root a loom daemon's sidecar reserves at the Loom's publication cause", async () => {
      const { space, root } = await loomSpace({ [someoneElse]: "WRITE" });

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toEqual(addressOf(root));
    });

    it("returns the Loom root when the space declares no kind", async () => {
      const { space, root } = await loomSpace({ [someoneElse]: "WRITE" }, {
        spaceKind: null,
      });

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toEqual(addressOf(root));
    });

    it("returns `space-kind-mismatch` when the space declares `fabrichat-room`", async () => {
      const { space } = await loomSpace({ [someoneElse]: "WRITE" }, {
        spaceKind: "fabrichat-room",
      });

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toBe("space-kind-mismatch");
    });

    it("returns `space-root-mismatch` when the root is re-pointed to a piece of another composition", async () => {
      const { space } = await loomSpace({ [someoneElse]: "WRITE" });
      await placeRoom(space, false);

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toBe("space-root-mismatch");
    });

    it("returns `space-root-mismatch` when the root is re-pointed to a document that is no piece", async () => {
      const { space } = await loomSpace({ [someoneElse]: "WRITE" });
      const elsewhere = runtime.getCell<unknown>(space, crypto.randomUUID());
      await runtime.editWithRetry((tx) =>
        elsewhere.withTx(tx).set({ elsewhere: true } as never)
      );
      await repoint(space, elsewhere);

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toBe("space-root-mismatch");
    });

    it("returns the Loom root again once a re-pointed root is linked back to it", async () => {
      const { space, root } = await loomSpace({ [someoneElse]: "WRITE" });
      await placeRoom(space, false);
      await repoint(space, root);

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toEqual(addressOf(root));
    });

    it("returns `space-root-missing` when the root pointer reaches a Loom root in another space", async () => {
      const { space } = await loomSpace({ [someoneElse]: "WRITE" });
      const other = await loomSpace({ [someoneElse]: "WRITE" });
      await repoint(space, other.root);

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toBe("space-root-missing");
    });

    it("returns `recipient-access-refused` when the space grants the identity only `READ`", async () => {
      const { space } = await loomSpace({ [identity.did()]: "READ" }, {
        owner: someoneElse,
      });

      expect(outcome(await vetSpace(runtime, space, identity.did(), "loom")))
        .toBe("recipient-access-refused");
    });
  });

  describe("a `fabrichat-room` space", () => {
    it("returns the room at the address the space's genesis reserves", async () => {
      const { space, root } = await roomSpace({ [someoneElse]: "WRITE" });

      expect(
        outcome(
          await vetSpace(runtime, space, identity.did(), "fabrichat-room"),
        ),
      ).toEqual(addressOf(root));
    });

    it("returns `space-kind-undeclared` when the space declares no kind", async () => {
      const { space } = await roomSpace({ [someoneElse]: "WRITE" }, {
        spaceKind: null,
      });

      expect(
        outcome(
          await vetSpace(runtime, space, identity.did(), "fabrichat-room"),
        ),
      ).toBe("space-kind-undeclared");
    });

    it("returns `space-root-misplaced` when the root is a room away from the reserved address", async () => {
      const { space } = await roomSpace({ [someoneElse]: "WRITE" }, {
        reserved: false,
      });

      expect(
        outcome(
          await vetSpace(runtime, space, identity.did(), "fabrichat-room"),
        ),
      ).toBe("space-root-misplaced");
    });
  });

  it("throws for a kind whose root it has no contract for", async () => {
    const { space } = await roomSpace({ [someoneElse]: "WRITE" }, {
      spaceKind: "photo-album",
    });

    await expect(vetSpace(runtime, space, identity.did(), "photo-album"))
      .rejects.toThrow("photo-album");
  });
});
