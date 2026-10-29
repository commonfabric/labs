import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findNodeById,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import PlainArrayCallbackLocals from "./main.tsx";

const at = (root: unknown, id: string) => textContent(findNodeById(root, id));

export default pattern(() => {
  const letters = new Writable(["a", "b", "c"]);
  const selection = new Writable("b");
  const visible = new Writable(2);
  const subject = PlainArrayCallbackLocals({ letters, selection, visible });
  const tree = subject[UI];

  const assert_marker = assert(() =>
    at(tree, "marker-0") === "away" &&
    at(tree, "marker-1") === "here" &&
    at(tree, "marker-2") === "away"
  );
  const assert_inline_optional = assert(() =>
    at(tree, "inline-optional-0") === "miss" &&
    at(tree, "inline-optional-1") === "match" &&
    at(tree, "inline-optional-2") === "miss"
  );
  const assert_inline_indexed = assert(() =>
    at(tree, "inline-indexed-0") === "miss" &&
    at(tree, "inline-indexed-1") === "match" &&
    at(tree, "inline-indexed-2") === "miss"
  );
  const assert_wrapped = assert(() =>
    at(tree, "wrapped-0") === "away" &&
    at(tree, "wrapped-1") === "here" &&
    at(tree, "wrapped-2") === "away"
  );
  const assert_negated = assert(() =>
    at(tree, "negated-0") === "off" &&
    at(tree, "negated-1") === "on" &&
    at(tree, "negated-2") === "off"
  );
  const assert_display = assert(() =>
    at(tree, "display-0") === "flex" &&
    at(tree, "display-1") === "flex" &&
    at(tree, "display-2") === "none"
  );
  const assert_label = assert(() =>
    at(tree, "label-0") === "a" &&
    at(tree, "label-1") === "b" &&
    at(tree, "label-2") === "c"
  );
  const assert_joined = assert(() =>
    at(tree, "joined--") === "a-b-c" &&
    at(tree, "joined-+") === "a+b+c"
  );

  // Every binding must stay live, not merely be right once. Moving the target
  // to "c" moves each comparison with it.
  const action_select_c = action(() => {
    subject.selectC.send();
  });
  const assert_marker_after = assert(() =>
    at(tree, "marker-0") === "away" &&
    at(tree, "marker-1") === "away" &&
    at(tree, "marker-2") === "here"
  );
  const assert_inline_optional_after = assert(() =>
    at(tree, "inline-optional-1") === "miss" &&
    at(tree, "inline-optional-2") === "match"
  );
  const assert_negated_after = assert(() =>
    at(tree, "negated-1") === "off" &&
    at(tree, "negated-2") === "on"
  );

  // A write to a cell the callback read eagerly reaches the same bindings.
  const action_rename_last = action(() => {
    subject.renameLast.send();
  });
  const assert_after_rename = assert(() =>
    at(tree, "marker-2") === "away" &&
    at(tree, "label-2") === "z" &&
    at(tree, "joined--") === "a-b-z"
  );

  return {
    [TESTS]: [
      { assertion: assert_marker },
      { assertion: assert_inline_optional },
      { assertion: assert_inline_indexed },
      { assertion: assert_wrapped },
      { assertion: assert_negated },
      { assertion: assert_display },
      { assertion: assert_label },
      { assertion: assert_joined },

      { action: action_select_c },
      { assertion: assert_marker_after },
      { assertion: assert_inline_optional_after },
      { assertion: assert_negated_after },

      { action: action_rename_last },
      { assertion: assert_after_rename },
    ],
    subject,
  };
});
