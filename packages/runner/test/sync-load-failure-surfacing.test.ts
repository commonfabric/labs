import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { entityIdFrom } from "../src/create-ref.ts";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

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
const FID_B = `fid1:${"B".repeat(43)}`;

const surfacedErrorCount = (): number =>
  (getLoggerCountsBreakdown() as Record<
    string,
    Record<string, { error?: number }>
  >)["storage.v2"]?.["sync-load-failure"]?.error ?? 0;

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
});
