import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import {
  CF_RUNTIME_ERROR_LOG,
  undeclaredVerbFieldError,
} from "../lib/callable.ts";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type ExecCommandSpec,
  normalizeCallableInputForExecution,
  parseExecArgs,
  renderExecHelp,
  renderExecHelpJson,
  renderPieceCallHelp,
  resolveExecInvocation,
  resolveParsedExecInput,
} from "../lib/exec-schema.ts";
import {
  executeMountedCallableFile,
  resolveMountedCallableFile,
} from "../lib/exec.ts";
import { writeMountState } from "../lib/fuse.ts";
import type { SpaceConfig } from "../lib/piece.ts";
import { externalizeSchema } from "../../runner/src/link-utils.ts";
import { cf, relevantStderr } from "./utils.ts";

function makeSpec(
  callableKind: "handler" | "tool",
  inputSchema: JSONSchema,
  outputSchemaSummary?: JSONSchema,
): ExecCommandSpec {
  return {
    callableKind,
    defaultVerb: callableKind === "handler" ? "invoke" : "run",
    inputSchema,
    outputSchemaSummary,
  };
}

/** The message `parseExecArgs` refused `args` with, or "" where it did not. */
function refusalFrom(
  spec: ExecCommandSpec,
  args: string[],
  sectionPrefix?: string,
): string {
  try {
    parseExecArgs(spec, args, sectionPrefix);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("parseExecArgs", () => {
  it("defaults handlers to invoke and tools to run when flags are provided", () => {
    const handler = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: { query: { type: "string" } },
      }),
      ["--query", "milk"],
    );
    const tool = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: { query: { type: "string" } },
      }),
      ["--query", "milk"],
    );

    expect(handler.verb).toBe("invoke");
    expect(handler.showHelp).toBe(false);
    expect(handler.input).toEqual({ query: "milk" });
    expect(tool.verb).toBe("run");
    expect(tool.showHelp).toBe(false);
    expect(tool.input).toEqual({ query: "milk" });
  });

  it("treats top-level --help as command help", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "string" },
          query: { type: "string" },
        },
      }),
      ["--help"],
    );

    expect(result.verb).toBe("run");
    expect(result.showHelp).toBe(true);
    expect(result.showHelpJson).toBe(false);
    expect(result.input).toEqual({});
  });

  it("treats top-level --help with a value as a schema field when help exists", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "string" },
          query: { type: "string" },
        },
      }),
      ["--help", "details", "--query", "milk"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({
      help: "details",
      query: "milk",
    });
  });

  it("reserves standalone --help even when help is a boolean schema field", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
      ["--help"],
    );

    expect(result.showHelp).toBe(true);
    expect(result.input).toEqual({});
  });

  it("still accepts explicit boolean help values", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
      ["--help=true"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({ help: true });
  });

  it("supports --help --json for machine-readable schema help", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      }),
      ["--help", "--json"],
    );

    expect(result.showHelp).toBe(true);
    expect(result.showHelpJson).toBe(true);
    expect(result.input).toEqual({});
  });

  it("parses primitive flags including booleans", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          verbose: { type: "boolean" },
          exact: { type: "boolean" },
        },
      }),
      [
        "invoke",
        "--query",
        "oat milk",
        "--limit",
        "2",
        "--verbose",
        "--exact=false",
      ],
    );

    expect(result.input).toEqual({
      query: "oat milk",
      limit: 2,
      verbose: true,
      exact: false,
    });
  });

  it("parses arrays and objects from JSON strings", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          filters: {
            type: "object",
            properties: { fresh: { type: "boolean" } },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      }),
      [
        "run",
        "--filters",
        '{"fresh":true}',
        "--tags",
        '["grocery","weekly"]',
      ],
    );

    expect(result.input).toEqual({
      filters: { fresh: true },
      tags: ["grocery", "weekly"],
    });
  });

  it("supports non-object schemas through --value and inline object schemas through --json", () => {
    const primitive = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["--value", "42"],
    );
    const json = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
          filters: {
            type: "object",
            properties: { fresh: { type: "boolean" } },
          },
        },
      }),
      ["--json", '{"query":"oat milk","filters":{"fresh":true}}'],
    );

    expect(primitive.input).toBe(42);
    expect(primitive.readJsonFromStdin).toBe(false);
    expect(json.input).toEqual({
      query: "oat milk",
      filters: { fresh: true },
    });
  });

  it("preserves inline --json payloads for object schemas without CLI shape enforcement", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json", '["not-an-object"]'],
    );

    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toEqual(["not-an-object"]);
  });

  it("treats bare --json as stdin input mode", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it("supports file-based value and JSON input modes", () => {
    const valueFile = parseExecArgs(
      makeSpec("handler", { type: "string" }),
      ["--value-file", "/tmp/content.md"],
    );
    const jsonFile = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json-file", "/tmp/input.json"],
    );

    expect(valueFile.inputFile).toEqual({
      format: "text",
      path: "/tmp/content.md",
    });
    expect(valueFile.readTextFromStdin).toBe(false);
    expect(jsonFile.inputFile).toEqual({
      format: "json",
      path: "/tmp/input.json",
    });
    expect(jsonFile.readJsonFromStdin).toBe(false);
  });

  it("supports reading primitive values from stdin via --value-file -", () => {
    const result = parseExecArgs(
      makeSpec("handler", { type: "string" }),
      ["--value-file", "-"],
    );

    expect(result.readTextFromStdin).toBe(true);
    expect(result.readJsonFromStdin).toBe(false);
    expect(result.input).toBeUndefined();
  });

  it('treats "--json -" as the stdin sentinel for non-object schemas', () => {
    const result = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["--json", "-"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it('treats "--json -" as the stdin sentinel for object schemas', () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json", "-"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it("preserves omitted non-object inputs as undefined", () => {
    const primitive = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["invoke"],
    );

    expect(primitive.input).toBeUndefined();
  });

  it("rejects invoking handlers with no arguments unless invoke is explicit", () => {
    expect(() =>
      parseExecArgs(
        makeSpec("handler", {
          type: "string",
        }),
        [],
      )
    ).toThrow(
      /Handler requires input/i,
    );
  });

  it("allows handlers with empty object inputs to invoke without arguments", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {},
      }),
      [],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toEqual({});
  });

  it("allows schema-less handlers to invoke without arguments", () => {
    const result = parseExecArgs(
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
      [],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toBeUndefined();
  });

  it("allows a schema-less handler whose schema is a content-addressed reference to invoke without arguments", () => {
    // A stored link carries its schema as a reference, so the stream
    // declaration is on the document the reference names, not at the root.
    const stored = externalizeSchema({ asCell: ["stream"] });
    expect(stored).toEqual({ $ref: expect.stringMatching(/^cid:/) });

    const result = parseExecArgs(makeSpec("handler", stored), []);

    expect(result.verb).toBe("invoke");
    expect(result.input).toBeUndefined();
  });

  it("allows invoke alone for handlers whose inputs are all optional", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      }),
      ["invoke"],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toEqual({});
  });

  it("rejects mixed --json and generated flags", () => {
    expect(() =>
      parseExecArgs(
        makeSpec("tool", {
          type: "object",
          properties: { query: { type: "string" } },
        }),
        ["--json", '{"query":"tea"}', "--query", "coffee"],
      )
    ).toThrow(/--json cannot be combined with generated flags/i);
  });

  it("reports readable required-field, enum, and unknown-flag errors", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        query: { type: "string" },
      },
      required: ["query"],
    });

    expect(() => parseExecArgs(spec, ["--mode", "fast"])).toThrow(
      /Missing required flag --query/i,
    );
    expect(() => parseExecArgs(spec, ["--query", "tea", "--mode", "invalid"]))
      .toThrow(/Invalid value for --mode/i);
    // The five elements the payload door gives for the same mistake: the
    // name, the position, the refusal, and the accepted vocabulary. A caller
    // who mistypes a flag and one who mistypes a payload key made one
    // mistake, and the flag spelling is the one the walkthrough teaches.
    expect(() => parseExecArgs(spec, ["--query", "tea", "--unknown", "value"]))
      .toThrow(
        /"--unknown" at <event> is not a field this verb declares\./,
      );
    expect(() => parseExecArgs(spec, ["--query", "tea", "--unknown", "value"]))
      .toThrow(/<event> takes "--mode", "--query"/);

    // The fifth element, on a name close enough to have been meant.
    expect(() => parseExecArgs(spec, ["--quer", "tea"]))
      .toThrow(/Did you mean "--query"\?/);
    // And withheld where nothing is close: a wrong guess is worse than none.
    expect(() => parseExecArgs(spec, ["--zzzzzzzz", "tea"]))
      .not.toThrow(/Did you mean/);

    // A verb declaring nothing says so rather than trailing an empty list,
    // which is the same sentence the payload door gives for that case.
    const bare = makeSpec("handler", { type: "object", properties: {} });
    expect(() => parseExecArgs(bare, ["invoke", "--titel", "x"]))
      .toThrow(/<event> declares no fields at all/);
  });

  it("refuses a read option inside the callable's section, and says where it goes", () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });

    // The projection is not a near miss for `--title`; it is a `cf` flag in
    // the wrong section, and the answer is the section it belongs to.
    const message = (() => {
      try {
        parseExecArgs(
          spec,
          ["--select", "topic.title", "--title", "Ship it"],
          "cf piece call ... addTopic",
        );
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toContain('"--select" is a `cf` read option');
    expect(message).toContain(
      "written:  cf piece call ... addTopic --select topic.title --title 'Ship it'",
    );
    expect(message).toContain(
      "write:    cf piece call ... addTopic --title 'Ship it' -- --select topic.title",
    );
  });

  it("refuses all three read options in the section, and none the verb declares", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: { query: { type: "string" } },
    });
    for (const flag of ["--select", "--schema", "--filter"]) {
      expect(() => parseExecArgs(spec, [flag, "x"]), flag)
        .toThrow(/is a `cf` read option/);
    }

    // Nothing reserves a field name. A verb that declares `select` owns the
    // word inside its own section, and the refusal never sees it.
    const declaring = makeSpec("tool", {
      type: "object",
      properties: { select: { type: "string" } },
    });
    expect(parseExecArgs(declaring, ["--select", "manual"]).input)
      .toEqual({ select: "manual" });
  });

  it("leaves a declared read-option name where its owner reads it", () => {
    // `filter` is this verb's field and `select` is nobody's. The corrected
    // line moves the one that names no field and leaves the other in the
    // section — moving both would hand the verb's own input to the read step.
    const spec = makeSpec("tool", {
      type: "object",
      properties: { filter: { type: "string" } },
    });
    const message = (() => {
      try {
        parseExecArgs(
          spec,
          ["--filter", "mine", "--select", "title"],
          "cf piece call ... findItems",
        );
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toContain(
      "write:    cf piece call ... findItems --filter mine -- --select title",
    );
  });

  it("refuses a read option in the section of a verb whose schema judges nothing", () => {
    // An open schema accepts any field, so this flag would otherwise be
    // absorbed as one and the handler would run with input the caller never
    // meant — a projection asked for, an unprojected value returned, exit
    // zero. That is the silent case the boundary exists for, so the answer
    // comes before the schema is consulted at all.
    const open = makeSpec("handler", { type: "object" });
    expect(() => parseExecArgs(open, ["--select", "title"]))
      .toThrow(/is a `cf` read option/);
    expect(parseExecArgs(open, ["--anything", "else"]).input)
      .toEqual({ anything: "else" });
  });

  it("refuses a read option in the section of a verb taking a single value", () => {
    // A verb with no fields reaches a different parser, and the boundary is
    // the same one: the alternative is the four value flags, which is a true
    // sentence about a vocabulary the caller was never reaching for.
    for (
      const spec of [
        makeSpec("handler", { type: "string" }),
        makeSpec("handler", true),
      ]
    ) {
      const message = (() => {
        try {
          parseExecArgs(
            spec,
            ["--value", "Ship", "--select", "topic.title"],
            "cf piece call ... setTitle",
          );
        } catch (error) {
          return (error as Error).message;
        }
        return "";
      })();
      expect(message).toContain('"--select" is a `cf` read option');
      expect(message).toContain(
        "write:    cf piece call ... setTitle --value Ship -- --select topic.title",
      );
    }

    // The keyword rejoins the prefix here too, so the corrected line is the
    // caller's own rather than one with a word silently dropped.
    expect(
      refusalFrom(
        makeSpec("handler", { type: "string" }),
        ["invoke", "--filter", "open"],
        "cf piece call ... setTitle",
      ),
    ).toContain("write:    cf piece call ... setTitle invoke -- --filter open");
  });

  it("takes a flag-shaped word after `--value` as the value it is", () => {
    // Such a verb's whole payload is one word the caller chose, and a word
    // beginning with dashes is a payload like any other. Reading it as a
    // projection refuses a call that names no projection at all.
    expect(
      parseExecArgs(makeSpec("handler", { type: "string" }), [
        "--value",
        "--select",
      ]).input,
    ).toBe("--select");
  });

  it("takes a flag-shaped word after `--value-file` and `--json-file` as the path", () => {
    // The same rule, and the reason the four flags are checked one at a time:
    // a path beginning with dashes is a path this verb accepts, so neither of
    // these leaves the word standing for the projection scan to find.
    const spec = makeSpec("handler", { type: "string" });
    expect(parseExecArgs(spec, ["--value-file", "--select"]).inputFile)
      .toStrictEqual({ format: "text", path: "--select" });
    expect(parseExecArgs(spec, ["--json-file", "--select"]).inputFile)
      .toStrictEqual({ format: "json", path: "--select" });
  });

  it("reads a read option after a bare `--json` as a read option", () => {
    // `--json` is the one of the four that declines a flag-shaped word: bare
    // it reads stdin, so the word after it is nobody's value and a read option
    // written there is a projection inside the callable's section.
    const spec = makeSpec("handler", { type: "string" });
    expect(
      refusalFrom(
        spec,
        ["--json", "--select", "topic.title"],
        "cf piece call ... scalar",
      ),
    )
      .toContain(
        "write:    cf piece call ... scalar --json -- --select topic.title",
      );
    // And still spends a payload that is not flag-shaped.
    expect(parseExecArgs(spec, ["--json", '"hi"']).input).toBe("hi");
  });

  it("leaves a field's own value in the section, flag-shaped or not", () => {
    // `--title` declares a string, so the word after it is that string. A
    // correction re-reading it as a flag moves the title's value out of the
    // section, breaks the pairing of the flag that really is misplaced, and
    // prints a line asking for something the caller never wrote.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(
      refusalFrom(
        spec,
        ["--title", "--select", "--schema", "topic"],
        "cf piece call ... addItem",
      ),
    ).toContain(
      "write:    cf piece call ... addItem --title --select -- --schema topic",
    );
  });

  it("moves a read option with its value where the field before it takes none", () => {
    // A boolean field spends no word, so the read option after it opens its
    // own pair and both words move together.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { draft: { type: "boolean" }, title: { type: "string" } },
    });
    expect(
      refusalFrom(
        spec,
        ["--draft", "--select", "topic.title"],
        "cf piece call ... addItem",
      ),
    ).toContain(
      "write:    cf piece call ... addItem --draft -- --select topic.title",
    );
    // A negation says which value it means, so it spends no word either.
    expect(
      refusalFrom(
        spec,
        ["--no-draft", "--select", "topic.title"],
        "cf piece call ... addItem",
      ),
    ).toContain(
      "write:    cf piece call ... addItem --no-draft -- --select topic.title",
    );
  });

  it("leaves a flag after `--json` standing as a flag, which `--json` refuses to take", () => {
    // `--json` takes a payload and refuses a flag-shaped word outright, so a
    // read option written after it is a read option rather than its value.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { title: { type: "string" } },
    });
    expect(
      refusalFrom(
        spec,
        ["--select", "a", "--json", "--filter", "b"],
        "cf piece call ... addItem",
      ),
    ).toContain(
      "write:    cf piece call ... addItem --json -- --select a --filter b",
    );
  });
});

