# DSH Native for OpenClaw

**实验性版本 0.3.0**：把官方 DeepSeek Harness（DSH）的模型／工具循环接入 OpenClaw 的原生 `AgentHarnessV2`，并保留 OpenClaw 对模型、认证、工具授权与会话入口的控制。

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
OpenClaw：参数校验、工具授权／审批、执行钩子、核心 coding 工具
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

确认所用源码的 `package.json` 版本为 `0.3.0`。本项目把 OpenClaw 声明为 **optional peer**，避免在生产插件内部自动安装第二份宿主；开发／类型检查／真实 SDK 测试仍需要匹配的 SDK。

若开发目录尚未提供精确 SDK，先从 [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)的发行流程取得并验证上述 **2026.9.2 官方制品**，然后本地安装：

```powershell
npm.cmd install --no-save --package-lock=false "C:\PATH\TO\openclaw-2026.9.2.tgz"
$DevHost = (Resolve-Path .\node_modules\openclaw).Path
node .\host-patch\apply.mjs --root $DevHost --check
npm.cmd run build
npm.cmd pack
```

`--check` 只检查，不会应用补丁。未修改的匹配制品应报告 `unpatched`。如果所用 registry 没有这个版本，应使用已核验的精确官方制品，**不要猜测可用的 npm 版本、改用最新预览版或伪造 SDK 类型**。无法取得匹配制品时，应停止需要该 SDK 的构建／集成验证。

`npm pack` 的 `prepack` 会再次执行构建，生成本地 `openclaw-dsh-native-0.3.0.tgz`。不要把开发目录中的 OpenClaw SDK、账号或会话状态随插件复制出去。

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
openclaw plugins install "C:\PATH\TO\openclaw-dsh-native-0.3.0.tgz" --force --accept-capabilities
```

`--force` 用于确认本地来源／覆盖安装；`--accept-capabilities` 是官方安装器对声明能力的接受选项，**仅用于已审阅并信任的代码**，不是规避安全策略。先阅读安装器说明和能力提示，不要无条件接受陌生代码。归档安装会处理运行依赖；已有 provider 及认证应留在 OpenClaw，不填入插件设置。

**若 managed npm 插件环境在 optional peer reconciliation 阶段失败**，例如试图从缺少精确 SDK 的 registry 解析宿主，不要修改共享宿主依赖或安装猜测版本。可以在独立目录准备完整运行制品，再使用官方目录安装入口：

```powershell
New-Item -ItemType Directory -Path .\artifacts\prepared-dsh-native
tar -xf .\openclaw-dsh-native-0.3.0.tgz -C .\artifacts\prepared-dsh-native
Push-Location .\artifacts\prepared-dsh-native\package
npm.cmd ci --omit=dev
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

位置：`plugins.entries.dsh-native.config`。只有下列字段被接受；未知字段报错。默认值以 `openclaw.plugin.json` 和 `src\config.ts` 为准。

| 字段 | 默认值 | 约束／用途 |
| --- | --- | --- |
| `stateDir` | 用户主目录下 `.openclaw\dsh-native` | 必须为绝对路径；保存私有绑定和 DSH 状态，不是工作区 |
| `startupTimeoutMs` | `60000` | 子进程启动等待；整数毫秒，`100..3600000` |
| `shutdownTimeoutMs` | `15000` | 子进程关闭等待；同上 |
| `streamIdleTimeoutMs` | `120000` | 桥接事件流空闲等待；同上，不是整个任务的总时限 |
| `allowedBaseUrls` | `["https://api.deepseek.com"]` | DeepSeek 精确端点列表，非空 |
| `allowedCopilotBaseUrls` | 下列四个端点 | 与 DeepSeek 分开校验的 Copilot 精确账号端点列表，非空 |

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

## 能力边界与 Dashboard

支持普通前台文本输入、文本工具结果，以及宿主实际提供并允许的核心 coding 工具：

```text
read  edit  write  apply_patch  exec  process  grep  glob  find  ls
```

