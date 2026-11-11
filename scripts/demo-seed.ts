import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { OrderInput } from '@/lib/order-schema';
import { normalizePhone, type OrderSource, type OrderStatus, type Permission } from '@/shared';
import { updateSetting } from '../server/admin/settings';
import { createUser, type Actor } from '../server/admin/users';
import { setupFirstOwner } from '../server/admin/first-owner';
import { clickIdFromRequest } from '../server/orders/attribution';
import { recordClick } from '../server/affiliates/clicks';
import { REF_COOKIE, signRef } from '../server/affiliates/ref';
import { acceptInvite } from '../server/auth/recovery';
import { issueToken } from '../server/auth/tokens';
import { fixedClock } from '../server/clock';
import { resolveDataDir, type Config } from '../server/config';
import { payableOf, createPayout } from '../server/commissions/payouts';
import { applyMigrations } from '../server/db/migrate';
import { openDatabase, type Db } from '../server/db/sqlite';
import { memoryMailer } from '../server/mail/mailer';
import { createOrder } from '../server/orders/create';
import { changeStatus } from '../server/orders/status';
import type { OrderActor } from '../server/orders/types';
import { hashPassword } from '../server/security/crypto';
import { algiersDateString, algiersDayBounds } from '../server/util/algiers';

// Local demo data: `npm run demo:seed [-- --reset]`.
//
// Everything goes through the REAL service layer (user service, invitation acceptance, click recording, the signed
// cookie, createOrder, changeStatus, payouts, settings) with an injected clock that walks through the last ~14 days,
// so every invariant (commissions, history, audit, adjustments) is produced by the production code, not by raw SQL.
// It refuses to run with NODE_ENV=production, and when the target database already has users (unless --reset, which
// removes only the demo database under the demo data directory). The password below is a documented DEMO credential.

export const DEMO_PASSWORD = 'Demo-Darling-2026!';
export const DEMO_DATA_DIR = './.data-demo';
const DB_FILE = 'darling.sqlite';
const MARKER_FILE = '.demo-marker';
const ENV_FILE = '.demo-env';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

// --- summary types ----------------------------------------------------------------------------------

export interface DemoAccount {
  label: string;
  name: string;
  email: string;
  note: string;
}

export interface DemoSummary {
  accounts: DemoAccount[];
  affiliates: { name: string; code: string }[];
  orders: { total: number; byStatus: Record<string, number> };
  commissions: { total: number; byStatus: Record<string, number>; onHold: number };
  payouts: { count: number; total: number };
  adjustments: { count: number; total: number };
  clicks: number;
  toPay: { name: string; amount: number }[];
  totalToPay: number;
}

// --- deterministic randomness ----------------------------------------------------------------------

