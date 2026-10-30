# DSH Agent Teams 实战手册

> 面向使用者的 Agent Teams 实践指南，补官方 README 没覆盖的**决策与踩坑**。
>
> **本文非官方文档。** 上游是 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（public, MIT），
> 本文所有事实以 tag **`dsh-v0.2.1-rc.3`** 的源码为准，每条结论标注 `文件:行号` 可自行核验。
> 上游在演进（撰写时 master 已到 `0.2.2-alpha.2`），若结论过期以源码为准。

---

## 目录

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| **本 README** | 决策树、名额规划、派活、写作用域、速查表 | 开始用之前通读 |
| [`docs/task-state-machine.md`](docs/task-state-machine.md) | 三态扩展为「规划中/实现中/测试中」的方案与边界 | 需要更细的进度表达时 |
| [`docs/roles.md`](docs/roles.md) | pm / arch / dev / sdet / qa 角色契约与验收证据要求 | 建 Team 前定分工 |
| [`examples/task-templates.md`](examples/task-templates.md) | 5 个可直接复制的任务模板 + 派活自查清单 | 每次派活前 |

---

## 这是什么

DSH 的 Agent Teams 让一个 Lead agent 可以创建多个持久化 teammate，通过**点对点消息**和**共享任务板**协作，全部状态经 journal 持久化，重启可恢复。

四个包的关系（`agent-team-profile` 是聚合层）：

```
@deepseek-ai/dsh-experimental-agent-team-profile    聚合层：cordis.patch.yml
├── @deepseek-ai/dsh-experimental-agent-team        核心服务：roster / 任务板 / 消息 / journal
├── @deepseek-ai/dsh-experimental-tool-agent-team   模型侧 9 个工具 + 2 个 system-prompt 段
└── @deepseek-ai/dsh-experimental-client-ui-agent-team   Web 侧 UI
```

`agent-team-profile` 的 patch 文件同时**禁用了 4 个单 agent 工具**（`tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-list-agents`），把直接委派收敛到 Team 工具上——所以启用 Team 后 `subagent` 不再是选项。

### 提供哪些能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 建成员 | `spawn_teammate` | 仅 Lead 可调；`context: fresh \| fork` |
| 点对点通信 | `send_message` | 任意成员之间；Lead ↔ teammate、teammate ↔ teammate |
| 看名册 | `list_agents` | |
| 等进展 | `wait_agent` | 等下一个状态/消息/任务变化 |
| 打断 | `interrupt_agent` | 仅 Lead；**不释放名额**，见 §2（`interrupt` 配置项默认为 `true`，设为 `false` 可整体关闭该工具，见 `tool-agent-team/src/index.ts:28`） |
| 任务板 | `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` | 共享 DAG，含 `blocked_by` 依赖与 `expected_revision` CAS 并发控制 |

---

## 1. 什么时候该用 Team，什么时候不该

这是本文最想先讲清楚的。Agent Teams 有**固定成本**（名额不可回收、消息开销、共享 cwd 的写冲突风险），不是免费的并行。

### 决策树

```
任务能否拆成 2+ 个互不依赖、可并行的子问题？
├─ 否 → 单 agent 直接做。不要为了"显得专业"建 Team。
└─ 是 → 子问题之间是否需要共享决策 / 中途对齐？
        ├─ 否 → 各自独立跑完再汇总 → ✅ Team 是好选择
        └─ 是 → 取决于对齐频率：
              ├─ 高频对齐（每步都要同步）→ ❌ Team 不合适，
              │     消息开销 > 并行收益；改用单 agent 串行
              └─ 低频对齐（只在关键节点）→ ✅ Team 可行，
                    用共享任务板表达依赖，而非消息轰炸

额外的否决条件（任一命中就不要用 Team）：
  ✗ 子任务会写同一批文件（写作用域无法切分）→ 文件冲突，见 §5
  ✗ 子任务需要跑同一份构建/测试且互相干扰
  ✗ 任务总量小到协调成本占主导（比如 3 个小改动）
  ✗ 你已经用满名额且无可复用的闲置成员（见 §2，名额不可回收）
```

