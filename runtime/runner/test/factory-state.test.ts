import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import {
  factoryStateOf,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { deepFreeze, hashOf } from "@commonfabric/data-model";
import type { Frame, JSONSchema } from "../src/builder/types.ts";
import { byRef, handler, lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import * as patternMetadata from "../src/builder/pattern-metadata.ts";
import { sqliteQueryNodeFactory } from "../src/builtins/sqlite/query-node.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("factory-state-test");
const space = signer.did();
const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

describe("builder factory state", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  });

  it("brands pattern, module, and handler callables without changing invocation", () => {
    const patternFactory = pattern(
      (_input: unknown) => ({ value: 1 }),
      true,
      { type: "object" },
    );
    const moduleFactory = lift(
      (input: { value: number }) => input.value,
      { type: "object" },
      { type: "number" },
    );
    const handlerFactory = handler(
      { type: "number" },
      { type: "object" },
      (_event: number, _context: Record<string, unknown>) => undefined,
    );

    expect(factoryStateOf(patternFactory)).toMatchObject({
      kind: "pattern",
      argumentSchema: true,
      resultSchema: { type: "object" },
    });
    expect(factoryStateOf(moduleFactory)).toMatchObject({
      kind: "module",
      argumentSchema: { type: "object" },
      resultSchema: { type: "number" },
    });
    expect(factoryStateOf(handlerFactory)).toMatchObject({
      kind: "handler",
      contextSchema: { type: "object" },
      eventSchema: { type: "number" },
    });

    expect(() => patternFactory({})).not.toThrow();
    expect(() => moduleFactory({ value: 1 })).not.toThrow();
    expect(() => handlerFactory({})).not.toThrow();
  });

  it("keeps direct pattern JSON as a full compatibility graph after indexing", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern((_input: {}) => ({ value: 1 }));",
        ].join("\n"),
      }],
    });

    expect(runtime.patternManager.getArtifactEntryRef(compiled)).toBeDefined();
    const json = JSON.parse(JSON.stringify(compiled));
    expect(json.$patternRef).toBeUndefined();
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(json.result).toBeDefined();
  });

  it("retains the authored pattern result schema as the public factory contract", () => {
    const publicResultSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          piece: { type: "object", asCell: ["cell"] },
        },
      },
    } as const satisfies JSONSchema;
    const factory = pattern(
      (_input: unknown) => [],
      true,
      publicResultSchema,
    );

    // Pattern graph outputs store cell links, so the execution artifact keeps
    // its historical link-sanitized schema.
    expect(factory.resultSchema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { piece: { type: "object" } },
      },
    });
    // Factory@1 describes the public call contract, which must still match the
    // transformer-emitted asFactory contract exactly.
    const state = factoryStateOf(factory);
    expect(state.kind).toBe("pattern");
    if (state.kind !== "pattern") throw new Error("expected pattern state");
    expect(state.resultSchema).toEqual(publicResultSchema);
  });

  it("shares a root token across modifier derivations while retaining raw modifiers", () => {
    const basePattern = pattern(
      (_input: unknown) => ({ value: 1 }),
      true,
      true,
    );
    const selector = { space: "child" };
    const scopedPattern = basePattern.asScope("user");
    const selectedPattern = basePattern.inSpace(selector as never);
    const anonymousPattern = basePattern.inSpace(undefined, {
      grants: { "*": "WRITE" },
      root: true,
      spaceKind: "profile",
      selfOwned: true,
    });
    const cellSelector = runtime.getCell(space, "factory-space-selector");
    const cellSelectedPattern = basePattern.inSpace(cellSelector);
    const scopeThenSpace = basePattern.asScope("user").inSpace(cellSelector);
    const spaceThenScope = basePattern.inSpace(cellSelector).asScope("user");

    const baseModule = lift<number>((value) => value, true, true);
    const scopedModule = baseModule.asScope("session");

    const basePatternState = factoryStateOf(basePattern);
    const scopedPatternState = factoryStateOf(scopedPattern);
    const selectedPatternState = factoryStateOf(selectedPattern);
    const anonymousPatternState = factoryStateOf(anonymousPattern);
    const cellSelectedPatternState = factoryStateOf(cellSelectedPattern);
    const scopeThenSpaceState = factoryStateOf(scopeThenSpace);
    const spaceThenScopeState = factoryStateOf(spaceThenScope);
    const baseModuleState = factoryStateOf(baseModule);
    const scopedModuleState = factoryStateOf(scopedModule);

    expect("rootToken" in basePatternState).toBe(true);
    expect("rootToken" in scopedPatternState).toBe(true);
    expect("rootToken" in selectedPatternState).toBe(true);
    expect("rootToken" in anonymousPatternState).toBe(true);
    expect("rootToken" in baseModuleState).toBe(true);
    expect("rootToken" in scopedModuleState).toBe(true);
    if (
      "rootToken" in basePatternState &&
      "rootToken" in scopedPatternState &&
      "rootToken" in selectedPatternState &&
      "rootToken" in anonymousPatternState &&
      "rootToken" in baseModuleState &&
      "rootToken" in scopedModuleState
    ) {
      expect(scopedPatternState.rootToken).toBe(basePatternState.rootToken);
      expect(selectedPatternState.rootToken).toBe(basePatternState.rootToken);
      expect(anonymousPatternState.rootToken).toBe(basePatternState.rootToken);
      expect(scopedModuleState.rootToken).toBe(baseModuleState.rootToken);
    }
    expect(scopedPatternState).toMatchObject({ defaultScope: "user" });
    expect(selectedPatternState).toMatchObject({ spaceSelector: selector });
    expect(anonymousPatternState).toMatchObject({
      spaceSelector: "",
      spaceRequest: {
        grants: { "*": "WRITE" },
        root: true,
        spaceKind: "profile",
        selfOwned: true,
      },
    });
    expect(cellSelectedPatternState).toMatchObject({
      spaceSelector: cellSelector,
    });
    expect(scopeThenSpaceState).toMatchObject({
      defaultScope: "user",
      spaceSelector: cellSelector,
    });
    expect(spaceThenScopeState).toMatchObject({
      defaultScope: "user",
      spaceSelector: cellSelector,
    });
    expect(scopedModuleState).toMatchObject({ defaultScope: "session" });
    expect(patternMetadata.resolveOriginal(scopedModule)).toBe(baseModule);
  });

  it("does not treat a canonical-looking session ref as durable", () => {
    const makeManual = () => {
      const factory = pattern(
        (_input: unknown) => ({ value: 1 }),
        true,
        true,
      );
      runtime.patternManager.associatePatternIdentity(factory, REF);
      return factory;
    };

    expect(() => sealFactoryState(makeManual())).toThrow(
      "artifact ref is not available",
    );
    expect(() => deepFreeze(makeManual())).toThrow(
      "artifact ref is not available",
    );
    expect(() => hashOf(makeManual())).toThrow(
      "artifact ref is not available",
    );

    const keyless = pattern(
      (_input: unknown) => ({ value: 1 }),
      true,
      true,
    );
    runtime.patternManager.ensureKeylessPatternIdentity(keyless);
    expect(() => sealFactoryState(keyless)).toThrow(
      "artifact ref is not available",
    );

    const hostRef = byRef<unknown, unknown>("host-only");
    patternMetadata.setArtifactEntryRef(hostRef, {
      identity: "host:1",
      symbol: "fn0",
    });
    expect(() => sealFactoryState(hostRef)).toThrow(
      "artifact ref is not available",
    );
  });

  it("seals root and pre-existing derivations only after verified durable indexing", () => {
    const basePattern = pattern(
      (_input: unknown) => ({ value: 1 }),
      true,
      true,
    );
    const scopedPattern = basePattern.asScope("user");
    const baseModule = lift<number>((value) => value, true, true);
    const scopedModule = baseModule.asScope("session");

    expect(() => sealFactoryState(scopedPattern)).toThrow(
      "artifact ref is not available",
    );
    expect(() => sealFactoryState(scopedModule)).toThrow(
      "artifact ref is not available",
    );

    patternMetadata.setDurableArtifactEntryRef(basePattern, {
      ...REF,
      symbol: "pattern",
    });
    patternMetadata.setDurableArtifactEntryRef(baseModule, {
      ...REF,
      symbol: "module",
    });
    const legacyImplRef = {
      identity: `${"B".repeat(42)}E`,
      symbol: "implementation-only",
    };
    baseModule.$implRef = legacyImplRef;

    expect(sealFactoryState(basePattern)).toMatchObject({
      kind: "pattern",
      ref: { ...REF, symbol: "pattern" },
    });
    expect(sealFactoryState(scopedPattern)).toMatchObject({
      kind: "pattern",
      ref: { ...REF, symbol: "pattern" },
      defaultScope: "user",
    });
    expect(sealFactoryState(baseModule)).toMatchObject({
      kind: "module",
      ref: { ...REF, symbol: "module" },
    });
    expect(sealFactoryState(baseModule).ref).not.toEqual(legacyImplRef);
    expect(sealFactoryState(scopedModule)).toMatchObject({
      kind: "module",
      ref: { ...REF, symbol: "module" },
      defaultScope: "session",
    });
  });

  it("preserves false and original handler schemas before internal combination", () => {
    const contextSchema = {
      $defs: { Context: { type: "object" } },
      $ref: "#/$defs/Context",
    } as const;
    const handlerFactory = handler(
      false,
      contextSchema,
      (_event: never, _context: Record<string, unknown>) => undefined,
    );
    const moduleFactory = lift(
      (_input: never) => undefined,
      false,
      false,
    );

    expect(factoryStateOf(handlerFactory)).toMatchObject({
      kind: "handler",
      contextSchema,
      eventSchema: false,
    });
    expect(factoryStateOf(moduleFactory)).toMatchObject({
      kind: "module",
      argumentSchema: false,
      resultSchema: false,
    });
  });

  it("assigns all three kinds at verified evaluation before publication", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { handler, lift, pattern } from 'commonfabric';",
          "export const moduleFactory = lift((value: number) => value);",
          "export const handlerFactory = handler((_event: number, _context: { value: number }) => undefined);",
          "export default pattern((_input: {}) => ({ value: 1 }));",
        ].join("\n"),
      }],
    };
    const sessionResult = await runtime.patternManager
      .compileAndRegisterModules(
        program,
      );
    const sessionFactories = [
      sessionResult.main!.default,
      sessionResult.main!.moduleFactory,
      sessionResult.main!.handlerFactory,
    ] as const;

    const expectedKinds = ["pattern", "module", "handler"] as const;
    for (let i = 0; i < sessionFactories.length; i++) {
      const factory = sessionFactories[i];
      const ref = runtime.patternManager.getArtifactEntryRef(factory);
      expect(ref).toBeDefined();
      expect(sealFactoryState(factory)).toMatchObject({
        kind: expectedKinds[i],
        ref,
      });
      expect(
        runtime.patternManager.isArtifactAvailableInSpace(
          ref!.identity,
          space,
        ),
      ).toBe(false);
    }

    let entryIdentity: string | undefined;
    await runtime.patternManager.compilePattern(program, {
      space,
      onEntryIdentity(identity) {
        entryIdentity = identity;
      },
    });
    expect(entryIdentity).toBeDefined();

    const symbols = ["default", "moduleFactory", "handlerFactory"] as const;
    for (let i = 0; i < symbols.length; i++) {
      const factory = runtime.patternManager.artifactFromIdentitySync(
        entryIdentity!,
        symbols[i],
      ) as object;
      expect(factory).toBeDefined();
      const ref = runtime.patternManager.getArtifactEntryRef(factory);
      expect(ref).toBeDefined();
      const state = sealFactoryState(factory);
      expect(state.kind).toBe(expectedKinds[i]);
      expect(state.ref).toEqual(ref);
    }
  });

  it("loads the module-init sqlite builtin without a builder-cycle TDZ", () => {
    expect(typeof sqliteQueryNodeFactory).toBe("function");
    expect(factoryStateOf(sqliteQueryNodeFactory)).toMatchObject({
      kind: "module",
    });
  });
});