/** mulberry32: a tiny seeded generator, so the same clock always gives the same demo. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const SEED = 20_261_111;

// --- scenario data ---------------------------------------------------------------------------------

const NAMES = [
  'Amel Bensalem', 'Yasmine Khelifi', 'Nesrine Boudiaf', 'Meriem Haddad', 'Lydia Amrani', 'Sabrina Mebarki', 'Ines Toumi', 'Wafa Cherif',
  'Katia Ouali', 'Samira Belkacem', 'Imane Rahmani', 'Rania Zerrouki', 'Hanane Saadi', 'Djamila Benyoucef', 'Houda Bouzid', 'Sonia Ait Ahmed',
  'Leila Meziane', 'Maya Slimani', 'Nadia Ferhat', 'Chahra Mansouri', 'Racha Boukhalfa', 'Selma Guendouz', 'Amina Hamdi', 'Farah Merabet',
  'Thinhinane Aoudia', 'Dounia Kaci', 'Nawel Belaid', 'Manel Soltani', 'Sihem Lounis', 'Celia Messaoudi', 'Rym Bouchama', 'Assia Daoudi',
];
// Wilaya code (data/delivery.ts) and a few real communes. Never Tindouf (no Stop Desk service).
const PLACES: { code: number; communes: string[] }[] = [
  { code: 16, communes: ['Hydra', 'Bab Ezzouar', 'Kouba', 'El Biar', 'Dar El Beida', 'Bordj El Kiffan'] },
  { code: 31, communes: ['Bir El Djir', 'Es Senia', 'Arzew'] },
  { code: 25, communes: ['El Khroub', 'Ali Mendjeli'] },
  { code: 9, communes: ['Boufarik', 'Ouled Yaich'] },
  { code: 15, communes: ['Azazga', 'Draa Ben Khedda'] },
  { code: 19, communes: ['El Eulma', 'Ain Arnat'] },
  { code: 23, communes: ['El Bouni', 'Sidi Amar'] },
  { code: 6, communes: ['Akbou', 'Amizour'] },
  { code: 35, communes: ['Boudouaou', 'Bordj Menaiel'] },
  { code: 42, communes: ['Kolea', 'Cherchell'] },
  { code: 5, communes: ['Barika', 'Ain Touta'] },
  { code: 27, communes: ['Hassi Mameche', 'Ain Tedeles'] },
];
const STREETS = ['12 rue Didouche Mourad', 'Cité 5 Juillet, bât. B', '8 boulevard Colonel Amirouche', 'Lotissement El Wiam n°24', '3 rue des Frères Bouadou', 'Cité Les Palmiers, n°17'];
const REFERERS = ['https://www.instagram.com/', 'https://l.instagram.com/', 'https://www.tiktok.com/', 'https://www.facebook.com/', null];
const PAYOUT_NOTES: { method: 'cash' | 'baridimob' | 'ccp'; reference: string | null; note: string | null }[] = [
  { method: 'baridimob', reference: 'BM-20261105-0417', note: 'Paiement des commandes livrées de la première semaine.' },
  { method: 'cash', reference: null, note: 'Remis en main propre à l’atelier.' },
  { method: 'ccp', reference: 'CCP-7788120', note: null },
];

type Step = readonly [OrderStatus, number]; // [status, hours after the previous step]
const DELIVERED: Step[] = [['confirmed', 3], ['shipped', 21], ['delivered', 36]];
const SHIPPED: Step[] = [['confirmed', 3], ['shipped', 21]];
const CONFIRMED: Step[] = [['confirmed', 3]];
const CANCELLED: Step[] = [['confirmed', 4], ['cancelled', 9]];
const CANCELLED_NEW: Step[] = [['cancelled', 6]];
const REFUSED: Step[] = [['confirmed', 3], ['shipped', 21], ['refused', 40]];
const NEW: Step[] = [];

type Via = { kind: 'organic'; source: 'website' | 'instagram' | 'whatsapp' } | { kind: 'click'; code: string } | { kind: 'staff'; code: string; source: 'instagram' | 'whatsapp' };
const organic = (source: 'website' | 'instagram' | 'whatsapp' = 'website'): Via => ({ kind: 'organic', source });
const click = (code: string): Via => ({ kind: 'click', code });

interface Scenario {
  daysAgo: number;
  via: Via;
  steps: Step[];
  /** The customer is the influenceuse herself (phone = hers): the commissions are held. */
  selfReferral?: boolean;
}

/**
 * The story, oldest first. Payouts happen six days ago: everything delivered before that is paid (Aya, Lina and
 * Karim), the order of day 12 is returned afterwards (clawback), everything delivered after is validated.
 */
