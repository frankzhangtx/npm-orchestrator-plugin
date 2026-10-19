# Android 普适性与持续运行实现进度

更新日期：2026-09-30。对应 [评审文档](../design/orchestrator-portability-and-continuity-review.md)。

## 最新发布：1.1.0 已发布 npm

2026-09-30 晚间按用户明确要求完成 npm 发布；浏览器登录及发布验证完成后，以 `frankzhang2026` 账号将已审阅的固定 tarball 发布到官方 Registry。

- 包：`@frankzhang2026/opencode-android-orchestrator@1.1.0`，公开访问，`latest` 已指向 `1.1.0`。
- 源码提交：`9bd6cd553aa42f4f7f79397e7da248d961ada234`，此前已推送 GitHub `main`。
- 新构建的发布包与下午审阅包的 SHA-1/SHA-512 完全一致；Registry 下载包与实际发布包逐字节一致，共 223 个文件。
- SHA-256：`28e8718c122bfe62624e99dd69a2fb5419c3886acdac7d20a9655dc90067006f`。
- npm 处理期间短暂返回版本不存在，等待后版本查询及固定版本下载均成功；没有重复发布。
- [发布核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/npm-publication/publication-status.json)、[Registry 元数据](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/npm-publication/registry-metadata.json)。

未升级当前 Android 工程安装实例。下方“未发布 npm”等表述保留为发布前历史记录。

## 1.1.0 版本与 Git 远程交付核验

9 月 30 日晚间恢复下午最后一项请求：“包版本号升级一下，然后提交到 git 远程”。下午已完成提交与推送，会话缺少最终交付说明；本次核验并补齐记录，未重复提交。

- 产品版本已升至 **1.1.0**；包元数据、锁文件、安装器版本固定值、文档与版本断言已同步更新。
- 提交为 `9bd6cd553aa42f4f7f79397e7da248d961ada234`（`Release Orchestrator 1.1.0`），远程为 `frankzhangtx/npm-orchestrator-plugin` 的 `main`。
- 本地远程引用日志记录原推送时间为 **2026-09-30 16:55:23 +08:00**；今晚通过 `git ls-remote origin refs/heads/main` 实时确认 GitHub main 与本地提交一致。
- 产品仓库工作区干净；92 个提交文件的内容摘要及权限与下午审阅清单全部一致。
- 下午最终版本专项 **71/71 通过**，构建与打包预检通过，包内 223 个文件；功能实现此前全量 **318/318**、Shell **46/46**、真实 Android 集成链 **1/1** 通过。本次未修改产品源码，未重复运行测试。
- [版本专项日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/version-tests.log)、[交付核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/final-verification.json)。

版本升级及 Git 远程交付请求已完成。未发布 npm、未创建 Git tag/GitHub Release、未升级当前 Android 工程安装实例；其他功能待办仍保持原状态。以下各轮版本与未提交描述为当时交付记录。

## 核对基准

- 产品源码：`/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`。
- 既有 HEAD：`8a3d1c410cd0a8beb95c52015e540d48fcf2bd66`，另有未提交 V4 清单实现；本轮保留这些修改。
- 工作副本：`orchestrator-android-continuity-work/source/`；基准副本为同级 `baseline/`。
- 开始时产品源码与 `orchestrator-android-continuity-validation/starting-inventory.json` 的文件摘要一致。
- 开始时工作副本只有 `orchestrate-task.sh` 的循环次数修改，尚无配套测试；其预算耗尽分支还缺一次终态读取。

## 逐项状态

“完成”仅表示列出的实现与对应回归范围，不表示整个评审验收完成。

