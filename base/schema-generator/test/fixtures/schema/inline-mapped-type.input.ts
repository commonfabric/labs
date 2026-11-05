interface SchemaRoot {
  stringConfig: {
    [P in "theme" | "language" | "timezone"]: string;
  };
  numberLimits: {
    [K in "cpu" | "memory" | "disk"]: number;
  };
  booleanFeatures: {
    [F in "auth" | "api" | "ui"]: boolean;
  };
  objectHandlers: {
    [H in "create" | "update" | "delete"]: { enabled: boolean };
  };
}
