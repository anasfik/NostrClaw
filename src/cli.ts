#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const API_HOST = process.env.API_HOST || "http://localhost:8080";
const LOG_FILE_PATH = process.env.LOG_FILE_PATH || "./log.txt";
const DB_PATH = process.env.DB_PATH || "./nostr-mind.sqlite";

async function fetchApi(endpoint: string, options?: RequestInit) {
  const url = `${API_HOST}${endpoint}`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }

  return response.json();
}

async function readTail(filePath: string, lines: number): Promise<string[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  return content.split(/\r?\n/).filter(Boolean).slice(-lines);
}

async function streamLogs(filePath: string): Promise<void> {
  let offset = existsSync(filePath) ? (await stat(filePath)).size : 0;

  setInterval(async () => {
    try {
      if (!existsSync(filePath)) {
        return;
      }

      const content = await readFile(filePath, "utf8");
      const size = Buffer.byteLength(content, "utf8");

      if (size < offset) {
        offset = 0;
      }

      if (size === offset) {
        return;
      }

      const next = content.slice(offset);
      offset = size;
      if (next.trim().length > 0) {
        process.stdout.write(next);
      }
    } catch (error) {
      console.error("✗ Failed to read log updates:", error);
    }
  }, 1000);

  await new Promise(() => undefined);
}

function wipeProcessedEventsLocal(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    const result = db.prepare("DELETE FROM processed_events").run();
    return result.changes;
  } finally {
    db.close();
  }
}

function isConnectionRefusedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("fetch failed") || message.includes("econnrefused");
}

