# WordPress Android 工程接入 OpenCode Android Orchestrator

## 1. 当前结论

- 目标工程：`/Users/zhanglong/files/program/wordpresslocal/WordPress`
- 插件源码：`/Users/zhanglong/files/npmprogram/opencode_android_orchestrator`
- Android 主应用模块：`:WordPress`
- WordPress 工作分支：`feature-0602-cases-opencode-test`
- WordPress 当前安装：`0.6.0` manifest 状态为 `installed`，45 个受管文件与 28 个可执行脚本均通过
  固定 `0.6.0` doctor；安装提交为 `7bff3ee`，本地分支领先同名远程分支 1 个提交。
- 历史问题（`0.4.0` 及以前）：只使用通用 `testDebugUnitTest` 与
  `connectedDebugAndroidTest` 会漏掉 `:WordPress` 的 flavor 任务；旧接入方案又要求从
  另一个工程传入绝对路径 JSON，把项目知识泄漏到了插件使用步骤中。
- `0.5.0` 修复：`init .` 会通过一次仅配置型 Gradle 调用自动发现真实任务并生成
  `gradleVerification`；focused test 合同仍同时记录 `gradleTask` 和 `filter`。
- `0.6.0` 修复：临时任务发现调用固定增加 `--no-configuration-cache`，避免配置缓存命中时
  跳过 init script 的 `projectsEvaluated` 回调并误报空矩阵；项目文件和正常构建缓存行为不变。
- `0.6.1` 修复：受管长命令默认获得 30 分钟超时且不会缩短调用方更大的值；新增一次性
  `/resume-task` 基线中断恢复，并用引用、HEAD、租约、规划哈希、零业务改动和下游证据缺失等
  条件限制恢复边界。
- 发布状态：`0.6.1` 已于 2026-09-01 公开发布，npm `latest` 当前指向 `0.6.1`；正式接入仍
  固定写出 `@0.6.1`，不使用浮动 tag。
- 验证状态：发布候选 Node 测试 `138/138`、Shell 事务测试 `44/44` 均已通过；`0.5.0` 新发现器
  已在真实 WordPress 工程得到预期矩阵，`0.6.0` 有配置缓存回归测试，`0.6.1` 增加长命令超时和
  基线恢复边界测试。发布证据入库后新增 1 项元数据测试，当前源码套件为 `139/139`。
- 隔离生命周期：`init → doctor → preflight → shadow → upgrade → uninstall` 已在临时 Android
  fixture 中通过；`0.6.1` 的 `init` 与 doctor 使用 47 个受管文件，Shell 清单包含 29 个可执行脚本。

> `0.6.1` 的候选源码提交为 `9fa54d3`，发布恢复证据提交为 `c961ba6`，升级顺序复核与勘误证据
> 提交为 `0b370cd`。两个独立干净 checkout 的重建包与 Registry 固定版本回下载包逐字节一致，SHA-256 为
> `3840549bddb2027ea84993fb0664365e24c1925f8f0a8ee1b5253e0091ff6d93`。正式接入直接使用
> 固定版本 `@0.6.1`；不要使用旧版本、浮动 `latest` 或来源不明的本地 tarball。

本次方案不改变 Agent 权限文件。自动质量证据必须通过受管脚本产生，不能把 Agent 直接执行的
通用 Gradle 命令当成 WordPress 应用 flavor 已覆盖的证明。

## 2. 已确认的工程状态

