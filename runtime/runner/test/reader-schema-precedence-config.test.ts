import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getReaderSchemaPrecedenceConfig,
  resetReaderSchemaPrecedenceConfig,
  setReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";

describe("reader-schema-precedence-config", () => {
  afterEach(() => {
    resetReaderSchemaPrecedenceConfig();
  });

  it("defaults on", () => {
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });

  it("takes an explicit false and reads it back", () => {
    setReaderSchemaPrecedenceConfig(false);
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);
  });

  it("treats an unset value as the default", () => {
    setReaderSchemaPrecedenceConfig(false);
    setReaderSchemaPrecedenceConfig(undefined);
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });

  it("resets to the default", () => {
    setReaderSchemaPrecedenceConfig(false);
    resetReaderSchemaPrecedenceConfig();
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
  });
});
