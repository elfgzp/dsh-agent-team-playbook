# 任务状态机增强方案

> 目标：在上游只有 `pending / in_progress / completed` 三态的前提下，
> 表达更细的流程状态（规划中 / 实现中 / 测试中 / 已完成）。
>
> **前提**：不修改上游源码（它是编译产物装在 `node_modules`，改了会被覆盖）。
> 所有事实依据 tag `dsh-v0.2.1-rc.3` 源码，每条标注 `文件:行号`。

---

## 一、先明确上游有什么，以及为什么"加一个状态"加不进去

### 1.1 上游的状态枚举

`packages/experimental/agent-team/src/types.ts:72`：

```ts
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
```

四个值，但 `deleted` 是**删除墓碑**，不是流程状态。真正可流转的只有 3 个。

### 1.2 三层封锁：为什么不能自定义状态

这是本文最重要的部分——**很多人以为"状态只是个字符串，随便传就行"，实际上三层都封死了**。

#### 第一层：工具层根本没有 `status` 参数

`packages/experimental/tool-agent-team/src/index.ts:372-386`：

```ts
parameters: {
  task_id: { type: 'string', required: true },
  expected_revision: { type: 'integer', required: true },
  action: {
    type: 'string', required: true,
    enum: ['claim', 'release', 'edit', 'set_dependencies',
           'complete', 'reopen', 'reassign', 'delete'],   // ← 封闭枚举
  },
  subject: { type: 'string' },
  description: { type: 'string' },
  blocked_by: { type: 'array', items: { type: 'string' } },
  write_scopes: { type: 'array', items: { type: 'string' } },
  owner: { type: 'string' },
}
```

**没有任何 `status` 字段。** 想传 `status: 'testing'` 无处可传。

#### 第二层：服务层 status 由 action 单向映射

`packages/experimental/agent-team/src/task-board.ts`（`updateTask` 的 switch）：

| action | 目标 status | 前置条件 | 副作用 |
|---|---|---|---|
| `claim` | `in_progress` | 必须 `pending` 且依赖全完成 | 设 `ownerId = caller` |
| `release` | `pending` | 必须 `in_progress` | **清空 owner** |
| `complete` | `completed` | 必须 `in_progress` | — |
| `reopen` | `pending` | 必须 `completed` | **清空 owner** |
| `reassign` | `in_progress` | 仅 Lead；`pending`/`in_progress` | 设新 owner |
| `delete` | `deleted` | 无下游依赖 | — |
| `edit` | **不改** | owner 或 Lead | 改 subject/description/writeScopes |
| `set_dependencies` | **不改** | owner 或 Lead | 改 blockedBy |

关键点：**status 只能由 action 推导，不能显式指定。** 而且 `edit` 是唯一能改文本内容的动作，
它**完全不碰 status** —— 这恰好是软状态方案的立足点。

#### 第三层：UI 是封闭 switch

`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:33-38`：

```ts
function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    // deleted 不渲染
  }
}
```

locale 里也只有 3 条（`client/locales.ts:30-32`）：

```ts
'status.pending': '待处理',
'status.in_progress': '进行中',
'status.completed': '已完成',
```

**即使你能往数据库里塞一个 `testing`，UI 也会渲染成空白或崩掉。**

> **结论：状态值本身不可扩展。所有增强只能是"在 subject/description 这个自由文本里编码约定"。**

---

## 二、三个候选方案

### 方案 A：subject 前缀

```
[planning]     设计 bigram 倒排表结构
[implementing] 实现 token 切分与查询
[testing]      验证误命中与精排
[completed]    已完成（用真实 status，不用前缀）
```

**实现方式**（每次流转都要一次 `edit`）：

```jsonc
// team_task_update
{
  "task_id": "task-3",
  "expected_revision": 4,
  "action": "edit",
  "subject": "[testing] 验证误命中与精排"      // 改前缀即可
}
```

