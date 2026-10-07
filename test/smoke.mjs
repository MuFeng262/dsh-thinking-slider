// Headless behavioural test for dsh-thinking-slider's client half.
//
// The real web bundle is not on disk, so this harness supplies a miniature
// React runtime (hooks with stable per-render slots, class components, refs,
// portals) and drives the seat the way a user does: click the trigger, drag the
// track, press arrow keys, open the model pane.
//
// It also proves the stability contract: a throwing directory must degrade to
// the boundary fallback instead of throwing out of the component, because the
// slot renderer retires an entry whose render throws.
//
// Run: node test/smoke.mjs   (from the package root)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Walk up from this file until the package's client bundle is found. */
const pluginDir = (() => {
  let dir = here
  for (let step = 0; step < 4; step += 1) {
    if (fs.existsSync(path.join(dir, 'lib', 'client.js'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
})()

const checks = []
const check = (name, ok, extra = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? `  (${extra})` : ''}`)
}

// ---------------------------------------------------------------------------
// Miniature React
// ---------------------------------------------------------------------------
let hookSlots = []
let hookCursor = 0

/** React compares a dependency array with Object.is; absent deps always recompute. */
const sameDeps = (previous, next) => {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

const React = {
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  },
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length > 1 ? children : children[0] } }),
  useState(initial) {
    const at = hookCursor++
    if (!(at in hookSlots)) hookSlots[at] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      const next = typeof value === 'function' ? value(hookSlots[at]) : value
      // React bails out of an identical state write; without that, a callback
      // ref that re-runs on every pass would spin the harness forever.
      if (Object.is(hookSlots[at], next)) return
      hookSlots[at] = next
      stateDirty = true
    }
    return [hookSlots[at], set]
  },
  useRef(initial) {
    const at = hookCursor++
    if (!(at in hookSlots)) hookSlots[at] = { current: initial }
    return hookSlots[at]
  },
  useMemo(factory, deps) {
    const at = hookCursor++
    const slot = hookSlots[at]
    if (slot === undefined || !sameDeps(slot.deps, deps)) hookSlots[at] = { value: factory(), deps }
    return hookSlots[at].value
  },
  useCallback(fn, deps) {
    const at = hookCursor++
    const slot = hookSlots[at]
    if (slot === undefined || !sameDeps(slot.deps, deps)) hookSlots[at] = { value: fn, deps }
    return hookSlots[at].value
  },
  // Effects really run, keyed on their dependency array, with cleanup —the
  // only way to observe "did the animation loop re-bind to the new canvas".
  useEffect(effect, deps) {
    const at = hookCursor++
    const slot = effectSlots[at]
    if (slot !== undefined && sameDeps(slot.deps, deps)) return
    pendingEffects.push({ at, effect, deps, previous: slot })
  },
  useLayoutEffect() { hookCursor++ },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  memo: (component) => component,
}

const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const jsxs = jsx

/** Effect bookkeeping: React compares deps against the previous render. */
let effectSlots = []
let pendingEffects = []
/** Set when a state write must trigger another render pass. */
let stateDirty = false
/** Host-element identity across renders, emulating reconciliation. */
const nodeCache = new Map()
let liveNodes = new Set()
/** The canvas node the particle loop most recently bound to. */
let lastBoundCanvas = null

const flushEffects = () => {
  const queue = pendingEffects
  pendingEffects = []
  for (const entry of queue) {
    entry.previous?.cleanup?.()
    const cleanup = entry.effect()
    effectSlots[entry.at] = { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }
}

/** Unmount everything the last pass did not represent, as React would. */
const pruneUnmounted = () => {
  for (const [path, element] of [...nodeCache]) {
    if (liveNodes.has(path)) continue
    if (typeof element.ref === 'function') element.ref(null)
    nodeCache.delete(path)
  }
  liveNodes = new Set()
}

/**
 * Drop the current mount and everything it left running.
 *
 * Clearing instances alone orphans their animation frames, because their effect
 * cleanups never run; those loops would then be counted against later
 * assertions. Use this instead of clearing the caches by hand.
 */
const resetRender = () => {
  classInstances.clear()
  nodeCache.clear()
  liveNodes = new Set()
  hookSlots = []
  effectSlots = []
  pendingEffects = []
  rafQueue.length = 0
  rafLive.clear()
}

// ---------------------------------------------------------------------------
// Host globals
// ---------------------------------------------------------------------------
const listeners = { window: {}, document: {} }
const addListener = (bag) => (name, fn) => { (bag[name] ??= new Set()).add(fn) }
const removeListener = (bag) => (name, fn) => { bag[name]?.delete(fn) }

/** Attributes on the harness <body>, which carries the colour-scheme flag. */
const bodyAttributes = new Set()
/** Attribute watchers, so a theme flip reaches the plugin as it would live. */
const bodyWatchers = new Set()

globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback }
  observe() { bodyWatchers.add(this.callback) }
  disconnect() { bodyWatchers.delete(this.callback) }
}

/** Flip the harness colour scheme and notify watchers, as the theme does. */
const setDarkTheme = (dark) => {
  if (dark) bodyAttributes.add('data-ds-dark-theme')
  else bodyAttributes.delete('data-ds-dark-theme')
  for (const callback of [...bodyWatchers]) callback()
}

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', style: {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { hasAttribute: (name) => bodyAttributes.has(name) },
  addEventListener: addListener(listeners.document),
  removeEventListener: removeListener(listeners.document),
}
globalThis.window = {
  __ModuleLoader__: { load: (registration) => { loadedId = registration.id; factoryRef = registration.factory } },
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  addEventListener: addListener(listeners.window),
  removeEventListener: removeListener(listeners.window),
}
globalThis.matchMedia = globalThis.window.matchMedia
globalThis.ResizeObserver = undefined
/**
 * Count live animation loops: a loop holds exactly one outstanding frame, so a
 * mode switch that failed to tear the previous renderer down would leave two.
 */
let rafSeq = 0
const rafLive = new Set()
/** Frames waiting to run; `pumpFrames` executes them so `draw` really runs. */
const rafQueue = []
const rafStub = (fn) => {
  const id = ++rafSeq
  rafLive.add(id)
  rafQueue.push({ id, fn })
  return id
}
const cafStub = (id) => {
  rafLive.delete(id)
  const at = rafQueue.findIndex((entry) => entry.id === id)
  if (at >= 0) rafQueue.splice(at, 1)
}
/** Run pending animation frames, as the browser eventually would. */
const pumpFrames = (count = 2) => {
  for (let n = 0; n < count; n += 1) {
    for (const { id, fn } of rafQueue.splice(0)) {
      rafLive.delete(id)
      fn(1000 + n * 16.7)
    }
  }
}
globalThis.requestAnimationFrame = rafStub
globalThis.cancelAnimationFrame = cafStub
globalThis.window.requestAnimationFrame = rafStub
globalThis.window.cancelAnimationFrame = cafStub
/** The plugin persists its mode client-locally; give it a real store to hit. */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
  clear: () => { storage.clear() },
}

let loadedId
let factoryRef

const require_ = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return { jsx, jsxs }
  if (id === 'react-dom') return { createPortal: (children) => children }
  throw new Error(`unexpected require(${id})`)
}

new Function('window', 'document', fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8'))(globalThis.window, globalThis.document)
const mod = factoryRef(require_)

check('loader id', loadedId === 'dsh-thinking-slider', String(loadedId))
check('exports apply + inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), (mod.inject ?? []).join(','))
// Proven against real cordis by _tools/cordis-inject-proof.mjs: ctx.modelDirectories
// is a traceable proxy whose `.ctx` is rebound to THIS plugin, and directoryFor()
// reads `this.ctx.remote.session` through it.
check('declares the remote.session service the model directory reaches through us',
  mod.inject.includes('remote') && mod.inject.includes('remote.session'),
  mod.inject.join(', '))

// ---------------------------------------------------------------------------
// Fake composition
// ---------------------------------------------------------------------------
const registrations = []
const entryErrorListeners = new Set()
/** Priorities already claimed by earlier generations (a leaked registration). */
const claimed = new Set()
let duplicateStrikes = 0
/** Keys the plugin asked the slot registry to wait for. */
const injectedKeys = []

/** Cell key per SlotCore: single cells by priority, list cells by id. */
const cellOf = (options) =>
  options.name === 'conversation.input.model' ? `p:${String(options.priority)}` : `id:${String(options.id)}`

/** Slot declarations the harness serves, mirroring declaration lifecycles. */
const declaredSlots = new Set(['conversation.input.model', 'settings.general.item'])
/** Pending `slots.inject` waits, by slot key. */
const injectWaits = new Map()

/** Declare a slot and notify waiters, as a parent entry's children table does. */
const declareSlot = (key) => {
  declaredSlots.add(key)
  for (const wait of [...(injectWaits.get(key) ?? [])]) wait.run()
}

/** Collapse a slot's declaration: the inject effects it installed are disposed. */
const collapseSlot = (key) => {
  declaredSlots.delete(key)
  for (const wait of [...(injectWaits.get(key) ?? [])]) wait.dispose()
}

const slots = {
  /**
   * Faithful SlotService.inject: runs synchronously when the declaration already
   * exists, otherwise waits for it, and runs again for every later declaration
   * lifetime (the previous one having been disposed first).
   */
  inject(key, callback) {
    injectedKeys.push(key)
    const wait = { active: null, stopped: false }
    wait.dispose = () => {
      if (wait.stopped) return
      wait.stopped = true
      wait.active?.()
      wait.active = null
    }
    wait.run = () => {
      if (wait.stopped) return
      wait.active?.()
      wait.active = null
      if (!declaredSlots.has(key)) return
      const dispose = callback()
      wait.active = typeof dispose === 'function' ? dispose : null
    }
    if (!injectWaits.has(key)) injectWaits.set(key, new Set())
    injectWaits.get(key).add(wait)
    wait.run()
    return () => {
      injectWaits.get(key)?.delete(wait)
      wait.dispose()
    }
  },
  register(options, component) {
    // SlotCore throws this when a parent entry's children table has not declared
    // the slot yet — the load-order race this plugin must never walk into.
    if (!declaredSlots.has(options.name)) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    // Mirror SlotCore: `single` refuses a taken priority, `list` a taken id.
    const cell = cellOf(options)
    if (claimed.has(cell)) {
      duplicateStrikes += 1
      throw new Error(`single slot "${options.name}" already has a registration at priority ${String(options.priority)} —register at a different priority to shadow it (lowest renders)`)
    }
    claimed.add(cell)
    const registration = { options, component }
    registrations.push(registration)
    return () => { claimed.delete(cell) }
  },
  onEntryError(fn) {
    entryErrorListeners.add(fn)
    return () => entryErrorListeners.delete(fn)
  },
}

/** Registrations of one slot name, in registration order. */
const regsOf = (name) => registrations.filter((entry) => entry.options.name === name)
const seatRegs = () => regsOf('conversation.input.model')
const rowRegs = () => regsOf('settings.general.item')

const catalogue = [
  {
    id: 'tokenrhythm',
    name: 'tokenrhythm',
    models: [
      {
        id: 'glm-5.3',
        name: 'glm-5.3',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
        },
      },
      { id: 'plain-model', name: 'plain-model' },
    ],
  },
  { id: 'teds', name: 'teds', models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }] },
]

const snapshot = {
  status: 'ready',
  error: null,
  groups: catalogue,
  failures: [],
  current: { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' },
  pending: null,
  retainedEffort: undefined,
}

const calls = []
/** Every selection ever made — tests reset `calls`, the invariant must not. */
const allCalls = []
const directory = {
  store: { subscribe: () => () => {}, getSnapshot: () => snapshot },
  load: async () => ({ groups: catalogue }),
  select: async (selection) => {
    calls.push(selection)
    allCalls.push(selection)
    // The host echoes an accepted selection back through the store; that echo is
    // what reconciles the seat's optimistic level.
    snapshot.current = { ...snapshot.current, ...selection }
    return { ok: true }
  },
}

/** Writes the levels row performed through the settings transport. */
const formWrites = []
/** A stand-in for `llm-pi-ai`'s config, shaped like the real profile's. */
const llmConfig = {
  providers: {
    tokenrhythm: {
      apiKeyEnv: 'TOKENRHYTHM_API_KEY',
      models: [
        { id: 'glm-5.3', reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } },
        { id: 'kimi-k3', reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } },
        // In the model catalogue too, so the card's empty state and its fill
        // button can be driven through the plugin's real face.
        { id: 'plain-model', name: 'plain-model' },
      ],
    },
    nvidia: {
      apiKeyEnv: 'NVIDIA_API_KEY',
      models: [
        { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
        { id: 'z-ai/glm-5.3', name: 'GLM-5.3', reasoningEfforts: { off: 'none', low: 'low' } },
      ],
    },
    // Fully declared: must never be offered for filling.
    teds: {
      apiKeyEnv: 'TEDS_API_KEY',
      models: [
        { id: 'deepseek-v4-pro', reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } },
      ],
    },
  },
}
const llmListeners = new Set()
/** The settings transport's config form for a namespace. */
const llmForm = {
  getSnapshot: () => ({ value: llmConfig }),
  subscribe: (listener) => {
    llmListeners.add(listener)
    return () => llmListeners.delete(listener)
  },
  set: (field, next) => {
    formWrites.push({ field, next })
    llmConfig[field] = next
    for (const listener of [...llmListeners]) listener()
    return Promise.resolve()
  },
}
/** Namespaces the levels row asked the transport for. */
const formNamespaces = []
/** A namespace the transport serves but which carries no `providers` value. */
const emptyForm = {
  getSnapshot: () => ({ value: undefined }),
  subscribe: () => () => {},
  set: () => {},
}
/**
 * The transport, shaped like the failing live case: the patch id `llm-pi-ai` is
 * NOT the namespace that carries the config, the mirror reports no served
 * namespaces at all, and only `include:llm-pi-ai` actually holds `providers`.
 */
const configForms = {
  get: (namespace) => {
    formNamespaces.push(namespace)
    return namespace === 'include:llm-pi-ai' ? llmForm : emptyForm
  },
  describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }),
}
/** The config-form target the plugin hands to its row and its card. */
const llmTarget = {
  tried: () => ['llm-pi-ai', 'include:llm-pi-ai'],
  resolve: () => ({ namespace: 'include:llm-pi-ai', form: llmForm }),
  form: () => llmForm,
}

/** The plugin's own derived scope, so a hot reload can be replayed. */
const makeScope = () => ({
  slots,
  sessions: { subagentAddress: () => undefined },
  modelDirectories: { directoryFor: () => directory },
  configForms,
  effect(fn) {
    return fn()
  },
})

let teardown = null
const loadPlugin = () => {
  teardown = null
  mod.apply({
    // `slots` sits on the plugin context; `inject` hands back the derived scope.
    slots,
    inject: (_deps, callback) => { teardown = callback(makeScope()) },
  })
}

loadPlugin()

check('waits for the composer seat and the General settings row',
  injectedKeys.includes('conversation.input.model') && injectedKeys.includes('settings.general.item'),
  injectedKeys.join(', '))
check('registers exactly one seat', seatRegs().length === 1, String(seatRegs().length))
check('registers both settings rows', rowRegs().length === 2, String(rowRegs().length))

/** The settings row with this registration id. */
const rowById = (id) => rowRegs().find((entry) => entry.options.id === id)
const modeRowReg = () => rowById('thinking-slider-mode')
const levelsRowReg = () => rowById('thinking-slider-levels')
const reg = seatRegs()[0]
check('shadows at priority -1', reg.options.priority === -1, String(reg.options.priority))

const face = reg.options.inject('session-1')
check('inject face shape', ['available', 'directory', 'load', 'select'].every((k) => k in face), Object.keys(face).join(','))

// ---------------------------------------------------------------------------
// Registration timing.
//
// `conversation.input.model` is declared by ui-conversation's composer bar, not
// by this plugin, so BOTH apply() orders are legal. A profile that applies this
// plugin first used to hit an eager register() and die with
// `slot "conversation.input.model" is not declared`, losing the seat entirely.
// ---------------------------------------------------------------------------
{
  // Drop earlier generations' waits so these counts are exact.
  injectWaits.clear()
  collapseSlot('conversation.input.model')
  const before = seatRegs().length
  const diagnosticsBefore = (globalThis.__dshThinkingSlider?.diagnostics ?? []).length
  loadPlugin()
  const raised = (globalThis.__dshThinkingSlider?.diagnostics ?? []).slice(diagnosticsBefore)
  check('apply registers nothing while the seat slot is undeclared',
    seatRegs().length === before, `registration attempts added=${seatRegs().length - before}`)
  check('apply raises no "not declared" error',
    !raised.some((entry) => /not declared/i.test(JSON.stringify(entry))),
    JSON.stringify(raised).slice(0, 160))

  declareSlot('conversation.input.model')
  check('the seat mounts once the declaration arrives',
    seatRegs().length === before + 1, `added=${seatRegs().length - before}`)
}

// ---------------------------------------------------------------------------
// Render harness
// ---------------------------------------------------------------------------
const TRACK_RECT = { left: 100, top: 400, right: 420, bottom: 430, width: 320, height: 30 }
/** Errors a class boundary absorbed during the current render pass. */
const boundaryCatches = []
/** Class instances survive across renders, as React's do. */
const classInstances = new Map()
const elementOf = (type, props, path) => {
  let element = nodeCache.get(path)
  if (element === undefined || element.type !== type) {
    element = { type, path, bound: 0, clears: 0 }
    element.getBoundingClientRect = () => {
      const className = String(element.props?.className ?? '')
      if (className.includes('tsl-trackWrap')) return TRACK_RECT
      // A canvas is inset:0 of the 26px rail, so its own box is rail-sized.
      if (type === 'canvas') return { left: 100, top: 400, right: 384, bottom: 426, width: 284, height: 26 }
      return { left: 0, top: 0, right: 320, bottom: 600, width: 320, height: 600 }
    }
    if (type === 'canvas') {
      /** Every colour the renderer painted or put into a gradient. */
      element.colours = []
      element.paints = 0
      // Observable proof that the animation loop bound to THIS node.
      element.getContext = () => {
        if (element.context === undefined) {
          const gradient = () => ({ addColorStop: (_offset, colour) => element.colours.push(String(colour)) })
          element.context = {
            setTransform() {},
            // Each frame starts by clearing, so resetting here keeps `rects`
            // holding exactly the most recently drawn frame.
            clearRect() { element.clears += 1; element.rects = [] },
            beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
            fill() { element.paints += 1; element.colours.push(String(this.fillStyle)) },
            stroke() { element.paints += 1; element.colours.push(String(this.strokeStyle)) },
            fillRect(x, y, w, h) {
              element.paints += 1
              element.colours.push(String(this.fillStyle))
              element.rects.push({ x, y, w, h, colour: String(this.fillStyle) })
            },
            createLinearGradient: gradient,
            createRadialGradient: gradient,
          }
        }
        element.bound += 1
        lastBoundCanvas = element
        return element.context
      }
      element.width = 0
      element.height = 0
    }
    nodeCache.set(path, element)
  }
  element.props = props
  element.ref = props.ref
  liveNodes.add(path)
  if (props.ref !== null && typeof props.ref === 'object') props.ref.current = element
  else if (typeof props.ref === 'function') props.ref(element)
  return element
}

const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}.${index}`))
  const { type, props = {} } = node
  if (type === undefined) return node
  if (typeof type === 'function') {
    if (typeof type.prototype?.render === 'function') {
      // React keeps a class instance alive across renders at the same position;
      // state (crucially an error boundary's) must survive, or a retry cannot be
      // distinguished from a fresh mount.
      let instance = classInstances.get(type)
      if (instance === undefined) {
        instance = new type(props)
        classInstances.set(type, instance)
      }
      instance.props = props
      if (instance.state === undefined) instance.state = {}
      try {
        const rendered = expand(instance.render(), `${path}:${type.name}`)
        instance.componentDidUpdate?.()
        return rendered
      } catch (error) {
        if (typeof type.getDerivedStateFromError !== 'function') throw error
        boundaryCatches.push(error)
        instance.state = { ...instance.state, ...type.getDerivedStateFromError(error) }
        const fallback = expand(instance.render(), `${path}:${type.name}`)
        instance.componentDidCatch?.(error, { componentStack: '' })
        return fallback
      }
    }
    return expand(type(props), path)
  }
  if (type === React.Fragment) return expand(props.children, path)
  return elementOf(type, { ...props, children: expand(props.children, `${path}/${String(type)}`) }, path)
}

/**
 * One render pass, repeated while a commit-phase state write (a callback ref)
 * asks for another —that is how React reacts to `ref={setNode}`.
 */
const renderSeat = (props = {}) => {
  let tree = null
  for (let pass = 0; pass < 8; pass += 1) {
    hookCursor = 0
    stateDirty = false
    tree = expand(reg.component({ ...face, locked: false, ...props }))
    flushEffects()
    pumpFrames(2)
    pruneUnmounted()
    if (!stateDirty) break
  }
  return tree
}

const collect = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (typeof node === 'object' && node.props !== undefined) {
    out.push(node)
    collect(node.props.children, out)
  }
  return out
}

