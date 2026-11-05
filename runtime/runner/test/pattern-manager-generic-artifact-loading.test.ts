import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { factoryStateOf } from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { isTrustedBuilderArtifact } from "../src/builder/pattern-metadata.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { type MemorySpace, Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "pattern-manager generic artifact loading",
);
const otherSigner = await Identity.fromPassphrase(
  "pattern-manager generic artifact loading other space",
);
const spaceA = signer.did();
const spaceB = otherSigner.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern } from 'commonfabric';",
      "export const patternFactory = pattern<{ value: number }>(({ value }) => ({ value }));",
      "export const moduleFactory = lift((value: number) => value + 1);",
      "export const handlerFactory = handler((_event: number, _context: { value: number }) => undefined);",
      "const hiddenFactory = lift((value: number) => value - 1);",
      "export const plainFunction = (value: number) => value;",
      "export default pattern<{ value: number }>(({ value }) => ({ value: hiddenFactory(value) }));",
    ].join("\n"),
  }],
};

interface StoredProgram {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  writer: Runtime;
  reader: Runtime;
  identity: string;
}

const resources: StoredProgram[] = [];

async function storeProgram(
  spaces: readonly MemorySpace[] = [spaceA],
  readerOptions: {
    cfcEnforcementMode?: ConstructorParameters<
      typeof Runtime
    >[0]["cfcEnforcementMode"];
  } = {},
): Promise<StoredProgram> {
  const storageManager = StorageManager.emulate({ as: signer });
  const writer = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  let identity: string | undefined;
  for (const space of spaces) {
    let compiledIdentity: string | undefined;
    await writer.patternManager.compilePattern(PROGRAM, {
      space,
      onEntryIdentity(value) {
        compiledIdentity = value;
      },
    });
    expect(compiledIdentity).toBeDefined();
    identity ??= compiledIdentity;
    expect(compiledIdentity).toBe(identity);
  }
  await storageManager.synced();

  const reader = new Runtime({
    ...readerOptions,
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const stored = { storageManager, writer, reader, identity: identity! };
  resources.push(stored);
  return stored;
}

function countCachedEvaluations(runtime: Runtime): {
  count(): number;
  entered: Promise<void>;
  release(): void;
} {
  const original = runtime.harness.evaluateCachedModules.bind(runtime.harness);
  let evaluations = 0;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.harness.evaluateCachedModules = (async (...args) => {
    evaluations++;
    markEntered();
    await gate;
    return await original(...args);
  }) as typeof runtime.harness.evaluateCachedModules;
  return { count: () => evaluations, entered, release };
}

afterEach(async () => {
  while (resources.length > 0) {
    const { reader, writer, storageManager } = resources.pop()!;
    await reader.dispose();
    await writer.dispose();
    await storageManager.close();
  }
});

describe("PatternManager generic artifact loading", () => {
  it("cold-loads trusted pattern, module, handler, and __cfReg artifacts", async () => {
    const { reader, identity } = await storeProgram();
    const manager = reader.patternManager;

    const patternFactory = await manager.loadArtifactByIdentity(
      identity,
      "patternFactory",
      spaceA,
    );
    const moduleFactory = await manager.loadArtifactByIdentity(
      identity,
      "moduleFactory",
      spaceA,
    );
    const handlerFactory = await manager.loadArtifactByIdentity(
      identity,
      "handlerFactory",
      spaceA,
    );
    const hiddenFactory = await manager.loadArtifactByIdentity(
      identity,
      "hiddenFactory",
      spaceA,
    );

    for (
      const factory of [
        patternFactory,
        moduleFactory,
        handlerFactory,
        hiddenFactory,
      ]
    ) {
      expect(isTrustedBuilderArtifact(factory)).toBe(true);
    }
    expect(factoryStateOf(patternFactory).kind).toBe("pattern");
    expect(factoryStateOf(moduleFactory).kind).toBe("module");
    expect(factoryStateOf(handlerFactory).kind).toBe("handler");
    expect(factoryStateOf(hiddenFactory).kind).toBe("module");

    expect(
      await manager.loadArtifactByIdentity(
        identity,
        "plainFunction",
        spaceA,
      ),
    ).toBeUndefined();
    expect(
      await manager.loadPatternByIdentity(identity, "moduleFactory", spaceA),
    ).toBeUndefined();
    expect(
      await manager.loadPatternByIdentity(identity, "patternFactory", spaceA),
    ).toBe(patternFactory);
  });

  it("promotes artifacts after a session-only root learns durable availability", async () => {
    const { reader, identity } = await storeProgram();
    const manager = reader.patternManager;
    const { pattern } = createTrustedBuilder(reader).commonfabric;
    const placeholder = pattern(() => ({}), true, true);
    manager.associatePatternIdentity(placeholder, {
      identity,
      symbol: "default",
    });

    const moduleFactory = await manager.loadArtifactByIdentity(
      identity,
      "moduleFactory",
      spaceA,
    );

    expect(factoryStateOf(moduleFactory).ref).toEqual({
      identity,
      symbol: "moduleFactory",
    });
  });

  it("shares one identity evaluation across symbols and negative lookups", async () => {
    const { reader, identity } = await storeProgram();
    const manager = reader.patternManager;
    const evaluations = countCachedEvaluations(reader);

    const loads = Promise.all([
      // Deliberately make a missing symbol the flight leader. Evaluation must
      // still index the module once for every following valid symbol.
      manager.loadArtifactByIdentity(identity, "missing", spaceA),
      manager.loadArtifactByIdentity(identity, "plainFunction", spaceA),
      manager.loadArtifactByIdentity(identity, "patternFactory", spaceA),
      manager.loadArtifactByIdentity(identity, "moduleFactory", spaceA),
      manager.loadArtifactByIdentity(identity, "handlerFactory", spaceA),
      manager.loadArtifactByIdentity(identity, "hiddenFactory", spaceA),
    ]);
    await evaluations.entered;
    evaluations.release();
    const [
      missing,
      plainFunction,
      patternFactory,
      moduleFactory,
      handlerFactory,
      hiddenFactory,
    ] = await loads;

    expect(isTrustedBuilderArtifact(patternFactory)).toBe(true);
    expect(isTrustedBuilderArtifact(moduleFactory)).toBe(true);
    expect(isTrustedBuilderArtifact(handlerFactory)).toBe(true);
    expect(isTrustedBuilderArtifact(hiddenFactory)).toBe(true);
    expect(missing).toBeUndefined();
    expect(plainFunction).toBeUndefined();
    expect(evaluations.count()).toBe(1);

    expect(
      await manager.loadArtifactByIdentity(identity, "missing", spaceA),
    ).toBeUndefined();
    expect(
      await manager.loadArtifactByIdentity(
        identity,
        "plainFunction",
        spaceA,
      ),
    ).toBeUndefined();
    expect(evaluations.count()).toBe(1);
  });

  it("reuses evaluation after verifying the identity in both spaces", async () => {
    const { reader, identity } = await storeProgram([spaceA, spaceB]);
    const manager = reader.patternManager;
    const evaluations = countCachedEvaluations(reader);

    const loadA = manager.loadArtifactByIdentity(
      identity,
      "patternFactory",
      spaceA,
    );
    await evaluations.entered;
    const loadB = manager.loadArtifactByIdentity(
      identity,
      "patternFactory",
      spaceB,
    );
    evaluations.release();

    const [artifactA, artifactB] = await Promise.all([loadA, loadB]);
    expect(isTrustedBuilderArtifact(artifactA)).toBe(true);
    expect(isTrustedBuilderArtifact(artifactB)).toBe(true);
    expect(evaluations.count()).toBe(1);
    expect(manager.isArtifactAvailableInSpace(identity, spaceA)).toBe(true);
    expect(manager.isArtifactAvailableInSpace(identity, spaceB)).toBe(true);
  });

  it("keeps cold generic loading behind CFC enforcement", async () => {
    const { reader, identity } = await storeProgram([spaceA], {
      cfcEnforcementMode: "disabled",
    });

    expect(
      await reader.patternManager.loadArtifactByIdentity(
        identity,
        "patternFactory",
        spaceA,
      ),
    ).toBeUndefined();
  });
});
