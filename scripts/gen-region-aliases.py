#!/usr/bin/env python3
"""把 v2 扫描结果合并进 server/src/data/regionAlias.ts。

输入：data/region-alias-v2.json（scripts/find-region-aliases-v2.py 产出）
      现有的 regionAlias.ts（保留上一轮人工复核过的分组）
输出：重写 regionAlias.ts

两条硬过滤（都是实测踩出来的）：
  · Apple Arcade 版（名字带 `+`、bundleId 含 applearcade）是订阅制，不是同一个商品，
    价格列会显示为空，必须排除 —— 否则《泰拉瑞亚》日区会被写成 Terraria+。
  · 「专业版 / Pro / HD」这类同厂双版本（金十数据专业版 ↔ 金十数据免费版）图标几乎一样，
    价格口径完全不同，按名字判定排除。
"""
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

SRC_JSON = Path("data/region-alias-v2.json")
OUT_TS = Path("server/src/data/regionAlias.ts")

BLACKLIST = {
    # cn trackId: 原因
    1197275827: "金十数据专业版 配到的是免费版（901284508），付费口径不同",
}


def is_arcade(hit) -> bool:
    name = (hit.get("name") or "").strip()
    bundle = (hit.get("bundleId") or "").lower()
    return name.endswith("+") or "applearcade" in bundle


def pro_only(cn_name: str, alt_name: str) -> bool:
    marks = ("专业版", "Pro", "PRO", "HD", "Plus", "高级版")
    return any(m in cn_name for m in marks) and not any(m in alt_name for m in marks)


def parse_existing(text: str):
    """从现有 TS 里抠出旧分组，保持人工复核过的映射不被覆盖。"""
    groups = {}
    for m in re.finditer(
        r'\{\s*id:\s*"([^"]+)",\s*members:\s*\{([^}]*)\},\s*label:\s*"((?:[^"\\]|\\.)*)",\s*distance:\s*(\d+),?\s*\}',
        text,
    ):
        gid, members_raw, label, distance = m.groups()
        members = {}
        for k, v in re.findall(r'(\w+):\s*(\d+)', members_raw):
            members[k] = int(v)
        cn_id = members.get("cn")
        if cn_id:
            groups[cn_id] = {"id": gid, "members": members, "label": label, "distance": int(distance)}
    return groups


def main():
    data = json.loads(SRC_JSON.read_text(encoding="utf-8"))
    existing = parse_existing(OUT_TS.read_text(encoding="utf-8")) if OUT_TS.exists() else {}

    merged = dict(existing)
    added = 0
    skipped = []
    for g in data["groups"]:
        cn_id = g["cn"]
        if cn_id in BLACKLIST:
            skipped.append((g["cnName"], BLACKLIST[cn_id]))
            continue
        hits = {cc: h for cc, h in g["hits"].items() if not is_arcade(h)}
        hits = {cc: h for cc, h in hits.items() if not pro_only(g["cnName"], h["name"])}
        if not hits:
            continue
        # 每个 trackId 覆盖哪些区，取覆盖最多的作为 default（海外 8 区通用）
        by_id = {}
        for cc, h in hits.items():
            by_id.setdefault(h["trackId"], {"name": h["name"], "ccs": [], "d": h["d"]})["ccs"].append(cc)
        # default 必须是「国际版」：优先美区那个 SKU（海外 8 区通常与美区同版），
        # 只有美区没命中时才退回覆盖区数最多的版本 —— 否则泰拉瑞亚会拿港台版去填欧美区。
        if "us" in hits and hits["us"]["trackId"] in by_id:
            default_id = hits["us"]["trackId"]
            meta = by_id[default_id]
        else:
            default_id, meta = max(by_id.items(), key=lambda kv: len(kv[1]["ccs"]))
        members = {"cn": cn_id, "default": default_id}
        for tid, info in by_id.items():
            if tid == default_id:
                continue
            # 非 default 的版本按区精确落位
            for cc in info["ccs"]:
                members[cc] = tid
        old = existing.get(cn_id)
        if old:
            # 旧分组有的区、新扫描没覆盖到，用旧值补（旧数据经过人工复核）
            for cc, tid in old["members"].items():
                members.setdefault(cc, tid)
        label = f'{g["cnName"]} ↔ {meta["name"]}'
        merged[cn_id] = {
            "id": f'{cn_id}-{default_id}' if not old else old["id"],
            "members": members,
            "label": label.replace('"', "'"),
            "distance": min(h["d"] for h in hits.values()),
        }
        if not old:
            added += 1

    # 输出
    tz = timezone(timedelta(hours=8))
    stamp = datetime.now(tz).isoformat(timespec="seconds")
    order = ["cn", "us", "hk", "tw", "jp", "kr"]
    lines = [
        "// 由 scripts/find-region-aliases-v2.py + gen-region-aliases.py 生成，勿手改。",
        "// 同一款游戏在各区可能由不同代理单独上架（trackId / bundleId / 名称全不同），",
        "// 这里按 512px 图标的 dHash(256) + pHash(64) 双指纹配对：两者同时进阈值才算同一款。",
        f"// 生成时间：{stamp}；扫描 {data['checked']} 款国区付费榜 App，共 {len(merged)} 组。",
        "",
        "export type RegionAliasGroup = {",
        "  id: string;",
        "  /** cc -> trackId，default 表示其它区通用版本。 */",
        "  members: Record<string, number>;",
        "  label: string;",
        "  /** 图标 dHash(256) 汉明距离，0 表示图标完全同源。 */",
        "  distance: number;",
        "};",
        "",
        f'export const REGION_ALIAS_GENERATED_AT = "{stamp}";',
        "",
        "export const REGION_ALIAS_GROUPS: RegionAliasGroup[] = [",
    ]
    for cn_id, g in merged.items():
        keys = [k for k in order if k in g["members"]] + [k for k in g["members"] if k not in order and k != "default"]
        if "default" in g["members"]:
            keys.append("default")
        body = ", ".join(f'{k}: {g["members"][k]}' for k in keys)
        lines.append("  {")
        lines.append(f'    id: "{g["id"]}",')
        lines.append(f"    members: {{ {body} }},")
        lines.append(f'    label: "{g["label"]}",')
        lines.append(f'    distance: {g["distance"]},')
        lines.append("  },")
    lines.append("];")
    lines.append("")
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")
    print(f"groups: {len(merged)} (new {added}, kept {len(existing)}) -> {OUT_TS}")
    for name, why in skipped:
        print(f"  skip {name}: {why}")


if __name__ == "__main__":
    main()
