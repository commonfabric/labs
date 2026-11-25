// A host that runs patterns in its own process (a deployed client with server
// execution off) sends their model calls to the deployment its runtime talks
// to. The runtime sets that endpoint where it sets the deployment patterns
// fetch against, so no host has to remember a second call to do it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLLMUrl, setLLMUrl } from "@commonfabric/llm";
import { runtimePresets } from "../src/runtime-presets.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

describe("the LLM endpoint a Runtime sets", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = getLLMUrl();
    setLLMUrl("http://earlier.test:1");
  });
  afterEach(() => {
    if (before !== undefined) setLLMUrl(before);
  });

  it("is the deployment a remoteClient runtime talks to", async () => {
    const options = runtimePresets.remoteClient({
      apiUrl: new URL("http://toolshed.test:8022/"),
      storageManager: StorageManager.emulate({ as: signer }),
      experimental: { serverExecution: false },
    });
    const runtime = new Runtime(options);
    try {
      expect(getLLMUrl()).toBe("http://toolshed.test:8022/api/ai/llm");
    } finally {
      await runtime.dispose();
      await options.storageManager.close();
    }
  });

  it("is left as it was by a runtime whose host names no deployment", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://elsewhere.test:9/"),
      storageManager,
    });
    try {
      expect(getLLMUrl()).toBe("http://earlier.test:1/api/ai/llm");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
