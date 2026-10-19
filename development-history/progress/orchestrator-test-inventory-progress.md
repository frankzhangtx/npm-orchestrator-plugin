# Orchestrator 测试集合覆盖修复

更新：2026-09-24。当前阶段：复核发现的 3 个遗漏已处理，F01–F05 全部完成；补修后的 44 个文件已核对写回。首轮验收结论由本次补修结果修正，未提交、推送或发布。

## 复核补修（当前）

- [x] F01：新增 green-verification.json；先作废旧成功，再绑定成功运行 ID 和报告摘要。定向覆盖运行失败、提前拒绝、中断、缺失/不匹配标记，以及重新成功恢复。
- [x] F02：状态提示、resume-task、Coder 模板与文档均明确“已有 baseline.json 不可原任务重试，须批准中止/归档后新建任务”；队列验证原基线不变。未新增自动恢复权限。
- [x] F03：结构化错误绑定 queueRunId；当前脚本保留末尾 8,000 字符 stderr。旧运行/无 ID/损坏 JSON 三类队列回归通过，均显示当前拒绝原因。
- [x] F04：补修后完整 Node 227/227、Shell 46/46、typecheck、真实 JVM/Android 通过；模板摘要同步，打包 205 文件通过。
- [x] F05：13 个补修文件已写回，总交付 44 文件 SHA-256/权限一致，反向补丁和格式检查通过；写回后构建、typecheck、29/29 冒烟通过。完整/增量补丁及最新报告已保存。

补修定向结果：判定/证据 14/14，V4 队列 10/10。真实 JVM 额外用环境开关触发真实 JUnit 再次失败，验证旧 GREEN 拒绝及重新跑绿恢复。完整 Node 227/227、Shell 46/46、真实 Android、离线发现和打包复验均通过；总交付 44 文件（新增修改 resume-task.sh）。

下面实施记录保留首轮交付快照；当前以 F01–F05 和最新报告为准。E07、U02、U03 已重新验收。F02 明确采用安全归档/新任务路线，没有新增原任务自动恢复能力。

当前交付入口：[补修验收报告](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/review-fixes/development-validation.md)、[当前完整补丁](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/review-fixes/final-source.patch)、[文件摘要清单](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/review-fixes/source-inventory.json)、[写回核对结果](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/review-fixes/writeback-verification.json)。上层验证目录的旧包和旧补丁保留为首轮历史证据。

## 本轮实施记录（持续更新）