| 检查项 | 当前结果 |
| --- | --- |
| WordPress Git 状态 | 工作树干净；当前安装提交 `7bff3ee` 尚使本地分支领先同名远程分支 1 个提交 |
| OpenCode | `1.15.13`，位于插件支持范围 `>=1.14.22 <1.16.0` |
| Node.js / npm | `v24.14.0` / `11.11.0` |
| Java | OpenJDK `21.0.11` |
| Android 工程 | Groovy DSL，检测到 8 个真实 Android 模块（1 个应用、7 个库） |
| Gradle Configuration Cache | `gradle.properties` 已启用；`0.6.1` 保留仅对临时发现调用禁用缓存的边界，正常构建不变 |
| 受管长命令超时 | 当前 `0.6.0` 无此字段；升级到 `0.6.1` 后默认 `1800000` ms，可在 `120000`–`7200000` ms 内显式配置 |
| 主模块检测 | 已修复 `.apply(false)` 误判；自动识别唯一应用模块 `:WordPress` |
| 已验证应用单元测试任务 | `:WordPress:testWordpressDebugUnitTest` |
| 已验证应用设备测试任务 | `:WordPress:connectedWordpressDebugAndroidTest` |
| `assembleDebug` | 包含 WordPress 应用与库模块的 Debug 构建 |
| `lint` | 包含 WordPress 应用与库模块；应用侧按默认 lint 入口执行 |
| 当前安装健康度 | 固定 `0.6.0` doctor 为 `ok: true`；45 个受管文件、28 个可执行脚本与 1 个原文件备份均一致 |
| npm Registry | `0.6.1` 已公开发布，`latest` 指向 `0.6.1` |
| 插件安装状态 | WordPress 已安装健康的 `0.6.0`；当前应先用 `0.6.0` doctor，再执行固定 `0.6.1` upgrade |

## 3. 修复后的执行模型

质量门不再由四个脚本各自硬编码任务，也不要求用户预先编写 JSON。初始化链路为：

```text
init .
  │
  ├── 静态检测 Git / settings / Android 模块
  ├── 临时 0600 Gradle init script + `gradlew help --no-configuration-cache`
  ├── 只接收带固定 marker 的已注册任务路径
  ├── 自动生成 gradleVerification
  └── 进入原有安装事务、Shell 测试与 shadow-run
```

运行期质量门统一读取生成后的：

```text
automation/config.json
        │
        ├── fullUnitTestTasks ──> baseline / 完整单元测试
        ├── focusedTestTasks ───> 合同允许的聚焦测试任务
        ├── assembleTasks ──────> Debug 构建
        ├── lintTasks ──────────> Android lint
        └── deviceTestTasks ────> 合同要求时执行设备测试
```

对应执行链路：

- OpenCode `tool.execute.before`：只匹配受管长命令，把有效超时提高到至少
  `longCommandTimeoutMs`（默认 `1800000` ms），不缩短更大的调用方超时，也不影响无关命令。
- `claim-task.sh`：运行 `fullUnitTestTasks`，记录 baseline 命令数组。
- `record-red.sh`：从合同中找到 `{ gradleTask, filter }`，记录真实 RED。
- `verify-task.sh`：执行 focused、完整单测、构建、lint，以及可选设备测试。
- `verify-integration.sh`：在集成候选上重复同一矩阵。
- `validate-contract.sh`：拒绝未列入 `focusedTestTasks` 的合同任务。
- `lib.sh`：校验任务字符并使用参数数组调用 `./gradlew`，不使用 `eval`。
- `resume-task.sh`：只允许一次经明确批准的 baseline-only 恢复；已有业务改动、baseline 或下游证据时
  一律拒绝，不能作为一般重试入口。

## 4. WordPress 自动发现结果

不再需要 WordPress 专用配置文件。下列矩阵最初由 `0.5.0` 在真实工程中自动生成；`0.6.0`
让启用 Configuration Cache 的工程能够稳定重复执行发现，`0.6.1` 继续保留同一推导与缓存边界：

```json
{
  "fullUnitTestTasks": [
    "testDebugUnitTest",
    ":WordPress:testWordpressDebugUnitTest",
    ":WordPress:testJetpackDebugUnitTest"
  ],
  "focusedTestTasks": [
    ":WordPress:testWordpressDebugUnitTest",
    ":WordPress:testJetpackDebugUnitTest",
    ":libs:analytics:testDebugUnitTest",
    ":libs:editor:testDebugUnitTest",
    ":libs:fluxc:testDebugUnitTest",
    ":libs:image-editor:testDebugUnitTest",
    ":libs:mocks:testDebugUnitTest",
    ":libs:networking:testDebugUnitTest",
    ":libs:posttypes:testDebugUnitTest"
  ],
  "assembleTasks": [
    "assembleDebug"
  ],
  "lintTasks": [
    "lint"
  ],
  "deviceTestTasks": [
    "connectedDebugAndroidTest",
    ":WordPress:connectedWordpressDebugAndroidTest",
    ":WordPress:connectedJetpackDebugAndroidTest"
  ]
}
```

