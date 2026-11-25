// A host that runs patterns in its own process (a deployed client with server
// execution off) sends their model calls to the deployment its runtime talks
// to. The runtime answers that per space, so the endpoint is the runtime's
// own and no host has to set a process-wide default for its calls to work.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { runtimePresets } from "../src/runtime-presets.ts";
import type { RuntimeOptions } from "../src/runtime.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

const space = signer.did();
const elsewhere = "did:key:z6MkElsewhereSpaceForTheLLMEndpointTest";

async function withRuntime(
  options: RuntimeOptions,
  body: (runtime: Runtime) => void,
): Promise<void> {
  const runtime = new Runtime(options);
  try {
    body(runtime);
  } finally {
    await runtime.dispose();
    await options.storageManager.close();
  }
}

describe("the LLM endpoint a Runtime gives a space", () => {
  it("is the deployment a remoteClient runtime talks to", async () => {
    await withRuntime(
      runtimePresets.remoteClient({
        apiUrl: new URL("http://toolshed.test:8022/"),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: { serverExecution: false },
      }),
      (runtime) => {
        expect(runtime.llmEndpointFor(space)?.href).toBe(
          "http://toolshed.test:8022/api/ai/llm",
        );
      },
    );
  });

  it("is the pattern-facing host, not the memory host, on a production server", async () => {
    await withRuntime(
      runtimePresets.productionServer({
        apiUrl: new URL("http://memory.test:9000/"),
        patternApiUrl: new URL("https://public.test/"),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: {},
      }),
      (runtime) => {
        expect(runtime.llmEndpointFor(space)?.href).toBe(
          "https://public.test/api/ai/llm",
        );
      },
    );
  });

  it("is a mapped space's own host", async () => {
    await withRuntime(
      {
        ...runtimePresets.remoteClient({
          apiUrl: new URL("http://toolshed.test:8022/"),
          storageManager: StorageManager.emulate({ as: signer }),
          experimental: { serverExecution: false },
        }),
        spaceHostMap: { [elsewhere]: "http://other.test:7000" },
      },
      (runtime) => {
        expect(runtime.llmEndpointFor(elsewhere)?.href).toBe(
          "http://other.test:7000/api/ai/llm",
        );
        expect(runtime.llmEndpointFor(space)?.href).toBe(
          "http://toolshed.test:8022/api/ai/llm",
        );
      },
    );
  });

  it("is left to the process default by a runtime whose host names no deployment", async () => {
    await withRuntime(
      {
        apiUrl: new URL("http://elsewhere.test:9/"),
        storageManager: StorageManager.emulate({ as: signer }),
      },
      (runtime) => {
        expect(runtime.llmEndpointFor(space)).toBeUndefined();
      },
    );
  });
});
