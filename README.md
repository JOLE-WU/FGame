# FGame · 限免日报（iOS App）

把原来的「白嫖空间 / 游戏应用限免推送」Web Space 改造成可打包成 **iOS App（IPA）** 的自包含工程。App 名称 **FGame**，图标为深蓝底白色发光闪电。

> 原始源码是 WorkBuddy「TS Space」：React 前端 + Bun server actions + Drizzle/SQLite，
> 依赖闭源的 `@hatch/space-sdk`（私有 tarball，公网 CI 拿不到）。本项目用一层
> 开源等价实现替换了它，因此可以在任意 Node 环境构建、在 GitHub Actions 上打包。

---

## 一、本次 4 项需求

| # | 需求 | 实现 |
|---|------|------|
| 1 | **Epic / GOG 登录像小黑盒一样自动回连** | 原生 iOS 壳内嵌 WKWebView 打开官方登录页，注入脚本在成功页自动抓取授权码并回传，`epicLogin`/`gogLogin` 自动完成绑定 —— **无需复制粘贴**。见下方「自动回连原理」。Web 端保留原弹窗+剪贴板流程作兜底。 |
| 2 | **iOS 限免按区服推荐：国 / 美 / 日 / 印度 / 港区** | 服务端对每个候选用 Apple 官方 iTunes Lookup 在 5 个 storefront 分别核验 `price === 0`，把真正免费的区服写入 `deals.regions`；APP 页新增区服切换，按区过滤、按区生成领取链接、卡片显示区服徽标。选择记在 localStorage。 |
| 3 | **云服务卡片改长条** | `CloudCard` 从 16:9 大方块封面改为「左侧方形品牌板 + 右侧标题/平台/价格/时间」的横向长条。 |
| 4 | **命名 FGame + 图标** | `appName`/`CFBundleDisplayName` = FGame；`assets/app-icon-1024.png` 为裁好的闪电图标（去水印/白边），已放进 iOS `AppIcon.appiconset`。 |
| 5 | **iOS 内购限免检测 + 卡片标签区分** | 两层：① 发现层扫 AppRaven 的 `appByITunesId`（一次请求拿到一个 App 全部内购的 `priceTier`，0 = 免费），候选池由 5 种排序各 20 页 + AppRaven 变价/新上架/更新流 + Apple 各区 top-free 榜单拼成（约 2300 个，`scripts/iap-scan-loop.sh` 每小时轮转 400 个）；② 核验层抓 Apple 官方应用页，页面内嵌 JSON 的「App内购买」区块给出每个内购的当前价（`¥0.00` / `¥198.00`），只有 Apple 也标 0 才收录。价格历史存 `data/iap-price-history.json`：见过收费再变 0 标「内购限免」（带原价），首次观察到的 0 元标「内购 0 元」，连续 10 天都是 0 就下架。与本体限免的区分：`iosfree-*`（tags `ios`，薄荷绿区服徽标）vs `iosiap-*`（tags `ios,iap`，紫色「内购限免」徽标）；同一个 App 两样都中时合并到本体限免那一行，不产生重名卡片。 |
| 6 | **应用页四类筛选 + 关注** | 顶部 chips：`全部 / 本体 / 内购 / 降价 / 关注`（短名是为了 390px 一排放得下，全称在 aria-label 与区块标题里）。「关注」= 收藏过的条目：本体限免与内购限免复用详情页同一颗「收藏」（`marks` 表，跨设备、按账号），降价 App 不是 deal、没有 marks 行，存在本机 `localStorage.fgame-watch-tracks`（trackId 列表，换设备会丢但不会串号）。列表每行右侧有星标可一键关注；关注页不受区服切换与「隐藏已领」影响，各分区按收藏情况动态出现或隐藏。 |
| 7 | **游戏库自动已领 + 右滑返回 + 游戏页筛选** | `listDeals` 把「库里已有」的游戏条目直接按 `claimed=true` 返回（只改显示字段，不写 `marks` 表；Prime 领取队列仍按 `inLibrary` 单独判断），所以一级页面卡片显示「已领取」、「隐藏已领」也能把它们藏掉。详情页支持从左侧起手右滑 96px 关闭（避开 `.overflow-x-auto` 截图画廊，纵向滚动优先）。游戏页补第二行筛选：`全部 / 隐藏已领 / 不感兴趣 / 收藏 / 未领`，与首页共用全局筛选状态，计数只算游戏。 |
| 8 | **应用页接入 App Store 全库搜索** | 搜索框原来只过滤本站已收录的 `deals` / `app_price_snapshots`，输入清单外的应用名会三个区块全空、五个 chip 计数全变 0，看起来像整页没数据。现新增服务端 `searchAppStore`，代理 Apple 官方 iTunes Search API（`country` 跟随区服切换、`limit=25`、12s 超时、5 分钟内存缓存），返回图标 / 名称 / 开发者 / 类型 / 现价 / 评分 / 商店链接，并按 `trackId` 与本站 `deals`（`iosfree-*` / `iosiap-*`）、`app_watch`、`app_price_snapshots` 交叉标记「本体限免 / 内购限免 / 降价」徽标。前端在搜索词 ≥2 字时于清单上方新增「App Store 全库」区块，点击直达官方商店页；chip 计数改为只受隐藏开关影响、不再随关键词归零；三个空状态文案区分「搜索无匹配」与「数据为空」。 |
| 9 | **Steam 游戏库封面改竖版** | 库同步原先用 `header.jpg`（460×215 横版横幅），在 3:4 竖版网格里被 `object-cover` 裁成中间一条。改用 Steam 官方 `library_600x900_2x.jpg`（600×900），`listLibrary` 读取时归一化历史横版链接，数据库里 125 条记录全部迁移；4 款官方确无竖版资产的应用回退到设计占位图，ARK 用 1x 竖版。 |
| 10 | **区服快捷切换 + 全库搜索结果可关注** | 区服切换行从「本体限免」区块内部移到搜索框正下方（任何筛选 chip 下都可见），切区服同时作用于「本体限免」与 `searchAppStore` 的 `country`，即全库检索范围也跟着变。App Store 全库结果每行新增 ☆ 关注：这些结果不是 deal、没有 `dealId` 可写 `marks`，所以把完整条目存本机 `localStorage.fgame-store-watch`（与降价关注同一取舍，换设备不同步但不会串号）；「关注」页新增「关注的应用」区块回看、可取消关注，关注 chip 计数也包含它们。星标按钮在 `<a>` 内用 `preventDefault` 阻止跳转，只切换关注。 |
| 11 | **搜索框一键清除** | 应用页「搜索应用」与首页「搜索羊毛」两个输入框右侧新增圆形 ✕ 清除按钮（`SearchClearButton`，仅在有输入时渲染，输入框加 `pr-10` 预留空间）。点击后清空关键词并立即把焦点还给输入框，可直接输入开始下一次搜索；应用页清空后「App Store 全库」区块按 `q.length >= 2` 条件自动收起、chip 计数恢复，不会残留上一次的搜索结果。 |
| 12 | **验库超时修复 + 取消 Epic 手游标签 + Epic 领取直达结算页** | ① `verifyBatchClaim` 结束队列前会重新同步绑定平台的官方库（实测 Epic 771 款约 33s），却没在客户端 `SLOW_ACTIONS` 白名单里，20s 就被 `AbortSignal.timeout` 掐断、报「连接 FGame 服务超时」；把它加入白名单（120s），等待文案也注明约需半分钟到一分钟。② 游戏页删掉 `epic-mobile` 平台 chip 与「Epic 手游」独立小节，手游条目并入「Epic / 全部」，卡片仍保留「手游版 安卓/iOS」属性标签。③ Epic 的 `purchase?offers=…` 结算页要求同一浏览器已登录 Epic，未登录会报 `Account id is missing` 或被导向 PC 商店页；详情页与一键入库队列的主 CTA 改走 `epicgames.com/id/login?redirectUrl=<结算页>`（已登录立即回结算页，未登录登完自动回），并保留「已登录 Epic？直接打开结算页」次要入口与提示文案。**（③ 的 redirectUrl 方案后经实测在 iOS 上不回跳，已在第 13 行推翻重做。）** |

