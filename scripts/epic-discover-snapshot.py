#!/usr/bin/env python3
"""Snapshot Epic's mobile storefront discover feed into data/epic-discover/.

Why this exists: the endpoint (egs-platform-service.store.epicgames.com) sits
behind Cloudflare bot management. Plain server-side fetch from a datacenter IP
gets 403 on every attempt (the server already retries with the cf_bm cookie),
while a real Chromium passes. The server therefore falls back to the snapshots
this script writes, and the weekly mobile giveaways keep their real
namespace/offerId — which is what makes the one-tap
`store.epicgames.com/purchase?offers=…` checkout reachable at all.

Run it on a timer (see scripts/epic-discover-cron.sh); a snapshot older than
7 days is ignored by the server.
"""
import json
import pathlib
import time

from playwright.sync_api import sync_playwright

OUT = pathlib.Path("/workspace/FGame/data/epic-discover")
BASE = (
    "https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home"
    "?count=10&country={country}&locale=en&platform={platform}&start=0&store=EGS"
)
COMBOS = [("android", "US"), ("ios", "US"), ("android", "CN"), ("ios", "CN")]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ok = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
        )
        page = ctx.new_page()
        for platform, country in COMBOS:
            url = BASE.format(country=country, platform=platform)
            try:
                res = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(600)
                text = page.inner_text("body") if res and res.ok else ""
                data = json.loads(text)
                modules = data.get("data") or []
                offers = sum(len(m.get("offers") or []) for m in modules)
                path = OUT / f"{platform}-{country}.json"
                path.write_text(json.dumps(data, ensure_ascii=False))
                print(f"{platform}-{country}: HTTP {res.status if res else '?'} offers={offers}")
                ok += 1
            except Exception as exc:  # noqa: BLE001 - keep going, other combos may work
                print(f"{platform}-{country}: FAILED {str(exc)[:120]}")
        browser.close()
    (OUT / "meta.json").write_text(json.dumps({"fetchedAt": int(time.time() * 1000), "okCount": ok}))
    print(f"done, {ok}/{len(COMBOS)} snapshots written to {OUT}")


if __name__ == "__main__":
    main()
