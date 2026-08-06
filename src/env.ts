import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Resolve .env at project root regardless of which file imports this
export const ENV_PATH = path.resolve(__dirname, "..", ".env");

// Make sure .env exists (create an empty one on first run) then load it
if (!fs.existsSync(ENV_PATH)) {
  fs.writeFileSync(ENV_PATH, "");
}
dotenv.config({ path: ENV_PATH });

export function getEnv(key: string): string {
  return (process.env[key] ?? "").trim();
}

/**
 * Write/update a single key in .env immediately, and in the current process's
 * env, so every future call (in this run or a future script) picks it up
 * automatically — same behavior as tiktok_client.py's update_env().
 */
export function updateEnv(key: string, value: string): void {
  let contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
  const lines = contents.split(/\r?\n/).filter((l) => l.length > 0);

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRegex = new RegExp(`^${escapedKey}=`);

  let found = false;
  const newLines = lines.map((line) => {
    if (lineRegex.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, newLines.join("\n") + "\n");
  process.env[key] = value; // keep current process in sync too

  console.log(`[.env updated] ${key} saved`);
}
