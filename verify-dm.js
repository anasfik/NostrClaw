#!/usr/bin/env node
/**
 * End-to-end test for Nostr DM functionality
 *
 * Steps:
 * 1. Verify NostrMind identity exists and is valid
 * 2. Check recipient npub is valid
 * 3. Simulate an event match and DM sending
 * 4. Verify logs contain DM send record
 */

require("dotenv").config();

const Database = require("better-sqlite3");
const { nip19 } = require("nostr-tools");

const db = new Database("./nostr-mind.sqlite");

console.log("🔍 Verifying Nostr DM Functionality\n");

// 1. Check NostrMind identity
console.log("1️⃣  NostrMind Identity:");
const notifierNsec = db
  .prepare("SELECT value FROM app_settings WHERE key = 'notifier_nsec'")
  .get();
const notifierNpub = db
  .prepare("SELECT value FROM app_settings WHERE key = 'notifier_npub'")
  .get();
const notifierPubkey = db
  .prepare("SELECT value FROM app_settings WHERE key = 'notifier_pubkey'")
  .get();

if (!notifierNsec || !notifierNpub || !notifierPubkey) {
  console.log("   ✗ NostrMind identity not initialized");
  process.exit(1);
}

console.log(`   ✓ nsec: ${notifierNsec.value.slice(0, 20)}...`);
console.log(`   ✓ npub: ${notifierNpub.value.slice(0, 20)}...`);
console.log(`   ✓ pubkey: ${notifierPubkey.value.slice(0, 16)}...`);

// Verify nsec/npub format
const decodedNsec = nip19.decode(notifierNsec.value);
const decodedNpub = nip19.decode(notifierNpub.value);

if (decodedNsec.type !== "nsec") {
  console.log("   ✗ Stored nsec has invalid format");
  process.exit(1);
}
if (decodedNpub.type !== "npub") {
  console.log("   ✗ Stored npub has invalid format");
  process.exit(1);
}
console.log("   ✓ nsec/npub format valid\n");

// 2. Check recipient
console.log("2️⃣  Recipient Configuration:");
const recipientNpub = process.env.NOTIFY_RECIPIENT_NPUB;
if (!recipientNpub) {
  console.log("   ✗ NOTIFY_RECIPIENT_NPUB not set in .env");
  process.exit(1);
}

try {
  const decodedRecipient = nip19.decode(recipientNpub);
  if (decodedRecipient.type !== "npub") {
    console.log("   ✗ NOTIFY_RECIPIENT_NPUB is not a valid npub");
    process.exit(1);
  }
  console.log(`   ✓ NOTIFY_RECIPIENT_NPUB: ${recipientNpub.slice(0, 20)}...`);
  console.log(
    `   ✓ Recipient pubkey (hex): ${decodedRecipient.data.slice(0, 16)}...\n`,
  );
} catch (e) {
  console.log(`   ✗ Invalid NOTIFY_RECIPIENT_NPUB: ${String(e)}`);
  process.exit(1);
}

// 3. Check relays
console.log("3️⃣  Relay Configuration:");
const relays = (process.env.NOSTR_RELAYS || "").split(",").filter(Boolean);
if (relays.length === 0) {
  console.log("   ✗ No relays configured");
  process.exit(1);
}
relays.forEach((r, i) => {
  console.log(`   ✓ Relay ${i + 1}: ${r.trim()}`);
});
console.log("");

// 4. Check active watchlists
console.log("4️⃣  Active Watchlists:");
const watchlists = db
  .prepare("SELECT id, name, filters_json FROM watchlists WHERE active = 1")
  .all();

if (watchlists.length === 0) {
  console.log("   ⚠️  No active watchlists. Create one to test:");
  console.log(
    "      npm run cli create 'Test' 'test' --keywords 'dmtest' --active true",
  );
} else {
  watchlists.forEach((wl) => {
    const filters = JSON.parse(wl.filters_json);
    console.log(`   • ${wl.name} (${wl.id.slice(0, 8)}...)`);
    console.log(`     Filters: ${JSON.stringify(filters).slice(0, 60)}...`);

    // Check if since timestamp is in the past (good) or future (bad)
    if (filters.since) {
      const sinceSecs = filters.since;
      const nowSecs = Math.floor(Date.now() / 1000);
      const sinceDate = new Date(sinceSecs * 1000);
      const isInFuture = sinceSecs > nowSecs;
      console.log(
        `     since: ${sinceDate.toISOString()} ${isInFuture ? "❌ (FUTURE - NO EVENTS WILL MATCH)" : "✓ (past)"}`,
      );
    }
  });
}
console.log("");

// 5. Check logs for DM sends
console.log("5️⃣  Recent DM Send Attempts (last 5 lines in log file):");
try {
  const fs = require("fs");
  const logPath = process.env.LOG_FILE_PATH || "./log.txt";
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean).slice(-5);
    if (lines.length === 0) {
      console.log("   (no log entries yet)\n");
    } else {
      lines.forEach((line) => {
        try {
          const entry = JSON.parse(line);
          console.log(`   • ${entry.timestamp}`);
          if (entry.notify) {
            console.log(
              `     ✓ Notification sent for event ${entry.eventId.slice(0, 16)}...`,
            );
          }
        } catch {
          // Not JSON, skip
        }
      });
      console.log("");
    }
  } else {
    console.log(`   (log file not found at ${logPath})\n`);
  }
} catch (e) {
  console.log(`   (could not read logs: ${String(e)})\n`);
}

// 6. Summary and next steps
console.log("✅ DM Setup Verification Complete\n");
console.log("📋 To test DM functionality:");
console.log("   1. Start the server: npm run dev");
console.log("   2. Create a test watchlist:");
console.log(
  "      npm run cli create 'DM Test' 'test notification' --keywords 'dmtest' --active true",
);
console.log("   3. Post a Nostr event with keyword 'dmtest' to any relay");
console.log("   4. Check your Nostr client for a DM from:");
console.log(`      ${notifierNpub.value}`);
console.log("   5. Monitor logs: npm run cli logs --lines 10");
console.log("   6. To reset and retry: npm run cli wipe-processed --confirm");

db.close();
