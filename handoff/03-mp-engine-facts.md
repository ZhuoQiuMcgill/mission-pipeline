# 03 · Mission Pipeline 4.3 引擎：已核实的事实

- **这是什么**：一次长对话里，对 Mission Pipeline（下称 MP）引擎做的全部事实核查的汇总，给没有上下文的新会话用。它只讲"引擎现在是什么样"，不讲设计方案（方案见同目录其他文件和 `handoff/drafts/`）。
- **截至**：2026-11-27。
- **对应代码**：就在本仓库 `engine/` 下。文件和行号对应 **4.3.0 加九个现场补丁**（`main` = `8a87f8f`）。多数行号是在补丁合入前的 `ed1c59b` 上读出来的，补丁动过 `flow/execution.ts`、`flow/mechanical.ts`、`flow/secretary.ts`、`memory/data.ts`、`process/pm.ts`，这几个文件的行号会有小幅漂移；以后的提交会漂移更多。行号是线索，用之前先重新定位。
- **来源标注**：〔源码〕= 子代理在源码里核实并给了位置；〔文档〕= 只在 README、设计文档或手册里读到；〔推断〕= 推理得出，没有直接验证；〔实测〕= 本次对话里亲自跑出来的；〔现场〕= 来自一个真实项目的只读调查（详见 `04-field-data.md`）。路径省略前缀时默认在 `engine/src/` 下。
- **文档缩写**：MP41 = `docs/design/DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md`；PS = `docs/design/DesignDoc_PMSecretary_2026-11-06_v03.md`；UA = `DesignDoc_UserAuthority_2026-11-05_v01.md`；ER = `DesignDoc_ExecutionRedundancy_2026-10-17_v01.md`；v51 = `DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`。

---

## 1. 引擎现状

### 1.1 它是什么（定位用，细节看 `engine/README.md`）
- 三部分：项目记忆（`<project>/.mission-pipeline/`，SQLite `memory.db` 是骨架，Markdown 是叶子）、角色说明（`roles/<seat>.md`）、流程。`mp` 命令行是读写记忆的唯一入口；每条命令自己打开数据库、做短事务、退出；没有服务、守护进程、socket。〔文档：engine/README.md〕
- 角色：PM（和用户对话）、常驻 Secretary（跑循环、派席位、处理异常）、被派发的席位：Calibrator ①/②、Architect（decompose / feasibility / repair）、Constructor、Reviewer、Researcher、Crititor、Stabilizer、Auditor。〔文档〕
- 命令组：`mp pm …`、`mp sec …`、`mp seat <dispatch> …`、`mp read …`，外加 `mp init`、`mp docs update`、`mp config`、`mp recompute`。〔文档〕
- 记忆目录：`memory.db`、`config.json`、`words/<date>.md`、`missions/<m>/{requirements.md,decisions.md,notices.md,plans/,dispatches/<d>/card.md+report.md,runs/,explorations/,deliveries/}`、`roles/ pm/ secretary/`、`worktrees/<dispatch>/`、`tmp/<dispatch>/`、`tmp/<run>/`、`tmp/checkouts/<commit>/`、`locks/`。产物是仓库里的提交，挂在 `refs/mission-pipeline/` 下。〔文档〕
- 规模：`engine/src` 约 5.1 万行 TypeScript；`engine/test` 约 138 个测试文件。〔实测：wc〕

### 1.2 版本和分支
- `engine/package.json`：`@mission-pipeline/engine` 4.3.0，`private`，只有 `bin.mp`，Node ≥ 22.12，依赖 `zod 4.6.5`，开发依赖 `typescript 5.9.3`、`@types/node 22.20.5`。〔实测〕
- tag：v0.1.0 … v4.3.0（共 17 个，2026-07-06 到 2026-11-06）。远端最新 tag 是 v4.3.0，没有 4.4.x。〔实测〕
- `main` = `8a87f8f`：PR 70（分支 `fix/field-fixes-4.3.0`，头 `0e31a4c`，基 `ed1c59b`）的合并提交。用普通合并（不是 squash），保留了九个提交的原哈希。〔实测〕
- 其他分支：`dsh`（= main + 一份 DSH 版立项文档，`7ff8c98`）；`handoff`（本交接分支）；远端还有若干 `fix/*` 旧分支。〔实测〕

### 1.3 PR 70 的九个补丁（12 个文件，+609 −17）〔实测 + PR 说明〕
| 提交 | 关联 issue | 修了什么 |
|---|---|---|
| `f0fc59c` | 51 | 非复审类的返工（重新绑定后的复审、重审、导出被拒、Secretary 的返工）遇到用尽的循环时，拿到的是该尝试的基础升级编号；若那个升级已被裁决，`raiseEscalation` 直接返回，工作永远等着。现在只有该尝试自己的复审保留基础编号，其余按 key 命名 |
| `fa54e0e` | 57 | 带风险接受的保留产物被重新绑定到新计划版本后，复审退回且循环用尽时，没有选项能再次接受。现在内容与已接受产物相同时提供 `accept-risk`；之前开着的旧升级作为 superseded 关闭 |
| `c43928c` | 58 | 集成复审重开了一个循环已用尽的依赖，随后集成被带风险接受；后来的集成尝试仍读到那次重开而永远等待。现在 `reopenEntries` 忽略任务最近一次接受之前的重开 |
| `9e425b1` | 63 | 规则 4 要求集成任务依赖那些本身建在集成树上的实现任务，形成环。现在排除这类任务 |
| `1c6e3da` | 67 | 循环用尽时只有"验证通过"的交回才提供 `accept-risk`。现在 `failedRunsRisk()` 让 `rework()` 以 `pmOnly` 方式提供它：Secretary 的 card 上不出现，PM 和用户可选，失败的运行写进理由 |
| `e2484c5` | 67 | 之前已裁决为 ask-pm 或未裁决的旧升级使任务继续等待。现在 `applyTaskDecision` 把旧升级作为 superseded 关闭（依赖上一条） |
| `6300cec` | 69 | `secretaryRound` 每个升级把整个 mission 的 flow 事件读一遍。现在只读 secretary 线上的 `secretary-retry` 事件 |
| `0c32344` | 69 | 每次读事件正文都查询、拷贝、重新哈希。现在 `DataStore.text` 在进程内按哈希缓存已提交值的文本（总上限 128 MiB，单值 8 MiB） |
| `0e31a4c` | 69 | `tidyWorktrees` 对每个已结束的派发跑一次 `git worktree list`。现在 worktree 目录不存在就跳过 |
- 效果〔现场 + PR 说明〕：约 290 个升级、1.48 万条 flow 事件的记忆上，`mp sec next` 之前 144 秒（使用中 2.5 到 7 分钟），之后约 50 秒。
- PR 说明里用的是 "Refs" 而不是关闭关键字，**相关 issue 都还开着**，是否关闭留给维护者。未修、现场靠绕行的：62、68。

### 1.4 怎么跑测试，以及对照结果
- `cd engine && npm install && npm run typecheck && npm test`。`npm test` = `node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=1 "test/**/*.test.ts"`；另有 `npm run test:cli`。README 要求用短的 `TMPDIR`、本地文件系统；`MP_TEST_INPROCESS=1` 可让 CLI 套件在进程内跑。〔实测 + 文档〕
- 本次对照〔实测：Linux，Node v22.23.5，以 root 运行，4 核，全量约 19 分钟〕：

| | 测试数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| 4.3.0 原版（`ed1c59b`） | 1,333 | 1,328 | 3 | 2 |
| 补丁之后（`0e31a4c`） | 1,346 | 1,341 | 3 | 2 |
- 两边失败的是**同样 3 个**，新增 13 个测试全过，类型检查通过。失败的三个：
  1. "review round 4: a break that neither the marker nor the database could record is reported…"（断言 `expected LedgerError CHAIN_BROKEN, got null`）
  2. "review round 7 #3: markers that cannot be listed fail closed: writes are refused, saying why"
  3. "worktrees under the folder follow the copy (git worktree repair, the common directory inside the folder)"
- 〔推断〕前两个测的是"写不进去时要报错"，而环境以 root 运行，写入不会被权限拒绝；第三个原因未查。**没有进一步验证**。
- Windows〔PR 说明〕：1,343 个测试，1,234 通过，83 失败，26 跳过；补丁前后失败的是同样 83 个；没有和裸 4.3.0 对比，也没有分析。Linux 上只有 3 个失败，所以那 83 个大概率是 Windows 特有的〔推断〕。

### 1.5 GitHub 上的 issue〔通过 REST API 读到；`gh issue list` 的 GraphQL 被拒〕
- PR 70 之前共 69 个 issue 和 PR。开着的：51–54、56–69；其余关闭（55 是作者撤回的）。**开着的 issue 没有任何维护者回复**；关闭的只有"Fixed in 4.1.3"或"duplicate"之类。
- 关键的几个：
  - **62**：席位以 `ask-pm` / `needs-pm` 交回后，`mp pm inbox` 是空的，而 `mp read blocked` 显示它在等。根因未确定，见 §19。
  - **68**：`architect-repair` 的 card 在提交那一刻冻住；撤回重派仍用同一批约束，白白消耗重派额度。期望的修法是像 `currentReviewTask` 那样重建。
  - **69**：`sec next` 慢（上表后三个补丁已处理主要部分）。
  - **53**：决策层的 card 保留排队时的约束。已部分修复，剩 `architect-repair`（即 68）。
  - **54**：新约束未被覆盖时，稳定模式的生产被静默按住（对应 WI-34）。
  - **59、60、61**：修复和重开的顺序、重新录入问题；修复不能修订，只能再开一个。
  - 已关闭但有参考价值：25（Stabilizer 用了过时的 card）、34 和 42（`**` 指令到不了没有写路径的任务）、36（错误的路径模式静默匹配不到任何东西）。
  - PR 70 引用的：51、57、58、63、67、69。

---

## 2. 引擎对 harness 的 14 个"文字端口"

MP 自己不做、靠手册文字让 harness 或模型去做的事。〔源码 + 文档；位置为手册行号〕

| # | 端口 | 谁触发 | 前后的 `mp` 命令 | 现在做不好时的后果 |
|---|---|---|---|---|
| P1 | 用环境变量 `MP_SECRETARY=S-n` 和固定 prompt 启动常驻会话，名为 `<project>-Secretary` | PM | `mp pm secretary start` → `mp pm secretary handle S-n <h>`；Secretary 跑 `mp sec session`（PM.md:22,38-53） | 没有环境变量时所有 `mp sec` 被拒 `NOT_ALLOWED`（memory/resident.ts:31-36）；pending 的代际没人认领则什么都不变 |
| P2 | 把身份环境变量传给该会话的每条命令；PM 会话里必须不设 | harness | — | 身份就是环境变量；PM 会话里设了它，所有 `mp pm` 被拒（resident.ts:39-41） |
| P3 | 用且只用打印出来的固定 prompt 启动子代理 | Secretary | `mp sec dispatch` → 席位跑 `mp seat D card … handback`（SECRETARY.md:32-33,302） | 多加指示会破坏盲测执行者（PM.md:146）；席位丢失则派发永远在途（WI-28） |
| P4 | 标为 `[parallel]` 的步骤并行运行 | Secretary | `mp sec next` → 多次 dispatch（SECRETARY.md:34） | 写路径重叠在派发时不会被拒 |
| P5 | 记录填席者 `--filled-by "<harness>/<model>"` | PM、Secretary | `pm session`、`sec dispatch`、`seat handback`（PM.md:8） | 只是信息，写错也照记 |
| P6 | 等待循环：`mp sec wait --since R` 后再 `next`；席位对后台运行分片等待（每片最多 50 分钟），不许结束回合 | Secretary、席位 | `sec wait` → `sec next`；`seat rerun --detach` → `seat wait`（SECRETARY.md:35-40；seat/card.ts:286；roles/constructor.md:50） | 只有 Secretary 会话在跑时工作才推进（README 已知限制） |
| P7 | 确认席位已结束后 `release --ended`；无法确认则 `--abandoned` | Secretary（4.2 模式下是 PM） | `mp sec release D --ended\|--abandoned`（SECRETARY.md:126-130） | "mp 从不判断席位死没死"；abandoned 保留 worktree 和租约，且不算停止的确认 |
| P8 | 停掉席位、停掉 Secretary 会话（如 `claude stop <handle>`）；子代理比父会话活得久的 harness 要逐个停 | Secretary；PM 兜底 | `mp pm stop` → harness 停 → `release --ended`；兜底 `mp pm secretary stop`（PM.md:171-182） | 席位无限期停在"未确认" |
| P9 | 叫醒或给另一个会话发消息（可选，记忆才是记录） | PM ↔ Secretary | `pm note`、`pm ask-secretary`、`sec ask-pm` 之后（PM.md:127） | 消息不能代替记录；没有 PM 会话时给 PM 的问题就等着 |
| P10 | 附着或恢复常驻会话（`claude attach`、`--resume`） | 用户、PM | `mp read secretary` | 文档写着"在你的版本上自行验证" |
| P11 | 记录用户原话：回复顶部的类型行、延迟的 `mp pm say --tag` | PM（模型） | `mp pm say` → 需求和计划的写入（PM.md:10-12,59-68） | "原话记录仍依赖 PM 的自觉" |
| P12 | 提示钩子（只提醒） | harness | — | 什么都不记录（见 §6） |
| P13 | 沙箱和权限：对 `.git` 和 worktree 的 git 写入；从项目根目录执行交回 | harness、席位 | `seat handback`（README 222-224；constructor.md:34） | `.git` 只读时后续写入由 Secretary 下一轮补做；shell 停在被删的 worktree 里则下一条命令失败 |
| P14 | 给别的主机上的后台 worker 发信号（`kill -TERM -<pid>`） | Secretary | `mp pm stop` 之后（WI-28:45-47） | mp 无法给它发信号或判断其死活；杀整棵进程树的 harness 会让 worker 被读成 "lost" |

