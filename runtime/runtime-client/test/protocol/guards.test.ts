import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isIPCClientMessage,
  isIPCClientNotification,
  isIPCClientRequest,
} from "@/protocol/guards.ts";
import { ClientNotificationType, RequestType } from "@/protocol/types.ts";

describe("guards", () => {
  describe("isIPCClientRequest()", () => {
    it("returns true for an object whose type names a request type", () => {
      expect(isIPCClientRequest({ type: RequestType.Idle })).toBe(true);
    });

    it("returns false for an unknown type, a non-string type, or a non-object", () => {
      expect(isIPCClientRequest({ type: "no-such-request" })).toBe(false);
      expect(isIPCClientRequest({ type: 1 })).toBe(false);
      expect(isIPCClientRequest([RequestType.Idle])).toBe(false);
      expect(isIPCClientRequest(RequestType.Idle)).toBe(false);
    });
  });

  describe("isIPCClientMessage()", () => {
    it("returns true for a numeric msgId wrapping a request", () => {
      expect(isIPCClientMessage({ msgId: 0, data: { type: RequestType.Idle } }))
        .toBe(true);
    });

    it("returns false without a numeric msgId or a request inside", () => {
      expect(isIPCClientMessage({ data: { type: RequestType.Idle } })).toBe(
        false,
      );
      expect(
        isIPCClientMessage({ msgId: "0", data: { type: RequestType.Idle } }),
      ).toBe(false);
      expect(isIPCClientMessage({ msgId: 0, data: { type: "nope" } })).toBe(
        false,
      );
      expect(isIPCClientMessage(null)).toBe(false);
    });
  });

  describe("isIPCClientNotification()", () => {
    it("returns true for an object whose type names a client notification type", () => {
      for (const type of Object.values(ClientNotificationType)) {
        expect(isIPCClientNotification({ type })).toBe(true);
      }
    });

    it("returns false for a request type, a non-string type, or a non-object", () => {
      expect(isIPCClientNotification({ type: RequestType.Idle })).toBe(false);
      expect(isIPCClientNotification({ type: undefined })).toBe(false);
      expect(isIPCClientNotification([ClientNotificationType.VDomEvent]))
        .toBe(false);
      expect(isIPCClientNotification(undefined)).toBe(false);
    });
  });
});
