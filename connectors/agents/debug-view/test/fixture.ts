/**
 * The published cells the debug view's pattern tests render, and the helpers
 * those tests use to drive and read the rendered view.
 *
 * Each test file instantiates `DebugViewFixture` for its own copy of the cells
 * and walks `view[UI]` with the helpers below.
 */

import {
  type Cell,
  type OpaqueCell,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  findElementByText,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  propsOf,
  readValue,
  textContent,
} from "../../../../patterns/tools/test-support/vnode-helpers.ts";
import DebugView, {
  type AgentCommandValue,
  type DebugOutput,
  type HostActivity,
  type HostHealth,
  type MessagePreview,
  type ReceiptIndex,
  type ReceiptRow,
  type SessionChunk,
  type SessionChunkDescriptor,
  type SessionIndex,
  type SessionManifest,
  type SessionRow,
  type ShardedJsonValue,
  type SourceRow,
} from "../main.tsx";

const capabilities = {
  inventory: true,
  read: true,
  prompt: true,
  cancel: true,
  rename: true,
  setMode: false,
  setConfigOption: false,
};

/** The prompt the composer tests type and expect to see reviewed. */
export const PROMPT_TEXT = "Continue from the debug view";

/** The first element under `root` whose tag is `name`. */
export function elementNamed(root: unknown, name: string): unknown | undefined {
  return findNode(root, (node) =>
    typeof node === "object" && node !== null &&
    (node as { name?: unknown }).name === name);
}

/** Sets the value `node` binds under `prop`, such as an input's `$value`. */
function setBinding(
  node: unknown,
  prop: string,
  next: unknown,
  what: string,
): void {
  const binding = propsOf(node)?.[prop];
  if (
    typeof binding !== "object" || binding === null || !("set" in binding) ||
    typeof binding.set !== "function"
  ) {
    throw new Error(`${what} binds nothing under ${prop}`);
  }
  binding.set(next);
}

/** The composer field whose label reads `label`. */
export function composerField(
  root: unknown,
  label: string,
): unknown | undefined {
  return findNode(
    elementNamed(root, "cf-form"),
    (node) =>
      readValue(propsOf(node)?.label) === label &&
      readValue((node as { name?: unknown }).name) === "cf-field",
  );
}

/** Picks `next` in the select of the composer field labelled `label`. */
export function setComposerSelect(
  root: unknown,
  label: string,
  next: string,
): void {
  setBinding(
    elementNamed(composerField(root, label), "cf-select"),
    "$value",
    next,
    `the ${label} select`,
  );
}

/** Picks the command type in the composer's select. */
export function setCommandType(root: unknown, next: string): void {
  setComposerSelect(root, "Command", next);
}

/** The maximum length the composer's argument input allows. */
export function argumentMaxLength(root: unknown, label: string): unknown {
  return readValue(
    propsOf(elementNamed(composerField(root, label), "cf-input"))?.maxlength,
  );
}

/** Ticks or clears the composer's force checkbox. */
export function setForce(root: unknown, next: boolean): void {
  const checkbox = findNode(
    elementNamed(root, "cf-form"),
    (node) =>
      propsOf(node)?.["$checked"] !== undefined &&
      textContent(node).includes("forced"),
  );
  setBinding(checkbox, "$checked", next, "the force checkbox");
}

/** Types `PROMPT_TEXT` into the composer's prompt. */
export function enterPrompt(root: unknown): void {
  setBinding(
    elementNamed(elementNamed(root, "cf-form"), "cf-textarea"),
    "$value",
    PROMPT_TEXT,
    "the prompt",
  );
}

/** Submits the composer, which drafts the command for review. */
export function reviewCommand(root: unknown): void {
  fireEvent(elementNamed(root, "cf-form"), "oncf-submit", {}, "the composer");
}

/** Clicks the review dialog's "Send command" button. */
export function sendCommand(root: unknown): void {
  fireClick(
    findElementByText(root, "cf-button", "Send command"),
    "the Send command button",
  );
}

/** Whether the command review dialog is open. */
export function reviewOpen(root: unknown): unknown {
  return readValue(propsOf(elementNamed(root, "cf-modal"))?.["$open"]);
}

/** The command review dialog's text. */
export function reviewText(root: unknown): string {
  return textContent(elementNamed(root, "cf-modal"));
}

/**
 * How the open review falls short of the prompt command for the first
 * session, one line per shortfall, or an empty string when it shows it.
 */
