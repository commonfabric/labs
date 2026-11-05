import { assertEquals, assertMatch } from "@std/assert";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const options = { types: COMMONFABRIC_TYPES };

Deno.test("nested wrapper layers bind each hoisted base exactly once", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ prefix: string }>(({ prefix }) => ({
  outer: pattern<{ suffix: string }>(({ suffix }) => ({
    inner: pattern<{ value: string }>(({ value }) => ({
      prefix,
      suffix,
      value,
    })),
  })),
}));
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertEquals(normalized.match(/withPatternParamsSchema/g)?.length, 2);
  assertEquals(normalized.match(/__cfPattern_\d+\.curry\(/g)?.length, 2);
  assertEquals(
    new Set(normalized.match(/__cfPattern_\d+(?=\.curry\()/g)).size,
    2,
  );
});

Deno.test("nested pattern conversion works in JSX and conditional positions", async () => {
  const output = await transformSource(
    `
import { pattern, UI } from "commonfabric";

export default pattern<{ enabled: boolean; label: string }>(
  ({ enabled, label }) => ({
    [UI]: <div>{enabled ? pattern(() => ({ label })) : pattern(() => ({ fallback: label }))}</div>,
  }),
);
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertEquals(normalized.match(/withPatternParamsSchema/g)?.length, 2);
  assertEquals(normalized.match(/__cfPattern_\d+\.curry\(/g)?.length, 2);
  assertMatch(normalized, /__cfHelpers\.ifElse/);
  assertEquals(
    normalized.match(
      /\(\{ label \}\) => __cfPattern_\d+\.curry\(\{ label: label \}\)/g,
    )?.length,
    2,
  );
  assertEquals(
    normalized.match(/__cfLift_\d+\(\{ label: label \}\)/g)?.length,
    2,
  );
  if (/lift<\{ __cfHelpers:/.test(normalized)) {
    throw new Error("compiler helper leaked into conditional capture state");
  }
});

Deno.test("nested pattern output and capture order are deterministic with no fourth pattern argument", async () => {
  const source = `
import { pattern } from "commonfabric";

export default pattern<{ alpha: string; beta: string }>(({ alpha, beta }) => ({
  child: pattern(() => ({ beta, alpha })),
}));
`;
  const first = await transformSource(source, options);
  const second = await transformSource(source, options);

  assertEquals(first, second);
  assertMatch(
    first.replace(/\s+/g, " "),
    /\.curry\(\{ beta: beta, alpha: alpha \}\)/,
  );
  const root = parseModule(first);
  for (const call of callsNamed(root, "pattern")) {
    if (call.arguments.length > 3) {
      throw new Error(`pattern() emitted ${call.arguments.length} arguments`);
    }
  }
});
