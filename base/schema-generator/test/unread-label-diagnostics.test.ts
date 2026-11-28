import { expect } from "@std/expect";

import { getLogger } from "@commonfabric/logger";
import { describe, it } from "@commonfabric/test-support/test";

import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

const CONFIDENTIAL = `
  type Confidential<T, L> = T & {
    readonly __ct_cfc__?: { readonly meta?: { confidentiality: L }; readonly of?: T };
  };
`;

/**
 * The messages the `schema-generator.unread` logger receives at each level
 * while a schema is generated for `SchemaRoot` in `code`, with no diagnostic
 * callback supplied.
 */
async function loggedFor(
  code: string,
): Promise<{ errors: string[]; warnings: string[] }> {
  const { type, checker } = await getTypeFromCode(
    CONFIDENTIAL + code,
    "SchemaRoot",
  );
  const logger = getLogger("schema-generator.unread");
  const { error, warn } = logger;
  const errors: string[] = [];
  const warnings: string[] = [];
  const into = (logged: string[]) => (_key: string, ...messages: unknown[]) => {
    for (const message of messages) {
      logged.push(String(typeof message === "function" ? message() : message));
    }
  };
  logger.error = into(errors);
  logger.warn = into(warnings);
  try {
    new SchemaGenerator().generateSchema(type, checker);
  } finally {
    logger.error = error;
    logger.warn = warn;
  }
  return { errors, warnings };
}

describe("unread-label-diagnostics", () => {
  describe("reportLabelReading()", () => {
    it("logs an error for a label list that is no list, where no callback is supplied", async () => {
      const { errors, warnings } = await loggedFor(
        `interface SchemaRoot { t: Confidential<string, string[]> }`,
      );

      expect(warnings).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        "A label list of `Confidential` is not a list: `string[]`",
      );
    });

    it("logs a warning for a label list read in part, where no callback is supplied", async () => {
      const { errors, warnings } = await loggedFor(
        `interface SchemaRoot { t: Confidential<string, readonly ["a" | "b"]> }`,
      );

      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        "A label of `Confidential` could not be read",
      );
    });
  });
});