### 适合 / 不适合的典型

| ✅ 适合 | 理由 |
|---|---|
| 多角度调研，最后汇总成一份文档 | 天然并行、写作用域互相隔离（各写各的文件） |
| 大规模机械改造（几十个文件同一种改法） | 按目录切分，依赖少 |
| 一边调研一边实现（调研完 pm 出需求、dev 实现） | 用任务板 `blocked_by` 表达阶段依赖 |
| 对抗式验证（一个实现、另一个找 bug） | 视角不同，交叉验证价值高 |

| ❌ 不适合 | 理由 |
|---|---|
| 单个 bug 的诊断修复 | 串行推理，并行只会让信息碎片化 |
| 需要频繁对齐的设计工作 | 消息开销超过并行收益 |
| 多个 agent 改同一个文件 | 无文件锁，必然冲突（§5） |
| 需要精确顺序的数据库迁移 | 顺序性 >> 并行性 |

---

## 2. 名额与角色规划（**最容易踩的坑**）

这一节纠正网上流传的两个错误说法。**先看结论**：

> **默认上限 16 个 teammate；当前 profile 配置为 8 个 teammate。**
> **lead 不计入该上限。** `state.members` 数组里只有 teammate。
> **名册没有删除机制，名额不可回收。**

### 2.1 上限到底是多少

三个数字，别搞混（源码 `packages/experimental/agent-team/src/index.ts`）：

```ts
const DEFAULT_MAX_MEMBERS = 16            // L42 代码默认值
const DEFAULT_MAX_TASKS = 256             // L43
const DEFAULT_MAX_MESSAGE_BYTES = 65_536  // L44
```

```ts
maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),   // L60
```

而**当前生效的 8 来自 profile 的显式配置**，不是代码默认值
（`packages/experimental/agent-team-profile/cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8          # ← 这里把默认的 16 覆盖成 8
        maxTasks: 256
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000
```

### 2.2 lead 到底算不算名额

**不算。** 证据链：

`roster.ts:257` 的上限检查只针对 `state.members`：

```ts
if (state.members.length >= this.maxMembers) {
  throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
}
```

而 `state.members` 里**只有 spawn 出来的 teammate**——lead 是在投影阶段被单独 prepend 进去的
（`projection.ts:344`）：

```ts
const members: TeamMemberProjection[] = [{ id: rootId, name: 'lead', role: 'lead', phase: 'active' }]
for (const member of state.members) {        // ← 真正的 teammate 在这里
  members.push({ id: member.id, name: member.name, role: 'teammate', ... })
}
```

> **所以：`maxMembers: 8` = 8 个 teammate，加上 lead 一共 9 个 agent。**
> 看到"上限 8（含 lead）"的说法是错的。

### 2.3 名额为什么不可回收

因为**名册是只增不减的**。journal 只有两种事件类型（全仓 grep `appendAndFlush(root, '`）：

```
team/member      ← 只有新增
team/task
```

**没有 `member-removed` / `member-deleted`。** 三个直接后果：

| 行为 | 是否释放名额 | 源码依据 |
|---|---|---|
| teammate 变 inactive（没事干） | ❌ 否 | 只是 status 变化，roster 不变 |
| `interrupt_agent` 打断 | ❌ 否 | `roster.ts:187-197` 只调 `subagents.interrupt()`，**完全不碰 roster** |
| spawn 失败 | ❌ 否 | 以 `phase: 'failed'` **留在名册里照样占位**（`roster.ts:283-295`） |
| 进程退出 | ❌ 否 | — |
| 名字复用 | ❌ 禁止 | `TEAM_MEMBER_NAME_TAKEN` 查的是**全历史**（`roster.ts:254`） |

上游 README `README.zh.md` §已知限制 也确认了这点：

> "**扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用。"
> "**不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。"

### 2.4 由此推出的操作纪律

> **必须先规划 roster 再召人。做不到"边做边加"的弹性。**

实战规则：