| 评审项 | 本轮实现情况 | 剩余工作 |
| --- | --- | --- |
| 1 Reviewer 恢复参数不一致 | 已修复：队列仍验证恢复审批，调用单参数 Shell 入口；不重跑 Coder，重新核对候选摘要 | 真实模型/供应商中断验证仍需单列 |
| 2 两轮 Review 修复不能执行 | 已修复：步数按 `4 * (maxReviewCycles + 1) + 1` 计算，包含预算耗尽及终态读取 | 已覆盖 0/1/2 轮成功及耗尽；并非新增模型成本预算 |
| 3 单任务失败阻塞后续任务 | 已交付任务级失败隔离；第七轮新增显式 V8 `isolatedWorktree + autoCommit`，安全封存失败任务后继续独立任务，成功任务完成本地集成及可选清理 | 依赖任务仍须等待实际集成；已开始的提交事务须显式恢复；默认固定目录、人工验收策略保持原值 |
| 4 失败分类及独立重试预算 | 部分：Agent 失败保持任务级；V5 基线分类恢复与 V7 RED/GREEN/Reviewer 确定性验证恢复已交付；累计预算、持久退避、输入/证据绑定和验证见第四轮 | 模型/供应商调用恢复、模型成本预算和跨多次恢复的整个任务总时限尚未实现；V6 单次执行时限见第三轮 |
| 5 基线阶段恢复 | 已交付显式 V5 协议：全量/发现/采集检查点，失败尝试留存，绑定合同、HEAD、工作区输入、配置及记录的工具环境；完成后才封存 baseline.json，拒绝覆盖成功证据 | V4 保持旧规则；没有持久结果的 RUNNING 崩溃尝试仍要求进程诊断/批准归档；真实 Android 故障注入待验收 |
| 6 Review 追加测试证据 | 未实现；RED 后测试冻结仍保留 | 新证据版本、原基线隔离复验、旧 RED/manifest 留存、禁止弱化断言 |
| 7 批量任务规划基线刷新 | 第七轮交付显式 V8：单独声明并封存 `planningInputs`；仅在输入/执行配置未变且中间提交均为可核验的已完成队列集成时，在执行前刷新并重新准备基线 | 规划输入的语义完整性依赖声明；不确定时选择拒绝刷新；外部提交、输入变化及已开始任务不自动重新规划或 rebase |
| 8 Android 工程能力模型 | 第五轮交付源集/任务/依赖快照；第六轮补齐显式嵌套构建根，安装/升级、SDK、Shell、清单采集和隔离工作区共用选择；305 项最终回归及真实嵌套 Android 验证通过，已同步源码 | 复合构建、最小反向影响调度及更多 flavor/插件组合仍未交付 |
| 9 任务类型和验收策略 | 未实现；V4 仍要求至少一项行为 RED | 新接口骨架、刻画/重构、补测、UI/资源、文档/配置、基线修复协议；旧合同保持原门槛 |
| 10 可靠验收来源 | 未实现；来源标签仍非测量证明 | 受控旧行为采样、独立草稿复核、准备期身份绑定、合同修订差异 |
| 第四节运行机制 | 第三轮新增 V6 单次 Worker/阶段截止、独立监督、归属核验、TERM/KILL 和退出确认；验证与同步记录见下 | 整个任务的无进展判定、可选系统守护、runtime 水位、日志轮转、可恢复归档、通知聚合及真实休眠/重启实测 |
| 第六节长期验收 | 未完成 | 单模块及多模块真实 Android 生命周期、网络/限流/超时/休眠/重启注入、24 小时运行及质量/成本/磁盘统计 |

## 本轮回归设计

- `tests/queue-review-continuity.test.mjs`：真实队列 Worker 和安装模板 Shell 链路；模拟 Agent/Gradle。覆盖 0/1/2 轮成功与耗尽、Reviewer 非零退出、审批拒绝、原候选恢复及篡改拒绝。
- `tests/queue-failures.test.mjs`：固定目录失败保留占用；隔离任务 A 失败、B 通过验收和本地集成、C 等待 A，A 的工作区仍保留。
- `tests/queue-capabilities.test.mjs`：缺少可选能力时完成其他必需门槛；V3/V4 需要缺失设备能力时，在草稿审批之前拒绝。
- `tests/gradle-verification.test.mjs`、`tests/adaptive-templates.test.mjs`、`tests/installation-doctor.test.mjs`：发现结果、模板、安装及 doctor 接受空可选能力；必需构建能力仍不可缺失；启用缺失 lint 时失败。
- 完整测试还验证原有安装、升级、卸载、权限、证据冻结和提交事务。本轮没有改动 Android 应用，无需以该应用的 JVM 测试替代插件测试。

真实队列/Shell 回归中的 Agent 与 Gradle 是确定性夹具，不能据此声称真实 Android 构建、模型恢复或长期无人值守已通过。

## 交付记录

- `npm run build`：工作副本和同步后的产品仓库均通过；132 个编译输出文件逐字节一致。
- `npm test`：最终 241 项通过、0 失败、0 跳过，耗时约 278 秒。初次完整回归的 3 项旧模板摘要/断言失败已更新并通过复验；最终完整结果见 [full-final.log](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/full-final.log)。
- `npm run pack:check`：通过，205 个发布文件；见 [pack-check.log](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/pack-check.log)。这是打包预检，未发布包。
- 同步状态：24 个文件已同步到产品源码并验证摘要，141 个未涉及的基准文件保持原样，保留原有未提交 V4 修改。同步清单见 [reviewed-changes.json](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/reviewed-changes.json)，可审阅补丁见 [continuity-changes.patch](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/continuity-changes.patch)。
- `git diff --check`：产品仓库通过。汇总证明见 [final-verification.json](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/final-verification.json)。
- 未发布 npm、未推送远程、未升级当前 Android 工程的安装实例。

## 下一批建议实现边界

### 2026-09-27 第二轮：基线恢复和分类预算（2026-09-28 已交付）

本轮分步交付，每一步完成后记录测试结果：

