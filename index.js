/**
 * agent-desktop tools for DeepSeek Harness.
 *
 * Every tool shells out to the `agent-desktop` CLI and returns its JSON
 * envelope unchanged, so the model sees the same error codes, suggestions and
 * retry dispositions the CLI itself produces. The plugin holds no desktop
 * state: refs, snapshots and leases live in the CLI's state root.
 */

import { spawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'agent-desktop'

/** The tool registry is the only required service. */
export const inject = ['tools']

/** Deployment knobs: where the CLI lives and how long one call may take. */
export const Config = Schema.object({
  command: Schema.string()
    .default('agent-desktop')
    .description('Path or name of the agent-desktop executable.'),
  timeoutMs: Schema.number()
    .default(30000)
    .description('Upper bound for one CLI invocation, in milliseconds.'),
})

/** Envelope every command prints: `{ ok, data?, error? }` plus protocol fields. */
const ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    command: { type: 'string' },
    data: { type: 'json' },
    error: { type: 'json' },
  },
}

const SNAPSHOT_GUIDANCE = 'Refs are scoped to one snapshot: after the UI changes, an old ref answers STALE_REF or AMBIGUOUS_TARGET, so take a new snapshot. Several windows of one app are listed by desktop_list_windows; pass window_id to choose one.'

/**
 * Popup surfaces are not part of any window tree, so they need their own read.
 * The accepted names are platform-owned — Linux (AT-SPI) answers window, sheet,
 * alert, menu and system-tray, macOS adds popover and menubar, Windows adds
 * start-menu and action-center — so the parameter stays free-form and the CLI
 * names the values it accepts when it refuses one.
 */
const SURFACE_HINT = 'Supported values differ per platform; desktop_status lists them (Linux: window, sheet, alert, menu, system-tray).'

/**
 * Quote one argument for the Windows shell, which npm's .cmd shim needs.
 * @param value - one command or argument.
 * @returns the argument, quoted when it contains whitespace or quotes.
 */
function quoteWin(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * Run one CLI command and parse its single JSON envelope.
 * @param settings - resolved command and timeout.
 * @param args - CLI arguments, without the executable.
 * @param options - caller text for stdin and the operation's cancellation signal.
 * @returns the parsed envelope; a non-zero exit still resolves because the CLI reports failures in JSON.
 */
function runCli(settings, args, options = {}) {
  const { input, signal } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('agent-desktop call aborted before start'))
      return
    }
    // npm installs a .cmd shim on Windows, which CreateProcess cannot start directly.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(settings.command)
    const child = useShell
      ? spawn([quoteWin(settings.command), ...args.map(quoteWin)].join(' '), { stdio: ['pipe', 'pipe', 'pipe'], shell: true })
      : spawn(settings.command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(reject, new Error(`agent-desktop exceeded ${settings.timeoutMs} ms: ${args.join(' ')}`))
    }, settings.timeoutMs)
    const onAbort = () => {
      child.kill('SIGKILL')
      settle(reject, new Error('agent-desktop call aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', (error) => {
      settle(reject, new Error(`cannot run "${settings.command}": ${error.message}`))
    })
    child.on('close', (code) => {
      const text = stdout.trim()
      if (text === '') {
        settle(reject, new Error(`agent-desktop printed nothing (exit ${code}): ${stderr.trim().slice(0, 400)}`))
        return
      }
      try {
        settle(resolve, JSON.parse(text))
      } catch {
        settle(reject, new Error(`agent-desktop printed non-JSON output (exit ${code}): ${text.slice(0, 400)} ${stderr.trim().slice(0, 200)}`))
      }
    })

    child.stdin.end(input === undefined ? '' : input)
  })
}

/**
 * Render one envelope for the model: a failure states its code, suggestion and
 * retry safety; a success shows the command payload.
 * @param value - parsed envelope.
 * @returns one text block.
 */
