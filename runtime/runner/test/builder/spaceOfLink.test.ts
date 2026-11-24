import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SpaceOfLinkFunction } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceOf, spaceOfLink } from "../../src/builder/space-access.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("space-of-link signer");
const home = signer.did();

describe("spaceOfLink()", () => {
  let server: MemoryV2Server.Server;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /**
   * Calls `call` as code in a `kind` frame of the home space would, with the
   * frame's transaction, and returns what it returns.
   */
  const callIn = <T>(
    kind: "lift" | "handler",
    call: (tx: IExtendedStorageTransaction) => T,
  ): T => {
    const tx = runtime.edit();
    const frame = pushFrame({ runtime, tx, space: home, frameKind: kind });
    try {
      return call(tx);
    } finally {
      popFrame(frame);
    }
  };

  /**
   * A cell in the home space holding a link to a cell in another space, and
   * that other space.
   */
  const linkElsewhere = async () => {
    const elsewhere = await runtime.createSpace();
    const tx = runtime.edit();
    const link = runtime.getCell<unknown>(
      home,
      `space-of-link link ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    link.set(runtime.getCell<unknown>(elsewhere, "space-of-link target"));
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.storageManager.synced();
    return { link, elsewhere };
  };

  for (const kind of ["lift", "handler"] as const) {
    it(`returns the space of the link a cell is, not of what it leads to, in a ${kind}`, async () => {
      const { link, elsewhere } = await linkElsewhere();

      expect(callIn(kind, () => spaceOfLink(link))).toBe(home);
      expect(callIn(kind, () => spaceOf(link))).toBe(elsewhere);
    });
  }

  it("returns the space a handle read at a position typed `Cell<unknown>` links into", async () => {
    const { link, elsewhere } = await linkElsewhere();

    const named = callIn("lift", (tx) => {
      const handle = link.withTx(tx).asSchema<Cell<unknown>>({
        type: "unknown",
        asCell: ["cell"],
      }).get();
      return spaceOfLink(handle);
    });
    expect(named).toBe(elsewhere);
  });

  it("returns `undefined` for a target passed as `undefined`", () => {
    expect(callIn("lift", () => spaceOfLink(undefined))).toBeUndefined();
  });

  it("throws when called without a `target`", () => {
    // The declared type refuses this call; the runtime check is for callers
    // the compiler never saw.
    const declared: SpaceOfLinkFunction = spaceOfLink;
    // @ts-expect-error: `target` is required.
    expect(() => callIn("lift", () => declared())).toThrow(
      "requires a `target`",
    );
  });

  it("throws for a target that is not a cell", () => {
    expect(() => callIn("lift", () => spaceOfLink({ space: home } as never)))
      .toThrow("takes a cell as its target");
  });

  it("throws in a pattern body", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceOfLink(undefined);
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });
});