- 引擎里**没有 harness 抽象**〔源码〕：`flow/ports.ts` 定义的是 `FlowLedgerPort`、`FlowSchedulerPort`（`submit/status/cancel/supersede/restart`…）、`FlowEvaluatorPort`，是流程引擎和存储之间的接口，唯一实现是 `process/ports.ts`（"提交的任务就是 `mp pm next` 的一个就绪步骤"）。`flow/scripted.ts` 只供测试用。全源码搜 harness、adapter、filler 只出现在字符串和注释里；filler 只是一个 `{harness, model}` 记录。

---

## 3. `--json` 输出、`sec wait`、退出码

### 3.1 外层包装〔源码：cli/main.ts:103-114〕
- 成功：`{ok, exitCode, command, op?, replayed?, problems, result}`；失败：`{ok:false, exitCode, op?, problems, error:{code,message,wi,detail}}`。`--json` 是全局开关。
- **没有成文或带版本的 JSON 约定**；只有 `read status` 带 `format: 'mp41.status.v1'`。〔源码〕

### 3.2 各命令 `result` 的字段〔源码〕
| 命令 | 字段 |
|---|---|
| `sec next` | NextReport + `stops, unconfirmed[{dispatch,mission,seat,stops}], notes, questions, replies, decisions, revision`（process/secretary.ts:199-206；NextReport 在 process/pm.ts:230-247） |
| 就绪步骤 `ReadyStep` | `step, seat, kind, mission, purpose, parallel, priority, dispatches`（pm.ts:187-200）。**没有** worktree、写路径、依赖、独占资源、预计时长、填席者提示 |
| 被按住的步骤 `HeldStep` | `step, seat, kind, mission, purpose, why, wi`（pm.ts:202-210）。`why` 是文字，**没有结构化的理由代码** |
| `inFlight[]` | `dispatch, step, seat, mission, ageMs, filler, worktree` |
| `sec dispatch` → `Dispatched` | `dispatch, step, seat, kind, mission, card`（叶子路径，不是正文）、`cardLeaf`、`worktree`（相对路径或 null）、`files{dir,report,result,request,notes}`、`prompt`（pm.ts:397-412；cli/commands/pm.ts:236）。没有 cwd 字段 |
| `sec wait` | `revision, timedOut, unconfirmed, replies`（secretary.ts:213） |
| `sec release` | `dispatch, how, released, requeued, exhausted, attempts, allowed, worktree, notes?`（pm.ts:506-520）；exhausted 时退出码 3 |
| `sec alerts` | `{notices}` 或 `{acknowledged, ids}`（cli/commands/pm.ts:1243-1257） |
| `seat card` | `{dispatch, text, leaf}`；JSON Schema 只在 `text` 里（process/seat.ts:110-117） |
| `seat handback` | `kind:'refused'{problems}` 或 `kind:'recorded'{outcome, repeated, report, candidate, verification, notes}`（seat.ts:523-541） |
| `pm session` | `session, filler, inFlight, layer1`（字符串）（cli/commands/pm.ts:137） |
| `pm inbox` | `{items[]}`：`id, kind, mission, text, state, action, resolution, round?, options?, facts?, about?, acknowledgeable?`（secretary.ts:111） |
| `pm stop` | `stop, scope, why, committed, inFlight`（cli/commands/pm.ts:405） |
| `read status` | Layer0 + `asOf, blocked, changed, recomputing`（cli/status.ts:26-44,164） |
| `read secretary` | `live, current, generations`（cli/commands/read.ts:186） |
- 其他缺口〔源码〕：填席者提示来自 `config.fillers`，只用于文本输出（cli/commands/pm.ts:170-182, 207；cli/commands/secretary.ts:58）；独占资源在 `spec.exclusive`（FlowTask，flow/ports.ts:200）；预计值在 `estimateMicros`（ports.ts:188）和 `DetailedTask.estimate {durationMs, costMicros, basis}`（flow/plandoc.ts:202）；`--filled-by` 由调用方给。

### 3.3 `mp sec wait --since R`〔源码：process/secretary.ts:208-225〕
- 是一个长驻进程。每 **100 毫秒**查一次 `SELECT MAX(rev) FROM log WHERE kind NOT IN ('pm.action','op.receipt','secretary.generation','cursor.set','leaf.recorded','notice.delivery')`（`actionableRevision`）。
- `R` 是哈希链事件日志 `log.rev` 的自增行号（memory/schema.ts:23）；`next` 返回 `memory.head()`。
- 有未确认席位或可行动修订号大于 R 时立即返回；否则到超时（默认 300 秒）。
- 每 **30 秒**跑一次完整的 `secNext`，会写入：`touchSecretary` 加对账（后台 worker、标签、落地）。
- 时间流逝本身不写任何东西，引擎里没有任何东西是按时间解除的（见 §12）。
- 外部观察：对 `log` 的只读 SQLite 查询很便宜、不拿写锁（journal mode DELETE），但不是成文接口；`memory.db` 的 mtime 也会因心跳写入而变。

### 3.4 退出码〔源码：cli/main.ts:70；cli/errors.ts:12-25〕
0 成功；3 被拒；64 用法错误；65 op 被复用；75 忙（30 秒 busy_timeout 后，什么都没写）；78 没有项目；1 内部错误。每条命令打印 operation id，`--op <id>` 重试返回已完成的结果〔文档〕。

---

## 4. 身份和授权

- **规则只有一条**〔源码〕：`io.env.MP_SECRETARY || null`（cli/main.ts:138）。设了就是 Secretary，没设就是 PM。`--as` 和 `MP_ROLE` 已在 4.3 设计的附录里去掉〔文档：PS A.1、B.6〕。
- `pm` 组：环境变量被设时拒绝（`requirePm`，main.ts:139；resident.ts:39-41）。`sec` 组：必须指向 live 的代际（`session` 命令可指向 pending 的）（`requireSecretary`，main.ts:143；resident.ts:31-47）。有 live 代际时，`mp pm` 下的 4.2 循环命令（next、dispatch、release、drain、renew、alerts）被拒（main.ts:147）。
- **`seat` 和 `read` 组完全没有身份检查**〔源码〕。`mp seat <id>` 只检查派发存在、在途、card 上列了这条命令（process/seat.ts:98-133）。后果：
  - 没继承 `MP_SECRETARY` 的席位会被当成 PM，可以跑 `mp pm …`；
  - 继承了的席位可以跑 `mp sec …`（钩子脚本的注释就假设会继承）；
  - 任何进程都能对别的派发跑 `mp seat <other> …`。
- 设计上自认〔源码注释 + 文档〕：派发编号"是记账，不是防伪措施"（seat.ts:3-4；MP41:189）；席位无视角色只能在交回时被发现（README 已知限制）。
- 〔现场〕21 天、1,200 次派发里没有席位运行 `mp pm` / `mp read` 的记录；这个口子目前是理论上的。
- 代际和围栏〔源码〕：`memory/resident.ts`（全文 78 行）；状态 pending / live / retired；`--replace` 在同一次写入里退役旧代际；围栏在命令开始时和每次写入内再查一次（process/context.ts:210-212；memory.ts:1130 等）；已放行的运行按原有的停止、租约、认领守卫记录结果（PS B.1；process/runs.ts:545 `alreadyAdmitted`）。
- 只因"Secretary 是一个常驻对话"而存在的机制及规模〔源码，`wc -l`〕：代际和 handle 绑定约 100 行；围栏约 20 行散布各处；`mp sec wait` 18 行；最后命令时间和 60 秒兜底约 14 行（resident.ts:76-78；secretary.ts:28-38）；跨代际的裁决轮次约 42 行（secretary.ts:227-268）；未确认席位 7 行（secretary.ts:20-26）；WI-24。4.3 相对 4.2 的总改动：src +1,342/−215（49 个文件），tests +1,194/−35（10 个文件）。

---

## 5. 交回契约

- card 种类和 zod 结果 schema 在 `seat/cards/*.ts`（`registry.ts:1-18`）；Constructor 和 Reviewer 在 `seat/card.ts`、`seat/results.ts`。〔源码〕
- 结构化字段的 schema 是**真的 JSON Schema**，由 `z.toJSONSchema` 生成（card.ts:176-185），但只印在 card 正文里（card.ts:378-381），没有命令能单独输出。〔源码〕
- 两种形式〔源码：cli/commands/seat.ts:243-291〕：`--stdin`（Markdown 报告，最后一个 fenced json 块是字段；或 `--result-json`）；`--report <f> --result <f>`。缺 json 块报 `NO_JSON_BLOCK`。
- 必读强制〔源码〕：有必读材料的页没读完，交回被拒（seat.ts:677-678）。回执绑定当轮的派发，别的轮次的回执不算（PS A.5；process/secretary.ts:249-257）。`read` 事件只记材料名和页码。
- 拒绝〔源码〕：退出码 3，`{kind:'refused', dispatch, problems[]}`，记为 flow 事件 `refused`，不算数，席位改正后重交（seat.ts:558-571）。
- 每个派发只能交回一次；内容不同报 `FACT_CONFLICT`；在撤回或停止之后的交回是"已记录、未接受"（见 §8）。〔源码〕
- Constructor：`mp` 收集 worktree 里 git 不忽略的所有改动（不需要 `git add`），写路径内的成为候选提交；写路径之外有改动则拒绝交回；card 上的验证命令在该提交的干净检出上运行，那些运行就是证据。〔文档：README、roles/constructor.md〕
- 卡片是自包含的：角色页全文、任务、适用的项目约束、材料（按页读、带哈希校验，每页 16 KiB，`seat/cards/common.ts:68-73`）、命令、交回格式。〔源码 + 文档〕

---

## 6. 现有的 Claude Code 适配器〔源码〕

- `engine/plugin/.claude-plugin/plugin.json`：只有元数据。
- `engine/plugin/hooks/hooks.json`：挂 `SessionStart`（超时 10）和 `UserPromptSubmit`（超时 30），都调用 `node ${CLAUDE_PLUGIN_ROOT}/hooks/claude-code.mjs <event>`。
- `hooks/claude-code.mjs`：从 stdin 读钩子 JSON，用其中的 `cwd`；只有向上能找到 `.mission-pipeline/memory.db` 且 `MP_SECRETARY` 未设时才动作；会话开始时打印 3 行指引；每次提示时打印 2 行提醒（类型行、延迟记录）。**从不运行 `mp`，永远退出 0，不记录任何东西。**
- `engine/plugin/bin/mp`：`exec ${MP_NODE:-node} ../../bin/mp.mjs`；Windows 有 `mp.cmd`。
- 仓库根的 `.claude-plugin/marketplace.json`：一个插件，source 是 `./engine/plugin`。
- **过时的描述**：`hooks.json` 的 description 和 `marketplace.json` 的描述仍写着"用 `mp pm say` 记录每条用户消息"，4.3 的钩子已不记录。

---

## 7. 记忆：格式、兼容性、"一条命令一个进程"

### 7.1 格式和版本〔源码〕
- meta `format = 'mp-memory-1'`（memory/schema.ts:20），每次打开严格相等检查，不等报 `BAD_REQUEST`（memory/memory.ts:1128-1129）。
- `PRAGMA user_version`，`SCHEMA_VERSION = 1`（memory.ts:66）；`ensureSchema` 在 `version >= SCHEMA_VERSION` 时直接返回（memory.ts:1032），即**更高的 user_version 会被旧引擎无检查地接受**。
- 事件哈希域标签 `'mp-event-v1'`（memory/chain.ts:38）；单个事件不带版本字段。格式串和 SCHEMA_VERSION 自 4.1.0 起未变。
- 叶子不带格式版本；文档叶子**写一次**，内容不同报 `FACT_CONFLICT`（memory/leaves.ts:1-24, 169-171）；只有装好的手册版本记在 `pm/installed.json`（cli/init.ts:6）。
- SQLite：journal mode DELETE，synchronous FULL，busy_timeout 30 秒（memory/db.ts:3-6, 20-34）；写入是 `BEGIN IMMEDIATE`；单次写的工作预算约 2 秒（memory.ts:64）。

