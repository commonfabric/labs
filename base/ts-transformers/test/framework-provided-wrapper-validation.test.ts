import { assertEquals, assertStringIncludes } from "@std/assert";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const FRAMEWORK_PROVIDED_WRAPPER =
  "pattern-callback:framework-provided-wrapper";

async function frameworkDiagnostics(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === FRAMEWORK_PROVIDED_WRAPPER
  );
}

Deno.test(
  "nested pattern accepts aliased optional FrameworkProvided public paths as system metadata",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

type ProvidedId = FrameworkProvided<string>;
type WrapperInput = {
  request?: {
    sandboxId?: ProvidedId;
  };
};

export default pattern(() => ({
  child: pattern<WrapperInput>((input) => ({ input })),
}));
`);

    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "nested pattern rejects a captured FrameworkProvided path",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

type ParentInput = {
  system: { sandboxId?: FrameworkProvided<string> };
};

export default pattern<ParentInput>(({ system }) => ({
  child: pattern(() => ({ sandboxId: system.sandboxId })),
}));
`);

    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0]!.line, 10);
    assertStringIncludes(diagnostics[0]!.message, "system.sandboxId");
    assertStringIncludes(diagnostics[0]!.message, "closure params");
    assertEquals(diagnostics[0]!.message.includes("WP3.6"), false);
  },
);

Deno.test(
  "nested pattern traces FrameworkProvided through an as-any alias chain",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

export default pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => {
  const first: any = (sandboxId as any);
  const second = (first satisfies any);
  const erased = (second);
  return {
    child: pattern(() => ({ erased })),
  };
});
`);

    assertEquals(diagnostics.length, 1);
    assertStringIncludes(diagnostics[0]!.message, "erased");
    assertStringIncludes(diagnostics[0]!.message, "closure params");
  },
);

Deno.test(
  "nested pattern rejects a captured factory with FrameworkProvided input",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import {
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type OperationInput = {
  request?: { sandboxId: FrameworkProvided<string> };
};
type Operation = PatternFactory<OperationInput, { ok: boolean }>;

export default pattern<{ operation: Operation }>((input) => ({
  child: pattern(() => ({ operation: input.operation })),
}));
`);

    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0]!.line, 15);
    assertStringIncludes(
      diagnostics[0]!.message,
      "operation input 'request.sandboxId'",
    );
    assertStringIncludes(
      diagnostics[0]!.message,
      "invoke the factory directly",
    );
    assertEquals(diagnostics[0]!.message.includes("WP3.6"), false);
  },
);

for (
  const [containerKind, declaration] of [
    ["object", "const container = { operation };"],
    ["array", "const container = [operation];"],
    ["tuple", "const container = [operation] as const;"],
  ] as const
) {
  Deno.test(
    `nested pattern rejects privileged factories inside ${containerKind} captures`,
    async () => {
      const diagnostics = await frameworkDiagnostics(`
import {
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

type Operation = PatternFactory<
  { sandboxId: FrameworkProvided<string> },
  { ok: boolean }
>;

export default pattern<{ operation: Operation }>(({ operation }) => {
  ${declaration}
  return {
    child: pattern(() => ({ container })),
  };
});
`);

      assertEquals(diagnostics.length, 1);
      assertStringIncludes(diagnostics[0]!.message, "sandboxId");
      assertStringIncludes(diagnostics[0]!.message, "Captured factory");
    },
  );
}

Deno.test(
  "nested pattern forwards invocation of a live factory with FrameworkProvided input",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}>(({ command }) => ({ command }));

export default pattern<{ command: string }>((input) => ({
  child: pattern(() => ({
    result: privileged({ command: input.command } as any),
  })),
}));
`);

    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "nested pattern forwards FrameworkProvided through a widened module factory alias",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import {
  pattern,
  type FrameworkProvided,
  type PatternFactory,
} from "commonfabric";

const privileged = pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => ({ sandboxId }));

const widened: PatternFactory<
  { value: string },
  { ok: boolean }
> = privileged as any;

export default pattern(() => ({
  child: pattern(() => ({ result: widened({ value: "x" }) })),
}));
`);

    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "nested pattern may expose a live factory carrying trusted FrameworkProvided metadata",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => ({ sandboxId }));

export default pattern(() => ({
  child: pattern(() => ({ privileged })),
}));
`);

    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "module-scope base pattern may declare FrameworkProvided input",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern, type FrameworkProvided } from "commonfabric";

export default pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => ({ sandboxId }));
`);

    assertEquals(diagnostics.length, 0);
  },
);

Deno.test(
  "a copied local FrameworkProvided spelling does not gain trusted provenance",
  async () => {
    const diagnostics = await frameworkDiagnostics(`
import { pattern } from "commonfabric";

declare const FRAMEWORK_PROVIDED_MARKER: unique symbol;
type FrameworkProvided<T> =
  | (T & { readonly [FRAMEWORK_PROVIDED_MARKER]: true })
  | T;

export default pattern(() => ({
  child: pattern<{ sandboxId?: FrameworkProvided<string> }>(
    ({ sandboxId }) => ({ sandboxId }),
  ),
}));
`);

    assertEquals(diagnostics.length, 0);
  },
);
