import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server"
import { SIG, requireSig } from "./auth"
import { internal } from "./_generated/api"
import { v } from "convex/values"

// Player communities. A community has one admin (the founder), a board, up to 50 members with plots, a share of
// members' mining that flows into a community pool, and structures bought from that pool that give every member a benefit.
// Founding costs $15 (paid in SOL at the rate in SOL_USD; devnet test money until the network is switched).
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const KH = /^[a-f0-9]{64}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,22}[A-Za-z0-9]$/
const DISCORD = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/
const TELEGRAM = /^https:\/\/t\.me\/(\+|joinchat\/)?[A-Za-z0-9_-]{3,64}$/
const STRONG = ["fuck", "shit", "bitch", "cunt", "nigg", "fagg", "whore", "slut"]
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" }
const REGS = ["green", "valley", "uplands", "desert", "canyon", "mountains"]
const FEE_USD = 15
const CAP = 50
const MAX_BOARD = 6

function bad(s: string): boolean {
  const n = s
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c])
    .replace(/[^a-z]/g, "")
  return STRONG.some((w) => n.includes(w))
}
const cleanName = (s: string) => {
  const n = s.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 16)
  return !n || bad(n) ? "Player" : n
}
function checkLinks(discord: string, telegram: string): string | null {
  if (discord && !DISCORD.test(discord)) return "discord"
  if (telegram && !TELEGRAM.test(telegram)) return "telegram"
  return null
}
const parse = (s?: string): any => {
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

// What a structure costs per level, and what it gives every member (applied in the game).
const STRUCT: Record<string, { max: number; cost: Record<string, number>[] }> = {
  hall: { max: 3, cost: [{ planks: 40, block: 30 }, { brick: 60, planks: 60, ingot: 20 }, { steel: 40, concrete: 60, glass: 30 }] },
  workshop: { max: 3, cost: [{ planks: 30, block: 20 }, { brick: 40, ingot: 30 }, { steel: 50, concrete: 50, chip: 10 }] },
  farm: { max: 3, cost: [{ planks: 30, sticks: 40 }, { brick: 30, planks: 60 }, { glass: 40, steel: 20, plastic: 30 }] },
  mine: { max: 3, cost: [{ block: 40, planks: 30 }, { ingot: 30, brick: 40 }, { steel: 60, sheet: 30, concrete: 40 }] },
  roads: { max: 3, cost: [{ block: 40, sand: 40 }, { brick: 60, mortar: 40 }, { concrete: 80, steel: 30 }] },
  plaza: { max: 3, cost: [{ block: 30, tile: 30 }, { brick: 50, glass: 20 }, { concrete: 60, glass: 40, steel: 20 }] },
}

const pub = (c: any) => ({
  id: c._id,
  name: c.name,
  desc: c.desc,
  discord: c.discord,
  telegram: c.telegram,
  on: c.on,
  reg: c.reg ?? "green",
  pct: c.pct ?? 5,
  members: (c.mem ?? []).length,
  lvl: Object.values(parse(c.st)).reduce((a: number, b: any) => a + Number(b || 0), 0),
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("communities").withIndex("by_t").order("desc").take(60)
    return rows.map(pub)
  },
})

export const mine = query({
  args: { kh: v.string() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return null
    const owner = await sha("own:" + a.kh)
    const c = await ctx.db.query("communities").withIndex("by_owner", (q) => q.eq("owner", owner)).first()
    return c ? { id: c._id, name: c.name, desc: c.desc, discord: c.discord, telegram: c.telegram, pct: c.pct ?? 5 } : null
  },
})

// Everything a member needs to see about a community.
export const get = query({
  args: { id: v.id("communities") },
  handler: async (ctx, a) => {
    const c: any = await ctx.db.get(a.id)
    if (!c) return null
    const board: string[] = c.board ?? []
    const prop = c.prop ? parse(c.prop) : null
    const voters = new Set<string>([c.adm ?? "", ...board])
    return {
      ...pub(c),
      cap: CAP,
      pool: parse(c.pool),
      st: parse(c.st),
      mem: (c.mem ?? []).map((m: any) => ({ n: m.n, b: board.includes(m.l), a: m.l === c.adm })),
      prop: prop ? { sid: prop.sid, votes: (prop.v ?? []).length, need: Math.floor(voters.size / 2) + 1, t: prop.t } : null,
      ann: [...(c.ann ?? [])].reverse().slice(0, 20),
    }
  },
})

