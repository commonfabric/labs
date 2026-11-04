import { assert, pattern, TESTS } from "commonfabric";
import DirectRelease from "./direct-release.tsx";

export default pattern(() => {
  const defaultRelease = DirectRelease({});
  const customRelease = DirectRelease({ message: "Review-ready summary" });

  const assert_default_message = assert(() =>
    defaultRelease.message === "Private until reader evidence is present"
  );
  const assert_custom_message = assert(() =>
    customRelease.message === "Review-ready summary"
  );

  return {
    [TESTS]: [
      { assertion: assert_default_message },
      { assertion: assert_custom_message },
    ],
    defaultRelease,
    customRelease,
  };
});
