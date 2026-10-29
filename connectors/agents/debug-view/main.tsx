import {
  action,
  type Cell,
  Cfc,
  computed,
  CurrentPrincipal,
  handler,
  lift,
  NAME,
  type OpaqueCell,
  pattern,
  RepresentsCurrentUser,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  conversationState,
  formatIdleFor,
  SESSION_PAGE_SIZE,
  type SessionSortColumn,
  type SessionSortDirection,
  sortSessionRows,
  trailingPath,
} from "./presentation.ts";
import {
  type AgentCommandType,
  commandDraftError,
  type CommandDraftFields,
  commandPayload,
  materializeRootCell,
  providerSessionRetrieval,
  sessionSortLabel,
  statusColor,
} from "./logic.ts";
import {
  type CellLink,
  inspectLinkedValueCommand,
  inspectMaterializedValueCommand,
  inspectValueCommand,
  RAW_RETRIEVAL_SETUP,
} from "./provenance.ts";

type DebugTab = "overview" | "sessions" | "commands" | "activity" | "raw";

// Provider payloads are deliberately open-ended. The debug view preserves
// their complete JSON-compatible shape instead of projecting a narrower model.
// deno-lint-ignore no-explicit-any
type JsonObject = Record<string, any>;
// Raw-view inputs use an empty inner schema until their view starts loading.
// deno-lint-ignore no-empty-interface
export interface DeferredDocument {}
// The cell brand keeps linked values opaque at enclosing storage boundaries.
// The intersection exposes the reactive value inside pattern computations.
type UnshapedCell<T = unknown> = OpaqueCell<T> & T;
type JsonPrimitive = string | number | boolean | null | undefined;
// Unknown nested items keep the command schema finite.
// Invalid actions remain visible in the debug table.
type JsonArray = Array<JsonObject | JsonPrimitive | Array<unknown>>;
type JsonValue = JsonObject | JsonPrimitive | JsonArray;
const DEBUG_TABLE_PAGE_SIZE = 25;

export type StableArrayItem<T> = Cell<T> | undefined;

export type ShardedJsonValue =
  | JsonPrimitive
  | ShardedJsonObject
  | Array<StableArrayItem<ShardedJsonValue>>;

export interface ShardedJsonObject {
  [key: string]: ShardedJsonValue;
}

export interface RawDataProvenance {
  origin: string;
  fabric: {
    space: string;
    entity: string;
    path: Array<string | number>;
    scope: string;
  };
  retrievalCommand: string;
  retrievalSetup: string;
  processing: string;
  providerRetrieval?: string;
}

export interface MessagePreview {
  id: string;
  parentId?: string;
  role: string;
  kind: string;
  createdAt: string | null;
  textPreview: string | null;
  rawIndex: number;
}

export interface SessionChunk {
  schema: string;
  key: string;
  part: number;
  contentHash: string;
  events: Array<StableArrayItem<ShardedJsonValue>>;
}

export interface SessionChunkDescriptor {
  part: number;
  link: Cell<SessionChunk>;
  contentHash: string;
  byteLength: number;
  eventCount: number;
}

export interface SessionManifest {
  schema: string;
  key: string;
  sourceId: string;
  driver: string;
  nativeSessionId: string;
  metadata: ShardedJsonObject;
  summary: ShardedJsonObject;
  normalized: {
    messages: Array<StableArrayItem<MessagePreview>>;
  };
  chunks: Array<StableArrayItem<SessionChunkDescriptor>>;
  snapshotHash: string;
  revision: string | null;
  observedAt: string;
  complete: boolean;
}

export interface SessionRow {
  key: string;
  sourceId: string;
  driver: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  capabilities: ShardedJsonObject;
  recentMessages?: Array<StableArrayItem<MessagePreview>>;
  manifest: UnshapedCell<SessionManifest>;
  contentHash: string;
  syncStatus: "complete" | "partial" | "stale" | "deleted";
  deletedAt?: string;
}

interface PublishedSessionInput {
  sourceId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  manifest: OpaqueCell<DeferredDocument>;
  syncStatus: SessionRow["syncStatus"];
}

interface PublishedSessionRow {
  sourceId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  updatedAt: string | null;
  conversationState: string;
  syncStatus: SessionRow["syncStatus"];
  rawView: OpaqueCell<SessionRawViewOutput>;
}

export interface SessionIndexInput {
  schema: string;
  bucket?: "recent" | "all";
  generatedAt?: string;
  generation?: number;
  totalSessionCount?: number;
  olderSessionCount?: number;
  sources: Array<OpaqueCell<SourceRow>>;
  sessions: Array<OpaqueCell<PublishedSessionInput>>;
}

export interface SourceError {
  nativeSessionId?: string;
  message: string;
}

export interface SourceRow {
  id: string;
  driver: string;
  enabled?: boolean;
  status?: string;
  capabilities: ShardedJsonObject;
  sessionCount?: number;
  complete?: boolean;
  errors: Array<StableArrayItem<SourceError>>;
  lastError?: string;
  lastCollectionStartedAt?: string;
  lastCollectionCompletedAt?: string;
}

export interface SessionIndex {
  schema: string;
  bucket: "recent" | "all";
  generatedAt: string;
  generation: number;
  totalSessionCount: number;
  olderSessionCount: number;
  sources: Array<UnshapedCell<SourceRow>>;
  sessions: Array<UnshapedCell<SessionRow>>;
}

export interface HostActivity {
  id: string;
  at: string;
  type: string;
  message: string;
  sourceId?: string;
  details?: ShardedJsonObject;
}

export interface HostHealth {
  schema: string;
  service: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  target: {
    spaceDid: string;
    debugPieceId?: string;
    cells: Record<string, string>;
  };
  commandProcessing: {
    accepting: boolean;
    pendingReceiptPublications: number;
    failedCommands: number;
    lastError?: string;
  };
  sync?: {
    reason: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    sessionCount?: number;
    error?: string;
  };
  sources: Array<StableArrayItem<SourceRow>>;
  activity: Array<StableArrayItem<HostActivity>>;
}

export type { AgentCommandType } from "./logic.ts";

export interface AgentCommand {
  schema: string;
  ownerDid: string;
  id: string;
  createdAt: string;
  sourceId: string;
  nativeSessionId: string;
  type: AgentCommandType;
  payload: JsonObject;
  force?: boolean;
  requestedBy?: string;
}

// The connector validates each action value before interpreting it as a command.
export type AgentCommandValue = JsonValue;

export const sendOwnerAgentCommand = handler<
  void,
  {
    commands: Writable<AgentCommandValue[]>;
    commandAdmission: Cell<boolean>;
    pendingCommand: Writable<AgentCommand | null>;
    commandLastSubmission: Writable<string>;
    commandError: Writable<string>;
    commandConfirmOpen: Writable<boolean>;
    commandPromptText: Writable<string>;
    commandArgument: Writable<string>;
    commandConfigKey: Writable<string>;
    commandConfigValue: Writable<string>;
    commandForce: Writable<boolean>;
  }
>((_, state) => {
  if (state.commandAdmission.get() !== true) {
    state.commandError.set("The host is not accepting commands.");
    return;
  }
  const command = state.pendingCommand.get();
  if (command === null || command === undefined) {
    state.commandError.set("Review the command before sending it.");
    return;
  }
  state.commands.push(JSON.stringify(command));
  state.commandLastSubmission.set(
    `Submitted ${command.id}. Watch the receipt index for its outcome.`,
  );
  state.commandError.set("");
  state.commandConfirmOpen.set(false);
  state.pendingCommand.set(null);
  state.commandPromptText.set("");
  state.commandArgument.set("");
  state.commandConfigKey.set("");
  state.commandConfigValue.set("");
  state.commandForce.set(false);
});

type OwnerCommandQueue = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<AgentCommandValue[], typeof sendOwnerAgentCommand>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

export interface ReceiptRow {
  commandId: string;
  sourceId: string;
  nativeSessionId: string;
  status: string;
  updatedAt: string;
  error?: { code: string; message: string; retryable: boolean };
  receipt: CellLink;
}

export interface ReceiptIndex {
  schema: string;
  receipts: Array<StableArrayItem<ReceiptRow>>;
  updatedAt: string;
}

export interface DebugInput {
  ownerDid: string;
  recentIndex: SessionIndexInput | undefined;
  allIndex: SessionIndexInput | undefined;
  health: HostHealth | undefined;
  receipts: ReceiptIndex | undefined;
  recentIndexCell: OpaqueCell<DeferredDocument | undefined>;
  allIndexCell: OpaqueCell<DeferredDocument | undefined>;
  healthCell: OpaqueCell<DeferredDocument | undefined>;
  commandsCell: Writable<AgentCommandValue[]>;
  receiptsCell: OpaqueCell<DeferredDocument | undefined>;
}

export interface CommandTargetSelection {
  sourceId: string;
  nativeSessionId: string;
}

export interface DebugOutput {
  [NAME]: string;
  [UI]: VNode;
  status: string;
  sourceCount: number;
  sessionCount: number;
  commandCount: number;
  receiptCount: number;
  activityCount: number;
  commandQueue: OwnerCommandQueue;
  // The host reads this optional field's schema to label the input command
  // queue with the verified handler that writes commands. The field has no
  // stored value.
  commandAuthorization?: WriteAuthorizedBy<
    boolean,
    typeof sendOwnerAgentCommand
  >;
}

