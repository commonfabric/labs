import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";

import { entityIdFrom } from "../src/create-ref.ts";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import {
  type MemorySpace,
  ReplicaLoadFailureError,
} from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

// The silent-collapse pin for sync-layer failures.
//
// A denied read never delivers data: the memory client throws the server's
// typed AuthorizationError from mount, the watch-refresh machinery wraps it
// into the pull result's `error`, and `sync()` still RESOLVES — the caller
// reads the doc as absent. Deny, transport failure, and genuine absence all
// collapse into the same silent `undefined` (the 2026-07-21 estuary
// investigation pinned this at the wire). These tests pin the surfacing:
// sync() keeps resolving (callers depend on that), but the failure is logged
// under storage.v2/"sync-load-failure" — once per distinct (space, error),
// carrying the server's own principal-naming message.

const signer = await Identity.fromPassphrase("sync load failure surfacing");

const denialFor = (space: string): Error =>
  Object.assign(
    new Error(`Principal ${signer.did()} lacks READ on space ${space}`),
    { name: "AuthorizationError" },
  );

/** Denies every mount the way a real enforce-mode server does: the memory
 * client's `request()` throws the response's typed error from `mount`. */
class DenyingFactory implements SessionFactory {
  create(spaceId: string): never {
    throw denialFor(spaceId);
  }
}

