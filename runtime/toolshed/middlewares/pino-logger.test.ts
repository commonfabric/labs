import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  redactHeaders,
  serializeRequest,
  serializeResponse,
} from "./pino-logger.ts";

Deno.test("redactHeaders removes sensitive Headers values", () => {
  assertEquals(
    redactHeaders(
      new Headers({
        authorization: "Bearer secret",
        "CF-Request-Auth": "signed authentication",
        "cf-request-proof": "replayable proof",
        cookie: "session=secret",
        "set-cookie": "session=response-secret",
        "user-agent": "diagnostic-browser",
      }),
    ),
    {
      authorization: "[redacted]",
      "cf-request-auth": "[redacted]",
      "cf-request-proof": "[redacted]",
      cookie: "[redacted]",
      "set-cookie": "[redacted]",
      "user-agent": "diagnostic-browser",
    },
  );
});

Deno.test("redactHeaders handles plain objects case-insensitively", () => {
  assertEquals(
    redactHeaders({
      Authorization: "Bearer secret",
      "CF-Request-Auth": "signed authentication",
      "cF-ReQuEsT-PrOoF": "replayable proof",
      "Proxy-Authorization": "Basic secret",
      "Set-Cookie": "session=secret",
      accept: "application/json",
    }),
    {
      Authorization: "[redacted]",
      "CF-Request-Auth": "[redacted]",
      "cF-ReQuEsT-PrOoF": "[redacted]",
      "Proxy-Authorization": "[redacted]",
      "Set-Cookie": "[redacted]",
      accept: "application/json",
    },
  );
});

Deno.test("redactHeaders preserves non-header values", () => {
  assertEquals(redactHeaders(undefined), undefined);
  assertEquals(redactHeaders(null), null);
  assertEquals(redactHeaders("headers unavailable"), "headers unavailable");
  assertEquals(redactHeaders([]), []);
});

Deno.test("response serializer redacts sensitive headers", () => {
  assertEquals(
    serializeResponse({
      statusCode: 200,
      headers: new Headers({
        "content-type": "application/json",
        "set-cookie": "session=response-secret",
      }),
    }),
    {
      status: 200,
      headers: JSON.stringify({
        "content-type": "application/json",
        "set-cookie": "[redacted]",
      }),
    },
  );
});

describe("request and response serializers", () => {
  const request = {
    method: "POST",
    url: "/api/storage/memory",
    headers: { authorization: "Bearer secret", accept: "application/json" },
  };
  const redacted = { authorization: "[redacted]", accept: "application/json" };

  it("returns `undefined` for a request and a response when DISABLE_LOG_REQ_RES is set", () => {
    expect(
      serializeResponse({ statusCode: 200, headers: {} }, {
        DISABLE_LOG_REQ_RES: true,
      }),
    ).toBeUndefined();
    expect(
      serializeRequest(request, { DISABLE_LOG_REQ_RES: true, ENV: "test" }),
    ).toBeUndefined();
  });

  it("returns a request's redacted headers as a JSON string outside production", () => {
    expect(
      serializeRequest(request, { DISABLE_LOG_REQ_RES: false, ENV: "test" }),
    ).toEqual({
      method: "POST",
      url: "/api/storage/memory",
      headers: JSON.stringify(redacted),
    });
  });

  it("returns a request's redacted headers as an object in production", () => {
    expect(
      serializeRequest(request, {
        DISABLE_LOG_REQ_RES: false,
        ENV: "production",
      }),
    ).toEqual({
      method: "POST",
      url: "/api/storage/memory",
      headers: redacted,
    });
  });
});
