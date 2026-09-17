/**
 * Validate the piWeb.plugins package metadata against the PI WEB discovery
 * rules (docs/plugins.md §Discovery and packaging). Run: npx tsx scripts/validate-manifest.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  piWeb?: { plugins?: Array<Record<string, unknown>> };
  name?: string;
  type?: string;
};

const errors: string[] = [];
const plugins = pkg.piWeb?.plugins;
if (!Array.isArray(plugins) || plugins.length === 0) {
  errors.push("package.json must declare piWeb.plugins as a non-empty array");
} else {
  for (const p of plugins) {
    const id = String(p.id ?? "");
    if (!/^[a-z][a-z0-9.-]*$/.test(id)) errors.push(`invalid plugin id: ${id}`);
    if (p.piWeb && id !== undefined) {
      errors.push("nested piWeb in plugin entry is wrong shape");
    }
    if (typeof p.module === "string") {
      if (typeof p.browserRoot !== "string") errors.push(`${id}: browser entry must declare browserRoot`);
      const modulePath = join(root, String(p.module));
      if (!existsSync(modulePath)) errors.push(`${id}: module not found: ${String(p.module)}`);
    } else if (typeof p.serverModule !== "string") {
      errors.push(`${id}: must declare at least one of module or serverModule`);
    }
  }
}

if (errors.length) {
  console.error("❌ manifest invalid:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("✅ piWeb.plugins manifest valid");
console.log(JSON.stringify(plugins, null, 2));
