import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  gatewayProvenanceHeaders,
  withGatewayOperation,
  withGatewayProvenance,
} from "./gateway-provenance.ts";

/** Records the request a wrapped fetch produced, and answers with nothing. */
function recordingFetch(): {
  fetch: typeof fetch;
  headers: () => Headers;
} {
  let seen: Headers | undefined;
  return {
    // Parameters written out for the reason withGatewayProvenance gives:
    // `typeof fetch` yields an `init` whose `headers` cannot be read.
    fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
    headers: () => {
      if (seen === undefined) throw new Error("no request was made");
      return seen;
    },
  };
}

describe("gateway-provenance", () => {
  describe("gatewayProvenanceHeaders()", () => {
    it("names toolshed as the service", () => {
      const headers = gatewayProvenanceHeaders();
      expect(headers["x-cf-harness-service"]).toBe("toolshed");
    });

    it("opens the user agent with the product", () => {
      const headers = gatewayProvenanceHeaders();
      expect(headers["User-Agent"]).toMatch(/^toolshed \(/);
    });

    it("reports the operation it is given as the command", () => {
      const headers = gatewayProvenanceHeaders("web-search");
      expect(headers["x-cf-harness-command"]).toBe("web-search");
    });

    it("reports the operation of the surrounding scope", () => {
      const headers = withGatewayOperation(
        "generate-object",
        () => gatewayProvenanceHeaders(),
      );
      expect(headers["x-cf-harness-command"]).toBe("generate-object");
    });

    it("prefers the operation it is given to the surrounding scope", () => {
      const headers = withGatewayOperation(
        "generate-object",
        () => gatewayProvenanceHeaders("list-models"),
      );
      expect(headers["x-cf-harness-command"]).toBe("list-models");
    });

    it("reports no command outside an operation", () => {
      const headers = gatewayProvenanceHeaders();
      expect(headers).not.toHaveProperty("x-cf-harness-command");
    });

    it("reports the same session for every request of one process", () => {
      const first = gatewayProvenanceHeaders("generate-text");
      const second = gatewayProvenanceHeaders("list-models");
      expect(first["x-cf-harness-session"]).toBe(
        second["x-cf-harness-session"],
      );
    });
  });

  describe("withGatewayProvenance()", () => {
    it("attaches provenance to the request", async () => {
      const recorder = recordingFetch();
      await withGatewayProvenance(recorder.fetch)("https://gateway.invalid/");
      expect(recorder.headers().get("x-cf-harness-service")).toBe("toolshed");
    });

    it("keeps the headers the caller set", async () => {
      const recorder = recordingFetch();
      await withGatewayProvenance(recorder.fetch)("https://gateway.invalid/", {
        headers: { authorization: "Bearer gateway-internal" },
      });
      expect(recorder.headers().get("authorization")).toBe(
        "Bearer gateway-internal",
      );
    });

    it("replaces a user agent the caller set", async () => {
      const recorder = recordingFetch();
      await withGatewayProvenance(recorder.fetch)("https://gateway.invalid/", {
        headers: { "user-agent": "ai-sdk/openai/4.0.16" },
      });
      expect(recorder.headers().get("user-agent")).toMatch(/^toolshed \(/);
    });

    it("keeps the headers of a request it was handed", async () => {
      const recorder = recordingFetch();
      await withGatewayProvenance(recorder.fetch)(
        new Request("https://gateway.invalid/", {
          headers: { authorization: "Bearer gateway-internal" },
        }),
      );
      expect(recorder.headers().get("authorization")).toBe(
        "Bearer gateway-internal",
      );
    });

    it("prefers the headers of the init to those of the request", async () => {
      const recorder = recordingFetch();
      await withGatewayProvenance(recorder.fetch)(
        new Request("https://gateway.invalid/", {
          headers: { authorization: "Bearer from-request" },
        }),
        { headers: { authorization: "Bearer from-init" } },
      );
      expect(recorder.headers().get("authorization")).toBe("Bearer from-init");
    });

    it("refuses an init whose headers are no header list", () => {
      const recorder = recordingFetch();
      expect(() =>
        withGatewayProvenance(recorder.fetch)(
          new Request("https://gateway.invalid/", {
            headers: { authorization: "Bearer gateway-internal" },
          }),
          { headers: null as unknown as HeadersInit },
        )
      ).toThrow(TypeError);
    });

    it("reports the operation in hand when the request was made", async () => {
      const recorder = recordingFetch();
      const send = withGatewayProvenance(recorder.fetch);
      await withGatewayOperation(
        "generate-text",
        () => send("https://gateway.invalid/"),
      );
      expect(recorder.headers().get("x-cf-harness-command")).toBe(
        "generate-text",
      );
    });

    it("reports the operation across an await inside the scope", async () => {
      const recorder = recordingFetch();
      const send = withGatewayProvenance(recorder.fetch);
      await withGatewayOperation("generate-object", async () => {
        await Promise.resolve();
        await send("https://gateway.invalid/");
      });
      expect(recorder.headers().get("x-cf-harness-command")).toBe(
        "generate-object",
      );
    });
  });
});
