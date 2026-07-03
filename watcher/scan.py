#!/usr/bin/env python3
"""
CATBOY launch watcher — emails you when new Solana / pump.fun tokens set a WEBSITE.

Data source: DexScreener "latest token profiles" (a token appears here the moment
it publishes a profile with links). We keep only Solana tokens that set a website
(and, by default, only pump.fun mints), skip ones we've already alerted, enrich each
with name/symbol/market-cap, and email a digest.

All config comes from env vars (set as GitHub Action secrets — nothing hardcoded):
  SMTP_USER      burner gmail address to send FROM
  SMTP_PASS      gmail App Password (not your normal password)
  ALERT_TO       where to send (default: SMTP_USER)
  PUMP_ONLY      "true" -> only pump.fun mints (address ends with 'pump'). default true
  REQUIRE_WEBSITE "true" -> only tokens that set a website. default true
  KEYWORDS       optional comma list; only alert if name/symbol/desc contains one
  MAX_ALERTS     cap per run (default 20)
  SEEN_FILE      state file path (default watcher/seen.json)
"""
import os, json, ssl, smtplib, time, urllib.request, urllib.error
from email.mime.text import MIMEText
from email.utils import formatdate

PROFILES = "https://api.dexscreener.com/token-profiles/latest/v1"
TOKENS = "https://api.dexscreener.com/latest/dex/tokens/"
PUMPFUN = "https://frontend-api-v3.pump.fun/coins?limit=100&sort=created_timestamp&order=DESC&includeNsfw=true"
UA = {"User-Agent": "catboy-watcher/1.0"}
BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept": "application/json"}

SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
ALERT_TO = os.environ.get("ALERT_TO") or SMTP_USER
PUMP_ONLY = os.environ.get("PUMP_ONLY", "true").lower() == "true"
REQUIRE_WEBSITE = os.environ.get("REQUIRE_WEBSITE", "true").lower() == "true"
KEYWORDS = [k.strip().lower() for k in os.environ.get("KEYWORDS", "").split(",") if k.strip()]
MAX_ALERTS = int(os.environ.get("MAX_ALERTS", "20"))
SEEN_FILE = os.environ.get("SEEN_FILE", "watcher/seen.json")


def get_json(url, timeout=25, headers=None):
    req = urllib.request.Request(url, headers=headers or UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


SOCIAL_HOSTS = ("twitter.com", "x.com", "t.me", "telegram", "discord", "instagram",
                "tiktok", "youtube", "youtu.be", "facebook", "reddit", "medium",
                "github", "linktr.ee", "warpcast")


def website_of(links):
    links = links or []
    # 1) explicitly tagged website
    for l in links:
        t = (l.get("type") or "").lower()
        lab = (l.get("label") or "").lower()
        if t in ("website", "web") or "website" in lab or "home" in lab:
            return l.get("url")
    # 2) fallback: any http link that isn't a known social (catches custom domains)
    for l in links:
        t = (l.get("type") or l.get("label") or "").lower()
        url = (l.get("url") or "").strip()
        if t in ("twitter", "x", "telegram", "tg", "discord", "instagram", "tiktok", "youtube"):
            continue
        low = url.lower()
        if url.startswith("http") and not any(h in low for h in SOCIAL_HOSTS):
            return url
    return None


def socials_of(links):
    out = {}
    for l in links or []:
        t = (l.get("type") or l.get("label") or "").lower()
        if t in ("twitter", "x"):
            out["x"] = l.get("url")
        elif t in ("telegram", "tg"):
            out["tg"] = l.get("url")
    return out


def enrich(addr):
    try:
        d = get_json(TOKENS + addr)
        pairs = d.get("pairs") or []
        if not pairs:
            return {}
        p = max(pairs, key=lambda x: (x.get("liquidity") or {}).get("usd", 0) or 0)
        bt = p.get("baseToken") or {}
        return {
            "name": bt.get("name"), "symbol": bt.get("symbol"),
            "price": p.get("priceUsd"), "mc": p.get("marketCap") or p.get("fdv"),
            "liq": (p.get("liquidity") or {}).get("usd"), "dex": p.get("url"),
            "age": p.get("pairCreatedAt"),
        }
    except Exception:
        return {}


def load_seen():
    try:
        with open(SEEN_FILE) as f:
            return set(json.load(f))
    except Exception:
        return None  # None => first run


def save_seen(seen):
    os.makedirs(os.path.dirname(SEEN_FILE) or ".", exist_ok=True)
    with open(SEEN_FILE, "w") as f:
        json.dump(sorted(seen), f)


def send_email(subject, body):
    if not (SMTP_USER and SMTP_PASS):
        print("[watcher] no SMTP creds set — printing instead:\n", subject, "\n", body)
        return
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = SMTP_USER
    msg["To"] = ALERT_TO
    msg["Date"] = formatdate(localtime=True)
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx) as s:
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(SMTP_USER, [ALERT_TO], msg.as_string())
    print("[watcher] emailed:", subject)


