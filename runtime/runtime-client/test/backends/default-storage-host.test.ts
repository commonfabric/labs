/**
 * The memory URL inside the worker: the host Memory opens on for a space the
 * host map does not list, and the posture an attach is held to.
 *
 * `RuntimeProcessor.initialize` runs for real over emulated storage, with the
 * options it opened storage with recorded, so the cases turn on what the
 * worker asked storage for rather than on what a backend returns.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { Options as StorageOptions } from "@commonfabric/runner/storage/cache";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  RuntimeProcessor,
  securityContextFrom,
} from "@/backends/runtime-processor.ts";
import { type InitializationData, RequestType } from "@/protocol/mod.ts";
import { stubWorkerBoot } from "./stub-worker-boot.ts";

const signer = await Identity.fromPassphrase("default-storage-host-user");
const apiUrl = "http://default-storage-host.test/";
const memoryUrl = "http://router.default-storage-host.test/";

const base: InitializationData = {
  apiUrl,
  identity: signer.keyPair,
  spaceDid: signer.did(),
};

/**
 * Initializes a processor from `data`, hands it and the options storage was
 * opened with to `body`, and disposes it afterwards.
 */
async function withProcessor(
  data: InitializationData,
  body: (
    processor: RuntimeProcessor,
    storage: StorageOptions,
  ) => void | Promise<void>,
): Promise<void> {
  const openedWith: StorageOptions[] = [];
  const restore = stubWorkerBoot((options) => {
    openedWith.push(options);
    return StorageManager.emulate({ as: options.as });
  });
  let processor: RuntimeProcessor;
  try {
    processor = await RuntimeProcessor.initialize(data);
  } finally {
    restore();
  }
  try {
    expect(openedWith).toHaveLength(1);
    await body(processor, openedWith[0]);
  } finally {
    await processor.dispose();
  }
}

