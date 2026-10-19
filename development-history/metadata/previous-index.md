# Orchestrator 开发过程资料

整理日期：2026-10-19。以下为历史过程记录，文中的“当前”“最新”以各文件记录时间为准。

## 目录索引

### 设计与改造计划

- [OpenCode Android 自动编程编排插件：开发与发布待办任务](../design/opencode-android-orchestrator-plugin-todo.md)
- [Orchestrator 合同与测试预期校验方案](../design/orchestrator-contract-test-validation-design.md)
- [任务启动前置条件检查与等待机制方案](../design/orchestrator-task-start-preconditions-design.md)
- [Orchestrator Android 工程普适性与长期运行方案](../design/orchestrator-portability-and-continuity-review.md)

### 开发与修复进度

- [Android 普适性与持续运行实现进度](../progress/orchestrator-android-continuity-progress.md)
- [Orchestrator 内置工作流技能改造进度](../progress/orchestrator-bundled-skills-progress.md)
- [Gradle 6.7.1 审查修复进度](../progress/orchestrator-gradle671-fix-progress.md)
- [Orchestrator 测试集合覆盖修复](../progress/orchestrator-test-inventory-progress.md)
- [Orchestrator 1.0.0 开发进度](../progress/orchestrator-v1-implementation-progress.md)
- [WordPress baseline 剩余测试修复进度](../progress/wordpress-baseline-test-failures-fix-progress.md)
- [WordPress Mockito instrumentation 修复进度](../progress/wordpress-mockito-instrumentation-fix-progress.md)

### 审查与工程验证

- [OpenCode Android Orchestrator 0.2.0 真实 tarball 验证报告](../validation/opencode-android-orchestrator-plugin-validation-2026-08-26.md)
- [Orchestrator 1.1.0 整体审查与 Gradle 6.7.1 适配评审](../validation/orchestrator-gradle-6.7.1-review.md)
- [Orchestrator 本地候选包与 WordPress 无人值守验证实施方案](../validation/orchestrator-local-package-wordpress-validation-plan.md)
- [WordPress Android 工程接入 OpenCode Android Orchestrator](../validation/wordpress-opencode-android-orchestrator-integration.md)

### 历史补丁

- [orchestrator-v1-work-in-progress.patch](../patches/orchestrator-v1-work-in-progress.patch)
- [wordpress-mockito-instrumentation-fix.patch](../patches/wordpress-mockito-instrumentation-fix.patch)

### 插件化前的操作参考

- [OpenCode 自动编码方案：逐步操作指南](../reference/stepdetail.html)
- [Task 2：OpenCode 手工执行“重庆城市识别”任务](../reference/task2.html)
- [Task 2 自动编排方案：从需求确认到原分支提交](../reference/task2detail.html)

### 发布记录

- [npm发布.txt](../release/npm发布.txt)

## 备份与其他资料

- [完整可恢复基线](/Users/zhanglong/files/program/cctest/方案备份/README.md)：2026-08-19 插件化前备份，约 3.9 MB，保留原路径及目录结构。
- [恢复说明](/Users/zhanglong/files/program/cctest/方案备份/恢复说明.md)；从工程根目录运行 `./方案备份/verify-backup.sh` 检查完整性。
- [队列流程说明](../visuals/orchestrator-auto-agent-queue-design-explained.html)。
- [WordPress 接入说明页](../visuals/wordpress-opencode-android-orchestrator-integration-explained.html)。
- 插件产品源码在历史记录中指向 `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`，本次仅整理本工程的过程资料。

## 整理与保留规则

- 本次迁移 21 个过程文件，按用途分类；未删除备份、补丁或证据。
- [迁移清单](previous-relocation-manifest.json)记录原路径、新路径及前后 SHA-256；文档变化仅为路径引用调整，补丁和 HTML 内容原样保留。
- `方案备份/` 中的快照、依赖和运行审计保持原样。其完整性检查已通过：70 个快照文件、183 个依赖文件、79 个审计文件。
- `.opencode/`、`automation/`、`scripts/automation/` 是现有方案资源，未作为历史备份迁移。
- 后续过程文档按以上目录归类。工程副本、依赖目录、构建产物和运行日志应单独存放，记录来源与验证结论后再决定保留期限。

