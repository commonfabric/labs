/**
 * Instantiates Cursor Canvas and reads back its name, the defaults
 * its `state` and `output` start from, and the one `cf-iframe` its view
 * renders: the guest's document and bundle, and the resources it hands the
 * guest with the kind each one is bridged as.
 */

import { assert, dataFile, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  canonicalJson,
  contextResource,
} from "../../tools/test-support/iframe-pattern.ts";
import { DEFAULT_INPUT, DEFAULT_OUTPUT, DEFAULT_STATE } from "./contract.ts";
import IframeCursorCanvas from "./main.tsx";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export default pattern(() => {
  const canvas = IframeCursorCanvas({});

  const assert_name = assert(() => canvas[NAME] === "Cursor Canvas");
  const assert_state_starts_at_default = assert(() =>
    canonicalJson(canvas.state) === canonicalJson(DEFAULT_STATE)
  );
  const assert_output_starts_at_default = assert(() =>
    canonicalJson(canvas.output) === canonicalJson(DEFAULT_OUTPUT)
  );
  const assert_frame_loads_guest_document = assert(() =>
    propValue(findElement(canvas[UI], "cf-iframe"), "src") === GUEST_HTML
  );
  const assert_frame_runs_guest_bundle = assert(() =>
    propValue(findElement(canvas[UI], "cf-iframe"), "script") === GUEST_SCRIPT
  );
  const assert_context_names_four_resources = assert(() =>
    Object.keys(
      propValue(findElement(canvas[UI], "cf-iframe"), "$context") ?? {},
    ).sort().join(",") === "cursors,input,output,state"
  );
  const assert_context_input_holds_default = assert(() =>
    canonicalJson(contextResource(canvas[UI], "input")) ===
      canonicalJson(DEFAULT_INPUT)
  );
  // The presence room is the room of the shapes' own cell, so the resource
  // it is reached through holds the shapes.
  const assert_cursors_room_is_the_state = assert(() =>
    canonicalJson(contextResource(canvas[UI], "cursors")) ===
      canonicalJson(DEFAULT_STATE)
  );
  // Only the input is read-only and only `cursors` is a presence room;
  // `state` and `output` are bridged as the ordinary writable cells they are.
  const assert_resource_kinds = assert(() =>
    canonicalJson(
      propValue(findElement(canvas[UI], "cf-iframe"), "resourceKinds"),
    ) === canonicalJson({ input: "readonly", cursors: "presence" })
  );

  return {
    [TESTS]: [
      { assertion: assert_name },
      { assertion: assert_state_starts_at_default },
      { assertion: assert_output_starts_at_default },
      { assertion: assert_frame_loads_guest_document },
      { assertion: assert_frame_runs_guest_bundle },
      { assertion: assert_context_names_four_resources },
      { assertion: assert_context_input_holds_default },
      { assertion: assert_cursors_room_is_the_state },
      { assertion: assert_resource_kinds },
    ],
    canvas,
  };
});
