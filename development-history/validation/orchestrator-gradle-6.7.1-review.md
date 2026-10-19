# Orchestrator 1.1.0 整体审查与 Gradle 6.7.1 适配评审

审查日期：2026-09-30；2026-10-01 续做并补充真实 Gradle 6.7.1 诊断。产品提交：`9bd6cd553aa42f4f7f79397e7da248d961ada234`，npm 版本 1.1.0。

2026-10-08 更新：本审查对应的开发修复已同步产品源码，全量 325/325、真实新旧 Android 4/4、Shell 46/46 通过，尚未发布新版本。具体实现、保留边界和验证证据见[修复交付记录](../progress/orchestrator-gradle671-fix-progress.md)。以下保留原审查结论，描述的是原始 1.1.0 基准，不代表修复后源码仍存在同样缺陷。

**结论：目前不应把 1.1.0 视为已验证可用于 Gradle 6.7.1 的无人值守方案。** 现有证据门禁存在可复现的判定缺口；旧版 Android 实测还确认了采集器初始化阻断和 Kotlin 源集遗漏。目标工程仍没有经过完整验证。无需因此强制升级用户的 Gradle，应该修复兼容问题并为 6.7.1 建立独立验收。

本次只做源码审查、官方资料核对和复现，没有修改或重新发布产品。目标工程路径、AGP、Kotlin 插件和实际构建 JDK 尚未提供。最初从官方下载 Gradle 6.7.1 超时；之后按用户授权改用阿里镜像，并核对官方 SHA-256，已完成真实 JVM 测试和旧版 Android 诊断。原版采集器失败；只改一行的诊断副本跑通 Android 基线→RED→GREEN→check。这不代表已发布产品通过兼容验收。下午的 318 项回归、46 项 Shell 回归和新版本 Android 实测属于既有证据，本次未重复运行。

## 优先处理的发现

### R7 · P1：Gradle 6.7.1 的请求参数读取导致采集器初始化失败（新增实测）

证据：[collect.init.gradle:9](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/collect.init.gradle:9)、[inventory.cjs:249](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/inventory.cjs:249)。

在真实 **Gradle 6.7.1 / AGP 4.2.2 / Kotlin 1.4.32 / Corretto 8u312** 的 Android 夹具中，配置 `org.gradle.jvmargs=-Xmx1536m` 后，初始化脚本的 `System.getProperty('orchestrator.inventoryRequest')` 返回 null；同一参数在 `gradle.startParameter.systemPropertiesArgs` 中仍存在。产品直接 `new File(null)`，在 baseline discovery 阶段报 `Ambiguous method overloading for method java.io.File#<init>`，尚未执行测试。

2026-10-01 使用重新下载并校验的发行包复验，普通 daemon 与 `--no-daemon` 均观察到相同参数差异；直接执行**原版**采集器并添加 `--no-daemon` 仍复现初始化失败。因此，Worker 已有的 `--no-daemon` 不能绕过这个问题。属性探针故意以退出码 1 停在工程配置前；这两次非零退出是诊断设计，原版采集器的非零退出才是产品缺陷复现。详见 [探针与原版运行记录](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/results.json)。

诊断副本仅将请求路径改为优先读取 `gradle.startParameter.systemPropertiesArgs`，再回退到 System 属性；其余四个验证模块与产品逐字节一致。该副本完成两项既有 Java/Kotlin 测试的基线、新增行为用例的预期 RED、三项 GREEN 和最终 check，真实 Gradle 日志、事件及 XML 均已保存。见 [诊断副本](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/diagnostic-verification/collect.init.gradle)、[Android 诊断日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/real-gradle-android-diagnostic.log)。

建议把请求参数解析修复纳入正式产品，并明确拒绝缺失或无效路径，再验证 6.7.1 与现有新版本、daemon/单次 daemon、安装升级及完整队列。诊断只确认此环境中的读取问题与候选修复效果，不宣称所有 Gradle 6.7.1 配置均失败，也不把临时副本当作已发布修复。

