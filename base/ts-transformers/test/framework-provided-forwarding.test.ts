import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformFiles, transformSource, validateSource } from "./utils.ts";

const FRAMEWORK_PROVIDED_WRAPPER =
  "pattern-callback:framework-provided-wrapper";

function frameworkDiagnostics(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === FRAMEWORK_PROVIDED_WRAPPER
  );
}

Deno.test(
  "inline wrapper synthesizes and forwards FrameworkProvided input from argument 0",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import {
  pattern,
  type FrameworkProvided,
} from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { received: string }>(({ sandboxId }) => ({ received: sandboxId }));

export default pattern<{ command: string }>((outer) => ({
  tool: pattern<{ suffix: string }>(({ suffix }) =>
    privileged({ command: outer.command } as any)
  ),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    const root = parseModule(output);
    assertEquals(
      callsNamed(root, "forwardFrameworkProvidedInput").length,
      0,
      "forwarding must be structural, not a runtime merge capability",
    );
    assertStringIncludes(
      output,
      '"sandboxId": __cf_framework_input.key("sandboxId")',
    );
    assertEquals(
      callsNamed(root, "withFrameworkProvidedPaths").length,
      2,
      "both the base and wrapper artifacts must carry trusted path metadata",
    );
    assertStringIncludes(output, "sandboxId");
  },
);

Deno.test(
  "FrameworkProvided forwarding is transitive through a wrapper chain",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { received: string }>(({ sandboxId }) => ({ received: sandboxId }));

const firstWrapper = pattern<{ command: string }>(({ command }) =>
  privileged({ command } as any)
);

export default pattern(() => ({
  tool: pattern<{ command: string }>(({ command }) =>
    firstWrapper({ command })
  ),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    const root = parseModule(output);
    assertEquals(
      callsNamed(root, "forwardFrameworkProvidedInput").length,
      0,
      "wrapper chains must use direct aliases",
    );
    assertEquals(
      output.match(
        /"sandboxId": __cf_framework_input(?:_\d+)?\.key\("sandboxId"\)/g,
      )
        ?.length,
      2,
      "each wrapper layer must forward the same argument-0 alias",
    );
    assertEquals(
      callsNamed(root, "withFrameworkProvidedPaths").length,
      3,
      "the obligation must remain artifact metadata at every layer",
    );
  },
);

Deno.test(
  "nested shorthand forwarding preserves one trusted subtree for shared protected paths",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

type Input = {
  nested: {
    command: string;
    credentials: {
      region: string;
      authToken: FrameworkProvided<string>;
      sandboxId: FrameworkProvided<string>;
    };
  };
};

const privileged = pattern<Input, { ok: boolean }>((_input) => ({ ok: true }));

export default pattern<Input>(({ nested }) => ({
  result: privileged({ nested }),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    assertEquals(
      output.match(
        /"nested": __cf_framework_input\.key\("nested"\)/g,
      )?.length,
      1,
      "the trusted subtree must preserve ordinary siblings and all protected leaves",
    );
  },
);

Deno.test(
  "union shorthand forwarding preserves the trusted argument-0 subtree",
  async () => {
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

type Input = {
  nested:
    | {
      kind: "alpha";
      alphaOnly: string;
      sandboxId: FrameworkProvided<string>;
    }
    | {
      kind: "beta";
      betaOnly: number;
      sandboxId: FrameworkProvided<string>;
    };
};

const privileged = pattern<Input, { ok: boolean }>((_input) => ({ ok: true }));

export default pattern<Input>(({ nested }) => ({
  result: privileged({ nested }),
}));
`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );

    assertStringIncludes(
      output,
      '"nested": __cf_framework_input.key("nested")',
    );
  },
);

Deno.test(
  "index-signature shorthand forwarding preserves the trusted argument-0 subtree",
  async () => {
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

type Input = {
  nested: {
    [name: string]: string;
    sandboxId: FrameworkProvided<string>;
  };
};

const privileged = pattern<Input, { ok: boolean }>((_input) => ({ ok: true }));

export default pattern<Input>(({ nested }) => ({
  result: privileged({ nested }),
}));
`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );

    assertStringIncludes(
      output,
      '"nested": __cf_framework_input.key("nested")',
    );
  },
);

for (
  const [name, setup] of [
    [
      "body-local override",
      'const nested = { command: "local", sandboxId: "authored" };',
    ],
    [
      "mutable alias",
      `let nested = input.nested;
  nested = { command: "local", sandboxId: "authored" };`,
    ],
  ] as const
) {
  Deno.test(
    `${name} cannot masquerade as a trusted protected-subtree shorthand`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import { pattern, type FrameworkProvided } from "commonfabric";

type Input = {
  nested: {
    command: string;
    sandboxId: FrameworkProvided<string>;
  };
};

const privileged = pattern<Input, { ok: boolean }>((_input) => ({ ok: true }));

export default pattern<Input>((input) => {
  ${setup}
  return { result: privileged({ nested }) };
});
`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );

      const failures = frameworkDiagnostics(diagnostics);
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, "argument 0");
    },
  );
}

Deno.test(
  "immutable argument-0 alias remains a trusted protected-subtree shorthand",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

type Input = {
  nested: {
    command: string;
    sandboxId: FrameworkProvided<string>;
  };
};

const privileged = pattern<Input, { ok: boolean }>((_input) => ({ ok: true }));

export default pattern<Input>((input) => {
  const nested = input.nested;
  return { result: privileged({ nested }) };
});
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    assertStringIncludes(
      output,
      '"nested": input.key("nested")',
    );
  },
);

Deno.test(
  "a first-class transitive wrapper carries its compiler-owned schema and path authority",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));

export const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));

export default pattern<{
  operation: typeof wrapper;
  command: string;
}>(({ operation, command }) => operation({ command }));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    const root = parseModule(output);
    const invoke = callsNamed(root, "invokeFactory")[0];
    assert(invoke, output);
    const expected = literalToValue(invoke.arguments[2]!) as {
      argumentSchema: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      frameworkProvidedPaths?: string[][];
    };
    assertEquals(expected.argumentSchema.properties?.sandboxId, true);
    assert(expected.argumentSchema.required?.includes("sandboxId"));
    assertEquals(expected.frameworkProvidedPaths, [["sandboxId"]]);

    const rootPattern = callsNamed(root, "pattern").find((call) => {
      const schema = call.arguments[1];
      if (!schema) return false;
      const value = literalToValue(schema) as {
        properties?: Record<string, unknown>;
      };
      return Object.hasOwn(value.properties ?? {}, "operation");
    });
    assert(rootPattern?.arguments[1], output);
    const rootSchema = literalToValue(rootPattern.arguments[1]) as {
      properties: {
        operation: {
          asFactory: {
            argumentSchema: {
              properties?: Record<string, unknown>;
              required?: string[];
            };
            frameworkProvidedPaths?: unknown;
          };
        };
      };
    };
    const storedContract = rootSchema.properties.operation.asFactory;
    assertEquals(storedContract.argumentSchema.properties?.sandboxId, true);
    assert(storedContract.argumentSchema.required?.includes("sandboxId"));
    assertEquals(storedContract.frameworkProvidedPaths, undefined);

    const schemas = callsNamed(root, "pattern").flatMap((call) => {
      const schema = call.arguments[1];
      if (!schema) return [];
      return [literalToValue(schema) as {
        properties?: Record<string, unknown>;
      }];
    });
    assertEquals(
      schemas.filter((schema) =>
        Object.hasOwn(schema.properties ?? {}, "sandboxId")
      ).length,
      2,
      "the base and transitive wrapper runtime contracts both require the protected path",
    );
  },
);

Deno.test(
  "same-shaped first-class wrappers keep distinct compiler-owned path authority",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import {
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

const sandboxed = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
const authenticated = pattern<{
  command: string;
  authToken: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));

export const sandboxWrapper: PatternFactory<
  { command: string },
  { ok: boolean }
> = pattern<{ command: string }, { ok: boolean }>(
  ({ command }) => sandboxed({ command } as any),
);
export const authWrapper: PatternFactory<
  { command: string },
  { ok: boolean }
> = pattern<{ command: string }, { ok: boolean }>(
  ({ command }) => authenticated({ command } as any),
);

type SandboxOperation = typeof sandboxWrapper;
type AuthOperation = typeof authWrapper;

export default pattern<{
  sandboxOperation: SandboxOperation;
  authOperation: AuthOperation;
}>((input) => {
  const sandboxOperation = input.sandboxOperation;
  return {
    sandbox: sandboxOperation({ command: "sandbox" }),
    auth: input["authOperation"]({ command: "auth" }),
  };
});
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    const root = parseModule(output);
    const invokes = callsNamed(root, "invokeFactory");
    assertEquals(invokes.length, 2, output);
    const pathsByCommand = Object.fromEntries(invokes.map((invoke) => {
      const input = literalToValue(invoke.arguments[1]!) as { command: string };
      const contract = literalToValue(invoke.arguments[2]!) as {
        argumentSchema: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        frameworkProvidedPaths?: string[][];
      };
      return [input.command, contract];
    }));

    assertEquals(pathsByCommand.sandbox.frameworkProvidedPaths, [[
      "sandboxId",
    ]]);
    assertEquals(
      pathsByCommand.sandbox.argumentSchema.properties?.sandboxId,
      true,
    );
    assertEquals(
      pathsByCommand.sandbox.argumentSchema.properties?.authToken,
      undefined,
    );
    assertEquals(pathsByCommand.auth.frameworkProvidedPaths, [["authToken"]]);
    assertEquals(
      pathsByCommand.auth.argumentSchema.properties?.authToken,
      true,
    );
    assertEquals(
      pathsByCommand.auth.argumentSchema.properties?.sandboxId,
      undefined,
    );

    const rootPattern = callsNamed(root, "pattern").find((call) => {
      const schema = call.arguments[1];
      if (!schema) return false;
      const value = literalToValue(schema) as {
        properties?: Record<string, unknown>;
      };
      return Object.hasOwn(value.properties ?? {}, "sandboxOperation");
    });
    assert(rootPattern?.arguments[1], output);
    const rootSchema = literalToValue(rootPattern.arguments[1]) as {
      properties: Record<
        "sandboxOperation" | "authOperation",
        {
          asFactory: {
            argumentSchema: { properties?: Record<string, unknown> };
          };
        }
      >;
    };
    assertEquals(
      rootSchema.properties.sandboxOperation.asFactory.argumentSchema
        .properties?.sandboxId,
      true,
    );
    assertEquals(
      rootSchema.properties.sandboxOperation.asFactory.argumentSchema
        .properties?.authToken,
      undefined,
    );
    assertEquals(
      rootSchema.properties.authOperation.asFactory.argumentSchema.properties
        ?.authToken,
      true,
    );
    assertEquals(
      rootSchema.properties.authOperation.asFactory.argumentSchema.properties
        ?.sandboxId,
      undefined,
    );
  },
);

Deno.test(
  "a factory union cannot borrow protected paths from only one provenanced arm",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import {
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
export const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));

type Plain = PatternFactory<{ command: string }, { ok: boolean }>;
export default pattern<{
  operation: typeof wrapper | Plain;
}>(({ operation }) => operation({ command: "run" }));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(
      diagnostics.map((diagnostic) => diagnostic.type),
      ["factory-call:framework-provided-mismatch-union"],
    );
    assertEquals(callsNamed(parseModule(output), "invokeFactory").length, 0);
  },
);

Deno.test(
  "same-kind provenanced unions compare each member's own result contract",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const first = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { child: { a: number } }>((_input) => ({ child: { a: 1 } }));
const second = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { child: { b: string } }>((_input) => ({ child: { b: "two" } }));

export const firstWrapper = pattern<
  { command: string },
  { child: { a: number } }
>(({ command }) => first({ command } as any));
export const secondWrapper = pattern<
  { command: string },
  { child: { b: string } }
>(({ command }) => second({ command } as any));

type Operation = typeof firstWrapper | typeof secondWrapper;
export default pattern<{ operation: Operation }>(({ operation }) =>
  operation({ command: "run" })
);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.type === "factory-call:schema-mismatch-union"
      ).length,
      1,
    );
    assertEquals(callsNamed(parseModule(output), "invokeFactory").length, 0);
  },
);

Deno.test(
  "same-kind provenanced unions with equal contracts remain callable",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));

export const firstWrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));
export const secondWrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));

type Operation = typeof firstWrapper | typeof secondWrapper;
export default pattern<{ operation: Operation }>(({ operation }) =>
  operation({ command: "run" })
);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    assertEquals(callsNamed(parseModule(output), "invokeFactory").length, 1);
  },
);

Deno.test(
  "repeated provenanced aliases do not look like a partial factory union",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
export const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));

type Operation = typeof wrapper;
export default pattern<{
  operation: Operation | Operation;
}>(({ operation }) => operation({ command: "run" }));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    const invoke = callsNamed(parseModule(output), "invokeFactory")[0];
    assert(invoke, output);
    const contract = literalToValue(invoke.arguments[2]!) as {
      frameworkProvidedPaths?: string[][];
    };
    assertEquals(contract.frameworkProvidedPaths, [["sandboxId"]]);
  },
);

Deno.test(
  "an imported type alias preserves wrapper provenance in either source order",
  async () => {
    const consumerSource = `
import { pattern } from "commonfabric";
import type { Operation } from "./wrapper.tsx";

export default pattern<{ operation: Operation }>(({ operation }) =>
  operation({ command: "run" })
);
`;
    const wrapperSource = `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
export const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));
export type Operation = typeof wrapper;
`;

    for (
      const files of [
        {
          "/consumer.tsx": consumerSource,
          "/wrapper.tsx": wrapperSource,
        },
        {
          "/wrapper.tsx": wrapperSource,
          "/consumer.tsx": consumerSource,
        },
      ]
    ) {
      const diagnostics: TransformationDiagnostic[] = [];
      const output = await transformFiles(files, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      });

      assertEquals(diagnostics, []);
      const consumer = output["/consumer.tsx"]!;
      const root = parseModule(consumer);
      const invoke = callsNamed(root, "invokeFactory")[0];
      assert(invoke, consumer);
      const contract = literalToValue(invoke.arguments[2]!) as {
        argumentSchema: { properties?: Record<string, unknown> };
        frameworkProvidedPaths?: string[][];
      };
      assertEquals(contract.argumentSchema.properties?.sandboxId, true);
      assertEquals(contract.frameworkProvidedPaths, [["sandboxId"]]);

      const rootPattern = callsNamed(root, "pattern")[0];
      assert(rootPattern?.arguments[1], consumer);
      const rootSchema = literalToValue(rootPattern.arguments[1]) as {
        properties: {
          operation: {
            asFactory: {
              argumentSchema: { properties?: Record<string, unknown> };
            };
          };
        };
      };
      assertEquals(
        rootSchema.properties.operation.asFactory.argumentSchema.properties
          ?.sandboxId,
        true,
      );
    }
  },
);

Deno.test(
  "direct aliases and supported modifier derivations preserve wrapper provenance",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));
const alias = wrapper;
const scoped = wrapper.asScope("space").inSpace();

export default pattern<{
  aliasedOperation: typeof alias;
  scopedOperation: typeof scoped;
}>(({ aliasedOperation, scopedOperation }) => ({
  aliased: aliasedOperation({ command: "alias" }),
  scoped: scopedOperation({ command: "scoped" }),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    const invokes = callsNamed(parseModule(output), "invokeFactory");
    assertEquals(invokes.length, 2, output);
    for (const invoke of invokes) {
      const contract = literalToValue(invoke.arguments[2]!) as {
        argumentSchema: { properties?: Record<string, unknown> };
        frameworkProvidedPaths?: string[][];
      };
      assertEquals(contract.argumentSchema.properties?.sandboxId, true);
      assertEquals(contract.frameworkProvidedPaths, [["sandboxId"]]);
    }
  },
);

Deno.test(
  "a mutable alias cannot retain initializer-only protected-path provenance",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));
const wrapper = pattern<
  { command: string },
  { ok: boolean }
>(({ command }) => privileged({ command } as any));
const ordinary = pattern<
  { command: string },
  { ok: boolean }
>((_input) => ({ ok: true }));
let mutable = wrapper;
mutable = ordinary;

export default pattern<{
  operation: typeof mutable;
}>(({ operation }) => operation({ command: "run" }));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(
      diagnostics.map(({ type, severity }) => ({ type, severity })),
      [{ type: "module-scope:let-declaration", severity: "error" }],
    );
    const invoke = callsNamed(parseModule(output), "invokeFactory")[0];
    assert(invoke, output);
    const contract = literalToValue(invoke.arguments[2]!) as {
      argumentSchema: { properties?: Record<string, unknown> };
      frameworkProvidedPaths?: string[][];
    };
    assertEquals(contract.argumentSchema.properties?.sandboxId, undefined);
    assertEquals(contract.frameworkProvidedPaths, []);
  },
);

Deno.test(
  "compiler emits trusted FrameworkProvided metadata for pattern, lift, and handler factories",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { handler, lift, pattern, type FrameworkProvided } from "commonfabric";

export const privilegedPattern = pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => ({ sandboxId }));

export const privilegedLift = lift((input: {
  sandboxId: FrameworkProvided<string>;
}) => input.sandboxId);

export const privilegedHandler = handler<
  { value: string },
  { sandboxId: FrameworkProvided<string> }
>((_event, context) => context.sandboxId);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    assertEquals(
      callsNamed(parseModule(output), "withFrameworkProvidedPaths").length,
      3,
    );
  },
);

Deno.test(
  "compiler orders FrameworkProvided metadata by UTF-8 bytes",
  async () => {
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

export const privilegedPattern = pattern<{
  z: FrameworkProvided<string>;
  ä: FrameworkProvided<string>;
  "😊": FrameworkProvided<string>;
}>((input) => input);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const [metadata] = callsNamed(
      parseModule(output),
      "withFrameworkProvidedPaths",
    );
    assertEquals(literalToValue(metadata!.arguments[1]!), [
      ["z"],
      ["ä"],
      ["😊"],
    ]);
  },
);

for (
  const [name, authoredValue] of [
    ["literal", '"author-chosen"'],
    ["capture", "chosen"],
  ] as const
) {
  Deno.test(
    `inline wrapper rejects an authored ${name} for FrameworkProvided input`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}>(({ command }) => ({ command }));

export default pattern<{ chosen: string }>((outer) => {
  const chosen = outer.chosen;
  return {
    tool: pattern<{ command: string }>(({ command }) =>
      privileged({ command, sandboxId: ${authoredValue} })
    ),
  };
});
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      const failures = frameworkDiagnostics(diagnostics);
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, "sandboxId");
      assertStringIncludes(failures[0]!.message, "authored");
    },
  );
}