1. [x] 新增显式 V5 基线恢复策略与分类器；旧 V4 合同保持原语义。基线环境重试使用独立预算，不调用模型、不消耗原有测试准备/实现/Review 修复预算；未知错误只允许在显式批准且人工恢复预算内处理。`recovery-policy.test.mjs` 3 项通过，覆盖策略边界、分类优先级、持久计数、退避、总时限及重复无进展停止。
2. [x] 分离全量基线尝试、成功检查点和最终封存；绑定合同、HEAD、工作区输入、配置及工具；失败历史保留。首批阶段故障测试通过，只有全部采集成功才生成 `baseline.json`；成功的 `baseline-full.json` 保持原字节。另增加了发现检查点复用，续做时已完成边界回归。
3. [x] 接入持久退避与队列恢复；沿用原进程退出和租约检查。重新读取持久队列后可在批准预算内恢复，基线完成后才启动模型；预算不与 RED 准备和实现修复混用。首批 5 项队列/Shell 测试全部通过。
4. [x] 确定性夹具故障注入覆盖网络、限流、历史失败、未知失败、预算耗尽、持久队列重载、输入/证据篡改及阶段恢复；机器重启和真实供应商/Android 环境不在本轮证明范围。
5. [x] 更新安装模板、Schema、操作指令和迁移说明；266 项全量回归及打包检查通过，37 个文件已同步产品仓库。

第二轮基准已独立保存为 `orchestrator-android-continuity-work/baseline-recovery-start/`，证据目录为 `orchestrator-android-continuity-validation/recovery/`。上一轮交付记录保留。

第二轮交付时边界：本轮自动重试只作用于基线的确定性采集命令，RED/GREEN/Reviewer 中的环境重试暂不新增。`maxElapsedMs` 限制恢复窗口和新尝试的启动，不代表已完成卡死进程的安全终止。步骤 2/3 已接入产品源码，真实队列/Shell 加确定性 Gradle/Agent 的故障注入回归已通过。

已通过新合同 V5 明确基线恢复窗口、独立预算、退避和检查点条件。当时的下一步是 Worker/Agent 阶段截止与安全终止（第三轮见下）；RED/GREEN/Reviewer 阶段分类恢复仍待实现。已有 V4 合同继续原语义；不能以升级名义自动授予重试、测试改写或自动集成权限。

之后补齐共享 Android 工程描述（真实源集、变体、依赖影响、构建根），再实现任务类型、采样及追加证据。最后交付隔离自动本地集成、规划刷新、归档守护与长期实测。


### 2026-09-28 续做：第二轮交付记录

已从昨天的工作副本继续实施，开始前确认产品仓库的 165 个基准文件与第二轮快照一致。

- 原有 16 项基线恢复/分类预算测试全部通过，包含全量、发现、采集三阶段恢复，队列重载、独立预算、未知失败审批、输入和证据拒绝。
- 补充队列与安装 Shell 的 V5 合同校验一致性；V4 默认示例及旧合同规则保持原样。
- 收紧失败分类：信号终止或成功命令中的网络文本不能授予自动重试权限；检查点及保留日志拒绝符号链接替换。
- 保持人工白名单文件的排除语义，同时将排除策略摘要绑定到恢复记录。
- 扩展历史失败、日志修改、目标 HEAD 前进、暂停/撤销/截止时间、隔离工作区满容量时原地恢复等回归。
- 更新 Planner/Coder/Reviewer、编排指令、Schema 说明、迁移和故障排查；新增 recovery.cjs 后管理资源总数为 51。

验证与同步已完成：

- `npm test`：266 项通过，0 失败、0 跳过，耗时约 459 秒；[最终完整日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/recovery/full-final.log)。首轮 5 项旧 Schema/管理文件数量断言失败已修正，首轮日志保留备查。
- `npm run pack:check`：通过，206 个发布文件；[打包预检日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/recovery/pack-check.log)。新增恢复模块后共 51 个项目管理资源。
- 工作副本及产品源码 `npm run build` 均通过；132 个编译输出逐字节一致；产品仓库 `git diff --check` 通过。
- 37 个文件已同步至 `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator` 并核对摘要；131 个未涉及的基准文件保持原样，原有未提交修改保留。
- [审阅补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/recovery/recovery-changes.patch)、[文件清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/recovery/reviewed-changes.json)、[汇总核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/recovery/final-verification.json)。
- 未发布 npm、未推送远程、未升级当前 Android 工程的安装实例。V5 为待发布开发能力，包版本仍为 1.0.5；发布前须使用新包版本，不能把同版本 upgrade 当作模板更新入口。

本次验证使用真实队列、独立 Worker 进程和安装 Shell，Gradle 与 Agent 为确定性夹具。队列重载证明持久预算与退避不丢失，不等同于机器重启/休眠或真实模型故障恢复。`maxElapsedMs` 限制恢复窗口和新尝试启动，不会终止卡死进程。第二轮交付时，Worker 安全终止仍未实现（第三轮见下）。Android 工程能力模型、其他阶段分类恢复、追加测试证据、隔离自动集成和长期实测仍未完成；整体评审验收清单保持未完成状态。