const SCENARIOS: Scenario[] = [
  { daysAgo: 13, via: click('AYA001'), steps: DELIVERED },
  { daysAgo: 13, via: click('AYA001'), steps: DELIVERED },
  { daysAgo: 12, via: click('LIN001'), steps: DELIVERED },
  { daysAgo: 12, via: organic(), steps: DELIVERED },
  { daysAgo: 12, via: { kind: 'staff', code: 'AYA001', source: 'instagram' }, steps: DELIVERED },
  { daysAgo: 11, via: click('SAR001'), steps: DELIVERED },
  { daysAgo: 11, via: click('AYA001'), steps: [...DELIVERED, ['returned', 8 * 24 - 60]] }, // returned AFTER the payout
  { daysAgo: 10, via: click('LIN001'), steps: DELIVERED },
  { daysAgo: 10, via: organic(), steps: DELIVERED },
  { daysAgo: 10, via: organic('whatsapp'), steps: DELIVERED },
  { daysAgo: 9, via: organic(), steps: CANCELLED },
  { daysAgo: 9, via: click('LIN001'), steps: REFUSED },
  { daysAgo: 8, via: click('AYA001'), steps: DELIVERED },
  { daysAgo: 8, via: organic(), steps: DELIVERED },
  { daysAgo: 7, via: click('SAR001'), steps: DELIVERED },
  { daysAgo: 7, via: click('LIN001'), steps: DELIVERED },
  { daysAgo: 7, via: organic('whatsapp'), steps: DELIVERED },
  { daysAgo: 6, via: click('AYA001'), steps: CANCELLED },
  { daysAgo: 6, via: organic(), steps: REFUSED },
  { daysAgo: 6, via: click('SAR001'), steps: CANCELLED_NEW },
  { daysAgo: 5, via: click('SAR001'), steps: DELIVERED, selfReferral: true },
  { daysAgo: 5, via: click('LIN001'), steps: CANCELLED_NEW },
  { daysAgo: 4, via: click('AYA001'), steps: DELIVERED },
  { daysAgo: 4, via: organic(), steps: DELIVERED },
  { daysAgo: 3, via: click('LIN001'), steps: SHIPPED },
  { daysAgo: 3, via: { kind: 'staff', code: 'LIN001', source: 'whatsapp' }, steps: CONFIRMED },
  { daysAgo: 2, via: click('AYA001'), steps: CONFIRMED },
  { daysAgo: 2, via: organic('instagram'), steps: SHIPPED },
  { daysAgo: 1, via: click('AYA001'), steps: NEW },
  { daysAgo: 1, via: click('LIN001'), steps: NEW },
  { daysAgo: 0, via: organic(), steps: NEW },
  { daysAgo: 0, via: organic('instagram'), steps: NEW },
  { daysAgo: 0, via: click('SAR001'), steps: NEW },
];

/** Visits that did not (yet) turn into an order: the funnel is wider than the orders. */
const EXTRA_CLICKS: Record<string, number> = { AYA001: 14, LIN001: 11, SAR001: 8 };
const PAYOUT_DAYS_AGO = 6;

// --- the seed --------------------------------------------------------------------------------------

export interface SeedDeps {
  db: Db;
  config: Pick<Config, 'encryptionKey' | 'appOrigin'>;
  /** The "present" of the demo (epoch ms): the data spans the 15 days before it. Default: the real time. */
  now?: number;
}

interface Event {
  at: number;
  run: () => void | Promise<void>;
}

/** Midnight (Algiers) of the day `daysAgo` before `now`, as epoch ms. */
function dayStart(now: number, daysAgo: number): number {
  return algiersDayBounds(algiersDateString(now - daysAgo * DAY))?.start ?? now - daysAgo * DAY;
}

/**
 * Seeds an empty, migrated database through the real services and returns what it created. Throws when the
 * database already has users: this function never mixes demo data into a real one.
 */
