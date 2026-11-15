// 由 scripts/find-region-aliases.py 生成，勿手改。
// 同一款游戏在各区可能由不同代理单独上架（trackId / bundleId / 名称全不同），
// 这里按图标 dHash 配对，运行时把「国区版」「港台版」「日版」「国际版」认成同一款。
// 生成时间：2026-11-15T14:58:50+08:00；共 7 组（dHash 距离 ≤ 2）。

export type RegionAliasGroup = {
  id: string;
  /** cc -> trackId，default 表示其它区通用版本。 */
  members: Record<string, number>;
  label: string;
  /** 图标 dHash 汉明距离，0 表示图标完全同源。 */
  distance: number;
};

export const REGION_ALIAS_GENERATED_AT = "2026-11-15T14:58:50+08:00";

export const REGION_ALIAS_GROUPS: RegionAliasGroup[] = [
  {
    id: "1157863540-640364616",
    members: { cn: 1157863540, default: 640364616, hk: 1609910024, jp: 793660476, tw: 1609910024 },
    label: "泰拉瑞亚 ↔ Terraria",
    distance: 0,
  },
  {
    id: "6757729278-1631859420",
    members: { cn: 6757729278, default: 1631859420 },
    label: "劫后公司 ↔ After Inc.",
    distance: 0,
  },
  {
    id: "6737795387-6742472194",
    members: { cn: 6737795387, default: 6742472194 },
    label: "鬼谷八荒 ↔ 鬼谷八荒 Tale of Immortal",
    distance: 0,
  },
  {
    id: "6443786927-6743115658",
    members: { cn: 6443786927, default: 6743115658 },
    label: "全面憨憨战争模拟器 ↔ TABS Pocket Edition",
    distance: 0,
  },
  {
    id: "6502489827-6711347049",
    members: { cn: 6502489827, default: 6711347049 },
    label: "大侠立志传 ↔ 大俠立志傳",
    distance: 0,
  },
  {
    id: "1517349382-1450144092",
    members: { cn: 1517349382, default: 1450144092 },
    label: "群雄时代 - 单机三国战棋策略游戏 ↔ 三國志天下布武 - 單機戰棋策略遊戲",
    distance: 1,
  },
  {
    id: "388627783-388624839",
    members: { cn: 388627783, default: 388624839 },
    label: "扫描全能王-手机扫描仪 & PDF图片转文字 ↔ CamScanner+",
    distance: 2,
  },
];
