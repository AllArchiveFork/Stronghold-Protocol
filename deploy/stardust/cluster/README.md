# 集群部署角色

显式独立Formal profile及安装/schema合同见[formal/README.md](formal/README.md)。新工具默认Beta、旧policy/runtime/无profile字段WG metadata仍兼容；共享`cluster-profile.py`须与工具同目录投放。不得因此替换其他profile工具或宣称已部署。生成资源data与Git代码库存必须分别验证。

本目录是版本化角色部署材料，不是已安装、接流量或完成验收的记录。准备与切换分别授权；DNS、旧接口/recovery、其他profile和Git发布不因这些文件自动变化。实际部署坐标与结果保存在Git外的私有记录，见[记录边界](../releases/README.md)。

## 固定profile与全局池

- 每个profile使用一个coordinator和固定数量的完整对战进程：Formal为16或32个（`--game-nodes 32`），Beta为16个；每game默认**8combat+2trial**（`--combat-workers 1..8`/`--trial-workers 0..2`，全部game相同）。coordinator和ingress不创建战斗/试算Worker。
- 每入口都持有全部game节点路由；逻辑部署分组不是路由或玩家分区。所有入口共享同一大厅/好友房/party/匹配池，同局、联防、Boss及观战固定一个owner，无需sticky。
- 内层WS不压缩，WG回程raw帧与外层PMD的CPU/字节应分别衡量。入口数量与标称带宽不能直接推导容量。
- 网络仅允许profile批准的本地及peer `/32`、精确容器IP、端口和对应路由。拒绝任意地址、额外绑定及raw direct访问，不改默认路由或其他网络组件。
- `0.0.0.0`只用于容器内监听，不允许在宿主裸露原始端口。公开流量仍走TLS、同源Origin、口令门禁、逐次private校验、private/no-store及同版素材。ingress HTTP始终404；受保护HTTP/privatecode/data由本地或coordinator供给。
- 共用认证验证key与Cookie语义需独立核验，不能在入口间产生互斥登录凭证。terminal RPC的宿主映射只可loopback，同bridge游戏使用独立私有监听。

## 不冒称Git版本的固定源码

`Dockerfile.cluster`只使用已验证且本地存在的Node24 digest；离线构建必须`--network=none --pull=false`，不在国内节点临时拉依赖/素材。游戏/私有码/data/vendor/静态清单必须来自同一已经验收的app导出。

- `SOURCE_KIND=commit`：`SOURCE_REVISION`为真实固定commit；还记录独立完整source manifest SHA256。
- `SOURCE_KIND=tree`：用于明确批准的固定未提交快照；`SOURCE_REVISION=SOURCE_MANIFEST_SHA256[:40]`。这只是明确标注的内容身份，**不是Git commit**，不能把不含该内容的HEAD写成该快照源码。
- 镜像必须携带OCI source/revision以及`cn.stardust.cluster.source-kind`和`cn.stardust.cluster.manifest-sha256`；root管理器固定实际`sha256:imageID`，不接受可移动tag。
- app导出/manifest校验由主发布流程完成；生成器不能替调用者证明其传入的digest确实覆盖app内容。

## 生成全新受保护材料

先按固定源摘要安装三个host工具为root-owned、不可group/world写的文件：`cluster-deploy.py`、`cluster-host-manager.py`和其复用的`main-thread-priority.py`。旧单体工具安装路径/profile不替换。

```sh
# 父目录须已经是root-owned、不可group/world写；OUT必须是不存在的新目录。
python3 -I /opt/ark-cluster-beta/tools/cluster-deploy.py \
  --role core --out "$NEW_CORE_BUNDLE" --image-id "$ACTUAL_IMAGE_ID" \
  --source-kind "$SOURCE_KIND" --build "$FIXED_BUILD" \
  --manifest-sha256 "$SOURCE_MANIFEST_SHA256"

# 在每个对应入口分别生成；entry为1..4，不是“每台四节点”路由限制。
python3 -I /opt/ark-cluster-beta/tools/cluster-deploy.py \
  --role edge --entry "$ENTRY_NUMBER" --out "$NEW_EDGE_BUNDLE" \
  --image-id "$ACTUAL_IMAGE_ID" --source-kind "$SOURCE_KIND" \
  --build "$FIXED_BUILD" --manifest-sha256 "$SOURCE_MANIFEST_SHA256"
```

生成`compose.json`（JSON是Compose支持的YAML子集）、每角色`runtime/runtime.json`、root-only`host-policy.json`和非激活摘要。核心每个game（默认16，Formal显式`--game-nodes 32`时32）一个独立32-byte节点key，只生成一次；policy仅在非16时记录`game_nodes`，默认输出与原格式逐字节相同；每game只挂自己的key，coordinator挂全部节点key，ingress不持有节点key。真实key不进入argv/env/JSON正文/镜像/日志。容器只读文件采用root:1000、0440，父目录0750；policy/Compose0600。不存在的目录可创建，已有目录**包括空目录**都不覆盖。

