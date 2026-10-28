import { query } from "./_generated/server"

// Public settings the game needs: where creator royalties go and how much (in basis points).
// 50 basis points = 0.5%. Set ROYALTY_WALLET in the deployment settings; leave it unset to turn royalties off.
export const get = query({
  args: {},
  handler: async () => {
    const w = process.env.ROYALTY_WALLET ?? ""
    const ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)
    const bps = Math.max(0, Math.min(1000, Math.round(Number(process.env.ROYALTY_BPS ?? 50)) || 0))
    // Optional official channels, shown in the game's Community tab. Only real invite links are passed on.
    const dc = process.env.DISCORD_URL ?? ""
    const tg = process.env.TELEGRAM_URL ?? ""
    const dcOk = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/.test(dc)
    const tgOk = /^https:\/\/t\.me\/(\+|joinchat\/)?[A-Za-z0-9_-]{3,64}$/.test(tg)
    return { w: ok ? w : "", bps: ok ? bps : 0, dc: dcOk ? dc : "", tg: tgOk ? tg : "" }
  },
})
