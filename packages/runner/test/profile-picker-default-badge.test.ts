import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

// Runs the shipped `profile-picker.tsx` and reads the badge it renders per
// row. Each profile lives in its own space, as `ProfileHome.inSpace()` puts
// it, and the home's `defaultProfile` holds a link to one of them under
// `profile` — the shape the home Profile tab shows. The row for the default
// must say "default"; every other row offers "Set default".
//
// The pin exists because the badge compared the default link against the map
// callback's element parameter, which inside a `computed` is the opaque
// reference and carries no link, so no row ever matched: a user who clicked
// "Set default" kept seeing "Set default", reload or not (2026-09-11).

const signer = await Identity.fromPassphrase("profile-picker default badge");
const home = signer.did();
const spaceA = (await Identity.fromPassphrase("profile-picker badge profile a"))
  .did();
const spaceB = (await Identity.fromPassphrase("profile-picker badge profile b"))
  .did();

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (name: string) => Deno.readTextFileSync(sysDir + name);
const PROGRAM: RuntimeProgram = {
  main: "/profile-picker.tsx",
  files: [
    { name: "/profile-picker.tsx", contents: read("profile-picker.tsx") },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

/** The string leaves of a rendered VNode tree, in document order. */
function textLeaves(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 40 || node === null || node === undefined) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textLeaves(child, out, depth + 1);
    return out;
  }
  if (typeof node === "object" && "children" in node) {
    textLeaves((node as { children: unknown }).children, out, depth + 1);
  }
  return out;
}

/** The badge text of each profile row: "default" or "Set default". */
function rowBadges(ui: unknown): string[] {
  return textLeaves(ui).filter((leaf) =>
    leaf === "default" || leaf === "Set default"
  );
}

describe("profile-picker default badge", () => {
  let manager: EmulatedStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });
  afterEach(async () => {
    await rt.dispose({ closeStorage: false });
    await manager.close();
  });

  async function renderPicker(
    cause: string,
    defaultProfile: "a" | "b" | undefined,
  ): Promise<string[]> {
    let tx = rt.edit();
    rt.getCell(spaceA, "profile", undefined, tx).set({
      name: "Ada",
      initialNameApplied: "Ada",
    });
    await tx.commit();
    tx = rt.edit();
    rt.getCell(spaceB, "profile", undefined, tx).set({
      name: "Alan",
      initialNameApplied: "Alan",
    });
    await tx.commit();

    tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(PROGRAM, {
      space: home,
      tx,
    });
    const a = rt.getCell(spaceA, "profile", undefined, tx);
    const b = rt.getCell(spaceB, "profile", undefined, tx);
    const resultCell = rt.getCell<Record<string, unknown>>(
      home,
      cause,
      undefined,
      tx,
    );
    const result = rt.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      {
        profiles: [a, b],
        defaultProfile: defaultProfile === "a"
          ? { profile: a }
          : defaultProfile === "b"
          ? { profile: b }
          : {},
        mru: [],
      },
      resultCell,
    );
    rt.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await result.pull();
    await rt.idle();
    await result.pull();
    try {
      // deno-lint-ignore no-explicit-any
      return rowBadges(result.key("$UI" as any).get());
    } finally {
      rt.runner.stop(resultCell);
    }
  }

  it("lights the badge on the row of the default profile only", async () => {
    // The default on the SECOND row: an identity mix-up between rows, or a
    // comparison that matches every row, both fail here.
    expect(await renderPicker("picker badge default b", "b")).toEqual([
      "Set default",
      "default",
    ]);
  });

  it("lights the first row when it is the default", async () => {
    expect(await renderPicker("picker badge default a", "a")).toEqual([
      "default",
      "Set default",
    ]);
  });

  it("offers Set default on every row when no default is set", async () => {
    expect(await renderPicker("picker badge no default", undefined)).toEqual([
      "Set default",
      "Set default",
    ]);
  });
});