function renderEnvelope(value) {
  if (value.ok === false) {
    const error = value.error ?? {}
    const lines = [`FAILED [${error.code ?? 'UNKNOWN'}] ${error.message ?? ''}`.trim()]
    if (error.suggestion !== undefined) lines.push(`suggestion: ${error.suggestion}`)
    const disposition = error.disposition
    if (disposition !== undefined) {
      lines.push(`delivery: ${disposition.delivery}, retry: ${disposition.retry}`)
    }
    // details carries the values that let the caller correct the request, such as
    // the surfaces this platform accepts.
    if (error.details !== undefined && error.details !== null && Object.keys(error.details).length > 0) {
      lines.push(`details: ${JSON.stringify(error.details).slice(0, 400)}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: JSON.stringify(value.data ?? value, null, 2) }]
}

/**
 * Render find results without the ancestor scaffolding: an unnamed group or
 * webarea that merely contains the match tells the model nothing.
 * @param value - parsed envelope from `find`.
 * @returns one text block.
 */
function renderMatches(value) {
  if (value.ok === false) return renderEnvelope(value)
  const matches = value.data?.matches ?? []
  const controls = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'textfield', 'treeitem'])
  const structural = new Set(['group', 'window'])
  const useful = matches.filter(match => {
    if (structural.has(match.role) && match.ref_id === null) return false
    return (match.name ?? '') !== '' || controls.has(match.role)
  })
  const actionable = useful.filter(match => match.ref_id !== null).length
  const lines = [`${matches.length} matches, ${useful.length} named (${actionable} with refs)`]
  for (const match of useful) {
    const ref = match.ref_id === null ? '-' : match.ref_id
    lines.push(`${match.role} | ${(match.name ?? '').slice(0, 80)} | ${ref}`)
  }
  if (value.data?.truncated === true) lines.push('(truncated: narrow with root or a stricter filter)')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Build one ref action tool.
 * @param ctx - context providing the tool registry.
 * @param settings - CLI command and timeout.
 * @param spec - tool identity, argument builder and description.
 * @returns nothing; registration is effect-based.
 */
function registerRefAction(ctx, settings, spec) {
  ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      return runCli(settings, spec.build(args), { signal: exec.signal, input: spec.input?.(args) })
    },
  }))
}

/**
 * Register the desktop_* tools.
 * @param ctx - context providing the tool registry.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const settings = {
    command: config.command ?? 'agent-desktop',
    timeoutMs: config.timeoutMs ?? 30000,
  }
  const call = (args, options) => runCli(settings, args, options)

  ctx.tools.register(defineTool({
    name: 'desktop_status',
    description: 'Report the platform, the accessibility permission state and the snapshot surfaces this build supports. Start here on an unfamiliar machine: a denied permission explains why every other tool fails, and an empty supported_surfaces list means the accessibility bus is not answering rather than an empty desktop.',
    parameters: {},
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(_args, exec) {
      return call(['status'], { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_list_windows',
    description: 'List visible desktop windows with their app name, title, window id and bounds. Start here when you do not know the app name, and use the id with desktop_snapshot when an app has several windows.',
    parameters: {
      app: { type: 'string', description: 'Exact application name to filter, as printed by this tool.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = ['list-windows']
      if (args.app !== undefined) argv.push('--app', args.app)
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_snapshot',
    description: `Read one application window's accessibility tree as JSON, with a @snapshot:eN ref for every actionable element. ${SNAPSHOT_GUIDANCE} Keep interactive_only for large apps; drop it when you need text that is not actionable. A dialog, menu or search popup is not inside the window tree: read it with surface instead.`,
    parameters: {
      app: { type: 'string', description: 'Application name from desktop_list_windows.' },
      window_id: { type: 'string', description: 'Window id when the app has several windows.' },
      surface: { type: 'string', description: `Read a popup surface instead of the window tree: sheet for a modal dialog, menu for an open menu, popover, alert. ${SURFACE_HINT}` },
      interactive_only: { type: 'boolean', default: true, description: 'Keep only elements the agent can act on. Defaults to true.' },
      compact: { type: 'boolean', default: true, description: 'Drop layout noise. Defaults to true.' },
      max_depth: { type: 'integer', description: 'Limit semantic depth for dense applications.' },
      skeleton: { type: 'boolean', description: 'Return a shallow map to drill into with root.' },
      timeout_ms: { type: 'integer', default: 10000, description: 'Observation deadline. A short deadline can leave refs that are not provably unique, which then answer AMBIGUOUS_TARGET; raise it for slow Chromium settles.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = ['snapshot']
      if (args.app !== undefined) argv.push('--app', args.app)
      if (args.window_id !== undefined) argv.push('--window-id', args.window_id)
      if (args.surface !== undefined) argv.push('--surface', args.surface)
      if (args.timeout_ms !== undefined) argv.push('--timeout-ms', String(args.timeout_ms))
      if (args.interactive_only !== false) argv.push('-i')
      if (args.compact !== false) argv.push('--compact')
      if (args.max_depth !== undefined) argv.push('--max-depth', String(args.max_depth))
      if (args.skeleton === true) argv.push('--skeleton')
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_find',
    description: 'Search the accessibility tree by role, name, text, value or description and return only the matching elements, instead of reading a whole window. Narrow with root to search one subtree. Large Electron applications need a higher timeout_ms: their traversal can exceed the 5 s default.',
    parameters: {
      app: { type: 'string', description: 'Application name to search.' },
      window_id: { type: 'string', description: 'Scope to a single window id.' },
      surface: { type: 'string', description: `Search a popup surface instead of the window tree. ${SURFACE_HINT}` },
      role: { type: 'string', description: 'Accessibility role such as button, textfield, checkbox, group.' },
      name: { type: 'string', description: 'Accessible name or label.' },
      text: { type: 'string', description: 'Text in name, value, title or description.' },
      value: { type: 'string', description: 'Current value.' },
      description: { type: 'string', description: 'Accessible description.' },
      exact: { type: 'boolean', description: 'Require exact (case-insensitive) name, description or value matches.' },
      root: { type: 'string', description: 'Search only inside this ref subtree. Cannot be combined with surface.' },
      timeout_ms: { type: 'integer', default: 15000, description: 'Traversal deadline. Raise it for large trees such as Electron applications.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderMatches(value) },
    async execute(args, exec) {
      if (args.root !== undefined && args.surface !== undefined) {
        throw new Error('desktop_find: root and surface cannot be combined — search either inside a ref subtree or inside a popup surface')
      }
      const argv = ['find']
      if (args.app !== undefined) argv.push('--app', args.app)
      if (args.window_id !== undefined) argv.push('--window-id', args.window_id)
      if (args.surface !== undefined) argv.push('--surface', args.surface)
      if (args.role !== undefined) argv.push('--role', args.role)
      if (args.name !== undefined) argv.push('--name', args.name)
      if (args.text !== undefined) argv.push('--text', args.text)
      if (args.value !== undefined) argv.push('--value', args.value)
      if (args.description !== undefined) argv.push('--description', args.description)
      if (args.exact === true) argv.push('--exact')
      if (args.root !== undefined) argv.push('--root', args.root)
      argv.push('--timeout-ms', String(args.timeout_ms ?? 15000))
      return call(argv, { signal: exec.signal })
    },
  }))

  registerRefAction(ctx, settings, {
    name: 'desktop_click',
    description: 'Click an element by ref from a fresh snapshot, using the accessibility action (no pointer move, no focus change). Read disposition.delivery: only delivered_verified confirms delivery; delivered_unverified needs a fresh observation, and retry unsafe means a repeat may submit twice.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Qualified ref such as @s8f3k2p9:e8.' },
      headed: { type: 'boolean', description: 'Allow physical input when the semantic action is unavailable.' },
    },
    build: args => (args.headed === true ? ['--headed', 'click', args.ref] : ['click', args.ref]),
  })

  registerRefAction(ctx, settings, {
    name: 'desktop_type',
    description: 'Insert text into an editable element by ref. Text travels over stdin, never through process arguments. The element must be a text field or editable text role; a terminal text node needs headed input.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Qualified ref of the editable element.' },
      text: { type: 'string', required: true, description: 'Text to insert.' },
    },
    build: args => ['type', args.ref, '--stdin'],
    input: args => args.text,
  })

  registerRefAction(ctx, settings, {
    name: 'desktop_get',
    description: 'Read one property of an element by ref, to verify the result of an action without a full snapshot.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Qualified ref from a fresh snapshot.' },
      property: {
        type: 'string',
        required: true,
        enum: ['text', 'value', 'title', 'bounds', 'role', 'states'],
        description: 'Property to read.',
      },
    },
    build: args => ['get', args.ref, '--property', args.property],
  })

  ctx.tools.register(defineTool({
    name: 'desktop_press',
    description: 'Send a key combination such as return, escape, ctrl+c or alt+tab. Key names follow macOS and Windows names plus X keysym names; cmd and meta are Super. Safety policy blocks some combinations and refuses them without an explicit override.',
    parameters: {
      keys: { type: 'string', required: true, description: 'Combination such as "ctrl+s" or a single key such as "escape".' },
      headed: { type: 'boolean', description: 'Allow physical key injection when the semantic route is unavailable.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = args.headed === true ? ['--headed', 'press', args.keys] : ['press', args.keys]
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_wait',
    description: 'Block until a window title or a piece of text appears, instead of polling with repeated snapshots. Use it after launching an application or after an action that opens a view.',
    parameters: {
      app: { type: 'string', description: 'Application name to scope the wait.' },
      window: { type: 'string', description: 'Window title or title substring to wait for.' },
      text: { type: 'string', description: 'Text that must appear in the accessibility tree.' },
      timeout_ms: { type: 'integer', default: 10000, description: 'Give up after this many milliseconds.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = ['wait']
      if (args.window !== undefined) argv.push('--window', args.window)
      if (args.text !== undefined) argv.push('--text', args.text)
      if (args.app !== undefined) argv.push('--app', args.app)
      argv.push('--timeout', String(args.timeout_ms ?? 10000))
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_launch',
    description: 'Launch an application and return once its process runs. Follow it with desktop_wait for the window title before taking a snapshot.',
    parameters: {
      app: { type: 'string', required: true, description: 'Application name or desktop entry id.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      return call(['launch', args.app], { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_focus',
    description: 'Bring a window to the front and confirm the OS granted it focus. Physical input — press, mouse and pointer actions — lands on the focused window, so focus the target before sending keys. Identify it by app, window id or title substring.',
    parameters: {
      app: { type: 'string', description: 'Application name.' },
      window_id: { type: 'string', description: 'Window id from desktop_list_windows.' },
      title: { type: 'string', description: 'Window title or title substring.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = ['focus-window']
      if (args.window_id !== undefined) argv.push('--window-id', args.window_id)
      if (args.app !== undefined) argv.push('--app', args.app)
      if (args.title !== undefined) argv.push('--title', args.title)
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_mouse',
    description: 'Click or move the pointer at absolute screen coordinates. This is the fallback for elements the accessibility tree does not expose — an application-drawn canvas, or a web view with no roles. Coordinates are screen pixels, not window-relative: derive them from element bounds, a screenshot, or the user. Prefer desktop_click on a ref whenever one exists.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Absolute screen x in pixels.' },
      y: { type: 'integer', required: true, description: 'Absolute screen y in pixels.' },
      action: { type: 'string', enum: ['click', 'move'], default: 'click', description: 'Click (default) or only move the pointer.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left', description: 'Mouse button for a click.' },
      count: { type: 'integer', default: 1, description: 'Number of clicks.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const xy = `${args.x},${args.y}`
      if (args.action === 'move') {
        return call(['mouse-move', '--xy', xy, '--headed'], { signal: exec.signal })
      }
      const argv = ['mouse-click', '--xy', xy, '--headed']
      if (args.button !== undefined) argv.push('--button', args.button)
      if (args.count !== undefined) argv.push('--count', String(args.count))
      return call(argv, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_clipboard_set',
    description: 'Write text to the clipboard. Text travels over stdin, never through process arguments. Use it together with desktop_press ctrl+v to insert text into a field that desktop_type cannot reach — a contenteditable editor exposes role group, not textfield, so semantic typing is refused there.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to write, up to 128 KiB of UTF-8.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      return call(['clipboard-set', '--stdin'], { signal: exec.signal, input: args.text })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_clipboard_get',
    description: 'Read the clipboard. Plain text is the default; auto lets the source pick the format, and image writes a PNG to a private temp file (pass out to choose the path) so it can be inspected afterwards.',
    parameters: {
      format: { type: 'string', enum: ['text', 'auto', 'image', 'file-urls'], default: 'text', description: 'Clipboard format to read.' },
      out: { type: 'string', description: 'Where to write image content; defaults to a private temp file under the session dir.' },
    },
    output: { schema: ENVELOPE_SCHEMA, render: (_args, value) => renderEnvelope(value) },
    async execute(args, exec) {
      const argv = ['clipboard-get', '--format', args.format ?? 'text']
      if (args.out !== undefined) argv.push('--out', args.out)
      return call(argv, { signal: exec.signal })
    },
  }))
}