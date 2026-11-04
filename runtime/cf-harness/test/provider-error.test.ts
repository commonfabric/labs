import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  describeProviderError,
  isTransientHttpStatus,
  isTransientProviderError,
  mapProviderError,
  providerErrorFromJsonText,
  providerErrorFromPayload,
} from "../src/model/provider-error.ts";

describe("provider-error", () => {
  describe("providerErrorFromPayload()", () => {
    it("reads type, code, and message from a nested `error` object", () => {
      expect(providerErrorFromPayload({
        type: "error",
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message:
            "Our servers are currently overloaded. Please try again later.",
        },
      })).toEqual({
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message:
          "Our servers are currently overloaded. Please try again later.",
      });
    });

    it("reads a top-level code and message, leaving out a `type` that names the event", () => {
      expect(providerErrorFromPayload({
        type: "error",
        code: "rate_limit_exceeded",
        message: "slow down",
        sequence_number: 3,
      })).toEqual({ code: "rate_limit_exceeded", message: "slow down" });
    });

    it("keeps a top-level `type` that is not the event's", () => {
      expect(providerErrorFromPayload({
        type: "server_error",
        message: "boom",
      })).toEqual({ type: "server_error", message: "boom" });
    });

    it("returns `undefined` for a payload that states no message", () => {
      expect(providerErrorFromPayload({ error: { code: "x" } }))
        .toBeUndefined();
      expect(providerErrorFromPayload({ error: "down" })).toBeUndefined();
      expect(providerErrorFromPayload("down")).toBeUndefined();
      expect(providerErrorFromPayload(null)).toBeUndefined();
    });

    it("leaves out an empty type or code", () => {
      expect(providerErrorFromPayload({
        error: { type: "", code: "", message: "m" },
      })).toEqual({ message: "m" });
    });
  });

  describe("providerErrorFromJsonText()", () => {
    it("parses a JSON body that carries an error object", () => {
      expect(providerErrorFromJsonText(
        '{"error":{"type":"server_error","message":"down"}}',
      )).toEqual({ type: "server_error", message: "down" });
    });

    it("returns `undefined` for text that is not JSON", () => {
      expect(providerErrorFromJsonText("<html>502</html>")).toBeUndefined();
      expect(providerErrorFromJsonText("")).toBeUndefined();
    });
  });

  describe("describeProviderError()", () => {
    it("renders type and code ahead of the message", () => {
      expect(describeProviderError({
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message: "overloaded",
      })).toBe("service_unavailable_error / server_is_overloaded: overloaded");
    });

    it("renders whichever of type or code is present", () => {
      expect(describeProviderError({ code: "c", message: "m" })).toBe("c: m");
      expect(describeProviderError({ type: "t", message: "m" })).toBe("t: m");
    });

    it("renders the message alone when neither type nor code is present", () => {
      expect(describeProviderError({ message: "m" })).toBe("m");
    });
  });

  describe("mapProviderError()", () => {
    it("applies the mapping to every field that is present", () => {
      expect(mapProviderError(
        { type: "t-secret", code: "c-secret", message: "m-secret" },
        (text) => text.replace("secret", "[redacted]"),
      )).toEqual({
        type: "t-[redacted]",
        code: "c-[redacted]",
        message: "m-[redacted]",
      });
      expect(mapProviderError({ message: "m" }, (text) => text.toUpperCase()))
        .toEqual({ message: "M" });
    });
  });

  describe("isTransientProviderError()", () => {
    it("returns `true` for a transient type or code", () => {
      expect(isTransientProviderError({
        type: "service_unavailable_error",
        message: "m",
      })).toBe(true);
      expect(isTransientProviderError({
        code: "server_is_overloaded",
        message: "m",
      })).toBe(true);
      expect(isTransientProviderError({
        type: "invalid_request_error",
        code: "rate_limit_exceeded",
        message: "m",
      })).toBe(true);
    });

    it("returns `false` for an error that states neither a transient type nor a transient code", () => {
      expect(isTransientProviderError({
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "overloaded",
      })).toBe(false);
      expect(isTransientProviderError({ message: "server_is_overloaded" }))
        .toBe(false);
    });
  });

  describe("isTransientHttpStatus()", () => {
    it("returns `true` for 429 and every 5xx status", () => {
      expect(isTransientHttpStatus(429)).toBe(true);
      expect(isTransientHttpStatus(500)).toBe(true);
      expect(isTransientHttpStatus(503)).toBe(true);
      expect(isTransientHttpStatus(599)).toBe(true);
    });

    it("returns `false` for every other status", () => {
      expect(isTransientHttpStatus(400)).toBe(false);
      expect(isTransientHttpStatus(401)).toBe(false);
      expect(isTransientHttpStatus(404)).toBe(false);
      expect(isTransientHttpStatus(200)).toBe(false);
    });
  });
});
