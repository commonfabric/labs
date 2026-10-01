import { action, assert, pattern, TESTS } from "commonfabric";
import {
  Aliased,
  Destructured,
  HandedToChild,
  HandlerBound,
  Indexed,
  IndexedTitle,
} from "./subjects.tsx";

export default pattern(() => {
  const destructured = Destructured({ title: "hello" });
  const indexed = Indexed({ title: "hello" });
  const aliased = Aliased({ title: "hello" });
  const indexedTitle = IndexedTitle({ title: "hello" });
  const handedToChild = HandedToChild({ title: "hello" });
  const handlerBound = HandlerBound({ title: "hello", seen: "" });

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
  };
});
