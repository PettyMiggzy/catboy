# x-watcher

Polls one X account and posts to Telegram on every fresh tweet. Cheap by design:
polls with `since_id`, so empty checks fetch 0 posts (you only pay per new post).

## Run
```
X_BEARER=... TG_TOKEN=... TG_CHAT=... X_USERNAME=vladtenev \
  pm2 start x-watcher/index.mjs --name x-watcher --update-env
```

## Data source (pick one)
- **Official X API** — pay-per-use, ~$0.005/post read (empty polls free). `X_API_BASE=https://api.x.com`.
- **Reseller** (twitterapi.io / SocialCrawl) — cheaper, easier signup, mirrors the v2 shape.
  Set `X_API_BASE` to their base URL and `X_BEARER` to their key. Endpoints used:
  `GET /2/users/by/username/:name` and `GET /2/users/:id/tweets`.

## Options
- `X_USERNAME` account to watch (default vladtenev, no @)
- `POLL_SECONDS` default 60
- `INCLUDE_REPLIES=1` / `INCLUDE_RTS=1` to include those (default: original posts only)
- First run "primes" to the latest tweet without alerting, so you don't get a backlog dump.

Notes: reads `.last_id` next to the script for dedup across restarts.
