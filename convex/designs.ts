import { mutation, query } from "./_generated/server"
import { SIG, requireSig } from "./auth"
import { v } from "convex/values"

// Saved builds ("blueprints"). A design is stored under the hash of its content (the first 32 hex characters of its SHA-256).
// The blueprint NFT carries that same hash in its on-chain attributes, so the game can check that the design it downloads
// is exactly the one that was registered: nobody, including this server, can swap it afterwards.
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const KH = /^[a-f0-9]{64}$/
const H = /^[a-f0-9]{32}$/
const MAX_PIECES = 1500
const MAX_DATA = 120_000

// Only signed-in players can store a design (so the table cannot be filled anonymously), and only well-formed ones:
// whole numbers that fit in a 24 x 12 x 36 lot.
export const put = mutation({
  args: { kh: v.string(), h: v.string(), data: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "designs:put")
    if (!KH.test(a.kh) || !H.test(a.h) || a.data.length > MAX_DATA) return { ok: false, e: "bad" }
    const lid = await sha("lid:" + a.kh)
    const acc = await ctx.db.query("accounts").withIndex("by_lid", (q) => q.eq("lid", lid)).first()
    if (!acc) return { ok: false, e: "account" }
    if ((await sha(a.data)).slice(0, 32) !== a.h) return { ok: false, e: "hash" }
    let d: any
    try {
      d = JSON.parse(a.data)
    } catch {
      return { ok: false, e: "json" }
    }
    if (!d || typeof d.n !== "string" || !Array.isArray(d.p) || d.p.length < 1 || d.p.length > MAX_PIECES) return { ok: false, e: "shape" }
    for (const r of d.p) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((x: any) => Number.isInteger(x))) return { ok: false, e: "shape" }
      if (r[0] < 0 || r[0] >= 24 || r[1] < 0 || r[1] >= 12 || r[2] < 0 || r[2] >= 36 || r[3] < 0) return { ok: false, e: "shape" }
    }
    const have = await ctx.db.query("designs").withIndex("by_h", (q) => q.eq("h", a.h)).first()
    if (have) return { ok: true, e: "" }
    await ctx.db.insert("designs", { h: a.h, n: d.n.slice(0, 24), pieces: d.p.length, data: a.data, t: Date.now() })
    return { ok: true, e: "" }
  },
})

export const get = query({
  args: { h: v.string() },
  handler: async (ctx, a) => {
    if (!H.test(a.h)) return { ok: false, data: "" }
    const d = await ctx.db.query("designs").withIndex("by_h", (q) => q.eq("h", a.h)).first()
    return d ? { ok: true, data: d.data } : { ok: false, data: "" }
  },
})
