# WordPress Mockito instrumentation 修复进度

更新时间：2026-09-02

## 目标

为 `/Users/zhanglong/files/program/wordpresslocal/WordPress` 的 JVM 单元测试提供可靠的 Mockito
instrumentation，使 `libs:fluxc` 在 Java 21 下不再依赖失败的 ByteBuddy 动态自附加。

## 当前结论

- 失败任务：`TASK-POSTLIST-REFRESH-LOADING`。
- 直接失败点：coding 前的 baseline 全量单测，而不是业务代码实现。
- FluxC 根异常：Mockito inline mock maker 无法让 ByteBuddy agent 自附加到 Homebrew OpenJDK 21.0.11。
- WordPress 另有 5 项 Locale 相关失败，不属于本文件当前修复范围。
- 原业务任务已由用户批准终止，状态为 `ABORTED`；修复已作为独立维护改动落入原业务分支。

## 分步状态

| 步骤 | 状态 | 结果 |
| --- | --- | --- |
| 1. 建立进度文件并读取仓库约束 | 已完成 | 根目录 `AGENTS.md` 要求完整单测最终使用独立的 `./gradlew testDebugUnitTest` 命令 |
| 2. 确认最小 Gradle 配置位置 | 已完成 | 在根 `build.gradle` 仅为 3 个 Mockito 模块建立非传递 agent 配置，并用惰性参数提供器覆盖 JVM `Test` 任务 |
| 3. 隔离实施并运行单个 FluxC 测试 | 已完成 | `NonceRestClientTest` 在相同 Homebrew JDK 21.0.11 下通过，原 ByteBuddy 自附加异常消失 |
| 4. 扩大测试验证 | 已完成 | 目标 Mockito 异常全部清零，Kover 报告与配置缓存均已验证 |
| 5. 安全集成 | 已完成 | 任务终止并恢复干净分支后，补丁已应用到正式 WordPress 工作树 |

## 下一步

Mockito instrumentation 修复已经完成。重新发起原业务任务前，还需要单独处理 baseline 中与本修复无关的
FluxC 4 个时区/数据失败，以及 WordPress 两个变体各自相同的 5 个中文 Locale 断言失败。

## 最小设计

1. 根脚本只为 `:WordPress`、`:libs:fluxc`、`:libs:image-editor` 分别创建其自己的 `mockitoAgent`
   configuration，避免 Gradle 9.4 禁止的跨项目 configuration 解析，也不向无 Mockito 的模块注入 agent。
2. `mockitoAgent(libs.mockito.core)` 设置 `transitive = false`，确保 agent 与测试使用的 Mockito 版本一致。
3. 对这 3 个项目的 `tasks.withType(Test).configureEach` 添加缓存友好的
   `CommandLineArgumentProvider`，产生 `-javaagent:<mockito-core.jar>`。
4. Kover 只 instrument 三个模块各自的生产包，避免重复改写 Kotlin/AndroidX/Robolectric/OkHttp 等外部类型，
   同时保留项目代码覆盖率。
5. 不通过环境变量或动态 attach 绕过；最终仍使用仓库规定的独立 Gradle 命令验证。

## 过程记录

- 隔离目录：`/private/tmp/wordpress-mockito-agent.q6f1sg/repo`。
- 第一次 `gradlew help --task` 在根 `build.gradle` 依赖声明处失败；原因为局部变量
  `mockitoAgent` 遮蔽 Groovy 自动生成的同名 configuration 方法，不是 agent 方案本身失败。
- 调整：局部变量改为 `mockitoAgentConfiguration`，公开 configuration 名称仍为 `mockitoAgent`。
- 第二次配置解析成功；单类测试尚未启动测试 JVM，就被 Gradle 9.4 的 unsafe cross-project
  configuration resolution 检查拒绝。
- 调整：agent configuration 与消费它的 Test task 改为同一项目所有，仍只修改根脚本一处。
- 第三次配置解析成功。
- 单类命令 `./gradlew :libs:fluxc:testDebugUnitTest --tests
  org.wordpress.android.fluxc.network.rest.wpapi.NonceRestClientTest --no-configuration-cache` 成功；43 个任务中
  1 个执行、42 个已是最新，Gradle 总耗时约 11 秒。