export async function seedDemo(deps: SeedDeps): Promise<DemoSummary> {
  const { db, config } = deps;
  if (db.get('SELECT 1 AS any_user FROM users LIMIT 1')) throw new Error('The database already has users.');
  const now = deps.now ?? Date.now();
  const clock = fixedClock(now - 15 * DAY);
  const rand = rng(SEED);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const mailer = memoryMailer();
  const usersDeps = { db, clock, config, mailer };
  const ctxDeps = { db, clock };

  // --- people: the owner first (the first-run path), then everybody else through the user service -----
  const ownerHash = await hashPassword(DEMO_PASSWORD);
  const { userId: ownerId } = setupFirstOwner(ctxDeps, { email: 'owner@demo.darling.test', fullName: 'Nadia Belhadj', passwordHash: ownerHash, ip: '127.0.0.1', requestId: 'demo-seed' });
  const ownerActor: Actor = { userId: ownerId, ip: '127.0.0.1', requestId: 'demo-seed' };
  // The owner has no authenticator in the demo: the 2FA requirement is switched off through the real settings service.
  clock.advance(MINUTE);
  updateSetting(ctxDeps, ownerActor, 'security.require_2fa_super_managers', false);

  const invite = async (input: Parameters<typeof createUser>[2]): Promise<string> => {
    clock.advance(MINUTE);
    const user = createUser(usersDeps, ownerActor, input);
    const token = issueToken(db, clock, { userId: user.id, type: 'invite' }); // supersedes the (unsent) mailed link
    const outcome = await acceptInvite({ db, clock }, { token, password: DEMO_PASSWORD, ip: '127.0.0.1', requestId: 'demo-seed' });
    if (outcome.kind !== 'ok') throw new Error(`Could not activate ${input.email}: ${outcome.kind}`);
    return user.id;
  };
  const opsPermissions: Permission[] = ['orders.read', 'orders.write'];
  const opsId = await invite({ email: 'ops@demo.darling.test', fullName: 'Sofiane Merah', role: 'super_manager', permissions: opsPermissions });
  const karimId = await invite({ email: 'karim@demo.darling.test', fullName: 'Karim Boudjemaa', phone: '0661203040', role: 'sub_manager' });
  await invite({ email: 'aya@demo.darling.test', fullName: 'Aya Benali', phone: '0550112233', role: 'affiliate', managerUserId: karimId });
  await invite({ email: 'lina@demo.darling.test', fullName: 'Lina Hamidi', phone: '0770445566', role: 'affiliate', managerUserId: karimId });
  await invite({ email: 'sara@demo.darling.test', fullName: 'Sara Mokrani', phone: '0555778899', role: 'affiliate' });
  const phoneOf = (email: string): string => {
    const stored = db.get<{ phone: string }>('SELECT phone FROM users WHERE email = ?', email)?.phone ?? '';
    return normalizePhone(stored) ?? stored;
  };

  const codeToEmail: Record<string, string> = { AYA001: 'aya@demo.darling.test', LIN001: 'lina@demo.darling.test', SAR001: 'sara@demo.darling.test' };
  for (const [code, email] of Object.entries(codeToEmail)) {
    const row = db.get<{ code: string }>('SELECT p.code FROM affiliate_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?', email);
    if (row?.code !== code) throw new Error(`Unexpected affiliate code for ${email}: ${row?.code ?? 'none'}`);
  }

  // --- the timeline ---------------------------------------------------------------------------------
  const staff: OrderActor[] = [
    { userId: ownerId, ip: '102.42.10.5', requestId: 'demo-seed' },
    { userId: opsId, ip: '102.42.10.9', requestId: 'demo-seed' },
  ];
  const events: Event[] = [];
  const usedPhones = new Set<string>(['0661203040', '0550112233', '0770445566', '0555778899']);
  const freshPhone = (): string => {
    for (;;) {
      const phone = `0${pick([5, 6, 7])}${String(between(0, 99_999_999)).padStart(8, '0')}`;
      if (!usedPhones.has(phone)) {
        usedPhones.add(phone);
        return phone;
      }
    }
  };
  let visitor = 0;
  const visitorIp = () => {
    visitor += 1;
    return `105.${(visitor >> 8) & 255}.${visitor & 255}.${between(2, 250)}`;
  };
  const moment = (daysAgo: number): number => {
    if (daysAgo >= 1) return dayStart(now, daysAgo) + between(9 * 60, 21 * 60) * MINUTE;
    return now - between(25, 300) * MINUTE;
  };
  const capped = (at: number) => Math.min(at, now - MINUTE);

  const doClick = (code: string, at: number): string => {
    clock.set(at);
    const result = recordClick({ db, clock, config }, { code, ip: visitorIp(), referer: pick(REFERERS), landingPath: '/' });
    if (!result) throw new Error(`No click recorded for ${code}`);
    return result.clickId;
  };

  const orderIds: string[] = [];
  SCENARIOS.forEach((scenario, index) => {
    const createdAt = capped(moment(scenario.daysAgo));
    const customer = scenario.selfReferral ? 'Sara Mokrani' : pick(NAMES);
    const place = pick(PLACES);
    const mode = rand() < 0.55 ? 'desk' : 'home';
    const phone = scenario.selfReferral ? phoneOf('sara@demo.darling.test') : freshPhone();
    const input: OrderInput = {
      productSlug: 'wet-kiss',
      shadeCode: pick(['*01', '*02', '*03', '*04']),
      quantity: rand() < 0.6 ? 1 : between(2, 3),
      fullName: customer,
      phone,
      wilayaCode: place.code,
      commune: pick(place.communes),
      mode,
      ...(mode === 'home' ? { address: pick(STREETS) } : {}),
    };
    const clickLead = between(4, 55) * MINUTE;
    const actor = pick(staff);
    events.push({
      at: createdAt,
      run: () => {
        const via = scenario.via;
        if (via.kind === 'click') {
          // The storefront path: a click, the signed cookie it sets, and the intake's own cookie check.
          const clickId = doClick(via.code, createdAt - clickLead);
          const cookie = `${REF_COOKIE}=${signRef(config, clickId)}`;
          const verified = clickIdFromRequest(new Request(config.appOrigin, { headers: { cookie } }), config);
          clock.set(createdAt);
          orderIds[index] = createOrder(ctxDeps, input, { source: 'website', ...(verified ? { refClickId: verified } : {}) }).order.id;
        } else if (via.kind === 'staff') {
          clock.set(createdAt);
          orderIds[index] = createOrder(ctxDeps, input, { source: via.source, createdBy: actor.userId, affiliateCode: via.code, ip: actor.ip, requestId: actor.requestId }).order.id;
        } else {
          clock.set(createdAt);
          const staffEntered = via.source !== 'website';
          orderIds[index] = createOrder(ctxDeps, input, { source: via.source as OrderSource, ...(staffEntered ? { createdBy: actor.userId, ip: actor.ip, requestId: actor.requestId } : {}) }).order.id;
        }
      },
    });
    let at = createdAt;
    for (const [to, hours] of scenario.steps) {
      at = capped(Math.max(at + MINUTE, at + hours * HOUR + between(-30, 30) * MINUTE));
      const stepAt = at;
      const stepActor = pick(staff);
      events.push({
        at: stepAt,
        run: () => {
          clock.set(stepAt);
          changeStatus(ctxDeps, stepActor, orderIds[index] as string, to);
        },
      });
    }
  });

  for (const [code, extra] of Object.entries(EXTRA_CLICKS)) {
    for (let i = 0; i < extra; i += 1) {
      const at = capped(moment(between(0, 13)));
      events.push({ at, run: () => void doClick(code, at) });
    }
  }

  // Payouts, six days ago: Aya, Lina and Karim are paid for what was delivered by then. Sara is not paid yet.
  const payoutAt = dayStart(now, PAYOUT_DAYS_AGO) + 15 * HOUR;
  (['aya@demo.darling.test', 'lina@demo.darling.test', 'karim@demo.darling.test'] as const).forEach((email, i) => {
    const at = payoutAt + i * 7 * MINUTE;
    events.push({
      at,
      run: () => {
        clock.set(at);
        const beneficiary = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
        const detail = PAYOUT_NOTES[i] as (typeof PAYOUT_NOTES)[number];
        createPayout(ctxDeps, ownerActor, { beneficiaryUserId: beneficiary?.id as string, method: detail.method, reference: detail.reference, paidAt: algiersDateString(at), note: detail.note });
      },
    });
  });

  // A stable sort on time keeps same-instant events in creation order.
  events.map((event, i) => ({ event, i })).sort((a, b) => a.event.at - b.event.at || a.i - b.i).forEach(({ event }) => void event.run());
  clock.set(now);

  return summarise(db);
}