async function main() {
  yargs(hideBin(process.argv))
    .command(
      "logs",
      "Track processed-event logs in real time",
      (yargs) =>
        yargs
          .option("file", {
            describe: "Path to the local processed-event log file",
            type: "string",
            default: LOG_FILE_PATH,
          })
          .option("lines", {
            describe: "Show the last N log lines before following",
            type: "number",
            default: 20,
          }),
      async (argv) => {
        try {
          const lines = await readTail(argv.file, argv.lines);
          if (lines.length > 0) {
            console.log(lines.join("\n"));
          } else {
            console.log(`Waiting for log entries in ${argv.file} ...`);
          }

          await streamLogs(argv.file);
        } catch (error) {
          console.error("✗ Failed to tail logs:", error);
          process.exit(1);
        }
      },
    )
    .command("health", "Check server health", {}, async () => {
      try {
        const data = await fetchApi("/health");
        console.log("✓ Server is healthy");
        console.log(JSON.stringify(data, null, 2));
      } catch (error) {
        console.error("✗ Health check failed:", error);
        process.exit(1);
      }
    })
    .command("list", "List all watchlists", {}, async () => {
      try {
        const data = await fetchApi("/watchlists");
        console.log("Watchlists:");
        console.log(JSON.stringify(data.data, null, 2));
      } catch (error) {
        console.error("✗ Failed to list watchlists:", error);
        process.exit(1);
      }
    })
    .command(
      "create <name> <prompt>",
      "Create a new watchlist",
      (yargs) =>
        yargs
          .positional("name", {
            describe: "Watchlist name",
            type: "string",
          })
          .positional("prompt", {
            describe: "Watchlist prompt",
            type: "string",
          })
          .option("keywords", {
            describe: "Comma-separated keywords to filter by",
            type: "string",
          })
          .option("authors", {
            describe: "Comma-separated author pubkeys to filter by",
            type: "string",
          })
          .option("kinds", {
            describe: "Comma-separated Nostr event kinds (e.g., 1 for notes)",
            type: "string",
          })
          .option("tags", {
            describe: 'JSON object of tag filters (e.g., {"t":["bitcoin"]})',
            type: "string",
          })
          .option("active", {
            describe: "Whether the watchlist is active",
            type: "boolean",
            default: true,
          }),
      async (argv) => {
        try {
          const filters: Record<string, unknown> = {};

          if (argv.keywords) {
            filters.keywords = argv.keywords.split(",").map((k) => k.trim());
          }
          if (argv.authors) {
            filters.authors = argv.authors.split(",").map((a) => a.trim());
          }
          if (argv.kinds) {
            filters.kinds = argv.kinds
              .split(",")
              .map((k) => parseInt(k.trim(), 10));
          }
          if (argv.tags) {
            filters.tags = JSON.parse(argv.tags);
          }

          const data = await fetchApi("/watchlists", {
            method: "POST",
            body: JSON.stringify({
              name: argv.name,
              prompt: argv.prompt,
              filters,
              active: argv.active,
            }),
          });

          console.log("✓ Watchlist created:");
          console.log(JSON.stringify(data.data, null, 2));
        } catch (error) {
          console.error("✗ Failed to create watchlist:", error);
          process.exit(1);
        }
      },
    )
    .command(
      "toggle <id> <active>",
      "Toggle watchlist active status",
      (yargs) =>
        yargs
          .positional("id", {
            describe: "Watchlist ID",
            type: "string",
          })
          .positional("active", {
            describe: "Active status (true/false)",
            type: "string",
          }),
      async (argv) => {
        try {
          const active = argv.active === "true" || argv.active === "1";
          const data = await fetchApi(`/watchlists/${argv.id}`, {
            method: "PATCH",
            body: JSON.stringify({ active }),
          });

          console.log(`✓ Watchlist ${active ? "enabled" : "disabled"}:`);
          console.log(JSON.stringify(data.data, null, 2));
        } catch (error) {
          console.error("✗ Failed to toggle watchlist:", error);
          process.exit(1);
        }
      },
    )
    .command(
      "insights",
      "Get recent insights",
      (yargs) =>
        yargs
          .option("watchlistId", {
            describe: "Filter by watchlist ID",
            type: "string",
          })
          .option("sinceMinutes", {
            describe: "Insights from the last N minutes (default: 60)",
            type: "number",
            default: 60,
          })
          .option("limit", {
            describe: "Max number of insights to return (default: 50)",
            type: "number",
            default: 50,
          }),
      async (argv) => {
        try {
          const params = new URLSearchParams();
          if (argv.watchlistId) {
            params.append("watchlistId", argv.watchlistId);
          }
          params.append("sinceMinutes", String(argv.sinceMinutes));
          params.append("limit", String(argv.limit));

          const data = await fetchApi(`/insights?${params.toString()}`);

          if (data.data.length === 0) {
            console.log("No insights found.");
          } else {
            console.log(`Found ${data.data.length} insights:`);
            console.log(JSON.stringify(data.data, null, 2));
          }
        } catch (error) {
          console.error("✗ Failed to get insights:", error);
          process.exit(1);
        }
      },
    )
    .command(
      "query <text>",
      "Query insights by text search",
      (yargs) =>
        yargs
          .positional("text", {
            describe: "Search query",
            type: "string",
          })
          .option("sinceMinutes", {
            describe: "Search from the last N minutes (default: 60)",
            type: "number",
            default: 60,
          })
          .option("limit", {
            describe: "Max results (default: 50)",
            type: "number",
            default: 50,
          }),
      async (argv) => {
        try {
          const data = await fetchApi("/bridge/query", {
            method: "POST",
            body: JSON.stringify({
              query: argv.text,
              sinceMinutes: argv.sinceMinutes,
              limit: argv.limit,
            }),
          });

          if (data.count === 0) {
            console.log(`No results for query: "${argv.text}"`);
          } else {
            console.log(`✓ Found ${data.count} results for "${argv.text}":`);
            console.log(JSON.stringify(data.data, null, 2));
          }
        } catch (error) {
          console.error("✗ Query failed:", error);
          process.exit(1);
        }
      },
    )
    .command(
      "wipe-processed [--confirm]",
      "Clear all processed events register (reprocess all events)",
      (yargs) =>
        yargs
          .option("confirm", {
            describe: "Confirm deletion without prompt",
            type: "boolean",
            default: false,
          })
          .option("dbPath", {
            describe: "SQLite DB path for local fallback wipe",
            type: "string",
            default: DB_PATH,
          }),
      async (argv) => {
        try {
          if (!argv.confirm) {
            const readline = await import("readline");
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });

            await new Promise<void>((resolve) => {
              rl.question(
                "⚠️  This will clear all processed events. Are you sure? (yes/no): ",
                (answer) => {
                  rl.close();
                  if (answer.toLowerCase() !== "yes") {
                    console.log("Cancelled.");
                    process.exit(0);
                  }
                  resolve();
                },
              );
            });
          }

          try {
            const deleted = await fetchApi("/admin/wipe-processed", {
              method: "POST",
            });

            console.log(`✓ Wiped ${deleted.deleted} processed event records.`);
          } catch (apiError) {
            if (!isConnectionRefusedError(apiError)) {
              throw apiError;
            }

            const deletedLocal = wipeProcessedEventsLocal(argv.dbPath);
            console.log(
              `✓ API unavailable, wiped ${deletedLocal} processed event records locally (${argv.dbPath}).`,
            );
          }

          console.log(
            "Events will be reprocessed on next watchlist refresh (~15s).",
          );
        } catch (error) {
          console.error("✗ Failed to wipe processed events:", error);
          process.exit(1);
        }
      },
    )
    .option("host", {
      describe: "API host URL",
      type: "string",
      default: API_HOST,
    })
    .help()
    .alias("help", "h")
    .version()
    .alias("version", "v")
    .demandCommand(1, "Please specify a command")
    .strict()
    .parseAsync();
}

main().catch((error) => {
  console.error("CLI Error:", error);
  process.exit(1);
});
