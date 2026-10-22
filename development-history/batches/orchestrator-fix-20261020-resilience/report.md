# WordPress 执行中断修复与验证

状态（2026-10-21）：rc.3 真实验证超时，副本恢复为 RESTORATION_BLOCKED；中止故障已修复并通过针对性回归，等待独立人工收尾授权。未完成、未合入 main、未发布。

## 恢复来源

2026-10-19 的修复副本、日志、冻结 rc.1 和试运行副本均位于 `/private/tmp`，2026-10-20 续跑时已不存在。从原会话工具调用恢复补丁，原始命令保存在 `recovered/`。昨晚完整套件只剩退出码 1 的记录，无法据此断言具体失败原因；本轮重新运行并持久保存日志。旧批次期限及委托未复用。

## 根因与修复

- `record-red.sh` 未被长命令识别器覆盖，调用方的 20 分钟超时没有提高到配置的 30 分钟下限。补上该入口，保持更长调用方超时及 Worker 的独立截止时间。
- RED 的异常类型、消息和来源约束之前短路检查，Coder 修好类型后才发现来源仍错误。现同时报告 `singleFailure/type/message/origin`，保持验收语义。
- Planner/Coder 指引明确要求断言符合封存合同；遇到超时及 RUNNING/锁记录时记录阻塞原因并停止重复尝试。
- 本修复不提供中断 RED 记录的自动接管，不删除历史锁或重置预算。原 WordPress 图片缓存任务仍保留现场。

## 候选

- 版本：`1.3.7-rc.2`
- 修复提交：`a152d91`
- 打包源码：`2a327315016f255625619418cb45730ca8b70bad`
- 包 SHA-256：`a7dd75668da742fc4fa5a550868398946a1d27d7ea389962e2001a550e0e4834`
- 后续 `5f8dc92` 仅对齐不随包分发的测试版本断言；冻结包未改动。
- 完整摘要及安装身份：`candidate/identity.json`、`candidate/install.json`。

## 已确认的检查

- 原工程安装基线通过，原版 doctor 在沙箱外通过。
- 新增两条回归修复前失败，修复后针对性 19 项全部通过。
- 候选针对性及版本元数据 26 项通过。
- 候选升级、安装、版本和文档 39 项通过；先前沙箱失败及旧版本断言失败日志保留。
- 历史电话任务两次失败日志重放：首次同时识别 type/origin 不匹配，第二次识别 origin 不匹配，仍拒绝不合格 RED；见 `replay.json`。
- rc.2 完整套件 413 项：411 通过、2 个模板固定摘要断言失败；同步三份已修改模板的审计摘要后，rc.3 完整套件 417 项全部通过。
- rc.3 普通包级 driver fixture 通过；冷环境对照在业务完成后复现二次 host 生成依赖导致恢复失败，提交 `4d81904` 补齐检查后的受限清理，冷环境完整夹具及 7 项恢复测试通过。
- 真实 WordPress 基线两变体全量单测通过（646 秒），聚焦基线 3 项；第一次 RED 因 JUnit 字符串断言产生包装异常而拒绝，使用一次准备修正后第二次得到 VALID_RED（3 个批准失败、6 项总数、无跳过），GREEN 聚焦 6 项全过；后续完整受影响验证超过 45 分钟执行期限，未取得成功结果，Review 与集成尚未完成。

## 真实验证范围

独立 WordPress 副本，任务 `TASK-RESILIENCE-PHONE-20261020`，分支 `trial/resilience-20261020-rc2`。仅允许修改电话格式化工具及其测试。通过原生 `/change` 与可信 driver 签发的有界委托运行，45 分钟执行、15 分钟收尾。聚焦测试为 `:WordPress:testWordpressDebugUnitTest --tests org.wordpress.android.util.DomainPhoneNumberUtilsTest`；后续构建及 affected 验证以封存计划和实际结果为准，不等同全仓库测试。

默认三个候选已使用（rc.1、rc.2、rc.3）。用户在追加一个候选的请求后表示继续，下一轮计划限 90 分钟执行、15 分钟收尾；只有旧副本恢复完成后才能冻结并启动 rc.4。原工程、历史队列、未提交图片缓存测试改动保留；不推送或发布。

## 待收尾

完整回归结果与失败分析；业务 RED/GREEN、Review、集成；原工程及副本安装恢复门禁；本地 main 版本整理与合入；本次临时开发分支清理。未满足前不宣称完成。

## rc.3 与收尾修正

