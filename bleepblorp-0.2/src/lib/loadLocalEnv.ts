import { existsSync, readFileSync } from "fs";
import path from "path";

/** CLI helpers (exit-opt worker) do not get Next.js env loading. */
export function loadLocalEnv(cwd = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!key || process.env[key] != null) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