### 2026-09-28 第三轮：Worker 安全终止

独立基准为 `orchestrator-android-continuity-work/worker-termination-start/`，开始前核对产品仓库 168 个文件一致。实现和测试位于工作副本，交付证据保存在 `orchestrator-android-continuity-validation/worker-termination/`。

实现范围：

- 新任务合同 V6 显式批准 `execution`：`maxRunMs`、`maxStageMs`、`terminationGraceMs`。保持 V4 默认示例及 V1–V5 权限；V6 同时保留 V5 基线恢复协议。每次执行、恢复、集成和归档均受本次执行预算约束，不能将它等同于跨恢复的任务总预算。
- 独立 Supervisor 位于 Worker 进程组之外，即使 Worker 事件循环停止，也会检查持久运行/阶段截止。阶段包括准备、基线、编码、Review、集成和归档；日志静默不作为终止条件。
- 使用唯一继承标记和观察到的进程祖先关系，并记录 PID、启动时间及进程组。每次 TERM/KILL 前重新读取进程身份，只对证明归属的进程逐个发信号；不按名称或整个进程组批量终止。受控 Gradle 使用 `--no-daemon`，Worker 环境也禁用共享 Gradle daemon。
- TERM 意图、结果和宽限期起点持久化；宽限期结束仍存活则 KILL。两次空归属快照后才允许退出确认及调度。归属、锁或时钟不确定时进入 `OWNERSHIP_BLOCKED`，保留槽位与租约。
- 服务停止不影响已有 Supervisor；Supervisor 崩溃后调度器接管同一 Worker，保留原运行/阶段期限和 TERM 宽限期，不重启执行。属于该执行的已退出锁拥有者可被核验恢复，其他锁继续拒绝。
- 超时保留全部现场和证据；隔离候选安全封存后，独立 B 可继续，依赖 A 的 C 继续等待。固定目录保留占用。已有本地提交事务时进入 `INTEGRATION_BLOCKED`，恢复仍使用同一事务和提交，不重复提交。
- 公共队列状态、任务详情、控制命令和 Shell 状态均不输出归属令牌；审计证据记录期限、信号意图/结果及退出确认，原始进程环境不写日志。

验证边界：测试使用真实队列、Supervisor、Worker、Shell 和可停止/忽略 TERM 的进程；Gradle 与模型为确定性夹具。休眠按持久墙钟前进建模，未实际让机器休眠或重启。机器重启后仍须启动队列服务；本轮没有安装系统守护，也不是操作系统级进程容器，外部服务和移除归属标记的逃逸进程不在允许的执行模型内。

验证与同步已完成：

- 首次完整 `npm test`：275 项，274 通过、1 项因夹具超时取消，原有 266 项全部通过。问题是故意保留 Worker 后，夹具仍等待其输出管道关闭，且已退出 Supervisor 的超时清理触发 ESRCH；已修正等待方式和夹具清理，并按归属清理测试残留。[首次全量日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/full-initial.log) 保留。修正后没有重跑整套全量，以下为最终增量复验。
- `node --test tests/worker-supervision.test.mjs`：10 项全部通过，0 失败/取消/跳过，约 220 秒；覆盖权限边界、墙钟预算、CLI/Shell 脱敏、真实进程信号、停止的 Worker、TERM 抵抗及脱离进程组的子进程、不误杀旁路进程、独立/依赖任务、TERM 宽限期重启、归属拒绝、正常集成和同一提交恢复。[专项最终日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/worker-final.log)。
- 最终模板迁移、文档、工具和队列服务复验 33 项全部通过；[相关回归日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/related-final.log)。
- `npm run typecheck`、工作副本及产品源码的 `npm run build` 均通过；140 个编译输出逐字节一致；产品仓库 `git diff --check` 通过。
- `npm run pack:check` 通过，214 个发布文件，项目管理资源仍为 51；[打包日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/pack-check.log)。
- 30 个审阅文件已同步产品仓库，141 个未涉及基准文件保持原样；原有未提交修改保留。对应 [文件清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/reviewed-changes.json)、[审阅补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/worker-termination-changes.patch)、[汇总核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/worker-termination/final-verification.json)。
- V6 为未发布开发协议；包版本仍为 1.0.5，发布前需新版本。未发布 npm、未推送远程、未升级当前 Android 工程的安装实例。


### 2026-09-29 第四轮：V7 阶段验证恢复已交付

恢复的是 9 月 28 日中断的 `stage-recovery` 工作，独立基准为 `orchestrator-android-continuity-work/stage-recovery-start/`，证据在 `orchestrator-android-continuity-validation/stage-recovery/`。开始时产品仓库 171 个基准文件全部与昨日快照一致。

本轮实现范围：

