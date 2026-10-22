# 开发与验证批次

2026-10-22 从 cctest/taskdescriptions 整体迁入。路径映射及 Git 校验见 [迁移清单](migration-20261022.json)。

| 批次 | 状态 | 入口 |
| --- | --- | --- |
| 1.4.0 受影响测试优化 | 已推送 GitHub、发布 npm | [报告](orchestrator-affected-tests-20261021/report.md) |
| WordPress resilience 修复 | 未完成，未合入修复源码保留 | [报告](orchestrator-fix-20261020-resilience/report.md) |

批次内保留日志、制品身份和发布/清理回执。resilience 批次的 source、candidate-source、wordpress、wordpress-worktrees 和大型夹具归档仅在本地保留，通过该批次 .gitignore 排除，避免把嵌套仓库或大型文件误提交。

历史日志、JSON 和脚本中的绝对路径保持原始证据，不代表可直接执行；需要使用时先按迁移清单定位新目录。旧任务的候选安装及恢复备份已按用户要求删除，此次迁移不恢复它们，也不代表旧任务完成。

2026-10-22 后续清理：用户要求删除 resilience 的 `source/` 和 `wordpress-worktrees/`，现已移除，分支与已提交历史保留。上述目录及迁移清单中的状态为历史记录；详见批次 `worktree-removal-20261022.json`。