export function promptReviewGaps(root: unknown): string {
  const review = reviewText(root);
  return [
    ...(reviewOpen(root) === true ? [] : ["the review dialog is closed"]),
    ...[
      '"ownerDid": "did:key:test-owner"',
      '"sourceId": "codex"',
      '"nativeSessionId": "session-1"',
      '"type": "prompt"',
      `"text": "${PROMPT_TEXT}"`,
    ].filter((line) => !review.includes(line)).map((line) =>
      `the review lacks ${line}`
    ),
  ].join("\n");
}

/** The published-session table, found by its column headings. */
export function sessionTable(root: unknown): unknown | undefined {
  return findNode(
    root,
    (node) =>
      readValue((node as { name?: unknown })?.name) === "cf-table" &&
      textContent(node).includes("Idle") &&
      textContent(node).includes("Worktree"),
  );
}

/** Whether the session table lists the row titled `first` above `second`. */
export function sessionRowPrecedes(
  root: unknown,
  first: string,
  second: string,
): boolean {
  const text = textContent(sessionTable(root));
  return text.includes(first) && text.includes(second) &&
    text.indexOf(first) < text.indexOf(second);
}

/** The `aria-sort` of the session-table heading whose button has `title`. */
export function sessionSortState(root: unknown, title: string): unknown {
  const heading = findNode(
    sessionTable(root),
    (node) =>
      readValue((node as { name?: unknown })?.name) === "th" &&
      findNodeByProp(node, "title", title) !== undefined,
  );
  return readValue(propsOf(heading)?.["aria-sort"]);
}

/** Types `next` into the session table's filter input. */
export function setSessionFilter(root: unknown, next: string): void {
  setBinding(
    findNodeByProp(root, "placeholder", "Filter this page"),
    "$value",
    next,
    "the session filter",
  );
}

/** The value of the raw-data view the "Raw data" tab links for `label`. */
export function rawCellView(
  root: unknown,
  label: string,
): Record<PropertyKey, unknown> {
  const card = findNode(
    root,
    (node) =>
      readValue((node as { name?: unknown })?.name) === "cf-card" &&
      textContent(node) === label &&
      elementNamed(node, "cf-cell-link") !== undefined,
  );
  const view = readValue(
    propsOf(elementNamed(card, "cf-cell-link"))?.["$cell"],
  );
  if (typeof view !== "object" || view === null) {
    throw new Error(`no raw data view is linked for ${label}`);
  }
  return view as Record<PropertyKey, unknown>;
}

/** Starts a raw-data view the way opening it does. */
export function startRawCellView(root: unknown, label: string): void {
  fireEvent(
    elementNamed(rawCellView(root, label)[UI], "cf-autostart"),
    "onstart",
    {},
    `the ${label} raw data view's autostart`,
  );
}

/** The JSON a raw-data view shows, once it has loaded. */
export function rawCellJson(root: unknown, label: string): string {
  return textContent(elementNamed(rawCellView(root, label)[UI], "pre"));
}

/** How many cell links labelled `label` the tree under `root` holds. */
export function countCellLinks(
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

/** The debug view over one source, and the cells a test changes under it. */
export interface DebugViewFixtureOutput {
  /** The debug view under test. */
  view: DebugOutput;
  /** The first session's manifest. */
  manifest: SessionManifest;
  /** The first session's sync status. */
  firstSessionSync: Writable<SessionRow["syncStatus"]>;
  /** How many sessions the indexes publish: 0, 1, or 2. */
  publishedSessionCount: Writable<number>;
  /** The host's health status. */
  status: Writable<string>;
  /** Whether the host accepts commands. */
  commandAccepting: Writable<boolean>;
  /** How many activity entries the health record lists: 1 or 2. */
  activityCount: Writable<number>;
  /** How many receipts the receipt index lists: 0 or 1. */
  receiptCount: Writable<number>;
  /** The command queue the view appends to. */
  commands: Writable<AgentCommandValue[]>;
}

/**
 * A debug view whose indexes publish one ready source and its first session,
 * whose health lists one activity entry, and whose queue and receipt index are
 * empty.
 */
export const DebugViewFixture = pattern<void, DebugViewFixtureOutput>(() => {
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
  return {
    view,
    manifest,
    firstSessionSync,
    publishedSessionCount,
    status,
    commandAccepting,
    activityCount,
    receiptCount,
    commands,
  };
});
