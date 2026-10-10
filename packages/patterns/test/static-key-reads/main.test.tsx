import { assert, NAME, pattern, TESTS, VIEWS } from "commonfabric";
import { Listed, Wrapper } from "./subjects.tsx";

export default pattern(() => {
  const wrapper = Wrapper({ piece: "a" });
  const listed = Listed({ entries: [{ piece: "a" }, { piece: "b" }] });

  const assert_name_read_in_body = assert(() => wrapper[NAME] === "a");
  const assert_views_read_in_body = assert(() =>
    wrapper[VIEWS].row.rendered === "a"
  );
  const assert_name_read_under_plain_key = assert(() => wrapper.label === "a");
  const assert_path_below_views_read_in_body = assert(() =>
    wrapper.nested === "a"
  );
  const assert_const_key_read_in_body = assert(() => wrapper.viaConst === "a");
  const assert_computation_over_name = assert(() => wrapper.shout === "a!");
  const assert_name_read_in_callback = assert(() =>
    listed.rows.map((row) => row.label).join(",") === "a,b"
  );
  const assert_path_below_views_read_in_callback = assert(() =>
    listed.rows.map((row) => row.nested).join(",") === "a,b"
  );
  const assert_const_key_read_in_callback = assert(() =>
    listed.rows.map((row) => row.viaConst).join(",") === "a,b"
  );

  return {
    [TESTS]: [
      { assertion: assert_name_read_in_body },
      { assertion: assert_views_read_in_body },
      { assertion: assert_name_read_under_plain_key },
      { assertion: assert_path_below_views_read_in_body },
      { assertion: assert_const_key_read_in_body },
      { assertion: assert_computation_over_name },
      { assertion: assert_name_read_in_callback },
      { assertion: assert_path_below_views_read_in_callback },
      { assertion: assert_const_key_read_in_callback },
    ],
    wrapper,
    listed,
  };
});
