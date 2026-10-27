/**
 * Skills and deferred tools (SPEC §6.8).
 *
 * The engine stays stateless: what is loaded is derived from the history on every run, from
 * the `tool` messages the engine marked `builtin: true`. Nothing new is stored by the harness
 * beyond those messages.
 */
import {
  BUILTIN_TOOLS,
  type RunRequest,
  type Skill,
  type StoredMessage,
  type ToolDef,
  type ToolMessage,
} from '../contracts.js'
import type { Texts } from '../i18n.js'

/** How activated tools reach the model (SPEC §6.8, activation mechanisms). */
export type ActivationMechanism = 'tool_reference' | 'tools_array'

/** A tool as the model sees it: an HTTP tool of the request or a built-in. */
export interface ModelTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  deferred: boolean
}

/** The request uses skills or deferred tools; without either the loop is exactly as before. */
export function usesSkills(request: Pick<RunRequest, 'skills' | 'tools'>): boolean {
  return request.skills.length > 0 || request.tools.some((t) => t.defer_loading)
}

export interface LoadSkillOutcome {
  ok: boolean
  /** The skill name as the model passed it. */
  name: string
  /** ok: the body, stored verbatim; error: the tool error for the model. */
  text: string
  /** ok: deferred tools that become visible from the next step. */
  tools: string[]
  /** ok: the skill was already loaded in an earlier run (restored from history). */
  reloaded: boolean
}