// The caller's role in a community.
export const role = query({
  args: { kh: v.string(), id: v.id("communities") },
  handler: async (ctx, a) => {
    const none = { m: false, a: false, b: false, v: false }
    if (!KH.test(a.kh)) return none
    const c: any = await ctx.db.get(a.id)
    if (!c) return none
    const l = await sha("mem:" + a.kh)
    const prop = c.prop ? parse(c.prop) : null
    return {
      m: (c.mem ?? []).some((m: any) => m.l === l),
      a: c.owner === (await sha("own:" + a.kh)),
      b: (c.board ?? []).includes(l) || c.adm === l,
      v: !!(prop && (prop.v ?? []).includes(l)),
    }
  },
})

export const quote = query({
  args: {},
  handler: async () => {
    const solUsd = Math.max(1, Number(process.env.SOL_USD ?? 150) || 150)
    return { usd: FEE_USD, solUsd, lamports: Math.ceil((FEE_USD / solUsd) * 1e9), wallet: process.env.ROYALTY_WALLET ?? "", cap: CAP }
  },
})

// Checks a new community before anyone pays for it.
export const check = query({
  args: { kh: v.string(), name: v.string(), desc: v.string(), discord: v.string(), telegram: v.string() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const name = a.name.trim()
    if (!NAME.test(name)) return { ok: false, e: "name" }
    if (bad(name) || bad(a.desc)) return { ok: false, e: "words" }
    const lk = checkLinks(a.discord, a.telegram)
    if (lk) return { ok: false, e: lk }
    const owner = await sha("own:" + a.kh)
    if (await ctx.db.query("communities").withIndex("by_owner", (q) => q.eq("owner", owner)).first()) return { ok: false, e: "owner" }
    if (await ctx.db.query("communities").withIndex("by_nl", (q) => q.eq("nl", name.toLowerCase())).first()) return { ok: false, e: "taken" }
    return { ok: true, e: "" }
  },
})

export const feeUsed = internalQuery({
  args: { sig: v.string() },
  handler: async (ctx, a) => !!(await ctx.db.query("communities").withIndex("by_fee", (q) => q.eq("fee", a.sig)).first()),
})

export const insertPaid = internalMutation({
  args: {
    kh: v.string(),
    name: v.string(),
    desc: v.string(),
    discord: v.string(),
    telegram: v.string(),
    oname: v.string(),
    reg: v.string(),
    sig: v.string(),
  },
  handler: async (ctx, a) => {
    const name = a.name.trim()
    const owner = await sha("own:" + a.kh)
    const l = await sha("mem:" + a.kh)
    if (await ctx.db.query("communities").withIndex("by_owner", (q) => q.eq("owner", owner)).first()) return { ok: false, e: "owner", id: "" }
    if (await ctx.db.query("communities").withIndex("by_nl", (q) => q.eq("nl", name.toLowerCase())).first()) return { ok: false, e: "taken", id: "" }
    if (await ctx.db.query("communities").withIndex("by_fee", (q) => q.eq("fee", a.sig)).first()) return { ok: false, e: "used", id: "" }
    const id = await ctx.db.insert("communities", {
      owner,
      name,
      nl: name.toLowerCase(),
      desc: a.desc.trim().slice(0, 80),
      discord: a.discord,
      telegram: a.telegram,
      on: cleanName(a.oname),
      t: Date.now(),
      pct: 5,
      adm: l,
      mem: [{ l, n: cleanName(a.oname) }],
      board: [],
      pool: "{}",
      st: "{}",
      prop: "",
      reg: REGS.includes(a.reg) ? a.reg : "green",
      fee: a.sig,
    })
    return { ok: true, e: "", id }
  },
})

