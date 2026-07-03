# Catboy PFP Generator — setup

The generator calls Venice **server-side** so the API key is never exposed.
Set these in **Vercel → Project → Settings → Environment Variables**:

| Var | What | Example |
|-----|------|---------|
| `VENICE_API_KEY` | your Venice inference key (required) | `venice_...` |
| `SOLANA_RPC` | private RPC (already used by /api/solrpc) | `https://mainnet.helius-rpc.com/?api-key=...` |
| `PFP_FEE_SOL` | price per PFP in SOL — set to ~**2× your Venice per-image cost** | `0.02` |
| `PFP_MODEL` | Venice model (optional) | `nano-banana-pro` |

Proceeds route on-chain 90% treasury `3DHwgk2T3tGxQRfD3p897eq1UV9rwvw1JNWa2rS3RdKw`
/ 10% overhead `EK8YS2haXFtKJ61phggC39m9RAG16B3NMx59uyMkP1PC` in a single tx.
Payment is verified server-side before the image is generated.

Replay protection is best-effort (recent-tx window + in-memory cache). For a
high-volume paid service, add a KV/DB store keyed on the tx signature.
