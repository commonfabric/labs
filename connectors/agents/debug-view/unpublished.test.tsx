import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import DebugView, {
  type AgentCommandValue,
  type DeferredDocument,
  RAW_SESSION_LOADING_TEXT,
  type SessionIndexInput,
  SessionRawView,
} from "./main.tsx";

const SESSION_INDEX = {
  schema: "commonfabric.agent-connector.session-index",
  bucket: "all",
  generatedAt: "2026-07-20T00:02:00.000Z",
  generation: 1,
  totalSessionCount: 3,
  olderSessionCount: 3,
  sources: [],
  sessions: [],
} satisfies SessionIndexInput;

export default pattern(() => {
  const allIndex = new Writable<SessionIndexInput | undefined>(undefined);
  const view = DebugView({
    ownerDid: "did:key:test-owner",
    recentIndex: undefined,
    allIndex,
    health: undefined,
    receipts: undefined,
    recentIndexCell: allIndex,
    allIndexCell: allIndex,
    healthCell: allIndex,
    commandsCell: new Writable<AgentCommandValue[]>([]),
    receiptsCell: allIndex,
  });
  const manifest = new Writable<DeferredDocument | undefined>(undefined);
  const rawView = SessionRawView({
    manifest,
    sourceId: "codex",
    nativeSessionId: "session-1",
  });

  // Until the host publishes, the view waits and counts no sources or
  // sessions. It counts the sessions a published complete index reports, and
  // none from a value that is not a session index.
  const assert_waiting = assert(() =>
    view.status === "waiting" && view.sourceCount === 0 &&
    view.sessionCount === 0
  );
  const action_publish_index = action(() => {
    allIndex.set(SESSION_INDEX);
  });
  const assert_published_sessions_counted = assert(() =>
    view.sessionCount === 3
  );
  const action_publish_other_schema = action(() => {
    allIndex.set({
      ...SESSION_INDEX,
      schema: "commonfabric.agent-connector.health",
    });
  });
  const assert_no_sessions_counted = assert(() => view.sessionCount === 0);

  // Loading a session whose manifest is unavailable fails, and the raw view
  // keeps showing its loading text.
  const assert_raw_session_loading = assert(() =>
    rawView.rawJson === RAW_SESSION_LOADING_TEXT
  );

  return {
    expectRuntimeErrors: ["session manifest is unavailable"],
    [TESTS]: [
      { assertion: assert_waiting },
      { action: action_publish_index },
      { assertion: assert_published_sessions_counted },
      { action: action_publish_other_schema },
      { assertion: assert_no_sessions_counted },
      { action: rawView.load },
      { assertion: assert_raw_session_loading },
    ],
    view,
  };
});