class DeniedStorageManager extends StorageManager {
  static make(as: Identity) {
    return new DeniedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
    );
  }
  private constructor(options: Options) {
    super(options, new DenyingFactory());
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

const FID_A = `fid1:${"A".repeat(43)}`;
const FID_B = `fid1:${"B".repeat(42)}A`;

const surfacedErrorCount = (): number =>
  (getLoggerCountsBreakdown() as Record<
    string,
    Record<string, { error?: number }>
  >)["storage.v2"]?.["sync-load-failure"]?.error ?? 0;

const ownInstanceRefusalCount = (): number =>
  (getLoggerCountsBreakdown() as Record<
    string,
    Record<string, { debug?: number }>
  >)["storage.v2"]?.["own-instance-read-refused"]?.debug ?? 0;

const serviceSigner = await Identity.fromPassphrase("sync load serving");
const homeSpace = (await Identity.fromPassphrase("sync load home")).did();
const foreignSpace = (await Identity.fromPassphrase("sync load foreign")).did();
const actor = (await Identity.fromPassphrase("sync load actor")).did();

/** A serving manager's view of `foreignSpace`, whose list grants no actor. */
const servingManager = (
  { withProbe = true }: { withProbe?: boolean } = {},
): EmulatedStorageManager =>
  EmulatedStorageManager.emulate({
    as: serviceSigner,
    servingHomeSpace: homeSpace,
    ...(withProbe
      ? {
        foreignScopedReadGrant: () =>
          Promise.resolve({
            granted: false as const,
            reason: "the list grants the actor nothing",
          }),
      }
      : {}),
  });

/** A cell over `foreignSpace`'s document `id`, under `scope`. */
const foreignCell = (
  runtime: Runtime,
  id: string,
  scope: "user" | "session",
) =>
  runtime.getCellFromLink({
    space: foreignSpace,
    id: `of:${id}`,
    path: [],
    scope,
  });

/** A cell over an inline value that links to `foreignSpace`'s document `id`. */
const cellLinkingForeign = (
  runtime: Runtime,
  id: string,
  scope: "user" | "session",
) =>
  runtime.getCellFromEntityId(
    homeSpace,
    dataUriFromValueWithResolvedLinks({
      ref: {
        "/": {
          [LINK_V1_TAG]: {
            id: `of:${id}`,
            path: [],
            space: foreignSpace,
            scope,
            schema: { type: "object" },
          },
        },
      },
    }),
    [],
    undefined,
  );

describe("sync load failure surfacing", () => {
  it("logs a denied sync once per space and still resolves", async () => {
    const storageManager = DeniedStorageManager.make(signer);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const space = signer.did();
    const emitted: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      emitted.push(args.map(String).join(" "));
      originalError(...args);
    };
    try {
      const before = surfacedErrorCount();

      const cell = runtime.getCellFromEntityId(
        space,
        entityIdFrom(FID_A),
        [],
        undefined,
      );
      // The existing contract: a failed pull does NOT reject sync().
      await cell.sync();
      // ...and the caller sees no data — the exact silent shape being pinned.
      expect(cell.getRawUntyped()).toBe(undefined);
      expect(surfacedErrorCount()).toBe(before + 1);
      // The surfaced line carries the server's own words — the principal and
      // the space — not a generic wrapper string.
      expect(
        emitted.some((line) =>
          line.includes("sync-load-failure") &&
          line.includes(`lacks READ on space ${space}`)
        ),
      ).toBe(true);

      // A second doc in the same denied space repeats the identical failure:
      // deduplicated, no second line.
      const sibling = runtime.getCellFromEntityId(
        space,
        entityIdFrom(FID_B),
        [],
        undefined,
      );
      await sibling.sync();
      expect(surfacedErrorCount()).toBe(before + 1);
    } finally {
      console.error = originalError;
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("surfaces a denied link-target pull", async () => {
    // The second seam: a doc's VALUE links into a space the reader cannot
    // mount (the cross-space shape from the estuary incident). The data-URI
    // cell path walks embedded links through the same link-target pull
    // tracker as pulled documents, so it drives that seam without a server.
    const storageManager = DeniedStorageManager.make(signer);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const linkedSpace = (await Identity.fromPassphrase("linked denied space"))
      .did();
    try {
      const before = surfacedErrorCount();
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: `of:${FID_A}`,
            path: [],
            space: linkedSpace,
          },
        },
      };
      const dataURI = dataUriFromValueWithResolvedLinks({ ref: sigilLink });
      const cell = runtime.getCellFromEntityId(
        signer.did(),
        dataURI,
        [],
        undefined,
      );
      // The data value itself is local; only the linked space is pulled —
      // and denied. sync() still resolves.
      await cell.sync();
      expect(surfacedErrorCount()).toBe(before + 1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resets the dedup set at the cap rather than growing it", async () => {
    const storageManager = DeniedStorageManager.make(signer);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // The factory rejects before any real use of the space, so fabricated
    // space ids suffice — each yields a distinct denial message, hence a
    // distinct dedup key.
    const fakeSpace = (i: number) => `did:key:zFakeSpace${i}` as MemorySpace;
    try {
      const before = surfacedErrorCount();
      for (let i = 0; i < 256; i++) {
        await runtime.getCellFromEntityId(
          fakeSpace(i),
          entityIdFrom(FID_A),
          [],
          undefined,
        ).sync();
      }
      expect(surfacedErrorCount()).toBe(before + 256);
      // The 257th distinct failure resets the full set and still logs...
      await runtime.getCellFromEntityId(
        fakeSpace(256),
        entityIdFrom(FID_A),
        [],
        undefined,
      ).sync();
      expect(surfacedErrorCount()).toBe(before + 257);
      // ...so an early repeat logs again — the accepted trade for a bound.
      await runtime.getCellFromEntityId(
        fakeSpace(0),
        entityIdFrom(FID_B),
        [],
        undefined,
      ).sync();
      expect(surfacedErrorCount()).toBe(before + 258);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("logs nothing for a load the manager's close cuts short, and still fails its waiters", async () => {
    // A write kicks a load of its document that nothing awaits, and neither
    // the commit nor the runtime going idle waits for it to land, so a close
    // right after both meets it in flight. Its failure is the close's own
    // doing, not a read that went wrong.

    const storageManager = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const space = signer.did();
    const tx = runtime.edit();
    runtime.getCell<number>(space, "cut-short", { type: "number" }, tx).set(1);
    await tx.commit().settled;
    await runtime.idle();

    const inFlight = storageManager.pendingLoadAddresses();
    expect(inFlight).toHaveLength(1);
    const settled = storageManager.loadsSettled(
      inFlight.map((address) =>
        entityKey(address, storageManager.scopeKeyIdentity())
      ),
    ).then(() => undefined, (error: unknown) => error);
    const before = surfacedErrorCount();

    await runtime.dispose();
    await storageManager.close();

    expect(surfacedErrorCount()).toBe(before);
    const failure = await settled;
    expect(failure).toBeInstanceOf(ReplicaLoadFailureError);
    expect((failure as ReplicaLoadFailureError).failure.failureClass).toBe(
      "connection",
    );
    expect((failure as ReplicaLoadFailureError).message).toBe(
      "memory client closed",
    );
  });

  it("logs distinct failures for distinct spaces", async () => {
    const storageManager = DeniedStorageManager.make(signer);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const otherSpace = (await Identity.fromPassphrase("another space")).did();
    try {
      const before = surfacedErrorCount();

      const mine = runtime.getCellFromEntityId(
        signer.did(),
        entityIdFrom(FID_A),
        [],
        undefined,
      );
      await mine.sync();
      const foreign = runtime.getCellFromEntityId(
        otherSpace,
        entityIdFrom(FID_A),
        [],
        undefined,
      );
      await foreign.sync();

      // One line per space: the denial message names the space, so the
      // dedup key differs even though the error name matches.
      expect(surfacedErrorCount()).toBe(before + 2);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("a serving manager's refused foreign scoped read", () => {
    // A case about a line reads both counters, so a line landing under the
    // other key or level fails it, whichever way the boundary moved.

    let manager: EmulatedStorageManager;
    let runtime: Runtime;

    /** The change each counter shows across `read`. */
    const countsAcross = async (read: () => Promise<unknown>) => {
      const errorsBefore = surfacedErrorCount();
      const ownBefore = ownInstanceRefusalCount();
      await read();
      return {
        errors: surfacedErrorCount() - errorsBefore,
        ownInstance: ownInstanceRefusalCount() - ownBefore,
      };
    };

    beforeEach(() => {
      manager = servingManager();
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await manager.close();
    });

    describe("of the runtime's own instance", () => {
      it("counts a cell's load under no identity at debug and logs no error", async () => {
        for (const scope of ["user", "session"] as const) {
          const cell = foreignCell(runtime, `own-${scope}`, scope);
          expect(await countsAcross(() => cell.sync())).toEqual({
            errors: 0,
            ownInstance: 1,
          });
        }
      });

      it("counts a load naming the runtime's own identity at debug and logs no error", async () => {
        const read = () =>
          manager.syncInstance(
            { space: foreignSpace, id: "of:own-named" as never, scope: "user" },
            { principal: serviceSigner.did() },
          );
        expect(await countsAcross(read)).toEqual({ errors: 0, ownInstance: 1 });
      });

      it("counts a link target's load at debug and logs no error", async () => {
        const cell = cellLinkingForeign(runtime, "own-link", "user");
        expect(await countsAcross(() => cell.sync())).toEqual({
          errors: 0,
          ownInstance: 1,
        });
      });

      it("logs a real failure once however many of them follow it", async () => {
        const named = () =>
          manager.syncInstance(
            { space: foreignSpace, id: "of:evict" as never, scope: "user" },
            { principal: actor },
          );
        expect(await countsAcross(named)).toEqual({
          errors: 1,
          ownInstance: 0,
        });

        // More than the logged-once set holds.
        for (let i = 0; i < 300; i++) {
          await foreignCell(runtime, `evict-${i}`, "user").sync();
        }

        expect(await countsAcross(named)).toEqual({
          errors: 0,
          ownInstance: 0,
        });
      });

      it("returns a refusal marked `unnamed`", async () => {
        const result = await manager.open(foreignSpace).sync(
          "of:own-mark" as never,
          { path: [], schema: false },
          "user",
        );
        expect(result.error).toMatchObject({
          name: "ForeignScopedReadRefusedError",
          unnamed: true,
        });
      });
    });

    describe("of an actor's instance", () => {
      it("logs an error naming the actor when the list does not grant the actor", async () => {
        const emitted: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
          emitted.push(args.map(String).join(" "));
        };
        try {
          const read = () =>
            manager.syncInstance(
              { space: foreignSpace, id: "of:named" as never, scope: "user" },
              { principal: actor },
            );
          expect(await countsAcross(read)).toEqual({
            errors: 1,
            ownInstance: 0,
          });
        } finally {
          console.error = originalError;
        }
        expect(
          emitted.some((line) =>
            line.includes("sync-load-failure") &&
            line.includes(`the instance is ${actor}'s`)
          ),
        ).toBe(true);
      });

      it("logs an error when the runtime holds no probe to ask", async () => {
        const unprobed = servingManager({ withProbe: false });
        try {
          const read = () =>
            unprobed.syncInstance(
              {
                space: foreignSpace,
                id: "of:unprobed" as never,
                scope: "user",
              },
              { principal: actor },
            );
          expect(await countsAcross(read)).toEqual({
            errors: 1,
            ownInstance: 0,
          });
        } finally {
          await unprobed.close();
        }
      });

      it("returns a refusal not marked `unnamed` for a key naming no actor", async () => {
        const result = await manager.open(foreignSpace).sync(
          "of:bad-key" as never,
          { path: [], schema: false },
          "user",
          "not-a-scope-key" as never,
        );
        expect(result.error).toMatchObject({
          name: "ForeignScopedReadRefusedError",
          unnamed: false,
        });
      });
    });

    describe("under an actor whose identity cannot resolve its scope", () => {
      // A run under an actor with no session reads a session-scoped document:
      // the read names no instance, as the runtime's own does, and the actor's
      // identity is the whole of the difference between the two.

      const sessionless = { principal: actor };

      it("logs an error for a load by address", async () => {
        const read = () =>
          manager.syncInstance(
            {
              space: foreignSpace,
              id: "of:sessionless-address" as never,
              scope: "session",
            },
            sessionless,
          );
        expect(await countsAcross(read)).toEqual({ errors: 1, ownInstance: 0 });
      });

      it("logs an error for a cell's load", async () => {
        const cell = foreignCell(runtime, "sessionless-cell", "session");
        const read = () =>
          manager.syncCell(cell, { scopeKeyIdentity: sessionless });
        expect(await countsAcross(read)).toEqual({ errors: 1, ownInstance: 0 });
      });

      it("logs an error for a link target's load", async () => {
        const cell = cellLinkingForeign(runtime, "sessionless-link", "session");
        const read = () =>
          manager.syncCell(cell, { scopeKeyIdentity: sessionless });
        expect(await countsAcross(read)).toEqual({ errors: 1, ownInstance: 0 });
      });
    });
  });
});
