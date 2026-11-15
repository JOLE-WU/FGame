// 由 scripts/find-region-aliases-v2.py + gen-region-aliases.py 生成，勿手改。
// 同一款游戏在各区可能由不同代理单独上架（trackId / bundleId / 名称全不同），
// 这里按 512px 图标的 dHash(256) + pHash(64) 双指纹配对：两者同时进阈值才算同一款。
// 生成时间：2026-11-15T16:46:17+08:00；扫描 147 款国区付费榜 App，共 26 组。

export type RegionAliasGroup = {
  id: string;
  /** cc -> trackId，default 表示其它区通用版本。 */
  members: Record<string, number>;
  label: string;
  /** 图标 dHash(256) 汉明距离，0 表示图标完全同源。 */
  distance: number;
};

export const REGION_ALIAS_GENERATED_AT = "2026-11-15T16:46:17+08:00";

export const REGION_ALIAS_GROUPS: RegionAliasGroup[] = [
  {
    id: "1157863540-640364616",
    members: { cn: 1157863540, hk: 1609910024, tw: 1609910024, jp: 793660476, default: 640364616 },
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
    label: "鬼谷八荒 ↔ Tale of Immortal",
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
    label: "大侠立志传 ↔ Hero's Adventure",
    distance: 0,
  },
  {
    id: "1517349382-1450144092",
    members: { cn: 1517349382, default: 1450144092 },
    label: "群雄时代 - 单机三国战棋策略游戏 ↔ 三國志天下布武 - 單機戰棋策略遊戲",
    distance: 15,
  },
  {
    id: "388627783-388624839",
    members: { cn: 388627783, default: 388624839 },
    label: "扫描全能王-手机扫描仪 & PDF图片转文字 ↔ CamScanner+",
    distance: 2,
  },
  {
    id: "6755228041-6759962259",
    members: { cn: 6755228041, default: 6759962259 },
    label: "潜水员戴夫 ↔ DAVE THE DIVER",
    distance: 0,
  },
  {
    id: "6743148949-6741892043",
    members: { cn: 6743148949, tw: 6749132733, default: 6741892043 },
    label: "盛世天下：女王的游戏 ↔ Road to Empress",
    distance: 19,
  },
  {
    id: "1523446532-1389752090",
    members: { cn: 1523446532, default: 1389752090 },
    label: "重生细胞 ↔ Dead Cells",
    distance: 12,
  },
  {
    id: "1544722749-1596863467",
    members: { cn: 1544722749, default: 1596863467 },
    label: "拣爱 ↔ LoveChoice",
    distance: 11,
  },
  {
    id: "1458460469-1611723264",
    members: { cn: 1458460469, default: 1611723264 },
    label: "人类跌落梦境 ↔ 人類跌落夢境",
    distance: 0,
  },
  {
    id: "982227026-870322730",
    members: { cn: 982227026, default: 870322730 },
    label: "聚爆Implosion ↔ Implosion - Never Lose Hope",
    distance: 0,
  },
  {
    id: "1584313012-1587860402",
    members: { cn: 1584313012, default: 1587860402 },
    label: "笼中窥梦 ↔ Moncage",
    distance: 0,
  },
  {
    id: "1329434099-1438490758",
    members: { cn: 1329434099, default: 1438490758 },
    label: "乱斗堂3 ↔ ChaosFighters3",
    distance: 0,
  },
  {
    id: "6757136435-6757171842",
    members: { cn: 6757136435, default: 6757171842 },
    label: "绿水镇 ↔ Green Pond Town",
    distance: 2,
  },
  {
    id: "1115520522-1376408577",
    members: { cn: 1115520522, default: 1376408577 },
    label: "姬魔恋战纪-单机剧情手游戏 ↔ 姬魔戀戰紀-三國後宮角色扮演回合制策略手遊",
    distance: 0,
  },
  {
    id: "1246083840-1316830864",
    members: { cn: 1246083840, hk: 1448324119, tw: 1448324119, default: 1316830864 },
    label: "荒野日记：孤岛 ↔ Survival: Man vs. Wild",
    distance: 0,
  },
  {
    id: "6466390901-1614771445",
    members: { cn: 6466390901, default: 1614771445 },
    label: "旋转音律 Rotaeno ↔ Rotaeno",
    distance: 0,
  },
  {
    id: "6444508254-1373057849",
    members: { cn: 6444508254, default: 1373057849 },
    label: "汉末霸业 ↔ ThreeKingdoms The Last Warlord",
    distance: 9,
  },
  {
    id: "1159266744-1133737578",
    members: { cn: 1159266744, default: 1133737578 },
    label: "双子 Gemini ↔ Gemini -A Journey of Two Stars",
    distance: 1,
  },
  {
    id: "1626320298-1084860489",
    members: { cn: 1626320298, default: 1084860489 },
    label: "极速变色龙 ↔ Chameleon Run",
    distance: 0,
  },
  {
    id: "6446614518-1269225754",
    members: { cn: 6446614518, default: 1269225754 },
    label: "画中世界 ↔ Gorogoa",
    distance: 1,
  },
  {
    id: "1529075749-1611462012",
    members: { cn: 1529075749, default: 1611462012 },
    label: "重建家园 ↔ 重建家園",
    distance: 0,
  },
  {
    id: "1500683068-1499318054",
    members: { cn: 1500683068, tw: 1499319685, default: 1499318054 },
    label: "南瓜先生2九龙城寨 ↔ Mr Pumpkin 2: Walls of Kowloon",
    distance: 1,
  },
  {
    id: "1579853413-1133544923",
    members: { cn: 1579853413, default: 1133544923 },
    label: "隐藏的家伙 ↔ Hidden Folks",
    distance: 2,
  },
];
