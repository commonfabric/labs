/**
 * The bounded transport retry both model clients share: which failures are
 * issued again, how the backoff runs, what every attempt record says, and
 * what a caller is thrown when the schedule runs out. Backoff is driven by an
 * injected delay that records what it was asked for and resolves at once, so
 * nothing here waits on a timer.
 */

import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { expect } from "@std/expect";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import {
  type OpenAIChatCompletionAttemptDiagnostic,
  OpenAICompatibleGatewayClient,
} from "../src/gateway/openai-client.ts";
import type { HarnessModelAttemptDiagnostic } from "../src/model/client.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import {
  abortableDelay,
  DEFAULT_TRANSPORT_RETRIES,
  DEFAULT_TRANSPORT_RETRY_DELAY_MS,
  type HarnessTransportRetryDelay,
  TransportRetrySchedule,
} from "../src/model/transport-retry.ts";

const credential: OpenAICodexOAuthCredential = {
  type: "oauth",
  providerId: "openai-codex",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: Date.now() + 60_000,
  accountId: "acct-123",
};

const OVERLOADED_EVENT = {
  type: "error",
  error: {
    type: "service_unavailable_error",
    code: "server_is_overloaded",
    message: "Our servers are currently overloaded. Please try again later.",
  },
};

const OVERLOADED_DESCRIPTION =
  "service_unavailable_error / server_is_overloaded: Our servers are currently overloaded. Please try again later.";

const sse = (...events: unknown[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const completedStream = (): Response =>
  sse({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      }],
    },
  });