describe("parseExecArgs edge cases", () => {
  it("validates every generated flag value by its schema type", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        count: { type: "number" },
        whole: { type: "integer" },
        items: { type: "array" },
        config: { type: "object" },
        nothing: { type: "null" },
      },
    });

    expect(() => parseExecArgs(spec, ["--enabled=maybe"])).toThrow(
      /expected true or false/,
    );
    expect(() => parseExecArgs(spec, ["--count", "NaN"])).toThrow(
      /expected number/,
    );
    expect(() => parseExecArgs(spec, ["--whole", "1.5"])).toThrow(
      /expected integer/,
    );
    expect(() => parseExecArgs(spec, ["--items", "{"])).toThrow(
      /Invalid JSON/,
    );
    expect(() => parseExecArgs(spec, ["--items", "{}"])).toThrow(
      /expected array JSON/,
    );
    expect(() => parseExecArgs(spec, ["--config", "[]"])).toThrow(
      /expected object JSON/,
    );
    expect(() => parseExecArgs(spec, ["--nothing", "false"])).toThrow(
      /expected null/,
    );
    expect(parseExecArgs(spec, ["--nothing", "null"]).input).toEqual({
      nothing: null,
    });
  });

  it("rejects conflicting object-input modes at the point they conflict", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        query: { type: "string" },
        enabled: { type: "boolean" },
      },
    });

    expect(() => parseExecArgs(spec, ["value"])).toThrow(
      /Unexpected argument value/,
    );
    expect(() => parseExecArgs(spec, ["--json", "--query", "tea"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseExecArgs(spec, ["--query", "tea", "--json", "{}"]))
      .toThrow(/cannot be combined/);
    expect(() => parseExecArgs(spec, ["--json", "{}", "--json", "{}"]))
      .toThrow(/only be provided once/);
    expect(() =>
      parseExecArgs(spec, ["--query", "tea", "--json-file", "input.json"])
    ).toThrow(/json-file cannot be combined/);
    expect(() =>
      parseExecArgs(spec, ["--json", "{}", "--json-file", "input.json"])
    ).toThrow(/only be provided once/);
    expect(() => parseExecArgs(spec, ["--json-file"])).toThrow(
      /Missing value/,
    );
    expect(parseExecArgs(spec, ["--json-file", "-"])).toMatchObject({
      readJsonFromStdin: true,
      usedJsonInput: true,
    });
    expect(parseExecArgs(spec, ["--no-enabled"]).input).toEqual({
      enabled: false,
    });
    // The field exists; the negation is what does not apply. Listing the
    // vocabulary here would send the caller looking for a name they already
    // found, so this refusal names only the field it is about.
    expect(() => parseExecArgs(spec, ["--no-query"])).toThrow(
      /"--no-query" negates "--query", which is not a boolean field/,
    );
    expect(() => parseExecArgs(spec, ["--no-query"])).not.toThrow(
      /declared fields are/,
    );
    expect(() => parseExecArgs(spec, ["--query"])).toThrow(/Missing value/);
  });

  it("reads a field a conjunction declares, on every flag surface", () => {
    // `properties` alone missed what an `allOf` member contributes, while the
    // payload door read it — so one door judged a field the other could not
    // see. A caller was refused at dispatch for omitting something no surface
    // had shown them.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      allOf: [{
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      }],
    });

    // The flag parses, and to its DECLARED type rather than a string.
    expect(
      parseExecArgs(spec, ["invoke", "--note", "hi", "--count", "5"]).input,
    )
      .toEqual({ note: "hi", count: 5 });

    // Required is enforced from the member that declares it.
    expect(() => parseExecArgs(spec, ["invoke", "--note", "hi"]))
      .toThrow(/Missing required flag --count/);

    // And the help page lists it, which is the half a caller reads first.
    const help = renderExecHelp("/mnt/x.handler", spec, {});
    expect(help).toMatch(/--count/);

    // The type block above the flags shows it too. The two are rendered by
    // DIFFERENT readers — the flag list by the CLI's own, the type block by
    // the runner's formatter — so one page could state two answers about one
    // schema, and did. Sliced out rather than matched against the whole page,
    // because `--count` in the flag list would satisfy a looser match on its
    // own and the disagreement is exactly what needs catching.
    const typeBlock = help.split("Input type:")[1]?.split("Flags:")[0] ?? "";
    expect(typeBlock).toMatch(/note/);
    expect(typeBlock).toMatch(/count/);
  });

  it("follows a reference into the definition a conjunction names", () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: { note: { type: "string" } },
      allOf: [{ $ref: "#/$defs/Extra" }],
      $defs: {
        Extra: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    });
    expect(parseExecArgs(spec, ["invoke", "--note", "a", "--count", "2"]).input)
      .toEqual({ note: "a", count: 2 });
  });

  it("does not pull a field out of a disjunction", () => {
    // A payload satisfies ONE branch of an `anyOf`, so no single flag list
    // describes the position and no branch's `required` binds it. Offering
    // `--only-here` would advertise a flag that fits one branch and breaks the
    // other.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { note: { type: "string" } },
      allOf: [{
        anyOf: [{
          type: "object",
          properties: { onlyHere: { type: "string" } },
          required: ["onlyHere"],
        }],
      }],
    });

    // It is not in the DECLARED vocabulary: the help page does not advertise
    // it, and its `required` does not bind a payload that omits it.
    const help = renderExecHelp("/mnt/x.handler", spec, {});
    expect(help).not.toMatch(/--only-here/);
    expect(parseExecArgs(spec, ["invoke", "--note", "a"]).input)
      .toEqual({ note: "a" });

    // A disjunction leaves the position unjudgeable, so BOTH doors fail open
    // and take an unnamed flag rather than refusing what they cannot assess.
    // Agreeing is the property worth pinning; which way they agree follows
    // from the design's "a call wrongly refused cannot be made at all".
    expect(parseExecArgs(spec, ["invoke", "--only-here", "x"]).input)
      .toEqual({ "only-here": "x" });
    expect(undeclaredVerbFieldError({ onlyHere: "x" }, spec.inputSchema))
      .toBeUndefined();
  });

  it("leaves a conjunction over a scalar on the single-value path", () => {
    // `allOf` earns the object path by CONTRIBUTING fields. A conjunction
    // constraining a scalar contributes none, and routing it through flag
    // parsing would offer a single-value verb a vocabulary of nothing.
    const spec = makeSpec("tool", { allOf: [{ type: "string" }] });
    expect(parseExecArgs(spec, ["run", "--value", "hi"]).input).toBe("hi");
    expect(() => parseExecArgs(spec, ["run", "--anything", "x"]))
      .toThrow(/is not a flag this verb takes/);
  });

  it("keeps the flags beside a disjunction it cannot express", () => {
    // A root `anyOf` adds constraints no flag list can express, but the
    // properties beside it are still declared and still typed. Reporting none
    // because a disjunction is present would take away flags that already
    // worked — the disjunction is stepped over, not treated as a veto.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { note: { type: "string" }, count: { type: "number" } },
      anyOf: [
        { required: ["note"] },
        { required: ["count"] },
      ],
    });

    expect(parseExecArgs(spec, ["invoke", "--note", "a", "--count", "2"]).input)
      .toEqual({ note: "a", count: 2 });
    expect(renderExecHelp("/mnt/x.handler", spec, {})).toMatch(/--note/);
  });

  it("accepts an undeclared flag exactly where the payload door accepts the field", () => {
    // The two doors are one gate asked in two spellings, so what they let
    // through must not depend on which the caller reached for. Both
    // permissive cases are schemas the RUNTIME will not judge either: one
    // naming no fields at all, and one saying extra fields are welcome.
    const shapes: Record<string, JSONSchema> = {
      "no properties key": { type: "object" },
      "empty properties": { type: "object", properties: {} },
      "additionalProperties": {
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: true,
      },
      "closed": { type: "object", properties: { title: { type: "string" } } },
    };

    const verdicts: Record<string, { flag: string; payload: string }> = {};
    for (const [label, inputSchema] of Object.entries(shapes)) {
      const spec = makeSpec("handler", inputSchema);
      let flag: string;
      try {
        parseExecArgs(spec, ["invoke", "--titel", "x"]);
        flag = "accept";
      } catch {
        flag = "refuse";
      }
      verdicts[label] = {
        flag,
        payload: undeclaredVerbFieldError({ titel: "x" }, inputSchema) ===
            undefined
          ? "accept"
          : "refuse",
      };
    }

    // Asserted as one object so a disagreement names WHICH shape drifted,
    // and so a change making both doors uniformly wrong still fails.
    expect(verdicts).toEqual({
      "no properties key": { flag: "accept", payload: "accept" },
      "empty properties": { flag: "refuse", payload: "refuse" },
      "additionalProperties": { flag: "accept", payload: "accept" },
      "closed": { flag: "refuse", payload: "refuse" },
    });

    // An accepted flag lands as the string the caller typed: the schema
    // declared no type to read it as, and this door does not invent one.
    expect(
      parseExecArgs(makeSpec("handler", shapes["no properties key"]), [
        "invoke",
        "--titel",
        "x",
      ]).input,
    ).toEqual({ titel: "x" });
  });

  it("offers a negated near miss, and only over fields that can be negated", () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        title: { type: "boolean" },
        done: { type: "boolean" },
        body: { type: "string" },
      },
    });

    // The case the caller actually hits: a typo inside the negated name. The
    // `no-` prefix is stripped before matching, because otherwise it is three
    // edits of noise and the threshold scales with the misspelling's length —
    // so it would get HARDER to match precisely because they typed more.
    expect(() => parseExecArgs(spec, ["invoke", "--no-titel"]))
      .toThrow(/Did you mean "--no-title"\?/);

    // Only booleans are offered, because only a boolean can be negated.
    expect(() => parseExecArgs(spec, ["invoke", "--no-titel"]))
      .toThrow(
        /Only a boolean field can be negated, and this verb declares "--title", "--done"/,
      );

    // A near miss toward a NON-boolean is withheld: `--no-body` would fail
    // too, so naming it sends the caller to a spelling that does not work.
    expect(() => parseExecArgs(spec, ["invoke", "--no-bodi"]))
      .not.toThrow(/Did you mean/);

    // The unnegated door is untouched, and still lists every field.
    expect(() => parseExecArgs(spec, ["invoke", "--titel", "x"]))
      .toThrow(
        /Did you mean "--title"\? <event> takes "--title", "--done", "--body"/,
      );

    // A valid negation still works.
    expect(parseExecArgs(spec, ["invoke", "--no-title"]).input)
      .toEqual({ title: false });
  });

  it("says so when a verb declares nothing that can be negated", () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: { body: { type: "string" } },
    });
    expect(() => parseExecArgs(spec, ["invoke", "--no-body-x"]))
      .toThrow(
        /Only a boolean field can be negated, and this verb declares none/,
      );
  });

  it("refuses a declared field typed in its schema spelling, not aliases it", () => {
    // The permissive path turns on whether the SCHEMA judges its fields, not
    // on whether a NAME is declared. Asking the second would read `--fooBar`
    // as an undeclared field against an open schema and accept it — a silent
    // alias for `--foo-bar` that no help page teaches and that arrives
    // untyped, because the synthesized descriptor carries no schema.
    const spec = makeSpec("handler", {
      type: "object",
      properties: { fooBar: { type: "number" } },
    });

    expect(() => parseExecArgs(spec, ["invoke", "--fooBar", "5"]))
      .toThrow(/"--fooBar" at <event> is not a field this verb declares\./);
    expect(() => parseExecArgs(spec, ["invoke", "--fooBar", "5"]))
      .toThrow(/Did you mean "--foo-bar"\?/);

    // And the spelling it names parses to the DECLARED type, not a string.
    expect(parseExecArgs(spec, ["invoke", "--foo-bar", "5"]).input)
      .toEqual({ fooBar: 5 });
  });

  it("reads a $ref's siblings the way the payload door resolves them", () => {
    // 2020-12 lets a `$ref` carry siblings, and the runtime's own
    // `resolveCfcSchemaRefs` merges the ref site over its target. Jumping
    // straight to the target instead would name `query` here — a flag the
    // validator refuses as an additional property — while hiding `limit`,
    // the one it accepts. Which fields exist is the validator's answer to
    // give; this door's job is to report the same one.
    const spec = makeSpec("handler", {
      $ref: "#/$defs/AddEvent",
      asCell: ["stream"],
      properties: { limit: { type: "number" } },
      additionalProperties: false,
      $defs: {
        AddEvent: {
          type: "object",
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
      },
    } as unknown as JSONSchema);

    expect(parseExecArgs(spec, ["--limit", "5"]).input).toEqual({ limit: 5 });
    expect(() => parseExecArgs(spec, ["--query", "Milk"]))
      .toThrow(/<event> takes "--limit"/);
  });

  it("falls back to the single-value vocabulary for an unresolvable $ref", () => {
    // A dangling ref describes nothing, so there is no fields position to
    // read and the scalar flags are all that remain — where such a schema
    // sat before any of this resolved.
    const spec = makeSpec("handler", {
      $ref: "#/$defs/Missing",
      asCell: ["stream"],
      $defs: {},
    } as unknown as JSONSchema);

    expect(parseExecArgs(spec, ["--value", "Milk"]).input).toBe("Milk");
    expect(() => parseExecArgs(spec, ["--query", "Milk"]))
      .toThrow(/This verb takes a single value/);
  });

  it("derives flags from fields behind a top-level $ref", () => {
    // The shape a stream's event is routinely written in. Its fields sit in
    // the definition, and a caller should not have to know that to name them.
    const refSchema = (
      properties: Record<string, JSONSchema>,
      required: string[],
    ): JSONSchema => ({
      $ref: "#/$defs/AddEvent",
      asCell: ["stream"],
      $defs: { AddEvent: { type: "object", properties, required } },
    } as JSONSchema);

    const one = makeSpec(
      "handler",
      refSchema({ query: { type: "string" } }, ["query"]),
    );
    expect(parseExecArgs(one, ["--query", "Milk"]).input)
      .toEqual({ query: "Milk" });
    // The field has a name, so that name is the flag. `--value` belongs to a
    // verb whose event IS a single value, and this one's is an object.
    expect(() => parseExecArgs(one, ["--value", "Milk"]))
      .toThrow(/"--value" at <event> is not a field this verb declares/);

    const two = makeSpec(
      "handler",
      refSchema(
        { query: { type: "string" }, limit: { type: "number" } },
        ["query"],
      ),
    );
    expect(parseExecArgs(two, ["--query", "Milk", "--limit", "5"]).input)
      .toEqual({ query: "Milk", limit: 5 });
    expect(() => parseExecArgs(two, ["--value", "Milk"]))
      .toThrow(/<event> takes "--query", "--limit"/);
    expect(() => parseExecArgs(two, ["--quer", "Milk"]))
      .toThrow(/Did you mean "--query"\?/);

    // The page reports the resolved event rather than calling it void, and
    // names the flags the parser accepts.
    const help = renderExecHelp("/tmp/x.handler", one);
    expect(help).toContain("query: string");
    expect(help).toContain("--query <string>");
    expect(help).not.toContain("Input type:\n  void");
  });

  it("spells a boolean without a placeholder, and a boolean value with one", () => {
    // A boolean FIELD is named bare in Usage, because writing the flag is
    // already the whole of saying true — a placeholder there would invite a
    // value the parser does not take in that position.
    const field = makeSpec("handler", {
      type: "object",
      properties: { done: { type: "boolean" } },
      required: ["done"],
    });
    const fieldHelp = renderExecHelp("/tmp/x.handler", field);
    expect(fieldHelp).toContain("[invoke] --done\n");
    expect(fieldHelp).not.toContain("--done <boolean>");

    // A verb whose whole event IS a boolean has no field to name, so the
    // value rides `--value` and the placeholder says which value it takes.
    const whole = makeSpec("tool", { type: "boolean" });
    const wholeHelp = renderExecHelp("/tmp/x.tool", whole);
    expect(wholeHelp).toContain("--value <boolean>");
  });

  it("keeps a defaulted field optional on the help page too", () => {
    // The page and the parser must answer required-ness the same way. Labelling
    // `--mode` required while the last line says a bare invoke works, and while
    // the parser accepts one, is the page contradicting itself and the caller.
    const spec = makeSpec("handler", {
      $ref: "#/$defs/RefreshEvent",
      asCell: ["stream"],
      $defs: {
        RefreshEvent: {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      },
    } as unknown as JSONSchema);

    const help = renderExecHelp("/tmp/x.handler", spec);
    expect(help).toContain('--mode <string>  Optional. Default: "fast".');
    // Usage names what a call must carry, and this one need carry nothing.
    expect(help).not.toContain("[invoke] --mode");
    expect(help).toContain("Invoke alone will call the handler");
    expect(parseExecArgs(spec, []).input).toEqual({});
  });

  it("leaves a verb schema-less when its $ref lands on no fields", () => {
    // Only where the ref reaches a fields position is there anything to derive.
    // A ref to a scalar, to a position naming nothing, or one that does not
    // resolve leaves the verb invoking bare, as it did before it was followed.
    const streamOf = (defs: Record<string, unknown>) => ({
      $ref: "#/$defs/Target",
      asCell: ["stream"],
      $defs: defs,
    } as unknown as JSONSchema);

    for (
      const inputSchema of [
        streamOf({ Target: {} }),
        streamOf({ Target: { type: "string" } }),
        streamOf({}),
      ]
    ) {
      expect(parseExecArgs(makeSpec("handler", inputSchema), []).input)
        .toBeUndefined();
    }

    // The stream marker is still what makes a bare position schema-less, and
    // following the ref must not take it out of the question. A $ref to a
    // scalar with no marker is a single-value verb, and owes its caller the
    // flags and the input type that go with one.
    const scalarTool = makeSpec("tool", {
      $ref: "#/$defs/Target",
      $defs: { Target: { type: "string" } },
    } as unknown as JSONSchema);
    expect(parseExecArgs(scalarTool, ["--value", "Milk"]).input).toBe("Milk");
    const help = renderExecHelp("/tmp/x.tool", scalarTool);
    expect(help).toContain("--value");
    expect(help).toContain("Input type:\n  string");
    expect(help).not.toContain("Input type:\n  void");
  });

  it("counts a defaulted field as supplied rather than owed", () => {
    // The payload gate relaxes `required` for a field carrying a default, so
    // demanding it at the flag door would refuse a call the runtime fills in.
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        mode: { type: "string", default: "fast" },
        note: { type: "string" },
      },
      required: ["mode"],
    });
    expect(parseExecArgs(spec, []).input).toEqual({});
    expect(parseExecArgs(spec, ["--note", "hi"]).input).toEqual({ note: "hi" });

    // A required field with no default is still owed.
    const owed = makeSpec("handler", {
      type: "object",
      properties: { mode: { type: "string" } },
      required: ["mode"],
    });
    expect(() => parseExecArgs(owed, ["invoke"]))
      .toThrow(/Missing required flag --mode/);
  });

  it("handles each non-object input mode and its errors", () => {
    const booleanSpec = makeSpec("tool", { type: "boolean" });
    const stringSpec = makeSpec("tool", { type: "string" });

    expect(parseExecArgs(booleanSpec, ["--value", "true"]).input).toBe(true);
    expect(() => parseExecArgs(stringSpec, ["--value", "one", "extra"]))
      .toThrow(/Unexpected argument extra/);
    // A verb taking a single value has no fields to name, so the vocabulary
    // is the fixed four rather than schema-derived — but a fixed vocabulary
    // is still a vocabulary, so the near miss is owed here too.
    expect(() => parseExecArgs(stringSpec, ["--other", "value"])).toThrow(
      /"--other" is not a flag this verb takes\./,
    );
    expect(() => parseExecArgs(stringSpec, ["--other", "value"])).toThrow(
      /"--value", "--value-file", "--json", "--json-file"/,
    );
    expect(() => parseExecArgs(stringSpec, ["--valu", "x"]))
      .toThrow(/Did you mean "--value"\?/);
    expect(() => parseExecArgs(stringSpec, ["--zzzzzzzz", "x"]))
      .not.toThrow(/Did you mean/);
    expect(() => parseExecArgs(stringSpec, ["--json", "--other"])).toThrow(
      /cannot be combined/,
    );
    expect(parseExecArgs(stringSpec, ["--json", '"value"']).input).toBe(
      "value",
    );
    expect(parseExecArgs(stringSpec, ["--json-file", "-"])).toMatchObject({
      readJsonFromStdin: true,
      usedJsonInput: true,
    });
    expect(parseExecArgs(stringSpec, ["--json-file", "input.json"]).inputFile)
      .toEqual({ format: "json", path: "input.json" });
  });

  it("validates explicit verbs and explicit-verb help", () => {
    const spec = makeSpec("tool", { type: "object", properties: {} });

    expect(() => parseExecArgs(spec, ["invoke"])).toThrow(/Invalid verb/);
    // `--help` is not unknown — alone it prints the help page. What it does
    // not do is take an argument, and only a verb declaring a `help` field
    // gives it one to fill.
    expect(() => parseExecArgs(spec, ["--help", "extra"])).toThrow(
      /--help takes no arguments/,
    );
    expect(parseExecArgs(spec, ["run", "--help"])).toMatchObject({
      verb: "run",
      showHelp: true,
      showHelpJson: false,
    });
    expect(parseExecArgs(spec, ["run", "--help", "--json"]))
      .toMatchObject({ showHelp: true, showHelpJson: true });
    expect(() => parseExecArgs(spec, ["run", "--help", "extra"])).toThrow(
      /--help takes no arguments/,
    );
  });
});

