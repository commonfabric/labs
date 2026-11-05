import { assertEquals } from "@std/assert";
import { APICallError, InvalidPromptError, RetryError } from "ai";

import env from "@/env.ts";
import {
  httpStatusForError,
  LLMRequestError,
  LLMUpstreamError,
} from "./errors.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

function providerFailure(statusCode: number): APICallError {
  return new APICallError({
    message: "provider said no",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    statusCode,
  });
}

//
// Wrapped and chained causes
//
// The routes ask the AI SDK for a single attempt, so these shapes do not
// reach the classifier from them. They are what the classifier sees if a call
// site ever asks for retries again, and the status has to survive however it
// is wrapped — including a cause graph that loops back on itself, which must
// not trap the search.
//

Deno.test("a status survives a retry wrapper", () => {
  const wrapped = new RetryError({
    message: "Failed after 3 attempts",
    reason: "maxRetriesExceeded",
    errors: [providerFailure(500), providerFailure(429)],
  });
  assertEquals(httpStatusForError(wrapped), 429);
});

Deno.test("a status survives a chain of causes", () => {
  const wrapped = new Error("wrapped", {
    cause: new Error("wrapped again", { cause: providerFailure(503) }),
  });
  assertEquals(httpStatusForError(wrapped), 503);
});

Deno.test("a cycle among causes does not trap the search", () => {
  const outer: { cause?: unknown } = new Error("outer");
  outer.cause = outer;
  assertEquals(httpStatusForError(outer), 500);
});

//
// Where a status comes from
//
// A status comes from the SDK raising over the request, from the service's
// own error types, or from the fallback for an error that names no origin.
//

Deno.test("a request the SDK would not send is the caller's mistake", () => {
  // The AI SDK raises these over what the caller sent, before any provider is
  // asked. Reporting them against the provider would send the caller looking in
  // the wrong place.

  assertEquals(
    httpStatusForError(
      new InvalidPromptError({
        prompt: {},
        message: "messages must not be empty",
      }),
    ),
    400,
  );
});

Deno.test("the error types carry their own classification", () => {
  assertEquals(httpStatusForError(new LLMRequestError("bad")), 400);
  assertEquals(httpStatusForError(new LLMUpstreamError("down")), 502);
  assertEquals(
    httpStatusForError(new LLMUpstreamError("busy", { upstreamStatus: 429 })),
    429,
  );
});

Deno.test("an error from nowhere in particular is this service's", () => {
  assertEquals(
    httpStatusForError(new TypeError("undefined is not a function")),
    500,
  );
  assertEquals(httpStatusForError("a string"), 500);
  assertEquals(httpStatusForError(undefined), 500);
});
