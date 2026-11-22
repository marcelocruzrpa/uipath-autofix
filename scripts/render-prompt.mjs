#!/usr/bin/env node
// Render a prompt template, replacing {{NAME}} with process.env.NAME.
// Done in node (not envsubst/bash) so untrusted webhook text is never shell-expanded.
import { readFileSync } from "node:fs";

const [, , template] = process.argv;
if (!template) {
  console.error("usage: render-prompt.mjs <template.md>");
  process.exit(2);
}
const text = readFileSync(template, "utf8").replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? "");
process.stdout.write(text);
