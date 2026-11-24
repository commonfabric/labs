/**
 * A machine of sensors, gates and actuators that several people wire together,
 * shown in a sandboxed iframe whose guest is a React app. The machine is the
 * pattern's `state`; each person's own view settings are kept for that user.
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

/** The module the guest runs, which `deno bundle` writes from `guest.tsx`. */
const GUEST_SCRIPT = dataFile("./guest.js");

/** What a Collaborative Impossible Machine piece is instantiated with. */
export interface IframeImpossibleMachineInput {
  /** What the guest reads and cannot write. */
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;

  /** This user's own view of the machine. */
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

/** A Collaborative Impossible Machine piece. */
export interface IframeImpossibleMachineOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the guest stores, shared by everyone on the piece. */
  state: IframeStateData;

  /** What the guest publishes, kept for each user. */
  output: IframeOutputData;
}

export default pattern<
  IframeImpossibleMachineInput,
  IframeImpossibleMachineOutput
>(({ input, output }) => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);

  return {
    [NAME]: "Collaborative Impossible Machine",
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