### 7.2 遇到不认识的记录种类时〔源码〕
- `project()` 走 `default: return;`（memory/projection.ts:291-293）；`identityOf` 返回 null（:54-55）。任何带字符串 `mission` 的记录仍会进 `record_missions`（:104-106）。
- 重建时重放每个事件（memory/rebuild.ts:30-34），只清空本版本认识的状态表（:27-28）。
- 标签扩展：不在 `INPUT_KINDS` 里的种类进 `noteNotice`，只处理 `alert` 和 `notice`（evaluator/labels.ts:615-622, 490-494）。探索的折叠："更新的 flow 的未知事件被忽略"（flow/exploration/machine.ts:854-855）。
- 例外：`applyTaskDecision` 遇到未知的裁决选项**不是忽略，而是标为已应用的空操作**（flow/execution.ts:1983-1985）。
- `validateRecord`（common/validate.ts:97）只在写路径上跑，折叠时不跑。哈希链校验与种类无关。
- 结论：**原样的 4.3.0 能打开一个含有新记录种类的记忆，校验哈希链并折叠，静默忽略那些种类**（前提是 `format` 和链格式不变）。
- 风险〔推断〕：新种类的语义对旧引擎不可见（分支独有的停止、暂缓、豁免、授权不会被遵守）；已知种类里的新取值可能被误用（如上面的例外）；分支独有的表不会被重建；种类名没有命名空间，可能撞名。
- 先例〔文档〕：历次发布都是"新记录种类只增不改"（PS:3、:90；CHANGELOG）；4.1.3 曾原样折叠过一个现场分支的记录。
- 搬迁检查〔源码：memory/move.ts:1-22, 95-132〕：路径和机器、worktree 修复和链接校验、哈希链、重建、叶子存在和哈希、所提到的提交可达。**不检查记录种类或版本。**

### 7.3 "一条命令一个短命进程"的假设〔源码；"→"后是〔推断〕〕
- 启动器：`bin/mp.mjs` 用 `spawnSync` 起第二个 Node（带 type-strip 和 sqlite 标志）（mp.mjs:27-37）；在 `node_modules` 下拒绝运行，因为 Node 不在那里剥离类型（mp.mjs:18-22，退出 78）；`main` 以 `process.exit` 结束。`runCli(argv, io)` 已导出（cli/main.ts:123），测试用它在进程内跑。→ 宿主进程要调 `runCli` 而不是 `main`，并且要从非 node_modules 路径以 type-strip 运行，或加构建步骤。
- 进程锁：每把锁是对锁文件的 SQLite `BEGIN EXCLUSIVE`，由内核在**进程退出**时释放（memory/locks.ts:1-9, 59-70）；持有的锁钉在模块级的 `held` Set 里（:19-20）。包括：按复用键的运行锁（process/runs.ts:398-412）、落地锁（git/land.ts:473, 801；`recoverLandings` 把"锁空闲"当作"持有者已结束"，:767）、让停止写入者优先的停止锁（memory.ts:662-710）、搬迁恢复的维护锁、检出锁（process/housekeeping.ts:68, 87, 290）、`locks/owners/` 下的所有者锁（清扫靠"能不能拿到锁"判断所有者是否存活，memory/scratch.ts:1-10；`holdOwner` 在一个进程内幂等，:28, 41-52）。→ 放进长驻宿主后，宿主内崩溃的东西不会释放锁：scratch 不被清扫、落地显示"进行中"、运行一直 RunInProgress。
- 身份取自 `process.env`（`io.env`）；扩展放在进程级注册表（memory.ts:101-105）。→ 一个进程里同时扮演 PM、Secretary 和席位时，身份必须逐次调用传入。
- 后台 worker：`spawnRerunWorker` 起一个分离的 Node 子进程（`seat … rerun --worker`），带 IPC 并 unref，比调用它的 `mp` 活得久（process/detached.ts:450-476）；存活靠 pid 加启动时间判断，只判本机（:18-21）；命令在自己的进程组里，按组发信号（runs.ts:172-212）。
- 同步的长操作：默认 runner `shellRunner` 用 `spawnSync`，超时 `commandTimeoutMs`（默认 30 分钟，最长 24 小时）（runs.ts:103-105；process/context.ts:163-165；cli/config.ts:69）；交回时的验证在交回命令内同步运行；异步的 `groupShellRunner` 只用于 rerun（runs.ts:161；seat.ts:331）。→ 放进宿主进程会冻结整个进程。
- `node:sqlite` 是同步的：忙等或长事务最多阻塞事件循环 30 秒。
- 库的可用性：`package.json` 没有 `main` / `exports`；`runCli` 是内部接口，只能从克隆路径导入。每次调用的启动开销没有成文数字。认领写在 `OVER_BUDGET` 时重试一次（100–600 毫秒后，pm.ts:413-433）。

---

## 8. 停止的完整生命周期

### 8.1 `mp pm stop`〔源码〕
- 用法：`mp pm stop "<words>" [--scope all|mission:<id>|capability:<name>] [--words W-n]`（cli/commands/pm.ts:382）。范围只有这三种（memory/domain/stops.ts:44；stopTypes.ts:5-34），没有比 capability 更窄的。
- 不给 `--scope` 时从文字里推断（`stopScopeFor`，pm.ts:399-402）；指向不存在的 mission 时放宽到 `all`：**停止从不被拒绝**（pm.ts:395-397）。
- 命令**自己记录那段文字**：`stop.committed {stop, scope, words(≤4000 字符), at, narrows?, wordsEntry?}`（stops.ts:53-55；cli/stopDetect.ts:178）。`--words` 可选；不给时，只有最新的原话条目逐字包含这段文字才会被关联，否则为 null（pm.ts:353-370）。所以不引用原话条目也能停。
- 写入带 `stop: true`，跳过扩展的队列，优先于一切（process/pm.ts:755；memory.ts:595；停止锁见 §7.3）。
- 范围内**拦住**：认领和派发（memory/domain/work.ts:175；排队的步骤在 `next` 里被按住，process/pm.ts:277-279）；交回的接受（work.ts:227）；交付和落地的授权、未完成落地的重试（memory/domain/delivery.ts:213, 247）；证明操作（memory/domain/facts.ts:289）；rerun、后台启动、全量运行（process/seat.ts:210, 315, 411；process/fullRuns.ts:234）；交回时的验证变成 "pending"（process/actions.ts:341；seat.ts:744）；Auditor 的盖章（flow/audit/flow.ts:443）。
- **不拦**：`release`（`releaseDispatch` 没有停止检查，work.ts:239-257）；租约获取（work.ts:260-268）；`say`（memory/domain/pm.ts:10）。
- 本机的后台运行：对每个 worker 的进程组发 SIGTERM，然后记 `detached-end` "stopped"；worker 已死则记 "lost"（process/detached.ts:390-413）。
- 命令输出"N 个派发在途：请在你的 harness 里停掉它们"（process/pm.ts:764）。记忆写入和本机 SIGTERM 之后的一切都靠 harness。
- capability〔源码〕：每张 card 固定带 `['seat','model']`，Constructor 和 Reviewer 加 `run-commands`（flow/context.ts:139）；计划任务不声明别的，探索和审计可以。

### 8.2 停止怎么结束〔源码〕
- `mp pm stop-release <stop> [--words]` 追加 `stop.released {stop}`（stops.ts:74-77）。**`--words` 被解析但没有存下来**，payload 只有 `{stop}`（pm.ts:446-451）。
- `mp pm stop-narrow`：写入更窄的新停止并在同一次写入里释放旧的（stops.ts:87-103）；只能收窄。
- 搜过 resume、lift、continue、thaw：没有别的命令。释放时的提示是"它取消的工作不会自己回来"（pm.ts:457）。
- 〔文档〕MP41 附录 P.1 的出口表（接受、改、重跑、放弃）没有列停止；手册说收窄或释放前要用户同意（PM.md:183）。

### 8.3 在途的派发〔源码〕
- 停止不改变它们的状态，仍是 in-flight（stops.ts:57-60 只是计数）。
- **停止期间交回**：结果是 `after-stop`（work.ts:227），规则是"在撤回或停止之后的交回：已记录、未接受"（seat.ts:659-664）。此时不跑检查、不收集候选、不追加记录（`appendRecords` 只在 `r.accepted` 时，seat.ts:672, 729）、跳过验证（:737）；派发变成 handed-back，租约释放（memory/projection.ts:136-140）；任务变成 `needs-disposition`，disposition 为 `stop`（process/ports.ts:449）。**之后永远不会被接受**：每个派发只能交回一次（work.ts:221-225），没有代码把 `after-stop` 转回；唯一出路是 `restart`（要等没有停止覆盖它；会排一个新派发，并计入 `quarantine-restart` 循环，ports.ts:526-538；flow/failures.ts:86-96）。
- **停止解除后交回**：`stoppedFor` 在交回时才查，所以**正常被接受**（work.ts:227）。
- 所以：在途而未被释放的派发，停止解除后可以继续并正常交回。`stop-release` 不要求先 `release --ended`（stops.ts:74-78）。
- 停止期间席位不能跑 rerun 和全量运行（seat.ts:210, 411）。
- `unconfirmedSeats`（process/secretary.ts:20-26）= 停止范围内在途的派发 + 以 abandoned 释放但还没 ended 的。**只是一个列表**，供 `sec next` / `wait`（:205, 220-221）和 PM 的 layer 1（cli/pmMemory.ts:55）用，**不强制任何东西**。"Secretary 逐个停掉并以 `release --ended` 确认"只写在手册里〔文档：PS A.4；PM.md:174-182；roles/secretary.md:38〕。部分强制的只有"有 live 代际时 PM 不能释放"（`requireDriver`，process/pm.ts:1201；resident.ts:43）。
- 兜底〔源码〕：`mp pm secretary stop` 在 max(停止时间, Secretary 最后一条命令) 之后 60 秒内被拒，除非带 `--gone`；它退役该代际并打印 `claude stop <handle>` 或"按名字停掉"（secretary.ts:28-37）。

### 8.4 `release --ended` 和 `--abandoned`〔源码〕
- `--ended`：`rm` 掉 worktree 及其 admin 目录，**包括未提交的文件**（git/workspace.ts:209-213, 189-205）；删除该派发的租约（projection.ts:145）。
- `--abandoned`：保留 worktree 和租约（workspace.ts:210）；之后再 `--ended` 才释放（work.ts:245）。
- 两者都：删除 `tmp/<dispatch>/` 和只有它持有的共享检出（process/housekeeping.ts:106-121）；从在途首次释放时，追加一条 `quarantine-restart` 循环的 `loop.attempt` 并把同一个任务重新排队（同一任务号和 lineage），除非循环已用尽（process/pm.ts:546-551；work.ts:247-254）。
- 下一次派发在 card 的快照提交上得到**新的** worktree（pm.ts:484-486）。**做到一半的未提交工作从不带入下一次派发**（搜过 partial、uncommitted、previous worktree，没有）；只有之前的运行会被带上（detached.ts:220-242）。
- `after-stop` 交回的 worktree 稍后由 `tidyWorktrees` 和 `pmClean` 删除，不产生候选提交（pm.ts:329-336；housekeeping.ts:324-337）。

### 8.5 运行在停止时〔源码〕
- 交回时的验证和全量运行：`executeRuns` 执行过程中没有停止检查，以 `admittedResult: true` 记录（process/runs.ts:571-627）。**已过预检的运行会跑完并记录证据**；停止只在开始前检查（actions.ts:341；fullRuns.ts:234；seat.ts:744）。前台 rerun 同样只在开始时查（seat.ts:210）。
- 后台运行：被停止就没有结果；结果写入在同一次写里被拒（`RunStopped`：已停止、已有 `detached-end` "stopped"、或有停止覆盖它，seat.ts:322-329）；规则是"先记录的停止赢过后到的结果"（detached.ts:294-307）。**不能续跑**，后续派发的 card 上写着"已停止，没有结果"，需要时重跑（detached.ts:235-236；roles/constructor.md:51）。**没有"让它跑完但扣住结果"的选项。**

### 8.6 角色页
- 没有任何角色页或 card 告诉席位"被停止时做什么"；席位根本不被告知有停止。搜 `stop` 的命中只有 PM 和 Secretary 的页面（roles/pm.md:31、roles/secretary.md:38）和 Constructor 页上关于已停止运行的一行（constructor.md:51）。card 上的 capability 只"用于匹配停止范围"（seat/cards/common.ts:140）。〔源码〕