这是允许的工具家族，**不是承诺每次都提供所有工具**。实际目录来自 OpenClaw 的策略过滤、审批与工具执行 hooks。DSH 不自行补充原生 shell 或搜索工具。

已知 safe-deny 例外仅有：

```text
sessions_list  sessions_history  sessions_send  session_status
```

这些能力在 callback host 和 DSH 中都不存在，因此可以保留对应 deny；这不授予任何 session 工具。其余显式 native-surface 限制会在推理／工具构造前拒绝。**不要删除原有 deny／审批规则来让 DSH 启动**；不兼容时使用内置 runtime。

不支持／不授予：

- `workboard`、browser、MCP、消息／渠道操作、subagent／delegation、插件工具 grants；
- skill-library authoring／Skill Workshop；读取宿主提供的 skill 指令不等于获得额外工具；
- 自定义 context engine／compaction、原生压缩、会话迁移／fork；
- 媒体输入或非文本工具结果、Code Mode、live steering、会话权限覆盖；
- remote／node／sandbox 执行放置、定时运行权限及 detached durable job scheduling。

使用 `legacy` context engine、普通前台轮次和符合既有策略的本地 Gateway 工作区。取消可以终止活动尝试，但恢复不是重启中断的操作系统进程或命令栈。

**Dashboard 0.3 兼容性**：普通用户 `chat.send` 可以带 `taskSuggestionDeliveryMode="gateway"` 和可选 `skillLibraryAuthoring` authority。插件接受这个已知 delivery mode、保留 active-handle 元数据，但不会调用或转交 authoring authority，也不添加 suggestion、messaging 或 skill-management 工具。未知 delivery mode 和显式 Skill Workshop 工作流仍失败关闭；这不是对内部系统轮次的普遍兼容承诺。

## 原生状态、锁与恢复

默认状态根位于用户主目录 `.openclaw\dsh-native`。每个宿主会话使用哈希目录、独立 `DSH_HOME`、原生会话和 `binding.json`。宿主转录是可见镜像；真正的续轮历史由 DSH 保存。

- 绑定包含版本、工作区、原生身份、已消耗 attempt 和路由／账号指纹，不保存明文 token。指纹不是可直接使用的登录凭据，但绑定仍是应保护的私有元数据。
- 原生执行前记录 `running`；完成持久化并确认关闭后才变为可复用的 `ready`。已提交后的失败可能变为 `blocked`。
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

0.1 的旧绑定缺少后续版本的模型／账号指纹；保留但不静默迁移。无论升级、切 runtime、换模型还是换账号，都使用 `/new`，不要直接重放旧任务。0.3.0 包含此前 reasoning 尾部空白的流式修正，不需要也不建议对运行中的安装做零散 JS 替换。

## 安全与公开发布

- 模型凭据由宿主准备，仅通过**收窄的子进程环境**传入模型适配器，不通过启动参数、插件配置、持久化 profile 或 binding 明文传递。子进程本身及具备相应系统权限的进程仍可能读取环境；这不是秘密对恶意本机代码的隔离。
- 仅有限的非秘密 Copilot 请求身份 headers 可进入 profile；`Authorization`、`Cookie` 和任意 headers 不被当作持久化配置接受。不要把 token 放进任何示例、命令行或 Issue。
- 凭据指纹不等于凭据，也不意味着整个目录可公开。工作区、原生历史、宿主转录、配置、补丁 receipts、日志和诊断输出都可能含隐私。不要上传真实用户路径、账号、IP、会话标识、部署配置或操作回执。
- coding 工具可能修改文件或执行程序；callback-only 限制不是对恶意依赖的沙箱。信任并保护宿主、插件包和状态文件，保留既有策略，不在敏感工作区试验。
- token 计数来自 provider 报告；结果中的零 cost 是 **unpriced**，不代表免费推理或权威账单。

公开问题请提交最小、脱敏、可复现的 fixture 与版本信息；不要附完整用户状态包。所有本项目作者／仓库链接使用 `ericzhaouu`，上游项目保留真实所有者和许可证。

## 开发与测试

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