全部角色有init、UID/GID1000、read-only、cap-drop ALL、no-new-privileges、PIDs128、受限tmpfs与轮转日志；**没有CPU/内存hardcap、CAP_SYS_NICE或整个Node的nice包装**。Docker restart固定no，由新root生命周期闭锁后启动。

## 经授权的安装/启动顺序

1. 保存正式/Beta原有CID、source/image、StartedAt、配置哈希及回滚材料。仅处理批准的新namespace、接口和文件，旧恢复服务不restart。
2. WG创建前先装独立bootstrap表`ak_cluster_beta_boot`，早于其他宽泛established规则，只允许指定peer/32的ICMP，其余新接口INPUT/FORWARD全DROP。TLS/auth/privatecode/素材先核验，不接公开Beta流量。
3. 配置批准WG接口/精确peer/32与路由。core按固定profile主动连接入口的批准UDP endpoint和keepalive；endpoint示例为 `192.0.2.10:<APPROVED_UDP_PORT>`，不是实际或可执行配置。私钥只在受保护文件和程序内存，不能回显。管理器仅接受实现白名单中的root-protected WG工具路径，不临时执行未知下载。
4. 生成上述bundle，把`host-policy.json`独立复制到`/etc/ark-cluster-beta/host-policy.json`（不通过会变化的symlink选版本）。保留真实bundle路径不改动。
5. 先执行`cluster-host-manager.py --config ... --action guard`：新core表`ak_cluster_beta_core`、新edge表`ak_cluster_beta_edge`闭锁，CAS摘要记录在各自`/run/<project>.guard.json`。只有所选profile新表的owned lease RULES按handle原子替换；不flush/restore全表，不改其他表。
6. 已证明新guard闭锁后，按bootstrap实存hash/handle核对，仅删除批准bootstrap拒绝RULES。否则bootstrap继续DROP，即使其他表ACCEPT也不能接流量。
7. 按模板安装独立`ark-cluster-beta-wg.service`依赖及core/edge manager服务。WG启动单元需独立安装审查，需要自己具备同一bootstrap-before-interface顺序；模板不会替调用者生成私钥或自动安装WG恢复。
8. manager `--action serve`先闭锁→查新WG→仅启动缺失的本namespace角色/按已核准CID恢复已停止角色→检查actual image/source/config/mount/network/PID/cgroup/startTicks→实际8+2/privatehealth或worker0/relay协议→**先reset-on-fork，再只Main -20**→全代次再核验→最后发布精确WG租约。
9. 全部批准入口均暖机并路由到全部game节点，再核验coordinator全部节点就绪、实际Nginx/TLS/认证/私有码/资源及浏览器。最后只更新所选profile的配套vhost；正常Nginx reload，不重启共享代理或其他game/auth。DNS改变不属于这些命令，也不因服务已启动自动执行。

## 健康与生命周期边界

- game：固定node/build/protocol/publicSlot、streamMarkers以及签名RPC私有`health.combat={status:ready,workers:N,ready:N}`、trial M/M（M=0为disabled 0/0），N/M取policy target（默认8/2）；N+M个真实WorkerThread，只有Main -20/reset，其他线程0。health不进入浏览器PONG，普通HTTP GET/health404不可套单体healthcheck。
- coordinator：原生GET health显示0 combat/0 trial、maxRooms0；真实WorkerThread数量0。它的browser build与runtime内容身份是不同字段，不冒称相等。
- ingress：GET health404+固定Origin的loopback WS upgrade、0 WorkerThread、固定源/路由/配置/代次；这是relay监听验证，不是TLS、口令或完整公网玩法验收。
- 每5秒检查固定代次；image/bridge的不可变ID元数据缓存，容器/PID/线程、runtime文件、私有health仍重读。不按入口在线人数推断后端CPU。
- 单个节点/入口故障只撤该角色租约，不关闭健康协调器和其他节点。相同进程/节点epoch的pool恢复可恢复原租约；**新PID/StartedAt/node generation绝不自动继承旧活跃租约**，需要显式闭锁启动生命周期。host policy/WG/table整体漂移才关闭本host新集群。
- 停止manager会只撤新WG租约，已完成Main策略保留，新容器暂留供诊断；它不会stop其他profile的容器。显式停所选profile计算用`--action stop`，先闭锁，再按记录的**全部本namespace immutable CID+image/source+StartedAt/restarts**逐个复核停用。代次不符拒绝，不按可复用名字盲停。先停止manager服务释放writer lock再执行stop；guard状态保留owned CID，即使先闭锁或某节点暂时不健康，也不丢停止凭据。
- manager不修改旧core/beta/prod工具、旧WG/recovery、其他站点、数据库或证书，不执行镜像清理。

一个coordinator仍是内存状态、无持久化/HA；game重启丢本节点局，coordinator重启可能丢全局身份/队列/目录。多个入口不是内存容灾。任何切换/回滚都不能恢复被重建的内存局。

