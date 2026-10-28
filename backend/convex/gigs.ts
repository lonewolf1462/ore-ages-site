import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import { SIG, requireSig } from "./auth"

// The work board. A station owner hires help for ONE batch at a fixed wage in gold; another player takes the job, goes to the
// station and works. The owner's game applies the worker's time to the batch; when the batch is finished the wage is owed to the
// worker, who collects it. The wage is taken from the owner when the job is posted, so it is always there to be paid.
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("")
}
const KH = /^[a-f0-9]{64}$/
const STATIONS = ["Kiln", "Smelter", "Foundry", "Factory", "Carpentry"]
const MAX_OWN = 3
const MIN_WORK = 5 // seconds a worker must have put in to be paid; otherwise the wage goes back to the owner
const STRONG = ["fuck", "shit", "bitch", "cunt", "nigg", "fagg", "whore", "slut"]
const clean = (s: string) => {
  const n = s.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 16)
  const flat = n.toLowerCase().replace(/[^a-z]/g, "")
  return !n || STRONG.some((w) => flat.includes(w)) ? "Player" : n
}
const int = (x: number, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi

async function account(ctx: any, kh: string) {
  const lid = await sha("lid:" + kh)
  return await ctx.db.query("accounts").withIndex("by_lid", (q: any) => q.eq("lid", lid)).first()
}
const pub = (g: any) => ({ id: g._id, sn: g.sn, st: g.st, recipe: g.recipe, wage: g.wage, slot: g.slot, cx: g.cx, cz: g.cz })

// Open jobs, newest first.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("gigs").withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(40)
    return rows.map(pub)
  },
})

export const post = mutation({
  args: { kh: v.string(), slot: v.number(), sn: v.string(), st: v.string(), cx: v.number(), cz: v.number(), recipe: v.string(), wage: v.number(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh) || !STATIONS.includes(a.st) || !int(a.slot, 0, 79) || !int(a.cx, 0, 40) || !int(a.cz, 0, 40)) return { ok: false, e: "bad", id: "" }
    if (!int(a.wage, 1, 500)) return { ok: false, e: "wage", id: "" }
    await requireSig(ctx.db, a, "gigs:post")
    if (!(await account(ctx, a.kh))) return { ok: false, e: "account", id: "" }
    const o = await sha("gig:" + a.kh)
    const mine = await ctx.db.query("gigs").withIndex("by_owner", (q) => q.eq("owner", o)).filter((q) => q.or(q.eq(q.field("status"), "open"), q.eq(q.field("status"), "taken"))).take(10)
    if (mine.length >= MAX_OWN) return { ok: false, e: "many", id: "" }
    const id = await ctx.db.insert("gigs", { owner: o, sn: clean(a.sn), slot: a.slot, st: a.st, cx: a.cx, cz: a.cz, recipe: a.recipe.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 30), wage: a.wage, status: "open", tw: 0, lw: 0, t: Date.now(), claimed: false })
    return { ok: true, e: "", id }
  },
})

// A worker takes an open job (one at a time).
export const take = mutation({
  args: { kh: v.string(), id: v.id("gigs"), wn: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh) || !(await account(ctx, a.kh))) return { ok: false, e: "account" }
    await requireSig(ctx.db, a, "gigs:take")
    const w = await sha("gig:" + a.kh)
    const g: any = await ctx.db.get(a.id)
    if (!g || g.status !== "open") return { ok: false, e: "gone" }
    if (g.owner === w) return { ok: false, e: "own" }
    const busy = await ctx.db.query("gigs").withIndex("by_worker", (q) => q.eq("wkr", w)).filter((q) => q.eq(q.field("status"), "taken")).first()
    if (busy) return { ok: false, e: "busy" }
    await ctx.db.patch(a.id, { status: "taken", wkr: w, wn: clean(a.wn), tw: 0, lw: Date.now() })
    return { ok: true, e: "" }
  },
})

// The worker gives the job up, and it goes back on the board.
export const quit = mutation({
  args: { kh: v.string(), id: v.id("gigs"), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false }
    await requireSig(ctx.db, a, "gigs:quit")
    const w = await sha("gig:" + a.kh)
    const g: any = await ctx.db.get(a.id)
    if (!g || g.status !== "taken" || g.wkr !== w) return { ok: false }
    await ctx.db.patch(a.id, { status: "open", wkr: undefined, wn: undefined, tw: 0 })
    return { ok: true }
  },
})

