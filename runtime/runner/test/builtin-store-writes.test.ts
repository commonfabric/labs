/**
 * A builtin names the stores it keeps when its node is set up, and the node's
 * action declares each as a write at every scope before the action first runs.
 * Each case below captures the action's write surface at registration, runs
 * the node, and checks the declaration against the store the builtin then
 * actually wrote.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { isRawBuiltinResult, raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("builtin store writes");
const space = (await Identity.fromPassphrase("builtin store writes space"))
  .did();

const TAG = "builtin_store_writes_profile";

/** A piece whose `found` is a wish for the viewer's favorite tagged `TAG`. */
const WISH_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { found: unknown }>(() => {",
      `  const found = wish<{ name: string }>({ query: "#${TAG}", scope: ["~"] });`,
      "  return { found };",
      "});",
    ].join("\n"),
  }],
};

describe("builtin-store-writes", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    storage = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
  });

  /**
   * Re-registers the builtin `ref` so that each action it registers has its
   * write surface recorded at registration, before the action first runs.
   * The builtin itself is the registered one, unchanged.
   */
  function observeSurfaces(
    ref: string,
    options?: Parameters<typeof raw>[1],
  ): IMemorySpaceAddress[][] {
    const surfaces: IMemorySpaceAddress[][] = [];
    // deno-lint-ignore no-explicit-any
    const registered = runtime.moduleRegistry.getModule(ref) as any;
    const implementation = registered.implementation;
    runtime.moduleRegistry.addModuleByRef(
      ref,
      raw(
        // deno-lint-ignore no-explicit-any
        (...args: any[]): any => {
          const built = implementation(...args);
          if (!isRawBuiltinResult(built)) return built;
          return {
            ...built,
            onActionRegistered: (action: Action) => {
              surfaces.push(runtime.scheduler.getMightWrite(action) ?? []);
              built.onActionRegistered?.(action);
            },
          };
        },
        options,
      ),
    );
    return surfaces;
  }

  /** The link the document at `link` holds, one hop further in. */
  async function hop(link: NormalizedFullLink): Promise<NormalizedFullLink> {
    const cell = runtime.getCellFromLink(link);
    await cell.pull();
    return parseLink(cell.getRaw(), cell)!;
  }

  /** The scopes at which `surface` declares the document `link` lives in. */
  function declaredScopes(
    surface: IMemorySpaceAddress[],
    link: NormalizedFullLink,
  ): string[] {
    return surface
      .filter((address) =>
        address.space === link.space && address.id === link.id
      )
      .map((address) => address.scope ?? "space")
      .sort();
  }

  it("declares a wish's state store at every scope before the wish first runs", async () => {
    const surfaces = observeSurfaces("wish");
    const home = signer.did() as MemorySpace;
    const seed = runtime.edit();
    const favorite = runtime.getCell(home, "favorite", undefined, seed);
    favorite.set({ name: "the favorite" });
    runtime.getCell(home, home, undefined, seed).set({
      defaultPattern: { favorites: [{ cell: favorite, tags: [TAG] }] },
    });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(
      WISH_PROGRAM,
      { space, tx },
    );
    const result = runtime.getCell<{ found: unknown }>(
      space,
      "builtin store writes wish",
      undefined,
      tx,
    );
    runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.key("found").sink(() => {});
    try {
      await runtime.idle();
      await result.pull();

      // `found` is the wish node's output slot, and the slot holds the link
      // to the state the wish wrote.
      const state = await hop(
        parseLink(result.key("found").getRaw(), result)!,
      );
      expect(state.scope).toBe("user");
      expect(surfaces).toHaveLength(1);
      expect(declaredScopes(surfaces[0], state)).toEqual([
        "session",
        "space",
        "user",
      ]);
    } finally {
      cancel();
    }
  });

  it("declares both of a cellFromUrl node's stores before it first runs", async () => {
    const surfaces = observeSurfaces("cellFromUrl");
    const { commonfabric } = createTrustedBuilder(runtime);
    const builtin = commonfabric.byRef("cellFromUrl");
    const testPattern = commonfabric.pattern<{ url: string }>(
      ({ url }) => builtin({ url, hosts: ["fabric.example"] }),
    );
    const tx = runtime.edit();
    const result = runtime.getCell(
      space,
      "builtin store writes cellFromUrl",
      undefined,
      tx,
    );
    runtime.run(tx, testPattern, { url: "https://example.com/" }, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();

    expect(surfaces).toHaveLength(1);
    for (const key of ["pending", "cell"] as const) {
      const slot = result.key(key) as Cell<unknown>;
      const store = parseLink(slot.getRaw(), slot)!;
      expect(declaredScopes(surfaces[0], store)).toEqual([
        "session",
        "space",
        "user",
      ]);
    }
  });

  it("declares no store for a builtin that names none", async () => {
    let declared: IMemorySpaceAddress[] | undefined;
    runtime.moduleRegistry.addModuleByRef(
      "builtinStoreWritesNone",
      raw((
        _inputs: Cell<unknown>,
        sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
      ) => ({
        action: (tx: IExtendedStorageTransaction) => sendResult(tx, 1),
        onActionRegistered: (action) => {
          declared = runtime.scheduler.getMightWrite(action);
        },
      })),
    );
    const { commonfabric } = createTrustedBuilder(runtime);
    const builtin = commonfabric.byRef("builtinStoreWritesNone");
    const testPattern = commonfabric.pattern(() => builtin({}));
    const tx = runtime.edit();
    const result = runtime.getCell(
      space,
      "builtin store writes none",
      undefined,
      tx,
    );
    runtime.run(tx, testPattern, {}, result);
    expect((await tx.commit().settled).error).toBeUndefined();

    // Only the node's own output slot: one document, at one scope.
    expect(new Set(declared!.map((address) => address.id)).size).toBe(1);
    expect(declared).toHaveLength(1);
  });

  it("leaves an effect's named stores out of its action's writes", async () => {
    // An effect takes no write surface, so nothing reads these writes as a
    // declaration; the action's own annotation, which diagnostics print,
    // lists none of them either.

    const store = runtime.getCell(space, "builtin store writes effect store")
      .getAsNormalizedFullLink();
    let annotated: readonly NormalizedFullLink[] | undefined;
    runtime.moduleRegistry.addModuleByRef(
      "builtinStoreWritesEffect",
      raw(() => ({
        action: () => {},
        isEffect: true,
        storeWrites: [store],
        onActionRegistered: (action) => {
          annotated = (action as { writes?: NormalizedFullLink[] }).writes;
        },
      })),
    );
    const { commonfabric } = createTrustedBuilder(runtime);
    const builtin = commonfabric.byRef("builtinStoreWritesEffect");
    const testPattern = commonfabric.pattern(() => builtin({}));
    const tx = runtime.edit();
    const result = runtime.getCell(
      space,
      "builtin store writes effect",
      undefined,
      tx,
    );
    runtime.run(tx, testPattern, {}, result);
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(annotated).toBeDefined();
    expect(annotated!.filter((link) => link.id === store.id)).toEqual([]);
  });
});
