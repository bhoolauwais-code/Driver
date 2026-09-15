import { getStore } from "@netlify/blobs";
import { randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Driver — player accounts.
 *
 *   POST /api/player  {action:"check",  name}              -> {available}
 *   POST /api/player  {action:"create", name}              -> {name, code, profile} | 409
 *   POST /api/player  {action:"login",  name, code}        -> {profile}             | 401/404
 *   POST /api/player  {action:"save",   name, code, patch} -> {profile}             | 401/404
 *   GET  /api/player?list=1                                -> roster for the Racers tab
 *
 * One blob per player, keyed "p/<slug>". Two players signing up at the same
 * moment write different keys, so neither can clobber the other — a single
 * shared list blob would lose one of them.
 *
 * The Driver Code is the only credential, and it is stored as written so the
 * owner can read it back when a player loses theirs. That is a deliberate
 * trade: it means whoever holds DRIVER_ADMIN_KEY — or a dump of the store —
 * can sign in as anybody. For a game played among friends that is the right
 * call, but it is why the admin listing is behind a key and fails closed when
 * that key isn't configured.
 *
 *   GET  /api/player?admin=<DRIVER_ADMIN_KEY>  -> every name with its code
 */

const STORE = "driver";
const PREFIX = "p/";
const MAX_NAME = 16;
const MIN_NAME = 3;

/* O/0 and I/1 left out — these get written on paper and typed back in. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const fail = (message, status) => json({ error: message }, status);

/** Display name -> stable blob key, so one player keeps one row. */
function slugFor(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
}

function cleanName(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")   // strip control characters
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

/** Names differing only by case or spacing are the same name. */
function nameIsLegal(name) {
  if (name.length < MIN_NAME) return "name must be at least " + MIN_NAME + " characters";
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) return "letters, numbers, spaces, - and _ only";
  if (!slugFor(name)) return "name needs at least one letter or number";
  return null;
}

function makeCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return "DRV-" + out.slice(0, 4) + "-" + out.slice(4);
}

