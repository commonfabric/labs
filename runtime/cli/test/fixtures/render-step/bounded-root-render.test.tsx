import { assert, computed, pattern, TESTS } from "commonfabric";
import { afterRenderBranch, lateVDOMBranch } from "./subject.tsx";

export default pattern(() => {
  const view = {
    type: "vnode",
    name: "div",
    props: {},
    children: [computed(() => lateVDOMBranch())],
    ignoredMetadata: computed(() => afterRenderBranch()),
  };
  return {
    [TESTS]: [
      { render: view },
      { assertion: assert(() => true) },
    ],
  };
});