### R8 · P1：旧 Kotlin 插件源集被工程能力模型静默遗漏（新增实测）

证据：[capabilities-script.ts:25](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/installer/capabilities-script.ts:25)、[adaptive-templates.ts:433](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/installer/adaptive-templates.ts:433)。

在同一旧版 Android 夹具执行产品原始工程发现脚本，Gradle 退出码为 0，模型通过产品 `parseProjectCapabilities` 校验，并成功生成 Debug/Release 单测与构建任务矩阵。但模型遗漏了 DSL 中明确声明且实际执行过测试的 `library/checks/kotlin/**`；Java、resources、assets、res 目录仍在。证据：[原始发现日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/capability-discovery.log)、[解析后的模型和矩阵](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/capabilities.json)。

独立 Gradle 探针确认：旧 Kotlin 插件向 source set 暴露的 `kotlin` 能被 `sourceSet.hasProperty('kotlin')` 和 `sourceSet.kotlin.srcDirs` 访问，而 `sourceSet.metaClass.hasProperty(sourceSet, 'kotlin')` 返回 null。产品能力脚本的通用 getter 先检查 metaClass，因此把这个有效动态属性当作不存在。详见 [属性探针](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/kotlin-property.log)。

影响：安装器根据能力模型生成 productionPaths、testPaths 和默认 allowedPaths，可能遗漏真实 Kotlin 输入并阻止合法 Kotlin 修改。模型校验只核对已报告的数据，未发现此遗漏。当前测试采集器使用另一套 `hasProperty` 逻辑，诊断副本能收集此测试目录，因此不能据此声称测试冻结已被绕过；也不能把采集器通过等同于安装能力发现完整。实测直接覆盖自定义测试源集，生产 Kotlin 源集及更多插件组合仍需专项验证。

建议按 Gradle 动态属性/扩展语义读取源集，无法可靠读取时明确报错；对真实旧 Kotlin 插件验证测试与生产 Kotlin、自定义目录、flavor，并核对安装生成配置与执行时清单一致。该发现尚未修入产品。

### R1 · P1：错误失败位置仍可成为有效 RED

证据：[inventory.cjs:128](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/inventory.cjs:128)、[contract.cjs:80](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/contract.cjs:80)。

合同强制填写 `expectedFailure.origin`，采集器也记录了异常调用栈，但 RED 判定只比较异常类型和可选的消息子串，完全没有使用 origin/stack。

已直接调用产品 `evaluateCoverage` 复现：合同要求目标行为断言失败，实际异常来自 `InputTest.setUp`，目标调用未发生，函数仍返回 `expectedRed=1`、`valid=true`。增加匹配的 `messageIncludes` 后仍能复现。这是判定函数层面的确定性复现，尚未通过真实 Gradle 将该结果封存成正式 `red.json`。

影响：RED 不能可靠证明旧实现存在批准的行为缺陷。后续测试通过与 Reviewer 审查仍是保护，但不能弥补“修改前已复现目标错误”这一证据承诺。

建议：把允许的失败来源定义为可校验的结构化位置/调用约束；明确拒绝 before/after fixture、规则、测试初始化等失败。无法确定归属时拒绝封存，不能只要求模型填写更长的说明。验收至少覆盖相同异常、相同消息但不同栈位置，以及正确目标失败被接受。

### R2 · P1：没有校验目标 Gradle 与实际构建 JVM 的兼容关系

证据：[doctor/index.ts:111](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/doctor/index.ts:111)、[service.ts:19](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/queue/service.ts:19)、[recovery.cjs:136](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/recovery.cjs:136)。

`doctor` 的 Java 检查只要求 `java -version` 成功；后台服务继承启动进程环境，没有项目级构建 JDK 选择与兼容性检查。实际运行该检查，本机 Java **21.0.11** 被标为 `pass`。这只证明“Java 命令存在”，不能证明适用于目标 Gradle。