1. **开干前写死成员清单**：需要哪几个角色、各叫什么名字，一次性想清楚。
2. **名字是永久资产**，起名要能表达职责（`infix-researcher` 比 `worker1` 好，因为失败重试时你得换个名字）。
3. **spawn 失败不要盲目重试同名**——`TEAM_MEMBER_NAME_TAKEN` 会立刻再失败，且失败条目已经占了名额。换名字重试。
4. **用满后靠"复用闲置成员"而不是"加人"**：把新任务用 `reassign` 或 `send_message` 派给已有的 inactive 成员。
5. **预算内预留缓冲**：8 个名额如果你规划了 8 个，那中途一次 spawn 失败就没救了。建议按 **≤7** 规划。

---

## 3. 任务状态机增强（上游只有 3 态）

用户常需要更细的流程状态：**规划中 → 实现中 → 测试中 → 已完成**。但上游只有 3 态。

### 3.1 先说清上游到底有什么（以及为什么改不了）

任务状态枚举（`types.ts:72`）：

```ts
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
```

`deleted` 是删除墓碑，不是流程态。**真正可用的流程态只有 3 个。**

**为什么不能直接加状态**——三层都封死了：

1. **工具层没有 `status` 参数**。`team_task_update` 的入参只有固定的 `action` 枚举
   （`tool-agent-team/src/index.ts:375-380`）：

   ```ts
   action: {
     type: 'string', required: true,
     enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
   }
   ```

   **传自定义 status 无处可传。**

2. **服务层状态由 action 单向映射**（`task-board.ts`）：

   | action | 目标 status | 前置条件 |
   |---|---|---|
   | `claim` | `in_progress` | 必须 `pending` 且依赖已满足 |
   | `release` | `pending` | 必须 `in_progress`，**清空 owner** |
   | `complete` | `completed` | 必须 `in_progress` |
   | `reopen` | `pending` | 必须 `completed`，**清空 owner** |
   | `reassign` | `in_progress` | 仅 Lead；`pending`/`in_progress` |
   | `delete` | `deleted` | 无下游依赖 |
   | `edit` / `set_dependencies` | **不改 status** | owner 或 Lead |

3. **UI 是封闭 switch**（`client-ui-agent-team/src/client/TeamAction.tsx:33-36`）：

   ```ts
   function statusKey(status: TeamTask['status']): TeamKey {
     switch (status) {
       case 'pending': return 'status.pending'
       case 'in_progress': return 'status.in_progress'
       ...
   ```

   locale 里也只有 3 条（`locales.ts:30-32`：待处理 / 进行中 / 已完成）。

### 3.2 三个候选方案与实测结论

#### 方案 A：subject 前缀（`[planning] ...`）

```
[implementing] 实现 bigram 倒排表
[testing] 验证误命中与精排
```

| 维度 | 结论 |
|---|---|
| 可行性 | ✅ 完全可行。`subject` 上限 200 字符（`task-board.ts:59`），前缀占 12 字符无压力 |
| UI 可见性 | ✅ **优秀**。UI 直接渲染 `task.subject`（`TeamAction.tsx:148`），前缀在卡片标题最显眼位置 |
| 机器可读 | ⚠️ 需要自己解析前缀；上游不理解它 |
| 阻止误改 | ❌ **完全不能**。前缀只是文本 |

#### 方案 B：description 里的 YAML front-matter

```yaml
---
phase: implementing
owner_role: dev
evidence: pending
---
正文：要做什么、验收标准...
```

| 维度 | 结论 |
|---|---|
| 可行性 | ✅ 可行。`description` 上限 **16384** 字符（`task-board.ts:60`），且 `requiredText()` 只 `trim()` 首尾空白、**保留内部换行**（`validation.ts`）——front-matter 不会被破坏 |
| UI 可见性 | ⚠️ **很差**。description 在卡片里被 `-webkit-line-clamp: 2` 截断成 **2 行**（`TeamAction.module.css:273-277`），front-matter 会**吃掉全部可见行**，正文完全看不见 |
| 机器可读 | ✅ 最佳。结构化、可解析、可放任意多字段 |
| 阻止误改 | ❌ **完全不能** |

