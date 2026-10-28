import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { SIG, requireSig } from "./auth"

const ITEMS = [
  "Hut", "Stone House", "Chariot", "Castle", "Steam Train", "Car", "Skyscraper", "Rocket",
  "Bed", "Table", "Chair", "Chest", "Lamp", "Stove", "Bookshelf", "Phone", "Computer", "Radio", "Kiln", "Smelter", "Foundry", "Factory",
  "Custom House", // a saved build registered as an NFT (see designs.ts)
]

// Everything currently for sale, newest first.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("listings")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .order("desc")
      .take(60)
    return rows.map((l) => ({
      id: l._id,
      seller: l.seller,
      sn: l.sn,
      item: l.item,
      price: l.price,
      cur: l.cur ?? "gold",
      w: l.w ?? "",
      loc: l.loc ?? "",
      a: l.a ?? "",
    }))
  },
})

export const create = mutation({
  args: {
    seller: v.string(),
    sn: v.string(),
    item: v.string(),
    price: v.number(),
    cur: v.optional(v.string()),
    w: v.optional(v.string()),
    loc: v.optional(v.string()),
    a: v.optional(v.string()),
    kh: v.optional(v.string()),
    ...SIG,
  },
  handler: async (ctx, a) => {
    if (!ITEMS.includes(a.item)) throw new Error("Unknown item")
    await requireSig(ctx.db, a, "market:create", "seller")
    if (!/^[a-z0-9]{6,24}$/.test(a.seller)) throw new Error("Bad seller")
    const cur = a.cur === "sol" ? "sol" : "gold"
    const asset = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.a ?? "") ? a.a : undefined
    let price: number
    if (cur === "sol") {
      price = Math.round(a.price * 1000) / 1000
      if (!(price >= 0.001 && price <= 100)) throw new Error("Price must be 0.001 to 100 SOL")
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.w ?? "")) throw new Error("A wallet address is needed for SOL listings")
    } else {
      price = Math.floor(a.price)
      if (!(price >= 1 && price <= 9999)) throw new Error("Price must be 1 to 9999")
    }
    const loc = (a.loc ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()
    const open = await ctx.db
      .query("listings")
      .withIndex("by_seller", (q) => q.eq("seller", a.seller))
      .filter((q) => q.eq(q.field("status"), "open"))
      .take(10)
    if (open.length >= 5) throw new Error("Too many open listings")
    return await ctx.db.insert("listings", {
      seller: a.seller,
      sn: a.sn.slice(0, 16),
      item: a.item,
      price,
      t: Date.now(),
      status: "open",
      claimed: false,
      cur,
      w: cur === "sol" ? a.w : "",
      loc,
      a: asset,
    })
  },
})

// Gold sale. Atomic: only one buyer can win a listing.
export const buy = mutation({
  args: { id: v.id("listings"), buyer: v.string(), kh: v.optional(v.string()), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "market:buy", "buyer")
    const l = await ctx.db.get(a.id)
    if (!l || l.status !== "open") return { ok: false, e: "gone" }
    if ((l.cur ?? "gold") !== "gold") return { ok: false, e: "currency" }
    if (l.seller === a.buyer) return { ok: false, e: "own" }
    await ctx.db.patch(a.id, { status: "sold", buyer: a.buyer })
    return { ok: true, e: "" }
  },
})

export const cancel = mutation({
  args: { id: v.id("listings"), seller: v.string(), kh: v.optional(v.string()), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "market:cancel", "seller")
    const l = await ctx.db.get(a.id)
    if (!l || l.status !== "open" || l.seller !== a.seller) return { ok: false }
    await ctx.db.patch(a.id, { status: "cancelled" })
    return { ok: true }
  },
})

// Gold sales whose gold the seller has not collected yet.
export const sales = query({
  args: { seller: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("listings")
      .withIndex("by_seller", (q) => q.eq("seller", a.seller))
      .filter((q) => q.and(q.eq(q.field("status"), "sold"), q.eq(q.field("claimed"), false)))
      .take(20)
    return rows.map((l) => ({ id: l._id, item: l.item, price: l.price }))
  },
})

export const claim = mutation({
  args: { id: v.id("listings"), seller: v.string(), kh: v.optional(v.string()), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "market:claim", "seller")
    const l = await ctx.db.get(a.id)
    if (!l || l.status !== "sold" || l.seller !== a.seller || l.claimed) return { ok: false, price: 0 }
    await ctx.db.patch(a.id, { claimed: true })
    return { ok: true, price: l.price }
  },
})

