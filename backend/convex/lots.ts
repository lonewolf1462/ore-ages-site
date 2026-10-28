import { mutation, query } from "./_generated/server"
import { SIG, requireSig } from "./auth"
import { v } from "convex/values"

// The shared neighbourhood. Every account claims one numbered lot; other players can see the lot's owner and
// a snapshot of what is built on it. A lot is owned by the account that claimed it (proved with the account key).
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const KH = /^[a-f0-9]{64}$/
const NSLOT = 80
const MAX_SNAP = 60_000
const STRONG = ["fuck", "shit", "bitch", "cunt", "nigg", "fagg", "whore", "slut"]
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" }

function cleanName(s: string): string {
  const n = s
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c])
    .replace(/[^a-z]/g, "")
  const name = s.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 16)
  return STRONG.some((w) => n.includes(w)) || !name ? "Player" : name
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("lots").take(100)
    return rows.map((l) => ({ slot: l.slot, name: l.name, ver: l.ver }))
  },
})

export const get = query({
  args: { slot: v.number() },
  handler: async (ctx, a) => {
    const l = await ctx.db.query("lots").withIndex("by_slot", (q) => q.eq("slot", a.slot)).first()
    return l ? { slot: l.slot, name: l.name, snap: l.snap, ver: l.ver } : { slot: a.slot, name: "", snap: "", ver: 0 }
  },
})

// Gives this account its lot (the same one every time), or the lowest free number the first time.
export const claim = mutation({
  args: { kh: v.string(), name: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "lots:claim")
    if (!KH.test(a.kh)) return { ok: false, slot: -1 }
    const owner = await sha("lot:" + a.kh)
    const name = cleanName(a.name)
    const mine = await ctx.db.query("lots").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    if (mine) {
      if (mine.name !== name) await ctx.db.patch(mine._id, { name })
      return { ok: true, slot: mine.slot }
    }
    const all = await ctx.db.query("lots").take(100)
    const used = new Set(all.map((l) => l.slot))
    let s = 0
    while (used.has(s) && s < NSLOT) s++
    if (s >= NSLOT) return { ok: false, slot: -1 }
    await ctx.db.insert("lots", { slot: s, owner, name, snap: "", ver: 0, t: Date.now() })
    return { ok: true, slot: s }
  },
})

// Share what is built on the lot so neighbours can see it.
export const publish = mutation({
  args: { kh: v.string(), snap: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "lots:publish")
    if (!KH.test(a.kh) || a.snap.length > MAX_SNAP) return { ok: false, ver: 0 }
    const owner = await sha("lot:" + a.kh)
    const l = await ctx.db.query("lots").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    if (!l) return { ok: false, ver: 0 }
    await ctx.db.patch(l._id, { snap: a.snap, ver: l.ver + 1, t: Date.now() })
    return { ok: true, ver: l.ver + 1 }
  },
})

export const release = mutation({
  args: { kh: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "lots:release")
    if (!KH.test(a.kh)) return { ok: false }
    const owner = await sha("lot:" + a.kh)
    const l = await ctx.db.query("lots").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    if (l) await ctx.db.delete(l._id)
    return { ok: true }
  },
})

// Move this account's lot to a free one (for example a plot in the mountains). Everything built goes with the player.
export const move = mutation({
  args: { kh: v.string(), slot: v.number(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "lots:move")
    if (!KH.test(a.kh) || !Number.isInteger(a.slot) || a.slot < 0 || a.slot >= NSLOT) return { ok: false, e: "bad" }
    const owner = await sha("lot:" + a.kh)
    const mine = await ctx.db.query("lots").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    if (!mine) return { ok: false, e: "none" }
    if (mine.slot === a.slot) return { ok: true, e: "" }
    const taken = await ctx.db.query("lots").withIndex("by_slot", (q) => q.eq("slot", a.slot)).first()
    if (taken) return { ok: false, e: "taken" }
    await ctx.db.patch(mine._id, { slot: a.slot, ver: mine.ver + 1, t: Date.now() })
    return { ok: true, e: "" }
  },
})
