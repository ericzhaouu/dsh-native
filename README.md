# DSH Native for OpenClaw

**发布候选版本 1.0.0-rc.3（非稳定版）**：把官方 DeepSeek Harness（DSH）的模型／工具循环接入 OpenClaw 的原生 `AgentHarnessV2`，并保留 OpenClaw 对模型、认证、工具授权与会话入口的控制。

- 源码仓库：[ericzhaouu/dsh-native](https://github.com/ericzhaouu/dsh-native)
- 作者：[ericzhaouu](https://github.com/ericzhaouu)
- npm 包名：`openclaw-dsh-native`；插件／harness ID：`dsh-native`
- 示例 Agent：`dsh-experiment`
- 许可证：MIT

> **先了解边界**
>
> 这是需要审阅并信任的原生代码，不是操作系统沙箱，也不是任意模型提供商的通用适配器。0.3 的 Agent 级 `runtime.harness` 是**可选 HOST PATCH 新增的字段**，不是 stock OpenClaw 2026.9.2 SDK 的既有配置。安装、升级、补丁和配置变更应在维护窗口完成；不要修改正在运行的 Gateway。
>
> 本文提供从源码构建和本地安装的方法，**不声称本项目已经发布到 npm 或提供 GitHub Release 安装包**。

## 目录

- [1.0.0-rc.3 模式、最终正文与验收控制](#100-rc3-模式最终正文与验收控制)
- [1.0.0-rc.2 根因整改与诊断](#100-rc2-根因整改与诊断)
- [1.0.0-rc.1 当前请求优先](#100-rc1-当前请求优先)
- [0.7.4 执行预算与验收边界](#074-执行预算与验收边界)
- [0.7.3 会话连续性根因修复](#073-会话连续性根因修复)
- [0.7.2 稳定性加固](#072-稳定性加固)
- [0.7.0 当前会话私有回复](#070-当前会话私有回复)
- [0.6.1 Copilot 压缩认证交接补丁](#061-copilot-压缩认证交接补丁)
- [0.6.0 原生压缩与独立维护](#060-原生压缩与独立维护)
- [0.5.2 Agent 级 SKILL 可见性覆盖](#052-agent-级-skill-可见性覆盖)
- [0.5.1 会话重置修复](#051-会话重置修复)
- [继承宿主工具与收窄清单](#继承宿主工具与收窄清单)
- [自适应任务准备](#自适应任务准备)
- [0.3.1 修复](#031-修复)
- [运行基线与兼容范围](#运行基线与兼容范围)
- [它是什么：native、ACP 与 provider](#它是什么nativeacp-与-provider)
- [从源码构建](#从源码构建)
- [维护窗口安装与 Agent 级启用](#维护窗口安装与-agent-级启用)
- [安全的首次任务](#安全的首次任务)
- [未打补丁宿主的兼容模式](#未打补丁宿主的兼容模式)
- [模型、认证与参数](#模型认证与参数)
- [插件配置项](#插件配置项)
- [能力边界与 Dashboard](#能力边界与-dashboard)
- [原生状态、锁与恢复](#原生状态锁与恢复)
- [停用、回退与升级](#停用回退与升级)
- [安全与公开发布](#安全与公开发布)
- [开发与测试](#开发与测试)
- [仓库结构](#仓库结构)
- [排错](#排错)
- [致谢与许可证](#致谢与许可证)

## 1.0.0-rc.3 模式、最终正文与验收控制

RC3 是源码候选，不是稳定版、生产升级或验收通过声明。本轮发布说明与版本元数据准备不部署插件、不应用宿主补丁、不修改真实飞书／业务记录；依赖版本保持固定。真实模型、飞书读写、完整语料与远程 CI 仍需对应制品的新证据，不能用局部 fixture 或历史报告代替。

- **当前交互与模式**：用户要求现在直接提问／共同探索时属于 `chat`，不是因为答案是文本就改成 `draft`，也不是因为整体目标还有未知就进入阻断式 `clarify`。供以后使用的问题模板／访谈稿属于 `draft`；当前核实／执行确被材料或权限阻断时才澄清。普通聊天问题不占阻断澄清次数；未读取的 Skill、未检索的资料或未完成的人审不能声称已使用／核实。非执行模式保持零宿主工具。
- **显式 v4 与可恢复 campaign**：`--source-corpus-version 4 --contract-version 2` 选择 `tests\acceptance\cases\v4` 的审阅增量，默认仍是 source-v1／contract-v2，不重判 v1–v3 的旧报告。新的等待、恢复与预算入口见下文“RC3：v4 语料与 campaign 等待恢复”；它们不改变现有 native 只读 source 验收路径或默认选择。
- **精确工具覆盖与资源限界**：`toolAllowlistByAgent` 只替换命中 Agent 的候选清单，不突破宿主权限；`bitablePolicyByAgent` 默认关闭，要求精确资源策略与可信原始工具实例 capability。stock `prepareNativeHost` 不提供该 capability，相关 Bitable 工具保持 fail-closed，不能据配置示例宣称真实写入可用。保留下文完整的 newtool 配置与限制；不向全局追加工具，不修改已有业务／只读 Agent、原生当前来源投递路由或未配置时的默认行为。

### DSH-only chat-final-text companion

独立 `host-patch\chat-final-text` companion 只对可信运行上下文中显式设置 `runtime.type:"embedded"`、`runtime.harness:"dsh-native"` 的 Agent 保留普通最终正文的首尾空白；多 text block 按原顺序拼接，不额外插入换行。它不是所有输出的无条件原始字节通道：纯空白仍隐藏，已有控制 token、heartbeat、脱敏等规则继续生效；非 DSH 保持旧投影，legacy model-selected DSH 不获得这一正文保证。

显式 Agent-pin 的 native preflight 只读检查 companion，缺失／partial／被改动时在模型执行前拒绝，不自动修补宿主。该补丁独立于 `source-reply` 所有权和 `table-policy` 格式策略，不扩大消息目标、source routing 或工具权限。准确范围、两个固定宿主文件及哈希见 `host-patch\chat-final-text\USAGE.txt` 和 `spec.mjs`。

需要安装时，先在独占离线维护窗口停止／排空对应 Gateway，再对精确 OpenClaw 2026.9.2 制品执行；以下是操作模板，不表示已经应用：

```powershell
node .\host-patch\chat-final-text\apply.mjs --root C:\PATH\TO\openclaw --check
node .\host-patch\chat-final-text\apply.mjs --root C:\PATH\TO\openclaw --apply --offline-confirmed
# 仅需回退时，在同样的离线窗口执行：
node .\host-patch\chat-final-text\apply.mjs --root C:\PATH\TO\openclaw --restore --offline-confirmed
```

保留独立 `.dsh-native-chat-final-text-patch-v1` 回执并协调插件回退；脚本不重启 Gateway。既有 `source-reply`／`table-policy`／`group-readonly` companion 的职责和默认策略不变，不将此 RC3 新要求追写为旧版本已具备的能力。

## 1.0.0-rc.2 根因整改与诊断

本候选修复运行时长与进程终止等待的墙钟依赖，增加不记录回调正文的失败阶段诊断，并保留准备回调未收敛时的锁和不可重放状态。非执行模式仍不调用宿主工具，自动 Skill 不强制加载；明确要求使用时仍受原有权限约束。

验收侧修复文件评分答案隔离、真实载荷重投、业务／安全失败归因，以及跨平台字节和测试副本权限约定。显式源语料版本 3 对齐已审阅的提示／评分合同，不重判版本 1、2 的历史失败。

这些修复不自动修改宿主配置、定时任务、业务记录或现有宿主补丁。部署仍需维护窗口和固定制品；本地回归通过不代表真实飞书、正向写入、远程 CI 或历史通知中断根因均已闭环，也不是 1.0 稳定版声明。

## 1.0.0-rc.1 当前请求优先

这是供新一轮验收使用的候选版本，**不是 1.0 稳定版发布，也不表示已替换运行中的 0.7.4**。既有工具权限、预算、状态绑定与非执行模式隔离保持不变。

模式选择明确优先处理用户当前要求：只要求解释、来源清单或文本草稿时，可以完成这些输出，但不能声称底层核实／执行已经完成；真正要求核实或执行、而必要材料或权限缺失时，必须澄清。该规则不使用用例编号或特定关键词路由，也不授予联网、工具或业务操作权限。

源码验收工具通过 `--source-corpus-version 2` 显式选择新语料：200 个用例、224 条输入，包含真实阻断目标的对照题。默认仍使用原语料；旧版语料哈希和失败报告不重判。源语料版本与 `--contract-version` 的评分协议版本分别管理。内部 `dsh_prepare_task` 仍完整留在证据中，但不混入宿主业务工具计数；这不豁免任何真实宿主调用或副作用。

源码中的后续整改提供显式 `--source-corpus-version 3`，对齐当前请求、可选自动 Skill 与测试输入／评分约定；默认仍为源版本 1，旧版本和历史结果不重判。编译与本地回归不等于新版语料已经完成真实模型或渠道验收，也不表示运行中的插件已经升级。

新候选仍须完成其对应的真实业务、渠道和发布门槛，不能用旧制品的成功记录或局部先导结果替代。

## 0.7.4 执行预算与验收边界

本轮提供选择性执行预算、专用测试群的只读补丁，以及定时归属和验收基础设施修复；**不是 1.0 就绪声明，也不表示已经部署到运行中的宿主**。未配置预算的既有任务保持原行为。

- **派发前预算**：可信配置的请求数、输入／输出 token、宿主工具次数和时限在运行时执行。准备、自动压缩及实际重试请求计入同一次尝试；独立压缩和 reviewer 是另一次受限尝试。使用方式见下文，不可用提示词代替限制。
- **保留第一原因**：不受支持的宿主 authority／能力契约使用宿主识别的终止型 preflight 错误，不进入不能解决该权限问题的模型 fallback。原有定时权限保护不删除。
- **专用只读群**：新增独立 `host-patch\group-readonly`，只在 DSH 绑定的真实飞书群、宿主已解析为仅 `read`／私有 `message` 的策略下，附加只读工作区约束；允许的只读 Skill 根仍遵循宿主规则，不是任意文件沙箱。它不改全局权限或其他聊天，配置规划器会保留继承的 deny，按最新配置哈希处理变更／恢复。应用或撤销必须停止对应 Gateway，详见该目录 `USAGE.txt`。
- **验收与发布证据**：新版语料保留允许结果集合及逐轮独立判定，原始观察先绑定再脱敏，旧版语料和历史报告不重判。通道控制严格区分真实飞书与隔离 SDK；重投增量、未知 ACK 和不可重发状态单独记录。Linux CI 要求显式运行隔离 SDK 用例，Windows 仍为实验性；绿灯不代表真实账号、卡片回退或完整业务语料已通过。

定时任务的替代路径是经过批准的**显式独立内置 owner**，不是原生 DSH cron 兼容；保持暂停状态、不运行任务、不复制认证或转录，见“定时任务的显式归属修复”。资源观测保留冷／暖基线和 FD 身份，不通过放宽阈值掩盖资源增长。

## 0.7.3 会话连续性根因修复

本轮修复真实渠道连续会话暴露的三个产品边界问题，不新增模型工具或性能调优。

- **单一历史所有者**：DSH 提交最终助手记录后，通过模型参数之外的一次性可信能力，绑定当前 Agent、会话、run、reset 和助手记录身份。宿主发送前再次核对权威历史和实际目标会话，只省略同一答复的重复投递镜像；不再靠原文与渠道规范化文本碰巧相等来去重。保留原有授权、投递回执与未知结果隔离。
- **终止型历史错误**：显式历史／准入不变量错误携带宿主识别的 `openclaw_transcript_not_continuable` 标记，保留原始错误和 cause，不再进入无法修复历史的模型 fallback。普通 I/O、取消和提供商错误不被一概改成终止型。
- **格式策略一致性**：独立宿主补丁仅调整明确绑定 `dsh-native` 的群聊 Agent，读取实际 account／channel 表格转换策略。`off` 表示不转换，可按用户要求输出原始 Markdown 表格；`code`／`bullets` 则明确说明对应替代，不谎称支持原生表格渲染。其他 Agent 的提示保持原状。

**私有 `message_tool_only` 回复现在需要新增的所有权宿主补丁**；缺失时在模型推理前明确拒绝，不退回已知有缺陷的旧发送方式。当前可信归属交接支持本地当前来源纯文本和内部 UI 回复；跨会话、媒体、远程 Gateway action 转发拒绝执行。它不承诺平台端恰好一次送达。

两个新补丁均要求精确 OpenClaw 2026.9.2 文件哈希、独立回执，并可单独回滚。须先在独占维护窗口停止／排空该 Gateway，再执行：

```powershell
node .\host-patch\source-reply\apply.mjs --root C:\PATH\TO\openclaw --check
node .\host-patch\table-policy\apply.mjs --root C:\PATH\TO\openclaw --check
node .\host-patch\source-reply\apply.mjs --root C:\PATH\TO\openclaw --apply --offline-confirmed
node .\host-patch\table-policy\apply.mjs --root C:\PATH\TO\openclaw --apply --offline-confirmed
```

升级插件与补丁后再启动 Gateway。撤销使用相应工具的 `--restore --offline-confirmed`，并协调插件版本，避免新插件在没有所有权能力时无法回复。现有 Agent-pin 和 compaction-auth 补丁不变；不会自动改写渠道配置。

**不自动修复已污染的旧历史**：不删记录、不把外来助手重新标为 DSH、不移除锁，也不自动 `/new`。保留旧现场，只有在明确授权后使用新会话阶段。新的连续性回归不覆盖或改判原始失败记录。

## 0.7.2 稳定性加固

功能、模型路由和工具权限保持不变。本轮不调整任务模式选择或业务评分规则，也不以正常用例重复通过代替故障恢复证明。

- 取消的升级路径不再依赖挂起的 RPC 返回。Linux DSH 子进程使用专属进程组，有界 TERM／KILL 后确认退出；宿主业务工具的进程仍由宿主负责，插件不会按名称杀进程。无法确认终止时保留所有权锁，不把会话标为可重放。
- RPC 分别限制单帧 16 MiB、待响应请求 128、入站请求 64、通知队列 1024、发送队列 256，以及收／发排队数据各 32 MiB。超限明确关闭并拒绝等待者；不丢帧后继续假装成功。`maxConcurrentRuns` 默认 8、可配置 1–64，限制**每个 runtime 实例**的并发操作；超额在状态／子进程提交前拒绝，不自动排队或重试，不替代宿主全局并发限制。
- 工具收尾、最终发布和结束 hook 设有有界等待。停止等待不等于工具已停止：实际回调尚未结束时，原会话继续被隔离。私有发送仍沿用原 attempt 的时限；只有取消发生后才开始收尾宽限期。
- 当前来源投递区分 `confirmed-delivered`、`confirmed-not-delivered`、`unknown-after-started`。发送前持久化 `source-reply.lock` 和 `source-reply-receipt.json`；未知结果保留锁，重载插件也不能默默重发。记录不含消息正文或渠道凭据。确认送达后发生其他错误仍保留送达事实；这不是对平台端恰好一次投递的承诺。
- `binding.json` 执行文件同步、原子替换及父目录同步；所有权记录增加进程启动身份、实例标识和状态键哈希。Linux 的真实落盘错误会失败；Windows 不支持目录同步时明确警告，不声称断电持久性已认证。

可使用随包提供的只读诊断，不会修改或删除任何锁：

```powershell
node .\scripts\inspect-state.mjs --state-dir C:\PATH\TO\private-dsh-state
```

`operator-inspection-required` 表示必须核对旧进程、工具与平台回执。不要通过删锁、改成 `ready` 或重发原消息绕过不确定结果。必要时保留旧记录并使用明确的新会话／清空 epoch。升级仍须维护窗口；本版本不会自动部署或修改宿主补丁。

## 0.7.0 当前会话私有回复

**0.7.1 修复**：真实飞书消息工具的可选 presentation schema 包含合法的联合类型。0.7.0 的私有校验器错误拒绝此 schema，导致普通文本轮次在推理前失败；0.7.1 接受这种 schema 表达，但仍严格限制发送参数为下述三个字段，不开放 presentation、多媒体或模型消息工具。业务工具校验策略不变。

当宿主要求 `message_tool_only` 投递时，DSH 使用宿主构造并授权的私有 `message` 工具，把**已持久化、经改写／脱敏的最终文本**发送到当前来源会话。模型仍只生成文本：`message` 不出现在模型工具清单，也不能由模型指定收件人、账号、频道或转发目标。

发送沿用宿主策略、审批、当前来源能力和 transport，参数仅为 `{action:"send", message:最终文本, final:true}`；不会独立调用飞书 API 或持有另一套渠道凭据。`toolAllowlist: []` 和准备阶段的零业务工具模式不禁止这项私有回复，但显式宿主工具禁用、执行 deny、失效能力仍会阻止发送，不能为可用性移除限制。

仅 SDK 确认的当前来源回执算送达；缺失回执或失败不能宣布成功，也不自动重跑模型／重复发送。发送后取消或 hook 失败保留已确认的送达事实。静默正文和 memory 维护不发送；message-only 轮次不推送未经提交的 partial／reasoning 文本。

这不是主动消息、跨群投递、多媒体或所有渠道的兼容承诺。Linux 隔离 Gateway 的合成通道测试不等于真实飞书验收；1.0 仍需真实渠道、完整行为语料、稳定性及同制品回退门禁。0.7.0 本身没有新增宿主补丁；升级到 0.7.3 时须同时应用上节的所有权兼容补丁。

飞书适配器 `@openclaw/feishu@2026.8.2` 可在对应 account 下设置 `renderMode:"raw"` 与 `streaming:{mode:"off",block:{enabled:false}}`，使用非卡片文本路径。该设置影响该 account 的展示方式，不扩大群／发送人权限，也不代表查明了旧 CardKit HTTP 400 的根因。

## 0.6.1 Copilot 压缩认证交接补丁

OpenClaw 2026.9.2 的普通对话会准备 Copilot 账户专属端点和请求头，但原生 `compact()` 路径缺少相同准备。配置端点与账户端点不同时，0.6.0 的严格绑定会拒绝压缩。

0.6.1 提供独立、可回滚的 **宿主兼容补丁**，仅处理 `dsh-native` + `github-copilot`、宿主拥有认证的压缩请求。它复用宿主 provider runtime-auth 准备及模型转换函数，并同步传入的认证路由计划。普通对话已向插件交付源凭据；压缩保持相同语义，不把短期派生 token 替换成绑定身份，也不放宽源账号、模型、端点或请求头指纹校验。

0.6.2 将 provider 准备显式绑定到该次压缩持有的插件代际快照，避免队列回调使用不相关的环境作用域。若已经应用 0.6.1 的旧压缩补丁，先在停机窗口用**旧版补丁工具**执行 `--restore --offline-confirmed`，再用新版工具应用；未知的已修改宿主文件仍拒绝覆盖。

**0.6.3 原生会话模型保持**：当所选 Harness 为 `dsh-native` 时，压缩使用当前会话模型，而不是 `agents.defaults.compaction.model` 的全局摘要模型。这是原生历史与严格路由绑定的要求，不会修改全局配置；其他 Harness 继续遵循原有模型覆盖。此版本使用独立 v2 回执 `.dsh-native-compaction-auth-patch-v2`，同时校验认证交接和压缩目标选择两个宿主文件。升级已应用的 0.6.1／0.6.2 补丁时，先用旧工具恢复旧补丁，再应用 v2；保留两套回滚材料。

**仅更新插件不会自动修改宿主。** 下载／构建包后，在停止该安装的 Gateway 的维护窗口中执行，`C:\PATH\TO\prepared-dsh-native` 指解包后的 `package` 目录：

```powershell
node C:\PATH\TO\prepared-dsh-native\host-patch\compact-auth\apply.mjs --root C:\PATH\TO\openclaw --check
node C:\PATH\TO\prepared-dsh-native\host-patch\compact-auth\apply.mjs --root C:\PATH\TO\openclaw --apply --offline-confirmed
```

需要撤销时，同样先停止 Gateway，使用 `--restore --offline-confirmed`。补丁要求精确的 2026.9.2 文件哈希；遇到其他版本或本地改动拒绝覆盖，不自行重启服务。压缩补丁回执与现有 `.dsh-agent-harness-patch` 独立；可分别检查和恢复。不要为消除冲突修改端点、删除绑定或绕过账号校验。源凭据本身变更仍需 `/new`，不会猜测两个凭据属于同一账号。

## 0.6.0 原生压缩与独立维护

0.6.0 新增以下能力；已安装的旧版本需要显式升级，不会自动更新：

- 累计计费用量与最后一次模型调用的 `contextUsage` 分开。SDK 的 `contextTokens` 是窗口容量，不是占用量；Dashboard 的历史投影可能省略 `contextUsage`，应以原始转录事件与 attempt usage 为准。
- 使用官方 DSH token meter 和 compaction engine 执行原生压力压缩，以及宿主公开的 `compact()` 调用。摘要没有宿主工具权限，沿用已准备的模型与凭据；原始事件保留，仅更新 DSH 模型可见上下文，不把 OpenClaw 镜像摘要当作原生历史。
- 压缩事务保留调用 ID 和检查点。已确认关闭子进程后的待定压缩，可以在下一轮先只读核对持久记录，再恢复；不会重做模型请求或工具动作。缺失／不完整记录、活动所有者锁和普通工具执行的不确定结果仍需人工处理。
- 宿主 `trigger="memory"` 维护使用独立原生状态、最多 60 秒、4 次宿主工具调用和 4096 输出 token。仅保留已授权 `read` 与宿主针对指定文件包装的 append-only `write`；不经过用户任务规划、不添加前台用户／助手行、不授予 `exec`。维护证据是明确标注可能省略早期消息的有界快照。
- `runIsolatedCompletionV2` 支持宿主准备的文本、模型和认证，零工具、独立临时状态、可取消。暂不支持 harness 自有认证、温度覆盖、非文本或非 strict-visible 输出策略；因此不是对所有自动标题或辅助任务的兼容承诺。

摘要质量仍取决于模型。已有外部压缩／损坏的镜像不会被自动改写或导入；此类旧会话仍需保留记录并使用 `/new`。生产升级与共享 Gateway 重启需要单独安排维护。

未应用 0.6.1 配套宿主补丁时，上述 Copilot 交接缺口仍可能导致 `DSH model route or account changed`。补丁不是对所有宿主版本、渠道和账号场景的兼容承诺；离线模型通过也不替代真实账户连续压缩验收，不能据此直接宣布 1.0-ready。

## 0.5.2 Agent 级 SKILL 可见性覆盖

0.5.2 增加 `taskPreparation.skillAllowlistByAgent`。键必须同时出现在 `taskPreparation.agentIds` 中；值使用与 `skillAllowlist` 相同的精确 Skill 名称校验，最多 12 项，不支持通配符。列出的 Agent 使用该数组**替换**共享 `skillAllowlist`；`[]` 明确表示不广告任何 Skill；未列出的 Agent 继续继承共享列表。此覆盖只影响准备阶段可见的 Skill 说明，不改变宿主工具、认证、MCP 连接或子进程协议。

```json
{
  "taskPreparation": {
    "agentIds": ["dsh-experiment", "dsh-other"],
    "skillAllowlist": [],
    "skillAllowlistByAgent": {
      "dsh-experiment": ["content-distill"],
      "dsh-other": []
    }
  }
}
```

## 0.5.1 会话重置修复

OpenClaw 的聊天 `/new` 可以保留原 `sessionId`，通过宿主转录中的重置事件清空模型上下文，而不是删除可见历史。此前仅测试新会话 ID 会漏掉这个渠道入口差异：重置后的首次请求可能仍因旧的非 DSH 历史而被拒绝，再次 `/new` 也不能解决。

0.5.1 按宿主当前分支的明确清空边界隔离上下文和原生状态，不再假设 `/new` 一定换 ID。原始历史及旧 DSH 状态保留；宿主用户入库回执、会话身份、写入栅栏与边界之后的 DSH 归属校验不放宽。消息正文中写着 `/new` 或“新会话”不是重置凭证。

仅兼容能够确认的清空边界。保留旧上下文的重置、不支持的分支变化或执行中的边界冲突仍明确失败，不能用删除历史、改绑定或导入其他运行时消息绕过。此修复不扩展搜索、飞书业务工具或主动消息投递权限。

## 继承宿主工具与收窄清单

0.5.0 的原则是：**OpenClaw 管理工具，DSH 挑选和编排，dsh-native 只维护收窄清单与调用适配。** 不新建一套工具认证、连接或生命周期管理平台。

```text
有效工具 = 宿主实际构造且当前 Agent 获准使用的工具
         ∩ dsh-native 精确收窄清单
         ∩ 当前桥接支持的工具契约
```

在 `plugins.entries.dsh-native.config` 配置：

```json
{
  "toolAllowlist": ["read", "web_search", "web_fetch"],
  "taskPreparation": {
    "agentIds": ["dsh-experiment", "dsh-other"],
    "skillAllowlist": [],
    "skillAllowlistByAgent": {
      "dsh-experiment": ["content-distill"],
      "dsh-other": []
    },
    "maxClarificationTurns": 3,
    "maxToolCalls": 24
  }
}
```

参考 [examples\openclaw.host-tools.json](examples/openclaw.host-tools.json)。工具必须已由宿主安装、启用并允许该 Agent 使用；示例不会配置搜索服务或授予网络／账号权限。`web_search` 调用宿主原有搜索提供商，不在 DSH 中重新实现搜索 API，也不导出搜索凭据。

- `toolAllowlist` 最多 64 个唯一、精确的可调用工具名，不支持通配符；`[]` 表示不暴露任何宿主工具。
- 未配置该字段时，保持旧的默认 coding 行为；已启用自适应准备的 Agent 也可继续使用旧字段 `taskPreparation.executionTools`。
- 新配置只维护顶层这一份名单。若省略旧字段，自适应执行上限自动从顶层派生；若显式配置两份不同名单，报错而不是静默扩大权限。
- 允许兼容的宿主核心工具及标准插件／渠道工具，保留原工具实例和来源。不会把任意 plugin 的 UI、hook 或后台服务转换成模型工具。
- 构造、授权、执行 hooks、认证及资源清理由宿主负责；DSH 仅接收参数 schema 和获准的文本结果。原始结果仍在宿主执行链中，不能把 `details`、环境变量或认证对象整体发送给模型。
- 名单不保证所有未入选的插件工厂都不会初始化；它约束最终暴露和执行。插件本身仍是需要信任的本机代码。
- 同名冲突、来源变化、已绑定但无法安全插入最终校验的工具或不兼容参数 schema 不会被静默接受。插件替换和启停遵循宿主维护／重载规则，不给正在执行的尝试偷偷增加权限。

### 精确 Agent 覆盖与默认关闭的 Bitable 资源门禁

`toolAllowlistByAgent` 的精确条目**替换**该 Agent 的 DSH 候选清单，不是追加到全局；`[]` 明确无工具。最多 64 个 Agent、每项最多 64 个唯一工具名，无通配符、重复、原型键或非法 Agent ID。未配置／未匹配保持旧行为。身份来自宿主已解析 Agent 或 SDK 会话解析器，不能来自 prompt；启用覆盖却无法解析身份时拒绝，不退回全局清单。

最终能力始终是候选清单 ∩ 宿主全局／Agent／渠道／会话允许 ∩ execution ceiling ∩ preparation gate。未显式配置 `taskPreparation.executionTools` 时，准备策略使用当前 Agent 的候选清单；显式配置时仅取交集，不自动扩权（原有全局名单冲突校验不变）。memory 仍只取 read/write，isolated 和 compact 仍零工具。

下面是插件配置的**合成资源示例**，不是生产接线或已有权限证明。保留原全局列表、瑞比／辛巴及已有只读验收 Agent 的宿主策略；另设专用 writer Agent，宿主仅允许这两个工具，不允许 exec、HTTP、文件工具或替代 dispatcher。不要覆盖已有 preparation Agent 列表；按需将 writer 加入其中并省略 executionTools，或显式配置更窄上限。

```json
{
  "toolAllowlist": ["read", "write", "edit", "apply_patch", "exec", "process", "web_search", "web_fetch"],
  "toolAllowlistByAgent": {
    "dsh-acceptance-writer": ["feishu_bitable_get_record", "feishu_bitable_update_record"]
  },
  "bitablePolicyByAgent": {
    "dsh-acceptance-writer": {
      "source": { "kind": "plugin", "pluginId": "feishu" },
      "accountId": "fixture_account",
      "groupId": "oc_synthetic",
      "appToken": "synthetic_app",
      "tableId": "tbl_synthetic",
      "recordIds": ["rec_synthetic"],
      "fields": { "Status": "string", "Count": "number", "Checked": "boolean" },
      "operations": ["get_record", "update_record"],
      "maxBatchSize": 1
    }
  }
}
```

资源策略必须对应精确 override，且该 Agent 只能选择策略中列出的 record 工具。新 override 中的 `feishu_bitable_*` 没有资源策略时拒绝配置。当前契约故意只支持单记录 get/update；不支持 list/search/create/batch/delete、app/table/field 管理、权限修改或账号重定向。参数只能是 `app_token/table_id/record_id`，update 另带 `fields`。字段是大小写敏感的原样名称，只支持 string/有限 number/boolean；不接受 `fld...` ID 别名、复杂对象或隐式类型转换。每次最多一个记录；大于 1 的 batch 配置拒绝。

在宿主 before-tool hook **之后、原实例 callback 之前**再次校验来源、可信上下文、目标与参数，并复制／冻结参数防止检查后漂移。读回也只能访问相同表与记录；返回契约限定为 JSON `{record:{record_id,fields}}`，只投影允许的字段，不返回其他字段、details 或服务端错误。未知返回格式失败，不虚报成功。

**生产写入仍关闭：**只读检查本地精确 OpenClaw 2026.9.2 SDK 的 dist 后，找到 Feishu 外部插件目录声明，但未找到该安装内可验证的 Bitable 实现／资源 grants。公开 attempt 有 `agentAccountId/groupId/messageProvider/inputProvenance/currentMessageId` 等上下文；这不等于证明某个 Feishu 工具闭包实际使用该账号，也不能据此猜测可信群与真实前台请求的绑定。

内部宿主接线 API 是 `src/native/host.ts` 的 `createNativeToolHost({ ..., bitableScope: { policy, capabilities } })`；类型位于 `src/native/bitable-gate.ts`。每个 `BitableToolCapability` 必须绑定**同一个原始工具实例**，包含 `agentId/accountId/groupId/channel:"feishu"/provenance:"external_user"/foreground:true/runId/sessionId/requestId/contract:"feishu-bitable-record-v1"` 和实时 `assertCurrent()`。这些不是模型参数，也不是可配置的自我声明。stock `prepareNativeHost` 只传 policy，**不制造 capabilities**，因此隐藏并拒绝相关工具。

主 Session 须先核验版本固定的实际 Feishu 工具契约、真实账号闭包、认证来源群／请求／前台生命周期及既有资源 grants，再通过可信宿主入口接线；任何一项不可验证则保持关闭。需用两个专用合成目标做正反例，不能用生产业务记录、prompt 或 exec wrapper 代替 ACL。这里的 capability fixture 测试不证明生产写入已可用。

当前 binding 新增可选 `toolPolicyFingerprint`，只绑定命中的 Agent override、有效 preparation 和资源策略，不加入整张 Agent 映射。增加／修改／删除目标策略须 `/new` 或可信清空 reset epoch；compact/recovery 也检查。其他 Agent 仍保留原绑定格式，不要求全体迁移。

**工具缺失不是需求不清楚。** 请求但未能获得的工具会进入有界的不可用说明；不能证明具体原因时，只说“不可用或被宿主策略过滤”，不猜测是否缺凭据。缺少专用业务工具名，不等于宿主已有的授权 CLI 路线必然不可用；但该说明本身也不证明 CLI 获准使用。仅在本轮提供 `exec`、任务授权该操作且宿主权限与审批允许时，才可使用已经安装、已经授权的 CLI。明确被拒绝的操作不能通过命令、其他账号、新连接或安装新能力绕过。

### SKILL、MCP 与特殊工具

SKILL 是方法说明，不是可执行工具。`skillAllowlist` 控制共享可见技能说明；`skillAllowlistByAgent` 可按已启用 Agent 精确替换它。实际步骤仍必须使用本轮工具集合。单独把技能加入名单不会添加搜索、飞书或 MCP 工具。

解释和草稿不强制自动使用 Skill，也不会为了读取相关 Skill 而升级到 `execute`。明确要求使用 Skill 时，缺失的指令只能在 `execute` 下通过当前获准工具加载；若无法加载，应说明限制，不能假称已应用方法。`chat`、`clarify`、`draft` 仍禁止宿主工具调用。

`chat`、`clarify`、`draft` 仍没有宿主工具。目录中的技能描述不等于完整方法已加载；若正文尚未进入授权上下文，这些模式不能读取技能文件，也不能声称已经完整执行该方法。此限制不通过给草稿模式开放通用命令来规避。

MCP 连接和认证应由 OpenClaw 管理。本版只接纳宿主能安全提供的兼容工具实例；不会自行读取 MCP 配置并建立新连接，也不会把缓存的 advertised catalog 当成当前请求者已连接的证明。需要单独物化请求者连接、特殊审批续接或其他未支持上下文的工具，应明确报告不兼容，而不是宣称所有 MCP／插件都已完整接通。

浏览器／媒体结果、主动消息投递、cron、委派、权限变更和 Tool Search／Code Mode 的二次派发控制器不属于通用文本工具的自动兼容承诺。0.7.0 的当前会话私有最终回复是独立、受限的宿主契约；不能用一个控制器名字绕过对底层工具的收窄。

## 自适应任务准备

0.4.0 新增**默认关闭、按 Agent 开启**的任务准备层。用户可以自然聊天，不需要特殊口令，也不必手动复制增强 Prompt：

| 模式 | 行为 | 本轮宿主工具 |
| --- | --- | --- |
| `chat` | 未要求成文产物的普通解释、咨询或闲聊，直接回答 | 无 |
| `clarify` | 当前确实要求核实或执行，但缺少必要材料或授权时，只问一个关键问题，然后等待回答 | 无 |
| `draft` | 生成明确要求的成文产物，如方案、清单、文本草稿或 Prompt；不执行其中的命令 | 无 |
| `execute` | 目标、边界和用户意图足够清楚时，使用合理假设推进任务 | 配置上限与 OpenClaw 实际授权工具的交集 |

**以当前明确授权的输出为准**，不要把说明、清单或草稿所讨论的潜在操作当成本轮执行目标。解释证据不足或说明所需来源可以是完整回答；要求成文产物时使用 `draft`。当前输出不需要的外部工具不可用，不应触发多余澄清或拒绝。若当前确实要求核实或执行，缺少必要材料或授权仍应澄清；达到澄清上限则保留缺口、仅出草稿，不能把说明或草稿当作已阅读、已核实或已执行。真正缺少工具时应说明能力限制，不反复追问无法补齐的能力。禁止联网仍不得联网，策略或工具可用也不授权代做未请求的业务操作。

内部沿用同一个模型、DSH Session 和 Turn。首个模型 Step 只看到桥接专用的 `dsh_prepare_task` 控制入口，不含任何宿主工具。决策经严格校验和宿主确认后，下一 Step 才获得相应工具或生成回答。控制入口不执行外部操作，其 JSON 和准备阶段推理不进入可见正文；使用量仍计入统计。准备步骤输出上限为 8,192 tokens（宿主限制更低时从低）；之后恢复原有模型限制。通常每轮增加一个短的模型步骤，**不是零开销的关键词分类器**。

以下是插件配置片段，放在 `plugins.entries.dsh-native.config`；不会自动安装或启用宿主 runtime：

```json
{
  "toolAllowlist": ["read", "write", "edit", "apply_patch", "exec", "process"],
  "taskPreparation": {
    "agentIds": ["dsh-experiment", "dsh-other"],
    "skillAllowlist": [],
    "skillAllowlistByAgent": {
      "dsh-experiment": ["content-distill"],
      "dsh-other": []
    },
    "maxClarificationTurns": 3,
    "maxToolCalls": 24
  }
}
```

完整合并参考：[examples\openclaw.task-preparation.json](examples/openclaw.task-preparation.json)。示例的 Agent pin 仍要求前述精确 HOST PATCH。新增配置、启停或修改策略应在维护窗口完成，并使用 `/new`，不要修改正在运行的会话。

| 配置 | 默认值／限制 |
| --- | --- |
| `agentIds` | `[]`，未列出的 Agent 沿用原路径；精确 ID，不支持通配符 |
| `executionTools` | 旧版兼容字段；优先使用顶层 `toolAllowlist`，省略时从顶层派生，否则默认为 coding 工具家族 |
| `skillAllowlist` | `[]`；准备模式不再默认广告整份技能目录，仅显示操作者明确列出的技能 |
| `skillAllowlistByAgent` | 可选对象；键必须是 `agentIds` 中的精确 Agent ID，值替换该 Agent 的共享 Skill 列表；`[]` 明确为空，省略则继承 |
| `maxClarificationTurns` | `3`，允许 `1..5`；达到上限后返回草稿／未决事项，不强迫执行 |
| `maxToolCalls` | `24`，允许 `1..100`；每次执行尝试的宿主调用预算，内部控制调用不计入 |

工具名单最多 64 项，Agent 与技能名单最多各 12 项，均不接受重复。工具名只接受字母、数字、下划线和连字符（最多 64 字符），内部控制名被保留；技能名称还可包含点。当前原始输入和保存的请求上下文上限为 24,000 字符；超过限额时明确报错，请缩小任务，不会静默截断成另一项授权。

### 权限边界

启用自动执行表示操作者允许该 Agent 根据自然语言意图，在所选工具范围内执行明确的任务。**模型判断仍可能误解意图**；代码校验来源引用和阶段，但不能证明任意自然语言的授权语义绝对正确。

阶段门禁在子进程、父进程和实际宿主派发处检查。准备阶段的工具调用不能越过门禁；同一模型响应中把决策与写文件混在一起，也不能提前获得权限。宿主的 `toolsAllow`、`toolExecutionAllow`、hooks 和审批仍有效。推导出的任务摘要是数据，不是高于用户原话、`AGENTS.md` 或宿主策略的新授权。

`exec` 可以执行任意本地程序，并不是只读工具、业务命令白名单或网络沙箱。通过它使用已有 CLI 时，实际权限仍来自宿主操作系统、服务账号和审批；工具名收窄不限制下游程序的全部业务能力。若不接受这种能力，从收窄名单中移除 `exec` 和 `process`，或由宿主提供更严格的执行控制。不得自行新增连接、提权、切换账号或绕过明确拒绝；需要额外权限的事项交由既有宿主／操作者流程处理。

### 会话状态与技能

紧凑任务说明包含目标、交付物、约束、假设、未决问题、来源引用和修订号，保存在私有原生绑定中，只有本轮成功持久化并收尾后才提交。用户原话不会被增强 Prompt 覆盖。每轮重新决定工具门禁，上一轮的 `execute` 不是永久执行许可；切换话题应清除不相关假设。

状态损坏、过期修订、无效决策、重复控制调用、取消或不确定副作用均不会退回不受限的执行。启停准备功能或改变策略后，旧会话会要求 `/new`，不会静默迁移授权或改写历史。

`AGENTS.md`、身份及既有工作区上下文仍由宿主加载。`skillAllowlist` 仅选择可见技能说明，**不是自动兼容性认证或工具授权**；只有依赖当前工具的步骤才可执行。空列表不改动技能文件，也不移除其他 Agent 的技能。

## 0.3.1 修复

- **模型状态归属**：转录可能将 provider／model 脱敏。当前尝试的模型身份改为来自已校验的实际执行路由，不再把 `***` 当作模型提供商，避免成功任务被误报为 Model Fallback。转录内容、脱敏和计费信息保持不变。
- **Dashboard 最终正文**：通过公开 SDK 发布标准 `assistant` 事件，让客户端收到含正文的 `chat.final`，而不只是结束标记。新增的 Dashboard 正文事件是持久化及收尾完成后的最终快照，不承诺逐 token 展示；现有宿主 partial callbacks 保留。
- **取消与收尾**：等待公开的 `agent_end` 完成接口，并保持尝试所有权直到发布结束。取消、重置、停用、过期或失败的尝试不能继续宣布成功正文。SDK 对 hook 错误的 best-effort 策略不变。
- **回归验收**：真实隔离 Gateway 测试直接检查客户端 `assistant`／`chat.delta`／`chat.final` 内容、重复消息和错误回退，同时检查脱敏历史、工具及第二轮续聊。仅检查历史里有答案，不再视为送达证明。

0.3.1 当时未提供独立补全；0.6.0 的受限支持见上方版本说明。Agent 级宿主补丁规格与 0.3.0 相同；已有补丁先执行 `--check`，不要为了升级插件手动重写宿主文件。升级仍需维护窗口和新会话，不会自动部署或清除旧告警／历史。

## 运行基线与兼容范围

| 项目 | 本版本要求 |
| --- | --- |
| Node.js | `>=22.23.1 <23 || >=24.15.0`；不包含 Node 23，也不包含较早的 Node 22／24 |
| OpenClaw SDK | 精确的官方 **2026.9.2** 实验性 `AgentHarnessV2` 制品 |
| 声明的 SDK／optional peer 范围 | `>=2026.9.2 <2026.10.0`；这是依赖范围，**不是所有范围内构建均兼容的保证** |
| Agent 级宿主补丁 | 仅针对 `host-patch\spec.mjs` 中固定文件名及 SHA-256 的 2026.9.2 制品 |
| DSH 包组 | 固定 `0.1.2-alpha.2`，包括 `dsh`、`dsh-agent`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-session`、`dsh-tools`、`dsh-system-prompt` |
| 支持的模型路由 | `deepseek` + `openai-completions`；`github-copilot` + GPT 模型 + `openai-responses` |
| 执行环境 | 本地 Gateway 执行、普通前台文本编码任务；不支持远端执行节点或 sandbox placement |

历史实际测试基线包括 Linux Node **22.23.1**。部分测试直接导入 TypeScript，并使用 Node 的类型剥离及 `node:module.registerHooks`，不能把最低要求简写成“Node 22+”。代码使用结构化子进程参数支持原生 Windows；这不等于声称所有系统／Node 组合都已重新验证。

宿主补丁声明的来源 commit 为：

```text
3928bad9badfcb6c7d140530435e806fb8092190
```

来源：[OpenClaw 对应源码提交](https://github.com/openclaw/openclaw/commit/3928bad9badfcb6c7d140530435e806fb8092190)。
`host-patch\spec.mjs` 是补丁涉及的 **12 个文件**的精确 SHA-256 清单和变更规格；工具还检查替换锚点。**这不是整个发行 tarball 的校验和，也不是对安装目录全部依赖的验签。** 获取官方制品时仍需核对其来源及可获得的制品校验信息。不能只凭版本号、同一源码提交的自编译包，或 `latest` 标签认定可打补丁。

升级 OpenClaw／DSH 后必须重新评估兼容性。宿主补丁需要持续维护、针对新制品重基或由上游正式契约替代；不要跳过哈希校验。

## 它是什么：native、ACP 与 provider

- **Native harness**：本插件显式注册为 OpenClaw 原生 `AgentHarnessV2`；仅启用插件不会自动接管其他 Agent。
- **不是 ACP target**：不需要 `acpx` 插件、ACP server 或 ACP runtime 配置。
- **不是模型 provider**：模型目录、当前／默认模型选择、账号权限及认证仍由 OpenClaw 负责；DSH 不替用户登录，也不提供模型订阅。

```text
用户／Dashboard／OpenClaw CLI
              |
OpenClaw：解析 Agent、当前或默认模型、认证、参数、策略与工作区
              |
dsh-native：原生 harness、路由校验、转录／连续性校验
              |
        私有管道 JSON-RPC
              |
DSH 子进程：一次 attempt 的模型／工具循环 → 已批准的模型端点
              |
        callback 工具调用
              |
OpenClaw：参数校验、工具授权／审批、执行钩子、已收窄的宿主工具
```

只有宿主提供的 callback 工具可以被模型调用。DSH profile 禁用自身原生 shell、编辑器／文件系统工具、stock SDK server 及相关自主执行入口，并核验最终工具目录；不启用环境中的 MCP、subagent 或产品集成。**工具在宿主执行**，不是在隔离沙箱内执行。

每个 attempt 使用一个新子进程；成功后先完成原生持久化、排空桥接并关闭子进程，再允许绑定复用。下一轮由新进程续接同一原生 DSH 会话，而不是保留一个随时可注入命令的长期 shell。无需另装全局 DSH、启动 DSH Web 服务或下载模型权重。

## 从源码构建

以下为 **PowerShell** 示例；所有 `C:\PATH\TO\...` 都是待替换的占位路径，不代表现有安装。其他 shell 可把 `npm.cmd` 换成 `npm` 并使用对应路径语法。PowerShell 若阻止 `npm.ps1`，使用 `npm.cmd`，不必修改系统执行策略。

```powershell
git clone https://github.com/ericzhaouu/dsh-native.git
Set-Location .\dsh-native
node --version
npm.cmd ci
```

确认所用源码的 `package.json` 版本为 `0.6.3`。本项目把 OpenClaw 声明为 **optional peer**，避免在生产插件内部自动安装第二份宿主；开发／类型检查／真实 SDK 测试仍需要匹配的 SDK。

若开发目录尚未提供精确 SDK，先从 [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)的发行流程取得并验证上述 **2026.9.2 官方制品**，然后本地安装：

```powershell
npm.cmd install --no-save --package-lock=false "C:\PATH\TO\openclaw-2026.9.2.tgz"
$DevHost = (Resolve-Path .\node_modules\openclaw).Path
node .\host-patch\apply.mjs --root $DevHost --check
npm.cmd run build
npm.cmd pack
```

`--check` 只检查，不会应用补丁。未修改的匹配制品应报告 `unpatched`。如果所用 registry 没有这个版本，应使用已核验的精确官方制品，**不要猜测可用的 npm 版本、改用最新预览版或伪造 SDK 类型**。无法取得匹配制品时，应停止需要该 SDK 的构建／集成验证。

`npm pack` 的 `prepack` 会再次执行构建，生成本地 `openclaw-dsh-native-0.6.3.tgz`。不要把开发目录中的 OpenClaw SDK、账号或会话状态随插件复制出去。

## 维护窗口安装与 Agent 级启用

### 1. 准备并停止共享 Gateway

先审阅插件、依赖及 `host-patch\spec.mjs`，备份配置、原有插件制品和宿主安装。为 `dsh-experiment` 准备一个**已有、专用、可丢弃的绝对工作区**；不要直接使用带凭据的个人目录。

**先完成或取消所有活动任务，并确认工具／子进程已停止。一个 Gateway 服务于多个连接，停止或自动重启会影响全部连接，不只是这个 Agent。** `gateway.reload.mode="hybrid"` 是默认值，会应用可热更新的改动，并在其他改动需要时重启共享 Gateway；`"off"` 则不应用运行中的配置编辑。不能把配置写入当作无影响的热更新。

下面的命令必须针对同一安装／profile。如受服务管理器管理，还要确保监督器不会自动拉起它：

```powershell
openclaw gateway stop --force
openclaw gateway status --no-probe
```

`gateway stop --force` 中的 `--force` 用于非交互式停止确认，不是空闲证明或补丁权限。状态检查不是对所有残留进程的自动证明；操作者还需确认目标 Gateway 和活动工作确已退出。**必须先停机，再安装插件、应用宿主补丁或写配置；禁止 live patch。** 协作暂停／暂停接单不等于进程停止。这里的 stop／start 用于中间有离线安装步骤的维护窗口；普通重启应使用 `openclaw gateway restart`。

### 2. 安装本地构建包

仍保持 Gateway 停止：

```powershell
openclaw plugins install "C:\PATH\TO\openclaw-dsh-native-0.7.2.tgz" --force --accept-capabilities
```

`--force` 用于确认本地来源／覆盖安装；`--accept-capabilities` 是官方安装器对声明能力的接受选项，**仅用于已审阅并信任的代码**，不是规避安全策略。先阅读安装器说明和能力提示，不要无条件接受陌生代码。归档安装会处理运行依赖；已有 provider 及认证应留在 OpenClaw，不填入插件设置。

**0.7.2 的固定依赖安装／升级／回退应优先采用下面的准备目录路径。** 在已检查的宿主中，直接归档安装可能重新解析 DSH 的预发布 peer，选择与锁定版本冲突的新 RC；optional peer reconciliation 也可能试图从 registry 安装另一份宿主。不要用 npm 的 `--force`／`--legacy-peer-deps` 绕过冲突，不要修改共享宿主依赖或安装猜测版本。解包同一制品，用锁文件准备完整运行依赖，再使用官方目录安装入口：

```powershell
New-Item -ItemType Directory -Path .\artifacts\prepared-dsh-native
tar -xf .\openclaw-dsh-native-0.7.2.tgz -C .\artifacts\prepared-dsh-native
Push-Location .\artifacts\prepared-dsh-native\package
npm.cmd ci --omit=dev --ignore-scripts
Pop-Location
$PreparedPlugin = (Resolve-Path .\artifacts\prepared-dsh-native\package).Path
openclaw plugins install $PreparedPlugin --force --accept-capabilities
```

请使用新的准备目录；如已存在，不要覆盖不明内容。目录必须已有 `dist`、manifest、锁文件及适用于目标系统的完整运行依赖 `node_modules`，但不应包含开发用的第二份 `node_modules\openclaw`。保留锁文件要求的运行时 peer（例如 DSH scope）；**不要加 `--omit=peer`，它也会移除 DSH 必需依赖**。**目录安装视为 prepared-directory，不替你构建或安装依赖**；不能仅拷贝源码。这个后备路径仍是停机维护操作，不是绕过审阅、版本或能力检查。

### 3. 可选：应用 Agent 级 HOST PATCH

只有要使用 `runtime.harness` 时才做此步；stock 宿主兼容模式见下文。`$HostRoot` 必须指向**实际运行 Gateway 的 OpenClaw 包目录**，包含 `openclaw.mjs`、`package.json` 和 `dist`，不是用户状态目录，也不是命令 shim／bin 目录。

```powershell
$HostRoot = "C:\PATH\TO\openclaw-package"
node .\host-patch\apply.mjs --root $HostRoot --check
node .\host-patch\apply.mjs --root $HostRoot --apply --offline-confirmed
node .\host-patch\apply.mjs --root $HostRoot --check
```

最终应为 `applied`。`--offline-confirmed` **只是操作者对已停机的断言**；补丁工具不会检测并关闭 Gateway，不会停止、重启、reload、发信号或改写配置。哈希不匹配立即停止，不要手改已编译文件规避检查。

完整事务恢复与补丁回退步骤见 [host-patch\USAGE.txt](host-patch/USAGE.txt)。

### 4. 只配置目标 Agent

在宿主已完整打补丁、Gateway 仍停止时，将以下字段合并到**已有** `dsh-experiment` Agent；它不是一份可覆盖整个配置的完整配置文件：

```json
{
  "plugins": {
    "entries": {
      "dsh-native": { "enabled": true }
    }
  },
  "agents": {
    "entries": {
      "dsh-experiment": {
        "runtime": {
          "type": "embedded",
          "harness": "dsh-native"
        }
      }
    }
  }
}
```

参考 `examples\openclaw.agent-pinned.json`。保留已有工作区及安全策略；如 `plugins.allow` 已设置，只添加 `dsh-native`，不要覆盖已有列表。

- **不必指定模型来选择 harness**，也不应为此修改 `agents.defaults.model`、全局认证、provider 或其他 Agent 的策略。
- OpenClaw 继续解析目标 Agent 的当前／默认模型、凭据、参数及上下文／输出限制；没有 Agent 模型覆盖时继承正常默认模型。
- 从旧模式迁移时，只删除**这个 Agent** 的旧 `models[...].agentRuntime` 叶子字段，保留相邻参数及其他模型设置；不要删除整个模型条目或修改全局默认／其他 Agent。
- 不要将 `harness` 填入 ACP runtime；若目标原来是 ACP，需要明确将其 runtime 对象替换为所需 embedded 配置，并使用新会话。
- Agent pin 优先于模型／provider runtime 选择，适用于每个 fallback 候选；**不支持的 provider／模型会报错，不能偷偷换模型或逃逸回内置 runtime**。新 provider 出现在目录里并不代表 DSH 支持它。

最后启用插件并启动宿主：

```powershell
openclaw plugins enable dsh-native
openclaw gateway start
openclaw gateway status
```

启用插件不等于完成 Agent runtime 选择。进入目标 Agent 后使用 Dashboard／聊天入口的 **`/new`**，再开始任务。

## 安全的首次任务

先在专用实验工作区手动放入不含秘密的 `smoke-input.txt`，确保 `smoke-output.txt` 尚不存在。使用当前已有权限的受支持模型，不要为了试验覆盖全局默认模型。

建议提示词：

> 仅在当前专用工作区内操作。先读取 smoke-input.txt；如果 smoke-output.txt 已存在就停止，否则用宿主 write 工具把输入原样写入 smoke-output.txt，再用 read 工具读回核对。只报告实际工具结果。不运行命令、不联网、不访问其他目录，不修改配置、凭据或已有文件；缺少权限时停止并说明。

可在 Dashboard 的新会话发送；CLI 可用新生成的会话键避免复用旧绑定：

```powershell
$SmokeSession = "agent:dsh-experiment:dsh-smoke-" + [guid]::NewGuid().ToString("N")
openclaw agent --agent dsh-experiment --session-key $SmokeSession --message "仅在当前专用工作区中读取 smoke-input.txt。如果 smoke-output.txt 已存在则停止；否则用 write 原样写入该文件，再 read 读回核对。不要执行命令、联网、访问其他目录或修改已有文件。缺少权限就停止，只报告工具结果。" --json
```

这是一次会使用模型账号的真实任务，可能产生费用。模型声称“我是 DSH”或输出某个口令**不是启用证明**；应结合宿主的实际 runtime 选择／进度信息、callback 工具结果、生成文件及本地原生绑定判断。不要公开未脱敏的状态或日志。CLI 的 `--message "/new"` 不等于执行聊天 slash-command；通过聊天入口 `/new` 或显式新会话键开始新会话。

## 未打补丁宿主的兼容模式

Agent 级 pin 是可选项。原始 2026.9.2 宿主仍可使用显式的**逐模型** `agentRuntime.id`，不要给 stock 配置加入 `runtime.harness`。

例如只针对已有实验 Agent 的一个已配置模型：

```json
{
  "agents": {
    "entries": {
      "dsh-experiment": {
        "models": {
          "deepseek/deepseek-v4-pro": {
            "agentRuntime": { "id": "dsh-native" }
          }
        }
      }
    }
  }
}
```

这只选择该模型条目的 runtime，不会自动把 Agent 的当前模型换成它；模型必须由宿主正常配置、选择并完成认证。此模式每个模型都需独立选择 runtime，不具有 Agent 级跨模型 pin 的语义。

示例用途：

| 文件 | 用途及注意事项 |
| --- | --- |
| `examples\openclaw.agent-pinned.json` | 0.3 Agent 级 pin；必须先应用 HOST PATCH |
| `examples\openclaw.agent-unpinned.json` | runtime **整体替换**参考；合并时省略 `harness` 不会删除旧字段 |
| `examples\openclaw.experiment.json` | stock DeepSeek 独立实验 Agent；替换工作区占位值 |
| `examples\openclaw.copilot.json` | stock Copilot GPT 的逐模型配置参考；根据宿主实际目录／账号选择，不保证列出的模型可用 |
| `examples\openclaw.enabled.json` | 旧的模型默认级配置，作用域更广；不是只启用单 Agent 的推荐配置 |
| `examples\openclaw.disabled.json` | 上述模型默认级配置的回退参考；不要用它误改其他 Agent 依赖的默认项 |

旧实验示例显式设置本地 Gateway 执行和 `sandbox.mode="off"`。**不要整份覆盖配置，也不要为了让示例运行而关闭已有必需沙箱／安全策略。** 不满足条件的会话应保留内置 OpenClaw runtime。

## 模型、认证与参数

### DeepSeek

仅支持 provider ID `deepseek`、具体模型 ID 和 `openai-completions`。OpenClaw 负责提供 API-key 认证和准备好的模型路由；不读取独立 DSH 登录或插件配置中的 key。

使用宿主正常支持的 thinking 映射：`off` 关闭，`minimal/low/medium/high` 映射到 DeepSeek `high`，`xhigh/max` 映射到 `max`；不能据此推断任意参数或未来模型行为均兼容。自定义认证、headers、proxy／TLS、非 SSE transport 及无法重现的采样参数会显式拒绝。

### GitHub Copilot GPT

仅支持 `github-copilot` provider 下的具体 `gpt-*` 模型和 `openai-responses`。这不是 `openai` provider 的替代登录，也不要求 DeepSeek key 或 OpenAI API 订阅。

- 复用 OpenClaw 准备的账号 token 及解析出的端点；登录、租户发现、订阅／模型权益由宿主和服务端决定。不要求再次 OAuth 或导出 token。
- 模型 ID、上下文窗口、输出限制和 reasoning 能力来自宿主，不要求出现在旧的 pi-ai 内置目录中。但模型名符合格式不等于账号获得授权。
- 支持可表示且被该模型允许的 `off/minimal/low/medium/high/xhigh/max` 映射；`adaptive`、`ultra`、不受支持的映射及任意采样覆盖会失败。`off` 省略 reasoning 请求，不发送 DeepSeek thinking 参数。
- 保留允许的宿主 integration／editor／organization 等请求身份 headers；Copilot adapter 按用户请求或工具续轮计算 `X-Initiator`。DSH 使用自己的产品 `User-Agent`；显式自定义 `User-Agent` 会被拒绝，不保证与 OpenClaw HTTP 实现逐字节相同。
- Copilot 的加密 reasoning 签名、response ID、opaque message／tool item ID 在原生持久化前清理；保留稳定的工具调用与结果关联。未签名 reasoning 仍保持 reasoning 类型，由 Responses serializer 从重放请求中省略，不冒充 assistant 正文。
- 原生 DSH 历史不会自动执行 OpenClaw 转录 hooks；插件实现自己的回放清理。非法或未清理的导入历史失败关闭。尾随 reasoning 空白的流式处理不会把实际内容改写当成正常结束。

**模型继承不等于同会话迁移。** 改 runtime、模型、provider、账号／token、端点、请求身份或会话归属后，使用 **`/new`**。已有原生历史不会被重写为另一个账号／模型的对话。

## 插件配置项

位置：`plugins.entries.dsh-native.config`。接受下列基础字段，以及上文说明的可选 `toolAllowlist`、`taskPreparation`；未知字段报错。默认值以 `openclaw.plugin.json` 和 `src\config.ts` 为准。

| 字段 | 默认值 | 约束／用途 |
| --- | --- | --- |
| `stateDir` | 用户主目录下 `.openclaw\dsh-native` | 必须为绝对路径；保存私有绑定和 DSH 状态，不是工作区 |
| `startupTimeoutMs` | `60000` | 子进程启动等待；整数毫秒，`100..3600000` |
| `shutdownTimeoutMs` | `15000` | 子进程关闭等待；同上 |
| `streamIdleTimeoutMs` | `120000` | 桥接事件流空闲等待；同上，不是整个任务的总时限 |
| `allowedBaseUrls` | `["https://api.deepseek.com"]` | DeepSeek 精确端点列表，非空 |
| `allowedCopilotBaseUrls` | 下列四个端点 | 与 DeepSeek 分开校验的 Copilot 精确账号端点列表，非空 |
| `operationalBudget` | 未设置 | 可选的每次尝试预算，五项正安全整数必须全部配置 |
| `operationalBudgetByAgent` | 未设置 | 至多 64 个精确 Agent ID；与全局预算及可信尝试预算逐项取较小值 |

Copilot 默认列表：

```json
[
  "https://api.individual.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
  "https://api.githubcopilot.com"
]
```

如宿主解析出其他经批准的企业／数据驻留端点，只把该**精确 HTTPS URL**加入对应列表；不是域名通配、路径前缀或任意代理授权。URL 会规范化并去除尾部 `/`，不能含用户名／密码、query 或 fragment。只允许明确列出的 HTTP loopback 开发 fixture，不接受任意明文远程端点。

这些选项不改变模型选择、认证、全局默认或工具策略。启动慢时可调整启动超时，但不要用更长超时掩盖路由、权限或会话连续性错误。

### 可选执行预算

以下是放入 `plugins.entries.dsh-native.config` 的**示意片段**，不是直接覆盖运行配置或推荐的成本额度。先按实际宿主模型窗口和测试活动调整，再在维护窗口启用：

```json
{
  "operationalBudgetByAgent": {
    "dsh-experiment": {
      "maxModelRequests": 8,
      "maxInputTokens": 4000000,
      "maxOutputTokens": 16000,
      "maxToolCalls": 16,
      "maxDurationMs": 120000
    }
  }
}
```

五个字段都必须是大于零的安全整数。它们不授予工具；零工具任务通过宿主／隔离工具目录控制，不是把 `maxToolCalls` 写成零。未列出的 Agent 只继承全局预算；全局也未配置时不启用预算。任何更具体的可信上限都只能收窄，不能放宽。

每次**物理模型请求**前保守预留完整 `contextWindow` 的输入额度，而不是按字符猜测 token；剩余额度小于窗口时，即使提示很短也会拒绝派发。已知 usage 包含缓存输入和 reasoning 输出；输出上限按累计剩余额度收窄。缺失或不确定 usage 保留持久化预留并隔离后续重放，不当作零消耗，也不改用其他提供商重试。这依赖受支持提供商遵守声明的模型窗口和输出上限，不是独立的账单担保。

`maxDurationMs` 到期停止准入并请求取消，**不等于远端模型／宿主工具已停止**；实际未确认收敛时保留隔离，不把等待超时当作清理成功。验收 runner 的 case／campaign 分配仅是上限；适配器必须在每次派发前证明已安装的运行时预算能容纳剩余额度与剩余时间，runner 不会自行改插件配置。额度过小、未知消耗或缺少证明都明确阻断。

独立评审未配置预算 root 时，控制器总时限默认是 120 秒，并受该 case 的 `limits.timeoutMs` 限制。RC3 私有 scope 可用 `reviewCaseBudget.maxDurationMs`，兼容旧 `reviewOperationalBudget.maxDurationMs`；`reviewAttemptBudget` 单独描述原生单次上限。只提供 attempt 时，case 资源额度按轮数推导、时限取 case timeout；评审按一次计算。初始化、资源和认证准备都计入同一个绝对截止时间，必须为已配置的原生执行上限留出余量；这些分配不会修改插件的原生时限或请求、token、工具额度。

## 能力边界与 Dashboard

支持普通前台文本输入、文本工具结果。没有显式扩展收窄名单时，默认使用宿主实际提供并允许的核心 coding 工具：

```text
read  edit  write  apply_patch  exec  process  grep  glob  find  ls
```

这是默认工具家族，**不是承诺每次都提供所有工具**。显式 `toolAllowlist` 可选择兼容的宿主搜索及标准插件工具，实际目录仍来自 OpenClaw 的策略过滤、审批与工具执行 hooks。DSH 不自行补充原生 shell、搜索实现或插件连接。

已知 safe-deny 例外仅有：

```text
sessions_list  sessions_history  sessions_send  session_status
```

这些能力在 callback host 和 DSH 中都不存在，因此可以保留对应 deny；这不授予任何 session 工具。旧默认模式仍在推理／工具构造前拒绝其他显式 native-surface 限制；使用顶层 `toolAllowlist` 时，保留原限制并由宿主工具构造、过滤和绑定后的派发执行。**不要删除原有 deny／审批规则来让 DSH 启动**；不兼容时使用内置 runtime。

不支持／不授予：

- browser／多媒体、主动或跨目标消息投递、cron、subagent／delegation、需要额外 authority 的插件工具 grants；
- 尚未由宿主安全物化的 requester MCP 工具，以及需要不受支持会话／审批上下文的工具；
- skill-library authoring／Skill Workshop；读取宿主提供的 skill 指令不等于获得额外工具；
- 自定义 context engine／外部 compaction、会话迁移／fork；受控 DSH 原生压缩见 0.6.0 说明；
- 媒体输入或非文本工具结果、Code Mode、live steering、会话权限覆盖；
- remote／node／sandbox 执行放置、定时运行权限及 detached durable job scheduling。

使用 `legacy` context engine、普通前台轮次和符合既有策略的本地 Gateway 工作区。取消可以终止活动尝试，但恢复不是重启中断的操作系统进程或命令栈。

**Dashboard 0.3 兼容性**：普通用户 `chat.send` 可以带 `taskSuggestionDeliveryMode="gateway"` 和可选 `skillLibraryAuthoring` authority。插件接受这个已知 delivery mode、保留 active-handle 元数据，但不会调用或转交 authoring authority，也不添加 suggestion、messaging 或 skill-management 工具。未知 delivery mode 和显式 Skill Workshop 工作流仍失败关闭；这不是对内部系统轮次的普遍兼容承诺。

### 定时任务的显式归属修复

DSH 的定时权限限制仍然保留，不会因异常自动换用其他 harness。源码中的 `scripts\cron-ownership.mjs` 提供离线 `plan`／`check`，用于审阅将指定 isolated `agentTurn` 任务交给独立、显式绑定 `openclaw` 的定时 Agent；**这不是 DSH 新增 cron 支持，也不会迁移前台 Agent**。该操作者脚本不随 npm 插件包分发。

必须先批准具体任务、新 Agent 和独立 `agentDir`，并由可信宿主适配器逐项证明认证主体、模型授权、工具／用户权限及实际投递范围不变。不能复制凭据、借用默认 Agent 的认证来冒充等价授权，或复用旧会话转录。新定时 Agent 的 heartbeat 保持关闭；旧显式 isolated 绑定需要单独确认清除。

计划绑定最新完整私有快照及宿主 CAS 标识，仅修改任务的 `agentId` 和必要的 `sessionKey`。已暂停任务保持暂停，不能有待运行时间或活动执行；启用任务必须处于安全空闲窗口。不会修改 `enabled`、时间表或手动运行任务。并发暂停／恢复会使旧计划失效；不能恢复旧备份来重新启用任务。CLI 不提供 `apply`；可导入的 apply 帮助函数仍需可信操作者适配器和准确计划批准。跨配置与多任务更新不是原子事务，发生部分写入或结果不明时停止并对账，不盲目重试或自动回滚。

## 原生状态、锁与恢复

默认状态根位于用户主目录 `.openclaw\dsh-native`。每个宿主会话使用哈希目录、独立 `DSH_HOME`、原生会话和 `binding.json`。宿主转录是可见镜像；真正的续轮历史由 DSH 保存。

- 绑定包含版本、工作区、原生身份、已消耗 attempt 和路由／账号指纹，不保存明文 token。指纹不是可直接使用的登录凭据，但绑定仍是应保护的私有元数据。
- 原生执行前记录 `running`；完成持久化并确认关闭后才变为可复用的 `ready`。已提交后的失败可能变为 `blocked`。
- 失败绑定可保留固定原因码、子进程阶段及准备请求／回调是否完成的 `failureDiagnostic`。它不保存回调错误原文或请求正文；只读 `inspect-state` 仅投影允许的字段。诊断不是恢复授权，也不证明外部副作用已停止。
- `owner.lock` 防止并发所有者。中断、崩溃、无法确认子进程终止或外部副作用时，不自动重放，也不自动删除锁／绑定／历史。
- OpenClaw 镜像与原生历史不一致、已有镜像但原生状态丢失、重复 attempt 或路由／工作区变化均失败关闭，不能默默新建空历史冒充续聊。
- `/new`／reset／disable 不自动清理旧原生状态。旧状态保留供操作者检查，不代表可以继续使用。

恢复优先选择：停止旧工作、核对外部文件／命令副作用，然后 **`/new`**。只有确认旧宿主、子进程和工具都已停止，才由操作者评估遗留锁；不要通过自动删锁、修改 `blocked`／`running`、清空绑定或删除历史强制重试。不确定结果不是“可以再执行一次”的授权。

## 停用、回退与升级

所有变更仍遵循“停止活动工作 → 停止共享 Gateway → 配置／制品维护 → 启动 → 新会话”。

### 只取消一个 Agent 的 pin

```powershell
openclaw config unset agents.entries.dsh-experiment.runtime.harness
```

也可把 runtime **整个对象替换**成 `{"type":"embedded"}`；合并一个省略 `harness` 的对象不会删掉旧字段。取消 pin 后恢复宿主原有模型／provider 选择，**未必是内置 runtime**：此前的逐模型 pin 可能再次生效。

在仍打补丁的宿主上，如果需要明确指定内置 runtime：

```powershell
openclaw config set agents.entries.dsh-experiment.runtime.harness openclaw
```

`auto`／`default` 不是合法的 harness pin；使用删除字段的方式解除选择。

### 停用插件

先处理所有仍显式选择 DSH 的配置。旧模式只修改目标 Agent 的相关 `models[...].agentRuntime`，保留其他字段；不要顺手改全局模型默认或其他 Agent。如果其他 Agent 仍依赖 DSH，不应全局停用插件。

```powershell
openclaw plugins disable dsh-native
openclaw gateway start
```

重新启用则在维护窗口使用 `openclaw plugins enable dsh-native` 并恢复所需 runtime 选择。启用／停用都不迁移历史；继续工作必须 `/new`。普通 DeepSeek／Copilot provider 与插件独立，不必删除其认证。

### 恢复 stock 宿主

保持 Gateway 停止，先从配置中删除本补丁引入的所有 `runtime.harness` 字段，包括值为 `openclaw` 的字段；按备份恢复原有 runtime 选择，再执行：

```powershell
node .\host-patch\apply.mjs --root $HostRoot --restore --offline-confirmed
node .\host-patch\apply.mjs --root $HostRoot --check
```

成功检查应报告 `unpatched`，然后才启动。保留宿主目录中的 `.dsh-agent-harness-patch` 备份和事务 receipt；不要删除它们来“解决”恢复失败。

### 升级

备份当前可回退的插件制品和配置，在停机窗口构建／安装新包。OpenClaw 升级可能替换补丁文件：先规划恢复／迁移，重新核对目标制品，不把旧补丁强加给新版本。发生 `partial` 时保持停止并按补丁文档恢复，不能带半套补丁启动。

0.1 的旧绑定缺少后续版本的模型／账号指纹；保留但不静默迁移。无论升级、切 runtime、换模型还是换账号，都使用 `/new`，不要直接重放旧任务。0.5.1 保留此前模型归属、最终正文及 reasoning 尾部空白的修正，不需要也不建议对运行中的安装做零散 JS 替换。

## 安全与公开发布

- 模型凭据由宿主准备，仅通过**收窄的子进程环境**传入模型适配器，不通过启动参数、插件配置、持久化 profile 或 binding 明文传递。子进程本身及具备相应系统权限的进程仍可能读取环境；这不是秘密对恶意本机代码的隔离。
- 仅有限的非秘密 Copilot 请求身份 headers 可进入 profile；`Authorization`、`Cookie` 和任意 headers 不被当作持久化配置接受。不要把 token 放进任何示例、命令行或 Issue。
- 凭据指纹不等于凭据，也不意味着整个目录可公开。工作区、原生历史、宿主转录、配置、补丁 receipts、日志和诊断输出都可能含隐私。不要上传真实用户路径、账号、IP、会话标识、部署配置或操作回执。
- coding 工具可能修改文件或执行程序；callback-only 限制不是对恶意依赖的沙箱。信任并保护宿主、插件包和状态文件，保留既有策略，不在敏感工作区试验。
- token 计数来自 provider 报告；结果中的零 cost 是 **unpriced**，不代表免费推理或权威账单。

公开问题请提交最小、脱敏、可复现的 fixture 与版本信息；不要附完整用户状态包。所有本项目作者／仓库链接使用 `ericzhaouu`，上游项目保留真实所有者和许可证。

## 开发与测试

### 安装包验收与 CI

安装包检查器只读取显式指定的 `.tgz`，不会重新构建、打包，也不依赖干净克隆中并不存在的历史安装包：

```powershell
npm.cmd run test:package
npm.cmd run package:check -- --package C:\PATH\TO\openclaw-dsh-native-<version>.tgz
# optional: --expected-sha <sha256> --root C:\PATH\TO\BUILT\WORKSPACE
```

`scripts\check-package.mjs` 输出安装包及各文件的 SHA-256、大小和问题清单。检查归档结构、截断／非法路径／链接、重复条目、必要入口、依赖及 manifest 一致性、夹带宿主／测试／私有配置和敏感内容。`--root` 比较已构建工作区与归档的实际字节，并拒绝链接越界；不要拿旧安装包与已修改的源码比较后声称制品一致。

### 行为用例与预演

固定语料包含 56 个单轮案例的三种表达、8 组四轮对话和 12 个飞书通道案例，共 **212 次计划用户输入**。这是待执行语料，不是 212 次通过记录。编译后为 188 个用例单元，多轮脚本保持分组；评分规则保存在单独的 `oracles.json`，不得混入模型输入。

历史字节合同分别固定旧语料的 CRLF 和测试资源的 LF。编译器仅接受已审阅哈希对应的这两种换行表示，并按该合同物化后计算语料／资源哈希；不对未知改动做通用归一化或更新旧期望值。`.gitattributes` 固定相应路径的换行规则，测试插件副本独立设置安全文件权限，不修改源依赖或关闭宿主的可写路径保护。

```powershell
$PlanRoot = Join-Path $env:TEMP ("dsh-acceptance-" + [guid]::NewGuid().ToString())
npm.cmd run acceptance:compile -- --output-root $PlanRoot
npm.cmd run acceptance:dry-run -- --manifest "$PlanRoot\manifest.json" --run-root "$PlanRoot\runs"
```

预演只验证格式并输出 `planned`、`passed: false`，不调用模型、不连接飞书。`acceptance:evaluate -- --report <report.json>` 会拒绝把预演当验收证据。`local-fixture-adapter.mjs` 只用于评分器自测，不能作为真实 Agent 成功证明。

真实执行必须显式使用 `--execute --live --trusted-capable-adapter --adapter <绝对模块路径> --scope <私有授权文件>`。源码中的 `gateway-acceptance-adapter.mjs` 验证真实 Gateway 最终帧、规范转录、当前原生 epoch、工具回执与用量，不能用历史正文伪造实时送达，也不能代替飞书平台回执。生产配置、SDK 路径、逻辑 Agent 映射通过私有 `DSH_ACCEPTANCE_GATEWAY_CONFIG` 指定，不自动发现或复制账号凭据。

全量负向语料应使用 `isolation:"agent-policy-read-only"` 的专用 `dsh-acceptance-*` 测试 Agent：宿主级工具清单仅允许 `read/grep/glob/find/ls`，文件工具限制为工作区内。0.7.1 仍拒绝会话级权限覆盖；不能删除这条限制或在现有业务 Agent 上仅靠“不要写入”的提示词运行负向语料。隔离角色的结果须明确标注，不能冒充原有 Agent 的个性化／业务集成验收。

编译结果以 SHA-256 绑定独立 `oracles.json`；隐藏评分标准、夹具真值不传给被测模型。编译语料还要求 `--reviewer <绝对模块路径>`、私有授权中的 `trustedIndependentReviewer:true` 与独立 `reviewBudgets`。`gateway-corpus-reviewer.mjs` 经宿主公开的模型／认证准备与 **零工具独立补全**评分，配置由 `DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG` 指定；评审进程必须显式设置相同的 `OPENCLAW_STATE_DIR`／`OPENCLAW_CONFIG_PATH`。评分逐条覆盖断言并绑定观察证据哈希；被测执行器自行返回的“全部通过”布尔值不能替代评分。评审模型本身不是事实正确性的保证，应保留原始回执供人工复核。

私有资源映射只提供当前 Agent、当前用例选择的地址或明确可见数据；不得把 oracle／标准答案放入被测输入。`modelVisibleRequiredTokens` 是语料的**提示词覆盖锚点**，不是要求答案照抄的词。缺失真实重复投递／重连控制回执必须记为阻塞，不能用平台发送幂等键替代适配器重复事件验收。

文件／表格路径的 JSON 内容也会在资源准入时检查：即使 SHA-256 匹配，包含 `oracle`、`answerKey`、`groundTruth` 等隐藏评分字段的文件仍会被拒绝。应只将源夹具的 `modelVisible` 数据写入独立公开文件，对该文件计算单独的资源哈希；完整夹具、评分侧文件及其原始哈希保留在被测 Agent 无权读取的位置。加载器不会自动改写或删除原始夹具，也不把文件正文直接塞进提示词。

执行与评分预算分别受私有授权约束；未计价必须标记为 `unpriced`。取消、未确认副作用、清理失败或不完整评分均不能算通过。适配器是受信任本机代码，JavaScript 信号和逻辑工具清单都不是操作系统沙箱。

报告分别记录执行、业务结果、权限、Skill 加载／遵循、交付和耗时。零副作用等关键门槛不能由总体 95% 成功率抵消；样本少于 20 时不宣称测得可靠的 p95。事实、引用和方法质量需要实际工具记录及独立评分，不能仅凭模型自称完成。

V2 报告将业务、模式和结果不匹配记入独立的策略／期望指标；用例与关键用例仍失败，但不因此单独宣称发生了安全违规。实际副作用、授权、评分来源与证据完整性错误仍失败关闭。

Gateway 的 `duplicate_inbound_delivery` 默认仍重复当前轮请求。显式 `controlVersion: 1` 配合 `replaySourceTurn` 才会取用本用例内此前已结算的输入载荷，包括当时的资源上下文；目标轮自己的幂等键用于验证重复提交。回执分别绑定原始／实际载荷哈希及 reset 边界，控制说明不作为用户业务输入发送。这是 Gateway 控制证据，不代替真实飞书重连或业务写入幂等证明。

### RC3：v4 语料与 campaign 等待恢复

以下使用源码仓库实际入口；验收脚本／语料不是 npm 安装包中的通用运维命令。先用 `node .\scripts\compile-acceptance.mjs --help`、`node .\scripts\run-acceptance.mjs --help`、`node .\scripts\run-acceptance-campaign.mjs --help` 核对当前参数和私有配置结构。

v4 文件是 `tests\acceptance\cases\v4\single-turn.json`、`multi-turn.json`、`feishu-canary.json` 与 `review-map.json`，保留基线来源、审阅原因及逐轮期望。v4 是**源语料版本**，不是 `--contract-version 4`；下面只编译／预演，不调用模型或飞书，也不产生通过证明。输出目录须为新的私有绝对路径：

```powershell
$PlanRoot = 'C:\PRIVATE\rc3-v4-plan'
node .\scripts\compile-acceptance.mjs --output-root $PlanRoot --source-corpus-version 4 --contract-version 2
node .\scripts\run-acceptance.mjs --manifest "$PlanRoot\manifest.json" --run-root "$PlanRoot\runs" --dry-run
```

`scripts\run-acceptance-campaign.mjs` 的公开子命令只有 `prepare`、`start`、`resume`、`status`；`--detach` 仅用于 `start`／`resume`，没有额外的 `--wait`／`--budget`／`--timeout` 开关。健康等待与预算由 `--config` 指向的私有 JSON 配置；`--help` 列出完整结构。先固定候选源码、已构建 runtime／host dist、依赖制品和 SHA-256 pins，再 prepare；版本元数据变化也会使旧 pins 失效，不能直接复用旧准备结果。

必须显式配置独立 adapter／reviewer、manifest／oracles、授权 scope、健康端点及子进程 `env`，不自动继承 ambient 环境或发现凭据。内建预算策略使用已有共享 `budget.accountRoot`、固定哈希的 authorization／baseline；不能为新 campaign 复制／重置账户。campaign root 必须在冻结的 source root 之外；Windows 私有 ACL 须由操作员预先配置，不宣称目录 fsync 已认证。

以下模板需要这些前置条件；`start`／`resume` 可能调用模型，只有取得授权后才能运行。此次版本准备不执行这些命令：

```powershell
node .\scripts\run-acceptance-campaign.mjs prepare --config C:\PRIVATE\rc3-campaign-config.json
node .\scripts\run-acceptance-campaign.mjs start --root C:\PRIVATE\rc3-campaign --detach
node .\scripts\run-acceptance-campaign.mjs status --root C:\PRIVATE\rc3-campaign
# 审计旧执行并确认需要恢复后：
node .\scripts\run-acceptance-campaign.mjs resume --root C:\PRIVATE\rc3-campaign --detach
```

- **等待而非强制重启**：仅明确的临时健康故障退避重试，认证／配置错误不重试；健康成功要求连续样本（默认且至少 3）。`health.totalWaitMs` 到期持久化 `paused / health-wait-expired`。这不是覆盖所有静态工作的硬超时，也不重启 Gateway。
- **显式恢复、不重放**：`start` 不接管旧 claim；`resume` 先核验旧 controller／child 的 PID 与 OS 启动身份、journal、回执、report 和 dispatch ledger。心跳陈旧不等于进程已死；已派发、成功或结果未知的 case 不自动重跑。完整证据可补结算；身份、用量或副作用不明仍隔离，不删锁“修复”。
- **看证据而非退出码**：前台仅 `completed` 返回 0，`paused`／`failed` 返回 1；`completed` 也可能包含已结算的失败／阻塞 case。后台 `launch-requested` 与 `status` 的成功退出不证明运行中或通过。核对 `campaign.json`、`pins.json`、`status.json`、`controller.jsonl`、`receipts` 和 `cases` 下实际 run 的 `report.json`／适用的 `gateway-acceptance-ledger.jsonl`；预算事件在同一 `controller.jsonl`，不是另一个 `budget.json`。

### RC3：case、attempt 与共享预算

`scripts\run-acceptance.mjs --help` 中的私有 scope 分开 `caseBudget`／`attemptBudget`，评审使用 `reviewCaseBudget`／`reviewAttemptBudget` 和独立 `reviewBudgets`。显式 case root 优先于兼容的 `operationalBudget`（评审为 `reviewOperationalBudget`）；在该情况下旧键可作为 attempt 上限的 fallback。未启用预算的 legacy/default 执行仍为 `unattested`，不自动改变运行时默认值。

内建 campaign 预算把 T 轮 DUT 分为 T 份原生 attempt，另为一次 reviewer 预留；两者在子进程派发前一起持久化。共享 `userTurns` 只计 DUT 输入，评审的物理请求和 token 仍记账。共享 input 是 input＋cache-read＋cache-write 的**一次聚合额度**，不是给各报告字段再授权三份或六份。历史已知消耗与未结算暴露均占用同一授权账户。

`prepare`／执行前静态预检核对已安装的全局与 exact-Agent 原生 cap，并要求 primary／全部 fallback 模型显式声明完整 `contextWindow`；不会替操作员扩大 cap。每次派发还必须证明有效原生上限适配剩余 case／campaign 额度、完整窗口及剩余时间。`budget.caseSetupMs`／`reviewSetupMs` 各须是大于 25 的整数，`runnerTimeoutMs` 须大于 DUT、reviewer 原生时长与各自 setup 余量之和；这些是等待／分配配置，不是新的原生额度。

`runnerTimeoutMs` 到期**不杀子进程，也不证明远端已停止**；未结算执行保留暴露并暂停。成功静态预检不能代替实际 runtime ledger、完整 accounting 与 quiescent cleanup 证明；未知消耗不能当作零，实际超额不能裁剪为预留数，溢出失败关闭。不得用调大等待时间、重置 baseline 或重复发送绕过预算／所有权隔离。

### 有界原生运行压测

```powershell
npm.cmd run soak:dry-run
node .\scripts\run-native-soak.mjs --execute --turns 4
node .\scripts\run-native-soak.mjs --execute --turns 200
node .\scripts\run-native-soak.mjs --execute --stability --turns 200 --keep-artifacts
```

压测显式执行后使用真实 DSH 子进程和本地合成模型，交替运行两个隔离身份、定期切换原生状态 epoch；不会访问生产账号。它不替代真实 Gateway／飞书端到端压力测试。启动失败必须失败，不能因为环境异常自动算通过；子进程 RSS 未测量时也不得冒充已观测。

`--stability` 使用两个并发轮次且保持各自同一原生 epoch，不用定期重置掩盖长会话问题。Linux 从所属子进程的 `/proc` 采样 RSS、FD、进程数量，记录静止边界的父进程内存趋势、延迟和每批回执；失败或所有权未确认时保留证据。内存趋势是观测值，不是一次短测便可宣称“绝无泄漏”；非 Linux 平台不伪造资源测量。压缩／断流／取消等故障还需配套专门用例。

`.github\workflows\test.yml` 在 PR 上默认只运行纯 Node 安装包检查器测试矩阵（Windows／Ubuntu，Node 22.23.1／24.15.0），不依赖真实账号或 SDK，也不等于当前源码包已通过全部验收。完整 SDK 工作流仅在 `workflow_dispatch` 启动，需要配置 `OPENCLAW_SDK_ARTIFACT_URL`／`OPENCLAW_SDK_ARTIFACT_SHA256` 或对应输入；只接受 OpenClaw 官方 GitHub Release／Actions 制品，内部 SDK 包摘要固定为 `3431f4cd2d8dbd6b936def2694ac27e19fa0256295cf4ada0f652ecf1c9ee520`。未配置或下载失败会明确失败，不能显示虚假的全量通过。工作流不发布、不打标签、不运行真实账号用例，也不使用 `pull_request_target`。


先按上文提供精确官方 optional peer SDK，再运行仓库已有命令：

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd pack
```

`npm test` 使用 Node 内置 test runner：`node --test --test-concurrency=1 tests/*.test.mjs`。部分测试引用 `dist`，所以测试前应构建；不要仅通过源码测试就认为打包内容已验证。

覆盖范围包括：

- 配置、路由、工具 schema／策略、JSON-RPC、worker profile／流式行为；
- 原生绑定、并发锁、超时／取消、崩溃后的拒绝重放与镜像连续性；
- Copilot reasoning／opaque ID 清理、两种模型协议的本地 HTTP／SSE fixture；
- `native-sdk.test.mjs` 对真实 OpenClaw 2026.9.2 公共 SDK 导出的 smoke 检查；
- 实际 OpenClaw local-agent CLI、真实宿主 read 工具、DSH 循环、第二轮续聊及插件停用；
- 复制官方宿主后应用哈希补丁的集成 fixture、Agent 默认模型继承／fallback ownership；
- 实际 Dashboard `chat.send` 路径的隔离 Gateway fixture、普通用户任务建议元数据兼容。

fixture 使用项目拥有的隔离配置／状态、本地模型服务和合成凭据；不需要生产账号。**这不是对真实 GitHub 登录、订阅、模型权益或服务端请求成功的测试，也不是共享生产 Gateway 的验收。**

历史测试数量不能充当当前工作树的通过证明。请针对所使用的提交执行上述命令，并记录实际 Node／SDK 制品及测试结果。

## 仓库结构

```text
dsh-native\
  README.md                    中文完整指南
  USAGE.txt                    随包使用说明
  package.json                 包元数据、脚本、optional peer
  npm-shrinkwrap.json           固定依赖解析
  openclaw.plugin.json          插件声明、激活方式及配置 schema
  tsconfig.json                TypeScript 构建配置
  src\
    index.ts                   插件注册
    config.ts                  配置解析与默认值
    native\                    宿主 harness、工具、路由、转录和连续性
    runtime.ts                 子进程、绑定、锁与生命周期
    bridge\                    DSH profile、worker、流式和回放校验
    protocol.ts / rpc.ts        私有桥接协议
  host-patch\
    spec.mjs                   精确宿主哈希与变更规格
    apply.mjs                  check / apply / restore 事务工具
    USAGE.txt                  离线补丁维护说明
  examples\                    需按作用域审阅的配置片段
  tests\                       单元及隔离集成测试
    fixtures\                  本地协议服务及精确 SDK 宿主副本
  dist\                        构建输出，不是源代码入口
```

本地生成的归档、准备目录、私有状态和操作记录不是公开源码使用指南的一部分。

## 排错

以下多数是错误消息而非稳定错误码；以实际上下文为准。

| 现象／消息 | 检查与处理 |
| --- | --- |
| `runtime.harness` 配置校验失败 | stock 宿主没有这个字段；确认实际 Gateway 包已完整应用精确补丁，或使用逐模型兼容模式。不要先在运行配置中试写 |
| 补丁哈希不匹配／`partial` | 保持停机；核对 `spec.mjs`、原始备份及 receipt。未知构建或修改不能强行覆盖 |
| 安装 optional peer／registry 解析失败 | 使用经核验的本地 SDK 制品；生产安装可选已准备目录，不猜版本、不重写共享宿主依赖 |
| 缺少 `openclaw/plugin-sdk/...` | optional peer 不等于 SDK 已存在；开发目录需提供精确 2026.9.2 制品 |
| `requires explicit dsh-native selection` | 启用插件不足以选中它；检查 Agent pin 或逐模型 runtime，再用新会话 |
| `requires a concrete ...`／pinned harness incompatibility | 仅支持 DeepSeek Chat Completions 和 Copilot GPT Responses；保留 pin 会拒绝不支持的候选，不自动退回其他 runtime |
| 缺少 host-resolved key／prepared token | 在 OpenClaw 的正常认证流程中解决；不要给插件填 key，也不要导出凭据 |
| `baseUrl is not allowed`／`account endpoint is not in allowedCopilotBaseUrls` | 检查宿主解析出的完整端点，仅将可信精确 URL 加入对应 allowlist |
| explicit tool-policy restriction／`Unsupported non-core coding tool` | 保留策略，检查是否使用不支持的权限或工具家族；必要时回到内置 runtime，不移除安全限制 |
| sandbox／remote placement 不支持 | 使用符合组织政策的本地实验环境；若必须沙箱／远端执行，则不要用本插件 |
| 模型／账号指纹变化、ownership 冲突 | `/new`；不要把新模型继承理解成旧原生会话迁移 |
| `OpenClaw mirror and native history no longer agree`／`Cannot resume a missing DSH session` | 核对原状态完整性或 `/new`；不造空绑定、不删历史强行续聊 |
| `owner.lock`、uncertain outcome、already submitted | 确认旧进程／工具已停止并核对副作用，使用新会话；禁止自动解锁重放 |
| 启动／关闭超时、unconfirmed termination | 检查实际 Node、依赖、子进程和工具状态；必要时维护窗口处理，不靠反复提交重试 |
| `working directory exceeds the Windows process limit` | 为 `stateDir` 选择更短的绝对路径；Windows 可读写长路径并不代表可用它启动子进程。运行时会在生成绑定或启动前拒绝过长目录，不自动迁移旧状态 |
| reasoning mapping／custom transport 被拒绝 | 保留宿主要求；选择可支持的模型／参数或内置 runtime，不静默忽略参数 |
| `INVALID_ARGS`／`HOST_TOOL_ERROR` | 检查宿主工具 schema、实际工具结果和授权；模型声称成功不能代替结果 |

补丁锁的 `--recover-stale-lock` **只用于补丁事务锁**，不用于原生会话的 `owner.lock`，也不负责关闭 Gateway。

## 致谢与许可证

- [OpenClaw](https://github.com/openclaw/openclaw)：原生 harness SDK、模型／认证准备、工具策略和会话基础设施。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：DSH 模型／工具循环、原生会话及适配器。保留上游 `deepseek-ai` 所有者，不将其改写成本项目作者。
- [GitHub Copilot 官方文档](https://docs.github.com/en/copilot)：账号、模型可用性和订阅规则以官方说明为准。

本项目是独立的实验性集成，不表示上述上游为其背书。

**MIT License — Copyright (c) 2026 [ericzhaouu](https://github.com/ericzhaouu).**
宿主补丁模板中的上游派生片段保留 OpenClaw Foundation 的 MIT 版权声明，见 [LICENSE](LICENSE)。上游及第三方依赖保留各自版权声明和许可证。问题与源码改进请提交至 [ericzhaouu/dsh-native](https://github.com/ericzhaouu/dsh-native)，且只附脱敏内容。
