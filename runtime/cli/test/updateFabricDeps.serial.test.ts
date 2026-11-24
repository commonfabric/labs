import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { slugIdForSpace } from "@commonfabric/runner/slugs";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { updateFabricDeps } from "../commands/deps.ts";

const signer = await Identity.fromPassphrase("updateFabricDeps");
const space = signer.did();
const ENTRY = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("updateFabricDeps()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let dir: string;
  let written: string;
  let writeSync: typeof Deno.stdout.writeSync;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    dir = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "update-fabric-deps-" }),
    );
    written = "";
    writeSync = Deno.stdout.writeSync;
    Deno.stdout.writeSync = (bytes) => {
      written += new TextDecoder().decode(bytes);
      return bytes.length;
    };
  });

  afterEach(async () => {
    Deno.stdout.writeSync = writeSync;
    await Deno.remove(dir, { recursive: true });
    await runtime.dispose();
    await storageManager.close();
  });

  /** Opens `space` in the test's runtime, as a command's load would. */
  const load = () => Promise.resolve({ runtime, getSpace: () => space });
  const config = { apiUrl: "http://localhost:1", space, identity: "" };

  /** Points `slug` at a piece whose pattern identity is {@link ENTRY}. */
  async function writePatternSlug(slug: string): Promise<void> {
    const piece = runtime.getCell(space, { space, random: `piece-${slug}` });
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "piece" });
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        piece.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  /** A main file importing a sibling, which imports `cf:dep` and `cf:other`. */
  async function writeProgram(): Promise<{ main: string; schemas: string }> {
    const main = join(dir, "main.tsx");
    const schemas = join(dir, "schemas.tsx");
    await Deno.writeTextFile(
      main,
      `import { s } from "./schemas.tsx";\nexport default s;\n`,
    );
    await Deno.writeTextFile(
      schemas,
      `import dep from "cf:dep";\nimport other from "cf:other";\n` +
        `export const s = [dep, other];\n`,
    );
    return { main, schemas };
  }

  it("pins every import in the program's files and names each pin", async () => {
    await writePatternSlug("dep");
    await writePatternSlug("other");
    const { main, schemas } = await writeProgram();

    await updateFabricDeps(config, main, {}, load);

    expect(await Deno.readTextFile(schemas)).toBe(
      `import dep from "cf:dep@${ENTRY}";\n` +
        `import other from "cf:other@${ENTRY}";\n` +
        `export const s = [dep, other];\n`,
    );
    expect(await Deno.readTextFile(main)).toBe(
      `import { s } from "./schemas.tsx";\nexport default s;\n`,
    );
    expect(written).toBe(
      `${schemas}:1 pinned cf:dep -> @${ENTRY}\n` +
        `${schemas}:2 pinned cf:other -> @${ENTRY}\n`,
    );
  });

  it("pins only the import `import` names", async () => {
    await writePatternSlug("dep");
    const { main, schemas } = await writeProgram();

    await updateFabricDeps(config, main, { import: "cf:dep" }, load);

    expect(await Deno.readTextFile(schemas)).toBe(
      `import dep from "cf:dep@${ENTRY}";\nimport other from "cf:other";\n` +
        `export const s = [dep, other];\n`,
    );
    expect(written).toBe(`${schemas}:1 pinned cf:dep -> @${ENTRY}\n`);
  });

  it("throws with `check` when a pin would change, and writes nothing", async () => {
    await writePatternSlug("dep");
    await writePatternSlug("other");
    const { main, schemas } = await writeProgram();
    const before = await Deno.readTextFile(schemas);

    await expect(updateFabricDeps(config, main, { check: true }, load))
      .rejects.toThrow(
        "fabric dependencies are not pinned; run cf deps update",
      );

    expect(await Deno.readTextFile(schemas)).toBe(before);
    expect(written).toContain(`${schemas}:1 pinned cf:dep -> @${ENTRY}`);
  });

  it("passes with `check` when every pin names the current entry", async () => {
    await writePatternSlug("dep");
    const main = join(dir, "main.tsx");
    const source = `import dep from "cf:dep@${ENTRY}";\nexport default dep;\n`;
    await Deno.writeTextFile(main, source);

    await updateFabricDeps(config, main, { check: true }, load);

    expect(await Deno.readTextFile(main)).toBe(source);
    expect(written).toBe("");
  });
});
