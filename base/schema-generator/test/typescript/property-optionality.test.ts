import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { isDefaultNodeWithUndefined } from "../../src/typescript/property-optionality.ts";
import { createTestProgram } from "../utils.ts";

describe("property-optionality", () => {
  describe("isDefaultNodeWithUndefined()", () => {
    /** The annotation of each member of the interface `Probes`, by name. */
    async function annotations() {
      const { checker, sourceFile } = await createTestProgram(`
        type Default<T, V = T> = T;
        type Other<T> = T;
        interface Probes {
          maybe: Default<string | undefined, "x">;
          always: Default<string, "x">;
          bare: Default;
          other: Other<string | undefined>;
        }
      `);
      const probes = sourceFile.statements.find((
        statement,
      ): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === "Probes"
      )!;
      const nodes = new Map<string, ts.TypeNode>();
      for (const member of probes.members.filter(ts.isPropertySignature)) {
        nodes.set(member.name.getText(), member.type!);
      }
      return { checker, nodes };
    }

    it("returns `true` for a `Default` whose type holds `undefined`", async () => {
      const { checker, nodes } = await annotations();

      expect(isDefaultNodeWithUndefined(nodes.get("maybe"), checker)).toBe(
        true,
      );
    });

    it("returns `false` for a `Default` whose type does not hold `undefined`, and for one without type arguments", async () => {
      // A `Default` written without type arguments is an error the checker
      // reports; it still parses as a reference.
      const { checker, nodes } = await annotations();

      expect(isDefaultNodeWithUndefined(nodes.get("always"), checker)).toBe(
        false,
      );
      expect(isDefaultNodeWithUndefined(nodes.get("bare"), checker)).toBe(
        false,
      );
    });

    it("returns `false` for a reference of another name", async () => {
      const { checker, nodes } = await annotations();

      expect(isDefaultNodeWithUndefined(nodes.get("other"), checker)).toBe(
        false,
      );
    });
  });
});
