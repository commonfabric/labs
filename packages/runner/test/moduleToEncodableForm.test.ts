/**
 * Serializing a module asks what its encodable form is allowed to carry: a
 * source fallback that survives a runtime unable to resolve the implementation
 * reference, and never the implementation behind a module that is not
 * JavaScript.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import { moduleToEncodableForm } from "../src/builder/to-encodable-form.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("moduleToEncodableForm", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("serializes unblessed javascript modules with executable source fallback", () => {
    const implementation = Object.assign(
      (value: number) => value * 2,
      {
        preview: "(value) => value * 2",
        src: "main.tsx:1:1",
      },
    );
    const serialized = moduleToEncodableForm({
      type: "javascript",
      implementation,
    } as any);

    expect(serialized).toMatchObject({
      type: "javascript",
      implementation: Function.prototype.toString.call(implementation),
      preview: "(value) => value * 2",
      location: "main.tsx:1:1",
    });
  });

  it("serializes non-javascript function-backed modules without leaking implementations", () => {
    const implementation = Object.assign(
      () => "ok",
      {
        preview: "() => 'ok'",
        src: "main.tsx:2:1",
      },
    );
    const serialized = moduleToEncodableForm({
      type: "raw",
      implementation,
    } as any);

    expect(serialized).toMatchObject({
      type: "raw",
      preview: "() => 'ok'",
      location: "main.tsx:2:1",
    });
    expect("implementation" in serialized).toBe(false);
  });

  it("keeps the fallback body when the registering runtime can't resolve the $implRef (standalone-engine registration)", async () => {
    const compileEngine = new Engine(runtime);
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const sourcePath = new URL(
      "../../patterns/factory-outputs/parking-coordinator/main.test.tsx",
      import.meta.url,
    ).pathname;
    const program = await resolveLocalProgram(
      (resolver) => compileEngine.resolve(resolver),
      { main: sourcePath, root: repoRoot },
    );
    const { main } = await compileEngine.compileAndEvaluateModules(program);
    const pattern = main?.default as any;

    const seen = new Set<unknown>();
    let targetModule: any;
    const visit = (value: unknown) => {
      if (
        !value ||
        (typeof value !== "object" && typeof value !== "function") ||
        seen.has(value)
      ) {
        return;
      }
      seen.add(value);
      if (
        !targetModule &&
        typeof (value as { type?: unknown }).type === "string" &&
        (value as { type?: string }).type === "javascript" &&
        typeof (value as { implementation?: unknown }).implementation ===
          "function"
      ) {
        const implementation =
          (value as { implementation: (...args: unknown[]) => unknown })
            .implementation;
        const implementationSource =
          (implementation as { preview?: string }).preview ??
            implementation.toString();
        if (
          implementationSource.includes(
            "formatDateShort(dateStr).shortName",
          )
        ) {
          targetModule = value;
          return;
        }
      }
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value as object,
          key,
        );
        if (descriptor && "value" in descriptor) {
          visit(descriptor.value);
        }
      }
    };
    visit(pattern);

    expect(targetModule).toBeDefined();

    // The implementation became verified during the STANDALONE Engine's
    // evaluation, so it carries process-global content-addressed provenance
    // (Engine.#recordModuleProvenance) and `moduleToEncodableForm` writes a `$implRef`.
    // But this pattern was registered WITHOUT going through
    // `compilePattern`/`registerEvaluatedModules` on THIS runtime, so its
    // engine's implementation index never saw the artifact and cannot resolve
    // that `$implRef` on reload (the cross-engine path the deleted
    // `associatePattern` bridge used to serve). The serializer must therefore
    // KEEP the stringified body as the fallback — otherwise reload would miss
    // the index, miss the registry, and throw.
    expect(getVerifiedProvenance(targetModule.implementation)).toBeDefined();
    expect(
      runtime.patternManager.artifactFromIdentitySync(
        getVerifiedProvenance(targetModule.implementation)!.identity,
        getVerifiedProvenance(targetModule.implementation)!.symbol!,
      ),
    ).toBeUndefined();
    expect(
      runtime.harness.getVerifiedImplementation?.(
        getVerifiedProvenance(targetModule.implementation)!.identity,
        getVerifiedProvenance(targetModule.implementation)!.symbol!,
      ),
    ).toBeUndefined();

    const frame = pushFrame({ runtime });
    let serialized: ReturnType<typeof moduleToEncodableForm>;
    try {
      serialized = moduleToEncodableForm(targetModule);
    } finally {
      popFrame(frame);
    }
    expect(serialized).toMatchObject({ type: "javascript" });
    expect("implementationRef" in serialized).toBe(false);
    expect(serialized).toHaveProperty("$implRef");
    // Body KEPT: this runtime cannot resolve the $implRef, so the fallback is
    // required for a successful reload.
    expect("implementation" in serialized).toBe(true);
  });
});