生成规则：

- 同名无 flavor 任务折叠成 `testDebugUnitTest`、`assembleDebug`、`lint` 和
  `connectedDebugAndroidTest` 选择器，覆盖普通 Android 库模块。
- flavor 单元测试和设备测试保留精确模块路径，避免再次漏掉应用变体。
- `:WordPress` 是唯一应用模块；其名称与 `wordpressDebug` 匹配，因此 WordPress flavor
  排在 focused task 示例首位。
- 全量验证保留所有已发现 Debug flavor；插件不会暗中选择一个 flavor 而漏掉另一个。
- `--gradle-verification-config` 仍可作为非标准企业策略的显式覆盖，但不属于普通安装步骤；
  覆盖文件应放在目标工程内并提交审核，不能引用另一台机器或另一个仓库的绝对路径。

## 5. 新任务合同格式

`targetTests` 不再是过滤器字符串数组。每个测试必须同时声明 Gradle 任务和过滤器：

```json
{
  "targetTests": [
    {
      "gradleTask": ":WordPress:testWordpressDebugUnitTest",
      "filter": "org.wordpress.android.ExampleTest.exampleBehavior"
    }
  ],
  "deviceTestsRequired": false
}
```

合同中的 `gradleTask` 必须存在于
`automation/config.json` 的 `gradleVerification.focusedTestTasks` 中，否则合同校验直接失败。

## 6. `0.6.1` 发布与审计基线

`0.6.1` 已完成发布与发布后恢复验证，WordPress 正式接入不需要再从插件源码构建 tarball。固定
信息如下：

| 项目 | 已验证值 |
| --- | --- |
| 候选源码提交 | `9fa54d36767ff28e8ce790751d1b39f20e067665` |
| 发布恢复证据提交 | `c961ba6e9cbe5ab561543ec949141d31295accfc` |
| 升级复核与勘误提交 | `0b370cd9c29eaea19fb2471c4ed2987e241744d9` |
| 包名与版本 | `@frankzhang2026/opencode-android-orchestrator@0.6.1` |
| 可见性与 Registry | public，`https://registry.npmjs.org/` |
| SHA-256 | `3840549bddb2027ea84993fb0664365e24c1925f8f0a8ee1b5253e0091ff6d93` |
| npm SHA-1 | `dfc08e4808901998f4758ba03e5e5f1341619a05` |
| npm integrity | `sha512-LOUbfPx7WzXqHX3iGqQyRpo5xvrBX/5oQ/GlS1qCQAEOexG3i8Fm//g7dt4AnhX5rubx0qQlNRlTHWiSXDQpAg==` |
| 包内容 | 140 个文件；199,067 bytes 压缩，961,026 bytes 解包 |

候选门禁与发布后恢复验证执行并通过了：

```bash
cd /Users/zhanglong/files/npmprogram/opencode_android_orchestrator

npm run typecheck
npm test
./templates/scripts/automation/tests/run-tests.sh
npm run pack:check
```

预期结果：

- TypeScript 编译与类型检查成功。
- 发布候选 Node 测试显示 `138` 个测试全部通过；发布证据测试加入后当前为 `139/139`。
- Shell 测试以 `1..44` 结束。
- `npm pack --dry-run` 只包含允许发布的 `dist/`、`docs/`、`templates/` 和包级文件。
- 两次独立打包字节一致；固定版本 Registry 回下载也与候选包逐字节一致。
- 分别固定 `@opencode-ai/plugin@1.14.22` 与 `@1.15.13` 的两个全新 consumer 均通过插件入口、
  公开 API、CLI help 和生产依赖审计，漏洞数为 `0`。

需要只读复核 Registry 元数据时执行：

```bash
npm view @frankzhang2026/opencode-android-orchestrator@0.6.1 \
  version dist.shasum dist.integrity dist.fileCount dist.unpackedSize
```

