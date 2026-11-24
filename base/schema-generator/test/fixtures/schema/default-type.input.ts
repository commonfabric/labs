type Default<T, V extends T = T> = T;

// Test basic Default type transformation
interface UserSettings {
  theme: Default<string, "dark">;
  fontSize: Default<number, 16>;
  notifications: Default<boolean, true>;
}

// Test nested Default types
interface AppConfig {
  user: {
    name: string;
    settings: {
      language: Default<string, "en">;
      timezone: Default<string, "UTC">;
    };
  };
  features: {
    darkMode: Default<boolean, false>;
    autoSave: Default<boolean, true>;
  };
}

// Test Default with arrays
interface ListConfig {
  items: Default<string[], ["item1", "item2"]>;
  selectedIndices: Default<number[], [0]>;
}

// Test Default with objects
interface ComplexDefault {
  metadata: Default<
    { version: number; author: string },
    { version: 1; author: "system" }
  >;
  config: Default<
    { enabled: boolean; value: number },
    { enabled: true; value: 100 }
  >;
}

// Test Default with Cell types
interface CellDefaults {
  counter: Cell<Default<number, 0>>;
  messages: Cell<Default<string[], []>>;
}

// Test optional properties with Default
interface OptionalWithDefaults {
  requiredField: string;
  optionalWithDefault?: Default<string, "default value">;
  nestedOptional?: {
    value?: Default<number, 42>;
  };
}

// Root schema for testing - we'll test all the interfaces above
interface SchemaRoot {
  userSettings: UserSettings;
  appConfig: AppConfig;
  listConfig: ListConfig;
  complexDefault: ComplexDefault;
  cellDefaults: CellDefaults;
  optionalDefaults: OptionalWithDefaults;
}
