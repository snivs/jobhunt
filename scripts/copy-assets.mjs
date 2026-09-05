#!/usr/bin/env node
// Copies non-TypeScript assets (SQL migrations) into dist/ after tsc.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [["src/db/migrations", "dist/db/migrations"]];
for (const [from, to] of pairs) {
  fs.mkdirSync(path.join(root, to), { recursive: true });
  fs.cpSync(path.join(root, from), path.join(root, to), { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
