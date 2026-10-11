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
4. Nginx：WS upstream 改为本地 ingress `core_ip(31..)`:3000，ingress backend 改为 `core_ip(31)`:3000，game backend 改为 `127.0.0.1:35400`；先 `openresty -t`，再一次正常 HUP。`prepare-dual-ingress-proxy.mjs` 目前仍写死 edge subnet，需手工替换并保留原文件备份。
5. 按 [ark-cluster-formal-local.service](ark-cluster-formal-local.service) 安装 unit（替换 `<local-stack>`），`systemctl enable --now`。它与 edge unit 互斥。
6. 公网 TLS/healthz/WS 与浏览器验收另行进行。

## 回滚

`systemctl disable --now ark-cluster-formal-local` → 恢复 Nginx 备份并正常 HUP → `systemctl enable --now ark-cluster-formal-edge`。回到 WG 拓扑的前提是 core 主机和链路已恢复并重新经过原有 guard/handoff/lease 流程。

## 已知限制与正式化

- 这套栈不受 `cluster-host-manager.py` 管理：没有 nft 租约 guard、CAS 状态、Main-thread 优先级或逐角色健康撤租。容器端口仅 loopback，bridge 由 Docker 隔离。
- 正式化方向：host policy 增加 local 模式（core 项目内含 ingress 目标、只 loopback 映射、跳过 WG `network_ready`）、lease 规则放行 ingress→coordinator/game:3000、对应 unit（无 WG 依赖/handoff）、Nginx 生成器支持本地 ingress 地址及相应测试。