/** What the demo database holds, for the closing printout and the tests. */
export function summarise(db: Db): DemoSummary {
  const tally = (sql: string): Record<string, number> => Object.fromEntries(db.all<{ k: string; n: number }>(sql).map((r) => [r.k, r.n]));
  const byStatus = tally('SELECT status AS k, count(*) AS n FROM orders GROUP BY status');
  const commissionStatus = tally('SELECT status AS k, count(*) AS n FROM commissions GROUP BY status');
  const payouts = db.get<{ n: number; s: number }>('SELECT count(*) AS n, coalesce(sum(amount), 0) AS s FROM payouts');
  const adjustments = db.get<{ n: number; s: number }>('SELECT count(*) AS n, coalesce(sum(amount), 0) AS s FROM commission_adjustments');
  const people = db.all<{ id: string; full_name: string }>(
    "SELECT id, full_name FROM users WHERE role IN ('affiliate', 'sub_manager') ORDER BY CASE role WHEN 'sub_manager' THEN 0 ELSE 1 END, full_name",
  );
  const toPay = people.map((p) => ({ name: p.full_name, amount: payableOf(db, p.id).amount })).filter((p) => p.amount > 0);
  return {
    accounts: [
      { label: 'Super Manager (propriétaire)', name: 'Nadia Belhadj', email: 'owner@demo.darling.test', note: 'accès complet, sans 2FA' },
      { label: 'Super Manager (restreint)', name: 'Sofiane Merah', email: 'ops@demo.darling.test', note: 'commandes seulement (lecture + écriture)' },
      { label: 'Sous-manager', name: 'Karim Boudjemaa', email: 'karim@demo.darling.test', note: 'gère Aya et Lina' },
      { label: 'Influenceuse', name: 'Aya Benali', email: 'aya@demo.darling.test', note: 'code AYA001, manager Karim' },
      { label: 'Influenceuse', name: 'Lina Hamidi', email: 'lina@demo.darling.test', note: 'code LIN001, manager Karim' },
      { label: 'Influenceuse', name: 'Sara Mokrani', email: 'sara@demo.darling.test', note: 'code SAR001, sans manager' },
    ],
    affiliates: db.all<{ name: string; code: string }>('SELECT u.full_name AS name, p.code FROM affiliate_profiles p JOIN users u ON u.id = p.user_id ORDER BY p.code'),
    orders: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
    commissions: {
      total: Object.values(commissionStatus).reduce((a, b) => a + b, 0),
      byStatus: commissionStatus,
      onHold: db.get<{ n: number }>('SELECT count(*) AS n FROM commissions WHERE on_hold = 1')?.n ?? 0,
    },
    payouts: { count: payouts?.n ?? 0, total: payouts?.s ?? 0 },
    adjustments: { count: adjustments?.n ?? 0, total: adjustments?.s ?? 0 },
    clicks: db.get<{ n: number }>('SELECT count(*) AS n FROM affiliate_clicks')?.n ?? 0,
    toPay,
    totalToPay: toPay.reduce((s, p) => s + p.amount, 0),
  };
}

