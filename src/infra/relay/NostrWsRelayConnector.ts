import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { RelayConnector, RelayFilter } from "../../contracts";
import type { AppLogger } from "../../logger";
import type { NostrEvent } from "../../types";

type NostrMessage = [string, ...unknown[]];

export class NostrWsRelayConnector implements RelayConnector {
  private readonly emitter = new EventEmitter();
  private readonly sockets = new Map<string, WebSocket>();
  private stopped = true;
  private subscriptionId = "";
  private filters: RelayFilter[] = [];

  constructor(
    private readonly relays: string[],
    private readonly reconnectMs = 5000,
    private readonly logger?: AppLogger,
  ) {}

  onEvent(handler: (event: NostrEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  start(filters: RelayFilter[]): void {
    this.filters = filters.length ? filters : [{ kinds: [1] }];
    this.subscriptionId = `nostrmind-${crypto.randomUUID()}`;
    this.stopped = false;

    this.logger?.info(
      {
        relayCount: this.relays.length,
        subscriptionId: this.subscriptionId,
        filterCount: this.filters.length,
      },
      "starting relay connector",
    );

    for (const relay of this.relays) {
      this.connectRelay(relay);
    }
  }

  stop(): void {
    this.stopped = true;
    this.logger?.info(
      { openSockets: this.sockets.size },
      "stopping relay connector",
    );

    for (const socket of this.sockets.values()) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
  }

  private connectRelay(relay: string): void {
    if (this.stopped || this.sockets.has(relay)) return;

    this.logger?.debug({ relay }, "connecting to relay");

    const ws = new WebSocket(relay);
    this.sockets.set(relay, ws);

    ws.on("open", () => {
      const req = ["REQ", this.subscriptionId, ...this.filters];
      ws.send(JSON.stringify(req));
      this.logger?.info(
        { relay, subscriptionId: this.subscriptionId },
        "relay connected and subscription sent",
      );
    });

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(String(data)) as NostrMessage;
        if (parsed[0] !== "EVENT") return;
        const event = parsed[2] as NostrEvent;
        if (event?.id) {
          this.logger?.debug(
            {
              relay,
              eventId: event.id,
              kind: event.kind,
              pubkey: event.pubkey,
            },
            "relay event received",
          );
          this.emitter.emit("event", event);
        }
      } catch {
        // ignore invalid messages
        this.logger?.warn({ relay }, "received invalid relay message payload");
      }
    });

    ws.on("close", () => {
      this.sockets.delete(relay);
      this.logger?.warn({ relay }, "relay connection closed");
      if (!this.stopped) {
        this.logger?.info(
          { relay, reconnectMs: this.reconnectMs },
          "scheduling relay reconnect",
        );
        setTimeout(() => this.connectRelay(relay), this.reconnectMs);
      }
    });

    ws.on("error", (error) => {
      this.logger?.error({ relay, error }, "relay socket error");
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }
}
