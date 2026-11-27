import { expect } from "@std/expect";

import {
  createCompileByteCache,
  createUnifiedDiff,
  defineFixtureSuite,
  flushCompileByteCache,
  ProcessModuleByteCache,
  runDenoCheckWithTemporaryConfig,
  runDenoCommandWithTemporaryLock,
  shouldUpdateGoldens,
} from "./mod.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("test-support module exports", () => {
  it("exposes the runtime helpers from the public module", () => {
    expect(createCompileByteCache()).toBeInstanceOf(ProcessModuleByteCache);
    expect(typeof createUnifiedDiff).toBe("function");
    expect(typeof defineFixtureSuite).toBe("function");
    expect(typeof flushCompileByteCache).toBe("function");
    expect(typeof runDenoCheckWithTemporaryConfig).toBe("function");
    expect(typeof runDenoCommandWithTemporaryLock).toBe("function");
    expect(typeof shouldUpdateGoldens).toBe("function");
  });
});