- 授权：用户要求“按照该文档进行实施，并及时更新进度”；本轮包括恢复、开发、验证和验证后写回，不含发布。
- 持久开发副本：`taskdescriptions/orchestrator-test-inventory-work/source`，起点 `8a3d1c410cd0a8beb95c52015e540d48fcf2bd66`，从干净源码复制；后续改动先在此验证。
- R01–R03 已完成：从会话恢复 3 个核心文件和 13 个已有文件的改动；同时恢复原先未落盘的 7 组测试草稿。
- R04 已完成：[恢复补丁（未验收）](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/recovered-unverified.patch) 已保存，包含 3 个新增核心文件和专项测试草稿；恢复后的已跟踪 diff 与历史统计一致（13 文件、+382/-62）。
- R05 已完成：恢复构建通过；7/7 专项测试通过。修正草稿将“重新跳过”误判为预期不符的断言，实际应报告覆盖缺失。
- 首个真实 Gradle 9.4.1/JUnit4 验证通过：双模块、8 个基线用例（含 2 个既有跳过）、新增 1 个批准行为、RED → GREEN → 再次 GREEN；第二轮编译保持 UP-TO-DATE，目标 Test 真实执行。发现并修正 macOS `/var` 与 `/private/var` 根路径别名误判。
- 真实 Gradle 已扩展通过：既有跳过拒绝、空过滤 reject/allow、新测试类 RED/GREEN、NO-SOURCE 空基线、空 RED 拒绝、重复 GREEN、资源/生产代码/RED 文件变更拒绝。原始工程和证据已保存到 [真实 Gradle 记录](../../../../program/cctest/taskdescriptions/orchestrator-test-inventory-validation/real-gradle)。
- 队列 V4 专项 5/5 通过：自动本地提交完整链路及 baseline/regression/interrupted/missing-green 四类失败；测试使用真实 Git/Shell，Gradle 和模型为替身，真实 Gradle 另行验证。
- 已接入最终 `check` 和 V4 验收报告；报告确认 Gradle 实际 exit=0 与批准失败用例数分别记录。GREEN 还绑定已验证 HEAD/工作区，后续代码变化拒绝旧证据。
- 已同步 Planner/Coder/Reviewer 说明、状态工具输出及 50 文件安装清单；模板/安装回归通过。
- 证据与准备预算新增 4/4 测试通过：绑定文件/测试/代码/权限篡改、缺失/损坏证据、提前实现、两次准备预算、部分封存中断、越界与符号链接输入。
- 模板/任务配置定向回归 32/32 通过；真实 Android Java/Kotlin、assets、res 均通过（首次缺缓存依赖，获准下载后最终离线复跑通过）。
- 完整套件首轮：沙箱限制进程查询，改为获准沙箱外执行；219 项中 214 项通过，5 项为旧夹具版本和新增资源数量断言，已修正。类型检查通过。
- 修复后定向回归 56/56 通过：包括安装/升级/卸载、Planner 审批回执、7 项 V4 队列、5 项证据防篡改和 7 项判定测试。
- 隔离工作区实测：生产基线前进可重新验证、重新审批并整合；冻结测试输入被外部任务改变时返回 EVIDENCE_CHANGED，保留证据、不替换 RED。
- 人工文件实测：提交前缀与快照 allowlist 内文件内容不参与证据；排除策略改变使绑定失效；人工文件不得兼作测试输入。
- Android Java/Kotlin、自定义 resources/assets/res 最终离线复跑通过。真实 JVM“编译失败不能成为 RED，修正后第二次准备成功”通过。
- 最终完整 Node 回归 222/222、Shell 流程 46/46、类型检查、打包 dry-run 通过；开发 tarball 包含 205 个文件（新增 3 个验证模块）。
- 最终真实 JVM/Android 证据分别保存在 `orchestrator-test-inventory-validation/real-gradle-final/`、`real-android-final/`；JVM 编译失败拒绝与第二次准备恢复均通过。
- 离线发现 1/1 通过：关闭默认外部插件/自动更新/模型抓取后，实际 OpenCode 1.15.13 识别全部 5 个内置技能；首轮超时日志仍保留。
- 实际 tarball 生命周期全部通过：新安装、doctor、同版本幂等 upgrade（50 文件复用）、卸载、重装、重装后 doctor；人工 AGENTS 内容和提交前缀保留。旧版到新版迁移由 Node 升级套件覆盖；本开发包未发布，不等同 registry 1.0.5。
- R15 已完成：源码仓库仍基于 `8a3d1c4`；43 个文件逐项 SHA-256/mode 与验证副本一致，反向补丁检查及 diff 格式检查通过。写回后构建、typecheck 和 22/22 清单/模板冒烟通过。
- 源码路径：`/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`。本地 tarball 沿用开发基线版本 1.0.5，不是 registry 已发布的 1.0.5；发布需另行授权并分配新版本。本轮未提交、推送或发布。
- 下文第 1–5 节保留 9 月 18 日历史取证，当前实现/验证结果以本节和第 6 节勾选为准。

本次核对发现 `/private/tmp/orchestrator-inventory.NYYUNK` 已不存在，无法直接读取原目录。以下历史进度根据 2026-09-18 开发会话中保存的补丁、命令返回和文件盘点还原，并与当前源码仓库交叉核对。目录消失的具体原因没有证据确认。

## 1. 范围与当前可恢复状态

实施目标：Planner 只声明任务行为用例；执行器在修改测试前采集聚焦范围内的既有测试，将其自动纳入回归覆盖；RED 与 GREEN 使用同一份完整清单。通用行为采样、草稿复核第二批不属于此次任务。

原始授权记录为 2026-09-17 晚间“按照此方案进行实施”，范围是开发与验证。发布、目标 WordPress 任务及队列状态不在该开发范围。本次操作为进度取证和文档更新。

| 对象 | 2026-09-24 核对结果 | 对后续工作的影响 |
| --- | --- | --- |
| 源码仓库 | `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`；HEAD 仍为 `8a3d1c4`，版本 `1.0.5`，`git status --short` 无输出 | 新清单实现尚未写回，恢复起点仍然明确 |
| 早期开发副本 | `/private/tmp/orchestrator-coverage.LAtbRO/source` 在 9 月 18 日恢复开发时已不存在 | 仅作历史背景，不是本次成果来源 |
| 本轮开发副本 | `/private/tmp/orchestrator-inventory.NYYUNK/source` 当前不存在 | 不能把历史写入当成当前可运行源码 |
| 最后一次实际文件盘点 | 9 月 18 日确认 13 个已有文件修改、3 个核心文件新增 | 可据日志还原实现范围，详见第 4 节 |
| 专项测试文件 | 当时检查返回 `test-file-missing` | 新测试仅有会话中的草稿，未确认落盘、未通过测试 |
| 本任务专属恢复补丁、验证目录、安装包 | 当前工程中未找到 | 原文档“将持久保存”的承诺尚未完成 |
| 旧版恢复材料 | `orchestrator-v1-work-in-progress.patch` 与 `orchestrator-v1-validation/` 属于 9 月 14 日的 1.0.0 开发 | 不能用于证明本轮 V4 清单方案已完成或测试通过 |
| 会话证据 | 9 月 18 日开发 JSONL 仍在本机，包含新增文件全文及修改命令 | 是后续恢复的输入，尚未整理成可直接应用的恢复补丁 |

