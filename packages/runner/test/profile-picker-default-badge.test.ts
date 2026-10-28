import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { seedProfileOwner } from "./cfc-seed-envelope.ts";
import { click, elementsLabeled, textLeaves } from "./support/vnode-text.ts";

// Runs the shipped `profile-picker.tsx` and reads the badge it renders per
// row. Each profile lives in its own space, as `ProfileHome.inSpace()` puts
// it, and the home's `defaultProfile` holds a link to one of them under
// `profile` — the shape the home Profile tab shows. The row for the default
// must say "default"; every other row offers "Set default". A default chosen
// before the slot, which Home names by its space (`legacyDefaultProfileSpace`),
// is the default while the slot holds none, and with no slot bound no row
// offers "Set default". Each profile is labeled as its owner's, as one its owner
// set up is. Every row but the one `#profile` returns offers Remove, which asks
// to be confirmed: that row is the default's, or, with no default, the most
// recently used profile's, or the first row's. The picker's lists are its own
// argument's rather than Home's, so a confirmed Remove retires nothing here;
// profile-retire.test.ts retires through a picker over Home's lists. A retired
// profile gets no row of its own, and is listed among the removed profiles with
// a Restore.
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

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

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

/** The badge text of each profile row: "default" or "Set default". */
function rowBadges(ui: unknown): string[] {
  return textLeaves(ui).filter((leaf) =>
    leaf === "default" || leaf === "Set default"
  );
}

