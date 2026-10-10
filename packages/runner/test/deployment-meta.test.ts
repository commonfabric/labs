import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

import {
  type DeployedClientParams,
  deploymentForShell,
  memoryHostForForeignOrigin,
  memoryHostNote,
  settingsForDeployedClient,
  SHELL_DEPLOYMENT_FLAGS,
  SHELL_FLAG_SOURCES,
  shellFlagsFromDeclared,
} from "../src/deployment-meta.ts";
import { SERVING_RUNTIME_EXPERIMENTAL } from "../src/executor/serving-runtime.ts";
import { EXPERIMENTAL_FLAG_AUTHORITY } from "../src/experimental-posture.ts";
import {
  ADOPT_SERVER_FLAGS_ENV,
  experimentalOptionsFromEnv,
  runtimePresets,
} from "../src/runtime-presets.ts";
import type { IStorageManager } from "../src/storage/interface.ts";

/**
 * Runs `body` with `console.warn` captured, returning what it warned and what
 * it returned. Restored synchronously, so a `body` that returns a promise has
 * to be awaited by the caller AFTER this returns.
 */
function captureWarnings<T>(
  body: () => T,
): { warnings: unknown[][]; result: T } {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { warnings, result: body() };
  } finally {
    console.warn = originalWarn;
  }
}

/** A JSON response carrying `body`, with `status`. */
const metaResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** `response` as `fetch` returns it after following redirects to `url`. */
const redirected = (response: Response, url: string): Response =>
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: url },
  });

const apiUrl = new URL("https://conformance.example/api");
const storageManager = {
  id: "conformance-storage",
} as unknown as IStorageManager;

