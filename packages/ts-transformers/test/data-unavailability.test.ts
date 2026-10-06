import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { StaticCache } from "@commonfabric/static";
import ts from "typescript";

import { transformSource, validateSource } from "./utils.ts";
import { collect, literalToValue, parseModule } from "./transformed-ast.ts";

const diagnosticTypes = (
  diagnostics: readonly { readonly type: string }[],
): string[] => diagnostics.map((diagnostic) => diagnostic.type);

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);

Deno.test("a terminal async result admits its schema-mismatch observation", async () => {
  const { diagnostics } = await validateSource(
    `
    import { computed, generateText, hasSchemaMismatch, pattern } from "commonfabric";
    export default pattern(() => {
      const request = generateText({ prompt: "hello" });
      return { mismatch: computed(() => hasSchemaMismatch(request)) };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );
  assertEquals(diagnosticTypes(diagnostics), []);
});

Deno.test("guarded error metadata preserves the native result union", async () => {
  const output = await transformSource(
    `
    import { type AsyncResult, computed, hasError, pattern } from "commonfabric";
    export default pattern((input: { request: AsyncResult<{ rows: number[] }> }) => {
      const request = input.request;
      return { error: computed(() => hasError(request) ? request.errorMessage : "") };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const schema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { request: { anyOf: Record<string, unknown>[] } };
    $defs: Record<string, unknown>;
  };
  assert(schema.properties.request.anyOf.some((arm) => arm.type === "object"));
  assertEquals(schema.$defs.HasError, { type: "FabricUnavailable" });
  assertEquals(schema.$defs.IsPending, { type: "FabricUnavailable" });
  assertEquals(schema.$defs.IsSyncing, { type: "FabricUnavailable" });
});

Deno.test("a flow-narrowed guard does not exclude a successful capture arm", async () => {
  const output = await transformSource(
    `
    import { type AsyncResult, computed, hasError, pattern } from "commonfabric";
    export default pattern((input: { request: AsyncResult<string> }) => {
      const request = input.request;
      return { value: computed(() => {
        if (typeof request === "object") return hasError(request) ? request.errorMessage : "";
        return request;
      }) };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const schema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { request: { anyOf: Record<string, unknown>[] } };
  };
  assert(schema.properties.request.anyOf.some((arm) => arm.type === "string"));
});

Deno.test("a guarded generic property keeps its instantiated result type", async () => {
  const output = await transformSource(
    `
    import { type AsyncResult, computed, hasError, pattern } from "commonfabric";
    type Box<T> = { request: T };
    export default pattern((input: { box: Box<AsyncResult<string>> }) => {
      const box = input.box;
      return { value: computed(() => {
        if (typeof box.request === "object") return hasError(box.request) ? box.request.errorMessage : "";
        return box.request;
      }) };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const schema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: {
      box: { properties: { request: { anyOf: Record<string, unknown>[] } } };
    };
    $defs: Record<string, unknown>;
  };
  assert(
    schema.properties.box.properties.request.anyOf.some((arm) =>
      arm.type === "string"
    ),
  );
  assertEquals(schema.$defs.HasError, { type: "FabricUnavailable" });
});

Deno.test("scoped generic guards preserve availability through local aliases", async () => {
  for (
    const [wrapper, scope] of [["PerUser", "user"], ["PerSession", "session"]]
  ) {
    const output = await transformSource(
      `
      import { type AsyncResult, computed, hasError, pattern, type ${wrapper} } from "commonfabric";
      type Box<T> = { request: T };
      export default pattern((input: { box: Box<${wrapper}<AsyncResult<string>>> }) => {
        const box = input.box;
        return { value: computed(() => {
          if (typeof box.request === "object") {
            const local = box.request;
            return hasError(local) ? local.errorMessage : "";
          }
          return box.request;
        }) };
      });
    `,
      { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
    );
    const root = parseModule(output);
    const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
      ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
      node.initializer?.getText(root).includes("hasError")
    );
    assert(
      declaration?.initializer && ts.isCallExpression(declaration.initializer),
    );
    const schema = literalToValue(declaration.initializer.arguments[1]!) as {
      properties: { box: { properties: { request: Record<string, unknown> } } };
    };
    const request = schema.properties.box.properties.request;
    assertEquals(request.scope, scope);
    assertStringIncludes(JSON.stringify(request), "string");
    assertStringIncludes(JSON.stringify(schema), "FabricUnavailable");
  }
});

Deno.test("observeAvailability is a transparent reactive alias", async () => {
  const output = await transformSource(`
    import { observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      return { observed };
    });
  `);

  assertStringIncludes(
    output,
    'observeAvailability(input.key("value"), "error")',
  );
  assertEquals(output.includes("=> observeAvailability"), false);
});

Deno.test("resultOf is a transparent policy-free reactive alias", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, pattern, resultOf } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = resultOf(input.request);
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, 'resultOf(input.key("request"))');
  assertEquals(output.includes("=> resultOf"), false);
  assertEquals(output.includes("unavailableInputPolicy"), false);
});

Deno.test("resultOf source crosses a reactive map boundary for nested computed", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      Default,
      pattern,
      resultOf,
      wish,
    } from "commonfabric";

    export default pattern(() => {
      const request = wish<Default<number, 0>>({ query: "#now" });
      const usable = resultOf(request.result);
      const rows = computed(() => [1]);
      return {
        labels: rows.map((row) => computed(() => row + usable)),
      };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const nestedPattern = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfPattern_") &&
    node.initializer?.getText(root).includes("request")
  );
  assert(nestedPattern?.initializer);
  const emitted = nestedPattern.initializer.getText(root);
  assertStringIncludes(emitted, 'key("params", "request")');
  assertStringIncludes(emitted, 'request.key("result")');
  assertEquals(emitted.includes("usable"), false);

  const nestedLift = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("request.result")
  );
  assert(nestedLift?.initializer);
  assertEquals(nestedLift.initializer.getText(root).includes("usable"), false);
});

