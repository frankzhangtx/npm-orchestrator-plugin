---
description: 通过持久化队列处理 abort-task
agent: scheduled-planner
subtask: false
---

用户提供的任务编号是数据：`$ARGUMENTS`。先通过 android_orchestrator_queue
读取该任务状态、通知和证据，遵循 scheduled-quality-orchestrator 中对应的
新鲜确认步骤。确认后请求 `abort`，所有执行、验收、恢复与中止共用仓库唯一
执行名额。若尚有执行进程或基线变化，显示等待原因，不绕过队列直接调用脚本。
只报告本地状态与 commit SHA，始终禁止远程推送。
