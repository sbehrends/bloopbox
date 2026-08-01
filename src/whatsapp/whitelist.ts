import type { ButtonIndex, TargetKind } from '../config/schema.ts';

/**
 * Who is allowed to reach this device (PRODUCT.md §4).
 *
 * This is the safety boundary of the whole product. A 2-5 year old cannot judge who is talking
 * to them, so the rule is a strict allowlist: a message is delivered only if its conversation
 * is one of the three a parent deliberately assigned. Everything else is dropped silently —
 * unknown numbers, groups nobody chose, status broadcasts, newsletters, the device's own
 * outgoing messages.
 *
 * Pure and synchronous: no I/O, so it is cheap to call on every inbound message and easy to
 * test exhaustively.
 */

/** A conversation the device accepts, resolved from config. */
export type AllowedTarget = {
  readonly index: ButtonIndex;
  readonly jid: string;
  readonly kind: TargetKind;
};

/** JIDs that are never a real conversation, whatever the config says. */
const NEVER_ALLOWED = new Set(['status@broadcast']);

/** Suffixes that are not person-to-person or group chats. */
const REJECTED_SUFFIXES = ['@broadcast', '@newsletter'] as const;

export type IncomingAddress = {
  /** The chat the message belongs to: a user JID or a group JID. */
  readonly chatJid: string;
  /**
   * The same chat under WhatsApp's other addressing scheme, when it is known.
   *
   * A direct message now arrives addressed to a LID (`44581961883857@lid`) rather than to the
   * phone number the parent typed. The two are the same person, so both are checked — matching
   * only the primary would reject a contact the parent deliberately assigned. Resolution
   * happens in the client, so this stays pure.
   */
  readonly chatJidAlt?: string | undefined;
  /** Within a group, who actually spoke. Absent for direct messages. */
  readonly participantJid?: string | undefined;
  /** True when the device itself sent this. */
  readonly fromMe: boolean;
};

export type WhitelistDecision =
  | { readonly allowed: true; readonly target: AllowedTarget }
  | { readonly allowed: false; readonly reason: string };

/**
 * Strips the device/agent suffix WhatsApp adds to JIDs.
 *
 * A JID can arrive as `15551234567:12@s.whatsapp.net` (a specific linked device) or
 * `15551234567@s.whatsapp.net`. Comparing raw strings would reject the same person depending
 * on which of their devices they happened to send from.
 */
export function normaliseJid(jid: string): string {
  const trimmed = jid.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at === -1) return trimmed;
  const user = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const colon = user.indexOf(':');
  return colon === -1 ? `${user}${domain}` : `${user.slice(0, colon)}${domain}`;
}

/** Builds a lookup from the configured contacts. */
export class Whitelist {
  #byJid = new Map<string, AllowedTarget>();
  #byIndex = new Map<ButtonIndex, AllowedTarget>();

  constructor(targets: readonly AllowedTarget[] = []) {
    this.replace(targets);
  }

  /** Swaps in a new set, e.g. after the hardware server sends updated contacts. */
  replace(targets: readonly AllowedTarget[]): void {
    this.#byJid = new Map(
      targets.map((target) => [normaliseJid(target.jid), { ...target, jid: target.jid }]),
    );
    // Indexed both ways: inbound needs jid -> button, outbound needs button -> jid.
    this.#byIndex = new Map(targets.map((target) => [target.index, { ...target }]));
  }

  get size(): number {
    return this.#byJid.size;
  }

  /** Every allowed JID, for logging and diagnostics. */
  jids(): string[] {
    return [...this.#byJid.values()].map((target) => target.jid);
  }

  /** The button a JID maps to, or null. Used for inbound messages. */
  lookup(jid: string): AllowedTarget | null {
    return this.#byJid.get(normaliseJid(jid)) ?? null;
  }

  /** Where a button sends to, or null if nothing is assigned. Used for outbound. */
  forIndex(index: ButtonIndex): AllowedTarget | null {
    return this.#byIndex.get(index) ?? null;
  }

  /**
   * Decides whether a message may reach the child.
   *
   * For a group, membership of the group is the permission — a parent assigning "the family
   * chat" is accepting everyone in it, and the device cannot meaningfully filter further
   * without becoming unpredictable. The speaker is still reported so it can be logged.
   */
  evaluate(address: IncomingAddress): WhitelistDecision {
    if (address.fromMe) {
      // Our own sends echo back; delivering them would replay the child's own voice.
      return { allowed: false, reason: 'sent by this device' };
    }

    /*
     * Both spellings of the same chat. Every rejection below is applied to all of them, so an
     * alternate can only ever admit a chat the parent assigned — never bypass a rule the
     * primary would have failed.
     */
    const candidates = [address.chatJid, address.chatJidAlt]
      .filter((jid): jid is string => typeof jid === 'string' && jid.trim().length > 0)
      .map(normaliseJid);

    if (candidates.length === 0) return { allowed: false, reason: 'missing chat jid' };
    if (candidates.some((jid) => NEVER_ALLOWED.has(jid))) {
      return { allowed: false, reason: 'status broadcast' };
    }
    if (candidates.some((jid) => REJECTED_SUFFIXES.some((suffix) => jid.endsWith(suffix)))) {
      return { allowed: false, reason: 'not a personal or group chat' };
    }

    for (const jid of candidates) {
      const target = this.#byJid.get(jid);
      if (target) return { allowed: true, target };
    }

    return { allowed: false, reason: 'not an assigned contact or group' };
  }
}
