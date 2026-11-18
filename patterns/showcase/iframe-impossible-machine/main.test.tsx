/**
 * Instantiates Collaborative Impossible Machine and reads back its name, the defaults
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
import IframeImpossibleMachine from "./main.tsx";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export default pattern(() => {
  const machine = IframeImpossibleMachine({});

  const assert_name = assert(() =>
    machine[NAME] === "Collaborative Impossible Machine"
  );
  const assert_state_starts_at_default = assert(() =>
    canonicalJson(machine.state) === canonicalJson(DEFAULT_STATE)
  );
  const assert_output_starts_at_default = assert(() =>
    canonicalJson(machine.output) === canonicalJson(DEFAULT_OUTPUT)
  );
  const assert_frame_loads_guest_document = assert(() =>
    propValue(findElement(machine[UI], "cf-iframe"), "src") === GUEST_HTML
  );
  const assert_frame_runs_guest_bundle = assert(() =>
    propValue(findElement(machine[UI], "cf-iframe"), "script") === GUEST_SCRIPT
  );
  const assert_context_names_three_resources = assert(() =>
    Object.keys(
      propValue(findElement(machine[UI], "cf-iframe"), "$context") ?? {},
    ).sort().join(",") === "input,output,state"
  );
  const assert_context_input_holds_default = assert(() =>
    canonicalJson(contextResource(machine[UI], "input")) ===
      canonicalJson(DEFAULT_INPUT)
  );
  // Only the input is read-only; `state` and `output` are bridged as the
  // ordinary writable cells they are.
  const assert_resource_kinds = assert(() =>
    canonicalJson(
      propValue(findElement(machine[UI], "cf-iframe"), "resourceKinds"),
    ) === canonicalJson({ input: "readonly" })
  );

  return {
    [TESTS]: [
      { assertion: assert_name },
      { assertion: assert_state_starts_at_default },
      { assertion: assert_output_starts_at_default },
      { assertion: assert_frame_loads_guest_document },
      { assertion: assert_frame_runs_guest_bundle },
      { assertion: assert_context_names_three_resources },
      { assertion: assert_context_input_holds_default },
      { assertion: assert_resource_kinds },
    ],
    machine,
  };
});