Deno.test("resultOf element source crosses a reactive map boundary", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      Default,
      pattern,
      resultOf,
    } from "commonfabric";

    export default pattern((input: { requests: [AsyncResult<Default<number, 0>>] }) => {
      const usable = resultOf(input.requests[0]);
      const rows = computed(() => [1]);
      return {
        values: rows.map((row) => computed(() => row + usable)),
      };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'const input = __cf_pattern_input.key("params", "input")',
  );
  assertStringIncludes(output, '"0": input.key("requests", "0")');
  assertStringIncludes(output, "row + input.requests[0]");
  assertEquals(output.includes("row + usable"), false);
});

Deno.test("resultOf direct producer stays a single captured alias", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      fetchJson,
      pattern,
      resultOf,
    } from "commonfabric";

    export default pattern(() => {
      const usable = resultOf(fetchJson<number>({ url: "/value" }));
      const rows = computed(() => [1]);
      return {
        values: rows.map((row) => computed(() => row + usable)),
      };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const producerCalls = collect(root, ts.isCallExpression).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "fetchJson"
  );
  assertEquals(producerCalls.length, 1);
  assertStringIncludes(output, "usable: usable");
  assertStringIncludes(output, "mapWithPattern(__cfPattern_");
  assertStringIncludes(output, 'key("params", "usable")');
});

Deno.test("reports an availability guard inside computed without an external observation", async () => {
  const { diagnostics } = await validateSource(`
    import { computed, hasError, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const failed = computed(() => hasError(input.value));
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a visible AsyncResult guard inside computed needs no observation cast", async () => {
  const source = `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = computed(() => hasError(input.request));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(output.includes("observeAvailability"), false);

  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const inputSchema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: {
      input: { properties: { request: Record<string, unknown> } };
    };
  };
  assertEquals(inputSchema.properties.input.properties.request, {
    type: "unknown",
  });
});

