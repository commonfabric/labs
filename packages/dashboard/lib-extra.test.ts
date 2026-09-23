/**
 * Unit tests for the helpers lib.test.ts does not reach: the GitHub API
 * wrapper, the artifact lookup over it, and the memo cache. No real network —
 * fetch is stubbed and restored, and the lookup is handed a fake caller.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  friendlyError,
  github,
  githubDownload,
  githubOperationsInProgress,
  memo,
  performanceGithub,
  runArtifactId,
} from "./lib.ts";
import { performanceGitHubRateLimit } from "./github-rate-limit.ts";

// Run `fn` with fetch replaced by `stub`, handing `fn` the calls made so far.
async function withFetch(
  stub: (url: string) => Response | Promise<Response>,
  fn: (calls: { url: string; init: RequestInit }[]) => Promise<void>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(stub(url));
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function captureConsole(
  level: "error" | "warn",
  fn: (messages: string[]) => Promise<void>,
) {
  const original = console[level];
  const messages: string[] = [];
  console[level] = (...parts: unknown[]) =>
    messages.push(parts.map(String).join(" "));
  try {
    await fn(messages);
  } finally {
    console[level] = original;
  }
}

// Run `fn` with the token vars set as given; a key left out is unset for the
// duration. Whatever the process had is put back.
async function withTokens(env: Record<string, string>, fn: () => Promise<void>) {
  const keys = ["GH_TOKEN", "GITHUB_TOKEN"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  const apply = (k: string, v: string | undefined) => v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  try {
    for (const k of keys) apply(k, env[k]);
    await fn();
  } finally {
    for (const [k, v] of saved) apply(k, v);
  }
}

const auth = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).authorization;

Deno.test("github: no token -> a 'set GH_TOKEN' error, and no request is attempted", async () => {
  await withTokens({}, async () => {
    await withFetch(() => Response.json({}), async (calls) => {
      const e = await assertRejects(() => github("repos/o/r"), Error);
      assertEquals(e.message, "GitHub API repos/o/r: set GH_TOKEN or GITHUB_TOKEN");
      assertEquals(calls.length, 0);
      // The message is one friendlyError recognizes, so a token-gated tile grays
      // out with "set GH_TOKEN" rather than "temporarily unavailable".
      assertEquals(friendlyError(e.message), "set GH_TOKEN");
    });
  });
});

Deno.test("github: non-OK -> throws with the status; the error body is not returned as data", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await withFetch(() => Response.json({ message: "Not Found" }, { status: 404 }), async () => {
      const e = await assertRejects(() => github("repos/o/missing"), Error);
      assertEquals(e.message, "GitHub API repos/o/missing failed: HTTP 404");
      assertEquals(friendlyError(e.message), "not found");
    });
    await withFetch(() => Response.json({}, { status: 429 }), async () => {
      const e = await assertRejects(() => github("rate/limited"), Error);
      assertEquals(e.message, "GitHub API rate/limited failed: HTTP 429");
      assertEquals(friendlyError(e.message), "rate limit hit");
    });
    await withFetch(
      () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
      async () => {
        const e = await assertRejects(() => github("rate/limited"), Error);
        assertEquals(
          e.message,
          "GitHub API rate/limited failed: HTTP 403 (rate-limited)",
        );
        assertEquals(friendlyError(e.message), "rate limit hit");
      },
    );
  });
});

Deno.test("github: an HTTP failure logs the endpoint and GitHub response context", async () => {
  await withTokens({ GH_TOKEN: "secret-token" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () =>
          Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-github-request-id": "request-123",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1787100000",
                "retry-after": "60",
              },
            },
          ),
        async () => {
          await assertRejects(() => github("repos/o/runs?per_page=100"), Error);
        },
      );
      assertEquals(messages.length, 1);
      assert(messages[0].includes("GitHub API operation"));
      assert(messages[0].includes("repos/o/runs?per_page=100"));
      assert(messages[0].includes("HTTP 403"));
      assert(messages[0].includes("request request-123"));
      assert(messages[0].includes("rate limit 0 remaining of 5000"));
      assert(messages[0].includes("retry after 60"));
      assert(messages[0].includes("API rate limit exceeded"));
      assert(!messages[0].includes("secret-token"));
    });
  });
});

Deno.test("github: response header details are bounded and single-line", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      const unsafe = `request-\x1b[31m${"x".repeat(500)}`;
      await withFetch(
        () =>
          new Response("unavailable", {
            status: 503,
            headers: { "x-github-request-id": unsafe },
          }),
        async () => {
          await assertRejects(() => github("repos/o/runs"), Error);
        },
      );
      assertEquals(messages.length, 1);
      assert([...messages[0]].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && (code < 127 || code > 159);
      }));
      assert(messages[0].length < 500);
    });
  });
});

Deno.test("github: a request failure logs its endpoint, stage, and elapsed time", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () => Promise.reject(new TypeError("connection closed")),
        async () => {
          await assertRejects(() => github("repos/o/runs"), TypeError);
        },
      );
      assertEquals(messages.length, 1);
      assert(messages[0].includes("for repos/o/runs failed after"));
      assert(messages[0].includes("while requesting GitHub"));
      assert(messages[0].includes("TypeError: connection closed"));
      assertEquals(githubOperationsInProgress(), []);
    });
  });
});

Deno.test("github: request failure details are bounded and single-line", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      const unsafe = `connection\nclosed\x1b[31m${"x".repeat(500)}`;
      await withFetch(
        () => Promise.reject(new TypeError(unsafe)),
        async () => {
          await assertRejects(() => github("repos/o/runs"), TypeError);
        },
      );
      assertEquals(messages.length, 1);
      assert([...messages[0]].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && (code < 127 || code > 159);
      }));
      assert(messages[0].length < 500);
    });
  });
});

Deno.test("github: unreadable JSON logs the endpoint and response context", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () =>
          new Response("not json", {
            headers: { "x-github-request-id": "invalid-123" },
          }),
        async () => {
          await assertRejects(() => github("repos/o/invalid"), SyntaxError);
        },
      );
      assertEquals(messages.length, 1);
      assert(messages[0].includes("for repos/o/invalid could not read valid JSON"));
      assert(messages[0].includes("HTTP 200, request invalid-123"));
      assert(messages[0].includes("SyntaxError"));
    });
  });
});

Deno.test("github: a failed error body preserves the known HTTP failure", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("body connection closed"));
              },
            }),
            { status: 403 },
          ),
        async () => {
          const error = await assertRejects(
            () => github("repos/o/broken-error"),
            Error,
          );
          assertEquals(
            error.message,
            "GitHub API repos/o/broken-error failed: HTTP 403",
          );
          assertEquals(friendlyError(error.message), "auth failed");
        },
      );
      assertEquals(messages.length, 2);
      assert(messages[0].includes("could not read the error response"));
      assert(messages[0].includes("body connection closed"));
      assert(messages[1].includes("returned HTTP 403"));
    });
  });
});

Deno.test("github: a large error keeps a bounded prefix and cancels the body", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      let sent = false;
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return;
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(`useful detail ${"x".repeat(10_000)}`),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      );
      await withFetch(
        () => response,
        async () => {
          await assertRejects(() => github("repos/o/error"), Error);
        },
      );
      assert(cancelled);
      assertEquals(messages.length, 1);
      assert(messages[0].includes("useful detail"));
      assert(messages[0].length < 500);
    });
  });
});

Deno.test("github: error response reader setup and cancellation failures are logged", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      const unreadable = {
        ok: false,
        status: 500,
        headers: new Headers(),
        body: {
          getReader() {
            throw new Error("reader setup failed");
          },
        },
      } as unknown as Response;
      await withFetch(
        () => unreadable,
        async () => {
          await assertRejects(() => github("repos/o/unreadable-error"), Error);
        },
      );
      assertEquals(messages.length, 2);
      assert(messages[0].includes("could not read the error response"));
      assert(messages[0].includes("reader setup failed"));

      const uncancellable = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5_000));
          },
          cancel() {
            throw new Error("reader cancellation failed");
          },
        }),
        { status: 500 },
      );
      await withFetch(
        () => uncancellable,
        async () => {
          await assertRejects(
            () => github("repos/o/uncancellable-error"),
            Error,
          );
        },
      );
      assertEquals(messages.length, 4);
      assert(messages[2].includes("could not stop reading the error response"));
      assert(messages[2].includes("reader cancellation failed"));
    });
  });
});

Deno.test("github: an ignored status does not hide transport failures", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () => new Response("missing", { status: 404 }),
        async () => {
          await assertRejects(
            () =>
              github("repos/o/optional", undefined, {
                ignoreStatuses: [404],
              }),
            Error,
          );
        },
      );
      assertEquals(messages, []);
      await withFetch(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("body connection closed"));
              },
            }),
            { status: 404 },
          ),
        async () => {
          await assertRejects(
            () =>
              github("repos/o/optional", undefined, {
                ignoreStatuses: [404],
              }),
            Error,
          );
        },
      );
      assertEquals(messages.length, 1);
      assert(messages[0].includes("body connection closed"));
      await withFetch(
        () => Promise.reject(new TypeError("connection closed")),
        async () => {
          await assertRejects(
            () =>
              github("repos/o/optional", undefined, {
                ignoreStatuses: [404],
              }),
            TypeError,
          );
        },
      );
      assertEquals(messages.length, 2);
      assert(messages[1].includes("TypeError: connection closed"));
    });
  });
});

Deno.test("github: an in-progress request reports what it is waiting on", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    let requestStarted = () => {};
    const started = new Promise<void>((resolve) => requestStarted = resolve);
    let finishRequest = (_response: Response) => {};
    const response = new Promise<Response>((resolve) => finishRequest = resolve);
    await withFetch(
      () => {
        requestStarted();
        return response;
      },
      async () => {
        const pending = github("repos/o/actions/runs?branch=main");
        await started;
        const operations = githubOperationsInProgress();
        assertEquals(operations.length, 1);
        assertEquals(operations[0].path, "repos/o/actions/runs?branch=main");
        assertEquals(operations[0].stage, "requesting GitHub");
        assert(operations[0].elapsedMs >= 0);
        finishRequest(Response.json({ workflow_runs: [] }));
        await pending;
        assertEquals(githubOperationsInProgress(), []);
      },
    );
  });
});

Deno.test("github: JSON stays active while its response body is read", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyRead = () => {};
    const reading = new Promise<void>((resolve) => bodyRead = resolve);
    let finishPull = () => {};
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      pull() {
        bodyRead();
        return new Promise<void>((resolve) => finishPull = resolve);
      },
    }));
    await withFetch(
      () => response,
      async () => {
        const pending = github("repos/o/actions/runs?branch=main");
        await reading;
        const operations = githubOperationsInProgress();
        assertEquals(operations.length, 1);
        assertEquals(operations[0].stage, "reading GitHub response");
        bodyController!.enqueue(new TextEncoder().encode('{"workflow_runs":[]}'));
        bodyController!.close();
        finishPull();
        assertEquals(await pending, { workflow_runs: [] });
        assertEquals(githubOperationsInProgress(), []);
      },
    );
  });
});

Deno.test("github: a download stays active while its response body is read", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyRead = () => {};
    const reading = new Promise<void>((resolve) => bodyRead = resolve);
    let finishPull = () => {};
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      pull() {
        bodyRead();
        return new Promise<void>((resolve) => finishPull = resolve);
      },
    }));
    await withFetch(
      () => response,
      async () => {
        const pending = githubDownload("repos/o/archive");
        await reading;
        const operations = githubOperationsInProgress();
        assertEquals(operations.length, 1);
        assertEquals(operations[0].path, "repos/o/archive");
        assertEquals(operations[0].stage, "reading GitHub response");
        bodyController!.enqueue(new TextEncoder().encode("archive"));
        bodyController!.close();
        finishPull();
        const download = await pending;
        assertEquals(new TextDecoder().decode(download.body), "archive");
        assertEquals(githubOperationsInProgress(), []);
      },
    );
  });
});

Deno.test("github: an abandoned download has already completed its body", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    const response = new Response("archive");
    await withFetch(
      () => response,
      async () => {
        const download = await githubDownload("repos/o/archive");
        assertEquals(githubOperationsInProgress(), []);
        assertEquals(new TextDecoder().decode(download.body), "archive");
      },
    );
  });
});

Deno.test("github: a failed download cancels its body and logs response context", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      const response = Response.json(
        { message: "artifact expired" },
        {
          status: 410,
          headers: { "x-github-request-id": "download-123" },
        },
      );
      await withFetch(
        () => response,
        async () => {
          const download = await githubDownload(
            "repos/o/actions/artifacts/1/zip",
          );
          assertEquals(download, {
            ok: false,
            status: 410,
            body: new Uint8Array(),
          });
        },
      );
      assert(response.bodyUsed);
      assertEquals(messages.length, 1);
      assert(
        messages[0].includes("for download repos/o/actions/artifacts/1/zip"),
      );
      assert(messages[0].includes("HTTP 410, request download-123"));
      assert(!messages[0].includes("artifact expired"));
    });
  });
});

Deno.test("github: a failed download does not wait for body cleanup", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("short detail"),
            );
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        { status: 500 },
      );
      await withFetch(
        () => response,
        async () => {
          const download = await githubDownload("repos/o/actions/artifacts/1/zip");
          assertEquals(download.status, 500);
        },
      );
      assert(cancelled);
      assertEquals(messages.length, 1);
      assert(!messages[0].includes("short detail"));
    });
  });
});

Deno.test("github: download response edge cases finish or log their operation", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      await withFetch(
        () => new Response(null, { status: 500 }),
        async () => {
          const download = await githubDownload("repos/o/no-error-body");
          assertEquals(download.status, 500);
        },
      );

      const cancellationThrows = {
        ok: false,
        status: 500,
        headers: new Headers(),
        body: {
          cancel() {
            throw new Error("synchronous cancellation failure");
          },
        },
      } as unknown as Response;
      await withFetch(
        () => cancellationThrows,
        async () => {
          const download = await githubDownload("repos/o/cancellation-throws");
          assertEquals(download.status, 500);
        },
      );
      assert(
        messages.some((message) =>
          message.includes("synchronous cancellation failure")
        ),
      );

      await withFetch(
        () => new Response(null, { status: 204 }),
        async () => {
          assertEquals(await githubDownload("repos/o/empty-download"), {
            ok: true,
            status: 204,
            body: new Uint8Array(),
          });
        },
      );

      const unreadable = {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {},
        arrayBuffer() {
          return Promise.reject(new Error("download body failed"));
        },
      } as unknown as Response;
      await withFetch(
        () => unreadable,
        async () => {
          await assertRejects(
            () => githubDownload("repos/o/unreadable-download"),
            Error,
            "download body failed",
          );
        },
      );
      assert(
        messages.some((message) => message.includes("download body failed")),
      );
      assertEquals(githubOperationsInProgress(), []);
    });
  });
});

Deno.test("github: performance reservation completion failures are logged", async () => {
  const originalReserve = performanceGitHubRateLimit.reserve;
  performanceGitHubRateLimit.reserve = () =>
    Promise.resolve({
      complete: () =>
        Promise.reject(new Error("reservation completion failed")),
    });
  try {
    await withTokens({ GH_TOKEN: "t" }, async () => {
      await captureConsole("error", async (messages) => {
        await withFetch(
          () => Response.json({ ok: true }),
          async () => {
            await assertRejects(
              () => performanceGithub("repos/o/performance"),
              Error,
              "reservation completion failed",
            );
          },
        );
        assertEquals(messages.length, 1);
        assert(messages[0].includes("while recording performance-request use"));
        assert(messages[0].includes("reservation completion failed"));
        assertEquals(githubOperationsInProgress(), []);
      });
    });
  } finally {
    performanceGitHubRateLimit.reserve = originalReserve;
  }
});

Deno.test("github: an ignored download status does not hide cleanup or transport failures", async () => {
  await withTokens({ GH_TOKEN: "t" }, async () => {
    await captureConsole("error", async (messages) => {
      const response = new Response("missing", { status: 404 });
      await withFetch(
        () => response,
        async () => {
          const download = await githubDownload(
            "repos/o/actions/artifacts/1/zip",
            undefined,
            { ignoreStatuses: [404] },
          );
          assertEquals(download.status, 404);
          assertEquals(download.ok, false);
        },
      );
      assert(response.bodyUsed);
      assertEquals(messages, []);
      await withFetch(
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                return Promise.reject(new Error("body cancellation failed"));
              },
            }),
            { status: 404 },
          ),
        async () => {
          const download = await githubDownload(
            "repos/o/actions/artifacts/1/zip",
            undefined,
            { ignoreStatuses: [404] },
          );
          assertEquals(download.status, 404);
        },
      );
      await Promise.resolve();
      assertEquals(messages.length, 1);
      assert(messages[0].includes("body cancellation failed"));
      await withFetch(
        () => Promise.reject(new TypeError("connection closed")),
        async () => {
          await assertRejects(
            () =>
              githubDownload(
                "repos/o/actions/artifacts/1/zip",
                undefined,
                { ignoreStatuses: [404] },
              ),
            TypeError,
          );
        },
      );
      assertEquals(messages.length, 2);
      assert(messages[1].includes("TypeError: connection closed"));
    });
  });
});

Deno.test("github: a slow successful operation logs response context", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await withTokens({ GH_TOKEN: "t" }, async () => {
      await captureConsole("warn", async (messages) => {
        await withFetch(
          () => {
            now += 10_000;
            return Response.json(
              { ok: true },
              { headers: { "x-github-request-id": "slow-123" } },
            );
          },
          async () => {
            await github("repos/o/slow");
          },
        );
        assertEquals(messages.length, 1);
        assert(messages[0].includes("for repos/o/slow completed slowly after 10000 ms"));
        assert(messages[0].includes("HTTP 200, request slow-123"));
      });
    });
  } finally {
    Date.now = realNow;
  }
});

Deno.test("github: parsed JSON from api.github.com, with the auth and version headers", async () => {
  await withTokens({ GH_TOKEN: "env-token" }, async () => {
    await withFetch(() => Response.json({ login: "octocat", id: 1 }), async (calls) => {
      const body = await github<{ login: string; id: number }>("/user");
      assertEquals(body, { login: "octocat", id: 1 });
      assertEquals(calls.length, 1);
      // A leading slash on the path does not double up against the base url.
      assertEquals(calls[0].url, "https://api.github.com/user");
      const h = calls[0].init.headers as Record<string, string>;
      assertEquals(h.authorization, "Bearer env-token");
      assertEquals(h.accept, "application/vnd.github+json");
      assertEquals(h["x-github-api-version"], "2022-11-28");
      assert(calls[0].init.signal, "the request is bounded by a timeout signal");
    });
  });
});

Deno.test("github: an explicit token wins over the env; GITHUB_TOKEN backs up GH_TOKEN", async () => {
  await withFetch(() => Response.json({}), async (calls) => {
    await withTokens({ GH_TOKEN: "gh", GITHUB_TOKEN: "github" }, async () => {
      await github("x", "explicit");
      await github("x");
    });
    await withTokens({ GITHUB_TOKEN: "github" }, async () => {
      await github("x");
    });
    assertEquals(calls.map(auth), ["Bearer explicit", "Bearer gh", "Bearer github"]);
  });
});

Deno.test("memo: a result is reused within the ttl, refetched past it", async () => {
  let n = 0;
  const get = memo(60_000, () => Promise.resolve(++n));
  assertEquals(await get(), 1);
  assertEquals(await get(), 1);
  assertEquals(n, 1);
  // A negative ttl has elapsed at any clock reading, so every call refetches.
  let m = 0;
  const fresh = memo(-1, () => Promise.resolve(++m));
  assertEquals(await fresh(), 1);
  assertEquals(await fresh(), 2);
});

Deno.test("memo: a rejection is not cached -> the next call retries", async () => {
  let n = 0;
  const get = memo(60_000, () => {
    n++;
    return n === 1 ? Promise.reject(new Error("error sending request")) : Promise.resolve("ok");
  });
  const e = await assertRejects(() => get(), Error);
  assertEquals(e.message, "error sending request");
  // Still inside the ttl: a failure must not be held onto, or one blip would
  // gray a tile out for the whole window.
  assertEquals(await get(), "ok");
  assertEquals(n, 2);
});

Deno.test("memo: concurrent callers share the one in-flight call", async () => {
  let n = 0;
  let release: (v: string) => void = () => {};
  const get = memo(60_000, () => {
    n++;
    return new Promise<string>((r) => release = r);
  });
  const a = get(), b = get();
  release("v");
  assertEquals(await a, "v");
  assertEquals(await b, "v");
  assertEquals(n, 1);
});


// One run's artifact listing, answering the name it is asked for as GitHub
// does, and keeping the paths it was asked for.
function artifactListing(
  artifacts: { id: number; name: string; expired: boolean }[],
) {
  const paths: string[] = [];
  return {
    paths,
    github: {
      json: <T>(path: string): Promise<T> => {
        paths.push(path);
        const asked = new URLSearchParams(path.split("?")[1] ?? "").get("name");
        return Promise.resolve({
          artifacts: artifacts.filter((artifact) => artifact.name === asked),
        } as T);
      },
    },
  };
}

const uploaded = (id: number, name: string, expired = false) => ({
  id,
  name,
  expired,
});

Deno.test("runArtifactId: asks the listing for the one name, and returns its id", async () => {
  // The run's other jobs upload far more than a page of the listing holds, so
  // an answer covering them all would not reach the one being looked for.
  const listing = artifactListing([
    ...Array.from({ length: 200 }, (_, at) => uploaded(1_000 + at, "logs")),
    uploaded(7, "perf-metrics"),
  ]);
  assertEquals(
    await runArtifactId({
      github: listing.github,
      runId: 42,
      name: "perf-metrics",
      token: "t",
    }),
    7,
  );
  assertEquals(listing.paths.length, 1);
  assertStringIncludes(listing.paths[0], "/runs/42/artifacts?");
  assertStringIncludes(listing.paths[0], "name=perf-metrics");
});

Deno.test("runArtifactId: a run with no artifact of the name -> undefined", async () => {
  const listing = artifactListing([uploaded(7, "logs")]);
  assertEquals(
    await runArtifactId({
      github: listing.github,
      runId: 42,
      name: "perf-metrics",
      token: "t",
    }),
    undefined,
  );
});

Deno.test("runArtifactId: a re-run job's newer artifact wins over the first attempt's", async () => {
  const listing = artifactListing([
    uploaded(9, "perf-metrics"),
    uploaded(7, "perf-metrics"),
  ]);
  assertEquals(
    await runArtifactId({
      github: listing.github,
      runId: 42,
      name: "perf-metrics",
      token: "t",
    }),
    9,
  );
});

Deno.test("runArtifactId: an expired artifact is passed over for an older one that is not", async () => {
  const listing = artifactListing([
    uploaded(9, "perf-metrics", true),
    uploaded(7, "perf-metrics"),
  ]);
  assertEquals(
    await runArtifactId({
      github: listing.github,
      runId: 42,
      name: "perf-metrics",
      token: "t",
    }),
    7,
  );
});

Deno.test("runArtifactId: a listing naming no artifacts at all -> undefined", async () => {
  const paths: string[] = [];
  const github = {
    json: <T>(path: string): Promise<T> => {
      paths.push(path);
      return Promise.resolve({} as T);
    },
  };
  assertEquals(
    await runArtifactId({
      github,
      runId: 42,
      name: "perf-metrics",
      token: "t",
    }),
    undefined,
  );
  assertEquals(paths.length, 1);
});