> **B 有个容易忽略的副作用**：front-matter 占 3~5 行，而预览只有 2 行 → **teammate 在 UI 上看不到任务内容**，必须点"展开"。这在实践中很烦。若要采用 B，把 front-matter 压缩到 1 行（`phase: implementing | role: dev`）无 `---` 包裹。

#### 方案 C：组合（**推荐**）

```
subject:      [implementing] 实现 bigram 倒排表     ← 人眼在 UI 一眼看到
description:  phase=implementing role=dev
              （正文另起，空行分隔）
```

- subject 前缀给人看（UI 标题位，无截断）
- description 首行给机器读（单行 key=value，不占满 2 行预览）
- 两者都由**同一个常量映射**生成，避免不一致

### 3.3 能力边界：软状态做不到什么（**必读**）

不要对软状态有不切实际的期待。**它全部是约定，不是机制**：

| 期望 | 现实 |
|---|---|
| 强制 teammate 按流程流转 | ❌ **无法强制**。teammate 可以跳过 `[planning]` 直接 `complete` |
| 让 UI 显示"测试中"并配色 | ❌ **做不到**。UI 只认 3 态 + 固定 locale key |
| 状态变更可被审计/追溯 | ⚠️ 只能看 revision 数字变化，**看不到历史值**（改了就覆盖，journal 事件是整条快照） |
| 防止并发两个 agent 同时改 | ❌ 软状态与 CAS 无关；CAS 只保护 `expected_revision` |
| 按状态筛选任务 | ❌ `team_task_list` 只支持按 `status`（3 态）和 `owner` 过滤，**不支持按 subject 内容过滤** |

**另一个硬约束**：`team_task_update` 的 `edit` 要求 **owner 或 Lead** 权限
（`task-board.ts:124-126`）：

```ts
const authorizeOwner = (): void => {
  if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
}
```

所以 teammate 只能用 `[implementing]` 改**自己名下**的任务；跨任务统一改状态得 Lead 来。

### 3.4 落地建议

1. **状态词表固定 4 个**，写进角色文档：`planning` / `implementing` / `testing` / `completed`
2. **`completed` 用真实 status**，不要用前缀——因为 `completed` 有真实语义（依赖解锁、`taskReady` 判定基于它，`task-view.ts:24-26`）。其余 3 个前缀是**对 `in_progress` 的细分**
3. **Lead 负责守规矩**：既然机制不强制，就在 Lead 的 prompt 里写明"看到 `[planning]` 的任务不应被他人 claim"
4. **接受它只是"给人和模型看的标签"**，别在它上面建自动化

> 一句话：**软状态解决的是"人一眼看懂进度"，不解决"流程控制"。** 需要真控制就用 `blocked_by` 依赖图——那个是上游真实强制执行的（`taskReady()`，`task-board.ts:133`）。

---

## 4. 角色定义

角色契约见 [`docs/roles.md`](docs/roles.md)。它改编自 ITFS 项目的 `docs/agents/roles.md`，
保留 pm / arch / dev / sdet / qa 五角色的**输入、产物、红线、验收证据**结构。

核心思想：**角色不越界，越界的产物不予验收。** 每个角色必须产出可复现的验证证据，
"写完了"不算完成。

起步用四个角色足够：**pm（要做什么）→ arch（怎么做）→ dev（实现）→ sdet/qa（验证）**。
角色越多，名额越紧张（§2），协调成本越高。

---

## 5. 派活：fresh context 意味着什么

`spawn_teammate` 有 `context` 参数（`tool-agent-team/src/index.ts:199-203`）：

```ts
context: {
  type: 'string',
  enum: ['fresh', 'fork'],
  description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
}
```

### 5.1 fresh 的后果

**默认是 `fresh`——teammate 看不到你的任何历史。** 它不知道：
- 你为什么做这件事（背景）
- 你之前试过什么、什么失败了
- 文件在哪、命名规范是什么
- "写完了"在这个项目里意味着什么

> **所以：任务描述必须自带完整上下文，把 teammate 当成一个刚入职、能力很强、但对你项目一无所知的同事。**

### 5.2 可复制的任务模板

