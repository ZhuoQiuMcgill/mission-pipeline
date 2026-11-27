# deepseek-harness（dsh）已核实的事实

这是交接文件，记录到 2026-11-27 为止对 deepseek-harness 查清楚的全部事实，供没有上下文的新会话阅读。
本仓库不含 dsh 的代码。需要时从 https://github.com/deepseek-ai/deepseek-harness 克隆。
所有结论都基于 0.2.3-alpha.2（提交 `4b399c3`，2026-11-22）。dsh 平均两天多发一个版本，接口随时会变，用之前先核对当前版本。

来源标记：**【源码】** 在该提交的源码里核实过；**【文档】** 只见于 README、docs 或设计笔记；**【推断】** 由事实推出，没有直接验证；**【未核实】** 没能查到。
路径相对 dsh 仓库根目录；只写文件名的，括号里给出所在的包。

---

## 1. 基本情况

- **仓库**：`deepseek-ai/deepseek-harness`，命令行名 `dsh`，npm 包 `@deepseek-ai/dsh`。启动：`npx @deepseek-ai/dsh web`，默认在 `http://127.0.0.1:3080` 提供 Web 界面。从源码：`pnpm install && pnpm run build && pnpm dsh web`。【文档】README.md
- **许可证**：MIT，"Copyright (c) 2026 DeepSeek"。【源码】LICENSE
- **成熟度**：自称 developer preview，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"。SAFETY.md 写明是实验性软件，没有做过安全审计，沙箱不保证隔离。【文档】
- **规模**：约 2.3 万个文件，TypeScript 的 pnpm monorepo；397 个包，全部在 `@deepseek-ai/dsh-*` 作用域下；约 80 个 `ui-*` 客户端包；`packages/experimental` 下约 60 个实验包，没有支持承诺。【源码】
- **Cordis**：整个系统建在 Cordis 插件框架上，Cordis 以改了作用域的形式放在 `vendor/`（MIT，Copyright Shigma，钉在记录的上游提交）。【源码】vendor/README.md、THIRD_PARTY_NOTICES.md:14-24
- **"万物皆插件"**：插件导出 `name`、`inject`、`apply(ctx)`；服务挂在 `ctx.<key>` 上；事件有 emit、waterfall、parallel、serial、bail 五种模式；每一次注册都是可撤销的；代理循环本身也是一个可替换的插件。【文档】docs/architecture.md:7-11、docs/cordis-primer.md:7-35
- **主干服务**：`ctx.sessions`（只追加的 `SessionEvent` 日志）、`ctx.systemPrompt`、`ctx.tools`、`ctx.agents`、`ctx.agentLoop`、`ctx.llm`。`core/scope` 让注册可以只对某一个代理生效，键就是活着的 `Agent` 对象本身。【文档】docs/architecture.md、docs/subsystems/scope.md

### 组合方式

- **profile** 是一摞 bundle 加上 `cordis.patch.yml` 覆盖层。已有的 profile：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`，另有桌面版。【文档+源码】
- **覆盖顺序**：`dsh.profile.bundles` 里的各 bundle → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 指定的覆盖。覆盖按行的 id 生效，而且会替换那一行的整个 `config`，所以要把想保留的键重写一遍。【文档】docs/architecture.md:25
- **agent preset** 决定一个会话有哪些能力，它就是一份 Cordis YAML，内容是子插件列表（`@deepseek-ai/dsh-agent-preset`，注册表是 `dsh-agent-preset-registry`，默认 `standard`）。Web 的 preset 有 `standard`、`ptc`、`minimal`、`cordis`（`packages/bundle/web-app/presets/`）。改 preset 只影响之后创建的代理。【文档+源码】
- **数据位置**：`$DSH_HOME` 默认 `~/.dsh`，profile 在 `$DSH_HOME/profiles/<name>`。【源码】packages/util/home-paths/src/index.ts:12,71

### turn 和 step

- step 是一次模型请求加上它调用的工具；turn 是零个或多个 step。
- 事件顺序：`turn/start` → `agent/pre-step` → `step/start` → `agent/request` → 流式输出 → `tool/call` → `tools/pre-execute`、`tools/execute`、`tools/post-execute` → `tool/result` → `step/end` → `agent/turn-stopping` → `turn/end`。【文档】docs/architecture.md "Turn flow"
- 给代理输入的四个接口：`send`、`followup`（开新 turn）、`steer`（进下一个 step）、`inject`（加上下文但不唤醒）。【源码】packages/core/agent/src/runtime-types.ts:233-271
- 不变量"模型看得见的，日志里必须有"：每次模型请求都要能从会话日志重建。每条消息带 `source.kind` 标明来源（`user`、`agent-message`、`goal`、`schedule` 等）。【文档】

### 会话日志和持久化

- 默认是 JSONL 加 zstd 校验帧，路径 `~/.dsh/sessions/--<规范化的 cwd>--/<session-id>/session.vN.jsonl.zstd`。它在用户主目录下，不在项目仓库里。【源码】packages/bundle/base/cordis.patch.yml:142-145；【文档】packages/session/session-persistence-jsonl/README.md:60-75
- 当前写入格式是 v4（packages/core/session/src/types.ts:90）。格式迁移一次只升一版，已提交的不重写。另有可选的 SQLite 后端。【源码】
- 不属于会话历史的应用状态用 `ctx.storageDomain` / `ctx.storage`（JSON 或 SQLite）。【文档】

### 压缩

- `compaction-basic` 在三种情况下总结最旧的历史：token 压力、上下文溢出错误、用户执行 `/compact`。它写 `compaction/start`、`compaction/summary`、`compaction/end` 事件，摘要以带 `surfaceOp: replace` 的 `user/message` 替换一段历史。【文档】docs/subsystems/compaction.md
- **触发阈值**：`floor(min(W×0.8, W−O−65,536))`，W 是上下文窗口，O 是输出上限；最新的 16%×(W−O) 原样保留；可按模型用 `modelPolicies` 覆盖。【源码+文档】packages/compaction/compaction-basic/README.md:64-75
  - DeepSeek 的 100 万窗口（W 1,048,576，O 256,000）：约 727,040 token 才触发，保留尾部约 126.8k。【推断：算术】
  - Claude 100 万窗口、O 128k：800,000。
  - 20 万窗口、O 64k：70,464。小窗口很早就压缩。
- 工具结果裁剪（`compaction-tool-result-pruner`）：`thresholdChars` 8192、`headChars` 4096、`tailChars` 1024，只在压缩触发条件满足后才运行。另有图片卸载。【文档】
- 没有任何处理空闲间隔或缓存过期的机制（搜过 keep-warm、cache ttl、idle 等关键词）。【源码：未找到】

---

## 2. 多代理相关

### 2.1 subagent（`ctx.subagents`）

**后端和能力矩阵**【源码：各 provider 的 `capabilities`】

| 后端 | cwd | agentPreset | agentOptions | outputSchema | depthLimit | 后续消息 | 取消 |
|---|---|---|---|---|---|---|---|
| `spawn`（进程内新建） | 有 | 有 | 有 | 有 | 有 | 有 | 有 |
| `fork`（带上级已完成的 turn） | 有 | 无 | 有 | 有 | 有 | 有 | 有 |
| `claude-code` / `codex` / `acp` / 实验性 `oar` | 有 | 无 | 无 | 无 | 无 | 无 | 有（只跑一次） |
| `dsh-sdk`（另起一个 dsh 进程） | 有 | 无 | 有 | 无 | 无 | 无 | 有 |

- 出处：`subagent-spawn-in-process/src/index.ts:39`、`subagent-fork-in-process/src/index.ts:61`、`subagent-dsh-sdk:100`、`subagent-acp:81`、`subagent-claude-code:74`、`subagent-codex:64`、`experimental/subagent-oar/src/index.ts:82`。
- `claude-code` 后端通过 Agent SDK 跑真正的 Claude Code，`permissionMode` 可配（subagent-claude-code/src/run.ts:49,331）。`claude-code` 和 `codex` 后端不在任何默认 bundle 里，只出现在快照夹具中。
- 只有进程内的子代理才能被插件注入工具、设置沙箱和读取用量。外部后端各用各的权限系统。

**`startActivation` 的参数**【文档】docs/subsystems/subagent.md

- `provider`、`label`、`name?`（1 到 32 个小写字母、数字或连字符）、`childId?`（可预留子会话编号）、`signal`、`delivery: 'parent' | 'caller'`。
- `cwd?`（由宿主指定的初始目录，相对路径按上级当前目录解析）、`agentPreset?`、`prompt: ContentBlock[]`、`parent: Agent`、`agentOptions?`、`outputSchema?`、`maxDepth?`。
- 返回 `SubagentActivation`：`childId`、`name`、`messageId?`、`result: Promise<SubagentResult>`、`dispose()`。
- `delivery: 'caller'` 时结果只返回给调用者，不往上级的对话里插通知。
- 面向模型的委派工具不传目录。

**限额**【源码】packages/subagent/subagent/src/index.ts:186-200

- `maxDepth` 默认 1，`maxActiveSubagents` 默认 8，都是 `dsh-subagent` 这一行上可随时改的配置（base 里这一行没有 config，用的是默认值）。
- 直接调用 `startActivation` 而不传 `maxDepth` 时不做深度检查（child-agent.ts:54）；面向模型的工具才回落到宿主的 `maxDepth`。
- 名额满了返回 `ACTIVATION_LIMIT_REACHED`，不排队。
- `wait_agent` 的 `timeout_ms` 范围 10000 到 3600000，默认 30000。

**面向模型的工具**：`subagent`、`subagent_fork`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`（默认关闭）。`subagent` 工具在 `modelSelection: true` 时暴露 `provider`、`model`、`reasoning_effort` 参数，但受宿主设置 `subagentModelSelection` 管控（`enabled` 默认 false，`allowedModels` 是白名单）。【源码】tool-subagent/src/index.ts:242-257、296

