/**
 * Agent Teams Playbook — inject operating conventions for Agent Teams sessions.
 *
 * What it does
 * ------------
 * Registers one ordered system-prompt section that teaches an agent the
 * non-obvious operating rules of Agent Teams: how to plan a roster before
 * spawning, that roster slots are never released, that write scopes are
 * advisory, and that `wait_agent` short-circuits when no peer is active.
 *
 * Why a prompt section and not a tool
 * -----------------------------------
 * The behaviours this plug-in fixes are decisions the model makes before it
 * acts, so they belong in the prompt, not behind another tool the model could
 * forget to call. It needs no tool registration and no client half.
 *
 * Scope
 * -----
 * The section is registered in the calling agent's scope, so it applies to the
 * Lead. Teammates are separate agents with their own prompt scope; they do not
 * inherit this section. That is deliberate: the rules are Lead-facing.
 *
 * @module dsh-agent-team-playbook
 */

import z from '@deepseek-ai/schemastery'

/** Order used for the playbook section: right after TEAM_POLICY (600). */
const PLAYBOOK_ORDER = 650

/** Stable section name; changing it would leave two sections registered. */
const PLAYBOOK_SECTION = 'team:playbook'

/**
 * The injected guidance. Kept as a single template string so that the whole
 * playbook is reviewable in one place and cheap to diff.
 */
const PLAYBOOK_TEXT = `## Agent Teams operating rules

These rules summarize hard constraints of the Agent Teams runtime. Each one is
verified against the runtime source; ignoring them causes silent, confusing
failures rather than errors.

### Plan the roster before spawning anyone

A teammate roster is append-only: the runtime records member creation but has no
member-removal event. Consequences:

- An inactive teammate still occupies its slot. There is no way to free a slot
  except ending the session.
- A failed spawn still occupies a slot.
- Teammate names are reserved for the whole session; re-spawning a failed name
  fails immediately.

Therefore decide the full roster first, then spawn. Keep one slot in reserve so
a single failed spawn cannot deadlock the plan. When the roster is full, reuse an
idle teammate for new work instead of spawning.

### Treat write scopes as advisory, not as locks

Overlapping write scopes produce a warning on the task; they never block a write.
Two teammates can edit the same file and silently overwrite each other. Split
concurrent work by directory, and review the final diff yourself before
reporting success. Formatting and code generation write too.

### Put complete context in every spawn prompt

Teammates default to a fresh context: they do not see the conversation that
preceded them. A spawn prompt must therefore carry the background, the target
paths, the constraints, the acceptance evidence required, and the escalation
boundary. Assume the teammate is capable but knows nothing about this session.

### Use task dependencies for ordering, not prose

\`blocked_by\` is enforced: claiming a blocked task fails. That is the only hard
flow control available. Descriptive status labels are conventions only — they
cannot be enforced, are invisible to the UI status column, and cannot be
filtered on. Express required ordering with \`blocked_by\`, and use text labels
purely for human readability.

### Interpret teammate state correctly

- \`inactive\` means only that no turn is executing. It does not mean the task is
  complete, failed, or waiting for you.
- \`provisioning\` means creation is still in progress.
- \`failed\` means creation failed; the slot stays occupied.
- A successful \`send_message\` means the message was queued, not that the
  recipient read or acted on it.

Before waiting, check that a peer is actually running or provisioning. Waiting
with no active peer returns immediately with a no-progress result instead of
blocking; wake the required teammate with a message first, then wait.

### Report only verified results

Do not claim a delegated step succeeded because the teammate said so. Confirm it
against the task board, the produced files, or a command you ran yourself.`


/**
 * Register the playbook section in one agent's prompt scope.
 *
 * @param agent - the agent whose scope receives the section.
 * @returns the disposer that removes the section.
 */
function install(agent) {
  const scoped = agent.ctx
  return scoped.systemPrompt.section({
    name: PLAYBOOK_SECTION,
    order: PLAYBOOK_ORDER,
    text: PLAYBOOK_TEXT,
  })
}

/**
 * Apply the plug-in: register the playbook for every current and future agent.
 *
 * @param config - resolved plug-in configuration.
 * @param ctx - the plug-in context; `systemPrompt` and `agents` are required.
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  /** Disposers keyed by agent identity. */
  const installed = new Map()

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    installed.set(agent, install(agent))
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)

  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'agent-team-playbook.sections()')
}

/** Services this plug-in requires before activation. */
export const inject = ['systemPrompt', 'agents']

/** Plug-in configuration schema, validated when the row activates. */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Inject the Agent Teams playbook section into every agent.'),
})
