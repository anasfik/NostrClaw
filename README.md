# NostrMind

NostrMind is a config-driven Nostr monitoring worker with AI classification and optional DM alerts.

It connects to relays, filters events with your watchlists, runs AI evaluation, stores results in SQLite, and exposes a live dashboard.

## Highlights

- JSON-configured runtime (`nostr-mind.config.json`)
- AI providers: `ollama`, `openai`, `openrouter`, `gemini`
- Provider failover with `ai.fallbackProviders`
- Live dashboard with SSE stream on port `3000` by default
- SQLite-backed processing history and insights
- NIP-17 DM notifications (when notifier identity + recipient are configured)

---

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Create config:

```bash
cp nostr-mind.config.json.example nostr-mind.config.json
```

3. Edit [nostr-mind.config.json](nostr-mind.config.json):

- pick AI provider + credentials/model
- set `notifications.recipientNpub` (optional, for DM alerts)
- define `watchlists`

4. Run in dev mode:

```bash
npm run dev
```

Dashboard: http://localhost:3000

Build + run production:

```bash
npm run build
npm start
```

---

## AI providers

| Provider     | Type  | Notes                                           |
| ------------ | ----- | ----------------------------------------------- |
| `ollama`     | Local | No cloud API cost; requires local Ollama server |
| `openai`     | Cloud | Uses OpenAI chat completions                    |
| `openrouter` | Cloud | OpenRouter OpenAI-compatible endpoint           |
| `gemini`     | Cloud | Gemini OpenAI-compatible endpoint               |

Example (local-first with cloud fallback):

```json
"ai": {
  "provider": "ollama",
  "fallbackProviders": ["openai", "openrouter", "gemini"],
  "rpm": 20,
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "model": "llama3.2"
  }
}
```

---

## Config shape (minimal example)

```json
{
  "nodeEnv": "development",
  "logLevel": "info",
  "logFilePath": "./data/log.txt",
  "dbPath": "./data/nostr-mind.sqlite",
  "nostrRelays": [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol"
  ],
  "ai": {
    "provider": "ollama",
    "fallbackProviders": ["openai", "openrouter", "gemini"],
    "rpm": 20,
    "ollama": { "baseUrl": "http://localhost:11434", "model": "llama3.2" }
  },
  "notifications": {
    "recipientNpub": "npub1..."
  },
  "dashboard": {
    "enabled": true,
    "port": 3000,
    "host": "127.0.0.1"
  },
  "watchlists": [
    {
      "id": "crypto",
      "name": "Crypto",
      "prompt": "Alert me about significant cryptocurrency market events",
      "active": true,
      "filters": { "kinds": [1], "limit": 50 }
    }
  ]
}
```

Full reference: [nostr-mind.config.json.example](nostr-mind.config.json.example)

---

## Dashboard

When enabled, dashboard is served from the same process:

> Dashboard is vibe-coded — please drop any issues/nugs (bugs, UX nits, or feature ideas).

### Dashboard screenshot

![NostrMind dashboard preview](docs/screenshots/nostrmind-dashboard.png)

Save the provided dashboard screenshot to `docs/screenshots/nostrmind-dashboard.png` to render this preview in GitHub.

- URL: `http://<dashboard.host>:<dashboard.port>`
- Live event stream: `/api/events/stream`
- API endpoints include:
  - `/api/stats`
  - `/api/watchlists`
  - `/api/insights`

Legacy endpoints are still available for compatibility (`/watchlists`, `/insights`).

---

## Docker

```bash
docker compose up -d --build
```

Compose mounts:

- `./nostr-mind.config.json` -> `/app/nostr-mind.config.json` (read-only)
- `./data` -> `/app/data`

Port mapping:

- `3000:3000` (dashboard/API)

---

## Notes

- Restart after config changes.
- Config loading prefers `nostr-mind.config.json` and also supports legacy `nostr-claw.config.json`.
- On startup, watchlists from config are seeded with `INSERT OR IGNORE`:
  - existing DB watchlists are preserved
  - dashboard edits are not overwritten by config sync
- Keep API keys and private keys secret.