以上命令应报告版本 `0.6.1`、npm SHA-1
`dfc08e4808901998f4758ba03e5e5f1341619a05`、140 个文件和 961,026 bytes 解包大小。
WordPress 安装仍使用下一节的固定版本 `npx` 命令，不使用插件源码目录或本地 tarball。

发布恢复时 Registry 已存在 `0.6.1`，因此没有重复运行 `npm publish`。不可变的发布包有两项已知文档
勘误：`CHANGELOG.md` 标题仍写作 `0.6.1 - Unreleased`；`docs/MIGRATION.md` 又把目标版本 doctor 错放在
旧安装升级之前。功能、版本元数据和制品哈希均正确，实际顺序必须是“已安装版本 doctor → 目标版本
upgrade → 目标版本 doctor”。为保持候选提交可逐字节重建发布包，本版本不再修改进入 tarball 的文件；
正确发布状态与升级顺序记录在插件仓库的 `release/0.6.1-release-notes.md`、
`release/0.6.1-authorization.md` 以及提交 `0b370cd` 中。

## 7. 正式安装前保护现场

```bash
cd /Users/zhanglong/files/program/wordpresslocal/WordPress
git rev-parse --show-toplevel
git status --short --branch
```

当前应看到工作树干净，但分支比远端领先 1 个安装提交。不要为了升级重新执行首次安装，也不要在
没有确认远端策略时自动 push 该提交。升级前记录当前基线：

```bash
git log -1 --oneline
git rev-parse HEAD
```

`.automation-plugin/` 保存 manifest、原文件备份和事务恢复证据，不应提交。当前工程已经通过
`.git/info/exclude` 第 8 行忽略该目录；升级前只需验证，不要重复追加规则：

```bash
git check-ignore -v .automation-plugin/manifest.json
```

预期同时满足：`git status --short` 无输出、当前提交为 `7bff3ee`、manifest 包版本为 `0.6.0` 且
`installation.state` 为 `installed`。任一项不符合时先停下调查，不能让升级覆盖未知状态。

## 8. 使用修复版执行 upgrade

WordPress 当前已经是健康的 `0.6.0` manifest-managed 安装，不能再次执行 `init`。升级前 doctor
必须与当前 manifest 的版本一致；随后由目标版本执行 upgrade，最后再用目标版本 doctor：

```bash
cd /Users/zhanglong/files/program/wordpresslocal/WordPress

npx --yes @frankzhang2026/opencode-android-orchestrator@0.6.0 \
  doctor . --json

npx --yes @frankzhang2026/opencode-android-orchestrator@0.6.1 \
  upgrade . \
  --json

npx --yes @frankzhang2026/opencode-android-orchestrator@0.6.1 \
  doctor . --json
```

不要在升级前运行 `0.6.1 doctor` 并要求其通过。doctor 会认证执行它的包版本和精确目标清单，
因此它在 `0.6.0` 的 45 文件 manifest 上会正确报告版本、47 文件目标、模板、插件引用和缺失超时字段
不匹配；这不代表原 `0.6.0` 安装损坏。固定 `0.6.0 doctor` 已于 2026-09-02 返回 `ok: true`。

同一份已发布 `0.6.1` 已在 WordPress 当前提交的一次性克隆中完成真实升级验证，结果为：

- `fromVersion: 0.6.0`，`toVersion: 0.6.1`，`status: upgraded`。
- 受管文件从 45 增至 47；写入 10 个、复用 37 个、恢复或移除 0 个，无清理警告。
- 新增 `.opencode/commands/resume-task.md` 与 `scripts/automation/resume-task.sh`。
- 保留 `moduleScope: all`、`:WordPress` 主模块和原有完整 Gradle 验证矩阵。
- 为旧配置补入 `longCommandTimeoutMs: 1800000`，并把 `opencode.json` 固定引用更新为 `@0.6.1`。
- 事务内 44 项 Shell 测试与 shadow-run 通过，随后 `0.6.1 doctor` 对 47 个文件、29 个可执行脚本和
  1 个原文件备份全部认证通过。

只有明确需要改变默认超时时，才在 upgrade 命令增加
`--long-command-timeout-ms <120000-7200000>`；不要直接编辑受管的 `automation/config.json`。
升级默认保留现有自动发现矩阵，不会再次运行 Gradle 发现，也不需要 WordPress 专用 JSON。