---

## 9. 原话的写入路径

### 9.1 命令和记录〔源码〕
- `pm` 组的命令都要求 `MP_SECRETARY` 未设；`pmSay` 另调 `requirePm`（process/pm.ts:777）。
- `mp pm say`（内联文本、`--file`、`--stdin`；`--tag` 可重复；`--supersedes`、`--withdraw-items`、`--keep-items`；cli/commands/pm.ts:141-168）写 `user.words {kind, message, session, at, text: sha256, excerpt ≤280, words: W-n, leaf}`（memory/domain/pm.ts:60-66）。session 是最近一次 `mp pm session` 的 op，或 `'pm'`（process/pm.ts:789）。逐字文本进 data 存储和 `words/<date>.md`。和最新条目文本相同则返回那一条（process/pm.ts:778-785）。
- `tag` / `retag`（以及 `say --tag`）写 `user.words-tags {words, tags: [{id: W-n#k, type, mission, quote}], supersedes, authorizedBy}`（memory/events.ts:49-57；memory/words.ts:141）。标签类型：`principle`、`decision`、`requirement`、`instruction`；引文必须出现在条目里（words.ts:61）；`parseTag` 让 instruction 是项目级的（words.ts:57）。
- 撤回和保留的清单**不存进标签记录**，而是变成独立的 `basis.withdrawn`、flow `withdrawn`、豁免撤回记录（words.ts:121-139）。
- `mp pm summary` 写 `words.summary {id: summary-n, text, covers: [{id, fingerprint}]}`（words.ts:145-152）。
- 标签记录本身没有时间戳，靠日志修订号。
- **谁记的、怎么来的**：唯一的"谁"是 `op.receipt {command, filler}`（memory/memory.ts:775-781）；`say` 传 PM 的 filler（process/pm.ts:135-136），`tag`、`retag`、`summary` 不传（words.ts:98, 146）。**没有字段说明是谁做的分类、文本是怎么取得的**；没有任何"逐字"的证据（存的是 PM 打进去那段文字的哈希）。

### 9.2 生效和状态〔源码〕
- 一个标签"生效中"当且仅当：类型不是 `instruction`、没被取代、所属 mission 没关闭（words.ts:37）。每个条目只有**最新一条** `user.words-tags` 算数（:30）。没有标签的旧条目也算作依据（:47）。
- **没有 proposed / pending / 未生效的状态**：条目一旦记录就存在。"下一条消息没有异议才记录"只是手册规则〔文档：PM.md:11, 65-66；PS §4.6〕。
- "指令当场记录"也只是手册规则〔文档：PM.md:12, 65〕；代码里"一次性"的含义只是 `instruction` 标签永不生效。
- "无关"的消息在记忆里**不留任何痕迹**；代码里没有 unrelated 的概念（grep 无结果）。

### 9.3 引用原话的命令校验什么〔源码〕
- `wordsArg` 只查**存在**（cli/commands/pm.ts:96-105），用于 constraint、waive、deliver、land、finish、repair 等；plan submit 也只查存在（pm.ts:719-721）。
- requirement add 和 repair：存在 + 逐字引文（`checkQuote`，memory/domain/pm.ts:72-77；process/pm.ts:819, 863）。
- stop：只查格式（pm.ts:357）。note、reply：查条目存在（process/secretary.ts:53, 97）。
- 只有 `answer --by pm` 和 `grant --by pm` 要求原话**生效中**：存一个 `wordsAuthority` 指纹，应用时再查（flow/secretary.ts:406；process/pm.ts:1099；process/ports.ts:306, 546；memory/words.ts:42-50）；依据失效的豁免在读取时掉出（flow/waivers.ts:133）。
- **没有命令检查标签类型**。
- 后果〔现场〕：一次性指令不在生效中，PM 的 `answer` 引用它会被拒，只好引一条不太相干的旧话。

### 9.4 retag 和读取〔源码〕
- retag 要求一个存在的 `--words` 条目（只查存在，words.ts:107）；第一次替换保留 `W-n#k`，多出来的标签给新编号（:120）。
- 历史只在更早的日志行里。`mp read words` 显示最新标签和是否生效（cli/commands/read.ts:189）；`mp read show words` 显示文本、时间、"由 PM 经 <filler> 记录"和叶子，**不显示标签**（cli/tree.ts:198-209）。**没有任何读取能显示更早的标签。**
- layer 1（`mp pm session`）有 8 KiB 硬上限，原则在前；溢出的部分只给计数和读取命令〔文档：PS B.5；现场触到过上限〕。

---

## 10. 约束和 card

### 10.1 约束模型〔源码〕
- 字段：`{line, version, kind: object|instruction, text, scope{mission?, paths[], taskTypes[]}, words?}`（flow/requirements.ts:49-57；common/records.ts:89-94）。
- 用法：`mp pm constraint add [<recording-mission>] <id> --kind --text [--paths] [--task-types] [--mission] [--words]`、`withdraw <id> --words`（cli/commands/pm.ts:641）。
- 版本是 `{text, kind}` 的哈希；文本不变只改范围时版本不变，写一个 `constraint-scope` 事件（requirements.ts:212-236）。撤回保留记录，编号永不可复用（requirements.ts:223；memory/domain/constraints.ts:90-101）。
- 路径模式只有三种：`**`、精确路径、`dir/**`，其余拒绝（constraints.ts:59-80；process/pm.ts:1030）。`add` 之后报告它触及多少对象和任务，匹配不到只警告。
- **范围维度只有 mission、路径、任务类型。**任务类型是计划里的 `interface|implementation|integration|experiment`（flow/plandoc.ts:175）加探索的席位名。**不能指向某个任务编号、某条线、某个需求条目或某种席位**（探索席位是部分例外）。〔推断〕要只指向一个任务，只能靠"只有它才有的精确写路径"。
- 范围被持久化并校验（common/validate.ts:69-76），证明侧也读它（evaluator/labels.ts:657-690；evaluator/store.ts:280）。

### 10.2 各类 card 怎么选约束〔源码〕
- Constructor，以及 Reviewer card 上的指令：`constraintsForTask`（seat/cards/dynamic.ts:29-36）。
  - object 约束：任务类型匹配**且**路径重叠。
  - 带任务类型的 instruction：类型匹配，**或**有非 `**` 的模式重叠。
  - 不带任务类型的 instruction：路径重叠，**或**路径里有 `**`。所以 `**` 指令会到达没有写路径的任务（4.1.3 修的，issue 34、42）。
- Reviewer 的 object 约束：`objectConstraints`，按对象版本的范围匹配（seat/cards/inputs.ts:19-27）。
- Architect 的 decompose 和 repair card：**该 mission 的全部约束**（`planningConstraints`，dynamic.ts:63-66）。
- Calibrator ①/② 和 feasibility：只有范围匹配计划对象（`pm-plan` 路径和类型）的 object 约束（flow/planning.ts:734, 1522, 1543）。
- Secretary card：任务的约束；没有任务时是 mission 的全部（dynamic.ts:116）。
- 探索席位：`constraintsForExploration`；盲测执行者只拿任务类型点名其席位的 instruction（dynamic.ts:53-61）。

### 10.3 渲染〔源码〕
- 约束**直接写在 card 正文**里，一个平铺的列表（"Project constraints"，seat/cards/common.ts:176），instruction 带前缀"Instruction (follow it; not a proof input)"。**没有大小上限、没有分页、没有相关性筛选**；只有材料才分页（16 KiB）。〔推断〕这就是 card 能到 30 万字符的原因。
- 顺序：`resolveConstraints` 用一个 Map，按"每条约束**当前版本**被记录时的日志修订号"排序（memory/domain/constraints.ts:31-46）。〔推断〕重录文本会把约束挪到末尾，只改范围不会——这就是现场"让约束排在最后"的由来。**约束之间、版本之间没有任何优先级。**
- 渲染出来的列表只被席位模型读；`card.constraints` 和 `decisionQuotes` 只被 `renderCommon` 用。object 约束通过另外的检查清单影响证明。

### 10.4 "相关决定（逐字）"怎么选〔源码：dynamic.ts:69-96〕
一条有效的 `decision` 类需求条目，满足以下任一条件就上 card：
1. 它的 line 在任务的 `requirementItems` 里；
2. 它的来源是一个授权（**所有基于授权的决定都算，出现在每张 card 上**，:81；授权已失效的跳过，:78）。没有找到成文理由；
3. 某条适用约束的文本包含这个条目的 line（〔源码〕`related.add(c.line)` 在 :74 实际是死代码：约束 line 是 `constraint.*`，条目 line 是 `item.*`）；
4. 它记录于参考计划的 `effective` 修订之后（标注"(recorded after the plan)"）。**这一条让计划之后记下的每条决定出现在所有任务的 card 上。**
- 第 4 条的来历〔文档：CHANGELOG.md:880-884，4.1.1，现场发现 B8〕：计划的 `requirementItems` 没法引用一条当时还不存在的决定。MP41 附录 N 规定认领时重新选择"任务决定"（MP41:636）。
- 参考计划：生产用生效中的计划；Reviewer 用它目标的固定契约里的 dplan（dynamic.ts:19-21）。
- 同一函数还加入：对 `task:<id>` 的升级、在任务最新 spec 之后提出、且应用的选项是 `answer` 的那些答复的 `instructions`（:84-94）；只有 `d.by === applied.by` 且指示非空才引（生效的裁决：用户 > 最新未被拒的 PM > Secretary）。
- Reviewer card 另加其尝试的 `reanswer` 裁决（dynamic.ts:102-105；execution.ts:2074-2079 写 `reanswer`，key 为 `k:m`）。
- 若把决定收窄为"只上有链接或显式范围的任务"，会破坏的测试：`test/p3-plans-constraints.test.ts:151-178, 285-293`、`test/int-dispatch-plan.test.ts:172`、`test/flow-rebind-kept-products.test.ts:1239-1242`。

### 10.5 card 上的其他内容〔源码〕
- 角色页全文：`renderSeatCard` 内联 `roles/<seat>.md`，3.8 到 9 KB（seat/card.ts:323-345）。
- 命令列表、交回的 JSON Schema、修复、职责（duties，含返工的问题和指示）、目标、标准、需求条目、写路径、可读文件、接口、独占资源（card.ts:112-130）。
- 新字段在 zod 里必须是可选的，先例：`repairs`、`contextItems`、`earlierDecisions`（common.ts:153；seat/cards/secretary.ts:64, 74）。

### 10.6 Secretary 的裁决 card〔源码〕
- 字段（seat/cards/secretary.ts:47-75）：request（id, source, lineage, subject, summary, original, changed, reasons）、authorizations、items、contextItems、materials、options、grantAvailable、classifications、position、earlierDecisions；公共字段再加 duties、constraints、decisionQuotes。渲染：`renderSecretary`（:98-114），外面由 `renderSeatCard` 包上角色页、命令和结果 schema。
- 四份材料，**全部必读**（seat/cards/dynamic.ts:122, 135-140）：
  1. `request`：升级及其 facts 的 JSON；
  2. `authorizations`；
  3. `alignment`：PM 批次编号和它们引用的原话编号（不是原话文本）；
  4. `current-facts`：升级、所选条目（每条决定）、**全部**授权、约束（没有任务时是 mission 的全部，**又印一遍**）、决定引文、**整个** DetailedTask、该任务线上**每个事件的完整正文**的规范化 JSON（dynamic.ts:139）。〔推断〕它随尝试、复审和约束增长，所以有 20 多页。
- `secretaryInputs` 把每条有效决定放进 `items`、`decisionQuotes` 和 `current-facts`，**同一条决定印三遍**（dynamic.ts:118-125）。
- `earlierDecisions`：同一 subject 上的其他升级（任何 spec），含生效的裁决、理由、已应用 / 尚未 / 被取代（dynamic.ts:150-170）。4.1.2 加的（CHANGELOG:531），为了修"Secretary 看不到同一条线上之前的裁决"。
- card **不带**：其他 subject 上的裁决、通知、PM 的 note、任务之外的计划（calibrator-2 例外，它的 `original` 是渲染后的 PM 计划，planning.ts:1302）、用户原话全文（只有授权引文和决定条目）。
- `current-facts` 的消费者只有 Secretary 模型；它是 `mustRead`，按字节分页；引用是 sha256，读时校验哈希（process/seat.ts:146-149；pm.ts:475）；认领时重建，变化时不报 `NOT_READY`（seat/cards/refresh.ts:167）。裁决的校验用 `contextItems`，不用这份材料（flow/secretary.ts:270, 355）。`test/p3-plans-constraints.test.ts:172-174` 断言它包含晚到的决定。
- 大小：子代理按代码估计 card 1 到 3 万字符、必读 7 到 50 KB〔推断，估错〕；〔现场〕实际每张 card 30 到 34 万字符，`current-facts` 23 到 27 页。

