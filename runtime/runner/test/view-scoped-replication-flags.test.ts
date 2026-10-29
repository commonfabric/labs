import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  adoptServerExperimentalOptions,
  experimentalOptionsFromEnv,
  parseServerExperimentalOptions,
  runtimePresets,
} from "../src/runtime-presets.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("view-scoped replication flags", () => {
  it("publishes and adopts the global default and web override independently", () => {
    const env: Record<string, string> = {
      EXPERIMENTAL_VIEW_SCOPED_REPLICATION: "true",
      EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION: "false",
    };
    const declared = experimentalOptionsFromEnv((key) => env[key]);
    expect(declared.viewScopedReplication).toBe(true);
    expect(declared.webViewScopedReplication).toBe(false);
    expect(adoptServerExperimentalOptions(
      parseServerExperimentalOptions(declared),
      {},
    )).toMatchObject({ ...declared });
  });

  for (
    const arm of [
      { global: undefined, web: undefined, server: true, enabled: false },
      { global: false, web: true, server: true, enabled: true },
      { global: true, web: false, server: true, enabled: false },
      { global: true, web: undefined, server: true, enabled: true },
      { global: true, web: true, server: false, enabled: false },
    ]
  ) {
    it(`resolves the web request ${JSON.stringify(arm)}`, async () => {
      const as = await Identity.fromPassphrase("view flags");
      const storageManager = StorageManager.emulate({ as });
      const runtime = new Runtime(runtimePresets.browserWorker({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: {
          serverExecution: arm.server,
          viewScopedReplication: arm.global,
          webViewScopedReplication: arm.web,
        },
      }));
      try {
        expect(runtime.viewScopedReplicationRequested).toBe(arm.enabled);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  }

  it("keeps unsupported client classes on ordinary replication", async () => {
    const as = await Identity.fromPassphrase("unsupported view client");
    const storageManager = StorageManager.emulate({ as });
    const runtime = new Runtime(runtimePresets.remoteClient({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true, viewScopedReplication: true },
    }));
    try {
      expect(runtime.viewScopedReplicationRequested).toBe(false);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
