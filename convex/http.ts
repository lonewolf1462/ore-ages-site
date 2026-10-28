import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { api } from "./_generated/api"

// HTTP routes for browser clients on other domains (the promo site on GitHub Pages).
// Served from the deployment's .convex.site address, e.g. https://successful-lion-368.convex.site/api/stats
// Only public read-only stats are exposed here; CORS allows any origin to GET the numbers.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}

const statsHandler = httpAction(async (ctx) => {
  try {
    const data = await ctx.runQuery(api.stats.overview, {})
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: "stats-unavailable" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

const preflight = httpAction(async () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
})

const http = httpRouter()

http.route({ path: "/api/stats", method: "GET", handler: statsHandler })
http.route({ path: "/api/stats", method: "POST", handler: statsHandler })
http.route({ path: "/api/stats", method: "OPTIONS", handler: preflight })

export default http
