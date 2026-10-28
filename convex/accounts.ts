import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import { SIG, requireSig, verifyBind, verifyCreate, hasSig } from "./auth"

// Player accounts. The account key never leaves the player's device: the game sends only a
// SHA-256 of it (kh), and the server stores a second hash of that (lid), so a database leak
// does not reveal anything that can be used to sign in.
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const KH = /^[a-f0-9]{64}$/
const AID = /^[a-z0-9]{6,24}$/
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const MAX_STATE = 400_000
const MAX_WALLETS = 5

function addWallet(list: string[], w: string | undefined): string[] {
  if (!w || !B58.test(w) || list.includes(w) || list.length >= MAX_WALLETS) return list
  return [...list, w]
}

export const create = mutation({
  args: {
    aid: v.string(),
    kh: v.string(),
    state: v.string(),
    wallet: v.optional(v.string()),
    ...SIG,
  },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh) || !AID.test(a.aid)) return { ok: false, e: "bad" }
    const pk = verifyCreate(a)
    if (a.state.length > MAX_STATE) return { ok: false, e: "big" }
    const lid = await sha("lid:" + a.kh)
    const byKey = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (byKey) return { ok: false, e: "exists" }
    const byAid = await ctx.db.query("accounts").withIndex("by_aid", (q) => q.eq("aid", a.aid)).first()
    if (byAid) return { ok: false, e: "aid" }
    await ctx.db.insert("accounts", {
      lid,
      aid: a.aid,
      state: a.state,
      ver: 1,
      wallets: addWallet([], a.wallet),
      ...(pk ? { pk } : {}),
      created: Date.now(),
      updated: Date.now(),
    })
    return { ok: true, e: "", ver: 1 }
  },
})

// Older accounts (created before signatures) have no pk yet. The game binds its key once, proving it holds the key.
export const bind = mutation({
  args: { kh: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh) || typeof a.pk !== "string") return { ok: false, e: "bad" }
    const acc = await verifyBind(ctx.db, a)
    await ctx.db.patch(acc._id, { pk: a.pk, updated: Date.now() })
    return { ok: true, e: "" }
  },
})

// Sign in on a new phone: the key finds the account and returns the saved progress.
export const get = query({
  args: { kh: v.string() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, aid: "", state: "", ver: 0, wallets: [] as string[] }
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false, aid: "", state: "", ver: 0, wallets: [] as string[] }
    return { ok: true, aid: acc.aid, state: acc.state, ver: acc.ver, wallets: acc.wallets }
  },
})

// Optimistic save: only accepted when the device saw the latest version.
export const save = mutation({
  args: {
    kh: v.string(),
    base: v.number(),
    state: v.string(),
    wallet: v.optional(v.string()),
    ...SIG,
  },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad", ver: 0 }
    if (a.state.length > MAX_STATE) return { ok: false, e: "big", ver: 0 }
    await requireSig(ctx.db, a, "accounts:save")
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false, e: "none", ver: 0 }
    if (acc.ver !== a.base) return { ok: false, e: "stale", ver: acc.ver }
    const ver = acc.ver + 1
    await ctx.db.patch(acc._id, {
      state: a.state,
      ver,
      wallets: addWallet(acc.wallets, a.wallet),
      updated: Date.now(),
    })
    return { ok: true, e: "", ver }
  },
})

export const remove = mutation({
  args: { kh: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false }
    await requireSig(ctx.db, a, "accounts:remove")
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false }
    await ctx.db.delete(acc._id)
    // Free the lot this account owned, so the number can be given to someone else.
    const owner = await sha("lot:" + a.kh)
    const lot = await ctx.db.query("lots").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    if (lot) await ctx.db.delete(lot._id)
    return { ok: true }
  },
})

// Link another wallet to this account (for example an old wallet that still holds NFTs).
export const link = mutation({
  args: { kh: v.string(), wallet: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh) || !B58.test(a.wallet)) return { ok: false, e: "bad", wallets: [] as string[] }
    await requireSig(ctx.db, a, "accounts:link")
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false, e: "none", wallets: [] as string[] }
    if (acc.wallets.includes(a.wallet)) return { ok: true, e: "", wallets: acc.wallets }
    if (acc.wallets.length >= MAX_WALLETS) return { ok: false, e: "full", wallets: acc.wallets }
    const wallets = [...acc.wallets, a.wallet]
    await ctx.db.patch(acc._id, { wallets, updated: Date.now() })
    return { ok: true, e: "", wallets }
  },
})

export const unlink = mutation({
  args: { kh: v.string(), wallet: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad", wallets: [] as string[] }
    await requireSig(ctx.db, a, "accounts:unlink")
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false, e: "none", wallets: [] as string[] }
    const wallets = acc.wallets.filter((w) => w !== a.wallet)
    await ctx.db.patch(acc._id, { wallets, updated: Date.now() })
    return { ok: true, e: "", wallets }
  },
})
