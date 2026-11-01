// usage-log — a structured log of user queries and choices for measuring
// search quality on real traffic (Part A of the bulletproof measurement plan).
// JSONL append to USAGE_LOG_PATH (default /logs/usage.jsonl inside the container).
// telegram id is hashed — privacy: the log keeps a stable alias, not the id itself.
// logUsage never throws: logging must not affect request handling.
import fs from "node:fs";
import crypto from "node:crypto";

// The path is read lazily on every call, not once at module start: this way tests
// point USAGE_LOG_PATH at a temp file, and the path can change without a rebuild.
function logPath(): string {
  return process.env.USAGE_LOG_PATH || "/logs/usage.jsonl";
}

// Stable alias for a telegram id: sha256, first 8 hex chars. Enough to
// tell users apart and count uniques without storing the id itself.
export function aliasOf(id: number): string {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8);
}

// Append a record to the JSONL. ISO ts — event time for later period selection.
// appendFileSync blocks, but the bot's RPS is low (rate limit + daily
// limits); for a personal-scale bot a sync append is simpler and more reliable than a buffer.
export function logUsage(rec: Record<string, unknown>): void {
  try {
    fs.appendFileSync(logPath(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch {
    // silently: a failed log must not break search/download
  }
}