历史状态口径：第 1–5 节描述恢复前的取证快照。“历史已写入”“待验证”“未落地”均为当时状态，不表示本轮仍未完成；本轮验收见第 6–7 节，不按代码行数估算百分比。

## 2. 上次开发时间线

以下时间均为北京时间；原始会话时间为 UTC，已加 8 小时。

| 时间 | 可确认的动作或结果 | 证据 |
| --- | --- | --- |
| 2026-09-18 20:39 | 重建 `orchestrator-inventory.NYYUNK/source`，进度文档更新到“恢复开发、梳理 V4” | E1 |
| 20:50 | 写入 V4 共享合同校验器 `contract.cjs` | E2 |
| 20:52–20:55 | 写入统一 Gradle 采集器 `collect.init.gradle` | E3 |
| 21:03 | 写入清单、覆盖判定和证据模块 `inventory.cjs` | E4 |
| 21:04 | 两个 CJS 文件的 `node --check` 组合命令返回 0，无报错输出 | E5 |
| 21:05–21:06 | 接入队列、安装、合同模板和 Shell 流程；`npm run build` 明确返回 0 | E6 |
| 21:25 | 尝试新增 `tests/test-inventory.test.mjs` 并运行专项测试；调用被用户中断 | E7 |
| 21:26 | 检查确认专项测试文件不存在、构建产物存在；原源码仓库仍干净 | E8 |
| 21:27 | 临时副本盘点确认 13 个修改文件和 3 个新增核心文件；`git diff --check` 通过；再次启动构建 | E9 |
| 21:35 | 第二次构建的轮询只保存了空 stdout，没有保存退出码 | E10；不另计一次已通过构建 |
| 2026-09-24 | 重新读取文档、盘点持久材料、核对源码基线并回溯历史工具记录 | 本次核对；未恢复或运行历史开发副本 |

## 3. 历史细粒度实施进度（9 月 18 日，勿与本轮验收混用）

### 3.1 V4 合同及旧版兼容

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| C01 | 新合同使用 `schemaVersion: 4`、`verification.version: 2` | 历史已写入模板、Schema 和类型声明 | 检查生成合同、队列与 Shell 入口一致性 |
| C02 | 显式声明 `inventory.mode: focusedBaseline` | 历史已写入共享校验器 | 缺少或非法策略必须拒绝 |
| C03 | 既有跳过策略为 `existingSkips: reject/preserve` | 历史已写入，模板默认 `reject` | 两种策略分别验证 |
| C04 | 空基线策略为 `emptyBaseline: reject/allow` | 历史已写入，模板默认 `reject` | 验证逐 task 空集合和新测试类场景 |
| C05 | 要求真实完整 Gradle task 路径、配置允许的任务和唯一目标 | 历史已写入共享校验器 | 拒绝任务别名、未配置任务、重复目标 |
| C06 | 行为 ID、测试身份、分类及预期失败字段校验 | 历史已写入共享校验器 | 验证重叠过滤下的重复身份与参数实例 |
| C07 | 队列与 `validate-contract.sh` 共用 `contract.cjs` | 历史已接入 V4 分支 | 同一合法/非法合同在两入口结果一致 |
| C08 | V1/V2/V3 沿用旧分支，队列测试 fixture 固定为 V3 | 历史已写入；Schema 文件声明 V3/V4 | 旧合同全套回归未执行，不能认定兼容性通过 |