describe("resolveParsedExecInput edge cases", () => {
  it("reports empty and malformed JSON read from stdin", async () => {
    const spec = makeSpec("tool", { type: "object", properties: {} });
    const parsed = parseExecArgs(spec, ["--json"]);

    await expect(resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve("  \n"),
    })).rejects.toThrow(/Expected JSON/);
    await expect(resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve("not json"),
    })).rejects.toThrow(/Invalid JSON/);
  });

  it("parses primitive stdin and handles terminal or empty implicit input", async () => {
    const primitive = makeSpec("handler", { type: "boolean" });
    const parsed = parseExecArgs(primitive, ["--value-file", "-"]);
    expect(
      await resolveParsedExecInput(primitive, parsed, {
        readTextInput: () => Promise.resolve("false"),
      }),
    ).toBe(false);

    const optional = makeSpec("handler", {
      type: "object",
      properties: {},
    });
    expect(
      (await resolveExecInvocation(optional, [], {
        isStdinTerminal: () => true,
      })).input,
    ).toEqual({});
    expect(
      (await resolveExecInvocation(optional, [], {
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve(""),
      })).input,
    ).toEqual({});
  });

  it("resolves a bare schema-less handler call without reading piped stdin", async () => {
    // A rejecting reader proves stdin stays untouched: a schema-less input
    // declares no payload, so the bare call must not wait on EOF even when
    // stdin is a pipe.
    const deps = {
      isStdinTerminal: () => false,
      readTextInput: () => Promise.reject(new Error("stdin was read")),
    };

    const stream = await resolveExecInvocation(
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
      [],
      deps,
    );
    expect(stream.parsed.verb).toBe("invoke");
    expect(stream.input).toBeUndefined();

    const unschematized = await resolveExecInvocation(
      makeSpec("handler", true),
      [],
      deps,
    );
    expect(unschematized.input).toBeUndefined();

    // The same verb as a stored link carries it: a content-addressed
    // reference, with the declaration on the document it names.
    const referenced = await resolveExecInvocation(
      makeSpec("handler", externalizeSchema({ asCell: ["stream"] })),
      [],
      deps,
    );
    expect(referenced.parsed.verb).toBe("invoke");
    expect(referenced.input).toBeUndefined();
  });

  it("reads piped stdin for a single-value handler whose schema is a content-addressed reference", async () => {
    // The reference's root looks as bare as a schema-less verb's. What the
    // verb takes is on the document it names: a string, so the piped payload
    // is its input and the call is not a bare one.
    const stored = externalizeSchema({ asCell: ["stream"], type: "string" });
    expect(stored).toEqual({ $ref: expect.stringMatching(/^cid:/) });

    const piped = await resolveExecInvocation(
      makeSpec("handler", stored),
      [],
      {
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve("hello"),
      },
    );
    expect(piped.input).toBe("hello");
  });

  it("normalizes only object inputs for tools with a string help field", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: { help: { type: "string" } },
    });

    expect(normalizeCallableInputForExecution(spec, null)).toBe(null);
    expect(normalizeCallableInputForExecution(spec, ["value"])).toEqual([
      "value",
    ]);
    expect(normalizeCallableInputForExecution(spec, { query: "tea" })).toEqual(
      { query: "tea", help: "" },
    );
  });
});