Deno.test("a computed-local alias retains its captured availability path", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = computed(() => {
        const request = input.request;
        return hasError(request);
      });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["request"], reasons: ["error"]'),
    false,
  );
});

Deno.test("a key access through a computed-local const alias keeps the source path", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, computed, hasError, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = computed(() => {
        const local = input as typeof input & {
          key(name: "request"): AsyncResult<Repo>;
        };
        return hasError(local.key("request"));
      });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["local", "request"], reasons: ["error"]'),
    false,
  );
});

Deno.test("a destructured computed-local const alias keeps the source path", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, computed, hasError, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = computed(() => {
        const { request } = input;
        return hasError(request);
      });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["request"], reasons: ["error"]'),
    false,
  );
});

Deno.test("a mutable computed-local guard alias is rejected", async () => {
  const { diagnostics } = await validateSource(`
    import { AsyncResult, computed, hasError, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      first: AsyncResult<Repo>;
      second: AsyncResult<Repo>;
    }) => {
      const failed = computed(() => {
        let request = input.first;
        request = input.second;
        return hasError(request);
      });
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).filter((type) =>
      type === "availability:unsupported-guard-operand"
    ).length,
    1,
  );
});

Deno.test("a dynamically selected computed-local guard alias is rejected", async () => {
  const { diagnostics } = await validateSource(`
    import { AsyncResult, computed, hasError, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      requests: AsyncResult<Repo>[];
      index: number;
    }) => {
      const failed = computed(() => {
        const selected = input.requests[input.index];
        return hasError(selected);
      });
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).filter((type) =>
      type === "availability:unsupported-guard-operand"
    ).length,
    1,
  );
});

