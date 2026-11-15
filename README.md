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

| 14 | **Epic 手游限免整段消失修复：快照自愈 + 空结果保护** | 11/13 反馈「Epic 手游限免没有了」。根因链：官方 `egs-platform-service` discover 接口被 Cloudflare 拦（服务端直连恒 403），只能靠 `scripts/epic-discover-snapshot.py` 用 Chromium 抓的 `data/epic-discover/*.json` 快照兜底；但 `epic-discover-cron.sh` 循环 11/9 后死掉且 `watchdog.sh` 没守护它，快照停在上期《巴别塔圣歌》（11/13 00:00 到期）。解析器跳过过期赠送后返回「解析成功但零条」，`buildEpicMobileDeals` 仍判 `ok=true`，`storeEpicMobileDeals` 遂用空集合跑 `expireMissing`，把所有 `epic-mobile-*` 标成 expired；本期新上架的手游限免又没抓到，整段就消失了。修复：① `buildEpicMobileDeals` 零赠送时返回 `ok=false`，`storeEpicMobileDeals` 遇空结果直接 return，绝不因「没抓到数据」清空在架条目；② `watchdog.sh` 增加对快照循环的守护，沙箱重启后自动拉起；③ 快照脚本 4/4 成功后主动调 `saveEpicMobileSnapshot` 立刻入库，不再等 6 小时自动刷新。重抓官方快照后本期《Knightica》手游版（安卓 + iOS，截止 11/20 00:00，国区在列不锁区）已入库，主 CTA 为双 offer 结算页；用户只领了 PC 版（库行 `device_platforms=pc`），手游条目 `claimed/inLibrary` 均为 false，未误标已领。 |

| 15 | **全页下拉刷新** | 五个 tab 通用：页面顶部单指下拉出现胶囊指示器（`下拉刷新 → 松开立即刷新 → 正在刷新… → 已更新 · HH:MM`），内容随手指下移，松手后重新拉取当前页所有 active query（deals / appPrices / library / 搜索结果等），完成后回弹。实现要点：① 独立 iOS WKWebView 里滚动的是 `window`，而 WorkBuddy 空间外壳会把 `[data-generated-space-root]` 钉成固定滚动层，故 `onStart` 同时检查 `window.scrollY` / `documentElement.scrollTop` / `scroller.scrollTop`，避免滚到页面中段误触发（实测该层在独立包里 `scrollHeight === clientHeight`，只看它会恒为 0）；② 触摸移动直接写 DOM `transform/opacity`，不每帧 setState 重渲染整棵树；③ 有 `[role=dialog]` 弹窗（详情右滑返回、Prime 队列、一键入库）或起点在输入框内时不接管，横向拖动按 `dy < |dx| * 1.1` 让回浏览器（chip 行/截图画廊照常横滑，但 masthead 正下方就是 chip 行，不能整块排除）；④ `overscroll-behavior: none` + `passive:false` 的 touchmove `preventDefault` 压住 iOS 橡皮筋。全量源同步仍由日报页右上角 ↻ 负责（可能耗时数十秒，不适合挂在手指下）。CDP 真触摸验证：下拉/阈值/刷新/「已更新」/回弹全通过，横向拖动、非顶部、弹窗内三类负例均不触发。 |

| 16 | **打开 App 页面无法加载：服务自愈 + 容器级自启** | 11/14 反馈「打开 App 页面无法加载」。逐层排查：服务 3000 与公网 `?sharecode=` 链路、OPTIONS 预检（204 / CORS `*`）、证书（有效至 2027-03）、前端五个 tab 全部正常渲染且零 JS/网络错误，IPA 内 `index.html` 与 bundle 引用一致、硬编码 origin/sharecode 正确 —— 唯一异常是**守护进程 watchdog 没在运行**（日志停在 11/13），服务是当天 10:26 才被会话拉起，沙箱休眠/恢复后的空窗期 App 就会白屏或一直转圈。修复：① 注册 supervisord 自启项 `scripts/fgame-supervisor.conf`（`autostart=true`，容器重建时自动拉起 watchdog），`scripts/install-autostart.sh` 负责安装；② watchdog 每轮 `ensure_autostart` 检测运行时目录里的配置丢失即补回，防止 `_run` 目录在沙箱恢复时被重建清空；③ watchdog 加 `flock` 单例锁，并给三处 `setsid` 子循环加 `9>&-` **关闭锁 fd 继承** —— 否则旧守护被杀后子循环仍持有 fd 9，新实例永远抢不到锁而静默退出（实测已修）。回归：删除自启配置后守护在 30s 内自动补回且逐字节一致；watchdog 存活、IAP 扫描与 Epic 快照循环均在，公网 `listDeals` 返回 176 条。属纯服务端/运维修复，**不需要出包**。 |