Gradle 6.7.1 官方要求运行 JVM 为 **Java 8–15**，不支持 Java 16 及以上。[官方兼容矩阵](https://docs.gradle.org/6.7.1/userguide/compatibility.html)。如果项目未通过 wrapper 或 `org.gradle.java.home` 等选择兼容 JVM，后台任务会继承错误环境。Android Studio 内构建成功也不能证明从 OpenCode 启动的后台服务使用相同 JDK。

恢复记录另以 PATH 中的 `java -version` 声称识别 Java toolchain，同时记录 JAVA_HOME 字符串。这并不必然对应 Gradle daemon 或测试执行实际使用的 JVM；例如 `org.gradle.java.home`、用户级 Gradle 配置和工具链均可能改变实际执行环境。其影响是可能出现误拒绝，或未识别实际工具环境变化，不能把现有摘要称为完整的工具链证明。

建议：在安装前与 Worker 执行前获得并核对所选 wrapper 的真实 Gradle/JVM 信息；固定项目执行环境，将实际 Gradle、AGP、Kotlin、JVM 信息纳入兼容记录和恢复绑定。修改启动终端的 JAVA_HOME 不会改变已经运行的后台服务，切换环境需要安全重启服务。

AGP 版本必须另外确认，不能从 Gradle 版本反推出用户配置。若目标是 AGP 4.2.x，其官方要求最低 Gradle 6.7.1，并推荐 JDK 11；可先把 **Gradle 6.7.1 + 实际 AGP + 经工程验证的 JDK 11/8** 作为候选组合，而不是直接使用本机默认 JDK 21。[AGP 4.2 官方说明](https://developer.android.com/build/releases/agp-4-2-0-release-notes)。

### R3 · P1（目标上线门槛）：现有真实 Android 夹具不能仅换版本号就验证 6.7.1

证据：[project-capabilities-android.integration.mjs:16](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/tests/project-capabilities-android.integration.mjs:16)、[同文件:28](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/tests/project-capabilities-android.integration.mjs:28)、[同文件:45](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/tests/project-capabilities-android.integration.mjs:45)。

现有真实夹具默认 Gradle 9.4.1 / AGP 9.2.1，settings 使用 `dependencyResolutionManagement`，还使用新 AGP 的 namespace、Kotlin 源集和 variant API。`dependencyResolutionManagement` 是 Gradle **6.8** 才引入的能力，因此只把 `ORCHESTRATOR_TEST_GRADLE` 换成 6.7.1 会先在夹具配置阶段失败。[Gradle 6.8 发布说明](https://docs.gradle.org/6.8/release-notes.html#central-declaration-of-repositories)。

这是兼容性验证缺口，不代表产品一定使用了全部这些新 API。产品的 `reports.junitXml.required`、`outputLocation` 不能据名称就判定不兼容：已核对官方 6.7.1 源码，`Report.getRequired()` 已存在，`DirectoryReport.getOutputLocation()` 返回可设置的 `DirectoryProperty`。

官方源码：[Report.java](https://github.com/gradle/gradle/blob/v6.7.1/subprojects/reporting/src/main/java/org/gradle/api/reporting/Report.java)、[DirectoryReport.java](https://github.com/gradle/gradle/blob/v6.7.1/subprojects/reporting/src/main/java/org/gradle/api/reporting/DirectoryReport.java)、[TaskGeneratedSingleDirectoryReport.java](https://github.com/gradle/gradle/blob/v6.7.1/subprojects/reporting/src/main/java/org/gradle/api/reporting/internal/TaskGeneratedSingleDirectoryReport.java)。

已在审查目录新增真正的旧构建诊断夹具，使用该版本可用的仓库配置、AGP DSL 与 Kotlin 插件，并验证自定义 Java/Kotlin/resources/assets/res 测试源集。原版与诊断副本结果见 R7。这仍缺少完整的发现→安装→基线→RED→GREEN→Reviewer→本地集成→恢复验收，以及 flavor、Android→JVM 依赖和隔离 worktree 组合；不能只凭单库测试链声明旧版 Android 完整兼容。

### R4 · P2：验收条件可以没有任何绑定证据

证据：[contract.cjs:67](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/contract.cjs:67)。

校验器只检查每个用例引用的 criterion 在有效范围内，没有反向要求所有行为验收条件都被覆盖。已复现：合同有“修复输入处理”和“保持编码输出不变”两个条件，只给第一个条件配置测试，合同仍通过。

影响：测试身份清单完整不等于需求清单完整。全量旧测试可能碰巧覆盖第二项，Reviewer 也可能发现遗漏，但自动门禁没有要求提供这种对应关系。

建议每项验收条件声明证据种类并完整映射：行为测试、构建、静态检查、设备/视觉或人工审查。不要简单要求“每句文字都必须有单测”，但不得让行为条件无证据静默通过。`baselineCapture`/`measuredFact` 目前也主要是来源标签，仍需补齐实测证据身份及摘要。

### R5 · P2：Review 补测仍会与已冻结测试冲突

证据：[inventory.cjs:317](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/inventory.cjs:317)、[contract.cjs:86](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/contract.cjs:86)。

RED 后对测试源和资源使用整份快照一致性校验。Reviewer 要求新增边界测试，新增文件也会改变快照，无法在现有循环内合法完成。这个先前已记录的问题在 1.1.0 中仍未解决。

同时所有 V4–V8 合同必须至少包含一个行为变化 RED；纯重构、补测已有行为、新 API 尚未存在、资源/文档维护和已有失败基线修复仍缺少各自的验收协议。它们容易因流程不适配停住，不能把重试预算增加当作修复。

建议追加式证据版本：保留原 RED，在原基线隔离环境验证新增测试，再生成新 manifest/GREEN；原测试删除、断言弱化和需求变更单独处理。任务类型需显式批准并保持旧合同语义。

### R6 · P2：全变体验证与隔离构建环境可能阻塞旧项目

证据：[project-capabilities.ts:71](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/installer/project-capabilities.ts:71)、[project.cjs:151](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/templates/automation/verification/project.cjs:151)、[service.ts:75](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/queue/service.ts:75)。

当前将发现的所有单测变体和 assemble 任务纳入强制矩阵，配置校验也不允许遗漏任一构建任务。对需要专门签名、CI 参数、私有依赖或渠道文件的 Release/flavor，修改 Debug 代码也可能被无关环境要求阻断。这是保守全量策略的实际取舍，不是已经复现于用户工程的错误。

隔离 worktree 只专门转交 SDK 目录，不复制被忽略的 `local.properties`。若旧工程还从该文件或其他被忽略文件读取 NDK、CMake、本地路径、渠道配置等，原目录构建成功不保证隔离目录成功。不能为方便直接把含凭据的全部文件复制给执行模型。

建议先在目标工程验证隔离环境输入清单；按显式批准的构建矩阵限定可编辑源集和验证范围，公共源集仍覆盖相关消费者，缺失能力明确阻断。保留当前全量策略，直到范围缩小与影响检查有完整授权和测试。

## 仍需保留的运行边界

- **V8 规划刷新依赖输入声明完整性。** `planningInputsDigest` 只计算声明路径，不会自动保证 Planner 使用过的业务依赖都在列表中。自动刷新还检查中间提交的队列事务，这能证明提交来源，不能证明遗漏路径不影响需求。相关代码：[queue.ts:283](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/queue/queue.ts:283)、[executor.ts:126](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/src/queue/executor.ts:126)。初次接入宜用 `planningRefresh=reject`，待证明输入充分后再开放。
- **版本升级不会给旧合同补上超时与自动恢复。** 默认模板仍为 V4；Worker 监督、阶段恢复、隔离自动集成分别需要对应的新合同权限。核对实际任务合同，不要只看 npm 版本号。
- **长期运行仍未完成。** 模型供应商故障恢复、跨恢复任务总时限、模型成本限额、证据/日志磁盘治理、系统重启自动拉起和真实 24 小时故障注入仍缺验收。V6 的单次 Worker 截止不等于整个任务的累计时间上限。
- **文件权限限制不是 Gradle 沙箱。** 工程构建脚本和测试会执行本机代码；同用户恶意进程/恶意测试不在现有威胁模型内。若要让不可信仓库或强对抗模型运行，需额外 OS 级隔离；一般受信工程也应明确这一边界。见 [SECURITY.md](/Users/zhanglong/files/npmprogram/opencode_android_orchestrator/docs/SECURITY.md)。

## 本次最小复现与建议验收顺序

[复现脚本](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/reproduce.mjs)直接调用已发布源码的合同/RED 判定模块；[结果](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/reproduction-results.json)记录错误栈位置获准、未覆盖验收条件获准，以及 Java 21 的命令检查通过。本次复现不修改产品源码，不声称绕过完整端到端 Reviewer 或提交事务。

1. 确认目标工程的 wrapper URL、AGP、Kotlin、运行 JDK、SDK/NDK 和必要本地配置；保持用户要求的 Gradle 6.7.1。
2. 修复 R7 的旧版初始化阻断、R8 的 Kotlin 源集遗漏与 R1 的 RED 来源判定；补齐 R2 的实际构建环境诊断及绑定，避免错误环境进入长任务。
3. 建立 R3 的旧版真实夹具，并在目标工程的隔离副本完成一条真实任务链；覆盖失败 RED、错误 setup 失败拒绝、GREEN、重试、中断恢复和本地集成。
4. 补齐验收条件证据覆盖；处理目标工程的全变体和本地环境约束。
5. 初次使用保留人工验收及规划漂移拒绝。满足上述门槛后，再启用已批准的 V8 自动隔离集成；长期无人值守另做耐久与故障注入验收。

先前已修复的 Reviewer 参数、Review 循环次数、任务失败隔离、V5/V7 恢复、V6 监督、嵌套构建根和 V8 提交事务不重复列为新缺陷；本次结论也不宣称这些模块已获得新的全面安全证明。

## 续做实测证据（2026-10-01）

| 检查 | 结果与边界 |
| --- | --- |
| 阿里镜像 Gradle 6.7.1 发行包 | 102842885 字节；SHA-256 `3239b5ed86c3838a37d983ac100573f64c1f3fd8e1eb6c89fa5f9529b5ec091d` 与官方校验文件相符。昨天临时目录已丢失，本次重新下载核验；[记录](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/distribution-verification-resumed.json)。 |
| 原版 JVM 清单集成 | 上次 1/1 通过，包含参数化身份、过滤合并、跳过/空基线、重复 GREEN、输入篡改拒绝；持久日志已核对，本次未重跑。[日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/real-gradle-jvm.log)。 |
| 原版 Android 采集器 | 上次 baseline discovery 初始化失败；本次带 `--no-daemon` 再次复现；见 R7。 |
| 诊断副本 Android 清单集成 | 上次 1/1 通过，约 55 秒；2 项 baseline、1 项预期 RED、3 项 GREEN、check 通过；本次核对副本差异和持久证据。不是正式产品修复，也没有执行安装/完整队列/Reviewer/集成/恢复。 |
| 普通 daemon / `--no-daemon` 参数探针 | 本次均确认 System 属性缺失而启动参数保留；探针主动以退出码 1 停止，不能统计为构建通过。 |
| 原版工程能力发现 | 本次 Gradle 命令成功、模型结构校验通过，但自定义 Kotlin 测试目录遗漏。最初完整性断言失败后保留为产品发现，最终诊断脚本显式断言缺陷可复现；并未把期望降低后声称产品验收通过。 |
| Kotlin 动态属性探针 | 本次确认 metaClass 读取与 Gradle 动态属性读取不同；见 R8。 |

本次诊断脚本：[resume-diagnostics.mjs](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resume-diagnostics.mjs)。最终结果：[results.json](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/results.json)。首次沙箱运行被本地端口权限阻断，保留 [失败日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/property-daemon-sandbox.log)，随后经授权在沙箱外运行。产品仓库保持原提交且无工作区修改；没有重新发布 npm 或更改当前 Android 工程的安装实例。
