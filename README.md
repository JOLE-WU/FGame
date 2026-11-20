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

| 27 | **分类行与区服下拉垂直对齐** | 反馈「下拉那个没有和左边的四个板块居中对齐」。四个 tab 原来是 `border-b-2` + `pb-[3px]` + `leading-none`（盒高 18px，但文字被顶到盒子顶部），下拉是 `py-[4px]`（盒高 21px），`items-center` 只对齐盒子，文字中心实际差 2～3px。改成两边都用固定 `h-[18px]`：tab 用 `leading-[18px]` + `after:` 伪元素 2px 下划线（不再靠 padding + border 撑高度），下拉改 `h-[18px] py-0`。实测：四个 tab 文字 rect 与 select 盒 rect 完全一致（117.5–135.5，中线 126.5）；像素扫描「本体」墨迹 36–70、「国区」39–68，中线差 0.5px，是 13px / 11px 字号本身的字面差。下划线离字底 2.7px，切 tab 时跟随且整行不跳动。 |
| 28 | **标题排版统一：三行报头等距、四页大标题同位、按钮归位** | 五条反馈一次改完。① **报头三行等距**：`VOL.xxx ● 每日限免情报` / 「羊毛日报」/ `FREE GAME DAILY` 原来挤在 `items-end` 的一行里、上下间距 10 / 9px 不均；改成 `flex-col` 堆叠 + `gap-2`，实测 14→32、66→74 两段间距都是 8px。② **底线对齐**：应用页的「应用」/`iOS APPS`/搜索框、游戏/云服务/我的的「大标题」/英文副标，统一 `items-end` 让底缘同线；搜索框高度从 31px 收到 26px，否则 `items-end` 会把标题顶下去 5px。③ **四页标题同位置**：修完②后 应用/游戏/云服务/我的 大标题纵坐标全部 `y=16`，切 tab 不再上下跳。④ **取消游戏页「批量入库」**：连带清掉 `menuOpen`、刷新 / 恢复不感兴趣两个按钮与 `refresh` / `clearHidden` mutation（`tsc` 开着未使用变量检查）。⑤ **「同步所有平台」移到「02 / 平台账号」右侧**：塞进 `SectionHead` 的 `right` 槽位；该容器由 `items-end` 改 `items-center`（标题 20px 高、按钮 30px 高，底对齐会差 4px），实测中心差 1px。 |
| 29 | **详情页 App Store 化：用户评价 + 逐条翻译 + 获取/关注 + 开发者页** | 五条反馈一次改完。① **删限免日报右上角「刷新 / 更多」两个圆钮**（保留主题切换），连带移除 `menuOpen`、`refreshMsg`、`refresh`/`clearHidden` mutation 与「今日战报」右侧的同步回报槽。② **所有 App 详情页加用户评价**：服务端新增 `appStoreReviews`（Apple `customerreviews` RSS，按 `trackId+country` 解析 author/title/content/rating/version/updated，缓存 30 分钟；Apple 把字段包成 `{label}`，author 还要再取一层 `author.name`），前端 `AppStoreReviews` 挂在 `AppStoreProfile` 里，限免 / 降价 / 全库搜索 / 排行榜 / Arcade 五处详情共用。③ **评价逐条翻译**：每条带「译」，复用服务端 `translateText`（按文本指纹缓存、异步生成 + 2.5s 轮询），就绪后正文换成中文并挂「中文翻译」标记、「查看原文」可切回；服务端判定「本来就是中文」（`needed:false`）时按钮自动收起，生成失败显示「译（暂不可用，点击重试）」。④ **图标名称右侧加「获取 / ☆关注」**：仿 App Store 竖排双胶囊，`获取` 跳商店（免费显示「获取」、付费显示本地化价格）、`关注` 是 star 切换；`StoreDetail` / `RankingDetail` / `ArcadeDetail` / `DropDetail` 四处统一，同时删掉各页底部重复的固定操作栏与排行榜详情底部那段「数据来自 Apple 官方榜单…」说明。⑤ **开发者名可点**：标题下方新增 `DeveloperLink`（蓝色名称 + `›`），点击进站内 `DeveloperView`，服务端新增 `developerApps`（iTunes `lookup?entity=software` 按 `artistId` 拉全部 App，缓存 30 分钟），列表显示图标 / 名称 / 类别 / 评分 / 价格，点条目直接进该 App 详情。实测美区 TikTok 详情 30 条评价、点「译」13s 后变「优秀的」；抖音开发者页 15 款应用全部可点进详情；`tsc` 与 `vite build` 均通过。 |

