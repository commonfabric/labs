import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

const HELPERS = `export interface Ping {
  word: string;
}
export interface PingResult {
  echoed: string;
}
export function echoImported(
  event: Ping,
  _state: { count: number },
): PingResult {
  return { echoed: event.word };
}
// deno-lint-ignore no-explicit-any
export const echoAny: any = ((event: Ping) => ({
  echoed: event.word,
  // deno-lint-ignore no-explicit-any
})) as any;
export type EchoHandler = (event: Ping) => PingResult;
// deno-lint-ignore no-explicit-any
export const echoSatisfies: any = ((event: Ping) => ({
  echoed: event.word,
})) satisfies EchoHandler;
`;

const MAIN = `import { cell, handler, pattern, Stream } from "commonfabric";
import { echoImported, type Ping, type PingResult } from "./helpers.ts";

interface Verbs {
  ping: Stream<Ping, PingResult>;
}

const ping = handler<Ping, { count: number }, PingResult>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  echoImported,
);

export default pattern<Record<string, never>, Verbs>(() => {
  const count = cell(0);
  return { ping: ping({ count }) };
});
`;

describe("schema-first-imported-callback", () => {
  it("keeps an imported callback in the runtime's callback position", async () => {
    // A callback imported from another module reaches recognition as its
    // import ALIAS symbol; resolving the alias is what lets the schema-first
    // form pass through un-prepended. Without it, the injection prepended
    // two generated schemas and the callback left the positions the runtime
    // dispatch reads (argument 0 or 2). Asserted on the emitted call shape:
    // authored schemas at 0 and 1, the imported callback at 2, and the
    // declared result lowered onto the trailing options — four arguments,
    // not six.
    const output = await transformFiles({
      "/main.tsx": MAIN,
      "/helpers.ts": HELPERS,
    }, { types: COMMONFABRIC_TYPES });
    const module = parseModule(output["/main.tsx"]);
    const [call] = callsNamed(module, "handler");
    expect(call).toBeDefined();
    expect(call.arguments.length).toBe(4);
    expect(call.arguments[2].getText(module)).toBe("echoImported");
    expect(call.arguments[3].getText(module)).toContain("resultSchema");
  });

  it("merges a declared result into an existing runtime options slot", async () => {
    // The lowered runtime form can already carry options, although the public
    // handler overloads expose the result through type arguments alone.
    const main = MAIN.replace(
      "  echoImported,\n);",
      '  echoImported,\n  { resultSchema: { type: "number" } },\n);',
    );
    const output = await transformFiles({
      "/main.tsx": main,
      "/helpers.ts": HELPERS,
    }, { types: COMMONFABRIC_TYPES });
    const module = parseModule(output["/main.tsx"]);
    const calls = callsNamed(module, "handler");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.arguments).toHaveLength(4);
    const callback = call.arguments[2];
    assert(ts.isIdentifier(callback));
    expect(callback.text).toBe("echoImported");

    const options = call.arguments[3];
    assert(ts.isObjectLiteralExpression(options));
    expect(options.properties).toHaveLength(2);
    const [preserved, result] = options.properties;
    assert(ts.isSpreadAssignment(preserved));
    expect(literalToValue(preserved.expression)).toEqual({
      resultSchema: { type: "number" },
    });
    assert(ts.isPropertyAssignment(result));
    assert(ts.isIdentifier(result.name));
    expect(result.name.text).toBe("resultSchema");
    expect(literalToValue(result.initializer)).toEqual({
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
    });
  });

  it("recognizes an imported callback whose type degraded to `any`", async () => {
    // `any` reports no call signatures and the syntactic resolver cannot
    // cross modules, so neither semantic nor local recognition sees this
    // callback — the declaration fallback does: the aliased symbol's
    // initializer is function-like. Without it the injection prepends
    // schemas and displaces the callback.
    const main = MAIN.replace(
      "import { echoImported, type Ping, type PingResult }",
      "import { echoAny, echoImported, type Ping, type PingResult }",
    ).replace(
      "  echoImported,\n);",
      "  echoAny,\n);",
    );
    const output = await transformFiles({
      "/main.tsx": main,
      "/helpers.ts": HELPERS,
    }, { types: COMMONFABRIC_TYPES });
    const module = parseModule(output["/main.tsx"]);
    const [call] = callsNamed(module, "handler");
    expect(call).toBeDefined();
    expect(call.arguments.length).toBe(4);
    expect(call.arguments[2].getText(module)).toBe("echoAny");
    expect(call.arguments[3].getText(module)).toContain("resultSchema");
  });

  it("recognizes an imported `any` callback behind a `satisfies` constraint", async () => {
    // `satisfies T` checks the value against T and leaves it exactly as
    // written, so it is transparent for the same reason parentheses and `as`
    // are. With the alias annotated `any` the wrapper is the only thing
    // between the declaration fallback and the function it needs to see.
    const main = MAIN.replace(
      "import { echoImported, type Ping, type PingResult }",
      "import { echoSatisfies, echoImported, type Ping, type PingResult }",
    ).replace(
      "  echoImported,\n);",
      "  echoSatisfies,\n);",
    );
    const output = await transformFiles({
      "/main.tsx": main,
      "/helpers.ts": HELPERS,
    }, { types: COMMONFABRIC_TYPES });
    const module = parseModule(output["/main.tsx"]);
    const [call] = callsNamed(module, "handler");
    expect(call).toBeDefined();
    expect(call.arguments.length).toBe(4);
    expect(call.arguments[2].getText(module)).toBe("echoSatisfies");
    expect(call.arguments[3].getText(module)).toContain("resultSchema");
  });
});
