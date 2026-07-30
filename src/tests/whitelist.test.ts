import { describe, expect, it } from 'vitest';
import { Whitelist, normaliseJid, type AllowedTarget } from '../whatsapp/whitelist.ts';

/**
 * The contact whitelist (PRODUCT.md §4) — the safety boundary of the product.
 *
 * A 2-5 year old cannot judge who is talking to them, so these tests are written from the
 * position that anything not explicitly assigned by a parent must not reach the device.
 */

const MOM = '15551234567@s.whatsapp.net';
const DAD = '15559876543@s.whatsapp.net';
const FAMILY_GROUP = '15551234567-1699999999@g.us';

const targets: AllowedTarget[] = [
  { index: 0, jid: MOM, kind: 'individual' },
  { index: 1, jid: DAD, kind: 'individual' },
  { index: 2, jid: FAMILY_GROUP, kind: 'group' },
];

function list(): Whitelist {
  return new Whitelist(targets);
}

describe('normaliseJid', () => {
  it('strips the device suffix, so the same person matches from any of their devices', () => {
    expect(normaliseJid('15551234567:12@s.whatsapp.net')).toBe(MOM);
    expect(normaliseJid('15551234567:3@s.whatsapp.net')).toBe(MOM);
    expect(normaliseJid(MOM)).toBe(MOM);
  });

  it('is case-insensitive and trims', () => {
    expect(normaliseJid('  15551234567@S.WhatsApp.Net  ')).toBe(MOM);
  });

  it('leaves a bare value alone', () => {
    expect(normaliseJid('nonsense')).toBe('nonsense');
  });
});

describe('allowing assigned contacts', () => {
  it('accepts a direct message from an assigned number', () => {
    const decision = list().evaluate({ chatJid: MOM, fromMe: false });

    expect(decision).toMatchObject({ allowed: true });
    expect(decision.allowed && decision.target.index).toBe(0);
  });

  it('accepts the same person sending from a linked device', () => {
    const decision = list().evaluate({ chatJid: '15559876543:41@s.whatsapp.net', fromMe: false });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.target.index).toBe(1);
  });

  it('accepts a message in an assigned group, whoever spoke', () => {
    const decision = list().evaluate({
      chatJid: FAMILY_GROUP,
      // An aunt in the family group the parent deliberately assigned.
      participantJid: '15550001111@s.whatsapp.net',
      fromMe: false,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.target).toMatchObject({ index: 2, kind: 'group' });
  });

  it('routes to the button the target sits on', () => {
    const whitelist = list();
    expect(whitelist.lookup(MOM)?.index).toBe(0);
    expect(whitelist.lookup(FAMILY_GROUP)?.index).toBe(2);
  });
});

describe('rejecting everything else', () => {
  it('drops an unknown number', () => {
    const decision = list().evaluate({ chatJid: '15550009999@s.whatsapp.net', fromMe: false });

    expect(decision).toMatchObject({ allowed: false, reason: 'not an assigned contact or group' });
  });

  it('drops a group nobody assigned', () => {
    // The account may belong to many groups; only the chosen one is a valid destination.
    const decision = list().evaluate({ chatJid: '99999999-1600000000@g.us', fromMe: false });

    expect(decision.allowed).toBe(false);
  });

  it('drops status broadcasts', () => {
    const decision = list().evaluate({ chatJid: 'status@broadcast', fromMe: false });

    expect(decision).toMatchObject({ allowed: false, reason: 'status broadcast' });
  });

  it('drops newsletters and other broadcast surfaces', () => {
    for (const jid of ['123@newsletter', '456@broadcast']) {
      const decision = list().evaluate({ chatJid: jid, fromMe: false });
      expect(decision).toMatchObject({ allowed: false, reason: 'not a personal or group chat' });
    }
  });

  it('drops the device’s own messages', () => {
    // Our sends echo back; delivering them would replay the child's own voice at them.
    const decision = list().evaluate({ chatJid: MOM, fromMe: true });

    expect(decision).toMatchObject({ allowed: false, reason: 'sent by this device' });
  });

  it('drops a message with no chat jid', () => {
    const decision = list().evaluate({ chatJid: '', fromMe: false });

    expect(decision.allowed).toBe(false);
  });

  it('allows nothing at all when no contacts are configured', () => {
    const empty = new Whitelist();

    expect(empty.size).toBe(0);
    for (const jid of [MOM, DAD, FAMILY_GROUP]) {
      expect(empty.evaluate({ chatJid: jid, fromMe: false }).allowed).toBe(false);
    }
  });
});

describe('outbound routing', () => {
  it('resolves a button to its target', () => {
    const whitelist = list();

    expect(whitelist.forIndex(0)?.jid).toBe(MOM);
    expect(whitelist.forIndex(2)).toMatchObject({ jid: FAMILY_GROUP, kind: 'group' });
  });

  it('returns null for an unassigned button', () => {
    const partial = new Whitelist([{ index: 1, jid: DAD, kind: 'individual' }]);

    expect(partial.forIndex(0)).toBeNull();
    expect(partial.forIndex(1)?.jid).toBe(DAD);
  });
});

describe('reconfiguration', () => {
  it('replaces the set wholesale, so a removed contact stops being accepted', () => {
    const whitelist = list();
    expect(whitelist.evaluate({ chatJid: MOM, fromMe: false }).allowed).toBe(true);

    whitelist.replace([{ index: 0, jid: DAD, kind: 'individual' }]);

    // Mom was unassigned, and must immediately lose access.
    expect(whitelist.evaluate({ chatJid: MOM, fromMe: false }).allowed).toBe(false);
    expect(whitelist.evaluate({ chatJid: DAD, fromMe: false }).allowed).toBe(true);
    expect(whitelist.size).toBe(1);
  });

  it('reports its jids for diagnostics', () => {
    expect(list().jids().toSorted()).toEqual([DAD, FAMILY_GROUP, MOM].toSorted());
  });
});