describe("default-storage-host", () => {
  describe("the host Memory opens on", () => {
    it("is the memory URL when the payload names one", async () => {
      await withProcessor({ ...base, memoryUrl }, (processor, storage) => {
        expect(storage.memoryHost.href).toBe(memoryUrl);
        // Only Memory moves: the runtime's HTTP work stays on the backend.
        const runtime = processor.accessForTestingOnly.runtime;
        expect(runtime.apiUrl.href).toBe(apiUrl);
        // The runtime holds it too, which is what keeps host hints from
        // moving Memory off it.
        expect(runtime.memoryUrl?.href).toBe(memoryUrl);
      });
    });

    it("is the backend when the payload names none", async () => {
      await withProcessor(base, (_processor, storage) => {
        expect(storage.memoryHost.href).toBe(apiUrl);
      });
    });

    it("is the backend when the memory URL is empty", async () => {
      // An empty value names no host.
      await withProcessor({ ...base, memoryUrl: "" }, (_processor, storage) => {
        expect(storage.memoryHost.href).toBe(apiUrl);
      });
    });

    it("is the backend, path and all, when the backend's URL has a path and the payload names no other host", async () => {
      // The runtime is handed the host storage opened on. Here that is the
      // backend's own URL, path included, which names the backend and is no
      // memory URL rather than one refused for its path.
      const pathful = `${apiUrl}fabric/`;
      for (const memory of [undefined, apiUrl]) {
        await withProcessor(
          { ...base, apiUrl: pathful, memoryUrl: memory },
          (processor, storage) => {
            expect(storage.memoryHost.href).toBe(pathful);
            const runtime = processor.accessForTestingOnly.runtime;
            expect(runtime.apiUrl.href).toBe(pathful);
            expect(runtime.memoryUrl).toBeUndefined();
          },
        );
      }
    });

    it("refuses a memory URL that is not an HTTP or HTTPS origin", async () => {
      const restore = stubWorkerBoot((options) =>
        StorageManager.emulate({ as: options.as })
      );
      try {
        await expect(
          RuntimeProcessor.initialize({
            ...base,
            memoryUrl: "http://router.default-storage-host.test/api",
          }),
        ).rejects.toThrow(
          'Invalid memoryUrl "http://router.default-storage-host.test/api"',
        );
      } finally {
        restore();
      }
    });
  });

  describe("a host hint over IPC", () => {
    const space = "did:key:z6Mk-ipc-hinted";
    const ask = async (processor: RuntimeProcessor, host: string) =>
      (await processor.handleRegisterSpaceHostDetailed({
        type: RequestType.RegisterSpaceHostDetailed,
        space,
        host,
      })).registration;

    /**
     * Stubs the global `fetch` to answer `/api/meta` on each origin of
     * `answers` with its document, or with a status and no document, counting
     * the reads, until disposed.
     */
    const metaAnswering = (
      answers: Record<string, Record<string, unknown> | number>,
    ) => {
      const reads: string[] = [];
      const fetch = stub(
        globalThis,
        "fetch",
        (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          reads.push(url.href);
          expect(url.pathname).toBe("/api/meta");
          const answer = answers[url.origin];
          expect(answer).toBeDefined();
          return Promise.resolve(
            typeof answer === "number"
              ? new Response(null, { status: answer })
              : new Response(JSON.stringify(answer), {
                headers: { "content-type": "application/json" },
              }),
          );
        },
      );
      return { reads, [Symbol.dispose]: () => fetch.restore() };
    };

    it("cannot move Memory off the memory URL for this deployment's own origins", async () => {
      // The processor passes no `fetch` to its runtime, so a read would go
      // through the global one; neither of these hints makes one.
      using fetch = stub(globalThis, "fetch");
      await withProcessor({ ...base, memoryUrl }, async (processor) => {
        // The backend's own origin and the memory URL are the default route.
        for (const host of [apiUrl, memoryUrl]) {
          expect(await ask(processor, host)).toEqual({ accepted: true });
          expect(
            await processor.handleRegisterSpaceHost({
              type: RequestType.RegisterSpaceHost,
              space,
              host,
            }),
          ).toEqual({ value: true });
        }
        expect(
          processor.accessForTestingOnly.runtime.mappedHostFor(space),
        ).toBeUndefined();
        expect(fetch.calls.length).toBe(0);
      });
    });

    it("decides a hint naming another deployment once that deployment's memory host is read", async () => {
      // Emulated storage takes no hints, so a hint that gets as far as
      // storage is refused there as `no-remote-resolution`: the read was made
      // and the hint was offered, which is what this checks.
      using meta = metaAnswering({
        "http://third.test": { memoryUrl: "http://router.third.test/" },
        "http://fourth.test": 500,
      });
      await withProcessor({ ...base, memoryUrl }, async (processor) => {
        expect(await ask(processor, "http://third.test/")).toEqual({
          accepted: false,
          reason: "no-remote-resolution",
        });
        expect(meta.reads).toEqual(["http://third.test/api/meta"]);
        // A hint whose read failed is refused before storage.
        using _warn = stub(console, "warn");
        expect(await ask(processor, "http://fourth.test/")).toEqual({
          accepted: false,
          reason: "foreign-host-unread",
        });
        expect(
          await processor.handleRegisterSpaceHost({
            type: RequestType.RegisterSpaceHost,
            space,
            host: "http://fourth.test/",
          }),
        ).toEqual({ value: false });
        expect(_warn.calls.length).toBe(1);
      });
    });

    it("is storage's to decide without one", async () => {
      // Emulated storage takes no hints, so the refusal comes from storage,
      // not from the memory URL rule.
      using fetch = stub(globalThis, "fetch");
      await withProcessor(base, async (processor) => {
        for (const host of [apiUrl, "http://third.test/"]) {
          expect(await ask(processor, host)).toEqual({
            accepted: false,
            reason: "no-remote-resolution",
          });
        }
        expect(fetch.calls.length).toBe(0);
      });
    });
  });

  describe("the posture an attach is held to", () => {
    it("records the memory URL in the runtime's security context", () => {
      expect(
        securityContextFrom(
          { ...base, memoryUrl: "http://Router.test" },
          signer.did(),
        )
          .memoryUrl,
      ).toBe("http://router.test/");
    });

    it("admits an attach asserting the runtime's memory URL", async () => {
      await withProcessor({ ...base, memoryUrl }, (processor) => {
        expect(() =>
          processor.assertAttachable(
            securityContextFrom({ ...base, memoryUrl }, signer.did()),
          )
        ).not.toThrow();
      });
    });

    it("refuses an attach asserting a different memory URL", async () => {
      await withProcessor({ ...base, memoryUrl }, (processor) => {
        expect(() =>
          processor.assertAttachable(
            securityContextFrom(
              { ...base, memoryUrl: "http://other-router.test/" },
              signer.did(),
            ),
          )
        ).toThrow(
          "Attach refused: the asserted security context differs " +
            "from the runtime's at `memoryUrl`.",
        );
      });
    });

    it("refuses an attach asserting no memory URL to a runtime that has one", async () => {
      await withProcessor({ ...base, memoryUrl }, (processor) => {
        expect(() =>
          processor.assertAttachable(securityContextFrom(base, signer.did()))
        ).toThrow("`memoryUrl`");
      });
    });

    it("admits an attach asserting no memory URL to a runtime whose memory URL is the backend", async () => {
      await withProcessor(
        { ...base, memoryUrl: "http://default-storage-host.test" },
        (processor) => {
          expect(() =>
            processor.assertAttachable(securityContextFrom(base, signer.did()))
          ).not.toThrow();
        },
      );
    });
  });
});