// Founding fee: the founder pays about $15 in SOL to the platform wallet; the payment is verified on-chain.
export const found = action({
  args: {
    kh: v.string(),
    name: v.string(),
    desc: v.string(),
    discord: v.string(),
    telegram: v.string(),
    oname: v.string(),
    reg: v.string(),
    sig: v.string(),
    wallet: v.string(),
    ...SIG,
  },
  handler: async (ctx, a): Promise<{ ok: boolean; e: string; id: string }> => {
    await ctx.runQuery(internal.auth.check, { kh: a.kh, asig: a.asig, pk: a.pk, ts: a.ts, fn: "communities:found" })
    const to = process.env.ROYALTY_WALLET ?? ""
    if (!to) return { ok: false, e: "nofee", id: "" }
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(a.sig)) return { ok: false, e: "tx", id: "" }
    if (await ctx.runQuery(internal.communities.feeUsed, { sig: a.sig })) return { ok: false, e: "used", id: "" }
    const solUsd = Math.max(1, Number(process.env.SOL_USD ?? 150) || 150)
    const lamports = Math.ceil((FEE_USD / solUsd) * 1e9)
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
    if (!tx || tx.meta?.err) return { ok: false, e: "tx", id: "" }
    const keys: string[] = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ]
    const pi = keys.indexOf(a.wallet)
    const ti = keys.indexOf(to)
    if (pi < 0 || ti < 0 || pi >= tx.transaction.message.header.numRequiredSignatures) return { ok: false, e: "tx", id: "" }
    if (tx.meta.postBalances[ti] - tx.meta.preBalances[ti] < lamports) return { ok: false, e: "amount", id: "" }
    if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 900) return { ok: false, e: "old", id: "" }
    return await ctx.runMutation(internal.communities.insertPaid, {
      kh: a.kh,
      name: a.name,
      desc: a.desc,
      discord: a.discord,
      telegram: a.telegram,
      oname: a.oname,
      reg: a.reg,
      sig: a.sig,
    })
  },
})

// Kept for testing only; real communities are founded with found() and the fee.
// Set FREE_COMMUNITIES=1 in the deployment settings to let the current game create communities without the fee.
export const create = mutation({
  args: { kh: v.string(), name: v.string(), desc: v.string(), discord: v.string(), telegram: v.string(), oname: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:create")
    if (process.env.FREE_COMMUNITIES !== "1") return { ok: false, e: "fee", id: "" }
    if (!KH.test(a.kh)) return { ok: false, e: "bad", id: "" }
    const name = a.name.trim()
    if (!NAME.test(name)) return { ok: false, e: "name", id: "" }
    const owner = await sha("own:" + a.kh)
    const l = await sha("mem:" + a.kh)
    if (await ctx.db.query("communities").withIndex("by_nl", (q) => q.eq("nl", name.toLowerCase())).first()) return { ok: false, e: "taken", id: "" }
    const id = await ctx.db.insert("communities", {
      owner, name, nl: name.toLowerCase(), desc: a.desc.slice(0, 80), discord: a.discord, telegram: a.telegram,
      on: cleanName(a.oname), t: Date.now(), pct: 5, adm: l, mem: [{ l, n: cleanName(a.oname) }], board: [], pool: "{}", st: "{}", prop: "", reg: "green",
    })
    return { ok: true, e: "", id }
  },
})

export const join = mutation({
  args: { kh: v.string(), id: v.id("communities"), name: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:join")
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: false, e: "gone" }
    const l = await sha("mem:" + a.kh)
    const mem: { l: string; n: string }[] = c.mem ?? []
    if (mem.some((m) => m.l === l)) return { ok: true, e: "" }
    if (mem.length >= CAP) return { ok: false, e: "full" }
    await ctx.db.patch(a.id, { mem: [...mem, { l, n: cleanName(a.name) }] })
    return { ok: true, e: "" }
  },
})

export const leave = mutation({
  args: { kh: v.string(), id: v.id("communities"), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:leave")
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: true, e: "" }
    const l = await sha("mem:" + a.kh)
    if (c.adm === l) return { ok: false, e: "admin" }
    await ctx.db.patch(a.id, {
      mem: (c.mem ?? []).filter((m: any) => m.l !== l),
      board: (c.board ?? []).filter((b: string) => b !== l),
    })
    return { ok: true, e: "" }
  },
})

// Admin: how much of members' mining goes to the pool, plus the community's description and channels.
export const setPolicy = mutation({
  args: { kh: v.string(), id: v.id("communities"), pct: v.number(), desc: v.string(), discord: v.string(), telegram: v.string() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false, e: "owner" }
    const desc = a.desc.trim().slice(0, 80)
    if (bad(desc)) return { ok: false, e: "words" }
    const lk = checkLinks(a.discord, a.telegram)
    if (lk) return { ok: false, e: lk }
    await ctx.db.patch(a.id, { pct: Math.max(0, Math.min(20, Math.round(a.pct))), desc, discord: a.discord, telegram: a.telegram })
    return { ok: true, e: "" }
  },
})

