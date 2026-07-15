# Phantom / Blowfish — Anti-Flag Notes

**Context:** Phantom runs every transaction through **Blowfish** (its security
scanner) and shows a red **"malicious / deceptive / blocked"** warning when a tx
matches drainer heuristics or can't execute. Connecting itself is fine — **it's
the transaction you ask a user to sign that gets flagged.** Everything below is
the pattern set we use to stay clean.

## The rules that keep txs unflagged (enforced in our code)

1. **Never put `approve` / `delegate` / `setAuthority` in a user-signed tx.**
   These token-approval / authority instructions are *the* classic drainer
   signature — Blowfish flags them instantly. We are non-custodial and
   approval-free, always.
2. **No raw multi-recipient SOL transfers in a signed tx.** A tx that fans SOL to
   several addresses = drainer pattern → flagged. **Payments are a single
   `SystemProgram.transfer` to ONE treasury**, `feePayer = buyer`, signed via
   `signAndSendTransaction`. Any splitting (fees, payouts) happens **off-chain**,
   never inside the signed tx.
3. **Fees via Jupiter's native `platformFee` → referral account**, not a separate
   SOL-transfer instruction bolted onto the swap. If the fee account isn't usable,
   fall back to a plain no-fee swap so trading never hard-fails.
4. **Swaps = Jupiter, single-signer, `signAndSendTransaction`.** Standard shape,
   nothing custom that trips the scanner.

## The other big flag trigger: insufficient funds

- **Phantom throws the scary "malicious/blocked" warning when the wallet can't
  cover the tx** (payment + gas). It reads as "this site is trying something bad"
  but it's really just "not enough SOL."
- **Guard BEFORE signing:** check `getBalance >= lamports + ~0.003 SOL gas` and
  **`simulateTransaction`** first. If it would fail, show a friendly "not enough
  SOL" message — the user never sees Phantom's red screen.

## Connect / linking

- **`signMessage` (ownership proof / linking to Telegram) is free and never
  flagged** — it's not a transaction, just a signature. Use it to bind identity;
  save the tx surface for the actual payment.
- Deploy / launch txs: mint keypair generated **client-side, never leaves the
  browser**; multi-signer (mint + user via `signTransaction`) then self-submitted;
  **simulate before signing**.

## TL;DR checklist for any new signing flow

- ✅ Single-recipient native transfer, single signer, `feePayer = buyer`
- ✅ Simulate + balance-check before `signAndSendTransaction`
- ❌ No `approve` / `delegate` / `setAuthority`
- ❌ No multi-recipient SOL in the signed tx (split off-chain)
- ✅ Fees via Jupiter `platformFee`, not a side transfer
- ✅ `signMessage` for ownership; keep it separate from the payment

## Where this lives in the codebase

- `credits.html` — payment flow: `signMessage` link → single-recipient
  `SystemProgram.transfer`, with the pre-sign balance guard + `simulateTransaction`.
- `api/swap.js` — Jupiter swap with native `platformFee` (never a raw side
  transfer), holder fee discount, no-fee fallback.
- `README.md` — the "Design rules enforced" line (non-custodial; no
  approve/delegate/setAuthority; no raw multi-recipient SOL in user-signed txs =
  anti-Blowfish; fees via Jupiter `platformFee`, split off-chain).
- `wallet.html`, `assets/holder.js` — the connect flow (Phantom / Solflare /
  Backpack detection, ownership via connect + `signMessage`).