**子代理的权限**【源码】packages/subagent/subagent/src/child-agent.ts:242-261

- 委派时只复制上级显式设置过的 `sandbox/mode`，不复制部署默认值。
- 审批策略被固定为 `'never'`，与上级无关。`never` 的意思是每个审批请求都直接被拒绝（docs/subsystems/approval.md:33）。
- 之后对子会话单独设置的值优先于委派时的值（child-agent.ts:263-270）。

**生命周期事件**【源码】packages/subagent/subagent/src/types.ts:103-131

- `subagent/start`：`{runId, provider, parentSessionId, id, local}`。在驻留建立之后、初始 prompt 被接受之前触发（manager.ts:934），此时 `ctx.agents.get(info.id)` 已能取到代理。每次冷启动也会带着新的 `runId` 再触发一次。
- `subagent/end`：多出 `stopReason` 和 `lastAssistantMessage?`。
- 两个事件都只能观察，不能否决。
- `SubagentResult`：`{output, structured?, diagnostic?, stopReason}`，`stopReason` 取 `completed | aborted | error | max-tokens | refusal`。没有用量字段。

**空闲即被收掉**【源码】packages/subagent/subagent/src/manager.ts

- 本地子代理一旦空闲且收件箱为空，就会结算并被销毁。回合正常结束和被 `interrupt` 之后都是如此。
- 判定在 `watchLocalSettlement`（:987-1035）和 `settlementState`（:1044-1053）；收尾在 `finishDisposal`（:1056-1133）；通知上级在 `notifySettlement`（:1136-1158）。
- 收尾做的事：销毁 Agent、释放名额、给上级发一条会唤醒它的通知（来源 `subagent-settled`）、发出 `subagent/end`、兑现 `result`。它的后台 job 和持久 shell 也随之被杀。
- 通知上级只在 `delivery === 'caller'` 时跳过。
- 没有任何选项、可否决的事件或 provider 钩子能让子代理保持驻留或压下这条通知。搜过 suspend、freeze、park，没有挂起的概念。
- 一个没写进文档的偶然口子：`agent.inject()` 往 `next-step` 放一条不唤醒的消息，判定会一直停在 `'wait'`，子代理就保持驻留。没有测试覆盖这个用法。【推断】
- 如果要改核心，最小的改动位置是 `settlementState` 加上 `notifySettlement` 开头的判断。

**停止和整棵树的操作**【源码】

- `dispose()` 只停这一次执行。`interrupt(id, {kind:'user'})` 取消当前回合；只有还有未处理的输入时才保留激活。
- `drainDescendants([root])` 会销毁全部后代，并且在这个根实例离开注册表之前拒绝一切新消息（`DRAINING`）。用过之后这棵树不能再接收消息，除非根被销毁再恢复（manager.ts:289-298, 174-175, 694-707）。
- 取消根会话的回合不会连带取消子代理，后代继续运行。
- `listDescendants(rootSessionId, signal?)` 返回 `id`、`activity: 'running'|'inactive'`、`mode`、`label`、`name?`、`hasChildren`、`parentId`、`depth`、`path?`。它只读目录记录。打断只能逐个进行。

**发消息和冷启动**【源码】

- `ctx.subagents.sendMessage(sender: Agent, targetId, content, {signal}): Promise<MessageId>`（index.ts:384-391）。发送者必须是活着的根，或同一棵树里驻留的成员；插件可以把根 Agent 作为发送者传入。消息以 steer 送达，前缀是 "Agent lead sent a message:"，来源记为根代理而不是人。
- 另有 `ctx.subagents.prompt(request, signal)`，带 requestId，来源记为 `kind:'user'`（index.ts:466-503）。
- 目标不在驻留状态时才会冷启动。冷启动恢复：完整日志、provider、模型和推理强度、preset、persona、工具过滤、沙箱模式和审批策略（child-agent.ts:233-275，`restoreTarget` 在 manager.ts:1231-1288）。工作目录也恢复【文档】。
- 冷启动后没有新的激活句柄。观察结束靠 `subagent/end`，停止靠 `interrupt` 或 `ctx.agents.get(id).cancel(...)`。冷启动的那一次运行默认会通知上级。
- 上级根会话不在线时子代理不能恢复，报 `CONTINUATION_UNAVAILABLE`（manager.ts:614-618）。所以宿主重启后要先恢复根，再给子代理发消息。
- 外部后端的子代理不能恢复。

**结构化输出**【源码】

- 实现是一个只对该子代理可见的合成工具 `structured_output`，带 JSON Schema 校验（packages/subagent/subagent/src/structured.ts:20）。它不是 JSON 模式，所以只要模型支持工具调用就能用。
- 它绑定在一次激活上，冷启动后不继承（manager.ts:858-862）；`attachStructuredRuntime` 没有导出。
- 冷启动后还想要带校验的结果，只能自己在 `subagent/start` 时往 `agent.ctx` 上注册工具并调用 `concludeTurn()`。另一条路是对子代理做 fork【推断，未测试】。

**宿主重启**【文档：subagent README "Known limitations"；源码】

- 驻留状态只存在于进程内。磁盘上有：每个子代理的会话日志（含 `subagent/descriptor` 和委派策略）、上级的 `subagent/catalog`、已落盘的待处理输入（`agent/inbox/spliced`）。
- 丢失的：驻留、名额、激活句柄、结构化输出的挂接、插件闭包、运行中的 job 和 shell。崩溃时已接受但还没落盘的消息会丢，不重放。最后一个 `turn/end` 可能没存下来，恢复时会补一段修复记录。
- 没找到任何过期时间，冷会话可以无限期放着。

**进程和后台任务**【源码】

- 已经开始执行的工具体一定会跑完，之后再被标成 ABORTED（packages/core/tools/src/pipeline.ts:254-262）。
- 前台 bash 也登记在 `ctx.jobs` 里。`ctx.jobs.kill(id, ownerSessionId, reason)` 可以只停这一条命令，原因会出现在模型看到的结果里（packages/shell/tool-bash/src/index.ts:307-337）。权限只按所属会话编号检查。
- 回合被取消时前台命令被杀：进程组先收 SIGTERM，`graceMs`（默认 3000）后 SIGKILL；有 systemd scope 时用它，否则是较弱的回退（packages/subprocess/subprocess-local/src/linux-scope.ts:288, 609-617）。
- 后台 job 在回合取消后还活着；所属 Agent 被销毁时被杀（"owner disposed"），宿主关闭时也被杀。持久 bash 在中止时被重置。
- 取消后对话记录保持完整：被跳过的调用会补上合成的结果。

### 2.2 其他编排功能

