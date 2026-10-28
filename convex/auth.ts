import nacl from "tweetnacl"
import { internalQuery } from "./_generated/server"
import { v } from "convex/values"

// Account signature check for every call that acts on an account.
//
// MESSAGE FORMAT (exact, UTF-8, no trailing newline):
//     oreages:<fn>:<ts>
//   <fn> is the Convex function the call is for, e.g. "gigs:post", "market:buySol", "communities:found".
//   <ts> is Date.now() in milliseconds on the client when it signed.
//   Example: oreages:gigs:post:1793123456789
//
// SIGNATURE FIELDS sent with the call (all three together, or none). asig is named to avoid clashing with the
// Solana transaction sig args on buySol / found / confirmBuy:
//   asig 64-byte ed25519 signature of that message, 128 lowercase hex characters
//   pk   32-byte ed25519 public key, 64 lowercase hex characters (must equal the key stored on the account)
//   ts   the timestamp number from the message
// The game derives the key from the account key: seed = sha256("oreages-sig:" + account key). The account key itself
// never leaves the device, and no extra wallet prompt appears. The public key is stored on the account (accounts.pk)
// when the account is created, or bound once for older accounts with accounts:bind.
//
// RULES
//  - ts must be within 120 seconds of server time (30 seconds of clock skew allowed in the future).
//    Otherwise error "signature-stale"; the game re-signs and retries once.
//  - the signature must verify against the pk stored on the account. Otherwise "signature-invalid".
//  - account not yet bound (accounts.pk unset): "signature-bind"; the game calls accounts:bind, then retries.
//  - optional owner check (calls that act for a player id, e.g. market): the account's aid must equal that arg.
//    Otherwise "signature-owner".
//  - LEGACY: a call with no sig/pk/ts is accepted ONLY when the deployment env var ALLOW_UNSIGNED=1 is set.
//    Env unset (default) means signatures are required and an unsigned call fails with "signature-required".
//    A call that carries a signature is always verified, even when ALLOW_UNSIGNED=1.
//
// Known limit: within its 120 second window, a signed message can be replayed by anyone who sees it on the wire.
// The message does not yet cover the arguments, so a replay can repeat the same call with the same arguments only.

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

const HEX128 = /^[a-f0-9]{128}$/
const HEX64 = /^[a-f0-9]{64}$/
const KH = /^[a-f0-9]{64}$/
const WINDOW_MS = 120_000
const SKEW_MS = 30_000

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

// Spread into the args of every signed function. kh is NOT part of SIG: each function declares its own kh.
export const SIG = {
  asig: v.optional(v.string()),
  pk: v.optional(v.string()),
  ts: v.optional(v.number()),
}

export function hasSig(a: any): boolean {
  return a.asig !== undefined || a.pk !== undefined || a.ts !== undefined
}

// Verifies the signature for a call. Throws on failure. Returns false for an allowed legacy (unsigned) call,
// true when the signature verified. aidField names the arg that must equal the account's aid (market calls).
export async function requireSig(db: any, a: any, fn: string, aidField?: string): Promise<boolean> {
  if (!hasSig(a)) {
    if (process.env.ALLOW_UNSIGNED === "1") return false
    throw new Error("signature-required")
  }
  if (typeof a.asig !== "string" || typeof a.pk !== "string" || typeof a.ts !== "number") throw new Error("signature-invalid")
  if (!HEX128.test(a.asig) || !HEX64.test(a.pk)) throw new Error("signature-invalid")
  const age = Date.now() - a.ts
  if (age > WINDOW_MS || age < -SKEW_MS) throw new Error("signature-stale")
  if (typeof a.kh !== "string" || !KH.test(a.kh)) throw new Error("signature-invalid")
  const lid = await sha("lid:" + a.kh)
  const acc = await db.query("accounts").withIndex("by_lid", (q: any) => q.eq("lid", lid)).first()
  if (!acc) throw new Error("signature-invalid")
  if (!acc.pk) throw new Error("signature-bind")
  if (acc.pk !== a.pk) throw new Error("signature-invalid")
  const msg = new TextEncoder().encode(`oreages:${fn}:${a.ts}`)
  if (!nacl.sign.detached.verify(msg, fromHex(a.asig), fromHex(a.pk))) throw new Error("signature-invalid")
  if (aidField && acc.aid !== a[aidField]) throw new Error("signature-owner")
  return true
}

// accounts:bind proof: the caller shows it holds the key by signing "oreages:accounts:bind:<ts>" with the new pk.
// Only for accounts that have no pk yet. Returns the account row so the caller can store the pk.
export async function verifyBind(db: any, a: any): Promise<any> {
  if (typeof a.asig !== "string" || typeof a.pk !== "string" || typeof a.ts !== "number") throw new Error("signature-invalid")
  if (!HEX128.test(a.asig) || !HEX64.test(a.pk)) throw new Error("signature-invalid")
  const age = Date.now() - a.ts
  if (age > WINDOW_MS || age < -SKEW_MS) throw new Error("signature-stale")
  const lid = await sha("lid:" + a.kh)
  const acc = await db.query("accounts").withIndex("by_lid", (q: any) => q.eq("lid", lid)).first()
  if (!acc) throw new Error("signature-invalid")
  if (acc.pk) throw new Error("signature-bound")
  const msg = new TextEncoder().encode(`oreages:accounts:bind:${a.ts}`)
  if (!nacl.sign.detached.verify(msg, fromHex(a.asig), fromHex(a.pk))) throw new Error("signature-invalid")
  return acc
}

// accounts:create proof: a new account must show the key it registers. Signs "oreages:accounts:create:<ts>".
// Returns the pk to store (or undefined when legacy unsigned creation is allowed).
export function verifyCreate(a: any): string | undefined {
  if (!hasSig(a)) {
    if (process.env.ALLOW_UNSIGNED === "1") return undefined
    throw new Error("signature-required")
  }
  if (typeof a.asig !== "string" || typeof a.pk !== "string" || typeof a.ts !== "number") throw new Error("signature-invalid")
  if (!HEX128.test(a.asig) || !HEX64.test(a.pk)) throw new Error("signature-invalid")
  const age = Date.now() - a.ts
  if (age > WINDOW_MS || age < -SKEW_MS) throw new Error("signature-stale")
  const msg = new TextEncoder().encode(`oreages:accounts:create:${a.ts}`)
  if (!nacl.sign.detached.verify(msg, fromHex(a.asig), fromHex(a.pk))) throw new Error("signature-invalid")
  return a.pk
}

// Used by actions (which cannot read the database directly): ctx.runQuery(internal.auth.check, {...}).
export const check = internalQuery({
  args: {
    kh: v.optional(v.string()),
    asig: v.optional(v.string()),
    pk: v.optional(v.string()),
    ts: v.optional(v.number()),
    fn: v.string(),
    aidField: v.optional(v.string()),
    aid: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const args: any = { kh: a.kh, asig: a.asig, pk: a.pk, ts: a.ts }
    if (a.aidField) args[a.aidField] = a.aid
    return await requireSig(ctx.db, args, a.fn, a.aidField)
  },
})
