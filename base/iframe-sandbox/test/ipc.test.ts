import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type GuestError,
  IPCGuestMessageType,
  isBridgeHostMessage,
  isBridgeRequest,
  isGuestAlarm,
  isGuestError,
  isGuestFlush,
  isGuestPortRequest,
  isIPCGuestMessage,
} from "../src/ipc.ts";

const ERROR: GuestError = {
  description: "description",
  source: "source",
  lineno: 1,
  colno: 2,
  stacktrace: "stack",
};

const HEADER = {
  protocol: BRIDGE_PROTOCOL,
  version: BRIDGE_VERSION,
};

describe("ipc", () => {
  describe("bridge messages", () => {
    it("accepts complete request operations", () => {
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "describe",
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 1,
        operation: "disconnect",
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 2,
        operation: "initialize",
        resource: "count",
        path: [],
        value: 0,
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 3,
        operation: "set",
        resource: "count",
        path: ["nested", 0],
        value: 1,
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 4,
        operation: "call",
        resource: "database",
        method: "query",
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 5,
        operation: "push",
        resource: "items",
        path: [],
        values: [1, 2],
      })).toBe(true);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 6,
        operation: "sink",
        handle: "cell-1",
        path: ["title"],
        subscription: "s1",
      })).toBe(true);
    });

    it("rejects incomplete or foreign requests", () => {
      expect(isBridgeRequest(undefined)).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "call",
        resource: "database",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "pull",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "initialize",
        resource: "count",
        path: [],
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "initialize",
        resource: "count",
        path: [],
        value: undefined,
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "push",
        resource: "items",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        type: "request",
        id: 0,
        operation: "future-version",
      })).toBe(false);
      expect(isBridgeRequest({
        ...HEADER,
        version: BRIDGE_VERSION + 1,
        type: "request",
        id: 0,
        operation: "describe",
      })).toBe(false);
    });

    it("returns false for a request that is not typed, numbered, and named", () => {
      const describe = { ...HEADER, type: "request", id: 0 };
      expect(isBridgeRequest({ ...describe, operation: "describe" })).toBe(
        true,
      );
      expect(isBridgeRequest({
        ...describe,
        type: "response",
        operation: "describe",
      })).toBe(false);
      expect(isBridgeRequest({ ...describe, id: 0.5, operation: "describe" }))
        .toBe(false);
      expect(isBridgeRequest({ ...describe, id: "0", operation: "describe" }))
        .toBe(false);
      expect(isBridgeRequest({ ...describe, operation: 1 })).toBe(false);
    });

    it("accepts complete responses and subscription events", () => {
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 0,
        ok: true,
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 1,
        ok: false,
        error: { code: "failed", message: "No." },
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "event",
        subscription: "s1",
      })).toBe(true);
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "response",
        id: 1,
        ok: false,
      })).toBe(false);
    });

    it("returns false for a response without a whole-number id and a boolean ok", () => {
      const response = { ...HEADER, type: "response", id: 0, ok: true };
      expect(isBridgeHostMessage(response)).toBe(true);
      expect(isBridgeHostMessage({ ...response, id: 0.5 })).toBe(false);
      expect(isBridgeHostMessage({ ...response, id: undefined })).toBe(false);
      expect(isBridgeHostMessage({ ...response, ok: "true" })).toBe(false);
      expect(isBridgeHostMessage({ ...response, type: "request" })).toBe(
        false,
      );
    });

    it("accepts a flush acknowledgement only with its nonce", () => {
      expect(isBridgeHostMessage({
        ...HEADER,
        type: "flush",
        nonce: "n1",
      })).toBe(true);
      expect(isBridgeHostMessage({ ...HEADER, type: "flush" })).toBe(false);
      expect(isBridgeHostMessage({ type: "flush", nonce: "n1" })).toBe(false);
    });
  });

  describe("outer-frame messages", () => {
    it("recognizes lifecycle messages and complete errors", () => {
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Ready })).toBe(true);
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.Load })).toBe(true);
      expect(isIPCGuestMessage({
        type: IPCGuestMessageType.OuterError,
        data: ERROR,
      })).toBe(true);
      expect(isIPCGuestMessage({ type: IPCGuestMessageType.OuterError }))
        .toBe(false);
    });

    it("returns false for a message with no type or an unknown one", () => {
      expect(isIPCGuestMessage(undefined)).toBe(false);
      expect(isIPCGuestMessage("ready")).toBe(false);
      expect(isIPCGuestMessage({})).toBe(false);
      expect(isIPCGuestMessage({ type: "load-document" })).toBe(false);
      expect(isIPCGuestMessage({ type: "port-request" })).toBe(false);
    });

    it("recognizes only complete guest alarms", () => {
      expect(isGuestError(ERROR)).toBe(true);
      expect(isGuestError({ ...ERROR, lineno: "1" })).toBe(false);
      expect(isGuestAlarm({ type: "error", data: ERROR })).toBe(true);
      expect(isGuestAlarm({ type: "write", data: ERROR })).toBe(false);
    });

    it("recognizes only complete flush markers", () => {
      expect(isGuestFlush({ type: "flush", nonce: "n1" })).toBe(true);
      expect(isGuestFlush({ type: "flush" })).toBe(false);
      expect(isGuestFlush({ type: "error", nonce: "n1" })).toBe(false);
      expect(isGuestFlush("flush")).toBe(false);
    });

    it("recognizes port requests", () => {
      expect(isGuestPortRequest({ type: "port-request" })).toBe(true);
      expect(isGuestPortRequest({ type: "flush", nonce: "n1" })).toBe(false);
      expect(isGuestPortRequest("port-request")).toBe(false);
    });
  });
});
