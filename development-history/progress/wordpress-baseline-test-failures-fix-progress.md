# WordPress baseline 剩余测试修复进度

更新时间：2026-09-02

## 目标

修复 Mockito instrumentation 配置落地后仍阻塞 baseline 的测试失败：

- FluxC：`StatsUtilsTest` 1 项、`SiteUtilsTest` 2 项、`BlazeCampaignsStoreTest` 1 项。
- WordPress：`MostPopularTimeViewModelTest` 5 项（wordpressDebug 与 jetpackDebug 为同一组测试）。

## 约束

- 保留正式工作树中已验证的 `build.gradle` 与 `config/gradle/code_coverage.gradle` 改动。
- 不修改编排器基础设施文件。
- 先运行失败测试类，最后按仓库规范独立执行 `./gradlew testDebugUnitTest`，并补跑两个 WordPress 变体。

## 分步状态

| 步骤 | 状态 | 结果 |
| --- | --- | --- |
| 1. 读取约束并建立记录 | 已完成 | 仅根 `AGENTS.md` 生效；正式工作树当前只有两项 Mockito/Kover 配置改动 |
| 2. 修复 FluxC 4 项 | 已完成 | 三个失败测试类已通过 |
| 3. 修复 WordPress 5 项 | 已完成 | `MostPopularTimeViewModelTest` 在两个变体均通过 |
| 4. 完整回归 | 已完成 | 三个完整测试任务均通过 |
| 5. 最终检查 | 已完成 | `git diff --check` 通过；测试 XML 未发现失败或旧 Mockito instrumentation 错误 |

## 过程记录

- 当前分支：`feature-0602-cases-opencode-test`。
- 原自动化任务已终止，不再有任务合同占用工作树。
- FluxC 根因与修复：
  - `StatsUtilsTest` 的 Calendar 只指定 Locale、未指定时区；改为显式 UTC。
  - `SiteUtilsTest` 的当前小时“不相等”断言会被宿主 UTC 偏移抵消；当前时间场景保留明确的时区后缀断言，
    固定日期场景改用固定 UTC Instant 和精确小时断言。
  - `BlazeCampaignsStoreTest` mock 期待 `en`，但调用使用宿主默认 Locale；测试调用显式传入 `en`。
- WordPress 根因与修复：生产代码按 `Locale.getDefault()` 本地化星期及 AM/PM，而测试断言英文。按照相邻
  `MostPopularDayViewModelTest` 的既有模式，在测试前保存 Locale 并设置 `Locale.US`，测试后恢复。
- 局部验证：三个 FluxC 失败类通过；`MostPopularTimeViewModelTest` 在 wordpressDebug、jetpackDebug 均通过。
- 完整回归：
  - `./gradlew testDebugUnitTest`：通过（1 分 41 秒）。
  - `./gradlew :WordPress:testWordpressDebugUnitTest`：通过（1 分 57 秒）。
  - `./gradlew :WordPress:testJetpackDebugUnitTest`：通过（2 分 1 秒）。
- 最终检查：`git diff --check` 无输出；扫描 FluxC 与 WordPress 的 `TEST-*.xml`，未发现 `<failure>`、
  `Could not initialize inline Byte Buddy mock maker`、`Could not self-attach` 或 `attempted to delete a method`。
- 当前正式工作树共有 6 个已修改文件：2 个 Mockito/Kover 配置文件、4 个测试文件；未创建提交。