describe("resolveParsedExecInput", () => {
  it("reads text payloads from files for primitive inputs", async () => {
    const spec = makeSpec("handler", { type: "string" });
    const parsed = parseExecArgs(spec, ["--value-file", "/tmp/content.md"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/content.md");
        return Promise.resolve("# Title\n\nLine 2");
      },
    });

    expect(input).toBe("# Title\n\nLine 2");
  });

  it("reads JSON payloads from files for object inputs", async () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        detail: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      },
      required: ["detail"],
    });
    const parsed = parseExecArgs(spec, ["--json-file", "/tmp/input.json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/input.json");
        return Promise.resolve(
          '{"detail":{"value":"Use `cat` to read files"}}',
        );
      },
    });

    expect(input).toEqual({
      detail: { value: "Use `cat` to read files" },
    });
  });

  it("reads --json stdin payloads for object inputs without CLI shape enforcement", async () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    const parsed = parseExecArgs(spec, ["--json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve('["not-an-object"]'),
    });

    expect(input).toEqual(["not-an-object"]);
  });

  it("reads --json-file payloads for object inputs without CLI shape enforcement", async () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    const parsed = parseExecArgs(spec, ["--json-file", "/tmp/input.json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/input.json");
        return Promise.resolve('["not-an-object"]');
      },
    });

    expect(input).toEqual(["not-an-object"]);
  });
});

