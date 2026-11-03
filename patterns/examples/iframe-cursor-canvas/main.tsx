/**
 * A board of shapes that several people move and resize at once, shown in a
 * sandboxed iframe. The shapes are the pattern's `state`; each person's pointer,
 * and a shape's box while someone drags it, travel through the presence room of
 * that state and are stored nowhere.
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

/** What a Cursor Canvas piece is instantiated with. */
export interface IframeCursorCanvasInput {
  /** What the guest reads and cannot write. */
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;

  /** Each person's name and color on the board, kept for each user. */
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

/** A Cursor Canvas piece. */
export interface IframeCursorCanvasOutput {
  [NAME]: string;
  [UI]: VNode;

  /** What the guest stores, shared by everyone on the piece. */
  state: IframeStateData;

  /** What the guest publishes, kept for each user. */
  output: IframeOutputData;
}

export default pattern<IframeCursorCanvasInput, IframeCursorCanvasOutput>(
  ({ input, output }) => {
    const state = new Writable<IframeStateData>(DEFAULT_STATE);

    return {
      [NAME]: "Cursor Canvas",
      [UI]: (
        <div style={{ width: "100%", height: "100vh" }}>
          <cf-iframe
            src={GUEST_HTML}
            script={GUEST_SCRIPT}
            $context={{ input, state, output, cursors: state }}
            resourceKinds={{ input: "readonly", cursors: "presence" }}
          />
        </div>
      ),
      state,
      output,
    };
  },
);
