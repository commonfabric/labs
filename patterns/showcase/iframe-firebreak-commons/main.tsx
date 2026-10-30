/**
 * A shared wildfire drill shown in a sandboxed iframe, drawn with Phaser. Every
 * crew's actions are the pattern's `state`, from which each guest replays the
 * fire; each person's crew settings are kept for that user.
 */

import {
  dataFile,
  type Default,
  NAME,
  pattern,
  type PerUser,
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

/** What a Firebreak Commons piece is instantiated with. */
export interface IframeFirebreakCommonsInput {
  /** What the guest reads and cannot write. */
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;

  /** This user's crew: its name, color and preferred tool. */
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

/** A Firebreak Commons piece. */
export interface IframeFirebreakCommonsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the guest stores, shared by everyone on the piece. */
  state: IframeStateData;

  /** What the guest publishes, kept for each user. */
  output: IframeOutputData;
}

export default pattern<
  IframeFirebreakCommonsInput,
  IframeFirebreakCommonsOutput
>(({ input, output }) => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);

  return {
    [NAME]: "Firebreak Commons",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ input, state, output }}
          resourceKinds={{ input: "readonly" }}
        />
      </div>
    ),
    state,
    output,
  };
});
