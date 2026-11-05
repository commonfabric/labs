import { assertEquals, assertThrows } from "@std/assert";
import { factoryStateOf } from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  getFrameworkProvidedPaths,
  setFrameworkProvidedPaths,
} from "../src/builder/pattern-metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string" },
    sandboxId: { type: "string" },
  },
  required: ["command", "sandboxId"],
} as const;

const signer = await Identity.fromPassphrase("framework metadata test");

async function withHelpers(
  test: (helpers: any) => void | Promise<void>,
): Promise<void> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    await test(
      (commonfabric as unknown as { __cfHelpers: unknown }).__cfHelpers,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

Deno.test("FrameworkProvided metadata lives on all trusted builder artifacts", () =>
  withHelpers(({ pattern, lift, handler, withFrameworkProvidedPaths }) => {
    const base = pattern(
      withFrameworkProvidedPaths(
        ({ sandboxId }: { sandboxId: string }) => ({ sandboxId }),
        [["sandboxId"]],
      ),
      INPUT_SCHEMA,
      INPUT_SCHEMA,
    );

    assertEquals(getFrameworkProvidedPaths(base), [["sandboxId"]]);
    const moduleFactory = lift(
      withFrameworkProvidedPaths((input: { sandboxId: string }) => input, [[
        "sandboxId",
      ]]),
      INPUT_SCHEMA,
      INPUT_SCHEMA,
    );
    const handlerFactory = handler(
      { type: "object", properties: {} },
      INPUT_SCHEMA,
      withFrameworkProvidedPaths(
        (_event: unknown, context: { sandboxId: string }) => context,
        [["sandboxId"]],
      ),
    );
    assertEquals(getFrameworkProvidedPaths(moduleFactory), [["sandboxId"]]);
    assertEquals(getFrameworkProvidedPaths(handlerFactory), [["sandboxId"]]);
    assertEquals(
      Object.hasOwn(factoryStateOf(base), "frameworkProvidedPaths"),
      false,
    );
  }));

Deno.test("FrameworkProvided artifact metadata is ordered by UTF-8 bytes", () =>
  withHelpers(({ pattern, withFrameworkProvidedPaths }) => {
    const base = pattern(
      withFrameworkProvidedPaths(
        (input: Record<string, string>) => input,
        [["😊"], ["ä"], ["z"]],
      ),
      INPUT_SCHEMA,
      INPUT_SCHEMA,
    );

    assertEquals(getFrameworkProvidedPaths(base), [
      ["z"],
      ["ä"],
      ["😊"],
    ]);
  }));

Deno.test("authored functions cannot acquire FrameworkProvided artifact metadata", () => {
  assertThrows(
    () => setFrameworkProvidedPaths(() => undefined, [["sandboxId"]]),
    TypeError,
    "trusted builder artifact",
  );
});

Deno.test("wrapper metadata synthesizes required system paths into its argument schema", () =>
  withHelpers(({ pattern, withFrameworkProvidedPaths }) => {
    const wrapper = pattern(
      withFrameworkProvidedPaths(
        ({ command }: { command: string }) => ({ command }),
        [["sandboxId"]],
      ),
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      INPUT_SCHEMA,
    );
    assertEquals(
      (wrapper.argumentSchema as { properties: Record<string, unknown> })
        .properties.sandboxId,
      true,
    );
    assertEquals(
      (wrapper.argumentSchema as { required: string[] }).required,
      ["command", "sandboxId"],
    );
  }));
