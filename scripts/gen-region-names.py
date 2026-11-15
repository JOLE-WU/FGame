#!/usr/bin/env python3
"""把「iOS应用各区上架名对照表.xlsx」转成服务端可直接 import 的对照数据。

表格一行 = 一个 trackId 在国/美/港/台/日/韩六个区的官方名称，由 Apple lookup 逐区取回。
运行时用途：lookup 打不通的区（海外区尤甚）改成用「该区官方名」而不是中文原名去 search，
中文名直译成英文搜索几乎必失败，这一步把跨区命中率拉起来。

只导出「六区名字并不完全相同」的行，同名行用原名搜即可，不必进包。
空字符串表示该区未上架 / 没有记录。

用法：python3 scripts/gen-region-names.py <xlsx> [out.ts]
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

CCS = ["cn", "us", "hk", "tw", "jp", "kr"]
COL = {"cn": 3, "us": 4, "hk": 5, "tw": 6, "jp": 7, "kr": 8}
ABSENT = "—"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").replace(" ", "").replace("\u3000", "")
    s = re.sub(r"[®™©]", "", s)
    return s.strip().lower()


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "data/region-names.xlsx")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "server/src/data/regionNames.ts")

    import openpyxl
    ws = openpyxl.load_workbook(src, data_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))[1:]

    table: dict[int, list[str]] = {}
    sellers: dict[int, str] = {}
    for r in rows:
        if not r or r[0] is None:
            continue
        try:
            tid = int(str(r[0]).strip())
        except ValueError:
            continue
        names = []
        for cc in CCS:
            v = str(r[COL[cc]] or "").strip()
            names.append("" if v.startswith(ABSENT) else v)
        known = [n for n in names if n]
        if len({norm(n) for n in known}) < 2:
            continue  # 六区同名（或只有一区上架），不需要对照
        table[tid] = names
        seller = str(r[11] or "").strip()
        if seller:
            sellers[tid] = seller

    tz = timezone(timedelta(hours=8))
    # 时间戳取源表 mtime 而不是「现在」：重复执行产出逐字节一致，diff 才干净。
    stamp = datetime.fromtimestamp(src.stat().st_mtime, tz).isoformat(timespec="seconds")
    lines = [
        "// 由 scripts/gen-region-names.py 生成，勿手改。",
        "// 数据来源：iOS应用各区上架名对照表.xlsx（Apple lookup 逐区核验，3448 行 × 6 区 100% 对得上）。",
        "// 一行 = 一个 trackId 在国/美/港/台/日/韩六区的官方名称，空串表示该区未上架。",
        "// 用途：跨区比价时 lookup 打不通的区改用「该区官方名」去 search（国区中文名直搜海外区基本搜不到）。",
        "",
        "export type RegionNameRow = [string, string, string, string, string, string];",
        "",
        "export const REGION_NAME_META = {",
        f'  generatedAt: "{stamp}",',
        f"  scanned: {len(rows)},",
        f"  rows: {len(table)},",
        "  order: [\"cn\", \"us\", \"hk\", \"tw\", \"jp\", \"kr\"] as const,",
        "};",
        "",
        "/** trackId -> [cn, us, hk, tw, jp, kr] */",
        "export const REGION_NAME_TABLE: Record<number, RegionNameRow> = {",
    ]
    for tid, names in table.items():
        arr = ",".join(json.dumps(n, ensure_ascii=False) for n in names)
        lines.append(f"  {tid}: [{arr}],")
    lines.append("};")
    lines.append("")
    lines.append("/** trackId -> App Store 的 sellerName，用来确认「同名」的两条记录是不是同一家发行。 */")
    lines.append("export const REGION_NAME_SELLERS: Record<number, string> = {")
    for tid, seller in sellers.items():
        lines.append(f"  {tid}: {json.dumps(seller, ensure_ascii=False)},")
    lines.append("};")
    lines.append("")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out} rows={len(table)} scanned={len(rows)} size={out.stat().st_size/1024:.0f}KB")


if __name__ == "__main__":
    main()