/** How many rows offer Remove, which is one per profile listed. */
function removeOffers(ui: unknown): number {
  return textLeaves(ui).filter((leaf) => leaf.trim() === "Remove…").length;
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

  /**
   * Runs a picker over profiles `a` and `b`, given the profile the slot names
   * (`"none"` for an empty slot, `"unbound"` for no slot), the profile an
   * earlier default names, if any, the profiles retired, and the
   * profiles in the MRU list, most recent first, and returns its result and
   * the cell holding its retired list.
   */
  async function startPicker(
    cause: string,
    defaultProfile: "a" | "b" | "none" | "unbound",
    legacyDefaultProfile?: "a" | "b",
    retired: readonly ("a" | "b")[] = [],
    mru: readonly ("a" | "b")[] = [],
  ): Promise<{
    result: Cell<Record<string, unknown>>;
    retiredList: Cell<unknown>;
  }> {
    let tx = rt.edit();
    const ada = rt.getCell(spaceA, "profile", undefined, tx);
    ada.set({ name: "Ada", initialNameApplied: "Ada" });
    seedProfileOwner(tx, ada.getAsNormalizedFullLink(), home);
    await tx.commit().settled;
    tx = rt.edit();
    const alan = rt.getCell(spaceB, "profile", undefined, tx);
    alan.set({ name: "Alan", initialNameApplied: "Alan" });
    seedProfileOwner(tx, alan.getAsNormalizedFullLink(), home);
    await tx.commit().settled;

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
      pattern,
      {
        profiles: [a, b],
        ...(defaultProfile === "unbound" ? { offersSetDefault: false } : {
          defaultProfile: defaultProfile === "a"
            ? { profile: a }
            : defaultProfile === "b"
            ? { profile: b }
            : {},
        }),
        ...(legacyDefaultProfile === undefined ? {} : {
          legacyDefaultProfileSpace: legacyDefaultProfile === "a"
            ? spaceA
            : spaceB,
        }),
        mru: mru.map((each) => each === "a" ? a : b),
        retiredProfiles: retired.map((each) => each === "a" ? a : b),
      },
      resultCell,
    );
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await rt.idle();
    await result.pull();
    const retiredList = result.getArgumentCell()?.key("retiredProfiles");
    if (retiredList === undefined) throw new Error("The picker has no input.");
    return { result, retiredList };
  }

  /** The rendered view of the picker `result`. */
  function view(result: Cell<Record<string, unknown>>): unknown {
    return result.key("$UI").get();
  }

  /**
   * The badges of a picker over profiles `a` and `b`, and how many rows offer
   * Remove, as `startPicker()` takes its arguments.
   */
  async function renderPicker(
    cause: string,
    defaultProfile: "a" | "b" | "none" | "unbound",
    legacyDefaultProfile?: "a" | "b",
    retired: readonly ("a" | "b")[] = [],
  ): Promise<{ badges: string[]; removes: number }> {
    const { result } = await startPicker(
      cause,
      defaultProfile,
      legacyDefaultProfile,
      retired,
    );
    try {
      const ui = view(result);
      return { badges: rowBadges(ui), removes: removeOffers(ui) };
    } finally {
      rt.runner.stop(result);
    }
  }

  /** The spaces of the profiles `retiredList` holds, in order. */
  function spacesIn(retiredList: Cell<unknown>): string[] {
    return (retiredList.asSchema(linkListSchema).get() ?? []).map((link) =>
      link.getAsNormalizedFullLink().space
    );
  }

  it("lights the badge on the row of the default profile only", async () => {
    // The default on the SECOND row: an identity mix-up between rows, or a
    // comparison that matches every row, both fail here.
    expect((await renderPicker("picker badge default b", "b")).badges).toEqual([
      "Set default",
      "default",
    ]);
  });

  it("lights the first row when it is the default", async () => {
    expect((await renderPicker("picker badge default a", "a")).badges).toEqual([
      "default",
      "Set default",
    ]);
  });

  it("offers Set default on every row when no default is set", async () => {
    expect((await renderPicker("picker badge no default", "none")).badges)
      .toEqual([
        "Set default",
        "Set default",
      ]);
  });

  it("lights the row of the legacy default while the slot holds none", async () => {
    expect(
      (await renderPicker("picker badge legacy default b", "none", "b"))
        .badges,
    ).toEqual(["Set default", "default"]);
  });

  it("lights the row of the slot's default over the legacy one", async () => {
    expect(
      (await renderPicker("picker badge slot over legacy", "a", "b")).badges,
    ).toEqual(["default", "Set default"]);
  });

  it("offers Remove on every row but the first when no default is set and none was used", async () => {
    expect((await renderPicker("picker removes", "none")).removes).toBe(1);
  });

  it("lists no row for a retired profile, and offers no Remove on the last live one", async () => {
    const shown = await renderPicker("picker retired a", "none", undefined, [
      "a",
    ]);

    expect(shown.badges).toEqual(["Set default"]);
    expect(shown.removes).toBe(0);
  });

  it("lists no row for a retired default", async () => {
    const shown = await renderPicker("picker retired default", "b", undefined, [
      "b",
    ]);

    expect(shown.badges).toEqual(["Set default"]);
    expect(shown.removes).toBe(0);
  });

  it("asks to confirm a row's Remove, and retires nothing from lists no Home owns once it is confirmed", async () => {
    // The retirement decides by Home's own lists, so it refuses the picker's
    // own arguments; profile-retire.test.ts retires through a picker over
    // Home's lists.
    const { result, retiredList } = await startPicker("picker remove", "none");
    try {
      await click(rt, elementsLabeled(view(result), "Remove…")[0]);
      await result.pull();
      expect(elementsLabeled(view(result), "Remove profile")).toHaveLength(1);
      expect(spacesIn(retiredList)).toEqual([]);

      await click(rt, elementsLabeled(view(result), "Remove profile")[0]);
      await result.pull();
      expect(spacesIn(retiredList)).toEqual([]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("offers Remove on the first row, and not the most recently used one's, when no default is set", async () => {
    const { result, retiredList } = await startPicker(
      "picker remove mru",
      "none",
      undefined,
      [],
      ["b"],
    );
    try {
      expect(removeOffers(view(result))).toBe(1);
      expect(spacesIn(retiredList)).toEqual([]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("offers no Remove on the default's row", async () => {
    expect((await renderPicker("picker remove default", "b")).removes).toBe(1);
  });

  it("lists a retired profile among the removed ones, and restores it with Restore", async () => {
    const { result, retiredList } = await startPicker(
      "picker restore",
      "none",
      undefined,
      ["a"],
    );
    try {
      expect(textLeaves(view(result)).map((leaf) => leaf.trim())).toContain(
        "Removed profiles",
      );
      expect(removeOffers(view(result))).toBe(0);

      await click(rt, elementsLabeled(view(result), "Restore")[0]);
      await result.pull();
      expect(spacesIn(retiredList)).toEqual([]);
      expect(removeOffers(view(result))).toBe(1);
      expect(textLeaves(view(result)).map((leaf) => leaf.trim())).not
        .toContain("Removed profiles");
    } finally {
      rt.runner.stop(result);
    }
  });

  it("offers no Set default when no slot is bound", async () => {
    expect(
      (await renderPicker("picker badge legacy only", "unbound", "b")).badges,
    ).toEqual(["default"]);
  });
});