| 30 | **外区付费榜补人民币参考价** | 反馈「外区排行榜收费榜，app 原价后面加上人民币价格」。服务端新增 `fxRates`（1 CNY 兑各币种的参考汇率，12 小时缓存；主源 `open.er-api.com/v6/latest/CNY`，失败回落 `api.frankfurter.dev`，再失败用内置静态表且只缓存 30 分钟以便重试；同一时刻只允许一次外网请求，`inflight` 复用）。前端 `cnyApprox` 在列表行与榜单详情「价格」行追加 `≈¥`，列表顶部标一行「≈¥ 为人民币参考价」。只在外区付费榜出现（国区本身是 ¥、免费榜无价）。踩坑：土耳其/欧洲区 `formattedPrice` 是 `₺114,99`，逗号是小数点，原先「删掉非数字」会把 114,99 读成 11499（≈¥1531），改为 `parsePriceAmount` 先判断逗号/点哪个是小数分隔符。实测美区 $6.99≈¥46.8、日区 JP¥1,300≈¥82.8、港区 HK$22≈¥18.8、印度 ₹349≈¥24.8。 |
| 31 | **详情页「各区价格对比」+ 新增土耳其/尼日利亚/埃及区服** | 反馈「付费区的应用或游戏，不论哪个区，点进详情页后加一个不同区价格对比，以换算后人民币比较；区域新增土耳其、尼日利亚、埃及」。① 区服筛选 `RANK_REGIONS` 与服务端 `APP_RANKING_COUNTRIES` 增加 `tr`/`ng`/`eg`，筛选行改为 `wrap` 两行（8 个 chip 横滑会藏住后三个）。② 服务端新增 `appStoreRegionPrices`：按 `trackId` 并发查 14 个 storefront（cn/hk/tw/jp/kr/sg/us/gb/ca/au/in/tr/ng/eg）的 iTunes lookup，取 `price`/`formattedPrice`/`currency`/`trackViewUrl`，每 5 个一批避免限流，按 trackId 缓存 6 小时。③ 详情页 `RegionPriceCompare` 在付费榜（含游戏付费榜、含国区）渲染：按人民币升序，行内 `区码 + 地区名 + 原价 + ≈¥`，最便宜标「最低」、当前区标「当前」并高亮，未上架灰显；顶部一句话结论（最低在埃及 ≈¥2.50，比当前区便宜约 95%）。④ `displayPrice` 修正 Apple 的区域化符号：台湾 `$235` → `NT$235`、日本 `¥1,300` → `JP¥1,300`、加/澳/新分别补 `CA$/A$/S$`，避免和美元/人民币混。实测美区 Minecraft 付费榜详情 14 区齐全（埃及 EGP 20 ≈ ¥2.50 最低、美国 $6.99 ≈ ¥46.8 居第 5），游戏付费榜同样生效，免费榜不显示。 |
| 32 | **跨区同名不同名识别 + 点区进本区详情** | 反馈「同一个游戏在不同区可能用了不同的名字，要找出同一个游戏在所有区的价格对比，并且点某个区直接进入该 App 在该区的详情页」。① Apple 的 `trackId` 是全局唯一的，但标题按 storefront 本地化——实测 Minecraft 在 14 个区就有 4 种写法（`Minecraft`、`Minecraft: Dream it, Build it!`、`Minecraft: クラフト、建築、サバイバル`、`Minecraft 온라인으로 친구들과 함께 플레이하세요`）。`appStoreRegionPrices` 每行补 `trackId`/`name`/`bundleId`/`artistName`/`iconUrl`/`match`，前端在名称与当前区不一致的行加第二行小字显示本区名，并说明「同一款按 trackId / bundleId 认定」。② 新增 `cc`/`name` 入参确定基准名；lookup 为空的区再用 iTunes Search 补一次（最多 4 个区、每区 2 个关键词，避免吃满限流），只认 `bundleId` 相同或标题归一化完全相同，标 `match=alias`「本地版」，不参与最低价比较。踩坑：最初用「标题互相包含」判定，把《泰拉瑞亚》港区搜出来的「攻略秘籍 For 泰拉瑞亚 Terraria」「泰拉瑞亚向导手册」这些第三方攻略 App 也标成了本地版，已收紧为完全相等。③ 点击任意区不再外跳 App Store，而是打开应用内 `RegionAppSheet`：本区名称、本区价格、区服、上架版本（同款 / 本区单独上架）、bundleId，下面直接挂该区的 `AppStoreProfile`（该区截图、介绍、评分、评价与翻译）。层级 `z-50` 叠在榜单详情 `z-40` 之上，Esc 在捕获阶段截住只关最上层。实测日区 Minecraft 详情售价 JP¥1,300、评分 3.9、106,857 个评分，与美区资料完全分开。 |
| 33 | **同一款游戏跨区 SKU 对照表（自动识别）** | 反馈「同一个游戏在不同区可能用了不同的名字，需要一张对照表让 App 自动识别」。根因：Apple 的 trackId 在同一个 App 各 storefront 间是共享的，但国服/日服/港台常由不同代理**单独上架**，trackId、bundleId、开发者、名称全都不同——《泰拉瑞亚》国区 `1157863540` ¥18、港台《泰拉瑞亞》`1609910024`、日区《テラリア》`793660476`，国际版 `640364616`。① 新增 `scripts/find-region-aliases.py`：拉国区付费/免费榜各 100 + 10 个海外区榜单，用**图标 dHash 指纹**（64 位差值哈希）做配对，距离 0 表示同一套美术；先撞出国际版，再逐区 lookup，缺的区用「国区名 + 国际名」搜索并按图标认领当地版本。② 产出 `server/src/data/regionAlias.ts`（7 组，距离 ≤2 才算确定；>2 只写进 `region-alias.json` 供人工复核，实测 d=5 的 AutoSleep↔AutoSnore、d=3 的抖音极速版↔抖音都是误配，已被阈值挡住）。③ 运行时 `appStoreRegionPrices` 建立 `trackId → group` 索引，对 lookup 为空的区用组内 `members[cc] ?? default` 补位，行标 `match=alias` 并带 `aliasOf`（「泰拉瑞亚 ↔ Terraria」）。双向生效：从国区版进去能看到 14 区价格，从国际版进去也能看到国区 ¥18。实测泰拉瑞亚 14 区全有价（国区 ¥18 最低、港区 HK$28≈¥23.88、台区 NT$120≈¥24.34、日区 JP¥800≈¥33.47、美区 $4.99≈¥33.38）。④ 比价规则调整：免费（含内购）的本地版不参与「最低」，有正价的本地版参与排序。 |
| 34 | **导入《iOS应用各区上架名对照表》，跨区检索改按各区官方名** | 用户提供 3,448 行 × 6 区（国/美/港/台/日/韩）的 App Store 上架名对照表，要求核查后导入。① **逐格复核**：按表内每一行的 `App ID` 去 Apple `lookup?country=xx` 重取六区实际标题，20,688 格全部对得上——14,379 个有名字的格逐字一致、6,309 个「—（未上架）」判定全部正确，`上架区域数` 3,448 行无一偏差，`苹果分类` 全对，`开发商` 列就是 Apple 的 `sellerName`（3,302 行国区直接对上，剩 146 行是国区未上架的美区榜 App，改用美区 `sellerName` 复核也 146/146 全对）；榜单排名抽样国区免费总榜 100 行、畅销总榜 70 行、参考榜 100 行、图形与设计榜 99 行、天气榜 100 行，排名偏差全为 0。唯一可挑剔的 3 行：`各区名字是否不同` 判「是」但实际只差 `®`／空格／大小写（开心消消乐®、Node Video、ReelFork），属口径细节，不算错。② **生成数据文件**：新增 `scripts/gen-region-names.py`，只把「六区名字确实不同」的 1,073 行写进 `server/src/data/regionNames.ts`（291KB，含 1,073 条 `sellerName`；同名行用原名就能搜到，不进包）。③ **接入跨区比价**：`searchNameFor()` 给每个 lookup 打不通的区返回「该区官方名」，其余海外区（表只覆盖六区）借美区英文名——原来拿国区中文名去搜美区/新加坡/英国，苹果基本只返回无关结果；`searchOne` 打分改为 bundleId 相同 100 → 本区官方名逐字一致 96 → 命中表内任一区名且 bundleId 前缀同厂 94／发行商同名 90／否则 84，并保持「标题完全一致」才认的保守口径，避免再出现《泰拉瑞亚》搜出第三方攻略 App 那种误配。④ **前端区分两种「没价」**：`localName` 有值说明该区上架过、只是这次没取到价格，与「根本没上架」分成两段文案，不再一律写成「未上架」。实测：《迷失岛》国区 ¥1，旧逻辑海外 13 区全部「未上架」，现在 14/14 全有价（美区 Isoland $0.99≈¥6.62、日区 見失い島 JP¥150≈¥6.27、台区 迷失島 NT$30≈¥6.08）；《元气骑士》《台球世界》《多邻国》同样 14/14；国区付费榜前 20 款里 11 款命中 13–14 区（旧逻辑多为 1/14）；《欢乐斗地主》海外版由 PROXIMA BETA 代理发行（`com.tencent.happypoker`），也被正确认成同一款。⑤ **边界（如实说明）**：这张表只覆盖「同一个 trackId 的多区本地化名」，国区代理单独上架、trackId 不同的《潜水员戴夫》《重生细胞》《人类跌落梦境》仍识别不到（实测仍 1/14），那类只能靠图标指纹；另测海外版多数换过图标（人类跌落梦境 d=32），`dHash ≤2` 只对《重生细胞》这类（d=2）成立，故未扩大自动配对。 |
| 35 | **跨区 SKU 对照表扩到 26 组（512px 双指纹）+ 免费/买断口径说明** | 接着第 33 条遗留问题：国区代理单独上架的游戏（《潜水员戴夫》等）跨区比价仍只有国区一个区。① 新增 `scripts/find-region-aliases-v2.py`：拉国区付费总榜 + 游戏付费榜各 100（去重 147 款），用国区中文名在 us/hk/tw/jp 搜候选，拿候选与国区的 **512px 图标**算两个独立指纹 —— dHash 16×16（256 位梯度）+ pHash 8×8（64 位 DCT 低频），两者同时进阈值才算同款。实测（512px 大图 + 双指纹比第 33 条的 100px 单 dHash 强得多）：真同款 dHash≤19、pHash≤6，无关 App dHash≥98，中间是空档，阈值取 dHash≤24 && pHash≤8 零误配。② `scripts/gen-region-aliases.py` 合并旧 7 组 → **26 组**，两条硬过滤都是实测踩出来的：Apple Arcade 版（名字带 `+`/bundleId 含 `applearcade`）是订阅制不是同款商品（《泰拉瑞亚》日区差点被写成 Terraria+）；「专业版/Pro/HD」同厂双版本图标几乎一样但付费口径不同（《金十数据专业版》差点配上免费版），均剔除。组内 `default` 取**美区那个 SKU**（海外 8 区通常与美区同版），港/台/日有独立版就按区精确落位。③ 前端补一句口径说明：同款在别的区是免费+内购时（如《潜水员戴夫》国区 ¥30 买断、海外 13 区免费下载），显示「另有 N 个区的同款是免费下载+内购版本…不计入最低价」，不再让人误读成「海外白送」。实测国区付费榜前 20 款：命中 164/280 → **217/280**，13–14/14 的从 11 款升到 15 款；《潜水员戴夫》《拣爱》《画中世界》《重生细胞》《隐藏的家伙》从 1/14 → 14/14，《盛世天下》13/14。仍识别不到的 5 款（候选池里根本没有正主，或海外版换过图标）：避难所：生存、王国保卫战5、迷雾北境、火柴人联盟2、人类跌落梦境 —— Apple 数据里没有可靠的跨区链接，属于数据边界。服务端已生效，**无需出包**；App 内看到新文案才需要。 |
| 36 | **价格对比页点进区内详情后补人民币参考价** | 上一版只改了「各区价格对比」列表行，点某一区进 `RegionAppSheet` 后「本区价格」仍只有本币（如美国区只给 `$0.99`），跨区比价的参照系断了。修复：`RegionAppSheet` 复用榜单详情同一套 `useCnyRates` + `priceToCny` + `cnyAmount`，价格行改为 `本区价格 $0.99 ≈ ¥6.62`（人民币用次级色小一号，与列表行口径一致）；免费区显示「免费」不带 ≈¥0，汇率取不到时只显示本币不报错。实测《迷失岛》美区详情 `$0.99 ≈ ¥6.62`，与列表行 ¥6.62 一致；控制台零报错。前端改动，需出包才能在手机上看到（Web 端即时生效）。 |
| 37 | **价格对比三处升级：重点区高亮 / 排行榜搜索 / 内购对比** | ① 「各区价格对比」列表着重标出国/印/日/美四个主流比价区：accent 色左侧竖条 + 淡底色 + 区码与区名加粗，扫一眼就能定位；当前区标记与「最低价」标签不受影响。② 排行榜页顶部加搜索胶囊（与「限免情报」同一位置，`subTab` 切换到排行榜时显示，placeholder 为「搜索当前榜单」）：`RankingBoard` 接 `search` prop 在本地筛当前榜（名称 + 开发商都匹配），保留真实排名序，无匹配时给出兜底提示（见第 38 条：筛选范围随后扩到前 100 名）。③ 详情页在「各区价格对比」下方新增「内购价格对比」，表头即「本体 | 内购」：逐区列出本体价与该区内购起价（Apple 商品页只公示前 10 项，取最低价折算人民币，次要行显示 ≈¥）；新增服务端 action `appStoreIapPrices`——iTunes API 不返回内购，只能解析 `apps.apple.com/{cc}/app/id{id}` 的 `serialized-server-data`（4 区并发、20s 超时、12h 缓存；Apple 按出口 IP 把别区页面 302 到本地 storefront，遇到就把该区标 `available:false` 显示「—」，绝不拿别区数据冒充）。④ 按要求删掉了价格对比表格下方那段长说明。实测：搜索「抖音」4 条命中且排名真实；《迷失岛》国区内购 ¥1.00 起 ≈¥1.00 正确显示；控制台零报错。**边界如实说明**：内购价依赖能访问到对应区的商品页，当前服务端出口在中国大陆，13 个海外区会被 Apple 重定向，内购列显示「—」；把服务端挪到境外出口（或配代理）后无需改代码即可全部点亮。前端改动需出包。 |
| 38 | **榜单从 50 条拉满到 Apple 上限 100 条，榜内搜索覆盖前 100 名** | 第 37 条上线后反馈「榜内搜索只在前 50 条里找」。查清不是 Apple 的限制：`client` 里 `appStoreRanking` 的 `limit` 被写死成 50，而实测 `rss/toppaidapplications/limit=50→50 条、limit=100→100 条、limit=200→仍 100 条`，接口上限就是 100 —— 等于白丢一半。① 前端 `limit: 50 → 100`，服务端 `appStoreRanking` 的 `Math.min(100, …)` 上限本来就够，缓存 key 含 limit 不受影响。② 榜内搜索是本地筛，覆盖面随数据自动变前 100；无命中提示改为「不在×××这个榜的前 100 名里」，并指路「限免情报」页搜索框做全库搜索（榜内搜索的语义是定位榜内名次，不静默改成全库）。实测（Playwright 390×844）：国区免费榜渲染 100 行（第 1 名抖音商城 → 第 100 名邮储银行），搜第 80 名「爱奇艺-《折月亮》全网独播」命中 1 条（旧 50 条上限下必搜不到），搜不存在的词正确落兜底文案，控制台零报错。前端改动需出包。 |
| 39 | **内购对比改成标题行「本体 \| 内购」切换 + 内购价人民币做主口径** | 第 37 条的内购表是压在「各区价格对比」下面另起一块 `mt-6` 的表，手机上同一屏要看两套口径。① 按反馈把内购挪进「各区价格对比」标题行右侧的空白处做成切换胶囊（`data-price-switch`，两个 tab 为 `data-price-tab="base"/"iap"`）：默认「本体」= 原 14 区折人民币排序表，「内购」= 内购表，两块互斥不再上下堆叠；右侧小字随之变「按人民币折算排序 / 按内购起价排序」。内购 query 只在切到该视图时挂载，不拖慢本体视图。② 内购价换算口径反过来：原来本币在主行、≈¥ 缩在副行小字里（用户反馈「没换算成人民币」），现在**人民币做主行**（accent 粗体 `¥8.00`），本币降为副行备注 `$0.99 起`；人民币区副行只留「起」不重复；汇率缺失显式写「汇率缺失」而不是留白。表头也改成「本体 \| 内购起价」。③ 读不到内购的区不再刷 13 行「—」，合并成表尾一行「读不到 13 个区：HK · TW · JP …（Apple 按访问地区限制商品页，不拿别区价格顶替）」，一屏内交代清楚。实测（Playwright 390×844，深/浅两套主题）：来回切换 `data-price-view` 正确、本体视图 14 行恢复、CN 行 `data-iap-cny="8.00"` 显示 `¥8.00 / 起`、控制台零报错。**边界（已实测确认）**：`apps.apple.com/{us,jp,hk,tw,gb}/app/id…` 在当前出口全部 302 到 `apps.apple.com/cn/iphone/today`，海外 13 区内购确实读不到；换境外出口即可点亮，代码无需改动。④ 按反馈收掉标题行右侧的排序小字与表格上方的两段解释（「当前区已经是这 14 个有货区里最便宜的…」「另有 N 个区的同款是免费下载+内购版本…」）：标题行只留「标题 + 切换」，下方直接就是表格；h2 加 `leading-none` 修掉胶囊比标题「上浮」的错位（实测两者垂直中心差 0.00px，胶囊右边缘与内容区右边界对齐）。前端改动需出包。 |

