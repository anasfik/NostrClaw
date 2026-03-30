import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { initDb } from "../src/infra/db";
import { WatchlistRepository } from "../src/infra/repositories";

describe("config-file mode", () => {
  it("loads JSON config and resolves relative paths", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "nostr-mind-config-"));
    const configPath = path.join(tempDir, "nostr-mind.config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          logFilePath: "./custom.log",
          dbPath: "./custom.sqlite",
          nostrRelays: ["wss://relay.damus.io"],
          ai: {
            provider: "openai",
            fallbackProviders: ["openrouter", "gemini"],
            rpm: 10,
            openai: {
              apiKey: "test-key",
              model: "gpt-test",
            },
          },
          notifications: {
            recipientNpub: "npub1test",
          },
          watchlists: [
            {
              id: "jobs",
              name: "Jobs",
              prompt: "Find job posts",
              filters: {
                keywords: ["jobs"],
                since: 1735689600,
                limit: 25,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = getConfig(configPath);

    expect(config.configPath).toBe(configPath);
    expect(config.logFilePath).toBe(path.join(tempDir, "custom.log"));
    expect(config.dbPath).toBe(path.join(tempDir, "custom.sqlite"));
    expect(config.aiProvider).toBe("openai");
    expect(config.aiFallbackProviders).toEqual(["openrouter", "gemini"]);
    expect(config.openAiApiKey).toBe("test-key");
    expect(config.watchlists[0].id).toBe("jobs");
  });

  it("loads Gemini provider settings", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "nostr-mind-config-"));
    const configPath = path.join(tempDir, "nostr-mind.config.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ai: {
            provider: "gemini",
            rpm: 30,
            gemini: {
              apiKey: "gemini-test-key",
              model: "gemini-2.5-flash",
            },
          },
          watchlists: [
            {
              name: "Gemini test",
              prompt: "Find high signal posts",
              filters: {
                kinds: [1],
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = getConfig(configPath);

    expect(config.aiProvider).toBe("gemini");
    expect(config.geminiApiKey).toBe("gemini-test-key");
    expect(config.geminiModel).toBe("gemini-2.5-flash");
    expect(config.aiRpm).toBe(30);
  });

  it("seeds config watchlists into SQLite on first run and preserves DB state on subsequent runs", () => {
    const db = initDb(":memory:");
    const repo = new WatchlistRepository(db);

    // First sync: seeds both entries
    repo.syncFromConfig([
      {
        id: "alpha",
        name: "Alpha",
        prompt: "Track alpha",
        active: true,
        filters: { keywords: ["alpha"], since: 1735689600, limit: 10 },
      },
      {
        id: "beta",
        name: "Beta",
        prompt: "Track beta",
        active: true,
        filters: { keywords: ["beta"], since: 1735689600, limit: 10 },
      },
    ]);

    // Simulate dashboard edit: user renamed alpha and toggled beta off
    repo.update("alpha", { name: "Alpha (edited)" });
    repo.setActive("beta", false);

    // Second sync with changed config — DB edits must be preserved
    repo.syncFromConfig([
      {
        id: "alpha",
        name: "Alpha updated via config",
        prompt: "Track alpha updates",
        active: true,
        filters: {
          keywords: ["alpha", "updates"],
          since: 1735689600,
          limit: 20,
        },
      },
    ]);

    const all = repo.list();
    const alpha = all.find((w) => w.id === "alpha");
    const beta = all.find((w) => w.id === "beta");

    // Dashboard edit wins — config must not overwrite existing rows
    expect(alpha?.name).toBe("Alpha (edited)");
    expect(alpha?.active).toBe(true);
    expect(alpha?.filters.since).toBe(1735689600);

    // beta is still in DB (not deleted), still inactive as the user set it
    expect(beta?.active).toBe(false);
  });
});
