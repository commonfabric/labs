import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "captured-binding-across-versions",
);
const space = signer.did();

/**
 * A pattern whose rows each capture a writer-protected `tags` list, made with
 * `.for(tagsCause)`. Two versions that differ only in that cause name two
 * different cells for the same binding.
 */
function program(tagsCause: string) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
        import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
        const add = handler<{ add: string }, { items: Writable<string[]> }>(
          (event, { items }) => {
            items.set([...items.get(), event.add]);
          },
        );
        const editTags = handler<{ tag: string }, { tags: Writable<string[]> }>(
          (event, { tags }) => {
            tags.set([...tags.get(), event.tag]);
          },
        );
        type Tags = WriteAuthorizedBy<string[], typeof editTags>;
        export default pattern<Record<string, never>>(() => {
          const items = new Writable<string[]>([]).for("items");
          const tags = new Writable<Tags>([]).for("${tagsCause}");
          return {
            items,
            tags,
            rows: items.map((item) => ({ item, tag: editTags({ tags }) })),
            add: add({ items }),
          };
        });
      `,
    }],
  };
}

/**
 * A pattern that passes a writer-protected `tags` list, made with
 * `.for(tagsCause)`, to a sub-pattern it composes, and re-exports the
 * sub-pattern's view of it.
 */
function composing(tagsCause: string) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
        import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
        const edit = handler<{ add: string }, { tags: Writable<string[]> }>(
          (event, { tags }) => {
            tags.set([...tags.get(), event.add]);
          },
        );
        type Tags = WriteAuthorizedBy<string[], typeof edit>;
        const Child = pattern<{ list: Writable<Tags> }, { list: Writable<Tags> }>(
          ({ list }) => ({ list }),
        );
        export default pattern<Record<string, never>>(() => {
          const tags = new Writable<Tags>([]).for("${tagsCause}");
          const child = Child({ list: tags });
          return { tags, childList: child.list, add: edit({ tags }) };
        });
      `,
    }],
  };
}

describe("captured-binding-across-versions", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  /**
   * Sets up the first version over two rows, then sets up a version whose
   * captured cell is made with `.for(cause)`, and returns the second setup's
   * refusal and every error the scheduler reported after it.
   */
  async function upgradeTo(cause: string) {
    const errors: string[] = [];
    runtime.scheduler.onError((error) => errors.push(String(error)));
    const v1 = await runtime.patternManager.compilePattern(program("tags"));
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      v1,
      {},
      runtime.getCell(space, "output", v1.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();
    result.key("add").send({ add: "a" });
    await runtime.idle();
    result.key("add").send({ add: "b" });
    await runtime.idle();
    await manager.synced();
    expect(errors).toEqual([]);

    const v2 = await runtime.patternManager.compilePattern(program(cause));
    const upgrade = runtime.edit();
    runtime.run(
      upgrade,
      v2,
      {},
      runtime.getCell(space, "output", v2.resultSchema, upgrade),
    );
    runtime.prepareTxForCommit(upgrade);
    const setupError = (await upgrade.commit()).error?.message;
    await runtime.idle();
    await manager.synced();
    cancel();
    return { setupError, errors };
  }

  it("re-stages each row's capture under a version that makes the captured cell the same way", async () => {
    const { setupError, errors } = await upgradeTo("tags");

    expect(setupError).toBeUndefined();
    expect(errors).toEqual([]);
  });

  // Whether a trusted setup may re-point a captured slot when a pattern
  // version names another cell for the same binding is open. Until it is
  // settled, the slot keeps the cell it was first given, and re-pointing it
  // is refused, as it is for a binding passed to a composed sub-pattern.
  it("refuses to re-point each row's capture under a version that makes the captured cell another way", async () => {
    const { setupError, errors } = await upgradeTo("labels");

    expect(setupError).toBeUndefined();
    expect(errors).not.toEqual([]);
    for (const error of errors) {
      expect(error).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /params/tags",
      );
    }
  });

  it("re-points a composed sub-pattern's binding under a version that makes the passed cell another way", async () => {
    // Unlike a list builtin's capture, a binding a setup passes to a
    // sub-pattern it composes follows the cell the version names.
    const errors: string[] = [];
    runtime.scheduler.onError((error) => errors.push(String(error)));
    const v1 = await runtime.patternManager.compilePattern(composing("tags"));
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      v1,
      {},
      runtime.getCell(space, "composed", v1.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();
    result.key("add").send({ add: "a" });
    await runtime.idle();
    await manager.synced();

    const v2 = await runtime.patternManager.compilePattern(
      composing("labels"),
    );
    const upgrade = runtime.edit();
    runtime.run(
      upgrade,
      v2,
      {},
      runtime.getCell(space, "composed", v2.resultSchema, upgrade),
    );
    runtime.prepareTxForCommit(upgrade);
    expect((await upgrade.commit()).error).toBeUndefined();
    await runtime.idle();
    await manager.synced();
    result.key("add").send({ add: "after" });
    await runtime.idle();
    await manager.synced();

    expect(await result.key("tags").pull()).toEqual(["after"]);
    expect(await result.key("childList").pull()).toEqual(["after"]);
    expect(errors).toEqual([]);
    cancel();
  });
});
