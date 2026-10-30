# 可复制的任务模板

> `spawn_teammate` 默认 `context: 'fresh'`——**teammate 看不到 Lead 的任何历史**
> （`tool-agent-team/src/index.ts:199-203`）。
>
> 所以任务描述必须**自带完整上下文**。把它当成"刚入职、能力很强、但对项目一无所知的同事"。

---

## 模板一：并行调研（最常用）

适合：多个互不依赖的调研方向，各自产出一份文件。

```markdown
## 背景
<为什么做这件事，2~4 句。包含：业务动机、当前现状、触发原因>

例：线上 MySQL 不支持全文索引，需要对「中文任意位置子串搜索」做技术选型。
现状是依赖 FULLTEXT，新引擎建表直接报错。数据量：空间 1.1 万、用户 10 万级。

## 你的职责
<一句话定位>

例：你是调研员 infix-researcher，负责深挖 CJK bigram 索引的业界实现。

## 具体任务
1. <可执行步骤>
2. <可执行步骤>
3. <写明产出文件路径>

## 约束
- 工作目录：/abs/path/to/repo
- 只写：tmp/research/<你的文件名>.md
- 不要碰：其他任何文件、不要 git commit、不要装新依赖
- 语言：中文回复，代码注释中文

## 已有信息（省去你自己找）
- 关键文件：src/storage/repository.go:120 是现有的查询入口
- 已确认结论：<别人验证过的事实，避免重复调研>
- 已知坑：<踩过的坑>

## 交付标准（验收证据）
- [ ] 产出写到 tmp/research/<name>.md
- [ ] 必须包含：<列举必需章节>
- [ ] 每个结论要有可复现的证据（命令 / 源码行号 / 实测数据）
- [ ] 完成后 send_message 给 lead，汇报：<要点>

## 边界
遇到以下情况停下来问 lead，不要自行决定：
- 需要修改 tmp/research/ 以外的文件
- 发现前提假设是错的
- 需要联网/装包/连数据库但权限不足
```

---

## 模板二：串行实现链路（pm → arch → dev → sdet → qa）

用 `blocked_by` 表达阶段依赖，`claim` 时上游强制校验前置完成
（`task-board.ts:133`）。

```jsonc
// 1) pm 出需求
team_task_create({
  "subject": "[planning] 出需求规格与验收标准",
  "description": "phase=planning role=pm\n背景：...\n产物：requirement.md + 验收标准表(P0/P1/P2)",
  "write_scopes": ["docs/requirement.md"]
})

// 2) arch 做方案，必须等 pm 完成
team_task_create({
  "subject": "[planning] 技术方案设计",
  "description": "phase=planning role=arch\n产物：technical-design.md（含被否决方案及理由）+ 风险表",
  "write_scopes": ["docs/technical-design.md"],
  "blocked_by": ["task-1"]
})

// 3) dev 实现，等 arch
team_task_create({
  "subject": "[implementing] 实现",
  "description": "phase=implementing role=dev\n产物：代码 + 单测 + 单测执行证据",
  "write_scopes": ["src/search/"],
  "blocked_by": ["task-2"]
})

// 4) sdet 补测，等 dev
team_task_create({
  "subject": "[testing] E2E 测试与报告",
  "description": "phase=testing role=sdet\n产物：E2E 脚本 + 实际执行报告",
  "write_scopes": ["scripts/e2e/"],
  "blocked_by": ["task-3"]
})

// 5) qa 验收，等 sdet
team_task_create({
  "subject": "[testing] 独立验收",
  "description": "phase=testing role=qa\n产物：验收核对表 + 质量结论",
  "write_scopes": ["docs/qa-report.md"],
  "blocked_by": ["task-4"]
})
```

> 注意：任务 id 是 `task-N` 格式（`task-board.ts:52`：`TeamTaskId(\`task-${state.nextTaskNumber}\`)`），
> 创建时自动分配，所以你需要先创建再拿返回的 id 填 `blocked_by`。

---

## 模板三：多 agent 并行改造（按目录切分）

适合：几十个文件同一种改法。

```markdown
## 背景
把所有 `errors.New` 单例合并为 `var()` 块，共 42 个文件，分布在 6 个包。

## 你的职责
负责 `pkg/storage/` 下的全部文件（约 15 个）。

## 约束
- 工作目录：/abs/path
- 写作用域：pkg/storage/          ← 只改这个目录
- 不要动其他包
- 每个文件改完跑 `gofmt -l` 自查

## 交付标准
- [ ] pkg/storage/ 下 0 个分散 var 声明
- [ ] `go build ./pkg/storage/...` 通过
- [ ] 汇报：改了哪几个文件、有没有踩到"同名错误变量"冲突
```

**关键**：按**目录**切分写作用域，不要按文件切。同时给多个 agent 派同一目录必然冲突
（write_scopes 只是提示，见主 README §6）。

---

## 模板四：对抗式验证

适合：一个实现、另一个找问题。

```markdown
## 背景
dev 已经实现 bigram 倒排表，单测全绿。现在需要独立找问题。

## 你的职责
你是对抗性审查者。**目标是找出它的缺陷，不是确认它没问题。**

## 具体任务
1. 通读 docs/impl-plan.md 和 src/search/ 下全部代码
2. 重点攻击：
   - 中文叠词（`哈哈哈`、`看看`）
   - 中英文混排（`Product测试空间`）
   - 空格/标点边界（`测试 空间`）
   - 单字查询、超长名称
3. 每发现一个问题，**写一个能复现的最小用例**（不要只描述）

## 红线
- 不要修代码（那是 dev 的事）
- 不要只报告"看起来没问题"——没找到问题也要说明你试过哪些攻击面

## 交付标准
- [ ] tmp/research/adversarial-findings.md
- [ ] 每个问题是：输入 + 期望 + 实际 + 复现代码
```

---

## 模板五：给 Lead 的派活前自查清单

派活前逐条过一遍（能显著降低返工）：

- [ ] **背景**写了吗？teammate 不知道你为什么做这件事
- [ ] **产出路径**是绝对路径吗？
- [ ] **写作用域**和其他并发任务重叠吗？（重叠 → warning，但没人阻止）
- [ ] **禁止事项**列了吗？（不 git commit / 不装依赖 / 不碰某目录）
- [ ] **验收标准**可判定吗？"做得好"不可判定，"误命中率 <5%"可判定
- [ ] **已有结论**同步了吗？避免 teammate 重复调研
- [ ] **escalation 边界**写了吗？什么情况下应该回来问而不是自行决定
- [ ] 这个名字**之前用过吗**？用过会 `TEAM_MEMBER_NAME_TAKEN`（名字永久占用，见主 README §2.3）
- [ ] 名额**还够吗**？不够就复用闲置成员，不要硬 spawn

---

## 反面示例（别这么写）

```markdown
❌ 太短、无上下文
prompt: "帮我调研一下搜索方案"

问题：不知道什么项目、什么约束、产出到哪、什么算完成

---

❌ 只给目标不给边界
prompt: "优化一下这个模块的性能"

问题：可能重构整个模块、可能装新依赖、可能改测试

---

❌ 把关键约束藏在对话历史里
prompt: "按我们刚才讨论的做"

问题：fresh context 的 teammate 看不到"刚才"；fork 也看不到进行中的 turn
```