- 新 V7 合同显式批准 `stageRecovery`，同时保留 V5 基线恢复和 V6 Worker 监督策略。默认样例仍为 V4，旧合同不自动获得新恢复权限。
- RED、GREEN、Reviewer 的确定性验证命令分别记录累计环境重试预算、恢复窗口、同类失败次数及带抖动的持久退避；跨 Review 修复循环不重置预算。只对明确临时网络和限流故障重试，不自动重放模型调用、审批或提交事务。
- 临时故障不消耗测试准备、实现修复或 Review 修复次数。Reviewer 环境预算耗尽进入 BLOCKED，不生成 CHANGES_REQUESTED 或批准结果。
- 保留每次命令日志、退出状态与清单证据，绑定合同、HEAD、工作文件、配置、工具环境和 baseline/RED 证据。阶段账本摘要由当前受监督 Worker 写入队列；修改或删除账本不能重置预算，未知调用者不能写入检查点。
- 补修合法生产文件删除的输入快照：删除状态保留在摘要中；等待期间恢复或更改输入仍使证据失效。
- macOS 退出窗口沿用已见证的 PID、启动时间和进程组证明；真正身份变化仍拒绝。另修正监督层读取未写完或刚释放的事务锁时立即阻塞的竞态；不删除模糊锁，正常事务仍等待或拒绝占用锁，未知死锁不能被自动接管。

当前验证记录：

- 续做初始专项 11/11 通过，约 180 秒；[初始专项](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/focused-resumed.log)。
- 首次完整回归 288 项，287 通过、1 失败：Reviewer 耗尽用例在 GREEN 完成时被监督状态拒绝，单独复验通过。该次夹具没有保存完整监督诊断，不能仅凭退出文字断言唯一根因；已增加脱敏诊断，并补修审查发现的事务锁读取竞态。[首次全量](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/full-final.log)、[单独复验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/review-exhaustion-diagnostic.log)。
- 新增锁边界专项 2/2 通过，验证部分写入保持原字节、活锁/未知死锁拒绝接管、已证明归属的死锁允许恢复；[锁专项](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/lock-final.log)。
- Shell 46/46 通过；[Shell 日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/shell-final.log)。
- 最终完整 `npm test`：290/290 通过，0 失败、0 取消、0 跳过，约 499 秒；包含 V7 的 12 项专项、新增锁边界 2 项、V6 的 10 项监督测试及旧协议回归。[最终全量](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/full-verified.log)。
- 最终类型检查、工作副本及产品源码构建均通过；140 个编译产物逐字节和权限一致。最终打包预检通过，共 214 个发布文件、51 个项目管理资源；[类型检查](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/typecheck-final.log)、[打包预检](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/pack-verified.log)。最初打包预检被沙箱的 npm 缓存写入限制阻断，提权重跑通过；失败日志保留。
- 30 个审阅文件已同步产品源码，143 个未涉及基准文件保持原样，保留之前的未提交修改；`git diff --check` 与补丁反向应用检查通过。[文件清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/reviewed-changes.json)、[审阅补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/stage-recovery-changes.patch)、[最终核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/final-verification.json)。
- 包版本仍为 1.0.5，V7 属于未发布开发能力；未发布 npm、未推送、未升级当前 Android 工程安装实例。发布前须使用新版本。

边界：以上阶段用例执行真实队列、Supervisor、Worker 和安装 Shell；Gradle 与 Agent 使用确定性夹具。等待保留当前 Worker 槽位，V6 截止仍有效；崩溃留下未知结果或恢复锁时要求诊断及批准归档/新合同，不能声称支持自动续接被杀死的模型调用或机器重启后原地续跑。整个任务总时限、模型成本预算、Android 工程能力模型、追加证据、自动隔离集成、规划刷新及长期实测仍待完成。


### 2026-09-29 第五轮：Android 工程能力模型已交付

恢复会话 `01a0eabf-f670-7c90-a43f-fbe55ed56996` 中断的 Android 模型工作。
独立基准为 `orchestrator-android-continuity-work/android-model-start/`，
证据在 `orchestrator-android-continuity-validation/android-model/`。
续做开始时产品仓库 173 个基准文件与快照一致，保留已有未提交修改。

实现范围：

- Gradle 运行时输出版本 1 的能力快照：模块身份、实际 DSL 源集、Java/Kotlin/资源和 manifest 路径、注册的验证任务、工程内部依赖边。纳入 Android 直接或传递依赖的 JVM 库，排除无关 JVM 项目。
- 配置、默认合同编辑范围、安装器、doctor 与 Shell 共用受保护的 `project.cjs` 校验。拒绝源集/模块身份不一致、伪造任务、遗漏全量单测或构建任务、外部/生成/符号链接源集及生产/测试重叠。管理资源由 51 增至 52。
- 全量矩阵保留所有已注册本地 Test 任务和生产 assemble 变体；无本地测试的变体仍构建，Debug 优先反馈。Android 消费者也在全量矩阵内，因此 JVM 库改动不会只测库自身。这是保守全量验证，未实现最小反向依赖调度。
- 排除 assemble 测试聚合任务、lint 分析/报告内部任务及会修改源码的 lintFix。lint/device 缺失能力保持原规则；设备任务发现不代表设备测试已执行。
- 旧安装升级继续旧源集规则；已有快照在升级事务中保留，不重新运行 Gradle 或改变已批准合同。构建布局变动需要重新发现并审阅配置。嵌套构建执行尚未实现；复合构建明确拒绝，不能声称已有完整外部构建依赖模型。

