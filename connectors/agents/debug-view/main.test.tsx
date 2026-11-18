import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  propsOf,
  readValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import {
  RAW_CELL_LOADING_TEXT,
  RAW_SESSION_LOADING_TEXT,
  rawConversationData,
  SessionRawView,
} from "./main.tsx";
import {
  countCellLinks,
  DebugViewFixture,
  rawCellJson,
  rawCellView,
  startRawCellView,
} from "./test/fixture.ts";

/** The top-level cells the "Raw data" tab links a raw-data view for. */
const RAW_CELL_LABELS = [
  "Health",
  "Recent session index",
  "Complete session index",
  "Commands",
  "Receipts",
];

export default pattern(() => {
  const fixture = DebugViewFixture();
  const view = fixture.view;
  const manifest = fixture.manifest;
  const firstSessionSync = fixture.firstSessionSync;
  const publishedSessionCount = fixture.publishedSessionCount;
  const status = fixture.status;
  const activityCount = fixture.activityCount;
  const receiptCount = fixture.receiptCount;
  const commands = fixture.commands;
  const rawView = SessionRawView({
    manifest,
    sourceId: "codex",
    nativeSessionId: "session-1",
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
  const assert_raw_conversation_data = assert(() => {
    const data = JSON.stringify(rawConversationData(manifest));
    return data.includes('"nativeSessionId":"session-1"') &&
      data.includes('"text":"Done"') &&
      !data.includes('"link"');
  });
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

  // A queued value that is not a command shows as invalid without its
  // contents, and keeps its raw-data link.
  const action_publish_invalid_command = action(() => {
    commands.push("not command JSON");
  });
  const assert_invalid_command_visible = assert(() => {
    const commandTable = findElementByText(view[UI], "cf-table", "Payload");
    return view.commandCount === 1 &&
      textContent(commandTable).includes("Invalid action value") &&
      !textContent(commandTable).includes("not command JSON") &&
      countCellLinks(commandTable, "Raw data") === 1;
  });
  const action_publish_nested_array_command = action(() => {
    commands.push([["nested invalid action"]]);
  });
  const assert_nested_array_command_visible = assert(() => {
    const commandTable = findElementByText(view[UI], "cf-table", "Payload");
    return view.commandCount === 2 &&
      !textContent(commandTable).includes("nested invalid action") &&
      countCellLinks(commandTable, "Raw data") === 2;
  });

  // Each top-level cell's raw-data view shows its loading text until it
  // starts, then the stored value of the cell it names.
  const assert_raw_cells_loading = assert(() =>
    rawCellView(view[UI], "Health")[NAME] === "Health — raw data" &&
    RAW_CELL_LABELS.every((label) =>
      rawCellJson(view[UI], label) === RAW_CELL_LOADING_TEXT
    )
  );
  const action_open_raw_cells = action(() => {
    for (const label of RAW_CELL_LABELS) {
      startRawCellView(view[UI], label);
    }
  });
  const assert_raw_cells_loaded = assert(() =>
    rawCellJson(view[UI], "Health").includes('"service": "agents-host"') &&
    rawCellJson(view[UI], "Recent session index").includes(
      '"schema": "commonfabric.agent-connector.session-index"',
    ) &&
    rawCellJson(view[UI], "Complete session index").includes(
      '"schema": "commonfabric.agent-connector.session-index"',
    ) &&
    rawCellJson(view[UI], "Commands").includes("not command JSON") &&
    !rawCellJson(view[UI], "Health").includes("not command JSON") &&
    rawCellJson(view[UI], "Receipts").includes(
      '"schema": "commonfabric.agent-connector.command-receipts"',
    ) &&
    rawCellView(view[UI], "Commands")[NAME] === "Commands — raw data" &&
    rawCellView(view[UI], "Receipts")[NAME] === "Receipts — raw data" &&
    rawCellView(view[UI], "Recent session index")[NAME] ===
      "Recent session index — raw data"
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_summary },
      { assertion: assert_raw_cells_loading },
      { assertion: assert_raw_session_loading },
      { assertion: assert_raw_session_provenance },
      { action: rawView.load },
      { assertion: assert_raw_session_data },
      { assertion: assert_raw_conversation_data },
      { assertion: assert_loaded_session_provenance },
      { action: action_publish_changes },
      { assertion: assert_updated_status },
      { assertion: assert_updated_sessions },
      { assertion: assert_updated_commands },
      { assertion: assert_updated_receipts },
      { assertion: assert_updated_activity },
      { action: action_publish_invalid_command },
      { assertion: assert_invalid_command_visible },
      { action: action_publish_nested_array_command },
      { assertion: assert_nested_array_command_visible },
      { action: action_open_raw_cells },
      { assertion: assert_raw_cells_loaded },
    ],
    view,
  };
});
