import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";

const signer = await Identity.fromPassphrase("test operator");

// A shared module whose identity must be stable regardless of which entry
// point pulls it into a compilation. It carries a default export so it can also
// serve as a program entry point.
const SHARED =
  "export const shared = (x: number) => x + 1;\nexport default shared;\n";

describe("Engine implementation identity", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Read the reload-stable, content-addressed module identity directly from the
  // compiled record graph rather than routing it through debug-source state.
  async function loadAndResolve(
    program: RuntimeProgram,
    modulePath: string,
  ): Promise<{ id: string; moduleIdentity: string | undefined }> {
    const { id, graph } = await engine.compileToRecordGraph(
      program,
    );
    const moduleIdentity = graph.specifierByPath.get(`/${id}${modulePath}`);
    return { id, moduleIdentity };
  }

  it("gives a shared module the same content-addressed identity across entry points", async () => {
    // Program A: entry imports the shared module (and so includes an extra file).
    const programA: RuntimeProgram = {
      main: "/a.tsx",
      files: [
        {
          name: "/a.tsx",
          contents:
            `import { shared } from "./shared.ts";\nexport default () => shared(1);\n`,
        },
        { name: "/shared.ts", contents: SHARED },
      ],
    };
    // Program B: the shared module is itself the entry point — a different file
    // set and a different program id.
    const programB: RuntimeProgram = {
      main: "/shared.ts",
      files: [
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const a = await loadAndResolve(programA, "/shared.ts");
    const b = await loadAndResolve(programB, "/shared.ts");

    // The whole-program ids differ (entry-point dependent), so an
    // implementation fingerprint built on them would be unstable.
    expect(a.id).not.toBe(b.id);

    // The content-addressed module identity is stable across entry points.
    expect(a.moduleIdentity).toBeTruthy();
    expect(a.moduleIdentity).toBe(b.moduleIdentity);
    expect(a.moduleIdentity!.startsWith("cf:module/")).toBe(true);
  });

  it("hashes module identity over PRISTINE authored source, not the helper-injected form", async () => {
    // module-loading.md §"Module Identity: Merkle hash over the import graph"
    // (`normSrc`) and §"Stability and sensitivity properties": a module's
    // identity is over its AUTHORED TypeScript, BEFORE the pretransform
    // helper-injection decoration, so it is TCB-version independent. Folding
    // in the injection would rotate a module's identity whenever the
    // decoration changes between compiles — a `writeAuthorizedBy` stamp
    // divergence between a profile stamped under an older decoration and one
    // recompiled today.
    const program: RuntimeProgram = {
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents: SHARED }],
    };
    const { entryIdentity } = await engine.compileToRecordGraph(program);

    const pristineId = computeModuleHashes({
      main: "/m.tsx",
      files: [{ name: "/m.tsx", contents: SHARED }],
    }).get("/m.tsx")!;
    const injectedId = computeModuleHashes(
      transformInjectHelperModule({
        main: "/m.tsx",
        files: [{ name: "/m.tsx", contents: SHARED }],
      }),
    ).get("/m.tsx")!;

    // The two candidate byte-forms genuinely hash differently — the choice is
    // real, not a no-op.
    expect(pristineId).not.toBe(injectedId);
    // The invariant: identity is over the pristine authored source.
    expect(entryIdentity).toBe(pristineId);
  });

  it("mints nested writer claims with the engine's authored path and module identity", async () => {
    const fileName = "/api/patterns/system/profile-home/profile-home.tsx";
    const program: RuntimeProgram = {
      main: fileName,
      files: [{
        name: fileName,
        contents: `/// <cts-enable />
          import { handler, toSchema, Writable, WriteAuthorizedBy } from "commonfabric";
          const setBio = handler<string, { bio: Writable<string> }>(
            (value, { bio }) => bio.set(value),
          );
          type ProtectedBio = WriteAuthorizedBy<string, typeof setBio>;
          interface Output { bio: ProtectedBio; }
          export const schema = toSchema<Output>();
        `,
      }],
    };

    const compiled = await engine.compileToRecordGraph(program);
    const evaluated = engine.evaluateRecordGraph(
      compiled.id,
      compiled.graph,
      compiled.mainSpecifier,
      program,
    );
    const findWriterIdentity = (
      value: unknown,
    ): Record<string, unknown> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      const marker = record.__ctWriterIdentityOf;
      if (marker && typeof marker === "object") {
        return marker as Record<string, unknown>;
      }
      for (const child of Object.values(record)) {
        const found = findWriterIdentity(child);
        if (found) return found;
      }
      return undefined;
    };
    const identity = findWriterIdentity(evaluated.main?.schema);

    expect(identity).toEqual({
      file: fileName,
      path: ["setBio"],
      moduleIdentity: compiled.entryIdentity,
    });

    // The source-cache recovery compiler is a separate pipeline construction
    // site; pin the same born-stamped payload there as well.
    const recovered = await engine.compileResolvedToRecordGraph(
      program.files,
      program.main,
    );
    expect(recovered.entryIdentity).toBe(compiled.entryIdentity);
    const recoveredBody = recovered.modules.find((module) =>
      module.filename === fileName
    )?.js;
    expect(recoveredBody).toContain(`file: "${fileName}"`);
    expect(recoveredBody).toContain(
      `moduleIdentity: "${compiled.entryIdentity}"`,
    );
  });

  it("changes the identity when the shared module's source changes", async () => {
    const program = (body: string): RuntimeProgram => ({
      main: "/shared.ts",
      files: [{ name: "/shared.ts", contents: body }],
    });

    const before = await loadAndResolve(program(SHARED), "/shared.ts");
    const after = await loadAndResolve(
      program(
        "export const shared = (x: number) => x + 2;\nexport default shared;\n",
      ),
      "/shared.ts",
    );

    expect(after.moduleIdentity).not.toBe(before.moduleIdentity);
  });
});