| 17 | **开代理/VPN 加载失败：可诊断的错误提示** | 用户反馈「开了代理加载失败，但代理联网正常」。排查确认：公网服务部署在腾讯云北京 CLB（`49.233.240.214`），服务端对 `X-Forwarded-For` / `Via` 等代理特征头、HTTP/1.1 降级、CORS 预检均正常响应（200 / 204），说明请求根本没到服务端 —— 设备全局代理把国内域名路由到境外出口后不可达，属于客户端网络环境问题，服务端无法修复。但原「加载失败」卡片**只显示标题 + 重试按钮，不显示错误原因**，用户无从判断。改动：① `App.tsx` 重试卡片透出 `dealsQuery.error.message`；② `sdk-shim.tsx` 在 fetch 失败 / 超时 / 返回非 JSON（代理拦截页）三类错误里追加可操作提示「若开启代理 / VPN，请把 `*.workbuddy.host` 加入直连（DIRECT）规则或暂时关闭代理；本服务部署在国内，走境外代理常超时或被拦截」。断网模拟实测 2 秒内显示完整提示。用户侧规则示例：Clash `DOMAIN-SUFFIX,workbuddy.host,DIRECT`；Surge / Shadowrocket `DOMAIN-SUFFIX,workbuddy.host,DIRECT`；Quantumult X `host-suffix, workbuddy.host, direct`。纯前端改动，Web 立即生效，装在 IPA 里需出包。 |

| 18 | **APP 页三个切换板块：限免情报 / 排行榜 / Apple Arcade** | 应用页顶部新增三个切换页。① **限免情报**＝原 APP 页全部内容，一行未改（筛选 chips、全库搜索、区服、关注照旧）。② **排行榜**：按区服（国 / 美 / 日 / 港 / 印度）、内容（软件 / 游戏）、榜单（免费 / 付费）切换，游戏额外支持 13 个 App Store 官方分类（动作 / 冒险 / 街机 / 棋盘 / 卡牌 / 益智 / 竞速 / 角色扮演 / 模拟 / 体育 / 策略 / 文字）。数据源用 Apple **v1 iTunes RSS**（`itunes.apple.com/{cc}/rss/{topfree\|toppaid}applications/limit=N[/genre=G]/json`）：实测 Marketing Tools v2 的 `?genre=` 参数不生效（带 6014 仍返回 TikTok / ChatGPT 总榜），而 v1 支持任意 genre 且五个区服都正常，价格按区本地化（¥ / Get / 取得 / ¥2,000）。服务端 `appStoreRanking` 按「区服+类型+榜单+分类」缓存 10 分钟、抓不到时保留上次好数据。③ **Apple Arcade**：无官方清单 API —— `apps.apple.com/arcade` 与官方 story 页在国区都被重定向到 Today（**国区 App Store 未上线 Arcade**），iTunes 元数据也没有 arcade 标记；改为聚合 Apple 官方 Search API 的三个 Arcade 相关检索词，用「无独立售价」精确筛出只能订阅获取的游戏（Arcade 游戏 `formattedPrice`/`price` 均缺失，普通免费游戏返回 `Free`/`0`），标注 `Arcade 原创 / App Store Greats / Arcade 版` 三类，按发行日倒序，实测 188 款，缓存 6 小时。UI 提供搜索、类型筛选、官方 Arcade 专区入口，并明确标注国区不可用。实测：三个 tab 切换、排行榜 5 组筛选（含换区）、Arcade 搜索与类型筛选全部通过，零 JS/网络错误。属前端 + 服务端改动，**服务端已即时生效，但三个新板块必须出新 IPA 才能在 App 里看到**。 |

