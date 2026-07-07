# OG Resurrection — Snapshot Freeze

**This file was committed BEFORE the OG-discount program was announced.** Its git
commit timestamp is the proof that the eligibility set was locked in advance, so
nobody can buy the old token *after the fact* to game the discount.

## Frozen snapshot
- **Chain:** BNB Smart Chain (BSC)
- **Snapshot block:** `108609459`
- **Block time:** `2026-07-07T14:10:14Z` (unix `1783433414`)
- **Old CATBOY token (original):** `0x0dcee5f694e492f0dd842a7fbe5bed4c6e4665a6`
- **Migrated CATBOY token:** `0xcA9b8D6df0729D85DCfc8eF8Bb18af1aD1990786`

## Eligibility rule (OG price on the Resurrection drop)
A wallet qualifies for the **OG at-cost price** if it held a **non-zero balance of
either CATBOY contract at block `108609459`**. Buying the token after this block
does **nothing** — eligibility is fixed to this past block and cannot be gamed.

## Verification (at claim)
The claimer signs with their BNB wallet to prove ownership of a snapshotted
address, then we confirm eligibility one of two ways:
1. **Materialized list (preferred):** the full holder set at block 108609459 is
   pulled once from an indexer (BscScan Pro / Moralis / Covalent / an archive node)
   and stored as `resurrection-og.json`. The claim gate checks membership — no
   archive access needed at claim time.
2. **Lazy archive check:** `balanceOf(wallet)` called historically `at block
   108609459` via a BSC **archive** RPC at claim time.

Option 1 is preferred (self-contained, cheap at claim). It requires one data pull
from an indexer with historical support — that's the only remaining step.

## Status
- [x] Snapshot block + contracts frozen and committed (pre-announcement).
- [ ] Materialize the holder list at block 108609459 → `resurrection-og.json`.
- [ ] Wire the OG gate into the Resurrection claim (at-cost vs 0.25/0.5).