### 10.7 card 什么时候生成和刷新〔源码〕
- flow 在**排队时**构建 card spec（如 flow/execution.ts:2257-2290）。
- `mp pm/sec dispatch` 在**认领的那次写入里**跑 `refreshDispatchCard`，渲染 card 并存为叶子（process/pm.ts:460-476；叶子 `missions/<m>/dispatches/<D>/card.md`，work.ts:179；路径记在 `dispatch.claimed` 上，投影为 `card_leaf`，projection.ts:127-129）。
- `mp seat <id> card` 只读那个叶子并校验哈希；被手改过报 `LEAF_EDITED`。**没有重新渲染或刷新的命令**（process/seat.ts:117-124）。
- 认领时的刷新重新选什么（seat/cards/refresh.ts）：
  - Constructor：约束、决定引文、需求条目（:139-141）；
  - Reviewer：bases、约束、决定引文（:149-158）；
  - Secretary：全部输入（:167）；
  - Architect decompose：约束；探索席位：约束和前驱；
  - Calibrator 和 feasibility：不重选；输入变了就抛 `NOT_READY`（:171-183）；
  - `architect-repair`：**原样返回**（:49-50），即 issue 68。对照：`currentReviewTask`（flow/planning.ts:514-537）会比较 `changedPlanningInputs`，写 `review-rebuild`、取消并替换步骤。
- **排队时就固定**的：duties（含返工的问题和指示）、目标、标准、写路径、快照提交（`workspace.snapshot`，execution.ts:2384）、接口，全部来自计划的 DetailedTask。Constructor 的刷新从不动快照（refresh.ts:122-143）。
- card 哈希和 superseded：Constructor 只有在 `taskCardHash(current) !== spec.hash` 时才是 superseded（refresh.ts:132）；哈希只覆盖 DetailedTask，**不含裁定、决定、约束**。Reviewer 没有 superseded 检查。Secretary 只查轮次和任务是否对得上（:166）。计划类的在 `planningContext`（每个条目的 line、版本、状态）变化时拒绝（inputs.ts:48-58；refresh.ts:182）——〔推断〕所以把裁定存成需求条目会搅动排队中的 Calibrator 和 Architect 步骤。
- 已在途的 4.3 派发不受影响（spec 在认领时渲染并存下，交回读的是派发时的 spec，seat.ts:100-108）；4.3 排队的 spec 会在认领时被新代码重新选择。

---

## 11. 任务、线、尝试、spec；答复如何到达 card；升级机制

### 11.1 标识和寿命〔源码〕
- **任务**：详细计划里的 `DetailedTask`，由 Architect 起的 `t.id` 标识；事件线是 `task:<id>`。
- **线（lineage）**：`taskLineage = safeId("task.<mission>.<idPart(id)>")`（flow/execution.ts:131），**只由任务编号推出**，跨尝试、重新规划和修复稳定，只要 Architect 保留编号（修订 card 要求它保留，flow/planning.ts:1477）。改名就是新的线，旧线得到 `dropped` 事件（execution.ts:2278）。
- **尝试**：`k = 1 + 该线上 rework 事件的个数`（execution.ts:152-155），跨 spec 累计。
- **任务行**：`tasks` 表的一行是一个排队的席位步骤（memory/schema.ts:114-125），各有编号（`con.<m>.<task>.<k>`、`rev.<m>.<task>.<k>[.r<m>]`、`.b1` 是重新绑定、`sec.<esc>[.retryN]`；execution.ts:137-138；flow/secretary.ts:116, 344）并带 `lineage` 列。〔现场〕所以 1,203 行对应 201 条线。
- **spec**：`task:<id>` 线上的 `spec` 事件，key `<dplan>#n`，body `{dplan, hash, repair?}`；`hash = taskCardHash(t)`（规范化 DetailedTask 的 sha256，flow/plandoc.ts:214-219）。只有哈希变了或 `dropped` 之后才写新 spec（execution.ts:572-591）；任务已开工时，重新规划或修复还会写 `rework k+1`（理由 `respec`）。保留 card 的计划不写 spec。
- **版本**：计划版本 `dplan.<m>.<n>.<k>` / `pmplan.<m>.<n>`；修复加一个带 `amendments` 的 "effective" 事件（加任务或改 card），不产生新 dplan（plandoc.ts:248-289）；产物版本是 `object.version` 记录，`productAttempt` 把它映射到 k（execution.ts:187-194）。
- 适合挂"线上的东西"的稳定键：`task:<id>`（事件线和升级的 subject）、`taskLineage`（`loops` 表和派发行）。

### 11.2 "直到新 spec"是什么意思〔源码〕
- `taskDecisionQuotes` 只引用**最新 spec 修订之后**提出的升级的答复（dynamic.ts:70, 85）；spec 变化时，开着的升级作为 superseded 关闭（execution.ts:587-590）。
- 所以一个 `answer`：在同一张 card 的多次返工之间有效；在保留 card 的重新规划之后仍有效；**card 一变就失效**。测试：`test/process-escalation-scope.test.ts:224`（F1d）。

### 11.3 指示怎么到达下一张 card〔源码〕
- 返工和 grant：`reworkAt` 把返工 body 和针对第 k−1 次尝试的 loop-exhausted 升级上已应用的 `grant` 裁决的指示合并（execution.ts:2310-2327）；`rework` 把裁决者的指示写进返工 body（:2083-2086）；印在 duties 的 "Instructions:" 下（:2377-2382）。**只对那一次尝试。**
- `answer`：进同一任务 Constructor card 的决定引文，直到新 spec；Reviewer 通过同样的引文加 `reanswer` 拿到。
- 构建位置：Constructor execution.ts:2298-2301, 2387；Reviewer :2521；两者在认领时重选（refresh.ts:141, 158）。

### 11.4 升级机制〔源码：flow/secretary.ts〕
- 答复存为 `secretary` 线上的事件 `decision`、`pm-answer`、`user-answer`、`applied`；`DecisionBody` 字段在 :58-77。
- `answerEscalation` 写 `user-answer`，以 `applied` 不存在为守卫（:670-704）；没有升级时抛错（:668）。
- `answerByPm` 写 `pm-answer <id>#<round>`，需要通过 `wordsAuthority` 指纹校验的原话（:406-421）；原话失效产生 `pm-answer-rejected`，收件箱以新一轮重开（:371-381）。
- Secretary 的裁决是 `decision` 事件（:258-272），`inputs = contextItems`；授权或所引决定变了时，`decisionAuthorityCurrent` 拒绝它并开一个重试轮（:351-364）。
- `carryOut` 构建 `applied` 事件（`what`、`by`、`dispatch`/`words`/`answerRound`）和守卫；只有对一个 position 的 accept 或 accept-risk 才写裁决判决 `j.user|pm|sec.<id>`（:489-541, 625-657）。裁决判决只在生效时随效果一起写，未应用的答复不留判决〔文档：PS A.6〕。
- `deciderOf` 只返回 user、pm、secretary，从不是 program（:620）；席位失败时程序产生的是一条 `by:'program'` 的**决定**（ask-pm），不是判决（:219-232, 721）。
- 用户的答复在应用前优先于 PM 的；应用之后相反的决定要走新的出口〔文档：PS §4.3〕。
- `decisions.md` 的日志条目来自 `decision`、`user-answer`、`pm-answer` 事件（process/ports.ts:213-218）。
- **每条下裁定的路都要求先有升级**（`pm answer`、`sec decide`、`answerEscalation`）。没有升级时 PM 只有四条路：一条 `decision` 需求条目（全 mission，计划之后记的会上所有 card）、一条约束、一个修复（经 Architect）、一个 grant（只加尝试次数）。**没有任务级的裁定记录。**
- Secretary 的 grant：每条线一次，1 到 2 次额外尝试；之后只有 PM 或用户能批（flow/secretary.ts:577-584；`mp pm grant`；seat/cards/secretary.ts:126-129）。PM 的 grant 不消耗 Secretary 的额度〔文档〕。
- 分类：`detail`（可带 may matter）、`needs-pm`（选项 `ask-pm`，是 `ask-user` 的别名，flow/secretary.ts:96-106）；`needs-pm` 的强制在 seat/cards/secretary.ts:118-121。

---

## 12. 就绪列表和认领

### 12.1 `readSteps`〔源码：process/pm.ts:269-299〕
按住一个步骤只有五种理由，先匹配到的赢（所以只显示一个理由）：
1. mission 已关闭，`heldByClose`（:274；close.ts:67）；
2. 停止，`stoppedFor(mission, capabilities)`（:278）；
3. git 写入被按住，只对 Constructor（:282，WI-31）；
4. 探索的 `after`，`heldByPredecessors`（:287）；
5. 独占资源被租用（:292-295，WI-28）。
- **完全不看升级、未应用的答复或待定的决定。**
- 报告方式：文本的 "Held" 一节（cli/commands/pm.ts:186）；JSON 的 `held[]`。`cli/layers.ts:429-439` 靠**匹配 `why` 文字的开头**来选下一步提示；新理由没有对应分支时会落到租约的提示上。

### 12.2 优先级和并行〔源码〕
- 优先级来自提交时的 `spec.priority`，按类型写死：Secretary 120（flow/secretary.ts:145）；计划、Architect、Calibrator 步骤 100（planning.ts:823/1512/1535/1580）；repair 100（repair.ts:404）；Reviewer 60（execution.ts:2556）；Constructor 50（:2408）；audit 50；探索用自己的值（默认 0）。高的在前（pm.ts:300），相同时按排队顺序（`queued_rev`，memory/queries.ts:262）。
- `parallel`：与在途的 spec 和其他候选没有共享的 `exclusive` 资源、写范围不重叠（pm.ts:249-252, 301-304）。**只是建议**：认领从不因写范围重叠而拒绝。
- 调度输入只有：`dependsOn`、`exclusive`（租约）、`estimate`（plandoc.ts:200-204）、探索的 `after`、配置 `startOnHandback`。`exclusive` 只设在 Constructor 的 card 和 spec 上（execution.ts:2398, 2414；plandoc.ts:203），Reviewer 没有。

### 12.3 认领〔源码〕
- `readSteps` 是只读快照。认领是一次串行化的写（`pmWrite`，pm.ts:450-482；`OVER_BUDGET` 时重试一次，:422-436）。写内**再查一遍**：mission 关闭（:459）、`after`（:461）、`NOT_QUEUED`（一个步骤只认领一次，work.ts:173）、`STOPPED`（work.ts:175）、`GIT_WRITES_HELD`（work.ts:178）、租约 `acquireLease` → `DOMAIN_BUSY`（pm.ts:476；work.ts:265），以及刷新可能抛的 `NOT_READY`（refresh.ts:132/137/166/182）。
- `NOT_READY` 的情形在 `next` 里看不见：步骤列为就绪，到 dispatch 才失败。含义：card 被取代或输入变了、mission 关闭、探索的前驱未定、快速模式的生产依赖着有争议或被否定的元素或正在重算的标签（refresh.ts:134-137）。
- 新的按住理由应该放在哪：一个谓词，在 pm.ts 约 :286 和认领内约 :460 两处各调一次（现有的 mission 关闭和 `after` 就是这个模式）。`mp sec card` 也经过 `pmDispatch`（process/secretary.ts:246）。
- 认领时创建的东西：刷新后的 spec（存为 data，`dispatch:<D>` 线上的 `claimed/spec` 事件，pm.ts:467, 478）、card 叶子、材料叶子（:475）、租约（:476）、`tmp/<D>/`（:484）、Constructor 的 worktree（在写入之外，:486-490）、固定 prompt（:503）。共享检出要等 `mp seat checkout`，它写一个 `checkout` 事件（housekeeping.ts:70-72）。

### 12.4 步骤和线的对应〔源码〕
- 任务线 `task.<m>.<id>` 覆盖：Constructor `con.…`（含返工尝试）、Reviewer `rev.…`（含答复后的重审和重新绑定的复审）、**Secretary 裁决步骤** `sec.<esc>`（它的 lineage 是升级的，flow/secretary.ts:117, 141，所以任务升级共用任务的线）。
- 修复的 Architect 步骤有自己的线 `repair.<m>.<r>`（repair.ts:57）；计划步骤用 `plan.<m>.<n>`（planning.ts:216）；探索和审计（`aud.*`）各有自己的线。
- 按住一条线上各类步骤的后果〔推断〕：Constructor = 不开新尝试；Reviewer = 已交回、验证已跑的候选没人审；Secretary = 裁决延后，阻塞性的升级让整个任务多等。

