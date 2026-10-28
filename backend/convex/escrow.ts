"use node"
import { action } from "./_generated/server"
import { api, internal } from "./_generated/api"
import { v } from "convex/values"
import { SIG as AUTHSIG } from "./auth"
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { createNoopSigner, createSignerFromKeypair, lamports, publicKey, transactionBuilder } from "@metaplex-foundation/umi"
import { fetchAsset, mplCore, transferV1 } from "@metaplex-foundation/mpl-core"
import { transferSol } from "@metaplex-foundation/mpl-toolbox"

// Escrow for NFT sales: one atomic swap, no pay-first-and-hope.
//
//  - While listing, the seller approves THIS server's key as the transfer delegate of the NFT (the NFT stays in the seller's wallet).
//  - prepareBuy builds ONE transaction: buyer pays seller, buyer pays the creator royalty, the NFT moves to the buyer.
//    The escrow key signs only the NFT transfer. The buyer's wallet adds its signature and sends it.
//  - If any part fails, all of it fails. The escrow key can only move NFTs that sellers have approved, and only inside a transaction
//    this server built for an open listing (the signature covers every instruction, so nothing can be changed afterwards).
//  - confirmBuy checks the result on-chain, then marks the listing sold and delivered.
//
// Environment: ESCROW_SECRET (the key; see setup() below for the accepted forms), ESCROW_ADDRESS (optional check, see below), ROYALTY_WALLET, ROYALTY_BPS (default 50), SOL_RPC (default devnet).

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/
const MIN_RENT = 890_880 // the smallest balance a brand-new empty account may hold (lamports)
const rpcUrl = () => process.env.SOL_RPC ?? "https://api.devnet.solana.com"

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0]
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error("not base58")
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch === "1") bytes.push(0)
    else break
  }
  return Uint8Array.from(bytes.reverse())
}

// ESCROW_SECRET can be the key as a list of 64 numbers like [12,34,...] (Solana Playground / CLI), as base58 text of 64 bytes
// (Phantom "Show private key"), or as base58 text of a 32-byte seed (some wallets show this shorter form).
// ESCROW_ADDRESS (the account's public address) must be set for a 32-byte seed, and when set it must match the key's own address.
// That check catches the usual mistake of pasting the address where the private key belongs: an address is public, so a key
// made from it would be one anyone could work out.
function setup() {
  const umi = createUmi(rpcUrl()).use(mplCore())
  let kp: any = null
  let why = "notset" // why there is no key: notset | format | length:N | need-address | mismatch (never the key itself)
  try {
    const unq = (x: string | undefined) => (x ?? "").trim().replace(/^["']|["']$/g, "")
    const raw = unq(process.env.ESCROW_SECRET)
    const addr = unq(process.env.ESCROW_ADDRESS)
    if (raw) {
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : base58Decode(raw)
      let k: any = null
      if (bytes.length === 64) k = umi.eddsa.createKeypairFromSecretKey(bytes)
      else if (bytes.length === 32) {
        if (!addr) why = "need-address"
        else k = umi.eddsa.createKeypairFromSeed(bytes)
      } else why = "length:" + bytes.length
      if (k) {
        if (addr && String(k.publicKey) !== addr) why = "mismatch"
        else {
          kp = k
          why = ""
        }
      }
    }
  } catch {
    why = "format"
  }
  return { umi, kp, why }
}

function royalty(total: number, seller: string) {
  const rw = process.env.ROYALTY_WALLET ?? ""
  const bps = Math.max(0, Math.min(1000, Math.round(Number(process.env.ROYALTY_BPS ?? 50)) || 0))
  return { rw, roy: rw && rw !== seller ? Math.floor((total * bps) / 10000) : 0 }
}

async function getTx(sig: string): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }],
      }),
    })
    const tx = (await r.json()).result
    if (tx) return tx
    await new Promise((res) => setTimeout(res, 1500))
  }
  return null
}

// The game asks for this once; without a key the game keeps using the old pay-then-deliver flow.
export const pubkey = action({
  args: {},
  handler: async (): Promise<{ ok: boolean; pk: string; why: string }> => {
    const { kp, why } = setup()
    return kp ? { ok: true, pk: String(kp.publicKey), why: "" } : { ok: false, pk: "", why }
  },
})

