import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";

describe("browser-library", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("exports a client that connects to its sibling worker without starting the shell", async () => {
    const page = shell.page();
    await page.goto(new URL("/manifest.webmanifest", env.FRONTEND_URL).href);
    const result = await page.evaluate(async () => {
      const url = new URL("/scripts/shell-library.js", location.href).href;
      const library = await import(url);
      await import(new URL("/scripts/shell-components.js", location.href).href);
      const transport = await library.WebWorkerRuntimeTransport.connect({
        workerUrl: new URL("/scripts/worker-runtime.js", location.href),
      });
      await transport.dispose();
      return {
        client: typeof library.RuntimeClient.initialize,
        identity: typeof library.Identity.generate,
        encoder: typeof library.jsonFromFabricValue,
        credential: typeof library.createKeyFileCredential,
        unrelatedCredential: "clearStoredCredential" in library,
        unrelatedRuntime: "fetchBuildHash" in library,
        map: !!customElements.get("cf-map"),
        editor: !!customElements.get("cf-code-editor"),
        shellStarted: !!document.querySelector("cf-shell"),
      };
    });
    expect(result).toEqual({
      client: "function",
      identity: "function",
      encoder: "function",
      credential: "function",
      unrelatedCredential: false,
      unrelatedRuntime: false,
      map: true,
      editor: true,
      shellStarted: false,
    });
  });
});