/** A delay that records each backoff it is asked for and resolves at once. */
const recordingDelay = (): {
  delays: number[];
  delay: HarnessTransportRetryDelay;
} => {
  const delays: number[] = [];
  return {
    delays,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
};

describe("transport-retry", () => {
  describe("TransportRetrySchedule", () => {
    describe("constructor()", () => {
      it("allows one attempt more than the configured retries", () => {
        expect(new TransportRetrySchedule({ transportRetries: 0 }).maxAttempts)
          .toBe(1);
        expect(new TransportRetrySchedule({ transportRetries: 2 }).maxAttempts)
          .toBe(3);
      });

      it("falls back to the defaults for an absent or invalid option", () => {
        expect(new TransportRetrySchedule().maxAttempts)
          .toBe(DEFAULT_TRANSPORT_RETRIES + 1);
        expect(new TransportRetrySchedule({ transportRetries: -1 }).maxAttempts)
          .toBe(DEFAULT_TRANSPORT_RETRIES + 1);
        expect(new TransportRetrySchedule().delayMsBefore(2))
          .toBe(DEFAULT_TRANSPORT_RETRY_DELAY_MS);
        expect(
          new TransportRetrySchedule({ transportRetryDelayMs: 1.5 })
            .delayMsBefore(2),
        ).toBe(DEFAULT_TRANSPORT_RETRY_DELAY_MS);
      });
    });

    describe("instance members", () => {
      describe("delayMsBefore()", () => {
        it("returns no backoff before the first attempt and doubles it before each attempt after the second", () => {
          const schedule = new TransportRetrySchedule({
            transportRetryDelayMs: 100,
          });
          expect([1, 2, 3, 4].map((attempt) => schedule.delayMsBefore(attempt)))
            .toEqual([0, 100, 200, 400]);
        });
      });

      describe("retryAfter()", () => {
        it("returns the kind and the backoff before the next attempt", () => {
          const schedule = new TransportRetrySchedule({
            transportRetries: 2,
            transportRetryDelayMs: 100,
          });
          expect(schedule.retryAfter(1, "http_status"))
            .toEqual({ kind: "http_status", delayMs: 100 });
          expect(schedule.retryAfter(2, "transport_error"))
            .toEqual({ kind: "transport_error", delayMs: 200 });
        });

        it("returns `undefined` for a failure that is not transient", () => {
          expect(new TransportRetrySchedule().retryAfter(1, undefined))
            .toBeUndefined();
        });

        it("returns `undefined` on the last attempt the schedule allows", () => {
          const schedule = new TransportRetrySchedule({ transportRetries: 2 });
          expect(schedule.retryAfter(3, "provider_error")).toBeUndefined();
          expect(schedule.retryAfter(4, "provider_error")).toBeUndefined();
        });
      });

      describe("waitBefore()", () => {
        it("waits out the backoff through the injected delay", async () => {
          const { delays, delay } = recordingDelay();
          const schedule = new TransportRetrySchedule({
            transportRetryDelayMs: 100,
            transportRetryDelay: delay,
          });
          await schedule.waitBefore(3);
          expect(delays).toEqual([200]);
        });
      });
    });
  });

  describe("abortableDelay()", () => {
    it("resolves once the timer fires", async () => {
      using time = new FakeTime();
      let resolved = false;
      const waiting = abortableDelay(50).then(() => {
        resolved = true;
      });
      await time.tickAsync(49);
      expect(resolved).toBe(false);
      await time.tickAsync(1);
      await waiting;
      expect(resolved).toBe(true);
    });

    it("resolves at once for a zero delay", async () => {
      await abortableDelay(0);
    });

    it("rejects with the abort reason when the signal aborts mid-wait", async () => {
      using time = new FakeTime();
      const controller = new AbortController();
      const reason = new Error("canceled during backoff");
      const waiting = abortableDelay(50, controller.signal);
      await time.tickAsync(10);
      controller.abort(reason);
      expect(await rejectionOf(waiting)).toBe(reason);
    });

    it("rejects with the abort reason when the signal is already aborted", async () => {
      const controller = new AbortController();
      const reason = new Error("already canceled");
      controller.abort(reason);
      expect(await rejectionOf(abortableDelay(50, controller.signal)))
        .toBe(reason);
    });
  });

  describe("OpenAICodexResponsesClient", () => {
    const codexClient = (
      respond: (call: number) => Response | Promise<Response>,
      options: {
        transportRetries?: number;
        delay?: HarnessTransportRetryDelay;
      } = {},
    ) => {
      const attempts: HarnessModelAttemptDiagnostic[] = [];
      let calls = 0;
      const client = new OpenAICodexResponsesClient({
        credentialResolver: { resolve: () => Promise.resolve(credential) },
        transportRetries: options.transportRetries ?? 2,
        transportRetryDelayMs: 100,
        ...(options.delay !== undefined
          ? { transportRetryDelay: options.delay }
          : {}),
        fetchFn: () => {
          calls += 1;
          return Promise.resolve(respond(calls));
        },
      });
      const complete = (signal?: AbortSignal) =>
        client.complete({
          model: "gpt-5.4",
          transcript: [{ role: "user", content: "hi" }],
          tools: [],
          nativeModelToolIds: [],
          runId: "run-retry",
          ...(signal !== undefined ? { signal } : {}),
          onAttempt: (attempt) => {
            attempts.push(attempt);
          },
        });
      return { attempts, complete, calls: () => calls };
    };

    it("issues the exchange again after a transient in-stream error event, recording the provider's reason on the failed attempt", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        (call) => call === 1 ? sse(OVERLOADED_EVENT) : completedStream(),
        { delay },
      );

      const result = await complete();

      expect(result.assistant.content).toBe("hello");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
      expect(attempts.map((attempt) => attempt.maxTransportAttempts))
        .toEqual([3, 3]);
      expect(attempts[0].outcome).toBe("http_response");
      expect(attempts[0].providerError).toEqual(OVERLOADED_EVENT.error);
      expect(attempts[0].retry)
        .toEqual({ kind: "provider_error", delayMs: 100 });
      expect(attempts[1].providerError).toBeUndefined();
      expect(attempts[1].retry).toBeUndefined();
    });

    it("throws the provider's reason once the schedule runs out, with every attempt recorded", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        () => sse(OVERLOADED_EVENT),
        { delay },
      );

      const error = await rejectionOf(complete());

      expect(error).toBeInstanceOf(HarnessControlError);
      expect((error as HarnessControlError).code).toBe("provider-unavailable");
      expect((error as Error).message).toBe(
        `OpenAI Codex Responses stream returned an error event: ${OVERLOADED_DESCRIPTION}`,
      );
      expect(calls()).toBe(3);
      expect(delays).toEqual([100, 200]);
      expect(attempts.map((attempt) => attempt.retry?.delayMs))
        .toEqual([100, 200, undefined]);
      expect(attempts[2].providerError).toEqual(OVERLOADED_EVENT.error);
    });

    it("does not issue the exchange again for an error event the provider does not state as transient", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        () =>
          sse({
            type: "error",
            error: {
              type: "invalid_request_error",
              code: "context_length_exceeded",
              message: "the input is too long",
            },
          }),
        { delay },
      );

      const error = await rejectionOf(complete());

      expect((error as Error).message).toBe(
        "OpenAI Codex Responses stream returned an error event: invalid_request_error / context_length_exceeded: the input is too long",
      );
      expect(calls()).toBe(1);
      expect(delays).toEqual([]);
      expect(attempts.length).toBe(1);
      expect(attempts[0].retry).toBeUndefined();
      expect(attempts[0].providerError?.code).toBe("context_length_exceeded");
    });

    it("records an error event that states no reason without inventing one", async () => {
      const { attempts, complete } = codexClient(
        () => sse({ type: "error" }),
        { transportRetries: 0 },
      );

      const error = await rejectionOf(complete());

      expect((error as Error).message).toBe(
        "OpenAI Codex Responses stream returned an error event: the provider stated no reason",
      );
      expect(attempts[0].providerError)
        .toEqual({ message: "the provider stated no reason" });
    });

    it("issues the exchange again after a `response.failed` terminal that states a transient reason", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        (call) =>
          call === 1
            ? sse({
              type: "response.failed",
              response: {
                status: "failed",
                output: [],
                error: { code: "server_error", message: "internal fault" },
              },
            })
            : completedStream(),
        { delay },
      );

      const result = await complete();

      expect(result.assistant.content).toBe("hello");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts[0].providerError)
        .toEqual({ code: "server_error", message: "internal fault" });
      expect(attempts[0].retry?.kind).toBe("provider_error");
    });

    it("names a `response.failed` terminal's reason when the schedule runs out", async () => {
      const { complete } = codexClient(
        () =>
          sse({
            type: "response.failed",
            response: {
              status: "failed",
              output: [],
              error: { code: "server_error", message: "internal fault" },
            },
          }),
        { transportRetries: 0 },
      );

      const error = await rejectionOf(complete());

      expect((error as Error).message).toBe(
        "Codex Responses ended with status failed: server_error: internal fault",
      );
    });

    it("issues the exchange again after a 5xx response, recording the body's reason", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        (call) =>
          call === 1
            ? new Response(
              JSON.stringify({
                error: { type: "server_error", message: "try again" },
              }),
              { status: 503 },
            )
            : completedStream(),
        { delay },
      );

      const result = await complete();

      expect(result.assistant.content).toBe("hello");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts[0].httpStatus).toBe(503);
      expect(attempts[0].providerError)
        .toEqual({ type: "server_error", message: "try again" });
      expect(attempts[0].retry).toEqual({ kind: "http_status", delayMs: 100 });
    });

    it("names the body's reason when a 5xx response ends the schedule", async () => {
      const { complete } = codexClient(
        () =>
          new Response(
            JSON.stringify({
              error: { type: "server_error", message: "try again" },
            }),
            { status: 503 },
          ),
        { transportRetries: 0 },
      );

      const error = await rejectionOf(complete());

      expect((error as Error).message).toBe(
        "OpenAI Codex Responses request failed (503): server_error: try again",
      );
    });

    it("redacts credential values from the provider's reason", async () => {
      const { attempts, complete } = codexClient(
        () =>
          sse({
            type: "error",
            error: {
              type: "server_error",
              message: "access-secret for acct-123 failed",
            },
          }),
        { transportRetries: 0 },
      );

      const error = await rejectionOf(complete());

      const serialized = `${(error as Error).message}${
        JSON.stringify(attempts)
      }`;
      expect(serialized.includes("access-secret")).toBe(false);
      expect(serialized.includes("acct-123")).toBe(false);
      expect(attempts[0].providerError?.message)
        .toBe("[redacted] for [redacted] failed");
    });

    it("does not issue the exchange again after a 4xx other than 429", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        () => new Response("unauthorized", { status: 401 }),
        { delay },
      );

      const error = await rejectionOf(complete());

      expect((error as HarnessControlError).code).toBe(
        "provider-auth-required",
      );
      expect(calls()).toBe(1);
      expect(delays).toEqual([]);
      expect(attempts[0].retry).toBeUndefined();
    });

    it("issues the exchange again after a transport error", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        (call) =>
          call === 1
            ? Promise.reject(new Error("connection reset"))
            : completedStream(),
        { delay },
      );

      const result = await complete();

      expect(result.assistant.content).toBe("hello");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts[0].outcome).toBe("transport_error");
      expect(attempts[0].retry)
        .toEqual({ kind: "transport_error", delayMs: 100 });
    });

    it("issues the exchange again after a stream that ends before its terminal event", async () => {
      const { delays, delay } = recordingDelay();
      const { attempts, complete, calls } = codexClient(
        (call) =>
          call === 1
            ? sse({ type: "response.output_text.delta", delta: "partial" })
            : completedStream(),
        { delay },
      );

      const result = await complete();

      expect(result.assistant.content).toBe("hello");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts[0].retry?.kind).toBe("transport_error");
    });

    it("does not issue the exchange again for a stream that is not SSE-framed JSON", async () => {
      const { delays, delay } = recordingDelay();
      const { complete, calls } = codexClient(
        () => new Response("data: {not-json}\n\n", { status: 200 }),
        { delay },
      );

      const error = await rejectionOf(complete());

      expect((error as Error).message).toContain("malformed JSON");
      expect(calls()).toBe(1);
      expect(delays).toEqual([]);
    });

    it("rejects with the abort reason when the signal aborts during the backoff", async () => {
      const controller = new AbortController();
      const reason = new Error("canceled during backoff");
      const { complete, calls } = codexClient(
        () => sse(OVERLOADED_EVENT),
        {
          delay: (_ms, signal) => {
            controller.abort(reason);
            return Promise.reject(signal?.reason);
          },
        },
      );

      expect(await rejectionOf(complete(controller.signal))).toBe(reason);
      expect(calls()).toBe(1);
    });
  });

  describe("OpenAICompatibleGatewayClient", () => {
    const gatewayClient = (
      respond: (call: number) => Response | Promise<Response>,
      options: { transportRetries?: number } = {},
    ) => {
      const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
      const { delays, delay } = recordingDelay();
      let calls = 0;
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        transportRetries: options.transportRetries ?? 2,
        transportRetryDelayMs: 100,
        transportRetryDelay: delay,
        fetchFn: () => {
          calls += 1;
          return Promise.resolve(respond(calls));
        },
      });
      const attemptOptions = {
        onChatCompletionAttempt: (
          attempt: OpenAIChatCompletionAttemptDiagnostic,
        ) => {
          attempts.push(attempt);
        },
      };
      return { client, attempts, delays, attemptOptions, calls: () => calls };
    };

    const completedResponse = (): Response =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          }],
        }),
        { status: 200 },
      );

    it("issues a Responses request again after a 5xx, recording the body's reason", async () => {
      const { client, attempts, delays, attemptOptions, calls } = gatewayClient(
        (call) =>
          call === 1
            ? new Response(
              JSON.stringify({
                error: { type: "server_error", message: "upstream down" },
              }),
              { status: 502 },
            )
            : completedResponse(),
      );

      const response = await client.createResponseJson(
        { model: "gpt-5.6", input: [] },
        attemptOptions,
      );

      expect(response.status).toBe("completed");
      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts.map((attempt) => attempt.httpStatus)).toEqual([502, 200]);
      expect(attempts[0].providerError)
        .toEqual({ type: "server_error", message: "upstream down" });
      expect(attempts[0].retry).toEqual({ kind: "http_status", delayMs: 100 });
      expect(attempts[0].responseBodyExcerpt).toContain("upstream down");
      expect(attempts[1].retry).toBeUndefined();
    });

    it("throws the final response's body once a 5xx ends the schedule", async () => {
      const { client, attempts, delays, attemptOptions, calls } = gatewayClient(
        () => new Response("gateway overloaded", { status: 503 }),
      );

      const error = await rejectionOf(client.createChatCompletionJson(
        { model: "gpt-5.4", messages: [] },
        attemptOptions,
      ));

      expect((error as Error).message)
        .toBe("chat completion request failed (503): gateway overloaded");
      expect(calls()).toBe(3);
      expect(delays).toEqual([100, 200]);
      expect(attempts.map((attempt) => attempt.retry?.delayMs))
        .toEqual([100, 200, undefined]);
      expect(attempts[2].providerError).toBeUndefined();
    });

    it("does not issue a request again after a 4xx other than 429", async () => {
      const { client, attempts, delays, attemptOptions, calls } = gatewayClient(
        () => new Response("bad request", { status: 400 }),
      );

      const error = await rejectionOf(client.createChatCompletionJson(
        { model: "gpt-5.4", messages: [] },
        attemptOptions,
      ));

      expect((error as Error).message)
        .toBe("chat completion request failed (400): bad request");
      expect(calls()).toBe(1);
      expect(delays).toEqual([]);
      expect(attempts.length).toBe(1);
      expect(attempts[0].retry).toBeUndefined();
    });

    it("issues a request again after a 429", async () => {
      const { client, attempts, calls } = gatewayClient(
        (call) =>
          call === 1
            ? new Response("slow down", { status: 429 })
            : completedResponse(),
      );

      await client.createResponseJson({ model: "gpt-5.6", input: [] }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      expect(calls()).toBe(2);
      expect(attempts[0].retry?.kind).toBe("http_status");
    });

    it("waits out the backoff through the injected delay after a transport error", async () => {
      const { client, attempts, delays, attemptOptions, calls } = gatewayClient(
        (call) =>
          call === 1
            ? Promise.reject(new Error("connection reset"))
            : completedResponse(),
      );

      await client.createResponseJson(
        { model: "gpt-5.6", input: [] },
        attemptOptions,
      );

      expect(calls()).toBe(2);
      expect(delays).toEqual([100]);
      expect(attempts[0].outcome).toBe("transport_error");
      expect(attempts[0].retry)
        .toEqual({ kind: "transport_error", delayMs: 100 });
    });

    it("returns a non-2xx response with its body readable to a caller that reads the response itself", async () => {
      const { client, attempts, attemptOptions } = gatewayClient(
        () => new Response("bad request", { status: 400 }),
      );

      const response = await client.createChatCompletion(
        { model: "gpt-5.4", messages: [] },
        attemptOptions,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("bad request");
      expect(attempts.length).toBe(1);
      expect(attempts[0].responseBodyExcerpt).toBe("bad request");
    });
  });
});