game重启或失联时，coordinator不再让其房间永久停在“对局中”：状态RPC看到同一节点的新generation时立即关闭旧generation的已发布房间（`room.closed {reason:'node-restarted'}`）；连续`nodeLostMs`（默认15秒）无成功状态时关闭该节点的已发布房间（`node-unavailable`，与发布/撤权失败相同）。不迁移、不伪造结算；释放RPC保持原node/actor代次围栏，失联期间未确认的释放在同一generation恢复应答后补发一次，新generation则丢弃。客户端两种原因均有本地化文案（`public/js/main.js` CLOSE_REASON）。

## 协调器主线程测量

coordinator的原生`/healthz`在`performance`下额外带`phases`（仅coordinator；单体/game的health形状不变）：与10秒采样窗口同步轮换，每项为`{count,totalMs,maxMs,p50Ms,p99Ms,items,peakMs,totalCount}`，名称为固定代码常量或已校验的消息类型，例如`presence.publish`（每片发送数）、`net.heartbeat`（每片socket数）、`receipt.chunk/commit/parse/apply`、`receipt.worker`（Worker往返墙钟）、`match.plan/prepare/valid/commit/publish`、`queue.pump/sweep/population`、`ws.<type>`/`ws.hello`/`ws.close`（同步部分）、`static.<mount>`（含I/O等待的墙钟与请求数）及`gc.minor/major/incremental/weakcb`。只含计数与耗时，无会话/房间标识；匿名`/healthz`代理原样透出，不改变其门禁/no-store规则。

本地回放（仅127.0.0.1临时端口，不连共享或生产主机）：

```sh
node tools/coordbench.mjs --out before.json --server-root /path/to/baseline-export   # 基线树
node tools/coordbench.mjs --out after.json                                          # 当前树
```

默认1400个合成WS会话经2个ingress、4个合成game节点（无战斗Worker）、20人房间（约1.5MB结束收据）、4人公开匹配、重连抖动及`/shared` `/data`页面加载；按窗口报告事件循环延迟、ELU、CPU、同一组外部计时（两棵树可比）及`phases`。`--storm`在中途让全部会话断线重连（入口重启/集体刷新），`--offload-static`模拟Nginx已接管`/shared` `/data`，`--receipt-worker`开启下述收据Worker。数字只用于同机前后对比，不是容量或线上负载结论。

结束收据在coordinator只解码/解析一次，转成各成员`m.result`、最终`m.public`与summary的JSON文本；`cluster.terminal`由这些文本按字节拼接（公共部分只做一次UTF-8编码），不再逐成员重新序列化。coordinator配置可选`"receiptWorker": true`（默认关闭）：≥128KiB的收据改由一个`worker_threads`线程校验SHA-256并解析，Worker异常/超时回退到同一内联实现。它会让coordinator出现1个WorkerThread；受`cluster-host-manager.py`管理的core profile要求coordinator为0个WorkerThread，开启前须同版更新该线程合同与对应policy批准，未受管的同机栈可直接在runtime配置中开启。

## 追加与范围

应用CLI保留SIGHUP append-only路由/节点：先核验新game→先全部入口追加路由→最后coordinator允许新局选它，旧局不迁移。root inventory只接受固定的16节点，或Formal显式生成的32节点（新bundle、新key、整体替换），runtime SHA固定；**不能直接HUP修改文件而不同时准备相应守卫批准材料**，否则守卫按漂移撤权。不能声称已经支持运行中任意node增删。

## 本地验证

```sh
python3 -I deploy/stardust/tools/test_cluster_deploy.py
unshare --net python3 -I deploy/stardust/tools/cluster-kernel-check.py --isolated-netns
unshare --net python3 -I deploy/stardust/tools/cluster-traffic-check.py --isolated-netns
CLUSTER_NATIVE_PRIORITY=1 CLUSTER_NODE24="$VERIFIED_NODE24" \
  python3 -I deploy/stardust/tools/test_cluster_native_priority.py
```

以上仅为本地检查入口，不声明任何环境已通过。准备器回归应覆盖copied-installed-layout、受保护路径、停止前全CID预检、代次变化拒绝及镜像/角色/绑定/key mount校验；kernel检查应覆盖闭锁→发布→关闭、CAS、foreign-table保持及wrong-port/direct-IP/wrong-peer/foreign-interface/已established关闭。

native fixture的Docker metadata注入不等于实际Compose镜像身份验收；veth/DNAT检查不证明WG加密或实机TLS/auth。独立实际Docker priority检查还需opt-in：

```sh
CLUSTER_DOCKER_PRIORITY=1 CLUSTER_PRIORITY_IMAGE="$APPROVED_LOCAL_IMAGE_ID" \
  python3 -I deploy/stardust/tools/test_cluster_docker_priority.py
```

镜像必须已在本地并明确pin。mount数组仅在逐行严格验证后按无序语义规范化，路径、只读及metadata变化仍拒绝；不能因inspect顺序不同而放宽generation fencing。

私有码的独立工具及验证边界见[PRIVATE-CODE.md](PRIVATE-CODE.md)。实际source/image、安装和逐角色结果应在本地私有记录中逐项保存；不从模板或单角色fixture推断全profile已部署。