- **team（`ctx.agentTeams`）**：一棵子代理树共用的任务板，存在根的日志里。任务字段 `{id, revision, subject, description, status: pending|in_progress|completed|deleted, ownerId, blockedBy, writeScopes}`，`writeScopes` 只是建议。工具 `team_task_create/list/get/update`，按 revision 做比较并交换。所有成员共用一个工作目录，提示词里写明写范围重叠"is advisory, not a lock"；README 写明没有 worktree、合并和文件锁。默认关闭。没有角色概念。【源码】packages/team/agent-team/src/types.ts:61,181、packages/team/tool-agent-team/src/index.ts:27-33、agent-team/README.md:196,215
- **goal（`ctx.goals`）**：每个会话一个目标，`{objective, phase: active|paused|blocked|complete, maxGoalRounds}`，默认上限 256 轮。工具 `create_goal`、`get_goal`、`update_goal`。创建、修改和恢复要求本轮里有 `source.kind==='user'` 的消息，而且是顶层代理；完成和阻塞也可以来自对应的 goal 轮次。目标文字是模型从用户请求里推断的，"完成"是模型自己声明的，没人核验。【源码】packages/goal/tool-goal/src/authority.ts:79-117
- **goal-round-driver**：代理空闲、目标处于激活且有剩余轮次时，自动给同一个会话排一条来源为 `goal` 的提示。值得照抄的做法【源码+文档】packages/goal/goal-round-driver/src/index.ts：
  - 先预留轮次号，消息真正进入历史才算数；`agent/pre-step` 上做前后两次校验，过期的提示被拒绝。
  - 排队之前先 `ctx.sessions.flush()`，再复查。
  - 只在代理空闲、没有竞争的排队输入、且后代都已安定（`waitForTreeWork`）时才驱动。
  - 用户取消后把目标置为暂停，并撤回还在排队的那条提示；出错或 max-tokens 时解除武装，不重试。
  - 会话恢复或 fork 之后绝不自动重新武装。
- **workflow**：`workflow` 工具运行模型写的 JS 脚本，提供 `agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`。没有日志和断点续跑（packages/workflow/workflow/README.md:127）。【文档】
- **jobs**：后台任务归启动它的代理所有（`job_output`、`job_list`、`job_kill`）。
- **schedule**：定时或周期任务存在宿主里（`schedule_create/list/view/edit`），每次触发投递到已有会话或新会话，宿主必须在运行。
- **plan**：`/plan` 进入计划模式，`exit_plan_mode` 把 markdown 计划交给人批准。它只是建议性的，所有工具照常可用。
- **deliverables**：`present` 声明产出文件；`workspace-changes` 在回合开始和结束时做 git 快照并记录差异摘要。
- **实验包**（`packages/experimental`）：
  - `worktree` / `tool-worktree`：`enter_worktree`、`exit_worktree` 把当前会话移到 `<仓库>/.agents/worktrees/<name>` 的新分支上，服务是 `ctx.worktrees`。它只移动一个会话，不给每个子代理分 worktree。
  - `tool-ralph`：每轮一个新子代理，报告 `{status, summary, evidence, nextSteps, blocker}`，README 自称报告"not independently verified"。
  - `auto-review`：同一个模型把每次工具调用当权限模式来评判。
  - `forge-*`：通过 gh / glab 查看 PR 状态、评审线程和合并，主要是给人看的页面。
  - `webhook-github`：PR 进入待评审时创建一个只读评审会话。
  - `hooks-claude-code` / `hooks-codex`：桥接 Claude Code 的钩子，30 个事件里支持 7 个，只支持命令钩子。映射：SessionStart → `agent/created`，UserPromptSubmit → `agent/pre-step`，PreToolUse → `tools/pre-execute`，PostToolUse → `tools/post-execute`，Stop → `agent/turn-stopping` 加 `steer`，SubagentStart/Stop → `subagent/start`/`end`。Stop 的桥接没有防循环（README:60-66,89,181）。
  - `session_send_message`（`packages/session/tool-session-control`，只在 Web）：给别的顶层会话发消息。
- **SDK 和协议**：stdio 上的 JSON-RPC SDK（`packages/sdk/*`，TypeScript 客户端）和 Python SDK（`python/sdk`）。方法有 `session/prompt`、`session/wait`、`session/resume`、`session/query`；通知有 `session.event`、`session.status`、`subagent.started/finished`；服务端到客户端有 `approval/request`。另有只做自动化的 ACP 服务（`dsh --profile acp`）。【文档】sdk/protocol/README.md:40-56
- **skill**：`SKILL.md` 或 `<name>.md` 加 YAML 头。默认搜索 `.dsh/skills`、`.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`。`.claude/skills` 不是默认目录，可用 `customSkillDirs` 加。【源码：grep】
- **指令文件**：`AGENTS.md`、`CLAUDE.md` 及其 `.local` 变体，从根到 cwd 逐级加载。`@path` 导入和 `.claude/rules` 不解析（packages/context/agent-instructions/README.md:67,223）。
- **MCP**：`mcp-client` 和 `mcp-manager`，工具名形如 `mcp__server__tool`。

### 2.3 dsh 没有的东西（搜过，未找到）

- 需求条目，以及从用户原话到任务的追溯。
- 角色或席位模型；preset 只是能力集合。
- 把关验收的独立审查代理（`auto-review` 只评判工具调用）。
- 在候选提交的干净检出上做验证。
- 只做 fast-forward 的落地（`fast-forward` 只作为 GitLab 的合并方式出现，forge-gitlab/src/status.ts:161）。
- 每个子代理一个 worktree。
- 常驻的调度代理。
- 放在项目里的 Markdown 加 SQLite 流程记忆。

---

## 3. 插件扩展面

### 3.1 工具

- 定义和注册：`defineTool` 加 `ctx.tools.register`（docs/user/develop/basic/tool.md）。【文档】
- **只对一个代理生效**：每个活着的 `Agent` 有 `agent.ctx`（runtime-types.ts:203）。`agent.ctx.tools.register(def)` 只在该代理的作用域里注册，闭包可以带插件状态；`agent.ctx.tools.restrict({allow?, deny?})` 屏蔽全局和继承来的工具。subagent 包自己就这么用（structured.ts:84、child-agent.ts:223）。限制取交集，作用域自己注册的工具不受限制（docs/subsystems/tools.md:165）。【源码+文档】
- 工具处理函数能拿到 `exec.agent` 和 `exec.name`，可以调用 `exec.concludeTurn()` 主动结束回合（packages/core/tools/src/contracts.ts:254-261）。【源码】
- preset 里没有 bash 插件就没有 bash 工具；`tool-fs` 有 `write:false`、`edit:false` 开关（packages/fs/tool-fs/README.md:58）。
- 注意：在 base 和 headless 里，`tool-bash` 和 `tool-fs` 是全局行（packages/bundle/base/cordis.patch.yml:288-306），只有 web-app 把它们移进了 preset（web-app/cordis.patch.yml:554,573）。web-app 之外要用 `restrict({deny:[...]})`。`agentPreset` 依赖 preset 注册表，默认只有 web-app 挂载。

### 3.2 拦截和回合控制

- **`tools/pre-execute`**（waterfall）：监听者返回 allow、deny、cancel 或 ask，不能改写参数（tools.md:572）。【源码+文档】
  - `{kind:'deny', reason, info?}`（contracts.ts:375-379）到模型那里是 `Error: ${reason}`，带 `isError`（pipeline.ts:214-225）。`reason` 是任意文本，可以按代理、按工具定制。
  - `{kind:'cancel'}` 是固定文本 "Error: tool call aborted before dispatch"，不能定制。
  - deny 和 cancel 都不结束回合，模型会继续下一步。
  - 注册在根上下文上的一个监听者能收到所有代理的调用（pipeline.ts:199-203；packages/core/scope/src/index.ts:175-176）；用 `agent.ctx.on(...)` 则只收该代理的。
  - `ctx.tools.guard` 可以加一道后面的监听者无法撤销的最终拒绝。
  - 进程外的子代理不在覆盖范围内。在 PTC 程序里，拒绝会变成程序可以捕获的异常。
- **`agent/turn-stopping`**（serial）：监听者不能直接否决结束，但可以调用 `agent.steer(msg)`，有新的 steer 就会强制再走一步（docs/subsystems/core.md:1092）。
- **`steer` 的时机**：在下一个 step 边界被取走，也就是当前的模型输出和整批工具调用都结束之后，不会打断流式输出。`steer` 和 `followup` 都会唤醒空闲的代理，`inject` 不会。【源码】packages/core/agent-loop/src/agent.ts:181-187, 232-253, 390-396