### 3.2 Gradle 统一采集

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| G01 | 按 task 合并过滤器，对同一任务一次采集 | 历史已写入 | 重叠过滤不能重复执行或漏记用例 |
| G02 | 以 `(taskPath, className, name)` 标识用例 | 历史已写入 | 多模块同名用例、JUnit 参数化/动态名称实测 |
| G03 | 记录 start、task、case、suite、taskEnd、end 事件及 runId | 历史已写入 | 截断、混入旧运行、缺失结束事件均拒绝 |
| G04 | 核对逐用例数与 suite 的总数、失败数、跳过数 | 历史已写入 | 错误计数和重复身份判定测试 |
| G05 | 禁用目标 Test 任务的缓存与 UP-TO-DATE 复用，关闭 failFast 和测试 dry-run | 历史已写入 | 真实 Gradle 连续运行，确认实际执行且编译可复用 |
| G06 | 先用 Gradle `--dry-run` 发现测试目录，再单独实际采集 | 历史已写入 | 发现阶段不能作为测试执行证据 |
| G07 | 基线阶段处理 NO-SOURCE/无匹配；RED/GREEN 不允许空执行 | 历史已写入 | 对照空基线策略验证每个任务 |
| G08 | 每次尝试保存独立日志、事件、进程结果及按 task 分目录的 JUnit XML | 历史已写入输出逻辑 | 尚无本轮真实运行产物；判定读取事件流，XML 用于留证，未实现独立 XML 解析比对 |

采集器初稿设置 `ignoreFailures=true`，要求 Gradle 进程正常完成后由逐用例结果判定 RED；`red.json.exitCode` 初稿写为 `1`。该值与真实进程 `process.json.status` 的含义需要在验收报告中明确，并通过真实失败测试验证，不能据字段值声称 Gradle 实际以 1 退出。

### 3.3 基线、RED 与 GREEN 共用清单

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| I01 | `claim-task.sh` 在 Coder 改测试前采集聚焦基线，失败转 BLOCKED | 历史已接入 | 端到端确认失败时 Coder 尚未开始编辑 |
| I02 | 基线既有失败拒绝封存；跳过与空任务按合同处理 | 历史已写入 `evaluateBaseline` | 逐项判定测试 |
| I03 | 将基线既有用例自动归入 regression，再合并声明行为用例 | 历史已写入 `evaluateCoverage` | 同一身份被行为声明覆盖时的语义验证 |
| I04 | RED 检查回归用例、preserve/change/observe 结果，并要求至少一个批准的 change 失败 | 历史已写入 | 混合预期失败与意外回归失败必须拒绝 |
| I05 | 拒绝漏用例、新增未声明用例、新跳过和重复身份 | 历史已写入 | 拆分边界案例验证 |
| I06 | `record-red.sh TASK-ID` 的 V4 分支先过范围门，再调用统一模块 | 历史已接入 | 测试失败、预算耗尽和正式 RED 不可覆盖场景 |
| I07 | GREEN 使用基线与合同形成的同一清单并核对 RED manifest | 历史已写入 | 行为用例全通过；既有允许跳过保持正确规则 |
| I08 | `lib.sh` 在 V4 聚焦验证处运行 GREEN，之后继续原全量测试 | 历史已接入 | 验证完整质量门和独立 Reviewer 路径 |

### 3.4 自定义测试目录和范围限制

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| P01 | 从 JVM SourceSet 发现对应 Test 任务的源码和资源目录 | 历史已写入 | 自定义目录的真实 JVM 工程验证 |
| P02 | 尝试从 Android unitTestVariants/sourceSets 发现 Java、Kotlin、resources、assets、res | 历史已写入 | AGP 兼容性及变体范围验证，尚不能宣称支持全部工程 |
| P03 | 合并发现目录与配置 testPaths，快照包含未修改的测试资源 | 历史已写入 | 修改资源而不修改测试源码也要使旧证据失效 |
| P04 | 拒绝仓库外、符号链接、build/.gradle/.git 等不安全或生成输入 | 历史已写入 | 路径边界判定测试 |
| P05 | `scope-gate.sh`、`integration-scope-gate.sh` 使用新测试路径识别入口 | 历史已替换调用 | 保留 allowedPaths、forbiddenPaths、protectedPaths、文件数限制；自动发现不能授予修改权限 |

### 3.5 证据绑定与防篡改

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| E01 | 绑定 taskId、合同/config 摘要、baseline HEAD、baseline.json 摘要 | 历史已写入 | 任一绑定改变时拒绝旧证据 |
| E02 | 对三个采集/校验文件计算 collector 摘要 | 历史已写入 | 修改采集器使旧证据失效 |
| E03 | baseline/RED 前后核对生产代码、工作区和测试输入 | 历史已写入 | 并发改动、提前修改生产代码应被拒绝 |
| E04 | 测试快照记录路径、SHA-256 和 mode，GREEN 前检查冻结输入 | 历史已写入 | 源码、资源和权限变化分别验证 |
| E05 | 独立 attempts 目录保存成功/失败尝试，RED 次数受准备预算约束 | 历史已写入 | 中断、失败重试、预算边界验证 |
| E06 | 基线和正式 RED 使用独占创建，manifest/preflight/原始文件互相绑定 | 历史已写入 | 部分写入、中断恢复、不可覆盖与篡改场景 |
| E07 | `inventory.cjs check` 校验 GREEN 与 RED/manifest 的绑定 | 模块内部历史已写入 | 未见接入 Shell 最终验收入口；需补齐调用及验证 |

