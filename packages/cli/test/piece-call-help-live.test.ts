import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { executePieceCallable } from "../lib/piece.ts";

/**
 * One pattern with three verbs: a declared object result, a declared scalar
 * result, and the value-less shape.
 *
 * The help page is driven against a COMPILED, RUN pattern rather than a
 * hand-built graph, because the thing under test is a structural match against
 * what the compiler emits: a handler node's `$event` input and the result
 * property exposing that handler's stream are the same cell written twice, and
 * a double asserts that agreement instead of demonstrating it. The declared
 * result itself is lowered by the transformer from `Stream<E, R>`'s `R`, which
 * only a real compile produces.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "interface AddResult {",
      "  /** The title as filed. */",
      "  title: string;",
      "  /** How many items the list now holds. */",
      "  total: number;",
      "}",
      "interface RenameEvent { title: string; }",
      "",
      "interface Out {",
      "  items: string[];",
      "  add: Stream<AddEvent, AddResult>;",
      "  rename: Stream<RenameEvent, string>;",
      "  clear: Stream<void>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<string[]>([]);",
      "  const add = action<AddEvent, AddResult>((event) => {",
      "    items.push(event.title);",
      "    return { title: event.title, total: items.get().length };",
      "  });",
      "  const rename = action<RenameEvent, string>((event) => {",
      "    items.set([event.title]);",
      "    return event.title;",
      "  });",
      "  const clear = action(() => { items.set([]); });",
      "  return { items, add, rename, clear };",
      "});",
    ].join("\n"),
  }],
};

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:live",
  space: "" as string,
};

/** Drive `cf piece call <verb> <args>` against a freshly run instance of the
 * program above, and hand back what the command produced. */
async function callVerb(
  verb: string,
  rawArgs: string[],
  options: { patternError?: Error } = {},
): Promise<{ helpText?: string; patternLoads: number }> {
  const signer = await Identity.fromPassphrase("piece-call-help-live");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, "call-help-live", undefined, tx);
    const root = runtime.run(tx, compiled, {}, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await root.pull();

    // The piece surface the callable resolver walks, plus the pattern handle
    // it reads a declared result through. Counting the loads is how the test
    // sees whether the help path paid for one — a call that dispatches must
    // not.
    let patternLoads = 0;
    const piece = {
      result: { getCell: () => Promise.resolve(root) },
      input: {
        getCell: () => Promise.resolve(runtime.getCell(space, "empty-input")),
      },
      getCell: () => root,
      getPattern: () => {
        patternLoads++;
        return options.patternError
          ? Promise.reject(options.patternError)
          : Promise.resolve(compiled);
      },
    };

    const executed = await executePieceCallable(
      { ...CONFIG, space },
      verb,
      rawArgs,
      {
        loadPieces: () =>
          Promise.resolve({ getSpace: () => space, runtime } as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    return { helpText: executed.helpText, patternLoads };
  } finally {
    await runtime.dispose?.();
    await storageManager.close?.();
  }
}

/** The page's `Output:` section, which closes it, or `undefined` when the page
 * carries none. Sliced out and compared whole rather than searched for its
 * lines: `title <string>` occurs in the flags above it as `--title <string>`,
 * so a containment check would pass against a page with no output section at
 * all. */
function outputSection(helpText: string | undefined): string | undefined {
  const marker = "\n\nOutput:\n";
  const at = (helpText ?? "").indexOf(marker);
  return at === -1 ? undefined : helpText!.slice(at + marker.length);
}

describe("cf piece call --help against a live piece", () => {
  it("enumerates the fields of a verb's declared result", async () => {
    const { helpText } = await callVerb("add", ["--help"]);

    // Both fields of `AddResult`, each with the placeholder its type renders
    // as, named at the position a caller collects them from — and each
    // carrying its own doc comment, compiled by the real pipeline rather
    // than planted on a hand-built schema.
    expect(outputSection(helpText)).toBe(
      [
        "  The invocation's `result`:",
        "    title <string>  The title as filed.",
        "    total <number>  How many items the list now holds.",
      ].join("\n"),
    );
  });

  it("names the type of a declared result that is not an object", async () => {
    const { helpText } = await callVerb("rename", ["--help"]);

    expect(outputSection(helpText)).toBe(
      ["  The invocation's `result`:", "    string"].join("\n"),
    );
  });

  it("carries no output section for a verb that declares no result", async () => {
    const { helpText } = await callVerb("clear", ["--help"]);

    // The value-less shape says nothing about output rather than claiming
    // there is none: absence is the honest report, and it is what tells a
    // caller this verb differs from `add`.
    expect(outputSection(helpText)).toBeUndefined();
    expect(helpText).toContain("Usage:");
  });

  it("serves the declared result as outputSchema under --help --json", async () => {
    const { helpText } = await callVerb("add", ["--help", "--json"]);

    const served = JSON.parse(helpText ?? "{}");
    expect(served.callableKind).toBe("handler");
    expect(served.outputSchema).toMatchObject({
      properties: { title: { type: "string" }, total: { type: "number" } },
    });
  });

  it("serves the page without an output section when the pattern will not load", async () => {
    // The message a piece with no reachable pattern identity fails with. The
    // pattern is advisory on this path: losing it costs the page its `Output:`
    // section and nothing else, where letting the failure out would cost a
    // caller the whole help page for a verb they can still call.
    const { helpText, patternLoads } = await callVerb("add", ["--help"], {
      patternError: new Error("piece missing pattern identity"),
    });

    expect(patternLoads).toBe(1);
    expect(outputSection(helpText)).toBeUndefined();
    expect(helpText).toContain("cf piece call ... add --help");
    expect(helpText).toContain("--title <string>");
  });

  it("loads the pattern for a help page and not for a dispatch", async () => {
    expect((await callVerb("add", ["--help"])).patternLoads).toBe(1);
    // The same verb, called for real. Resolution is the same path; the
    // declared result is a thunk nobody pulls, so no pattern is loaded to
    // serve a page this caller never asked for.
    expect((await callVerb("add", ["--title", "milk"])).patternLoads).toBe(0);
  });
});
