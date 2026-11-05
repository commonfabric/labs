// Importing this config throws, the way a config whose own imports no longer
// resolve or whose top-level code fails would. The settings it would have
// produced never reach the harness.
throw new Error("this config is deliberately broken");