### 12.5 "已接受"和时间〔源码〕
- 接受记为 `task:<id>` 线上的 `accepted` 事件，key 是尝试号（execution.ts 约 :795）。接受之后还可能被 `rework` 或 `reopened` 推翻；`pmInbox` 用 `accepted/abandoned/attempt/reopened/rework` 里最新的一个（process/secretary.ts:158）。在 `next` 时便宜的测试：对 `flow_events` 的一次带索引查询。
- 时间：flow/ 和 memory/domain/ 不调时钟；时间只出现在记录的 `tx.at`、process/ 里的 `ctx.now()`（`ageMs` pm.ts:264；停止的 `at` pm.ts:757；60 秒宽限 secretary.ts:34）和 `IN_FLIGHT_BLOCKED_MS`（layers.ts:65）。**没有任何东西按时间解除**（搜过 until、notBefore、releaseAt、expires）。

### 12.6 `blocked` 怎么算〔源码〕
- `mp read blocked` 和 layer 0 的计数来自同一个解析器（cli/layers.ts:37-48, 368-467）。blocked = 有开着的升级（`constructor-decision` 除外，:405）、`readSteps().held` 的每一项（:428-440）、停止压着在途派发、在途超过 1 小时没有交回、停止后到达的交回。
- PM 的 layer 1（cli/pmMemory.ts:55-59）只列未确认席位和停止计数。
- `mp read status` 给 layer 0，外加自上次询问以来状态变化的子任务的 layer 1；它会移动 PM 的游标 `asked`（Secretary 用自己的 `asked.sec`，cli/status.ts:97, 195）。〔现场〕存在 `mp read status --no-mark`，不移动游标。

---

## 13. 升级来源；Constructor 提问的完整流程

### 13.1 来源、提出位置、选项〔源码〕
来源在 `seat/cards/secretary.ts:24-40` 声明；选项来自各提出位置；常驻模式下 `ask-user` 显示为 `ask-pm`。

| 来源 | 提出位置 | 选项 |
|---|---|---|
| calibrator-2 | flow/planning.ts:1298 | accept, send-back, ask |
| order-change | planning.ts:1046 | accept, send-back, ask |
| feasibility-unresolved | planning.ts:1140 | accept-risk, send-back, ask |
| loop-exhausted（计划） | planning.ts:1230 | grant, ask |
| loop-exhausted（修复） | repair.ts:274 | grant, ask |
| loop-exhausted（任务） | execution.ts:1886（补丁后约 :1991-2000） | grant, replan, [accept-risk], abandon, ask |
| reviewer-needs-decision | execution.ts:520, 852, 1815 | answer, [rework], replan, [accept-risk], ask |
| replan（依据被撤回） | execution.ts:549 | accept, replan, abandon, ask |
| replan（编号重复） | execution.ts:667 | replan, abandon, ask |
| constructor-decision | execution.ts:751 | answer, replan, ask |
| exploration-direction（作者提问） | exploration/step.ts:539 | answer, ask |
| exploration-direction（Stabilizer 判偏移或漂移） | step.ts:553, 566 | answer, send-back, abandon, ask |
| exploration-direction（升级的发现） | step.ts:580 | answer, send-back, accept-risk, ask |
| 探索的路由 | planning.ts:1343 | accept 或 replan, ask |
| exploration-budget / exploration-repeated-fatal | step.ts:285-302 | [accept], grant, [accept-risk], [send-back], replan, abandon, ask |
| needs-disposition | step.ts:473 | restart, abandon, ask |
| plan-structure-change | planning.ts:1081 | approve, send-back；**直接进 PM 收件箱，不经过 Secretary**（flow/secretary.ts:127, 203） |
| plan-restarts-work、issue-disposition、cost-overrun | — | 声明了，但没有找到提出位置 |
- 每个裁决的输入都是显式的：card 加材料。

### 13.2 是否阻塞、答复落在哪、哪些组合会造成过时的 card〔源码〕
- flow 里 `taskStep` 在 `task:<id>` 上有未决的开着的升级时不提交新步骤（execution.ts:612-618），**例外是 `constructor-decision`：`blocking = source !== 'constructor-decision'`**（约 :2032）。
- 升级之前已排队的步骤仍可派发〔推断，由就绪列表不看升级得出〕。
- 刷新在认领时重算引文，所以"过时"= **在答复尚未应用时被认领**；已裁决但未应用的答复什么都不渲染（要求 `applied`）。
- 各来源：
  - **constructor-decision**：不阻塞；同一轮里复审照常排队；答复应用后进 Reviewer card 的决定引文和后续 Constructor card。**过时组合：Reviewer × cdec**（含重审和重新绑定的复审）；Constructor × cdec 只在开着时排了返工的情况。
  - **reviewer-needs-decision**：阻塞；`answer` 变成 `reanswer`，排一个**新的** Reviewer 步骤；rework 把指示放进下一次尝试的 duties；都在裁决之后排队，不过时。
  - **loop-exhausted（返工）**：阻塞；grant 的指示进下一次尝试的 duties，裁决后才排队，不过时。
  - **replan**：阻塞；通过计划起作用（spec 变 → 刷新报 superseded），不是引文。
  - **needs-disposition / 非返工的 loop-exhausted**（flow/failures.ts:58）：在 `taskStep` 里不阻塞，在看到失败的地方处理；失败的步骤不排队。
  - **计划 subject 的来源**（calibrator-2、order-change、feasibility-unresolved、plan-structure-change、计划的 loop-exhausted）：不渲染到任何 Constructor 或 Reviewer card；当前计划排队中的 Constructor 仍可派发，要等重新规划生效才变 superseded。
  - **探索的来源**：没有追踪（未核实）。
  - **Secretary × 同一 subject 上的其他升级**：会过时（通过 `earlierDecisions`）。
  - **PM 的 `decision` 需求条目**不是升级，但"计划之后记录"的会印在每张 Constructor card 上；认领之后才记的话，没有任何升级也会造成过时的 card。

### 13.3 Constructor 提问的端到端流程〔源码〕
1. 产物被记录，提出 `cdec.<con>`（每一轮都会重提，直到它存在）；
2. 它的 Secretary 步骤 `sec.cdec.<con>` 以优先级 120 排队；
3. 验证运行，然后 Reviewer 以优先级 60 排队；
4. Reviewer 的 `selfReportedGaps` 只有 `unmet_standards` 和 `unfixed_problems`（execution.ts:2483-2486），**它既看不到问题也看不到答复**；
5. 即使 cdec 还开着，判为通过也会被接受；
6. 之后的 `answer` 被标为已应用（`answer` 分支，约 :2081），只到达以后的 card；
7. 已接受之后再来的 rework、replan 或 abandon 会怎样：没有追踪。
- "为什么不阻塞"：只有一句代码注释"任务同时继续进入复审"（execution.ts:741-742）和 layers.ts:38-39 的"是流程的一部分"；设计文档和 CHANGELOG 里没有找到专门的理由（搜过 constructor-decision、decisions_needed、non-blocking）。

### 13.4 通知和 WI〔源码 + 文档〕
- WI 页面（`engine/plugin/pm/wi/`）处理方式〔文档〕：照做即可的 WI-05、06、13、20、24、32；要凭给出的事实判断的 WI-01–04、07、16、21、23、25、26、29–31、33；走裁决 card 的 WI-08、WI-33；只进 PM 收件箱的 WI-34。
- 手册里依赖"Secretary 自己记得"的句子〔文档 + 源码〕：SECRETARY.md:85（确认 note 前要考虑其中的指示；而 note 一经确认就从 `next` 消失，没有任何读取能列出，也到不了 card）、:78（重复失败要换思路；部分由 card 的 `facts.reason:'no-progress'` 和 `earlierDecisions` 支撑）、:134（席位活着就等、没了就释放）、WI-19:24、WI-28 的"How to choose"、WI-33、WI-31:34。
- 4.2 的一次性 Secretary〔源码：`git show v4.2.0`〕：`submitSecretary` 以优先级 120 排一个 `sec.<id>` 步骤（flow/secretary.ts:131-149）；由 PM 像别的席位一样派发；工具档是 `materials`；角色页规定只凭 card 和材料判断、不许用别的 `mp` 命令。4.3 改成常驻的成文理由只在 PS §1；**仓库里没有任何现场记录显示一次性 Secretary 的裁决是错的、慢的或没被用**（最接近的是 ER:71 的一条分析，已由 4.1.2 的 `earlierDecisions` 修掉）。
- 记忆里任何实例都能读到的跨裁决知识〔源码〕：`missions/<m>/decisions.md`（process/ports.ts:212-218）、`requirements.md`、`notices.md`；升级、裁决、applied、pm-answer、user-answer 事件；通知（含已确认的，`alerts --all`，cli/commands/pm.ts:1245）；循环和 grant 的状态；`mp read status|blocked|show|leaf|why|from|chain|tree|full-runs|words|secretary`（cli/commands/read.ts:192）。**Secretary 没有任何自己的工作笔记**（记录种类见 memory/events.ts:42-50）。
- 新实例从记忆里**恢复不了**的〔推断〕：已确认的 PM note、Secretary 没记下的推理、席位对话（报告之外）、harness 状态（哪些子代理活着、它们的句柄、用户直接说过什么）。

---

## 14. 撤回和重派额度；card 是否被读过；叶子不可改

- 记账〔源码：process/pm.ts:546-554；work.ts:247-254〕：在途的派发被 `release`（`--ended` 和 `--abandoned` 一样）时，若该线的循环未用尽，追加一条 `loop.attempt`（循环 `quarantine-restart`，签名 `release:<D>`）并重新排队；用尽则不排队，flow 看到 `exhausted`（process/ports.ts:444-448）→ loop-exhausted 升级，WI-08（flow/failures.ts:58）→ grant 才能重新排队（test/p43-decisions.test.ts:181）。
- 上限是 **2**（common/records.ts:634），**按线计**，所以 Secretary 和 Reviewer 步骤的撤回和任务共用同一个额度（test/process-coverage-a3.test.ts:274）。停止之后的 restart 也计数（ports.ts:527-539）。
- 不计数的先例：mission 关闭造成的释放（pm.ts:541-548）、Secretary 的 moot 释放（seat.ts:709-713）。
- **没有任何东西检查席位读没读过 card。**`seatCard` 只是读叶子加哈希校验（seat.ts:117-124），席位命令不写操作回执（cli/main.ts:154）。会留下记录的只有：`read`（材料页，seat.ts:152-154）、`run`、`detached`、`checkout`、被拒的交回。
- 文档叶子**写一次**，其他内容报 `FACT_CONFLICT`（memory/leaves.ts:169-171）。所以"重新定稿"意味着新叶子加新事件；而 `dispatchView` 取 `claimed[0]`（seat.ts:103），交回时的检查（必读、绑定、记录）都对照那个 spec。
- 可检查的"没读过"条件〔推断〕：`dispatch:<D>` 线上没有 `read`、`run`、`detached`、`checkout`、`refused` 事件（再加一个新的"已送达"回执）；Constructor 还要 worktree 干净，因为编辑不留记录。漏洞：可以无成本地无限派发再撤回，需要单独计数。

---

## 15. 复审、带风险接受、检查、修复、按条目的状态

### 15.1 复审的产出〔源码〕
- 交回 schema（seat/results.ts:40-64）：
  - `judgments[]`：`{standard, met: yes|no|unclear, reason, evidence[]}`，card 上每条标准恰好一条（:197-211）；
  - `gap_responses[]`；
  - `issue_responses[]`：`{issue, response: fixed|not-fixed|deferred, reason, owner?}`，deferred 必须有 `owner` 和 `reason`（:217）；
  - `findings: string[]`：**纯字符串，没有编号、严重程度、依据**；
  - `verdict: pass|rework|needs-decision`（映射 pass/fail/undecided，:251）；有任何标准不是 `yes` 时 `pass` 被拒（:219）；
  - `reopen[]`：只有集成任务。