恢复前，上述 JSON 仅是代码预定的产物，并无可验收文件。本轮已实际生成并保存 baseline/manifest/RED/GREEN 及原始采集证据，见验证目录，勿将历史缺失与当前状态混淆。

### 3.6 队列展示、安装与模板

| 编号 | 单项工作 | 上次实现状态 | 剩余验收 |
| --- | --- | --- | --- |
| U01 | 队列详情读取 baseline-inventory、test-preflight、test-manifest、green-inventory、inventory-status | 历史已接入 | 工具返回内容与缺失证据处理验证 |
| U02 | 执行器失败时优先读取 phase、reasonCode、issues、nextAction | 历史已接入 | BLOCKED 原因和通知实际呈现验证 |
| U03 | 为执行失败、覆盖不符、输入变更、预算耗尽等原因提供恢复文字 | 历史已写入模块 | 按失败场景核对原因与下一步是否准确 |
| U04 | V4 完整清单与摘要进入 `acceptance-report.sh` | 未落地；最后改动清单没有此文件，原代码仅处理 V3 structured RED | 实现 V4 报告及证据校验 |
| U05 | 安装复制根加入 `automation/verification` | 历史已写入 `init.ts` | init、upgrade、doctor、卸载和重装验证 |
| U06 | Planner/Coder/Reviewer 的 agent、skill 提示词同步 V4 | 未见写入记录；当时仍为 V3 文案 | 明确行为声明、自动回归、跳过与空基线策略 |
| U07 | 用户文档、模板清单及固定摘要同步新增文件 | 未见写入记录 | 文档、模板迁移、包内容校验 |

`verify-task.sh` 没有直接修改记录，但它调用的 `automation_run_configured_unit_tests` 已增加 V4 GREEN 分支，因此验证链路属于“部分接入”。仍须检查最终验收是否调用独立 `check` 并呈现 V4 证据，不能仅凭该脚本未改动认定 GREEN 完全未接入。

## 4. 上次实际生成/修改的文件

以下路径均相对于当时的 `source/`，依据 E8/E9 的实际盘点。13 个已跟踪文件的 `git diff --stat` 为 **382 行新增、62 行删除**；该统计不含 3 个未跟踪新增文件。

| 文件 | 当时状态 | 已写入内容 |
| --- | --- | --- |
| `templates/automation/verification/contract.cjs` | 新增，76 行 | V4 共享合同校验、身份及路径工具 |
| `templates/automation/verification/collect.init.gradle` | 新增，98 行 | 三阶段共享 Gradle 事件采集及目录发现 |
| `templates/automation/verification/inventory.cjs` | 新增，338 行 | 基线/覆盖判定、快照、证据绑定、运行与恢复原因 |
| `src/queue/queue.ts` | 修改 | V4 校验入口、五类新证据的详情读取 |
| `src/queue/executor.ts` | 修改 | 从 inventory-status 提取具体错误与恢复方向 |
| `src/installer/init.ts` | 修改 | 安装新的 verification 目录 |
| `src/installer/adaptive-templates.ts` | 修改 | 合同样例类型的 schemaVersion 改为 4 |
| `templates/automation/task-contract.schema.json` | 修改 | V3/V4 条件约束及 inventory 策略 |
| `templates/automation/tasks/TASK-TEMPLATE.json.example` | 修改 | 默认 V4、verification V2、reject/reject 策略 |
| `templates/scripts/automation/validate-contract.sh` | 修改 | V4 调用共享校验器，旧版保留原分支 |
| `templates/scripts/automation/claim-task.sh` | 修改 | 基线清单采集与失败阻断 |
| `templates/scripts/automation/record-red.sh` | 修改 | V4 RED 调用与参数限制 |
| `templates/scripts/automation/lib.sh` | 修改 | GREEN 调用、统一运行入口和测试路径识别 |
| `templates/scripts/automation/scope-gate.sh` | 修改 | 使用包含发现目录的测试路径识别 |
| `templates/scripts/automation/integration-scope-gate.sh` | 修改 | 集成阶段同样使用新路径识别 |
| `tests/queue-fixture.mjs` | 修改 | 将既有测试合同显式固定为 V3 |

