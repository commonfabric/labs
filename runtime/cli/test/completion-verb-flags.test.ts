import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shapeVerbFlagCandidates } from "../lib/completion/verb-flags.ts";
import { type ExecCommandSpec, parseExecArgs } from "../lib/exec-schema.ts";

/**
 * The `inputSchema` of one verb, in the shape `cf piece verbs --json` reports
 * it — a declared field with a doc comment, an optional boolean, and a
 * required field with none. Copied from a listing rather than invented, so the
 * candidates are shaped from what a real pattern produces.
 */
const ADD_ITEM = {
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The item's display label." },
      pinned: {
        type: "boolean",
        description: "Whether the item starts pinned.",
      },
      sortKey: { type: "number" },
    },
    required: ["title"],
  },
} as const;

describe("shapeVerbFlagCandidates()", () => {
  it("names every declared field as the flag the parser accepts", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--title");
    expect(values).toContain("--pinned");
  });

  it("writes a camelCase field as its kebab-case flag", () => {
    // `flagNameForKey` is the mapping the parser itself applies, so `sortKey`
    // is reachable as `--sort-key` and as nothing else.
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--sort-key");
    expect(values).not.toContain("--sortKey");
  });

  it("offers both spellings of a boolean field", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--pinned");
    expect(values).toContain("--no-pinned");
    // Only a boolean is negatable.
    expect(values).not.toContain("--no-title");
  });

  it("annotates a field with the author's own doc comment", () => {
    const title = shapeVerbFlagCandidates(ADD_ITEM)
      .find((candidate) => candidate.value === "--title");
    expect(title?.description).toBe("The item's display label.");
  });

  it("falls back to whether the field is owed where no prose was written", () => {
    const sortKey = shapeVerbFlagCandidates(ADD_ITEM)
      .find((candidate) => candidate.value === "--sort-key");
    expect(sortKey?.description).toBe("optional");
  });

  it("offers the generic input flags after the declared ones", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values.slice(-3)).toEqual(["--json", "--json-file", "--help"]);
  });

  it("names the value flags for a verb declaring no input", () => {
    // A schema-less input declares no fields, but the parser takes `--value`
    // for it and the usage lines advertise it — so the candidate set says so
    // too. The cross-check below is what proves it rather than this list.
    expect(shapeVerbFlagCandidates({ inputSchema: true }).map((c) => c.value))
      .toEqual(["--value", "--value-file", "--json", "--json-file", "--help"]);
  });

  it("offers a colliding field the one spelling that reaches it", () => {
    // `parseExecArgs` reads a bare `--json` as the generic input mode and
    // never consults a declared field of that name, so offering the bare
    // token would name a flag that does something else.
    const values = shapeVerbFlagCandidates({
      inputSchema: { type: "object", properties: { json: { type: "string" } } },
    }).map((candidate) => candidate.value);
    expect(values).toContain("--json=");
    expect(values.filter((v) => v === "--json").length).toBe(1);
  });

  it("names the value flags for an input that is not an object", () => {
    // A non-object input is written whole, so `--value` is the field-shaped
    // flag and there are no per-field ones to derive.
    const values = shapeVerbFlagCandidates({
      inputSchema: { type: "string" },
    }).map((candidate) => candidate.value);
    expect(values).toEqual([
      "--value",
      "--value-file",
      "--json",
      "--json-file",
      "--help",
    ]);
  });

  it("gives a colliding negation to the field that owns the token", () => {
    // `parseObjectInput` looks a token up as a declared field before it reads
    // a `no-` prefix as a negation, so `--no-active` sets `noActive` and never
    // means `active = false`. Annotating it as the negation would put one
    // field's meaning on another field's flag.
    const schema = {
      type: "object",
      properties: {
        active: { type: "boolean" },
        noActive: { type: "boolean" },
      },
    };
    const spec = {
      callableKind: "handler",
      defaultVerb: "invoke",
      inputSchema: schema,
    } as ExecCommandSpec;
    const candidates = shapeVerbFlagCandidates({
      inputSchema: schema as ExecCommandSpec["inputSchema"],
    });
    const negation = candidates.find((c) => c.value === "--no-active");
    expect(negation?.description).toBe("optional");
    expect(parseExecArgs(spec, ["--no-active"]).input).toEqual({
      noActive: true,
    });
    // `active = false` is still reachable, by the spelling no field can own.
    expect(candidates.map((c) => c.value)).toContain("--active=false");
    expect(parseExecArgs(spec, ["--active=false"]).input).toEqual({
      active: false,
    });
  });

  it("offers one candidate per value where a field collides with a generic flag", () => {
    // Two menu entries of one value would mean two different things.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        type: "object",
        properties: { json: { type: "string" }, jsonFile: { type: "string" } },
      },
    }).map((candidate) => candidate.value);
    expect(values).toEqual([...new Set(values)]);
  });

  it("offers only candidates the schema-derived parser accepts", () => {
    // The one assertion that cannot drift from the parser: every candidate is
    // completed the way a caller would and put back through `parseExecArgs`.
    // A list that agreed with itself and not with the parser is exactly the
    // defect this slot is for.
    const booleanNames = new Set(["pinned", "help"]);
    const argsFor = (value: string): string[] => {
      if (value.includes("=") || value.startsWith("--no-")) return [value];
      if (value === "--help") return [value];
      if (value === "--json") return [value, "{}"];
      if (value === "--json-file" || value === "--value-file") {
        return [value, "-"];
      }
      return booleanNames.has(value.replace(/^--/, ""))
        ? [value]
        : [value, "x"];
    };
    const schemas: unknown[] = [
      true,
      { type: "object", properties: { json: { type: "string" } } },
      { type: "object", properties: { help: { type: "boolean" } } },
      {
        type: "object",
        properties: { title: { type: "string" }, pinned: { type: "boolean" } },
      },
    ];
    for (const inputSchema of schemas) {
      const spec = {
        callableKind: "handler",
        defaultVerb: "invoke",
        inputSchema,
      } as ExecCommandSpec;
      for (
        const candidate of shapeVerbFlagCandidates({
          inputSchema: inputSchema as ExecCommandSpec["inputSchema"],
        })
      ) {
        expect(
          () => parseExecArgs(spec, argsFor(candidate.value)),
          `${candidate.value} against ${JSON.stringify(inputSchema)}`,
        ).not.toThrow();
      }
    }
  });

  it("sets a declared boolean `help` by the spellings that are not the help page", () => {
    // Bare `--help` opens the verb's own page whatever a field of that name
    // says, so offering it as the way to set the field names a flag that does
    // something else.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        type: "object",
        properties: { help: { type: "boolean" } },
      },
    }).map((candidate) => candidate.value);
    expect(values).toContain("--help=true");
    expect(values).toContain("--no-help");
    expect(values.filter((v) => v === "--help").length).toBe(1);
  });

  it("reads fields an `allOf` contributes, which the payload door judges", () => {
    // The two doors read one schema. A field the parser accepts and this did
    // not offer would be a slot silently short of the vocabulary it claims.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        allOf: [
          { type: "object", properties: { title: { type: "string" } } },
          { type: "object", properties: { body: { type: "string" } } },
        ],
      },
    }).map((candidate) => candidate.value);
    expect(values).toContain("--title");
    expect(values).toContain("--body");
  });
});