已发现并处理的问题：

- 上次专项 39/40；唯一失败为沙箱禁止 `ps`（EPERM）。本次沙箱外全量回归中该用例通过。
- 上次真实 Android 夹具禁用了 Debug，但未启用 Staging 单测，Gradle 未注册对应任务；修正为显式 `enableUnitTest=true`。真实诊断记录在 `android-model/capability-task-probe.log`，初次失败日志保留。
- 中间真实生命周期测试已构建/安装成功，在同版本升级处收到正确的 `UPGRADE_NOT_REQUIRED`；修正测试，保留同版本拒绝检查，并以模拟旧版本 manifest 验证升级事务。它不代表发布过带此模型的旧包。
- 本次首次全量 295 项：291 通过、4 失败，均为新增管理资源后卸载/升级数量断言未更新，已修正。日志为 `full-resumed.log`。

当前验证：

- 真实 Gradle 9.4.1 / AGP 9.2.1 / SDK 36 的多模块测试 1/1 通过：自定义 Java/Kotlin/测试资源目录、projectDir 重映射、仅 Staging 变体、Android→Android→JVM 传递依赖、无关失败 JVM 项目排除、真实单测和 AAR 构建、安装/doctor/Shell 校验、模拟旧版本升级/卸载以及复合构建拒绝。最终日志 `android-final.log`；发现模型、构建日志及 3 份 JUnit XML 保存在 `real-android/`。
- Shell 46/46 通过：`shell-verified.log`。Gradle 编译和测试真实执行；OpenCode 版本及安装时 smoke 响应是夹具，无真实模型调用、设备运行或长期运行证明。
- 第二次完整回归 295 项：293 通过、2 失败（`full-verified.log`）：V7 重试在锁归属检查被阻塞，以及 Supervisor 重启等待超时。该日志不能证明两个用例的唯一共同根因。
- 审查补修了查询锁拥有者之后的竞态：锁可能已经正常释放或被新事务替换。拒绝或恢复前重新核对 pid/start/token，恢复入口绑定同一锁代次；保留未知死锁的拒绝规则。新增确定性测试在进程查询时释放/替换锁，并验证旧归属不能恢复新锁。
- 监督补修定向回归中，两个原失败用例与原锁边界通过；新测试先因夹具未创建锁目录失败，修正初始化后锁专项 3/3 通过。保留 `supervision-fix.log` 的中间结果，最终全量包含修正后的专项。
- 第三次完整回归 296 项：295 通过、1 个监督重启超时（`full-final.log`），锁读取竞态专项通过。重启用例单独 1/1 和与恢复用例并发 41/41 均通过；分别见 `restart-diagnostic.log` 和 `restart-concurrent-diagnostic.log`，未复现时不能断言全量超时的唯一根因。
- 进一步消除锁创建窗口：先写入并刷盘完整拥有者记录，再以同目录独占硬链接原子创建锁；创建前崩溃不占用事务锁，创建后崩溃留下完整归属。旧空锁/未知锁仍拒绝接管。新增真实进程在原子创建前后被 KILL 的专项，加锁竞争和服务回归，共 7/7 通过（`atomic-lock-final.log`）。崩溃前的 pending 文件可能留存，不自动删除其他进程的 pending 文件。
- 原子锁修复后全量 297 项：296 通过、1 个阶段账本篡改用例失败（`full-delivery.log`）；监督重启已通过。发现退避循环重复保存可能覆盖外部修改，以及写入后读取摘要可能吸收外部修改的窗口；修正为等待期不写账本、更新前验证旧摘要、以待写内容的摘要封存，并在封存前后复核。新增确定性测试在更新前、原子发布后及封存回调中篡改，专项和模板校验 6/6 通过。
- 最终完整 `npm test` **298/298 通过**，0 失败、0 取消、0 跳过，约 501 秒；含阶段账本拒绝、监督重启、原子锁崩溃测试、Android 模型及旧协议回归。[最终全量日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/full-complete.log)。
- 最终类型检查、工作副本及产品源码构建通过；148 个编译文件内容和权限完全一致。打包预检通过，223 个发布文件、52 个项目管理资源。[类型检查](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/typecheck-delivery.log)、[打包预检](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/pack-delivery.log)。
- **30 个审阅文件已同步**到 `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator` 并核对摘要；149 个未涉及基准文件保持原样，保留既有未提交修改。产品仓库 `git diff --check` 和补丁反向检查通过。[审阅清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/reviewed-changes.json)、[完整补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/android-model-changes.patch)、[最终核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/android-model/final-verification.json)。
- 包版本仍为 1.0.5，本轮为未发布开发能力。未发布 npm、未推送、未升级当前 Android 工程的安装实例。发布须使用新版本。