// --- printout --------------------------------------------------------------------------------------

const pad = (text: string, width: number) => text.padEnd(width);

/** The login URL, the credentials table and the affiliate links. */
export function renderCredentials(summary: Pick<DemoSummary, 'accounts' | 'affiliates'>, origin: string): string {
  const lines = ['', `Connexion : ${origin}/connexion`, `Mot de passe de démo (tous les comptes) : ${DEMO_PASSWORD}`, ''];
  const w = Math.max(...summary.accounts.map((a) => a.label.length));
  const e = Math.max(...summary.accounts.map((a) => a.email.length));
  for (const a of summary.accounts) lines.push(`  ${pad(a.label, w)}  ${pad(a.email, e)}  ${a.note}`);
  lines.push('', 'Liens influenceuses :');
  for (const a of summary.affiliates) lines.push(`  ${pad(a.code, 7)} ${pad(a.name, 14)} ${origin}/?ref=${a.code}`);
  lines.push('');
  return lines.join('\n');
}

export function renderCounts(summary: DemoSummary): string {
  const fmt = (record: Record<string, number>) => Object.entries(record).map(([k, n]) => `${k} ${n}`).join(', ');
  const lines = [
    `Commandes : ${summary.orders.total} (${fmt(summary.orders.byStatus)})`,
    `Commissions : ${summary.commissions.total} (${fmt(summary.commissions.byStatus)}; ${summary.commissions.onHold} en attente de contrôle)`,
    `Paiements : ${summary.payouts.count} (${summary.payouts.total} DA), régularisations : ${summary.adjustments.count} (${summary.adjustments.total} DA), clics : ${summary.clicks}`,
    `À payer maintenant : ${summary.totalToPay} DA (${summary.toPay.map((p) => `${p.name} ${p.amount}`).join(', ')})`,
    '',
  ];
  return lines.join('\n');
}

