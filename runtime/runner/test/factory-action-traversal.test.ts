import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createFactoryShell,
  registerFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("factory-action-traversal");
const space = signer.did();
const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

describe("factory-aware action schema walks", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const collectors = () => {
    const runner = runtime.runner.accessForTestingOnly as unknown as {
      collectWritableCellArgumentLinks(
        schema: unknown,
        value: unknown,
        processCell: unknown,
        writeInputPaths?: readonly (readonly string[])[],
      ): NormalizedFullLink[];
      collectArgumentSchedulerReadLinks(
        schema: unknown,
        value: unknown,
        processCell: unknown,
      ): NormalizedFullLink[];
    };
    return {
      writable: runner.collectWritableCellArgumentLinks.bind(runner),
      scheduler: runner.collectArgumentSchedulerReadLinks.bind(runner),
    };
  };

  const setup = () => {
    const processCell = runtime.getCell(space, "factory-action-process");
    const writableTarget = runtime.getCell(
      space,
      "factory-action-writable-target",
    );
    const selectorTarget = runtime.getCell(
      space,
      "factory-action-selector-target",
    );
    const writableLink = writableTarget.getAsWriteRedirectLink({
      base: processCell,
    });
    const selectorLink = selectorTarget.getAsWriteRedirectLink({
      base: processCell,
    });
    const factory = createFactoryShell({
      kind: "pattern",
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: {
        type: "object",
        properties: {
          target: { asCell: ["cell"] },
          bytes: true,
        },
      },
      params: {
        target: writableLink,
        bytes: new FabricBytes(new Uint8Array([4, 5, 6])),
      },
      spaceSelector: selectorLink,
    });
    return {
      factory,
      processCell,
      selectorTarget,
      writableTarget,
    };
  };

  it("collects writable params but never treats spaceSelector as writable", () => {
    const { factory, processCell, selectorTarget, writableTarget } = setup();
    const { writable } = collectors();

    const links = writable(
      { type: "object", properties: { first: true, second: true } },
      { first: factory, second: factory },
      processCell,
    );

    expect(links.map((link) => link.id)).toEqual([
      writableTarget.getAsNormalizedFullLink().id,
    ]);
    expect(links.map((link) => link.id)).not.toContain(
      selectorTarget.getAsNormalizedFullLink().id,
    );

    const pathFiltered = writable(
      { type: "object", properties: { first: true, second: true } },
      { first: factory, second: factory },
      processCell,
      [["second"]],
    );
    expect(pathFiltered.map((link) => link.id)).toEqual([
      writableTarget.getAsNormalizedFullLink().id,
    ]);
  });

  it("collects scheduler reads from params and the execution-space selector", () => {
    const { factory, processCell, selectorTarget, writableTarget } = setup();
    const { scheduler } = collectors();

    const links = scheduler(
      { type: "object", properties: { first: true, second: true } },
      { first: factory, second: factory },
      processCell,
    );

    expect(links.map((link) => link.id).sort()).toEqual([
      selectorTarget.getAsNormalizedFullLink().id,
      writableTarget.getAsNormalizedFullLink().id,
    ].sort());
  });

  it("finds factories nested in array items and additional properties", () => {
    const { factory, processCell, selectorTarget, writableTarget } = setup();
    const { scheduler, writable } = collectors();
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            list: { type: "array", items: true },
            record: { type: "object", additionalProperties: true },
          },
        },
      },
    };
    const value = {
      nested: {
        list: [factory],
        record: { current: factory },
      },
    };

    expect(
      writable(schema, value, processCell).map((link) => link.id),
    ).toEqual([writableTarget.getAsNormalizedFullLink().id]);
    expect(
      scheduler(schema, value, processCell).map((link) => link.id).sort(),
    ).toEqual([
      selectorTarget.getAsNormalizedFullLink().id,
      writableTarget.getAsNormalizedFullLink().id,
    ].sort());
  });

  it("fails closed for arbitrary functions and real hidden-state cycles", () => {
    const processCell = runtime.getCell(space, "factory-action-invalid");
    const { scheduler, writable } = collectors();
    const withFunction = registerFabricFactory(
      () => undefined,
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: { invalid: () => undefined },
      },
    );

    for (const collect of [writable, scheduler]) {
      expect(() => collect(true, withFunction, processCell)).toThrow(
        "Arbitrary functions are not valid factory state values",
      );
    }

    const cyclicParams: { self?: unknown } = {};
    const cyclic = registerFabricFactory(
      () => undefined,
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: cyclicParams,
      },
    );
    cyclicParams.self = cyclic;
    for (const collect of [writable, scheduler]) {
      expect(() => collect(true, cyclic, processCell)).toThrow(
        "Circular reference detected in factory state",
      );
    }
  });
});
