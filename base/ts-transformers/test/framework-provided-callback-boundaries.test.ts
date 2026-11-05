import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

const FRAMEWORK_PROVIDED_WRAPPER =
  "pattern-callback:framework-provided-wrapper";
const SCHEDULED_FACTORY_CALL =
  "scheduled-callback:framework-provided-factory-call";
const NON_STATIC_PATH = "framework-provided:non-static-path";

function diagnosticsOfType(
  diagnostics: readonly TransformationDiagnostic[],
  type: string,
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.type === type);
}

function frameworkPathMetadata(output: string): unknown[] {
  return callsNamed(parseModule(output), "withFrameworkProvidedPaths").map(
    (call) => {
      assertEquals(call.arguments.length, 2);
      return literalToValue(call.arguments[1]!);
    },
  );
}

Deno.test(
  "module-scope pattern, lift, and handler factories emit trusted nested paths",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import {
  handler,
  lift,
  pattern,
  type FrameworkProvided,
} from "commonfabric";

export const privilegedPattern = pattern<{
  request: { sandboxId: FrameworkProvided<string> };
}>(({ request }) => ({ sandboxId: request.sandboxId }));

export const privilegedLift = lift((input: {
  runtime: { sandboxId: FrameworkProvided<string> };
}) => input.runtime.sandboxId);

export const privilegedHandler = handler<
  { value: string },
  { runtime: { sandboxId: FrameworkProvided<string> } }
>((_event, context) => context.runtime.sandboxId);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    assertEquals(
      frameworkPathMetadata(output).map((paths) => JSON.stringify(paths))
        .sort(),
      [
        '[["request","sandboxId"]]',
        '[["runtime","sandboxId"]]',
        '[["runtime","sandboxId"]]',
      ].sort(),
    );
  },
);

Deno.test(
  "transitive wrapper forwarding preserves destructured argument 0",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  request: {
    command: string;
    sandboxId: FrameworkProvided<string>;
  };
}, { received: string }>(({ request }) => ({ received: request.command }));

const firstWrapper = pattern<{
  request: { command: string };
}, { received: string }>(({ request: { command } }) =>
  privileged({ request: { command } } as any)
);

export default pattern<{
  request: { command: string };
}, { received: string }>(({ request }) => firstWrapper({ request }));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(diagnostics, []);
    assertEquals(frameworkPathMetadata(output).length, 3);
    assertEquals(
      output.match(/\.key\("request"\)\.key\("sandboxId"\)/g)?.length,
      1,
      "the explicit wrapper must forward its protected leaf",
    );
    assertMatch(
      output,
      /"request":\s*__cf_[A-Za-z0-9_]+\.key\("request"\)/,
      "the shorthand wrapper must preserve its complete trusted argument-0 subtree",
    );
    assertMatch(
      output,
      /const\s+command\s*=\s*__cf_[A-Za-z0-9_]+\.key\("request",\s*"command"\);/,
      "ordinary destructuring must still bind the authored public field",
    );
    assertStringIncludes(output, "command");
  },
);

for (
  const [name, source] of [
    [
      "literal",
      `
export default pattern<{ command: string }>(({ command }) =>
  privileged({ command, sandboxId: "author-chosen" })
);`,
    ],
    [
      "closure-converted capture",
      `
export default pattern<{ command: string; chosen: string }>((outer) => ({
  wrapper: pattern<{ command: string }>(({ command }) =>
    privileged({ command, sandboxId: outer.chosen })
  ),
}));`,
    ],
  ] as const
) {
  Deno.test(
    `authored ${name} cannot supply a FrameworkProvided path`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}>(({ command }) => ({ command }));
${source}
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      const failures = diagnosticsOfType(
        diagnostics,
        FRAMEWORK_PROVIDED_WRAPPER,
      );
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, "sandboxId");
    },
  );
}

Deno.test(
  "a privileged dynamic factory call inside lift fails closed",
  async () => {
    const { diagnostics } = await validateSource(
      `
import {
  lift,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;

export const apply = lift((input: {
  operation: Privileged;
  command: string;
}) => input.operation({ command: input.command } as any));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const failures = diagnosticsOfType(diagnostics, SCHEDULED_FACTORY_CALL);
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0]!.message, "sandboxId");
  },
);

Deno.test(
  "a privileged dynamic factory call inside a referenced lift callback fails closed",
  async () => {
    const { diagnostics } = await validateSource(
      `
import {
  lift,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;

function callback(input: {
  operation: Privileged;
  command: string;
}) {
  return input.operation({ command: input.command } as any);
}

export const apply = lift(callback);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const failures = diagnosticsOfType(diagnostics, SCHEDULED_FACTORY_CALL);
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0]!.message, "sandboxId");
  },
);