```markdown
## 背景
[为什么做这件事。2~4 句。包含：业务动机、当前现状、触发原因]

## 你的职责
[一句话定位这个角色要干什么]

## 具体任务
1. [可执行的步骤，越具体越好]
2. [写明产出文件路径]

## 约束
- 工作目录：/abs/path（不要碰其他目录）
- 不要修改：/abs/path/a、/abs/path/b
- 语言/风格：[如"中文回复，代码注释中文"]
- 禁止：[如"不要 git commit / 不要装新依赖"]

## 已有信息（省去你自己找）
- 关键文件：/abs/path/x.go:120-180 是主逻辑
- 已知结论：[别人已经验证过的事实，避免重复调研]
- 已知坑：[踩过的坑]

## 交付标准（验收证据）
- [ ] 产出文件写在哪
- [ ] 必须包含哪些内容
- [ ] 验证方式：[跑什么命令 / 看什么输出]
- [ ] 完成后用 send_message 汇报：[汇报要点]

## 边界
遇到以下情况停下来问我，不要自行决定：
- [列举需要 escalation 的情况]
```

### 5.3 fork 什么时候用

`fork` 继承 Lead 已完成的所有 turn。适合：
- 需要 Lead 全部上下文的**延续性工作**（比如"接着我上面的调研再挖一层"）
- 但注意：**fork 只继承"已完成"的 turn，看不到当前进行中的 turn**（这一点在工具描述里写明）

**默认用 fresh + 好模板**，比 fork 更可控——fork 出来的 agent 继承了你的全部历史，token 成本高，且容易"记得太多无关的东西"。

---

## 6. 写作用域（write_scopes）只是提示

`team_task_create` / `update` 支持 `write_scopes`，用于**提示**谁改哪些路径。

**它不是锁。** 三条证据：

1. **类型注释直接写明**（`types.ts`，`writeScope()` 的 docstring）：

   > `Normalize one workspace-relative path prefix **without treating it as a lock**.`

2. **重叠只产生 warning，不阻止**（`task-view.ts:43-47`）：

   ```ts
   for (const other of state.tasks) {
     if (other.id === task.id || other.status !== 'in_progress') continue
     if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
       warnings.add(`write scopes overlap with ${other.id}`)     // ← 只加一条 warning
     }
   }
   ```

3. **上游 README 明确承认**：

   > "**write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。"

### 实践做法

- **切分原则**：按**目录**切，不要按文件切（`tmp/research/` 比 `tmp/research/a.md` 更好，粒度合理）
- **每个并发任务给独立的文件/目录**，让 warning 天然为空
- **Lead 必须在最后跑一次 `git diff` / 全量验证**——这是唯一可靠的冲突兜底
- **格式化和代码生成也算写**：如果两个 member 都跑 `gofmt`/`prettier`，即使源码不重合也可能互相覆盖

---

## 7. 真实案例：并行调研 → 串行实现

### 场景

给一个 Go 后端项目（TDSQL 不支持全文索引）调研"中文任意位置子串搜索"的可行方案。
需要：现状审计 + 数据库实测 + 外部方案调研 + 前端影响分析，最后汇总成决策文档。

### 怎么拆

| 阶段 | 成员 | 任务 | 写作用域 |
|---|---|---|---|
| 并行调研 | `backend-auditor` | 审计现有搜索代码路径 | `tmp/research/backend-*.md` |
| | `db-prober` | 连库实测数据量/查询耗时 | `tmp/research/db-*.md` |
| | `web-researcher` | 调研外部方案 | `tmp/research/external-*.md` |
| | `infix-researcher` | 深挖 CJK bigram 索引实现 | `tmp/research/infix-*.md` |
| | `frontend-auditor` | 前端搜索交互影响 | `tmp/research/frontend-*.md` |
| 汇总 | Lead | 合并 5 份产出、做决策 | — |

**关键设计**：
- 5 个成员，1 lead + 5 = 6 个 agent，在 8 个名额内（§2），留了 2 个缓冲
- **写作用域按文件名前缀完全隔离**，互不重叠 → 并行零冲突
- 每人**只写自己那一个文件**，汇总由 Lead 做 → 避免了"多人改同一文档"
- 任务描述里给了**共同的背景段落**（fresh context 必须自带上下文，§5）