### 3.3 宿主侧执行和沙箱

- 工具处理函数在宿主进程内运行，只受它自己调用的东西约束。【源码】
- `ctx.subprocess.spawn(spec)` 里没有任何沙箱逻辑（在 `packages/subprocess/*/src` 里搜 "sandbox" 无结果），限制是使用它的一方加的。【源码】
- `dsh-bash-sandbox` 的写法是 `sandboxPolicy: request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`（packages/shell/bash-sandbox/src/index.ts:86）。所以不带会话直接调 `ctx.shell` 得到的是部署默认模式，不是无限制。要无限制就显式传 `danger-full-access`，或者用 `ctx.subprocess`。
- shell 执行请求对进程内的可信调用者接受 `stdin` 和 `env`。环境变量的合并顺序：清洗过的 `process.env`（含 `DSH_*`）→ `ENV_OVERRIDES` → 普通 `env` → `dshEnv`。面向模型的 bash 工具不暴露这两个字段。【文档：设计笔记 2026-06-30-bash-stdin-env-trusted-plugin-api】
- **沙箱模式**：`'read-only' | 'workspace-write' | 'danger-full-access'`，只管文件系统的写入效果，不管网络和进程可见性。后端：Linux 用 bwrap / Landlock，macOS 用 Seatbelt，Windows 用 ACL 受限令牌，另有 SSH。强度报告为 `full` 或 `partial`。【文档】docs/subsystems/sandbox.md
  - 策略按每次调用解析：`SandboxExecutionPolicy {mode, workspaceRoot, additionalWritableRoots?, sessionId?}`，`workspaceRoot` 来自调用会话的目录。
  - `workspace-write` 的边界跟着会话的工作目录走（升级指南 v0.2.2-rc.4 "workspace-write-boundary-follows-root"）。
  - 读取不受模式限制。【推断：文档说模式只管 file effects】
- **按会话设置**：`startActivation` 没有沙箱字段。用 `@deepseek-ai/dsh-sandbox-policy` 的 `setSandboxMode(session, mode)`（session-mode.ts:53），在 `subagent/start` 时对 `ctx.agents.get(id).session` 调用。额外的可写目录用 `registerWritableRoot(session, dir)` 或 `additionalWritableRoots`（sandbox-policy/README.md:51）。【源码】
- **worktree 的已知问题**：链接式 worktree 的 git 目录在工作区根之外，`workspace-write` 下 git 的写操作会被拒，需要把那个目录登记为可写。【文档】
- `fs-sandbox` 用同样的规则约束文件工具。
- **审批**：`user-approval`（`ask` 或 `never`，有审计日志）。`permission-presets` 把沙箱模式和审批策略打包成命名模式，默认有 `workspace-write`（加 `ask`）和 `danger-full-access`（加 `never`），`custom` 和 `auto` 是保留名。【文档】
- **凭据**：`${credential:REF}` 引用，环境变量优先于 `.env`。
- **工作目录**：`ctx.workingDirectory.get(session)`、`ensure(agent)`、`set(agent, path)`。会话头记录的是原始项目，每次移动记一条 `workspace-root/change`。模型没有移动目录的工具，只有宿主的操作可以移。目录消失时会恢复到原始项目。【文档】docs/subsystems/working-directory.md

### 3.4 消息、会话和上下文

- **用户消息**：会话事件 `user/message`，`UserMessage = {id: MessageId, role, content: ContentBlock[], source}`，附件是内容块。【源码】packages/core/session/src/types.ts:325、packages/llm/llm/src/message.ts:164
  - Web 提交的来源是 `{kind:'user', rpcId, clientTimeZone?, principal?}`（packages/api/session-controller/src/types.ts:392，写入在 index.ts:458-464）；SDK 和 ACP 提交的只有 `{kind:'user'}`，没有 `rpcId`。
  - 监听：`session/event`（提交之后触发；`user/message` 在 `step/start` 和 `prepareCall` 之后才追加，此时主请求已经在准备）；`agent/inbox/inserted` 更早，但消息之后可能被丢弃；`agent/pre-step` 是 waterfall。
  - 只取顶层会话：`session.header.origin !== 'subagent'`。会话头的 `origin` 是封闭集合，JSONL 读取器只接受未定义或 `'subagent'`（session-persistence-jsonl/src/format.ts:181-182）。
  - 不能按 `MessageId` 取回消息，只能用 `ctx.sessionQuery.readSession` 或 `readEvent({sessionId, seq})` 按序号取。
  - `snapshotEvents()`、`eventAt()`、`ownEvents()` 已弃用且禁止新调用；读最近若干轮要写一个 `ctx.sessionProjections` 单元。
- **来源种类可扩展**：`MessageSourceMap` 支持声明合并，goal 就是这么加的 `kind: 'goal'`（packages/goal/goal/src/domain.ts:56）。用 `createUserMessage({content, source:{kind:'自定义',…}})`（message.ts:128-140），再直接调 `agent.steer`。经 subagent 管理器转发的消息会被盖上它自己的来源。【源码】
- **创建和唤醒会话**：`ctx.sessionController.create({cwd | workspaceId, sessionId?, agentPreset?})`，之后可 `rename`、`selectModel`（types.ts:260）；没有控制器时用 `ctx.agents.create(...)`。唤醒：`ctx.sessionController.resolveAgent(id)` 再 `agent.steer(msg)`，`session_send_message` 工具就是这么做的，会冷启动并保持驻留。`sessionController` 只在 web-app 组合里挂载（web-app/cordis.patch.yml:117），桌面版经由 web 应用启动，所以也有。【源码+文档】
- **会话列表**：`session.list` 返回所有带 cwd 的持久化会话（session-controller/src/list.ts:111-143）。Web 的树隐藏 `origin === 'subagent'` 的会话和空白的非当前会话（packages/client/ui-workspace/src/client/tree.ts:235-242），按工作区归组。插件创建的会话有了内容之后会显示。【源码】
  - 不改 `ui-workspace` 就能做到的归组和隐藏：`ctx.workspaceRegistry.create(path, title)` 加 `attachSession`（会话头的 cwd 必须等于工作区路径，workspace/src/entity.ts:123-135）；`archiveSession` 让会话落入默认隐藏的归档筛选。没有自定义的隐藏标记。
- **顶层代理没有空闲回收**：没找到空闲驱逐、活动代理数上限或内存压力策略（搜过 evict、idle-dispose、max-live）。也没找到宿主层面的并发回合上限，唯一的扇出限制是 subagent 的名额。供应商的限流没测。【源码：未找到】
- **宿主重启后没有东西自动恢复**：冷会话以 `agentAvailable: false` 列出，第一次被访问（发送、打开）时才恢复（session-controller/src/agent.ts:129-170）。【源码】
- **给主代理加上下文**：
  - `agent.inject()`：进 `next-step`，不唤醒；记为 `agent/inbox/spliced`，下一步以带自定义来源的 `user/message` 进入；聊天里有 `context` 节点类型。
  - `ctx.systemPrompt.context()`：文档称为"对缓存安全的对应物"，快照只在变化时追加到历史之后（docs/subsystems/system-prompt.md:92）。
  - `ctx.systemPrompt.section()`：文本可以是按每次组装求值的函数；改动以追加的系统增量发出，压缩后才整体重建（system-prompt.md:48）。
  - 不能给已有的用户消息附加数据。
- **旁路调用模型**：会话标题的两个包直接 `ctx.llm.prepareCall()` 再 `call.stream()`，带 `purpose:'session-title'`，不开隐藏会话，不占子代理名额（packages/session/session-title-llm/src/index.ts:258-289）。模型由插件配置里的一对 `provider` 加 `model` 指定，省略则沿用主请求的线路。调用前会追加一条只进日志的 `session/title-llm-request` 事件。实验性的 translator 也是直接调 `ctx.llm`。【源码】
- **没有现成的结构化输出**：`GenerateOptions` 有 `tools`，没有 response-format 或 JSON Schema 字段（packages/llm/llm/src/types.ts:564-606）。标题包自己做 JSON 的框定和解析。【源码】
- **用量和实际模型**：进程内会话的每条 `assistant/message` 带 `message.source.{provider, model}` 和 `usage?: TokenUsage`（types.ts:356-363）。`ctx.tokenMeter` 只给上下文压力快照，不给总量。外部后端拿不到模型和用量。【源码】

