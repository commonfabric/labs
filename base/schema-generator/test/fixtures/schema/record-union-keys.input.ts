interface SchemaRoot {
  settings: Record<"theme" | "language" | "timezone", string>;
  limits: Record<"cpu" | "memory" | "disk", number>;
  features: Record<"auth" | "api" | "ui", boolean>;
}
