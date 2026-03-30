import { SimplePool, finalizeEvent, nip17, nip19 } from "nostr-tools";
import WebSocket from "ws";
import type { NotificationSender } from "../../contracts";
import type { AppIdentityRepository } from "../repositories";

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket as any;
}

function buildTemplateVars(
  input: Parameters<NotificationSender["sendMatchNotification"]>[0],
): Record<string, string> {
  const nevent = nip19.neventEncode({ id: input.event.id });
  const contentPreview = input.event.content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const actions = input.aiDecision.recommended_actions?.length
    ? input.aiDecision.recommended_actions
        .map((action, i) => `${i + 1}. ${action}`)
        .join("\n")
    : "-";

  return {
    "watchlist.id": input.watchlist.id,
    "watchlist.name": input.watchlist.name,
    "event.id": input.event.id,
    "event.nevent": nevent,
    "event.link": `https://njump.me/${nevent}`,
    "event.pubkey": input.event.pubkey,
    "event.author_link": `https://njump.me/${input.event.pubkey}`,
    "event.kind": String(input.event.kind),
    "event.created_at": String(input.event.created_at),
    "event.content": input.event.content,
    "event.content_preview": contentPreview,
    "ai.message": input.aiDecision.message ?? "Relevant event found.",
    "ai.score":
      input.aiDecision.match_score != null
        ? String(input.aiDecision.match_score)
        : "n/a",
    "ai.link": input.aiDecision.actionable_link ?? "",
    "ai.actions": actions,
  };
}

function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const k = key.trim();
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `{{${k}}}`;
  });
}

function formatNotificationMessage(
  input: Parameters<NotificationSender["sendMatchNotification"]>[0],
): string {
  const vars = buildTemplateVars(input);

  if (input.watchlist.messageTemplate) {
    return interpolateTemplate(input.watchlist.messageTemplate, vars);
  }

  // Default built-in template
  const sections = [
    `NostrMind Match\nWatchlist: ${vars["watchlist.name"]}`,
    `Summary\n${vars["ai.message"]}`,
    `Details\nScore: ${vars["ai.score"]}\nEvent: ${vars["event.link"]}\nAuthor: ${vars["event.author_link"]}`,
    vars["ai.link"] ? `Action\n${vars["ai.link"]}` : undefined,
    `Next Steps\n${vars["ai.actions"]}`,
    vars["event.content_preview"]
      ? `Preview\n${vars["event.content_preview"]}`
      : undefined,
  ];

  return sections.filter(Boolean).join("\n\n");
}

