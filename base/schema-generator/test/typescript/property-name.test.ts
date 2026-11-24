import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { getPropertyNameText } from "../../src/typescript/property-name.ts";
import { createTestProgramFromFiles } from "../utils.ts";

const FILES = {
  "/keys.d.ts":
    `declare module "@commonfabric/keys" { export const UI: string; }`,
  "/other.d.ts": `declare module "other-keys" { export const UI: string; }`,
  "/test.ts": `
import { UI } from "@commonfabric/keys";
import { UI as OtherUI } from "other-keys";
declare const NAME: unique symbol;
declare const SELF: string;
declare namespace __cfHelpers { const FS: unique symbol; const OTHER: unique symbol; }
const literalKey = "lit";
interface Keys {
  [__cfHelpers.FS]: 0;
  [__cfHelpers.OTHER]: 9;
  [UI]: 1;
  [OtherUI]: 2;
  [NAME]: 3;
  [SELF]: 4;
  [literalKey]: 5;
  [Missing]: 6;
  plain: 7;
}
class Holder {
  #hidden = 8;
}
`,
};

/** Each member name the interface `Keys` and the class `Holder` write. */
async function memberNames() {
  const { checker, sourceFile } = await createTestProgramFromFiles(
    FILES,
    "/test.ts",
  );
  const names = new Map<string, ts.PropertyName>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) && !ts.isClassDeclaration(statement)
    ) continue;
    for (const member of statement.members) {
      names.set(member.name!.getText(), member.name!);
    }
  }
  return { checker, names };
}

describe("property-name", () => {
  describe("getPropertyNameText()", () => {
    it("returns the text of a written name", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("plain")!, checker)).toBe("plain");
      expect(getPropertyNameText(names.get("[literalKey]")!, checker)).toBe(
        "lit",
      );
    });

    it("returns a Common Fabric key's text for a key Common Fabric declares or a unique symbol of its name", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("[UI]")!, checker)).toBe("$UI");
      expect(getPropertyNameText(names.get("[NAME]")!, checker)).toBe(
        "$NAME",
      );
    });

    it("returns a Common Fabric key's text for a key the helpers name, and `undefined` for another of their members", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("[__cfHelpers.FS]")!, checker))
        .toBe("$FS");
      expect(getPropertyNameText(names.get("[__cfHelpers.OTHER]")!, checker))
        .toBeUndefined();
    });

    it("returns `undefined` for a key of a Common Fabric name that is neither", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("[OtherUI]")!, checker))
        .toBeUndefined();
      expect(getPropertyNameText(names.get("[SELF]")!, checker))
        .toBeUndefined();
    });

    it("returns `undefined` for a key naming nothing declared", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("[Missing]")!, checker))
        .toBeUndefined();
    });

    it("returns `undefined` for a private name", async () => {
      const { checker, names } = await memberNames();

      expect(getPropertyNameText(names.get("#hidden")!, checker))
        .toBeUndefined();
    });
  });
});