另有两类产物需要区分：

- `dist/queue/queue.js`：当时检查确认存在，并有一次构建返回 0；未保存完整 dist 清单，当前临时副本已丢失。
- `tests/test-inventory.test.mjs`：会话内有完整拟写入补丁，但调用中断后的检查明确不存在；不计入上述 16 个已落盘文件。

## 5. 验证进度与专项测试草稿

| 检查 | 可确认结果 | 限制或待办 |
| --- | --- | --- |
| `node --check inventory.cjs`、`node --check contract.cjs` | 历史组合命令返回 0，无报错；之后 inventory 又单独检查返回 0 | 仅语法检查，无行为验证 |
| `npm run build` | 9 月 18 日 21:06 明确 exit_code=0 | 仅证明当时 TypeScript 构建通过，不编译/验证 Gradle 采集脚本 |
| 第二次 `npm run build` | 已启动，轮询记录未保留退出码 | 不单独标记通过 |
| `git diff --check` | 历史返回 0 | 当时只覆盖已跟踪改动，不含未跟踪新增文件 |
| `node --test tests/test-inventory.test.mjs` | 与写入操作所在调用一起中断；随后测试文件不存在 | 无测试成功执行或通过结果 |
| 本轮完整 `npm test` | 未见执行结果 | 恢复后执行；1.0.5 的历史 203 项通过不能移作本轮结果 |
| Shell 流程、旧合同及模板迁移回归 | 未见本轮结果 | 需验证 V1/V2/V3 语义及新增资源清单 |
| 真实 Gradle/JUnit 采集、Android 目录发现 | 未见本轮运行结果 | 事件、异常类型、参数名称及目录发现均待实测 |
| `npm run typecheck`、离线发现、`npm run pack:check` | 未见本轮结果 | 需完成恢复后的独立检查 |
| 安装升级生命周期、写回核对 | 未执行完成 | 需验证新增目录安装和写回一致性 |

E7 当时拟新增的测试文件包含以下 7 组草稿；以下保留当时未落地、未验证的快照，本轮 7/7 通过结果见 R05 和第 7 节：

- [ ] T01：V4 合同在队列/Shell 两入口使用同一策略校验，旧 fixture 保持 V3。
- [ ] T02：拒绝任务别名、重叠过滤造成的重复行为身份和未声明策略字段。
- [ ] T03：自动归类既有回归用例，RED/GREEN 共用完整 manifest。
- [ ] T04：既有跳过及逐 task 空基线须显式允许，并拒绝新跳过。
- [ ] T05：拒绝缓存复用、中断、无效事件、重复身份与计数不一致。
- [ ] T06：参数实例身份独立，不同 task 中同名用例互不冲突。
- [ ] T07：测试资源快照能发现资源内容变化；草稿尚需补充真实自定义目录场景。

## 6. 恢复后的下一步与原验收项

按依赖顺序推进，每项均有独立完成条件：

- [x] R01：从 `8a3d1c4` 建立持久开发副本，记录路径和基线；恢复位置不再只依赖 `/private/tmp`。
- [x] R02：从 E2/E3/E4 恢复 3 个核心文件，核对全文及历史行数。
- [x] R03：从 E6 恢复 13 个已有文件的修改，包含后续机械替换和 JSON 更新；与 E9 文件清单逐项比对。
- [x] R04：持久保存包含新增文件的本任务专属恢复补丁；注明“未验收”，不能只保存普通 `git diff` 而遗漏未跟踪文件。
- [x] R05：恢复 E7 的专项测试草稿，检查 fixture 与 V4 模板的组合后执行 T01–T07，记录实际结果。
- [x] R06：真实 JVM/Android 完成 baseline → RED → GREEN；完整事件、进程结果、XML、评价报告已保存。
- [x] R07：双模块同名、4 个参数实例、重叠过滤、空基线 reject/allow、既有跳过 reject/preserve 均通过。
- [x] R08：真实连续 GREEN 目标 Test 不复用缓存；编译失败拒绝且未封存 RED，第二次准备成功；事件中断/缓存标记由专项测试拒绝。
- [x] R09：JVM 自定义源码/resources；Android Java/Kotlin/resources/assets/res 通过。实测 Gradle 9.4.1、AGP 9.2.1、SDK 36；越界、生成目录、符号链接拒绝，不声明全部版本兼容。
- [x] R10：5 项证据专项通过，包括内容/权限、配置/采集器、人工排除策略、预算及部分封存；7 项 V4 队列覆盖重验与失败恢复提示。
- [x] R11：两个 verify 入口最终 check 已接入；验收报告包含完整清单、覆盖摘要、Gradle 实际退出码和批准失败数量。
- [x] R12：模板与文档同步；详情、waitingReason、验收报告按原因显示。通知沿用队列 outcome.error，未向真实外部用户发送消息。
- [x] R13：补修后完整 Node 227/227、Shell 46/46、类型检查、构建、旧合同/模板迁移回归通过；见 review-fixes 日志。
- [x] R14：新安装、doctor、同版本幂等升级、卸载/重装的真实 CLI 全通过；旧版本迁移由 Node 套件覆盖。离线发现 1/1，开发包 205 文件、新增 3 模块与源码摘要一致。
- [x] R15：补修后 44 个验证文件已写回源码仓库；基线不变，SHA-256/权限逐项一致，反向补丁检查通过；构建/typecheck/29 项冒烟通过，当前补丁、包和验证证据已保存到 review-fixes。

