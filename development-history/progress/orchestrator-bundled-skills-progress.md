# Orchestrator 内置工作流技能改造进度

更新时间：2026-09-07

目标：把 Orchestrator 实际使用的 Superpowers v6.2.0 工作流内容裁剪、命名空间化并随 npm 包发布，移除运行期 GitHub/Superpowers 插件依赖，同时取消 `brainstorming` 的本地浏览器服务。

## 执行步骤

- [x] 步骤 1：冻结当前依赖面，确认外部插件引用、Skill 调用、配套资源和升级影响。
- [x] 步骤 2：新增包内 `android-orchestrator-*` 技能及必要引用文件，保留 MIT 来源声明。
- [x] 步骤 3：让 Orchestrator 插件通过 `config` hook 注册包内 Skill 目录。
- [x] 步骤 4：更新 Agent、自动化配置和合同 schema，移除 `using-superpowers`、外部 Superpowers 引用及遗留字段。
- [x] 步骤 5：更新安装、升级、卸载和 doctor 逻辑；升级时只删除旧版 Orchestrator 管理的固定 Superpowers 引用。
- [x] 步骤 6：更新文档、第三方声明、版本和变更记录。
- [x] 步骤 7：补齐/更新单元测试、模板测试、离线发现测试及 npm 打包内容测试。
- [x] 步骤 8：运行构建、完整测试、模板脚本测试和 `npm pack --dry-run`，记录结果。

## 已确认事实

- Orchestrator 0.7.0 在 `opencode.json(c)` 中强制加入 `superpowers@git+https://github.com/obra/superpowers.git#v6.2.0`。
- 运行流程实际依赖 5 个上游技能：brainstorming、writing-plans、test-driven-development、systematic-debugging、verification-before-completion。
- 原版 brainstorming 包含 `127.0.0.1` 本地服务、自动打开浏览器及远程品牌图片；本改造不携带该功能。
- 原版 writing-plans 引用未纳入 Orchestrator 的执行技能，并使用不兼容的计划路径；需要改写为 Orchestrator 合同工作流。
- Superpowers v6.2.0 使用 MIT 许可证；再分发版本必须保留版权和许可文本。

## 当前状态

改造和验证已经完成，源码位于
`/Users/zhanglong/files/npmprogram/opencode_android_orchestrator` 的 `main` 分支。
实现提交 `93e2037` 和发布准备提交 `2e489a2` 已推送到 `origin/main`。
`@frankzhang2026/opencode-android-orchestrator@0.8.0` 已发布到公共 npm
Registry，`latest` 已指向 `0.8.0`。

## 完成内容

- npm 包版本更新为 `0.8.0`，并发布 5 个 `android-orchestrator-*` 命名空间技能及其最小运行期资源。
- 插件启动时校验内置技能文件，并通过 OpenCode `config` hook 幂等注册包内技能目录。
- 新安装不再写入外部 Superpowers GitHub 插件；升级会移除旧安装所管理的固定引用，但保留安装前已经存在的用户引用。
- 自动化配置升级到 V4、任务合同升级到 V2；验证脚本继续兼容已有 V1 合同。
- 移除了 `using-superpowers` 引导依赖以及 brainstorming 的浏览器、本地服务、远程图片和网络运行期依赖。
- README、迁移、安全、故障排查、变更记录、第三方许可和测试说明均已同步。

## 最终验证（2026-09-07）

- `npm run typecheck`：通过。
- `npm test`：149/149 通过（包含构建、包内技能、升级所有权和发布内容测试）。
- `./templates/scripts/automation/tests/run-tests.sh`：44/44 通过。
- `npm run test:offline-discovery`：1/1 通过；隔离环境中的 OpenCode 无外部插件、无网络发现全部 5 个内置技能。
- `npm run pack:check`：通过；0.8.0 包含 157 个文件，压缩后 228.7 kB、解包后 1.0 MB，13 个内置技能资源文件全部进入 tarball。
- `git diff --check`：通过。
- npm 发布后验证：Registry 发布时间为 `2026-09-07T06:26:46.550Z`，
  SHA-1 为 `6251a0a2418c84f5d82a0ac822d6dd3130bee386`；重新下载的固定版本
  tarball 与本地候选包字节一致，SHA-256 均为
  `ee3adf0a9abd01e060f8a8c370fb98fbc0fc9bb74aa662551e8f99100dc27740`。

## 0.8.1 升级兼容修复（已发布）

- `upgrade` 不再因为活动 manifest、托管文件或原始备份的 Unix 权限位与
  manifest 记录不同而拒绝执行；内容、存在性、常规文件、符号链接、
  SHA-256/大小、并发修改和事务回滚检查仍然保留。
- `AGENTS.md` 升级时保留旧管理标记区块外的当前内容，只替换
  Orchestrator 管理区块；若两个标记都已移除，则保留整个当前文件后再
  加入新管理区块。保留内容会进入新的卸载备份链路。
- 失败升级会精确恢复升级前的文件内容和实际权限。
- 包版本和文档已准备为 `0.8.1`；提交
  `23533f42d67425dccfc6dc6b214a02e7d4501f3c` 及发布准备提交
  `89b80071b1b80039288c098aac0f3c64d5511c2f` 已推送到
  `origin/main`。
- 当前验证：`npm test` 154/154、Shell 生命周期测试 44/44、离线技能
  发现 1/1、`npm run pack:check` 和 `git diff --check` 均通过；dry-run
  包含 157 个文件，压缩后 231.4 kB、解包后 1.1 MB。
- `@frankzhang2026/opencode-android-orchestrator@0.8.1` 已于
  `2026-09-07T10:42:55.214Z` 发布到公共 npm Registry，`latest` 已指向
  `0.8.1`。Registry SHA-1 为
  `f5608140244f0c62fb7be67dfc508c406ffffe4d`，重新下载的固定版本与本地
  候选包字节一致，SHA-256 均为
  `1f8337fa97acb9b2241743032e8051b88152e50f51247e60e9085dac956a567e`。
