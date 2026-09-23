import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  cacheHarnessFabricSessionFactory,
  createHarnessFabricSessionFactory,
  type HarnessFabricSession,
  harnessFabricSessionControllerOptions,
} from "../src/fabric-session.ts";

const identity = await Identity.fromPassphrase("fabric-session factory");

/** A controller whose runtime reports the given read ceiling. */
const controllerBoundedBy = (
  ceiling: {
    cfcReadMaxConfidentiality?: readonly unknown[];
    cfcReadOnExceed?: "fail" | "skip";
  },
  disposed: string[],
): PiecesController =>
  ({
    runtime: {
      cfcReadMaxConfidentiality: ceiling.cfcReadMaxConfidentiality,
      cfcReadOnExceed: ceiling.cfcReadOnExceed,
      dispose: () => {
        disposed.push("runtime");
        return Promise.resolve();
      },
    },
  }) as unknown as PiecesController;

describe("fabric-session", () => {
  describe("harnessFabricSessionControllerOptions()", () => {
    const base = {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    };

    it("resolves the space and API URL and carries no dial the config omits", () => {
      const options = harnessFabricSessionControllerOptions(base);
      expect(options.apiUrl.href).toBe("https://toolshed.example/");
      expect(options.space).toBe("my-space");
      expect("cfcEnforcementMode" in options).toBe(false);
      expect("cfcFlowLabels" in options).toBe(false);
      expect("cfcPosture" in options).toBe(false);
      expect("cfcReadMaxConfidentiality" in options).toBe(false);
      expect("cfcReadOnExceed" in options).toBe(false);
    });

    it("carries the read ceiling the config sets, with its onExceed", () => {
      const options = harnessFabricSessionControllerOptions({
        ...base,
        cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
        cfcReadOnExceed: "skip",
      });
      expect(options.cfcReadMaxConfidentiality).toEqual([
        "did:key:zOwner",
        "did:key:zFacet",
      ]);
      expect(options.cfcReadOnExceed).toBe("skip");
    });

    it("carries every dial the config sets, posture included", () => {
      const options = harnessFabricSessionControllerOptions({
        ...base,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcPosture: "max-enforcement",
      });
      expect(options.cfcEnforcementMode).toBe("enforce-strict");
      expect(options.cfcFlowLabels).toBe("persist");
      expect(options.cfcPosture).toBe("max-enforcement");
    });
  });

  describe("createHarnessFabricSessionFactory()", () => {
    it("registers admitted hosts before returning the session under its own identity", async () => {
      const routed: Array<[string, string]> = [];
      const controller = {
        getSpace: () => "did:key:zLocal",
        runtime: {
          registerSpaceHost: (space: string, host: string) => {
            routed.push([space, host]);
            return true;
          },
        },
      } as unknown as PiecesController;
      const session = await createHarnessFabricSessionFactory({
        apiUrl: "https://local.example/",
        identityKeyPath: "/fixture.key",
        space: "local",
        foreignSpaces: { "did:key:zForeign": "https://foreign.example" },
      }, {
        loadIdentity: () => Promise.resolve(identity),
        initialize: (options) => {
          expect(options.identity).toBe(identity);
          expect(routed).toEqual([]);
          return Promise.resolve(controller);
        },
      })();
      expect(routed).toEqual([[
        "did:key:zForeign",
        "https://foreign.example/",
      ]]);
      expect(session.foreignSpaces).toEqual(Object.fromEntries(routed));
      expect(session.identity).toBe(identity);
    });

    it("disposes the session when an admitted route is refused", async () => {
      const disposed: string[] = [];
      const controller = controllerBoundedBy({}, disposed);
      controller.getSpace = () => "did:key:zLocal";
      controller.runtime.registerSpaceHost = () => false;
      const factory = createHarnessFabricSessionFactory({
        apiUrl: "https://local.example/",
        identityKeyPath: "/fixture.key",
        space: "local",
        foreignSpaces: { "did:key:zForeign": "https://foreign.example" },
      }, {
        loadIdentity: () => Promise.resolve(identity),
        initialize: () => Promise.resolve(controller),
      });
      await expect(factory()).rejects.toThrow("host route was refused");
      expect(disposed).toEqual(["runtime"]);
    });

    const bounded = {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
      cfcReadOnExceed: "skip" as const,
    };

    it("hands the controller the read ceiling and returns the bounded session", async () => {
      const disposed: string[] = [];
      let received: Record<string, unknown> | undefined;
      const factory = createHarnessFabricSessionFactory(bounded, {
        loadIdentity: () => Promise.resolve(identity),
        initialize: (options) => {
          received = options as Record<string, unknown>;
          return Promise.resolve(controllerBoundedBy(bounded, disposed));
        },
      });
      const session = await factory();
      expect(received?.cfcReadMaxConfidentiality).toEqual(
        bounded.cfcReadMaxConfidentiality,
      );
      expect(received?.cfcReadOnExceed).toBe("skip");
      expect(session.identity).toBe(identity);
      expect(disposed).toEqual([]);
    });

    it("refuses a session whose runtime is not bounded as configured, and disposes it", async () => {
      const disposed: string[] = [];
      const factory = createHarnessFabricSessionFactory(bounded, {
        loadIdentity: () => Promise.resolve(identity),
        initialize: () => Promise.resolve(controllerBoundedBy({}, disposed)),
      });
      await expect(factory()).rejects.toThrow(
        /not bounded by the configured read ceiling/,
      );
      expect(disposed).toEqual(["runtime"]);
    });

    it("refuses a session whose runtime is bounded by another ceiling", async () => {
      const disposed: string[] = [];
      const factory = createHarnessFabricSessionFactory(bounded, {
        loadIdentity: () => Promise.resolve(identity),
        initialize: () =>
          Promise.resolve(
            controllerBoundedBy({
              cfcReadMaxConfidentiality: ["did:key:zOwner"],
              cfcReadOnExceed: "skip",
            }, disposed),
          ),
      });
      await expect(factory()).rejects.toThrow(
        /not bounded by the configured read ceiling/,
      );
      expect(disposed).toEqual(["runtime"]);
    });
  });

  describe("cacheHarnessFabricSessionFactory()", () => {
    it("returns the same session promise for every call", async () => {
      let calls = 0;
      const session = {} as HarnessFabricSession;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        return Promise.resolve(session);
      });
      const first = cached();
      const second = cached();
      expect(second).toBe(first);
      expect(await first).toBe(session);
      expect(calls).toBe(1);
    });

    it("shares one in-flight construction between concurrent calls even when it rejects", async () => {
      let calls = 0;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        return Promise.reject(new Error("construction failed"));
      });
      const first = cached();
      const second = cached();
      expect(second).toBe(first);
      await expect(first).rejects.toThrow("construction failed");
      expect(calls).toBe(1);
    });

    it("invokes a synchronously-throwing factory again after its rejection settles, and a later attempt can succeed", async () => {
      // Only a HEALTHY session is cached: a rejected construction clears the
      // cache so a later tool call retries the factory instead of replaying a
      // terminal failure for the rest of the run. This deliberately supersedes
      // the earlier behavior of caching the rejection forever.

      let calls = 0;
      const session = {} as HarnessFabricSession;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("construction failed");
        }
        return Promise.resolve(session);
      });
      await expect(cached()).rejects.toThrow("construction failed");
      expect(await cached()).toBe(session);
      expect(calls).toBe(2);
    });
  });
});