能力边界：本轮模型记录 DSL 声明源集，不证明被禁用变体的覆盖率，也不处理任意插件生成的源文件；真实验证覆盖上述 Staging 组合，不等同于所有 flavor、AGP 或工程插件兼容。任务类型、追加证据、自动隔离集成、规划刷新和长期实测仍保持未完成。


### 2026-09-30 第六轮：嵌套 Android 构建目录已交付

恢复 9 月 29 日晚间中断的 `nested-root` 工作。独立基准为
`orchestrator-android-continuity-work/nested-root-start/`，证据目录为
`orchestrator-android-continuity-validation/nested-root/`。开始时产品源码与
179 个基准文件的摘要一致；工作副本有 23 个未同步文件，保留此前已交付修改。

实现范围：

- 从选定的 Gradle settings 目录初始化，例如 `repo/android`；能力快照以仓库相对路径记录 `buildRoot`。安装资源、Git、队列和合同路径使用仓库根目录，Gradle、清单采集和 SDK 查找使用选定构建目录。
- doctor、升级及显式重新发现保留该构建选择。嵌套 wrapper、settings、Gradle 配置与构建逻辑受到保护；缺少快照、源集越界或目录符号链接被拒绝，不回退到仓库根或兄弟构建。
- 隔离工作区在自身 checkout 内解析相同相对构建目录；Worker 从原源码的选定目录解析 SDK，不复制被忽略的 `local.properties`。无人执行的嵌套 Gradle 命令须经过受管脚本。
- baseline/RED 与测试采集进程记录实际工作目录；默认合同范围不纳入兄弟构建。
- 修复本轮新发现的 V7 集成阻断：运行时 `stageRecovery` 检查点此前被误纳入原合同审批摘要。现从草稿摘要排除该运行字段，合同内恢复策略、依赖及提交策略仍受原审批摘要保护。阶段账本自身的摘要校验和受监督 Worker 写入门槛保持有效。

验证记录：

- 昨晚全量 304 项：297 通过、7 失败，包含 3 项旧模板摘要和 4 项 90 秒夹具超时；保留 `full-tests.log`，不计为通过。昨晚真实嵌套 Android 1/1 通过，但临时目录已丢失，本次重新验证并持久保存产物。
- 更新两个摘要测试文件后定向复验 34 项：33 通过、1 失败，暴露上述 V7 审批摘要问题；见 `focused-resumed.log`。修复后专项 **2/2** 通过，包含合同篡改拒绝与 V7 嵌套目录完整本地集成；见 `authorization-fix.log`。
- 最终完整 `npm test` **305/305 通过**，0 失败、0 取消、0 跳过，约 576 秒。覆盖根目录旧协议、嵌套 V3/V4/V7、固定/隔离工作区、人工批准本地集成、错误 wrapper 拒绝、恢复账本及监督流程。[完整日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/full-final.log)。没有放宽测试时限或产品截止预算；本次全量与真实 Android 构建分开执行，不据此断言昨晚超时的唯一根因。
- 真实 Gradle 9.4.1 / AGP 9.2.1 / SDK 36 嵌套 Android 集成 **1/1 通过**，约 148 秒：Staging 变体、自定义源集、Android→Android→JVM 依赖、66 项构建任务实际执行、安装/doctor、模拟旧 manifest 的升级与重新发现、独立工作区全量单测、baseline→RED→GREEN→check、卸载及复合构建拒绝。[真实日志](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/real-android-final.log)，构建日志、JUnit XML 和采集证据保存在 `nested-root/real-android/capabilities-android-uKRjKW/`。
- Shell **46/46** 通过；沿用昨晚 `shell-tests.log`，之后未修改 Shell 模板。最终类型检查和打包预检通过，共 223 个发布文件、52 个项目管理资源。[类型检查](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/typecheck.log)、[打包预检](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/pack-check.log)。
- **27 个审阅文件已同步产品源码**，153 个未涉及基准文件保持原样；工作副本与产品源码构建通过，148 个编译输出的内容和权限一致。产品仓库 `git diff --check` 与审阅补丁反向检查通过。[审阅清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/reviewed-changes.json)、[完整补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/nested-root-changes.patch)、[最终核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/nested-root/final-verification.json)。

边界：真实 Android 测试的 Gradle 编译和单测实际执行；安装时 OpenCode 版本/smoke 响应与队列测试中的模型仍为夹具。未执行真实模型、设备测试、机器休眠/重启或长期运行验收。复合构建、多构建联合调度、最小反向影响矩阵及更多 flavor/插件组合仍未交付。任务类型、追加证据、隔离自动集成、规划刷新和长期验收清单保持未完成。