Deno.test(
  "a privileged factory call reached through a scheduled helper fails closed",
  async () => {
    const { diagnostics } = await validateSource(
      `
import {
  lift,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;

function invoke(operation: Privileged, command: string) {
  return operation({ command } as any);
}

export const apply = lift((input: {
  operation: Privileged;
  command: string;
}) => invoke(input.operation, input.command));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const failures = diagnosticsOfType(diagnostics, SCHEDULED_FACTORY_CALL);
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0]!.message, "sandboxId");
  },
);

Deno.test(
  "scheduled factory modifier derivations do not count as privileged invocations",
  async () => {
    const { diagnostics } = await validateSource(
      `
import {
  lift,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;

export const derive = lift((input: { operation: Privileged }) =>
  input.operation.asScope("session").inSpace()
);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(diagnosticsOfType(diagnostics, SCHEDULED_FACTORY_CALL), []);
  },
);

for (
  const [boundary, source] of [
    [
      "eager pattern",
      `export default pattern<{ operation: Privileged; text: string }>(
        (input) => ({ upper: input.text.toUpperCase() }),
      );`,
    ],
    [
      "scheduled lift",
      `export const apply = lift((input: {
        operation: Privileged;
        text: string;
      }) => input.text.toUpperCase());`,
    ],
  ] as const
) {
  Deno.test(
    `an unrelated method call in an ${boundary} does not invoke a sibling privileged factory`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import {
  lift,
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;

${source}
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      assertEquals(
        diagnostics.filter((diagnostic) =>
          diagnostic.type === FRAMEWORK_PROVIDED_WRAPPER ||
          diagnostic.type === SCHEDULED_FACTORY_CALL
        ),
        [],
      );
    },
  );
}

Deno.test(
  "a widened scheduled factory boundary emits an explicitly unprivileged call contract",
  async () => {
    const { diagnostics, output } = await validateSource(
      `
import {
  lift,
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Ordinary = PatternFactory<{
  command: string;
  sandboxId: string;
}, { ok: boolean }>;

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>((_input) => ({ ok: true }));

export const apply = lift((input: {
  operation: Ordinary;
  command: string;
  sandboxId: string;
}) => input.operation({
  command: input.command,
  sandboxId: input.sandboxId,
}));

export default pattern<{ command: string; sandboxId: string }>((input) =>
  apply({
    operation: privileged as Ordinary,
    command: input.command,
    sandboxId: input.sandboxId,
  })
);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(diagnostics, []);
    const liftCall = callsNamed(parseModule(output), "lift")[0]!;
    const inputSchema = literalToValue(liftCall.arguments[1]!) as {
      properties: {
        operation: {
          asFactory: { frameworkProvidedPaths?: unknown };
        };
      };
    };
    assertEquals(
      inputSchema.properties.operation.asFactory.frameworkProvidedPaths,
      undefined,
      "authored asFactory schemas must never carry compiler authority",
    );
  },
);

for (
  const [source, boundary] of [
    ["event", "handler event"],
    ["context", "handler context"],
  ] as const
) {
  Deno.test(
    `a privileged dynamic factory call cannot trust ${boundary} data`,
    async () => {
      const other = source === "event" ? "context" : "event";
      const parameters = source === "event"
        ? `${source}: Boundary, ${other}: Record<string, never>`
        : `${other}: Record<string, never>, ${source}: Boundary`;
      const { diagnostics } = await validateSource(
        `
import {
  handler,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Privileged = PatternFactory<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { ok: boolean }>;
type Boundary = {
  operation: Privileged;
  command: string;
  sandboxId: FrameworkProvided<string>;
};

export const apply = handler(
  (${parameters}) =>
    ${source}.operation({
      command: ${source}.command,
      sandboxId: ${source}.sandboxId,
    }),
);
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      const failures = diagnosticsOfType(diagnostics, SCHEDULED_FACTORY_CALL);
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, "sandboxId");
    },
  );
}

Deno.test(
  "an inline wrapper argument is the trusted compiler-owned forwarding channel",
  async () => {
    const { diagnostics, output } = await validateSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}>(({ command }) => ({ command }));

export default pattern<{ command: string }>(({ command }) =>
  privileged({ command } as any)
);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.type.includes("framework-provided")
      ),
      [],
    );
    assertEquals(frameworkPathMetadata(output).length, 2);
    assertStringIncludes(output, '.key("sandboxId")');
  },
);

for (
  const [shape, input, path] of [
    [
      "wildcard",
      "{ sandboxes: Record<string, FrameworkProvided<string>> }",
      "sandboxes.*",
    ],
    [
      "array",
      "{ sandboxes: Array<FrameworkProvided<string>> }",
      "sandboxes.[]",
    ],
  ] as const
) {
  Deno.test(
    `FrameworkProvided ${shape} paths produce a compile-time diagnostic`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import { pattern, type FrameworkProvided } from "commonfabric";

export default pattern<${input}>((_input) => ({ ok: true }));
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      const failures = diagnosticsOfType(diagnostics, NON_STATIC_PATH);
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, path);
    },
  );
}
