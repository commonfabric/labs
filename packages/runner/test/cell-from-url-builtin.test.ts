import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { parseLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("test cellFromUrl builtin");
const space = signer.did();

const HOSTS = ["fabric.example"];

describe("cellFromUrl builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let causeCounter = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;
  });

  /** Resolve a URL through the builtin and return the link its `cell` holds. */
  async function resolve(
    url: string,
    hosts?: string[],
    spaceHost?: string,
  ): Promise<
    {
      pending: unknown;
      id: string | undefined;
      path?: readonly unknown[];
      scope?: string;
    }
  > {
    const builtin = byRef("cellFromUrl");
    const testPattern = pattern<{ url: string }>(
      ({ url }) =>
        builtin({
          url,
          ...(hosts ? { hosts } : {}),
          ...(spaceHost ? { spaceHost } : {}),
        }),
    );

    const resultCell = runtime.getCell(
      space,
      `cell-from-url-${causeCounter++}`,
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const pending = result.key("pending").get();

    // `result.key("cell")` reads the link to the builtin's own sub-cell; the
    // answer is the link that sub-cell HOLDS, one hop further in.
    const slot = result.key("cell");
    const slotRaw = slot.getRaw();
    if (slotRaw === undefined) return { pending, id: undefined };

    const sub = runtime.getCellFromLink(parseLink(slotRaw, slot)!);
    const held = sub.getRaw();
    const link = held === undefined ? undefined : parseLink(held, sub);
    return {
      pending,
      id: link?.id as string | undefined,
      path: link?.path,
      scope: link?.scope,
    };
  }

  /** A cell in this space, and the id a URL would have to name to reach it. */
  function anExistingCell(): string {
    const cell = runtime.getCell<{ value: string }>(
      space,
      "cell-from-url-target",
      undefined,
      tx,
    );
    return cell.getAsNormalizedFullLink().id as string;
  }

  it("resolves a rooted link to the cell it names", async () => {
    const id = anExistingCell();
    const { pending, id: resolved } = await resolve(`/${id}`);

    expect(pending).toBe(false);
    expect(resolved).toBe(id);
  });

  it("selects an arguments document before traversing its path", async () => {
    const result = runtime.getCell(space, "member-result", undefined, tx);
    const argument = runtime.getCell(space, "member-argument", undefined, tx);
    result.setMetaRaw(
      "argument",
      argument.getAsLink(),
      rawMetaWriteAuthorization,
    );
    const id = result.getAsNormalizedFullLink().id;
    const selected = await resolve(`//${space}/${id}#argument/title/`);
    expect(selected.id).toBe(argument.getAsNormalizedFullLink().id);
    expect(selected.path).toEqual(["title", ""]);
    expect(selected.scope).toBe("space");
  });

  it("returns no cell for a missing argument member and preserves explicit scope", async () => {
    const id = anExistingCell();
    expect((await resolve(`/${id}#argument`)).id).toBeUndefined();
    const selected = await resolve(`/${id}@user/title`);
    expect(selected.id).toBe(id);
    expect(selected.scope).toBe("user");
    expect(selected.path).toEqual(["title"]);
  });

  it("resolves a bare tagged hash to the same cell", async () => {
    const id = anExistingCell();
    const { id: resolved } = await resolve(id.replace(/^of:/, ""));

    expect(resolved).toBe(id);
  });

  it("resolves a page URL on a configured host", async () => {
    const id = anExistingCell();
    const { id: resolved } = await resolve(
      `https://fabric.example/${space}/${id}`,
      HOSTS,
    );

    expect(resolved).toBe(id);
  });

  it("registers an explicit toolshed before resolving a cross-space address", async () => {
    const id = anExistingCell();
    const routes: Array<[string, string]> = [];
    runtime.registerSpaceHost = (routedSpace, host) => {
      routes.push([routedSpace, host]);
      return true;
    };

    const { id: resolved } = await resolve(
      `//${space}/${id}`,
      undefined,
      "https://remote.example",
    );

    expect(resolved).toBe(id);
    expect(routes).toEqual([[space, "https://remote.example"]]);
  });

  it("returns no cell when an explicit toolshed conflicts with the fixed route", async () => {
    const id = anExistingCell();
    runtime.registerSpaceHost = () => false;

    const { id: resolved } = await resolve(
      `//${space}/${id}`,
      undefined,
      "https://remote.example",
    );

    expect(resolved).toBeUndefined();
  });

  it("resolves a slug to the document that redirects to the piece", async () => {
    const { id: resolved } = await resolve(
      `https://fabric.example/${space}/my-note`,
      HOSTS,
    );

    expect(resolved).toBe(`of:${slugIdForSpace(space, "my-note")}`);
  });

  it("resolves an ordinary web page to no cell", async () => {
    const { pending, id } = await resolve("https://example.com/blog/post");

    expect(pending).toBe(false);
    expect(id).toBeUndefined();
  });

  it("resolves a page URL on an unconfigured host to no cell", async () => {
    const id = anExistingCell();
    const { id: resolved } = await resolve(
      `https://elsewhere.example/${space}/${id}`,
      HOSTS,
    );

    expect(resolved).toBeUndefined();
  });

  it("resolves a URL naming an unknown space to no cell", async () => {
    // A space named rather than addressed resolves only from the runtime's
    // cache. Until it is there, the honest answer is that this names no cell
    // — not a cell in whichever space happened to be asking.
    const id = anExistingCell();
    const { pending, id: resolved } = await resolve(
      `https://fabric.example/some-space-name/${id}`,
      HOSTS,
    );

    expect(pending).toBe(false);
    expect(resolved).toBeUndefined();
  });

  for (const destination of ["invalid URL", "missing argument member"]) {
    it(`clears a resolved cell after selecting ${destination}`, async () => {
      // Reading through the stored link returns `undefined` for an empty target,
      // so a guard on that would leave the previous URL's answer in place.
      const id = anExistingCell();
      const url = runtime.getCell<string>(space, "cell-from-url-input", {
        type: "string",
      }, tx);
      url.withTx(tx).set(`/${id}`);

      const builtin = byRef("cellFromUrl");
      const testPattern = pattern<{ url: string }>(({ url }) =>
        builtin({ url })
      );
      const resultCell = runtime.getCell(
        space,
        "cell-from-url-clear",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { url }, resultCell);
      tx.commit();
      tx = runtime.edit();
      await result.pull();
      expect(result.key("cell").getRaw()).toBeDefined();
      const slot = result.key("cell");
      const sub = runtime.getCellFromLink(parseLink(slot.getRaw(), slot)!);
      expect(parseLink(sub.getRaw(), sub)?.id).toBe(id);

      const edit = runtime.edit();
      url.withTx(edit).set(
        destination === "invalid URL"
          ? "https://example.com/not-a-cell"
          : `/${id}#argument`,
      );
      edit.commit();
      await result.pull();

      expect(sub.getRaw()).toBeUndefined();
    });
  }

  it("resolves prose to no cell", async () => {
    expect((await resolve("just some words")).id).toBeUndefined();
  });
});