// Seconds worked, reported by the worker's game. A worker cannot report more time than has really passed.
export const work = mutation({
  args: { kh: v.string(), id: v.id("gigs"), sec: v.number(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, tw: 0 }
    await requireSig(ctx.db, a, "gigs:work")
    const w = await sha("gig:" + a.kh)
    const g: any = await ctx.db.get(a.id)
    if (!g || g.status !== "taken" || g.wkr !== w) return { ok: false, tw: 0 }
    const now = Date.now()
    const real = Math.floor(((now - g.lw) / 1000) * 1.5) + 1
    const add = Math.max(0, Math.min(Math.floor(a.sec), 30, real))
    await ctx.db.patch(a.id, { tw: g.tw + add, lw: now })
    return { ok: true, tw: g.tw + add }
  },
})

// What this player has on the board: jobs they posted, the job they took, and wages waiting for them.
export const mine = query({
  args: { kh: v.string() },
  handler: async (ctx, a) => {
    const none = { own: [] as any[], work: null as any, owed: 0 }
    if (!KH.test(a.kh)) return none
    const o = await sha("gig:" + a.kh)
    const own = await ctx.db.query("gigs").withIndex("by_owner", (q) => q.eq("owner", o)).order("desc").take(12)
    const taken = await ctx.db.query("gigs").withIndex("by_worker", (q) => q.eq("wkr", o)).order("desc").take(12)
    const cur = taken.find((g: any) => g.status === "taken")
    const owed = taken.filter((g: any) => g.status === "done" && !g.claimed).reduce((s: number, g: any) => s + g.wage, 0)
    return {
      own: own.filter((g: any) => g.status === "open" || g.status === "taken").map((g: any) => ({ id: g._id, status: g.status, tw: g.tw, wn: g.wn ?? "", wage: g.wage, recipe: g.recipe, st: g.st })),
      work: cur ? { ...pub(cur), tw: cur.tw } : null,
      owed,
    }
  },
})

// The owner's batch is finished. A worker earns the wage; a job nobody took is cancelled and the wage goes back to the owner.
export const finish = mutation({
  args: { kh: v.string(), id: v.id("gigs"), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, refund: 0 }
    await requireSig(ctx.db, a, "gigs:finish")
    const o = await sha("gig:" + a.kh)
    const g: any = await ctx.db.get(a.id)
    if (!g || g.owner !== o) return { ok: false, refund: 0 }
    if (g.status === "taken") {
      if ((g.tw ?? 0) < MIN_WORK) {
        await ctx.db.patch(a.id, { status: "cancelled" })
        return { ok: true, refund: g.wage }
      }
      await ctx.db.patch(a.id, { status: "done" })
      return { ok: true, refund: 0 }
    }
    if (g.status === "open") {
      await ctx.db.patch(a.id, { status: "cancelled" })
      return { ok: true, refund: g.wage }
    }
    return { ok: false, refund: 0 }
  },
})

// The owner takes back a job nobody has taken.
export const cancel = mutation({
  args: { kh: v.string(), id: v.id("gigs"), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, refund: 0 }
    await requireSig(ctx.db, a, "gigs:cancel")
    const o = await sha("gig:" + a.kh)
    const g: any = await ctx.db.get(a.id)
    if (!g || g.owner !== o || g.status !== "open") return { ok: false, refund: 0 }
    await ctx.db.patch(a.id, { status: "cancelled" })
    return { ok: true, refund: g.wage }
  },
})

// The worker collects the wages for finished batches.
export const claim = mutation({
  args: { kh: v.string(), ...SIG },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, gold: 0, n: 0 }
    await requireSig(ctx.db, a, "gigs:claim")
    const w = await sha("gig:" + a.kh)
    const rows = await ctx.db.query("gigs").withIndex("by_worker", (q) => q.eq("wkr", w)).filter((q) => q.and(q.eq(q.field("status"), "done"), q.eq(q.field("claimed"), false))).take(30)
    let gold = 0
    for (const g of rows) {
      await ctx.db.patch(g._id, { claimed: true })
      gold += g.wage
    }
    return { ok: true, gold, n: rows.length }
  },
})