export const prepareBuy = action({
  args: { id: v.id("listings"), buyer: v.string(), buyerWallet: v.string(), kh: v.optional(v.string()), ...AUTHSIG },
  handler: async (ctx, a): Promise<any> => {
    await ctx.runQuery(internal.auth.check, { kh: a.kh, asig: a.asig, pk: a.pk, ts: a.ts, fn: "escrow:prepareBuy", aidField: "buyer", aid: a.buyer })
    const { umi, kp } = setup()
    if (!kp) return { ok: false, e: "noesc" }
    if (!B58.test(a.buyerWallet)) return { ok: false, e: "bad" }
    const l: any = await ctx.runQuery(internal.market.getOne, { id: a.id })
    if (!l || l.status !== "open" || l.cur !== "sol" || !l.w) return { ok: false, e: "gone" }
    if (!l.a) return { ok: false, e: "noesc" }
    if (l.seller === a.buyer || l.w === a.buyerWallet) return { ok: false, e: "own" }

    let asset: any
    try {
      asset = await fetchAsset(umi, publicKey(l.a))
    } catch {
      return { ok: false, e: "asset" }
    }
    if (String(asset.owner) !== l.w) return { ok: false, e: "owner" }
    const d = asset.transferDelegate?.authority
    if (!d || d.type !== "Address" || String(d.address) !== String(kp.publicKey)) return { ok: false, e: "noesc" } // listed the old way

    const total = Math.round(l.price * 1e9)
    const { rw, roy } = royalty(total, l.w)
    // Solana refuses a payment that would leave a brand-new account below the rent minimum, which would fail the whole sale.
    if (roy > 0) {
      const bal = Number((await umi.rpc.getBalance(publicKey(rw))).basisPoints)
      if (bal + roy < MIN_RENT) return { ok: false, e: "royaltyfund" }
    }
    const sbal = Number((await umi.rpc.getBalance(publicKey(l.w))).basisPoints)
    if (sbal + (total - roy) < MIN_RENT) return { ok: false, e: "sellerfund" }

    const buyerSigner = createNoopSigner(publicKey(a.buyerWallet))
    const esc = createSignerFromKeypair(umi, kp)
    let b = transactionBuilder().add(
      transferSol(umi, { source: buyerSigner, destination: publicKey(l.w), amount: lamports(total - roy) })
    )
    if (roy > 0) b = b.add(transferSol(umi, { source: buyerSigner, destination: publicKey(rw), amount: lamports(roy) }))
    b = b
      .add(transferV1(umi, { asset: publicKey(l.a), newOwner: publicKey(a.buyerWallet), authority: esc, payer: buyerSigner }))
      .setFeePayer(buyerSigner)
    const bh = await umi.rpc.getLatestBlockhash()
    b = b.setBlockhash(bh)
    const signed = await esc.signTransaction(b.build(umi))
    return {
      ok: true,
      e: "",
      tx: Buffer.from(umi.transactions.serialize(signed)).toString("base64"),
      bh: bh.blockhash,
      lv: Number(bh.lastValidBlockHeight),
      total,
      roy,
    }
  },
})

export const confirmBuy = action({
  args: { id: v.id("listings"), buyer: v.string(), buyerWallet: v.string(), sig: v.string(), kh: v.optional(v.string()), ...AUTHSIG },
  handler: async (ctx, a): Promise<{ ok: boolean; e: string }> => {
    await ctx.runQuery(internal.auth.check, { kh: a.kh, asig: a.asig, pk: a.pk, ts: a.ts, fn: "escrow:confirmBuy", aidField: "buyer", aid: a.buyer })
    const { umi } = setup()
    const l: any = await ctx.runQuery(internal.market.getOne, { id: a.id })
    if (!l || l.cur !== "sol" || !l.a || !l.w) return { ok: false, e: "gone" }
    if (l.status === "sold" && l.sig === a.sig) return { ok: true, e: "" } // already confirmed
    if (l.status !== "open") return { ok: false, e: "gone" }
    if (!B58.test(a.buyerWallet) || !SIG.test(a.sig)) return { ok: false, e: "tx" }

    const tx = await getTx(a.sig)
    if (!tx || tx.meta?.err) return { ok: false, e: "tx" }
    if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 900) return { ok: false, e: "old" }
    const keys: string[] = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ]
    if (keys[0] !== a.buyerWallet) return { ok: false, e: "tx" } // the buyer is the fee payer and the first signer
    const total = Math.round(l.price * 1e9)
    const { rw, roy } = royalty(total, l.w)
    const si = keys.indexOf(l.w)
    if (si < 0 || tx.meta.postBalances[si] - tx.meta.preBalances[si] < total - roy) return { ok: false, e: "amount" }
    if (roy > 0) {
      const ri = keys.indexOf(rw)
      if (ri < 0 || tx.meta.postBalances[ri] - tx.meta.preBalances[ri] < roy) return { ok: false, e: "royalty" }
    }
    // the NFT itself must now belong to the buyer
    let asset: any
    try {
      asset = await fetchAsset(umi, publicKey(l.a))
    } catch {
      return { ok: false, e: "asset" }
    }
    if (String(asset.owner) !== a.buyerWallet) return { ok: false, e: "owner" }

    const r = await ctx.runMutation(internal.market.finishSol, { id: a.id, buyer: a.buyer, sig: a.sig, bw: a.buyerWallet })
    if (!r.ok) return r
    await ctx.runMutation(api.market.delivered, { id: a.id, seller: l.seller }) // nothing is left to deliver
    return { ok: true, e: "" }
  },
})
