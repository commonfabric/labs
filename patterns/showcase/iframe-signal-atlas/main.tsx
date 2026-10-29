/**
 * A map of signal observations and the routes between them, shown in a
 * sandboxed iframe drawn with D3. The observations are the pattern's `state`,
 * each person's bookmarks and hypotheses are in a SQLite database of their own,
 * and where each browser session has the map panned is kept for that session.
 */

import {
  cfSqlite,
  dataFile,
  type Default,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  sqliteDatabase,
  type SqliteDb,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

/** The guest's document. */
const GUEST_HTML = dataFile("./guest.html");

/** The module the guest runs, which `deno bundle` writes from `guest.ts`. */
const GUEST_SCRIPT = dataFile("./guest.js");

/** What a Signal Propagation Atlas piece is instantiated with. */
export interface SignalPropagationAtlasInput {
  /** What the guest reads and cannot write. */
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;

  /** Where this session has the map panned and zoomed. */
  output?: PerSession<
    Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>
  >;
}

/** A Signal Propagation Atlas piece. */
export interface SignalPropagationAtlasOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the guest stores, shared by everyone on the piece. */
  state: IframeStateData;

  /** What the guest publishes, kept for each browser session. */
  output: IframeOutputData;
}

export default pattern<
  SignalPropagationAtlasInput,
  SignalPropagationAtlasOutput
>(({ input, output }) => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);
  const { table } = cfSqlite;
  const personalAtlas: PerUser<SqliteDb> = sqliteDatabase({
    tables: {
      atlas_bookmarks: table({
        id: "text primary key",
        observation_id: "text not null",
        note: "text not null",
        created_at: "integer not null",
      }),
      atlas_hypotheses: table({
        id: "text primary key",
        title: "text not null",
        narrative: "text not null",
        status: "text not null",
        created_at: "integer not null",
      }),
    },
  });

  return {
    [NAME]: "Signal Propagation Atlas",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ input, state, output, personalAtlas }}
          resourceKinds={{ input: "readonly", personalAtlas: "sqlite" }}
        />
      </div>
    ),
    state,
    output,
  };
});
