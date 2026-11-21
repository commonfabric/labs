import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  fireClick,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import {
  DebugViewFixture,
  sessionRowPrecedes,
  sessionSortState,
  sessionTable,
  setSessionFilter,
} from "./test/fixture.ts";

const TITLE_SORT = "Sort this page by title";
const IDLE_SORT = "Sort this page by idle time";
const WORKTREE_SORT = "Sort this page by worktree";

export default pattern(() => {
  const fixture = DebugViewFixture();
  const view = fixture.view;
  const publishedSessionCount = fixture.publishedSessionCount;

  // Sorting a column orders the page's rows by it and marks only that
  // column's heading, and a second click on the same column reverses it.
  const action_publish_second_session = action(() => {
    publishedSessionCount.set(2);
  });
  const assert_sessions_unsorted = assert(() =>
    sessionSortState(view[UI], TITLE_SORT) === undefined &&
    sessionSortState(view[UI], IDLE_SORT) === undefined &&
    sessionRowPrecedes(view[UI], "Debug session", "Second session")
  );
  const action_sort_by_title = action(() => {
    fireClick(findNodeByProp(view[UI], "title", TITLE_SORT), "title sort");
  });
  const assert_sorted_by_title_ascending = assert(() =>
    sessionSortState(view[UI], TITLE_SORT) === "ascending" &&
    sessionSortState(view[UI], IDLE_SORT) === undefined &&
    sessionRowPrecedes(view[UI], "Debug session", "Second session")
  );
  const assert_sorted_by_title_descending = assert(() =>
    sessionSortState(view[UI], TITLE_SORT) === "descending" &&
    sessionSortState(view[UI], IDLE_SORT) === undefined &&
    sessionRowPrecedes(view[UI], "Second session", "Debug session")
  );
  const action_sort_by_idle = action(() => {
    fireClick(findNodeByProp(view[UI], "title", IDLE_SORT), "idle sort");
  });
  const assert_sorted_by_idle_ascending = assert(() =>
    sessionSortState(view[UI], IDLE_SORT) === "ascending" &&
    sessionSortState(view[UI], TITLE_SORT) === undefined
  );
  const action_sort_by_worktree = action(() => {
    fireClick(
      findNodeByProp(view[UI], "title", WORKTREE_SORT),
      "worktree sort",
    );
  });
  const assert_sorted_by_worktree_ascending = assert(() =>
    sessionSortState(view[UI], WORKTREE_SORT) === "ascending" &&
    sessionSortState(view[UI], IDLE_SORT) === undefined
  );

  // The filter keeps the rows whose text matches and drops the others.
  const action_filter_unmatched = action(() => {
    setSessionFilter(view[UI], "no such worktree");
  });
  const assert_filter_hides_session = assert(() =>
    !textContent(sessionTable(view[UI])).includes("Debug session")
  );
  const action_filter_matched = action(() => {
    setSessionFilter(view[UI], " DEBUG ");
  });
  const assert_filter_keeps_session = assert(() =>
    textContent(sessionTable(view[UI])).includes("Debug session")
  );

  return {
    [TESTS]: [
      { action: action_publish_second_session },
      { assertion: assert_sessions_unsorted },
      { action: action_sort_by_title },
      { assertion: assert_sorted_by_title_ascending },
      { action: action_sort_by_title },
      { assertion: assert_sorted_by_title_descending },
      { action: action_sort_by_idle },
      { assertion: assert_sorted_by_idle_ascending },
      { action: action_sort_by_worktree },
      { assertion: assert_sorted_by_worktree_ascending },
      { action: action_filter_unmatched },
      { assertion: assert_filter_hides_session },
      { action: action_filter_matched },
      { assertion: assert_filter_keeps_session },
    ],
    view,
  };
});
