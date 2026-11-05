declare const DEFAULT_MARKER: unique symbol;

interface Default<T, V extends T = T> {
  readonly [DEFAULT_MARKER]?: [T, V];
}

interface DeepDefault<V> {
  readonly [DEFAULT_MARKER]?: V;
}

interface Preferences {
  theme: string;
  retries: number;
  profile: {
    name: string;
    email: string;
    flags: {
      marketing: boolean;
    };
  };
}

interface SchemaRoot {
  legacy: {
    title: Default<string, "">;
    count: Default<number, 0>;
    enabled: Default<boolean, false>;
    nullable: Default<string | null, null>;
    tags: Default<string[], ["default", "tags"]>;
    preferences: Default<
      Preferences,
      {
        theme: "dark";
        retries: 3;
        profile: {
          name: "Ada";
          email: "";
          flags: {
            marketing: false;
          };
        };
      }
    >;
    writableTags: Writable<Default<string[], []>>;
  };
  shorthand: {
    title: string | Default<"">;
    count: number | Default<0>;
    enabled: boolean | Default<false>;
    nullable: string | null | Default<null>;
    tags: string[] | Default<["default", "tags"]>;
    preferences: Preferences | Default<
      {
        theme: "dark";
        retries: 3;
        profile: {
          name: "Ada";
          email: "";
          flags: {
            marketing: false;
          };
        };
      }
    >;
    writableTags: Writable<string[] | Default<[]>>;
  };
  deep: {
    preferences: Preferences | DeepDefault<
      {
        theme: "dark";
        profile: {
          name: "Ada";
          flags: {
            marketing: false;
          };
        };
      }
    >;
  };
}
