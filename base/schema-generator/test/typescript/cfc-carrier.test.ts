import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  carrierStampsOf,
  isCfcCarrierMember,
} from "../../src/typescript/cfc-carrier.ts";
import { createTestProgram } from "../utils.ts";

const DECLARATIONS = `
  type CfcStamp<T, Meta> = { readonly meta?: Meta; readonly of?: T };
  type CfcTag<T, Meta, Stamp = CfcStamp<T, Meta>> = [T] extends [unknown]
    ? { readonly __ct_cfc__?: Stamp } | Extract<T, null | undefined>
    : { readonly __ct_cfc__?: Stamp } | Extract<T, null | undefined>;
  type OtherTag<T> = [T] extends [unknown] ? { readonly other?: T } : never;
  namespace Authored {
    // An author's alias of the tag's name whose branch carries a payload
    // field beside the carrier member.
    export type CfcTag<T> = [T] extends [unknown]
      ? { readonly __ct_cfc__?: unknown; readonly payload: T }
      : { readonly __ct_cfc__?: unknown; readonly payload: T };
  }
  interface Probes<T> {
    deferred: CfcTag<T, { confidentiality: ["x"] }>;
    other: OtherTag<T>;
    authored: Authored.CfcTag<T>;
    carrier: { readonly __ct_cfc__?: { readonly meta?: ["x"] } };
    beside: { readonly __ct_cfc__?: unknown; readonly name: string };
  }
`;

/**
 * The type of each member of `Probes<T>`, read while `T` is a parameter, and
 * the checker that read them.
 */
async function probes(): Promise<
  { types: Map<string, ts.Type>; checker: ts.TypeChecker }
> {
  const { checker, sourceFile } = await createTestProgram(DECLARATIONS);
  const probe = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "Probes"
  ) as ts.InterfaceDeclaration;
  const types = new Map(
    probe.members.filter(ts.isPropertySignature).map((member) => [
      (member.name as ts.Identifier).text,
      checker.getTypeFromTypeNode(member.type!),
    ]),
  );
  return { types, checker };
}

describe("cfc-carrier", () => {
  describe("isCfcCarrierMember", () => {
    it("returns `true` for the carrier member and for the `CfcTag` the checker defers", async () => {
      const { types } = await probes();

      expect(isCfcCarrierMember(types.get("carrier")!)).toBe(true);
      expect(isCfcCarrierMember(types.get("deferred")!)).toBe(true);
    });

    it("returns `false` for another deferred conditional and for an object holding more than the carrier", async () => {
      const { types } = await probes();

      expect(isCfcCarrierMember(types.get("other")!)).toBe(false);
      expect(isCfcCarrierMember(types.get("beside")!)).toBe(false);
    });

    it("returns `false` for an alias of the tag's name whose branch holds a payload field", async () => {
      expect(isCfcCarrierMember((await probes()).types.get("authored")!))
        .toBe(false);
    });
  });

  describe("carrierStampsOf", () => {
    it("returns the stamp the deferred `CfcTag` is given, its metadata and its payload", async () => {
      const { types, checker } = await probes();
      const stamps = carrierStampsOf(types.get("deferred")!, checker);

      expect(stamps).toHaveLength(1);
      expect(checker.typeToString(stamps![0]!.meta)).toBe(
        '{ confidentiality: ["x"]; }',
      );
      expect(checker.typeToString(stamps![0]!.of!)).toBe("T");
    });

    it("returns the stamp the carrier member holds", async () => {
      const { types, checker } = await probes();
      const stamps = carrierStampsOf(types.get("carrier")!, checker);

      expect(stamps).toHaveLength(1);
      expect(checker.typeToString(stamps![0]!.meta)).toBe('["x"]');
      expect(stamps![0]!.of).toBeUndefined();
    });

    it("returns `undefined` for another deferred conditional, an object holding more than the carrier, and an alias of the tag's name", async () => {
      const { types, checker } = await probes();

      for (const name of ["other", "beside", "authored"]) {
        expect(carrierStampsOf(types.get(name)!, checker)).toBeUndefined();
      }
    });
  });
});