包版本仍为 1.0.5，本轮为未发布开发能力。未提交、未推送、未发布 npm、未升级当前 Android 工程安装实例；发布须使用新版本。


### 2026-09-30 第七轮：自动隔离集成与规划刷新已交付

本轮按用户要求继续自动隔离集成等功能。独立基准为
`orchestrator-android-continuity-work/isolated-integration-start/`；本轮快照核对
162 个源码/模板/测试/文档文件，未纳入未改动的历史 release 目录。
证据保存在 `orchestrator-android-continuity-validation/isolated-integration/`。

- 已实现显式 V8 `continuity`：隔离自动集成、声明式规划输入快照及仅允许已完成队列集成的基线刷新；保留原合同/规划 HEAD，不增加旧合同权限。
- 已实现自动集成前的源目录/目标 HEAD 检查及最终中止/撤销检查；沿用同一串行槽和五阶段提交事务。
- 初始 10 项专项全部通过，包括 A→B 两次自动本地集成、失败 A/独立 B/依赖 C、输入/外部提交/配置/禁止刷新拒绝、撤销及目标漂移；见 `focused-initial.log`。
- COMMITTED/INTEGRATED 两种真实 Worker 中断恢复专项 2/2 通过，复用原事务和原提交；见 `recovery-focused.log`。
- 最终中止边界与共享验证专项 2/2、模板迁移专项 18/18 通过，分别见 `abort-boundary.log` 和 `templates-focused.log`。
- 首次真实 Android 基线因夹具缺少依赖仓库而失败（Kotlin 标准库无法解析）；已修正夹具，原日志和目录保留。最终真实 Gradle 9.4.1 / AGP 9.2.1 / SDK 36 的两任务自动集成链 **1/1 通过**，约 489 秒；见 `real-android-final.log`。两份合同在原始 HEAD 批准，依次执行全量基线、RED、GREEN、独立验证、本地集成和工作区清理；第二个任务在首个任务集成后准备新基线。Gradle 编译、JUnit 测试、队列/Shell/事务实际执行，Coder/Reviewer 为模拟响应，无真实模型调用。证据保存在 `real-android/orchestrator-queue-test-p2YL8w/summary.json` 及其项目 `.git/automation-runtime/`。
- 最终类型检查和打包预检通过，223 个发布文件。全量回归发现 doctor 的旧断言仍禁止隔离自动提交配置；已更新为接受该配置、拒绝无效提交策略，执行权限仍由 V8 合同单独校验，定向复验 1/1 通过（`doctor-focused.log`）。
- Shell **46/46 通过**（`shell-final.log`）。补齐随插件安装的 Orchestrator 操作指引后，模板校验 **4/4** 通过（`orchestrator-template-final.log`），最终打包预检重新通过。
- 首次完整回归 **315/318**，约 714 秒，保留 `full-initial.log`：doctor 旧断言已修正；V7 三阶段重试用例触发 90 秒夹具超时，日志已到 AWAITING_HUMAN；升级回滚用例被 PLAN_STALE 拒绝，运行期间补齐过模板，不能将这次运行视为固定输入的最终验证。后两项冻结源码定向复验 **2/2 通过**（`failure-diagnostic.log`），阶段重试约 46 秒；未修改旧夹具超时或产品截止预算。
- 最终完整 `npm test` **318/318 通过**，0 失败、0 取消、0 跳过，约 699 秒（`full-final.log`）。本次对冻结源码单独运行，包含全部 13 项 V8 用例，以及旧合同、安装升级、监督、恢复、嵌套构建和提交事务回归；此前三项失败均通过。新增夹具的等待时限单独配置，旧夹具超时及产品预算未放宽。
- **28 个审阅文件已同步产品源码**，136 个未涉及基准文件保持原样；保留已有未提交修改。产品仓库重新构建通过，148 个编译产物与工作副本内容/权限一致，`git diff --check` 与补丁反向检查通过。[审阅清单](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/reviewed-changes.json)、[完整补丁](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/isolated-integration-changes.patch)、[最终核验](../../../../program/cctest/taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/final-verification.json)。

交付边界：仅新的 V8 合同可以明确授予隔离自动本地集成和规划刷新权限；原合同与规划 HEAD 不改写，旧任务不会因默认配置变化获得新权限。任务执行后遇到目标漂移时，不自动 merge/rebase，也不重复生成提交。声明式规划输入不等于自动推导全部语义依赖，不确定时应拒绝刷新。任务类型、Review 追加证据、成本/跨恢复总时限、归档守护及真实模型/机器重启/24 小时验收仍属未完成事项。

包版本仍为 1.0.5，本轮为未发布开发能力。未提交、未推送、未发布 npm、未升级当前 Android 工程安装实例；发布须使用新版本。