### 换到实现阶段

调研完成后转串行，用 `blocked_by` 表达阶段依赖：

```
task-1 [pm]      出需求规格与验收标准
task-2 [arch]    技术方案设计        blocked_by: task-1
task-3 [dev]     实现                blocked_by: task-2
task-4 [sdet]    补充/执行测试       blocked_by: task-3
task-5 [qa]      验收与报告          blocked_by: task-4
```

`blocked_by` 是**上游真实强制**的：`claim` 时 `taskReady()` 检查所有 blocker 是否 `completed`
（`task-board.ts:133`），不满足直接抛 `TEAM_TASK_BLOCKED`。这是唯一"硬"的流程控制机制——
**需要真控制时用它，不要指望 §3 的软状态。**

可从 `examples/task-templates.md` 复制这些任务的完整写法。

---

## 8. 协调机制的两个陷阱

这一节的结论直接来自上游内置的 Team policy prompt 与工具实现——**它们是运行时真正在执行的行为**，
不是建议。优先读原文，比读任何二手总结可靠。

### 8.1 `inactive` 不等于"做完了"

内置 policy prompt 原文（`tool-agent-team/src/index.ts:41`）：

> "**inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.**"

`list_agents` 里的 `inactive` 只表示"当前没有 turn 在执行"。一个 teammate 可能是：

- ✅ 真的做完了，在等你验收
- ⏳ 正在等你的消息（它上一轮问了你问题）
- ⚠️ 中途失败退出了，但 roster 里还挂着
- 💤 你派给它的任务它根本没读到

> **不要看到 inactive 就认为任务完成。** 判断完成看两处：共享任务板上 `status === 'completed'`，
> 或者它 `send_message` 给你的汇报内容。

其他状态词：「`provisioning` means member creation is in progress; `failed` means member creation failed」（同一行）。

### 8.2 `wait_agent` 会立刻返回，不是"等到有进展"

`wait_agent` 有个**硬短路**（`tool-agent-team/src/index.ts:266-282`）：

```ts
const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
  member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
if (!hasActivePeer) {
  return { timedOut: false, noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } }
}
```

`ACTIVE_WAIT_STATUSES` 只有 `running` 和 `provisioning`（`index.ts:44`）。

**所以：当你所有 teammate 都是 inactive 时，`wait_agent` 会立刻返回 `noProgress`，不会等满 timeout。**

上游提示的应对（`NO_ACTIVE_PEER_MESSAGE`，`index.ts:45`）：

> "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. **Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.**"

**正确姿势**：

```
list_agents  →  发现队友 inactive
  →  它手上还有没做完的活？
        ├─ 是 → send_message 叫醒它（会 resume 它的 turn）
        └─ 否 → 不要 wait，直接推进你自己的部分
  →  确认有 running/provisioning 的队友了，再 wait_agent
```

**其他 `wait_agent` 细节**（`index.ts:250-253`）：

- timeout 范围 **10000 ~ 3600000 ms**，默认 30000
- "never wakes inactive members"——**它不能唤醒人，只能观察**
- "Re-list after wakeup or timeout instead of polling"——超时后重新 list，不要盲目轮询

### 8.3 发出去 ≠ 对方处理了

> "**A successful send does not mean the recipient has processed it.**"（`index.ts:41`）

`send_message` 成功只代表**投递成功**。目标可能：

- 正在跑，要到下一个 step boundary 才看到
- 处于 inactive，需要被启动/恢复才会处理
- 处理了但没回复你

所以**发完不要假设对方已经知道**；需要确认就等它的回复，或查任务板状态。

---

## 9. 速查表