## 9. 升级后核对

首先检查升级后的配置与固定引用：

```bash
test -f .automation-worktree-allowlist
jq '.androidProject.primaryModule, .longCommandTimeoutMs, .gradleVerification' automation/config.json
jq '.targetTests' automation/tasks/TASK-TEMPLATE.json.example
jq '.plugin' opencode.json
```

必须看到：

```text
":WordPress"
1800000
:WordPress:testWordpressDebugUnitTest
:WordPress:testJetpackDebugUnitTest
:WordPress:connectedWordpressDebugAndroidTest
:WordPress:connectedJetpackDebugAndroidTest
:libs:networking:testDebugUnitTest
```

随后执行诊断与只读验证：

```bash
npx --yes @frankzhang2026/opencode-android-orchestrator@0.6.1 \
  doctor . --json

./scripts/automation/tests/run-tests.sh
./scripts/automation/shadow-run.sh
```

预期：

- `doctor` 返回退出码 `0`，结果包含 `"ok": true`。
- Shell 测试以 `1..44` 结束。
- shadow 输出包含 `"mutationPerformed": false`。
- `opencode.json` 的其他配置和项目 Skill 路径仍然存在，插件引用只从 `@0.6.0` 变为 `@0.6.1`。
- `git status --short` 显示 8 个受管文件修改与 2 个新增恢复文件，不显示被忽略的 `.automation-plugin/`。

`upgrade` 本身会在事务提交前运行 Shell 测试与 shadow-run。严格的 `preflight.sh --source` 会故意
拒绝脏工作树，因此先人工审核这 10 个升级文件，再提交升级差异；不要把其他本地改动混入：

```bash
git status --short
git diff --stat
git add --all
git commit -m "Upgrade OpenCode Android Orchestrator to 0.6.1"
```

确认提交后工作树干净，再执行：

```bash
./scripts/automation/preflight.sh --source
```

在受限执行器中验证时，OpenCode 还需要写入用户级 SQLite 与缓存。如果执行器只允许写项目目录，
`opencode debug config` 可能以 `PRAGMA wal_checkpoint(PASSIVE)` 失败；应为该只读发现命令提供正常的
用户数据目录写权限，不能把这种环境错误当成项目配置错误。

## 10. 独立核对 Gradle 矩阵

在开始真实任务前，按矩阵逐项人工核对一次：

```bash
./gradlew testDebugUnitTest \
  :WordPress:testWordpressDebugUnitTest \
  :WordPress:testJetpackDebugUnitTest

./gradlew :WordPress:testWordpressDebugUnitTest \
  --tests 'org.wordpress.android.ExampleTest.exampleBehavior'

./gradlew assembleDebug
./gradlew lint
```

只有合同将 `deviceTestsRequired` 设为 `true` 时，自动质量门才执行：

```bash
./gradlew \
  connectedDebugAndroidTest \
  :WordPress:connectedWordpressDebugAndroidTest \
  :WordPress:connectedJetpackDebugAndroidTest
```

设备测试需要已连接设备或可用模拟器。没有设备时必须保持合同为 `false`，不能伪造通过证据。

## 11. upgrade 与 uninstall

升级器默认保留首次 `init` 自动发现并安装的 `gradleVerification`，不再重复引用外部文件：

```bash
npx --yes @frankzhang2026/opencode-android-orchestrator@<新固定版本> \
  upgrade . \
  --json
```

升级后重新执行 `doctor`、Shell 测试和 shadow-run。如果项目新增或删除了 flavor，应在升级前先用
新版本在临时干净 checkout 中执行首次 `init` 来核对自动发现矩阵，并把“是否刷新既有策略”作为
独立审核项，不能悄悄覆盖。`upgrade` 默认保留旧安装的矩阵，不会因为升级到 `0.6.1` 自动刷新；
如果旧矩阵漏掉 flavor，必须使用经审核的工程内覆盖文件，或先安全卸载再重新 `init`。当前 WordPress
正是健康 `0.6.0` 到 `0.6.1` 的升级场景，已经在一次性克隆中证明现有矩阵会完整保留。

