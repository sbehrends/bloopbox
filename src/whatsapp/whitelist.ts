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

    const chatJid = normaliseJid(address.chatJid);

    if (chatJid.length === 0) return { allowed: false, reason: 'missing chat jid' };
    if (NEVER_ALLOWED.has(chatJid)) return { allowed: false, reason: 'status broadcast' };
    if (REJECTED_SUFFIXES.some((suffix) => chatJid.endsWith(suffix))) {
      return { allowed: false, reason: 'not a personal or group chat' };
    }

    const target = this.#byJid.get(chatJid);
    if (!target) {
      return { allowed: false, reason: 'not an assigned contact or group' };
    }

    return { allowed: true, target };
  }
}