// --- environment and command -------------------------------------------------------------------------

export interface MainIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: MainIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The ENCRYPTION_KEY the demo runs with: the one in the environment when it is valid, otherwise a throwaway key
 * generated once and kept in `<dataDir>/.demo-env` (git-ignored), so the app boots without a `.env` file.
 */
export function demoEncryptionKey(dataDir: string, env: NodeJS.ProcessEnv): string {
  const given = env.ENCRYPTION_KEY?.trim();
  if (given && KEY_PATTERN.test(given)) return given;
  const file = path.join(dataDir, ENV_FILE);
  try {
    const found = /^ENCRYPTION_KEY=(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim();
    if (found && KEY_PATTERN.test(found)) return found;
  } catch {
    // not there yet: generate below
  }
  const key = randomBytes(32).toString('base64');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `# Throwaway key of the local demo. Not a secret worth keeping.\nENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
  return key;
}

export const demoDbPath = (dataDir: string) => path.join(dataDir, DB_FILE);

/** True when the demo database exists and has users (the demo is already seeded). */
export function demoIsSeeded(dataDir: string): boolean {
  const file = demoDbPath(dataDir);
  if (!fs.existsSync(file)) return false;
  const db = openDatabase(file);
  try {
    applyMigrations(db);
    return db.get('SELECT 1 AS any_user FROM users LIMIT 1') !== undefined;
  } finally {
    db.close();
  }
}

const removeDbFiles = (dataDir: string) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${demoDbPath(dataDir)}${suffix}`, { force: true });
};

/** `npm run demo:seed [-- --reset]`: returns the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: MainIo = processIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr(`${message}\n`);
    return 1;
  };
  let reset: boolean;
  try {
    reset = parseArgs({ args: argv, options: { reset: { type: 'boolean', default: false } }, strict: true, allowPositionals: false }).values.reset === true;
  } catch (err) {
    return fail(`Error: ${err instanceof Error ? err.message : 'invalid arguments'}\nUsage: npm run demo:seed [-- --reset]`);
  }
  if (env.NODE_ENV === 'production') return fail('Refusing to seed demo data with NODE_ENV=production. The demo credentials are public.');

  const dataDir = resolveDataDir({ DATA_DIR: env.DATA_DIR?.trim() || DEMO_DATA_DIR });
  const marker = path.join(dataDir, MARKER_FILE);
  if (fs.existsSync(demoDbPath(dataDir)) && demoIsSeeded(dataDir)) {
    if (!reset) return fail(`The database in ${dataDir} already has users. Re-run with --reset to wipe the demo database and seed again.`);
    if (!fs.existsSync(marker)) return fail(`${dataDir} was not created by the demo seed (no ${MARKER_FILE}): --reset only removes a demo database. Use another DATA_DIR.`);
  }
  if (reset && fs.existsSync(demoDbPath(dataDir))) removeDbFiles(dataDir);

  const encryptionKey = Buffer.from(demoEncryptionKey(dataDir, env), 'base64');
  const origin = env.APP_ORIGIN?.trim() || 'http://localhost:3000';
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(demoDbPath(dataDir));
  try {
    applyMigrations(db);
    const summary = await seedDemo({ db, config: { encryptionKey, appOrigin: origin } });
    fs.writeFileSync(marker, 'Created by scripts/demo-seed.ts. `npm run demo:seed -- --reset` may delete darling.sqlite here.\n');
    io.stdout(`Demo data written to ${demoDbPath(dataDir)}\n${renderCredentials(summary, origin)}\n${renderCounts(summary)}`);
    return 0;
  } catch (err) {
    return fail(`Error: ${err instanceof Error ? err.message : 'demo seed failed'}`);
  } finally {
    db.close();
  }
}

/** True only when this file is the script being run (not when a test or demo.ts imports it). */
function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return /[\\/]scripts[\\/]demo-seed\.[cm]?[jt]s$/.test(fs.realpathSync(entry));
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
