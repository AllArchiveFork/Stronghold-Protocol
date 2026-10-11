# 应急同机组合栈（无 WG）

当 core 主机或 core↔入口的 WG 链路不可用、而入口主机资源足够时，可在入口主机上同时运行 coordinator、十六个 game 和本地 ingress。本文是通用流程，不是部署状态或执行授权；实际坐标、时间线和回执只放 Git 外私有记录。

这不是 HA，也不迁移内存状态：切换即结束原 coordinator/game 上的房间、会话、队列和对局。

## 拓扑

- 单一 Docker bridge = profile `core_subnet`（Formal 为 `172.30.245.0/24`）：coordinator `.2`，game-01..16 `.11`–`.26`（每个 8combat+2trial），本地 ingress `.31` 起（Formal 最多 8 个，到 `.38`）。
- ingress runtime 直接访问 `http://<core_ip(2)>:3000` 及 `http://<core_ip(10+i)>:3000`；coordinator→game、game→coordinator 不变，仍是 bridge 内地址。
- 只发布 loopback：coordinator `35400`（3000）、`35410`（3001 私有端口），game `35411`–`35426`，ingress `35401` 起。不在 WG 地址发布任何端口，WG 不再承载这套角色。
- 角色、镜像、环境、只读/cap-drop/PIDs 等基线与 `cluster-deploy.py` 完全相同；唯一差别是 `restart: unless-stopped`，因为没有 root 管理器负责重启。

## 生成

```sh
# 1. 全新 core bundle：新 16 节点 key，只在本机生成、不离开本机。
python3 -I /opt/ark-cluster-formal/tools/cluster-deploy.py --profile formal \
  --role core --out "$NEW_CORE_BUNDLE" --image-id "$ACTUAL_IMAGE_ID" \
  --source-kind "$SOURCE_KIND" --build "$FIXED_BUILD" --manifest-sha256 "$SOURCE_MANIFEST_SHA256"

# 2. 组合栈：复用 core bundle 的 key/runtime（不改动），新增本地 ingress runtime 与 compose.json。
python3 -I /opt/ark-cluster-formal/tools/cluster-local-stack.py --profile formal \
  --core-bundle "$NEW_CORE_BUNDLE" --out "$NEW_LOCAL_STACK" --ingress-instances 8

docker compose -p ark-cluster-formal-local -f "$NEW_LOCAL_STACK/compose.json" config -q
```

两个输出目录都必须是不存在的新目录，父目录 root-owned 且不可 group/world 写。`stack-summary.json` 不含秘密，不是激活回执。

## 切换（需当前明确授权）

1. 记录现有 edge/Nginx 配置与容器身份作为回滚材料。
2. `systemctl stop ark-cluster-formal-edge`，再用原 policy `cluster-host-manager.py --action stop` 停旧 ingress（释放同一组 loopback 端口），`systemctl disable ark-cluster-formal-edge`。旧容器与 policy 保留，不删除。
3. `docker compose -p ark-cluster-formal-local -f "$NEW_LOCAL_STACK/compose.json" up -d`，确认 25 个容器运行、`127.0.0.1:35400/healthz` 正常。
4. Nginx：WS upstream 改为本地 ingress `core_ip(31..)`:3000，ingress backend 改为 `core_ip(31)`:3000，game backend 改为 `127.0.0.1:35400`；当前 private-code include 中 `^~ /js/`、`^~ /css/` 与 `@ark_formal_cluster_code` 的 fallback `proxy_pass` 也从 WG coordinator 地址改为 `127.0.0.1:35400`。先 `openresty -t`，再一次正常 HUP。`prepare-dual-ingress-proxy.mjs` 与 private-code 生成器目前仍写死 WG 地址，需手工替换并保留原文件备份；`formal-open.conf` 等待用候选配置同步更新，避免以后被装回旧拓扑。
5. 按 [ark-cluster-formal-local.service](ark-cluster-formal-local.service) 安装 unit（替换 `<local-stack>`），`systemctl enable --now`。它与 edge unit 互斥：把 `/etc/systemd/system` 下的 edge unit 文件移到备份目录后 `systemctl mask ark-cluster-formal-edge.service`，防止误启动时 `Conflicts=` 先把本栈整体停掉。
6. 公网 TLS/healthz/WS 与浏览器验收另行进行。

## 单机运行加固

同机栈没有第二台主机兜底，任何 Docker 守护进程重启都会结束全部内存对局，因此：

- unit 使用 `Wants=docker.service` 而不是 `Requires=`：显式 restart docker 时 `Requires=` 会联动 restart 本 unit，`ExecStop` 会停掉全部容器。
- `/etc/docker/daemon.json` 开启 `"live-restore": true`，先 `dockerd --validate --config-file /etc/docker/daemon.json`，再 `systemctl reload docker`（只 SIGHUP，不重启容器）。
- unattended-upgrades 的 `Package-Blacklist` 加入 `docker.io`、`containerd`、`runc`、`docker-compose-v2`；needrestart 对 `docker`、`containerd` 设 `override_rc` 为 0。Docker 只在维护窗口手动升级。
- proxy 写入宿主的 access/error log 加 logrotate（daily、copytruncate，无需向 proxy 发信号）。
- 入口 Nginx 的 443 监听加 `reuseport backlog=4096`，避免单个 worker 接收绝大多数长连接；HUP 即可生效，已有连接留在旧 worker 自然结束。
- 客户端 TCP 可用 `bbr`、`tcp_slow_start_after_idle=0`、`tcp_notsent_lowat=16384`，只影响新连接；写入 `/etc/sysctl.d/` 并在 `modules-load.d` 加载 `tcp_bbr`。
- 不再使用的 WG recovery unit 只 `disable`、不 `stop`；其接口与 nft 表在确认不回滚后再清理。

## 回滚

`systemctl disable --now ark-cluster-formal-local` → 恢复 Nginx 备份并正常 HUP → `systemctl unmask ark-cluster-formal-edge.service`、从备份放回 edge unit 并 `daemon-reload` → `systemctl enable ark-cluster-formal-wg` → `systemctl enable --now ark-cluster-formal-edge`。回到 WG 拓扑的前提是 core 主机和链路已恢复并重新经过原有 guard/handoff/lease 流程。

## 已知限制与正式化

- 这套栈不受 `cluster-host-manager.py` 管理：没有 nft 租约 guard、CAS 状态、Main-thread 优先级或逐角色健康撤租。容器端口仅 loopback，bridge 由 Docker 隔离。
- 正式化方向：host policy 增加 local 模式（core 项目内含 ingress 目标、只 loopback 映射、跳过 WG `network_ready`）、lease 规则放行 ingress→coordinator/game:3000、对应 unit（无 WG 依赖/handoff）、Nginx 与 private-code 生成器支持本地 ingress/coordinator 地址和 `reuseport`，以及相应测试。
