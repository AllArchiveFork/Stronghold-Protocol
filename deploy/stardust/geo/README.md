# 仅放行中国大陆 IP（ark_geo）

formal vhost 在 443 的 server 级用 `set_by_lua_block` 查客户端 IP，不在表内的请求改写到 internal 的 `/_ark_geo_blocked`，返回 403 中文页。80 端口不过滤（ACME HTTP-01 校验来自境外）。回环、私网（含 100.64.0.0/10）、IPv6 ULA 和 link-local 永远放行。本文只说明实现与安全合同，不记录部署坐标或上线状态。

## 数据
- 两个来源取并集：APNIC delegated stats 里 `CN` 的 allocated/assigned 段（每日更新，校验 md5），以及 Loyalsoldier/geoip 的 `release/text/cn.txt`（基于 GeoLite2、ipip 等，每周更新）。可选的手工白名单放在 `state/extra-allow.txt`，每行一个 CIDR。
- 每个来源单独校验：IPv4 地址总数在 2 亿到 4.5 亿之间，IPv6 段数不少于 500，没有短于 /8（IPv4）或 /16（IPv6）的前缀，几个已知境内地址在表内、境外地址不在表内。校验失败时改用 14 天内的上次合格缓存；没有可用副本时整次失败。
- 和上一次输出相比，IPv4 地址数变化超过 10% 或 IPv6 段数变化超过 20% 时拒绝输出，确认无误后用 `--force` 重跑。
- 输出格式：第一行是表头 `# ark-geo-cn v1 … sha256=<正文摘要>`；正文每行是 `4 <起> <止>`（十进制）或 `6 <起> <止>`（地址前 64 位，16 位小写十六进制），已排序、已合并。

## 代理主机
- `ark_geo.lua` 和 `cn-allow.txt` 放在站点目录下的 `geo/`。worker 以 nobody 运行，需要能读到这两个文件；配置目录是 0700，不能放那里。
- `install_cn_allow.py <incoming> <target>` 校验摘要、行格式、顺序、计数和探针地址后原子替换，旧表保留为 `.prev`；incoming 必须和 target 在同一目录。
- worker 在 `init_worker` 时加载表，之后每 60 秒读一次表头，有变化才重新加载，不需要重载 Nginx。没有有效表时全部放行；新表无效时保留当前表；同一问题只记一次日志。

## 生成与推送
- 在能访问 GitHub 的管理机上生成。把本目录复制到 `/root/projects/ark-geo-cn/`（或修改 service 的 ExecStart），在同目录建 `target.env`（不入库），写 `ARK_GEO_TARGET`、`ARK_GEO_DIR`、`ARK_GEO_INSTALLER`，可选 `ARK_GEO_SSH_KEY`。
- `ark-geo-cn.timer` 每天 04:30（随机延迟 10 分钟内）运行 `update-and-push.sh`：生成、`scp` 到代理主机、远程运行安装脚本。任何一步失败，代理主机都保持原表。

## 测试
`test/run.sh <cn-allow.txt>` 用 OpenResty 1.27.1.2 容器验证：无表时放行；境内、私网放行；境外、IPv4 映射地址和 404 路径拒绝；热更新；安装脚本拒绝坏表；worker 遇到坏文件时保留原表；重启时遇到坏表全部放行。全程不访问生产，也不联网。
