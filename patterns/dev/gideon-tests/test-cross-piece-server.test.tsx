/**
 * Test: the server's `incrementCounter` stream counts and logs each
 * invocation, and its view reports both.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-cross-piece-server.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import CrossPieceServer from "./test-cross-piece-server.tsx";

export default pattern(() => {
  const server = CrossPieceServer({ counter: 0, invocationLog: [] });

  const action_invoke = action(() => server.incrementCounter.send());

  return {
    [TESTS]: [
      { assertion: assert(() => server[NAME] === "Cross-Piece Test Server") },
      { assertion: assert(() => server.counter === 0) },
      { assertion: assert(() => server.invocationLog.length === 0) },
      { assertion: assert(() => hasText(server[UI], "Counter Value: 0")) },
      { assertion: assert(() => hasText(server[UI], "No invocations yet")) },
      { assertion: assert(() => countElements(server[UI], "li") === 0) },

      { action: action_invoke },
      { assertion: assert(() => server.counter === 1) },
      {
        assertion: assert(() =>
          server.invocationLog.length === 1 &&
          server.invocationLog[0].startsWith("Invoked at ")
        ),
      },
      { assertion: assert(() => hasText(server[UI], "Counter Value: 1")) },
      { assertion: assert(() => !hasText(server[UI], "No invocations yet")) },
      { assertion: assert(() => countElements(server[UI], "li") === 1) },

      { action: action_invoke },
      { assertion: assert(() => server.counter === 2) },
      { assertion: assert(() => server.invocationLog.length === 2) },
      { assertion: assert(() => countElements(server[UI], "li") === 2) },
    ],
    server,
  };
});