### 3.5 持久化、打包和限制的性质

- **插件自己的持久事件**：
  - `appendPluginRecord()` 写 `plugin:<小写段>` 类型的记录，可忽略，永不进入模型可见内容。运行时只检查类型的写法（packages/core/session/src/index.ts:211-215）。"只有 `packages/experimental/` 能调用"是仓库里的一个校验脚本（scripts/verify-plugin-record-callers.ts:39-40），运行时不拦。格式迁移时这类记录只是"尽力保留"。【源码】
  - 用 `Session.append` 写自定义类型：写入会成功，但重开会话时 `validateStoredEvents` 对不在 `KNOWN_SESSION_EVENT_TYPES` 里且没有 `ignorable: true` 的类型抛 `SessionFormatUnsupportedError`（packages/session/session-persistence/src/storage-contract.ts:75）。这是技术上的硬限制。
- **客户端引用内部包**：共享的基础模块表 `PLATFORM_MODULES` 是 react、react-dom、`@deepseek-ai/cordis`、zod、`@tanstack/react-virtual`、`dsh-client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`（packages/client/web/src/platform.ts:8-15）。其他包在 `dsh.client.external` 里声明即可；"功能插件只能请求 packages/api/ 下的包"只是仓库门禁（verify-client-packages.ts:31）。【源码】
- **进程内没有访问控制**（AGENTS.md："Trust TypeScript at typed same-process boundaries"）。
- **插件准入只有版本检查**：`engines.dsh`（或 DSH 的 peer 范围）必须匹配运行时版本，profile 的 `compatibility.json` 可以豁免（app-boot README:54-58）。fork 如果改了版本号要注意这一点。【文档+源码】
- **打包和安装**：npm 包里声明 `dsh.bundle.patch`；`dsh plugin --profile <p> add <包>`，参数转给 pnpm。支持 registry、git（钉提交）、tarball、`file:` 和 `link:`，本地目录是链接进来的（plugin-manager README:48-54）。装到该 profile 的 `node_modules` 里。【文档】
- **热更新**：base 里的 `hmr` 行（`root: []`）会替换 profile 下文件有变化的插件，"including … the targets of linked packages"（hmr README:49）。所以放在别的仓库里的包可以链接进 `web` profile 开发。它的客户端那一半要先构建成 `dsh.client` / `./client` 的格式。【文档】
- **斜杠命令**：宿主侧 `ctx.commands.register`，例子 `packages/goal/command-goal/src/index.ts:193`、`packages/experimental/timeline/src/command.ts`（81 行）。

---

## 4. 界面（只在 web-app 组合里）

### 4.1 扩展位（slot）

- 机制：`ctx.slots.register()`，`SlotMap` 是编译期的登记表；往没声明的位置注册会在插件激活时失败。【文档】docs/subsystems/slots.md
- **用户消息气泡**只有一个位置：`conversation.chat.user.before`。【源码】packages/client/ui-chat/src/client/contract/slots.ts:476，渲染在 chat/MessageItem.tsx:227
  - 链式位置，会话作用域。拿到的属性只有 `{source, kind: 'user'|'steering'}`，没有消息编号和序号。Web 提交的消息可以用 `source.rpcId` 作键。
  - 注册方式是 `select(owner)`，第一个返回非空的胜出，不能叠加。现有的唯一占用者是实验包 liveshare。
  - 代理运行中插入的消息（steering 行）和待处理行不渲染这个位置（register-node-renderers.ts:47-51）。
  - 用户消息没有操作位；`conversation.chat.assistant-actions`（列表，`{messageId}`）只给助手消息。
- 对话里的其他位置：`conversation.chat.node`（按节点种类，替换 `user` 会遮蔽自带界面）、`conversation.chat.turnTail`（列表，`{turn, seq, openFile}`，action-cards、deliverables、plan、schedule 在用）、`conversation.user.text.node`、`conversation.chat.text-interaction`、`conversation.chat.aside`。【源码】packages/extensions/cordis-client-runner/src/client/slot-catalog.ts
- **输入框周围**【源码】packages/client/ui-conversation/src/client/contract/slots.ts:305-331：
  - `conversation.input.activity` 只能有一个，已被语音输入占用。
  - 可叠加的列表位置：`conversation.input.left`、`conversation.input.right`、`conversation.input.dock`（输入框上方）、`conversation.composer.dock`（下方）、`conversation.input.overlay`。
- 会话标题栏：`conversation.session.header.actions`（列表）。全局：`shell.overlay`（packages/client/ui-layout/src/client/index.ts:96-107）。
- 会话列表的行：`sidebar.session.row.trailing`、`sidebar.session.row.leading`、`sidebar.workspaces.session.row.action`，都带 `{sessionId}`。
- 会话面板：`conversation.session.panel.section`。
- 没有通用的 toast 服务。未读标记是内置的 `ui-session-status`，没找到让插件加自定义未读原因的接口。

### 4.2 右侧栏

- 每个会话一个停靠区。一个标签页类型是两次注册：`ctx.sidebarRightTabs.register` 里的静态定义，加 `sidebar.right.pane.tab` 位置上的组件。最小的例子是 `packages/experimental/session-inspector/src/client/views/index.ts`（80 行）。【文档+源码】docs/subsystems/sidebar-right.md:36-70
- 标签页按地址打开，资源地址形如 `dsh-resource://<type>/…`。

### 4.3 数据通路和界面到宿主的调用

- **推荐的数据通路**：宿主侧带 `wire.view` 的 projection，客户端用 `useProjection(key)` 读。例子 `packages/preset/agent-preset-registry/src/session.ts:37-45`；按回合实时显示的例子是 `ActionCardTail`（client/ui-action-cards/src/client/Card.tsx:98）。projection 只折叠日志事件，所以第三方的数据更适合放 `ctx.storageDomain`，再通过自己的 Remote 提供（有流模式）。【文档+源码】
- **Typert Remote**：宿主侧写一个带 `@Remote` 方法的 `TypertRemoteService`，客户端以 `ctx.remote.<namespace>` 调用。`dsh-api-remote-access` 按调用者的身份种类检查每次调用。【文档】docs/subsystems/typert.md:289, 477-489
  - 调用者身份：处理函数读 `this.ctx.invocation.peer.principal`，对所有者 `principalOf()` 返回 undefined（packages/typert/protocol/src/principal.ts:14）。"所有者"指任何所有者一侧的对端（Web、桌面，或同一宿主的 SDK 客户端），它不能证明是真人点的。
  - 代理的工具调用不经过 Remote，所以模型伪造不了这类调用。
  - 最小的改状态例子：message-feedback 的 `put` / `delete`（packages/feedback/message-feedback/src/index.ts:150-210）。
  - 命令也可以从界面触发（`ctx.remote.commands.execute`），会记 `command/run` 和 `command/done`，但处理函数拿不到调用者身份。
- **内置停止按钮**调用 `session/cancel`，执行 `agent.cancel({kind:'user'}, {keepInbox:true})`（packages/api/session-controller/src/commands.ts:528-541）。只对根会话有效，拒绝子代理会话，也不连带后台的子代理。插件的 Remote 可以同样调用 `ctx.agents.get(id).cancel(...)`。【源码】
- **action card**：插件用 `ctx.actionCards.register(kind)` 注册一种卡片，但卡片只有在模型的回答里写出 `action-card` 块时才出现，回合结束后显示，用户点了才执行，选择会记录并在下次请求时告知模型。例子 `packages/extensions/creation-recommendations`。【文档】
- **设置页**：第三方在 `plugins.row.config`（键 `<包名>#<行 id>`）或 `plugins.bundle.config` 里注册自己的表单，值来自可随时改的配置字段（`ctx.configForms.get(entryId)`）。没有自动生成的表单。模型选择器 `ModelSelect` 是 `ui-model-selection` 的内部模块，上游规定第三方不引用，但运行时并不拦（见 3.5）。【文档】client/ui-plugin-manager/README.md:90-99
- **客户端打包**：`package.json` 里要有 `dsh.client`（`platform`、`inject`、`immediately`）和 `./client` 导出。模板在 `packages/preset/agent-preset/skills/dsh-doc/templates/decoration/package.json`。

