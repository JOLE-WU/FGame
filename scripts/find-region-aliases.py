#!/usr/bin/env python3
"""
建「同一款游戏在各区各有一个 SKU」的对照表。

背景：Apple 的 trackId 在同一个 App 的各 storefront 之间共享，但国服/日服/港台
常由不同代理单独上架——bundleId、开发者、名称全不同（「泰拉瑞亚」「泰拉瑞亞」
「テラリア」「Terraria」）。只看名字永远配不上，但各版用的是同一套美术资源，
所以用图标指纹（dHash）来配对。

两步：
  A. 国区榜单 × 海外榜单 图标碰撞，找到国际版（members.default）。
  B. 对每个区先 lookup 国际版；查不到的区，用「国区名 + 国际版名」搜索该区，
     再按图标指纹认领当地的独立上架版本（members[cc]）。

产出：server/src/data/regionAlias.ts（运行时读）、region-alias.json（人可读）。

用法：python3 scripts/find-region-aliases.py [--limit 100] [--max-dist 6]
"""
import argparse
import io
import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_TS = ROOT / "server" / "src" / "data" / "regionAlias.ts"
OUT_JSON = ROOT / "server" / "src" / "data" / "region-alias.json"

CN = "cn"
GLOBAL_CHARTS = ["us", "jp", "hk", "tw", "kr", "sg", "gb", "ca", "au", "in"]
TARGETS = ["cn", "hk", "tw", "jp", "kr", "sg", "us", "gb", "ca", "au", "in", "tr", "ng", "eg"]

UA = {"User-Agent": "Mozilla/5.0"}

GENRE_ZH = {
    "游戏": "Games", "动作": "Action", "冒险": "Adventure", "角色扮演": "Role-Playing",
    "策略": "Strategy", "模拟": "Simulation", "益智": "Puzzle", "竞速": "Racing",
    "体育": "Sports", "卡牌": "Card", "棋盘": "Board", "街机": "Arcade",
    "家庭": "Family", "文字": "Word", "教育": "Education", "音乐": "Music",
    "工具": "Utilities", "娱乐": "Entertainment", "效率": "Productivity",
    "摄影与录像": "Photo & Video", "生活": "Lifestyle", "健康健美": "Health & Fitness",
    "财务": "Finance", "购物": "Shopping", "美食佳饮": "Food & Drink",
    "旅游": "Travel", "导航": "Navigation", "新闻": "News", "图书": "Books",
    "参考": "Reference", "商务": "Business", "医疗": "Medical", "社交": "Social Networking",
    "软件开发工具": "Developer Tools", "图形和设计": "Graphics & Design",
}