const byClass = (nodes, className) =>
  nodes.filter((n) => String(n.props?.className ?? '').split(' ').includes(className))

/**
 * Guard the jsx(el, props, key) call shape: passing a children array as the
 * third argument silently renders nothing in React (it lands in `key`).
 */
const misArityLeaf = (nodes) => nodes.filter((n) => n.key !== undefined && typeof n.key !== 'string' && typeof n.key !== 'number')

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

// --- closed state -----------------------------------------------------------
let view = collect(renderSeat())
let trigger = byClass(view, 'tsl-trigger')[0]
check('renders the composer trigger', trigger !== undefined)
check('trigger reads "model 路 level"', textOf(trigger).includes('glm-5.3') && textOf(trigger).includes('High'), JSON.stringify(textOf(trigger)))
check('trigger is enabled', trigger?.props.disabled === false)
check('no slider rail while closed', byClass(view, 'tsl-trackWrap').length === 0)

// --- open the card ----------------------------------------------------------
trigger.props.onClick()
view = collect(renderSeat())
const card = byClass(view, 'tsl-card')[0]
check('clicking the trigger opens the card', card !== undefined)
check('card is a labelled dialog', card?.props.role === 'dialog')
check('card headline is the level name', byClass(view, 'tsl-level')[0] !== undefined && textOf(byClass(view, 'tsl-level')[0]) === 'High', textOf(byClass(view, 'tsl-level')[0]))
check('card shows the model row', textOf(byClass(view, 'tsl-modelRow')[0]) === 'glm-5.3', textOf(byClass(view, 'tsl-modelRow')[0]))