| 13 | **Epic 手游领取彻底修复：结算页直达 + PC/手游已领区分** | 上一轮的 `id/login?redirectUrl=<结算页>` 在 iOS WKWebView / 系统浏览器登录后不回跳，落到 Epic PC 商店首页的游戏列表，即「点进去还是 PC 端游戏」。小黑盒「一键领取」的真相（官方帖子核实）：主按钮就是 `store.epicgames.com/purchase?offers=1-<ns>-<offerId>` 结算页本身（安卓、iOS 各一个 offer，可合并），登录是**独立的第 1 步**用 `/id/login/guided`（登录态留在同一浏览器），登录后再点结算页下 0 元单。前端据此改回：详情页与队列页主 CTA 直接 `deal.claimUrl`（结算页），次要按钮改为不带 redirectUrl 的独立登录入口，文案改成「先登录→再点结算页→核对 0 元→下订单→页面变黑即成功」。另修「领了 PC 版却显示手游已领」：① `listDeals` 的 `inLibraryIds` 原来只按归一化标题匹配库行、不看设备标记，PC 版 Knightica 会把所有同名含 Android/iOS 的条目点亮成「已领取」；现按 `libraryItems.device_platforms` 拆出 `libMobileTitles`，手游 deal（`epic-mobile-*`/`(Mobile)`/全 android+ios offers/`手游版`字样）只认带 `mobile` 标记的库行，与 `verifyBatchClaim` 的验库规则一致。② GamerPower 会把 Epic 官方当周免费游戏重复收录成 `… (Epic Games) Giveaway`、platform 乱带 Android/iOS（被前端标成「手游」），其 `open_giveaway_url` 只跳 PC 商店页、又因同名被 PC 库点亮「已领取」；`listDeals` 现过滤掉与在架官方 `epic-*`（PC）同名的这类 GP 重复赠礼，`visibleRows` 同时用于 deals、inLibrary 与 stats。浏览器实测：假手游重复条目消失、PC/手游设备区分三组对照全通过、真手游 deal 详情页主 CTA 为带双 offer 的结算页且含独立登录与「只领安卓/iOS」按钮。 |

