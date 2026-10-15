# /sim、/shared、/data 的创空间公开副本

2026-10-15 服主决定：为减轻济南出口带宽，每个版本把浏览器演算代码（`/sim`、`/shared`）和游戏数据（`/data`）公开到 ModelScope 创空间 `Stardust/arknight-proto`。这三类不再要求经过门禁；`/js`、`/css`、门禁、API、WS 不变，济南门禁后的同版本副本保留，作为回退来源。

## 客户端

- 页面启动时取一次 `GET /code-source.json`（[codeSource.js](../../public/js/codeSource.js)），内容为 `{"version":1,"sim":"<…>/server/sim/","data":"<…>/data/"}`。只接受 https 目录 URL（本机回环可用 http，供本地检查）。文件不存在、为 `null`、格式不符或 3 s 内未返回时，全部从本站读取。
- 演算整套模块从同一来源加载（`loadSimFrom`）。`runner.js` 用 `simdata.js setSimData` 注入数据，内容模块又以相对路径 import `simdata.js`；如果由边缘逐文件 302，`simdata.js` 会出现两个实例，其中一个是空的，所以不能用 Nginx 跳转代替。20 s 内没加载完或加载失败，就改从本站加载。
- 数据文件逐个先取创空间副本，失败或 10 s 内未开始返回时改取本站。`announcements.json`（公告会在两次发版之间修改）和 `local-assets.json`（协调器生成）始终从本站读取。
- 失败只记一次：本页之后同类文件直接走本站。已打开的页面在刷新前一直沿用最初取到的来源。

## 创空间目录

`releases/<build>/` 按仓库结构摆放，让模块的相对 import 能直接解析：

| 路径 | 来源 |
|---|---|
| `server/sim/**` | 本版 localcode 的 `sim/`（已排除 Node 专用的 `nodeData.js`） |
| `server/data.js` | 本版 `server/http/static.js` 的 `DATA_SHIM_JS`（浏览器版 `data.js`） |
| `shared/**` | 本版 localcode 的 `shared/` |
| `data/**` | 本版 localcode 的 `data/` |
| `SHA256SUMS` | 以上文件的摘要 |

已发布的目录永不改写。所有文件都用普通 Git 存储，不走 LFS（创空间的 resolve 对 LFS 文件返回的不是文件本身）。创空间仓库有约 1.6 GB 的硬上限，每版大约增加 22 MB 原始文件，Git 压缩后更小。

## 发版步骤

切换前完成准备；第 3 步写入创空间和第 5 步改济南 Nginx，都需要当次明确授权。

1. 按 [PRIVATE-CODE.md](cluster/PRIVATE-CODE.md) 用 `--runtime-static` 生成本版 localcode。
2. 在本版提交的检出目录里运行：
   `node deploy/stardust/tools/studio-code-source.mjs stage --localcode "$STAGE/localcode/cluster-formal-$BUILD" --build "$BUILD" --repo "$STUDIO_CHECKOUT"`
3. 在创空间检出目录中只提交新增的 `releases/$BUILD/`，然后普通推送（不强推）。
4. `node deploy/stardust/tools/studio-code-source.mjs verify --repo "$STUDIO_CHECKOUT" --build "$BUILD" --base "https://modelscope.cn/studio/Stardust/arknight-proto/resolve/$STUDIO_COMMIT/releases/$BUILD/"`：逐个文件核对状态码、SHA-256、`Access-Control-Allow-Origin: *`，以及 `.js` 的 MIME。
5. 用 `node deploy/stardust/tools/studio-code-source.mjs nginx --base <同上>` 生成 `location = /code-source.json`，追加到本版私有代码 include，跟发版共用同一次 `openresty -t` 和 reload。
6. 验收：在浏览器 Network 面板里确认 `/sim`、`/data` 的请求发往 `modelscope.cn`，`announcements.json` 仍走本站；本地演算的校验值一致，没有退回服务器推流。

回滚或关闭：从 include 去掉这个 location 再 reload。请求会落到协调器，协调器返回 `null`，页面全部改从本站读取；已打开的页面刷新后生效。

## 同批的一次性边缘设置

- `nginx.conf` 的 `gzip_comp_level` 从 2 调到 6（数据 JSON 约小 30%，JS/CSS 约小 12–22%）。
- 门禁页静态资源（`/_gate/assets/*`）原来是 `private, no-store`。带版本号 `?v=` 的改为 `public, max-age=31536000, immutable`：把 `$ark_proto_cache` 这个 map 的键改成 `"$status:$uri:$arg_v"`，再加一条 `~^(200|304):/_gate/assets/[^:]+:[A-Za-z0-9._-]+$`。没有版本号的（如 `ae-sphere.json`）保持原样。ALTCHA Worker 必须同源加载，`gate.js` 和 `gate.css` 里有绝对路径，所以门禁资源只加缓存，不挪到创空间。

## 检查

- `node --test test/code-source.test.js`
- 本地端到端：启动服务器时设置 `SP_CODE_SOURCE='{"version":1,"sim":"http://127.0.0.1:<port>/releases/<build>/server/sim/","data":"http://127.0.0.1:<port>/releases/<build>/data/"}'`，用本机静态服务提供 `stage` 生成的目录（需带 `Access-Control-Allow-Origin: *`），再跑本地演算相关的浏览器测试，例如 `test/ui/boss-local-replica.e2e.test.js`。