| 维度 | 评估 |
|---|---|
| 可行性 | ✅ 完全可行。`subject` 上限 **200** 字符（`task-board.ts:59`），前缀占 ~13 字符 |
| UI 可见性 | ✅ **最好**。UI 直接渲染 `task.subject` 作为卡片标题（`TeamAction.tsx:148`），无截断 |
| 机器可读 | ⚠️ 需自行解析前缀（正则 `^\[(\w+)\]`） |
| 能否阻止误改 | ❌ **完全不能** |
| 每次流转成本 | 1 次 `edit`（`expected_revision` 必须是最新值 → 有 CAS 失败重试成本） |

**优点**：最简单、UI 最直观、不需要额外字段。
**缺点**：subject 语义被污染（标题里混了状态）；前缀和标题可能不同步；解析脆弱（用户手改了标题前缀就没了）。

---

### 方案 B：description 里的 YAML front-matter

```markdown
---
phase: implementing
role: dev
evidence: pending
---

## 目标
实现 char-level bigram 切分与倒排表写入

## 验收
- [ ] 单测覆盖叠词边界（`哈哈哈`）
- [ ] 误命中样本全部被精排剔除
```

**实现方式**：每次流转重写整个 description。

| 维度 | 评估 |
|---|---|
| 可行性 | ✅ 可行。`description` 上限 **16384** 字符（`task-board.ts:60`）；`requiredText()` 只 `trim()` 首尾空白，**保留内部换行**（`validation.ts:12-19`），front-matter 不会被破坏 |
| UI 可见性 | ⚠️ **很差**（见下） |
| 机器可读 | ✅ **最好**。结构化，可放任意多字段（role、evidence、retry count…） |
| 能否阻止误改 | ❌ **完全不能** |
| 每次流转成本 | 1 次 `edit`，但**要重写整个 description**（易丢内容） |

#### ⚠️ B 有一个致命 UX 问题（实测）

UI 对 description 的预览是 **2 行截断**（`client/TeamAction.module.css:273-277`）：

```css
.clampedDescription {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
```

而 YAML front-matter 至少要 4 行（`---` / 3 个字段 / `---`）。**结果：teammate 在卡片上完全看不到任务正文，只看到 front-matter 的横杠和字段名**，必须手动点"展开"。

**这是个真实的可用性倒退**，不是理论问题。

**缓解**：把 front-matter 压成**单行 key=value**（不要 `---` 包裹）：

```
phase=implementing role=dev evidence=pending
## 目标
...
```

这样只占 1 行，还剩 1 行可见正文。

---

### 方案 C：组合（**推荐**）

```
subject:      [implementing] 实现 bigram 倒排表
description:  phase=implementing role=dev
              ## 目标
              实现 char-level bigram 切分与倒排表写入
```

**设计原则**：
- **subject 前缀给人看**——UI 标题位，无截断，一眼扫过整个任务板就能看出进度
- **description 首行给机器读**——单行 `key=value`，只占 1 行，留 1 行给正文
- **两者由同一常量映射生成**，避免不一致

**推荐的状态词表（固定 4 个）**：

| 软状态 | 映射到真实 status | 语义 |
|---|---|---|
| `planning` | `in_progress`（或 `pending` 不 claim） | 需求/方案设计中 |
| `implementing` | `in_progress` | 编码中 |
| `testing` | `in_progress` | 测试/验收中 |
| `completed` | **`completed`（真实 status）** | 完成 |

> **`completed` 必须用真实 status，不要用前缀。** 因为它是**上游唯一有真实语义保证**的状态：
> 依赖解锁（`taskReady()` 判断 blocker 是否 `completed`，`task-view.ts:24-26`）、
> UI 配色、`reopen` 的前置条件，都依赖它。
> 其余 3 个软状态只是**对 `in_progress` 的细分**。

---

## 三、能力边界：软状态做不到什么（**必读**）

这是本文最需要向使用者讲清楚的部分。**软状态全部是约定，不是机制。**