describe("renderExecHelp", () => {
  it("renders flag-first tool help without schema prose", () => {
    const help = renderExecHelp(
      "/tmp/search.tool",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
          },
          required: ["query"],
        },
        {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      ),
    );

    expect(help).toContain("Usage:");
    expect(help).toContain("cf exec /tmp/search.tool [run] --query <string>");
    expect(help).toContain("cf exec /tmp/search.tool [run] --json");
    expect(help).toContain("cf exec /tmp/search.tool [run] --json-file <path>");
    expect(help).toContain("cf exec /tmp/search.tool [run] --help --json");
    expect(help).toContain("--query <string>");
    expect(help).toContain('Optional input field named "help".');
    expect(help).toContain("Read the full input object from stdin.");
    expect(help).toContain("Read the full input object from a JSON file.");
    expect(help).toContain("Show full schema details as JSON.");
    expect(help).toContain("Output:");
    expect(help).toContain("JSON on success:");
    expect(help).toContain("results");
    expect(help).not.toContain("Callable:");
    expect(help).not.toContain("Input schema:");
  });

  it("renders tuples, const, type arrays, and index signatures in the input type", () => {
    // CT-1895: tuples used to render as "unknown[]"; const, type arrays, and
    // index-signature value types were lossy the same way
    const help = renderExecHelp(
      "/tmp/shapes.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
          },
          rest: {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "boolean" },
          },
          kind: { type: "string", const: "point" },
          maybe: { type: ["string", "null"] },
          counts: { type: "object", additionalProperties: { type: "number" } },
        },
      } as JSONSchema),
    );

    expect(help).toContain("pair?: [string, number, ...unknown[]]");
    expect(help).toContain("rest?: [string, ...boolean[]]");
    expect(help).toContain('kind?: "point"');
    expect(help).toContain("maybe?: string | null");
    expect(help).toContain("counts?: Record<string, number>");
  });

  it("threads the schema's own $defs into the input type", () => {
    const help = renderExecHelp(
      "/tmp/defs.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          user: { $ref: "#/$defs/User" },
        },
        $defs: {
          User: { type: "string" },
        },
      } as JSONSchema),
    );
    // The small definition inlines through the threaded $defs instead of
    // rendering "unknown".
    expect(help).toContain("user?: string");
  });

  it("renders a boolean input schema as unknown", () => {
    const help = renderExecHelp(
      "/tmp/boolean.tool",
      makeSpec("tool", false as JSONSchema),
    );
    expect(help).toContain("Input type:");
    expect(help).toContain("  unknown");
  });

  it("abbreviates the input type at the depth cap", () => {
    // The shared formatter's default maxDepth (4) matches the cap the CLI's
    // own renderer used before it delegated to schemaToTypeString
    const help = renderExecHelp(
      "/tmp/deep.tool",
      makeSpec("tool", {
        type: "object", // depth 0
        properties: {
          a: {
            type: "object", // depth 1
            properties: {
              b: {
                type: "object", // depth 2
                properties: {
                  c: {
                    type: "object", // depth 3
                    properties: {
                      d: { // depth 4: abbreviated
                        type: "object",
                        properties: { e: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as JSONSchema),
    );

    expect(help).toContain("d?: {...}");
    expect(help).not.toContain("e?:");
  });

  it("renders direct mounted-file usage when called via shebang", () => {
    const help = renderExecHelp(
      "./legacyWrite.handler",
      makeSpec("handler", {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("./legacyWrite.handler [invoke] --message <string>");
    expect(help).toContain("./legacyWrite.handler [invoke] --help");
    expect(help).not.toContain("cf exec ./legacyWrite.handler");
    // A handler's help carries no `Output:` section at all: it cannot see a
    // declared result from here, and a verb that declares one does return it,
    // so any fixed claim about output would be false for half the verbs.
    expect(help).not.toContain("Output:");
    expect(help).toContain(
      "Alternatively, write JSON to this file to invoke the handler.",
    );
  });

  it("mentions explicit invoke for handlers whose inputs are all optional", () => {
    const help = renderExecHelp(
      "./legacyWrite.handler",
      makeSpec("handler", {
        type: "object",
        properties: {},
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("./legacyWrite.handler invoke");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("renders schema-less handlers as void no-input callables", () => {
    const help = renderExecHelp(
      "./onAddContact.handler",
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("Input type:");
    expect(help).toContain("  void");
    expect(help).toContain("./onAddContact.handler");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("quotes direct mounted-file usage when the path contains spaces", () => {
    const help = renderExecHelp(
      "/tmp/Fuse Exec Fixture/search.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain(
      "'/tmp/Fuse Exec Fixture/search.tool' [run] --query <string>",
    );
    expect(help).toContain("'/tmp/Fuse Exec Fixture/search.tool' [run] --help");
  });

  it("renders primitive callable flags through --value and --json", () => {
    const help = renderExecHelp(
      "/tmp/number.handler",
      makeSpec("handler", { type: "number" }),
    );

    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --value <number>",
    );
    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --value-file <path>",
    );
    expect(help).toContain("cf exec /tmp/number.handler [invoke] --json");
    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --json-file <path>",
    );
    expect(help).toContain("--value <number>");
    expect(help).toContain("--value-file <path>");
    expect(help).toContain("Read the full input value as JSON from stdin.");
    expect(help).toContain(
      "Read the value from a UTF-8 file. Use - for stdin.",
    );
  });

  it("renders boolean help fields without colliding with command help", () => {
    const help = renderExecHelp(
      "/tmp/search.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
    );

    expect(help).toContain("--help=<boolean> | --no-help");
    expect(help).toContain("Boolean. Use --help=true or --no-help.");
  });

  it("renders typed flags, schema details, deep shapes, and empty output objects", () => {
    const help = renderExecHelp(
      "/tmp/complex.tool",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: true,
              description: "Enables the operation.",
            },
            count: { type: "integer" },
            settings: { type: "object", properties: {} },
            items: { type: "array", items: { type: "string" } },
            nothing: { type: "null" },
            mode: { enum: ["fast", "safe"] },
            choice: { anyOf: [{ type: "string" }, { type: "number" }] },
            deep: {
              type: "object",
              properties: {
                one: {
                  type: "object",
                  properties: {
                    two: {
                      type: "object",
                      properties: {
                        three: {
                          type: "object",
                          properties: { four: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          required: ["enabled", "count", "settings", "items", "nothing"],
        },
        { type: "object", properties: {} },
      ),
    );

    expect(help).toContain("--enabled | --no-enabled");
    expect(help).toContain("--count <integer>");
    expect(help).toContain("--settings <json-object>");
    expect(help).toContain("--items <json-array>");
    expect(help).toContain("--nothing <null>");
    expect(help).toContain('Allowed: "fast" | "safe".');
    expect(help).toContain("Default: true.");
    expect(help).toContain("Enables the operation.");
    expect(help).toContain("choice?: string | number");
    expect(help).toContain("{...}");
    expect(help).toContain("JSON on success.");
  });
});

describe("renderExecHelpJson", () => {
  it("renders machine-readable schema details", () => {
    const schema = JSON.parse(
      renderExecHelpJson(
        makeSpec(
          "tool",
          {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          {
            type: "object",
            properties: {
              summary: { type: "string" },
            },
          },
        ),
      ),
    );

    expect(schema.callableKind).toBe("tool");
    expect(schema.inputSchema.required).toEqual(["query"]);
    expect(schema.outputSchema.properties.summary.type).toBe("string");
  });
});

describe("renderPieceCallHelp", () => {
  it("renders piece-call help with top-level help lines and JSON input", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... search",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
          },
          required: ["query"],
        },
        {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      ),
    );

    expect(help).toContain("cf piece call ... search --help");
    expect(help).toContain("cf piece call ... search --help --json");
    expect(help).toContain("cf piece call ... search <json>");
    expect(help).toContain("cf piece call ... search --json [<json>]");
    // The verb opens the section, so its own flags follow the name with
    // nothing between; the marker appears once, on the read-option line.
    expect(help).toContain(
      "cf piece call ... search [run] --query <string>",
    );
    expect(help).toContain("cf piece call ... search ... -- --select <fields>");
    expect(help).not.toContain("cf piece call ... search -- ");
    expect(help).toContain("JSON input:");
    expect(help).toContain(
      "Pass inline JSON as one positional argument or after `--json`",
    );
    expect(help).toContain("query: string");
    expect(help).toContain("help?: string");
    expect(help).toContain("Flags:");
    expect(help).not.toContain("Read the full input object from stdin.");
    expect(help).not.toContain("cf piece call ... search [run] --help");
  });

  it("renders bare usage for schema-less handler piece-call help", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... onAddContact",
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
    );

    expect(help).toContain("cf piece call ... onAddContact");
    expect(help).toContain("cf piece call ... onAddContact invoke");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("enumerates a handler's declared result under Output", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... addItem",
      makeSpec(
        "handler",
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        {
          type: "object",
          properties: {
            item: { type: "object" },
            openBelow: { type: "number" },
          },
        },
      ),
    );

    // The section closes the page, so comparing the tail compares the whole
    // section: `title <string>` also occurs in the flags above it as
    // `--title <string>`, which a containment check could not tell apart.
    expect(help.slice(help.indexOf("\n\nOutput:\n"))).toBe(
      [
        "",
        "",
        "Output:",
        "  The invocation's `result`:",
        "    item <json-object>",
        "    openBelow <number>",
      ].join("\n"),
    );
  });

  it("names the type of a handler result that is not an object", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... rename",
      makeSpec(
        "handler",
        { type: "object", properties: { title: { type: "string" } } },
        { type: "array", items: { type: "string" } },
      ),
    );

    expect(help.slice(help.indexOf("\n\nOutput:\n"))).toBe(
      [
        "",
        "",
        "Output:",
        "  The invocation's `result`:",
        "    string[]",
      ].join("\n"),
    );
  });

  it("prints a result field's own description beside its placeholder", () => {
    // The description is a ref-site sibling on the property — the shape a
    // declared result actually arrives in — so no resolution stands between
    // the wire and the page. Aligned as the flags are, and a multi-line
    // comment continues under its own first line.
    const help = renderPieceCallHelp(
      "cf piece call ... addItem",
      makeSpec(
        "handler",
        { type: "object", properties: { title: { type: "string" } } },
        {
          type: "object",
          properties: {
            item: {
              "$ref": "#/$defs/ItemOutput",
              description: "The root item this call created.",
            } as never,
            openBelow: {
              type: "number",
              description: "Descendants still open.\nZero means done.",
            },
          },
        },
      ),
    );

    expect(help.slice(help.indexOf("\n\nOutput:\n"))).toBe(
      [
        "",
        "",
        "Output:",
        "  The invocation's `result`:",
        "    item <json>         The root item this call created.",
        "    openBelow <number>  Descendants still open.",
        "                        Zero means done.",
      ].join("\n"),
    );
  });

  it("mentions no file to write JSON to, there being none in this context", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... onAddContact",
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
    );

    // The write-through note belongs to the mounted-file page, which this
    // renderer shares its body with. `cf piece call` takes its payload as an
    // argument and mounts nothing, so the sentence would name a file the
    // caller has no way to reach — and it is the last line of the page.
    expect(help).not.toContain("write JSON to this file");
    expect(help).not.toContain("Alternatively");
    // The neighboring note is about this command's own spelling, and stays.
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("carries no Output section for a handler that declares no result", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... archive",
      makeSpec("handler", { type: "object", properties: {} }),
    );

    // The value-less shape, which is the common one: the page says nothing
    // about output rather than asserting there is none.
    expect(help).not.toContain("Output:");
  });
});

describe("exec command user-facing errors", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-cli-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("prints readable errors without a raw stack trace", async () => {
    const missingPath = join(tmpDir, "missing.handler");
    const { code, stdout, stderr } = await cf(`exec ${missingPath}`);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);

    const relevant = relevantStderr(stderr).filter((line) =>
      !line.includes("deno run ")
    );

    expect(relevant).toEqual([
      `Path is not within a mounted cf fuse filesystem: ${missingPath}`,
    ]);
    expect(relevant.join("\n")).not.toMatch(/\n\s*at\s+/);
    expect(relevant.join("\n")).not.toMatch(
      /executeMountedCallableFile|resolveMountedCallableFile/,
    );
  });
});

describe("mounted callable resolution and execution", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-test-" });
    stateDir = join(tmpDir, "state");
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("rejects non-mounted paths", async () => {
    await expect(
      resolveMountedCallableFile(join(tmpDir, "outside.handler"), {
        stateDir,
      }),
    ).rejects.toThrow(/not within a mounted cf fuse filesystem/i);
  });

  it("rejects mounted non-callable files", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/title",
      pieceId: "of:piece-123",
    });
    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
      }),
    ).rejects.toThrow(/not a mounted callable file/i);
  });

  it("rejects suffix-only callable paths whose cell kind does not match", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/title.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "title",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      }),
    ).rejects.toThrow(/does not resolve to a handler/i);
  });

  it("rejects fabricated mounted callable paths whose file is missing", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "title.handler");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const delays: number[] = [];
    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/mounted callable file not found/i);

    // One bounded wait to outlast the directory listing cache, then failure.
    // The macOS NFS client serves cached listings for up to ~3s, so the
    // wait must exceed that for the recheck to reach the daemon.
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThan(3000);
  });

  it("tolerates transient mounted callable ENOENT during FUSE invalidation", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "search.tool");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    await writeLiveMountState(stateDir, mountpoint);

    // The file exists, but stat reports NotFound the way a stale FUSE-T
    // kernel cache does while the bridge rebuilds the prop subtree. The
    // resolver falls back to the parent directory listing, which names
    // the file.
    const statCalls: string[] = [];
    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
      stat: (path) => {
        statCalls.push(path);
        return Promise.reject(
          new Deno.errors.NotFound(`stat '${path}': invalidated`),
        );
      },
    });

    expect(statCalls.length).toBe(1);
    expect(statCalls[0].endsWith(join("result", "search.tool"))).toBe(true);
    expect(resolved.absPath).toBe(filePath);
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("consults the parent listing again after a stale cached listing", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "search.tool");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    await writeLiveMountState(stateDir, mountpoint);

    // stat reports NotFound and the first parent listing is served from a
    // cache that predates the file; only the listing taken after the cache
    // validity window names it.
    const readDirCalls: string[] = [];
    const delays: number[] = [];
    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
      stat: (path) =>
        Promise.reject(new Deno.errors.NotFound(`stat '${path}': invalidated`)),
      readDir: (path) => {
        readDirCalls.push(path);
        return readDirCalls.length === 1
          ? (async function* (): AsyncIterable<Deno.DirEntry> {})()
          : Deno.readDir(path);
      },
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(readDirCalls.length).toBe(2);
    expect(delays.length).toBe(1);
    expect(resolved.absPath).toBe(filePath);
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("resolves the correct mount by longest-prefix lookup", async () => {
    const parentMount = join(tmpDir, "mount");
    const nestedMount = join(parentMount, "nested");
    const filePath = await createMountedFile(nestedMount, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      toolResult: { ok: true },
    });

    await writeLiveMountState(stateDir, parentMount, "http://localhost:8000");
    await writeLiveMountState(stateDir, nestedMount, "http://localhost:9000");

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.mount.entry.mountpoint).toBe(nestedMount);
    expect(resolved.mount.entry.apiUrl).toBe("http://localhost:9000");
  });

  it("uses sibling meta.json to recover the canonical piece id for de-duped names", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:canonical-piece",
      patternRef: {
        identity: "A".repeat(43),
        symbol: "default",
        source: {
          ref: `cf:pattern:${"A".repeat(43)}`,
          repository: "https://github.com/commonfabric/labs",
          entry: "/notes/note.tsx",
          origin: "file:///repo/notes/note.tsx",
        },
      },
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:canonical-piece",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      toolResult: { ok: true },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.pieceId).toBe("of:canonical-piece");
    expect(resolved.pieceMeta.patternRef).toEqual({
      identity: "A".repeat(43),
      symbol: "default",
      source: {
        ref: `cf:pattern:${"A".repeat(43)}`,
        repository: "https://github.com/commonfabric/labs",
        entry: "/notes/note.tsx",
        origin: "file:///repo/notes/note.tsx",
      },
    });
  });

  it("resolves callable paths under both pieces and entities", async () => {
    const mountpoint = join(tmpDir, "mount");
    const piecesPath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const entitiesPath = await createMountedFile(mountpoint, {
      relativePath: "home/entities/of:piece-123/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const piecesResolved = await resolveMountedCallableFile(piecesPath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });
    const entitiesResolved = await resolveMountedCallableFile(entitiesPath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(piecesResolved.callablePath.rootKind).toBe("pieces");
    expect(entitiesResolved.callablePath.rootKind).toBe("entities");
    expect(piecesResolved.pieceId).toBe("of:piece-123");
    expect(entitiesResolved.pieceId).toBe("of:piece-123");
  });

  it("resolves root-level FS projection callables as result callables", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "add.handler");
    await Deno.mkdir(pieceDir, { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath).toEqual({
      spaceName: "home",
      rootKind: "pieces",
      rootName: "notes-2",
      cellProp: "result",
      cellKey: "add",
      callableKind: "handler",
      rootLevel: true,
    });
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("resolves sparse stream handler cells whose value is undefined", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      sparseHandlerCell: true,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath.callableKind).toBe("handler");
  });

  it("resolves callable paths through a symlinked alias of the mountpoint", async () => {
    const realRoot = join(tmpDir, "real");
    const mountpoint = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    await Deno.mkdir(mountpoint, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const filePath = join(
      aliasRoot,
      "mount/home/pieces/notes-2/result/add.handler",
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath.rootKind).toBe("pieces");
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("reads mounted metadata from the canonical target of symlinked callable paths", async () => {
    const mountpoint = join(tmpDir, "mount");
    const realPath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:real-piece",
    });
    const aliasDir = join(tmpDir, "alias", "result");
    await Deno.mkdir(aliasDir, { recursive: true });
    const aliasPath = join(aliasDir, "add.handler");
    await Deno.symlink(realPath, aliasPath);
    await Deno.writeTextFile(
      join(tmpDir, "alias", "meta.json"),
      JSON.stringify({
        id: "of:fake-piece",
        entityId: "of:fake-piece",
        name: "Fake Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:real-piece",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(aliasPath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: (_manager, pieceId) => {
        expect(pieceId).toBe("of:real-piece");
        return Promise.resolve(harness.piece);
      },
    });

    expect(resolved.pieceId).toBe("of:real-piece");
  });

  it("calls asSchemaFromLinks on the resolved child cell", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(harness.tracker.asSchemaFromLinksCalls).toBeGreaterThan(0);
  });

  it("starts the piece before dispatching a mounted handler", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const runItArgs: boolean[] = [];
    (harness.pieces as unknown as {
      get: (pieceId: string, runIt?: boolean) => Promise<unknown>;
    }).get = (pieceId, runIt) => {
      runItArgs.push(runIt ?? false);
      expect(pieceId).toBe("of:piece-123");
      return Promise.resolve(harness.piece);
    };

    await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
      },
    );

    expect(runItArgs).toEqual([true]);
  });

  it("dispatches handlers through the same piece-property path used by FUSE writes", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.outputText).toBeUndefined();
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("preserves the Cell.send receiver when dispatching mounted handlers", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      handlerSendRequiresReceiver: true,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(filePath, ["--query", "milk"], {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("surfaces mounted handler transaction failures as errors", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      handlerFailureMessage: "Mounted handler failed",
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(
        filePath,
        ["--message", "milk"],
        {
          stateDir,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(/Handler "add" failed: Mounted handler failed/);
  });

  it("dispatches tools with extraParams merged into the runtime input and returns JSON output", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
            result: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
        result: "bound-result",
      },
      toolResult: {
        echoed: "tea",
        source: "bound-source",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadPieces: () => Promise.resolve(harness.pieces),
      loadPiece: () => Promise.resolve(harness.piece),
    });
    const loadConfigs: SpaceConfig[] = [];
    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadPieces: (config) => {
          loadConfigs.push(config);
          return Promise.resolve(harness.pieces);
        },
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(loadConfigs).toHaveLength(1);
    expect(loadConfigs[0].jsonOutput).toBe(true);
    expect(
      Object.keys(
        (resolved.commandSpec.inputSchema as {
          properties?: Record<string, unknown>;
        })
          .properties ?? {},
      ),
    ).toEqual(["query", "help"]);
    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      help: "",
      source: "bound-source",
      result: "bound-result",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      echoed: "tea",
      source: "bound-source",
    });
  });

  it("settles mounted tool results before reading, without polling", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolResult: { echoed: "tea" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    // Commit, then drain to a fully settled state, then read the result cell
    // once. No poll loop and no deadline: `settled()` awaits the tool's async
    // work to completion. The trailing sync is the auto-step that follows
    // every mounted invocation.
    expect(harness.tracker.events).toEqual([
      "run",
      "idle",
      "commit",
      "settled",
      "pieces.synced",
    ]);
    expect(JSON.parse(result.outputText!)).toEqual({ echoed: "tea" });
  });

  it("uses mounted tool sink output after a successful commit", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolSinkValue: { echoed: "from-sink" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    // The sink reported the result, so after settling there is no result-cell
    // read at all — the sink value is authoritative.
    expect(harness.tracker.events).toEqual([
      "run",
      "sink",
      "idle",
      "commit",
      "settled",
      "pieces.synced",
    ]);
    expect(JSON.parse(result.outputText!)).toEqual({ echoed: "from-sink" });
  });

  it("fails loudly when a mounted tool settles without a result", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      // No toolResult, no sink value, no recorded error: the tool settled
      // without producing anything.
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(filePath, ["--query", "tea"], {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      }),
    ).rejects.toThrow('Tool "search" produced no result.');
  });

  it("surfaces the recorded runtime error when a mounted tool produces no result", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      // The tool run records a runtime error and writes no result.
      toolRunError: "boom from the tool pattern",
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(filePath, ["--query", "tea"], {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      }),
    ).rejects.toThrow('Tool "search" failed: boom from the tool pattern');
  });

  it("pulls mounted tool result cells before serializing output", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResultGetValue: {
        query: "explicit",
        help: "schema-field",
        source: "bound-source",
        summary: "bound-source:explicit:undefined",
      },
      toolResultPullValue: {
        query: "explicit",
        help: "schema-field",
        source: "bound-source",
        summary: "bound-source:explicit:schema-field",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "explicit", "--help", "schema-field"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "explicit",
      help: "schema-field",
      source: "bound-source",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      query: "explicit",
      help: "schema-field",
      source: "bound-source",
      summary: "bound-source:explicit:schema-field",
    });
  });

  it("allocates tool result cells in the resolved space DID", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      managerSpace: "did:key:resolved-space",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolResult: {
        echoed: "tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(harness.tracker.toolResultSpace).toBe("did:key:resolved-space");
  });

  it("reads --json input from stdin for mounted handlers", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        readJsonInput: () => Promise.resolve({ query: "milk" }),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("infers piped stdin for mounted primitive handlers when no args are provided", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: { type: "string" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      [],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve("# Title\n\nLine 2"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: "# Title\n\nLine 2",
      },
    ]);
  });

  it("refuses implicit piped JSON that cannot satisfy a mounted object handler", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(
        filePath,
        [],
        {
          stateDir,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve('["not-an-object"]'),
        },
      ),
    ).rejects.toThrow(/Invalid input for "add"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("passes stdin --json through unchanged for mounted tools", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
        readJsonInput: () => Promise.resolve({ query: "tea" }),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      source: "bound-source",
    });
  });

  it("passes inline --json through unchanged for mounted tools", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json", '{"query":"tea"}'],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      source: "bound-source",
    });
  });

  it("refuses stdin --json that cannot satisfy the linked handler schema", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    // stdin is still parsed as JSON verbatim — the CLI does not reshape it.
    // What changed is that a payload the verb cannot accept stops here rather
    // than dispatching and settling as if it had worked.
    await expect(
      executeMountedCallableFile(
        filePath,
        ["--json"],
        {
          stateDir,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          readJsonInput: () => Promise.resolve(["not-an-object"]),
        },
      ),
    ).rejects.toThrow(/Invalid input for "add"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("refuses an absent payload for a mounted handler that cannot run without one", async () => {
    // A mounted handler whose event schema sits behind a top-level local $ref
    // is refused at the flag door, which reads the definition's fields and can
    // name the type the caller must supply. Nothing dispatches, so an
    // invocation id is never spent.

    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        $ref: "#/$defs/AddEvent",
        asCell: ["stream"],
        $defs: {
          AddEvent: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      } as JSONSchema,
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(
        filePath,
        [],
        {
          stateDir,
          loadPieces: () => Promise.resolve(harness.pieces),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => true,
        },
      ),
    ).rejects.toThrow(
      /Handler requires input\. Expected type: \{\s*query: string\s*\}/,
    );

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("returns machine-readable schema details for --help --json", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            source: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--help", "--json"],
      {
        stateDir,
        loadPieces: () => Promise.resolve(harness.pieces),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.helpText).toBeDefined();
    expect(JSON.parse(result.helpText!)).toEqual({
      callableKind: "tool",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
      },
    });
  });
});

