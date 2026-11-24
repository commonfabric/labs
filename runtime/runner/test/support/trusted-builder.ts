import {
  createBuilder,
  type CreateBuilderOptions,
} from "../../src/builder/factory.ts";
import type { Module, Pattern } from "../../src/builder/types.ts";
import type { Runtime } from "../../src/runtime.ts";

const TEST_TRUST_REASON = "unit test fixture";

export function createTrustedBuilder(
  runtime: Runtime,
  options: Omit<CreateBuilderOptions, "unsafeHostTrust"> = {},
) {
  return createBuilder({
    ...options,
    unsafeHostTrust: runtime.createUnsafeHostTrust({
      reason: TEST_TRUST_REASON,
    }),
  });
}

export function trustPattern<T extends Pattern>(
  runtime: Runtime,
  pattern: T,
  reason = TEST_TRUST_REASON,
): T {
  return runtime.unsafeTrustPattern(pattern, { reason });
}

export function trustModule<T extends Module>(
  runtime: Runtime,
  module: T,
  reason = TEST_TRUST_REASON,
): T {
  return runtime.unsafeTrustModule(module, { reason });
}

export function trustExecutable<T extends Pattern | Module | undefined>(
  runtime: Runtime,
  executable: T,
  reason = TEST_TRUST_REASON,
): T {
  if (!executable) {
    return executable;
  }
  return ("nodes" in executable
    ? trustPattern(runtime, executable as Pattern, reason)
    : trustModule(runtime, executable as Module, reason)) as T;
}
