import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import type { DiagnosticInput } from "../src/core/mod.ts";
import { reportOpaqueReservedResultKeys } from "../src/transformers/reserved-result-keys.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { validateSource } from "./utils.ts";

const DIAGNOSTIC_TYPE = "pattern-result:opaque-reserved-key";

/** A schema node, read positionally rather than through a declared shape. */
type Obj = Record<string, unknown>;

/** The diagnostics one schema draws, reported straight rather than compiled. */
function diagnosticsFor(
  schema: unknown,
  options: { storedSource?: boolean } = {},
): DiagnosticInput[] {
  const reported: DiagnosticInput[] = [];
  reportOpaqueReservedResultKeys(
    { reportDiagnosticOnce: (input) => void reported.push(input), options },
    schema,
    ts.factory.createIdentifier("anchor"),
  );
  return reported;
}

/** A result schema whose root is a reference to the one definition it holds. */
function rootRef(ref: string, definition?: unknown): Record<string, unknown> {
  return {
    $ref: ref,
    ...(definition === undefined ? {} : { $defs: { Held: definition } }),
  };
}

const OPAQUE_SCREEN = {
  type: "object",
  properties: { $UI: { type: "unknown" }, label: { type: "string" } },
} as const;

/** The reserved-key diagnostics a source produces, in emission order. */
async function reservedKeyDiagnostics(lines: string[]) {
  const { diagnostics } = await validateSource(lines.join("\n"), {
    types: COMMONFABRIC_TYPES,
  });
  const unexpected = diagnostics.filter((d) =>
    d.severity === "error" && d.type !== DIAGNOSTIC_TYPE
  );
  expect(unexpected.map((d) => `${d.type}: ${d.message}`)).toEqual([]);
  return diagnostics.filter((d) => d.type === DIAGNOSTIC_TYPE);
}

