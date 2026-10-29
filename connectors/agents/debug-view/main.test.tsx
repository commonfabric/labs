import {
  action,
  assert,
  type Cell,
  type OpaqueCell,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  findElementByText,
  findNode,
  propsOf,
  readValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import DebugView, {
  type AgentCommandValue,
  type HostActivity,
  type HostHealth,
  type MessagePreview,
  RAW_SESSION_LOADING_TEXT,
  type ReceiptIndex,
  type ReceiptRow,
  type SessionChunk,
  type SessionChunkDescriptor,
  type SessionIndex,
  type SessionManifest,
  SessionRawView,
  type SessionRow,
  type ShardedJsonValue,
  type SourceRow,
} from "./main.tsx";

const capabilities = {
  inventory: true,
  read: true,
  prompt: true,
  cancel: true,
  rename: true,
  setMode: false,
  setConfigOption: false,
};

function elementNamed(root: unknown, name: string): unknown | undefined {
  return findNode(root, (node) =>
    typeof node === "object" && node !== null &&
    (node as { name?: unknown }).name === name);
}

/** Picks the command type in the composer's select. */
function setCommandType(root: unknown, next: string): void {
  const form = elementNamed(root, "cf-form");
  const field = findNode(
    form,
    (node) => readValue(propsOf(node)?.label) === "Command",
  );
  const value = propsOf(elementNamed(field, "cf-select"))?.["$value"];
  if (typeof value === "object" && value !== null && "set" in value) {
    (value as { set: (next: string) => void }).set(next);
  }
}

/** Ticks or clears the composer's force checkbox. */
function setForce(root: unknown, next: boolean): void {
  const form = elementNamed(root, "cf-form");
  const checkbox = findNode(
    form,
    (node) =>
      propsOf(node)?.["$checked"] !== undefined &&
      textContent(node).includes("forced"),
  );
  const checked = propsOf(checkbox)?.["$checked"];
  if (typeof checked === "object" && checked !== null && "set" in checked) {
    (checked as { set: (next: boolean) => void }).set(next);
  }
}

function countCellLinks(
  root: unknown,
  label: string,
  visited = new Set<object>(),
): number {
  const value = readValue(root);
  if (typeof value !== "object" || value === null) return 0;
  if (visited.has(value)) return 0;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.reduce(
      (count, child) => count + countCellLinks(child, label, visited),
      0,
    );
  }
  const current = (value as { name?: unknown }).name === "cf-cell-link" &&
      readValue(propsOf(value)?.label) === label
    ? 1
    : 0;
  return current + childNodes(value).reduce<number>(
    (count, child) => count + countCellLinks(child, label, visited),
    0,
  );
}

const NativeEventFixture = pattern<void, ShardedJsonValue>(() => ({
  id: "message-1",
  text: "Done",
}));

const EventChunkFixture = pattern<
  { nativeEvent: Cell<ShardedJsonValue> },
  SessionChunk
>(({ nativeEvent }) => ({
  schema: "commonfabric.agent-connector.session-chunk",
  ownerDid: "did:key:test-owner",
  key: "codex/session-1",
  part: 0,
  contentHash: "sha256:chunk",
  events: [nativeEvent],
}));

const ChunkDescriptorFixture = pattern<
  { eventChunk: Cell<SessionChunk> },
  SessionChunkDescriptor
>(({ eventChunk }) => ({
  part: 0,
  link: eventChunk,
  contentHash: "sha256:chunk",
  byteLength: 32,
  eventCount: 1,
}));

const MessageFixture = pattern<void, MessagePreview>(() => ({
  id: "message-1",
  role: "assistant",
  kind: "message",
  createdAt: "2026-07-20T00:01:00.000Z",
  textPreview: "Done",
  rawIndex: 0,
}));

const ManifestFixture = pattern<
  {
    chunkDescriptor: Cell<SessionChunkDescriptor>;
    message: Cell<MessagePreview>;
  },
  SessionManifest
>(({ chunkDescriptor, message }) => ({
  schema: "commonfabric.agent-connector.session",
  ownerDid: "did:key:test-owner",
  key: "codex/session-1",
  sourceId: "codex",
  driver: "codex-app-server",
  nativeSessionId: "session-1",
  metadata: { id: "session-1" },
  summary: { nativeSessionId: "session-1", title: "Debug session" },
  normalized: { messages: [message] },
  chunks: [chunkDescriptor],
  snapshotHash: "sha256:session",
  revision: "1",
  observedAt: "2026-07-20T00:02:00.000Z",
  complete: true,
}));