| 你可能期望 | 实际能力 | 说明 |
|---|---|---|
| 强制 teammate 按流程流转 | ❌ **无法强制** | teammate 可以跳过 `[planning]` 直接 `complete`；服务层不校验 |
| UI 显示"测试中"并配色 | ❌ **做不到** | UI 只认 3 态 + 固定 locale key（§1.2 第三层） |
| 按软状态筛选任务 | ❌ **做不到** | `team_task_list` 只支持按真实 `status` 和 `owner` 过滤，**不支持按 subject 内容过滤** |
| 状态变更可审计/追溯 | ⚠️ **部分** | 只能看到 `revision` 数字增长；**看不到历史值**（journal 事件存整条快照，改了就覆盖） |
| 防止两个 agent 同时改状态 | ❌ **不能** | 软状态与并发无关。CAS 只保护 `expected_revision`，先到者赢 |
| 跨任务统一改状态 | ⚠️ **受限** | `edit` 要求 **owner 或 Lead**（`task-board.ts:124-126`）；teammate 只能改自己名下 |
| 状态影响依赖解锁 | ❌ **不能** | 只有真实 `completed` 影响 `taskReady()`；软状态写 `[completed]` 不解除阻塞 |

### 另外两个硬约束

1. **每次流转 = 1 次 `edit` + 1 次 `expected_revision` CAS**。
   如果两个人同时想改，后到者会收到 revision 冲突，需要 `get` 后重试。
   **状态流转越频繁，CAS 冲突概率越高**——这是软状态的隐性成本。

2. **`edit` 会覆盖整个字段**，不是 patch。
   `subject` 只传前缀+标题没问题；但 `description` 的 front-matter 方案**每次都要重写整个 description**，
   一旦写漏，正文就丢了。

### 什么才是"真控制"

如果你要的是**流程强制**而不是**进度展示**，用 `blocked_by` 依赖图——那是上游真实执行的：

```ts
// task-board.ts:133 —— claim 时强制校验
if (current.status !== 'pending' || !taskReady(state, current)) {
  throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
}
```

```ts
// task-view.ts:24-26 —— 依赖判定的唯一依据
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every(id => state.tasks.find(c => c.id === id)?.status === 'completed')
}
```

**结论：`blocked_by` 做串行约束（硬），subject 前缀做进度可视（软）。两者配合，不要指望后者承担前者的职责。**

---

## 四、落地建议

### 4.1 最小可用约定

1. **状态词表固定 4 个**，写进项目角色文档：`planning` / `implementing` / `testing` / `completed`
2. **subject 用 `[软状态] 标题` 格式**，description 首行用 `phase=xxx role=yyy`
3. **`completed` 用真实 status**，不用前缀
4. **Lead 负责守规矩**：机制不强制，就在 Lead 的 prompt 里写明验收时检查状态流转是否符合预期
5. **接受它只是"给人和模型看的标签"**，不要在其上建自动化

### 4.2 一个可复制的流转脚本骨架

```bash
#!/usr/bin/env bash
# 用法: task-phase.sh <task_id> <soft-status> [新标题]
# 依赖 team_task_update 的 edit action
set -euo pipefail

TASK_ID="$1"; NEW_PHASE="$2"; shift 2
NEW_SUBJECT="${1:-}"

# 1. 读最新 revision（edit 必须带 CAS 期望值）
REV=$(team_task_get "$TASK_ID" | jq -r .revision)
SUBJ=$(team_task_get "$TASK_ID" | jq -r .subject)

# 2. 去掉旧前缀，拼新前缀
STRIPPED=$(echo "$SUBJ" | sed -E 's/^\[[a-z]+\] //')
[ -n "$NEW_SUBJECT" ] && STRIPPED="$NEW_SUBJECT"

# 3. 执行 edit（subject 前缀；description 首行由团队自行约定是否同步）
team_task_update "$TASK_ID" "$REV" edit --subject "[$NEW_PHASE] $STRIPPED"
```

> 注意 `expected_revision` 必须是**最新**值，并发时会失败——**失败就重读重试，不要盲目 +1**。

### 4.3 什么情况下不要用软状态

- **任务数少（<5）**：靠 `status` + `owner` + 直接沟通就够了，加软状态是纯负担
- **追求可审计**：软状态没有历史，需要审计就得自己维护一份变更日志（但那就超出 Task 板的能力了）
- **希望自动化驱动**：上游没有 API 读软状态，自动化只能靠正则解析，脆弱

---

## 五、一句话总结

> **软状态解决"人一眼看懂进度"，不解决"流程控制"。**
> 需要真控制 → 用 `blocked_by`（上游强制执行）。
> 需要真状态枚举 → 只能改上游源码并重新构建，不在本文范围内。