function stringValue(value: string | null | undefined, fallback = "—"): string {
  return value && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pageCountFor(length: number): number {
  return Math.max(1, Math.ceil(length / DEBUG_TABLE_PAGE_SIZE));
}

function currentPageFor(requested: number | undefined, pageCount: number) {
  return Math.max(
    0,
    Math.min(
      typeof requested === "number" ? requested : 0,
      pageCount - 1,
    ),
  );
}

function pageFromNewest<T>(values: readonly T[], page: number): T[] {
  const end = Math.max(0, values.length - page * DEBUG_TABLE_PAGE_SIZE);
  return values.slice(Math.max(0, end - DEBUG_TABLE_PAGE_SIZE), end);
}

function isAgentCommandType(value: unknown): value is AgentCommandType {
  return value === "prompt" || value === "start" || value === "cancel" ||
    value === "rename" || value === "set-mode" ||
    value === "set-config-option";
}

function isAgentCommand(value: unknown): value is AgentCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const command = value as Record<string, unknown>;
  return command.schema === "commonfabric.agent-connector.command" &&
    typeof command.ownerDid === "string" &&
    typeof command.id === "string" &&
    typeof command.createdAt === "string" &&
    typeof command.sourceId === "string" &&
    typeof command.nativeSessionId === "string" &&
    isAgentCommandType(command.type) &&
    command.payload !== null &&
    typeof command.payload === "object" &&
    !Array.isArray(command.payload);
}

function commandForDisplay(
  value: unknown,
): AgentCommand | undefined {
  if (typeof value !== "string") {
    return isAgentCommand(value) ? value : undefined;
  }
  try {
    const decoded: unknown = JSON.parse(value);
    return isAgentCommand(decoded) ? decoded : undefined;
  } catch {
    // The raw-cells view retains command values that cannot be decoded.
  }
  return undefined;
}

function sessionConversationState(
  session: Pick<PublishedSessionInput, "archived" | "active">,
): string {
  return conversationState({
    archived: typeof session.archived === "boolean" ? session.archived : null,
    active: typeof session.active === "boolean" ? session.active : null,
  });
}

interface ReadableCellValue<T> {
  get(): T | undefined;
  getAsNormalizedFullLink?(): {
    id: string;
    space: string;
    path: Array<string | number>;
    scope?: string;
  };
}

function isReadableCell<T>(value: unknown): value is ReadableCellValue<T> {
  return typeof value === "object" && value !== null && "get" in value &&
    typeof value.get === "function";
}

function readableCellLink(value: unknown): CellLink {
  if (!isReadableCell(value)) {
    throw new Error("Raw data source does not expose a Fabric cell");
  }
  const link = value.getAsNormalizedFullLink?.();
  if (
    typeof link?.id !== "string" || typeof link.space !== "string" ||
    !Array.isArray(link.path)
  ) {
    throw new Error("Raw data source has an incomplete Fabric cell link");
  }
  return {
    id: link.id,
    space: link.space,
    path: [...link.path],
    ...(link.scope === undefined ? {} : { scope: link.scope }),
  };
}

function rawDataProvenanceAtLink(
  link: CellLink,
  origin: string,
  processing: string,
  options: {
    retrievalCommand?: string;
    providerRetrieval?: string;
  } = {},
): RawDataProvenance {
  return {
    origin,
    fabric: {
      space: link.space,
      entity: link.id,
      path: [...link.path],
      scope: link.scope ?? "space",
    },
    retrievalCommand: options.retrievalCommand ??
      inspectValueCommand(link),
    retrievalSetup: RAW_RETRIEVAL_SETUP,
    processing,
    ...(options.providerRetrieval === undefined
      ? {}
      : { providerRetrieval: options.providerRetrieval }),
  };
}

function rawDataProvenance(
  source: unknown,
  origin: string,
  processing: string,
  options: {
    retrievalCommand?: string;
    providerRetrieval?: string;
  } = {},
): RawDataProvenance {
  return rawDataProvenanceAtLink(
    readableCellLink(source),
    origin,
    processing,
    options,
  );
}

function materializedCells<T>(
  values: Array<Cell<T> | OpaqueCell<T> | T | undefined>,
): T[] {
  return values.flatMap((value) => {
    if (value === undefined) return [];
    const materialized: T | undefined = isReadableCell<T>(value)
      ? value.get()
      : value as T;
    return materialized === undefined ? [] : [materialized] as T[];
  });
}

function sessionIndexJson(
  value: SessionIndexInput | undefined,
): SessionIndexInput | undefined {
  if (
    value?.schema !== "commonfabric.agent-connector.session-index" ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.sessions)
  ) {
    return undefined;
  }
  return value;
}

interface SessionIndexState {
  generation: number;
  generatedAt: string;
  rowCount: number;
  totalSessionCount: number;
  olderSessionCount: number;
}

function sessionIndexState(
  value: SessionIndexInput | undefined,
): SessionIndexState {
  const index = sessionIndexJson(value);
  return {
    generation: numberValue(index?.generation),
    generatedAt: stringValue(index?.generatedAt),
    rowCount: index?.sessions.length ?? 0,
    totalSessionCount: numberValue(index?.totalSessionCount),
    olderSessionCount: numberValue(index?.olderSessionCount),
  };
}

function currentSessionEntries(
  value: SessionIndexInput | undefined,
): Array<OpaqueCell<PublishedSessionInput>> {
  const index = sessionIndexJson(value);
  return index?.sessions ?? [];
}

// deno-lint-ignore no-explicit-any
function json(value: any): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch (error) {
    return `Could not serialize value: ${String(error)}`;
  }
}

function cellRows(health: HostHealth | undefined): Array<[string, string]> {
  return Object.entries(health?.target.cells ?? {});
}

interface SessionRawViewInput {
  manifest: OpaqueCell<DeferredDocument>;
  sourceId: string;
  nativeSessionId: string;
}

interface SessionRawViewOutput {
  [NAME]: string;
  [UI]: VNode;
  load: Stream<JsonObject>;
  rawJson: string;
  provenance: RawDataProvenance;
}

export const RAW_SESSION_LOADING_TEXT = "Loading raw conversation data…";
export const RAW_CELL_LOADING_TEXT = "Loading raw cell data…";

function materializeShardedJson(value: unknown): unknown {
  if (isReadableCell(value)) return materializeShardedJson(value.get());
  if (Array.isArray(value)) return value.map(materializeShardedJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      materializeShardedJson(child),
    ]),
  );
}

interface RuntimeReadableCell {
  resolveAsCell?: () => RuntimeReadableCell;
  asSchema?: (schema: undefined) => RuntimeReadableCell;
  get?: () => unknown;
  getRaw?: () => unknown;
}

function isRuntimeReadableCell(value: unknown): value is RuntimeReadableCell {
  return typeof value === "object" && value !== null &&
    ("get" in value || "getRaw" in value);
}

function materializeOpaqueCell(value: unknown): unknown {
  if (!isRuntimeReadableCell(value)) return value;
  const resolved = value.resolveAsCell?.() ?? value;
  const unshaped = resolved.asSchema?.(undefined) ?? resolved;
  return unshaped.get?.() ?? unshaped.getRaw?.();
}

function rawOpaqueCell(value: unknown): unknown {
  if (!isRuntimeReadableCell(value)) return value;
  const resolved = value.resolveAsCell?.() ?? value;
  return resolved.getRaw?.() ?? resolved.get?.();
}

function materializedRawConversationData(manifestValue: unknown): JsonObject {
  const manifest = materializeShardedJson(manifestValue) as
    | SessionManifest
    | undefined;
  const chunks = materializedCells(manifest?.chunks ?? []);
  return {
    manifest: materializeShardedJson({
      ...manifest,
      chunks: chunks.map((chunk) => {
        const { link: _link, ...descriptor } = chunk;
        return descriptor;
      }),
    }),
    eventChunks: chunks.map((chunk) => materializeShardedJson(chunk.link)),
  };
}

const loadSessionRawData = handler<
  JsonObject,
  {
    manifest: OpaqueCell<DeferredDocument>;
    rawJson: Writable<string>;
    driver: Writable<string | null>;
  }
>((_, { manifest, rawJson, driver }) => {
  const manifestValue = materializeOpaqueCell(manifest) as
    | SessionManifest
    | undefined;
  if (manifestValue === undefined) {
    throw new Error("session manifest is unavailable");
  }
  driver.set(manifestValue.driver);
  rawJson.set(
    json(materializedRawConversationData(manifestValue)),
  );
});

const loadSessionIndexRawData = handler<
  JsonObject,
  {
    value: OpaqueCell<DeferredDocument | undefined>;
    rawJson: Writable<string>;
  }
>((_, { value, rawJson }) => {
  rawJson.set(json(rawOpaqueCell(value)));
});

const loadHealthRawData = handler<
  JsonObject,
  {
    value: OpaqueCell<DeferredDocument | undefined>;
    rawJson: Writable<string>;
  }
>((_, { value, rawJson }) => {
  rawJson.set(json(rawOpaqueCell(value)));
});

const loadCommandsRawData = handler<
  JsonObject,
  { value: AgentCommandValue[] | undefined; rawJson: Writable<string> }