def matches_keywords(prof, meta):
    if not KEYWORDS:
        return True
    hay = " ".join(str(x) for x in [
        prof.get("description"), meta.get("name"), meta.get("symbol")
    ]).lower()
    return any(k in hay for k in KEYWORDS)


def dexscreener_candidates():
    out = []
    try:
        profiles = get_json(PROFILES)
    except Exception as e:
        print("[watcher] dexscreener error:", e); return out
    rows = profiles if isinstance(profiles, list) else profiles.get("profiles", [])
    for r in rows:
        if r.get("chainId") != "solana":
            continue
        addr = r.get("tokenAddress") or ""
        if PUMP_ONLY and not addr.endswith("pump"):
            continue
        site = website_of(r.get("links"))
        if REQUIRE_WEBSITE and not site:
            continue
        r["_src"] = "dex"
        out.append((addr, r, site))
    return out


def pumpfun_candidates():
    """Direct pump.fun feed — coins appear seconds after creation, with website set."""
    out = []
    try:
        coins = get_json(PUMPFUN, headers=BROWSER_UA)
    except Exception as e:
        print("[watcher] pump.fun error:", e); return out
    for c in coins or []:
        mint = c.get("mint") or ""
        site = (c.get("website") or "").strip()
        if REQUIRE_WEBSITE and not site:
            continue
        links = []
        if site: links.append({"label": "Website", "url": site})
        if c.get("twitter"): links.append({"type": "twitter", "url": c["twitter"]})
        if c.get("telegram"): links.append({"type": "telegram", "url": c["telegram"]})
        prof = {"tokenAddress": mint, "links": links, "description": c.get("description"),
                "header": c.get("name"), "_src": "pump", "_pf": c}
        out.append((mint, prof, site or None))
    return out


def main():
    # merge both feeds, dedupe by mint (pump.fun wins — it has fresher meta)
    by_mint = {}
    for a, r, s in dexscreener_candidates() + pumpfun_candidates():
        if a and (a not in by_mint or r.get("_src") == "pump"):
            by_mint[a] = (a, r, s)
    candidates = list(by_mint.values())

    seen = load_seen()
    first_run = seen is None
    if first_run:
        seen = set()

    fresh = [(a, r, s) for (a, r, s) in candidates if a not in seen]

    # mark everything current as seen regardless (so we don't re-alert)
    for a, _, _ in candidates:
        seen.add(a)

    if first_run:
        save_seen(seen)
        send_email("🐾 CATBOY launch watcher is LIVE",
                   "Your watcher is running. You'll get an email when a new "
                   f"{'pump.fun ' if PUMP_ONLY else 'Solana '}token sets a website.\n\n"
                   f"Seeded {len(seen)} existing tokens (no alerts for these).")
        print("[watcher] first run — seeded", len(seen))
        return

    if not fresh:
        save_seen(seen)
        print("[watcher] no new tokens with a website")
        return

    lines, n = [], 0
    for addr, prof, site in fresh:
        if n >= MAX_ALERTS:
            break
        pf = prof.get("_pf")
        if pf:   # brand-new pump.fun coin — use its own metadata (not yet on DexScreener)
            meta = {"name": pf.get("name"), "symbol": pf.get("symbol"),
                    "mc": pf.get("usd_market_cap"), "age": pf.get("created_timestamp"),
                    "dex": "https://dexscreener.com/solana/" + addr}
        else:
            meta = enrich(addr)
        if not matches_keywords(prof, meta):
            continue
        soc = socials_of(prof.get("links"))
        name = meta.get("name") or prof.get("header") or "(unknown)"
        sym = ("$" + meta["symbol"]) if meta.get("symbol") else ""
        mc = meta.get("mc")
        src = "pump.fun (live)" if prof.get("_src") == "pump" else "dexscreener"
        age = ""
        if meta.get("age"):
            secs = int(time.time() - float(meta["age"]) / 1000)
            age = f"  Age: {secs}s\n" if 0 <= secs < 36000 else ""
        lines.append(
            f"• {name} {sym}   [{src}]\n"
            f"  CA: {addr}\n"
            f"  Website: {site or '—'}\n"
            + (f"  X: {soc['x']}\n" if soc.get("x") else "")
            + (f"  TG: {soc['tg']}\n" if soc.get("tg") else "")
            + (f"  Market cap: ${int(float(mc)):,}\n" if mc else "")
            + (f"  Liquidity: ${int(float(meta['liq'])):,}\n" if meta.get("liq") else "")
            + age
            + f"  Chart: {meta.get('dex') or 'https://dexscreener.com/solana/' + addr}\n"
            + f"  Pump: https://pump.fun/{addr}\n"
        )
        n += 1

    save_seen(seen)
    if not lines:
        print("[watcher] new tokens found but filtered out by keywords")
        return
    subject = f"🚀 {len(lines)} new {'pump.fun' if PUMP_ONLY else 'Solana'} launch(es) with a website"
    body = "New tokens that just launched and set a website:\n\n" + "\n".join(lines) + \
           "\n— CATBOY watcher. Always DYOR; a website is not safety."
    send_email(subject, body)


if __name__ == "__main__":
    main()
