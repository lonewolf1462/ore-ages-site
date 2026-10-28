import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // One row per player currently (or recently) online: settlement, mine or inside a house.
  miners: defineTable({
    pid: v.string(),
    n: v.string(),
    c: v.number(),
    x: v.number(),
    y: v.number(),
    h: v.number(),
    inMine: v.boolean(),
    t: v.number(),
    r: v.optional(v.string()), // house invite code the player is inside, if any
    k: v.optional(v.string()), // house kind (set by the owner)
    o: v.optional(v.number()), // 1 when this player owns the house they are in
    m: v.optional(v.string()), // the player's last few chat messages (JSON)
    u: v.optional(v.string()), // stable player id (for phone messages)
    f: v.optional(v.string()), // furniture layout of the house the owner is in
    cm: v.optional(v.string()), // community the player belongs to
  })
    .index("by_pid", ["pid"])
    .index("by_t", ["t"]),

  // Communities that players create, with Discord and Telegram links, members, a board, a pool and structures.
  communities: defineTable({
    owner: v.string(), // hash identifying the owning account
    name: v.string(),
    nl: v.string(), // lower-case name, so names stay unique
    desc: v.string(),
    discord: v.string(),
    telegram: v.string(),
    on: v.string(), // owner display name when it was created
    t: v.number(),
    pct: v.optional(v.number()), // share of members' mining that goes to the pool
    adm: v.optional(v.string()), // the admin's member hash
    mem: v.optional(v.array(v.object({ l: v.string(), n: v.string() }))),
    board: v.optional(v.array(v.string())),
    pool: v.optional(v.string()), // JSON of pooled resources
    st: v.optional(v.string()), // JSON of structure levels
    prop: v.optional(v.string()), // JSON of the open proposal
    reg: v.optional(v.string()), // region
    fee: v.optional(v.string()), // founding-fee transaction signature
    ann: v.optional(v.array(v.object({ t: v.number(), n: v.string(), x: v.string() }))), // announcements from the admin and board
  })
    .index("by_owner", ["owner"])
    .index("by_nl", ["nl"])
    .index("by_t", ["t"])
    .index("by_fee", ["fee"]),

  // Tier-2 buildings a member finished while in a community, shared so every member can see them.
  cstructures: defineTable({
    comm: v.string(), // community id the structure belongs to
    kind: v.string(), // building name (Shop, Market Hall, Plaza, Communal Farm)
    lot: v.number(), // the owner's lot number (-1 when unknown)
    owner: v.string(), // the owner's stable player id
    at: v.number(), // when it was registered (ms)
  }).index("by_comm", ["comm"]),

  // The shared neighbourhood: one numbered lot per account, with a snapshot of what is built on it.
  lots: defineTable({
    slot: v.number(),
    owner: v.string(), // hash identifying the owning account
    name: v.string(),
    snap: v.string(),
    ver: v.number(),
    t: v.number(),
  })
    .index("by_slot", ["slot"])
    .index("by_owner", ["owner"]),

  // Player-to-player marketplace: items listed for gold or SOL, displayed at a house or the market square.
  listings: defineTable({
    seller: v.string(),
    sn: v.string(),
    item: v.string(),
    price: v.number(),
    t: v.number(),
    status: v.string(), // open | sold | cancelled
    buyer: v.optional(v.string()),
    claimed: v.boolean(), // seller has collected the gold from a sale
    cur: v.optional(v.string()), // gold | sol (missing means gold)
    w: v.optional(v.string()), // seller wallet address for SOL listings
    loc: v.optional(v.string()), // house code where it is displayed ("" = market square)
    sig: v.optional(v.string()), // verified payment transaction for SOL sales
    a: v.optional(v.string()), // NFT asset address backing this item, if it was registered
    bw: v.optional(v.string()), // buyer wallet for SOL sales
    dv: v.optional(v.boolean()), // the NFT has reached the buyer
  })
    .index("by_status", ["status", "t"])
    .index("by_seller", ["seller"])
    .index("by_sig", ["sig"]),

  // Saved builds ("blueprints"). Stored under the hash of their content; the blueprint NFT carries the same hash on-chain.
  designs: defineTable({
    h: v.string(), // first 32 hex characters of the SHA-256 of data
    n: v.string(),
    pieces: v.number(),
    data: v.string(), // JSON {n, p:[[dx,dy,dz,value],...]}
    t: v.number(),
  }).index("by_h", ["h"]),

  // The work board: a station owner hires help for one batch at a fixed wage (gold).
  gigs: defineTable({
    owner: v.string(), // hash of the owner's account
    sn: v.string(),
    slot: v.number(), // the owner's lot number
    st: v.string(), // Kiln | Smelter | Foundry | Factory
    cx: v.number(), // where the station stands on the lot
    cz: v.number(),
    recipe: v.string(),
    wage: v.number(),
    status: v.string(), // open | taken | done | cancelled
    wkr: v.optional(v.string()), // hash of the worker's account
    wn: v.optional(v.string()),
    tw: v.number(), // seconds the worker has worked
    lw: v.number(),
    t: v.number(),
    claimed: v.boolean(),
  })
    .index("by_status", ["status", "t"])
    .index("by_owner", ["owner"])
    .index("by_worker", ["wkr"]),

  // Player accounts (progress saved online). Sign-in uses a key that only the player holds.
  accounts: defineTable({
    lid: v.string(), // server-side hash of the player's key hash
    aid: v.string(), // stable player id, also used for market and chat identity
    state: v.string(), // saved game progress (JSON)
    ver: v.number(), // bumps on every save so two devices cannot overwrite each other
    wallets: v.array(v.string()), // wallets this player has connected
    pk: v.optional(v.string()), // ed25519 public key (hex) the game signs account actions with; see auth.ts
    created: v.number(),
    updated: v.number(),
  })
    .index("by_lid", ["lid"])
    .index("by_aid", ["aid"]),
})
