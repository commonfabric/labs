import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SpaceOfFunction } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { aclDocId } from "@commonfabric/memory/acl";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceOf } from "../../src/builder/space-access.ts";
import type { Cell } from "../../src/cell.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace, URI } from "../../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("space-of signer");
const home = signer.did();

/** What a handler queues for each child it creates: the child, and its space. */
type Notice = { room: unknown; space?: string };

describe("spaceOf()", () => {
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
   * Runs a root pattern whose `create` handler creates one child in a space of
   * its own, with `inSpace()` and grants, and queues a notice holding the
   * child and what `spaceOf()` returns for it. Each run of the handler records
   * that return in `seen`. A `deliver` handler records in `delivered` what
   * `spaceOf()` returns for the first queued notice's child.
   */
  const spawnRoot = async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const seen: unknown[] = [];
    const delivered: unknown[] = [];
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const stateSchema = {
      type: "object",
      properties: { notices: { asCell: ["cell"] } },
      required: ["notices"],
    } as const;
    const create = handler<{ value: string }, { notices: Cell<Notice[]> }>(
      {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      stateSchema,
      ({ value }, { notices }) => {
        const room = Child.inSpace(undefined, { grants: { "*": "READ" } })({
          value,
        });
        const space = commonfabric.spaceOf(room);
        seen.push(space);
        notices.push({ room, ...(space === undefined ? {} : { space }) });
      },
    );
    const deliver = handler<unknown, { notices: Cell<Notice[]> }>(
      {},
      stateSchema,
      (_event, { notices }) => {
        delivered.push(commonfabric.spaceOf(notices.key(0).key("room")));
      },
    );
    const Root = pattern<{ notices: Cell<Notice[]> }>(
      ({ notices }) => ({
        notices,
        create: create({ notices }),
        deliver: deliver({ notices }),
      }),
      stateSchema,
    );
    const tx = runtime.edit();
    const notices = runtime.getCell<Notice[]>(
      home,
      `space-of notices ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    notices.set([]);
    const result = runtime.run(
      tx,
      Root,
      { notices },
      runtime.getCell(
        home,
        `space-of root ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    const send = async (stream: "create" | "deliver", event: unknown) => {
      result.key(stream).send(event);
      await runtime.idle();
      await runtime.storageManager.synced();
    };
    return {
      seen,
      delivered,
      create: (value: string) => send("create", { value }),
      deliver: () => send("deliver", {}),
      /** The space each queued notice's child landed in, and its `space`. */
      queued: async (): Promise<{ landed: string; space?: string }[]> => {
        await notices.pull();
        // Each notice is a document of its own, so its fields are read
        // through the list's links rather than off the list's raw value.
        return (notices.getRaw() as unknown[]).map((_, index) => {
          const notice = notices.key(index);
          const room = notice.key("room");
          const space = notice.key("space").get() as string | undefined;
          return {
            landed: parseLink(room.getRaw(), room)!.space!,
            ...(space === undefined ? {} : { space }),
          };
        });
      },
    };
  };

  /**
   * Calls `spaceOf()` on `target` as code in a `kind` frame of the home space
   * would, and returns what it returns.
   */
  const callIn = (
    kind: "lift" | "handler",
    target: unknown,
  ): ReturnType<typeof spaceOf> => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: kind,
    });
    try {
      return spaceOf(target);
    } finally {
      popFrame(frame);
    }
  };

  describe("on a child a handler creates with `inSpace()`", () => {
    it("returns `undefined` in the run that names the space, and the created space's DID in the run after it", async () => {
      const root = await spawnRoot();
      await root.create("first");

      const [{ landed }] = await root.queued();
      expect(root.seen).toEqual([undefined, landed]);
      expect(isWellFormedDID(landed)).toBe(true);
      expect(landed).not.toBe(home);
      // The space holds the access list the call's grants created it with,
      // so it is the space this call created and not one that already was.
      expect(
        (await server.readDocument(
          landed as MemorySpace,
          aclDocId(landed as MemorySpace) as URI,
        ))?.value,
      ).toEqual({ "*": "READ", [home]: "OWNER" });
    });

    it("commits the created space's DID into the notice the handler queues", async () => {
      const root = await spawnRoot();
      await root.create("first");

      const [notice] = await root.queued();
      expect(notice.space).toBe(notice.landed);
      expect(notice.space).not.toBe(home);
    });

    it("returns the created space's DID to a later handler reading the queued child", async () => {
      const root = await spawnRoot();
      await root.create("first");
      await root.deliver();

      const [{ landed }] = await root.queued();
      expect(root.delivered).toEqual([landed]);
      expect(landed).not.toBe(home);
    });
  });

  describe("on a cell the calling code holds", () => {
    for (const kind of ["lift", "handler"] as const) {
      it(`returns the calling code's own space's DID for a cell there, in a ${kind}`, () => {
        expect(callIn(kind, runtime.getCell<unknown>(home, "space-of here")))
          .toBe(home);
      });
    }

    it("returns the space a linked cell's value lives in, for the cell and for its reactive proxy", async () => {
      const elsewhere = await runtime.createSpace();
      const tx = runtime.edit();
      const link = runtime.getCell<unknown>(
        home,
        "space-of link",
        undefined,
        tx,
      );
      link.set(runtime.getCell<unknown>(elsewhere, "space-of target"));
      expect((await tx.commit().settled).error).toBeUndefined();

      expect(callIn("lift", link)).toBe(elsewhere);
      expect(callIn("lift", link.getAsReactiveProxy())).toBe(elsewhere);
      await runtime.storageManager.synced();
    });
  });

  it("returns `undefined` for a target passed as `undefined`", () => {
    expect(callIn("lift", undefined)).toBeUndefined();
  });

  it("throws when called without a `target`", () => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: "lift",
    });
    try {
      // The declared type refuses this call; the runtime check is for callers
      // the compiler never saw.
      const declared: SpaceOfFunction = spaceOf;
      // @ts-expect-error: `target` is required.
      expect(() => declared()).toThrow("requires a `target`");
    } finally {
      popFrame(frame);
    }
  });

  it("throws for a target that is not a cell", () => {
    expect(() => callIn("lift", { space: home })).toThrow(
      "takes a cell as its target",
    );
  });

  it("throws in a pattern body", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceOf(undefined);
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });

  it("throws outside any frame", () => {
    expect(() => spaceOf(runtime.getCell<unknown>(home, "space-of here")))
      .toThrow("can only be called from a handler or a reactive computation");
  });
});