| 19 | **板块切换条移到「01 / xxx」标题下方** | 反馈「三个切换页和 01/xxx 标题重叠了」。原因：切换条只有 `mt-3`、没有下边距，而板块的 `SectionHead` 是板块根节点的 `:first-child`，`first:mt-0` 让它的上边距归零 —— 于是标题紧贴切换条底边，`leading-none` 的中文衬线字形向上溢出，看起来被切换条「吃掉」了半截。改法：切换条改为由 `AppsPage` 生成、以 `tabs` prop 传给 `RankingBoard` / `ArcadeBoard`，各自插在自己的 `SectionHead` 之后；「限免情报」补一个板块页头 `01 / 限免情报`（`IOS APP FREEBIES`），让三个板块结构一致，内部区块编号顺延为 02 本体 / 03 内购 / 04 降价 / 05 关注。切换条本身加 `mt-1 mb-1`，与标题固定 14px 间距。实测三个板块：标题底 87px → 切换条顶 101px，间距 14px，无重叠、无裁切。 |

| 20 | **「历史限免」独立板块移除，改成 App 详情页内的历史价格曲线** | 反馈「不要历史限免这一栏，我要在限免 App 详情页里看到这个 App 的历史价格曲线」。删掉 APP 页原来的「历史限免」整段（含其筛选与列表），改为在「本体限免 / 排行榜 / Arcade」三个板块点进 App 详情时渲染 `AppPriceHistory`：横轴为抓取日期、纵轴为当地货币价格，实线圆点＝本站每日实测的 Apple 官方价（`app_price_snapshots`），虚线空心点＝收录时记录的原价锚点（只有「原价→当前免费」两点时用它兜底），0 元处画绿色基准带。`realMax === 0`（观测期内一直免费）时不画无信息量的直线，改写「观测期内始终免费」。内购限免条目（`iosiap-*`）不渲染本体曲线，避免把「本体 0 元」曲线贴到内购 App 上误导。 |
| 21 | **App 详情页补齐官方介绍与截图（含大图浏览）** | 详情页新增 `AppStoreProfile`：评分 / 评分人数卡、iPhone 与 iPad 截图画廊（缩略图用 `/460x0w.jpg`，点开走全屏 lightbox，支持 `←` / `→` / `Esc` 翻页）、「详细介绍」全文（默认折叠 5 行，可展开）、版本 / 大小 / 兼容性 / 语言 / 年龄分级等规格表，末尾附「此版本更新」。数据来自新增的服务端 action `appStoreDetail`（Apple iTunes Lookup 直取 `description` / `screenshotUrls` / `averageUserRating` / `fileSizeBytes` 等，`num()` 兼容 Apple 把 `fileSizeBytes` 返回成字符串的情况）。接口失败时降级到本站已有封面 + 收录简介，不留空白卡片。限免、排行榜、Arcade 三处详情共用同一组件。 |
| 22 | **非中文介绍自动补中文译文（覆盖全部区服）** | 日区 / 美区 / 韩区 / 港区等非中文商店的介绍不再直接丢原文：服务端 `appStoreDetail` 先看国区同 `trackId` 是否有 Apple 官方中文（有就直接用，`descZhSource=official`），没有再走有道演示翻译分段机翻（每段 <850 字、最多 6 块并发，`errorCode` 是字符串 `"0"` 需宽松判断），结果按 `appdetail_zh:${country}:${trackId}` 落 `meta` 表复用。`needsTranslation` 改为按假名 / 谚文 / 汉字占比判断——此前「含汉字就算中文」把整篇日文误判成中文，导致日区详情直接显示日文。详情页「详细介绍」给中文 / 原文两个 tab，翻译未完成时先显示原文并挂「正在生成中文翻译」。同一套 `TranslatedIntro` 也接到 Epic / Steam / GOG 游戏详情与游戏库详情，非中文简介一律自动翻译。实测日区 U-NEXT（1039 个中文字）、美区纯英文条目均正常；港区繁体按「已是中文」保留，不做简繁转换。 |
| 23 | **四分类横向切换 + 内购限免跨区服 + 降价进详情 + 底部黑边** | 四条反馈一次改完。① **底部黑边**：滑到底时 WKWebView 下方露出原生底色（录屏可见）。修法是双层兜底——原生 `AppDelegate.installBottomScrim()` 在 WebView 下面铺一块 140pt、颜色跟顶栏同步的底色层，并关掉 `scrollView.bounces / alwaysBounceVertical / alwaysBounceHorizontal`；Web 侧加 `SafeAreaBottomScrim`（`position:fixed; bottom:0; height:env(safe-area-inset-bottom)`，同底栏色）盖住安全区，滚动回弹时不再透出黑条。② **四个分类并排横向切换**：限免情报页内「本体限免 / 内购限免 / 降价 / 关注」改成一行横向 tab（`data-free-tabs`），与上方「限免情报 / 排行榜 / Arcade」两级结构并存；切到内购 / 降价 / 关注时隐藏区服行（这三个分类本身跨区）。③ **内购限免跨区服**：此前只核验国区、且「本轮没扫到就下架」，2000 个候选池一轮只扫 160 个，导致整组反复被清空。改为 `cn` + `us` 双区探针（已知区服再兜 `hk/jp/gb`），`probeIapFree()` 返回 `{hit, conclusive}`，**只下架本轮确证无 0 元项的条目**，抓取被限流（页面缺 `"$kind":"Annotation"`）时直接抛错不写空结论；池子放宽到 `tier === 0 || tier == null`，每轮上限提到 200。④ **降价条目进站内详情**：`PriceRow` 不再直接跳 App Store，改为 `DropDetail`——价格曲线 + 5 行统计（现价 / 原价 / 降幅 / 最低价 / 收录时间）+ 同一套 `AppStoreProfile`，底部才是「加关注 / 在 App Store 打开」。 |

