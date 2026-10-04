import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime, SpaceHostValidationError } from "@commonfabric/runner";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runtime-host-for-space");
const spaceA = signer.did();
const spaceB = "did:key:z6Mk-host-for-space-b" as MemorySpace;

function makeRuntime(spaceHostMap?: Record<string, string>) {
  const storageManager = StorageManager.emulate({ as: signer });
  return new Runtime({
    apiUrl: new URL("http://host-a.test/"),
    spaceHostMap,
    storageManager,
  });
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

function expectSafeValidationCause(
  error: Error,
  secret: string,
  message: string,
): void {
  expect(error.message).not.toContain(secret);
  expect(error.cause).toBeInstanceOf(SpaceHostValidationError);
  expect((error.cause as Error).message).toBe(message);
  expect((error.cause as Error).message).not.toContain(secret);
}

describe("Runtime.registerSpaceHost", () => {
  it("follows storage's verdict and routes compute on acceptance", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return host !== "http://refused.test/";
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
      // Storage refusal ⇒ compute routing must NOT diverge.
      const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
      expect(runtime.registerSpaceHost(spaceC, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceC)).toBeUndefined();
      expect(storageVerdicts.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns false when the manager has no remote resolution", async () => {
    const runtime = makeRuntime();
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  describe("registerSpaceHostDetailed()", () => {
    it("returns storage's refusal and routes compute only on acceptance", async () => {
      const storageManager = Object.assign(
        StorageManager.emulate({ as: signer }),
        {
          registerSpaceHostDetailed(_space: string, host: string) {
            if (host === "http://pinned.test/") {
              return {
                accepted: false,
                reason: "default-route-in-use",
              } as const;
            }
            if (host === "http://other.test/") {
              return {
                accepted: false,
                reason: "known-different-host",
                existingHost: "http://host-b.test/",
              } as const;
            }
            return { accepted: true } as const;
          },
        },
      );
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager,
      });
      try {
        const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
        expect(runtime.registerSpaceHostDetailed(spaceC, "http://pinned.test"))
          .toEqual({ accepted: false, reason: "default-route-in-use" });
        expect(runtime.mappedHostFor(spaceC)).toBeUndefined();

        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test"))
          .toEqual({ accepted: true });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");

        expect(runtime.registerSpaceHostDetailed(spaceB, "http://other.test"))
          .toEqual({
            accepted: false,
            reason: "known-different-host",
            existingHost: "http://host-b.test/",
          });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      } finally {
        await runtime.dispose();
      }
    });

    it("returns `no-remote-resolution` from an emulated manager", async () => {
      const runtime = makeRuntime();
      try {
        expect(
          runtime.storageManager.registerSpaceHostDetailed?.(
            spaceB,
            "http://host-b.test/",
          ),
        ).toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("returns `unspecified` for a refusal by a manager that gives only a verdict", async () => {
      const storageManager = Object.assign(
        StorageManager.emulate({ as: signer }),
        {
          registerSpaceHostDetailed: undefined,
          registerSpaceHost(_space: string, host: string) {
            return host !== "http://refused.test/";
          },
        },
      );
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager,
      });
      try {
        expect(
          runtime.registerSpaceHostDetailed(spaceB, "http://refused.test/"),
        ).toEqual({ accepted: false, reason: "unspecified" });
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: true });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      } finally {
        await runtime.dispose();
      }
    });

    it("returns `no-remote-resolution` when the manager takes no hints", async () => {
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager: Object.assign(StorageManager.emulate({ as: signer }), {
          registerSpaceHostDetailed: undefined,
          registerSpaceHost: undefined,
        }),
      });
      try {
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
          .toBe(false);
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("throws on a host that is not an origin, naming the space", async () => {
      const runtime = makeRuntime();
      try {
        expect(() =>
          runtime.registerSpaceHostDetailed(spaceB, "https://host-b.test/api")
        ).toThrow(`Invalid host for space ${spaceB}`);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("takes the verdict of a manager that gives only a registration", async () => {
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost: undefined,
        registerSpaceHostDetailed(_space: string, host: string) {
          return host === "http://refused.test/"
            ? { accepted: false, reason: "default-route-in-use" } as const
            : { accepted: true } as const;
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects non-origin hints before forwarding them to storage", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return true;
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      for (
        const host of [
          "ws://host-b.test",
          "wss://host-b.test",
          "ftp://host-b.test",
          "https://user@host-b.test/",
          "https://host-b.test/api",
          "https://host-b.test/api/..",
          "https://host-b.test/?region=west",
          "https://host-b.test/#primary",
        ]
      ) {
        expect(() => runtime.registerSpaceHost(spaceB, host))
          .toThrow(`Invalid host for space ${spaceB}`);
      }
      expect(storageVerdicts).toEqual([]);

      expect(runtime.registerSpaceHost(spaceB, "https://host-b.test"))
        .toBe(true);
      expect(storageVerdicts).toEqual([
        [spaceB, "https://host-b.test/"],
      ]);
      expect(runtime.mappedHostFor(spaceB)).toBe("https://host-b.test/");
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves safe validation causes without repeating route secrets", async () => {
    const hosts = [
      [
        "https://user:route-password-sentinel@host-b.test/",
        "route-password-sentinel",
        "Space host must not include credentials",
      ],
      [
        "https://host-b.test/?token=route-query-sentinel",
        "route-query-sentinel",
        "Space host must not include a query",
      ],
      [
        "https://user:route-parse-password-sentinel@[/",
        "route-parse-password-sentinel",
        "Invalid space host URL",
      ],
    ] as const;
    const runtime = makeRuntime();
    try {
      for (const [host, secret, message] of hosts) {
        const error = captureError(() =>
          runtime.registerSpaceHost(spaceB, host)
        );
        expectSafeValidationCause(error, secret, message);
      }
    } finally {
      await runtime.dispose();
    }

    for (const [host, secret, message] of hosts) {
      const error = captureError(() => makeRuntime({ [spaceB]: host }));
      expectSafeValidationCause(error, secret, message);
    }
  });
});

describe("Runtime.hostForSpace", () => {
  it("rejects seeded hosts that cannot serve HTTP requests", () => {
    for (
      const host of [
        "ws://host-b.test",
        "wss://host-b.test",
        "ftp://host-b.test",
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/%2e%2e/",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => makeRuntime({ [spaceB]: host }))
        .toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
    }
  });

  it("resolves mapped spaces to their host and others to apiUrl", async () => {
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.hostForSpace(spaceA).toString()).toBe(
        "http://host-a.test/",
      );
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("healthCheck fans out over the default and every mapped host", async () => {
    const dialed: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      dialed.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const runtime = makeRuntime({
      [spaceB]: "http://host-b.test",
      "did:key:z6Mk-host-for-space-c": "http://host-b.test", // dupe host
    });
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(dialed.sort()).toEqual([
        "http://host-a.test/_health",
        "http://host-b.test/_health",
      ]);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck captures the default host's gitSha header; other hosts don't overwrite it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const sha = String(input).startsWith("http://host-a.test")
        ? "  abc123  "
        : "not-the-default-host";
      return Promise.resolve(
        new Response("ok", {
          status: 200,
          headers: { "x-cf-git-sha": sha },
        }),
      );
    }) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.serverGitSha).toBe(null);
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck reports null gitSha without the header, and resets a stale capture", async () => {
    const realFetch = globalThis.fetch;
    let headers: Record<string, string> = { "x-cf-git-sha": "abc123" };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("ok", { status: 200, headers }),
      )) as typeof fetch;
    const runtime = makeRuntime();
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
      // An older server without the header must reset the capture.
      headers = {};
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe(null);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck completes at headers-arrival: an open body stream cannot gate it", async () => {
    const realFetch = globalThis.fetch;
    // A 200 whose body stream never closes. The capture reads only headers,
    // so health must resolve; awaiting the body would hang forever.
    const openBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"OK"'));
        // never closed
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(openBody, {
          status: 200,
          headers: { "x-cf-git-sha": "abc123" },
        }),
      )) as typeof fetch;
    const runtime = makeRuntime();
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
    } finally {
      globalThis.fetch = realFetch;
      await openBody.cancel();
      await runtime.dispose();
    }
  });

  it("an overdue earlier healthCheck cannot overwrite a newer call's capture", async () => {
    const realFetch = globalThis.fetch;
    const gate: Array<(res: Response) => void> = [];
    const responseWith = (sha: string) =>
      new Response("ok", { status: 200, headers: { "x-cf-git-sha": sha } });
    let call = 0;
    globalThis.fetch = (() => {
      call++;
      if (call === 1) {
        // First call's response is withheld until released below.
        return new Promise<Response>((resolve) => {
          gate.push(resolve);
        });
      }
      return Promise.resolve(responseWith("second"));
    }) as typeof fetch;
    const runtime = makeRuntime();
    try {
      const first = runtime.healthCheck();
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("second");
      gate[0]!(responseWith("first"));
      expect(await first).toBe(true);
      // The stale response arrived last but belongs to a superseded call.
      expect(runtime.serverGitSha).toBe("second");
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck is false when any host is unreachable", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response("", {
          status: String(input).includes("host-b") ? 500 : 200,
        }),
      )) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(await runtime.healthCheck()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck forwards cancellation to its requests", async () => {
    const realFetch = globalThis.fetch;
    const controller = new AbortController();
    const reason = new Error("health check canceled");
    const receivedSignals: Array<AbortSignal | null> = [];
    let requestCount = 0;
    let requestEntered!: () => void;
    const requestsStarted = new Promise<void>((resolve) => {
      requestEntered = () => {
        requestCount++;
        if (requestCount === 2) resolve();
      };
    });
    const rejectRequests: Array<(reason?: unknown) => void> = [];
    let runtime: ReturnType<typeof makeRuntime> | undefined;
    let check: Promise<boolean> | undefined;
    try {
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? null;
        receivedSignals.push(signal);
        requestEntered();
        return new Promise<Response>((_resolve, reject) => {
          rejectRequests.push(reject);
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }) as typeof fetch;
      runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
      check = runtime.healthCheck(controller.signal);
      const requestState = await Promise.race([
        requestsStarted.then(() => "started" as const),
        check.then(
          () => "completed" as const,
          () => "completed" as const,
        ),
      ]);
      expect(requestState).toBe("started");
      expect(receivedSignals).toEqual([
        controller.signal,
        controller.signal,
      ]);
      controller.abort(reason);
      await expect(check).rejects.toBe(reason);
    } finally {
      controller.abort(reason);
      for (const rejectRequest of rejectRequests) rejectRequest(reason);
      await check?.catch(() => {});
      globalThis.fetch = realFetch;
      await runtime?.dispose();
    }
  });
});
