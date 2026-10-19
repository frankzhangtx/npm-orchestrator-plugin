# Gradle 6.7.1 审查修复进度

用户于 2026-10-01 授权修复审查发现。产品仓库 `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`，基准提交 `9bd6cd553aa42f4f7f79397e7da248d961ada234`，版本 1.1.0，开始时工作区干净。

开发副本：`orchestrator-gradle671-fix-work/source/`；原文件摘要：`orchestrator-gradle671-fix-work/baseline.json`；验证目录：`orchestrator-gradle671-fix-validation/`。

**2026-10-08 本轮开发修复及交付验证完成。42 个文件已同步产品仓库，最终全量 325/325、真实 Android 4/4、Shell 46/46 通过。版本保持 1.1.0，未发布。**

## 验收清单

- [x] R7：Gradle 6.7.1 初始化请求参数读取与明确错误诊断。
- [x] R8：旧 Kotlin 动态源集发现，生产/测试目录真实验证。
- [x] R1：RED 失败位置校验；真实 setup 失败拒绝，teardown/规则等确定性专项覆盖。
- [x] R4：每项验收条件都有显式证据映射。
- [x] R2：真实构建 JVM 诊断、清单阶段运行时比较及环境输入恢复绑定；不宣称监视每个测试子进程。
- [x] R3：独立旧版夹具的清单、生命周期和两任务队列验证；不等同用户目标工程或真实模型验收。
- [x] R5：显式批准的一次新文件补测；其他任务协议继续拒绝并说明边界。
- [x] R6：隔离时拒绝未声明的非 SDK 本地属性；保留全变体矩阵，不实现缩小验证范围。
- [x] 全量回归、Shell、类型检查、打包检查与源码同步。

目标工程路径已异步询问；无答复时先使用 Gradle 6.7.1 / AGP 4.2.2 / Kotlin 1.4.32 的独立夹具。未授权本轮 npm 发布。

## 2026-10-08 恢复记录

- 已核对产品仓库与 `baseline.json` 全部原文件摘要一致，产品工作区干净；沿用已有开发副本。
- 上次 `legacy-queue.log` 实际为 1/1 通过（约 376 秒），覆盖旧版 flavor、Android→JVM、两项隔离自动集成与规划刷新；上次尚未写回本进度。Coder/Reviewer 为模拟响应。
- 补齐卸载和 doctor 测试中的实际 JVM 模拟响应、53 个管理资源的数量断言及新增文档清单。初始沙箱运行受 `ps EPERM` 阻断，沙箱外复验后修正上述夹具遗漏。
- doctor/文档专项 17/17 通过：`resumed-doctor-docs.log`。初次完整回归发现旧夹具遗漏，不算全量通过；最终结果见下文。
- 新增独立 `gradle671-lifecycle.integration.mjs`，用于真实验证安装、模拟旧版本升级、实际 JVM 诊断、Kotlin 自定义目录和原基线 Review 补测。
- 临时 Gradle 发行目录已被清理；重新从原阿里镜像下载，并核对上次记录的官方 SHA-256。发行工具放在验证目录 `tooling/`，不纳入产品包。

### 已完成的续做验证

- 首轮全量 324 项：309 通过、15 失败，均为 doctor/文档测试夹具遗漏；日志 `resumed-full-initial.log`。对应修复的专项 17/17 通过。后补实际 JVM 变化拒绝用例，专项 5/5 通过。
- 旧版真实清单与新生命周期 **2/2 通过**（`resumed-legacy-cached.log`，约 53 秒）：安装、实际 JVM doctor、模拟旧版本升级、Kotlin 自定义生产/测试目录、错误 setup RED 拒绝、基线/RED/GREEN/check、新文件补测在原基线上通过、原 RED 不变、卸载。生命周期证据 `legacy-lifecycle-KCLHw5/`。
- 首次旧版复验依赖解析缓存缺失：清单 1/1 通过、生命周期离线失败，保留 `resumed-legacy-lifecycle.log`。随后用本机已有 2555 个 JAR/POM 等缓存文件建立测试专用本地 Maven 仓库，未改变产品依赖或降低断言。
- 新版真实 Gradle 9.4.1 / AGP 9.2.1 / SDK 36 / JDK 21 **2/2 通过**（`resumed-modern-android.log`，约 247 秒），含根目录和嵌套目录、Staging、多模块传递依赖、安装升级卸载及嵌套隔离工作区测试/清单。
- 已核对上次两个真实旧版队列的 GREEN 记录：采集器摘要与当前候选一致，见 `inherited-queue-evidence-check.json`；未把旧日志写作本次重跑。
- 类型检查通过；打包预检沙箱内因 npm 缓存写权限失败，沙箱外通过（225 个发布文件），见 `resumed-typecheck.log`、`resumed-pack-check-unsandboxed.log`。
- 候选冻结为 192 个源码文件、42 个审阅变更。`candidate-snapshot.json`、`reviewed-changes.json`、`reviewed-changes.patch` 已保存；冻结后执行最终全量 `resumed-full-final.log`，通过后才同步产品源码。

### 最终交付

- 冻结候选的完整 `npm test` **325/325 通过**，0 失败、0 取消、0 跳过，约 692 秒；[最终日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle671-fix-validation/resumed-full-final.log)。前次 15 项失败均已通过，新增实际 JVM 变化拒绝测试也包含在内。
- Shell **46/46 通过**，见 [日志](../../../../program/cctest/taskdescriptions/orchestrator-gradle671-fix-validation/resumed-shell.log)。类型检查、源码构建、打包预检通过，225 个发布文件、53 个安装管理资源。
- 经文件系统授权，已同步 **42 个审阅文件**到 `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`。同步前复核完整原始摘要并备份被替换文件；**150 个未涉及的基准文件保持不变**。
- 产品重新构建成功；**192 个源码文件**与冻结候选一致，**148 个编译文件**的内容和权限一致。`git diff --check`、审阅补丁反向检查均通过。[最终核验](../../../../program/cctest/taskdescriptions/orchestrator-gradle671-fix-validation/final-verification.json)、[同步记录](../../../../program/cctest/taskdescriptions/orchestrator-gradle671-fix-validation/sync-result.json)、[审阅补丁](../../../../program/cctest/taskdescriptions/orchestrator-gradle671-fix-validation/reviewed-changes.patch)。
- 保留 npm 版本 1.1.0；这些新增修复仍属未发布开发代码。没有 Git 提交、推送、npm 发布或修改当前 Android 项目的安装实例；发布时必须使用新版本。

剩余边界：用户目标工程路径及实际工具组合尚未提供，因此不能宣称目标工程已通过；真实 Android 测试没有调用真实 Coder/Reviewer 模型或执行设备测试。纯重构、无行为变化、失败初始基线等新任务协议、Review 修改原断言或新增依赖新实现的测试、缩小全变体矩阵、任意忽略文件环境注入及长期无人值守验收仍未实现。当前实现对此保持拒绝/显式边界，不把这些能力列为本轮交付。实际测试 JVM 子进程与任意后置执行钩子也不在运行时记录的完整证明范围内。