async function writeLiveMountState(
  stateDir: string,
  mountpoint: string,
  apiUrl = "http://localhost:8000",
) {
  await Deno.mkdir(mountpoint, { recursive: true });
  await writeMountState(stateDir, {
    pid: Deno.pid,
    mountpoint,
    apiUrl,
    identity: "/tmp/test-identity.pem",
    startedAt: "2026-03-17T00:00:00.000Z",
  });
}

async function createMountedFile(
  mountpoint: string,
  options: {
    relativePath: string;
    pieceId: string;
    patternRef?: {
      identity: string;
      symbol: string;
      source: {
        ref: string;
        repository?: string;
        entry?: string;
        origin?: string;
      };
    };
  },
): Promise<string> {
  const absPath = join(mountpoint, options.relativePath);
  await Deno.mkdir(dirname(absPath), { recursive: true });
  await Deno.writeTextFile(absPath, "");

  const metaPath = join(dirname(dirname(absPath)), "meta.json");
  await Deno.writeTextFile(
    metaPath,
    JSON.stringify({
      id: options.pieceId,
      entityId: options.pieceId,
      name: "Fixture Piece",
      ...(options.patternRef === undefined
        ? {}
        : { patternRef: options.patternRef }),
    }),
  );

  return absPath;
}

function createExecHarness(options: {
  callableKind: "handler" | "tool";
  cellProp: "input" | "result";
  cellKey: string;
  pieceId: string;
  managerSpace?: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  };
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
  toolResultGetValue?: unknown;
  toolResultPullValue?: unknown;
  toolSinkValue?: unknown;
  toolRunError?: string;
  handlerFailureMessage?: string;
  handlerSendRequiresReceiver?: boolean;
  sparseHandlerCell?: boolean;
}) {
  const tracker = {
    events: [] as string[],
    asSchemaFromLinksCalls: 0,
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    toolRunInput: undefined as unknown,
    toolResultSpace: undefined as string | undefined,
  };

  const callableSchema: JSONSchema = options.callableKind === "tool"
    ? {
      type: "object",
      properties: {
        pattern: { type: "object" },
        extraParams: { type: "object" },
      },
    }
    : options.inputSchema;
  const callableValue = options.callableKind === "tool"
    ? {
      pattern: options.pattern,
      extraParams: options.extraParams ?? {},
    }
    : options.sparseHandlerCell
    ? undefined
    : { $stream: true };
  const runtimeErrors: Array<{ message: string }> = [];
  const handlerSend = function (
    this: unknown,
    value: unknown,
    onCommit?: (
      tx: { status: () => { status: string; error?: Error } },
    ) => void,
  ) {
    if (options.handlerSendRequiresReceiver && this !== callableCell) {
      throw new Error("Cell.send receiver lost");
    }
    tracker.handlerWrites.push({
      cellProp: "result",
      path: [options.cellKey],
      value,
    });
    if (options.handlerFailureMessage) {
      runtimeErrors.push({ message: options.handlerFailureMessage });
    }
    onCommit?.({
      status: () =>
        options.handlerFailureMessage
          ? {
            status: "error",
            error: new Error(options.handlerFailureMessage),
          }
          : { status: "done" },
    });
  };
  const callableCell = createMockCell(
    callableValue,
    callableSchema,
    options.callableKind === "handler"
      ? {
        onSchemaFromLinks: () => {
          tracker.asSchemaFromLinksCalls++;
        },
        isStream: () => options.sparseHandlerCell === true,
        send: handlerSend,
      }
      : {
        onSchemaFromLinks: () => {
          tracker.asSchemaFromLinksCalls++;
        },
      },
  );
  const rootCell = createMockCell(
    {
      [options.cellKey]: callableValue,
    },
    {
      type: "object",
      properties: {
        [options.cellKey]: callableSchema,
      },
    },
    {
      childOverrides: { [options.cellKey]: callableCell },
    },
  );

  const state = {
    value: options.toolResult,
    getValue: options.toolResultGetValue,
    pullValue: options.toolResultPullValue,
  };
  const resultCell = {
    get: () => state.getValue ?? state.value,
    pull: () => Promise.resolve(state.pullValue ?? state.value),
    key: (_key: string) => resultCell,
    asSchemaFromLinks: () => resultCell,
    getAsNormalizedFullLink: () => ({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: "space",
      path: [],
    }),
  };

  const piece = {
    id: options.pieceId,
    getCell: () => ({ pull: () => Promise.resolve() }),
    input: {
      getCell: () => Promise.resolve(rootCell),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "input", path, value });
        return Promise.resolve();
      },
    },
    result: {
      getCell: () => Promise.resolve(rootCell),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "result", path, value });
        return Promise.resolve();
      },
    },
  };

  const pieces = {
    getSpace: () => options.managerSpace ?? "home",
    synced: () => {
      tracker.events.push("pieces.synced");
      return Promise.resolve();
    },
    runtime: {
      [CF_RUNTIME_ERROR_LOG]: runtimeErrors,
      storageManager: {
        synced: () => {
          tracker.events.push("storage.synced");
          return Promise.resolve();
        },
      },
      edit: () => ({
        commit: () => {
          tracker.events.push("commit");
          return Promise.resolve();
        },
        // The real transaction reports both, and the write receipt reads
        // them rather than treating a resolved `commit()` as proof of a
        // write. This stub stages none, so it reports none.
        status: () => ({ status: "done", journal: { novelty: () => [] } }),
      }),
      prepareTxForCommit: () => {},
      getCell: (
        space: string,
        _id: string,
        _schema: JSONSchema | undefined,
        _tx: unknown,
      ) => {
        tracker.toolResultSpace = space;
        return resultCell;
      },
      run: (
        _tx: unknown,
        _pattern: unknown,
        input: unknown,
        _result: unknown,
      ) => {
        tracker.events.push("run");
        tracker.toolRunInput = input;
        if (options.toolRunError !== undefined) {
          runtimeErrors.push({ message: options.toolRunError });
        }
        state.value = options.toolResult;
        state.getValue = options.toolResultGetValue ?? options.toolResult;
        state.pullValue = options.toolResultPullValue ?? options.toolResult;
        return {
          sink: (callback: (value: unknown) => void) => {
            if (options.toolSinkValue !== undefined) {
              tracker.events.push("sink");
              callback(options.toolSinkValue);
            }
            return () => {};
          },
        };
      },
      idle: () => {
        tracker.events.push("idle");
        return Promise.resolve();
      },
      settled: () => {
        tracker.events.push("settled");
        return Promise.resolve();
      },
    },
  };

  // The doubles implement the slice of the controller and piece surfaces the
  // invocation engine exercises; the cast is at this seam alone.
  return {
    pieces: pieces as unknown as PiecesController,
    piece: piece as unknown as PieceController,
    tracker,
  };
}

