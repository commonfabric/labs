import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ErrorNotification,
  EventEmitter,
  NotificationType,
  RuntimeConnection,
  type RuntimeTransport,
} from "@commonfabric/runtime-client";
import type {
  IPCClientMessage,
  IPCRemoteMessage,
} from "@commonfabric/runtime-client";

/**
 * Tests that error notifications sent from the worker (via IPC)
 * arrive at the shell with correct stack traces.
 *
 * This simulates the production flow:
 * Pattern error → scheduler.handleError → postMessage(ErrorNotification)
 *   → RuntimeConnection → shell's #onError handler
 */

type TransportEvents = { message: [IPCRemoteMessage] };

class MockTransport extends EventEmitter<TransportEvents>
  implements RuntimeTransport {
  send(_data: IPCClientMessage): void {}
  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Simulates receiving a message from the worker. */
  simulateMessage(msg: IPCRemoteMessage): void {
    this.emit("message", msg);
  }
}

describe("Error IPC propagation", () => {
  it("receives ErrorNotification with stack trace from worker", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let receivedError: ErrorNotification | null = null;
    connection.on("error", (err) => {
      receivedError = err;
    });

    const sourceMapppedStack = `Error: something broke
    at myFunction (pattern.ts:10:5)
    at processData (utils.ts:25:12)
    at <CF_INTERNAL>`;

    // Simulate the worker sending an ErrorNotification
    transport.simulateMessage({
      type: NotificationType.ErrorReport,
      message: "something broke",
      pieceId: "piece-123",
      space: "did:key:z6Mktest",
      patternId: "pattern-456",
      stackTrace: sourceMapppedStack,
    });

    expect(receivedError).not.toBeNull();
    expect(receivedError!.message).toBe("something broke");
    expect(receivedError!.pieceId).toBe("piece-123");
    expect(receivedError!.stackTrace).toBeDefined();
    expect(receivedError!.stackTrace).toContain("pattern.ts:10:5");
    expect(receivedError!.stackTrace).toContain("myFunction");
    expect(receivedError!.stackTrace).toContain("utils.ts:25:12");
  });

  it("propagates stack trace with original source locations, not compiled hashes", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let receivedError: ErrorNotification | null = null;
    connection.on("error", (err) => {
      receivedError = err;
    });

    // This is what a GOOD source-mapped stack looks like after transformation
    const goodStack = `Error: user code error
    at validateInput (validator.ts:15:10)
    at processForm (form-handler.ts:42:3)
    at <CF_INTERNAL>
    at <CF_INTERNAL>`;

    transport.simulateMessage({
      type: NotificationType.ErrorReport,
      message: "user code error",
      stackTrace: goodStack,
    });

    expect(receivedError).not.toBeNull();
    const stack = receivedError!.stackTrace!;

    // Stack should contain original .ts file references
    expect(stack).toContain("validator.ts:15:10");
    expect(stack).toContain("form-handler.ts:42:3");

    // Should NOT contain compiled hash-based filenames
    expect(stack).not.toMatch(
      /ba[a-z0-9]{50,}\.js/,
    );
  });

  it("handles ErrorNotification with missing stack trace", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let receivedError: ErrorNotification | null = null;
    connection.on("error", (err) => {
      receivedError = err;
    });

    transport.simulateMessage({
      type: NotificationType.ErrorReport,
      message: "error without stack",
    });

    expect(receivedError).not.toBeNull();
    expect(receivedError!.message).toBe("error without stack");
    expect(receivedError!.stackTrace).toBeUndefined();
  });

  it("handles ErrorNotification with untransformed stack (raw compiled)", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let receivedError: ErrorNotification | null = null;
    connection.on("error", (err) => {
      receivedError = err;
    });

    // This is what a BAD (untransformed) stack looks like - hash filenames
    const rawStack =
      `Error: something broke\n    at Object.eval [as factory] (ba4jcbcoh3wqzgaq3x6v36c625ycvssvqewtr563cg2osp66t4jzls7cb.js, <anonymous>:1:1234)\n    at Loader.resolveModule (ba4jcbcoh3wqzgaq3x6v36c625ycvssvqewtr563cg2osp66t4jzls7cb.js, <anonymous>:1:5678)`;

    transport.simulateMessage({
      type: NotificationType.ErrorReport,
      message: "something broke",
      stackTrace: rawStack,
    });

    expect(receivedError).not.toBeNull();

    // The stack arrives as-is (the transformation should have happened in the worker).
    // This test documents that if source mapping fails, the raw stack is still delivered.
    expect(receivedError!.stackTrace).toContain("something broke");
    expect(receivedError!.stackTrace).toBeDefined();
  });
});