export const getOne = internalQuery({
  args: { id: v.id("listings") },
  handler: async (ctx, a) => await ctx.db.get(a.id),
})

export const finishSol = internalMutation({
  args: { id: v.id("listings"), buyer: v.string(), sig: v.string(), bw: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.id)
    if (!l || l.status !== "open") return { ok: false, e: "gone" }
    const used = await ctx.db.query("listings").withIndex("by_sig", (q) => q.eq("sig", a.sig)).first()
    if (used) return { ok: false, e: "used" }
    await ctx.db.patch(a.id, { status: "sold", buyer: a.buyer, sig: a.sig, claimed: true, bw: a.bw })
    return { ok: true, e: "" }
  },
})

// SOL sale. The buyer pays the seller from their own wallet; we check the payment on-chain
// before handing over the item. Defaults to devnet (test money). Set SOL_RPC to change network.
export const buySol = action({
  args: { id: v.id("listings"), buyer: v.string(), buyerWallet: v.string(), sig: v.string(), kh: v.optional(v.string()), ...SIG },
  handler: async (ctx, a): Promise<{ ok: boolean; e: string }> => {
    await ctx.runQuery(internal.auth.check, { kh: a.kh, asig: a.asig, pk: a.pk, ts: a.ts, fn: "market:buySol", aidField: "buyer", aid: a.buyer })
    const l = await ctx.runQuery(internal.market.getOne, { id: a.id })
    if (!l || l.status !== "open" || l.cur !== "sol" || !l.w) return { ok: false, e: "gone" }
    if (l.seller === a.buyer) return { ok: false, e: "own" }
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(a.sig)) return { ok: false, e: "tx" }
    const lamports = Math.round(l.price * 1e9)
    const rpc = process.env.SOL_RPC ?? "https://api.devnet.solana.com"
    let tx: any = null
    for (let i = 0; i < 5 && !tx; i++) {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [a.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }],
        }),
      })
      tx = (await r.json()).result
      if (!tx) await new Promise((res) => setTimeout(res, 1500))
    }
    if (!tx || tx.meta?.err) return { ok: false, e: "tx" }
    const keys: string[] = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ]
    const bi = keys.indexOf(a.buyerWallet)
    const si = keys.indexOf(l.w)
    if (bi < 0 || si < 0 || bi >= tx.transaction.message.header.numRequiredSignatures) return { ok: false, e: "tx" }
    // Creator royalty: NFT-backed sales send a small share (default 0.5%) to the creator wallet.
    const rw = process.env.ROYALTY_WALLET ?? ""
    const bps = Math.max(0, Math.min(1000, Math.round(Number(process.env.ROYALTY_BPS ?? 50)) || 0))
    const roy = l.a && rw && rw !== l.w ? Math.floor((lamports * bps) / 10000) : 0
    if (tx.meta.postBalances[si] - tx.meta.preBalances[si] < lamports - roy) return { ok: false, e: "amount" }
    if (tx.meta.preBalances[bi] - tx.meta.postBalances[bi] < lamports) return { ok: false, e: "amount" }
    if (roy > 0) {
      const ri = keys.indexOf(rw)
      if (ri < 0 || tx.meta.postBalances[ri] - tx.meta.preBalances[ri] < roy) return { ok: false, e: "royalty" }
    }
    if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 900) return { ok: false, e: "old" }
    return await ctx.runMutation(internal.market.finishSol, { id: a.id, buyer: a.buyer, sig: a.sig, bw: a.buyerWallet })
  },
})

// Sold NFT-backed items the seller still has to send to the buyer's wallet.
export const toDeliver = query({
  args: { seller: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("listings")
      .withIndex("by_seller", (q) => q.eq("seller", a.seller))
      .filter((q) => q.eq(q.field("status"), "sold"))
      .take(30)
    return rows
      .filter((l) => l.a && l.bw && !l.dv)
      .map((l) => ({ id: l._id, item: l.item, a: l.a ?? "", bw: l.bw ?? "", w: l.w ?? "" }))
  },
})

export const delivered = mutation({
  args: { id: v.id("listings"), seller: v.string() },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.id)
    if (!l || l.status !== "sold" || l.seller !== a.seller) return { ok: false }
    await ctx.db.patch(a.id, { dv: true })
    return { ok: true }
  },
})