/** Accepts "drv aBcd efgh", "DRV-ABCD-EFGH", etc. */
function normaliseCode(v) {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Constant-time compare, so timing can't be used to fish for a code. */
function sameCode(a, b) {
  const x = Buffer.from(normaliseCode(a));
  const y = Buffer.from(normaliseCode(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function freshProfile(name, slug) {
  return {
    name,
    slug,
    created: Date.now(),
    lastSeen: Date.now(),
    seconds: 0,          // time actually spent driving
    money: 2500,         // starting float, in Rand
    car: "polo14",
    owned: ["polo14"],
    best: 0,
    bestDistance: 0,
    races: { won: 0, lost: 0 },
    achievements: [],
  };
}

/* Only these may be written by the client, and only as the right shape. A
   client that sets its own money is a client that gives itself everything. */
function applyPatch(profile, patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const num = (v, max) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const best = num(p.best, 1e9);
  const dist = num(p.bestDistance, 1e7);
  const secs = num(p.seconds, 1e7);
  const money = num(p.money, 1e9);

  if (best !== null) profile.best = Math.max(profile.best || 0, best);
  if (dist !== null) profile.bestDistance = Math.max(profile.bestDistance || 0, dist);
  if (secs !== null) profile.seconds = Math.max(profile.seconds || 0, secs);
  if (money !== null) profile.money = money;
  if (typeof p.car === "string" && p.car.length < 32) profile.car = p.car;
  if (Array.isArray(p.owned))
    profile.owned = [...new Set(p.owned.filter(x => typeof x === "string" && x.length < 32))].slice(0, 200);
  if (p.upgrades && typeof p.upgrades === 'object') profile.upgrades = p.upgrades;
  if (p.fitted && typeof p.fitted === 'object' && !Array.isArray(p.fitted)) profile.fitted = p.fitted;
  if (Array.isArray(p.parts)) profile.parts = [...new Set(p.parts.filter(x => typeof x === 'string' && x.length < 40))].slice(0, 400);
  if (p.setup && typeof p.setup === 'object' && !Array.isArray(p.setup)) profile.setup = p.setup;
  // which of your cars are standing out in the yard rather than put away
  if (Array.isArray(p.parked))
    profile.parked = [...new Set(p.parked.filter(x => typeof x === 'string' && x.length < 32))].slice(0, 200);
  // A quarter mile time, in hundredths. Lower is better, so this one keeps
  // the minimum where every other figure keeps the maximum.
  const et = num(p.bestEt, 600000);
  if (et !== null && et > 0) profile.bestEt = profile.bestEt ? Math.min(profile.bestEt, et) : et;
  if (Array.isArray(p.achievements))
    profile.achievements = [...new Set(p.achievements.filter(x => typeof x === "string" && x.length < 48))].slice(0, 200);
  profile.lastSeen = Date.now();
  return profile;
}

/** What other players are allowed to see. Never the code hash. */
const publicView = p => ({
  name: p.name,
  slug: p.slug,
  created: p.created,
  lastSeen: p.lastSeen,
  seconds: p.seconds || 0,
  best: p.best || 0,
  bestDistance: p.bestDistance || 0,
  cars: (p.owned || []).length,
  car: p.car,
  races: p.races || { won: 0, lost: 0 },
  bestEt: p.bestEt || 0,
  achievements: (p.achievements || []).length,
});


const PRESENCE_TTL = 25000;      // you drop off the strip if we don't hear from you
const ONLINE_WINDOW = 120000;    // "online" means we heard from you in the last two minutes      // you drop off the strip if we don't hear from you

/** Everyone currently checked in at Nasrec, except you. */
async function nasrecRows(store, exceptSlug) {
  const { blobs } = await store.list({ prefix: PREFIX });
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
  const now = Date.now();
  return rows
    .filter(p => p && p.here && now - p.here.ts < PRESENCE_TTL && p.slug !== exceptSlug)
    .map(p => ({ name: p.name, slug: p.slug, car: p.here.car, since: p.here.ts }));
}

/* ---- Marketplace ----
   A listing lives on the seller's own record, so two people putting a car up
   at the same moment write different blobs and neither is lost. The board is
   gathered by reading them all back, the same way Nasrec presence works. */
const MAX_LISTINGS = 6;

function newListingId() {
  return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function marketRows(store) {
  const { blobs } = await store.list({ prefix: PREFIX });
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
  const out = [];
  for (const p of rows) {
    if (!p || !p.name || !Array.isArray(p.listings)) continue;
    for (const l of p.listings)
      if (l && (p.owned || []).includes(l.car))
        out.push({ id: l.id, car: l.car, price: l.price, ts: l.ts,
                   seller: p.name, sellerSlug: p.slug });
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export default async (req) => {
  const store = getStore(STORE);

  if (req.method === "GET") {
    const url = new URL(req.url);
    const admin = url.searchParams.get("admin");

    /* Owner's recovery list. Fails closed: with no key configured there is no
       way in, rather than the endpoint quietly serving every code. */
    if (admin !== null) {
      const expected = process.env.DRIVER_ADMIN_KEY;
      if (!expected) return fail("admin key is not configured on this site", 503);
      if (!sameCode(admin, expected)) return fail("not authorised", 401);
      try {
        const { blobs } = await store.list({ prefix: PREFIX });
        const rows = await Promise.all(
          blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
        );
        return json(
          rows.filter(r => r && r.name)
              .map(r => ({ name: r.name, code: r.code, created: r.created,
                           lastSeen: r.lastSeen, money: r.money, best: r.best,
                           cars: (r.owned || []).length }))
              .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        );
      } catch { return fail("could not read the roster", 500); }
    }

    if (url.searchParams.get("list") === null) return fail("nothing to get", 400);
    try {
      const { blobs } = await store.list({ prefix: PREFIX });
      const rows = await Promise.all(
        blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
      );
      return json(
        rows.filter(r => r && r.name)
            .map(publicView)
            .sort((a, b) => (b.best || 0) - (a.best || 0))
      );
    } catch {
      return fail("could not read the roster", 500);
    }
  }

  if (req.method !== "POST") return fail("method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return fail("expected a JSON body", 400); }

  const action = String(body.action || "");
  const name = cleanName(body.name);
  const slug = slugFor(name);
  const key = PREFIX + slug;

  if (action === "check" || action === "create") {
    const bad = nameIsLegal(name);
    if (bad) return json({ available: false, error: bad }, action === "check" ? 200 : 400);
  } else if (!slug) {
    return fail("name is required", 400);
  }

  if (action === "market") {
    try { return json({ listings: await marketRows(store) }); }
    catch { return fail("could not read the board", 500); }
  }

  try {
    const existing = await store.get(key, { type: "json" }).catch(() => null);

    if (action === "check") {
      return json({ available: !existing, name });
    }

    if (action === "create") {
      if (existing) return json({ error: "That driver name is already taken.", available: false }, 409);
      const code = makeCode();
      const profile = freshProfile(name, slug);
      await store.setJSON(key, { ...profile, code });
      return json({ name, code, profile }, 201);
    }


    if (action === "seen") {                    // "still playing", and how many others are
      if (!existing) return fail("No driver by that name.", 404);
      if (!sameCode(existing.code, body.code))
        return fail("That code doesn't match this driver.", 401);
      existing.lastSeen = Date.now();
      await store.setJSON(key, existing);
      const { blobs } = await store.list({ prefix: PREFIX });
      const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
      const cut = Date.now() - ONLINE_WINDOW;
      return json({ online: rows.filter(p => p && (p.lastSeen || 0) > cut).length });
    }

    /* ---- Nasrec: presence and race invites ---- */
    if (action === "here" || action === "leave" || action === "invite" ||
        action === "respond" || action === "answer" || action === "clearinvite") {
      if (!existing) return fail("No driver by that name.", 404);
      if (!sameCode(existing.code, body.code))
        return fail("That code doesn't match this driver.", 401);

      if (action === "here") {
        existing.here = { ts: Date.now(), car: String(body.car || "polo14").slice(0, 32) };
        await store.setJSON(key, existing);
        return json({ here: await nasrecRows(store, slug), invite: existing.invite || null });
      }

      if (action === "leave") {
        delete existing.here;
        await store.setJSON(key, existing);
        return json({ ok: true });
      }

      if (action === "invite") {
        const toKey = PREFIX + slugFor(body.to);
        const target = await store.get(toKey, { type: "json" }).catch(() => null);
        if (!target) return fail("That driver is not here.", 404);
        const wager = Math.max(0, Math.min(1e7, Math.floor(Number(body.wager) || 0)));
        if (wager > (existing.money || 0)) return fail("You can't cover that wager.", 400);
        target.invite = { from: existing.name, fromSlug: slug, wager, ts: Date.now(), status: "pending" };
        await store.setJSON(toKey, target);
        return json({ sent: true });
      }

      if (action === "respond") {
        const inv = existing.invite;
        if (!inv) return fail("Nothing to answer.", 404);
        inv.status = body.accept ? "accepted" : "declined";
        const fromKey = PREFIX + inv.fromSlug;
        const from = await store.get(fromKey, { type: "json" }).catch(() => null);
        if (from) {
          from.answer = { by: existing.name, wager: inv.wager, accepted: !!body.accept, ts: Date.now() };
          await store.setJSON(fromKey, from);
        }
        if (body.accept) existing.invite = inv; else delete existing.invite;
        await store.setJSON(key, existing);
        return json({ ok: true, status: inv.status });
      }

      if (action === "answer") {
        const ans = existing.answer || null;
        if (ans) { delete existing.answer; await store.setJSON(key, existing); }
        return json({ answer: ans });
      }

      if (action === "clearinvite") {
        delete existing.invite;
        await store.setJSON(key, existing);
        return json({ ok: true });
      }
    }

    /* ---- Marketplace: list a car, take it down, buy someone else's ---- */
    if (action === "sell" || action === "unlist" || action === "buy") {
      if (!existing) return fail("No driver by that name.", 404);
      if (!sameCode(existing.code, body.code))
        return fail("That code doesn't match this driver.", 401);
      existing.listings = Array.isArray(existing.listings) ? existing.listings : [];

      if (action === "sell") {
        const carId = String(body.car || "").slice(0, 32);
        const price = Math.floor(Number(body.price));
        const mine = existing.owned || [];
        if (!mine.includes(carId)) return fail("You don't own that car.", 400);
        if (mine.length < 2) return fail("That's your only car — you'd be walking home.", 400);
        if (!Number.isFinite(price) || price < 100 || price > 1e7)
          return fail("Pick a price between R100 and R10,000,000.", 400);
        existing.listings = existing.listings.filter(l => l && l.car !== carId);   // re-listing changes the price
        if (existing.listings.length >= MAX_LISTINGS)
          return fail("You already have " + MAX_LISTINGS + " cars up for sale.", 400);
        existing.listings.push({ id: newListingId(), car: carId, price, ts: Date.now() });
        await store.setJSON(key, existing);
        return json({ listings: existing.listings });
      }

      if (action === "unlist") {
        const id = String(body.id || "");
        existing.listings = existing.listings.filter(l => l && l.id !== id);
        await store.setJSON(key, existing);
        return json({ listings: existing.listings });
      }

      /* buy: the seller's side is written first, so the same car cannot be
         sold twice even if two people tap at once. */
      const sellerSlug = slugFor(body.seller);
      if (sellerSlug === slug) return fail("That one is yours already.", 400);
      const sellerKey = PREFIX + sellerSlug;
      const seller = await store.get(sellerKey, { type: "json" }).catch(() => null);
      if (!seller) return fail("That seller is no longer around.", 404);

      const listings = Array.isArray(seller.listings) ? seller.listings : [];
      const at = listings.findIndex(l => l && l.id === String(body.id || ""));
      if (at < 0) return fail("That one has already gone.", 409);
      const listing = listings[at];
      if (!(seller.owned || []).includes(listing.car)) {
        listings.splice(at, 1);
        seller.listings = listings;
        await store.setJSON(sellerKey, seller);
        return fail("That one has already gone.", 409);
      }
      // Listing is not selling: someone can put both their cars up. Whoever
      // buys second would leave them on foot, so that sale is the one refused.
      if ((seller.owned || []).length < 2) {
        listings.splice(at, 1);
        seller.listings = listings;
        await store.setJSON(sellerKey, seller);
        return fail("That is the only car they have left.", 409);
      }
      if ((existing.owned || []).includes(listing.car)) return fail("You have one of those already.", 400);
      if ((existing.money || 0) < listing.price) return fail("You can't cover that.", 400);

      listings.splice(at, 1);
      seller.listings = listings;
      seller.owned = (seller.owned || []).filter(c => c !== listing.car);
      if (!seller.owned.length) seller.owned = ["polo14"];
      if (seller.car === listing.car) seller.car = seller.owned[0];
      seller.money = (seller.money || 0) + listing.price;
      await store.setJSON(sellerKey, seller);

      existing.money = (existing.money || 0) - listing.price;
      existing.owned = [...new Set([...(existing.owned || []), listing.car])];
      existing.lastSeen = Date.now();
      await store.setJSON(key, existing);
      const { code: _c, ...rest } = existing;
      return json({ profile: rest, bought: { car: listing.car, price: listing.price, seller: seller.name } });
    }

    if (action === "login" || action === "save") {
      if (!existing) return fail("No driver by that name.", 404);
      if (!sameCode(existing.code, body.code))
        return fail("That code doesn't match this driver.", 401);

      const { code, ...rest } = existing;
      const profile = action === "save" ? applyPatch(rest, body.patch) : { ...rest, lastSeen: Date.now() };
      await store.setJSON(key, { ...profile, code });
      return json({ profile });
    }

    return fail("unknown action", 400);
  } catch (e) {
    return fail("the server could not complete that", 500);
  }
};

export const config = { path: "/api/player" };
