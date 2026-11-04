import { assertEquals, assertStringIncludes } from "@std/assert";
import { StaticCache } from "@commonfabric/static";
import ts from "typescript";

import { transformSource, validateSource } from "./utils.ts";
import { callsNamed, parseModule } from "./transformed-ast.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);

Deno.test("latestComplete injects its recursively usable schema", async () => {
  const output = await transformSource(
    `
      import { AsyncResult, Cell, latestComplete, pattern } from "commonfabric";

      type Repo = { owner: string; name: string };
      type Ticket = { title: string };

      export default pattern((input: {
        repo: AsyncResult<Repo>;
        ticket: AsyncResult<Ticket>;
        variable: Cell<number>;
      }) => {
        const snapshot = latestComplete({
          repo: input.repo,
          ticket: input.ticket,
          variable: input.variable,
          nested: [input.repo, { ticket: input.ticket }] as const,
        });
        return { snapshot };
      });
    `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, "latestComplete({");
  assertStringIncludes(output, "schema:");
  assertStringIncludes(output, "owner: {");
  assertStringIncludes(output, "title: {");
  assertStringIncludes(output, "variable: {");
  assertEquals(output.match(/type: "string"/g)?.length! >= 3, true);
  assertEquals(output.match(/type: "number"/g)?.length! >= 2, true);
  const root = parseModule(output);
  const options = callsNamed(root, "latestComplete")[0]!.arguments[0]!;
  assertEquals(ts.isObjectLiteralExpression(options), true);
  if (!ts.isObjectLiteralExpression(options)) {
    throw new Error("Expected snapshot options");
  }
  const snapshotSchema = options.properties.find((property) =>
    ts.isPropertyAssignment(property) &&
    property.name.getText(root) === "schema"
  );
  assertEquals(
    snapshotSchema?.getText(root).includes("FabricUnavailable"),
    false,
  );
  assertEquals(output.includes('reason: { type: "string"'), false);
});

Deno.test("aliased and namespace latestComplete calls inject a schema", async () => {
  const output = await transformSource(
    `
      import * as cf from "commonfabric";
      import { AsyncResult, latestComplete as keepLatest, pattern } from "commonfabric";

      type Repo = { name: string };

      export default pattern((input: { request: AsyncResult<Repo> }) => {
        const one = keepLatest(input.request);
        const two = cf.latestComplete(input.request);
        return { one, two };
      });
    `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertEquals(output.match(/schema:/g)?.length, 2);
  assertEquals(output.match(/name: \{/g)?.length! >= 2, true);
});

Deno.test("latestComplete diagnoses an unresolved complete-value type", async () => {
  const { diagnostics } = await validateSource(
    `
      import { latestComplete, pattern } from "commonfabric";

      export default pattern((input: { value: unknown }) => ({
        snapshot: latestComplete(input.value),
      }));
    `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "latest-complete:unresolved-type"
    ),
    true,
  );
});

Deno.test("malformed zero-argument latestComplete remains unchanged for recovery", async () => {
  const output = await transformSource(
    `
      import { latestComplete } from "commonfabric";
      // @ts-expect-error Exercise transformer recovery for an incomplete call.
      const snapshot = latestComplete();
    `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, "latestComplete()");
  assertEquals(output.includes("schema:"), false);
});