>((_, { value, rawJson }) => {
  rawJson.set(json(materializeRootCell(value)));
});

const loadReceiptsRawData = handler<
  JsonObject,
  {
    value: OpaqueCell<DeferredDocument | undefined>;
    rawJson: Writable<string>;
  }
>((_, { value, rawJson }) => {
  rawJson.set(json(rawOpaqueCell(value)));
});

export function rawConversationData(
  manifest: SessionManifest | undefined,
): JsonObject {
  return materializedRawConversationData(manifest);
}

export const SessionRawView = pattern<
  SessionRawViewInput,
  SessionRawViewOutput
>(
  ({ manifest, sourceId, nativeSessionId }) => {
    const rawJson = new Writable(RAW_SESSION_LOADING_TEXT);
    const driver = new Writable<string | null>(null);
    const load = loadSessionRawData({
      manifest,
      rawJson,
      driver,
    });
    const manifestLink = readableCellLink(manifest);
    const provenance = computed(() =>
      rawDataProvenanceAtLink(
        manifestLink,
        "AgentFabricTarget.publish() wrote this session manifest after the " +
          `connector source ${
            JSON.stringify(sourceId)
          } returned a snapshot for ` +
          `native session ${JSON.stringify(nativeSessionId)} from ` +
          "AgentDriver.readSession(). The snapshot's summary.raw value became " +
          "the provider metadata. Its normalizedMessages and events became the " +
          "normalized message list and native event chunks.",
        "The page reads the manifest when it starts. It materializes every " +
          "stable child cell inside the manifest. It follows each chunk " +
          "descriptor's link and materializes that event-chunk cell. It returns " +
          "a manifest without the repeated descriptor links and a separate " +
          "eventChunks array. The " +
          "JSON is a snapshot from the time this page started.",
        {
          retrievalCommand: `${inspectMaterializedValueCommand(manifestLink)}
# Recursively follow every $link in the manifest to obtain metadata, summary,
# normalized messages, chunk descriptors, and arrays nested inside them.
# Each chunk descriptor has a link to an event-chunk root. Follow it, then
# recursively follow every $link in that chunk to obtain its events and nested
# provider data. Select the matching revision from each linked cell's history.`,
          providerRetrieval: providerSessionRetrieval(
            driver.get(),
            sourceId,
            nativeSessionId,
          ),
        },
      )
    );
    return {
      [NAME]: "Raw conversation data",
      [UI]: rawCellViewUi(
        "Raw conversation data",
        "Provider metadata, normalized messages, and native event chunks",
        load,
        rawJson,
        provenance,
      ),
      load,
      rawJson,
      provenance,
    };
  },
);

interface RawSessionIndexViewInput {
  title: string;
  description: string;
  value: OpaqueCell<DeferredDocument | undefined>;
  origin: string;
  processing: string;
}

interface RawHealthViewInput {
  title: string;
  description: string;
  value: OpaqueCell<DeferredDocument | undefined>;
  origin: string;
  processing: string;
}

interface RawCommandsViewInput {
  title: string;
  description: string;
  value: OpaqueCell<AgentCommandValue[] | undefined>;
  origin: string;
  processing: string;
}

interface RawReceiptsViewInput {
  title: string;
  description: string;
  value: OpaqueCell<DeferredDocument | undefined>;
  origin: string;
  processing: string;
}

interface RawJsonViewInput {
  title: string;
  description: string;
  rawJson: string;
  source: OpaqueCell<DeferredDocument>;
  origin: string;
  processing: string;
}

interface RawJsonViewOutput {
  [NAME]: string;
  [UI]: VNode;
  rawJson: string;
  provenance: RawDataProvenance;
}

interface RawReceiptDetailsViewInput {
  title: string;
  description: string;
  receipt: UnshapedCell<ReceiptRow>;
}

interface RawActivityDetailsViewInput {
  title: string;
  description: string;
  activity: UnshapedCell<HostActivity>;
}

interface RawCellViewOutput {
  [NAME]: string;
  [UI]: VNode;
  load: Stream<JsonObject>;
  rawJson: string;
  provenance: RawDataProvenance;
}

function rawDataProvenanceUi(
  provenance: RawDataProvenance,
): VNode {
  return (
    <cf-card>
      <details>
        <summary
          style={{
            cursor: "pointer",
          }}
        >
          <cf-heading
            level={4}
            no-margin
            style={{ display: "inline-block" }}
          >
            Where this data comes from
          </cf-heading>
        </summary>
        <div style={{ paddingTop: "12px" }}>
          <cf-vstack gap="3">
            <cf-text>{provenance.origin}</cf-text>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "12px",
              }}
            >
              <cf-vstack gap="1">
                <cf-text tone="muted">Fabric space</cf-text>
                <code style="overflow-wrap: anywhere;">
                  {provenance.fabric.space}
                </code>
              </cf-vstack>
              <cf-vstack gap="1">
                <cf-text tone="muted">Fabric entity</cf-text>
                <code style="overflow-wrap: anywhere;">
                  {provenance.fabric.entity}
                </code>
              </cf-vstack>
              <cf-vstack gap="1">
                <cf-text tone="muted">Value path</cf-text>
                <code style="overflow-wrap: anywhere;">
                  {json(provenance.fabric.path)}
                </code>
              </cf-vstack>
              <cf-vstack gap="1">
                <cf-text tone="muted">Declared scope</cf-text>
                <code>{provenance.fabric.scope}</code>
              </cf-vstack>
            </div>
            <cf-vstack gap="1">
              <cf-heading level={5}>Retrieve it independently</cf-heading>
              <code
                style={{
                  display: "block",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  padding: "12px",
                  background: "var(--cf-theme-color-surface-inverse, #16181d)",
                  color: "var(--cf-theme-color-text-on-inverse, #ffffff)",
                  borderRadius: "8px",
                }}
              >
                {provenance.retrievalCommand}
              </code>
              <cf-text tone="muted">{provenance.retrievalSetup}</cf-text>
            </cf-vstack>
            <cf-vstack gap="1">
              <cf-heading level={5}>How this page prepares it</cf-heading>
              <cf-text>{provenance.processing}</cf-text>
            </cf-vstack>
            {provenance.providerRetrieval === undefined
              ? null
              : (
                <cf-vstack gap="1">
                  <cf-heading level={5}>
                    Retrieve it from the provider
                  </cf-heading>
                  <cf-text>{provenance.providerRetrieval}</cf-text>
                </cf-vstack>
              )}
          </cf-vstack>
        </div>
      </details>
    </cf-card>
  ) as VNode;
}

function rawCellViewUi(
  title: string,
  description: string,
  load: Stream<JsonObject> | undefined,
  rawJson: Cell<string> | string,
  provenance: RawDataProvenance,
): VNode {
  return (
    <cf-screen>
      {load === undefined ? null : <cf-autostart onstart={load} />}
      <cf-vstack slot="header" gap="1">
        <cf-heading level={3}>{title}</cf-heading>
        <cf-text tone="muted">{description}</cf-text>
      </cf-vstack>
      <cf-vscroll flex showScrollbar fadeEdges>
        <cf-vstack gap="3" padding="4">
          {rawDataProvenanceUi(provenance)}
          <cf-card>
            <pre style="margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;">
              {rawJson}
            </pre>
          </cf-card>
        </cf-vstack>
      </cf-vscroll>
    </cf-screen>
  ) as VNode;
}

const RawSessionIndexView = pattern<
  RawSessionIndexViewInput,
  RawCellViewOutput
>(({ title, description, value, origin, processing }) => {
  const rawJson = new Writable(RAW_CELL_LOADING_TEXT);
  const load = loadSessionIndexRawData({
    value,
    rawJson,
  });
  const provenance = rawDataProvenance(value, origin, processing);
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(title, description, load, rawJson, provenance),
    load,
    rawJson,
    provenance,
  };
});

const RawHealthView = pattern<
  RawHealthViewInput,
  RawCellViewOutput
>(({ title, description, value, origin, processing }) => {
  const rawJson = new Writable(RAW_CELL_LOADING_TEXT);
  const load = loadHealthRawData({
    value,
    rawJson,
  });
  const provenance = rawDataProvenance(value, origin, processing);
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(title, description, load, rawJson, provenance),
    load,
    rawJson,
    provenance,
  };
});

const RawCommandsView = pattern<
  RawCommandsViewInput,
  RawCellViewOutput
>(({ title, description, value, origin, processing }) => {
  const rawJson = new Writable(RAW_CELL_LOADING_TEXT);
  const load = loadCommandsRawData({ value, rawJson });
  const provenance = rawDataProvenance(value, origin, processing);
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(title, description, load, rawJson, provenance),
    load,
    rawJson,
    provenance,
  };
});

const RawReceiptsView = pattern<
  RawReceiptsViewInput,
  RawCellViewOutput
>(({ title, description, value, origin, processing }) => {
  const rawJson = new Writable(RAW_CELL_LOADING_TEXT);
  const load = loadReceiptsRawData({
    value,
    rawJson,
  });
  const provenance = rawDataProvenance(value, origin, processing);
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(title, description, load, rawJson, provenance),
    load,
    rawJson,
    provenance,
  };
});

const RawJsonView = pattern<
  RawJsonViewInput,
  RawJsonViewOutput
