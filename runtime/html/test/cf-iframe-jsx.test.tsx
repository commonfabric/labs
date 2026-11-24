import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { createFabricBridge } from "@commonfabric/iframe-sandbox";

describe("cf-iframe JSX attributes", () => {
  it("accepts an explicit Fabric bridge", () => {
    const bridge = createFabricBridge({
      service: {
        kind: "service",
        methods: { ping: () => "pong" },
      },
    });

    const frame = <cf-iframe src="<main></main>" bridge={bridge} />;

    expect(frame).toMatchObject({ props: { bridge } });
  });
});