升级到 `0.6.1` 时，已有合法 `longCommandTimeoutMs` 会保留；`0.6.1` 以前的安装没有该字段时写入
默认 `1800000` ms。需要改值时使用受审核的 `--long-command-timeout-ms`，不要直接编辑受管配置。

安全卸载：

```bash
npx --yes @frankzhang2026/opencode-android-orchestrator@<已安装版本> \
  uninstall . \
  --json
```

不要手工删除 `.automation-plugin/`、修改 manifest 哈希、运行 `git reset --hard` 或使用
`git clean` 绕过事务错误。

2026-08-28 的历史隔离验证基于当时的 45 文件清单：幂等升级返回 `already-current`，卸载返回
`uninstalled` 并恢复原始 `opencode.json`。`0.6.1` 当前清单已扩展为 47 个受管文件和 29 个可执行
脚本；2026-09-02 的 138 项候选 Node 测试与 44 项 Shell 测试覆盖当前安装、doctor、升级、卸载及
新增 baseline 恢复边界，不能再把历史的 45/44 计数当成当前预期。
`.automation-plugin/` 的审计/恢复证据会保留；OpenCode 自己生成并忽略的 `.opencode` 依赖缓存也不在
插件 manifest 内，卸载器不会冒险删除这些外部文件。

## 12. 人工升级清单

- [x] WordPress 工作区干净；当前安装提交为 `7bff3ee`，本地分支领先远程 1 个提交。
- [x] `.automation-plugin/manifest.json` 为健康的 `0.6.0` installed 状态，固定 `0.6.0` doctor 全绿。
- [ ] 升级命令使用固定 `@frankzhang2026/opencode-android-orchestrator@0.6.1`，不使用浮动 `latest`。
- [ ] 不重复执行 `init`；命令只有 `upgrade . --json`，没有跨仓库绝对路径或 WordPress 专用 JSON。
- [ ] 没有复制或重新创建 WordPress 专用 Gradle 验证 JSON。
- [ ] 升级结果为 `0.6.0 → 0.6.1`、47 个受管文件、写入 10 个、复用 37 个且无清理警告。
- [ ] `androidProject.primaryModule` 仍为 `:WordPress`，`moduleScope` 仍为 `all`。
- [ ] `automation/config.json` 继续同时覆盖库单测和 WordPress 应用单测。
- [ ] focused test 首项为 `:WordPress:testWordpressDebugUnitTest`，同时允许其他已发现模块任务。
- [ ] 全量与设备矩阵同时包含 WordPress 和 Jetpack Debug flavor。
- [ ] 现有 `.automation-worktree-allowlist` 被原样保留；无需排除项时保持注释即可。
- [ ] WordPress 的项目级 Configuration Cache 保持启用；插件只在临时发现调用中禁用缓存。
- [ ] `longCommandTimeoutMs` 默认为 `1800000`；只有明确需要时才通过生命周期参数调整。
- [ ] `/resume-task` 只用于一次经批准的 baseline 中断恢复，不用于测试失败、复核失败或已有业务改动。
- [ ] `doctor`、138 项发布候选 Node 测试、44 项 Shell 测试与 shadow-run 均通过。
- [x] `.automation-plugin/` 已被 `.git/info/exclude` 忽略且未提交。
- [ ] 8 个修改文件与 2 个新增文件经过人工审核后才提交。
- [ ] 提交后工作树干净，严格的 `preflight.sh --source` 通过。
- [ ] 当前领先远程的安装提交与新的升级提交是否 push，由独立人工决定；本发布事项不自动推送 WordPress。
- [ ] `0.6.0` 只用于升级前 doctor；upgrade 与升级后 doctor 均固定使用 `0.6.1`，未使用源码目录、
  本地 tarball、浮动 `latest` 或来源不明的包。

满足以上条件后，插件才同时达到三个目标：不再漏掉应用 flavor、长命令不会被短超时误杀，并且
baseline 外部中断只能通过一次受限恢复继续；任何 Android 工程仍从一条项目无关的 `init .` 命令开始接入。