>(({ title, description, rawJson, source, origin, processing }) => {
  const provenance = rawDataProvenance(source, origin, processing, {
    retrievalCommand: inspectMaterializedValueCommand(
      readableCellLink(source),
    ),
  });
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(
      title,
      description,
      undefined,
      rawJson,
      provenance,
    ),
    rawJson,
    provenance,
  };
});

const receiptDetailsJson = lift(
  (
    {
      error,
      receipt,
      updatedAt,
    }: Pick<ReceiptRow, "error" | "receipt" | "updatedAt">,
  ) =>
    json(materializeShardedJson({
      updatedAt,
      error,
      receipt,
    })),
);

const activityDetailsJson = lift(
  ({ details }: Pick<HostActivity, "details">) =>
    json(materializeShardedJson(details)),
);

const RawReceiptDetailsView = pattern<
  RawReceiptDetailsViewInput,
  RawJsonViewOutput
>(({ title, description, receipt }) => {
  const rawJson = receiptDetailsJson({
    error: receipt.error,
    receipt: receipt.receipt,
    updatedAt: receipt.updatedAt,
  });
  const receiptDocumentCommand = inspectLinkedValueCommand(
    receipt.receipt,
    "RECEIPT_REVISION_SEQ",
    "has this command ID, status, and update time",
  );
  const provenance = rawDataProvenance(
    receipt,
    `AgentFabricTarget.publishReceipt() wrote command receipt ${
      JSON.stringify(receipt.commandId)
    } and updated its index row at ${
      JSON.stringify(receipt.updatedAt)
    }. It wrote the individual receipt cell first, then added this row to ` +
      "the bounded receipt-index cell. This " +
      "row identifies the command, provider source, native session, status, " +
      "update time, optional error, and individual receipt-cell link.",
    "The page projects updatedAt, error, and receipt from the receipt-index " +
      "row. It keeps the individual receipt as a link and does not read that " +
      "document.",
    {
      retrievalCommand: `${inspectValueCommand(readableCellLink(receipt))}
# The row's receipt field points to the complete receipt document:
${receiptDocumentCommand}`,
    },
  );
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(
      title,
      description,
      undefined,
      rawJson,
      provenance,
    ),
    rawJson,
    provenance,
  };
});

const RawActivityDetailsView = pattern<
  RawActivityDetailsViewInput,
  RawJsonViewOutput
>(({ title, description, activity }) => {
  const rawJson = activityDetailsJson({ details: activity.details });
  const provenance = rawDataProvenance(
    activity,
    `AgentsHost records activity ${JSON.stringify(activity.id)} at ${
      JSON.stringify(activity.at)
    } in its bounded in-memory activity list. ` +
      "AgentsHost.health() includes that list in a health snapshot. " +
      "AgentFabricTarget.publishHealth() writes the snapshot and stable " +
      "activity child cells to the connector health cell.",
    "The page materializes only the activity record's details field. The " +
      "event ID, time, type, source, and message remain in the containing " +
      "activity row.",
    {
      retrievalCommand: inspectMaterializedValueCommand(
        readableCellLink(activity),
      ),
    },
  );
  return {
    [NAME]: `${title} — raw data`,
    [UI]: rawCellViewUi(
      title,
      description,
      undefined,
      rawJson,
      provenance,
    ),
    rawJson,
    provenance,
  };
});

const renderCommandTableRow = pattern<
  { element: AgentCommandValue },
  VNode
>(
  // deno-lint-ignore no-explicit-any
  (input: any) => {
    const value = input.element as AgentCommandValue;
    const source: OpaqueCell<DeferredDocument> = input.key("element");
    const command = commandForDisplay(value);
    const rawValue = command === undefined ? value : command.payload;
    const rawJson = computed(() => json(materializeShardedJson(rawValue)));
    const rawView = RawJsonView({
      title: command === undefined
        ? "Invalid command action value"
        : `Command ${command.id} payload`,
      description: command === undefined
        ? "The complete value stored in the command action cell"
        : "The provider-specific payload from a displayable command envelope",
      rawJson,
      source,
      origin: command === undefined
        ? "This is one unrecognized action value from the owner's protected " +
          "command queue."
        : `This is the payload field of command ${
          JSON.stringify(command.id)
        }, created at ${JSON.stringify(command.createdAt)}, from the ` +
          "owner's protected command queue. The debug composer appends a JSON " +
          "string through its owner-gated sending handler.",
      processing: command === undefined
        ? "The page materializes stable child cells inside the action value and " +
          "formats the complete unrecognized value as JSON."
        : "The page JSON-decodes string action values and checks the fields " +
          "needed for table display. It then selects the payload field, " +
          "materializes stable child cells inside that payload, and formats " +
          "the result as JSON. The host separately applies the complete " +
          "connector command validation before execution.",
    });
    return command === undefined
      ? (
        <tr>
          <td>Invalid action value</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>
            <cf-cell-link $cell={rawView} label="Raw data" />
          </td>
        </tr>
      )
      : (
        <tr>
          <td>{stringValue(command.id)}</td>
          <td>{stringValue(command.sourceId)}</td>
          <td>{stringValue(command.nativeSessionId)}</td>
          <td>{stringValue(command.type)}</td>
          <td>{stringValue(command.createdAt)}</td>
          <td>
            <cf-cell-link $cell={rawView} label="Raw data" />
          </td>
        </tr>
      );
  },
);

const renderReceiptTableRow = pattern<
  { element: UnshapedCell<ReceiptRow> },
  VNode
>(({ element: receipt }) => {
  const rawView = RawReceiptDetailsView({
    title: `Receipt ${receipt.commandId} details`,
    description: "The receipt error and linked receipt document",
    receipt,
  });
  return (
    <tr>
      <td>{stringValue(receipt.commandId)}</td>
      <td>{stringValue(receipt.sourceId)}</td>
      <td>{stringValue(receipt.nativeSessionId)}</td>
      <td>
        <cf-badge color={statusColor(receipt.status)}>
          {stringValue(receipt.status)}
        </cf-badge>
      </td>
      <td>{stringValue(receipt.updatedAt)}</td>
      <td>
        <cf-cell-link $cell={rawView} label="Raw data" />
      </td>
    </tr>
  ) as VNode;
});

const renderActivityTableRow = pattern<
  { element: UnshapedCell<HostActivity> },
  VNode
>(({ element: event }) => {
  const rawView = RawActivityDetailsView({
    title: `Activity ${event.id} details`,
    description: "The details recorded for this event",
    activity: event,
  });
  return (
    <tr>
      <td>{stringValue(event.at)}</td>
      <td>{stringValue(event.type)}</td>
      <td>{stringValue(event.sourceId)}</td>
      <td>{stringValue(event.message)}</td>
      <td>
        <cf-cell-link $cell={rawView} label="Raw data" />
      </td>
    </tr>
  ) as VNode;
});

const movePage = handler<
  unknown,
  { page: Writable<number>; currentPage: number; delta: number }
>((_, { page, currentPage, delta }) => {
  page.set(
    Math.max(0, (typeof currentPage === "number" ? currentPage : 0) + delta),
  );
});

const changeSessionSort = handler<
  unknown,
  {
    column: Writable<SessionSortColumn | null>;
    direction: Writable<SessionSortDirection>;
    currentColumn: SessionSortColumn | null;
    currentDirection: SessionSortDirection;
    requestedColumn: SessionSortColumn;
  }
>((_, state) => {
  if (state.currentColumn === state.requestedColumn) {
    state.direction.set(
      state.currentDirection === "ascending" ? "descending" : "ascending",
    );
    return;
  }
  state.column.set(state.requestedColumn);
  state.direction.set("ascending");
});

const chooseSessionForCommand = handler<
  unknown,
  {
    sourceId: string;
    nativeSessionId: string;
    selectTarget: Stream<CommandTargetSelection>;
  }
>((_, { sourceId, nativeSessionId, selectTarget }) => {
  selectTarget.send({ sourceId, nativeSessionId });
});

const projectPublishedSession = pattern<
  { element: PublishedSessionInput },
  PublishedSessionRow
>(
  ({ element: session }) => {
    // deno-lint-ignore no-explicit-any
    const rawView = SessionRawView({
      manifest: session.manifest,
      sourceId: session.sourceId,
      nativeSessionId: session.nativeSessionId,
    }) as any;
    return {
      sourceId: session.sourceId,
      nativeSessionId: session.nativeSessionId,
      title: session.title,
      cwd: session.cwd,
      gitRepo: session.gitRepo,
      gitBranch: session.gitBranch,
      gitWorktreeRoot: session.gitWorktreeRoot,
      updatedAt: session.updatedAt,
      conversationState: computed(() => sessionConversationState(session)),
      syncStatus: session.syncStatus,
      rawView,
    };
  },
);

const slicePublishedSessionCells = lift(
  (
    {
      values,
      start,
      count,
    }: {
      values: Array<OpaqueCell<PublishedSessionRow>>;
      start: number;
      count: number;
    },
  ): Array<OpaqueCell<PublishedSessionRow>> =>
    values.slice(start, start + count),
);

