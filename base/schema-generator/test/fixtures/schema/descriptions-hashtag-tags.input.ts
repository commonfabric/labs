/** A #note the user took, discoverable via #quickCapture. */
interface SchemaRoot {
  /** The note body. */
  content: string;

  /** Linked #annotation entries. */
  annotations: string[];
}