原有 8 项验收（本轮逐项核对）：

- [x] 新版合同明确批准自动回归覆盖、既有跳过与空基线策略；旧合同语义不变。对应 C01–C08。
- [x] 基线、RED、GREEN 共用 Gradle 采集器及身份/覆盖判定模块。对应 G01–G08、I01–I08。
- [x] 处理真实任务路径、重叠过滤、参数实例、重复身份、空结果、缓存及中断。对应 C05–C06、G01–G08、T02–T06。
- [x] 发现自定义测试目录与资源，不扩大合同允许修改范围。对应 P01–P05。
- [x] 固定证据与合同、基线、测试快照及采集器摘要的绑定。对应 E01–E07。
- [x] 队列详情、通知数据源和验收报告展示具体原因及恢复方向。对应 U01–U04。
- [x] 跨工程判定回归、真实 Gradle/JUnit 采集验证、原有套件与打包检查。对应第 5 节、R05–R14。
- [x] 将验证后的改动写回源码仓库，并持久保存验证结论。对应 R04、R15。

## 7. 本轮细粒度验收（2026-09-24）

本表覆盖历史 43 项，不以代码已写入代替验证结论。完整回归、真实 Gradle、安装验证的边界分别记录。

| 编号 | 当前状态 | 本轮结果与边界 |
| --- | --- | --- |
| C01 | 完成 | 新模板生成 V4 / verification v2，安装模板和审批回执回归通过。 |
| C02 | 完成 | inventory 必填；缺失或多余策略字段由共享校验器拒绝。 |
| C03 | 完成 | reject/preserve 分别经真实 Gradle 验证；行为用例不得跳过。 |
| C04 | 完成 | 逐 task 空基线 reject/allow、无匹配过滤和新测试类通过。 |
| C05 | 完成 | 限定配置内完整 task 路径；别名和重复目标拒绝。 |
| C06 | 完成 | 行为身份、分类和预期失败校验；重叠身份拒绝。 |
| C07 | 完成 | 队列/Shell 同源校验；TodoAdapterTest 不再被 Shell 误判占位符。 |
| C08 | 完成 | 既有 V1/V2/V3 分支保留，222 项完整回归通过。 |
| G01 | 完成 | 真实重叠过滤合并；同一 Test 任务不重复采集。 |
| G02 | 完成 | 双模块同名、4 个参数实例独立记录。 |
| G03 | 完成 | runId、事件开始/结束与完整性校验；队列中断替身拒绝。 |
| G04 | 完成 | 逐用例与 suite 数量核对；重复身份、计数不一致拒绝。 |
| G05 | 完成 | 两次 GREEN 均真实执行 Test，compileTestJava 可保持 UP-TO-DATE。 |
| G06 | 完成 | 独立 discovery dry-run；未执行的事件流不充当结果。 |
| G07 | 完成 | NO-SOURCE 仅按空基线策略允许；空 RED 拒绝。 |
| G08 | 完成 | 最终 JVM/Android 项目、事件、日志、process 和 XML 已持久保存；不单独解析 XML 判定。 |
| I01 | 完成 | 队列 baseline 失败在 Coder 编辑前阻断，检查测试/生产文件未生成。 |
| I02 | 完成 | 既有失败、既有跳过及空集合策略分别覆盖。 |
| I03 | 完成 | 自动加入既有回归；真实双模块清单由 8 项基线增至 9 项。 |
| I04 | 完成 | 预期 change 失败才构成 RED；额外回归失败拒绝。 |
| I05 | 完成 | 缺失、额外、新跳过、重复与参数实例替换均拒绝。 |
| I06 | 完成 | 正式 RED 不可覆盖；最多两次准备，编译失败修正后第二次成功。 |
| I07 | 完成 | GREEN 复用完整 manifest；冻结测试/资源与旧 RED 绑定。 |
| I08 | 完成 | 聚焦 GREEN 后保留全量测试、独立 Review、自动整合路径。 |
| P01 | 完成 | 真实 JVM spec/code、spec/data 自动发现并纳入快照。 |
| P02 | 完成（限定实测） | AGP 9.2.1 的 Java/Kotlin/resources/assets/res 通过；不外推全部 AGP/变体版本。 |
| P03 | 完成 | 未修改资源也进入快照；内容或权限改变使证据失效。 |
| P04 | 完成 | 外部、生成、符号链接及与生产/保护目录重叠输入拒绝。 |
| P05 | 完成 | 两个 scope gate 使用新识别器；原 allowed/forbidden/protected/文件数限制仍保留。 |
| E01 | 完成 | 合同/config、原始 HEAD、baseline.json 绑定，逐文件篡改回归通过。 |
| E02 | 完成 | 三文件 collector 摘要绑定；采集器变化拒绝旧证据。 |
| E03 | 完成 | baseline/RED 拒绝提前改生产；采集前后复核代码/输入/绑定。 |
| E04 | 完成 | 路径、内容、mode 冻结；GREEN 后生产文件变化同样拒绝。 |
| E05 | 完成 | 成功/失败 attempts 独立保留；预算耗尽不再启动采集。 |
| E06 | 完成 | 独占封存、部分写入重试、原始文件与评价摘要绑定均通过。 |
| E07 | 补修后完成 | 两个 verify 最终 check 均接入；最新 GREEN 必须有同运行 ID/报告摘要的 PASSED 标记，后续失败不能复用旧成功。 |
| U01 | 完成 | 详情和 status 输出完整清单、preflight、GREEN 与原因状态。 |
| U02 | 补修后完成 | 错误绑定本次 queueRunId；旧/无 ID/损坏状态不遮蔽当前脚本原因。通知复用 outcome.error，无真实外部发信。 |
| U03 | 补修后完成 | 四种失败分类及恢复提示通过；已封存 baseline 的 V4 中断明确要求批准归档后新建任务，不再误导重试。 |
| U04 | 完成 | V4 验收报告包含基线/RED/GREEN 摘要、身份及实际退出码。 |
| U05 | 完成 | 50 文件 Node 安装/升级/卸载回归通过；tarball 实际安装、doctor、同版本幂等升级、卸载/重装及最终 doctor 均通过。 |
| U06 | 完成 | Planner/Coder/Reviewer 说明已同步自动回归、策略审批和冻结规则。 |
| U07 | 完成 | 受管清单/摘要已更新，文档与包内容测试通过；开发包 205 文件。 |

