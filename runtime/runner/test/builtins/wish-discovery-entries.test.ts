/**
 * Entries in the lists a wish searches that name nothing it can hand out: a
 * mentionable whose value is not a record, a profile element without a cell,
 * and a profile entry that points into the home space. Each case puts one
 * beside an entry the wish does hand out, so what is asserted is that the
 * search skips the one and still finds the other.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { WishParams } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { createBuilder } from "../../src/builder/factory.ts";
import { NAME } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { seedProfileOwner } from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const userIdentity = await Identity.fromPassphrase("wish discovery user");
const patternSpace = await Identity.fromPassphrase("wish discovery space");
const profileSpace = await Identity.fromPassphrase("wish discovery profile");

type WishState = { result?: unknown; candidates?: unknown[]; error?: string };

describe("wish-discovery-entries", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    ({ wish, pattern } = createTrustedBuilder(runtime).commonfabric);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Runs `write` in a transaction of its own and commits it. */
  async function commit(
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<void> {
    const tx = runtime.edit();
    write(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  }

  /** The state a wish for `query` in `scope` settles to. */
  async function wishFor(
    label: string,
    query: string,
    scope: WishParams["scope"],
    headless = false,
  ): Promise<Cell<WishState>> {
    const tx = runtime.edit();
    const wishPattern = pattern(() => ({
      result: wish({
        query,
        ...(scope === undefined ? {} : { scope }),
        headless,
      }),
    }));
    const resultCell = runtime.getCell<{ result?: WishState }>(
      patternSpace.did(),
      `wish discovery ${label}`,
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return result.key("result") as Cell<WishState>;
  }

  it("skips a mentionable whose value is not a record", async () => {
    let text: Cell<unknown>;
    let gadget: Cell<unknown>;
    await commit((tx) => {
      text = runtime.getCell(patternSpace.did(), "plain text", undefined, tx);
      text.set("gadget");
      gadget = runtime.getCell(patternSpace.did(), "gadget", undefined, tx);
      gadget.set({ [NAME]: "gadget", kind: "named" });
      const root = runtime.getCell(
        patternSpace.did(),
        "mentionable root",
        undefined,
        tx,
      );
      root.set({ backlinksIndex: { mentionable: [text, gadget] } });
      runtime.getCell<{ defaultPattern?: unknown }>(
        patternSpace.did(),
        patternSpace.did(),
        undefined,
        tx,
      ).key("defaultPattern").set(root);
    });

    const state = await wishFor("mentionable", "#gadget", ["."]);

    expect(state.get()?.error).toBeUndefined();
    expect(state.key("result").get()).toEqual({
      [NAME]: "gadget",
      kind: "named",
    });
    expect(state.key("candidates").get()?.length).toBe(1);
  });

  describe("in the user's profile", () => {
    /**
     * Seeds a profile of the user's own holding `elements`, and the Home that
     * lists `entries` and then that profile.
     */
    async function seedProfile(
      elements: (card: Cell<unknown>) => unknown[],
      entries: (tx: IExtendedStorageTransaction) => Cell<unknown>[] = () => [],
    ): Promise<void> {
      let profile: Cell<unknown>;
      await commit((tx) => {
        const card = runtime.getCell(
          profileSpace.did(),
          "profile card",
          undefined,
          tx,
        );
        card.set({ title: "Card" });
        profile = runtime.getCell(profileSpace.did(), "profile", undefined, tx);
        profile.set({
          name: "Ada",
          initialNameApplied: "Ada",
          avatar: "",
          elements: elements(card),
        });
        seedProfileOwner(
          tx,
          profile.getAsNormalizedFullLink(),
          userIdentity.did(),
        );
      });
      await commit((tx) => {
        const root = runtime.getCell(
          userIdentity.did(),
          "home root",
          undefined,
          tx,
        );
        root.key("profiles").set([...entries(tx), profile]);
        runtime.getHomeSpaceCell(tx).asSchema(undefined).key("defaultPattern")
          .set(root);
      });
    }

    it("skips a profile element that names no cell", async () => {
      await seedProfile((card) => [
        { tag: "#card", title: "No cell" },
        { cell: card, tag: "#card", title: "Card" },
      ]);

      const state = await wishFor("element", "#card", ["profile"]);

      expect(state.get()?.error).toBeUndefined();
      expect(state.key("result").get()).toEqual({ title: "Card" });
      expect(state.key("candidates").get()?.length).toBe(1);
    });

    it("skips a profile entry that points into the home space", async () => {
      // The entry is the user's own by its label, and its document exists,
      // so only where it lives keeps it out.
      await seedProfile(() => [], (tx) => {
        const inHome = runtime.getCell(
          userIdentity.did(),
          "profile in home",
          undefined,
          tx,
        );
        inHome.set({ name: "Home", initialNameApplied: "Home", avatar: "" });
        seedProfileOwner(
          tx,
          inHome.getAsNormalizedFullLink(),
          userIdentity.did(),
        );
        return [inHome];
      });

      const state = await wishFor("entry", "#profile", undefined, true);

      expect(state.get()?.error).toBeUndefined();
      expect(state.key("result").key("name").get()).toBe("Ada");
      expect(state.key("candidates").get()?.length).toBe(1);
    });
  });
});
