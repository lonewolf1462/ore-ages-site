import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

const LIVE_MS = 10_000

// A player reports where they are, what they last said and (for house owners) how the house is furnished.
export const upsert = mutation({
  args: {
    pid: v.string(),
    n: v.string(),
    c: v.number(),
    x: v.number(),
    y: v.number(),
    h: v.number(),
    inMine: v.boolean(),
    r: v.optional(v.string()),
    k: v.optional(v.string()),
    o: v.optional(v.number()),
    m: v.optional(v.string()),
    u: v.optional(v.string()),
    f: v.optional(v.string()),
    cm: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    if (a.pid.length > 24 || !/^[a-z0-9]+$/.test(a.pid)) return
    const now = Date.now()
    const row = {
      pid: a.pid,
      n: a.n.slice(0, 16),
      c: Math.abs(Math.round(a.c)) % 360,
      x: Math.round(a.x),
      y: Math.round(a.y),
      h: Math.round(a.h),
      inMine: a.inMine,
      t: now,
      r: (a.r ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase(),
      k: (a.k ?? "").slice(0, 16),
      o: a.o === 1 ? 1 : 0,
      m: (a.m ?? "").slice(0, 600),
      u: (a.u ?? "").replace(/[^a-z0-9]/g, "").slice(0, 24),
      f: (a.f ?? "").replace(/[^a-z0-9,;]/g, "").slice(0, 300),
      cm: (a.cm ?? "").replace(/[^a-z0-9]/g, "").slice(0, 40),
    }
    const existing = await ctx.db
      .query("miners")
      .withIndex("by_pid", (q) => q.eq("pid", a.pid))
      .first()
    if (existing) await ctx.db.patch(existing._id, row)
    else await ctx.db.insert("miners", row)

    // Tidy up rows nobody has touched for an hour.
    const stale = await ctx.db
      .query("miners")
      .withIndex("by_t", (q) => q.lt("t", now - 3_600_000))
      .take(5)
    for (const s of stale) await ctx.db.delete(s._id)
  },
})

// Everyone who has reported in the last few seconds.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("miners")
      .withIndex("by_t", (q) => q.gt("t", Date.now() - LIVE_MS))
      .take(200)
    return rows.map((r) => ({
      pid: r.pid,
      n: r.n,
      c: r.c,
      x: r.x,
      y: r.y,
      h: r.h,
      inMine: r.inMine,
      r: r.r ?? "",
      k: r.k ?? "",
      o: r.o ?? 0,
      m: r.m ?? "",
      u: r.u ?? "",
      f: r.f ?? "",
      cm: r.cm ?? "",
    }))
  },
})
