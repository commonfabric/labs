import { assertEquals } from "@std/assert";
import type { JSONSchema } from "../index.ts";

const stampedSchema = {
  type: "string",
  ifc: {
    writeAuthorizedBy: {
      __ctWriterIdentityOf: {
        file: "/patterns/profile-home.tsx",
        path: ["setBio"],
        moduleIdentity: "cf:module/profile-home-v1",
      },
    },
  },
} as const satisfies JSONSchema;

const agedUnstampedSchema = {
  type: "string",
  ifc: {
    writeAuthorizedBy: {
      __ctWriterIdentityOf: {
        file: "/patterns/profile-home.tsx",
        path: ["setBio"],
      },
    },
  },
} as const satisfies JSONSchema;

Deno.test("JSONSchema represents stamped and aged unstamped writer claims", () => {
  assertEquals(
    stampedSchema.ifc.writeAuthorizedBy.__ctWriterIdentityOf.moduleIdentity,
    "cf:module/profile-home-v1",
  );
  assertEquals(
    "moduleIdentity" in
      agedUnstampedSchema.ifc.writeAuthorizedBy.__ctWriterIdentityOf,
    false,
  );
});