| 40 | **关注页首张卡片顶到「本体｜内购｜降价｜关注」标签行** | 反馈「关注页的 App 卡片太靠上了，和四个标签重叠」。查 `chip === "watch"` 下的四组列表：限免（`watchFree`）、内购（`watchIap`）、降价（`watchDrops`）三组的容器都带 `mt-4`，唯独 App Store 应用组（`watchStore`）的 `<div className="flex flex-col gap-[9px]">` 漏了这个上边距。只关注了 App Store 应用时（另外三组都为空，正是反馈里的截图情形），第一张卡片直接贴住标签行下沿，看起来像把标签压住了。补上 `mt-4` 后实测（Playwright 390×844，关注 3 个 App Store 应用）：标签行 bottom 130px → 首卡 top 146px，**间距 16px**，与「本体」等其他 tab 完全一致，控制台零报错。前端改动需出包。 |

| 41 | **打开 App 要加载半天：首屏 4 秒，且每次重开都一样慢** | 反馈「打开app都要加载半天」。真机复现（公网后端 + Fast 3G）：冷启动首屏 **4.0–4.4s**，二次打开同样慢。根因三处：①整个 App 被单个查询 `listDeals` 卡住（`dealsQuery.isPending` 时只显示「加载中…」），而它一次返回 182 条 / 652KB；②react-query 缓存只在内存，iOS 杀进程后全丢，每次冷启动必重下；③474KB 单 JS bundle（DOMContentLoaded 就 3.5s）。**本轮修 ①②**：在 `sdk-shim.tsx` 用 react-query 内置 `dehydrate/hydrate` 做持久化缓存（不新增依赖）——模块加载时同步从 localStorage 恢复白名单查询（`deals`/`appPrices`/`fxRates`/`appleArcadeGames`/`appWatches`/`freeHistory`，仅成功态、7 天有效），首屏先渲染缓存，后台按各自 staleTime 静默刷新（stale-while-revalidate）；写盘 1.2s 防抖、超配额自动丢弃不影响功能。缓存带 **session token 指纹**，账号切换时指纹不符即丢弃，`handleSessionChange` / 会话失效路径主动 `clearPersistedQueryCache()`，杜绝串账号 saved/claimed 标记。实测（真机模型，数据请求人为延迟 2.5s）：**冷启动 3101ms → 命中缓存 412ms（7.5×），缓存命中零阻塞请求（actions=[]）**；榜单/内购/关注回归通过、零 console 报错。前端改动需出包。 |

