import { expect } from "@std/expect";

import {
  $conn,
  $onCellUpdate,
  type CellGetRequest,
  CellHandle,
  type CellRef,
  type CellSetRequest,
  type InitializedRuntimeConnection,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { CFInput } from "./index.ts";

for (const confirmation of ["worker", "read"] as const) {
  Deno.test(`cf-input repaints a read override after an unchanged ${confirmation} confirmation`, async () => {
    const readStarted = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ value: string }>();
    let reads = 0;
    const connection = {
      request: (request: CellGetRequest | CellSetRequest) => {
        if (request.type === RequestType.CellGet) {
          if (reads++ === 0) {
            readStarted.resolve();
            return response.promise;
          }
          return Promise.resolve({ value: "spaces" });
        }
        return Promise.resolve();
      },
      subscribe() {},
      unsubscribe() {},
    } as unknown as InitializedRuntimeConnection;
    const runtime = {
      [$conn]: () => connection,
      signal: new AbortController().signal,
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, {
      id: "of:input-cache" as CellRef["id"],
      space: "did:key:test",
      scope: "space",
      path: [],
      schema: { type: "string" },
    }, "spaces");
    const sibling = new CellHandle(runtime, cell.ref(), "spaces");
    let reconciliation: Promise<unknown> | undefined;
    const sync = cell.sync.bind(cell);
    cell.sync = () => {
      const read = sync();
      reconciliation = read;
      return read;
    };
    const element = document.createElement("cf-input") as CFInput;
    element.value = cell;
    element.timingStrategy = "immediate";
    const changes: string[] = [];
    element.addEventListener("cf-change", (event) => {
      changes.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(element).toBeInstanceOf(CFInput);
      const input = element.shadowRoot!.querySelector("input")!;
      input.value = "profile";
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      await readStarted.promise;
      // Another handle advances the shared queue while this view's read is
      // pending, so the read returns its snapshot without installing it here.
      sibling[$onCellUpdate]("profile");
      response.resolve({ value: "profile" });
      await reconciliation;
      await element.updateComplete;
      expect(cell.get()).toBe("spaces");
      expect(input.value).toBe("profile");
      changes.length = 0;

      if (confirmation === "worker") cell[$onCellUpdate]("spaces");
      else await cell.sync();
      await element.updateComplete;
      expect(input.value).toBe("spaces");
      expect(changes).toEqual(["spaces"]);
    } finally {
      response.resolve({ value: "profile" });
      await reconciliation;
      element.remove();
    }
  });
}