- 标准只有 `{id, text}`（flow/plandoc.ts:179；seat/card.ts:44）。**没有必须和可选之分，没有权重**。执行复审没有严重程度；严重程度只存在于探索的发现（seat/cards/crititor.ts:70）和 Architect 的计划发现（`blocking|risk`，seat/cards/architect.ts:158）。
- Reviewer 的证据只能是 `evidence:<run>` 或快照内的 `file:`（results.ts:176-183），`statisticalOrExternal: false`（execution.ts:2547）。`data:` 指针（仓库之外、带 sha256 和大小）只用于实验和探索（seat/cards/experiment.ts:59；seat/cards/researcher.ts:284）。**没有任何东西记录执行任务在仓库之外（模拟器、人工）被验证过。**
- 存下来的判决（results.ts:257-281）：JudgmentRecord，带 `issues: IssueResponse[]`；推迟的理由存为内容哈希（:272, 284）；每条 finding 变成一个 IssueRecord `finding:<hash>`（:298-309）。
- 任务线上的 `review` 事件（execution.ts:1526-1533）：`issues` 是**文本行**——`"[S] not met|unclear: why"`、`"finding: …"`、`"issue X not fixed: …"`；`deferred[]` 是 `"issue X deferred to O: …"`。
- Reviewer 的合同行是 `std.<m>.<task>.<std>` 加需求条目，固定在目标的 ReviewContract 里（seat/cards/inputs.ts:12-17），刷新时保留（refresh.ts:149-152）。
- object 约束通过判决记录约束证明：`objectConstraints` → `binding.constraints`（inputs.ts:19-27；refresh.ts:153-154）；证明侧要求起决定作用的判决覆盖每条适用约束的范围（evaluator/semantics.ts:780-811）。所以新加的 object 约束会让对象"未完全证明"；对计划来说就是 WI-34（flow/plan-constraints.ts；"稳定模式的生产等待"）。instruction 从不是证明输入。
- 修改标准而不整体重新规划：只能通过修复 amendment 的 `changed` card，而且只对**没有已接受产物**的任务（plandoc.ts:255-259；repair.ts:321）；仍然是新 spec 加新尝试。`reanswer` 不是修订，只是给同一次尝试重判用的引文。
- `reviewer-issue-deferred`（execution.ts:1534-1543）是 `wi: null` 的通知，默认动作"保持未修复并在收尾时列出"。推迟本身存在判决的 `issues` 里（带自由文本的 `owner`），并被带下去：`deferredInstructions`（:1667）放进之后的返工指示；之后的 Reviewer card 把它列为开着的问题并附"上次的回应"（:2492-2506）；收尾从 `lbl_fixes` 加起决定作用的判决里读（process/close.ts:280-300）。
- 下一张 card 上的"上一次复审"：`previousReviewOf`（:2576-2586）从席位的交回结果重建结构化的 `{standard, met, reason}`；结果读不到时**用正则解析问题文本**（:2583）。
- 修复状态：`FixState = fixed | fixed-not-fully-proven | unfixed`，按 (target, issue) 存在 `lbl_fixes`（evaluator/semantics.ts:105；evaluator/store.ts:140）。

### 15.2 带风险接受〔源码〕
- 在哪提供：循环用尽时 `rework()` 的选项 `grant, replan, accept-risk?, abandon, ask-user`（execution.ts 约 :1996）；`reviewer-needs-decision`（:858）。
- 何时提供：`riskAcceptable`（交回已验证、没有通过，:1148-1158）；`failedRunsRisk`（PR 70 加的：运行失败，升级带 `pmOnly: ['accept-risk']`，:1166-1177, 1997；`secretaryOptions` 把 pmOnly 选项从 Secretary 的 card 上去掉，flow/secretary.ts:106；只有 PM 或用户能裁，:1255）；另有重新绑定（:1184）和集成重开（:1345）的变体。
- 升级带什么：`reasons` 是 `[...review.issues]`，即**文本行**，加失败运行的文本；`facts` 是 `{task, attempt, loop, issues(文本), attempts, allowed, reason}`（:1995-2000）。结构化数据只能间接取回：`handover.from` 指向 Reviewer 任务（:2002, 2017），它的交回结果里有带标准编号的 judgments。
- 接受时写什么：`acceptWithRisk`（:1241-1286）写 `accepted` 事件 `{k, product, judgment: j.user|j.pm|j.sec.<esc>, decision:{escalation, option:'accept-risk', by, words?}, risks: string[]}`，每条 risk 是 `"accepted with its risk by … on <esc>: <理由文本>"`；`carryOut` 写裁决者的判决（一个撤销否定的 pass）。
- 之后的读取：`riskAcceptance` 解析器（:208-218）；树多一行检查"…N open finding(s) on the risk list"（cli/tree.ts:449-450）；**status / layers 只标 "accepted"**（cli/layers.ts:132），不区分；收尾写 `acceptedWithRisk[]` 并摊平进 `risks`（process/close.ts:206, 231-233, 316）。
- **证明标签是"已证明"**（判决撤销了否定；test/flow-rebind-accept-risk.test.ts:80）。所以标签不标记带风险接受；要区分只能看 `accepted` 事件的 `decision.option`。
- **没有任何东西以 risks 为条件**；没有按 mission 或按条目的列表，只有收尾时列。

### 15.3 交付、落地、收尾的检查〔源码〕
- 收尾从不因工作本身拒绝；只拒错误的模式、缺少的原话条目、未知的 mission（process/close.ts:4-11, 429-442）；其余进快照的 `risks`。收尾快照列出：证明、未证明、带风险接受、问题、未完成、已放弃、开着的升级。
- 交付只拒机械问题：正在重算、未知目标、未放置的产物、不兼容、冲突、描述不符、对象不可用、重建上限、ref 不符或待定（cli/commands/pm.ts:862-899）。"未完全证明"的条目**只报告不拒绝**（:867-871）；"被取代的前置"规则（delivery/candidate.ts:613-622, 675-680）只是给"未完全证明"加一个 `built-on-superseded` 理由。
- 落地只因 git 状态拒绝：锁文件、有另一个未完成的意图（WI-06）、基线移动导致重建（git/land.ts:173, 534, 611）；只做 fast-forward〔文档〕。`finish` 在交付或落地因这些被拒时停下（pm.ts:1189-1240）。
- 停止是唯一由人的话驱动的"拒绝工作"。
- 豁免模型〔源码：flow/waivers.ts:1-40〕：`reviews-waiver` 事件，带 `check`、`n`、`action waive|withdraw`、范围、`by words|authority`、理由，以及一个在各处读取时显示的标签；`WAIVABLE_CHECKS = ['plan-reviews']`，代码注释说以后可以加（:21）。

### 15.4 修复〔源码〕
- `RepairBody {id, words, kind, text, about: task|exploration|null}`（flow/plandoc.ts:387-396）；修复要求用户原话，文本逐字（cli/commands/pm.ts:547-556）。
- 结果 `RepairDecidedBody {add, reopen[{task, issue, attempt, product}], changed?}`（plandoc.ts:398-406）；新增的任务在 `AmendmentEntry.repair` 里（:248-259）；查找：`repairOfTask`（:306）、`repairsOfWork`（execution.ts:1507）。
- 状态是 `exploration|answered|architect|decided|waiting`（flow/repair.ts:68, 117）。**没有"完成 / 已修好"的状态**：没有任何东西推导"这个修复的任务都被接受了"。
- 每次 Architect 尝试钉住 `dplan`；修复 card（计划、已接受的产物、owners、约束）在提交时构建一次（repair.ts:366-405），从不刷新（refresh.ts:49）；新计划生效时取消排队中的步骤并开新尝试（repair.ts:222-225）。**修复不能修订**，只能再开一个（issue 60、61）。
- 把失败追到任务：`mp seat <id> owners <path>`（`pathOwners`，execution.ts:2626）把路径追到已接受的产物；Reviewer 的 `reopen` 也这么做。
- **修复或任务与某个具体问题或 finding 编号之间没有任何链接**；推迟的 `owner` 是自由文本。

### 15.5 按需求条目能算出什么〔源码〕
- 链接：PM 计划元素 → `items`（plandoc.ts:66）；DetailedTask → `requirementItems`（:181）；Constructor card 带着条目，图上的边是派发 "serves" `requirement:<version>`（cli/tree.ts:703-708）；任务 → 产物 → 判决 → 标签；交付条目 → 标签。
- 能算：未开始 / 进行中（任务线最后一个事件，`TASK_LABEL`，cli/layers.ts:132 起）；复审通过后接受 vs 带风险接受（`accepted` 的 `decision.option`）；已放弃；已交付、已落地（deliveries 加 `notFullyProven`）；证明标签（`lbl_labels`）；较旧的环境。
- 算不出：**在仓库之外验证过**（见 §15.1）。
- 现在需求条目只标"生效 / 撤回 / 有争议"（cli/layers.ts:224）。没有命令按条目汇总；`mp read from item.<m>.<id>` 和 `why` 只是沿链接走。
- 成本：`resolveSubtasks` 和 `buildGraph` 已经读每一行 `flow_events`、`tasks`、`dispatches`、`lbl_labels`（layers.ts:167-195；tree.ts:118 起）；按条目读取与 `mp read status` 同价。process/secretary.ts 的 `allFlow`（:112）也是全表扫描并解析每个 body。

---

## 16. `mp sec next` 的步骤；通知；程序驱动循环所缺的

### 16.1 一次 `sec next` 做什么〔源码：process/secretary.ts:200-206；process/pm.ts:320-383〕
1. `touchSecretary`（写）；
2. `settleLabels`（写）；
3. `recoverLandings`；
4. `tidyWorktrees`：每个曾有 worktree 的已结束派发一次 `git worktree list`（补丁后目录不存在就跳过）；
5. `sweepTmp`，上限 1.5 秒；
6. `advance`：每个 mission 的每个 flow 步骤，最多 50 轮；`secretaryRound` 每个升级读一遍（补丁前是整个 mission 的事件）；
7. `readSteps`；
8. `detachedRunNotes`；
9. `listNotices`：扫描每一条 alert，然后标为已送达（写）；
10. `allFlow()`：解码每个 flow body；
11. `pmInbox()`：对每个 waitingOnUser 条目跑一次，每次是完整的 `allFlow` 加嵌套扫描；
12. 列出所有过去已应用的 PM 和用户裁决。
- 随历史增长的：4、6、9、10、11、12。每次读 body 都重新哈希（issue 69；补丁加了进程内缓存）。
- `mp sec wait` 每 30 秒跑一次完整的 `secNext`。
- 有 live 代际时，PM 的命令和读取不做运行层面的恢复和对账（不 `advance`、不做落地或搬迁恢复、不做裁决的拒绝和重排），由 Secretary 的命令做〔文档：PS A.3〕。

### 16.2 通知〔源码〕
- 状态：undelivered、delivered、acknowledged（memory/domain/pm.ts:85）。`listNotices` 只隐藏已确认的（process/notices.ts:45）。
- Secretary 只能确认受众是 Secretary 的通知（process/pm.ts:387）；受众是 PM、关联着升级或带 `resolvingCommand` 的通知不能确认，条件满足时自动清除（process/noticeAudience.ts；secretary.ts:150, 164, 189）。
- **没有任何流程逻辑以"是否已确认"为条件**（grep `'acknowledged'` 没有守卫性的用法）。
- `wi: null` 的类别（grep，近似）：accept-risk-moot/waits、calibrator-1-returned/unavailable、capacity、dependency-abandoned、early-start-rebuilt、exploration-*、integration-restarted/start-conflict、kept-product-not-rebound、kept-products-rebind-review、legacy-prerequisites-*、legalization-plan/stamped、plan-revision-restarts-work、plan-task-still-abandoned、reopened-task-abandoned、repair-decided、result-not-fully-proven、reviewer-issue-deferred、rework-carry-dropped。
- `engine/plugin/pm/wi/INDEX.md:41` 只把 integration-restarted、integration-start-stale、early-start-rebuilt、accept-risk-moot 称为"信息"；现场最吵的三类（kept-product-not-rebound、reviewer-issue-deferred、repair-decided）不在其中，它们的说明在 SECRETARY.md:182, 198, 214。
- note 和问答〔源码〕：记录形状在 memory/events.ts:44-48，`pm.note` 是 `{id, text, words, acknowledged}`；`channel()` 只列未确认的 note、未回答的问题和全部 PM 回复（process/secretary.ts:42-47）；**没有别的读取显示它们，它们永远到不了 card**。读全部 note 只需要对 `residentRecords(…,'pm.note')` 去掉那个过滤。

### 16.3 程序（而不是模型）驱动循环还缺什么〔源码〕
- 数据缺口见 §3.2。
- 今天仍需要读文字或靠模型的步骤：Secretary 的裁决（`sec card` / `read` / `decide`，要读必读页）；每个指向 WI 页面的通知；`held` 的理由（文字）；停止的确认（要 harness 确认席位结束）。
- 假设"跑循环的是一个对话"的地方：身份取自 `MP_SECRETARY`；代际在写入时围栏；启动提示是 `claude --bg`（cli/commands/secretary.ts:28）；60 秒宽限（secretary.ts:34）；固定 prompt（process/pm.ts:504）；手册假设子代理、"确认席位结束后再 `release --ended`"、"mp 从不判断席位死没死"〔文档：SECRETARY.md:61, 126, 154〕。

### 16.4 worktree 和磁盘〔文档 + 源码〕
- Constructor 的 worktree 在 `.mission-pipeline/worktrees/<dispatch>/`，交回被记录后或以 ended 释放后删除；abandoned 保留。
- 只读席位共用 `tmp/checkouts/<commit>/`（一个提交一份，没有在途派发持有时删除）；运行用 `tmp/<run>/` 的干净检出（借用项目的对象，跑完删除，之后再跑 `cleanupCommands`）。
- `mp sec next` 最多花 1.5 秒清扫无主的 scratch；`mp pm clean [--mission]` 不限时并报告释放的字节。共用只读检出和清扫是 4.1.2 才加的（MP41 附录 O.5）。