### 自动回连原理（为什么必须做成原生 App）
Epic 登录页带 `X-Frame-Options: SAMEORIGIN` 与 `COOP: same-origin`，浏览器页面**既不能 iframe 嵌入、也读不到跨域弹窗的 URL/内容**，Epic 也从不 postMessage 授权码 —— 所以纯 Web 版只能让用户复制粘贴。小黑盒 / Heroic 这类原生 App 用内嵌 WKWebView 可以监听导航与页面内容，这正是原生壳能自动化的原因。

链路：
```
点「打开 Epic/GOG 官方登录页」
  → fgame://oauth 深链 → AppDelegate 弹出原生 WKWebView（登录页）
  → 注入的 detector 脚本在成功页抓到 code
  → CustomEvent('fgameOAuthCode') 回到 Capacitor 主 WebView
  → auth-bridge.ts → 复用 epicLogin/gogLogin 动作自动绑定
```
代码：`ios-overrides/App/App/AppDelegate.swift`、`client/src/auth-bridge.ts`、`client/src/App.tsx`（`PlatformLoginPanel`）。

---

## 二、目录结构

```
client/           React 前端（App.tsx = 全部 UI；sdk-shim = 开源 RPC/Query 兼容层）
server/           Node HTTP 服务（better-sqlite3 + Drizzle），暴露 /actions RPC
  src/actions.ts  原 Space 的业务逻辑（41 个 action，含限免同步/账号/验库）
  src/index.ts    HTTP 服务：POST /actions、/blobs、/health、静态托管
  src/db.ts       SQLite + 迁移
  src/sdk-shim.ts defineAction / Ctx / z 的开源实现
drizzle/          SQL 迁移（新增 0013_add_deal_regions.sql）
ios-overrides/    Capacitor iOS 模板的覆盖文件（AppDelegate、Info.plist、图标）
scripts/          prepare-ios.mjs：把覆盖应用到生成的 iOS 工程并配签名
.github/workflows/build-ipa.yml   macOS 上编译 IPA 的 CI
capacitor.config.ts              Capacitor 配置
```

---

## 三、本地运行（Web）