## 8. 可追溯历史证据位置

历史主会话文件为 `/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl`。下表行号指 JSONL 事件行，不是历史源码行；恢复时需解析其中工具调用的字符串，不能直接把整行 JSON 当作补丁执行。

| 引用 | 事件位置 | 支持的结论 |
| --- | --- | --- |
| E1 | [第 60 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:60) | 创建开发副本及旧版进度文档更新 |
| E2 | [第 124 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:124) | `contract.cjs` 新增全文 |
| E3 | [第 132 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:132) | `collect.init.gradle` 新增全文 |
| E4 | [第 149 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:149) | `inventory.cjs` 新增全文 |
| E5 | [第 156 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:156)、[第 161 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:161) | CJS 语法检查命令和结果 |
| E6 | [第 165 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:165)、[第 176 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:176) | 接入补丁、机械修改命令和构建成功退出码 |
| E7 | [第 182 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:182)、[第 184 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:184) | 七组专项测试草稿及调用中断结果 |
| E8 | [第 206 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:206)、[第 213 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:213) | 实际 Git 状态、test-file-missing、build-present |
| E9 | [第 217 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:217)、[第 223 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:223) | 修改统计、核心文件行数、部分完整 diff、格式检查结果 |
| E10 | [第 228 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:228)、[第 230 行](/Users/zhanglong/.codex/sessions/2026/09/18/rollout-2026-09-18T20-30-53-01a0b47f-8fb9-76e2-8a4f-ec02c4928039.jsonl:230) | 第二次构建仅输出 stdout，不能据此补造成功退出码 |

历史取证阶段仅更新文档；后续恢复实施进展见文件开头的“本轮实施记录”。尚未提交或发布。
