export interface UnsafeHostTrustOptions {
  reason: string;
}

export interface UnsafeHostTrust {
  readonly kind: "unsafe-host-trust";
  readonly reason: string;
}

const unsafeHostTrustRegistrarSymbol = Symbol("unsafe-host-trust-registrar");

type UnsafeHostTrustRegistrar = (value: unknown) => void;

type InternalUnsafeHostTrust = UnsafeHostTrust & {
  [unsafeHostTrustRegistrarSymbol]: UnsafeHostTrustRegistrar;
};

export function createUnsafeHostTrustToken(
  options: UnsafeHostTrustOptions,
  registrar: UnsafeHostTrustRegistrar,
): UnsafeHostTrust {
  return Object.freeze({
    kind: "unsafe-host-trust",
    reason: options.reason,
    [unsafeHostTrustRegistrarSymbol]: registrar,
  }) as UnsafeHostTrust;
}

export function registerUnsafeHostTrustedValue(
  unsafeHostTrust: UnsafeHostTrust | undefined,
  value: unknown,
): void {
  if (!unsafeHostTrust) {
    return;
  }
  const registrar = (unsafeHostTrust as InternalUnsafeHostTrust)[
    unsafeHostTrustRegistrarSymbol
  ];
  if (typeof registrar !== "function") {
    throw new Error("Invalid unsafeHostTrust token");
  }
  registrar(value);
}
