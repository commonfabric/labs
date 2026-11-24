import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";
import { isCfcMigrationRejection } from "../src/ops/cfc-migration-rejection.ts";

const REJECTION_PREFIX =
  "CFC enforcement rejected commit: relevant transaction was not prepared";

describe("isCfcMigrationRejection", () => {
  it("recognizes the migration token in the reason position", () => {
    expect(isCfcMigrationRejection(
      new Error(
        `${REJECTION_PREFIX}: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: ` +
          "required field favorites needs a default to preserve old documents",
      ),
    )).toBe(true);
  });

  it("stays fail-closed on a token framed inside another reason's message", () => {
    expect(isCfcMigrationRejection(
      new Error(
        `${REJECTION_PREFIX}: incompatible types at ` +
          `/a: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: b`,
      ),
    )).toBe(false);
  });

  it("stays fail-closed on a token in a path and on other rejections", () => {
    expect(isCfcMigrationRejection(
      new Error(
        `${REJECTION_PREFIX}: incompatible types at ` +
          `/${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}`,
      ),
    )).toBe(false);
    expect(isCfcMigrationRejection(
      new Error(`${REJECTION_PREFIX}: policy refused the write`),
    )).toBe(false);
    expect(isCfcMigrationRejection(
      new Error(`not prepared: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: x`),
    )).toBe(false);
    expect(isCfcMigrationRejection("not an error")).toBe(false);
  });
});
