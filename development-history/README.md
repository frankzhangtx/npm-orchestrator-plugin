# Orchestrator 开发历史资料

本目录于 2026-10-19 从 Android 实验工程 `cctest` 迁入，集中保存插件开发过程中的非产品源码资料。历史文档中的版本、状态及“当前”结论仅代表记录当时；现行使用说明见 [项目 README](../README.md) 和 [文档目录](../docs/)。

## 发展脉络

| 阶段 | 归纳 | 资料入口 |
| --- | --- | --- |
| 插件化之前 | 定时编程、质量门禁与人工操作流程；保留 2026-08-19 可恢复基线 | `reference/`、`visuals/`、cctest 的 `方案备份/` |
| 插件化与接入 | 插件实现计划、早期发布验证、WordPress Android 接入 | `design/`、`release/`、`validation/` |
| 能力迭代 | 内置技能、任务队列、测试清单、Android 适配与持续运行 | `design/`、`progress/` |
| 兼容与实跑 | Gradle 6.7.1、任务启动条件、本地候选包验证和问题分析 | `validation/`、`progress/`、`issues/` |

## 分类索引

### 设计与方案

- [OpenCode Android 自动编程编排插件：开发与发布待办任务](design/opencode-android-orchestrator-plugin-todo.md)
- [Orchestrator 合同与测试预期校验方案](design/orchestrator-contract-test-validation-design.md)
- [Orchestrator Android 工程普适性与长期运行方案](design/orchestrator-portability-and-continuity-review.md)
- [任务启动前置条件检查与等待机制方案](design/orchestrator-task-start-preconditions-design.md)

### 开发与修复进度

- [Android 普适性与持续运行实现进度](progress/orchestrator-android-continuity-progress.md)
- [Orchestrator 内置工作流技能改造进度](progress/orchestrator-bundled-skills-progress.md)
- [Gradle 6.7.1 审查修复进度](progress/orchestrator-gradle671-fix-progress.md)
- [Orchestrator 测试集合覆盖修复](progress/orchestrator-test-inventory-progress.md)
- [Orchestrator 1.0.0 开发进度](progress/orchestrator-v1-implementation-progress.md)
- [WordPress baseline 剩余测试修复进度](progress/wordpress-baseline-test-failures-fix-progress.md)
- [WordPress Mockito instrumentation 修复进度](progress/wordpress-mockito-instrumentation-fix-progress.md)

### 审查与工程验证

- [OpenCode Android Orchestrator 0.2.0 真实 tarball 验证报告](validation/opencode-android-orchestrator-plugin-validation-2026-08-26.md)
- [Orchestrator 1.1.0 整体审查与 Gradle 6.7.1 适配评审](validation/orchestrator-gradle-6.7.1-review.md)
- [Orchestrator 本地候选包与 WordPress 无人值守验证实施方案](validation/orchestrator-local-package-wordpress-validation-plan.md)
- [WordPress Android 工程接入 OpenCode Android Orchestrator](validation/wordpress-opencode-android-orchestrator-integration.md)

### 历史补丁

- [orchestrator-v1-work-in-progress.patch](patches/orchestrator-v1-work-in-progress.patch)
- [wordpress-mockito-instrumentation-fix.patch](patches/wordpress-mockito-instrumentation-fix.patch)

### 发布参考

- [npm发布.txt](release/npm发布.txt)

### 早期操作指南

- [OpenCode 自动编码方案：逐步操作指南](reference/stepdetail.html)
- [Task 2：OpenCode 手工执行“重庆城市识别”任务](reference/task2.html)
- [Task 2 自动编排方案：从需求确认到原分支提交](reference/task2detail.html)

### 图文说明

- [Orchestrator 自动执行与任务队列解耦设计方案 · 工作区与提交双策略](visuals/orchestrator-auto-agent-queue-design-explained.html)
- [Superpowers × OpenCode Scheduler 定时编程质量门禁融合方案 V1](visuals/scheduled-coding-quality-gate-explained-v1.html)
- [OpenCode Scheduler 定时编程质量门禁方案](visuals/scheduled-coding-quality-gate-explained.html)
- [WordPress 升级到 OpenCode Android Orchestrator 0.7.0](visuals/wordpress-opencode-android-orchestrator-integration-explained.html)

### 问题分析

- [orchestrator问题.txt](issues/orchestrator问题.txt)

## 历史备份（保留在 cctest）

- 按用户要求，`方案备份/` 不纳入迁移，整套文件已恢复到原 Android 工程。
- [2026-08-19 插件化前完整基线](/Users/zhanglong/files/program/cctest/方案备份/README.md)包含快照、恢复说明、固定版本依赖及运行审计。
- 从 `cctest` 工程根目录执行 `./方案备份/verify-backup.sh` 检查完整性；原内容、文件权限及忽略规则保留。

## 迁移与使用说明

- [本次迁移清单](metadata/migration-manifest.json)：逐文件记录来源、去向、前后 SHA-256 与权限。
- [前次分类清单](metadata/previous-relocation-manifest.json)与[前次整理索引](metadata/previous-index.md)保留历史来源。前次索引中的“保留原位”等描述为当次状态，本次位置以本页和迁移清单为准。
- 前次索引列出的 78 个缺失历史证据目标没有恢复；迁移后的链接仍指向原来的证据位置。正文中的历史命令、日志路径与补丁内容保留，不能直接视为当前可执行操作。
- 本目录独立于产品源码和 npm 发布的 `docs/`，不进入当前 `package.json` 的发布白名单。
- `cctest` 中仍在使用的 `.opencode/`、`automation/`、`scripts/automation/` 和 Android 任务计划保留原位。其历史版本已包含在备份快照中。

## 2026-10-22 新迁入批次

- [开发与验证批次](batches/README.md)：1.4.0 发布资料及未完成的 WordPress resilience 修复现场。
- [本次目录迁移清单](batches/migration-20261022.json)：旧/新路径及四个源码/工作树的 HEAD、Git 状态对比。