const SourceFixture = pattern<void, SourceRow>(() => ({
  id: "codex",
  driver: "codex-app-server",
  enabled: true,
  status: "ready",
  capabilities,
  sessionCount: 1,
  complete: true,
  errors: [],
}));

const ActivityFixture = pattern<
  { id: string; message: string },
  HostActivity
>(({ id, message }) => ({
  id,
  at: "2026-07-20T00:02:00.000Z",
  type: "sync-completed",
  message,
}));

const SessionFixture = pattern<
  {
    manifest: OpaqueCell<SessionManifest> & SessionManifest;
    message: Cell<MessagePreview>;
    key: string;
    nativeSessionId: string;
    title: string;
    archived: boolean | null;
    active: boolean | null;
    syncStatus: SessionRow["syncStatus"];
  },
  SessionRow
>(({
  manifest,
  message,
  key,
  nativeSessionId,
  title,
  archived,
  active,
  syncStatus,
}) => ({
  key,
  sourceId: "codex",
  driver: "codex-app-server",
  nativeSessionId,
  title,
  cwd: "/work",
  gitRepo: "example/repo",
  gitBranch: "main",
  gitWorktreeRoot: "/work",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:01:00.000Z",
  archived,
  active,
  capabilities,
  recentMessages: [message],
  manifest,
  contentHash: "sha256:session",
  syncStatus,
}));

const IndexFixture = pattern<
  {
    bucket: "recent" | "all";
    source: OpaqueCell<SourceRow> & SourceRow;
    firstSession: OpaqueCell<SessionRow> & SessionRow;
    secondSession: OpaqueCell<SessionRow> & SessionRow;
    sessionCount: number;
  },
  SessionIndex
>(({ bucket, source, firstSession, secondSession, sessionCount }) => ({
  schema: "commonfabric.agent-connector.session-index",
  bucket,
  generatedAt: "2026-07-20T00:02:00.000Z",
  generation: 1,
  totalSessionCount: sessionCount,
  olderSessionCount: 0,
  sources: [source],
  sessions: sessionCount === 0
    ? bucket === "all" ? [firstSession] : []
    : sessionCount === 1
    ? [firstSession]
    : [firstSession, secondSession],
}));

const HealthFixture = pattern<
  {
    status: string;
    source: Cell<SourceRow>;
    firstActivity: Cell<HostActivity>;
    secondActivity: Cell<HostActivity>;
    activityCount: number;
    commandAccepting: boolean;
  },
  HostHealth
>((
  {
    status,
    source,
    firstActivity,
    secondActivity,
    activityCount,
    commandAccepting,
  },
) => ({
  schema: "commonfabric.agent-connector.health",
  ownerDid: "did:key:test-owner",
  service: "agents-host",
  status,
  startedAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:02:00.000Z",
  target: {
    spaceDid: "did:key:space",
    debugPieceId: "debug-piece",
    cells: {
      recentIndex: "recent-cell",
      allIndex: "all-cell",
      health: "health-cell",
      commands: "commands-cell",
      receipts: "receipts-cell",
    },
  },
  commandProcessing: {
    accepting: commandAccepting,
    pendingReceiptPublications: 0,
    failedCommands: 0,
  },
  sync: {
    reason: "startup",
    status: "complete",
    startedAt: "2026-07-20T00:01:00.000Z",
    completedAt: "2026-07-20T00:02:00.000Z",
    sessionCount: 1,
  },
  sources: [source],
  activity: activityCount === 1
    ? [firstActivity]
    : [firstActivity, secondActivity],
}));

const ReceiptFixture = pattern<void, ReceiptRow>(() => ({
  commandId: "command-1",
  sourceId: "codex",
  nativeSessionId: "session-1",
  status: "succeeded",
  updatedAt: "2026-07-20T00:04:00.000Z",
  receipt: {
    id: "receipt-cell",
    space: "did:key:space",
    path: [],
  },
}));

const ReceiptIndexFixture = pattern<
  { receipt: Cell<ReceiptRow>; receiptCount: number },
  ReceiptIndex
>(({ receipt, receiptCount }) => ({
  schema: "commonfabric.agent-connector.command-receipts",
  ownerDid: "did:key:test-owner",
  updatedAt: "2026-07-20T00:04:00.000Z",
  receipts: receiptCount === 0 ? [] : [receipt],
}));