- rc.3 源码 `04cf0372e116c02e85fd50a1b5e5cf1136b7ced8`，SHA-256 `33e223bb02daf956f35062173543a1e37d99155a4c3fe990852a0ee28c3eae27`。见 `candidate-rc3/identity.json`。
- 额外修复：活动执行器期间不遍历工作树；扫描期间工作树消失或队列快照变化时重试下一轮，稳定目录的真实 I/O 错误仍拒绝。
- 恢复只清理原快照不存在且与封存状态逐文件字节/模式一致的 OpenCode 依赖新增项，不覆盖已有受管文件和外部修改。
- rc.2 已经操作员恢复：`trial-rc2/operator-restoration-result.json`，原中断 ledger 保持不变。副本与原工程的中间门禁均通过。旧 run scope 仅在服务停止、队列空闲、恢复核验通过后归档移除。
- 本轮 rc.3 真实任务：`TASK-RESILIENCE-PHONE-RC3-20261020`，目标分支 `trial/resilience-20261020-rc3`。
- `4d81904` 是 rc.3 冻结之后的收尾修正，尚未作为新冻结包进行完整原生实跑，不得将 rc.3 结果冒称该源码版本的完整实跑结果。后续用户表示继续；追加候选尚未开始，先解决 rc.3 的恢复阻塞。
- 故障注入夹具最后会故意修改 manifest 并检验拒绝；其末尾 ledger 可能显示 RESTORATION_BLOCKED。成功证据需看命令退出码、日志断言和首次 `restoration-result.json`，不能仅看该故意失败的末尾状态。

## 2026-10-21 续跑结果

- rc.3 原错误：`Trial execution deadline exhausted; Trial cleanup deadline exhausted`。失败 ledger、specification、run scope 和委托均未修改。
- 自动中止在源工作区读取合同，但隔离准备流程已把合同移到任务工作树。`jq` 找不到合同，进而把合法的 `DomainPhoneNumberUtils.kt` 修改误判为越界。
- 提交 `6fbff58` 改为读取任务工作树中刚通过摘要验证的合同；合同篡改、越界和保护路径限制继续生效。冻结 rc.3 包及安装未修改。
- 真实回归：`abort-red-unrestricted.log` 复现缺失合同；`abort-green.log` 4/4；`abort-template-green.log` 6/6；`abort-shell-lifecycle.log` 46/46；构建与 diff 检查通过。最初沙箱 ps 限制及测试状态断言调整已记录，不把它们当作业务根因。
- 通过官方队列 stop 停止副本服务。`rc3-stopped-status.json` 记录服务停止、active=null、paused=true、fault=null。任务仍 BLOCKED，工作树和代码保留；未伪造 ABORTED 或恢复成功。
- `original-20261021-final.json`：installation.ok=true，restoration.ok=true。原工程图片缓存任务及用户改动保持原样；原版 doctor 也通过（ok=true），见 `original-doctor-20261021.json`。
- 现有 `trial-recover` 明确拒绝过期收尾期限。已询问是否允许增加仅绑定本 rc.3 任务、15 分钟有效、只中止归档和恢复的独立人工恢复授权入口。确认前不实现授权变更、不启动新候选；不续期旧执行授权或改写旧记录。
- 修复分支仍为 `fix/wordpress-resilience-20261020`，工作树 `source/` 保留。主分支仍未合入，版本仍为候选元数据 `1.3.7-rc.3`；源码比冻结 rc.3 多 `4d81904` 和 `6fbff58`，不能宣称此源码已经真实完整实跑。

## 2026-10-22 测试夹具归档清理

按用户要求清理大量未跟踪中间文件。确认没有相关验证进程后，将 `driver-fixtures/` 完整归档到 `driver-fixtures-archived-20261022.tar.gz`，逐文件核验内容一致后删除展开目录。恢复时在本目录执行 `tar -xzf driver-fixtures-archived-20261022.tar.gz`。唯一代码、任务恢复依赖、源码与 WordPress 工作树均保留；旧任务仍未完成。清理回执见 `fixture-cleanup-20261022.json`。

## 2026-10-22 删除旧候选安装及恢复备份

用户明确表示未完成任务的候选安装和恢复备份不再需要，已删除 `installations/`、`trial-rc2/original-package/`、`trial-rc2/installation-restore/`、`trial-rc3/original-package/`、`trial-rc3/installation-restore/`。历史记录中的对应路径现已失效，不能再依赖这些目录恢复旧试运行。未合入源码、WordPress 工作树、冻结候选 tarball 和历史日志保留。删除清单见 `installation-cleanup-20261022.json`。

## 2026-10-22 删除试验工作树

按用户明确要求，通过 git worktree remove 删除插件修复工作树 `source/` 和 WordPress 验证工作树 `wordpress-worktrees/task-resilience-phone-rc3-20261020-v1/`。保留两者的 Git 分支与已提交历史；WordPress 工作树中的电话工具、测试及任务/计划未提交修改随目录删除。此次删除不是验证通过或合入完成。详情见 `worktree-removal-20261022.json`。