```bash
npm install                 # 安装依赖（含 server 子 workspace）
npm run build               # 构建前端到 client/dist
npm run server              # 启动后端 :8787（自动执行迁移）
# 另开一个终端做前端开发：
npm run dev                 # Vite :5173
```
后端还可同时托管前端产物：`FGAME_WEB_DIR=./client/dist npm run server`，然后访问 `http://localhost:8787`。

也可以用 Docker（需要 CI 或已构建好 `client/dist`）：
```bash
docker build -f server/Dockerfile -t fgame .
docker run -p 8787:8787 -v fgame-data:/data -e FGAME_PUBLIC_ORIGIN=https://你的域名 fgame
```

---

## 四、打包成 IPA（重要：请先看这里）

**iOS App 只能在 macOS + Xcode 上编译和签名。** 当前构建环境是 Linux，无法直接产出可安装的 IPA；因此本项目用 **GitHub Actions 的 macOS runner** 来打包，产物为 workflow 的 artifact。

### 两种 IPA
| 类型 | 是否需要 Apple 开发者账号 | 用途 |
|------|--------------------------|------|
| **未签名 IPA**（每次 push / 手动触发都产出） | 否 | 用 AltStore / Sideloadly / TrollStore 侧载，或本地用免费 Apple ID 重签 |
| **签名 IPA**（配置证书后产出） | 是（$99/年） | 直接安装到设备 / TestFlight |

### 触发打包
代码推到 GitHub 后，`.github/workflows/build-ipa.yml` 会在 `main`/`master` 的 push 时自动运行，也可在 Actions 页手动 `Run workflow`。产物 `FGame-IPA` 里包含 `FGame-unsigned.ipa`（若配置了签名证书还会多一个 `FGame-signed.ipa`）。

### 配置签名（可选，用于签名 IPA）
在仓库 `Settings → Secrets and variables → Actions` 添加：

- **Secrets**：`APPLE_CERTIFICATE_P12`（.p12 的 base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_PROVISIONING_PROFILE`（.mobileprovision 的 base64）、`APPLE_TEAM_ID`、`PROVISIONING_PROFILE_UUID`
- **Variables**：`FGAME_BUNDLE_ID`（需与描述文件匹配，默认 `com.fgame.daily`）、`FGAME_API_BASE`（**必填**：已部署的后端地址）、`EXPORT_METHOD`（development / ad-hoc / app-store）

### 后端必须先部署
iOS App 的前端是打进包里的，但 `/actions` 数据请求要访问一个**公网后端**。打包前把 `FGAME_API_BASE` 设为已部署的后端 URL（第三节的 Docker/Node 服务）。CORS 已全开，WKWebView 可跨域调用。

### 本地（Mac）自己打
```bash
npm install
VITE_API_BASE=https://你的后端 npm run build
npx cap add ios
npx cap sync ios
node scripts/prepare-ios.mjs
open ios/App/App.xcworkspace     # 在 Xcode 里选设备/签名，Product → Archive
```

---

## 五、相对原 Space 的降级说明（诚实清单）
独立部署后，以下几项依赖 WorkBuddy 托管能力的功能会**优雅降级**（不报错、不影响主流程）：
- **AI 中英翻译 / 应用介绍润色**：SDK 的 `inference.complete` 无对应开源实现，独立部署时跳过，条目保留英文原文（已有中文翻译的行不受影响）。
- **后台 agent 抓取 Epic 手游 discover 源**：`agent.spawnTask` 降级为 no-op；主抓取仍走直连，直连失败时保留上次数据。
- **定时刷新**：原托管 cron 改为后端可选 `FGAME_AUTO_REFRESH=1` 自轮询。
- **账号 / 验库 / 收藏 / 领取进度**：完全保留（都在 `actions.ts` + SQLite 里）。

---

## 六、安全
- Epic / GOG 授权码与 token 只存在服务端 `accounts` 表，不返回客户端；App 内不出现任何平台密码输入框。
- 授权码兑换走官方 OAuth endpoint，客户端只是把「成功页里的 code」交给服务端，逻辑与原版一致。
- GitHub Token 等密钥仅通过环境变量 / CI Secrets 传入，**不要写进仓库文件**。