describe("reserved-result-keys", () => {
  describe("reportOpaqueReservedResultKeys()", () => {
    it("ignores a schema that describes no properties", () => {
      expect(diagnosticsFor(true)).toEqual([]);
      expect(diagnosticsFor(null)).toEqual([]);
      expect(diagnosticsFor([OPAQUE_SCREEN])).toEqual([]);
      expect(diagnosticsFor({ type: "object" })).toEqual([]);
    });

    it("demotes the report to a warning over stored source", () => {
      // Admission is judged once; reconstruction re-judges nothing. The
      // identity-pinned reload of durable stored source (the engine's
      // cold-recovery path) compiles bytes nobody can re-author, so the
      // report keeps its visibility and loses its veto — the 2026-08-25
      // estuary deploy is what happens otherwise: every piece pinned to a
      // pre-`VNode` pattern, profiles fleet-wide among them, refused on
      // reload. Authoring compiles keep the error (the cases below).
      const reported = diagnosticsFor(OPAQUE_SCREEN, { storedSource: true });
      expect(reported.map((d) => [d.type, d.severity])).toEqual([
        [DIAGNOSTIC_TYPE, "warning"],
      ]);
      expect(
        diagnosticsFor(OPAQUE_SCREEN).map((d) => [d.type, d.severity]),
      ).toEqual([[DIAGNOSTIC_TYPE, "error"]]);
    });

    it("follows a root reference into the definition it names", () => {
      const reported = diagnosticsFor(
        rootRef("#/$defs/Held", OPAQUE_SCREEN),
      );
      expect(reported.length).toBe(1);
      expect(reported[0]!.message).toContain("`$UI`");
    });

    it("follows a chain of root references", () => {
      expect(
        diagnosticsFor({
          $ref: "#/$defs/Outer",
          $defs: { Outer: { $ref: "#/$defs/Held" }, Held: OPAQUE_SCREEN },
        }).length,
      ).toBe(1);
    });

    it("leaves a root reference it cannot resolve alone", () => {
      // An external reference, one with no definitions to resolve against, one
      // naming a definition that is not there, and one that names itself.
      expect(diagnosticsFor(rootRef("https://example.test/vnode.json")))
        .toEqual(
          [],
        );
      expect(diagnosticsFor({ $ref: "#/$defs/Held" })).toEqual([]);
      expect(diagnosticsFor(rootRef("#/$defs/Absent", OPAQUE_SCREEN))).toEqual(
        [],
      );
      expect(diagnosticsFor(rootRef("#/$defs/Held", { $ref: "#/$defs/Held" })))
        .toEqual([]);
    });

    it("reports a declared result that leaves its own screen opaque", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "type Out = { [UI]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [UI]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.severity).toBe("error");
      expect(diagnostics[0]!.message).toContain("`$UI`");
      expect(diagnostics[0]!.message).toContain("VNode");
    });

    it("names every offending key in one diagnostic", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern, UI } from "commonfabric";',
        "type Out = { [NAME]: unknown; [UI]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [NAME]: s.label, [UI]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.message).toContain("`$NAME`, `$UI`");
    });

    it("reports a recursive result whose root is a reference into $defs", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "type Branch = { [UI]: unknown; label: string; children: Branch[] };",
        "export default pattern<{ label: string }, Branch>(",
        "  (s) => ({ [UI]: s.label, label: s.label, children: [] }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.message).toContain("`$UI`");
    });

    it("reports a declared result that leaves its offered views opaque", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, VIEWS } from "commonfabric";',
        "type Out = { [VIEWS]: unknown; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [VIEWS]: { inbox: { label: s.label } }, label: s.label }),",
        ");",
      ]);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]!.severity).toBe("error");
      expect(diagnostics[0]!.message).toContain("`$VIEWS`");
    });

    it("accepts a result that names the groups its views field holds", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { pattern, VIEWS } from "commonfabric";',
        "type Out = { [VIEWS]: { inbox: { label: string } }; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [VIEWS]: { inbox: { label: s.label } }, label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("emits a result schema naming each offered group and its stream payloads", async () => {
      // What one-round discovery rests on. A host holding the static result
      // schema decides native-or-floor from `$VIEWS.properties` without
      // reading a value at all, and drives a group's streams from the payload
      // schemas carried beside them — labs describes an event contract
      // nowhere else. A `$VIEWS` that reached a reader as a bare `object`,
      // or a stream member that lost its brand, would leave the field
      // present and the capability undiscoverable.
      const { diagnostics, output } = await validateSource(
        [
          "/// <cts-enable />",
          "import { handler, pattern, type Stream, VIEWS, type Writable }" +
          ' from "commonfabric";',
          "interface InboxView {",
          "  threads: { title: string }[];",
          "  setSearch: Stream<{ query: string }>;",
          "}",
          "type Out = { [VIEWS]: { inboxView: InboxView }; label: string };",
          "const setSearch = handler<",
          "  { query: string },",
          "  { label: Writable<string> }",
          ">(({ query }, state) => state.label.set(query));",
          "export default pattern<{ label: Writable<string> }, Out>(",
          "  (s) => ({",
          "    [VIEWS]: { inboxView: { threads: [], setSearch: setSearch(s) } },",
          "    label: s.label,",
          "  }),",
          ");",
        ].join("\n"),
        { types: COMMONFABRIC_TYPES },
      );
      expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      const result = patternSchemas(parseModule(output)).output;
      const views = (result.properties as Obj).$VIEWS as Obj;
      expect(views?.type).toBe("object");
      // The group is named at the field, so its presence is readable without
      // following the reference that describes it.
      expect((views.properties as Obj).inboxView).toEqual({
        $ref: "#/$defs/InboxView",
      });

      const group = (result.$defs as Obj).InboxView as Obj;
      const stream = (group.properties as Obj).setSearch as Obj;
      expect(stream?.asCell).toEqual(["stream"]);
      expect((stream.properties as Obj).query).toEqual({ type: "string" });
    });

    it("accepts a result that names the type its reserved key holds", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type Out = { [NAME]: string; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ [NAME]: s.label, label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("accepts an argument whose root leaves a reserved key opaque", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type StoredPiece = { [NAME]: unknown; label: string };",
        "export default pattern<StoredPiece, { label: string }>(",
        "  (s) => ({ label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("accepts a reserved key left opaque below the root of a result", async () => {
      const diagnostics = await reservedKeyDiagnostics([
        "/// <cts-enable />",
        'import { NAME, pattern } from "commonfabric";',
        "type Held = { [NAME]: unknown; label: string };",
        "type Out = { held: Held; label: string };",
        "export default pattern<{ label: string }, Out>(",
        "  (s) => ({ held: { [NAME]: s.label, label: s.label }, label: s.label }),",
        ");",
      ]);
      expect(diagnostics).toEqual([]);
    });
  });
});