def fetch_json(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def fetch_bytes(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def _app(x, cc):
    return {
        "trackId": x["trackId"],
        "name": x.get("trackName", ""),
        "artist": x.get("artistName", ""),
        "bundle": x.get("bundleId", ""),
        "price": x.get("formattedPrice"),
        "art": x.get("artworkUrl100"),
        "cc": cc,
    }


def lookup(track_id, cc):
    try:
        res = fetch_json(f"https://itunes.apple.com/lookup?id={track_id}&country={cc}")["results"]
    except Exception:
        return None
    return _app(res[0], cc) if res else None


def search(term, cc, limit=8):
    url = f"https://itunes.apple.com/search?term={urllib.parse.quote(term)}&country={cc}&entity=software&limit={limit}"
    try:
        return [_app(x, cc) for x in fetch_json(url)["results"]]
    except Exception:
        return []


def chart(cc, kind, limit=100):
    url = f"https://itunes.apple.com/{cc}/rss/top{kind}applications/limit={limit}/json"
    data = fetch_json(url)
    out = []
    for e in data.get("feed", {}).get("entry", []):
        try:
            tid = int(e["id"]["attributes"]["im:id"])
        except (KeyError, TypeError, ValueError):
            continue
        images = e.get("im:image") or []
        out.append(
            {
                "trackId": tid,
                "name": e["im:name"]["label"],
                "artist": e.get("im:artist", {}).get("label", ""),
                "genre": e.get("category", {}).get("attributes", {}).get("label", ""),
                "price": e.get("im:price", {}).get("label", ""),
                "art": images[-1]["label"] if images else None,
                "cc": cc,
            }
        )
    return out


def dhash(img, size=8):
    """64 位差值哈希：灰度 + 相邻像素比较，对缩放/压缩很稳。"""
    g = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | (1 if px[base + col] > px[base + col + 1] else 0)
    return bits


def distance(a, b):
    return bin(a ^ b).count("1")


def attach_hashes(apps, workers=12):
    def one(app):
        if not app.get("art"):
            return None
        try:
            return dhash(Image.open(io.BytesIO(fetch_bytes(app["art"]))))
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for app, h in zip(apps, pool.map(one, apps)):
            app["hash"] = h
    return [a for a in apps if a.get("hash") is not None]


def dedupe(apps):
    seen, out = set(), []
    for a in apps:
        if a["trackId"] in seen:
            continue
        seen.add(a["trackId"])
        out.append(a)
    return out


def name_terms(cn_name, intl_name):
    """搜索关键词：国区原名 + 国际版主名（去掉副标题）。"""
    terms = []
    for raw in (cn_name, intl_name):
        if not raw:
            continue
        terms.append(raw)
        base = raw.split(":")[0].split("：")[0].split(" - ")[0].strip()
        if len(base) >= 2 and base != raw:
            terms.append(base)
    out = []
    for t in terms:
        if t not in out:
            out.append(t)
    return out[:3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100, help="每个区榜单抓取条数")
    ap.add_argument("--max-dist", type=int, default=6, help="dHash 最大汉明距离（>2 只进候选）")
    args = ap.parse_args()
    trusted_max = 2

    print(f"① 拉取国区榜单（付费 + 免费，各 {args.limit}）…")
    cn_apps = []
    for kind in ("paid", "free"):
        try:
            cn_apps.extend(chart(CN, kind, args.limit))
        except Exception as e:
            print(f"  跳过 cn/{kind}: {e}", file=sys.stderr)
    cn_apps = dedupe(cn_apps)
    print(f"  国区 {len(cn_apps)} 个 App")

    print("② 拉取海外榜单作为配对池…")
    global_apps = []
    for cc in GLOBAL_CHARTS:
        for kind in ("paid", "free"):
            try:
                global_apps.extend(chart(cc, kind, args.limit))
            except Exception as e:
                print(f"  跳过 {cc}/{kind}: {e}", file=sys.stderr)
    global_apps = dedupe(global_apps)
    print(f"  海外 {len(global_apps)} 个 App")

    print("③ 下载图标并计算 dHash…")
    cn_apps = attach_hashes(cn_apps)
    global_apps = attach_hashes(global_apps)
    print(f"  有效图标：国区 {len(cn_apps)} / 海外 {len(global_apps)}")

    print("④ 图标碰撞，找国际版…")
    pairs = []
    for c in cn_apps:
        best, best_d = None, 99
        for g in global_apps:
            if g["trackId"] == c["trackId"]:
                continue
            d = distance(c["hash"], g["hash"])
            if d < best_d:
                best_d, best = d, g
        if best is None or best_d > args.max_dist:
            continue
        pairs.append({"cn": c, "global": best, "distance": best_d, "members": {CN: c["trackId"]}})
    trusted = [p for p in pairs if p["distance"] <= trusted_max]
    print(f"  候选 {len(pairs)} 组，其中距离 ≤{trusted_max} 的 {len(trusted)} 组")

    print("⑤ 逐区寻找当地的独立上架版本…")
    for pair in trusted:
        cn, gl = pair["cn"], pair["global"]
        pair["members"]["default"] = gl["trackId"]
        found = {}
        for cc in TARGETS:
            if cc == CN:
                continue
            if lookup(gl["trackId"], cc):
                continue  # 国际版在该区能直接查到，不需要别名
            for term in name_terms(cn["name"], gl["name"]):
                cands = [x for x in search(term, cc) if x["trackId"] not in (cn["trackId"], gl["trackId"])]
                cands = attach_hashes(cands, workers=6)
                hit, hit_d = None, 99
                for x in cands:
                    d = distance(cn["hash"], x["hash"])
                    if d <= trusted_max and d < hit_d:
                        hit, hit_d = x, d
                if hit:
                    found[cc] = hit
                    break
        pair["variants"] = found
        for cc, app in found.items():
            pair["members"][cc] = app["trackId"]
        detail = " ".join(f"{cc}:{app['name'][:10]}" for cc, app in found.items())
        print(f"  {cn['name'][:16]:16s} ↔ {gl['name'][:22]:22s} {detail}")

    stamp = datetime.now().astimezone().isoformat(timespec="seconds")

    def ts_entry(p):
        members = ", ".join(f'{k}: {v}' for k, v in sorted(p["members"].items()))
        label = f'{p["cn"]["name"]} ↔ {p["global"]["name"]}'
        return (
            "  {\n"
            f'    id: "{p["cn"]["trackId"]}-{p["global"]["trackId"]}",\n'
            f"    members: {{ {members} }},\n"
            f'    label: {json.dumps(label, ensure_ascii=False)},\n'
            f'    distance: {p["distance"]},\n'
            "  },"
        )

    lines = [
        "// 由 scripts/find-region-aliases.py 生成，勿手改。",
        "// 同一款游戏在各区可能由不同代理单独上架（trackId / bundleId / 名称全不同），",
        "// 这里按图标 dHash 配对，运行时把「国区版」「港台版」「日版」「国际版」认成同一款。",
        f"// 生成时间：{stamp}；共 {len(trusted)} 组（dHash 距离 ≤ {trusted_max}）。",
        "",
        "export type RegionAliasGroup = {",
        "  id: string;",
        "  /** cc -> trackId，default 表示其它区通用版本。 */",
        "  members: Record<string, number>;",
        "  label: string;",
        "  /** 图标 dHash 汉明距离，0 表示图标完全同源。 */",
        "  distance: number;",
        "};",
        "",
        f"export const REGION_ALIAS_GENERATED_AT = {json.dumps(stamp)};",
        "",
        "export const REGION_ALIAS_GROUPS: RegionAliasGroup[] = [",
    ]
    lines += [ts_entry(p) for p in trusted]
    lines += ["];", ""]
    OUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")

    OUT_JSON.write_text(
        json.dumps(
            {
                "generatedAt": stamp,
                "trusted": len(trusted),
                "groups": [
                    {
                        "distance": p["distance"],
                        "cn": p["cn"],
                        "global": p["global"],
                        "members": p["members"],
                        "variants": {
                            cc: {k: v for k, v in a.items() if k != "hash"}
                            for cc, a in p.get("variants", {}).items()
                        },
                        "label": f'{p["cn"]["name"]} ↔ {p["global"]["name"]}',
                    }
                    for p in pairs
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"\n写入 {OUT_TS.relative_to(ROOT)}：{len(trusted)} 组（另有 {len(pairs) - len(trusted)} 组低置信候选）")
    for p in trusted:
        print(f"  d={p['distance']:2d}  {p['cn']['name'][:24]:24s} ↔ {p['global']['name'][:34]:34s} members={len(p['members'])}")
    low = [p for p in pairs if p["distance"] > trusted_max]
    if low:
        print("\n低置信候选（未启用，供人工复核）：")
        for p in low[:12]:
            print(f"  d={p['distance']:2d}  {p['cn']['name'][:24]:24s} ↔ {p['global']['name'][:34]}")


if __name__ == "__main__":
    main()