function createMockCell(
  value: unknown,
  schema: JSONSchema | undefined,
  options?: {
    childOverrides?: Record<string, ReturnType<typeof createMockCell>>;
    onSchemaFromLinks?: () => void;
    send?: (
      value: unknown,
      onCommit?: (
        tx: { status: () => { status: string; error?: Error } },
      ) => void,
    ) => void;
    isStream?: () => boolean;
  },
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => {
      options?.onSchemaFromLinks?.();
      return cell;
    },
    getAsNormalizedFullLink: () => ({
      id: "of:mock-cell",
      space: "did:key:test-home",
      scope: "space",
      path: [],
    }),
    send: options?.send,
    isStream: options?.isStream,
    key: (key: string) => {
      if (options?.childOverrides?.[key]) {
        return options.childOverrides[key];
      }
      const nextValue = isObjectNotArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
      const nextSchema = getChildSchema(schema, key);
      return createMockCell(nextValue, nextSchema);
    },
  };

  return cell;
}

function getChildSchema(
  schema: JSONSchema | undefined,
  key: string,
): JSONSchema | undefined {
  if (
    !schema || !isObjectNotArray(schema)
  ) {
    return undefined;
  }

  const properties = schema.properties;
  if (!isObjectNotArray(properties)) {
    return undefined;
  }

  return properties[key] as JSONSchema | undefined;
}