export default pattern(() => {
  const nativeEvent = NativeEventFixture();
  const eventChunk = EventChunkFixture({ nativeEvent });
  const chunkDescriptor = ChunkDescriptorFixture({ eventChunk });
  const message = MessageFixture();
  const manifest = ManifestFixture({ chunkDescriptor, message });
  const source = SourceFixture();
  const firstActivity = ActivityFixture({
    id: "activity-1",
    message: "Full collection completed",
  });
  const secondActivity = ActivityFixture({
    id: "activity-2",
    message: "Incremental collection completed",
  });
  const firstSessionSync = new Writable<SessionRow["syncStatus"]>("complete");
  const firstSession = SessionFixture({
    manifest,
    message,
    key: "codex/session-1",
    nativeSessionId: "session-1",
    title: "Debug session",
    archived: false,
    active: true,
    syncStatus: firstSessionSync,
  });
  const secondSession = SessionFixture({
    manifest,
    message,
    key: "codex/session-2",
    nativeSessionId: "session-2",
    title: "Second session",
    archived: null,
    active: null,
    syncStatus: "complete",
  });
  const receipt = ReceiptFixture();
  const status = new Writable("ready");
  const commandAccepting = new Writable(true);
  const commands = new Writable<AgentCommandValue[]>([]);
  const activityCount = new Writable(1);
  const receiptCount = new Writable(0);
  const publishedSessionCount = new Writable(1);
  const recentIndex = IndexFixture({
    bucket: "recent",
    source,
    firstSession,
    secondSession,
    sessionCount: publishedSessionCount,
  });
  const allIndex = IndexFixture({
    bucket: "all",
    source,
    firstSession,
    secondSession,
    sessionCount: publishedSessionCount,
  });
  const health = HealthFixture({
    status,
    source,
    firstActivity,
    secondActivity,
    activityCount,
    commandAccepting,
  });
  const receipts = ReceiptIndexFixture({ receipt, receiptCount });
  const rawView = SessionRawView({
    manifest,
    sourceId: "codex",
    nativeSessionId: "session-1",
  });
  const view = DebugView({
    ownerDid: "did:key:test-owner",
    recentIndex,
    allIndex,
    health,
    receipts,
    recentIndexCell: recentIndex,
    allIndexCell: allIndex,
    healthCell: health,
    commandsCell: commands,
    receiptsCell: receipts,
  });

  const assert_initial_summary = assert(() =>
    view.status === "ready" &&
    view.sourceCount === 1 &&
    view.sessionCount === 1 &&
    view.commandCount === 0 &&
    view.receiptCount === 0 &&
    view.activityCount === 1
  );
  const assert_raw_session_loading = assert(() =>
    rawView.rawJson === RAW_SESSION_LOADING_TEXT
  );
  const assert_raw_session_provenance = assert(() => {
    const provenance = rawView.provenance;
    const disclosure = findElementByText(
      rawView[UI],
      "details",
      "Where this data comes from",
    );
    const summary = findElementByText(
      rawView[UI],
      "summary",
      "Where this data comes from",
    );
    const summaryHeading = findElementByText(
      summary,
      "cf-heading",
      "Where this data comes from",
    );
    const retrievalCode = findElementByText(
      rawView[UI],
      "code",
      provenance.retrievalCommand,
    );
    const retrievalStyle = readValue(propsOf(retrievalCode)?.style) as
      | Record<string, unknown>
      | undefined;
    const rendered = textContent(rawView[UI]);
    return provenance.origin.includes('connector source "codex"') &&
      provenance.origin.includes('native session "session-1"') &&
      provenance.fabric.space.startsWith("did:key:") &&
      provenance.fabric.entity.includes("fid1:") &&
      provenance.retrievalCommand.includes("inspect pull") &&
      provenance.retrievalCommand.includes("--force") &&
      provenance.retrievalCommand.includes("inspect history") &&
      provenance.retrievalCommand.includes("cf inspect value-at") &&
      provenance.retrievalCommand.includes("--full-depth") &&
      provenance.retrievalCommand.includes("--seq REVISION_SEQ") &&
      provenance.retrievalCommand.includes("--seq LINK_REVISION_SEQ") &&
      provenance.retrievalCommand.includes(
        "Do not reuse root REVISION_SEQ without checking",
      ) &&
      provenance.retrievalCommand.includes(
        "Resolve relative links against the cell containing them",
      ) &&
      provenance.retrievalCommand.includes("--scope 'LINK_SCOPE_KEY'") &&
      !provenance.retrievalCommand.includes(
        "--scope '<resolved $link.scope>'",
      ) &&
      provenance.retrievalCommand.includes("every $link in the manifest") &&
      provenance.retrievalCommand.includes("chunk descriptor") &&
      provenance.retrievalSetup.includes(
        "ENV must be development, test, or staging",
      ) &&
      provenance.retrievalSetup.includes(
        "MEMORY_DUMP_ENABLED must be true",
      ) &&
      provenance.retrievalSetup.includes("MEMORY_DUMP_DIDS") &&
      provenance.retrievalSetup.includes(
        "--seq flag keeps the reconstruction stable",
      ) &&
      provenance.providerRetrieval?.includes(
          "reads the producing driver from the session manifest",
        ) === true &&
      rendered.includes("Where this data comes from") &&
      rendered.includes("Retrieve it independently") &&
      rendered.includes("Retrieve it from the provider") &&
      disclosure !== undefined &&
      propsOf(disclosure)?.open === undefined &&
      summary !== undefined &&
      readValue(propsOf(summaryHeading)?.level) === 4 &&
      retrievalStyle?.background ===
        "var(--cf-theme-color-surface-inverse, #16181d)" &&
      retrievalStyle?.color ===
        "var(--cf-theme-color-text-on-inverse, #ffffff)";
  });
  const assert_loaded_session_provenance = assert(() =>
    rawView.provenance.providerRetrieval?.includes('"thread/read"') === true &&
    rawView.provenance.providerRetrieval?.includes('"includeTurns":true') ===
      true
  );
  const assert_raw_session_data = assert(() =>
    rawView.rawJson.includes('"nativeSessionId": "session-1"') &&
    rawView.rawJson.includes('"text": "Done"')
  );

  const action_publish_changes = action(() => {
    firstSessionSync.set("deleted");
    publishedSessionCount.set(0);
    status.set("degraded");
    activityCount.set(2);
    receiptCount.set(1);
  });

  const assert_updated_status = assert(() => view.status === "degraded");
  const assert_updated_sessions = assert(() => view.sessionCount === 0);
  const assert_updated_commands = assert(() => view.commandCount === 0);
  const assert_updated_receipts = assert(() => view.receiptCount === 1);
  const assert_updated_activity = assert(() => view.activityCount === 2);

  const action_select_command_target = action(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Command",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });
  const action_enter_prompt = action(() => {
    const form = elementNamed(view[UI], "cf-form");
    const textarea = elementNamed(form, "cf-textarea");
    const value = propsOf(textarea)?.["$value"];
    if (typeof value === "object" && value !== null && "set" in value) {
      (value as { set: (next: string) => void }).set(
        "Continue from the debug view",
      );
    }
  });
  const action_review_command = action(() => {
    const form = elementNamed(view[UI], "cf-form");
    const onSubmit = propsOf(form)?.["oncf-submit"];
    if (
      typeof onSubmit === "object" && onSubmit !== null && "send" in onSubmit
    ) {
      (onSubmit as { send: (event: Record<string, never>) => void }).send({});
    }
  });
  const assert_command_target = assert(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Command",
    );
    const form = elementNamed(view[UI], "cf-form");
    const source = elementNamed(form, "cf-select");
    const session = elementNamed(form, "cf-input");
    return readValue(propsOf(button)?.["aria-label"]) ===
        "Compose command for Debug session (codex)" &&
      readValue(propsOf(source)?.["$value"]) === "codex" &&
      readValue(propsOf(session)?.["$value"]) === "session-1";
  });
  const assert_empty_prompt_rejected = assert(() => {
    const modal = elementNamed(view[UI], "cf-modal");
    const alert = findNode(
      view[UI],
      (node) =>
        readValue(propsOf(node)?.role) === "alert" &&
        textContent(node).includes("Enter a prompt."),
    );
    return view.commandCount === 0 &&
      readValue(propsOf(modal)?.["$open"]) === false &&
      alert !== undefined;
  });
  const assert_command_prepared = assert(() => {
    const form = elementNamed(view[UI], "cf-form");
    const textarea = elementNamed(form, "cf-textarea");
    return readValue(propsOf(textarea)?.["$value"]) ===
      "Continue from the debug view";
  });
  const assert_command_review = assert(() => {
    const modal = elementNamed(view[UI], "cf-modal");
    const review = textContent(modal);
    return view.commandCount === 0 &&
      readValue(propsOf(modal)?.["$open"]) === true &&
      review.includes('"ownerDid": "did:key:test-owner"') &&
      review.includes('"sourceId": "codex"') &&
      review.includes('"nativeSessionId": "session-1"') &&
      review.includes('"type": "prompt"') &&
      review.includes('"text": "Continue from the debug view"');
  });
  // A start drafts like a prompt and carries the force flag when asked.
  const action_prepare_forced_start = action(() => {
    setCommandType(view[UI], "start");
    setForce(view[UI], true);
  });
  const assert_forced_start_review = assert(() => {
    const modal = elementNamed(view[UI], "cf-modal");
    const review = textContent(modal);
    return review.includes('"type": "start"') &&
      review.includes('"text": "Continue from the debug view"') &&
      review.includes('"force": true');
  });
  const action_restore_prompt = action(() => {
    setCommandType(view[UI], "prompt");
    setForce(view[UI], false);
  });
  const action_send_command = action(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Send command",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });
  const action_stop_command_admission = action(() => {
    commandAccepting.set(false);
  });
  const action_resume_command_admission = action(() => {
    commandAccepting.set(true);
  });
  const assert_command_send_disabled = assert(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Send command",
    );
    return readValue(propsOf(button)?.disabled) === true;
  });
  const assert_stopped_command_rejected = assert(() => {
    const modal = elementNamed(view[UI], "cf-modal");
    return view.commandCount === 0 &&
      readValue(propsOf(modal)?.["$open"]) === true &&
      textContent(modal).includes("The host is not accepting commands.");
  });
  const assert_command_sent = assert(() => {
    const form = elementNamed(view[UI], "cf-form");
    const textarea = elementNamed(form, "cf-textarea");
    const modal = elementNamed(view[UI], "cf-modal");
    const statusMessage = findNode(
      view[UI],
      (node) =>
        readValue(propsOf(node)?.role) === "status" &&
        textContent(node).includes("Submitted debug:"),
    );
    return view.commandCount === 1 &&
      readValue(propsOf(modal)?.["$open"]) === false &&
      readValue(propsOf(textarea)?.["$value"]) === "" &&
      statusMessage !== undefined;
  });
  const action_publish_invalid_command = action(() => {
    commands.push("not command JSON");
  });
  const assert_invalid_command_visible = assert(() => {
    const commandTable = findElementByText(view[UI], "cf-table", "Payload");
    return view.commandCount === 2 &&
      textContent(commandTable).includes("Invalid action value") &&
      !textContent(commandTable).includes("not command JSON") &&
      countCellLinks(commandTable, "Raw data") === 2;
  });
  const action_publish_nested_array_command = action(() => {
    commands.push([["nested invalid action"]]);
  });
  const assert_nested_array_command_visible = assert(() => {
    const commandTable = findElementByText(view[UI], "cf-table", "Payload");
    return view.commandCount === 3 &&
      !textContent(commandTable).includes("nested invalid action") &&
      countCellLinks(commandTable, "Raw data") === 3;
  });

  return {
    [TESTS]: [
      { assertion: assert_initial_summary },
      { assertion: assert_raw_session_loading },
      { assertion: assert_raw_session_provenance },
      { action: rawView.load },
      { assertion: assert_raw_session_data },
      { assertion: assert_loaded_session_provenance },
      { action: action_publish_changes },
      { assertion: assert_updated_status },
      { assertion: assert_updated_sessions },
      { assertion: assert_updated_commands },
      { assertion: assert_updated_receipts },
      { assertion: assert_updated_activity },
      { action: action_select_command_target },
      { assertion: assert_command_target },
      { action: action_review_command },
      { assertion: assert_empty_prompt_rejected },
      { action: action_enter_prompt },
      { assertion: assert_command_prepared },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_prepare_forced_start },
      { action: action_review_command },
      { assertion: assert_forced_start_review },
      { action: action_restore_prompt },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_stop_command_admission },
      { assertion: assert_command_send_disabled },
      { action: action_send_command },
      { assertion: assert_stopped_command_rejected },
      { action: action_resume_command_admission },
      { action: action_send_command },
      { assertion: assert_command_sent },
      { action: action_publish_invalid_command },
      { assertion: assert_invalid_command_visible },
      { action: action_publish_nested_array_command },
      { assertion: assert_nested_array_command_visible },
    ],
    view,
  };
});
