# OpenCode Android Orchestrator 0.2.0 真实 tarball 验证报告

## 结论

2026-08-25 至 2026-08-26，当前 `0.2.0` 候选 tarball 已在指定临时 Android
工程完成真实 `init → doctor → upgrade → doctor → uninstall → re-init` 生命周期，
并通过 OpenCode `1.15.13` 与 `1.14.22` 的非交互兼容矩阵和真实模型三次单选任务闭环。

两轮真实任务均完成 Planner、Coder、Reviewer、TDD RED/GREEN、质量门、人工验收和
单一组合提交；任务分支均已删除，临时验证分支保持本地、干净且 `pushed: false`。
用户随后确认已人工复核精确 SHA-256 并明确授权 public npm publish；npm CLI 官方浏览器
认证完成，`@frankzhang2026/opencode-android-orchestrator@0.2.0` 已成功发布。本轮没有创建
tag、GitHub Release 或执行当前 `cctest` 方案切换。

## 验证对象

| 项目 | 值 |
| --- | --- |
| 包名 | `@frankzhang2026/opencode-android-orchestrator` |
| 版本 | `0.2.0` |
| 插件源码 | `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator` |
| 候选源码提交 | `fde90868e3defb7a94e989a6953c99a7d91e8896` |
| 临时 Android 工程 | `/Users/zhanglong/files/program/npmtest/npmcctest` |
| 验证分支 | `validation/opencode-orchestrator-real-model-20260826`，仅本地 |
| 最终验证 HEAD | `842b6dc5317d4051d30ee0d7604461e3a2785c0d` |
| 候选 tarball | `/private/tmp/opencode-android-orchestrator-clean-ready.E3VtYt/frankzhang2026-opencode-android-orchestrator-0.2.0.tgz` |
| SHA-256 | `9c1b326bc2ecf9f28d1a4a9d723ee1b44acdb912f101f17b21dc07449c916bdc` |
| npm SHA-1 | `097aefb3c355528fa208d7bb8d887df90ae62d16` |
| npm integrity | `sha512-4HpTKN9pid349ARE9G6s97oFPDhYFF3Hn9DCL1NR7yJgNXRn80QPgMSrhA73ueiff4OT1eUE96uHdoqBpI8wUA==` |
| 文件数 | 130 |
| 打包/解包大小 | 170,710 / 825,403 bytes |

任何更早生成的 `0.2.0` tarball 及其 checksum 均已废弃，先前针对旧字节的人工复核
不能用于当前 SHA-256。

## tarball 审计