### 4.4 各组合里有什么【源码：bundle 的 patch 文件】

- `dsh-base`（除 sdk-minimal 外的所有 profile）：`api-gateway`、`api-remote-access`、`commands`、`settings`、`session-title`、`session-title-first-prompt-llm`。
- 只在 web-app：`api-session-controller`（所以 `session/cancel` 和 `rpcId` 来源只在这里有）、`api-remotes`、所有 `client-ui-*` 位置、`message-feedback`、`client-ui-settings`、`client-ui-session-status`、preset 注册表。
- 到处都能用的宿主侧部件：`ctx.llm`、`session/event`、`agent.inject`、`systemPrompt.context`。

---

## 5. 模型和供应商

### 5.1 适配器【源码】

- `ctx.llm.registerAdapter` 只在四处被调用：`llm`、`llm-deepseek-api-key`、`llm-deepseek-account`（两者共用 `llm-deepseek/src/host.ts`）、`llm-pi-ai`。
- **`llm-deepseek`** 说的是 Anthropic Messages 协议，默认地址 `https://api.deepseek.com/anthropic`（llm-deepseek/src/config.ts:125），可用配置或 `DEEPSEEK_BASE_URL` 改（:335），但不允许改协议（:240）。
- **`llm-pi-ai`** 包装第三方库 `@earendil-works/pi-ai ^1.3.0`，内置目录约 40 家：anthropic、openai、google、google-vertex、amazon-bedrock、azure、mistral、openrouter、groq、xai、几种通义的套餐、moonshotai、zai、minimax、together、nvidia、deepseek 等。手工声明的线路只能用四种接口：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`（provider.ts:48-53）。
- 没有专门的 Ollama 或 vLLM 适配器，本地服务走 `openai-completions`；README 列了 vLLM 专用开关。【文档】
- **挂载情况**：`dsh-base` 挂了 `llm-deepseek`、`llm-deepseek-account`、`llm-pi-ai`（base/cordis.patch.yml:139, 560-564）。`llm-pi-ai` 在设置里加供应商之前没有任何线路。web、headless、acp、sdk 都建在 base 上；`sdk-minimal` 只挂 `llm-deepseek-api-key`。

### 5.2 配置【源码+文档】

- `llm-pi-ai.config.providers` 下每个键是一条线路，可设 `apiKeyEnv`（按请求解析的凭据引用）、`baseURL`、`api`、`headers`、`compat`、`defaultContextWindow`（1,000,000）、`defaultMaxTokens`（128,000）；`models[]` 每项可设 `id`、`name`、`contextWindow`、`maxTokens`、`input`（text / image）、`reasoningEfforts`（llm-pi-ai/src/config.ts:364-376）。
- **任意 OpenAI 兼容端点只靠配置就能加**：需要 `api`、`baseURL` 和非空的 `models`。Web 的 "Models" 页写的是同一份 `cordis.patch.yml`，下一次请求就生效，不用重启（docs/user/guide/providers.md:27,54）。模型发现用 `GET {baseURL}/models`。
- 写新适配器：继承 `LlmAdapter`，实现 `async *stream(GenerateOptions)`，调用 `ctx.llm.registerAdapter([routes], adapter)`。指南里的骨架约 40 行，工作量在协议映射。【文档】docs/user/develop/practice/llm-adapter.md

### 5.3 同一进程混用供应商：成立【源码】

- `ctx.llm` 按 `provider` 分发，线路没注册才报 `NO_ADAPTER`（packages/llm/llm/src/index.ts:1004）。
- `AgentOptions` 四个字段：`{provider?, model?, reasoningEffort?, maxTokens?}`（packages/core/agent/src/runtime-types.ts:32-41）。
- 链路：`startActivation` → manager.ts:340 的 `resolveChildAgentOptions`（取上级的值，叠加请求的值，换线路时丢掉推理强度，child-agent.ts:98-118）→ 子代理的 step 调 `llm.prepareCall({provider, model…})`（agent-loop/src/agent.ts:634）。
- 没有权限或授权检查（grep "entitlement" 无结果），模型目录只是建议性的（llm/src/types.ts:368）。

### 5.4 与 DeepSeek 的绑定

- **不需要 DeepSeek 账号**。桌面版的欢迎页只在既没登录也没有 DeepSeek key 时出现，可以跳过。pi-ai 的线路只凭第三方 key 就能用（有快照是禁用 `llm-deepseek`、用 Moonshot 的 key）。`account/*` 管的是浏览器登录、余额、通知和 DeepSeek 联网搜索的认证，不卡 harness 本身。【源码】apps/desktop/src/welcome-api.ts:73
- **默认模型要先改**：`agent-default-model` 默认 `deepseek-official/deepseek-flash`（base/cordis.patch.yml:90-94），acp 默认 `deepseek-v4-flash`。
- 写在共享代码里但可配置的：
  - system prompt 的第一句 "You are an AI agent powered by DeepSeek Harness."，由 `includeHarnessIdentity` 控制，默认 true（packages/core/system-prompt/src/index.ts:489, 513-517）。`sdk-minimal` 已经把它关了。
  - `web_search` 对非 DeepSeek 线路也用 DeepSeek 的搜索接口，凭 `DEEPSEEK_API_KEY`（base:472-500）。
- 只对 DeepSeek 官方线路的请求生效的：
  - `session-log-deepseek`：把一段会话日志作为 `dsh_session_log` 随请求上传，默认挂载（base:43）。这一行没有配置，关掉要设 `disabled: true`。
  - `plugin-package-inventory-deepseek`：上报当前启用的插件列表。
- 与供应商无关的：token 估算用固定的每 token 4 个字符，有供应商用量时用用量（token-meter/src/estimate.ts:13）；压缩按适配器报告的窗口算，可指定单独的摘要模型；推理内容是中性的 `reasoning` 块。
- **离线跑本地端点**看配置是可行的，没有实测。【未核实】

### 5.5 各适配器的功能差异【源码】

- 图片能力由 `LlmModelInfo.inputModalities` 标记，缺失表示未知；模型不支持图片时 `read-image` 拒绝（tool-fs/src/read-image.ts:134）。
- 不支持的推理强度报 `UNSUPPORTED_REASONING_EFFORT`。pi-ai 对 `stop` 报 `UNSUPPORTED_OPTION`。
- 输出上限默认值：DeepSeek 256,000（上下文 100 万，llm-deepseek/src/defaults.ts:8-10）；pi-ai 128,000（上下文 100 万）。
- 两个适配器里都没找到 `parallel_tool_calls` 开关，工具自己声明 `isConcurrencySafe`。只有流式一种调用方式。

### 5.6 多模型测试的证据

- benchmarks 和 snapshots 里：`deepseek-v4-flash` 约 3,245 次，`deepseek-v4-pro` 419 次，`deepseek-v4-flash-vision-exp` 484 次。非 DeepSeek 的覆盖只有 pi-ai 的夹具快照（Moonshot、图片限制）和 claude-code / codex 子代理后端的占位夹具。【源码】
- README、用户指南和 BENCHMARK.md 都没有给非 DeepSeek 模型任何支持等级的说明。别家模型在这个 harness 里表现如何，需要自己验证。

### 5.7 网络和遥测【源码】

- **会话遥测**（`session-telemetry-otel`）：`FEEDBACK_ONLY` 模式，只在用户主动反馈后导出会话前缀，发往 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`，带匿名 UUID。任意非空的 `DSH_TELEMETRY_DISABLED` 可关闭，`DSH_TELEMETRY_OTLP_URL` 可改地址（base/cordis.patch.yml:205-235；app-boot/src/profile-context.ts:39,52）。
- **桌面版产品分析**（`product-analytics`、`desktop-product-telemetry`）：默认开启，没有界面开关，`DSH_TELEMETRY_DISABLED` 管不到它，要改它那一行的配置才能关（web-app/cordis.patch.yml:37-54）。
- 其他会连的 DeepSeek 主机：api.deepseek.com、platform.deepseek.com、harness.deepseek.com。
- 代理：`util/http-proxy` 对所有内置 `fetch` 流量应用标准的 `*_PROXY` 环境变量。【文档】
- 插件安装用 pnpm，`registry` 可配，备用源默认 `registry.npmmirror.com`（plugin-manager/src/index.ts:336）。插件市场的索引地址默认是空的。

---

## 6. 缓存和成本

### 6.1 请求怎么拼【源码】

- 上线顺序：system 文本 → 工具定义 → 消息（llm-deepseek/src/serialize.ts:151-165）。
- system 的各段按 order 再按名字排序，开头固定是身份句（order −1000）。第一次请求提交一个 `system/message` 头，之后的改动作为增量追加，只有压缩后的第一次尝试才整体重建（agent-loop/src/agent.ts:449-451）。
- **增量怎么上线取决于模型**：
  - `deepseek-flash` 声明了 `systemPromptUpdate: 'in-history'`（llm-deepseek/src/models.ts:15），增量变成历史里的 system 消息，前缀不变。
  - `deepseek-v4-pro` 没有声明，增量被合并进顶层的 `system` 字段（serialize.ts:107-115），前缀从第 0 个 token 起就变了。在这个模型上频繁改 system 段会让缓存全部失效，应改用 `systemPrompt.context()`。
  - pi-ai 的线路把增量作为提醒消息发出，保住前缀。
- `ctx.systemPrompt.context()` 的快照是 user 角色的 `<system-reminder>` 消息，追加在本轮取走的用户消息之后，没变化就不发（runtime-context.ts:74-91；agent.ts:303-306）。
- 这些都不在 system 里：工作目录（运行时上下文）、时间（`time-context` 单独发 user 消息，默认最多每 10 分钟一次）、AGENTS.md（`agent-instructions` 把它作为 user 角色的基线插在最后一条用户消息之后，agent-instructions/src/index.ts:353-355）。会话编号只进请求头 `x-deepseek-harness-session-id`。提示变量只有 `provider` 和 `model`。

### 6.2 会话内什么会破坏前缀【文档：各包 README 的 "KV Cache effect" 一节】

- 压缩：从第一个被替换的历史 token 起失效，下一次请求还会重建 system 头。压缩后发给供应商的是：当前 system 头、摘要检查点、原样保留的尾部。
- 工具结果裁剪、图片卸载：从第一个被改动的位置起失效。
- 工具集或工具定义变化（注册、屏蔽、重排）：从第一个变化的定义起失效。
- 换模型或供应商：换了一个缓存域。
- 改推理强度：请求前缀不变；供应商是否把它算进缓存键【未核实】。
- 插件重载：同样的文本和顺序重新注册"什么都不发"。

### 6.3 跨会话的前缀

- 第一条用户消息之前只有 system 头和工具定义，内容来自 preset、配置、插件和模型变量；没找到往里放会话编号、日期、目录或环境的段。所以配置相同的两个独立会话，开头应该逐字节相同。【推断：读代码得出，没有做字节比对；没有逐个审查 MCP、skill 和连接器的段】
- 推论：想让角色手册跨会话命中缓存，要把它放进 persona 或 system prompt，不能放在第一条用户消息里或之后。
- `spawn` 的子代理："request cache is independent of the parent's"（subagent-spawn-in-process/README.md:117）。
- `fork` 的子代理："may reuse the inherited byte-identical prefix under the same provider and model"（subagent-fork-in-process/README.md:120）。设计笔记写明 fork 的"intended payoff is provider-side prefix reuse"（.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md:9），同一份笔记也说测试只验证了请求头输入相等，没验证供应商的缓存行为（:43）。fork 的种子只含已完成的 turn；结构化输出等差异会破坏一致。【文档】

### 6.4 缓存控制和用量记录【源码】

- `llm-deepseek` 不发任何 `cache_control`，依赖 DeepSeek 的自动缓存，读取 `cache_read_input_tokens` 和 `cache_creation_input_tokens`（translate.ts:37）。
- `llm-pi-ai` 把 `cacheRetention`（`none` / `short` / `long`，按 pi-ai 的 profile 配置，另有 `PI_CACHE_RETENTION=long`）和 `sessionId` 传给 pi-ai 1.3.0：
  - Anthropic：默认 `short`，发不带 ttl 的 ephemeral 断点；`long` 发 `ttl:"1h"`。断点在 system 块、最后一个工具、最后一条 user/system 消息上，共 3 个（OAuth 下 4 个）。
  - OpenAI Responses：`prompt_cache_key` 设为会话编号，`long` 发 `prompt_cache_retention:"24h"`。每个 dsh 会话的键不同，这会不会降低跨会话命中【未核实】。
  - Google：没找到任何标记，只读 `cachedContentTokenCount`。
- `TokenUsage`：`{inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`，各项互不重叠，`inputTokens` 只含未命中缓存的部分（packages/llm/llm/src/types.ts:173-194）。每条 `assistant/message` 存一份。
- 现成的统计：token-meter 的 `tokenUsage` projection 有四项合计；实验性的 `client-ui-stats` 按步和按回合显示缓存命中率，默认不挂载；`session-stats` 没有缓存字段。所以事后可以从会话日志算出每个会话的缓存命中率。

### 6.5 价格【来自 pi-ai 1.3.0 的 tarball，发布于 2026-10-15；当时 npm 最新是 1.6.1，可能已过时】

单位是美元每百万 token。dsh 自己"never reads pi-ai's cost metadata"（llm-pi-ai/src/catalog.ts:33-38），这些只是参考。

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 窗口 |
|---|---|---|---|---|---|
| deepseek-flash | 0.30 | 1.20 | 0.006 | 0 | 100 万 |
| deepseek-v4-pro | 1.32 | 3.96 | 0.044 | 0 | 100 万 |
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 | 100 万 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 | 100 万 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 | 100 万 |
| gpt-5.5 | 5 | 30 | 0.50 | 0 | 27.2 万 |
| gpt-6-sol | 2 | 10 | 0.20 | 2.5 | 27.2 万 |
| gemini-3.5-flash | 1.5 | 9 | 0.15 | 0 | 约 105 万 |
| qwen3.7-max（经 OpenRouter） | 1.475 | 4.425 | 0.295 | 1.844 | 100 万 |
| kimi-k3 | 3 | 15 | 0.30 | 0 | 约 105 万 |
| glm-5.3 | 1.4 | 4.4 | 0.26 | 0 | 100 万 |
| MiniMax-M3 | 0.30 | 1.20 | 0.06 | 0 | 100 万 |

DeepSeek 的缓存读取价是正常输入价的 1/30 到 1/50。

### 6.6 成本算术的结论，以及它为什么作废

- 当时比较的是三种做法：一个常驻会话累积所有判断；每次判断新起一个会话；从一个带固定前缀的基础会话 fork。假设每次判断的材料是 1 万到 3 万 token。
- 算出的规律：两边缓存命中情况相同时，常驻从第 2 次判断起就更贵，因为每次都要重读越来越长的历史；即使常驻全部命中而新起完全不命中，常驻也会在几十次判断后变贵（deepseek-flash 在材料 1 万 token 时是第 124 次，3 万时是第 47 次）。
- **这张表的数字已经作废**：现场数据显示，一次裁决的 card 实际是 30 到 34 万字符，再加二十多页必读材料，折合约 10 到 20 万 token，比假设高一个数量级。规律的方向不变，具体数字不能用。
- 仍然成立的判断：在 DeepSeek 模型上缓存读取极便宜，成本大概率不是决定因素；关键的未知数是 DeepSeek 的缓存能保留多久。

---

## 7. fork 的成本

### 7.1 上游的节奏【源码：git 历史】

- 44 个 tag，从 `dsh-v0.1.0-rc.7`（2026-08-17）到 `dsh-v0.2.3-alpha.2`（2026-11-22），全部是 alpha 或 rc，没有稳定版，平均约 2.2 天一个。
- 所有 tag 都能从 master 到达，其中 14 个在短命的 `worktree-release-*` 分支上，之后用 PR 合回。master 就是发布线。
- 18 个版本的升级指南里共约 201 份破坏性改动说明（v0.2.1-rc.2 有 33 份，v0.2.2-rc.1 有 24 份）。
- 提交量（仓库始于 2026-06-10）：6 月 579，7 月 8,088，8 月 6,397，9 月 6,071，10 月 4,687，11 月到 22 日 3,150。PR 层面：30 天 477 个，90 天 1,691 个。

各路径的改动频率（可以估计一个补丁打在那里多久冲突一次）：

| 路径 | 30 天提交 | 90 天提交 | 30 天 PR | 90 天 PR |
|---|---|---|---|---|
| packages/subagent/subagent/src | 33 | 145 | 12 | 55 |
| packages/core/agent-loop/src | 14 | 93 | 8 | 40 |
| packages/core/session/src | 16 | 74 | 6 | 40 |
| packages/core/tools/src | 8 | 67 | 3 | 25 |
| packages/core/system-prompt/src | 4 | 22 | 6 | 20 |
| packages/client/ui-chat/src | 59 | 387 | 34 | 170 |
| packages/client/ui-conversation/src | 77 | 362 | 44 | 178 |
| packages/api/session-controller/src | 27 | 203 | 18 | 94 |
| packages/sandbox | 40 | 153 | 20 | 82 |
| packages/bundle/web-app/cordis.patch.yml | 28 | 119 | 21 | 79 |
| packages/bundle/base/cordis.patch.yml | 15 | 57 | 13 | 42 |

- 包的移动和改名：最近 90 天有 95 个提交含完全相同内容的改名，其中 10 个超过 20 处，最大的一次 96 处；约 33 个提交移动了约 55 个包。这是下限。

近期影响插件的破坏性改动举例【文档：docs/upgrade-guide】：

- v0.2.1-alpha.1：委派改成托管的 activation，原来的驱动包被删。
- v0.2.1-rc.2：`SubagentActivationSpec` 被拍平；`drainChildren`、`listChildren`、`list` 被删；`system-prompt/assemble` 不再带工具；工具执行器拆成独立插件。
- v0.2.1-rc.3：`ctx.agents.create` / `resume` 去掉 owner 参数。
- v0.2.2-rc.1：`Session.append` 的重载变了。
- v0.2.2-rc.3：子代理的初始任务从 `user` 改记为 `agent-message`。
- v0.2.2-rc.4：workspace-write 的边界改为跟随 cwd。
- v0.2.2-rc.5：system 消息的段更新方式变了。

### 7.2 上游的政策和门禁

- 公共接口明确是"pre-stable; update every consumer"，每个破坏性改动配一份升级指南（AGENTS.md:7, 11）。没有接口版本机制，只有 3.5 说的版本范围检查。
- **目前不接受外部 PR**（CONTRIBUTING.md:9），所以没有 CLA；反馈走 GitHub Discussions。fork 里的改动合不回上游。
- 仓库自己的门禁【源码】：
  - lefthook 的 pre-commit：翻译配对、oxlint 自动修复、`git diff --cached --check` 等；pre-push 跑 `pnpm run typecheck`。
  - CI：static、coverage（2 个分片）、lint、build、snapshots、web snapshots、benchmarks、node-compat；Windows 和 Python 另有工作流。
  - 覆盖率：`perFile: true`，`packages/*/*/src` 下语句、分支、函数、行都要 100%（vitest.config.ts:278, 437-444），有显式的豁免清单。
  - oxlint 约 80 条规则；jscpd（minTokens 60，minLines 6）；约 70 个 `verify-*` 脚本，包括配置目录、持久化目录、cordis 接口目录、插件包、翻译配对、README 必备小节、tsconfig 路径等。
  - 397 个包每个都有 `README.md`、`README.zh.md`、`README.i18n.yaml`。`tsconfig.host.json` 列了 342 个引用，`tsconfig.client.json` 115 个。
  - `packages/experimental` 不放宽任何工程、文档、测试要求，只是隔离依赖并允许 `appendPluginRecord`。
- 往仓库里加一个新包的最低要求【文档】docs/cookbook/adding-a-package.md:7-41, 163-170：`package.json`、`tsconfig.json`、`src/index.ts`、逐文件 100% 的测试、三份 README（含 Model Experience 和 Known Limitations 小节）、tsconfig 里的一条引用、产品包策略里的分类；用户可见的插件还要一个真实组合的测试。
- 这些门禁管的是仓库里的包。放在别的仓库、链接进来的插件不受它们约束。【推断】
- 硬件提示：覆盖率跑在 16 核的机器上；每个 tsc 聚合需要 8 GiB 的 old-space；本地默认 12 个门禁进程、48 个 Vitest 进程（docs/development.md:69,156）。完整构建和测试的耗时没有数据【未核实】。

### 7.3 不改源码就能改的默认值【源码】

写一个自己的 bundle 包（`package.json` 里声明 `dsh.bundle.patch`），按行 id 覆盖：

- 默认模型：`agent-default-model`（base:90-94）。
- 会话日志上传：`session-log-deepseek`，设 `disabled: true`。
- 桌面分析：`product-analytics`、`desktop-product-telemetry`（web-app:37-54），以及 `session-telemetry-otel`。
- 身份句：`system-prompt` 行加 `includeHarnessIdentity: false`，并重写 `personaPrefix`（web-app:17-20）。
- 子代理限额：`subagent`（base:374）。
- 权限：`sandbox-policy` 的模式是 `DSH_PERMISSION_MODE ?? 'workspace-write'`（base:249-253），另有 `approval`（:265-268）和 `permission` 的预设表（:270-282）。
- 默认 preset：`agent-preset-registry` 的 `default: standard`（web-app:654-657）。

### 7.4 品牌和许可【文档+源码】

- `BRAND_GUIDELINES.md` 只有 12 行，是请求而不是许可条款：可以如实写"built on DeepSeek Harness"；命名建议用缩写 "DSH"；请避免直接用 "DeepSeek Harness" 全名（称其为注册商标），避免用官方品牌素材。它没有提到 logo、npm 作用域、身份字符串和应用名。
- 要改品牌的地方：system prompt 的身份句；桌面版的字符串（apps/desktop/src/locale.ts:34-77）和图标；apps/ 和 packages/ 下 161 个非测试文件里共 408 处出现。
- 非 MIT 的部分：`native/system` 是 BSD-3-Clause；`packages/fs/fs-patch` 有一部分改编自 OpenAI Codex，保持 Apache-2.0；`packages/experimental/subagent-oar` 是 Apache-2.0；inspector 带 Chromium devtools 前端（BSD-3）；运行时依赖里有 MPL-2.0 的 `@deepseek-ai/libreoffice-kit` 和 `@anthropic-ai/claude-agent-sdk`。
- 仓库里再分发的 Claude Code 平台组件，依据的是项目所有者得到的"identity-scoped authorization"（THIRD_PARTY_NOTICES.md:191），fork 不一定继承这个授权。
- `THIRD_PARTY_NOTICES.md` 是生成的，有新鲜度检查。

---

## 8. 没有核实的，和只是推断的

**未核实**

- 各家官方的缓存文档：自动还是显式、最小可缓存长度、保留时长、是否跨会话共享。两次尝试打开文档都被网络策略拦了。尤其是 DeepSeek 的缓存保留时长，它决定常驻会话在几小时的间隔后还便不便宜。凭印象的说法（DeepSeek、OpenAI、Gemini 按前缀自动缓存；Anthropic 显式，默认 5 分钟，可选 1 小时；缓存按账号或 key 共享）都没有重新核对。
- 两个独立会话的开头是否真的逐字节相同（只读了代码，没做比对）。
- 供应商是否把推理强度算进缓存键；OpenAI 按会话设置的 `prompt_cache_key` 对跨会话命中的影响。
- 完整构建和完整测试的耗时。
- 离线只连本地 OpenAI 兼容端点能否完整运行。
- 非 DeepSeek 家族的模型在 dsh 里的实际表现（工具调用质量、长任务稳定性）。
- 宿主层面并发跑几十个顶层会话的实际表现，以及供应商限流的影响。
- 插件创建的会话如果不指定 `workspaceId`，在界面里落在哪个分组（推断是"未分组"）。
- `session/title-llm-request` 这类只进日志的事件、以及 `agent.inject` 的 `context` 节点在界面上具体怎么显示。
- `cwd` 在子代理冷启动后是否恢复（只见于文档）。
- dsh 的各个内置文件工具在回合取消时会不会提前停。

**只是推断**

- 沙箱模式不限制读取。
- 100 万窗口模型上压缩约在 72.7 万 token 触发（算术）。
- 用 `agent.inject()` 让子代理保持驻留；对子代理做 fork 来取得带校验的结果。两者都没有测试。
- 上游的门禁不约束链接进来的外部包。
- 6.6 里的成本规律（具体数字已作废）。

**信息的时效**

- 全部事实对应提交 `4b399c3`。subagent、对话界面、会话控制器这几块 90 天内各有一百到近四百次提交，使用前先看那之后的升级指南。
