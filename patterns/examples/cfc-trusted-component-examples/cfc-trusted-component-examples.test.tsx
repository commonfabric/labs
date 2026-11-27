import { assert, NAME, pattern, TESTS } from "commonfabric";
import TrustedComponentExamples from "./cfc-trusted-component-examples.tsx";

export default pattern(() => {
  const gallery = TrustedComponentExamples({});
  const assert_total_examples = assert(() =>
    gallery[NAME] === "CFC Trusted Component Example Gallery" &&
    gallery.totalExamples === 52
  );

  return {
    [TESTS]: [{ assertion: assert_total_examples }],
    gallery,
  };
});
