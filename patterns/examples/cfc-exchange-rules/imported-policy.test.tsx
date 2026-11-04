import { assert, pattern, TESTS } from "commonfabric";
import ImportedPolicy from "./imported-policy.tsx";

export default pattern(() => {
  const defaultPolicy = ImportedPolicy({});
  const customPolicy = ImportedPolicy({ message: "Imported policy message" });

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          defaultPolicy.message ===
            "Protected by the defining module's rules"
        ),
      },
      {
        assertion: assert(() =>
          customPolicy.message === "Imported policy message"
        ),
      },
    ],
  };
});