- 首次完整 FluxC 验证共运行 1387 个测试，原来的 ByteBuddy “无法初始化 inline mock maker / 无法
  self-attach”异常为 0，但有 99 项失败。其中 13 个测试结果文件包含 Mockito 重定义
  `kotlin.jvm.functions.Function0` 时的 `attempted to delete a method`。
- `--info` 确认测试 JVM 同时加载 Mockito 与 Kover 0.9.8 agent，当前顺序为 Mockito 在前、Kover在后。
  把 Mockito 参数提供器延迟到 Kover 插件应用后注册并未改变最终 JVM 参数顺序，受影响测试仍失败，故不把顺序作为修复手段。
- 已从本机缓存的 Kover 0.9.8 官方源码确认 `currentProject.instrumentation.excludedClasses` 是其用于处理
  instrumentation 库冲突的类级配置。下一小步只让 Kover 跳过 `kotlin.*`，保留项目代码覆盖率，再重跑
  `PagedListFactoryTest`。
- `PagedListFactoryTest` 的 2 个用例已全部通过，说明排除 `kotlin.*` 能消除已知的结构重定义冲突。
  下一小步运行完整 FluxC 单测，检查是否还有其他类型的 Mockito instrumentation 失败。
- 完整 FluxC 共 1387 个测试，失败从 99 降到 20（4 个原有时区/数据失败，16 个 Mockito/Kover
  冲突）。剩余冲突涉及 `androidx.lifecycle.*`、`org.robolectric.*`、`okhttp3.*`，证明维护外部包黑名单
  不够稳。下一小步改为 Kover 白名单，只 instrument `org.wordpress.android.fluxc.*` 的模块自有代码。
- AndroidX、Robolectric、OkHttp 三类抽样测试均通过；第二次完整 FluxC 运行 1387 个测试，Mockito
  instrumentation 失败为 0，只剩 `StatsUtilsTest`、`SiteUtilsTest` 和 `BlazeCampaignsStoreTest` 共 4 个
  与本修复无关的既有失败。
- 方案已收紧：只在实际声明 Mockito 的 `:WordPress`、`:libs:fluxc`、`:libs:image-editor` 加载 agent，
  并为 Kover 设置对应生产包白名单。下一小步验证较小的 image-editor 模块。
- `./gradlew :libs:image-editor:testDebugUnitTest --no-configuration-cache` 已成功。下一小步运行
  `:WordPress:testWordpressDebugUnitTest`，确认主模块没有新增 instrumentation 回归。
- `:WordPress:testWordpressDebugUnitTest` 共运行 6077 个测试，只剩先前已知的
  `MostPopularTimeViewModelTest` 5 个中文 Locale 断言失败；Mockito instrumentation 失败为 0。
  下一小步验证 `:WordPress:testJetpackDebugUnitTest`。
- `:WordPress:testJetpackDebugUnitTest` 同样运行 6077 个测试，仅上述 5 个 Locale 失败，Mockito
  instrumentation 失败为 0。
- `:libs:fluxc:koverLogDebug` 使用本轮测试数据成功输出 36.224% 行覆盖率，说明 Kover 白名单未令报告失效。
- 默认开启的 Gradle configuration cache 已完成一次存储和一次复用，单类 Mockito 测试均成功。
- 按仓库规范独立执行 `./gradlew testDebugUnitTest`；只剩 FluxC 原有 4 项失败。扫描全部 `TEST-*.xml`
  后，`Could not initialize inline Byte Buddy mock maker`、`Could not self-attach`、
  `attempted to delete a method` 均为 0。
- 可落地补丁：`taskdescriptions/orchestrator/patches/wordpress-mockito-instrumentation-fix.patch`。

## 正式集成记录

- 用户已在 OpenCode 中终止 `TASK-POSTLIST-REFRESH-LOADING`；状态文件确认 `ABORTED`，工作树回到
  `feature-0602-cases-opencode-test` 且落地前为干净状态。
- 正式修改仅为 `build.gradle` 与 `config/gradle/code_coverage.gradle`，`git diff --check` 通过。
- 正式工作树中的 `NonceRestClientTest` 与 `PagedListFactoryTest` 均成功。
- 正式执行独立 `./gradlew testDebugUnitTest`：1387 个 FluxC 测试中只剩原有 4 项失败；扫描测试 XML 后，
  三类目标 instrumentation 异常均为 0。
