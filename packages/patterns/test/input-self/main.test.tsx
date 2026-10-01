import { action, assert, pattern, TESTS } from "commonfabric";
import {
  Aliased,
  CapturedAlias,
  Destructured,
  DestructuredInBody,
  HandedToChild,
  HandlerBound,
  Indexed,
  IndexedTitle,
  NamedThroughAlias,
  OverOwnList,
} from "./subjects.tsx";

export default pattern(() => {
  const destructured = Destructured({ title: "hello" });
  const indexed = Indexed({ title: "hello" });
  const aliased = Aliased({ title: "hello" });
  const indexedTitle = IndexedTitle({ title: "hello" });
  const handedToChild = HandedToChild({ title: "hello" });
  const handlerBound = HandlerBound({ title: "hello", seen: "" });
  const overOwnList = OverOwnList({ items: ["a", "b"] });
  const namedThroughAlias = NamedThroughAlias({ title: "hello" });
  const destructuredInBody = DestructuredInBody({ title: "hello" });
  const capturedAlias = CapturedAlias({ title: "hello", items: ["a", "b"] });

  const assert_destructured_self_is_the_result = assert(() =>
    destructured.other?.title === "hello"
  );
  const assert_indexed_self_is_the_result = assert(() =>
    indexed.other?.title === "hello"
  );
  const assert_aliased_self_is_the_result = assert(() =>
    aliased.other?.title === "hello"
  );
  const assert_indexed_self_title_is_the_result_title = assert(() =>
    indexedTitle.otherTitle === "hello"
  );
  const assert_child_reads_the_result = assert(() =>
    handedToChild.child.roomTitle === "hello"
  );
  const assert_mapped_own_list = assert(() =>
    overOwnList.echoed.join(",") === "a!,b!"
  );
  const assert_filtered_own_list = assert(() =>
    overOwnList.kept.join(",") === "a"
  );
  const assert_destructured_in_body_is_the_result = assert(() =>
    destructuredInBody.other?.title === "hello"
  );
  const assert_method_call_through_self = assert(() =>
    capturedAlias.shouted === "HELLO"
  );
  const assert_alias_captured_in_computed = assert(() =>
    capturedAlias.computedTitle === "hello"
  );
  const assert_alias_captured_in_map = assert(() =>
    capturedAlias.mappedTitles.join(",") === "hello,hello"
  );
  const assert_name_read_off_alias = assert(() =>
    namedThroughAlias.myName === "hello"
  );
  const assert_handler_has_not_run = assert(() => handlerBound.seen === "");
  const action_copy_title = action(() => {
    handlerBound.copy.send();
  });
  const assert_handler_read_the_result = assert(() =>
    handlerBound.seen === "hello"
  );

  return {
    [TESTS]: [
      { assertion: assert_destructured_self_is_the_result },
      { assertion: assert_indexed_self_is_the_result },
      { assertion: assert_aliased_self_is_the_result },
      { assertion: assert_indexed_self_title_is_the_result_title },
      { assertion: assert_child_reads_the_result },
      { assertion: assert_mapped_own_list },
      { assertion: assert_filtered_own_list },
      { assertion: assert_destructured_in_body_is_the_result },
      { assertion: assert_method_call_through_self },
      { assertion: assert_alias_captured_in_computed },
      { assertion: assert_alias_captured_in_map },
      { assertion: assert_name_read_off_alias },
      { assertion: assert_handler_has_not_run },
      { action: action_copy_title },
      { assertion: assert_handler_read_the_result },
    ],
    destructured,
    indexed,
    aliased,
    indexedTitle,
    handedToChild,
    handlerBound,
    overOwnList,
    destructuredInBody,
    capturedAlias,
    namedThroughAlias,
  };
});
