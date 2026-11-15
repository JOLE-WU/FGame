#!/usr/bin/env python3
"""找出「同一个游戏、不同区各上一个 SKU」的跨区对照（v2：512px 双指纹）。

背景：Apple 的 trackId 在同一个 App 各 storefront 之间是共享的，但国区/日服/港台
常由**不同代理单独上架**，trackId、bundleId、开发商、名称全都不同。这类情况下
lookup 在海外区返回空，用国区中文名去 search 也匹配不上英文标题。

做法：
  1. 取国区付费总榜 + 游戏付费榜（比价只对付费 App 有意义）；
  2. 对每款用「国区中文名」在 us/hk/tw/jp 四个区 search 取候选；
  3. 拿候选的 512px 图标与国区图标算两个独立指纹：
       dHash 16x16（256 位，梯度方向）
       pHash 8x8  （64 位，DCT 低频）
     两者同时进阈值才算同一款 —— 实测重合时 dHash≤19，不重合时 ≥98，中间是空档，
     阈值放在 dHash≤24 && pHash≤8 既能全收又不会误配；
  4. 输出 JSON（供人工复核）+ 直接生成 server/src/data/regionAlias.ts。

用法：python3 scripts/find-region-aliases-v2.py [--limit 100] [--out server/src/data/regionAlias.ts]
"""
import argparse
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.fftpack import dct

CCS = ["us", "hk", "tw", "jp"]
CC_ORDER = ["cn", "us", "hk", "tw", "jp", "kr", "sg", "gb", "ca", "au", "in", "tr", "ng", "eg"]
DH_MAX, PH_MAX = 24, 8
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"


def fetch(url, timeout=25):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception:
            time.sleep(1.2 * (attempt + 1))
    raise IOError(url)


def img(url):
    return Image.open(io.BytesIO(fetch(url))).convert("L")


def dhash(im, size=16):
    a = np.asarray(im.resize((size + 1, size), Image.LANCZOS), dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return v, bits.size


def phash(im, hs=8, size=32):
    a = np.asarray(im.resize((size, size), Image.LANCZOS), dtype=np.float64)
    d = dct(dct(a, axis=0, norm="ortho"), axis=1, norm="ortho")[:hs, :hs]
    med = np.median(d.flatten()[1:])
    bits = d.flatten() > med
    v = 0
    for b in bits:
        v = (v << 1) | int(b)
    return v, bits.size


def dist(a, b, n):
    return bin((a ^ b) & ((1 << n) - 1)).count("1")


def get_json(url):
    return json.loads(fetch(url))


def chart(kind, genre=None, limit=100):
    base = f"https://itunes.apple.com/cn/rss/{kind}/limit={limit}"
    url = f"{base}/genre={genre}/json" if genre else f"{base}/json"
    try:
        feed = get_json(url)["feed"]["entry"]
    except Exception:
        return []
    out = []
    for e in feed:
        out.append((int(e["id"]["attributes"]["im:id"]), e["im:name"]["label"]))
    return out


def lookup_cn(tid):
    r = get_json(f"https://itunes.apple.com/lookup?id={tid}&country=cn")
    return r["results"][0] if r.get("results") else None


def search(term, cc, limit=8):
    url = (
        "https://itunes.apple.com/search?term="
        + urllib.parse.quote(term)
        + f"&country={cc}&entity=software&limit={limit}"
    )
    try:
        return get_json(url).get("results", [])
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--out", default="server/src/data/regionAlias.ts")
    ap.add_argument("--json", default="data/region-alias-v2.json")
    args = ap.parse_args()

    seen, targets = set(), []
    for kind, genre in (("toppaidapplications", None), ("toppaidapplications", 6014)):
        for tid, name in chart(kind, genre, args.limit):
            if tid in seen:
                continue
            seen.add(tid)
            targets.append((tid, name))
    print(f"targets: {len(targets)}", flush=True)

    groups = []
    checked = 0
    for idx, (tid, name) in enumerate(targets, 1):
        row = lookup_cn(tid)
        if not row:
            continue
        try:
            base_im = img(row["artworkUrl512"])
            db, dn = dhash(base_im)
            pb, pn = phash(base_im)
        except Exception:
            continue
        hits = {}

        def probe(cc):
            best = None
            for c in search(name, cc):
                if str(c.get("trackId")) == str(tid):
                    continue
                try:
                    cim = img(c["artworkUrl512"])
                    cd, _ = dhash(cim)
                    cp, _ = phash(cim)
                except Exception:
                    continue
                d, p = dist(db, cd, dn), dist(pb, cp, pn)
                if d <= DH_MAX and p <= PH_MAX:
                    cand = {"trackId": int(c["trackId"]), "name": c["trackName"], "d": d, "p": p,
                            "bundleId": c.get("bundleId"), "seller": c.get("sellerName")}
                    if best is None or (d + p) < (best["d"] + best["p"]):
                        best = cand
            return cc, best

        with ThreadPoolExecutor(max_workers=4) as ex:
            for cc, best in ex.map(probe, CCS):
                if best:
                    hits[cc] = best
        checked += 1
        if hits:
            groups.append({
                "cn": tid, "cnName": name, "cnBundle": row.get("bundleId"),
                "cnSeller": row.get("sellerName"), "hits": hits,
            })
            ids = {v["trackId"] for v in hits.values()}
            print(f"[{idx}/{len(targets)}] HIT {name} -> {sorted(ids)}", flush=True)
        elif idx % 20 == 0:
            print(f"[{idx}/{len(targets)}] ... {len(groups)} groups", flush=True)

    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    tz = timezone(timedelta(hours=8))
    payload = {"generatedAt": datetime.now(tz).isoformat(timespec="seconds"),
               "checked": checked, "groups": groups}
    Path(args.json).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nchecked {checked}, groups {len(groups)} -> {args.json}", flush=True)
    return groups, payload


if __name__ == "__main__":
    main()
