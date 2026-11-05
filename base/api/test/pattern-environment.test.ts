import { assertEquals } from "@std/assert";
import { getPatternEnvironment } from "@commonfabric/api";

function restoreLocation(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, "location", descriptor);
  } else {
    Reflect.deleteProperty(globalThis, "location");
  }
}

Deno.test("getPatternEnvironment uses the current global location origin", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: "https://tools.example.test/space/path?query=1#note",
      } as Location,
    });

    const environment = getPatternEnvironment();

    assertEquals(environment.apiUrl.href, "https://tools.example.test/");
  } finally {
    restoreLocation(originalLocation);
  }
});

Deno.test("getPatternEnvironment uses localhost when no global location exists", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: undefined,
    });

    const environment = getPatternEnvironment();

    assertEquals(environment.apiUrl.href, "http://localhost:8000/");
  } finally {
    restoreLocation(originalLocation);
  }
});
