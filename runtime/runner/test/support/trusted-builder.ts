import {
  createBuilder,
  type CreateBuilderOptions,
} from "../../src/builder/factory.ts";
import { setDurableArtifactEntryRef } from "../../src/builder/pattern-metadata.ts";
import type {
  Module,
  Pattern,
  PatternFactory,
} from "../../src/builder/types.ts";
import type { Runtime } from "../../src/runtime.ts";

const TEST_TRUST_REASON = "unit test fixture";

type TestArtifactRegistry = {
  byRef: Map<string, PatternFactory<any, any>>;
  identities: Set<string>;
};

const testArtifactRegistries = new WeakMap<Runtime, TestArtifactRegistry>();
const testArtifactRefs = new WeakMap<
  object,
  { identity: string; symbol: string }
>();
let nextTestArtifactIdentity = 0;

function testArtifactRegistry(runtime: Runtime): TestArtifactRegistry {
  const existing = testArtifactRegistries.get(runtime);
  if (existing !== undefined) return existing;

  const registry: TestArtifactRegistry = {
    byRef: new Map(),
    identities: new Set(),
  };
  const manager = runtime.patternManager;
  const resolveOriginal = manager.artifactFromIdentitySync.bind(manager);
  const availableOriginal = manager.isArtifactAvailableInSpace.bind(manager);
  manager.artifactFromIdentitySync = (identity, symbol) =>
    registry.byRef.get(`${identity}#${symbol}`) ??
      resolveOriginal(identity, symbol);
  manager.isArtifactAvailableInSpace = (identity, space) =>
    registry.identities.has(identity) || availableOriginal(identity, space);
  testArtifactRegistries.set(runtime, registry);
  return registry;
}

/**
 * Give a hand-built PatternFactory the warm artifact metadata that transformed
 * source receives from module evaluation. Use only for fixtures that need to
 * write the factory as canonical Fabric data; it deliberately does not make
 * arbitrary functions serializable or provide a cold source closure.
 */
export function installTestPatternArtifact<
  T extends PatternFactory<any, any>,
>(runtime: Runtime, factory: T): T {
  let ref = testArtifactRefs.get(factory);
  if (ref === undefined) {
    const suffix = (++nextTestArtifactIdentity).toString(36).padStart(8, "0");
    ref = {
      identity: (`T${suffix}${"A".repeat(42)}`).slice(0, 43),
      symbol: "default",
    };
    testArtifactRefs.set(factory, ref);
    setDurableArtifactEntryRef(factory, ref);
  }

  const registry = testArtifactRegistry(runtime);
  registry.byRef.set(`${ref.identity}#${ref.symbol}`, factory);
  registry.identities.add(ref.identity);
  return factory;
}

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