describe("deployment-meta", () => {
  describe("settingsForDeployedClient()", () => {
    describe("the posture", () => {
      /** The posture of one attempt's settings. */
      const postureFor = async (params: DeployedClientParams) =>
        (await settingsForDeployedClient({ retryDelaysMs: [], ...params }))
          .experimental;

      it("adopts the posture the server publishes on its meta document", async () => {
        const requested: string[] = [];
        const adopted = await postureFor({
          apiUrl: new URL("https://deployment.example/api/"),
          env: (name) =>
            name === "EXPERIMENTAL_MODERN_CELL_REP" ? "false" : undefined,
          fetch: (input) => {
            requested.push(String(input));
            return Promise.resolve(metaResponse({
              did: "did:key:z",
              experimental: { modernCellRep: true, serverExecution: true },
            }));
          },
        });
        // Spelled out rather than composed from the constant: the point is
        // WHICH document the client reads, and a test that reuses the
        // constant cannot tell a changed path from an unchanged one. The
        // toolshed side pins the constant against the route that serves it.
        expect(requested).toEqual(["https://deployment.example/api/meta"]);
        // The env's explicit `false` outranks the server; the flag it says
        // nothing about is adopted — and a posture with no
        // readerSchemaPrecedence declaration is a pre-flag server, adopted
        // as the legacy strict `false`.
        expect(adopted).toEqual({
          modernCellRep: false,
          serverExecution: true,
          readerSchemaPrecedence: false,
          agentBuiltin: false,
        });
      });

      it("ignores the body of a 404 and falls back to the environment", async () => {
        // The body of an error response is not a posture even when it parses
        // as one — an error page, or a proxy standing in for the deployment.
        expect(
          await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              }, 404)),
          }),
        ).toEqual({ modernCellRep: true });
      });

      it("falls back to the environment when the request fails", async () => {
        // Unread, so the memory URL's fallback is warned about.
        using _warn = stub(console, "warn");
        // A deployment that is simply down. The caller is about to fail
        // loudly on its real work; failing here first would only obscure it.
        expect(
          await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () => Promise.reject(new TypeError("connection refused")),
          }),
        ).toEqual({});
      });

      it("falls back to the environment when the body is not JSON", async () => {
        // Unread, so the memory URL's fallback is warned about.
        using _warn = stub(console, "warn");
        expect(
          await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () => Promise.resolve(new Response("<html>nope</html>")),
          }),
        ).toEqual({});
      });

      it("falls back to the environment when successful JSON is not a meta object", async () => {
        // Unread, so the memory URL's fallback is warned about.
        using _warn = stub(console, "warn");
        for (const body of [null, [], "not metadata", 42, true]) {
          expect(
            await postureFor({
              apiUrl: new URL("https://deployment.example"),
              env: (name) =>
                name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
              fetch: () => Promise.resolve(metaResponse(body)),
            }),
          ).toEqual({ modernCellRep: true });
        }
      });

      it("falls back to the environment for a server that publishes no posture", async () => {
        // An older server's meta document predates both flags, so each
        // adopts its legacy `false` rather than staying unset.
        expect(
          await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () =>
              Promise.resolve(metaResponse({ did: "did:key:z", gitSha: null })),
          }),
        ).toEqual({ readerSchemaPrecedence: false, agentBuiltin: false });
      });

      it("hands the request the caller's cancellation signal", async () => {
        // Without it, a deployment that accepts the connection and then says
        // nothing holds a cancellable startup here until the attempt times
        // out, and no shutdown can reach it sooner. The request carries the
        // caller's signal joined with the attempt's own timeout.
        const controller = new AbortController();
        let passed: AbortSignal | undefined;
        await postureFor({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) => {
            passed = init?.signal ?? undefined;
            return Promise.resolve(metaResponse({ experimental: {} }));
          },
        });
        expect(passed?.aborted).toBe(false);
        const reason = new Error("shutting down");
        controller.abort(reason);
        expect(passed?.aborted).toBe(true);
        expect(passed?.reason).toBe(reason);
      });

      it("throws the abort reason even under CF_ADOPT_SERVER_FLAGS=false", async () => {
        // The opt-out is over adopting a posture, not over the caller's
        // cancellation: a startup that has already stopped gets the abort
        // whichever way it was going to resolve its flags.
        const controller = new AbortController();
        controller.abort(new Error("shutting down"));
        await expect(postureFor({
          apiUrl: new URL("https://deployment.example"),
          env: (name) => name === ADOPT_SERVER_FLAGS_ENV ? "false" : undefined,
          signal: controller.signal,
          fetch: () => Promise.reject(new Error("must not be reached")),
        })).rejects.toThrow("shutting down");
      });

      it("refuses cancellation that arrives with a successfully decoded response", async () => {
        for (const body of [{ experimental: {} }, null]) {
          const controller = new AbortController();
          const response = new Response();
          response.json = () => {
            controller.abort(new Error("decoded startup cancelled"));
            return Promise.resolve(body);
          };
          await expect(postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            signal: controller.signal,
            fetch: () => Promise.resolve(response),
          })).rejects.toThrow("decoded startup cancelled");
        }
      });

      it("throws the abort reason when the body read is cancelled", async () => {
        // The signal rides the request, so aborting it errors the response
        // stream: a deployment that sends headers and then stalls its body
        // cannot hold a cancellable startup open.
        const controller = new AbortController();
        await expect(postureFor({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  start(chunk) {
                    chunk.enqueue(new TextEncoder().encode('{"experimental":'));
                    init?.signal?.addEventListener(
                      "abort",
                      () => chunk.error(init.signal!.reason),
                    );
                    controller.abort(new Error("shutting down"));
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            ),
        })).rejects.toThrow("shutting down");
      });

      it("throws the abort reason instead of resolving a cancelled startup", async () => {
        // The one failure that is NOT read as "the server said nothing": the
        // caller asked to stop, so handing back a posture would feed a
        // runtime construction it is abandoning.
        const controller = new AbortController();
        controller.abort(new Error("shutting down"));
        await expect(postureFor({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) => {
            init?.signal?.throwIfAborted();
            return Promise.resolve(metaResponse({ experimental: {} }));
          },
        })).rejects.toThrow("shutting down");
      });

      it("ignores the server's posture under CF_ADOPT_SERVER_FLAGS=false", async () => {
        // The document is still read, for the memory URL it may name.
        let fetched = false;
        expect(
          await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === ADOPT_SERVER_FLAGS_ENV ? "false" : undefined,
            fetch: () => {
              fetched = true;
              return Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              }));
            },
          }),
        ).toEqual({});
        expect(fetched).toBe(true);
      });

      it("adopts under a non-canonical CF_ADOPT_SERVER_FLAGS, with a warning", async () => {
        // Same discipline as the EXPERIMENTAL_* mapping: a value that is
        // neither "true" nor "false" leaves the default (adopting) in place
        // rather than being read as an opt-out.
        const { warnings, result } = captureWarnings(() =>
          postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: (name) => name === ADOPT_SERVER_FLAGS_ENV ? "0" : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              })),
          })
        );
        expect(await result).toEqual({
          serverExecution: true,
          readerSchemaPrecedence: false,
          agentBuiltin: false,
        });
        expect(warnings.length).toBe(1);
        expect(String(warnings[0][0])).toContain(ADOPT_SERVER_FLAGS_ENV);
      });

      it("warns under one prefix for every value it ignores", async () => {
        // The environment's flags, the opt-out, and what the server publishes
        // are read in one call, so their warnings carry one prefix.
        using warn = stub(console, "warn");
        await settingsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: (name) =>
            name === ADOPT_SERVER_FLAGS_ENV
              ? "0"
              : name === "EXPERIMENTAL_MODERN_CELL_REP"
              ? "yes"
              : undefined,
          retryDelaysMs: [],
          fetch: () =>
            Promise.resolve(metaResponse({
              experimental: { serverExecution: "on" },
              memoryUrl: "router.example",
            })),
        });
        expect(warn.calls.length).toBe(4);
        for (const call of warn.calls) {
          expect(String(call.args[0])).toMatch(/^\[deployment-meta\] /);
        }
      });

      it("an adopted server-OFF posture rides the deployed-topology presets explicitly, immune to the first-party default", async () => {
        // The separately-installed-host shape: nothing declared in the
        // environment, talking to a
        // server held on the explicit-OFF rollback posture. Adoption hands
        // the preset an EXPLICIT `false`, and the presets' `??` fill then
        // never consults `SERVER_EXECUTION_DEFAULT_ENABLED` — which is why
        // the first arm of this pin references no constant: it must hold
        // under EITHER value (that immunity is the rollback lever working
        // across a staggered upgrade, not a restatement of the absolute
        // pin in toolshed's server-execution-flag.test.ts).
        const adopted = await postureFor({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          fetch: () =>
            Promise.resolve(metaResponse({
              did: "did:key:z",
              experimental: { serverExecution: false },
            })),
        });
        expect(adopted.serverExecution).toBe(false);
        for (const preset of ["remoteClient", "productionServer"] as const) {
          expect(
            runtimePresets[preset]({
              apiUrl,
              storageManager,
              experimental: adopted,
            })
              .experimental?.serverExecution,
          ).toBe(false);
        }
        // The arm adoption replaces: an env-only resolution leaves the
        // unset flag ABSENT, and the preset fills it with the first-party
        // constant — under a flipped default that is an ON client against
        // the rolled-back OFF server, the mixed topology the adoption
        // exists to prevent. Compared against the imported constant, not a
        // literal, so this documents the exposure without pinning the
        // constant's value.
        expect(
          runtimePresets.remoteClient({
            apiUrl,
            storageManager,
            experimental: experimentalOptionsFromEnv(() => undefined),
          }).experimental?.serverExecution,
        ).toBe(SERVER_EXECUTION_DEFAULT_ENABLED);
      });

      it("an explicit environment outranks the published posture in both directions, through the preset", async () => {
        // Both arms stay selectable on a deployed client: the env is the
        // documented rollback lever and CI's way to pin a lane, so it must
        // survive adoption AND the preset fill in each direction.
        for (
          const arm of [
            { env: "true", server: false, resolved: true },
            { env: "false", server: true, resolved: false },
          ] as const
        ) {
          const adopted = await postureFor({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === "EXPERIMENTAL_SERVER_EXECUTION" ? arm.env : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                did: "did:key:z",
                experimental: { serverExecution: arm.server },
              })),
          });
          expect(adopted.serverExecution).toBe(arm.resolved);
          expect(
            runtimePresets.remoteClient({
              apiUrl,
              storageManager,
              experimental: adopted,
            }).experimental?.serverExecution,
          ).toBe(arm.resolved);
        }
      });
    });

    describe("the memory host", () => {
      const apiUrl = new URL("https://deployment.example/");
      const router = "https://router.example/";

      /** Reads settings from a server returning `respond`, counting requests. */
      async function settingsFrom(
        respond: (attempt: number) => Promise<Response>,
        options: {
          env?: (name: string) => string | undefined;
          retryDelaysMs?: readonly number[];
          apiUrl?: URL;
        } = {},
      ) {
        const requested: string[] = [];
        const settings = await settingsForDeployedClient({
          apiUrl: options.apiUrl ?? apiUrl,
          env: options.env ?? (() => undefined),
          retryDelaysMs: options.retryDelaysMs ?? [0, 0],
          fetch: (input) => {
            requested.push(String(input));
            return respond(requested.length);
          },
        });
        return { ...settings, requested };
      }

      it("reads the posture and the memory host from one request", async () => {
        const { experimental, memoryHost, requested } = await settingsFrom(
          () =>
            Promise.resolve(metaResponse({
              experimental: { serverExecution: true },
              memoryUrl: "https://router.example",
            })),
        );
        expect(requested).toEqual(["https://deployment.example/api/meta"]);
        expect(memoryHost.href).toBe(router);
        expect(experimental).toEqual({
          serverExecution: true,
          readerSchemaPrecedence: false,
          agentBuiltin: false,
        });
      });

      it("returns the API URL, without a warning, when the server publishes no memory URL", async () => {
        using warn = stub(console, "warn");
        for (
          const respond of [
            () => Promise.resolve(metaResponse({ experimental: {} })),
            () => Promise.resolve(metaResponse({ memoryUrl: null })),
            () => Promise.resolve(metaResponse({ memoryUrl: "" })),
            // The API host's own origin is no memory URL either.
            () =>
              Promise.resolve(
                metaResponse({ memoryUrl: "https://deployment.example" }),
              ),
          ]
        ) {
          const { memoryHost, requested } = await settingsFrom(respond);
          expect(memoryHost).toBe(apiUrl);
          expect(requested.length).toBe(1);
        }
        expect(warn.calls.length).toBe(0);
      });

      it("returns the API URL, without a warning or a second request, when the server says it has no meta document", async () => {
        using warn = stub(console, "warn");
        for (const status of [404, 405, 410]) {
          const { memoryHost, requested } = await settingsFrom(() =>
            Promise.resolve(
              metaResponse({ memoryUrl: "https://router.example" }, status),
            )
          );
          expect(memoryHost).toBe(apiUrl);
          expect(requested.length).toBe(1);
        }
        expect(warn.calls.length).toBe(0);
      });

      it("returns the API URL with a warning, and asks once, when the failure would come out the same", async () => {
        using warn = stub(console, "warn");
        const failures: (() => Promise<Response>)[] = [
          ...[300, 302, 400, 401, 403, 499, 500, 501, 505].map((status) => () =>
            Promise.resolve(
              metaResponse({ memoryUrl: "https://router.example" }, status),
            )
          ),
          () => Promise.resolve(new Response("<html>a proxy page</html>")),
          () => Promise.resolve(metaResponse([])),
          // An error that is not a network failure, such as a permission the
          // process lacks.
          () => Promise.reject(new Error("Requires net access")),
        ];
        for (const failure of failures) {
          const { memoryHost, requested } = await settingsFrom(failure);
          expect(memoryHost).toBe(apiUrl);
          expect(requested.length).toBe(1);
        }
        expect(warn.calls.length).toBe(failures.length);
      });

      it("returns the API URL with a warning naming where the redirect ended, and asks once, when a redirect left the API URL's deployment", async () => {
        using warn = stub(console, "warn");
        const cases: { apiUrl?: URL; finalUrl: string; response: Response }[] =
          [
            // A login host that says it has no such document.
            {
              finalUrl: "https://login.example/api/meta",
              response: metaResponse({}, 404),
            },
            // A canonical host that publishes a memory URL of its own.
            {
              finalUrl: "https://canonical.example/api/meta",
              response: metaResponse({ memoryUrl: router }),
            },
            // Another port on the same host.
            {
              finalUrl: "https://deployment.example:8443/api/meta",
              response: metaResponse({ memoryUrl: router }),
            },
            // https down to http on the same host.
            {
              finalUrl: "http://deployment.example/api/meta",
              response: metaResponse({ memoryUrl: router }),
            },
          ];
        for (const { apiUrl: asked, finalUrl, response } of cases) {
          warn.calls.length = 0;
          const { memoryHost, requested } = await settingsFrom(
            () => Promise.resolve(redirected(response, finalUrl)),
            asked !== undefined ? { apiUrl: asked } : {},
          );
          expect(memoryHost).toBe(asked ?? apiUrl);
          expect(requested.length).toBe(1);
          expect(warn.calls.length).toBe(1);
          const message = String(warn.calls[0].args[0]);
          expect(message).toContain(`redirected to ${finalUrl}`);
          expect(message).toContain(
            `served from ${new URL(finalUrl).origin}, set the API URL`,
          );
        }
      });

      it("adopts the posture a redirect brought from off the API URL's deployment", async () => {
        // As clients did before deployments published a memory URL: only the
        // memory URL is refused from such a response.
        using _warn = stub(console, "warn");
        const { experimental, memoryHost } = await settingsFrom(() =>
          Promise.resolve(
            redirected(
              metaResponse({
                experimental: { serverExecution: true },
                memoryUrl: router,
              }),
              "https://canonical.example/api/meta",
            ),
          )
        );
        expect(experimental).toEqual({
          serverExecution: true,
          readerSchemaPrecedence: false,
          agentBuiltin: false,
        });
        expect(memoryHost).toBe(apiUrl);
      });

      it("takes the document a redirect brought from the API URL's own origin", async () => {
        using warn = stub(console, "warn");
        const { memoryHost } = await settingsFrom(() =>
          Promise.resolve(
            redirected(
              metaResponse({ memoryUrl: router }),
              "https://deployment.example/api/meta/",
            ),
          )
        );
        expect(memoryHost.href).toBe(router);
        expect(warn.calls.length).toBe(0);
      });

      it("takes the posture and the memory URL for an http API URL behind a redirect to https on the same host", async () => {
        // A proxy that upgrades the connection to TLS, with a 308.
        using warn = stub(console, "warn");
        const http = new URL("http://deployment.example/");
        const { experimental, memoryHost, requested } = await settingsFrom(
          () =>
            Promise.resolve(
              redirected(
                metaResponse({
                  experimental: { serverExecution: true },
                  memoryUrl: router,
                }),
                "https://deployment.example/api/meta",
              ),
            ),
          { apiUrl: http },
        );
        expect(requested).toEqual(["http://deployment.example/api/meta"]);
        expect(memoryHost.href).toBe(router);
        expect(experimental).toEqual({
          serverExecution: true,
          readerSchemaPrecedence: false,
          agentBuiltin: false,
        });
        expect(warn.calls.length).toBe(0);
      });

      it("asks three times in all when the failure is transient", async () => {
        using warn = stub(console, "warn");
        const failures: (() => Promise<Response>)[] = [
          ...[408, 429, 502, 503, 504].map((status) => () =>
            Promise.resolve(
              metaResponse({ memoryUrl: "https://router.example" }, status),
            )
          ),
          () => Promise.reject(new TypeError("connection refused")),
        ];
        for (const failure of failures) {
          // Read on the third attempt: the memory URL is taken.
          const late = await settingsFrom((attempt) =>
            attempt < 3 ? failure() : Promise.resolve(metaResponse({
              memoryUrl: "https://router.example",
            }))
          );
          expect(late.memoryHost.href).toBe(router);
          expect(late.requested.length).toBe(3);
          // Never read: three attempts, then the API URL.
          const never = await settingsFrom(failure);
          expect(never.memoryHost).toBe(apiUrl);
          expect(never.requested.length).toBe(3);
        }
        expect(warn.calls.length).toBe(failures.length);
      });

      it("warns once, naming the host Memory stays on, when the document cannot be read", async () => {
        using warn = stub(console, "warn");
        await settingsFrom(() => Promise.reject(new TypeError("refused")));
        expect(warn.calls.length).toBe(1);
        const message = String(warn.calls[0].args[0]);
        expect(message).toContain("https://deployment.example/api/meta");
        expect(message).toContain("Memory opens on https://deployment.example");
      });

      it("waits a quarter of a second and then a second between attempts by default", async () => {
        using _warn = stub(console, "warn");
        let attempts = 0;
        const settings = settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          fetch: () => {
            attempts++;
            return Promise.reject(new TypeError("refused"));
          },
        });
        await clock.settle();
        expect(attempts).toBe(1);
        await clock.tick(249);
        expect(attempts).toBe(1);
        await clock.tick(1);
        expect(attempts).toBe(2);
        await clock.tick(999);
        expect(attempts).toBe(2);
        await clock.tick(1);
        expect(attempts).toBe(3);
        expect((await settings).memoryHost).toBe(apiUrl);
      });

      it("gives up on an attempt that takes longer than its timeout, and does not ask again", async () => {
        using warn = stub(console, "warn");
        let attempts = 0;
        const settings = await settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          attemptTimeoutMs: 5,
          retryDelaysMs: [0, 0],
          fetch: (_input, init) => {
            attempts++;
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal!.reason),
              );
            });
          },
        });
        expect(settings.memoryHost).toBe(apiUrl);
        // A server that sent nothing for the whole attempt is not asked
        // again: the read ends on the first timeout.
        expect(attempts).toBe(1);
        expect(warn.calls.length).toBe(1);
      });

      it("does not ask again when an attempt times out while the body is read", async () => {
        // A stream that breaks off reports a TypeError, which is otherwise a
        // network failure worth asking again; here the attempt's own timeout
        // broke it.
        using _warn = stub(console, "warn");
        let attempts = 0;
        const settings = await settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          attemptTimeoutMs: 5,
          retryDelaysMs: [0, 0],
          fetch: (_input, init) => {
            attempts++;
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(chunk) {
                    chunk.enqueue(new TextEncoder().encode('{"memoryUrl":'));
                    init?.signal?.addEventListener(
                      "abort",
                      () => chunk.error(new TypeError("stream broke off")),
                    );
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            );
          },
        });
        expect(settings.memoryHost).toBe(apiUrl);
        expect(attempts).toBe(1);
      });

      it("gives an attempt its timeout when the caller passes a signal", async () => {
        // The caller's signal is joined with the attempt's own timeout rather
        // than standing in for it: a caller that never aborts still gets a
        // read that ends.
        using warn = stub(console, "warn");
        const settings = await settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          signal: new AbortController().signal,
          attemptTimeoutMs: 5,
          retryDelaysMs: [],
          fetch: (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal!.reason),
              );
            }),
        });
        expect(settings.memoryHost).toBe(apiUrl);
        expect(warn.calls.length).toBe(1);
      });

      it("clears an attempt's timeout once the attempt completes", async () => {
        let passed: AbortSignal | undefined;
        await settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          fetch: (_input, init) => {
            passed = init?.signal ?? undefined;
            return Promise.resolve(metaResponse({ experimental: {} }));
          },
        });
        // Past the five seconds the attempt was given: a timeout left armed
        // would abort the signal the request carried.
        await clock.tick(10_000);
        expect(passed?.aborted).toBe(false);
      });

      it("cancels the body of a response it does not read", async () => {
        const unread: ((body: ReadableStream) => Response)[] = [
          ...[404, 500, 503].map((status) => (body: ReadableStream) =>
            new Response(body, { status })
          ),
          // A 404 a redirect brought from off the API URL's deployment.
          (body) =>
            redirected(
              new Response(body, { status: 404 }),
              "https://login.example/api/meta",
            ),
        ];
        for (const respond of unread) {
          let cancelled = false;
          const body = new ReadableStream({
            cancel() {
              cancelled = true;
            },
          });
          using _warn = stub(console, "warn");
          await settingsFrom(
            () => Promise.resolve(respond(body)),
            {
              retryDelaysMs: [],
            },
          );
          expect(cancelled).toBe(true);
        }
      });

      it("throws the abort reason when the caller stops between attempts", async () => {
        const controller = new AbortController();
        let attempts = 0;
        const outcome = settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          signal: controller.signal,
          retryDelaysMs: [3_000],
          fetch: () => {
            attempts++;
            return Promise.reject(new TypeError("refused"));
          },
        }).then(() => "resolved", (error: Error) => error.message);
        // The first attempt has failed and the read is waiting to ask again.
        await clock.settle();
        expect(attempts).toBe(1);
        controller.abort(new Error("stopped"));
        // Settled without moving the clock: the wait ended on the abort, not
        // on its timer.
        await clock.settle();
        expect(await Promise.race([outcome, Promise.resolve("pending")]))
          .toBe("stopped");
        expect(attempts).toBe(1);
      });

      it("drops a published memory URL that is not an HTTP or HTTPS origin, with a warning", async () => {
        using warn = stub(console, "warn");
        for (
          const value of [
            "https://router.example/api",
            "wss://router.example",
            "blob:https://deployment.example/x",
            42,
            // Shaped like a URL, but a document carries strings.
            { href: "https://router.example" },
          ]
        ) {
          expect(
            (await settingsFrom(() =>
              Promise.resolve(metaResponse({ memoryUrl: value }))
            )).memoryHost,
          ).toBe(apiUrl);
        }
        expect(warn.calls.length).toBe(5);
        expect(String(warn.calls[0].args[0])).toContain("memoryUrl");
        expect(String(warn.calls[0].args[0])).toContain(
          "Memory URL must not include a path",
        );
      });

      it("returns an API URL with a path, unchanged, when the deployment publishes no memory URL", async () => {
        // The memory host then names the API host, path and all, and a runtime
        // built on it holds no memory URL (the presets' tests).
        const pathful = new URL("https://deployment.example/fabric/");
        for (const memoryUrl of [null, "https://deployment.example"]) {
          const { memoryHost } = await settingsFrom(
            () => Promise.resolve(metaResponse({ memoryUrl })),
            { apiUrl: pathful },
          );
          expect(memoryHost).toBe(pathful);
        }
      });

      it("reads the memory host when the environment refuses the server's flags", async () => {
        const { experimental, memoryHost, requested } = await settingsFrom(
          () =>
            Promise.resolve(metaResponse({
              experimental: { serverExecution: true },
              memoryUrl: "https://router.example",
            })),
          {
            env: (name) =>
              name === ADOPT_SERVER_FLAGS_ENV ? "false" : undefined,
          },
        );
        expect(requested.length).toBe(1);
        expect(experimental).toEqual({});
        expect(memoryHost.href).toBe(router);
      });

      it("throws the abort reason of a cancelled signal", async () => {
        const controller = new AbortController();
        controller.abort(new Error("stopped"));
        await expect(settingsForDeployedClient({
          apiUrl,
          env: () => undefined,
          signal: controller.signal,
          fetch: () => Promise.resolve(metaResponse({})),
        })).rejects.toThrow("stopped");
      });
    });
  });

  describe("deploymentForShell()", () => {
    const apiUrl = new URL("https://deployment.example/");

    it("returns the published memory URL and the shell's flags, not transient", async () => {
      const requested: string[] = [];
      const read = await deploymentForShell({
        apiUrl,
        fetch: (input) => {
          requested.push(String(input));
          return Promise.resolve(
            metaResponse({
              memoryUrl: "https://router.example",
              experimental: {
                sharedMemoryConnection: true,
                serverExecution: true,
              },
            }),
          );
        },
      });
      expect(read.memoryUrl?.href).toBe("https://router.example/");
      // One request serves both; the posture is restricted to the flags the
      // shell takes from its deployment.
      expect(read.experimental).toEqual({ sharedMemoryConnection: true });
      expect(read.transient).toBe(false);
      expect(requested).toEqual(["https://deployment.example/api/meta"]);
      expect(
        await deploymentForShell({
          apiUrl,
          fetch: () =>
            Promise.resolve(
              metaResponse({
                memoryUrl: null,
                experimental: { sharedMemoryConnection: false },
              }),
            ),
        }),
      ).toEqual({
        memoryUrl: undefined,
        experimental: { sharedMemoryConnection: false },
        transient: false,
      });
    });

    it("adopts nothing from a document that is silent, has no posture yet, or is absent", async () => {
      for (
        const body of [
          {},
          { experimental: null },
          { experimental: {} },
          { experimental: { serverExecution: true } },
        ]
      ) {
        const read = await deploymentForShell({
          apiUrl,
          fetch: () => Promise.resolve(metaResponse(body)),
        });
        expect(read.experimental, JSON.stringify(body)).toEqual({});
      }
      expect(
        await deploymentForShell({
          apiUrl,
          fetch: () => Promise.resolve(metaResponse({}, 404)),
        }),
      ).toEqual({ memoryUrl: undefined, experimental: {}, transient: false });
    });

    it("drops a flag the document declares with a non-boolean, with a warning", async () => {
      using warn = stub(console, "warn");
      const read = await deploymentForShell({
        apiUrl,
        fetch: () =>
          Promise.resolve(
            metaResponse({ experimental: { sharedMemoryConnection: "yes" } }),
          ),
      });
      expect(read.experimental).toEqual({});
      expect(warn.calls.length).toBe(1);
      expect(String(warn.calls[0].args[0])).toContain(
        "Ignoring server-published sharedMemoryConnection=",
      );
      expect(String(warn.calls[0].args[0])).toContain("expected a boolean");
    });

    it("returns a transient result only for a transient failure", async () => {
      using _warn = stub(console, "warn");
      const read = (fetch: typeof globalThis.fetch) =>
        deploymentForShell({
          apiUrl,
          retryDelaysMs: [],
          attemptTimeoutMs: 5,
          fetch,
        });
      for (
        const transient of [
          () => Promise.reject(new TypeError("refused")),
          () => Promise.resolve(metaResponse({}, 503)),
        ]
      ) {
        expect(await read(transient)).toEqual({
          memoryUrl: undefined,
          experimental: {},
          transient: true,
        });
      }
      for (
        const settled of [
          () => Promise.resolve(metaResponse({}, 401)),
          () => Promise.resolve(metaResponse({}, 500)),
          // An attempt that timed out.
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal!.reason),
              );
            }),
        ]
      ) {
        expect(await read(settled)).toEqual({
          memoryUrl: undefined,
          experimental: {},
          transient: false,
        });
      }
    });

    it("takes the posture, and no memory URL, from a response a redirect brought off the deployment", async () => {
      using _warn = stub(console, "warn");
      // As settingsForDeployedClient reads it: the posture as before
      // deployments published a memory URL, the memory URL not.
      expect(
        await deploymentForShell({
          apiUrl,
          fetch: () =>
            Promise.resolve(
              redirected(
                metaResponse({
                  memoryUrl: "https://router.example",
                  experimental: { sharedMemoryConnection: true },
                }),
                "https://login.example/api/meta",
              ),
            ),
        }),
      ).toEqual({
        memoryUrl: undefined,
        experimental: { sharedMemoryConnection: true },
        transient: false,
      });
    });
  });

  describe("SHELL_DEPLOYMENT_FLAGS", () => {
    it("is the flags SHELL_FLAG_SOURCES gives the deployment", () => {
      expect(SHELL_DEPLOYMENT_FLAGS).toEqual(["sharedMemoryConnection"]);
      for (const flag of SHELL_DEPLOYMENT_FLAGS) {
        expect(SHELL_FLAG_SOURCES[flag]).toBe("deployment");
      }
    });

    it("holds only server-authority flags, which is what the shell's adoption takes", () => {
      for (const flag of SHELL_DEPLOYMENT_FLAGS) {
        expect(EXPERIMENTAL_FLAG_AUTHORITY[flag], flag).toBe("server");
      }
    });

    it("holds no flag the serving loop forces, since the page is built once", () => {
      // /api/meta applies the serving overrides live; a page carrying one of
      // them would disagree with it whenever the loop started or stopped.
      for (const flag of SHELL_DEPLOYMENT_FLAGS) {
        expect(flag in SERVING_RUNTIME_EXPERIMENTAL, flag).toBe(false);
      }
    });
  });

  describe("shellFlagsFromDeclared()", () => {
    it("keeps the flags the shell takes from its deployment and nothing else", () => {
      expect(shellFlagsFromDeclared({
        sharedMemoryConnection: true,
        serverExecution: false,
        readerSchemaPrecedence: true,
        unknownToThisBuild: true,
      })).toEqual({ sharedMemoryConnection: true });
      expect(shellFlagsFromDeclared({ sharedMemoryConnection: false }))
        .toEqual({ sharedMemoryConnection: false });
    });

    it("reads an older server's silence as no declaration of the shell's flags", () => {
      // parseServerExperimentalOptions reads it as the legacy false on
      // readerSchemaPrecedence and agentBuiltin; neither is the shell's to
      // adopt.
      for (const declared of [undefined, null, {}, [], "posture", 3]) {
        expect(shellFlagsFromDeclared(declared), String(declared)).toEqual({});
      }
    });
  });

  describe("memoryHostForForeignOrigin()", () => {
    const origin = new URL("https://foreign.example/");
    const read = (fetch: typeof globalThis.fetch) =>
      memoryHostForForeignOrigin({
        apiUrl: origin,
        retryDelaysMs: [],
        attemptTimeoutMs: 5,
        fetch,
      });

    it("returns the memory URL the origin publishes", async () => {
      const requested: string[] = [];
      const host = await read((input) => {
        requested.push(String(input));
        return Promise.resolve(
          metaResponse({ memoryUrl: "https://router.foreign.example" }),
        );
      });
      expect(host).toEqual({
        memoryHost: new URL("https://router.foreign.example/"),
      });
      expect(requested).toEqual(["https://foreign.example/api/meta"]);
    });

    it("returns the origin itself where it publishes no memory URL", async () => {
      for (
        const answer of [
          () => Promise.resolve(metaResponse({}, 404)),
          () => Promise.resolve(metaResponse({}, 405)),
          () => Promise.resolve(metaResponse({}, 410)),
          () => Promise.resolve(metaResponse({})),
          () => Promise.resolve(metaResponse({ memoryUrl: null })),
          // Its own origin is no memory URL, as it is for a client's own
          // deployment.
          () =>
            Promise.resolve(
              metaResponse({ memoryUrl: "https://foreign.example" }),
            ),
        ]
      ) {
        expect(await read(answer)).toEqual({ memoryHost: origin });
      }
    });

    it("returns unread, with the reason, where the memory host cannot be learned", async () => {
      using _warn = stub(console, "warn");
      const unread = async (
        fetch: typeof globalThis.fetch,
        reason: string,
      ) => {
        const host = await read(fetch);
        expect("unread" in host).toBe(true);
        if ("unread" in host) expect(host.reason).toContain(reason);
      };
      const couldNotBeRead =
        "https://foreign.example/api/meta could not be read";
      await unread(
        () => Promise.reject(new TypeError("refused")),
        couldNotBeRead,
      );
      await unread(
        () => Promise.resolve(metaResponse({}, 500)),
        couldNotBeRead,
      );
      await unread(
        () => Promise.resolve(metaResponse({}, 401)),
        couldNotBeRead,
      );
      await unread(
        () => Promise.resolve(metaResponse({}, 503)),
        couldNotBeRead,
      );
      await unread(
        () => Promise.resolve(new Response("<html>", { status: 200 })),
        couldNotBeRead,
      );
      await unread(
        () =>
          Promise.resolve(
            redirected(
              metaResponse({ memoryUrl: "https://router.foreign.example" }),
              "https://login.example/api/meta",
            ),
          ),
        "redirected to https://login.example/api/meta",
      );
      await unread(
        () =>
          Promise.resolve(
            metaResponse({ memoryUrl: "wss://router.foreign.example" }),
          ),
        "Unsupported memory URL protocol",
      );
      await unread(
        () => Promise.resolve(metaResponse({ memoryUrl: 7 })),
        "expected a string",
      );
      expect(_warn.calls.length).toBe(0);
    });

    it("throws the abort reason when the signal aborts", async () => {
      const controller = new AbortController();
      controller.abort(new Error("stopped"));
      await expect(
        memoryHostForForeignOrigin({
          apiUrl: origin,
          signal: controller.signal,
          fetch: () => Promise.resolve(metaResponse({})),
        }),
      ).rejects.toThrow("stopped");
    });
  });

  describe("memoryHostNote()", () => {
    it("returns a note naming the memory host only when it is not the API host", () => {
      const apiUrl = new URL("https://deployment.example/fabric/");
      expect(memoryHostNote(new URL("https://deployment.example"), apiUrl))
        .toBe("");
      expect(memoryHostNote(new URL("https://router.example"), apiUrl)).toBe(
        ' Memory opens on "https://router.example/", which the health ' +
          "check does not ask.",
      );
    });
  });
});