| 24 | **搜索框缩进页头 + 三板块切换条上移到「应用」标题下** | 反馈「搜索框缩小放到标题右侧」「限免/排行榜/Arcade 三个标签页放到应用标题下面」。调整 APP 页信息层级：① 原来独占一行的全宽搜索框改成标题行右侧的小胶囊（`w-45%`、`max-w-186px`、`rounded-full`、11.5px 字），placeholder 缩为「搜索应用 / 全库」，清除按钮仍是 22px 圆钮，输入框右侧留 `pr-8` 不挤压；标题行加 `min-h-[32px]`，切换板块时不会因为搜索框消失而跳动。② 三个板块切换条从「01 / 限免情报」标题下方整段上移到「应用 iOS APPS」标题正下方（`mt-3`），`RankingBoard` / `ArcadeBoard` 不再接收 `tabs` prop，各板块的「01 / xxx」标题回到正文首位，页面层级变成 标题 → 三板块 → 01 板块头 → 四分类 → 区服 → 列表。③ 搜索框只在「限免情报」下出现：它本来就只筛本站条目与 App Store 全库结果，排行榜 / Arcade 各有自己的筛选，避免在那边输入却毫无反应。实测 390×844：「应用」标题 y=18.5–44.5，搜索框 y=16–47（右边缘 368，与标题同一行），三板块条 y=63–100.5，01 标题接在其下；浅/深两套主题无重叠、无裁切，控制台零报错。 |

| 25 | **搜索回车自动收键盘 + APP 页分类行极简化** | 反馈「点键盘确认后键盘不收起，挡住搜索结果」和「红框里的东西都不要，四个板块做成 本体｜内购｜降价｜关注，02/03/04 标题和说明文字也别要」。① 搜索框加 `enterKeyHint="search"` + `onKeyDown`：Enter 且非输入法合成态时 `preventDefault()` 后 `blur()`，WKWebView 立刻收键盘（`isComposing` 时保留，避免中文选字被吞）。实测回车后 `document.activeElement` 从 INPUT 变 BODY。② APP 页去掉整块：`01 / 限免情报` 板块页头、带计数的四格卡片、区服筛选行、每类底下的说明长文案，以及 `02 本体限免 / 03 内购限免 / 04 降价`、关注页四个子标题，统统一行 `本体｜内购｜降价｜关注` 纯文字切换（当前项加 2px 主色下划线，无底色、无计数）。列表直接接在切换行下方。③ 连带清理：`countFree / countIap / countDrop`、`changeRegion` 与相关空态文案里的「切区服」说法；区服不再在界面切换，沿用本设备上次选择（默认国区）。搜索结果的 `00 / App Store 全库` 顺延为 `01`。 |