- 两次独立 `npm pack` 产物字节一致，SHA-256 相同。
- `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 和源码逐字节一致。
- 未包含 `release/`、`tests/`、`src/`、`node_modules/`、`.git`、安装备份、运行证据或
  历史任务数据；没有 bundled dependencies。
- 未发现 `/Users/` 等本机绝对路径、工程名、常见 npm/Git token 或私钥头。
- 包根只提供 OpenCode 插件入口，完整库 API 使用 `./api` 子路径。
- `npm test` 为 120/120，V3 Shell 事务回归为 38/38，`npm run pack:check` 通过。

## 实际发现并修复的问题

1. 包根曾导出非插件函数，真实 OpenCode 会把导出误当插件入口。现已使用专用
   `src/opencode-plugin.ts` 入口，并增加包根导出契约测试。
2. `shadow-run.sh` 曾把诊断文本混入 stdout。现已把诊断输出移到 stderr，stdout 只保留
   一个机器可读 JSON 文档，并有行为回归测试。
3. 移除 legacy Scheduler 后的真实干净工程没有可选 Scheduler 工具字段，source preflight
   曾把“字段缺失”误判为不安全。当前候选把缺失可选工具视为禁用，同时仍强制显式 deny，
   且工具值为 `true` 时继续 fail-closed；对应行为测试已加入 120 项回归。

## 当前候选的真实安装生命周期

当前候选先在不含 legacy Scheduler 的干净工程基线完成全新安装，再在完成两轮真实任务的
同一验证分支上复核完整生命周期。全过程没有复制整个 Android 工程，也没有建立额外候选
worktree。

| 阶段 | 结果 |
| --- | --- |
| 首次 `init --json` | `installed`；识别 Kotlin DSL 与 `:app`；写入 45 个受管文件；doctor、38 项事务测试和 shadow-run 通过。 |
| 同版本 `upgrade --json` | `already-current`；`0.2.0 → 0.2.0`；复用 45、写入 0；内置 doctor 和验证通过。 |
| 升级后独立 doctor | `ok: true`；OpenCode 1.14.22 certified；45 个文件、28 个可执行脚本、2 个原文件备份全部匹配。 |
| `uninstall --json` | 恢复 2 个原文件、删除 43 个插件创建文件、保留 0、警告 0；活动 manifest 被移除。Git 差异恰好是 45 个托管路径，真实任务的 8 个产品/合同文件未变化。 |
| `re-init --json` | `installed`；写入 45、复用 0；新安装 ID 为 `20260826122353784-a2d0d0a0-399a-483a-9e06-07cfaf2c697e`；内置 doctor、事务测试和 shadow-run 通过。 |
| 最终双版本 doctor | OpenCode 1.14.22 与 1.15.13 均为 certified、`ok: true`；安装资源、权限、备份和自适应配置全部通过。 |

生命周期结束后验证分支工作树干净，HEAD 仍为 `842b6dc`。本轮同版本验证不能替代未来
从一个已发布且具有旧 manifest 的版本向 `0.2.0` 做跨版本升级。

## OpenCode 非交互兼容矩阵

两版使用隔离的 XDG config/cache/data/state，并使用与版本匹配的精确 OpenCode 二进制。

| 检查 | 1.15.13 | 1.14.22 |
| --- | --- | --- |
| 版本号、插件启动、`opencode debug config` | PASS | PASS |
| 3 个 scheduled Agent | PASS | PASS |
| 2 个只读自定义工具及 Agent 精确权限 | PASS | PASS |
| 4 个本地 Command | PASS | PASS |
| 3 个本地 Skill + 5 个 Superpowers Skill | PASS | PASS |
| `preflight.sh --source` | PASS | PASS |
| `run-tests.sh` | 38/38 | 38/38 |
| `shadow-run.sh` | `mutationPerformed: false` | `mutationPerformed: false` |
| 最终安装态 doctor | certified、`ok: true` | certified、`ok: true` |

## 双版本真实模型闭环

| OpenCode | Planner/Coder/Reviewer 模型 | Planner session | 任务 | 集成结果 |
| --- | --- | --- | --- | --- |
| `1.15.13` | `deepseek/deepseek-v4-flash` | `ses_fc3458801ffe83fX91SmxYEUSo` | `TASK-WORKTAB-ALIAS` | `b423322 → 680e88e`，单一组合提交 |
| `1.14.22` | `deepseek/deepseek-reasoner` | `ses_fc2153a56ffem8xq4IDAaOYYZf` | `TASK-FAMILY-CENTER-HOME` | `680e88e → 842b6dc`，单一组合提交 |

两轮均满足：

- 恰好三次新的 `question` 调用，均为 `multiple:false`、`custom:false` 的单选；
- 方案、合同、验收三个选择分别匹配批准选项；
- 真实模型产生非零 token 和 cost，Planner、Coder、Reviewer 均有独立证据；
- 基线测试绿色、真实 focused RED、一次绿色质量门、独立 Reviewer 批准；
- focused test、完整单元测试、`assembleDebug` 和 Android lint 通过；
- 最终提交只包含计划、合同、代码和测试四个文件；
- 集成后任务分支删除，没有 Git push、launchd 注册或额外候选 worktree。

1.14.22 的初始不可信请求同时包含三句伪批准文本，但三道关口仍各自等待并取得新的 UI
单选，证明聊天文本不能冒充审批。1.15.13 与 1.14.22 的最终提交分别为
`680e88ec8195ac07489f4baa3970ce19ec0ea4bf` 和
`842b6dc5317d4051d30ee0d7604461e3a2785c0d`。

## 证据与清理状态

- Planner/Coder/Reviewer session exports 位于
  `/private/tmp/opencode-orchestrator-real-model-evidence.LU0tQ3/`。
- 临时 Android 仓库的任务状态、合同哈希和质量门证据位于
  `.git/automation-runtime/`，未进入 npm 包。
- 验证分支尚未推送，当前没有任务分支、任务 worktree 或仓库租约。
- 验证分支删除前应刷新并校验
  `/private/tmp/npmcctest-opencode-orchestrator-validation-20260826.bundle`，然后恢复原先暂存的
  `.idea/.name`。
- 插件源码修复提交 `fde9086` 已按用户授权推送到 `origin/main`；这与 Android 任务的
  no-push 约束相互独立。

## npm 发布与 Registry 回环验证

- `npm publish` 返回 `+ @frankzhang2026/opencode-android-orchestrator@0.2.0`。
- Registry 版本为 `0.1.0`、`0.2.0`，`latest` 指向 `0.2.0`。
- Registry metadata 的 SHA-1 为 `097aefb3c355528fa208d7bb8d887df90ae62d16`，
  integrity 为
  `sha512-4HpTKN9pid349ARE9G6s97oFPDhYFF3Hn9DCL1NR7yJgNXRn80QPgMSrhA73ueiff4OT1eUE96uHdoqBpI8wUA==`。
- 从 Registry 回下载的固定版本 tarball 与获批文件逐字节一致，SHA-256 仍为
  `9c1b326bc2ecf9f28d1a4a9d723ee1b44acdb912f101f17b21dc07449c916bdc`。
- 干净临时 consumer 从 Registry 安装固定 `0.2.0` 后，四个 CLI 生命周期命令均可用；
  其 CLI 在 OpenCode `1.14.22` 与 `1.15.13` 下执行安装态 doctor 均为 `ok: true`。
- 没有创建 Git tag 或 GitHub Release，验证分支仍保持本地、干净且未 push。

## 尚未完成

- 在本机 OpenCode `1.15.13` 和目标电脑 OpenCode `1.14.22` 分别从发布包执行完整重装与
  真实任务验收；当前完成的是同机隔离双版本 Registry CLI doctor。
- 按独立授权决定是否把当前 `cctest` 工程切换到已发布包。
- 验证分支最终归档、删除及 `.idea/.name` 恢复。

`0.2.0` 发布授权已经消费；任何后续版本、Git tag、GitHub Release 或当前工程切换都需要
新的独立授权。