const commandCellPageFromNewest = lift(
  (
    {
      values,
      length,
      page,
    }: {
      values: OpaqueCell<AgentCommandValue[]>;
      length: number;
      page: number;
    },
  ): Array<OpaqueCell<AgentCommandValue>> => {
    if (values === undefined) return [];
    const end = Math.max(0, length - page * DEBUG_TABLE_PAGE_SIZE);
    const start = Math.max(0, end - DEBUG_TABLE_PAGE_SIZE);
    return Array.from(
      { length: end - start },
      (_, offset) => values.key(start + offset),
    );
  },
);

const DebugView = pattern<DebugInput, DebugOutput>(
  (
    {
      recentIndex,
      allIndex,
      health,
      receipts,
      recentIndexCell,
      allIndexCell,
      healthCell,
      commandsCell,
      receiptsCell,
      ownerDid,
    },
  ) => {
    const commands = commandsCell;
    const protectedCommands: Writable<OwnerCommandQueue> = commandsCell;
    const activeTab = new Writable.perSession<DebugTab>("overview");
    const sessionFilter = new Writable.perSession("");
    const sessionPage = new Writable.perSession(0);
    const sessionSortColumn = new Writable.perSession<
      SessionSortColumn | null
    >(null);
    const sessionSortDirection = new Writable.perSession<SessionSortDirection>(
      "ascending",
    );
    const commandSourceId = new Writable.perSession("");
    const commandNativeSessionId = new Writable.perSession("");
    const commandType = new Writable.perSession<AgentCommandType>("prompt");
    const commandPromptText = new Writable.perSession("");
    const commandArgument = new Writable.perSession("");
    const commandConfigKey = new Writable.perSession("");
    const commandConfigValue = new Writable.perSession("");
    const commandConfigValueType = new Writable.perSession<
      "string" | "true" | "false"
    >("string");
    const commandForce = new Writable.perSession(false);
    const pendingCommand = new Writable.perSession<AgentCommand | null>(null);
    const commandConfirmOpen = new Writable.perSession(false);
    const commandError = new Writable.perSession("");
    const commandLastSubmission = new Writable.perSession("");
    const commandHistoryPage = new Writable.perSession(0);
    const receiptPage = new Writable.perSession(0);
    const activityPage = new Writable.perSession(0);
    const now = wish<number>({ query: "#now/60" });
    const commandAdmission = computed(() =>
      health?.commandProcessing?.accepting === true
    );

    const selectCommandTarget = action(
      ({ sourceId, nativeSessionId }: CommandTargetSelection) => {
        commandSourceId.set(sourceId);
        commandNativeSessionId.set(nativeSessionId);
        commandType.set("prompt");
        commandPromptText.set("");
        commandArgument.set("");
        commandConfigKey.set("");
        commandConfigValue.set("");
        commandConfigValueType.set("string");
        commandForce.set(false);
        pendingCommand.set(null);
        commandConfirmOpen.set(false);
        commandError.set("");
        commandLastSubmission.set("");
        activeTab.set("commands");
      },
    );
    const reviewCommand = action(() => {
      if (!commandAdmission) {
        commandError.set("The host is not accepting commands.");
        return;
      }
      const fields: CommandDraftFields = {
        sourceId: commandSourceId.get() ?? "",
        nativeSessionId: commandNativeSessionId.get() ?? "",
        type: commandType.get() ?? "prompt",
        promptText: commandPromptText.get() ?? "",
        argument: commandArgument.get() ?? "",
        configKey: commandConfigKey.get() ?? "",
        configValue: commandConfigValue.get() ?? "",
        configValueType: commandConfigValueType.get() ?? "string",
      };
      const error = commandDraftError(fields);
      commandError.set(error);
      if (error) return;
      const createdAt = new Date().toISOString();
      const command: AgentCommand = {
        schema: "commonfabric.agent-connector.command",
        ownerDid,
        id: `debug:${createdAt}:${Math.random().toString(36).slice(2, 10)}`,
        createdAt,
        sourceId: fields.sourceId.trim().toLowerCase(),
        nativeSessionId: fields.nativeSessionId.trim(),
        type: fields.type,
        payload: commandPayload(fields),
        ...((fields.type === "prompt" || fields.type === "start") &&
            commandForce.get() === true
          ? { force: true }
          : {}),
      };
      pendingCommand.set(command);
      commandConfirmOpen.set(true);
    });
    const cancelCommandReview = action(() => {
      commandConfirmOpen.set(false);
      pendingCommand.set(null);
    });
    const sendCommand = sendOwnerAgentCommand({
      commands,
      commandAdmission,
      pendingCommand,
      commandLastSubmission,
      commandError,
      commandConfirmOpen,
      commandPromptText,
      commandArgument,
      commandConfigKey,
      commandConfigValue,
      commandForce,
    });

    const recentIndexState = computed(() => sessionIndexState(recentIndex));
    const completeIndexState = computed(() => sessionIndexState(allIndex));
    const commandActionCount = computed(() =>
      numberValue(commands.key("length").get())
    );
    const receiptEntries = computed(() => receipts?.receipts ?? []);
    const activityEntries = computed(() => health?.activity ?? []);
    const sources = computed(() => materializedCells(health?.sources ?? []));
    const commandSourceOptions = computed(() => [
      { label: "Choose a source", value: "" },
      ...sources.map((source) => ({
        label: `${source.id} · ${source.driver}`,
        value: source.id,
      })),
    ]);
    const pendingCommandJson = computed(() => {
      const command = pendingCommand.get();
      return command === null || command === undefined ? "" : json(command);
    });
    const commandArgumentLabel = computed(() =>
      commandType.get() === "rename" ? "New title" : "Mode ID"
    );
    const commandIsPrompt = computed(() =>
      commandType.get() === "prompt" || commandType.get() === "start"
    );
    const commandIsCancel = computed(() => commandType.get() === "cancel");
    const commandNeedsArgument = computed(() =>
      commandType.get() === "rename" || commandType.get() === "set-mode"
    );
    const commandSetsConfig = computed(() =>
      commandType.get() === "set-config-option"
    );
    const commandConfigIsString = computed(() =>
      commandConfigValueType.get() === "string"
    );
    const sessionPageCount = computed(() =>
      Math.max(
        1,
        Math.ceil(
          currentSessionEntries(allIndex).length / SESSION_PAGE_SIZE,
        ),
      )
    );
    const currentSessionPage = computed(() => {
      const requestedPage = sessionPage.get();
      return Math.max(
        0,
        Math.min(
          typeof requestedPage === "number" ? requestedPage : 0,
          sessionPageCount - 1,
        ),
      );
    });
    const projectedSessionEntries = computed(() => {
      const start = currentSessionPage * SESSION_PAGE_SIZE;
      const end = Math.min(
        currentSessionEntries(allIndex).length,
        start + SESSION_PAGE_SIZE,
      );
      return currentSessionEntries(allIndex).slice(
        start,
        end,
      );
    });
    // deno-lint-ignore no-explicit-any
    const projectedSessions = (projectedSessionEntries as any).mapWithPattern(
      // The list runner supplies each linked record in its element field.
      // deno-lint-ignore no-explicit-any
      projectPublishedSession as any,
      {},
    ) as PublishedSessionRow[];
    const pageSessionCells = slicePublishedSessionCells({
      values: projectedSessions,
      start: 0,
      count: SESSION_PAGE_SIZE,
    });
    const pageSessions = computed(() => materializedCells(pageSessionCells));
    // TODO(@ianh): Apply sorting before pagination after the connector publishes
    // a shallow directory of row links and sortable title, update-time, and
    // worktree keys. Sorting opaque row cells here would load every session.
    const sortedPageSessions = computed(() =>
      sortSessionRows(
        pageSessions,
        sessionSortColumn.get(),
        sessionSortDirection.get(),
      )
    );
    const visibleSessions = computed(() => {
      const query = (sessionFilter.get() ?? "").trim().toLowerCase();
      if (!query) return sortedPageSessions;
      return sortedPageSessions.filter((session) =>
        [
          session.sourceId,
          session.title,
          session.cwd,
          session.gitRepo,
          session.gitBranch,
          session.gitWorktreeRoot,
        ].some((value) =>
          typeof value === "string" && value.toLowerCase().includes(query)
        )
      );
    });
    const commandHistoryPageCount = computed(() =>
      pageCountFor(numberValue(commandActionCount))
    );
    const currentCommandHistoryPage = computed(() =>
      currentPageFor(commandHistoryPage.get(), commandHistoryPageCount)
    );
    const commandPageValues = commandCellPageFromNewest({
      values: commandsCell,
      length: commandActionCount,
      page: currentCommandHistoryPage,
    });
    // deno-lint-ignore no-explicit-any
    const commandRows = (commandPageValues as any).mapWithPattern(
      // deno-lint-ignore no-explicit-any
      renderCommandTableRow as any,
      {},
    ) as VNode[];
    const receiptPageCount = computed(() =>
      pageCountFor(receiptEntries.length)
    );
    const currentReceiptPage = computed(() =>
      currentPageFor(receiptPage.get(), receiptPageCount)
    );
    const receiptPageEntries = computed(() =>
      pageFromNewest(receiptEntries, currentReceiptPage)
    );
    // deno-lint-ignore no-explicit-any
    const receiptRows = (receiptPageEntries as any).mapWithPattern(
      // deno-lint-ignore no-explicit-any
      renderReceiptTableRow as any,
      {},
    ) as VNode[];
    const activityPageCount = computed(() =>
      pageCountFor(activityEntries.length)
    );
    const currentActivityPage = computed(() =>
      currentPageFor(activityPage.get(), activityPageCount)
    );
    const activityPageEntries = computed(() =>
      pageFromNewest(activityEntries, currentActivityPage)
    );
    // deno-lint-ignore no-explicit-any
    const activityRows = (activityPageEntries as any).mapWithPattern(
      // deno-lint-ignore no-explicit-any
      renderActivityTableRow as any,
      {},
    ) as VNode[];
    const status = computed(() => stringValue(health?.status, "waiting"));
    const sourceCount = computed(() => sources.length);
    const sessionCount = computed(() =>
      numberValue(sessionIndexJson(allIndex)?.totalSessionCount)
    );
    const commandCount = computed(() => numberValue(commandActionCount));
    const receiptCount = computed(() => receiptEntries.length);
    const activityCount = computed(() => activityEntries.length);
    const titleSortLabel = computed(() =>
      sessionSortLabel(
        "Title",
        "title",
        sessionSortColumn.get(),
        sessionSortDirection.get(),
      )
    );
    const idleSortLabel = computed(() =>
      sessionSortLabel(
        "Idle for",
        "idleFor",
        sessionSortColumn.get(),
        sessionSortDirection.get(),
      )
    );
    const worktreeSortLabel = computed(() =>
      sessionSortLabel(
        "Worktree",
        "worktree",
        sessionSortColumn.get(),
        sessionSortDirection.get(),
      )
    );
    const rawHealth = RawHealthView({
      title: "Health",
      description: "Connector host health, source state, and recent activity",
      value: healthCell,
      origin:
        "AgentsHost.health() creates this snapshot from host lifecycle, " +
        "source, collection, command, and activity state. " +
        "AgentFabricTarget.publishHealth() stores the snapshot in the " +
        "deterministic top-level health cell whose cause uses " +
        'agentConnector: "health" and the configured owner DID.',
      processing: "The page reads the health cell's stored value when it " +
        "starts and formats it as JSON. Stable child cells remain explicit " +
        "Fabric links. The page does not follow source or activity links.",
    });
    const rawRecentIndex = RawSessionIndexView({
      title: "Recent session index",
      description: "The bounded index used for recent-session discovery",
      value: recentIndexCell,
      origin: "AgentFabricTarget.publish() rebuilds this deterministic " +
        "top-level index after a provider collection. It contains source rows " +
        "and links to non-deleted sessions updated within the preceding seven " +
        "days. " +
        'Its cause uses agentConnector: "recent-session-index" and the ' +
        "configured owner DID.",
      processing:
        "The page reads the index cell's stored value when it starts " +
        "and formats it as JSON. Session and source child cells remain explicit " +
        "Fabric links. The page does not load session manifests or event chunks.",
    });
    const rawCompleteIndex = RawSessionIndexView({
      title: "Complete session index",
      description: "Every published session-row reference",
      value: allIndexCell,
      origin: "AgentFabricTarget.publish() rebuilds this deterministic " +
        "top-level index after a provider collection. It contains source rows, " +
        "all non-deleted session-row links, and retained deleted-session rows. " +
        'Its cause uses agentConnector: "all-session-index" and the ' +
        "configured owner DID.",
      processing:
        "The page reads the index cell's stored value when it starts " +
        "and formats it as JSON. Session and source child cells remain explicit " +
        "Fabric links. The page does not load session manifests or event chunks.",
    });
    const rawCommands = RawCommandsView({
      title: "Commands",
      description: "Commands submitted to the connector host",
      value: commandsCell,
      origin:
        "This is the owner-confidential command queue supplied by the host. " +
        "piece. Only the configured owner acting through the debug pattern's " +
        "command-sending handler can modify it. The running host subscribes " +
        "to this cell.",
      processing: "The page reads the root action array when it starts. It " +
        "formats inline values as JSON and represents linked child cells as " +
        "explicit $cell records. It does not validate, decode, or execute the " +
        "commands.",
    });
    const rawReceipts = RawReceiptsView({
      title: "Receipts",
      description: "Command execution receipts published by the connector host",
      value: receiptsCell,
      origin: "AgentFabricTarget.publishReceipt() writes one deterministic " +
        "receipt cell per command. It then updates this deterministic top-level " +
        "index with the latest 200 receipt-row links. The index cause uses " +
        'agentConnector: "receipts" and the configured owner DID.',
      processing: "The page reads the receipt index's stored value when it " +
        "starts and formats it as JSON. Receipt rows and individual receipt " +
        "documents remain explicit Fabric links. The page does not follow them.",
    });

    return {
      [NAME]: "Agent sessions",
      [UI]: (
        <cf-screen className="agent-sessions-debug">
          <style>
            {`
              .agent-sessions-debug cf-table th {
                text-align: left;
              }

              .agent-sessions-debug cf-table thead > tr > th,
              .agent-sessions-debug cf-table tbody > tr:not(:last-child) > :is(th, td) {
                border-block-end: 1px solid var(--cf-theme-color-border-muted, #f2f3f6);
              }

              .agent-sessions-debug cf-table tr > :is(th, td):not(:last-child) {
                border-inline-end: 1px solid var(--cf-theme-color-border-muted, #f2f3f6);
              }
            `}
          </style>
          <cf-vstack slot="header" gap="2">
            <cf-hstack justify="between" align="center" gap="3">
              <cf-vstack gap="0">
                <cf-heading level={3}>Agent sessions</cf-heading>
                <cf-text tone="muted">
                  Source collection, Fabric publication, and command execution
                </cf-text>
              </cf-vstack>
              <cf-badge color={computed(() => statusColor(status))}>
                {status}
              </cf-badge>
            </cf-hstack>
            <cf-tabs $value={activeTab}>
              <cf-tab-list>
                <cf-tab value="overview">Overview</cf-tab>
                <cf-tab value="sessions">Sessions</cf-tab>
                <cf-tab value="commands">Commands</cf-tab>
                <cf-tab value="activity">Activity</cf-tab>
                <cf-tab value="raw">Raw cells</cf-tab>
              </cf-tab-list>
            </cf-tabs>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-tabs $value={activeTab}>
              <cf-tab-panel value="overview">
                <cf-vstack gap="4" padding="4">
                  <cf-hstack gap="3" style="flex-wrap: wrap;">
                    <cf-card style="min-width: 150px; flex: 1;">
                      <cf-vstack gap="1">
                        <cf-text tone="muted">Sources</cf-text>
                        <cf-heading level={3}>{sourceCount}</cf-heading>
                      </cf-vstack>
                    </cf-card>
                    <cf-card style="min-width: 150px; flex: 1;">
                      <cf-vstack gap="1">
                        <cf-text tone="muted">Sessions</cf-text>
                        <cf-heading level={3}>{sessionCount}</cf-heading>
                      </cf-vstack>
                    </cf-card>
                    <cf-card style="min-width: 150px; flex: 1;">
                      <cf-vstack gap="1">
                        <cf-text tone="muted">Commands</cf-text>
                        <cf-heading level={3}>{commandCount}</cf-heading>
                      </cf-vstack>
                    </cf-card>
                    <cf-card style="min-width: 150px; flex: 1;">
                      <cf-vstack gap="1">
                        <cf-text tone="muted">Receipts</cf-text>
                        <cf-heading level={3}>{receiptCount}</cf-heading>
                      </cf-vstack>
                    </cf-card>
                  </cf-hstack>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={4}>Host</cf-heading>
                        <cf-badge color={computed(() => statusColor(status))}>
                          {status}
                        </cf-badge>
                      </cf-hstack>
                      <cf-table full-width>
                        <tbody>
                          <tr>
                            <th>Started</th>
                            <td>
                              {computed(() => stringValue(health?.startedAt))}
                            </td>
                          </tr>
                          <tr>
                            <th>Updated</th>
                            <td>
                              {computed(() => stringValue(health?.updatedAt))}
                            </td>
                          </tr>
                          <tr>
                            <th>Last sync</th>
                            <td>
                              {computed(() => {
                                const sync = health?.sync;
                                return `${stringValue(sync?.status)} · ${
                                  stringValue(sync?.reason)
                                } · ${stringValue(sync?.completedAt)}`;
                              })}
                            </td>
                          </tr>
                          <tr>
                            <th>Command admission</th>
                            <td>
                              {computed(() =>
                                health?.commandProcessing?.accepting
                                  ? "accepting"
                                  : "closed"
                              )}
                            </td>
                          </tr>
                          <tr>
                            <th>Pending receipt publications</th>
                            <td>
                              {computed(() =>
                                numberValue(
                                  health?.commandProcessing
                                    ?.pendingReceiptPublications,
                                )
                              )}
                            </td>
                          </tr>
                          <tr>
                            <th>Failed commands</th>
                            <td>
                              {computed(() =>
                                numberValue(
                                  health?.commandProcessing
                                    ?.failedCommands,
                                )
                              )}
                            </td>
                          </tr>
                          <tr>
                            <th>Last command error</th>
                            <td>
                              {computed(() =>
                                stringValue(
                                  health?.commandProcessing?.lastError,
                                )
                              )}
                            </td>
                          </tr>
                        </tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={4}>Sources</cf-heading>
                      <cf-table full-width hover>
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Driver</th>
                            <th>Status</th>
                            <th>Sessions</th>
                            <th>Complete</th>
                            <th>Errors</th>
                            <th>Last error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sources.map((source) => (
                            <tr>
                              <td>{stringValue(source.id)}</td>
                              <td>{stringValue(source.driver)}</td>
                              <td>
                                <cf-badge color={statusColor(source.status)}>
                                  {stringValue(source.status)}
                                </cf-badge>
                              </td>
                              <td>{numberValue(source.sessionCount)}</td>
                              <td>{source.complete === true ? "yes" : "no"}</td>
                              <td>
                                <details>
                                  <summary>
                                    {source.errors.length} errors
                                  </summary>
                                  <pre style="white-space: pre-wrap; overflow-wrap: anywhere;">
                                    {json(materializedCells(source.errors))}
                                  </pre>
                                </details>
                              </td>
                              <td>{stringValue(source.lastError)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={4}>Fabric cells</cf-heading>
                      <cf-table full-width>
                        <tbody>
                          {computed(() =>
                            cellRows(health).map((
                              [name, id],
                            ) => (
                              <tr>
                                <th>{name}</th>
                                <td style="font-family: monospace; overflow-wrap: anywhere;">
                                  {id}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={4}>Session indexes</cf-heading>
                      <cf-table full-width>
                        <thead>
                          <tr>
                            <th>Index</th>
                            <th>Generation</th>
                            <th>Generated</th>
                            <th>Rows</th>
                            <th>Total sessions</th>
                            <th>Older sessions</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Recent</td>
                            <td>
                              {computed(() => recentIndexState.generation)}
                            </td>
                            <td>
                              {computed(() => recentIndexState.generatedAt)}
                            </td>
                            <td>
                              {computed(() => recentIndexState.rowCount)}
                            </td>
                            <td>
                              {computed(() =>
                                recentIndexState.totalSessionCount
                              )}
                            </td>
                            <td>
                              {computed(() =>
                                recentIndexState.olderSessionCount
                              )}
                            </td>
                          </tr>
                          <tr>
                            <td>Complete</td>
                            <td>
                              {computed(() => completeIndexState.generation)}
                            </td>
                            <td>
                              {computed(() => completeIndexState.generatedAt)}
                            </td>
                            <td>
                              {computed(() => completeIndexState.rowCount)}
                            </td>
                            <td>
                              {computed(() =>
                                completeIndexState.totalSessionCount
                              )}
                            </td>
                            <td>
                              {computed(() =>
                                completeIndexState.olderSessionCount
                              )}
                            </td>
                          </tr>
                        </tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="sessions">
                <cf-vstack gap="3" padding="4">
                  <cf-hstack justify="between" align="center" gap="3">
                    <cf-heading level={4}>Published sessions</cf-heading>
                    <cf-hstack align="center" gap="2">
                      <cf-text tone="muted">
                        {computed(() =>
                          `Page ${
                            currentSessionPage + 1
                          } of ${sessionPageCount}`
                        )}
                      </cf-text>
                      <cf-text tone="muted">
                        {computed(() => sessionSortColumn.get() === null
                          ? ""
                          : "Sorting applies to this page"
                        )}
                      </cf-text>
                      <cf-button
                        variant="ghost"
                        size="sm"
                        disabled={computed(() => currentSessionPage === 0)}
                        onClick={movePage({
                          page: sessionPage,
                          currentPage: currentSessionPage,
                          delta: -1,
                        })}
                      >
                        Previous
                      </cf-button>
                      <cf-button
                        variant="ghost"
                        size="sm"
                        disabled={computed(() =>
                          currentSessionPage >= sessionPageCount - 1
                        )}
                        onClick={movePage({
                          page: sessionPage,
                          currentPage: currentSessionPage,
                          delta: 1,
                        })}
                      >
                        Next
                      </cf-button>
                      <cf-input
                        $value={sessionFilter}
                        placeholder="Filter this page"
                        style="min-width: 320px;"
                      />
                    </cf-hstack>
                  </cf-hstack>
                  <cf-card>
                    <cf-table full-width hover>
                      <thead>
                        <tr>
                          <th>Source</th>
                          <th
                            aria-sort={computed(() =>
                              sessionSortColumn.get() === "title"
                                ? sessionSortDirection.get()
                                : undefined
                            )}
                          >
                            <cf-button
                              variant="ghost"
                              size="sm"
                              title="Sort this page by title"
                              onClick={changeSessionSort({
                                column: sessionSortColumn,
                                direction: sessionSortDirection,
                                currentColumn: sessionSortColumn,
                                currentDirection: sessionSortDirection,
                                requestedColumn: "title",
                              })}
                            >
                              {titleSortLabel}
                            </cf-button>
                          </th>
                          <th>Status</th>
                          <th>Sync</th>
                          <th
                            aria-sort={computed(() =>
                              sessionSortColumn.get() === "idleFor"
                                ? sessionSortDirection.get()
                                : undefined
                            )}
                          >
                            <cf-button
                              variant="ghost"
                              size="sm"
                              title="Sort this page by idle time"
                              onClick={changeSessionSort({
                                column: sessionSortColumn,
                                direction: sessionSortDirection,
                                currentColumn: sessionSortColumn,
                                currentDirection: sessionSortDirection,
                                requestedColumn: "idleFor",
                              })}
                            >
                              {idleSortLabel}
                            </cf-button>
                          </th>
                          <th
                            aria-sort={computed(() =>
                              sessionSortColumn.get() === "worktree"
                                ? sessionSortDirection.get()
                                : undefined
                            )}
                          >
                            <cf-button
                              variant="ghost"
                              size="sm"
                              title="Sort this page by worktree"
                              onClick={changeSessionSort({
                                column: sessionSortColumn,
                                direction: sessionSortDirection,
                                currentColumn: sessionSortColumn,
                                currentDirection: sessionSortDirection,
                                requestedColumn: "worktree",
                              })}
                            >
                              {worktreeSortLabel}
                            </cf-button>
                          </th>
                          <th>Data</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleSessions.map((session) => (
                          <tr>
                            <td>{stringValue(session.sourceId)}</td>
                            <td>
                              <cf-vstack gap="0">
                                <cf-text>
                                  {stringValue(session.title, "(untitled)")}
                                </cf-text>
                              </cf-vstack>
                            </td>
                            <td>
                              <cf-badge
                                color={statusColor(
                                  session.conversationState,
                                )}
                              >
                                {session.conversationState}
                              </cf-badge>
                            </td>
                            <td>
                              <cf-badge
                                color={statusColor(session.syncStatus)}
                              >
                                {stringValue(session.syncStatus)}
                              </cf-badge>
                            </td>
                            <td title={session.updatedAt ?? undefined}>
                              {formatIdleFor(
                                session.updatedAt,
                                now.result ?? null,
                              )}
                            </td>
                            <td
                              title={session.gitWorktreeRoot ?? undefined}
                              style="font-family: monospace;"
                            >
                              {trailingPath(session.gitWorktreeRoot)}
                            </td>
                            <td>
                              <cf-hstack gap="2" align="center">
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Compose command for ${
                                    stringValue(
                                      session.title,
                                      "untitled session",
                                    )
                                  } (${stringValue(session.sourceId)})`}
                                  onClick={chooseSessionForCommand({
                                    sourceId: session.sourceId,
                                    nativeSessionId: session.nativeSessionId,
                                    selectTarget: selectCommandTarget,
                                  })}
                                >
                                  Command
                                </cf-button>
                                <cf-cell-link
                                  $cell={session.rawView}
                                  label="Raw data"
                                />
                              </cf-hstack>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </cf-table>
                  </cf-card>
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="commands">
                <cf-vstack gap="4" padding="4">
                  <cf-card>
                    <cf-vstack gap="3">
                      <cf-hstack justify="between" align="center" gap="3">
                        <cf-vstack gap="0">
                          <cf-heading level={4}>Send a command</cf-heading>
                          <cf-text tone="muted">
                            Review the exact Fabric command before the host
                            receives it.
                          </cf-text>
                        </cf-vstack>
                        <cf-badge
                          color={computed(() =>
                            commandAdmission ? "accent" : "danger"
                          )}
                        >
                          {computed(() => commandAdmission
                            ? "Host accepting commands"
                            : "Command admission stopped"
                          )}
                        </cf-badge>
                      </cf-hstack>

                      <cf-form oncf-submit={reviewCommand}>
                        <cf-vstack gap="3">
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "repeat(auto-fit, minmax(220px, 1fr))",
                              gap: "12px",
                            }}
                          >
                            <cf-field label="Source" required>
                              <cf-select
                                $value={commandSourceId}
                                items={commandSourceOptions}
                                style="width: 100%;"
                              />
                            </cf-field>
                            <cf-field label="Native session ID" required>
                              <cf-input
                                $value={commandNativeSessionId}
                                maxlength="1024"
                                required
                              />
                            </cf-field>
                            <cf-field label="Command" required>
                              <cf-select
                                $value={commandType}
                                items={[
                                  { label: "Prompt", value: "prompt" },
                                  { label: "Start session", value: "start" },
                                  { label: "Cancel", value: "cancel" },
                                  { label: "Rename", value: "rename" },
                                  { label: "Set mode", value: "set-mode" },
                                  {
                                    label: "Set configuration option",
                                    value: "set-config-option",
                                  },
                                ]}
                                style="width: 100%;"
                              />
                            </cf-field>
                          </div>

                          {commandIsPrompt
                            ? (
                              <cf-vstack gap="2">
                                <cf-field label="Prompt" required>
                                  <cf-textarea
                                    $value={commandPromptText}
                                    rows={6}
                                    maxlength={`${128 * 1_024}`}
                                    required
                                    resize="vertical"
                                  />
                                </cf-field>
                                <cf-checkbox $checked={commandForce}>
                                  Request forced prompt execution
                                </cf-checkbox>
                              </cf-vstack>
                            )
                            : null}
                          {commandIsCancel
                            ? (
                              <cf-text tone="muted">
                                Cancel targets an active prompt started by this
                                connector host.
                              </cf-text>
                            )
                            : null}
                          {commandNeedsArgument
                            ? (
                              <cf-field label={commandArgumentLabel} required>
                                <cf-input
                                  $value={commandArgument}
                                  maxlength={computed(() =>
                                    commandType.get() === "rename"
                                      ? "512"
                                      : "128"
                                  )}
                                  required
                                />
                              </cf-field>
                            )
                            : null}
                          {commandSetsConfig
                            ? (
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns:
                                    "repeat(auto-fit, minmax(220px, 1fr))",
                                  gap: "12px",
                                }}
                              >
                                <cf-field label="Option key" required>
                                  <cf-input
                                    $value={commandConfigKey}
                                    maxlength="256"
                                    required
                                  />
                                </cf-field>
                                <cf-field label="Value type" required>
                                  <cf-select
                                    $value={commandConfigValueType}
                                    items={[
                                      { label: "String", value: "string" },
                                      { label: "Boolean: true", value: "true" },
                                      {
                                        label: "Boolean: false",
                                        value: "false",
                                      },
                                    ]}
                                    style="width: 100%;"
                                  />
                                </cf-field>
                                {commandConfigIsString
                                  ? (
                                    <cf-field label="String value">
                                      <cf-input
                                        $value={commandConfigValue}
                                      />
                                    </cf-field>
                                  )
                                  : null}
                              </div>
                            )
                            : null}

                          {commandError
                            ? (
                              <div role="alert">
                                <cf-text tone="error">{commandError}</cf-text>
                              </div>
                            )
                            : null}
                          {commandLastSubmission
                            ? (
                              <div role="status">
                                <cf-text tone="success">
                                  {commandLastSubmission}
                                </cf-text>
                              </div>
                            )
                            : null}
                          <cf-hstack justify="end">
                            <cf-button
                              type="submit"
                              color="primary"
                              variant="solid"
                              disabled={computed(() => !commandAdmission)}
                            >
                              Review command
                            </cf-button>
                          </cf-hstack>
                        </cf-vstack>
                      </cf-form>

                      <cf-modal
                        $open={commandConfirmOpen}
                        presentation="dialog"
                        size="md"
                        dismissible
                        oncf-modal-close={cancelCommandReview}
                      >
                        <div slot="header">
                          <cf-heading level={4}>
                            Confirm agent command
                          </cf-heading>
                        </div>
                        <cf-vstack gap="3">
                          <cf-text>
                            Sending appends this command to the shared Fabric
                            command cell. The running host can act on the target
                            conversation immediately.
                          </cf-text>
                          <pre style="margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto;">
                            {pendingCommandJson}
                          </pre>
                          {commandError
                            ? (
                              <div role="alert">
                                <cf-text tone="error">{commandError}</cf-text>
                              </div>
                            )
                            : null}
                        </cf-vstack>
                        <div slot="footer">
                          <cf-hstack gap="2" justify="end">
                            <cf-button
                              variant="outline"
                              onClick={cancelCommandReview}
                            >
                              Keep editing
                            </cf-button>
                            <cf-button
                              color="primary"
                              variant="solid"
                              disabled={computed(() =>
                                pendingCommand.get() === null ||
                                pendingCommand.get() === undefined ||
                                !commandAdmission
                              )}
                              onClick={sendCommand}
                            >
                              Send command
                            </cf-button>
                          </cf-hstack>
                        </div>
                      </cf-modal>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center" gap="3">
                        <cf-heading level={4}>Command action values</cf-heading>
                        <cf-hstack align="center" gap="2">
                          <cf-text tone="muted">
                            {computed(() =>
                              `Page ${
                                currentCommandHistoryPage + 1
                              } of ${commandHistoryPageCount}`
                            )}
                          </cf-text>
                          <cf-button
                            variant="ghost"
                            size="sm"
                            disabled={computed(() =>
                              currentCommandHistoryPage === 0
                            )}
                            onClick={movePage({
                              page: commandHistoryPage,
                              currentPage: currentCommandHistoryPage,
                              delta: -1,
                            })}
                          >
                            Newer
                          </cf-button>
                          <cf-button
                            variant="ghost"
                            size="sm"
                            disabled={computed(() =>
                              currentCommandHistoryPage >=
                                commandHistoryPageCount - 1
                            )}
                            onClick={movePage({
                              page: commandHistoryPage,
                              currentPage: currentCommandHistoryPage,
                              delta: 1,
                            })}
                          >
                            Older
                          </cf-button>
                        </cf-hstack>
                      </cf-hstack>
                      <cf-table full-width hover>
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Source</th>
                            <th>Session</th>
                            <th>Type</th>
                            <th>Created</th>
                            <th>Payload</th>
                          </tr>
                        </thead>
                        <tbody>{commandRows}</tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>

                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-hstack justify="between" align="center" gap="3">
                        <cf-heading level={4}>Receipt index</cf-heading>
                        <cf-hstack align="center" gap="2">
                          <cf-text tone="muted">
                            {computed(() =>
                              `Page ${
                                currentReceiptPage + 1
                              } of ${receiptPageCount}`
                            )}
                          </cf-text>
                          <cf-button
                            variant="ghost"
                            size="sm"
                            disabled={computed(() => currentReceiptPage === 0)}
                            onClick={movePage({
                              page: receiptPage,
                              currentPage: currentReceiptPage,
                              delta: -1,
                            })}
                          >
                            Newer
                          </cf-button>
                          <cf-button
                            variant="ghost"
                            size="sm"
                            disabled={computed(() =>
                              currentReceiptPage >= receiptPageCount - 1
                            )}
                            onClick={movePage({
                              page: receiptPage,
                              currentPage: currentReceiptPage,
                              delta: 1,
                            })}
                          >
                            Older
                          </cf-button>
                        </cf-hstack>
                      </cf-hstack>
                      <cf-table full-width hover>
                        <thead>
                          <tr>
                            <th>Command</th>
                            <th>Source</th>
                            <th>Session</th>
                            <th>Status</th>
                            <th>Updated</th>
                            <th>Details</th>
                          </tr>
                        </thead>
                        <tbody>{receiptRows}</tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="activity">
                <cf-vstack gap="3" padding="4">
                  <cf-hstack justify="between" align="center">
                    <cf-heading level={4}>Host activity</cf-heading>
                    <cf-hstack align="center" gap="2">
                      <cf-text tone="muted">
                        {computed(() =>
                          `${activityCount} retained events · Page ${
                            currentActivityPage + 1
                          } of ${activityPageCount}`
                        )}
                      </cf-text>
                      <cf-button
                        variant="ghost"
                        size="sm"
                        disabled={computed(() => currentActivityPage === 0)}
                        onClick={movePage({
                          page: activityPage,
                          currentPage: currentActivityPage,
                          delta: -1,
                        })}
                      >
                        Newer
                      </cf-button>
                      <cf-button
                        variant="ghost"
                        size="sm"
                        disabled={computed(() =>
                          currentActivityPage >= activityPageCount - 1
                        )}
                        onClick={movePage({
                          page: activityPage,
                          currentPage: currentActivityPage,
                          delta: 1,
                        })}
                      >
                        Older
                      </cf-button>
                    </cf-hstack>
                  </cf-hstack>
                  <cf-card>
                    <cf-table full-width hover>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Type</th>
                          <th>Source</th>
                          <th>Message</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>{activityRows}</tbody>
                    </cf-table>
                  </cf-card>
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="raw">
                <cf-vstack gap="3" padding="4">
                  <cf-text tone="muted">
                    Each link opens an on-demand view of a top-level connector
                    cell. Session manifests and native event chunks remain
                    behind the links stored in the indexes.
                  </cf-text>
                  {([
                    ["Health", rawHealth],
                    ["Recent session index", rawRecentIndex],
                    ["Complete session index", rawCompleteIndex],
                    ["Commands", rawCommands],
                    ["Receipts", rawReceipts],
                  ] as const).map(([label, view]) => (
                    <cf-card>
                      <cf-hstack justify="between" align="center" gap="3">
                        <cf-text>{label}</cf-text>
                        <cf-cell-link $cell={view} label="Open raw data" />
                      </cf-hstack>
                    </cf-card>
                  ))}
                </cf-vstack>
              </cf-tab-panel>
            </cf-tabs>
          </cf-vscroll>
        </cf-screen>
      ),
      status,
      sourceCount,
      sessionCount,
      commandCount,
      receiptCount,
      activityCount,
      commandQueue: protectedCommands,
    };
  },
);

export default DebugView;