export const update = mutation({
  args: { kh: v.string(), id: v.id("communities"), desc: v.string(), discord: v.string(), telegram: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:update")
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false, e: "owner" }
    const desc = a.desc.trim().slice(0, 80)
    if (bad(desc)) return { ok: false, e: "words" }
    const lk = checkLinks(a.discord, a.telegram)
    if (lk) return { ok: false, e: lk }
    await ctx.db.patch(a.id, { desc, discord: a.discord, telegram: a.telegram })
    return { ok: true, e: "" }
  },
})

// Admin: put a member on or off the board.
export const setBoard = mutation({
  args: { kh: v.string(), id: v.id("communities"), name: v.string(), on: v.boolean() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false, e: "owner" }
    const m = (c.mem ?? []).find((x: any) => x.n.toLowerCase() === a.name.trim().toLowerCase())
    if (!m || m.l === c.adm) return { ok: false, e: "member" }
    let board: string[] = (c.board ?? []).filter((b: string) => b !== m.l)
    if (a.on) {
      if (board.length >= MAX_BOARD) return { ok: false, e: "full" }
      board = [...board, m.l]
    }
    await ctx.db.patch(a.id, { board })
    return { ok: true, e: "" }
  },
})

// Members add part of what they mine to the pool.
export const contribute = mutation({
  args: { kh: v.string(), id: v.id("communities"), res: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:contribute")
    if (!KH.test(a.kh)) return { ok: false }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: false }
    const l = await sha("mem:" + a.kh)
    if (!(c.mem ?? []).some((m: any) => m.l === l)) return { ok: false }
    const add = parse(a.res)
    const pool = parse(c.pool)
    for (const k of Object.keys(add)) {
      if (!/^[a-z]{3,12}$/.test(k)) continue
      const n = Math.max(0, Math.min(20, Math.floor(Number(add[k]) || 0)))
      pool[k] = Math.min(1_000_000, (pool[k] ?? 0) + n)
    }
    await ctx.db.patch(a.id, { pool: JSON.stringify(pool) })
    return { ok: true }
  },
})

// Spending the pool is decided by the admin and the board: a proposal needs a majority of them to approve.
async function tryExec(ctx: any, c: any, prop: any): Promise<{ done: boolean; e: string }> {
  const voters = new Set<string>([c.adm ?? "", ...(c.board ?? [])])
  const need = Math.floor(voters.size / 2) + 1
  if ((prop.v ?? []).filter((x: string) => voters.has(x)).length < need) {
    await ctx.db.patch(c._id, { prop: JSON.stringify(prop) })
    return { done: false, e: "" }
  }
  const st = parse(c.st)
  const lvl = Number(st[prop.sid] ?? 0)
  const def = STRUCT[prop.sid]
  const cost = def?.cost[lvl]
  const pool = parse(c.pool)
  if (!def || !cost) {
    await ctx.db.patch(c._id, { prop: "" })
    return { done: false, e: "max" }
  }
  for (const k of Object.keys(cost)) {
    if ((pool[k] ?? 0) < cost[k]) {
      await ctx.db.patch(c._id, { prop: "" })
      return { done: false, e: "pool" }
    }
  }
  for (const k of Object.keys(cost)) pool[k] -= cost[k]
  st[prop.sid] = lvl + 1
  await ctx.db.patch(c._id, { pool: JSON.stringify(pool), st: JSON.stringify(st), prop: "" })
  return { done: true, e: "" }
}

export const propose = mutation({
  args: { kh: v.string(), id: v.id("communities"), sid: v.string(), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:propose")
    if (!KH.test(a.kh) || !STRUCT[a.sid]) return { ok: false, e: "bad", done: false }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: false, e: "gone", done: false }
    const l = await sha("mem:" + a.kh)
    if (!(c.adm === l || (c.board ?? []).includes(l))) return { ok: false, e: "board", done: false }
    const old = c.prop ? parse(c.prop) : null
    if (old && Date.now() - (old.t ?? 0) < 7 * 86_400_000) return { ok: false, e: "open", done: false }
    if (Number(parse(c.st)[a.sid] ?? 0) >= STRUCT[a.sid].max) return { ok: false, e: "max", done: false }
    const r = await tryExec(ctx, c, { sid: a.sid, v: [l], t: Date.now() })
    return { ok: !r.e, e: r.e, done: r.done }
  },
})