| 26 | **区服改小下拉 + 搜索结果点进站内详情** | 反馈「按你说的做个下拉切换」「搜索出来的应用游戏点进去也是详情页，现在直接跳转」。① 分类行右侧加一个小胶囊区服下拉（`data-region-select`，原生 `select` + `appearance-none` + 自绘 chevron，11px 字、`ml-auto` 靠右），切换写入 `localStorage.fgame-ios-region`，只影响「本体限免」的筛选口径与全库搜索 storefront；上一版删掉的 `changeRegion` 恢复。② `StoreRow` 新增 `onOpen`：搜索结果与「关注」页里的全库条目点整行进新的 `StoreDetail`（`data-store-detail`），含图标 / 价格 / 类别 / 开发者 / 评分 / 区服、`AppStoreProfile`（官方截图 + 详细介绍 + 中文翻译）与底部「加关注 / 在 App Store 打开」，不再整行直接跳 store。③ 外层用 `div[role=button]` 而不是 `<button>`，避免与卡片内 ☆ 按钮形成非法嵌套；☆ 的 `stopPropagation` 保证点星只关注、不打开详情。实测：「国区」下拉可切到美区/全部区服并落盘；搜索 19 条结果全部可点入，URL 不变、无 popup；点 ☆ 后 `data-store-detail` 计数仍为 0；关注页条目同样可点入；浅/深两套主题控制台零报错。 |

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

### 版本记录（产物 / 文件名 / Info.plist / App 内显示必须一致）
| 版本 | build | 产物文件名 | 内容 |
|------|-------|-----------|------|
| 1.0.12 | 18 | `FGame-v1.0.12-b18-unsigned.ipa` | Arcade 汇总 / 排行榜详情 / 下拉刷新 / 代理提示 |
| 1.0.13 | 19 | `FGame-v1.0.13-b19-unsigned.ipa` | 历史限免曲线、Arcade 详情、排行榜详情进站内 |
| 1.0.14 | 20 | `FGame-v1.0.14-b20-unsigned.ipa` | 价格曲线移入 App 详情、App Store 官方资料、全区服翻译、四分类横切、内购跨区、降价详情、底部黑边（第 20–23 行） |
| 1.0.15 | 21 | `FGame-v1.0.15-b21-unsigned.ipa` | 搜索框缩进「应用」标题右侧、三板块切换条上移到标题下方（第 24 行） |

同一版本号会被 `FGame-version.txt`（commit / 分支 / 构建时间）、`Info.plist` 的 `CFBundleShortVersionString` / `CFBundleVersion`、「我的」页底部 `FGame v1.0.15 (21)` 四路共用，CI 里由 `FGAME_VERSION` / `FGAME_BUILD` 注入，改版本只改这一处输入。

---

## 五、相对原 Space 的降级说明（诚实清单）
独立部署后，以下几项依赖 WorkBuddy 托管能力的功能会**优雅降级**（不报错、不影响主流程）：
- **AI 中英翻译 / 应用介绍润色**：SDK 的 `inference.complete` 无对应开源实现，独立部署时**不做 LLM 润色**；但 App 详情页的中文译文另有链路（国区官方中文 → 有道机翻兜底，见第 21/22 行），不依赖 LLM，照常工作。
- **后台 agent 抓取 Epic 手游 discover 源**：`agent.spawnTask` 降级为 no-op；主抓取仍走直连，直连失败时保留上次数据。
- **定时刷新**：原托管 cron 改为后端可选 `FGAME_AUTO_REFRESH=1` 自轮询。
- **账号 / 验库 / 收藏 / 领取进度**：完全保留（都在 `actions.ts` + SQLite 里）。

---

## 六、安全
- Epic / GOG 授权码与 token 只存在服务端 `accounts` 表，不返回客户端；App 内不出现任何平台密码输入框。
- 授权码兑换走官方 OAuth endpoint，客户端只是把「成功页里的 code」交给服务端，逻辑与原版一致。
- GitHub Token 等密钥仅通过环境变量 / CI Secrets 传入，**不要写进仓库文件**。
