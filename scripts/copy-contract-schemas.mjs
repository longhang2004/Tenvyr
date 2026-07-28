import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "contracts", "schemas");
const destination = join(root, "packages", "contracts", "dist", "schema-json");

mkdirSync(destination, { recursive: true });
for (const name of readdirSync(source)) {
  if (name.endsWith(".json"))
    copyFileSync(join(source, name), join(destination, name));
}
