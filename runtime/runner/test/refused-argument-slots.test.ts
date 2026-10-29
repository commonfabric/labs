import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import type { FabricValue } from "@commonfabric/data-model";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  createSigilLinkFromParsedLink,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import {
  keepRefusedArgumentSlots,
  type PieceAddress,
  type RefusedArgumentSlots,
  refusedArgumentSlotsCell,
} from "../src/refused-argument-slots.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("refused argument slots");
const space = signer.did();
const REFUSED_BY = "refusing-pattern#default";

/** A runtime over its own session of `server`, closed by `dispose`. */
const sessionOf = (server: ReturnType<typeof newSharedServer>) => {
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  return {
    runtime,
    storageManager,
    dispose: async () => {
      await runtime.dispose();
      await storageManager.close();
    },
  };
};

/**
 * Stores `stored` as the argument document at `cause`, then keeps the slots
 * `refused` names into the store of `piece`, in one transaction.
 */
const keepFrom = async (
  runtime: Runtime,
  piece: PieceAddress,
  cause: string,
  stored: Record<string, FabricValue>,
  refused: Record<string, string>,
): Promise<NormalizedFullLink> => {
  const tx = runtime.edit();
  const argumentCell = runtime.getCell(space, cause, undefined, tx);
  argumentCell.setRawUntyped(stored);
  const argument = argumentCell.getAsNormalizedFullLink();
  keepRefusedArgumentSlots(
    runtime,
    tx,
    piece,
    argument,
    stored,
    new Map(Object.entries(refused)),
    REFUSED_BY,
  );
  expect((await tx.commit().settled).error).toBeUndefined();
  return argument;
};

/** The store of `piece`, as stored. */
const storeOf = async (runtime: Runtime, piece: PieceAddress) => {
  const store = refusedArgumentSlotsCell(runtime, piece);
  await store.sync();
  return store.getRaw() as RefusedArgumentSlots | undefined;
};

describe("refused-argument-slots", () => {
  it("keeps the values each session's instance of a session-scoped piece refused apart", async () => {
    const server = newSharedServer();
    const a = sessionOf(server);
    const b = sessionOf(server);
    try {
      const piece = (runtime: Runtime): PieceAddress => ({
        space,
        id: runtime.getCell(space, "scoped piece").getAsNormalizedFullLink()
          .id,
        scope: "session",
      });

      await keepFrom(a.runtime, piece(a.runtime), "argument a", {
        kept: "session A only",
      }, { kept: "refused in A" });
      await a.storageManager.synced();
      await keepFrom(b.runtime, piece(b.runtime), "argument b", {
        kept: "session B only",
      }, { kept: "refused in B" });
      await b.storageManager.synced();

      expect(
        (await storeOf(a.runtime, piece(a.runtime)))?.kept[REFUSED_BY]
          .map(({ value }) => value),
      ).toEqual(["session A only"]);
      expect(
        (await storeOf(b.runtime, piece(b.runtime)))?.kept[REFUSED_BY]
          .map(({ value }) => value),
      ).toEqual(["session B only"]);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  describe("a link in a refused value", () => {
    it("names the argument document when it left its document out, and reads as it did there", async () => {
      const server = newSharedServer();
      const session = sessionOf(server);
      try {
        const { runtime } = session;
        const piece: PieceAddress = {
          ...runtime.getCell(space, "linking piece").getAsNormalizedFullLink(),
        };
        const argument = runtime.getCell(space, "linking argument")
          .getAsNormalizedFullLink();
        const toLabel = createSigilLinkFromParsedLink(
          { ...argument, path: ["label"] },
          { base: argument },
        );
        expect(linkRefPayload(toLabel).id).toBeUndefined();

        await keepFrom(runtime, piece, "linking argument", {
          label: "mine",
          kept: ["one", toLabel],
          alias: toLabel,
        }, { kept: "refused", alias: "refused" });

        const store = await storeOf(runtime, piece);
        const nested = store!.kept[REFUSED_BY][0].value as FabricValue[];
        expect(linkRefPayload(nested[1] as never)).toMatchObject({
          id: argument.id,
          space: argument.space,
          scope: argument.scope,
          path: ["label"],
        });
        expect(
          linkRefPayload(store!.alias[REFUSED_BY][0].value as never),
        ).toMatchObject({ id: argument.id, path: ["label"] });

        const kept = refusedArgumentSlotsCell(runtime, piece);
        expect(
          kept.key("kept").key(REFUSED_BY).key(0).key("value").get(),
        ).toEqual(["one", "mine"]);
        expect(
          kept.key("alias").key(REFUSED_BY).key(0).key("value").get(),
        ).toBe("mine");
      } finally {
        await session.dispose();
      }
    });

    it("is kept as it was when it already names its document", async () => {
      const server = newSharedServer();
      const session = sessionOf(server);
      try {
        const { runtime } = session;
        const piece: PieceAddress = {
          ...runtime.getCell(space, "absolute piece").getAsNormalizedFullLink(),
        };
        const elsewhere = runtime.getCell(space, "elsewhere")
          .getAsNormalizedFullLink();
        const absolute = createSigilLinkFromParsedLink(elsewhere);

        await keepFrom(runtime, piece, "absolute argument", {
          kept: absolute,
        }, { kept: "refused" });

        const store = await storeOf(runtime, piece);
        expect(linkRefPayload(store!.kept[REFUSED_BY][0].value as never))
          .toEqual(linkRefPayload(absolute));
      } finally {
        await session.dispose();
      }
    });
  });

  it("keeps a second value a pattern refuses beside the first, and the same value once", async () => {
    const server = newSharedServer();
    const session = sessionOf(server);
    try {
      const { runtime } = session;
      const piece: PieceAddress = {
        ...runtime.getCell(space, "refused twice").getAsNormalizedFullLink(),
      };

      for (const value of ["first", "first", "second"]) {
        await keepFrom(runtime, piece, "refused twice argument", {
          kept: value,
        }, { kept: "refused" });
      }

      expect(
        (await storeOf(runtime, piece))?.kept[REFUSED_BY].map(({ value }) =>
          value
        ),
      ).toEqual(["first", "second"]);
    } finally {
      await session.dispose();
    }
  });
});
