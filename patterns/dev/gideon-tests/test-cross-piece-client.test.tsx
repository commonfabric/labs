/**
 * Test: the client reaches the server piece through
 * `wish({ query: "#crossPieceTestServer" })` once the server is a favorite,
 * and its "Invoke Server Stream" button sends to the server's
 * `incrementCounter` stream.
 *
 * The test favorites the server the way Home's `addFavorite` does: an entry
 * holding the piece and the discovery tags its schema declares.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-cross-piece-client.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import CrossPieceClient from "./test-cross-piece-client.tsx";
import CrossPieceServer from "./test-cross-piece-server.tsx";

interface Favorite {
  cell: unknown;
  tags: string[];
  userTags: string[];
}

export default pattern(() => {
  const server = CrossPieceServer({ counter: 0, invocationLog: [] });
  const client = CrossPieceClient({
    useCfRender: false,
    lastInvocationStatus: "Not invoked yet",
    invocationCount: 0,
  });
  const favorites = wish<Writable<Favorite[]>>({ query: "#favorites" });

  const action_favorite_server = action(() => {
    favorites.result?.push({
      cell: server,
      tags: ["crosspiecetestserver"],
      userTags: [],
    });
  });
  const action_invoke = action(() =>
    clickButton(client[UI], "Invoke Server Stream")
  );
  const action_toggle_mode = action(() =>
    clickButton(client[UI], "Toggle Mode")
  );

  return {
    [TESTS]: [
      { assertion: assert(() => client[NAME] === "Cross-Piece Test Client") },
      { assertion: assert(() => hasText(client[UI], "Not invoked yet")) },
      { assertion: assert(() => hasText(client[UI], "Mode A: Wish Only")) },
      {
        assertion: assert(() =>
          findElement(client[UI], "cf-render") === undefined
        ),
      },
      {
        assertion: assert(() => hasText(client[UI], "serverFound: false")),
      },

      // Before the server is a favorite, the wish finds nothing to send to.
      { action: action_invoke },
      {
        assertion: assert(() =>
          client.lastInvocationStatus ===
            "Stream not found: no favorite is tagged #crossPieceTestServer"
        ),
      },
      { assertion: assert(() => client.invocationCount === 0) },
      { assertion: assert(() => server.counter === 0) },

      { action: action_favorite_server },
      {
        assertion: assert(() => hasText(client[UI], "serverFound: true")),
      },
      { action: action_invoke },
      { assertion: assert(() => server.counter === 1) },
      { assertion: assert(() => server.invocationLog.length === 1) },
      { assertion: assert(() => client.invocationCount === 1) },
      {
        assertion: assert(() =>
          hasText(client[UI], "Success! Invoked the server stream 1 times")
        ),
      },

      { action: action_toggle_mode },
      { assertion: assert(() => client.useCfRender === true) },
      {
        assertion: assert(() =>
          hasText(client[UI], "Mode B: Wish + <cf-render>")
        ),
      },
      {
        assertion: assert(() =>
          findElement(client[UI], "cf-render") !== undefined
        ),
      },

      { action: action_toggle_mode },
      { assertion: assert(() => client.useCfRender === false) },
      {
        assertion: assert(() =>
          findElement(client[UI], "cf-render") === undefined
        ),
      },
    ],
    server,
    client,
  };
});
