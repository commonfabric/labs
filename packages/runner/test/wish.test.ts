import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import { NAME, UI } from "../src/builder/types.ts";
import { acquireSchemaRegistryLease } from "../src/schema-registry.ts";
import {
  openedSidecarSurface,
  openSidecarSurface,
  parseWishTarget,
  type SidecarSurfaceState,
  tagMatchesHashtag,
  wishSidecarDiagnostics,
} from "../src/builtins/wish.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

// Stable entity id used to address the test's piece registry cell. The value is
// opaque to these tests, which set up the cell and the space link to it
// directly; it's a real content-hash id so it stays well-formed.
const pieceRegistryEntityId = entityIdFrom(hashOf("piece-registry"));
const pieceRegistryId = pieceRegistryEntityId.taggedHashString;

describe("wish built-in", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("resolves the piece registry through an absolute path", async () => {
    const pieceRegistryCell = runtime.getCellFromEntityId<unknown[]>(
      space,
      pieceRegistryEntityId,
      [],
      undefined,
      tx,
    );
    const piecesData = [{ name: "Alpha", title: "Alpha" }];
    pieceRegistryCell.withTx(tx).set(piecesData);

    // Set up the space cell to link to pieceRegistry.
    const spaceCell = runtime.getCell<{ pieceRegistry?: unknown[] }>(
      space,
      space,
    ).withTx(tx);
    spaceCell.key("pieceRegistry").set(pieceRegistryCell.withTx(tx));

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern(() => {
      const pieceRegistry = wish<Array<Record<string, unknown>>>({
        query: "/pieceRegistry",
      });
      const firstPieceTitle = wish({ query: "/pieceRegistry/0/title" });
      return { pieceRegistry, firstPieceTitle };
    });

    const resultCell = runtime.getCell<{
      pieceRegistry?: { result?: unknown[] };
      firstPieceTitle?: { result?: string };
    }>(
      space,
      "wish built-in result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    const wishResultCell = result.key("pieceRegistry");
    const pieceRegistryResultCell = wishResultCell.key("result");
    const rawValue = pieceRegistryResultCell.getRaw() as
      | { ["/"]: Record<string, unknown> }
      | undefined;
    const linkData = rawValue?.["/"]?.[LINK_V1_TAG] as
      | { id?: string; overwrite?: string }
      | undefined;

    expect(result.key("pieceRegistry").get()?.result).toEqual(piecesData);
    expect(result.key("firstPieceTitle").get()?.result).toEqual(
      piecesData[0].title,
    );
    expect(linkData?.id).toEqual(`of:${pieceRegistryId}`);
  });

  it("resolves semantic wishes with # prefixes", async () => {
    const pieceRegistryCell = runtime.getCellFromEntityId(
      space,
      pieceRegistryEntityId,
      [],
      undefined,
      tx,
    );
    const piecesData = [
      { name: "Alpha", title: "Alpha" },
      { name: "Beta", title: "Beta" },
    ];
    pieceRegistryCell.withTx(tx).set(piecesData);

    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    (defaultPatternCell as any).key("pieceRegistry").set(
      pieceRegistryCell.withTx(tx),
    );
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern(() => {
      return {
        pieceRegistry: wish({ query: "#pieceRegistry" }),
        canonicalFirstTitle: wish({ query: "#pieceRegistry/0/title" }),
      };
    });

    const resultCell = runtime.getCell<{
      pieceRegistry?: { result?: unknown[] };
      canonicalFirstTitle?: { result?: string };
    }>(
      space,
      "wish semantic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    expect(result.key("pieceRegistry").get()?.result).toEqual(piecesData);
    expect(result.key("canonicalFirstTitle").get()?.result).toEqual("Alpha");
  });

  it("resolves the default pattern with #default", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    const defaultData = {
      title: "Default App",
      argument: { greeting: "hello" },
    };
    defaultPatternCell.set(defaultData);
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern(() => {
      return {
        defaultTitle: wish({ query: "#default/title" }),
        defaultGreeting: wish({ query: "#default/argument/greeting" }),
      };
    });

    const resultCell = runtime.getCell<{
      defaultTitle?: { result?: string };
      defaultGreeting?: { result?: string };
    }>(
      space,
      "wish default pattern result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation
    await result.pull();

    expect(result.key("defaultTitle").get()?.result).toEqual("Default App");
    expect(result.key("defaultGreeting").get()?.result).toEqual("hello");
  });

  it("resolves mentionable backlinks via #mentionable", async () => {
    const spaceCell = runtime.getCell(space, space).withTx(tx);
    const defaultPatternCell = runtime.getCell(space, "default-pattern").withTx(
      tx,
    );
    defaultPatternCell.set({
      backlinksIndex: {
        mentionable: [{ name: "Alpha" }, { name: "Beta" }],
      },
    });
    (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

    await tx.commit();
    await runtime.idle();
    tx = runtime.edit();

    const wishPattern = pattern(() => {
      return {
        mentionable: wish({ query: "#mentionable" }),
        firstMentionable: wish({ query: "#mentionable/0/name" }),
      };
    });

    const resultCell = runtime.getCell<{
      mentionable?: { result?: unknown[] };
      firstMentionable?: { result?: string };
    }>(
      space,
      "wish mentionable result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(result.key("mentionable").get()?.result).toEqual([
      { name: "Alpha" },
      { name: "Beta" },
    ]);
    expect(result.key("firstMentionable").get()?.result).toEqual("Alpha");
  });

  it("returns current timestamp via #now", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "wish now result",
      undefined,
      tx,
    );
    const before = Date.now();
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const after = Date.now();
    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // Coarsened to 1s resolution — floor(before) to floor(after+1s) range
    const coarsenedBefore = Math.floor(before / 1000) * 1000;
    expect(nowValue).toBeGreaterThanOrEqual(coarsenedBefore);
    expect(nowValue).toBeLessThanOrEqual(after);
    expect(nowValue! % 1000).toBe(0);
  });

  it("resolves the space cell using slash target", async () => {
    // Create the space cell (cause = space DID)
    const spaceCell = runtime.getCell(
      space,
      space, // Use space DID as cause
    ).withTx(tx);
    const spaceData = {
      testField: "space cell value",
    };
    spaceCell.withTx(tx).set(spaceData);

    const wishPattern = pattern(() => {
      const spaceResult = wish({ query: "/" });
      return { spaceResult };
    });

    const resultCell = runtime.getCell<{ spaceResult?: { result?: unknown } }>(
      space,
      "wish built-in space",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const readTx = runtime.readTx();
    const spaceResultCell = result.withTx(readTx).key("spaceResult");

    expect(spaceResultCell.get()?.result).toEqual(spaceData);
  });

  it("resolves space cell subpaths using slash notation", async () => {
    // Create the space cell with nested data
    const spaceCell = runtime.getCell(
      space,
      space, // Use space DID as cause
    ).withTx(tx);
    spaceCell.withTx(tx).set({
      config: { setting: "value" },
      nested: { deep: { data: ["Alpha"] } },
    });

    const wishPattern = pattern(() => {
      return {
        configLink: wish({ query: "/config" }),
        dataLink: wish({ query: "/nested/deep/data" }),
      };
    });

    const resultCell = runtime.getCell<{
      configLink?: { result?: unknown };
      dataLink?: { result?: unknown };
    }>(
      space,
      "wish built-in space subpaths",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const readTx = runtime.readTx();

    const configCell = result.withTx(readTx).key("configLink");
    expect(configCell.get()?.result).toEqual({ setting: "value" });

    const dataCell = result.withTx(readTx).key("dataLink");
    expect(dataCell.get()?.result).toEqual(["Alpha"]);
  });

  it("returns error for unknown wishes", async () => {
    const wishPattern = pattern(() => {
      const missing = wish({ query: "" });
      return { missing };
    });

    const resultCell = runtime.getCell<{ missing?: { error?: string } }>(
      space,
      "wish built-in missing target",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const missingResult = result.key("missing").get();
    // Empty query returns an error object
    expect(missingResult?.error).toMatch(/no query/);
  });

  describe("object-based wish syntax", () => {
    it("resolves the piece registry through a sourced default root", async () => {
      const canonicalRegistryCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        pieceRegistryEntityId,
        [],
        undefined,
        tx,
      );
      const piecesData = [{ name: "Alpha", title: "Alpha" }];
      canonicalRegistryCell.withTx(tx).set(piecesData);

      const spaceCell = runtime.getCell<{ pieceRegistry?: unknown[] }>(
        space,
        space,
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("pieceRegistry").set(
        canonicalRegistryCell.withTx(tx),
      );
      defaultPatternCell.setMetaRaw("patternIdentity", {
        identity: "stored-default-app",
        symbol: "default",
      }, rawMetaWriteAuthorization);
      defaultPatternCell.setMetaRaw(
        "patternSource",
        "/api/patterns/system/default-app.tsx",
        rawMetaWriteAuthorization,
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        pieceRegistry: wish<unknown[]>({ query: "#pieceRegistry" }),
      }));
      const resultCell = runtime.getCell<{
        pieceRegistry?: { result?: unknown[] };
      }>(space, "wish canonical registry result", undefined, tx);
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      await result.pull();

      expect(result.key("pieceRegistry").get()?.result).toEqual(piecesData);

      const canonicalResult = result.key("pieceRegistry").key("result")
        .resolveAsCell();
      canonicalResult.withTx(tx).push({ name: "Beta", title: "Beta" });
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();
      expect(canonicalRegistryCell.get()).toEqual([
        ...piecesData,
        { name: "Beta", title: "Beta" },
      ]);
    });

    it("resolves nested paths using tag and path parameters", async () => {
      const pieceRegistryCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        pieceRegistryEntityId,
        [],
        undefined,
        tx,
      );
      const piecesData = [
        { name: "Alpha", title: "First Title" },
        { name: "Beta", title: "Second Title" },
      ];
      pieceRegistryCell.withTx(tx).set(piecesData);

      const spaceCell = runtime.getCell<{ pieceRegistry?: unknown[] }>(
        space,
        space,
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("pieceRegistry").set(
        pieceRegistryCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        const firstTitle = wish<string>({
          query: "#pieceRegistry",
          path: ["0", "title"],
        });
        return { firstTitle };
      });

      const resultCell = runtime.getCell<{
        firstTitle?: { result?: string };
      }>(
        space,
        "wish object syntax path result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      await result.pull();

      expect(result.key("firstTitle").get()?.result).toEqual("First Title");
    });

    it("resolves slashed path embedded in tag query", async () => {
      const pieceRegistryCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        pieceRegistryEntityId,
        [],
        undefined,
        tx,
      );
      const piecesData = [
        { name: "Alpha", title: "First Title" },
        { name: "Beta", title: "Second Title" },
      ];
      pieceRegistryCell.withTx(tx).set(piecesData);

      const spaceCell = runtime.getCell<{ pieceRegistry?: unknown[] }>(
        space,
        space,
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(space, "default-pattern")
        .withTx(tx);
      (defaultPatternCell as any).key("pieceRegistry").set(
        pieceRegistryCell.withTx(tx),
      );
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        const firstTitle = wish<string>({
          query: "#pieceRegistry/0/title",
        });
        return { firstTitle };
      });

      const resultCell = runtime.getCell<{
        firstTitle?: { result?: string };
      }>(
        space,
        "wish object syntax slashed query result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      await result.pull();

      expect(result.key("firstTitle").get()?.result).toEqual("First Title");
    });

    it("resolves space cell using / tag", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "wish object syntax space result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      await result.pull();

      expect(result.key("spaceResult").get()?.result).toEqual(spaceData);
    });

    it("resolves space cell subpaths using / tag with path", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      spaceCell.set({
        config: { setting: "value" },
        nested: { deep: { data: ["Alpha"] } },
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return {
          configLink: wish({ query: "/", path: ["config"] }),
          dataLink: wish({ query: "/", path: ["nested", "deep", "data"] }),
        };
      });

      const resultCell = runtime.getCell<{
        configLink?: { result?: unknown };
        dataLink?: { result?: unknown };
      }>(
        space,
        "wish object syntax space subpaths result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("configLink").get()?.result).toEqual({
        setting: "value",
      });
      expect(result.key("dataLink").get()?.result).toEqual(["Alpha"]);
    });

    it("returns current timestamp via #now tag", async () => {
      const wishPattern = pattern(() => {
        return { nowValue: wish({ query: "#now" }) };
      });

      const resultCell = runtime.getCell<{
        nowValue?: { result?: number };
      }>(
        space,
        "wish object syntax now result",
        undefined,
        tx,
      );
      const before = Date.now();
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const after = Date.now();
      const nowValue = result.key("nowValue").get()?.result;
      expect(typeof nowValue).toBe("number");
      // Coarsened to 1s resolution — floor(before) to after range
      const coarsenedBefore = Math.floor(before / 1000) * 1000;
      expect(nowValue).toBeGreaterThanOrEqual(coarsenedBefore);
      expect(nowValue).toBeLessThanOrEqual(after);
      expect(nowValue! % 1000).toBe(0);
    });

    it("returns error for unknown tag", async () => {
      const wishPattern = pattern(() => {
        const missing = wish({ query: "#unknownTag" });
        return { missing };
      });

      const resultCell = runtime.getCell<{
        missing?: { result?: unknown };
      }>(
        space,
        "wish object syntax unknown result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      // Unknown tags now search favorites, returning "No favorites found" error
      expect(missingResult?.error).toMatch(/No favorites found matching/);
    });

    it("returns error when tag is missing", async () => {
      const wishPattern = pattern(() => {
        const missing = wish({ query: "", path: ["some", "path"] });
        return { missing };
      });

      const resultCell = runtime.getCell<{
        missing?: { error?: string };
      }>(
        space,
        "wish object syntax no tag result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const missingResult = result.key("missing").get();
      expect(missingResult?.error).toMatch(/no query/);
    });

    it("returns cell UI or cf-cell-link fallback on success", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "space cell value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "wish object syntax UI success result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const wishResult = result.key("spaceResult").get() as Record<
        string | symbol,
        unknown
      >;
      expect(wishResult?.error).toBeUndefined();
      expect(wishResult?.result).toEqual(spaceData);

      // Plain data has no [UI], so falls back to cf-cell-link
      const ui = wishResult?.[UI] as { type: string; name: string; props: any };
      expect(ui?.type).toEqual("vnode");
      expect(ui?.name).toEqual("cf-cell-link");
      expect(ui?.props?.$cell).toBeDefined();
    });

    it("returns UI with error message on failure", async () => {
      const errors: unknown[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };

      try {
        const wishPattern = pattern(() => {
          const missing = wish({ query: "#unknownTag" });
          return { missing };
        });

        const resultCell = runtime.getCell<{
          missing?: { error?: string };
        }>(
          space,
          "wish object syntax UI error result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        const wishResult = result.key("missing").get() as Record<
          string | symbol,
          unknown
        >;
        // Unknown tags now search favorites, returning "No favorites found" error
        expect(wishResult?.error).toMatch(/No favorites found matching/);

        const ui = wishResult?.[UI] as {
          type: string;
          name: string;
          props: any;
          children: string;
        };
        expect(ui?.type).toEqual("vnode");
        expect(ui?.name).toEqual("span");
        expect(ui?.props?.style).toEqual("color: red");
        expect(ui?.children).toMatch(/⚠️/);
        expect(ui?.children).toMatch(/No favorites found matching/);
      } finally {
        console.error = originalError;
      }
    });

    it("returns unified shape with candidates for single result", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "unified shape test" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        const spaceResult = wish({ query: "/" });
        return { spaceResult };
      });

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown; candidates?: unknown[] };
      }>(
        space,
        "wish unified shape result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const wishResult = result.key("spaceResult").get() as Record<
        string | symbol,
        unknown
      >;
      // Unified shape: result is present
      expect(wishResult?.result).toEqual(spaceData);
      // Unified shape: candidates is present (array containing the single match)
      expect(wishResult?.candidates).toBeDefined();
      expect(Array.isArray(wishResult?.candidates)).toBe(true);
      expect((wishResult?.candidates as unknown[]).length).toBe(1);
    });
  });

  describe("scope-based wish search", () => {
    let userIdentity: Identity;
    let patternSpace: Identity;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: ReturnType<Runtime["edit"]>;
    let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
    let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

    beforeEach(async () => {
      userIdentity = await Identity.fromPassphrase("scope-test-user");
      patternSpace = await Identity.fromPassphrase("scope-pattern-space");
      storageManager = StorageManager.emulate({ as: userIdentity });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      tx = runtime.edit();

      const { commonfabric } = createTrustedBuilder(runtime);
      ({ wish, pattern } = commonfabric);
    });

    afterEach(async () => {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    });

    it('searches only mentionables with scope: ["."]', async () => {
      // Setup: Add favorites to home space (should NOT be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (should be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      // Set up backlinksIndex as a separate cell with mentionable array
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      // defaultPattern references backlinksIndex as a cell
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["."] should find only mentionable
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#test-tag", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-mentionable-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find mentionable, not favorite
      const wishResult = result.key("result").get();
      if (wishResult?.error) {
        console.log("Error in wish:", wishResult.error);
      }
      const foundItem = wishResult?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("mentionable");
    });

    it('searches only favorites with scope: ["~"]', async () => {
      // Setup: Add favorites to home space (should be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (with same tag - should NOT be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-fav",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["~"] should find only favorite
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#test-tag", scope: ["~"] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-favorites-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find favorite, not mentionable
      const wishResult = result.key("result").get();
      if (wishResult?.error) {
        console.log("Error in scope favorites test:", wishResult.error);
      }
      const foundItem = wishResult?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("favorite");
    });

    it("matches favorites by structured tags", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-structured",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item-structured",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["structured-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query: "#structured-tag", scope: ["~"] }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        "structured-tags-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      const data = (() => {
        const r = result.key("result").get()?.result;
        return (r as any)?.get?.() ?? r;
      })();
      expect(data?.type).toBe("favorite");
    });

    it("matches favorites by user tags", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-usertags",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item-usertags",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      // No schema-derived tags; only a user-applied tag should match.
      favoritesCell.set([{ cell: favoriteItem, tags: [], userTags: ["mine"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query: "#mine", scope: ["~"] }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        "favorites-usertags-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      const r = result.key("result").get()?.result;
      const data = (r as any)?.get?.() ?? r;
      expect(data?.type).toBe("favorite");
    });

    it('searches both favorites and mentionables with scope: ["~", "."]', async () => {
      // Setup: Add favorites to home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["fav-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-both",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "ment-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with scope: ["~", "."] should find favorite
      const wishPattern1 = pattern(() => {
        return { result: wish({ query: "#fav-tag", scope: ["~", "."] }) };
      });

      const resultCell1 = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-both-fav-result",
        undefined,
        tx,
      );
      const result1 = runtime.run(tx, wishPattern1, {}, resultCell1);
      await tx.commit();
      tx = runtime.edit();

      await result1.pull();

      // Verify: Should find favorite
      const foundFavorite = result1.key("result").get()?.result;
      expect(foundFavorite).toBeDefined();
      const favoriteData = (foundFavorite as any).get?.() ?? foundFavorite;
      expect(favoriteData.type).toBe("favorite");

      // Execute: Search with scope: ["~", "."] should find mentionable
      const wishPattern2 = pattern(() => {
        return { result: wish({ query: "#ment-tag", scope: ["~", "."] }) };
      });

      const resultCell2 = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "scope-both-ment-result",
        undefined,
        tx,
      );
      const result2 = runtime.run(tx, wishPattern2, {}, resultCell2);
      await tx.commit();
      tx = runtime.edit();

      await result2.pull();

      // Verify: Should find mentionable
      const foundMentionable = result2.key("result").get()?.result;
      expect(foundMentionable).toBeDefined();
      const mentData = (foundMentionable as any).get?.() ??
        foundMentionable;
      expect(mentData.type).toBe("mentionable");
    });

    it("searches favorites only by default (no scope parameter)", async () => {
      // Setup: Add favorites to home space (should be found)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add mentionables to pattern space (with same tag - should NOT be found)
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-default",
        undefined,
        tx,
      );
      const mentionableItem = runtime.getCell(
        patternSpace.did(),
        "mentionable-item",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "mentionable" };
      mentionableData[NAME] = "test-tag";
      mentionableItem.set(mentionableData);
      backlinksIndexCell.set({
        mentionable: [mentionableItem],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search without scope parameter should default to favorites only
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#test-tag" }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "default-scope-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find favorite (not mentionable) by default
      const foundItem = result.key("result").get()?.result;
      expect(foundItem).toBeDefined();
      const data = (foundItem as any).get?.() ?? foundItem;
      expect(data.type).toBe("favorite");
    });

    it("scope parameter changes error message for mentionable-only search", async () => {
      // Setup: No favorites with "nonexistent" tag
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      favoritesCell.set([]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: No mentionables with "nonexistent" tag
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
      ).withTx(tx);
      defaultPatternCell.set({
        backlinksIndex: {
          mentionable: [],
        },
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with mentionable scope only should give mentionable-specific error
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#nonexistent", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { error?: string };
      }>(
        patternSpace.did(),
        "scope-error-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Error message mentions "mentionables" not "favorites"
      const resultData = result.key("result").get();
      expect(resultData?.error).toBeDefined();
      expect(resultData?.error).toContain("mentionables");
      expect(resultData?.error).not.toContain("favorites");
    });

    it("returns error when no matches found in mentionable scope", async () => {
      // Setup: Add only favorites (no mentionables)
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tags: ["test-tag"] }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup empty mentionables in pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern",
      ).withTx(tx);
      defaultPatternCell.set({
        backlinksIndex: {
          mentionable: [],
        },
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search with mentionable scope only should fail (even though favorites has it)
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#test-tag", scope: ["."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { error?: string };
      }>(
        patternSpace.did(),
        "no-match-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should return error
      const resultData = result.key("result").get();
      expect(resultData?.error).toBeDefined();
      expect(resultData?.error).toMatch(/No mentionables found matching/i);
    });

    it('#default with scope: ["~"] resolves against home space', async () => {
      // Setup: Add default pattern to home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "home-default-pattern-tilde",
        undefined,
        tx,
      );
      homeDefaultPatternCell.set({
        title: "Home Default",
        value: "from-home",
      });
      (homeSpaceCell as any).key("defaultPattern").set(
        homeDefaultPatternCell,
      );

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add different default pattern to current space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const currentDefaultPattern = runtime.getCell(
        patternSpace.did(),
        "current-default-pattern-tilde",
        undefined,
        tx,
      );
      currentDefaultPattern.set({
        title: "Current Default",
        value: "from-current",
      });
      (spaceCell as any).key("defaultPattern").set(currentDefaultPattern);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: #default with scope: ["~"] should resolve from home space
      const wishPattern = pattern(() => {
        return {
          result: wish({
            query: "#default",
            scope: ["~"],
          }),
        };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown };
      }>(
        patternSpace.did(),
        "default-tilde-scope-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should return home space's default pattern, not current space's
      const wishResult = result.key("result").get();
      expect(wishResult?.error).toBeUndefined();
      const defaultData = wishResult?.result;
      expect(defaultData).toBeDefined();
      expect((defaultData as any)?.title).toBe("Home Default");
      expect((defaultData as any)?.value).toBe("from-home");
    });

    describe("arbitrary DID scope", () => {
      let otherSpace: Identity;

      beforeEach(async () => {
        otherSpace = await Identity.fromPassphrase("other-space-arbitrary");
      });

      it("searches mentionables in arbitrary DID space with scope: [did]", async () => {
        // Setup: Add mentionables to the "other" space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-item",
          undefined,
          tx,
        );
        const mentionableData: any = { type: "from-other-space" };
        mentionableData[NAME] = "arb-tag";
        otherMentionable.set(mentionableData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope containing the arbitrary DID
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#arb-tag",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "scope-arb-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find the mentionable from the other space
        const wishResult = result.key("result").get();
        if (wishResult?.error) {
          console.log("Error in arbitrary DID scope test:", wishResult.error);
        }
        const foundItem = wishResult?.result;
        expect(foundItem).toBeDefined();
        const data = (foundItem as any).get?.() ?? foundItem;
        expect(data.type).toBe("from-other-space");
      });

      it("reports confirmed absence in an arbitrary DID space and finds later arrivals", async () => {
        const wishPattern = pattern(() => {
          return {
            result: wish({ query: "#late-tag", scope: [otherSpace.did()] }),
          };
        });
        const resultCell = runtime.getCell<{
          result?: { result?: unknown; error?: string };
        }>(
          patternSpace.did(),
          "scope-arb-did-late-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        const arrived = Promise.withResolvers<void>();
        const stopReading = result.key("result").key("result").sink((value) => {
          if (value !== undefined) arrived.resolve();
        });
        try {
          await result.pull();
          expect(result.key("result").get()?.result).toBeUndefined();
          expect(result.key("result").get()?.error).toContain(
            "No 1 space(s) found",
          );

          const otherSpaceCell = runtime.getCell(
            otherSpace.did(),
            otherSpace.did(),
          ).withTx(tx);
          const otherDefaultPattern = runtime.getCell(
            otherSpace.did(),
            "other-late-default-pattern",
            undefined,
            tx,
          );
          const otherBacklinksIndex = runtime.getCell(
            otherSpace.did(),
            "other-late-backlinks-index",
            undefined,
            tx,
          );
          const otherMentionable = runtime.getCell(
            otherSpace.did(),
            "other-late-mentionable-item",
            undefined,
            tx,
          );
          const mentionableData: any = { type: "arrived-late" };
          mentionableData[NAME] = "late-tag";
          otherMentionable.set(mentionableData);
          otherBacklinksIndex.set({ mentionable: [otherMentionable] });
          otherDefaultPattern.set({ backlinksIndex: otherBacklinksIndex });
          (otherSpaceCell as any).key("defaultPattern").set(
            otherDefaultPattern,
          );
          expect((await tx.commit()).error).toBeUndefined();
          tx = runtime.edit();

          await arrived.promise;
          await result.pull();
          const recovered = result.key("result").get();
          expect(recovered?.error).toBeUndefined();
          const foundItem = recovered?.result;
          expect(foundItem).toBeDefined();
          const data = (foundItem as any).get?.() ?? foundItem;
          expect(data.type).toBe("arrived-late");
        } finally {
          stopReading();
        }
      });

      it('searches both current space and arbitrary DID with scope: [".", did]', async () => {
        // Setup: Add mentionables to pattern space (current space)
        const spaceCell = runtime.getCell(
          patternSpace.did(),
          patternSpace.did(),
        ).withTx(tx);
        const defaultPatternCell = runtime.getCell(
          patternSpace.did(),
          "space-default-pattern-arb",
          undefined,
          tx,
        );
        const backlinksIndexCell = runtime.getCell(
          patternSpace.did(),
          "backlinks-index-arb",
          undefined,
          tx,
        );
        const currentMentionable = runtime.getCell(
          patternSpace.did(),
          "current-mentionable",
          undefined,
          tx,
        );
        const currentData: any = { type: "from-current-space" };
        currentData[NAME] = "multi-tag";
        currentMentionable.set(currentData);
        backlinksIndexCell.set({
          mentionable: [currentMentionable],
        });
        defaultPatternCell.set({
          backlinksIndex: backlinksIndexCell,
        });
        (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

        await tx.commit();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Setup: Add mentionables to other space with same tag
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern-multi",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index-multi",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-multi",
          undefined,
          tx,
        );
        const otherData: any = { type: "from-other-space" };
        otherData[NAME] = "multi-tag";
        otherMentionable.set(otherData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: [".", otherSpace.did()]
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#multi-tag",
              scope: [".", otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown; candidates?: unknown[] };
        }>(
          patternSpace.did(),
          "scope-dot-and-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        await runtime.idle();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find matches (candidates from both spaces)
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        // The result should be defined (first match = current space due to ordering)
        expect(wishResult?.result).toBeDefined();
        const resultData = (wishResult?.result as any)?.get?.() ??
          wishResult?.result;
        // Current space match should be preferred (comes first in ordering)
        expect(resultData.type).toBe("from-current-space");
      });

      it('searches favorites and arbitrary DID with scope: ["~", did]', async () => {
        // Setup: Add favorites to home space
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultPatternCell = runtime.getCell(
          userIdentity.did(),
          "default-pattern-arb-fav",
          undefined,
          tx,
        );
        const favoritesCell = homeDefaultPatternCell.key("favorites");
        const favoriteItem = runtime.getCell(
          userIdentity.did(),
          "favorite-arb-item",
          undefined,
          tx,
        );
        favoriteItem.set({ type: "from-favorites" });
        favoritesCell.set([{ cell: favoriteItem, tags: ["combo-tag"] }]);
        (homeSpaceCell as any).key("defaultPattern").set(
          homeDefaultPatternCell,
        );

        await tx.commit();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Setup: Add mentionables to other space with same tag
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-pattern-combo",
          undefined,
          tx,
        );
        const otherBacklinksIndex = runtime.getCell(
          otherSpace.did(),
          "other-backlinks-index-combo",
          undefined,
          tx,
        );
        const otherMentionable = runtime.getCell(
          otherSpace.did(),
          "other-mentionable-combo",
          undefined,
          tx,
        );
        const otherData: any = { type: "from-other-space" };
        otherData[NAME] = "combo-tag";
        otherMentionable.set(otherData);
        otherBacklinksIndex.set({
          mentionable: [otherMentionable],
        });
        otherDefaultPattern.set({
          backlinksIndex: otherBacklinksIndex,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with scope: ["~", otherSpace.did()]
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#combo-tag",
              scope: ["~", otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown; candidates?: unknown[] };
        }>(
          patternSpace.did(),
          "scope-tilde-and-did-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        await runtime.idle();
        await runtime.storageManager.synced();
        await runtime.idle();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should find matches, favorites first
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        expect(wishResult?.result).toBeDefined();
        const resultData = (wishResult?.result as any)?.get?.() ??
          wishResult?.result;
        // Favorites match should be preferred (comes first in ordering)
        expect(resultData.type).toBe("from-favorites");
      });

      it("#default with scope: [did] returns that space's default pattern", async () => {
        // Setup: Add default pattern data to the other space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-for-target",
          undefined,
          tx,
        );
        otherDefaultPattern.set({
          title: "Other Space Default",
          value: "other",
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Also set up current space with different data (separate tx for write isolation)
        const currentSpaceCell = runtime.getCell(
          patternSpace.did(),
          patternSpace.did(),
        ).withTx(tx);
        const currentDefaultPattern = runtime.getCell(
          patternSpace.did(),
          "current-default-for-target",
          undefined,
          tx,
        );
        currentDefaultPattern.set({
          title: "Current Space Default",
          value: "current",
        });
        (currentSpaceCell as any).key("defaultPattern").set(
          currentDefaultPattern,
        );

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: #default with scope: [otherSpace.did()]
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#default",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "default-did-scope-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Should return the other space's default, not current space's
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        const defaultData = wishResult?.result;
        expect(defaultData).toBeDefined();
        expect((defaultData as any)?.title).toBe("Other Space Default");
        expect((defaultData as any)?.value).toBe("other");
      });

      it("#pieceRegistry with scope: [did] reads that space", async () => {
        // Setup: add registry data to the other space.
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-piece-registry",
          undefined,
          tx,
        );
        const otherPieceRegistry = runtime.getCell(
          otherSpace.did(),
          "other-piece-registry-data",
          undefined,
          tx,
        );
        otherPieceRegistry.set([
          { name: "Piece A" },
          { name: "Piece B" },
        ]);
        otherDefaultPattern.set({
          pieceRegistry: otherPieceRegistry,
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: #pieceRegistry with scope: [otherSpace.did()].
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#pieceRegistry",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { result?: unknown };
        }>(
          patternSpace.did(),
          "piece-registry-did-scope-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: it returns the other space's registry.
        const wishResult = result.key("result").get();
        expect(wishResult?.error).toBeUndefined();
        const pieceRegistry = wishResult?.result;
        expect(pieceRegistry).toBeDefined();
        expect(Array.isArray(pieceRegistry)).toBe(true);
        expect((pieceRegistry as any[])[0]?.name).toBe("Piece A");
      });

      it("error message includes space count for arbitrary DID scope", async () => {
        // Setup: Empty mentionables in other space
        const otherSpaceCell = runtime.getCell(
          otherSpace.did(),
          otherSpace.did(),
        ).withTx(tx);
        const otherDefaultPattern = runtime.getCell(
          otherSpace.did(),
          "other-default-error",
          undefined,
          tx,
        );
        otherDefaultPattern.set({
          backlinksIndex: {
            mentionable: [],
          },
        });
        (otherSpaceCell as any).key("defaultPattern").set(otherDefaultPattern);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Execute: Search with only an arbitrary DID scope, no matches
        const wishPattern = pattern(() => {
          return {
            result: wish({
              query: "#nonexistent",
              scope: [otherSpace.did()],
            }),
          };
        });

        const resultCell = runtime.getCell<{
          result?: { error?: string };
        }>(
          patternSpace.did(),
          "arb-did-error-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // Verify: Error message mentions space count
        const resultData = result.key("result").get();
        expect(resultData?.error).toBeDefined();
        expect(resultData?.error).toContain("1 space(s)");
        expect(resultData?.error).not.toContain("favorites");
      });
    });

    it("deduplicates results that appear in both favorites and mentionables", async () => {
      // Setup: Create a single piece cell in pattern space
      const sharedPiece = runtime.getCell(
        patternSpace.did(),
        "shared-piece",
        undefined,
        tx,
      );
      const mentionableData: any = { type: "shared" };
      mentionableData[NAME] = "shared-tag";
      sharedPiece.set(mentionableData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add piece to favorites in home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern-dedup",
        undefined,
        tx,
      );
      const favoritesCell = homeDefaultPatternCell.key("favorites");
      favoritesCell.set([{
        cell: sharedPiece.withTx(tx),
        tags: ["shared-tag"],
      }]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add same piece to mentionables in pattern space
      const spaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        patternSpace.did(),
        "space-default-pattern-dedup",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        patternSpace.did(),
        "backlinks-index-dedup",
        undefined,
        tx,
      );
      backlinksIndexCell.set({
        mentionable: [sharedPiece.withTx(tx)],
      });
      defaultPatternCell.set({
        backlinksIndex: backlinksIndexCell,
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Search both with scope: ["~", "."]
      const wishPattern = pattern(() => {
        return { result: wish({ query: "#shared-tag", scope: ["~", "."] }) };
      });

      const resultCell = runtime.getCell<{
        result?: { result?: unknown; candidates?: unknown[] };
      }>(
        patternSpace.did(),
        "scope-dedup-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should get a single result (deduplicated), not trigger picker
      const wishResult = result.key("result").get();
      expect(wishResult?.result).toBeDefined();
    });
  });

  describe("compiled pattern with object-based wish syntax", () => {
    it("keeps a typed semantic registry writable", async () => {
      const pieceRegistryCell = runtime.getCellFromEntityId<unknown[]>(
        space,
        pieceRegistryEntityId,
        [],
        undefined,
        tx,
      );
      pieceRegistryCell.withTx(tx).set([]);
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        space,
        "compiled-wish-default",
        undefined,
        tx,
      );
      defaultPatternCell.key("pieceRegistry").set(
        pieceRegistryCell.withTx(tx),
      );
      spaceCell.key("defaultPattern").set(defaultPatternCell);
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { action, pattern, wish, Writable } from 'commonfabric';",
              "interface Piece { title: string; children?: Piece[]; }",
              "export default pattern<void>(() => {",
              "  const registry = wish<Writable<Piece[]>>({",
              "    query: '#pieceRegistry',",
              "    headless: true,",
              "  }).result!;",
              "  const addPiece = action(() => registry.push({ title: 'Beta' }));",
              "  return { addPiece };",
              "});",
            ].join("\n"),
          },
        ],
      };
      const loadedPattern = await runtime.patternManager.compilePattern(
        program,
        { space },
      );
      const resultCell = runtime.getCell(
        space,
        "compiled writable registry wish result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loadedPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();

      result.key("addPiece").send({});
      await runtime.idle();

      expect(pieceRegistryCell.get()).toEqual([{ title: "Beta" }]);
    });

    it("preserves object syntax through compilation pipeline", async () => {
      // The `wish({ query: "..." })` object syntax survives pattern
      // compilation and deployment.
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      const spaceData = { testField: "compiled pattern value" };
      spaceCell.set(spaceData);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Compile a pattern that uses object-based wish syntax
      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { pattern, wish } from 'commonfabric';",
              "export default pattern<{}>(() => {",
              "  const spaceResult = wish({ query: '/' });",
              "  return { spaceResult };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const loadedPattern = await runtime.patternManager.compilePattern(
        program,
        { space },
      );

      const resultCell = runtime.getCell<{
        spaceResult?: { result?: unknown };
      }>(
        space,
        "compiled wish test result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loadedPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // The wish should resolve to the space cell data, wrapped in { result: ... }
      expect(result.key("spaceResult").get()?.result).toEqual(spaceData);
    });

    it("preserves object syntax with path through compilation", async () => {
      const spaceCell = runtime.getCell(space, space).withTx(tx);
      spaceCell.set({
        nested: { deep: { value: "found it" } },
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const program = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { pattern, wish } from 'commonfabric';",
              "export default pattern<{}>(() => {",
              "  const deepValue = wish({ query: '/', path: ['nested', 'deep', 'value'] });",
              "  return { deepValue };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const loadedPattern = await runtime.patternManager.compilePattern(
        program,
        { space },
      );

      const resultCell = runtime.getCell<{
        deepValue?: { result?: string };
      }>(
        space,
        "compiled wish path test result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loadedPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("deepValue").get()?.result).toEqual("found it");
    });
  });

  describe("cross-space wish resolution", () => {
    let userIdentity: Identity;
    let patternSpace: Identity;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: ReturnType<Runtime["edit"]>;
    let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
    let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

    beforeEach(async () => {
      userIdentity = await Identity.fromPassphrase("user-home-space");
      patternSpace = await Identity.fromPassphrase("pattern-space-1");

      // Key: storageManager.as determines home space (user identity)
      storageManager = StorageManager.emulate({ as: userIdentity });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      tx = runtime.edit();

      const { commonfabric } = createTrustedBuilder(runtime);
      ({ wish, pattern } = commonfabric);
    });

    afterEach(async () => {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    });

    it("resolves #favorites from home space when pattern runs in different space", async () => {
      // Setup: Add favorites to home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-item",
        undefined,
        tx,
      );
      favoriteItem.set({ name: "My Favorite", value: 42 });
      favoritesCell.set([
        { cell: favoriteItem, tag: "test favorite" },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Run pattern in different space (patternSpace)
      const wishPattern = pattern(() => {
        return { favorites: wish({ query: "#favorites" }) };
      });

      const resultCell = runtime.getCell<{
        favorites?: { result?: unknown[] };
      }>(
        patternSpace.did(), // Pattern runs in different space
        "wish-favorites-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Favorites resolved from home space, not pattern space
      const favorites = result.key("favorites").get()?.result;
      expect(favorites).toBeDefined();
      expect(Array.isArray(favorites)).toBe(true);
      expect((favorites as any[])[0].tag).toEqual("test favorite");
    });

    async function resolveFavoritesTerm(
      label: string,
      entry: { tags?: string[]; userTags?: string[] },
      term: string,
      options?: { value?: unknown; path?: string[] },
    ) {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        `default-pattern-${label}`,
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        `favorite-item-${label}`,
        undefined,
        tx,
      );
      favoriteItem.set(options?.value ?? { name: "My Favorite", value: 42 });
      favoritesCell.set([
        {
          cell: favoriteItem,
          tags: entry.tags ?? [],
          userTags: entry.userTags ?? [],
        },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return {
          result: wish({
            query: ["#favorites", term, ...(options?.path ?? [])].join("/"),
          }),
        };
      });
      const resultCell = runtime.getCell<{
        result?: { result?: unknown; error?: string };
      }>(
        patternSpace.did(),
        `favorites-term-${label}-result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      return result.key("result").get();
    }

    it("matches a #favorites/<term> query by a structured discovery tag", async () => {
      const resolved = await resolveFavoritesTerm(
        "tag",
        { tags: ["weather"] },
        "weather",
      );
      expect(resolved?.error).toBeUndefined();
    });

    it("matches a #favorites/<term> query by a user tag substring", async () => {
      const resolved = await resolveFavoritesTerm(
        "usertag",
        { userTags: ["mynotebook"] },
        "note",
      );
      expect(resolved?.error).toBeUndefined();
    });

    it("resolves #favorites/<term> to the matched favorite", async () => {
      const resolved = await resolveFavoritesTerm(
        "weather-value",
        { userTags: ["weather"] },
        "weather",
        { value: { name: "My Favorite", value: 42 } },
      );
      expect(resolved?.result).toEqual({
        name: "My Favorite",
        value: 42,
      });
    });

    it("resolves #favorites/<term>/<subpath> inside the matched favorite", async () => {
      const resolved = await resolveFavoritesTerm(
        "weather-subpath",
        { userTags: ["weather"] },
        "weather",
        {
          value: { name: "My Favorite", forecast: { temp: 72 } },
          path: ["forecast", "temp"],
        },
      );
      expect(resolved?.result).toBe(72);
    });

    it("reports an error for #favorites/<term> when nothing matches", async () => {
      const resolved = await resolveFavoritesTerm(
        "nomatch",
        { tags: ["weather"], userTags: ["mine"] },
        "missing",
      );
      expect(resolved?.result).toBeUndefined();
      expect(resolved?.error).toMatch(/No favorite found matching/);
    });

    async function resolveHomeTarget(
      label: string,
      key: string,
      value: unknown,
      query: string,
    ) {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        `default-pattern-${label}`,
        undefined,
        tx,
      );
      defaultPatternCell.key(key).set(value);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { result: wish({ query }) };
      });
      const resultCell = runtime.getCell<{ result?: { result?: unknown } }>(
        patternSpace.did(),
        `home-target-${label}-result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      return result.key("result").get();
    }

    it("resolves #journal to the home journal list", async () => {
      const resolved = await resolveHomeTarget(
        "journal",
        "journal",
        [{ narrative: "first entry" }],
        "#journal",
      );
      expect(resolved?.error).toBeUndefined();
      const journal = resolved?.result;
      expect(Array.isArray(journal)).toBe(true);
      expect((journal as any[])[0].narrative).toBe("first entry");
    });

    it("reports a missing requesting identity for #agent_queue", async () => {
      runtime.homeSpacePrincipalFor = () => undefined;
      const wishPattern = pattern(() => ({
        result: wish({ query: "#agent_queue" }),
      }));
      const resultCell = runtime.getCell<{
        result?: { error?: string; result?: unknown };
      }>(patternSpace.did(), "agent-queue-no-identity", undefined, tx);
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      const resolved = result.key("result").get();

      expect(resolved?.error).toContain(
        "User identity DID not available for #agent_queue",
      );
      expect(resolved?.result).toBeUndefined();
    });

    it("resolves #agent_queue to the home agent queue", async () => {
      const resolved = await resolveHomeTarget(
        "agent-queue",
        "agentQueue",
        { entries: [], agentRunner: { host: "https://local.example" } },
        "#agent_queue",
      );
      expect(resolved?.error).toBeUndefined();
      expect((resolved?.result as any)?.agentRunner?.host).toBe(
        "https://local.example",
      );
    });

    it("resolves #learned to the home learned object", async () => {
      const resolved = await resolveHomeTarget(
        "learned",
        "learned",
        { summary: "a learned summary" },
        "#learned",
      );
      expect(resolved?.error).toBeUndefined();
      expect((resolved?.result as any)?.summary).toBe("a learned summary");
    });

    it("resolves #learnedSummary to the home learned summary", async () => {
      const resolved = await resolveHomeTarget(
        "learned-summary",
        "learned",
        { summary: "Known facts" },
        "#learnedSummary",
      );
      expect(resolved?.error).toBeUndefined();
      expect(resolved?.result).toBe("Known facts");
    });

    it("resolves well-known profile targets from the home default profile link", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-space",
      )).did();
      const profileSpaceCell = runtime.getSpaceCell(
        profileSpaceDid,
        undefined,
        tx,
      );
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        bio: "Mathematician & first programmer.",
        elements: [],
      });
      profileSpaceCell.key("defaultPattern").set(profileDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return {
          profile: wish({ query: "#profile" }),
          profileName: wish({ query: "#profileName" }),
          profileAvatar: wish({ query: "#profileAvatar" }),
          profileBio: wish({ query: "#profileBio" }),
          profileSpace: wish({ query: "#profileSpace" }),
        };
      });

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-targets-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Ada Lovelace");
      expect(result.key("profileName").get()?.result).toBe("Ada Lovelace");
      expect(result.key("profileAvatar").get()?.result).toBe("ada.png");
      expect(result.key("profileBio").get()?.result).toBe(
        "Mathematician & first programmer.",
      );
      expect(result.key("profileSpace").get()?.result?.defaultPattern?.name)
        .toBe("Ada Lovelace");
    });

    it("#profile resolves to the default directly (no picker) when a default is set among multiple profiles", async () => {
      // With a default set among 2+ profiles, a non-headless `#profile` wish
      // resolves to it directly as a single result rather than launching the
      // multi-candidate picker. A picker owning `.result` would leave it
      // undefined until a selection, dead-locking every pattern that wishes
      // for "the viewer's active profile" (e.g. profile-group-chat's send
      // guard).
      // Each profile in its OWN space — space DID is the identity.
      const spaceA = (await Identity.fromPassphrase(
        "wish-profile-default-among-many-a",
      )).did();
      const profileA = runtime.getCell(spaceA, "profile-a", undefined, tx);
      profileA.set({
        name: "Default Della",
        initialNameApplied: "Default Della",
        avatar: "della.png",
        bio: "",
        elements: [],
      });
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();
      const spaceB = (await Identity.fromPassphrase(
        "wish-profile-default-among-many-b",
      )).did();
      const profileB = runtime.getCell(spaceB, "profile-b", undefined, tx);
      profileB.set({
        name: "Other Otto",
        initialNameApplied: "Other Otto",
        avatar: "otto.png",
        bio: "",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-among-many",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileA, profileB]);
      homeDefaultCell.key("defaultProfile").set(profileA);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => {
        return { profile: wish({ query: "#profile" }) };
      });

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-default-among-many-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // The direct result remains the default, while candidates retain the
      // complete roster for identity-only consumers (such as ProfileHome's
      // owner edit gate).
      const profileWish = result.key("profile").get();
      const candidates = profileWish?.candidates as
        | Array<{ name?: string }>
        | undefined;
      expect(profileWish?.result?.name).toBe("Default Della");
      expect(candidates).toHaveLength(2);
      expect(candidates?.map((profile) => profile.name))
        .toEqual(["Default Della", "Other Otto"]);
    });

    it("#profileDefault is not a well-known profile target", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-default-removed-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default-removed",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-default-removed",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profileDefault: wish({ query: "#profileDefault" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-default-removed-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("profileDefault").get()?.result).toBeUndefined();
      expect(String(result.key("profileDefault").get()?.error)).toContain(
        "#profiledefault",
      );
    });

    it("renders #profile wish UI as a link when the profile exists", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-ui-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-ui-default",
        undefined,
        tx,
      );
      profileDefaultCell.set({
        name: "Ada Lovelace",
        initialNameApplied: "Ada Lovelace",
        avatar: "ada.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-ui-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-ui-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const ui = result.key("profile").key(UI).get() as any;
      expect(ui?.name).toBe("cf-cell-link");
      expect(
        result.key("profile").key(UI).key("props").key("$cell")
          .resolveAsCell()
          .get()?.name,
      ).toBe("Ada Lovelace");
    });

    it("renders #profile wish UI as a create-profile input when the profile is missing", async () => {
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-ui",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-missing-profile-ui-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("profile").get();
      const ui = result.key("profile").key(UI).get() as any;
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
      expect(ui?.name).toBe("cf-render");
      expect(ui?.props?.["data-profile-create-ui"]).toBe("wish");
      // The cell behind that `cf-render` is filled by the deferred launch, and
      // this suite runs without net access, so what lands in it is the load
      // failure. The case below is the one that pins that.
      expect(
        JSON.stringify(
          result.key("profile").key(UI).key("props").key("$cell")
            .resolveAsCell().getRaw(),
        ),
      ).toContain("profile-create.tsx");
    });

    it("settles the create surface's launch and says so when it cannot load", async () => {
      // Two things the create surface has to get right at once. The wish sends
      // its `[UI]` — a `cf-render` over a cell only the deferred launch fills —
      // so the runtime must not report itself idle with that cell still empty,
      // or a caller settling the view is told a surface still on its way has
      // arrived. And when the launch cannot produce a pattern (here the fetch
      // is refused: this suite runs without net access), the failure must be
      // written, or the only route to a first profile is permanently blank
      // with no account of why.
      //
      // One `idle()`, no draining loop, and the cell holds the failure.
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-launch",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile" }),
      }));
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-create-launch-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();
      await runtime.idle();

      const createCell = result.key("profile").key(UI).key("props").key("$cell")
        .resolveAsCell();
      expect(JSON.stringify(createCell.key(UI).get())).toContain(
        "profile-create.tsx",
      );
    });

    it("launches nothing when the create surface answers after its demander stopped", async () => {
      // The launch is asynchronous: the surface's source is fetched, and the
      // pattern lands later. A piece stopped while that fetch is in flight
      // has no surface to render, so the answer, when it comes, launches
      // nothing and writes nothing — neither the pattern nor a failure.
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-stopped",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const held = Promise.withResolvers<Response>();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => held.promise) as typeof fetch;
      const opensBefore = wishSidecarDiagnostics.profileCreateSurfaceOpens;
      try {
        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "wish-profile-create-stopped-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        // A sink is the demand that runs the wish. `idle()` would wait on the
        // launch the run starts, and that is waiting on the fetch, so the
        // drain here is the reactive work alone.
        const stopReading = result.sink(() => {});
        await clock.settle();
        expect(wishSidecarDiagnostics.profileCreateSurfaceOpens).toBe(
          opensBefore + 1,
        );
        const createCell = result.key("profile").key(UI).key("props")
          .key("$cell").resolveAsCell();

        stopReading();
        runtime.runner.stop(resultCell);
        held.reject(new Error("the surface's source never came"));
        await runtime.idle();

        expect(createCell.key(UI).get()).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("asks the host serving the surface's space for the profile-create source", async () => {
      // A surface records a `system:` origin, which is host-relative on
      // purpose: it resolves against whichever host serves the space its piece
      // is in. The process-global pattern environment does not decide that,
      // and a worker that has not been handed one still reaches the right
      // host. The identity route is asked first, so an unchanged surface costs
      // one conditional request and no source download.
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-create-fetch-url",
        undefined,
        tx,
      );
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const recordedUrls: string[] = [];
      const originalFetch = globalThis.fetch;
      const originalEnvironment = getPatternEnvironment();
      setPatternEnvironment({ apiUrl: new URL("https://pattern-env.test/") });
      globalThis.fetch = ((input: Request | URL | string) => {
        recordedUrls.push(
          input instanceof Request ? input.url : String(input),
        );
        return Promise.resolve(new Response("not found", { status: 404 }));
      }) as typeof fetch;

      try {
        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "wish-profile-create-fetch-url-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();

        await result.pull();

        // The missing-profile UI kicks off a deferred open of the create
        // surface, which the wish registers as scheduler background work — so
        // one idle covers it and `recordedUrls`, a plain array with no sink to
        // wait on, is already written by the time idle resolves.
        await runtime.idle();
        expect(recordedUrls).toContain(
          "https://example.com/api/patterns/system/profile-create.tsx?identity=",
        );
        expect(recordedUrls.some((url) => url.includes("pattern-env.test")))
          .toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        setPatternEnvironment(originalEnvironment);
        await runtime.idle();
      }
    });

    it("searches home default profile elements for hashtag wishes with profile scope", async () => {
      const profileSpaceDid = (await Identity.fromPassphrase(
        "wish-profile-hashtag-space",
      )).did();
      const profileDefaultCell = runtime.getCell(
        profileSpaceDid,
        "profile-default-hashtag",
        undefined,
        tx,
      );
      const profileCard = runtime.getCell(
        profileSpaceDid,
        "profile-card",
        undefined,
        tx,
      );
      profileCard.set({ title: "Profile Card", kind: "card" });
      profileDefaultCell.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "",
        elements: [{
          cell: profileCard,
          tag: "#profileCard",
          userTags: ["person"],
          title: "Profile Card",
        }],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default-profile-hashtag-link",
        undefined,
        tx,
      );
      homeDefaultCell.key("profiles").set([profileDefaultCell]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        byUserTag: wish({ query: "#person", scope: ["profile"] }),
        byTag: wish({ query: "#profileCard", scope: ["profile"] }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-hashtag-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      expect(result.key("byUserTag").get()?.result?.title).toBe(
        "Profile Card",
      );
      expect(result.key("byTag").get()?.result?.kind).toBe("card");
    });

    it("resolves headless #profile to the default profile (ordered first)", async () => {
      // Each profile lives in its OWN (non-home) space — its space DID is its
      // identity. Commit per space (single-space-writer per tx).
      const p1Space = (await Identity.fromPassphrase(
        "wish-multi-profile-space-1",
      )).did();
      const p1 = runtime.getCell(p1Space, "multi-profile-1", undefined, tx);
      p1.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "ada.png",
        elements: [],
      });
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();
      const p2Space = (await Identity.fromPassphrase(
        "wish-multi-profile-space-2",
      )).did();
      const p2 = runtime.getCell(p2Space, "multi-profile-2", undefined, tx);
      p2.set({
        name: "Grace",
        initialNameApplied: "Grace",
        avatar: "grace.png",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-multi-profile-default-link",
        undefined,
        tx,
      );
      // Two profiles; the default is the *second* one — it must still resolve
      // first for headless callers.
      homeDefaultCell.key("profiles").set([p1, p2]);
      homeDefaultCell.key("defaultProfile").set(p2);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile", headless: true }),
        profileName: wish({ query: "#profileName" }),
        profileAvatar: wish({ query: "#profileAvatar" }),
      }));
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-multi-profile-default-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Grace");
      expect(result.key("profileName").get()?.result).toBe("Grace");
      expect(result.key("profileAvatar").get()?.result).toBe("grace.png");
    });

    it("orders headless #profile by MRU when no default is set", async () => {
      // Each profile in its OWN space — space DID is the identity.
      const p1Space = (await Identity.fromPassphrase(
        "wish-mru-profile-space-1",
      )).did();
      const p1 = runtime.getCell(p1Space, "mru-profile-1", undefined, tx);
      p1.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "",
        elements: [],
      });
      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();
      const p2Space = (await Identity.fromPassphrase(
        "wish-mru-profile-space-2",
      )).did();
      const p2 = runtime.getCell(p2Space, "mru-profile-2", undefined, tx);
      p2.set({
        name: "Grace",
        initialNameApplied: "Grace",
        avatar: "",
        elements: [],
      });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-mru-profile-link",
        undefined,
        tx,
      );
      // No default set; MRU lists p2 first, so p2 must resolve first.
      homeDefaultCell.key("profiles").set([p1, p2]);
      homeDefaultCell.key("mru").set([p2]);
      (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      const wishPattern = pattern(() => ({
        profile: wish({ query: "#profile", headless: true }),
      }));
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-mru-profile-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(result.key("profile").get()?.result?.name).toBe("Grace");
    });

    it("does not parse profile scope as an arbitrary DID", async () => {
      const wishPattern = pattern(() => ({
        missing: wish({ query: "#missing", scope: ["profile"] }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-profile-scope-reserved-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("missing").get();
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
      expect(String(state?.error)).not.toContain("did");
    });

    it("returns an error state instead of throwing when profile space is missing", async () => {
      const wishPattern = pattern(() => ({
        profileName: wish({ query: "#profileName" }),
      }));

      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace.did(),
        "wish-missing-profile-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      const state = result.key("profileName").get();
      expect(state?.result).toBeUndefined();
      expect(String(state?.error)).toContain("profile");
    });

    it("resolves #default from pattern space, not home space", async () => {
      // Setup: Add different #default data to home space
      const homeSpaceCell = runtime.getCell(
        userIdentity.did(),
        userIdentity.did(),
      ).withTx(tx);
      const homeDefaultCell = runtime.getCell(
        userIdentity.did(),
        "home-default",
      ).withTx(tx);
      homeDefaultCell.set({ title: "Home Default", value: "home" });
      homeSpaceCell.key("defaultPattern").set(homeDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: Add different #default data to pattern space
      const patternSpaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      const patternDefaultCell = runtime.getCell(
        patternSpace.did(),
        "pattern-default",
      ).withTx(tx);
      patternDefaultCell.set({ title: "Pattern Default", value: "pattern" });
      patternSpaceCell.key("defaultPattern").set(patternDefaultCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Run pattern in pattern space that wishes for #default
      const wishPattern = pattern(() => {
        return { defaultData: wish({ query: "#default" }) };
      });

      const resultCell = runtime.getCell<{
        defaultData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-default-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Gets pattern space's #default, not home space's
      const defaultData = result.key("defaultData").get()?.result;
      expect(defaultData).toEqual({
        title: "Pattern Default",
        value: "pattern",
      });
    });

    it("resolves mixed tags (#favorites from home, / from pattern) in single pattern", async () => {
      // Setup: Favorites in home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem = runtime.getCell(
        userIdentity.did(),
        "favorite-mixed",
        undefined,
        tx,
      );
      favoriteItem.set({ type: "favorite" });
      favoritesCell.set([{ cell: favoriteItem, tag: "mixed test" }]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Setup: /data in pattern space
      const patternSpaceCell = runtime.getCell(
        patternSpace.did(),
        patternSpace.did(),
      ).withTx(tx);
      patternSpaceCell.set({ data: { type: "pattern" } });

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Single pattern wishes for both
      const wishPattern = pattern(() => {
        return {
          favorites: wish({ query: "#favorites" }),
          patternData: wish({ query: "/", path: ["data"] }),
        };
      });

      const resultCell = runtime.getCell<{
        favorites?: { result?: unknown[] };
        patternData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-mixed-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Each resolves to correct space
      const favorites = result.key("favorites").get()?.result;
      const patternData = result.key("patternData").get()?.result;

      expect(Array.isArray(favorites)).toBe(true);
      expect((favorites as any[])[0].tag).toEqual("mixed test");
      expect(patternData).toEqual({ type: "pattern" });
    });

    it("resolves hashtag using computed query (GoogleAuthManager pattern)", async () => {
      // This test mimics GoogleAuthManager which uses computed() for the wish query
      const { commonfabric: { computed } } = createTrustedBuilder(runtime);

      // Setup: Favorites with #googleAuth tag in home space
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const authItem = runtime.getCell(
        userIdentity.did(),
        "google-auth-item",
        undefined,
        tx,
      );
      authItem.set({
        auth: {
          token: "test-token",
          user: { email: "test@gmail.com" },
          scope: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      });

      favoritesCell.set([
        { cell: authItem, tags: ["googleauth"] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern uses computed() for the query - just like GoogleAuthManager
      const wishPattern = pattern(() => {
        const tag = computed(() => "#googleAuth");
        const authResult = wish({ query: tag });
        return { authResult };
      });

      const resultCell = runtime.getCell<{
        authResult?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-computed-query-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Should find the auth item via hashtag search in home space
      const authResult = result.key("authResult").get();
      expect(authResult?.error).toBeUndefined();
      expect(authResult?.result).toBeDefined();
      expect((authResult?.result as any)?.auth?.user?.email).toEqual(
        "test@gmail.com",
      );
    });

    it("resolves hashtag search in home space favorites from different pattern space", async () => {
      // Setup: Favorites with tags in home space through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      const favoriteItem1 = runtime.getCell(
        userIdentity.did(),
        "hashtag-item-1",
        undefined,
        tx,
      );
      favoriteItem1.set({ name: "Item with #myTag" });
      const favoriteItem2 = runtime.getCell(
        userIdentity.did(),
        "hashtag-item-2",
        undefined,
        tx,
      );
      favoriteItem2.set({ name: "Different item" });

      favoritesCell.set([
        { cell: favoriteItem1, tags: ["mytag", "awesome"] },
        { cell: favoriteItem2, tags: [] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for #myTag
      const wishPattern = pattern(() => {
        return { taggedItem: wish({ query: "#myTag" }) };
      });

      const resultCell = runtime.getCell<{
        taggedItem?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-hashtag-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Searches home space favorites, finds correct cell
      const taggedItem = result.key("taggedItem").get()?.result;
      expect(taggedItem).toEqual({ name: "Item with #myTag" });
    });

    it("starts piece automatically when accessed via cross-space wish", async () => {
      // Setup 1: Create a simple piece. The actual returned shape doesn't
      // matter for this test — we only care that the piece can be started
      // and that its result is reachable through a cross-space wish.
      const counterPattern = pattern<{ count: number }>(() => {
        const count = 0;
        return { count };
      });

      // Setup 2: Store the piece in home space
      const pieceCell = runtime.getCell(
        userIdentity.did(),
        "counter-piece",
        undefined,
        tx,
      );
      // Setup the piece (but don't start it yet)
      runtime.setup(tx, counterPattern, {}, pieceCell);

      // Setup 3: Add piece to favorites through defaultPattern
      const homeSpaceCell = runtime.getHomeSpaceCell(tx);
      const defaultPatternCell = runtime.getCell(
        userIdentity.did(),
        "default-pattern",
        undefined,
        tx,
      );
      const favoritesCell = defaultPatternCell.key("favorites");
      favoritesCell.set([
        { cell: pieceCell, tags: ["counterpiece"] },
      ]);
      (homeSpaceCell as any).key("defaultPattern").set(defaultPatternCell);

      await tx.commit();
      await runtime.idle();
      tx = runtime.edit();

      // Execute: Pattern in different space wishes for the piece via hashtag
      const wishingPattern = pattern(() => {
        return { pieceData: wish({ query: "#counterPiece" }) };
      });

      const resultCell = runtime.getCell<{
        pieceData?: { result?: unknown };
      }>(
        patternSpace.did(),
        "wish-piece-result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishingPattern, {}, resultCell);
      await tx.commit();
      tx = runtime.edit();

      await result.pull();

      // Verify: Wish triggered piece to start and returns running piece data
      const pieceData = result.key("pieceData").get()?.result;
      expect(pieceData).toBeDefined();
      expect(typeof pieceData).toBe("object");
      expect(pieceData).not.toBeNull();

      // The piece should be running and have its state accessible.
      expect(pieceData).toHaveProperty("count");
    });

    describe("host embedding contract: profile wish targets", () => {
      // Host-embedding contract seam 1 (docs/features/host-embedding.md §1):
      // the well-known profile wish targets an embedder binds to, and the
      // zero-profile `result ?? fallback` idiom. This describe pins the
      // load-bearing embedder guarantees in one place; the broader profile
      // suite above covers ordering/picker/headless behavior in depth.

      it("resolves all five well-known targets from the default profile", async () => {
        const profileSpaceDid = (await Identity.fromPassphrase(
          "host-embedding-wish-profile-space",
        )).did();
        const profileDefaultCell = runtime.getCell(
          profileSpaceDid,
          "host-embedding-profile-default",
          undefined,
          tx,
        );
        profileDefaultCell.set({
          name: "Ada Lovelace",
          initialNameApplied: "Ada Lovelace",
          avatar: "ada.png",
          bio: "Mathematician & first programmer.",
          elements: [],
        });
        const profileSpaceCell = runtime.getSpaceCell(
          profileSpaceDid,
          undefined,
          tx,
        );
        profileSpaceCell.key("defaultPattern").set(profileDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          "host-embedding-home-default-link",
          undefined,
          tx,
        );
        homeDefaultCell.key("profiles").set([profileDefaultCell]);
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
          profileName: wish({ query: "#profileName" }),
          profileAvatar: wish({ query: "#profileAvatar" }),
          profileBio: wish({ query: "#profileBio" }),
          profileSpace: wish({ query: "#profileSpace" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "host-embedding-wish-targets-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        expect(result.key("profile").get()?.result?.name).toBe("Ada Lovelace");
        expect(result.key("profileName").get()?.result).toBe("Ada Lovelace");
        expect(result.key("profileAvatar").get()?.result).toBe("ada.png");
        expect(result.key("profileBio").get()?.result).toBe(
          "Mathematician & first programmer.",
        );
        expect(
          result.key("profileSpace").get()?.result?.defaultPattern?.name,
        ).toBe("Ada Lovelace");
      });

      it("leaves #profileName result undefined at zero profiles (the result ?? fallback idiom)", async () => {
        // No profile linked. A scalar target lands a WishError and `result`
        // stays undefined, so every embedder consumer must use
        // `wish.result ?? fallback` — this asserts the `undefined` half.
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          "host-embedding-home-default-empty",
          undefined,
          tx,
        );
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profileName: wish<string>({ query: "#profileName" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "host-embedding-empty-profile-name-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        const state = result.key("profileName").get();
        expect(state?.result).toBeUndefined();
        // The `?? fallback` idiom an embedder must use:
        expect(state?.result ?? "Anonymous").toBe("Anonymous");
      });

      it("renders the create surface (result undefined) for #profile at zero profiles", async () => {
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          "host-embedding-home-default-create-ui",
          undefined,
          tx,
        );
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "host-embedding-empty-profile-create-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        const state = result.key("profile").get();
        const ui = result.key("profile").key(UI).get() as any;
        expect(state?.result).toBeUndefined();
        expect(String(state?.error)).toContain("profile");
        expect(ui?.name).toBe("cf-render");
        expect(ui?.props?.["data-profile-create-ui"]).toBe("wish");
      });
    });

    describe("single-result `#profile` contract", () => {
      // `wish("#profile").result` is ALWAYS the single best profile (ordered
      // default → MRU → first) in every mode. The picker does not own
      // `.result`; it is only the `[UI]` switching affordance. These tests pin
      // the contract that Loom binds to, and are distinct from the "host
      // embedding contract" block above — do not depend on that one.

      // Stand up N profiles in one profile space, wire the home default-pattern
      // `profiles` list (and optionally `defaultProfile` / `mru`), run a
      // `#profile` wish (interactive unless `headless`), and return the wish
      // state cell so callers can read `.result` / `[UI]` and re-pull after
      // writes.
      async function setupProfiles(
        label: string,
        opts: {
          names: string[];
          defaultIndex?: number;
          // Indices into `names`, most-recently-used first.
          mruIndices?: number[];
          // Point `defaultProfile` at a cell that is not in `profiles` (an
          // invalid default link) so `defaultValid` is false.
          invalidDefault?: boolean;
          headless?: boolean;
        },
      ) {
        // Each profile lives in its OWN space (an anonymous
        // `ProfileHome.inSpace()` in production) — the profile's own space DID is
        // its stable identity. Commit per space: a single tx can only
        // open one space writer at a time.
        const profileCells: Array<ReturnType<Runtime["getCell"]>> = [];
        for (let i = 0; i < opts.names.length; i++) {
          const profileSpaceDid = (await Identity.fromPassphrase(
            `ct1829-${label}-space-${i}`,
          )).did();
          const cell = runtime.getCell(
            profileSpaceDid,
            `ct1829-${label}-profile-${i}`,
            undefined,
            tx,
          );
          cell.set({
            name: opts.names[i],
            initialNameApplied: opts.names[i],
            avatar: "",
            bio: "",
            elements: [],
          });
          await tx.commit();
          await runtime.idle();
          tx = runtime.edit();
          profileCells.push(cell);
        }

        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          `ct1829-${label}-home-default`,
          undefined,
          tx,
        );
        homeDefaultCell.key("profiles").set(profileCells);
        if (opts.invalidDefault) {
          // An invalid default link: points at a cell in the HOME space, which
          // profileCellIsValid rejects (it requires the profile live in a
          // non-home space). So `defaultValid` is false and the default is
          // ignored — the next ordering rule (MRU) applies.
          const orphan = runtime.getCell(
            userIdentity.did(),
            `ct1829-${label}-orphan-default`,
            undefined,
            tx,
          );
          orphan.set({
            name: "Orphan",
            initialNameApplied: "Orphan",
            avatar: "",
            bio: "",
            elements: [],
          });
          homeDefaultCell.key("defaultProfile").set(orphan);
        } else if (opts.defaultIndex !== undefined) {
          homeDefaultCell.key("defaultProfile").set(
            profileCells[opts.defaultIndex],
          );
        }
        if (opts.mruIndices) {
          homeDefaultCell.key("mru").set(
            opts.mruIndices.map((i) => profileCells[i]),
          );
        }
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish(
            opts.headless
              ? { query: "#profile", headless: true }
              : { query: "#profile" },
          ),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          `ct1829-${label}-result`,
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        return { result, homeDefaultCell, profileCells };
      }

      it("0 profiles → result undefined, error set, create-surface UI", async () => {
        const homeSpaceCell = runtime.getHomeSpaceCell(tx);
        const homeDefaultCell = runtime.getCell(
          userIdentity.did(),
          "ct1829-zero-home-default",
          undefined,
          tx,
        );
        (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        const wishPattern = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const resultCell = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "ct1829-zero-result",
          undefined,
          tx,
        );
        const result = runtime.run(tx, wishPattern, {}, resultCell);
        await tx.commit();
        tx = runtime.edit();
        await result.pull();

        const state = result.key("profile").get();
        const ui = result.key("profile").key(UI).get() as any;
        expect(state?.result).toBeUndefined();
        expect(String(state?.error)).toContain("profile");
        expect(ui?.props?.["data-profile-create-ui"]).toBe("wish");
      });

      it("1 profile → result = it (interactive)", async () => {
        const { result } = await setupProfiles("one-interactive", {
          names: ["Solo"],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Solo");
      });

      it("1 profile → result = it (headless)", async () => {
        const { result } = await setupProfiles("one-headless", {
          names: ["Solo"],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Solo");
      });

      it("2+ with valid default → result = default (interactive)", async () => {
        const { result } = await setupProfiles("default-interactive", {
          names: ["First", "TheDefault"],
          defaultIndex: 1,
        });
        expect(result.key("profile").get()?.result?.name).toBe("TheDefault");
      });

      it("2+ with valid default → result = default (headless)", async () => {
        const { result } = await setupProfiles("default-headless", {
          names: ["First", "TheDefault"],
          defaultIndex: 1,
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("TheDefault");
      });

      it("resolves 2+ profiles with no default to the MRU head interactively, with no empty window", async () => {
        // The orphan-second-profile case: 2 profiles, no default, MRU lists the
        // second first. `.result` rides the main wish state and resolves
        // eagerly, so the picker's sidecar — which here 404s against the test
        // apiUrl and never runs — cannot leave it undefined.
        const { result } = await setupProfiles("mru-interactive", {
          names: ["Ada", "Grace"],
          mruIndices: [1],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("2+ no default → result = MRU head (headless)", async () => {
        const { result } = await setupProfiles("mru-headless", {
          names: ["Ada", "Grace"],
          mruIndices: [1],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("2+ no default, no MRU → result = first (interactive)", async () => {
        const { result } = await setupProfiles("first-interactive", {
          names: ["Ada", "Grace"],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("2+ no default, no MRU → result = first (headless)", async () => {
        const { result } = await setupProfiles("first-headless", {
          names: ["Ada", "Grace"],
          headless: true,
        });
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("invalid default link → skipped, next rule (MRU) applies", async () => {
        // defaultProfile points at a cell not in `profiles` → defaultValid is
        // false, so the default is ignored and MRU order wins.
        const { result } = await setupProfiles("invalid-default", {
          names: ["Ada", "Grace"],
          invalidDefault: true,
          mruIndices: [1],
        });
        expect(result.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("interactive 2+ no default renders the picker sidecar as [UI]", async () => {
        const { result } = await setupProfiles("picker-ui", {
          names: ["Ada", "Grace"],
        });
        const ui = result.key("profile").key(UI).get() as any;
        expect(ui?.name).toBe("cf-render");
        expect(ui?.props?.["data-profile-picker-ui"]).toBe("wish");
        // And `.result` is populated even though the sidecar has not run.
        expect(result.key("profile").get()?.result?.name).toBe("Ada");
      });

      it("MRU write flips result (the switcher contract: selection = MRU write → result changes)", async () => {
        // Start with Ada as most-recently-used (no default) → result = Ada.
        const { result, profileCells } = await setupProfiles(
          "mru-flip",
          { names: ["Ada", "Grace"], mruIndices: [0] },
        );
        expect(result.key("profile").get()?.result?.name).toBe("Ada");

        // Simulate the picker's "Use" action: stamp Grace as most-recently-used.
        // This is the trusted picker-surface write the switcher makes — it feeds
        // the same MRU ordering the builtin reads, so `.result` (ordered[0])
        // tracks the selection rather than the picker's confirm gesture.
        const liveMru = runtime.getHomeSpaceCell(tx)
          .key("defaultPattern")
          .resolveAsCell()
          .key("mru") as any;
        liveMru.set([profileCells[1].withTx(tx)]);
        await tx.commit();
        await runtime.idle();
        tx = runtime.edit();

        // Resolve `#profile` after the selection write: ordered[0] — and thus
        // `.result` — now follows the new MRU head. (A live picker sidecar drives
        // this reactively through the scheduler graph; here we re-resolve to
        // assert the ordering contract the write feeds.)
        const wishPattern2 = pattern(() => ({
          profile: wish({ query: "#profile" }),
        }));
        const rc2 = runtime.getCell<Record<string, any>>(
          patternSpace.did(),
          "ct1829-mru-flip-after-selection",
          undefined,
          tx,
        );
        const r2 = runtime.run(tx, wishPattern2, {}, rc2);
        await tx.commit();
        tx = runtime.edit();
        await r2.pull();

        expect(r2.key("profile").get()?.result?.name).toBe("Grace");
      });

      it("picker sidecar fetch failure → result still resolves; error surfaced in picker UI", async () => {
        // Fail every request for the picker's source, so opening its surface
        // cannot answer. `.result` does not ride the sidecar cell, so it must
        // still resolve to ordered[0]; the failure is surfaced as an error
        // inside the picker `[UI]` cell, not as an unhandled rejection.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((input: Request | URL | string) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes("profile-picker.tsx")) {
            return Promise.reject(new Error("picker fetch boom"));
          }
          return Promise.resolve(new Response("not found", { status: 404 }));
        }) as typeof fetch;

        try {
          const { result } = await setupProfiles("picker-fail", {
            names: ["Ada", "Grace"],
          });
          // `.result` still resolves to the single best profile.
          expect(result.key("profile").get()?.result?.name).toBe("Ada");

          // The picker sidecar cell surfaces the failure: opening the surface
          // reports the rejection and resolves to undefined, so the
          // undefined-pattern branch commits an error UI into the picker cell.
          const pickerCell = result.key("profile").key(UI).key("props")
            .key("$cell").resolveAsCell();
          // The picker launch is scheduler background work, so one settle
          // covers the rejected request and the error UI it commits.
          await runtime.settled();
          expect(pickerCell.key(UI).get()).toBeDefined();
        } finally {
          globalThis.fetch = originalFetch;
          await runtime.idle();
        }
      });

      describe("cross-space id skew", () => {
        // In real deployments each profile lives in its OWN space (an
        // anonymous `ProfileHome.inSpace()`), and the `mru` / `defaultProfile`
        // link and the `profiles` candidate for the SAME profile point at
        // DIFFERENT cells WITHIN that profile's space — same space, DIFFERENT
        // entity id (the picker stores the profile pattern's result cell; the
        // list stores the pattern cell). Neither `Cell.equals` nor an id-based
        // comparison matches them: either would return false for every
        // candidate, silently collapsing the ordering to `profiles`-list
        // (creation) order and making the switcher a no-op cross-space. The
        // builtin matches by the profile's own SPACE (the stable per-profile
        // identity), so the id difference does not defeat the match. Live
        // data has this shape: mru[0].space == profiles[1].space for the same
        // profile, while the ids differ.

        // Stand up N profiles, each in its OWN space (real cross-space), wire the
        // home `profiles` list from the profiles' CANONICAL cells, and write
        // `mru` / `defaultProfile` as links pointing at a DIFFERENT cell in the
        // SAME profile space (a distinct entity id) — the production shape under
        // which id/equals comparison returns false for the same profile.
        async function setupCrossSpace(
          label: string,
          opts: {
            names: string[];
            // Indices into `names`, most-recently-used first.
            mruIndices?: number[];
            // Index into `names` to set as default.
            defaultIndex?: number;
          },
        ) {
          // Each profile in a DISTINCT space; commit per space (a single tx can
          // only open one space writer at a time). We create TWO cells per
          // profile space: the canonical profile cell (goes in `profiles`) and a
          // sibling "alias" cell with a DIFFERENT id but the SAME `name` (what the
          // mru/default links point at) — mirroring production's list-cell vs
          // picker-result-cell id divergence within one profile space.
          const profileSpaces: string[] = [];
          const profileCells: Array<ReturnType<Runtime["getCell"]>> = [];
          const aliasLinks: Array<
            ReturnType<
              ReturnType<Runtime["getCell"]>["getAsNormalizedFullLink"]
            >
          > = [];
          for (let i = 0; i < opts.names.length; i++) {
            const spaceDid = (await Identity.fromPassphrase(
              `ct1842-${label}-space-${i}`,
            )).did();
            profileSpaces.push(spaceDid);
            const value = {
              name: opts.names[i],
              initialNameApplied: opts.names[i],
              avatar: "",
              bio: "",
              elements: [],
            };
            const cell = runtime.getCell(
              spaceDid,
              `ct1842-${label}-profile-${i}`,
              undefined,
              tx,
            );
            cell.set(value);
            // Sibling cell in the SAME space, DIFFERENT id — the mru/default link
            // target.
            const alias = runtime.getCell(
              spaceDid,
              `ct1842-${label}-profile-${i}-alias`,
              undefined,
              tx,
            );
            alias.set(value);
            await tx.commit();
            await runtime.idle();
            tx = runtime.edit();
            profileCells.push(cell);
            aliasLinks.push(alias.getAsNormalizedFullLink());
          }

          // A sigil link to the SIBLING cell (same profile space, different id) —
          // the shape a cross-space `mru` / `defaultProfile` entry resolves to in
          // production.
          const aliasSigil = (i: number) => ({
            "/": {
              [LINK_V1_TAG]: {
                id: aliasLinks[i].id,
                space: aliasLinks[i].space,
                path: [],
                scope: aliasLinks[i].scope,
              },
            },
          });

          const homeSpaceCell = runtime.getHomeSpaceCell(tx);
          const homeDefaultCell = runtime.getCell(
            userIdentity.did(),
            `ct1842-${label}-home-default`,
            undefined,
            tx,
          );
          homeDefaultCell.key("profiles").set(profileCells);
          if (opts.mruIndices) {
            homeDefaultCell.key("mru").setRawUntyped(
              // deno-lint-ignore no-explicit-any
              opts.mruIndices.map((i) => aliasSigil(i)) as any,
            );
          }
          if (opts.defaultIndex !== undefined) {
            homeDefaultCell.key("defaultProfile").setRawUntyped(
              // deno-lint-ignore no-explicit-any
              aliasSigil(opts.defaultIndex) as any,
            );
          }
          // deno-lint-ignore no-explicit-any
          (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);

          await tx.commit();
          await runtime.idle();
          tx = runtime.edit();

          const wishPattern = pattern(() => ({
            profile: wish({ query: "#profile", headless: true }),
          }));
          const resultCell = runtime.getCell<Record<string, any>>(
            patternSpace.did(),
            `ct1842-${label}-result`,
            undefined,
            tx,
          );
          const result = runtime.run(tx, wishPattern, {}, resultCell);
          await tx.commit();
          tx = runtime.edit();
          await result.pull();
          return { result };
        }

        it("resolves the MRU head cross-space despite different-id mru links", async () => {
          // Two profiles in two spaces, no default. MRU lists the SECOND-created
          // profile first, via a link whose entity id differs from the candidate's
          // (but shares the profile space). Id/equals matching would reject every
          // mru↔candidate pair, ordering would fall back to creation order, and
          // `.result` would be first-created (Ada). Space-based matching gives
          // `.result` = MRU head (Grace).
          const { result } = await setupCrossSpace("mru-id-skew", {
            names: ["Ada", "Grace"],
            mruIndices: [1],
          });
          expect(result.key("profile").get()?.result?.name).toBe("Grace");
        });

        it("resolves the default cross-space despite a different-id default link", async () => {
          // defaultProfile points at the SECOND profile via a different-id link.
          // A default match by `defaultCell.equals(candidate)` would fail the
          // same way and ignore the default; space-based matching resolves to
          // the chosen default.
          const { result } = await setupCrossSpace("default-id-skew", {
            names: ["Ada", "Grace"],
            defaultIndex: 1,
          });
          expect(result.key("profile").get()?.result?.name).toBe("Grace");
        });

        it("default outranks MRU even under id skew", async () => {
          // Default = Ada (index 0), MRU head = Grace (index 1), both different-id.
          // Default must win.
          const { result } = await setupCrossSpace("default-over-mru-id-skew", {
            names: ["Ada", "Grace"],
            defaultIndex: 0,
            mruIndices: [1],
          });
          expect(result.key("profile").get()?.result?.name).toBe("Ada");
        });
      });
    });
  });
});

describe("parseWishTarget", () => {
  it("parses absolute paths starting with /", () => {
    const result = parseWishTarget("/pieceRegistry");
    expect(result).toEqual({ key: "/", path: ["pieceRegistry"] });
  });

  it("parses nested absolute paths", () => {
    const result = parseWishTarget("/pieceRegistry/0/title");
    expect(result).toEqual({
      key: "/",
      path: ["pieceRegistry", "0", "title"],
    });
  });

  it("parses hash tag targets", () => {
    const result = parseWishTarget("#favorites");
    expect(result).toEqual({ key: "#favorites", path: [] });
  });

  it("parses hash tag targets with path", () => {
    const result = parseWishTarget("#favorites/list/0");
    expect(result).toEqual({ key: "#favorites", path: ["list", "0"] });
  });

  it("trims whitespace", () => {
    const result = parseWishTarget("  /pieceRegistry  ");
    expect(result).toEqual({ key: "/", path: ["pieceRegistry"] });
  });

  it("filters empty segments", () => {
    const result = parseWishTarget("/pieceRegistry//nested/");
    expect(result).toEqual({
      key: "/",
      path: ["pieceRegistry", "nested"],
    });
  });

  it("throws on empty string", () => {
    expect(() => parseWishTarget("")).toThrow('Wish target "" is empty');
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseWishTarget("   ")).toThrow("is empty");
  });

  it("throws on unrecognized path format", () => {
    expect(() => parseWishTarget("noSlashOrHash")).toThrow("is not recognized");
  });

  it("throws on hash-only target", () => {
    expect(() => parseWishTarget("#")).toThrow("is not recognized");
  });
});

describe("interval #now wish", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("#now one-shot is coarsened to 1s", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "coarsened now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // Coarsened to 1s — must be divisible by 1000
    expect(nowValue! % 1000).toBe(0);
  });

  it("#now one-shot remains stable across reruns", async () => {
    const triggerCell = runtime.getCell<number>(
      space,
      "one-shot trigger",
      undefined,
      tx,
    );
    triggerCell.set(0);

    const wishPattern = pattern(() => {
      triggerCell.get();
      return { nowValue: wish({ query: "#now" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "stable one-shot result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const first = result.key("nowValue").get()?.result;
    expect(typeof first).toBe("number");

    await clock.tick(1100);
    triggerCell.withTx(tx).set(1);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const second = result.key("nowValue").get()?.result;
    expect(second).toBe(first);
  });

  it("#now one-shot keeps its first-ever capture across re-instantiation", async () => {
    const wishPattern = pattern(() => ({ nowValue: wish({ query: "#now" }) }));
    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "durable one-shot result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const first = result.key("nowValue").get()?.result;
    expect(typeof first).toBe("number");

    // Stop and re-instantiate the pattern into the same result cell — a fresh
    // wish-action closure, exactly what a piece stop/start or a reload in another
    // runtime produces — after crossing the 1s coarsening boundary.
    runtime.runner.stop(resultCell);
    await clock.tick(1100);

    const result2 = runtime.run(tx, wishPattern, {}, resultCell.withTx(tx));
    await tx.commit();
    tx = runtime.edit();

    await result2.pull();
    const second = result2.key("nowValue").get()?.result;
    // Durable: the re-instantiation reads the first-ever captured time from the
    // per-instance cell instead of re-reading the clock, so it does not jump.
    expect(second).toBe(first);
  });

  it("#now/5 returns a cell coarsened to a 5s boundary", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/5" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "interval now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // 5 seconds — coarsened to a 5000ms boundary
    expect(nowValue! % 5000).toBe(0);
  });

  it("#now/1 ticks at the 1s minimum", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "min now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // 1 second is the 1000ms minimum
    expect(nowValue! % 1000).toBe(0);
  });

  it("#now/0 throws WishError (below minimum)", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/0" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "zero now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("between 1 and 86400 seconds");
  });

  it("#now/60 values are coarsened to a 60s boundary", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/60" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "60s now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // 60 seconds — coarsened to a 60000ms boundary
    expect(nowValue! % 60000).toBe(0);
  });

  it("#now/86400 is accepted (24h maximum)", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/86400" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "max now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowValue = result.key("nowValue").get()?.result;
    expect(typeof nowValue).toBe("number");
    // 86400 seconds = 24h, coarsened to an 86_400_000ms boundary
    expect(nowValue! % 86_400_000).toBe(0);
  });

  it("#now/86401 throws WishError (above maximum)", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/86401" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "over-max now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("between 1 and 86400 seconds");
  });

  it("#now/abc throws WishError", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/abc" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "invalid now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("whole number of seconds");
  });

  it("#now/5.5 throws WishError (non-integer rejected)", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/5.5" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "fractional now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("whole number of seconds");
  });

  it("#now/1e3 throws WishError (exponent rejected)", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1e3" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "exponent now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("whole number of seconds");
  });

  it("#now/-1 throws WishError", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/-1" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "negative now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("whole number of seconds");
  });

  it("#now/Infinity throws WishError", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/Infinity" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "infinity now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("whole number of seconds");
  });

  it("#now/5/extra throws WishError", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/5/extra" }) };
    });

    const resultCell = runtime.getCell<{
      nowValue?: { result?: unknown; error?: string };
    }>(
      space,
      "extra path now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const nowState = result.key("nowValue").get();
    expect(nowState?.error).toBeDefined();
    expect(nowState?.error).toContain("is not recognized");
  });

  it("#now interval timer is cleaned up on stop", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "cleanup now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Stop the runner for this cell — should clear the timer without errors
    runtime.runner.stop(resultCell);

    // With the interval cleared, the runtime drains to idle. A leftover timer
    // would auto-advance forever and hang here instead.
    await runtime.idle();
  });
});

describe("tagMatchesHashtag", () => {
  it("matches exact hashtag in tag string", () => {
    expect(tagMatchesHashtag("#todo items", "todo")).toBe(true);
  });

  it("does not match partial hashtag", () => {
    expect(tagMatchesHashtag("#todolist", "todo")).toBe(false);
  });

  it("matches among multiple hashtags", () => {
    expect(tagMatchesHashtag("some #alpha and #beta text", "beta")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(tagMatchesHashtag("#Todo", "todo")).toBe(true);
  });

  it("returns false for undefined tag", () => {
    expect(tagMatchesHashtag(undefined, "todo")).toBe(false);
  });

  it("returns false for empty tag", () => {
    expect(tagMatchesHashtag("", "todo")).toBe(false);
  });

  it("ignores non-hashtag text", () => {
    expect(tagMatchesHashtag("todo without hash", "todo")).toBe(false);
  });

  it("matches hashtag at start of string", () => {
    expect(tagMatchesHashtag("#pattern for dinner", "pattern")).toBe(true);
  });

  it("includes underscores in the hashtag", () => {
    expect(tagMatchesHashtag("#todo_list", "todo_list")).toBe(true);
    expect(tagMatchesHashtag("#todo_list", "todo")).toBe(false);
  });

  it("ends the hashtag at a hyphen", () => {
    expect(tagMatchesHashtag("#todo-list", "todo")).toBe(true);
    expect(tagMatchesHashtag("#todo-list", "todo-list")).toBe(false);
  });

  it("matches hashtags written in non-Latin scripts", () => {
    expect(tagMatchesHashtag("一篇 #日本語 笔记", "日本語")).toBe(true);
    expect(tagMatchesHashtag("café au #café", "café")).toBe(true);
  });
});

describe("openSidecarSurface", () => {
  // A surface whose piece the runtime opens through a stubbed reconciler: what
  // is under test here is when a slot opens its surface and what it does with
  // the answer, not how a source origin resolves.
  const SURFACE = { name: "profile-create.tsx", origin: "system:x.tsx" };

  const makeFakeRuntime = (
    open: (piece: unknown, origin: string) => Promise<unknown>,
  ) => ({ sourceReconciler: { open } }) as unknown as Runtime;

  const piece = {} as Cell<unknown>;

  it("opens a surface once and reuses what that answered", async () => {
    const opened: string[] = [];
    const runtime = makeFakeRuntime((_piece, origin) => {
      opened.push(origin);
      return Promise.resolve({ marker: "surface" });
    });
    const slot: SidecarSurfaceState = {};

    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toEqual({ marker: "surface" });
    expect(openedSidecarSurface(slot)).toEqual({ marker: "surface" });
    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toEqual({ marker: "surface" });
    expect(opened).toEqual(["system:x.tsx"]);
  });

  it("joins an open already in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return gate.then(() => ({ marker: "surface" }));
    });
    const slot: SidecarSurfaceState = {};

    const first = openSidecarSurface(runtime, slot, piece, SURFACE);
    const second = openSidecarSurface(runtime, slot, piece, SURFACE);
    // Nothing is opened yet, so the second launch has no answer to reuse and
    // must wait on the one already asking.
    expect(openedSidecarSurface(slot)).toBeUndefined();
    release();

    expect(await first).toEqual({ marker: "surface" });
    expect(await second).toEqual({ marker: "surface" });
    expect(opens).toBe(1);
  });

  it("opens again after a failure when the surface retries", async () => {
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return Promise.resolve(opens === 1 ? undefined : { marker: "surface" });
    });
    const slot: SidecarSurfaceState = {};

    expect(
      await openSidecarSurface(runtime, slot, piece, SURFACE, {
        retryOnFailure: true,
      }),
    ).toBeUndefined();
    expect(
      await openSidecarSurface(runtime, slot, piece, SURFACE, {
        retryOnFailure: true,
      }),
    ).toEqual({ marker: "surface" });
    expect(opens).toBe(2);
  });

  it("keeps a failure for a surface that does not retry", async () => {
    // The suggestion surface's policy: it is an addition to a view that
    // already works, so a launch that could not open it does not ask again.
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return Promise.resolve(undefined);
    });
    const slot: SidecarSurfaceState = {};

    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toBeUndefined();
    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toBeUndefined();
    expect(opens).toBe(1);
  });

  it("answers with the replacement when the epoch ends mid-open", async () => {
    // The pattern an open answers with is minted in the registry epoch that
    // compiled it. An open still in flight when that epoch ends is answering
    // about a dead one, so its caller is handed what the open that replaced
    // it says — not a pattern whose schema references nothing can resolve,
    // and not a failure over a surface still on its way.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return opens === 1
        ? gate.then(() => ({ marker: "stale" }))
        : Promise.resolve({ marker: "fresh" });
    });
    const slot: SidecarSurfaceState = {};

    const lease = acquireSchemaRegistryLease();
    const stale = openSidecarSurface(runtime, slot, piece, SURFACE);
    lease();

    const fresh = openSidecarSurface(runtime, slot, piece, SURFACE);
    expect(await fresh).toEqual({ marker: "fresh" });

    release();
    expect(await stale).toEqual({ marker: "fresh" });
    expect(openedSidecarSurface(slot)).toEqual({ marker: "fresh" });
    expect(opens).toBe(2);
  });

  it("asks again when the epoch ends under an open nobody replaced", async () => {
    // The epoch can end with no second launch behind it — a lease released
    // while the only open is still in flight. Nothing has replaced that open,
    // and its pattern is dead all the same, so what makes it ask again is the
    // epoch rather than another open having taken its place.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return opens === 1
        ? gate.then(() => ({ marker: "stale" }))
        : Promise.resolve({ marker: "fresh" });
    });
    const slot: SidecarSurfaceState = {};

    const lease = acquireSchemaRegistryLease();
    const opening = openSidecarSurface(runtime, slot, piece, SURFACE);
    lease();
    release();

    expect(await opening).toEqual({ marker: "fresh" });
    expect(openedSidecarSurface(slot)).toEqual({ marker: "fresh" });
    expect(opens).toBe(2);
  });

  it("drops an opened pattern when the schema registry epoch clears", async () => {
    // A compiled pattern's serialized graph embeds `cid:` schema references
    // minted in the registry epoch that compiled it, and both backings die
    // with the epoch — the registry clears on last-lease-out, and the compile
    // context's space belongs to that session. A pattern handed across the
    // clear would stage links whose references nothing can resolve (the
    // emission gate throws on exactly that), so the surface is opened again
    // and its pattern minted into the epoch that will use it.
    let opens = 0;
    const runtime = makeFakeRuntime(() => {
      opens += 1;
      return Promise.resolve({ marker: `surface-${opens}` });
    });
    const slot: SidecarSurfaceState = {};

    const release = acquireSchemaRegistryLease();
    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toEqual({ marker: "surface-1" });
    expect(openedSidecarSurface(slot)).toEqual({ marker: "surface-1" });

    release();
    expect(
      openedSidecarSurface(slot),
      "a compiled pattern outlived the registry epoch that minted its " +
        "schema references",
    ).toBeUndefined();

    expect(await openSidecarSurface(runtime, slot, piece, SURFACE))
      .toEqual({ marker: "surface-2" });
    expect(opens).toBe(2);
  });
});