---

## 17. 哲学和机制

### 17.1 候选哲学清单（**撰写者从 4.0 到 4.3 的设计文档里抽取，尚未经维护者审阅**）
括号里是出处的裁决编号（裁决的转述在 MP41 §0、PS §2、UA、ER）。
1. 结果对用户负责；PM 是用户的锚，防止长时间的自动工作跑偏。（F-1）
2. 用户记录下来的话是权威的根；需求引用它；只因被取代、范围结束或一次性而失效，不因时间。（F-7、F-8、F-9）
3. 用户决定过的事由他的话了结；每个停下来的地方都有一个用户的话能走的出口。（E-1、E-2、E-5）
4. 用户管方向，不验收细节；只有最重要的决定到用户面前。（U-10、D-9、D-12）
5. 收尾从不被阻止；记录如实写明已证明、未证明、未完成和有风险的部分。（D-11）
6. 证明归程序：证据可复现、有哈希；程序不替席位下判断，用户的话不冒充证明。（U-15、U-16、E-4）
7. 每个角色只对自己的范围负责；完整证明在集成处，失败退回造成它的任务。（D-4 到 D-7）*可能只是机制。*
8. 写不出验收标准的任务靠经受攻击来验收；Stabilizer 防漂移；按状态而不是轮数判断结束。（U-6、U-7、E-3）
9. 席位是角色，填席者随时可换，只作为信息记录。（U-1、U-5）
10. 席位只知道自己的直接上下游。（v51 原则 5、6）
11. 锚和操作者分开；现场的事在计划内决定；决定不随会话丢失。（F-1 到 F-5）
12. 记忆中立：任何 harness 只凭文件夹就能重建项目。（U-2）
13. 数据库是骨架，Markdown 是叶子；细节只记指向。（U-13、U-14）
14. 读写记忆只有一条受保护的通道，每个角色有自己的命令集。（U-3、U-9）
15. 安全、登录和花费是 harness 的事。（U-3）
16. 大体正确就够；边缘情况给检测、安全默认和工作指引，不加新机制；先砍执行上的冗余。（D-1 到 D-3、U-8）
17. 停止立即生效，先于一切。*没有找到维护者单独的裁决，只在 README 和设计正文里（MP41 §6.6 标的是 [v51, adapted, mine]）。*

### 17.2 文档自己标为"细节 / 机制"的条目〔文档〕
- MP41 里"Author's decision under D-12"：按复用键的运行锁（MP41:160）、`runMethod=v2`（:187）、worktree 链接校验（:137）、§12 的 10 到 12 项。
- MP41 里 [mine]：目录布局和 journal mode（§3.1）、30 秒忙等、2 秒写预算、2 万单位的传播目标（§4.1）、存储的标签、派发循环（§5.1）。
- PS §4 标题就是"Mechanics（细节，除非引用了裁决）"：代际、`mp sec wait` 的 300 秒和 30 秒、通知受众、游标、8 KiB 上限、附录 A 和 B；F-3 的缺口默认值也标了 detail（PS:16）。PS:3 写明 F-1 到 F-9 是维护者的裁决，标 detail 的是撰写者的。
- v51:7：没标"维护者"的都是撰写者的细节决定，包括原则 7"权限靠机制，不靠 prompt"、沙箱和专用工具（都在 4.1 被移除）。
- 本身就是机制级的维护者裁决：U-18（alternates 和 hooks）、U-19（每条声明的命令都拿运行锁）、U-20、U-22、U-23、U-11（文档用英文）、U-12（版本号）。

### 17.3 张力（只陈述，不解决）〔文档 + 推断〕
- U-1（实现不强依赖某个模型或 harness）对"深度嵌入一个 harness"。维护者后来的澄清把保证收窄为记忆中立（U-2）。
- U-2 对界面里持有的状态：嵌入版里用户在界面上的异议和分类必须落进文件夹，否则重建会丢。
- U-3 和"只有三部分"（MP41:60）对进程内嵌入或把状态放在 harness 里。
- U-4（PM 用自己的 harness 派人）对 F-2（Secretary 跑循环、起席位）：维护者已改过一次。另外 MP41:75 说 `mp` 不起席位、不跑后台服务，而附录 P.10 说后台 rerun 跑在 `mp` 自己起的 worker 进程里（MP41:200）。
- F-2（Secretary 回答问题但不接受指令；用户通过 harness 找到它）对一个能直达 Secretary 的界面。
- F-6、F-7（类型行、下一条消息无异议才记录）是按"一来一回的对话"定义的；换成独立的分类席位加界面会同时移动分类者和异议通道。
- v51 的"只有一个 PM，就是用户屏幕上的对话"对新增的交互面。
- F-5（没有 PM 会话时给 PM 的问题就等着）对一个常驻的宿主。
- E-1（提高用户的话语权）对 D-9、D-12（用户不验收细节）；CHANGELOG.md:93 的调和是：提高的是对决定的权力，不是提问的次数。
- U-13（席位的对话不保留，属于 harness）对一个什么都保留的 harness：重建不能依赖那些对话。
- U-3（安全归 harness）对 v51 原则 7：按角色的沙箱把"靠机制的权限"带回来，但放在 harness 里。
- F-2 的原文把"常驻对话"和跑循环、起席位、处理通知、回答问题绑在一起；没有任何裁决单独回答"判断（区别于循环）是否必须在同一个对话里"〔推断〕。

### 17.4 4.0 的教训〔文档：CHANGELOG 4.0.0 / 4.1.0；MP41 §7〕
- 4.0 自己拥有：席位是跑在 Agent SDK 席位宿主里的独立 Claude Code 进程，带进程内的专用工具和计量代理；bubblewrap 沙箱和 cgroups；单写入者的 ledger 服务，外加 evaluator、scheduler、watchdog；启动自检和工具链冻结；systemd 单元。
- 4.1（隔天发布）全部移除，外加凭据、模型配置、`mp install`、`watch-notices`。成文理由：把席位绑在一个 harness 上（违反 U-1）；安全是 harness 的事（U-3）；由 PM 派发（U-4），SQLite 事务取代单写入者服务。
- 相关裁决的转述：U-1 要的是一套工作流程，席位像员工一样可换，不强依赖某个模型或 harness；U-2 记忆中立，拷走文件夹换任何模型和 harness 都能恢复；U-3 CLI 是给任何能调用工具的 harness 读写历史的方式，SQLite 用于记忆、追踪和断点恢复，安全不归 MP 管；U-4 由 PM 用自己 harness 的子代理功能派人；U-12 版本号沿用 4.x，4.0 不是想要的东西，不单独留版本号。4.3 不读 4.0 的 ledger。

---

## 18. 测试文件索引（在 `engine/test/`，供扩展用）〔源码〕

**card、约束、决定、刷新**
- `p3-plans-constraints.test.ts`：各类 card 认领时对晚到的决定和约束的刷新（:151-178, 285-293, 306, 329）；引文时机；授权被撤回时的 Secretary 轮次。
- `int-dispatch-plan.test.ts`：引文的参考计划；固定契约下的 Reviewer；被取代的 Constructor（:172）。
- `flow-rebind-kept-products.test.ts`：保留产物、相关通知、Reviewer 和 Constructor 对引文的刷新（:1203, 1225, 1239-1242）。
- `process-escalation-scope.test.ts`：答复以 spec 为界（F1d，:224）。
- `p413-constraints.test.ts`：`**` 指令到达无写路径的任务；约束模式和触及范围。
- `flow-exploration-card-constraints.test.ts`：探索 card 的约束。
- `process-cards.test.ts`、`seat-card.test.ts`：每种 card 的渲染；Reviewer 交回规则；推迟必须有 owner 和理由（seat-card:164）。
- `flow-plan-recheck.test.ts`：计划之后记录的条目。
- `p414-fixes.test.ts`：共享或复用的升级和 grant；Secretary card 和 Reviewer card 的刷新（:222, 497）。
- `p3-stabilizer-r1.test.ts`：认领时的刷新（:144, 393, 496）。

**就绪列表、认领、停止、租约、撤回**
- `memory-domain.test.ts`：停止（原话、拒绝、收窄，:304）；认领和迟到的交回（:345）；队列状态（:406）。
- `process-dispatch.test.ts`：撤回重排并计数、两次重派后 WI-08（:28, 61）；有在途派发时的停止（:95）。
- `process-coverage-a3.test.ts`：优先级、`parallel`、租约（:153, 180）；被停止按住的步骤（:239）；Secretary 的撤回计入它的线（:274）。
- `p413-dispatch-retry.test.ts`：`OVER_BUDGET` 重试（:48）。
- `cli-layers.test.ts`：`mp read status` 和 `blocked`（:106-259）。
- `flow-exploration-predecessors.test.ts`：`after` 的按住（:105, 238）。
- `process-exploration-resnapshot.test.ts`：认领时的快照（:137-301）。
- `disk-housekeeping.test.ts`：撤回后的清理（:241）。

**裁决、常驻、收件箱**
- `p43-decisions.test.ts`：`sec card` 的认领、替换、grant 重排（:17, 41, 181）；常驻的 ask-pm 到达收件箱（:17-36）；必读、PM 答复、原话失效。
- `p43-resident.test.ts`：代际、围栏、身份、未确认席位（:22, 70, 109, 138）；`p43-runtime.test.ts`：什么会叫醒 `wait`（:37）。
- `p43-review-r1.test.ts`：收件箱通知、`sec ask-pm`；`p43-words.test.ts`、`p43-plan.test.ts`、`p43-exploration.test.ts`、`p43-fixtures.ts`。
- `flow-execution.test.ts`：card 和返工循环；用尽时的选项含 accept-risk（:112）；`earlierDecisions`（:464）。
- `flow-decision.test.ts`：正常路径和 Calibrator ①。

**带风险接受、收尾、读取**
- `local-runs-accept-risk.test.ts`：issue 67 的修复（pmOnly、失败的运行作为风险）。
- `flow-rebind-accept-risk.test.ts`：issue 57 的修复；标签是已证明（:80）。
- `final-fix1-upgrade.test.ts`：收尾快照；"从不拒绝"。
- `cli-tree.test.ts`：`mp read why` 的归属；`cli-reads.test.ts`：探索的读取、环境变化。
- PR 70 新增的其他：`local-rule4-tail.test.ts`、`memory-data-text-cache.test.ts`、`process-tidy-worktrees.test.ts`。
- `cli-mission.test.ts`：用 shell 调用的 `mp` 跑完一整个 mission。

---

## 19. 没有核实、或只是推断的条目

- **issue 62 的根因没有确定。**读代码得到的线索：`pmInbox`（process/secretary.ts:116-140）只在升级 `routed` 时列出它（:134），这要求在 `round.key` 下有一条分类为 needs-user / needs-pm 的 `decision` 事件；`readSteps.waitingOnUser`（process/pm.ts:306-325）用的是按 **`e.key`** 取的裁决，不是重试轮的 key，它喂给 `mp read blocked`。候选原因：`secretary-retry` 之后 `round.key` 和 `e.key` 不一致；secretary.ts:146 处跳过通知。现有测试对合成的升级是通过的。**需要用 constructor-decision 和 loop-exhausted 加重试轮做一次复现。**
- 3 个失败测试的原因是推断（root 运行）；第三个没查。Windows 的 83 个失败没有分析。
- "必读回执只证明命令执行过，不证明内容被读到"是〔推断〕：按现场数字做算术，那么大的必读材料不可能每次都完整进入 Secretary 的上下文；要翻它的会话记录才能确认。
- "升级之前已排队的步骤仍可派发"是从"就绪列表不看升级"推出来的，没有用测试确认。
- 探索类升级的阻塞性和过时组合没有追踪。
- 已接受的尝试之后再来 rework、replan、abandon 对 constructor-decision 的答复有什么影响，没有追踪。
- "所有基于授权的决定上每张 card"没有找到成文理由（搜过设计文档、backlog、CHANGELOG）。
- 约束"重录文本会挪到末尾、只改范围不会"是读排序代码得出的推断。
- `plan-restarts-work`、`issue-disposition`、`cost-overrun` 三个升级来源有声明但没找到提出位置。
- 子代理对 Secretary card 大小的估计（1 到 3 万字符）和现场实测（30 到 34 万字符）差一个数量级；任何依赖前者的结论都不可用。
- 一个子代理说仓库文本里搜不到 "#54" 和 "#68"；这两个 issue 存在于 GitHub 上（另一个子代理通过 REST 读到），只是源码和文档里没有引用它们的编号。
- 每条 `mp` 命令的启动开销没有成文数字，也没有测过。
- `mp read status --no-mark` 这个开关来自现场答复，没有在源码里核对。
- 各处行号：多数读自补丁合入前的树，§1 开头说明的五个文件会有漂移。