const rail = byClass(view, 'tsl-trackWrap')[0]
check('slider exposes a11y state', rail?.props.role === 'slider' && rail?.props['aria-valuemax'] === 3 && rail?.props['aria-valuenow'] === 2,
  `role=${rail?.props.role} max=${rail?.props['aria-valuemax']} now=${rail?.props['aria-valuenow']}`)
check('one tick per level', byClass(view, 'tsl-tick').length === 4, String(byClass(view, 'tsl-tick').length))
check('one scale label per level', byClass(view, 'tsl-scaleItem').length === 4)
check('particle canvas is mounted', byClass(view, 'tsl-canvas').length === 1)

const fill = byClass(view, 'tsl-fill')[0]
check('fill gradient is emitted', typeof fill?.props.style?.background === 'string' && fill.props.style.background.startsWith('linear-gradient'), fill?.props.style?.background)
check('fill ends exactly under the knob centre (single geometry)',
  fill?.props.style?.width === byClass(view, 'tsl-thumb')[0]?.props.style?.left,
  `fill=${fill?.props.style?.width} thumb=${byClass(view, 'tsl-thumb')[0]?.props.style?.left}`)
check('the active tick sits under the knob (shared geometry)',
  byClass(view, 'tsl-tick')[2]?.props.style?.left === byClass(view, 'tsl-thumb')[0]?.props.style?.left,
  `tick[2]=${byClass(view, 'tsl-tick')[2]?.props.style?.left} thumb=${byClass(view, 'tsl-thumb')[0]?.props.style?.left}`)
