# OpenCode Android 自动编程编排插件：开发与发布待办任务

## 任务信息

| 字段 | 内容 |
| --- | --- |
| 任务 ID | `TASK-OPENCODE-ANDROID-ORCHESTRATOR-PLUGIN-001` |
| 状态 | `IN_PROGRESS`，`0.2.0` 已经人工复核、授权并公开发布；Registry 回下载字节一致，固定版本 CLI 及双版本 doctor 通过；下一步完成两台目标环境的发布后完整验收，并单独决定当前 `cctest` 工程是否切换 |
| 创建日期 | 2026-08-19 |
| 最近核对日期 | 2026-08-26 |
| 任务类型 | OpenCode 插件开发、Android 工程初始化器、双版本兼容与 npm 发布 |
| 当前本机 OpenCode | `1.15.13` |
| 目标电脑 OpenCode | `1.14.22` |
| 当前方案基线 | OpenCode coding orchestration V3，Git HEAD `829693652e3737ad94c7cc75214b09fb2b58715b` |
| 插件源码 | `/Users/zhanglong/files/npmprogram/opencode_android_orchestrator` |
| 插件开发基线 | Git `62f9b6aa6569e6392b0e1317bad40c5690ea556b` |
| 正式包名 | `@frankzhang2026/opencode-android-orchestrator` |
| 已发布版本 | `0.1.0`（2026-08-20 的历史空壳包）与 `0.2.0`（2026-08-26 发布的首个可用生命周期版本） |
| 当前发布版本 | `0.2.0`，public，npm `latest` |
| 回滚基线 | `方案备份/` |

> `0.2.0` 已在完整验证、人工复核、明确授权和 npm 浏览器认证后发布。当前工程切换仍是
> 独立授权关口；发布成功也不代表已经批准切换 `cctest`、创建 Git tag 或 GitHub Release。
> Registry 中的 `0.1.0` 仍只是历史空壳版本。

## 一、任务目标

将本工程已经验证的 OpenCode Android 自动编程方案封装成可复用插件包，
让其他 macOS Android 工程通过一条初始化命令完成安装，不再手工复制
Agent、Command、Skill、Shell 脚本、Schema 或配置模板。

计划中的使用方式为：

```bash
npx @frankzhang2026/opencode-android-orchestrator@0.2.0 init .
opencode --agent scheduled-planner .
```

`0.2.0` 已发布；以上固定版本命令现在可作为正式安装方式。当前 `cctest` 工程是否切换到
发布包仍需按第十节单独验收和授权。

## 二、必须满足的结果

1. 同一插件版本支持 OpenCode `1.14.22` 和 `1.15.13`。
2. 以 `@opencode-ai/plugin@1.14.22` 作为最低编译基线，只使用两版公共 API。
3. `init .` 自动安装所有必要的工程内资源，不要求用户手工复制 Shell 脚本。
4. 自动识别 Git 根目录、Gradle Wrapper、Android 模块及 Kotlin/Groovy DSL。
5. 不复制 Android 产品工程，不产生完整工程副本或重复 Gradle 构建目录。
6. 保留当前 V3 的三次 OpenCode 单选确认交互。
7. 保留计划、合同、代码和测试只生成一个正常路径提交的策略。
8. 保留原分支漂移阻断、任务分支安全删除、no-push 和无 launchd 注册约束。
9. 安装、升级和卸载均有文件清单、哈希、冲突保护及恢复方法。
10. 发布前在两个 OpenCode 版本上通过相同的真实集成测试。

## 三、推荐实现形态

采用“npm OpenCode 插件 + 一键初始化 CLI + 工程内可审计资源”的混合结构，
第一版不将已验证的确定性 Shell 事务逻辑重写为 TypeScript。