Deno.test("reports a helper guard whose caller path cannot be represented", async () => {
  const { diagnostics } = await validateSource(
    `
    import { AsyncResult, computed, hasError, pattern } from "commonfabric";

    type Repo = { name: string };

    function failed(request: AsyncResult<Repo>) {
      return hasError(request);
    }

    export default pattern((input: {
      requests: AsyncResult<Repo>[];
      index: number;
    }) => {
      const result = computed(() => failed(input.requests[input.index]));
      return { result };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a guard only accepts the availability variant it probes", async () => {
  const { diagnostics } = await validateSource(
    `
    import {
      computed,
      HasError,
      isPending,
      pattern,
    } from "commonfabric";

    export default pattern((input: { failure: HasError }) => {
      const pending = computed(() => isPending(input.failure));
      return { pending };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("AsyncResult<any> retains guard policy from its async producer", async () => {
  const source = `
    import {
      computed,
      fetchJsonUnchecked,
      hasError,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const request = fetchJsonUnchecked({ url: "https://example.com/data" });
      const failed = computed(() => hasError(request));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
});

Deno.test("streaming generation results retain async provenance", async () => {
  const source = `
    import {
      computed,
      generateObjectStream as objectStream,
      generateTextStream as textStream,
      hasError,
      pattern,
    } from "commonfabric";
    import * as cf from "commonfabric";

    export default pattern(() => {
      const textRequest = textStream({ prompt: "text" });
      const aliasObjectRequest = objectStream<any>({ prompt: "alias object" });
      const objectRequest = cf.generateObjectStream<any>({ prompt: "object" });
      const textFailed = computed(() => hasError(textRequest));
      const aliasObjectFailed = computed(() => hasError(aliasObjectRequest));
      const objectFailed = computed(() => hasError(objectRequest));
      return {
        aliasObjectFailed,
        objectFailed,
        textFailed,
      };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  const unobserved = diagnostics.filter((diagnostic) =>
    diagnostic.type === "availability:unobserved-compute-guard"
  );
  assertEquals(unobserved.length, 0);

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'path: ["textRequest"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["aliasObjectRequest"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["objectRequest"], reasons: ["error"]',
  );
});

Deno.test("any and unknown async state producers retain guard provenance", async () => {
  const source = `
    import {
      computed,
      hasError,
      llmDialog,
      pattern,
      streamData,
      wish,
    } from "commonfabric";

    export default pattern(() => {
      const stream = streamData<any>({ url: "/events" });
      const wished = wish({ query: "#repo" }).result;
      const dialog = llmDialog<any>({ messages: [] }).result;
      const streamFailed = computed(() => hasError(stream));
      const wishFailed = computed(() => hasError(wished));
      const dialogFailed = computed(() => hasError(dialog));
      return { dialogFailed, streamFailed, wishFailed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "availability:unobserved-compute-guard"
    ).length,
    0,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'path: ["stream"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["wished"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["dialog"], reasons: ["error"]',
  );
});

Deno.test("partialResultOf is usable while stream guards retain async provenance", async () => {
  const source = `
    import {
      computed,
      generateObjectStream,
      hasError,
      partialResultOf,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const stream = generateObjectStream<{ name: string }>({
        prompt: "object",
      });
      const partial = partialResultOf(stream);
      const upper = computed(() => partial.toUpperCase());
      const failed = computed(() => hasError(stream));
      return { failed, upper };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["stream"], reasons: ["error"] }]',
  );
});

Deno.test("partialResultOf accepts a stable streamData alias", async () => {
  const source = `
    import { partialResultOf, pattern, streamData } from "commonfabric";

    type Event = { id: string; data: { value: number } };

    export default pattern(() => {
      const request = streamData<Event>({ url: "/events" });
      const alias = request;
      return { partial: partialResultOf(alias) };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unsupported-partial-result-source",
    ),
    false,
  );
});

Deno.test("partialResultOf rejects direct stream sources inside compute boundaries", async () => {
  const source = `
    import {
      computed,
      generateTextStream,
      partialResultOf,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const request = generateTextStream({ prompt: "hello" });
      const partial = computed(() => partialResultOf(request));
      return { partial };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "availability:unsupported-partial-result-source"
    ).length,
    1,
  );
});

Deno.test("partialResultOf does not expose an availability guard surface", async () => {
  const source = `
    import {
      computed,
      generateTextStream,
      hasError,
      partialResultOf,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const stream = generateTextStream({ prompt: "text" });
      const partial = partialResultOf(stream);
      const failed = computed(() => hasError(partial));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("partialResultOf rejects stream results after pattern composition", async () => {
  const source = `
    import {
      generateTextStream,
      partialResultOf,
      pattern,
    } from "commonfabric";

    const Child = pattern(() => ({
      request: generateTextStream({ prompt: "child" }),
    }));

    export default pattern(() => {
      const child = Child({});
      const direct = partialResultOf(child.request);
      const children = [child];
      const mapped = children.map((entry) => partialResultOf(entry.request));
      return { direct, mapped };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "availability:unsupported-partial-result-source"
    ).length,
    2,
  );
});

Deno.test("availability guards are plain predicates inside an existing compute", async () => {
  const source = `
    import {
      computed,
      generateText,
      generateTextStream,
      hasError,
      isPending,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const request = generateText({ prompt: "text" });
      const stream = generateTextStream({ prompt: "stream" });
      const status = computed(() => {
        const pending = isPending(request);
        const failed = hasError(stream);
        if (pending || failed) return "waiting";
        return "ready";
      });
      return { status };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'path: ["request"], reasons: ["pending"]',
  );
  assertStringIncludes(
    output,
    'path: ["stream"], reasons: ["error"]',
  );
});

Deno.test("availability guards stay plain in a nested compute over mapped results", async () => {
  const source = `
    import {
      computed,
      generateObject,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Result = { label: string };

    export default pattern((input: { prompts: string[] }) => {
      const requests = input.prompts.map((prompt) => {
        const request = generateObject<Result>({ prompt });
        const result = resultOf(request);
        return { request, result };
      });
      const labels = requests.map((item) => computed(() => {
        const pending = isPending(item.request);
        if (pending) return "pending";
        if (hasError(item.request)) return item.request.errorMessage;
        return item.result.label;
      }));
      return { labels };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );

  await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
});

Deno.test("an availability guard does not hide a reactive value created inside a compute", async () => {
  const { diagnostics } = await validateSource(
    `
    import { computed, generateText, isPending, pattern } from "commonfabric";

    export default pattern(() => {
      const status = computed(() => {
        const request = generateText({ prompt: "created too late" });
        const pending = isPending(request);
        if (pending) return "pending";
        return "ready";
      });
      return { status };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
    },
  );
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    true,
  );
});

Deno.test("an invalid observer used as a computed key does not hide another local reactive value", async () => {
  const { diagnostics } = await validateSource(
    `
    import {
      computed,
      generateText,
      observeAvailability,
      pattern,
    } from "commonfabric";

    export default pattern((input: { key: string }) => {
      const value = computed(() => {
        const local = generateText({ prompt: "created too late" });
        const observed = observeAvailability(input.key, "error");
        if (local[observed as unknown as "error"]) return "used";
        return "unused";
      });
      return { value };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
    },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:observation-inside-compute",
    ),
    true,
  );
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    true,
  );
});

Deno.test("reports observeAvailability inside the compute boundary it tries to widen", async () => {
  const { diagnostics } = await validateSource(`
    import { computed, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const failed = computed(() =>
        observeAvailability(input.value, "error")
      );
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:observation-inside-compute",
    ),
    true,
  );
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );
});

Deno.test("reports a dead nullish fallback after resultOf", async () => {
  const { diagnostics } = await validateSource(
    `
      import {
        AsyncResult,
        pattern,
        resultOf,
      } from "commonfabric";

      type Repo = { name: string };

      export default pattern((input: { request: AsyncResult<Repo> }) => {
        const repo = resultOf(input.request) ?? { name: "fallback" };
        return { repo };
      });
    `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:dead-result-fallback",
    ),
    true,
  );
});

Deno.test("allows nullish fallbacks for valid nullable result values", async () => {
  const { diagnostics } = await validateSource(
    `
      import { AsyncResult, pattern, resultOf } from "commonfabric";

      type Repo = { name: string };

      export default pattern((input: {
        nullable: AsyncResult<Repo | null>;
        optional: AsyncResult<Repo | undefined>;
      }) => {
        const nullable = resultOf(input.nullable) ?? { name: "none" };
        const optionalResult = resultOf(input.optional);
        const optional = optionalResult ?? { name: "missing" };
        return { nullable, optional };
      });
    `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "availability:dead-result-fallback"
    ).length,
    0,
  );
});

Deno.test("an in-compute observation reports only its availability diagnostic", async () => {
  const { diagnostics } = await validateSource(`
    import {
      AsyncResult,
      computed,
      hasError,
      observeAvailability,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const content = computed(() => {
        const observed = observeAvailability(input.request, "error");
        return hasError(observed)
          ? observed.errorMessage
          : resultOf(observed).name;
      });
      return { content };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:observation-inside-compute",
    ),
    true,
  );
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );
});

Deno.test("an external selective observation authorizes the matching compute guard through an alias", async () => {
  const { diagnostics } = await validateSource(`
    import {
      computed,
      hasError,
      observeAvailability as observe,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observe(input.value, "error");
      const alias = observed;
      const failed = computed(() => hasError(alias));
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );
});

Deno.test("computed canonicalizes request and resultOf alias to one guarded capture", async () => {
  const source = `
    import {
      AsyncResult,
      computed,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string; url: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const requestState = request;
      const content = computed(() =>
        isPending(requestState)
          ? "pending"
          : hasError(requestState)
          ? requestState.errorMessage
          : result.name + result.url
      );
      return { content };
    });
  `;

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("isPending")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputType = liftCall.typeArguments?.[0]?.getText(root) ?? "";
  assertStringIncludes(inputType, "request");
  assertEquals(inputType.includes("result:"), false);

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: Record<string, unknown>;
  };
  assertEquals(Object.keys(inputSchema.properties), ["request"]);
  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["request"], reasons: ["pending", "error"] },
  ]);
  assertEquals(
    liftCall.arguments.at(-2)?.getText(root).includes("resultOf"),
    false,
  );
});

Deno.test("resultOf keeps a captured Cell capability on its physical source", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      pattern,
      resultOf,
      Writable,
    } from "commonfabric";

    export default pattern((input: {
      request: AsyncResult<Writable<string[]>>;
    }) => {
      const result = resultOf(input.request);
      const count = computed(() => result.get().length);
      return { count };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes(".get()")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const inputSchema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { input: { properties: { request: unknown } } };
  };
  assertEquals(inputSchema.properties.input.properties.request, {
    anyOf: [
      { type: "array", items: { type: "unknown" }, asCell: ["readonly"] },
      { $ref: "#/$defs/IsPending" },
      { $ref: "#/$defs/IsSyncing" },
      { $ref: "#/$defs/HasError" },
    ],
  });
});

Deno.test("a synthesized guarded expression canonicalizes its resultOf alias", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      return {
        label: isPending(request)
          ? "pending"
          : hasError(request)
          ? request.errorMessage
          : result.name,
      };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );
  const root = parseModule(output);
  const declarations = collect(root, ts.isVariableDeclaration).filter((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    (node.initializer?.getText(root).includes("isPending") ||
      node.initializer?.getText(root).includes("hasError"))
  );
  assert(declarations.length > 0);
  const reasons = new Set<string>();
  for (const declaration of declarations) {
    assert(
      declaration.initializer && ts.isCallExpression(declaration.initializer),
    );
    const inputSchema = literalToValue(
      declaration.initializer.arguments[1]!,
    ) as {
      properties: Record<string, unknown>;
    };
    assertEquals(Object.keys(inputSchema.properties), ["request"]);
    const options = literalToValue(
      declaration.initializer.arguments.at(-1)!,
    ) as {
      unavailableInputPolicy: Array<{ reasons: string[] }>;
    };
    for (const entry of options.unavailableInputPolicy) {
      entry.reasons.forEach((reason) => reasons.add(reason));
    }
  }
  assertEquals([...reasons].sort(), ["error", "pending"]);
});

Deno.test("explicit lift canonicalizes a resultOf alias with its guarded source", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      lift,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const label = lift(() =>
        hasError(request) ? request.errorMessage : result.name
      )({});
      return { label };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: Record<string, unknown>;
  };
  assertEquals(Object.keys(inputSchema.properties), ["request"]);
  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["request"], reasons: ["error"] },
  ]);
});

Deno.test("resultOf canonicalization preserves an authored shorthand output key", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const state = request;
      const view = computed(() =>
        hasError(state) ? { result: undefined } : { result }
      );
      return { view };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, "{ result: request }");
});

Deno.test("a typed explicit lift parameter infers guard policy without observation", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift } from "commonfabric";

    type Repo = { name: string };
    export const failed = lift(
      (request: AsyncResult<Repo>) => hasError(request),
    );
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: [], reasons: ["error"] }]',
  );
  assertEquals(output.includes("observeAvailability"), false);
});

Deno.test("closure hoisting maps an explicit lift guard to the emitted input key", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      request: AsyncResult<Repo>;
      suffix: string;
    }) => {
      const suffix = input.suffix;
      const failed = lift((value: AsyncResult<Repo>) =>
        hasError(value) ? suffix : "ok"
      )(input.request);
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["value"], reasons: ["error"]'),
    false,
  );
});

Deno.test("closure hoisting maps a destructured lift guard below the merged input key", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      request: AsyncResult<Repo>;
      suffix: string;
    }) => {
      const suffix = input.suffix;
      const failed = lift(({ request }: { request: AsyncResult<Repo> }) =>
        hasError(request) ? suffix : "ok"
      )({ request: input.request });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["request"], reasons: ["error"]'),
    false,
  );
});

Deno.test("same-file helper guards contribute policy to their owning compute", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(request: AsyncResult<Repo>) {
      return hasError(request);
    }

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = computed(() => failed(input.request));
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
});

Deno.test("same-file helper guard paths retain nested caller structure", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(state: { request: AsyncResult<Repo> }) {
      return hasError(state.request);
    }

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = computed(() => failed(input));
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
});

Deno.test("a helper parameter cannot widen a plain caller input implicitly", async () => {
  const { diagnostics } = await validateSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(request: AsyncResult<Repo>) {
      return hasError(request);
    }

    export default pattern((input: { repo: Repo }) => {
      const result = computed(() => failed(input.repo));
      return { result };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a local AsyncResult name does not authorize unavailable input", async () => {
  const { diagnostics } = await validateSource(
    `
    import { computed, hasError, pattern } from "commonfabric";

    interface AsyncResult {
      local: string;
    }

    export default pattern((input: { value: AsyncResult }) => {
      const failed = computed(() => hasError(input.value));
      return { failed };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a concrete type name containing a variant name still receives the marker arm", async () => {
  const output = await transformSource(
    `
    import { hasError, pattern } from "commonfabric";

    interface HasErrorEnvelope {
      local: string;
    }

    export default pattern((input: { value: HasErrorEnvelope }) => ({
      failed: hasError(input.value),
    }));
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    "value: HasErrorEnvelope | __cfHelpers.HasError",
  );
});

Deno.test("object-rest guard paths map back to the source object", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = lift(({
        ...rest
      }: { request: AsyncResult<Repo> }) => hasError(rest.request))({
        request: input.request,
      });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
  assertEquals(output.includes('path: ["rest", "request"]'), false);
});

Deno.test("array-rest guard indices map back to source tuple positions", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = lift(([
        _head,
        ...rest
      ]: [string, AsyncResult<Repo>]) => hasError(rest[0]))([
        "head",
        input.request,
      ]);
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["1"], reasons: ["error"] }]',
  );
  assertEquals(output.includes('path: ["1", "0"]'), false);
});

Deno.test("pending error and success JSX shares one physical async capture", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string; url: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      return isPending(request)
        ? <div>Loading repository...</div>
        : hasError(request)
        ? <div>Error: {request.errorMessage}</div>
        : <a href={result.url}>{result.name}</a>;
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const generatedLifts = collect(root, ts.isVariableDeclaration).filter((
    node,
  ) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer && ts.isCallExpression(node.initializer)
  );
  assert(generatedLifts.length > 0);
  for (const declaration of generatedLifts) {
    assert(
      declaration.initializer && ts.isCallExpression(declaration.initializer),
    );
    const inputSchema = literalToValue(
      declaration.initializer.arguments[1]!,
    ) as {
      properties?: Record<string, unknown>;
    };
    assertEquals(
      Object.keys(inputSchema.properties ?? {}).includes("result"),
      false,
    );
  }
  assertStringIncludes(output, 'path: ["request"]');
});

Deno.test("a selective observation does not authorize a different reason", async () => {
  const { diagnostics } = await validateSource(`
    import {
      computed,
      isPending,
      observeAvailability,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const pending = computed(() => isPending(observed));
      return { pending };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("an observed computed capture survives aliasing and hoisting with aligned artifacts", async () => {
  const output = await transformSource(`
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const alias = observed;
      const failed = computed(() => hasError(alias));
      return { failed };
    });
  `);
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;

  assertStringIncludes(
    liftCall.typeArguments?.[0]?.getText(root) ?? "",
    "alias: string | __cfHelpers.HasError",
  );
  assertEquals(liftCall.typeArguments?.[1]?.getText(root), "boolean");

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: { alias: Record<string, unknown> };
  };
  assertEquals(inputSchema.properties.alias, { type: "unknown" });
  assertEquals(literalToValue(liftCall.arguments[2]!), {
    type: "boolean",
  });

  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["alias"], reasons: ["error"] },
  ]);
  assertStringIncludes(output, "=> hasError(alias)");
});

Deno.test("an observed lift input is widened at its outer boundary", async () => {
  const output = await transformSource(`
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift((value) => hasError(value))(observed);
      return { failed };
    });
  `);

  assertStringIncludes(
    output,
    "observed: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["observed"], reasons: ["error"] }]',
  );
  assertStringIncludes(output, "({ observed: value }) => hasError(value)");
});

Deno.test("a destructured lift input maps observation to its emitted nested path", async () => {
  const source = `
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift(({ value }) => hasError(value))({ value: observed });
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source);
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source);
  assertStringIncludes(
    output,
    "value: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "value"], reasons: ["error"] }]',
  );
  assertStringIncludes(output, "({ input: { value } }) => hasError(value)");
});

Deno.test("capture collision renaming is reflected in schema and policy paths", async () => {
  const output = await transformSource(`
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift((_value) => hasError(observed))(observed);
      return { failed };
    });
  `);

  assertStringIncludes(
    output,
    "observed: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    "observed_1: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["observed"], reasons: ["error"] }, { path: ["observed_1"], reasons: ["error"] }]',
  );
});

Deno.test("an omitted observation reason widens and authorizes every variant", async () => {
  const output = await transformSource(`
    import { computed, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value);
      const copy = computed(() => observed);
      return { copy };
    });
  `);

  for (
    const variant of [
      "IsPending",
      "HasError",
      "IsSyncing",
      "HasSchemaMismatch",
    ]
  ) {
    assertStringIncludes(output, `__cfHelpers.${variant}`);
  }
  assertStringIncludes(
    output,
    'reasons: ["pending", "error", "syncing", "schemaMismatch"]',
  );
});

Deno.test("a guard-only generic value materializes as an opaque root", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    type Box<T> = { value: T };
    type Item = { id: string };

    export default pattern<Box<Item>>((input) => {
      const observed = observeAvailability(input.value, "error");
      const failed = computed(() => hasError(observed));
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    "observed: Item | __cfHelpers.HasError",
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const inputSchema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { observed: Record<string, unknown> };
  };
  assertEquals(inputSchema.properties.observed, { type: "unknown" });
});

Deno.test("a guarded value read keeps its usable schema", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    type Item = { id: string };

    export default pattern((input: { value: Item }) => {
      const observed = observeAvailability(input.value, "error");
      const label = computed(() =>
        hasError(observed) ? "failed" : observed.id
      );
      return { label };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const inputSchema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { observed: Record<string, unknown> };
  };
  assertEquals(inputSchema.properties.observed, {
    anyOf: [
      { $ref: "#/$defs/HasError" },
      {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    ],
  });
});

Deno.test("an authored same-named type does not collide with the availability schema arm", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    type HasError = { local: string };

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const local: HasError = { local: "ordinary data" };
      const result = computed(() => hasError(observed) ? local : local);
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, '$ref: "#/$defs/HasError"');
  assertStringIncludes(output, "local: HasError");
  assertStringIncludes(
    output,
    'HasError: {\n            type: "object",\n            properties: {\n                local: {\n                    type: "string"',
  );
});

Deno.test("a direct pattern guard reads only its probed root and emits exact policy", async () => {
  const output = await transformSource(`
    import { hasError, pattern } from "commonfabric";

    export default pattern((input: { value: string; other: number }) => ({
      failed: hasError(input.value),
      other: input.other,
    }));
  `);
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputType = liftCall.typeArguments?.[0];
  assert(inputType);
  assertStringIncludes(
    inputType.getText(root),
    "string | __cfHelpers.HasError",
  );
  assertEquals(inputType.getText(root).includes("other"), false);
  assertEquals(liftCall.typeArguments?.[1]?.getText(root), "boolean");

  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["input", "value"], reasons: ["error"] },
  ]);

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: { input: { properties: { value: Record<string, unknown> } } };
  };
  const valueSchema = inputSchema.properties.input.properties.value;
  assertEquals(valueSchema, { type: "unknown" });
  assertEquals(literalToValue(liftCall.arguments[2]!), {
    type: "boolean",
  });
});