const highGradient = fill?.props.style?.background

// --- drag to the far right --------------------------------------------------
rail.props.onPointerDown({ preventDefault() {}, currentTarget: { setPointerCapture() {} }, clientX: 419, pointerId: 1 })
rail.props.onPointerUp({ clientX: 419 })
await new Promise((resolve) => setTimeout(resolve, 0))
check('dragging to the end commits Max', calls.at(-1)?.reasoningEffort === 'max', JSON.stringify(calls.at(-1) ?? null))

// --- keyboard ---------------------------------------------------------------
calls.length = 0
rail.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
check('ArrowLeft commits the previous level', calls.at(-1)?.reasoningEffort === 'low', JSON.stringify(calls.at(-1) ?? null))
// The app re-renders after a commit; that render is what reconciles the
// optimistic level against the echoed one.
collect(renderSeat())

// --- a commit shows the new level before the host answers ------------------
{
  snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'off' }
  resetRender()
  // The gate must be installed BEFORE the commit, so this really is a host that
  // has not answered yet.
  const never = async () => new Promise(() => {})
  let slowView = collect(renderSeat({ select: never }))
  byClass(slowView, 'tsl-trigger')[0].props.onClick()
  slowView = collect(renderSeat({ select: never }))
  const slowRail = byClass(slowView, 'tsl-trackWrap')[0]
  slowRail.props.onPointerDown({ preventDefault() {}, currentTarget: { setPointerCapture() {} }, clientX: 419, pointerId: 1 })
  slowRail.props.onPointerUp({ clientX: 419 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  slowView = collect(renderSeat({ select: never }))
  check('a commit shows the new level without waiting for the host',
    textOf(byClass(slowView, 'tsl-level')[0]) === 'Max',
    `level=${textOf(byClass(slowView, 'tsl-level')[0])}`)
}

// Re-open the card for the checks below, which read the rail's look and geometry.
snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
resetRender()
collect(renderSeat())
byClass(collect(renderSeat()), 'tsl-trigger')[0].props.onClick()
collect(renderSeat())

// --- gradient climbs with the level ----------------------------------------
snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'max' }
let maxView = collect(renderSeat())
const maxGradient = byClass(maxView, 'tsl-fill')[0]?.props.style?.background
snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'off' }
let offView = collect(renderSeat())
const offFill = byClass(offView, 'tsl-fill')[0]
check('max gradient differs from high gradient', maxGradient !== highGradient, `${highGradient} vs ${maxGradient}`)
check('off rail is dimmed rather than glowing', offFill?.props.style?.opacity === 0.45, String(offFill?.props.style?.opacity))
check('off knob still sits flush at the left cap', offFill?.props.style?.width === byClass(offView, 'tsl-thumb')[0]?.props.style?.left,
  `fill=${offFill?.props.style?.width} thumb=${byClass(offView, 'tsl-thumb')[0]?.props.style?.left}`)
const maxFill = byClass(maxView, 'tsl-fill')[0]
check('max knob sits flush at the right cap', maxFill?.props.style?.width === byClass(maxView, 'tsl-thumb')[0]?.props.style?.left,
  `fill=${maxFill?.props.style?.width} thumb=${byClass(maxView, 'tsl-thumb')[0]?.props.style?.left}`)

// --- model pane -------------------------------------------------------------
snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
view = collect(renderSeat())
byClass(view, 'tsl-modelRow')[0].props.onClick()
view = collect(renderSeat())
const items = byClass(view, 'tsl-item')
check('model pane lists every selectable model', items.length === 3, String(items.length))
check('model pane groups by provider', byClass(view, 'tsl-group').length === 2, String(byClass(view, 'tsl-group').length))
check('a reasoning model shows one ramp dot per level', byClass(view, 'tsl-rampDot').length === 5, String(byClass(view, 'tsl-rampDot').length))
check('the ramp lists the level names in its tooltip', String(items[0]?.props?.title ?? '').includes('Off') && String(items[0]?.props?.title ?? '').includes('Max'), String(items[0]?.props?.title))
check('a model with no levels shows no ramp dots', byClass(view, 'tsl-ramp').length === 2, String(byClass(view, 'tsl-ramp').length))
check('a model with no levels shows a muted dash instead', byClass(view, 'tsl-rampNone').length === 1, String(byClass(view, 'tsl-rampNone').length))
check('no element was passed a children array as its key', misArityLeaf(view).length === 0,
  misArityLeaf(view).map((n) => n.type).join(', ') || 'none')