export interface Restored {
  skills: string[]
  tools: string[]
  /** Marked messages whose shape does not match: treated as ordinary history. */
  invalid: Array<{ call_id: string; tool: string }>
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export class SkillState {
  /** The request uses the feature (SPEC §6.8); false — the state is inert. */
  readonly enabled: boolean
  readonly mechanism: ActivationMechanism
  readonly builtins: ModelTool[]

  private readonly skills = new Map<string, Skill>()
  private readonly deferred = new Set<string>()
  /** Deferred tool → the first skill (by name) that lists it. */
  private readonly owner = new Map<string, string>()
  private readonly activated = new Set<string>()
  private readonly loaded = new Set<string>()
  /** Bumped on every activation: the runner rebuilds the tool set when it changes. */
  private revision = 0

  constructor(
    private readonly request: Pick<RunRequest, 'skills' | 'tools'>,
    toolReferences: boolean,
    private readonly texts: Texts,
  ) {
    this.enabled = usesSkills(request)
    this.mechanism = this.enabled && toolReferences ? 'tool_reference' : 'tools_array'
    for (const tool of request.tools) if (tool.defer_loading) this.deferred.add(tool.name)
    for (const skill of [...request.skills].sort((a, b) => byName(a.name, b.name))) {
      this.skills.set(skill.name, skill)
      for (const tool of skill.tools) {
        if (this.deferred.has(tool) && !this.owner.has(tool)) this.owner.set(tool, skill.name)
      }
    }
    this.builtins =
      request.skills.length > 0
        ? [
            {
              name: BUILTIN_TOOLS.loadSkill,
              description: texts.loadSkillDescription,
              input_schema: {
                type: 'object',
                properties: { name: { type: 'string', description: texts.loadSkillNameDescription } },
                required: ['name'],
                additionalProperties: false,
              },
              deferred: false,
            },
          ]
        : []
  }

  get version(): number {
    return this.revision
  }

  /** `[engine] Skills…` appended to `system`, sorted by name (SPEC §6.8); null without skills. */
  index(): string | null {
    if (this.skills.size === 0) return null
    const lines = [...this.skills.values()].map((s) => `- ${s.name}: ${s.description}`)
    return [this.texts.skillIndexHeader, ...lines].join('\n')
  }

  skillNames(): string[] {
    return [...this.skills.keys()]
  }

  builtin(name: string): ModelTool | undefined {
    return this.builtins.find((b) => b.name === name)
  }

  /** A deferred tool the model cannot call yet. */
  isHidden(name: string): boolean {
    return this.deferred.has(name) && !this.activated.has(name)
  }

  /** The tool error for a call to a hidden tool (SPEC §6.8, tool_not_loaded). */
  notLoadedError(tool: string): string {
    const skill = this.owner.get(tool)
    return skill ? this.texts.toolNotLoadedSkill(tool, skill) : this.texts.toolNotLoaded(tool)
  }

  /** Deferred tools of a skill that are in the current request, sorted. */
  skillTools(name: string): string[] {
    const skill = this.skills.get(name)
    if (!skill) return []
    return [...new Set(skill.tools.filter((t) => this.deferred.has(t)))].sort(byName)
  }

  /** Visible from the next step on. */
  activate(names: readonly string[]): void {
    let changed = false
    for (const name of names) {
      if (!this.deferred.has(name) || this.activated.has(name)) continue
      this.activated.add(name)
      changed = true
    }
    if (changed) this.revision++
  }

  /** Visible deferred tools, sorted (SPEC §6.8). */
  activatedTools(): string[] {
    return [...this.activated].sort(byName)
  }

  /**
   * Activation state from the history, before step 1 (SPEC §6.8, restoration). Only `tool`
   * messages with `builtin: true` count; a legacy HTTP tool of the same name stays ordinary
   * history.
   */
  restore(messages: readonly StoredMessage[]): Restored {
    const restored: Restored = { skills: [], tools: [], invalid: [] }
    if (!this.enabled) return restored
    const args = callArgs(messages)
    for (const message of messages) {
      if (message.role !== 'tool' || message.builtin !== true || message.is_error) continue
      if (message.tool !== BUILTIN_TOOLS.loadSkill) continue
      const name = loadedSkillName(message, args.get(message.call_id))
      if (name === null) {
        restored.invalid.push({ call_id: message.call_id, tool: message.tool })
        continue
      }
      if (!this.skills.has(name) || this.loaded.has(name)) continue
      this.loaded.add(name)
      restored.skills.push(name)
    }
    for (const name of restored.skills) this.activate(this.skillTools(name))
    restored.tools = this.activatedTools()
    return restored
  }

  /** Executes `load_skill`; activation is the caller's, after the batch (SPEC §6.8). */
  loadSkill(input: unknown): LoadSkillOutcome {
    const name = String((input as { name?: unknown } | null)?.name ?? '')
    const skill = this.skills.get(name)
    if (!skill) {
      return { ok: false, name, text: this.texts.unknownSkill(name, this.skillNames()), tools: [], reloaded: false }
    }
    const reloaded = this.loaded.has(name)
    this.loaded.add(name)
    return { ok: true, name, text: skill.body, tools: this.skillTools(name), reloaded }
  }

  /**
   * What the model sees for a built-in result: the header, a blank line and the body, plus
   * the deferred tools to reference on `tool_reference`. Deterministic from the stored
   * message and the current request, so a historical result renders byte for byte as in the
   * run that produced it. null — not a valid built-in result: render as ordinary history.
   */
  render(message: ToolMessage, input: unknown): { text: string; references: string[] } | null {
    if (!this.enabled || message.builtin !== true || message.is_error) return null
    if (message.tool !== BUILTIN_TOOLS.loadSkill) return null
    const name = loadedSkillName(message, input)
    if (name === null) return null
    const tools = this.skillTools(name)
    return {
      text: `${this.texts.skillLoaded(name, tools)}\n\n${message.result as string}`,
      references: this.mechanism === 'tool_reference' ? tools : [],
    }
  }

  /**
   * A trimming block that carries an activation in effect (SPEC §6.8): a marked, valid
   * `load_skill` result for a skill of the current request. Such blocks are never dropped,
   * so the visible set always matches what the model sees.
   */
  isPinned(block: readonly StoredMessage[]): boolean {
    if (!this.enabled) return false
    const args = callArgs(block)
    return block.some((message) => {
      if (message.role !== 'tool' || message.builtin !== true || message.is_error) return false
      if (message.tool !== BUILTIN_TOOLS.loadSkill) return false
      const name = loadedSkillName(message, args.get(message.call_id))
      return name !== null && this.skills.has(name)
    })
  }

  /** Tools the model can call now: non-deferred, built-ins and activated deferred tools. */
  visibleTools(tools: readonly ToolDef[]): ModelTool[] {
    const out: ModelTool[] = tools
      .filter((t) => !this.isHidden(t.name))
      .map((t) => toModelTool(t))
    return [...out, ...this.builtins]
  }

  /**
   * The tools array of a step (SPEC §6.8). `tool_reference`: every tool on every step,
   * non-deferred by name then deferred by name. `tools_array`: the visible tools by name.
   */
  providerTools(tools: readonly ToolDef[]): ModelTool[] {
    if (this.mechanism === 'tool_reference') {
      const all = [...tools.map((t) => toModelTool(t)), ...this.builtins]
      const eager = all.filter((t) => !t.deferred).sort((a, b) => byName(a.name, b.name))
      const lazy = all.filter((t) => t.deferred).sort((a, b) => byName(a.name, b.name))
      return [...eager, ...lazy]
    }
    return this.visibleTools(tools)
      .map((t) => ({ ...t, deferred: false }))
      .sort((a, b) => byName(a.name, b.name))
  }
}

function toModelTool(def: ToolDef): ModelTool {
  return {
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    input_schema: def.input_schema,
    deferred: def.defer_loading,
  }
}

/** call_id → args of the assistant tool calls. */
export function callArgs(messages: readonly StoredMessage[]): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) if (part.type === 'tool_call') out.set(part.call_id, part.args)
  }
  return out
}

/** The skill name of a well-formed `load_skill` result, else null (SPEC §6.8 shape check). */
function loadedSkillName(message: ToolMessage, input: unknown): string | null {
  if (typeof message.result !== 'string') return null
  const name = (input as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? name : null
}