type LoggerLike = {
  debug?: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

const RELAY_EVENT_TAGS = new Set(["relay", "r"]);
const DISCOVERY_RELAYS = [
  "wss://relay.damus.io",
  "wss://purplepag.es",
  "wss://relay.primal.net",
  "wss://nos.lol",
];
const RECIPIENT_DM_RELAY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const recipientDmRelayCache = new Map<
  string,
  { relays: string[]; fetchedAt: number }
>();

function normalizeRelayUrl(value: string | undefined): string | undefined {
  const relay = value?.trim().replace(/\/+$/, "");
  if (!relay) {
    return undefined;
  }

  return relay.startsWith("wss://") || relay.startsWith("ws://")
    ? relay
    : undefined;
}

function dedupeRelays(relays: string[]): string[] {
  const seen = new Set<string>();
  const uniqueRelays: string[] = [];

  for (const relay of relays) {
    const normalizedRelay = normalizeRelayUrl(relay);
    if (!normalizedRelay) {
      continue;
    }

    const relayKey = normalizedRelay.toLowerCase();
    if (seen.has(relayKey)) {
      continue;
    }

    seen.add(relayKey);
    uniqueRelays.push(normalizedRelay);
  }

  return uniqueRelays;
}

export class NostrDmNotificationSender implements NotificationSender {
  private readonly pool = new SimplePool();
  private readonly recipientPubkey: string;
  private senderSecretKey?: Uint8Array;
  private senderPubkey?: string;

  constructor(
    private readonly deps: {
      relays: string[];
      recipientNpub: string;
      identityRepo: AppIdentityRepository;
      logger: LoggerLike;
    },
  ) {
    const decodedNpub = nip19.decode(deps.recipientNpub);
    if (decodedNpub.type !== "npub") {
      throw new Error("NOTIFY_RECIPIENT_NPUB must be a valid npub");
    }

    this.recipientPubkey = decodedNpub.data;
  }

  private async getRecipientDmRelays(): Promise<string[]> {
    const cached = recipientDmRelayCache.get(this.recipientPubkey);
    if (
      cached &&
      Date.now() - cached.fetchedAt < RECIPIENT_DM_RELAY_CACHE_TTL_MS
    ) {
      this.deps.logger.debug?.(
        {
          recipient: this.recipientPubkey,
          relayCount: cached.relays.length,
          cacheAgeMs: Date.now() - cached.fetchedAt,
        },
        "using cached recipient DM relays",
      );
      return cached.relays;
    }

    try {
      const relayListEvents = await this.pool.querySync(
        dedupeRelays([...this.deps.relays, ...DISCOVERY_RELAYS]),
        {
          authors: [this.recipientPubkey],
          kinds: [10050],
          limit: 1,
        },
        { maxWait: 2000 },
      );

      if (!relayListEvents.length) {
        return [];
      }

      const relayListEvent = relayListEvents.sort(
        (left, right) => right.created_at - left.created_at,
      )[0];

      const relays = dedupeRelays(
        relayListEvent.tags
          .filter((tag) => RELAY_EVENT_TAGS.has(tag[0]))
          .map((tag) => normalizeRelayUrl(tag[1]))
          .filter((relay): relay is string => Boolean(relay)),
      );

      recipientDmRelayCache.set(this.recipientPubkey, {
        relays,
        fetchedAt: Date.now(),
      });

      this.deps.logger.info(
        {
          recipient: this.recipientPubkey,
          relayCount: relays.length,
          relays,
        },
        "resolved recipient DM relays",
      );

      return relays;
    } catch (error) {
      this.deps.logger.error(
        { error, recipient: this.recipientPubkey },
        "failed to fetch recipient DM relay list (kind 10050)",
      );
      return [];
    }
  }

  private async publishToRelays(
    relays: string[],
    event: Parameters<SimplePool["publish"]>[1],
  ): Promise<{
    successfulRelays: string[];
    failedRelayCount: number;
    failedRelays: Array<{ relay: string; reason: string }>;
  }> {
    const uniqueRelays = dedupeRelays(relays);

    if (uniqueRelays.length === 0) {
      return {
        successfulRelays: [],
        failedRelayCount: 0,
        failedRelays: [],
      };
    }

    const publishResults = await Promise.allSettled(
      this.pool.publish(uniqueRelays, event),
    );

    const successfulRelays: string[] = [];
    const failedRelays: Array<{ relay: string; reason: string }> = [];

    publishResults.forEach((result, index) => {
      if (
        result.status === "fulfilled" &&
        !(
          typeof result.value === "string" &&
          result.value.startsWith("connection failure:")
        )
      ) {
        successfulRelays.push(uniqueRelays[index]);
      } else {
        const reason =
          result.status === "fulfilled"
            ? result.value
            : result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);

        failedRelays.push({ relay: uniqueRelays[index], reason });
      }
    });

    return {
      successfulRelays,
      failedRelayCount: failedRelays.length,
      failedRelays,
    };
  }

  async initialize(): Promise<void> {
    const identity = this.deps.identityRepo.getOrCreateNotifierIdentity();
    const decodedNsec = nip19.decode(identity.nsec);
    if (decodedNsec.type !== "nsec") {
      throw new Error("stored notifier nsec is invalid");
    }

    this.senderSecretKey = decodedNsec.data;
    this.senderPubkey = identity.pubkey;

    this.deps.logger.info(
      {
        senderPubkey: this.senderPubkey,
        recipientPubkey: this.recipientPubkey,
      },
      "initialized Nostr DM notification sender",
    );

    const existingProfile = await this.pool.get(
      this.deps.relays,
      {
        authors: [identity.pubkey],
        kinds: [0],
      },
      { maxWait: 2000 },
    );

    if (!existingProfile) {
      const metadataEvent = finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            name: "NostrMind",
            display_name: "NostrMind",
            about: "Autonomous Nostr intelligence watchdog",
          }),
        },
        this.senderSecretKey,
      );

      const metadataPublish = await this.publishToRelays(
        this.deps.relays,
        metadataEvent,
      );

      if (metadataPublish.successfulRelays.length === 0) {
        throw new Error(
          `failed to publish metadata profile to any relay: ${metadataPublish.failedRelays
            .map(({ relay, reason }) => `${relay} (${reason})`)
            .join("; ")}`,
        );
      }

      this.deps.logger.info(
        {
          pubkey: identity.pubkey,
          successfulRelayCount: metadataPublish.successfulRelays.length,
          failedRelayCount: metadataPublish.failedRelayCount,
          failedRelays: metadataPublish.failedRelays,
        },
        "published NostrMind metadata profile",
      );
    }
  }

  async sendMatchNotification(
    input: Parameters<NotificationSender["sendMatchNotification"]>[0],
  ): Promise<void> {
    if (!this.senderSecretKey || !this.senderPubkey) {
      await this.initialize();
    }

    const plaintext = formatNotificationMessage(input);
    const senderRelays = dedupeRelays(this.deps.relays);

    this.deps.logger.info(
      {
        eventId: input.event.id,
        watchlistId: input.watchlist.id,
        watchlistName: input.watchlist.name,
        senderRelayCount: senderRelays.length,
      },
      "building NIP-17 DM notification",
    );

    // Mirror the reference bus/client behavior:
    // create one wrap addressed to the sender (so other clients for that key can
    // show the sent message) and one wrap addressed to the recipient.
    const wrappedCopies = nip17.wrapManyEvents(
      this.senderSecretKey!,
      [{ publicKey: this.recipientPubkey }],
      plaintext,
    );

    if (wrappedCopies.length < 2) {
      throw new Error(
        "failed to create NIP-17 DM copies for sender and recipient",
      );
    }

    const [senderCopyWrap, recipientCopyWrap] = wrappedCopies;

    const recipientDmRelays = await this.getRecipientDmRelays();
    const recipientTargetRelays = dedupeRelays([
      ...senderRelays,
      ...recipientDmRelays,
    ]);

    const [recipientPublishResult, senderPublishResult] = await Promise.all([
      this.publishToRelays(recipientTargetRelays, recipientCopyWrap),
      this.publishToRelays(senderRelays, senderCopyWrap),
    ]);

    if (recipientPublishResult.successfulRelays.length === 0) {
      throw new Error(
        `failed to send NIP-17 DM: no relay accepted the recipient copy (${recipientPublishResult.failedRelays
          .map(({ relay, reason }) => `${relay}: ${reason}`)
          .join("; ")})`,
      );
    }

    if (senderPublishResult.successfulRelays.length === 0) {
      this.deps.logger.warn?.(
        {
          eventId: input.event.id,
          watchlistId: input.watchlist.id,
          recipient: this.recipientPubkey,
          failedRelays: senderPublishResult.failedRelays,
        },
        "published recipient DM copy, but failed to publish sender copy",
      );
    }

    this.deps.logger.info(
      {
        eventId: input.event.id,
        watchlistId: input.watchlist.id,
        recipient: this.recipientPubkey,
        recipientRelayCount: recipientTargetRelays.length,
        senderRelayCount: senderRelays.length,
        recipientSuccessfulRelayCount:
          recipientPublishResult.successfulRelays.length,
        recipientFailedRelayCount: recipientPublishResult.failedRelayCount,
        senderSuccessfulRelayCount: senderPublishResult.successfulRelays.length,
        senderFailedRelayCount: senderPublishResult.failedRelayCount,
        recipientSuccessfulRelays: recipientPublishResult.successfulRelays,
        recipientFailedRelays: recipientPublishResult.failedRelays,
        senderSuccessfulRelays: senderPublishResult.successfulRelays,
        senderFailedRelays: senderPublishResult.failedRelays,
      },
      "sent NIP-17 gift-wrapped DM copies for recipient and sender",
    );
  }
}