calls.length = 0
items[2].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
check('picking a model selects that provider/model', calls.at(-1)?.provider === 'teds' && calls.at(-1)?.model === 'deepseek-v4-pro', JSON.stringify(calls.at(-1) ?? null))
check('picking a model carries its default level', 'reasoningEffort' in (calls.at(-1) ?? {}) === false, JSON.stringify(calls.at(-1) ?? null))

// --- a model with no reasoning levels ---------------------------------------
snapshot.current = { provider: 'tokenrhythm', model: 'plain-model' }
const plain = collect(renderSeat())
const plainRail = byClass(plain, 'tsl-trackWrap')[0]
check('no-effort model renders no rail after opening', plainRail === undefined)
if (plainRail !== undefined) {
  // Should a rail ever appear here, drive it: the invariant below then reports
  // the level this model would be asked for, which the host refuses.
  plainRail.props.onPointerDown({ preventDefault() {}, currentTarget: { setPointerCapture() {} }, clientX: 419, pointerId: 1 })
  plainRail.props.onPointerUp({ clientX: 419 })
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const plainTrigger = byClass(collect(renderSeat()), 'tsl-trigger')[0]
check('no-effort trigger omits the level segment', !textOf(plainTrigger).includes('路'), JSON.stringify(textOf(plainTrigger)))

// --- stability: a throwing directory must not escape the component ----------
snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
const originalGroups = snapshot.groups
snapshot.groups = null
let threw = null
let fallbackView = null
try {
  fallbackView = collect(renderSeat())
} catch (error) {
  threw = error
}
check('a broken snapshot does not throw out of the seat', threw === null, threw === null ? '' : String(threw))
snapshot.groups = originalGroups

// A directory whose getSnapshot throws is caught by the boundary.
const explodingDirectory = { store: { subscribe: () => () => {}, getSnapshot: () => { throw new Error('boom') } }, load: async () => {}, select: async () => ({ ok: true }) }
const explodingFace = { available: true, directory: explodingDirectory.store, load: () => {}, select: explodingDirectory.select }
let boundaryError = null
let boundaryView = null
boundaryCatches.length = 0
const originalError = console.error
console.error = () => {}
try {
  boundaryView = collect(renderSeat(explodingFace))
} catch (error) {
  boundaryError = error
} finally {
  console.error = originalError
}
check('a throwing directory is caught by the seat boundary', boundaryError === null, boundaryError === null ? '' : String(boundaryError))
check('the boundary actually absorbed the crash', boundaryCatches.length === 1, String(boundaryCatches.length))
check('the boundary renders a fallback instead of nothing', byClass(boundaryView ?? [], 'tsl-fallback').length === 1)

// ---------------------------------------------------------------------------
// Rail modes: official hands the composer back, energy binds its own renderer
// ---------------------------------------------------------------------------
{
  const row = modeRowReg()
  const modeView = collect(expand(row.component({})))
  const choices = byClass(modeView, 'tsl-segChoice')
  check('the settings row offers every mode', choices.length === 3, String(choices.length))
  check('the settings row marks the active mode',
    choices.filter((c) => c.props['data-active'] === true).length === 1)
  check('the settings row defaults to particle',
    textOf(choices.find((c) => c.props['data-active'] === true)) === '粒子')

  // -------------------------------------------------------------------------
  // Filling reasoning levels into llm-pi-ai's config.
  //
  // The Models settings page has no field for `reasoningEfforts`, so any provider
  // added through it offers no levels. Nothing the client shows can fix that —
  // the Host refuses an unmapped level — so the plugin writes the mapping into the
  // config the adapter actually reads.
  // -------------------------------------------------------------------------
  {
    // The hook slots are global to the harness, so drop the Seat's before
    // rendering a settings row stand-alone (its `pane` state is the string
    // 'effort', which is how a collision shows up).
    resetRender()
    check('the levels row is registered', levelsRowReg() !== undefined)
    let levelsView = collect(expand(levelsRowReg().component({ target: llmTarget })))
    check('the levels row lists only providers with level-less models',
      textOf(levelsView).includes('nvidia') && textOf(levelsView).includes('tokenrhythm')
        && !textOf(levelsView).includes('teds'),
      textOf(levelsView).slice(0, 120))
    check('the levels row counts the level-less models',
      textOf(levelsView).includes('2 个代理商共 2 个模型'), textOf(levelsView).slice(0, 120))

    const fills = byClass(levelsView, 'tsl-fillApply')
    check('the levels row offers one fill per affected provider',
      fills.length === 2 && textOf(fills[0]) === '补四档', String(fills.length))

    const writesBefore = formWrites.length
    fills[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const write = formWrites.at(-1)
    check('the fill writes the providers field',
      formWrites.length === writesBefore + 1 && write?.field === 'providers', String(write?.field))
    check('the level-less model gains exactly the four verified levels',
      JSON.stringify(write?.next?.nvidia?.models?.[0]?.reasoningEfforts)
        === JSON.stringify({ off: 'none', low: 'low', high: 'high', max: 'max' }),
      JSON.stringify(write?.next?.nvidia?.models?.[0]?.reasoningEfforts ?? null))
    check('a model that already declares levels keeps its own mapping',
      JSON.stringify(write?.next?.nvidia?.models?.[1]?.reasoningEfforts)
        === JSON.stringify({ off: 'none', low: 'low' }),
      JSON.stringify(write?.next?.nvidia?.models?.[1]?.reasoningEfforts ?? null))
    check('another provider is left untouched',
      write?.next?.tokenrhythm?.models?.length === 3
        && write?.next?.tokenrhythm === llmConfig.providers.tokenrhythm,
      String(write?.next?.tokenrhythm?.models?.length))

    levelsView = collect(expand(levelsRowReg().component({ target: llmTarget })))
    check('the row reports what is left after one fill',
      textOf(levelsView).includes('1 个代理商共 1 个模型'), textOf(levelsView).slice(0, 120))
    resetRender()
  }

  // The card is where someone looks when a model offers no levels, so the fix
  // must be reachable there too — driven through the plugin's real face.
  {
    resetRender()
    snapshot.current = { provider: 'tokenrhythm', model: 'plain-model' }
    const writesBefore = formWrites.length
    let card = collect(renderSeat())
    byClass(card, 'tsl-trigger')[0].props.onClick()
    card = collect(renderSeat())
    const button = byClass(card, 'tsl-fillApply')[0]
    check('the card offers the level fix for the model in front of the user',
      button !== undefined && textOf(button).includes('tokenrhythm'), textOf(button))
    button.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const write = formWrites.at(-1)
    const filled = write?.next?.tokenrhythm?.models?.find((model) => model.id === 'plain-model')
    check('the card button writes the mapping through the real fill path',
      formWrites.length === writesBefore + 1 && write?.field === 'providers'
        && JSON.stringify(filled?.reasoningEfforts)
          === JSON.stringify({ off: 'none', low: 'low', high: 'high', max: 'max' }),
      JSON.stringify(filled?.reasoningEfforts ?? null))
    check('the plugin resolved the namespace that actually carries providers',
      formNamespaces.includes('include:llm-pi-ai'), formNamespaces.join(', '))
    card = collect(renderSeat())
    check('the card reports the mapping as written, not an error',
      textOf(card).includes('已写入'), textOf(byClass(card, 'tsl-failure')[0] ?? card).slice(0, 90))
    resetRender()
  }

  // The directory must be fetched once per session, not once per render: the
  // slot entry rebuilds `load` every pass, so an effect keyed on it re-fetches
  // on every composer re-render — a network round-trip per reasoning-level change.
  {
    snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
    resetRender()
    let loads = 0
    // A FRESH function each render, because that is what the slot entry hands
    // down: reusing one reference would hide the bug this asserts against.
    const makeLoad = () => () => { loads += 1 }
    collect(renderSeat({ load: makeLoad() }))
    const afterFirst = loads
    for (let pass = 0; pass < 5; pass += 1) collect(renderSeat({ load: makeLoad() }))
    check('the model directory loads once, not on every render',
      afterFirst === 1 && loads === afterFirst, `first=${afterFirst} afterSixRenders=${loads}`)

    // A fresh session must load again.
    const otherDirectory = { subscribe: () => () => {}, getSnapshot: () => snapshot }
    const beforeSessionChange = loads
    collect(renderSeat({ load: makeLoad(), directory: otherDirectory }))
    check('a different session loads its own directory',
      loads === beforeSessionChange + 1, `before=${beforeSessionChange} after=${loads}`)
    resetRender()
  }

  // Switching to 官方 must give the composer back to the shipped selector.
  const claimedBefore = claimed.has('p:-1')
  choices.find((c) => textOf(c) === '官方').props.onClick()
  check('choosing 官方 releases the composer seat', seatRegs().at(-1) !== undefined && !claimed.has('p:-1'),
    `claimed -1 before=${String(claimedBefore)} after=${String(claimed.has('p:-1'))}`)
  check('choosing 官方 persists the mode', storage.get('dsh-thinking-slider:mode') === 'official',
    String(storage.get('dsh-thinking-slider:mode')))

  // And switching back must reclaim it. Asserted as "a registration happened
  // and the shadowing priority is held again": earlier tests leave leaked
  // generations subscribed, so an exact count is not meaningful here.
  const seatsBefore = seatRegs().length
  choices.find((c) => textOf(c) === '粒子').props.onClick()
  check('switching back reclaims the composer seat',
    seatRegs().length > seatsBefore && claimed.has('p:-1'),
    `before=${seatsBefore} after=${seatRegs().length} holds -1=${String(claimed.has('p:-1'))}`)
}

// A re-declaration must not resurrect the seat while the mode is `official`.
{
  const modeRow = modeRowReg()
  byClass(collect(expand(modeRow.component({}))), 'tsl-segChoice')
    .find((c) => textOf(c) === '官方').props.onClick()
  const afterOfficial = seatRegs().length
  collapseSlot('conversation.input.model')
  declareSlot('conversation.input.model')
  check('official mode does not mount on a fresh declaration',
    seatRegs().length === afterOfficial, `added=${seatRegs().length - afterOfficial}`)

  // Back to particle: the live declaration must mount again.
  byClass(collect(expand(modeRowReg().component({}))), 'tsl-segChoice')
    .find((c) => textOf(c) === '粒子').props.onClick()
  check('returning to particle mounts on the live declaration',
    seatRegs().length === afterOfficial + 1 && claimed.has('p:-1'),
    `added=${seatRegs().length - afterOfficial} holds -1=${String(claimed.has('p:-1'))}`)
}

// The energy rail must actually bind to the freshly mounted canvas.
{
  snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
  classInstances.clear()
  nodeCache.clear()
  liveNodes = new Set()
  hookSlots = []
  effectSlots = []
  pendingEffects = []
  lastBoundCanvas = null

  storage.set('dsh-thinking-slider:mode', 'energy')
  // The module reads its mode once; drive the store through the settings row.
  const row = modeRowReg()
  const modeView = collect(expand(row.component({})))
  byClass(modeView, 'tsl-segChoice').find((c) => textOf(c) === '能量充能').props.onClick()

  let view = collect(renderSeat())
  byClass(view, 'tsl-trigger')[0].props.onClick()
  view = collect(renderSeat())
  const canvas = byClass(view, 'tsl-canvas')[0]
  check('energy mode binds its renderer to the rail canvas', canvas !== undefined && lastBoundCanvas === canvas,
    `bound=${String(canvas?.bound)}`)

  // The complaint this guards: both renderers driving the same canvas at once.
  const loopsInEnergy = rafLive.size
  check('energy mode runs exactly one animation loop', loopsInEnergy === 1, `loops=${loopsInEnergy}`)

  // And that the effect is actually visible: the energy rail is a dot lattice
  // over a DARK track, so the gradient fill must be suppressed and the canvas
  // must paint lit cells.
  const fill = byClass(view, 'tsl-fill')[0]
  check('energy mode hides the gradient fill so the lattice is the only colour',
    fill?.props.style?.opacity === 0, `opacity=${String(fill?.props.style?.opacity)}`)

  const rgba = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
  const litCells = (canvas?.colours ?? []).filter((colour) => {
    const match = rgba.exec(colour)
    if (match === null) return false
    return (match[4] === undefined ? 1 : Number(match[4])) > 0.05
  })
  check('the energy lattice paints lit cells', litCells.length > 0 && (canvas?.paints ?? 0) > 0,
    `paints=${String(canvas?.paints)} cells=${litCells.length} colours=${String(canvas?.colours?.length)}`)

  // The light scheme must not bleach cells toward white: that rail is already
  // near-white, so the brightest cells would be the least visible ones. Measured
  // on ONE frame's cells, ordered by opacity, so dim early frames cannot flatter
  // the result.
  {
    /**

     */
    const saturationOf = (colour) => {
      const match = rgba.exec(colour)
      if (match === null) return 0
      return Math.max(Number(match[1]), Number(match[2]), Number(match[3]))
        - Math.min(Number(match[1]), Number(match[2]), Number(match[3]))
    }
    const alphaOf = (colour) => {
      const match = rgba.exec(colour)
      return match === null ? 0 : match[4] === undefined ? 1 : Number(match[4])
    }

    // Flip the scheme on the ALREADY MOUNTED rail: this exercises the same
    // MutationObserver path a live theme switch takes, and avoids leaving a
    // second canvas effect behind.
    setDarkTheme(false)
    collect(renderSeat())
    for (let i = 0; i < 90; i += 1) pumpFrames(1)
    const lightView = collect(renderSeat())
    const lightCanvas = byClass(lightView, 'tsl-canvas')[0]
    // `rects` holds only the most recently drawn frame.
    const lightCells = (lightCanvas?.rects ?? []).map((r) => r.colour)
    // The decisive property: in the light scheme NO clearly visible cell may be
    // near-white, because a near-white cell on a near-white rail is invisible.
    // Bleaching the tint by opacity cannot hide behind an average.
    const visible = lightCells
      .map((colour) => ({ alpha: alphaOf(colour), saturation: saturationOf(colour) }))
      .filter((cell) => cell.alpha > 0.5)
    const leastSaturated = visible.length === 0 ? 0 : Math.min(...visible.map((cell) => cell.saturation))
    check('the light scheme never paints a near-white cell on its near-white rail',
      visible.length >= 10 && leastSaturated > 100,
      `cells=${lightCells.length} visible=${visible.length} leastSaturated=${leastSaturated}`)
    // Restore the dark scheme for the remaining checks.
    setDarkTheme(true)
    collect(renderSeat())
  }

  // Switch back to particle and confirm the energy loop is torn down first.
  const row2 = modeRowReg()
  byClass(collect(expand(row2.component({}))), 'tsl-segChoice').find((c) => textOf(c) === '粒子').props.onClick()
  view = collect(renderSeat())
  const loopsInParticle = rafLive.size
  check('switching modes swaps the loop instead of stacking a second',
    loopsInParticle === 1, `loops=${loopsInParticle}`)

  // A commit must hand the renderer a burst request it consumes.
  calls.length = 0
  const rail = byClass(view, 'tsl-trackWrap')[0]
  rail.props.onPointerDown({ preventDefault() {}, currentTarget: { setPointerCapture() {} }, clientX: 419, pointerId: 1 })
  rail.props.onPointerUp({ clientX: 419 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('a commit commits the level in energy mode', calls.at(-1)?.reasoningEffort === 'max', JSON.stringify(calls.at(-1) ?? null))

  // Back to particle for the remaining checks.
  byClass(collect(expand(row.component({}))), 'tsl-segChoice').find((c) => textOf(c) === '粒子').props.onClick()
}

// The failure the user actually hit: a TRANSIENT render error must not park the
// fallback in the composer forever.
{
  let failNext = true
  const flakyDirectory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => {
        if (failNext) { failNext = false; throw new Error('catalog reloading') }
        return snapshot
      },
    },
    load: async () => ({ groups: catalogue }),
    select: async () => ({ ok: true }),
  }
  const flakyFace = { available: true, directory: flakyDirectory.store, load: () => {}, select: flakyDirectory.select }
  const quiet = console.error
  console.error = () => {}
  classInstances.clear()                        // isolate this scenario
  boundaryCatches.length = 0
  const first = collect(renderSeat(flakyFace))
  check('a transient failure shows the fallback', byClass(first, 'tsl-fallback').length === 1)

  const retry = byClass(first, 'tsl-fallbackRetry')[0]
  check('the fallback offers a 閲嶈瘯 control', retry !== undefined)
  check('the fallback is not a dead end (it keeps an auto-retry timer)',
    [...classInstances.values()].some((instance) => instance.timer !== null && instance.timer !== undefined))
  retry?.props.onClick()
  const second = collect(renderSeat(flakyFace))
  console.error = quiet

  check('the seat recovers after a retry (boundary is not sticky)', byClass(second, 'tsl-fallback').length === 0,
    `fallback=${byClass(second, 'tsl-fallback').length}`)
  check('the recovered seat renders the trigger again', byClass(second, 'tsl-trigger').length === 1)
}

check('a seat-render crash is published to the diagnostic channel', (() => {
  const diagnostics = globalThis.__dshThinkingSlider?.diagnostics ?? []
  return diagnostics.some((entry) => entry.phase === 'seat-render')
})(), (globalThis.__dshThinkingSlider?.diagnostics ?? []).map((d) => d.phase).join(','))

// ---------------------------------------------------------------------------
// Stability: the failures that made the seat vanish in the real app
// ---------------------------------------------------------------------------
check('a hot reload disposes the previous registration', (() => {
  const before = seatRegs().length
  teardown?.()
  loadPlugin()
  return seatRegs().length === before + 1
})(), `registrations=${seatRegs().length}, duplicate strikes=${duplicateStrikes}`)

// A predecessor that never ran its disposer (the real leak) must not be fatal.
check('a leaked registration is stepped over, not fatal', (() => {
  const before = seatRegs().length
  loadPlugin()                       // no teardown: simulates the leaked generation
  const latest = seatRegs().at(-1)
  return seatRegs().length === before + 1 && duplicateStrikes >= 1 && latest.options.priority < -1
})(), `priority=${seatRegs().at(-1)?.options.priority}, duplicate strikes=${duplicateStrikes}`)

// The newest generation must still be the one rendered (lowest priority wins).
check('the newest generation holds the lowest priority', (() => {
  const priorities = seatRegs().map((r) => r.options.priority)
  return priorities.at(-1) === Math.min(...priorities)
})(), seatRegs().map((r) => r.options.priority).join(' > '))

// A throwing directory must degrade, never retire the entry.
check('a throwing directory degrades the face instead of throwing', (() => {
  const exploding = {
    inject: (_deps, callback) => callback({
      slots,
      sessions: { subagentAddress: () => undefined },
      modelDirectories: { directoryFor: () => { throw new Error('session resolved no scope') } },
      effect: (fn) => fn(),
    }),
  }
  const errors = seatRegs().length
  mod.apply(exploding)
  const newest = seatRegs().at(-1)
  let face = null
  try {
    face = newest.options.inject('session-x')
  } catch {
    return false
  }
  void errors
  return face !== null && face.available === false && typeof face.select === 'function'
})())

// An abdicated entry must be put back so the seat returns by itself.
// Isolate one live generation so the assertion is exact.
entryErrorListeners.clear()
loadPlugin()
check('an abdicated seat re-registers itself', (() => {
  const before = seatRegs().length
  for (const listener of entryErrorListeners) {
    listener('conversation.input.model', seatRegs().at(-1), new Error('render blew up'), { abdicated: true })
  }
  return seatRegs().length === before + 1
})(), `registrations=${seatRegs().length}, listeners=${entryErrorListeners.size}`)

check('an abdication of a different seat is ignored', (() => {
  const before = seatRegs().length
  for (const listener of entryErrorListeners) {
    listener('some.other.slot', seatRegs().at(-1), new Error('x'), { abdicated: true })
  }
  return seatRegs().length === before
})())

// The particle loop is bound to a canvas ELEMENT. Switching to the model pane
// unmounts that canvas and returning mounts a new one, so the loop must re-bind
// —otherwise the rail stays blank until the card is closed and reopened.
{
  snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: 'high' }
  classInstances.clear()
  nodeCache.clear()
  liveNodes = new Set()
  hookSlots = []
  effectSlots = []
  pendingEffects = []

  let view = collect(renderSeat())
  byClass(view, 'tsl-trigger')[0].props.onClick()
  view = collect(renderSeat())
  const firstCanvas = byClass(view, 'tsl-canvas')[0]
  check('opening the card binds the particle loop to the canvas', lastBoundCanvas === firstCanvas && firstCanvas?.bound >= 1,
    `bound=${String(firstCanvas?.bound)}`)

  // Walk into the model pane: the canvas unmounts.
  byClass(view, 'tsl-modelRow')[0].props.onClick()
  view = collect(renderSeat())
  check('the model pane unmounts the canvas and stops its loop',
    byClass(view, 'tsl-canvas').length === 0 && firstCanvas.clears >= 1,
    `clears=${String(firstCanvas.clears)}`)

  // Pick a model: the effort pane returns with a BRAND-NEW canvas.
  byClass(view, 'tsl-item')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  view = collect(renderSeat())
  const secondCanvas = byClass(view, 'tsl-canvas')[0]
  check('returning from the model pane mounts a different canvas', secondCanvas !== undefined && secondCanvas !== firstCanvas)
  check('the particle loop re-binds to the new canvas (no close/reopen needed)',
    lastBoundCanvas === secondCanvas && secondCanvas?.bound >= 1,
    `bound to first=${String(lastBoundCanvas === firstCanvas)}, new=${String(lastBoundCanvas === secondCanvas)}`)
}

check('a non-abdicating crash report does not churn the seat', (() => {
  const before = seatRegs().length
  for (const listener of entryErrorListeners) {
    listener('conversation.input.model', seatRegs().at(-1), new Error('chain declined'), { abdicated: false })
  }
  return seatRegs().length === before
})())

check('diagnostics are published for DevTools', Array.isArray(globalThis.__dshThinkingSlider?.diagnostics) && globalThis.__dshThinkingSlider.diagnostics.length >= 1,
  String(globalThis.__dshThinkingSlider?.diagnostics?.length ?? 0))

check('apply never throws even on a broken composition', (() => {
  try {
    mod.apply({ inject: () => { throw new Error('no services at all') } })
    return true
  } catch {
    return false
  }
})())

// ---------------------------------------------------------------------------
// Opt-in preview dump: replay the REAL renderer's recorded draws as SVG, so a
// still can be reviewed without opening DSH. `TSL_FRAME_OUT=<dir>` to enable.
// ---------------------------------------------------------------------------
if (process.env.TSL_FRAME_OUT) {
  const path_ = await import('node:path')
  const fs_ = await import('node:fs')
  const outDir = process.env.TSL_FRAME_OUT
  fs_.mkdirSync(outDir, { recursive: true })

  const LEVELS_TO_DUMP = [
    { level: 'off', name: 'Off' },
    { level: 'low', name: 'Low' },
    { level: 'high', name: 'High' },
    { level: 'max', name: 'Max' },
  ]

  const rowFor = (label, rects, fraction, light) => {
    const W = 284
    const H = 26
    const knob = H
    const scale = 2.2
    const limit = knob / 2 + (W - knob) * fraction
    const body = rects
      .map((r) => `<rect x="${(r.x * scale).toFixed(1)}" y="${(r.y * scale).toFixed(1)}" width="${Math.max(0.6, r.w * scale).toFixed(1)}" height="${Math.max(0.6, r.h * scale).toFixed(1)}" fill="${r.colour}"/>`)
      .join('')
    // The rail's own surface follows the scheme, so the still is faithful.
    const rail = light ? 'fill="#f6f6f8" stroke="#e2e2e8"' : 'fill="#16161a" stroke="#2c2c34"'
    const ink = light ? '#3a3a44' : '#c9c9d2'
    return `<g><text x="0" y="-10" fill="${ink}" font-size="13" font-family="Segoe UI">${label}</text>` +
      `<rect x="0" y="0" width="${(W * scale).toFixed(0)}" height="${(H * scale).toFixed(0)}" rx="${(H * scale / 2).toFixed(1)}" ${rail}/>` +
      body +
      // The knob is a DOM element, so the still must place it explicitly.
      `<circle cx="${(limit * scale).toFixed(1)}" cy="${(H * scale / 2).toFixed(1)}" r="${(knob * scale / 2).toFixed(1)}" fill="#ffffff" stroke="${light ? '#dcdce4' : 'none'}"/>` +
      `</g>`
  }

  const dumpTheme = (light) => {
    setDarkTheme(!light)
    const rows = []
    for (const entry of LEVELS_TO_DUMP) {
      snapshot.current = { provider: 'tokenrhythm', model: 'glm-5.3', reasoningEffort: entry.level }
      classInstances.clear()
      nodeCache.clear()
      liveNodes = new Set()
      hookSlots = []
      effectSlots = []
      pendingEffects = []
      storage.set('dsh-thinking-slider:mode', 'energy')
      const modeRow = modeRowReg()
      byClass(collect(expand(modeRow.component({}))), 'tsl-segChoice')
        .find((c) => textOf(c) === '能量充能').props.onClick()

      let v = collect(renderSeat())
      const trigger = byClass(v, 'tsl-trigger')[0]
      if (trigger) trigger.props.onClick()
      v = collect(renderSeat())
      // Pump well past the charge front so the still shows the settled state.
      for (let i = 0; i < 240; i += 1) pumpFrames(1)
      v = collect(renderSeat())
      const node = byClass(v, 'tsl-canvas')[0]
      const fraction = LEVELS_TO_DUMP.indexOf(entry) / Math.max(1, LEVELS_TO_DUMP.length - 1)
      rows.push(rowFor(entry.name, node?.rects ?? [], fraction, light))
    }
    const background = light ? '#ffffff' : '#0e0e12'
    return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="${rows.length * 90 + 20}">
<rect width="100%" height="100%" fill="${background}"/>${rows.map((r, i) => `<g transform="translate(20 ${40 + i * 90})">${r}</g>`).join('')}</svg>`
  }

  for (const [name, light] of [['dark', false], ['light', true]]) {
    const file = path_.join(outDir, `energy-frames-${name}.svg`)
    fs_.writeFileSync(file, dumpTheme(light))
    console.log(`\npreview written: ${file}`)
  }
  setDarkTheme(true)
}

// ---------------------------------------------------------------------------
// Invariant: never ask the host for a level the model does not report.
//
// The Host validates an explicit effort against the model's supported levels and
// throws UNSUPPORTED_REASONING_EFFORT ("... does not support reasoning effort
// ...") instead of clamping. A fallback that invents levels for a model that
// declares none therefore turns every pick into a visible error, which is why
// DSH reports no selectable levels at all for such a model.
// ---------------------------------------------------------------------------
{
  const effortsFor = (provider, modelId) => {
    const route = catalogue.find((entry) => entry.id === provider)
    const model = route?.models?.find((entry) => entry.id === modelId)
    return model?.reasoning?.efforts
  }
  const offenders = allCalls.filter((call) => {
    if (call.reasoningEffort === undefined) return false
    const efforts = effortsFor(call.provider, call.model)
    if (!Array.isArray(efforts)) return true
    return !efforts.some((level) => level?.id === call.reasoningEffort)
  })
  check('every requested level is one the model actually reports',
    offenders.length === 0, JSON.stringify(offenders.slice(0, 2)))
  check('the invariant actually observed level requests',
    allCalls.some((call) => call.reasoningEffort !== undefined), String(allCalls.length))
}

const failed = checks.filter((c) => !c.ok)
console.log(failed.length === 0 ? `\nALL ${checks.length} CHECKS PASSED` : `\n${failed.length}/${checks.length} CHECK(S) FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