| 42 | **游戏库一排控件三种高度** | 反馈「这三个胶囊不等高」。实测「04/游戏库」这一排：展示方式胶囊组 31px、排序下拉 32px、「更新时长」按钮 27px，三种高度视觉参差。原来靠各自 padding 撑高（`py-1.5` / `py-[7px]`，浏览器 select 又有默认行高）。统一改成固定 `h-8`（32px）+ `items-center`，胶囊按钮改 `flex h-full items-center`，下拉与两个按钮去掉 py 用 `h-8`。实测四控件统一 32px、同一水平线（top 774 / bottom 806），390×844 截图确认，零报错。前端改动需出包。 |

| 43 | **Epic 一键入库（原生）** | 反馈「已登录 Epic，免费游戏为什么不能一键入库，附加内容免费一起入库，小黑盒就有」。查证：服务端虽有用户 Epic token，但下单接口只认 epicgames.com 网页会话且数据中心 IP 被 Cloudflare 挡（实测 store 域 403、老 graphql 端点 Gone）；小黑盒/Heroic 及所有开源方案都是「内嵌浏览器 + 已登录网页 cookie + UI 点击下单」，无一用 token 直接调 API。故走原生壳方案：`AppDelegate.swift` 新增 `FGameClaimViewController`（WKWebView 用 `.default()` 共享系统 cookie，复用 OAuth 登录态），逐个 offer 加载官方 `purchase?offers=1-ns-id` 页，注入脚本点 `purchase-cta-button`→iframe 内 `Place Order`/`I Accept`→判定 `Thanks for your order!`；跨域 iframe 由 `decidePolicyFor` 记录 `WKFrameInfo` 后用 `evaluateJavaScript(_:in:)` 注入解决。`fgame://claim?payload=<base64>` 深链触发，结果经 `fgameClaimResult` 事件回前端标记已领。前端 `claim-bridge.ts` + 详情页「⚡ 一键入库」按钮（仅 iOS 原生 + Epic + active + 有 offers 时显示，Web 端零回归）。免费 DLC：`claimOffersFromDeal` 汇总该 deal 的 claimUrl/epicOffers/combinedPurchaseUrl 里全部 offer（含安卓+iOS 两端与 bundle 多 item）一并下单；独立成 deal 的 DLC 走游戏页多选队列。验证：前端 typecheck 通过、Swift 括号平衡、offer 解析正确、Web 端按钮 0 且零报错、结果事件成功/失败提示均正常。**原生领取需在真机验证**（Linux 沙箱无 Swift/UIKit，无法编译或模拟 WKWebView 下单，编译与功能验证靠 CI macOS runner 构建 + 真机）。前端改动需出包。 |
| 44 | **一键入库「Epic 已拥有的游戏」也标已领取** | 反馈「我 Epic 已经有的游戏，App 限免卡片里没显示已拥有或已领取」。服务端「已在库」判定本身正确：用真实登录态验证，Knightica 的 PC 版与手游版都能正确点亮 `inLibrary`（库同步了 772 款 Epic 游戏，标题归一化匹配通过）；未点亮的新限免（如 Mark of the Deep）是确实还没领，属正常。真正的 bug 在**原生一键入库的结果回传**：`AppDelegate` 的注入脚本能正确识别「already own / in library」并发 `owned` 事件，但 `decidePolicyFor` 的 `owned` 分支只 `index+=1` 跳过、**不把这款计入回传的 claimed 数组**，于是 `finish()` 回传 `claimed=[]`，前端 `onClaimResult` 的 `if (claimed.length>0)` 不成立 → 不调用 `toggleMark` → 卡片永远停在「限免 FREE」。修复三处：① 原生 `FGameClaimViewController` 新增 `owned:[String]` 数组，`owned` 分支把标题记进去，`finish()` 回传 `claimed/owned/failed` 三段并把 `ok` 判空包含 owned；② 把 owned 通过 `fgameClaimResult` 事件的 `owned` 字段回传前端（`claim-bridge.ts` 的 `ClaimResult` 增加可选 `owned`，兼容旧原生包）；③ 前端 `onClaimResult` 把 `claimed + owned` 都视为「已在库」标记当前 deal 为已领取，提示文案区分「新领取 N 款 / N 款本来就在库中已同步标记 / N 款需手动」。验证：前端 typecheck 通过、Swift 括号平衡、owned 全链路 12 处一致；真机下单仍靠 CI 构建 + 真机验证。需出包。 |
| 45 | **限免详情页「获取」胶囊（App Store 同款）** | 反馈「限免 app 在右侧加个获取 icon 跳转 App Store 领取，注意对齐」，并明确「不是下载符号，是和 App Store 一样的获取 icon」。实现：详情页价格行（「免费 $30→90」右侧）新增胶囊按钮，文案「获取」、`rounded-full` + `--free-bg` / `--free-ink` 绿系配色，点击 `deal.claimUrl` 直达 App Store（iOS 自动唤起 App Store App）；仅 `status=active` 且 `claimUrl` 含 `apps.apple.com` 时渲染，Epic / Prime 零影响。对齐：首版 36px 圆形箭头使行高被撑到 36px、与 20px 文字（text-xl 行高 28px）中心差 4px；改为 h-7（28px，与文字行高相等）后实测垂直中心偏差 **0.00px**、距右边缘 16px 与页面边距一致。验证：typecheck 通过；真机浏览器渲染确认 App Store 限免显示胶囊、Epic 限免不显示。需出包。 |
| 46 | **一键入库错误兜底 + 增量验库加速** | 反馈「一键入库提示未知错误还是要手动领」+「验库能不能快一点，之前存在的不用重复验证」。① 一键入库：确认「unknown error」是 Epic 购买页自身返回（App 代码无此文案），原脚本只认 `thanks for your order`/`already own`/`captcha`，遇到 unknown error 会空转直到手动结束；原生 top/frame 注入脚本增加 `unknown error`/`something went wrong`/`an error occurred`/`we couldn't` 检测 → 触发 `ev('error')`，`decidePolicyFor` 新增 error/captcha 分支（记入 failed、提示「Epic 返回错误/需要验证码，请手动领取」、自动进下一款），并加 25s/offer 超时 watchdog 兜底；前端 `onClaimResult` 的失败文案改为明确引导「点下方去领取在官网手动完成」。② 增量验库：`verifyBatchClaim` 原对每个平台无条件全量 `syncPlatform`（Epic 翻 11 页 + catalog bulk，最慢一步）；改为先读本地 `libraryItems(source=sync)` 建索引，若本地库已能确认该平台全部 guided 条目（普通=标题命中，手游=标题命中且有 mobile 标记，规则与 results 判定完全一致）则跳过网络同步，note 标注「无需重新同步」；只有本地查不到/库空才触发全量同步。验证：真实账号库 773 条、上次同步 7.4 分钟前，验 Mark of the Deep(525)+手游 Knightica(609) 两款 → 均 verified、note「已在本地库查到（无需重新同步）」、耗时 50ms（原需数十秒）；Swift 括号平衡、前端 typecheck 通过。需出包。 |
| 47 | **各区价格对比高亮区自选 + Epic 手游限免补 Epic 标签** | 反馈两处：① 排行榜各区价格对比的重点高亮区原本写死国/印/日/美，改为在「本体 / 内购」切换左侧新增「高亮区」多选下拉：列出当前有价格的区 + 对照表全部 14 区，勾选即高亮（accent 竖条 + 淡底 + 区名加粗），本体表与内购表共用同一份选择，含「恢复默认」，选择存 `localStorage`（key `fgame-price-focus-regions`）跨详情页持久；默认仍是国/印/日/美，未勾选的区（含当前区）恢复普通底色。② Epic 手游限免（如 GamerPower 镜像的 Lonesome Village (Mobile)，数据层未归到 epic）列表卡片原本只显示「手游 · 安卓 · IOS」，新增 `isEpicGiveaway` 判定（`gamePlatform=epic` / `epicMobile` / 有 epicOffers / 领取说明含 Epic Games Store），对「是 Epic 且平台文案未写 Epic」的手游在标签行补一个 Epic 胶囊（`showEpicBadge`，避免与已有「EPIC 商城」重复）；列表卡片与详情大卡片同步生效，Epic PC 游戏与 Prime 游戏不受影响。验证：typecheck + `vite build` 通过；浏览器实测下拉默认勾选四项、勾选加拿大/取消中国后高亮实时更新且写入 localStorage、内购表共用选择；限免列表 Epic 手游出现 Epic 胶囊、其他游戏不误标；控制台零报错。需出包。 |
| 48 | **订阅追踪（云服务页入口卡 + 二级详情页）** | 用户拿来一张订阅管理界面截图，要求做进 App 的「云服务」导航页、做成一个卡片、点进去进二级页显示订阅信息。实现：① `SubscriptionEntryCard` 放在云服务页标题下、筛选 chips 上，渐变卡显示「本月订阅 ¥总额 / N 项服务 / 比单独订阅省 ¥N」+ 柱状图；② 点击进入 `SubscriptionPage`（全屏 portal + 返回栏 + 滑动返回 + ＋添加），按截图的 01 本月订阅 / 02 订阅中的服务 / 03 即将扣费 三段排版，每行品牌色方块 + 服务名 + 自动续费绿点 + 区服·套餐·扣费日 + 人民币/月（副行本币价）；「即将扣费」按当前日期算 7 天内下一个扣费日（跨月/小月末自动顺延）；③ `SubscriptionEditor` 底部弹层可增改删订阅（名称/区服/套餐/本币价/币种/扣费日/单买原价/自动续费开关/标识色），区服联动带出币种；④ 数据存 `localStorage`（key `fgame-subscriptions`），首次进入给 6 项示例订阅（Netflix/Spotify/iCloud+/YouTube Premium/ChatGPT Plus/Apple Music），之后完全由用户增删改；人民币换算复用 `useCnyRates` + `rateFor` + `cnyAmount`。验证：typecheck + `vite build` 通过；浏览器实测入口卡显示 ¥296/6 项、二级页三段与换算正确（Spotify/iCloud+ 算到 11 月 21 日扣费）、增改删三项与 localStorage 持久化全过、控制台零报错。需出包。 |
| 49 | **Epic 手游归入 Epic 筛选 + 领取跳官网排查（快照过期）** | 反馈两处：① Epic 手游卡片挂了 Epic 标签，但点游戏页「Epic」平台筛选时跑到「其他」里漏掉。根因：GamerPower 镜像的 Epic 手游（如 Lonesome Village）数据层 `gamePlatform=other`，筛选只看 `gamePlatform==="epic"`。修：新增 `gamePlatBucket`，把 `isEpicGiveaway` 的手游统一归到 epic，Steam/GOG/Prime 不受影响。实测点 Epic 后 Lonesome 出现在 Epic（6→7 条）、「其他」里消失、Steam 数量不变。② 「Epic 手游领取上周能跳购物车结账，现在跳官网」。排查：官方手游源（`egs-platform-service.store.epicgames.com/discover`）本周免费游戏正是 Lonesome Village，真实 offer id 存在（namespace `4385ab59…`，安卓 `a64debf3…`/iOS `bb6b2e7a…`，与小黑盒分享帖完全一致）；跳官网的根因是 `data/epic-discover/*.json` 浏览器快照停在 11/15（超 7 天失效）+ 服务端直连被 Cloudflare 403，官方 offer 没进库，GP 镜像条目 `epic_offers` 为空、`claim_url` 停在 GP 文章页。修：跑 `scripts/epic-discover-snapshot.py` 重新抓四个官方源并 `saveEpicMobileSnapshot` 落库，GP 镜像与官方行随即拿到双端结算链接，去领取直达 `store.epicgames.com/purchase?offers=…&offers=…`，并出现「只领安卓/iOS」分端按钮与商品页兜底。实测链接与小黑盒「一键领取」逐字一致。说明：Epic 官方源只能靠浏览器快照（数据中心 IP 被 Cloudflare 挡），快照由 `epic-discover-cron.sh` 每 6 小时刷新、7 天过期；本次本地快照因环境休眠停了才过期，线上后端靠自身 cron/后台抓取自愈。第①项前端改动需出包；第②项为运行时数据，随后端刷新即时生效。 |
| 50 | **一键入库报「Account id is missing」：在领取页内引导登录并自动续领** | 反馈：一键领取 Epic 游戏（Lonesome Village 手游版）时，原生领取页弹出 Epic 错误「发生意外错误。Account id is missing」。查证：这是 Epic 结算页自身的报错——当前 WKWebView 会话里没有已登录的 Epic 账号；详情页的「① 登录 Epic」用的是 target=_blank，在 Safari 的独立 cookie jar 登录，领取页（`.default()` data store）读不到，所以下单时报缺 account id；小黑盒分享帖的「一键领取」同样把「先登录 Epic」列为第 1 步。根因是原注入脚本只认 unknown error / something went wrong / captcha，不认这条文案，导致空转 25s 后超时。修：① top/frame 注入脚本新增 `account id is missing` / `发生意外错误` / `account id is not` 检测 → 触发 `needlogin` 事件；② 原生 `decidePolicyFor` 新增 needlogin 分支——不记失败、不推进 index，调用 `enterLoginGate()` 在**同一个 WKWebView** 里加载官方登录页 `www.epicgames.com/id/login/guided?lang=zh-CN`（cookie 落在本会话，结算页能读到）；③ 登录后导航离开 `/id/*` 且到达 epicgames.com 普通页时自动 `resumeAfterLogin()` 重领当前 offer，另加顶栏「继续领取」按钮作手动兜底；④ 注入脚本在登录页只做文案检测、不自动点 Continue，避免干扰人工登录；⑤ 顶部进度文案改为「未登录 Epic：请在页面内登录，登录后自动继续」。验证：Swift 括号平衡、needlogin/enterLoginGate/awaitingLogin 全链路一致；真机流程靠 CI 构建 + 真机验证（Linux 无 Swift/UIKit）。需出包。 |
| 51 | **同步验库提速：Epic 从整库重建（86s）改为 namespace 精确核对（~15s）** | 反馈「同步验库怎么还是要很久」。实测定位：增量验库只对「游戏已在本地库」有效（26ms），而刚领的新游戏本地库必然没有 → 每次触发全量 `syncEpicLibrary`（1,050 条记录 / 774 款 / 11 页分页 + 每款 catalog 查标题几十次请求 + 时长接口 + 774 行逐行写库），实测 86.4s。关键验证：Epic 库 records 带稳定 `namespace`，与限免 deal 的 `epic_offers[].namespace` 一一对应（12/13 命中，唯一未命中是真没领的 Bread and Fred），records 的 `platform` 数组还直接区分 Android/iOS（手游权益）。修：新增 `fetchEpicOwnershipIndex()` 只分页拉 records（~18s 硬成本，Epic 无按 namespace 过滤接口）提取 `namespace→平台集合`，`verifyBatchClaim` 的 Epic 分支在「本地库确认不了」时改走此轻量路径，用 namespace 命中注入合成 idx 复用原有 results 判定，彻底跳过 catalog 标题解析 / 时长 / 整库写库；本地库能确认时仍走原快速路径不变。实测同一场景 86.4s→11.1s，PC 本体/手游/未领三种判定全对，手游平台标记正确；文案按 `lightweight` 标志区分「精确核对」与「本次同步」。纯服务端改动，需重新发布后端生效（前端/IPA 无需重出）。 |

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
| 1.0.16 | 22 | `FGame-v1.0.16-b22-unsigned.ipa` | 区服改分类行右侧小下拉、搜索结果与关注条目点进站内详情（`StoreDetail`）、搜索回车自动收键盘、APP 页分类行极简为「本体｜内购｜降价｜关注」、分类行与下拉垂直对齐（第 25–27 行） |
| 1.0.17 | 23 | `FGame-v1.0.17-b23-unsigned.ipa` | 限免日报去掉右上角刷新/更多、详情页 App Store 化（获取 + 关注双胶囊、可点开发者进开发者页、用户评价 + 逐条翻译）、排行榜详情删底部说明与按钮、四页标题排版统一（第 28–29 行） |
| 1.0.18 | 24 | `FGame-v1.0.18-b24-unsigned.ipa` | 外区付费榜价格后补人民币参考价：服务端新增 `fxRates`（1 CNY 兑各币种，12 小时缓存，exchangerate-api → frankfurter → 内置静态表三级兜底），榜单行与榜单详情价格行显示「≈¥」，国区与免费榜不显示 |
| 1.0.19 | 25 | —（尚未出包） | 详情页各区价格对比（14 个 storefront 折人民币排序、标最低/当前）、区服新增土耳其/尼日利亚/埃及、区服筛选改两行、服务端新增 `appStoreRegionPrices` |
| 1.0.20 | 26 | —（尚未出包） | 跨区价格对比识别各区不同标题并显示本区名、点某区进入该区详情页（本区价格/资料/评价），`appStoreRegionPrices` 增加 name/bundleId/match 与搜索补位 |
| 1.0.21 | 27 | —（尚未出包） | 同一款游戏跨区 SKU 对照表（图标 dHash 自动配对 7 组，国服/港台/日版互认），跨区价格对比双向补全 14 区 |
| 1.0.22 | 28 | `FGame-v1.0.22-b28-unsigned.ipa` | 导入各区上架名对照表（3,448 行 × 6 区全量复核后导入 1,073 行差异行）：跨区比价改用「该区官方名／美区英文名」检索，海外区命中从 1/14 提升到 13–14/14，价格对比区分「未上架」与「上架但没取到价」（CI run 43694496741，commit 4fbe520） |
| 1.0.23 | 29 | `FGame-v1.0.23-b29-unsigned.ipa` | 跨区 SKU 对照表 7 → 26 组（512px dHash+pHash 双指纹自动配对，剔除 Arcade 版与专业版误配），详情页补「免费+内购版本」口径说明（CI run 43696420064，commit 776986e） |
| 1.0.24 | 30 | 并入 1.0.26 | 区内详情页「本区价格」补 ≈¥ 人民币参考价，与价格对比列表口径一致 |
| 1.0.25 | 31 | 并入 1.0.26 | 价格对比：国/印/日/美四区高亮；排行榜页加搜索（与限免情报同位置）；新增「本体 | 内购」内购对比（服务端解析各区商品页，12h 缓存）；删价格对比下方长说明 |
| 1.0.26 | 32 | `FGame-v1.0.26-b32-unsigned.ipa` | 合并首发 1.0.24–1.0.26：区内详情补 ≈¥；价格对比四区高亮；排行榜加搜索栏；「本体｜内购」内购对比；榜单 50 → 100 条（Apple RSS 上限），榜内搜索覆盖前 100 名（CI run 43703166572，commit 3fa1db2；sha256 `9c16deb3…e97d7`） |
| 1.0.27 | 33 | `FGame-v1.0.27-b33-unsigned.ipa` | 内购对比从「另起一块表」改为「各区价格对比」标题行右侧的「本体｜内购」切换；内购价改人民币做主行（本币降为副行）；读不到的区合并成一行；标题行与切换胶囊垂直对齐（中心差 0.00px），删掉标题行右侧排序小字与表格上方两段说明（第 39 条；CI run 43721454974，commit 31de7c1；sha256 `2528e1c3…78dd`） |
| 1.0.28 | 34 | 并入 1.0.29 | 关注页 App Store 应用组补 `mt-4`：只关注了应用时首卡不再顶住「本体｜内购｜降价｜关注」标签行（第 40 条） |
| 1.0.29 | 35 | `FGame-v1.0.29-b35-unsigned.ipa` | 合并首发 1.0.28–1.0.29：关注页补 `mt-4`；冷启动秒开——react-query 查询持久化到 localStorage（白名单 + token 指纹 + 后台静默刷新），二次打开首屏 4s → 0.4s（第 40/41 条；CI run 44110242273，commit cf00468；sha256 `ae147cc3…bb6aa`） |
| 1.0.30 | 36 | —（尚未出包） | 游戏库一排控件统一 32px 高、同一水平线（第 42 条） |
| 1.0.31 | 37 | `FGame-v1.0.31-b37-unsigned.ipa` | Epic 一键入库（原生 WKWebView 网页会话自动下单 + 免费 DLC 一起领，第 43 条）；CI run 44241429641 编译通过，真机下单功能待验证 |
| 1.0.32 | 38 | `FGame-v1.0.32-b38-unsigned.ipa` | 一键入库「已拥有」也标已领取：原生层把 Epic「already own / in library」计入回传，前端据此标记当前 deal，修复「Epic 已有的游戏一键入库后卡片仍显示限免 FREE」（第 44 条） |
| 1.0.33 | 39 | `FGame-v1.0.33-b39-unsigned.ipa` | 限免详情页价格行右侧新增 App Store 同款「获取」胶囊，点击直达 App Store 领取；仅 App Store 来源显示（第 45 条） |
| 1.0.34 | 40 | `FGame-v1.0.34-b40-unsigned.ipa` | 一键入库识别 Epic「unknown error」/验证码并兜底（明确提示手动领取 + 25s 超时）；验库改增量——本地库已命中的直接判定、跳过全量同步（第 46 条） |
| 1.0.35 | 41 | `FGame-v1.0.35-b41-unsigned.ipa` | 排行榜各区价格对比高亮区改为可自选多选下拉（本体/内购共用、本地持久）+ Epic 手游限免补 Epic 标签（第 47 条）；云服务页新增订阅追踪入口卡 + 二级详情页（本月订阅/订阅中的服务/即将扣费，增删改、人民币换算）（第 48 条） |

同一版本号会被 `FGame-version.txt`（commit / 分支 / 构建时间）、`Info.plist` 的 `CFBundleShortVersionString` / `CFBundleVersion`、「我的」页底部 `FGame v1.0.19` 四路共用，CI 里由 `FGAME_VERSION` / `FGAME_BUILD` 注入，改版本只改这一处输入。

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