export const vote = mutation({
  args: { kh: v.string(), id: v.id("communities"), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:vote")
    if (!KH.test(a.kh)) return { ok: false, e: "bad", done: false }
    const c: any = await ctx.db.get(a.id)
    if (!c || !c.prop) return { ok: false, e: "none", done: false }
    const l = await sha("mem:" + a.kh)
    if (!(c.adm === l || (c.board ?? []).includes(l))) return { ok: false, e: "board", done: false }
    const prop = parse(c.prop)
    if (!(prop.v ?? []).includes(l)) prop.v = [...(prop.v ?? []), l]
    const r = await tryExec(ctx, c, prop)
    return { ok: !r.e, e: r.e, done: r.done }
  },
})

export const cancelProp = mutation({
  args: { kh: v.string(), id: v.id("communities") },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false }
    const c: any = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false }
    await ctx.db.patch(a.id, { prop: "" })
    return { ok: true }
  },
})

export const remove = mutation({
  args: { kh: v.string(), id: v.id("communities") },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false }
    const c = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false }
    await ctx.db.delete(a.id)
    return { ok: true }
  },
})

// Announcements: the admin and board can post short notices that every member sees in the community window.
const MAX_ANN = 20
export const announce = mutation({
  args: { kh: v.string(), id: v.id("communities"), text: v.string() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false, e: "bad" }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: false, e: "gone" }
    const l = await sha("mem:" + a.kh)
    if (!(c.adm === l || (c.board ?? []).includes(l))) return { ok: false, e: "board" }
    const text = a.text.replace(/\s+/g, " ").trim().slice(0, 140)
    if (!text) return { ok: false, e: "empty" }
    if (bad(text)) return { ok: false, e: "words" }
    const who = (c.mem ?? []).find((m: any) => m.l === l)
    const ann = [...(c.ann ?? []), { t: Date.now(), n: who ? who.n : "Admin", x: text }].slice(-MAX_ANN)
    await ctx.db.patch(a.id, { ann })
    return { ok: true, e: "" }
  },
})

// The admin can remove an announcement.
export const removeAnn = mutation({
  args: { kh: v.string(), id: v.id("communities"), t: v.number() },
  handler: async (ctx, a) => {
    if (!KH.test(a.kh)) return { ok: false }
    const c: any = await ctx.db.get(a.id)
    if (!c || c.owner !== (await sha("own:" + a.kh))) return { ok: false }
    await ctx.db.patch(a.id, { ann: (c.ann ?? []).filter((x: any) => x.t !== a.t) })
    return { ok: true }
  },
})

// Shared community buildings: a member's finished tier-2 building (Shop, Market Hall, Plaza, Communal Farm) is
// registered to the community so every member can see it. Only a member of the community can register one.
// The client sends id (the community id), and builtAt (ms); both are stored under comm and at.
export const structure_add = mutation({
  args: { kh: v.string(), id: v.id("communities"), kind: v.string(), lot: v.number(), owner: v.string(), builtAt: v.optional(v.number()), ...SIG },
  handler: async (ctx, a) => {
    await requireSig(ctx.db, a, "communities:structure_add")
    if (!KH.test(a.kh)) return { ok: false, e: "bad", id: "" }
    const c: any = await ctx.db.get(a.id)
    if (!c) return { ok: false, e: "gone", id: "" }
    const l = await sha("mem:" + a.kh)
    if (!(c.mem ?? []).some((m: any) => m.l === l)) return { ok: false, e: "member", id: "" }
    const kind = a.kind.trim().slice(0, 40)
    const owner = a.owner.trim().slice(0, 64)
    if (!kind || !owner) return { ok: false, e: "bad", id: "" }
    const lot = Math.floor(Number(a.lot))
    if (!Number.isFinite(lot)) return { ok: false, e: "bad", id: "" }
    const comm = String(a.id)
    const dup = await ctx.db
      .query("cstructures")
      .withIndex("by_comm", (q) => q.eq("comm", comm))
      .filter((q) => q.and(q.eq(q.field("lot"), lot), q.eq(q.field("kind"), kind)))
      .first()
    if (dup) return { ok: true, e: "dup", id: dup._id }
    const id = await ctx.db.insert("cstructures", { comm, kind, lot, owner, at: Date.now() })
    return { ok: true, e: "", id }
  },
})

// All shared buildings in one community, oldest first.
export const structures = query({
  args: { comm: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("cstructures")
      .withIndex("by_comm", (q) => q.eq("comm", a.comm))
      .collect()
    return rows
      .sort((x, y) => x.at - y.at)
      .map((r) => ({ id: r._id, comm: r.comm, kind: r.kind, lot: r.lot, owner: r.owner, at: r.at }))
  },
})