| 事项 | 事实 | 依据 |
|---|---|---|
| teammate 上限 | 默认 16，当前 profile 配 8 | `index.ts:42`, `cordis.patch.yml` |
| lead 是否占名额 | **不占**，8 = 8 teammate + 1 lead | `roster.ts:257`, `projection.ts:344` |
| 名额能否回收 | **不能**，名册只增不减 | journal 只有 `team/member`、`team/task` |
| interrupt 释放名额吗 | **不**，完全不碰 roster | `roster.ts:187-197` |
| spawn 失败占名额吗 | **占**，以 `phase:'failed'` 留下 | `roster.ts:283-295` |
| 名字能复用吗 | **不能**，全历史唯一 | `roster.ts:254` |
| 任务状态 | 4 值但只有 3 个流程态 | `types.ts:72` |
| 能自定义状态吗 | **不能**，工具层无 status 参数 | `tool-agent-team/index.ts:375` |
| 任务的创建者是谁 | Lead 创建，`owner` 可为空 | `task-board.ts:52` |
| 谁能改任务 | owner 或 Lead | `task-board.ts:124-126` |
| write_scopes 是锁吗 | **不是**，只产生 warning | `task-view.ts:43-47` |
| blocked_by 强制执行吗 | **是**，claim 时校验 | `task-board.ts:133` |
| teammate 默认看得到我的历史吗 | **看不到**，默认 fresh | `tool-agent-team/index.ts:199` |
| 默认最大任务数 | 256 | `index.ts:43` |
| 单条消息上限 | 65536 字节 | `index.ts:44` |
| subject / description 上限 | 200 / 16384 字符 | `task-board.ts:59-60` |

---

## 10. 获取源码与核验本文

本文所有结论都可用下面的方式自行核验（需要 `gh` / `git`）：

```bash
# 稀疏 clone 精确 tag（只拉这几个包，很快）
git clone --depth 1 --branch dsh-v0.2.1-rc.3 \
  --filter=blob:none --sparse \
  https://github.com/deepseek-ai/deepseek-harness.git dsh-src
cd dsh-src
git sparse-checkout set packages/experimental/agent-team \
  packages/experimental/tool-agent-team \
  packages/experimental/client-ui-agent-team \
  packages/experimental/agent-team-profile

# 核验本文的关键结论（括号内是应看到的行号）
grep -n "DEFAULT_MAX_MEMBERS\|DEFAULT_MAX_TASKS" \
  packages/experimental/agent-team/src/index.ts                    # 42, 43, 44
grep -n "members.length >= this.maxMembers" \
  packages/experimental/agent-team/src/roster.ts                   # 257
grep -n "member.name === name" \
  packages/experimental/agent-team/src/roster.ts                   # 254（名字永久占用）
grep -n "role: 'lead'" \
  packages/experimental/agent-team/src/projection.ts               # 344（lead 单独投影）
grep -n "TeamTaskStatus =" \
  packages/experimental/agent-team/src/types.ts                    # 72（只有 3 个流程态）
grep -n "function statusKey" \
  packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx  # 33（UI 封闭 switch）
grep -rn "appendAndFlush(root, '" packages/experimental/agent-team/src/ | \
  sed "s/.*'\([^']*\)'.*/\1/" | sort -u
  # 输出应恰好两行: team/member 与 team/task —— 证明名册无删除事件
cat packages/experimental/agent-team-profile/cordis.patch.yml
  # 看到 maxMembers: 8 覆盖了代码默认的 16
```

**本地安装产物（`node_modules`）与源码的关系**：npm 包只含 `lib/`（编译产物），
不含 `src/`。经比对，`dsh-v0.2.1-rc.3` tag 的 README/locale 与本地安装产物**逐字节一致**，
`package.json` 仅差 monorepo 的 `workspace:*` 协议。所以**要读源码必须去上游取，不要试图从
`node_modules` 里还原**（那里没有 sourcemap，也没有 `src/`）。

---

## 附：与官方文档的分工

| 文档 | 定位 | 读者 |
|---|---|---|
| 上游 `README.zh.md` | **规范说明**：包的能力、配置、持久化模型、设计理念 | 想了解"它是什么" |
| 本文 | **实战决策**：什么时候用、名额怎么规划、任务怎么写、坑在哪 | 想了解"怎么用不出事" |

两者互补。遇到冲突**以上游源码为准**，并欢迎提 issue 修正本文。

## License

本文档以 MIT 发布。上游 `deepseek-harness` 亦为 MIT；本文不包含上游源码拷贝。