```text
opencode-android-orchestrator/
├── dist/
│   ├── index.js                 # OpenCode 插件入口
│   └── cli.js                   # init/doctor/upgrade/uninstall
├── src/
│   ├── plugin/                  # 两版共有的插件钩子
│   ├── compatibility/           # OpenCode 版本检查与兼容层
│   ├── installer/               # Android 检测、复制、合并和清单管理
│   └── tools/                   # 首版只读诊断工具，后续可增加脚本包装工具
├── templates/
│   ├── .opencode/agents/
│   ├── .opencode/commands/
│   ├── .opencode/skills/
│   ├── automation/
│   ├── scripts/automation/
│   └── docs/plans/
├── tests/
│   ├── unit/
│   ├── fixtures/android-kts/
│   ├── fixtures/android-groovy/
│   └── compatibility/
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 四、现有资源的迁移方式

| 当前资源 | 插件化处理 |
| --- | --- |
| `.opencode/agents/scheduled-*.md` | 放入插件模板，由 `init` 安装 |
| `.opencode/commands/*.md` | 放入插件模板，由 `init` 安装 |
| `.opencode/skills/scheduled-quality-*` | 放入插件模板，安装到标准 Skill 目录 |
| `scripts/automation/*.sh` | 保持现有实现，由 `init` 自动复制并保留可执行位 |
| `automation/config.json` | 转为 Android 工程自适应模板 |
| 两个 JSON Schema | 原样打包并安装 |
| `TASK-TEMPLATE.json.example` | 原样打包并安装 |
| 历史任务合同和计划 | 不作为新工程模板安装 |
| `.git/automation-runtime/` | 不迁移，仅属于原仓库审计数据 |
| `taskdescriptions/*.html` | 作为开发参考，不作为插件运行依赖 |
| `AGENTS.md` | 只合并带标记的必要片段，禁止覆盖目标工程原文件 |
| `opencode.json` | 结构化合并插件引用，保留目标工程已有配置 |

## 五、一键初始化器职责

`init .` 必须自动完成：

- 检查目标目录是否为 Git Android 工程。
- 检查 OpenCode 版本是否满足兼容要求。
- 检查 `git`、`jq`、`rg`、`shasum`、Java、Gradle Wrapper 和 Android SDK。
- 识别 `settings.gradle`/`settings.gradle.kts` 及 Android 模块。
- 在修改前备份所有可能受影响的少量配置文件。
- 安装 Agent、Command、Skill、Shell 脚本、Schema、配置和模板。
- 对 Shell 脚本恢复可执行权限。
- 合并而不是覆盖 `opencode.json`。
- 固定插件版本，不使用浮动 `latest`。
- 生成 `.automation-plugin/manifest.json`，记录版本、来源和文件 SHA-256。
- 对已有同名但内容不同的文件停止并报告冲突，禁止静默覆盖。
- 自动运行 `doctor`、基础发现检查、自动化测试和 shadow run。
- 输出安装结果、警告、下一步启动命令和回滚入口。

## 六、双版本兼容约束

插件只允许使用 1.14.22 与 1.15.13 共有的能力：

- `PluginInput` 中的 `directory`、`worktree`、`client` 和 `$`；
- `config`；
- `tool`；
- `command.execute.before`；
- `permission.ask`；
- `shell.env`；
- `tool.execute.before` 和 `tool.execute.after`。

第一版禁止依赖：

- 仅在 1.15.13 提供的 `dispose`；
- `experimental_workspace` 及其两版类型命名差异；
- 动态 `skills.paths` 注入；
- 实验性聊天 transform；
- Auth 扩展；
- 未在 1.14.22 实际运行验证的 API。

兼容声明建议：

```json
{
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.14.22 <1.16.0"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "1.14.22"
  }
}
```

包内额外记录“已认证版本”：`1.14.22`、`1.15.13`。低于最低版本时
`init` 必须拒绝；处于声明范围但未经认证的版本只允许在明确警告后继续。

## 七、外部依赖策略

### Superpowers

第一版继续固定使用：

```text
superpowers@git+https://github.com/obra/superpowers.git#v6.2.0
```

由初始化器自动加入配置并检查以下 Skill：

- `brainstorming`
- `writing-plans`
- `test-driven-development`
- `systematic-debugging`
- `verification-before-completion`

是否将这些第三方 Skill 打包进主插件，需要单独完成许可证和升级策略评审；
不作为第一版默认方案。

### opencode-scheduler

当前 V3 正常流程不是定时任务流程，新插件不应依赖或注册
`opencode-scheduler`，也不得创建 macOS launchd 任务。迁移验证通过后，
再单独确认是否从本工程 `opencode.json` 移除旧 Scheduler 引用。

## 八、功能开发待办

- [x] 确定正式 npm 包名、scope、仓库和许可证。
- [x] 建立独立插件源码目录或独立 Git 仓库。
- [x] 建立以 OpenCode 1.14.22 为基线的 TypeScript 工程。
- [x] 实现插件入口和公共 API 兼容层。
- [x] 实现 OpenCode 版本检测与基础 `doctor`（OpenCode、Git、Android、Gradle Wrapper）。
- [x] 实现 Android/Gradle 工程检测。
- [x] 将当前 V3 Agent、Command、Skill、配置、Schema、任务示例、计划说明和 AGENTS 片段转为安装模板。
- [x] 将 28 个自动化 Shell 文件转为安装模板并保持文件权限。
- [x] 将配置中的工程名称、模块名和绝对路径改为动态生成。
- [x] 实现安全的 `opencode.json` JSON/JSONC 合并。
- [x] 实现安装前备份和安装 manifest。
- [x] 实现文件冲突检测，默认不覆盖用户修改。
- [x] 实现 `init`。
- [x] 完善安装态 `doctor`（依赖、资源、权限、配置和 manifest）。
- [x] 实现 `upgrade`，仅升级未被用户修改的受管文件。
- [x] 实现 `uninstall`，只移除哈希仍匹配的受管文件。
- [x] 为只读 `status/doctor` 提供插件自定义工具。
- [x] 评估第二阶段是否将高层脚本入口包装成类型化工具；结论为 `0.2.0 NO-GO`，满足一次性人工授权凭据等准入门槛后再评估。
- [x] 编写 README、迁移指南、故障排查和安全说明。

### 第二阶段类型化工具评估结论（2026-08-25）

**决策：`0.2.0` 不新增任何写入型或状态迁移型自定义工具。** 已验证的 Shell
白名单继续作为审批、编排、集成与中止入口；本结论是当前版本的安全边界，不代表永久
放弃类型化包装。

评估依据：

1. 自定义工具适合提供 Zod 参数 Schema、固定脚本路径和 worktree 上下文，但 OpenCode
   普通工具权限只解决“是否允许调用工具”，不能证明用户刚刚完成了本工作流要求的语义确认。
   `ask` 权限允许本次、会话级 `always`，并可能在 `--auto` 下自动批准，因此不能替代三次
   新鲜 `question` 单选和异常中止确认。
2. 两个目标 SDK 对 `ToolContext.ask` 的声明不一致：`1.14.22` 返回
   `Effect.Effect<void>`，`1.15.13` 返回 `Promise<void>`。该能力不能进入当前只使用双版本
   公共 API 的实现层。
3. 公共 Hook 只有通用、非类型化的 `tool.execute.after` 输出和 metadata，没有稳定的
   `question` 专用结果契约，无法可靠绑定选项、任务、消息和 sealed SHA 并生成一次性授权
   凭据。把固定审批语作为工具参数会使模型能够自行构造它，反而削弱现有确认边界。
4. 候选入口均不只是轻量 Shell 包装：它们会写证据、改变状态、启动子 OpenCode、创建
   提交、切换或删除分支/worktree，必须继续依赖已有锁、租约、哈希和回滚规则。

| 候选入口 | 已确认副作用 | 本次结论 |
| --- | --- | --- |
| `prepare-contract-review.sh` | 写入 proposal/origin 证据并初始化 `CONTRACT_REVIEW` | 暂缓；需要绑定新鲜方案确认的一次性凭据。 |
| `approve-and-run.sh` | 获取仓库租约、创建/切换任务分支或 worktree、启动 Coder/Reviewer | 暂缓；需要合同确认凭据和可取消的长任务执行器。 |
| `show-acceptance-review.sh` | 读取 sealed 证据，但报告缺失或原分支变化时会重写 `acceptance-report.json` | 先拆出纯内存、零写入的 preview；它是未来最早可包装候选。 |
| `resume-review.sh` | 记录恢复证据、执行 `BLOCKED → REVIEWING` 并重新启动 Reviewer | 后续候选；先验证命令级授权、取消和双版本行为。 |
| `accept-and-integrate.sh` | 创建唯一组合提交、快进原分支、移除 worktree、删除任务分支 | 暂缓；必须消费绑定任务、sealed diff、分支和会话的最终验收凭据。 |
| `abort-task.sh` | 归档 diff、可能创建恢复提交、切换/移除 worktree、释放租约 | 暂缓；必须消费同等级的一次性中止凭据。 |

未来重新评估前必须同时满足：

- 先在真实 OpenCode `1.14.22` 与 `1.15.13` 完成现有只读工具兼容矩阵；
- 获得或实现不可由模型伪造的一次性授权凭据，至少绑定 `kind`、`taskId`、`sessionID`、
  `messageID`、相关 sealed SHA/原分支、签发时间和随机 nonce，并在执行时原子消费；
- 工具参数中不得出现可由模型直接填写的 proposal/contract/acceptance/abort 审批语；
- 执行前继续认证安装清单、固定脚本内容和权限，限定 plugin worktree，复核准确前置状态；
- `AbortSignal` 必须真正终止子进程，输出必须限长且结构化，失败保持现有状态与恢复证据；
- 新工具只能对需要它的 Agent 使用精确权限，内部 Coder/Reviewer 状态脚本不得公开；
- 保持 38 项事务回归，并新增权限绕过、重复消费、跨任务/跨会话、sealed SHA 变化、取消、
  超时和中途失败测试。

建议顺序是：先拆分纯只读验收 preview，再评估 Reviewer-only resume，最后才考虑合同执行、
最终集成和中止；任何准入门槛未满足时都维持当前 Shell 入口。

## 九、测试待办

> 2026-08-26 最新验证：`npm run typecheck` 通过，`npm test` 为 120/120
> 通过，V3 Shell 事务回归为 38/38 通过，`npm run pack:check` 通过且预览包含
> 130 个文件；OpenCode `1.15.13` 与 `1.14.22` 的 shadow run 均报告
> `mutationPerformed: false`。真实 tarball 的 SHA-256、安装生命周期、双版本发现结果与
> 清理状态记录在
> [验证报告](../validation/opencode-android-orchestrator-plugin-validation-2026-08-26.md)。包内现已包含
> `docs/MIGRATION.md`、`docs/TROUBLESHOOTING.md` 和 `docs/SECURITY.md`，自动测试会核对
> 文档清单、仓库内链接、固定版本命令、恢复标记、安全边界以及本机路径泄漏。
> `init` 当前会规划并安装 45 个受管文件，覆盖 10 个 OpenCode
> 定义、28 个 Shell 文件、动态配置和任务示例、两个 Schema、计划说明，以及
> `AGENTS.md`/`opencode.json` 的无损合并。安装态 `doctor` 会只读核对命令和 SDK、
> 固定包版本与 45 文件清单、包内模板哈希、受管内容和权限、原文件备份，以及
> OpenCode/AGENTS/Android 自适应配置。安全 `upgrade` 会先拒绝受管文件或原始备份漂移，
> 从首次安装前原文件重建合并结果，保留原始恢复链，保存即时升级快照，恢复或移除废弃
> 资源，并在 38 项事务测试与 shadow run 通过后原子替换 manifest；验证失败会完整恢复旧版。
> 安全 `uninstall` 会先执行只读规划并排除未完成的升级/卸载事务；仅恢复或删除内容、大小和
> 权限仍与 manifest 完全匹配的受管文件，已经恢复或删除的路径保持不变，内容、权限或存在性
> 已漂移的路径原样保留并列出供人工复核。写入前会保存活动 manifest 和所有受影响文件的恢复
> 快照，成功后保存卸载历史并移除活动 manifest，提交前失败会自动恢复完整安装态。
> 插件现已注册 `android_orchestrator_status` 与 `android_orchestrator_doctor`：两者均绑定
> 加载插件时的 worktree；`status` 还会严格校验任务 ID，在执行固定脚本前认证安装清单、
> 受管资源和权限，并限制及核对 JSON 输出。三个 Agent 仅显式放行这两个只读工具，source
> preflight 会检查解析后的权限与工具可发现性。
> 测试已覆盖 Kotlin/Groovy DSL、依赖失败零写入、初始化与同版本升级字节幂等、安装和升级
> 失败自动回滚、内容与权限漂移分离、缺失 manifest、备份丢失、不安全配置、同步改写文件
> 和 manifest 的篡改、同版本资源不可变、未完成升级标记、降级拒绝、JSON 输出与失败退出码、
> Scheduler 与本机路径清理。无 legacy Scheduler 的真实干净工程曾暴露可选工具缺失被误判
> 为不安全的问题；修复后缺失工具按禁用处理，但显式 deny 规则仍为必需，启用工具仍会失败。
> 新候选 tarball 已在该干净临时 Android 基线完成真实 `init`、同版本零写入
> `upgrade`、`uninstall`（恢复 2、删除 43、保留 0）、`re-init`（写入 45）和
> 双版本最终安装态 `doctor`。两个目标 OpenCode 版本已经完成配置、Agent、
> Command、Skill、自定义工具权限、source preflight、38 项事务测试和 shadow 验证。
> OpenCode `1.15.13` 与 `1.14.22` 也已分别完成三次真实单选、真实模型
> Planner/Coder/Reviewer、小型 TDD 任务和单一组合提交闭环；`1.14.22` 的初始不可信请求
> 还包含全部三句伪批准文本，三道关口仍分别等待新的 UI 单选。以上结果仍不等于发布后验收。

### 包和初始化器

- [ ] TypeScript 编译与 lint。
- [x] `npm pack` 内容检查，禁止包含密钥、运行证据和历史任务数据。
- [x] Kotlin DSL Android fixture 初始化测试。
- [x] Groovy DSL Android fixture 初始化测试。
- [x] 多模块 Android 工程检测测试。
- [x] 已存在配置的无损合并测试。
- [x] 同名文件冲突和无静默覆盖测试。
- [x] 重复执行 `init` 的幂等性测试。
- [x] 安装态 `doctor` 健康、篡改、权限、备份、配置和缺失 manifest 测试。
- [x] `upgrade` 保留用户修改测试。
- [x] `uninstall` 安全删除和保留修改文件测试。
- [x] manifest 与 SHA-256 完整性测试。

### OpenCode 兼容矩阵

以下测试必须分别在 `1.14.22` 和 `1.15.13` 执行：

- [x] 插件能够启动且无 API 错误。
- [x] `opencode debug config` 正常。
- [x] `scheduled-planner`、`scheduled-coder`、`scheduled-reviewer` 均可发现。
- [x] `android_orchestrator_status`、`android_orchestrator_doctor` 均可发现且三个 Agent 权限正确。
- [x] `/change`、`/acceptance`、`/resume-review`、`/abort-task` 均可发现。
- [x] 三个本地 Skill 和五个 Superpowers Skill 均可发现。
- [x] 三个 OpenCode 单选确认正常，直接聊天文本不能批准。
- [x] `./scripts/automation/preflight.sh --source` 通过。
- [x] `./scripts/automation/tests/run-tests.sh` 为 `1..38` 全通过。
- [x] `./scripts/automation/shadow-run.sh` 报告 `mutationPerformed: false`。
- [x] 在临时 Android 工程完成一项真实的小型任务闭环。
- [x] 最终只有一个包含计划、合同、代码和测试的组合提交。
- [x] 原分支漂移能够阻断集成。
- [x] 成功集成后任务本地分支被删除。
- [x] 没有 Git push。
- [x] 没有 launchd 注册。
- [x] 没有整个工程复制或额外候选 worktree。

## 十、本工程切换待办

- [ ] 在临时工程完成全部测试前，不修改本工程现有方案。
- [ ] 使用本地 `npm pack` 产物在本工程进行影子接入。
- [ ] 影子阶段保留旧 Agent、Command、Skill 和 Shell 脚本。
- [ ] 对比插件安装结果与 `方案备份/snapshot/repository/`。
- [ ] 展示完整 Git diff、测试结果和回滚路径供人工复核。
- [ ] 经人工确认后，在单独提交中切换 `opencode.json`。
- [ ] 插件连续验证成功前，不删除旧方案资源。
- [ ] 如发生异常，按 `方案备份/恢复说明.md` 恢复。

## 十一、发布准备待办

- [x] 核对 npm Registry 状态：正式包名已存在，`0.1.0` 为早期空壳版本。
- [x] 确认后续版本继续使用 public 发布方式。
- [x] 确认 npm scope 和发布账号权限（`npm whoami` 为 `frankzhang2026`，
  Registry owner 为 `frankzhang2026`，当前只存在 `0.1.0`；发布时采用的 2FA 或
  trusted-publishing 方式仍需在最终外部操作前确认）。
- [x] 确认许可证和第三方声明：项目使用 MIT，用户已于 2026-08-26 明确确认版权标识为 `frankzhang2026`；`jsonc-parser`、OpenCode peer API、外部 Superpowers 和开发依赖的范围及许可证已记录。
- [x] 确认发布版本为 `0.2.0`；没有覆盖已发布的 `0.1.0`。
- [x] 生成并人工检查 npm tarball（修复 clean-project preflight 后的新候选已完成
  自动审计，SHA-256 为
  `9c1b326bc2ecf9f28d1a4a9d723ee1b44acdb912f101f17b21dc07449c916bdc`；
  用户已在发布前确认对这个精确哈希完成人工复核）。
- [x] 生成 CHANGELOG 和 release notes。
- [x] 确认包内没有本机绝对路径、任务日志、密钥或历史运行证据。
- [x] 在干净环境从 tarball 完成一次全新安装。
- [x] 对同一新 tarball 完成 `upgrade → doctor → uninstall → re-init`，并在
  OpenCode `1.14.22` 与 `1.15.13` 下完成最终安装态 doctor。
- [x] 保存两个 OpenCode 版本的最终测试证据。
- [x] 展示发布命令、目标 registry、包名、版本及可见性；命令仅记录在 fail-closed 授权单中，未执行。

## 十二、发布授权关口

正式发布是独立的外部变更，必须在下列信息全部明确后再次取得人工确认：

- 正式包名和 scope；
- 版本号；
- public 或 private；
- npm registry；
- Git 仓库地址；
- 许可证；
- npm 登录状态或安全发布凭证；
- 2FA 处理方式；
- 最终 tarball SHA-256；
- 1.14.22 和 1.15.13 的测试结论。

未经该次明确确认，不得执行 `npm publish`、创建远端仓库、推送 tag 或生成
公开 release。不得把 npm token、2FA 信息或其他凭证写入仓库和日志。

已有 `0.1.0` 的发布事实只作为历史状态记录；任何 `0.2.0` 或后续版本的
发布仍必须重新通过本节授权关口。

### 2026-08-26 发布授权准备记录

- 授权单：插件源码仓库 `release/0.2.0-authorization.md`，当前明确标记
  `PUBLISHED` 并记录发布后 Registry 验证结果。
- 候选 tarball：`frankzhang2026-opencode-android-orchestrator-0.2.0.tgz`，
  170,710 bytes，解包 825,403 bytes，SHA-256
  `9c1b326bc2ecf9f28d1a4a9d723ee1b44acdb912f101f17b21dc07449c916bdc`。
- npm 清单共 130 个文件；`LICENSE` 和 `THIRD_PARTY_NOTICES.md` 已包含且与
  源码逐字节一致；`release/`、`tests/`、`src/` 和 `node_modules/` 未打包；
  本机路径和常见凭据模式扫描通过。
- 正式参数已固定为包 `@frankzhang2026/opencode-android-orchestrator`、版本
  `0.2.0`、public、Registry `https://registry.npmjs.org/`、MIT、仓库
  `https://github.com/frankzhangtx/npm-orchestrator-plugin`。
- 用户已于 2026-08-26 明确确认 MIT `LICENSE` 中继续使用 `frankzhang2026`
  作为版权标识；该确认不构成 npm 发布、Git push、tag 或公开 Release 授权。
- 插件全部 package inputs 已提交为
  `fde90868e3defb7a94e989a6953c99a7d91e8896` 并通过普通非强制 push 到
  `origin/main`；SSH 写权限已经验证，push 后插件工作区干净。
- npm 发布时登录用户及 Registry owner 均为 `frankzhang2026`；`0.2.0` 已公开发布，
  `latest` 指向 `0.2.0`。
- OpenCode `1.15.13` 会话 `ses_fc3458801ffe83fX91SmxYEUSo` 完成
  `TASK-WORKTAB-ALIAS`，由 `b423322` 单提交集成为 `680e88e`；
  OpenCode `1.14.22` 会话 `ses_fc2153a56ffem8xq4IDAaOYYZf` 完成
  `TASK-FAMILY-CENTER-HOME`，由 `680e88e` 单提交集成为 `842b6dc`。
  两轮均删除任务分支并记录 `pushed: false`。
- 新 tarball 的同版本 `upgrade` 复用 45 个文件且写入 0；`uninstall` 恢复 2、
  删除 43、保留 0；`re-init` 写入 45 个文件并生成安装 ID
  `20260826122353784-a2d0d0a0-399a-483a-9e06-07cfaf2c697e`。随后两版最终
  doctor 均通过，临时验证分支保持干净并停在 `842b6dc`，未 push。
- 用户确认精确 artifact 与参数后，npm CLI 通过官方浏览器认证完成发布；Registry
  回下载文件与获批 tarball 字节一致，固定版本 CLI 在两版 OpenCode 下 doctor 通过。
  当前剩余项是两台目标环境的发布后完整验收和另行授权的 `cctest` 方案切换。

## 十三、发布后待办

- [x] 从 npm registry 安装刚发布的固定版本，而不是本地源码。
- [ ] 在本机 OpenCode 1.15.13 完成安装与完整回归。
- [ ] 在目标电脑 OpenCode 1.14.22 完成安装与完整回归。
- [ ] 验证目标 Android 工程无需手动复制任何 Shell 脚本。
- [x] 验证 Registry CLI 的 `doctor` 能在 OpenCode `1.14.22` 与 `1.15.13` 报告
  版本、45 个资源、28 个可执行脚本、备份、权限和配置状态。
- [ ] 验证升级和卸载不会破坏用户修改。
- [ ] 根据真实安装结果决定是否切换当前工程。
- [ ] 如发现严重问题，停止推广并发布修复版本或执行回滚，不覆盖原版本内容。

## 十四、明确不在本任务中的事项

- 不修改 Android 产品功能代码。
- 不把每个 Android 工程整体复制到插件工作区。
- 不把历史任务合同、计划或 `.git/automation-runtime` 安装到新工程。
- 不自动注册 Scheduler 或 launchd。
- 不自动 push、merge、rebase 或解决原分支漂移。
- 不在第一版重写已验证的 Git、状态机和质量门 Shell 实现。
- 不在用户确认前删除本工程旧方案资源。
- 后续任何版本仍不得在用户确认前执行真实 npm 发布；`0.2.0` 已严格经过该确认。

## 十五、完成定义

只有同时满足以下条件，任务才能标记为完成：

1. 插件源码、CLI、模板、文档和许可证齐全。
2. `init` 能在一个新的 Android 工程中一键安装全部必要资源。
3. 用户不需要手工复制 `scripts/automation/` 或其他方案文件。
4. OpenCode 1.14.22 与 1.15.13 的兼容矩阵全部通过。
5. 当前 38 项自动化测试保持全绿，并新增插件安装生命周期测试。
6. 安装、升级、卸载和失败回滚均经过实际验证。
7. npm tarball 经人工检查并记录摘要。
8. 用户明确批准正式发布。
9. npm 发布成功且可按固定版本重新安装。
10. 本机和目标电脑分别从已发布包完成最终验收。

## 十六、已确认的启动决策

以下启动决策已经确认：

1. 正式包名为 `@frankzhang2026/opencode-android-orchestrator`。
2. 使用独立 Git 仓库 `frankzhangtx/npm-orchestrator-plugin`。
3. 使用 public 发布方式。
4. 许可证选择 MIT；实际 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和包元数据已完成，
   版权标识采用已验证的 npm 发布者 `frankzhang2026`。
5. Superpowers 继续作为固定伴随依赖，不内置到第一版。
6. 第一版插件工具只提供只读诊断，事务入口继续使用现有 Shell 白名单。

上述决策已使任务进入 `IN_PROGRESS`；安全受管文件写入、`init`、安装失败自动回滚、
安装态 `doctor`、安全 `upgrade`、安全 `uninstall` 和只读 `status/doctor` 自定义工具
已经完成。第二阶段写入型工具评估也已完成，结论是 `0.2.0 NO-GO`；README、迁移指南、
故障排查和安全说明均已补齐并纳入 npm 包。真实 tarball 安装生命周期以及 OpenCode
`1.15.13`/`1.14.22` 的非交互兼容矩阵已通过。MIT `LICENSE`、第三方声明、release notes、
含许可证的新候选 tarball 及 fail-closed 发布授权单也已完成。无 legacy Scheduler 的干净
工程误判已经修复，新候选完成真实 `init`、同版本 `upgrade`、`uninstall`、`re-init`
与双版本最终安装态 `doctor`；两版三次真实
OpenCode 单选和真实模型小任务闭环也已完成。用户随后人工复核精确 SHA-256 并明确授权，
npm CLI 官方浏览器认证成功，`0.2.0` 已公开发布；Registry 回下载字节一致，固定版本 CLI
的双版本 doctor 通过。当前下一阶段是两台目标环境的发布后完整验收；仍不得据此自动执行
当前工程切换、Git tag 或 GitHub Release。