## 当前工作区缺失的历史证据

整理前，下面的 Markdown 链接目标已经不存在；本次保留其原目标含义，未重新生成或宣称已验证这些证据。历史正文中的其他路径也可能已失效。

另外，开发记录提到的 `taskdescriptions/orchestrator-test-inventory-work/source` 工程副本当前也不存在。

- `taskdescriptions/orchestrator-1.3.0-preconditions/completion.md`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/android-model-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/full-complete.log`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/pack-delivery.log`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/android-model/typecheck-delivery.log`
- `taskdescriptions/orchestrator-android-continuity-validation/continuity-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/full-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/isolated-integration-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/isolated-integration/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/full-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/nested-root-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/pack-check.log`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/real-android-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/nested-root/typecheck.log`
- `taskdescriptions/orchestrator-android-continuity-validation/pack-check.log`
- `taskdescriptions/orchestrator-android-continuity-validation/recovery/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/recovery/full-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/recovery/pack-check.log`
- `taskdescriptions/orchestrator-android-continuity-validation/recovery/recovery-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/recovery/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/focused-resumed.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/full-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/full-verified.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/lock-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/pack-verified.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/review-exhaustion-diagnostic.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/shell-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/stage-recovery-changes.patch`
- `taskdescriptions/orchestrator-android-continuity-validation/stage-recovery/typecheck-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/npm-publication/publication-status.json`
- `taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/npm-publication/registry-metadata.json`
- `taskdescriptions/orchestrator-android-continuity-validation/version-1.1.0/version-tests.log`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/final-verification.json`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/full-initial.log`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/pack-check.log`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/related-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/reviewed-changes.json`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/worker-final.log`
- `taskdescriptions/orchestrator-android-continuity-validation/worker-termination/worker-termination-changes.patch`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/diagnostic-verification/collect.init.gradle`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/distribution-verification-resumed.json`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/real-gradle-android-diagnostic.log`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/real-gradle-jvm.log`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/reproduce.mjs`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/reproduction-results.json`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resume-diagnostics.mjs`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/capabilities.json`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/capability-discovery.log`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/kotlin-property.log`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/property-daemon-sandbox.log`
- `taskdescriptions/orchestrator-gradle-6.7.1-review/resumed-diagnostics/results.json`
- `taskdescriptions/orchestrator-gradle671-fix-validation/final-verification.json`
- `taskdescriptions/orchestrator-gradle671-fix-validation/resumed-full-final.log`
- `taskdescriptions/orchestrator-gradle671-fix-validation/resumed-shell.log`
- `taskdescriptions/orchestrator-gradle671-fix-validation/reviewed-changes.patch`
- `taskdescriptions/orchestrator-gradle671-fix-validation/sync-result.json`
- `taskdescriptions/orchestrator-local-package-wordpress-validation/final-report.md`
- `taskdescriptions/orchestrator-local-package-wordpress-validation/progress.md`
- `taskdescriptions/orchestrator-test-inventory-validation/real-gradle`
- `taskdescriptions/orchestrator-test-inventory-validation/recovered-unverified.patch`
- `taskdescriptions/orchestrator-test-inventory-validation/review-fixes/development-validation.md`
- `taskdescriptions/orchestrator-test-inventory-validation/review-fixes/final-source.patch`
- `taskdescriptions/orchestrator-test-inventory-validation/review-fixes/source-inventory.json`
- `taskdescriptions/orchestrator-test-inventory-validation/review-fixes/writeback-verification.json`
- `taskdescriptions/orchestrator-v1-validation`
- `taskdescriptions/orchestrator-v1-validation/development-validation.md`
- `taskdescriptions/orchestrator-v1-validation/writeback-verification.json`
- `taskdescriptions/wordpress-1.2.3-start-diagnosis/diagnosis.md`
