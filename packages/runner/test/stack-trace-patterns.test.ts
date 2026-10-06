// Tests that errors thrown from pattern lift() and handler() callbacks
// produce stack traces with correct ORIGINAL source locations when
// compiled through the full CTS transformer pipeline.
//
// These tests exercise the production compilation path:
// source string → transformCfDirective → TypeScript + CTS transformers
// → source maps → eval → error → parseStack → original line numbers.

import { assertEquals, assertMatch } from "@std/assert";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function makeProgram(source: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: source }],
  };
}

Deno.test("lift error through CTS pipeline has correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 5.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 5;
  const source = [
    'import { lift, pattern } from "commonfabric";', //        line 2
    "const double = lift((val: number) => {", //              line 3
    "  if (val > 10) {", //                                   line 4
    "    throw new Error('lift value too large');", //         line 5
    "  }", //                                                 line 6
    "  return val * 2;", //                                   line 7
    "});", //                                                 line 8
    "export default pattern<{ input: number }>(({ input }) => {", // line 9
    "  const result = double(input);", //                     line 10
    "  return { result };", //                                line 11
    "});", //                                                 line 12
  ].join("\n");

  const program = makeProgram(source);
  const { main } = await runtime.harness.compileAndEvaluateModules(program);
  const patternFn = main!["default"];

  let capturedError: Error | null = null;
  runtime.scheduler.onError((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "lift-stack-trace-cts");

  await runtime.setup(undefined, patternFn, { input: 5 }, resultCell);
  runtime.start(resultCell);

  const initial = (await resultCell.pull()) as any;
  assertEquals(initial.result, 10);

  // Trigger the error by setting input > 10
  const argumentCell = resultCell.getArgumentCell<{ input: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ input: 20 });
  await tx.commit().settled;
  await resultCell.pull();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "lift value too large");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: lift value too large");
  assertEquals(
    stack.includes("<CF_INTERNAL>"),
    false,
    `stack should preserve runner internal frames by default:\n${stack}`,
  );
  assertMatch(
    stack,
    /packages\/runner\/src\/(?:sandbox\/ses-runtime|harness\/engine|scheduler)\.ts/,
  );

  // First frame must point to the throw location in main.tsx
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("handler error through CTS pipeline has correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 6.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 6;
  const source = [
    'import { type Cell, handler, pattern } from "commonfabric";', //  line 2
    "const clickHandler = handler(", //                               line 3
    "  (event: { action: string }, state: { status: Cell<string> }) => {", // line 4
    '    if (event.action === "crash") {', //                         line 5
    "      throw new Error('handler crash on purpose');", //          line 6
    "    }", //                                                       line 7
    "    state.status.set(`did: ${event.action}`);", //               line 8
    "  },", //                                                        line 9
    ");", //                                                          line 10
    "export default pattern<{ status: string }>(({ status }) => {", // line 11
    "  return { status, stream: clickHandler({ status }) };", //      line 12
    "});", //                                                         line 13
  ].join("\n");

  const program = makeProgram(source);
  const { main } = await runtime.harness.compileAndEvaluateModules(program);
  const patternFn = main!["default"];

  let capturedError: Error | null = null;
  runtime.scheduler.onError((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "handler-stack-trace-cts");

  await runtime.setup(
    undefined,
    patternFn,
    { status: "idle" },
    resultCell,
  );
  runtime.start(resultCell);

  await resultCell.pull();

  // First event succeeds
  resultCell.key("stream").send({ action: "ok" });
  await runtime.scheduler.idle();
  assertEquals(capturedError, null, "no error on valid action");

  // Second event triggers the error
  resultCell.key("stream").send({ action: "crash" });
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "handler crash on purpose");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: handler crash on purpose");
  assertEquals(
    stack.includes("<CF_INTERNAL>"),
    false,
    `stack should preserve runner internal frames by default:\n${stack}`,
  );
  assertMatch(
    stack,
    /packages\/runner\/src\/(?:sandbox\/ses-runtime|harness\/engine|scheduler)\.ts/,
  );

  // First frame must point to the throw location in main.tsx
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("lift error stack has multiple frames with correct source line", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  // Pattern source: throw is on line 4.
  // Source maps correctly point to the original throw location.
  const THROW_LINE = 4;
  const source = [
    'import { lift, pattern } from "commonfabric";', //        line 2
    "const double = lift((x: number) => {", //                line 3
    "  if (x < 0) throw new Error('negative not supported');", // line 4
    "  return x * 2;", //                                     line 5
    "});", //                                                  line 6
    "export default pattern<{ n: number }>(({ n }) => {", //   line 7
    "  const doubled = double(n);", //                         line 8
    "  return { doubled };", //                                line 9
    "});", //                                                  line 10
  ].join("\n");

  const program = makeProgram(source);
  const { main } = await runtime.harness.compileAndEvaluateModules(program);
  const patternFn = main!["default"];

  let capturedError: Error | null = null;
  runtime.scheduler.onError((err: Error) => {
    capturedError = err;
  });

  const resultCell = runtime.getCell(space, "multi-frame-cts");

  await runtime.setup(undefined, patternFn, { n: 1 }, resultCell);
  runtime.start(resultCell);
  await resultCell.pull();

  // Trigger error by setting n < 0
  const argumentCell = resultCell.getArgumentCell<{ n: number }>()!;
  const tx = runtime.edit();
  argumentCell.withTx(tx).set({ n: -5 });
  await tx.commit().settled;
  await resultCell.pull();
  await runtime.scheduler.idle();

  assertEquals(capturedError !== null, true, "error should have been caught");

  const stack = capturedError!.stack ?? "";
  assertEquals(stack.split("\n")[0], "Error: negative not supported");

  // First frame points to the throw location
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  assertMatch(
    frames[0],
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first frame should reference main.tsx:${THROW_LINE}, got:\n${frames[0]}`,
  );

  // Should have multiple frames
  assertEquals(
    frames.length > 1,
    true,
    `should have multiple frames, got ${frames.length}:\n${stack}`,
  );

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("mapWithPattern synthetic pattern callsite keeps authored source lines", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost"),
    storageManager,
  });

  const MAP_LINE = 6;
  const THROW_LINE = 7;
  const source = [
    'import { pattern, UI } from "commonfabric";',
    "interface Item { id: string; }",
    "interface State { items: Item[]; }",
    "export default pattern<State>((state) => ({",
    "  [UI]: <div>{state.items.map((item) => {",
    "    throw new Error('map boom');",
    "  })}</div>,",
    "}));",
  ].join("\n");

  const program = makeProgram(source);
  let capturedError: Error | null = null;
  try {
    await runtime.harness.compileAndEvaluateModules(program);
  } catch (error) {
    if (error instanceof Error) {
      capturedError = error;
    } else {
      throw error;
    }
  }

  assertEquals(capturedError !== null, true, "error should have been caught");
  assertEquals(capturedError!.message, "map boom");

  // The stack is already source-mapped when compileAndEvaluateModules
  // surfaces a module-evaluation error (re-parsing a mapped stack would
  // corrupt it — the per-module maps are keyed by the mapped source paths).
  const stack = capturedError!.stack ?? "";
  const frames = stack.split("\n").filter((l) => l.trim().startsWith("at "));
  const sourceFrames = frames.filter((line) => line.includes("main.tsx"));

  assertMatch(
    sourceFrames[0] ?? "",
    new RegExp(`main\\.tsx:${THROW_LINE}:\\d+`),
    `first source frame should reference main.tsx:${THROW_LINE}, got:\n${
      sourceFrames[0]
    }`,
  );
  assertMatch(
    sourceFrames[1] ?? "",
    new RegExp(`main\\.tsx:${MAP_LINE}:\\d+`),
    `map helper callsite should reference main.tsx:${MAP_LINE}, got:\n${
      sourceFrames[1]
    }`,
  );
  assertEquals(
    sourceFrames.some((line) => line.includes("main.tsx:1:23")),
    false,
    `stack should not collapse to main.tsx:1:23:\n${stack}`,
  );

  await runtime.dispose();
  await storageManager.close();
});
