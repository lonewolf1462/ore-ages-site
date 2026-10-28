import { query } from "./_generated/server"

// Public game counters for the promo site. Anonymous: no sig, no account lookup, read only.
// Tables that do not exist in the schema are not counted here; NFTs are not a table (they live on-chain),
// so nftsMinted counts market listings that are backed by an NFT asset address (listings.a).
// resourcesGathered is not stored anywhere yet, so it stays 0 until it is tracked.
const LIVE_WINDOW_MS = 5 * 60_000

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    const accounts = await ctx.db.query("accounts").collect()
    const communities = await ctx.db.query("communities").collect()
    const structures = await ctx.db.query("cstructures").collect()
    const listings = await ctx.db.query("listings").collect()
    const miners = await ctx.db
      .query("miners")
      .withIndex("by_t", (q) => q.gt("t", now - LIVE_WINDOW_MS))
      .collect()

    return {
      activePlayers: miners.length,
      totalPlayers: accounts.length,
      resourcesGathered: 0,
      buildings: structures.length,
      nftsMinted: listings.filter((l) => !!l.a).length,
      marketTx: listings.filter((l) => l.status === "sold").length,
      communities: communities.length,
    }
  },
})
