import { assertEquals } from "@std/assert";
import { redactHeaders, serializeResponse } from "./pino-logger.ts";

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
