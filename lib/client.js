/**
 * dsh-thinking-slider - browser half.
 *
 * Composer seat replacement for `conversation.input.model`:
 *
 *   - the trigger reads like the shipped one: `model · level`
 *   - clicking it opens a card in the Codex idiom: the level as the headline,
 *     the model as a link that swaps the card to the model list, and a wide
 *     gradient track with a heavy thumb
 *   - the track's gradient, glow and particle field all climb with the level;
 *     "off" is a cold, motionless rail rather than a lying control
 *
 * Levels are never hard-coded: the seat reads the catalog the Host advertises,
 * so any provider route declaring `reasoningEfforts` becomes draggable.
 *
 * Stability contract: the seat is wrapped in its own error boundary. The slot
 * renderer retires an entry whose render throws, so an unguarded crash would
 * silently hand the seat back to the shipped selector ("the slider vanished").
 * Everything below therefore degrades to a visible fallback instead of throwing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-thinking-slider',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { createPortal } = require('react-dom')

    const LOG = '[dsh-thinking-slider]'

    // ---------------------------------------------------------------------
    // Mode preference.
    //
    // Deliberately client-local (localStorage) rather than a Host Config
    // schema: a schema would require `@deepseek-ai/schemastery`, which is NOT
    // resolvable from a plugin that lives outside `<profile>/node_modules`
    // (the junction dev layout). The settings row below is registered into
    // `settings.general.item`, which the settings panel renders without any
    // namespace filtering, so no Host plumbing is needed at all.
    // ---------------------------------------------------------------------
    /** Selectable rail modes, in settings order. */
    const MODES = ['official', 'particle', 'energy']
    const MODE_LABELS = { official: '官方', particle: '粒子', energy: '能量充能' }
    const MODE_HINTS = {
      official: '完全交还 DSH 官方模型选择器',
      particle: '轨道内漂浮粒子，等级越高越密',
      energy: '能量向旋钮汇聚，落档时爆发，最高档持续燃烧',
    }
    const MODE_KEY = 'dsh-thinking-slider:mode'
    const DEFAULT_MODE = 'particle'

    const readMode = () => {
      try {
        const stored = globalThis.localStorage?.getItem(MODE_KEY)
        return MODES.includes(stored) ? stored : DEFAULT_MODE
      } catch {
        return DEFAULT_MODE
      }
    }
    let currentMode = readMode()
    const modeListeners = new Set()
    /** Current rail mode. */
    const getMode = () => currentMode
    /** Subscribe to mode changes (for `useSyncExternalStore`). */
    const subscribeMode = (listener) => {
      modeListeners.add(listener)
      return () => modeListeners.delete(listener)
    }
    /** Switch the rail mode and persist it. */
    const setMode = (next) => {
      if (!MODES.includes(next) || next === currentMode) return
      currentMode = next
      try {
        globalThis.localStorage?.setItem(MODE_KEY, next)
      } catch {}
      for (const listener of [...modeListeners]) listener()
    }
    /** React hook over the mode store. */
    const useMode = () => react.useSyncExternalStore(subscribeMode, getMode, getMode)

    // ---------------------------------------------------------------------
    // Filling in reasoning levels for models that declare none.
    //
    // The Host keeps the wire mapping per model in `reasoningEfforts`, and a model
    // without one resolves to `reasoning: false`: DSH reports no selectable level
    // and REFUSES an explicit one (UNSUPPORTED_REASONING_EFFORT), on purpose --
    // it will not ship "a control that cannot do what it says". So a level can
    // only be offered by putting the mapping into the config the Host reads.
    //
    // The Models settings page has no field for it, which is why every provider
    // added through the GUI offers no levels. A plugin may edit a namespace
    // another plugin owns, so the fix is to write the mapping into `llm-pi-ai`'s
    // own config -- the same place the Models page writes -- which the adapter
    // re-reads on the next request, no restart needed.
    //
    // Applied per provider, on request: a gateway that rejects `reasoning_effort`
    // would 400 every request, so this must never happen behind the user's back.
    // ---------------------------------------------------------------------
    const LLM_NAMESPACE = 'llm-pi-ai'
    /** The levels this plugin offers, in the wire spellings verified to work. */
    const DEFAULT_EFFORTS = { off: 'none', low: 'low', high: 'high', max: 'max' }

    /** Providers with at least one model that declares no levels. */
    const providersMissingLevels = (configValue) => {
      const providers = configValue?.providers
      if (providers === null || typeof providers !== 'object') return []
      const missing = []
      for (const [route, entry] of Object.entries(providers)) {
        const models = Array.isArray(entry?.models) ? entry.models : []
        const count = models.filter((model) => model?.reasoningEfforts === undefined).length
        if (count > 0) missing.push({ route, count, total: models.length })
      }
      return missing.sort((left, right) => left.route.localeCompare(right.route))
    }

    /** The provider map with one provider's level-less models filled in. */
    const withFilledLevels = (configValue, route) => {
      const entry = configValue?.providers?.[route]
      if (entry === undefined || entry === null) return undefined
      const models = (Array.isArray(entry.models) ? entry.models : []).map((model) =>
        model?.reasoningEfforts === undefined
          ? { ...model, reasoningEfforts: { ...DEFAULT_EFFORTS } }
          : model)
      return { ...configValue.providers, [route]: { ...entry, models } }
    }

    /**
     * Write the default levels for one provider's level-less models.
     *
     * Shared by the settings row and the card's empty state, because the empty
     * state is exactly where a user looks when a model offers no levels.
     *
     * `target` resolves the config form lazily: the namespace the Host serves is
     * discovered at runtime (`include:llm-pi-ai` for a bundle-inserted row, not
     * the patch id), so it cannot be hardcoded here.
     *
     * @returns `{ ok: true, count, pending? }` or `{ ok: false, message }`, with
     *   the message naming what was actually found so a mismatch is diagnosable.
     */
    const fillProviderLevels = (target, route) => {
      let form = null
      let namespace = '?'
      try {
        namespace = target.namespace()
        form = target.form()
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
      if (form === null || form === undefined) return { ok: false, message: '设置通道不可用' }
      const value = form.getSnapshot()?.value
      const providers = value?.providers
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
        const keys = value !== null && value !== undefined && typeof value === 'object'
          ? Object.keys(value).join(', ')
          : String(value)
        const served = target.namespaces?.().join(', ') ?? ''
        return { ok: false, message: `读不到 providers（命名空间 ${namespace}：拿到 ${keys || '空'}；可用 ${served || '无'}）` }
      }
      const entry = providers[route]
      if (entry === undefined || entry === null) {
        return { ok: false, message: `配置里没有代理商 "${route}"（现有：${Object.keys(providers).join(', ') || '空'}）` }
      }
      const models = Array.isArray(entry.models) ? entry.models : []
      const count = models.filter((model) => model?.reasoningEfforts === undefined).length
      if (count === 0) return { ok: true, count: 0 }
      const next = withFilledLevels(value, route)
      if (next === undefined) return { ok: false, message: `配置里没有代理商 "${route}"` }
      try {
        const result = form.set('providers', next)
        if (result !== undefined && result !== null && typeof result.then === 'function') {
          return {
            ok: true,
            count,
            pending: result.then(
              () => ({ ok: true, count }),
              (error) => ({ ok: false, message: String(error?.message ?? error) }),
            ),
          }
        }
        return { ok: true, count }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    }

    // ---------------------------------------------------------------------
    // Colour scheme.
    //
    // The theme boot script puts `data-ds-dark-theme` on <body>, which is the
    // only signal that reflects a FORCED light/dark preference (matchMedia only
    // reports the OS setting). Watching the attribute also keeps the rail
    // correct if the user flips the theme with the card already open.
    // ---------------------------------------------------------------------
    const readDarkTheme = () =>
      typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme') === true

    const useDarkTheme = () => {
      const [dark, setDark] = react.useState(readDarkTheme)
      react.useEffect(() => {
        const body = typeof document === 'undefined' ? undefined : document.body
        if (body === undefined || body === null || typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => setDark(readDarkTheme()))
        observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        setDark(readDarkTheme())
        return () => observer.disconnect()
      }, [])
      return dark
    }

    // ---------------------------------------------------------------------
    // Styles. Only confirmed theme tokens are used, each with a literal
    // fallback so a token rename degrades rather than breaks.
    // ---------------------------------------------------------------------
    const CSS = `
.tsl-root{display:flex;align-items:center;min-width:0}
.tsl-trigger{display:flex;align-items:center;gap:4px;height:28px;max-width:min(360px,45cqw);min-width:0;padding:0 6px 0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer;outline:none}
.tsl-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.tsl-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe))}
.tsl-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.tsl-triggerModel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tsl-triggerDot{flex:none;color:var(--dsw-alias-label-caption);opacity:.7}
.tsl-triggerLevel{flex:none;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption)}
.tsl-triggerChevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s ease}
.tsl-triggerChevronOpen{transform:rotate(180deg)}
.tsl-card{position:fixed;z-index:1100;--tsl-knob:26px;width:320px;padding:18px 18px 16px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:16px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.28));animation:tsl-in .14s ease-out}
@keyframes tsl-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.tsl-card{animation:none}}
.tsl-head{display:flex;align-items:center;justify-content:center;position:relative;min-height:26px;margin-bottom:2px}
.tsl-level{font-size:17px;line-height:26px;font-weight:500;letter-spacing:.02em;transition:color .18s ease}
.tsl-reset{position:absolute;right:-2px;top:0;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer;opacity:.85}
.tsl-reset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.tsl-modelRow{display:flex;align-items:center;justify-content:center;gap:2px;width:100%;margin:0 0 14px;padding:2px 6px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.tsl-modelRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.tsl-modelRow:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}
.tsl-modelName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}
.tsl-trackWrap{position:relative;height:30px;display:flex;align-items:center;outline:none;cursor:pointer;touch-action:none}
.tsl-trackWrap[data-inert=true]{cursor:default;opacity:.55}
.tsl-trackWrap:focus-visible .tsl-track{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe))}
.tsl-track{position:relative;width:100%;height:var(--tsl-knob);border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));overflow:hidden;transition:box-shadow .2s ease}
.tsl-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;transition:width .18s ease}
.tsl-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.tsl-ticks{position:absolute;inset:0;pointer-events:none}
.tsl-tick{position:absolute;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:999px;background:currentColor;opacity:.55}
.tsl-thumb{position:absolute;top:50%;width:var(--tsl-knob);height:var(--tsl-knob);margin:calc(var(--tsl-knob) / -2) 0 0 calc(var(--tsl-knob) / -2);border-radius:999px;background:#fff;pointer-events:none;transition:left .18s ease,box-shadow .2s ease;box-shadow:0 1px 4px rgba(0,0,0,.32)}
.tsl-scale{position:relative;height:16px;margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.tsl-scaleItem{position:absolute;top:0;white-space:nowrap;transform:translateX(-50%);transition:color .18s ease}
.tsl-scaleItem[data-active=true]{font-weight:500}
.tsl-empty{margin-top:10px;font-size:12px;line-height:18px;text-align:center;color:var(--dsw-alias-label-caption);display:flex;flex-direction:column;align-items:center;gap:8px}
.tsl-list{max-height:min(320px,50vh);overflow:auto;margin:0 -6px;padding:0 6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.tsl-group{margin:2px 0 6px;font-size:11px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.tsl-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:0 0;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.tsl-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.tsl-item[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.tsl-itemText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tsl-itemMeta{flex:none;display:inline-flex;align-items:center;font-size:11px;color:var(--dsw-alias-label-caption)}
.tsl-ramp{display:inline-flex;align-items:center;gap:3px}
.tsl-rampDot{display:block;width:5px;height:5px;border-radius:999px}
.tsl-rampNone{color:var(--dsw-alias-label-dimmed)}
.tsl-check{flex:none;width:14px;height:14px}
.tsl-failure{margin:4px 0;padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.12));color:var(--dsw-alias-state-error-primary,#d64545)}
.tsl-fallback{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));font-size:13px;color:var(--dsw-alias-label-secondary)}
.tsl-fallbackBadge{font-size:11px;color:var(--dsw-alias-state-warn-primary,#b7791f)}
.tsl-fallbackRetry{border:0;padding:0;background:0 0;color:inherit;font:inherit;font-size:11px;text-decoration:underline;cursor:pointer;opacity:.85}
.tsl-fallbackRetry:hover{opacity:1}
.tsl-settings{display:flex;flex-direction:column}
.tsl-setting{display:flex;align-items:center;gap:12px;padding:12px 0;min-width:0}
.tsl-fills{flex:none;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:58%}
.tsl-fillChip{display:inline-flex;align-items:center;gap:6px;padding:2px 4px 2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.tsl-fillApply{border:0;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap}
.tsl-fillApply:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.tsl-fillApply:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe))}
.tsl-settingText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.tsl-settingTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.tsl-settingHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.tsl-seg{flex:none;display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}
.tsl-segChoice{border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}
.tsl-segChoice:hover:not([data-active=true]){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.tsl-segChoice[data-active=true]{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.18)}
.tsl-segChoice:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe))}
`
    const TAG_ID = 'dsh-thinking-slider/styles.css'
    const installStyles = () => {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-thinking-slider'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    installStyles()

    // ---------------------------------------------------------------------
    // Level palette: one gradient stop set per level, interpolated across a
    // continuous position so a drag previews the exact level it would pick.
    // ---------------------------------------------------------------------
    /** `off` is deliberately cold and still, so it never reads as a live level. */
    const OFF_LOOK = {
      gradient: 'linear-gradient(90deg, rgb(100, 116, 139) 0%, rgb(148, 163, 184) 100%)',
      accent: 'rgb(148, 163, 184)',
      tint: [148, 163, 184],
      glow: 'rgba(148, 163, 184, 0.18)',
      energy: 0,
    }
    /**
     * Thinking-level stops, coldest to hottest. A model's non-off levels map
     * across these two extremes, so a three-level model spans blue -> magenta
     * exactly and a seven-level one interpolates smoothly through the same
     * range instead of pinning several levels to one colour.
     */
    const STOPS = [
      { from: [59, 130, 246], to: [99, 102, 241], glow: 'rgba(99,102,241,', energy: 0.34 }, // low - blue
      { from: [124, 58, 237], to: [168, 85, 247], glow: 'rgba(168,85,247,', energy: 0.68 }, // mid - violet
      { from: [217, 70, 239], to: [249, 115, 22], glow: 'rgba(236,72,153,', energy: 1.0 },  // top - magenta -> amber
    ]

    const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)
    const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t))
    const rgb = (channels) => `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`

    /**
     * One model row's level ramp: a dot per offered level, coloured along the
     * same palette the rail uses, so the list speaks the slider's visual
     * language. `off` takes the cold accent; the rest climb blue -> magenta.
     * @param efforts - the model's advertised levels.
     * @returns one colour per level, in order.
     */
    function rampOf(efforts) {
      const positive = efforts.filter((level) => level?.id !== 'off')
      return efforts.map((level) => {
        if (level?.id === 'off') return OFF_LOOK.accent
        const at = positive.findIndex((candidate) => candidate?.id === level?.id)
        const rank = positive.length <= 1 ? 1 : Math.max(0, at) / (positive.length - 1)
        return lookOf(rank).accent
      })
    }

    /**
     * Visual state for a thinking level at fractional depth `t` in `[0, 1]`.
     * @param t - 0 is the coldest thinking level, 1 the hottest.
     * @returns gradient stops, accent, glow, and particle energy.
     */
    function lookOf(t) {
      const p = clamp01(t)
      const span = STOPS.length - 1
      const scaled = p * span
      const index = Math.min(span - 1, Math.floor(scaled))
      const local = scaled - index
      const low = STOPS[index]
      const high = STOPS[index + 1]
      const energy = low.energy + (high.energy - low.energy) * local
      const tint = mix(low.to, high.to, local)
      return {
        gradient: `linear-gradient(90deg, ${rgb(mix(low.from, high.from, local))} 0%, ${rgb(tint)} 100%)`,
        accent: rgb(tint),
        // Numeric channels: the canvas renderers tint their cells with these.
        tint,
        glow: `${local < 0.5 ? low.glow : high.glow}${(0.18 + energy * 0.42).toFixed(2)})`,
        energy,
      }
    }

    // ---------------------------------------------------------------------
    // Particle field. Density, speed, sparkle and trails all follow energy;
    // nothing is drawn at all on the "off" rail.
    // ---------------------------------------------------------------------
    /**
     * Pixel x where the particle field must stop: the knob's centre.
     * @param width - measured rail width.
     * @param height - measured rail height, which equals the knob diameter.
     * @param fraction - stop fraction in `[0, 1]`.
     * @returns the limit in CSS pixels.
     */
    function limitOf(width, height, fraction) {
      const knob = Math.min(height, width)
      return knob / 2 + (width - knob) * clamp01(fraction ?? 1)
    }
    /**
     * Animation loop bound to one canvas ELEMENT, not to a ref object.
     *
     * The canvas only exists while the effort pane is mounted, and switching to
     * the model pane unmounts it — returning mounts a brand-new node. Keying the
     * effect on a ref object would leave the dependency list unchanged across
     * that swap, so the loop would keep painting the orphaned canvas and the new
     * one would stay blank until the card was closed and reopened.
     *
     * @param canvas - the mounted canvas node, or null while unmounted.
     * @param lookRef - current visual state, published per render.
     * @param repaintRef - receives a nudge function the seat calls on change.
     * @param enabled - whether the rail should animate at all.
     */
    function useParticles(canvas, lookRef, repaintRef, enabled) {
      react.useEffect(() => {
        if (!enabled || canvas === null || canvas === undefined) return undefined
        let context = null
        try {
          context = canvas.getContext('2d')
        } catch (error) {
          console.warn(LOG, 'canvas 2d unavailable; falling back to a static rail', error)
        }
        if (context === null) return undefined

        const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        let frame = 0
        let width = 0
        let height = 0
        let last = 0
        const particles = []

        const measure = () => {
          const rect = canvas.getBoundingClientRect()
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          width = Math.max(1, Math.round(rect.width))
          height = Math.max(1, Math.round(rect.height))
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          context.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        measure()

        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(canvas)
        }

        const MAX_PARTICLES = 120
        const seed = (particle, atStart) => {
          const energy = lookRef.current.energy
          // The field lives inside the filled part of the rail, so energy reads
          // as belonging to the selected level rather than the whole track.
          const limit = limitOf(width, height, lookRef.current.fillFraction)
          particle.x = atStart === true ? Math.random() * limit : -4
          particle.y = height * (0.28 + Math.random() * 0.44)
          particle.vx = (0.22 + Math.random() * 0.55) * (0.35 + energy)
          particle.vy = (Math.random() - 0.5) * 0.3
          particle.radius = 0.7 + Math.random() * 1.35
          particle.age = 0
          particle.span = 28 + Math.random() * 36
          return particle
        }

        const draw = (now) => {
          const delta = last === 0 ? 16.7 : Math.min(48, now - last)
          last = now
          const look = lookRef.current
          const energy = look.energy
          const limit = limitOf(width, height, look.fillFraction)
          const wanted = Math.round(energy <= 0.02 ? 0 : 10 + energy * (MAX_PARTICLES - 10))

          while (particles.length < wanted) particles.push(seed({}, true))
          if (particles.length > wanted) particles.length = wanted

          context.clearRect(0, 0, width, height)
          if (particles.length > 0) {
            const speed = 1 + energy * 2.5
            for (const particle of particles) {
              particle.x += particle.vx * speed * (delta / 16.7)
              particle.y += particle.vy * (delta / 16.7)
              particle.age += delta / 16.7
              if (particle.age > particle.span || particle.x > limit + 6) seed(particle, false)
              const fade = Math.sin(Math.PI * clamp01(particle.age / particle.span))
              const alpha = fade * (0.24 + energy * 0.5)
              const radius = particle.radius * (0.8 + energy * 0.85)
              context.beginPath()
              context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
              context.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
              context.fill()
              if (energy > 0.55) {
                context.beginPath()
                context.moveTo(particle.x, particle.y)
                context.lineTo(particle.x - particle.vx * 8 * energy, particle.y - particle.vy * 8)
                context.strokeStyle = `rgba(255,255,255,${(alpha * 0.3).toFixed(3)})`
                context.lineWidth = Math.max(0.5, radius * 0.5)
                context.stroke()
              }
            }
          }
          frame = requestAnimationFrame(draw)
        }

        const start = () => {
          if (frame !== 0 || reduceMotion) return
          last = 0
          frame = requestAnimationFrame(draw)
        }
        repaintRef.current = start
        start()

        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          frame = 0
          repaintRef.current = null
          observer?.disconnect()
          context.clearRect(0, 0, width, height)
        }
      }, [canvas, lookRef, repaintRef, enabled])
    }

    /**
     * "Energy" rail: a cellular field that charges from the left into the knob.
     *
     * Modelled on the cellular look this mode is meant to echo — a fine dot
     * lattice over a dark rail, cells igniting as a charging front sweeps
     * through, a warm tail settling behind the knob, and the top level burning
     * continuously — but reimplemented on canvas 2D as a per-cell decay
     * simulation, so the plugin keeps its zero dependencies and its single-file
     * bundle.
     *
     * Calm by design: intermediate levels settle to a static lit field and the
     * loop stops; only the model's highest level keeps burning. `repaintRef`
     * stays bound after the loop stops so the seat restarts it on the next level
     * change.
     *
     * @param canvas - the mounted canvas node, or null while unmounted.
     * @param lookRef - current visual state (energy, tint, fill fraction).
     * @param repaintRef - receives a nudge function the seat calls on change.
     * @param burstRef - a timestamp the seat writes to force a fresh charge.
     * @param enabled - whether the rail should animate at all.
     */
    function useEnergyField(canvas, lookRef, repaintRef, burstRef, enabled, darkTheme) {
      react.useEffect(() => {
        if (!enabled || canvas === null || canvas === undefined) return undefined
        let context = null
        try {
          context = canvas.getContext('2d')
        } catch (error) {
          console.warn(LOG, 'canvas 2d unavailable for the energy rail', error)
        }
        if (context === null) return undefined

        const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        let frame = 0
        let width = 0
        let height = 0
        let last = 0
        /** Milliseconds since the level last moved; drives the charging front. */
        let elapsed = 0
        /** Last seen knob position, so a level change replays the front. */
        let settledLimit = -1
        let cells = []
        let cellW = 4
        let cellH = 4

        /** Deterministic per-cell noise, so a cell keeps its identity across frames. */
        const hash = (a, b) => {
          const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
          return value - Math.floor(value)
        }

        const measure = () => {
          const rect = canvas.getBoundingClientRect()
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          width = Math.max(1, Math.round(rect.width))
          height = Math.max(1, Math.round(rect.height))
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          context.setTransform(dpr, 0, 0, dpr, 0, 0)
          // A constant cell size in CSS pixels: the lattice must not reflow when
          // the rail changes width, and the front keeps a pixel speed.
          cellW = 4
          cellH = Math.max(3, height / 6)
          const columns = Math.max(1, Math.round(width / cellW))
          const rows = Math.max(1, Math.round(height / cellH))
          cells = []
          for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
              cells.push({ column, row, random: hash(column + 1, row + 1), level: 0 })
            }
          }
        }
        measure()

        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(canvas)
        }

        const draw = (now) => {
          frame = 0
          const delta = last === 0 ? 16.7 : Math.min(48, now - last)
          last = now
          const look = lookRef.current
          const energy = clamp01(look.energy ?? 0)
          const tint = Array.isArray(look.tint) ? look.tint : [148, 163, 184]
          const knob = Math.min(height, width)
          const limit = limitOf(width, height, look.fillFraction)

          if (burstRef.current) {
            burstRef.current = 0
            elapsed = 0
          }
          if (limit !== settledLimit) {
            settledLimit = limit
            elapsed = 0
          } else if (!reduceMotion) {
            elapsed += delta
          }

          // Retention is the one dial the level turns: a short afterimage while
          // the front passes, long trails that fuse into a sheet at the top.
          const retention = reduceMotion ? 0.92 : 0.18 + energy * 0.72
          const pulse = 0.84 + Math.sin(now / 227) * 0.16
          const frameIndex = Math.floor(now / 125)
          // The settled field reaches much further at the top level, which is what
          // makes Max read as a sustained burn rather than a dot by the knob.
          const tail = Math.max(8, width * (0.10 + 0.30 * energy))
          const seconds = elapsed / 1000

          context.clearRect(0, 0, width, height)

          for (const cell of cells) {
            const x = cell.column * cellW + cellW / 2
            const y = cell.row * cellH + cellH / 2
            let target = 0

            if (x <= limit + 0.5) {
              // The front: each cell starts its own travel when the level moves,
              // so the charge reads as a sweep rather than a wipe.
              const traveled = seconds * 210 * (0.85 + cell.random * 0.30)
              const front = Math.max(limit - traveled, knob * 0.5)
              if (seconds < 1.6 && x >= front) {
                const behind = clamp01((limit - x) / Math.max(limit - front, 1))
                target = Math.pow(1 - behind, 0.65) * Math.min(seconds, 1) * 0.8
              }
              // The settled field: a bright core at the knob plus a warm tail,
              // thinning per frame so it glitters rather than glowing flat.
              const distance = Math.max(limit - x, 0)
              const aura = Math.exp(-Math.pow(distance / tail, 1.35))
              const core = Math.exp(-Math.pow((x - (limit - knob * 0.14)) / Math.max(3, knob * 0.16), 2))
              const glitter = hash(cell.column + frameIndex * 13, cell.row + frameIndex * 29) > 0.58 - energy * 0.22 ? 1 : 0
              const settled = Math.max(core, aura * glitter * 0.72) * (0.58 + cell.random * 0.42) * pulse
              target = Math.max(target, settled * (0.52 + energy * 0.78))
            }

            cell.level = Math.max(target, cell.level * retention)
            if (cell.level <= 0.02) continue

            // Dark scheme: hotter cells bleach toward white, which is what makes
            // the knob end read as white-hot. Light scheme: bleaching would wash
            // the cells out against an already near-white rail, so the tint stays
            // saturated and contrast carries the level instead.
            const heat = darkTheme ? Math.min(1, cell.level * 1.6) * 0.85 : 0
            const contrast = darkTheme ? 1.15 : 1.55
            const channel = (value) => Math.round(value + (255 - value) * heat)
            context.fillStyle = `rgba(${channel(tint[0])},${channel(tint[1])},${channel(tint[2])},${Math.min(1, cell.level * contrast).toFixed(3)})`
            context.fillRect(x - cellW * 0.34, y - cellH * 0.32, cellW * 0.68, cellH * 0.64)
          }

          // Keep burning at the top level and while the front travels; otherwise
          // settle and stop, leaving a static lit field.
          if (!reduceMotion && (energy >= 0.98 || seconds < 1.6)) frame = requestAnimationFrame(draw)
        }

        const start = () => {
          if (frame !== 0) return
          last = 0
          if (reduceMotion) {
            draw(0)
            return
          }
          frame = requestAnimationFrame(draw)
        }
        repaintRef.current = start
        start()

        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          frame = 0
          repaintRef.current = null
          observer?.disconnect()
          cells = []
          context.clearRect(0, 0, width, height)
        }
      }, [canvas, lookRef, repaintRef, burstRef, enabled, darkTheme])
    }

    // ---------------------------------------------------------------------
    // Error boundary: the seat must never throw, or the slot renderer retires
    // it and the shipped selector silently takes the seat back.
    //
    // It must also never be STICKY. A transient render failure — a catalog
    // reloading, a session whose directory is momentarily unresolvable — would
    // otherwise park this fallback in the composer forever, which reads to the
    // user as "the slider worked, then it disappeared".
    // ---------------------------------------------------------------------
    /** Retry backoff, capped; the seat keeps trying for as long as it is mounted. */
    const RETRY_BASE_MS = 1200
    const RETRY_CAP_MS = 10000

    class SeatBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null, attempt: 0 }
        this.timer = null
        this.clearTimer = () => {
          if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
          }
        }
        this.retry = () => {
          this.clearTimer()
          this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
        }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        // Feed the shared diagnostic channel: this is what raises the visible
        // notice and fills window.__dshThinkingSlider for a DevTools read.
        record('seat-render', error)
        console.error(`${LOG} seat render failed; showing the fallback and retrying`, error, info)
        this.clearTimer()
        const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (this.state.attempt + 1))
        this.timer = setTimeout(this.retry, delay)
      }

      componentDidUpdate() {
        // A successful render clears the backoff so a later failure starts fresh.
        if (this.state.error === null && this.state.attempt > 0) this.setState({ attempt: 0 })
      }

      componentWillUnmount() {
        this.clearTimer()
      }

      render() {
        if (this.state.error === null) {
          // Remount the seat on every retry so a stale subtree cannot survive.
          return jsx(Seat, { ...this.props.face, key: `attempt-${this.state.attempt}` })
        }
        return jsxs('div', {
          className: 'tsl-fallback',
          title: String(this.state.error?.message ?? this.state.error),
          children: [
            jsx('span', { children: '模型' }),
            jsx('span', { className: 'tsl-fallbackBadge', children: '推理等级不可用' }),
            jsx('button', {
              type: 'button',
              className: 'tsl-fallbackRetry',
              onClick: () => this.retry(),
              children: '重试',
            }),
          ],
        })
      }
    }

    // ---------------------------------------------------------------------
    // The seat
    // ---------------------------------------------------------------------
    const CHECK_PATH = 'M2.5 8.2 6 11.5 13.5 4'

    /**
     * The one geometry both the fill and the knob use.
     *
     * The knob is a full-height circle, so a stop's position is its CENTRE,
     * inset by half a knob at each end: the first stop sits flush against the
     * left cap and the last flush against the right cap. The fill is given this
     * same expression as its `width`, which is what keeps the coloured rail
     * ending exactly under the knob — two different formulas (a percentage
     * inset versus a pixel inset) drift apart and leave a bare notch of track
     * showing beside the knob.
     *
     * `--tsl-knob` is the single source of the size: the stylesheet sizes the
     * knob and the rail from it, this function places everything by it, and the
     * particle field derives its own limit from the measured canvas height.
     *
     * @param index - stop index.
     * @param count - number of stops.
     * @returns a CSS length usable as `left`, `width`, or a scale-label anchor.
     */
    function centerOf(index, count) {
      const fraction = count <= 1 ? 1 : index / (count - 1)
      return `calc(var(--tsl-knob) / 2 + (100% - var(--tsl-knob)) * ${fraction})`
    }

    /** The same fraction `centerOf` uses, for consumers that need a number. */
    function fractionOf(index, count) {
      return count <= 1 ? 1 : index / (count - 1)
    }

    function Seat(props) {
      const { locked, available, directory, load, select, fillLevels } = props

      const state = react.useSyncExternalStore(
        (subscribe) => directory.subscribe(subscribe),
        () => directory.getSnapshot(),
      )

      const [open, setOpen] = react.useState(false)
      const [pane, setPane] = react.useState('effort')
      const [preview, setPreview] = react.useState(null)
      const [notice, setNotice] = react.useState(null)
      const [placement, setPlacement] = react.useState(null)

      const rootRef = react.useRef(null)
      const cardRef = react.useRef(null)
      const trackRef = react.useRef(null)
      // A callback ref in state, not a ref object: the particle loop must
      // re-bind whenever a canvas is remounted (pane switches).
      const [canvasNode, setCanvasNode] = react.useState(null)
      const lookRef = react.useRef(OFF_LOOK)
      const repaintRef = react.useRef(null)
      /** Non-zero once a commit asks the energy rail for a burst. */
      const burstRef = react.useRef(0)
      const mode = useMode()
      const darkTheme = useDarkTheme()

      /**
       * Load the model directory once per session, not once per render.
       *
       * `load` arrives from the slot entry, which rebuilds it on every render, so
       * depending on it directly made this effect fire on each pass and re-fetch
       * the directory every time the composer re-rendered — invisible in-process,
       * a visible stall on every reasoning-level change where the store is remote.
       * `directory` is the stable per-session identity, so it is the honest
       * dependency; the ref keeps the newest closure without re-triggering.
       */
      const loadRef = react.useRef(load)
      loadRef.current = load
      react.useEffect(() => {
        if (available === true) loadRef.current()
      }, [available, directory])

      const groups = Array.isArray(state?.groups) ? state.groups : []
      const failures = Array.isArray(state?.failures) ? state.failures : []
      const current = state?.current ?? null

      const currentModel = react.useMemo(() => {
        if (current === null) return undefined
        for (const group of groups) {
          if (group?.id !== current.provider) continue
          const models = Array.isArray(group.models) ? group.models : []
          const hit = models.find((model) => model?.id === current.model)
          if (hit !== undefined) return hit
        }
        return undefined
      }, [groups, current])

      const efforts = Array.isArray(currentModel?.reasoning?.efforts) ? currentModel.reasoning.efforts : []
      const supported = efforts.length > 0
      const activeEffort = current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort ?? null
      /**
       * The level the user just committed, shown before the store round-trip
       * lands. Serving the level straight from `activeEffort` means the rail sits
       * on the OLD level until the host answers, which reads as a stall where the
       * store is remote (`dsh web`) even though it is imperceptible in-process.
       */
      const [optimistic, setOptimistic] = react.useState(null)
      react.useEffect(() => {
        if (optimistic === null) return undefined
        if (optimistic === activeEffort) {
          setOptimistic(null)
          return undefined
        }
        // Never mask the real level for long if the write never lands.
        const timer = setTimeout(() => setOptimistic(null), 4000)
        return () => clearTimeout(timer)
      }, [optimistic, activeEffort])
      const shownEffort = preview ?? optimistic ?? activeEffort
      const busy = state?.pending !== null && state?.pending !== undefined
      const inert = locked === true || available !== true || current === null || !supported

      const index = supported ? Math.max(0, efforts.findIndex((level) => level?.id === shownEffort)) : -1
      /** Thinking levels only: `off` is styled apart from the escalation ramp. */
      const positive = react.useMemo(
        () => efforts.filter((level) => level?.id !== 'off'),
        [efforts],
      )
      const isOff = shownEffort === null || shownEffort === undefined || String(shownEffort).toLowerCase() === 'off'
      const positiveIndex = positive.findIndex((level) => level?.id === shownEffort)
      const thinking = !isOff && positive.length > 0 && positiveIndex >= 0
      const rank = positive.length <= 1 ? 1 : Math.max(0, positiveIndex) / (positive.length - 1)
      const look = react.useMemo(() => (thinking ? lookOf(rank) : OFF_LOOK), [thinking, rank])
      const fillFraction = fractionOf(Math.max(0, index), Math.max(1, efforts.length))

      // Publish the look for the animation loop, then nudge a repaint so a
      // change lands even while the browser is throttling frames.
      react.useEffect(() => {
        lookRef.current = { ...look, fillFraction }
        repaintRef.current?.()
      }, [look, fillFraction, lookRef, repaintRef])

      const railLive = open && supported
      useParticles(canvasNode, lookRef, repaintRef, railLive && mode === 'particle')
      useEnergyField(canvasNode, lookRef, repaintRef, burstRef, railLive && mode === 'energy', darkTheme)

      const activeLabel = !supported
        ? state?.retainedEffort ?? '推理等级'
        : isOff
          ? efforts[0]?.name ?? 'Off'
          : efforts[index]?.name ?? String(shownEffort)
      const modelLabel = currentModel?.name ?? (current === null ? '模型' : `${current.provider}/${current.model}`)

      const commit = react.useCallback(
        async (effort) => {
          if (current === null || effort === activeEffort || effort === optimistic) return
          // Show the choice immediately; the effect above drops it once the
          // session reports the new level (or after a timeout).
          setOptimistic(effort)
          try {
            const result = await select({
              provider: current.provider,
              model: current.model,
              ...(effort === null || effort === undefined ? {} : { reasoningEffort: effort }),
            })
            if (result !== undefined && result !== null && result.ok === false) {
              setOptimistic(null)
              setNotice(`${result.error?.code ?? 'error'}: ${result.error?.message ?? '选择失败'}`)
            } else {
              setNotice(null)
              // A committed level releases one burst on the energy rail.
              burstRef.current = Date.now()
              repaintRef.current?.()
            }
          } catch (error) {
            console.error(LOG, 'selection failed', error)
            setOptimistic(null)
            setNotice(String(error?.message ?? error))
          }
        },
        [activeEffort, current, optimistic, select],
      )

      const effortAt = react.useCallback(
        (clientX) => {
          const node = trackRef.current
          if (node === null || node === undefined || efforts.length === 0) return undefined
          const rect = node.getBoundingClientRect()
          if (rect.width <= 0) return undefined
          const ratio = clamp01((clientX - rect.left) / rect.width)
          const scaled = (ratio - 0.06) / 0.88
          const index = Math.round(clamp01(scaled) * (efforts.length - 1))
          return efforts[index]?.id
        },
        [efforts],
      )

      const endDrag = react.useCallback(
        (event) => {
          const next = effortAt(event.clientX)
          setPreview(null)
          if (next !== undefined) void commit(next)
        },
        [commit, effortAt],
      )

      const onKeyDown = (event) => {
        if (inert) return
        const move = (delta) => {
          const from = index < 0 ? 0 : index
          const next = efforts[Math.min(efforts.length - 1, Math.max(0, from + delta))]
          if (next !== undefined) void commit(next.id)
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); move(1) }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); move(-1) }
        else if (event.key === 'Home') { event.preventDefault(); if (efforts[0]) void commit(efforts[0].id) }
        else if (event.key === 'End') { event.preventDefault(); const last = efforts[efforts.length - 1]; if (last) void commit(last.id) }
        else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      }

      // Anchor the card just above the trigger, clamped into the viewport.
      react.useLayoutEffect(() => {
        if (!open) { setPlacement(null); return undefined }
        const place = () => {
          const trigger = rootRef.current?.getBoundingClientRect()
          const card = cardRef.current?.getBoundingClientRect()
          if (trigger === undefined || card === undefined) return
          const margin = 12
          const gap = 10
          const width = card.width || 320
          const left = Math.min(
            Math.max(margin, trigger.right - width),
            Math.max(margin, window.innerWidth - width - margin),
          )
          const bottom = Math.min(
            Math.max(margin, window.innerHeight - trigger.top + gap),
            Math.max(margin, window.innerHeight - card.height - margin),
          )
          setPlacement({ left: Math.round(left), bottom: Math.round(bottom) })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open, pane])

      // Dismiss on outside pointer down / Escape.
      react.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (rootRef.current?.contains(target) === true) return
          if (cardRef.current?.contains(target) === true) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
      }, [open])

      const chooseModel = (group, model) => {
        setNotice(null)
        const effort = model?.reasoning?.defaultEffort
        const same = current !== null && current.provider === group.id && current.model === model.id
        if (!same) {
          void select({
            provider: group.id,
            model: model.id,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          }).then((result) => {
            if (result !== undefined && result !== null && result.ok === false) {
              setNotice(`${result.error?.code ?? 'error'}: ${result.error?.message ?? '选择失败'}`)
            } else {
              setPane('effort')
            }
          }).catch((error) => {
            console.error(LOG, 'model selection failed', error)
            setNotice(String(error?.message ?? error))
          })
        } else {
          setPane('effort')
        }
      }

      const triggerChevron = jsx('svg', {
        className: `tsl-triggerChevron${open ? ' tsl-triggerChevronOpen' : ''}`,
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: jsx('path', {
          d: 'M4 6.5 8 10.5 12 6.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      })

      const trigger = jsxs('button', {
        ref: rootRef,
        type: 'button',
        className: 'tsl-trigger',
        disabled: locked === true || available !== true || current === null,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: supported ? `${modelLabel} · ${activeLabel}` : modelLabel,
        onClick: () => {
          setNotice(null)
          setPane('effort')
          setOpen((value) => !value)
        },
        children: [
          jsx('span', { className: 'tsl-triggerModel', children: modelLabel }),
          supported
            ? jsx('span', { className: 'tsl-triggerDot', children: '·' })
            : null,
          supported
            ? jsx('span', {
                className: 'tsl-triggerLevel',
                style: { color: isOff ? undefined : look.accent },
                children: busy ? '…' : activeLabel,
              })
            : null,
          triggerChevron,
        ],
      })

      if (!open) return jsx('div', { className: 'tsl-root', children: trigger })

      const scale = jsx('div', {
        className: 'tsl-scale',
        children: efforts.map((level, at) => jsx('span', {
          className: 'tsl-scaleItem',
          'data-active': at === index,
          style: {
            left: centerOf(at, efforts.length),
            ...(at === index && !isOff ? { color: look.accent } : {}),
          },
          children: level?.name ?? level?.id,
        }, level?.id ?? at)),
      })

      const track = jsxs('div', {
        ref: trackRef,
        className: 'tsl-trackWrap',
        role: 'slider',
        tabIndex: inert ? -1 : 0,
        'aria-label': '推理强度',
        'aria-valuemin': 0,
        'aria-valuemax': Math.max(0, efforts.length - 1),
        'aria-valuenow': Math.max(0, index),
        'aria-valuetext': activeLabel,
        'aria-disabled': inert,
        'data-inert': inert,
        onPointerDown: (event) => {
          if (inert) return
          event.preventDefault()
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
          const next = effortAt(event.clientX)
          setPreview(next ?? null)
        },
        onPointerMove: (event) => {
          if (inert || event.buttons !== 1) return
          const next = effortAt(event.clientX)
          setPreview(next ?? null)
        },
        onPointerUp: (event) => {
          if (inert) return
          endDrag(event)
        },
        onPointerCancel: () => setPreview(null),
        onKeyDown,
        children: [
          jsxs('div', {
            className: 'tsl-track',
            style: { boxShadow: look.energy > 0.02 ? `0 0 14px ${look.glow}` : undefined },
            children: [
              jsx('div', {
                className: 'tsl-fill',
                style: {
                  width: centerOf(Math.max(0, index), Math.max(1, efforts.length)),
                  background: look.gradient,
                  // The energy rail is a dot lattice over a DARK track, so its
                  // gradient fill is suppressed and the canvas carries the colour.
                  opacity: mode === 'energy' ? 0 : isOff ? 0.45 : 1,
                },
              }),
              jsx('canvas', { ref: setCanvasNode, className: 'tsl-canvas' }),
              jsx('div', {
                className: 'tsl-ticks',
                style: { color: isOff ? 'var(--dsw-alias-label-caption)' : '#fff' },
                children: efforts.map((level, at) => jsx('span', {
                  className: 'tsl-tick',
                  style: { left: centerOf(at, efforts.length) },
                }, `tick-${level?.id ?? at}`)),
              }),
              jsx('div', {
                className: 'tsl-thumb',
                style: {
                  left: centerOf(Math.max(0, index), Math.max(1, efforts.length)),
                  boxShadow: `0 1px 4px rgba(0,0,0,.32)${look.energy > 0.02 ? `, 0 0 12px ${look.glow}` : ''}`,
                },
              }),
            ],
          }),
        ],
      })

      // The card's empty state is exactly where someone looks when a model offers
      // no levels, so the fix belongs here too, not only in Settings.
      const fillable = typeof fillLevels === 'function' && current !== null
      const fillHere = () => {
        if (!fillable) return
        const outcome = fillLevels(current.provider)
        if (outcome?.ok === false) setNotice(outcome.message)
        else if (outcome?.count === 0) setNotice('这个代理商已经声明过等级了，重开卡片即可看到')
        else setNotice('已写入等级的映射，关掉卡片重开即可看到（若该网关不接受 reasoning_effort，会让它的请求失败）')
        if (outcome?.ok && outcome.pending !== undefined) {
          outcome.pending.then((settled) => {
            if (!settled.ok) setNotice(settled.message)
          })
        }
      }

      const effortPane = jsxs('div', {
        children: [
          jsxs('div', {
            className: 'tsl-head',
            children: [
              jsx('span', {
                className: 'tsl-level',
                style: { color: isOff ? undefined : look.accent },
                children: busy ? '…' : activeLabel,
              }),
              activeEffort !== null && activeEffort !== undefined
                ? jsx('button', {
                    type: 'button',
                    className: 'tsl-reset',
                    title: '回到 Default',
                    'aria-label': '回到 Default',
                    onClick: () => {
                      if (current === null) return
                      void select({ provider: current.provider, model: current.model })
                    },
                    children: jsx('svg', {
                      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                      children: jsx('path', {
                        d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10',
                        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
                      }),
                    }),
                  })
                : null,
            ],
          }),
          jsxs('button', {
            type: 'button',
            className: 'tsl-modelRow',
            disabled: current === null,
            onClick: () => setPane('model'),
            children: [
              jsx('span', { className: 'tsl-modelName', children: modelLabel }),
              jsx('svg', {
                width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                children: jsx('path', {
                  d: 'M6 3.5 10.5 8 6 12.5',
                  stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
                }),
              }),
            ],
          }),
          supported
            ? track
            : jsxs('div', {
                className: 'tsl-empty',
                children: [
                  jsx('span', { children: '这个模型没有提供推理等级' }),
                  fillable
                    ? jsx('button', {
                        type: 'button',
                        className: 'tsl-fillApply',
                        title: LEVELS_HINT_LONG,
                        onClick: fillHere,
                        children: `给 ${current.provider} 补四档`,
                      })
                    : null,
                ],
              }),
          supported ? scale : null,
          notice !== null ? jsx('div', { className: 'tsl-failure', children: notice }) : null,
        ],
      })

      const modelPane = jsxs('div', {
        children: [
          jsxs('div', {
            className: 'tsl-head',
            children: [
              jsx('button', {
                type: 'button',
                className: 'tsl-reset',
                style: { left: -2, right: 'auto' },
                title: '返回推理强度',
                'aria-label': '返回推理强度',
                onClick: () => setPane('effort'),
                children: jsx('svg', {
                  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                  children: jsx('path', {
                    d: 'M10 3.5 5.5 8 10 12.5',
                    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
                  }),
                }),
              }),
              jsx('span', { className: 'tsl-level', style: { fontSize: 15 }, children: '选择模型' }),
            ],
          }),
          jsx('div', { style: { height: 10 } }),
          jsxs('div', {
            className: 'tsl-list',
            role: 'listbox',
            children: [
              groups.length === 0 ? jsx('div', { className: 'tsl-empty', children: '正在加载模型目录…' }) : null,
              ...groups.map((group) => {
                const models = Array.isArray(group?.models) ? group.models : []
                return jsxs('div', {
                  children: [
                    jsx('div', { className: 'tsl-group', children: group?.name ?? group?.id }),
                    ...models.map((model) => {
                      const selected = current !== null && current.provider === group.id && current.model === model?.id
                      const levels = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []
                      const ramp = rampOf(levels)
                      const names = levels.map((level) => level?.name ?? level?.id).join(' · ')
                      return jsxs('button', {
                        type: 'button',
                        role: 'option',
                        'aria-selected': selected,
                        className: 'tsl-item',
                        'data-active': selected,
                        title: levels.length > 0 ? `推理等级：${names}` : '这个模型没有推理等级',
                        onClick: () => chooseModel(group, model),
                        children: [
                          jsx('span', { className: 'tsl-itemText', children: model?.name ?? model?.id }),
                          jsx('span', {
                            className: 'tsl-itemMeta',
                            'aria-hidden': true,
                            children: levels.length > 0
                              ? jsx('span', {
                                  className: 'tsl-ramp',
                                  children: levels.map((level, at) => jsx('i', {
                                    className: 'tsl-rampDot',
                                    style: { background: ramp[at] },
                                  }, `dot-${level?.id ?? at}`)),
                                })
                              : jsx('span', { className: 'tsl-rampNone', children: '—' }),
                          }),
                          selected
                            ? jsx('svg', {
                                className: 'tsl-check', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
                                children: jsx('path', {
                                  d: CHECK_PATH, stroke: 'currentColor', strokeWidth: 1.8,
                                  strokeLinecap: 'round', strokeLinejoin: 'round',
                                }),
                              })
                            : null,
                        ],
                      }, `${group.id}/${model?.id}`)
                    }),
                  ],
                }, group?.id)
              }),
              ...failures.map((failure) => jsx('div', {
                className: 'tsl-failure',
                children: `${failure?.name ?? failure?.id}: ${failure?.message ?? '加载失败'}`,
              }, `failure/${failure?.id}`)),
              notice !== null ? jsx('div', { className: 'tsl-failure', children: notice }) : null,
            ],
          }),
        ],
      })

      const card = jsx('div', {
        ref: cardRef,
        className: 'tsl-card',
        role: 'dialog',
        'aria-label': '模型与推理强度',
        style: placement === null ? { left: 0, bottom: 0, visibility: 'hidden' } : placement,
        children: pane === 'model' ? modelPane : effortPane,
      })

      const portal = typeof document === 'undefined'
        ? card
        : createPortal(card, document.body)

      return jsxs('div', { className: 'tsl-root', children: [trigger, portal] })
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------
    /**
     * Services this plugin needs.
     *
     * `remote` and `remote.session` are not used directly — they are required
     * because `ctx.modelDirectories` hands back a cordis *traceable* proxy whose
     * `.ctx` is rebound to the ACCESSING context. `directoryFor()` then reads
     * `this.ctx.remote.session` against this plugin's context, so the dependency
     * must be declared here or cordis throws
     * `cannot get property "remote.session" without inject`. The shipped
     * ui-model-selection plugin declares the same pair for the same reason.
     */
    const inject = ['slots', 'sessions', 'remote', 'remote.session']

    /** The composer seat this plugin shadows. */
    const SLOT = 'conversation.input.model'
    /** Register just below the shipped selector: the lowest priority renders. */
    const BASE_PRIORITY = -1
    /**
     * Priority slots this plugin will retreat through before giving up.
     *
     * The Host hot-reloads a client bundle whenever its file changes, and a
     * `single` slot REFUSES a second registration at an occupied priority. A
     * generation whose predecessor was not disposed therefore cannot register
     * at all, `apply()` fails, and the seat silently reverts to the shipped
     * selector until a full page reload — the "it loaded, then it vanished"
     * failure. Retreating to a lower priority always still shadows the shipped
     * seat (lowest renders), so a leaked generation is inert instead of fatal.
     */
    const MAX_GENERATIONS = 24
    /** Abdication recoveries allowed per plugin load, so a hard crash cannot spin. */
    const MAX_RECOVERIES = 3
    /** Diagnostics retained for DevTools inspection. */
    const diagnostics = []
    const record = (phase, error) => {
      const entry = {
        at: new Date().toISOString(),
        phase,
        message: String(error?.message ?? error),
        stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : undefined,
      }
      diagnostics.push(entry)
      if (diagnostics.length > 20) diagnostics.shift()
      console.error(`${LOG} ${phase} failed`, error)
      publishDiagnostics()
      showNotice(entry)
      return entry
    }
    /** Expose the log where a DevTools one-liner can read it. */
    const publishDiagnostics = () => {
      try {
        globalThis.__dshThinkingSlider = { diagnostics, plugin: 'dsh-thinking-slider' }
      } catch {}
    }
    /** One visible, dismissible notice per page load: an invisible failure is unfixable. */
    let noticeShown = false
    const showNotice = (entry) => {
      if (noticeShown || typeof document === 'undefined' || document.body === null) return
      noticeShown = true
      try {
        const box = document.createElement('div')
        box.setAttribute('data-plugin', 'dsh-thinking-slider')
        box.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
          'max-width:420px', 'padding:10px 12px', 'border-radius:10px',
          'background:#3a1d1d', 'color:#ffd7d7', 'font:12px/18px ui-monospace,monospace',
          'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'white-space:pre-wrap',
        ].join(';')
        box.textContent = `dsh-thinking-slider ${entry.phase} 失败：\n${entry.message}\n\n`
          + '每页只弹第一条错误；其余（含更早的）都在 __dshThinkingSlider.diagnostics 里，\n'
          + 'Console 里跑 copy(JSON.stringify(__dshThinkingSlider, null, 2)) 即可取到。\n'
          + '（截图给我即可定位；点此关闭）'
        box.addEventListener('click', () => box.remove())
        document.body.appendChild(box)
      } catch {}
    }

    /**
     * The Settings → General row that picks the rail mode.
     *
     * Reads the module-level mode store directly, so it needs neither a Host
     * Config namespace nor a slot store: `settings.general.item` renders every
     * registration unconditionally.
     */
    function ModeRow() {
      const mode = useMode()
      return jsxs('div', {
        className: 'tsl-setting',
        children: [
          jsxs('div', {
            className: 'tsl-settingText',
            children: [
              jsx('span', { className: 'tsl-settingTitle', children: '推理滑块' }),
              jsx('span', { className: 'tsl-settingHint', children: MODE_HINTS[mode] ?? MODE_HINTS.particle }),
            ],
          }),
          jsx('div', {
            className: 'tsl-seg',
            role: 'radiogroup',
            'aria-label': '推理滑块模式',
            children: MODES.map((id) => jsx('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': mode === id,
              'data-active': mode === id,
              className: 'tsl-segChoice',
              title: MODE_HINTS[id],
              onClick: () => setMode(id),
              children: MODE_LABELS[id],
            }, id)),
          }),
        ],
      })
    }

    /** Tooltip for the per-provider fill buttons. */
    const LEVELS_HINT_LONG = '给这个代理商里没有声明推理等级的模型补上 Off/Low/High/Max，'
      + '写入 llm-pi-ai 配置（与「设置 → 模型」同一份），宿主下一个请求即生效，不用重启。'
      + '若该网关不接受 reasoning_effort，会让它的请求失败 —— 所以逐个确认，不要一次全补。'

    /**
     * The Settings → General row that fills reasoning levels in per provider.
     *
     * Reads and writes `llm-pi-ai`'s config through the settings transport, so the
     * change lands in the same document the Models page edits.
     */
    function LevelsRow(props) {
      const target = props.target
      const form = target.form()
      const snapshot = react.useSyncExternalStore(
        (listener) => target.form().subscribe(listener),
        () => target.form().getSnapshot(),
      )
      const [failure, setFailure] = react.useState(null)
      const missing = providersMissingLevels(snapshot?.value)
      const total = missing.reduce((sum, entry) => sum + entry.count, 0)

      const apply = (route) => {
        const outcome = fillProviderLevels(target, route)
        setFailure(outcome.ok ? null : outcome.message)
        if (outcome.ok && outcome.pending !== undefined) {
          outcome.pending.then((settled) => {
            if (!settled.ok) setFailure(settled.message)
          })
        }
      }

      return jsxs('div', {
        className: 'tsl-setting',
        children: [
          jsxs('div', {
            className: 'tsl-settingText',
            children: [
              jsx('span', { className: 'tsl-settingTitle', children: '模型推理等级' }),
              jsx('span', {
                className: 'tsl-settingHint',
                children: failure !== null
                  ? `写入失败：${failure}`
                  : missing.length === 0
                    ? '所有模型都已声明等级'
                    : `${missing.length} 个代理商共 ${total} 个模型没有等级`,
              }),
            ],
          }),
          jsx('div', {
            className: 'tsl-fills',
            children: missing.map(({ route, count }) => jsxs('span', {
              className: 'tsl-fillChip',
              children: [
                jsx('span', { children: `${route} · ${count}` }),
                jsx('button', {
                  type: 'button',
                  className: 'tsl-fillApply',
                  title: LEVELS_HINT_LONG,
                  onClick: () => apply(route),
                  children: '补四档',
                }),
              ],
            }, route)),
          }),
        ],
      })
    }

    function apply(ctx) {
      try {
        /**
         * The `llm-pi-ai` config form, once the settings transport provides it.
         *
         * Declared here, in `apply`'s scope: both the settings row and the card's
         * fill button read it, and a nested declaration would leave the card
         * looking at a different variable that never gets assigned.
         */
        let levelsForm = null

        // The mode row lives in Settings → General, independent of whether the
        // composer seat has a place to mount.
        try {
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              { name: 'settings.general.item', id: 'thinking-slider-mode', order: 12 },
              ModeRow,
            ),
          )
        } catch (error) {
          record('settings-row', error)
        }

        // The level-filling row needs the settings transport to read and write
        // `llm-pi-ai`'s config. Declared as a derived scope so a composition
        // without it loses only this row (and the card's fill button), not the
        // whole plugin.
        try {
          ctx.inject(['configForms'], (scope) => {
            const forms = scope.configForms
            /**
             * Namespaces the Host actually serves.
             *
             * The settings namespace of a bundle-inserted row is its entry id
             * (`include:llm-pi-ai`), which is NOT the patch id in the profile, so
             * it has to be discovered rather than hardcoded.
             */
            const namespaces = () => {
              try {
                const view = forms.describe().getSnapshot().view
                return (view?.namespaces ?? [])
                  .map((entry) => entry?.ns)
                  .filter((ns) => typeof ns === 'string')
              } catch {
                return []
              }
            }
            const namespace = () => {
              const served = namespaces()
              return served.find((ns) => ns === LLM_NAMESPACE)
                ?? served.find((ns) => /llm-pi-ai/i.test(ns))
                ?? LLM_NAMESPACE
            }
            let resolved = null
            const target = {
              namespace,
              namespaces,
              form: () => {
                if (resolved === null) resolved = forms.get(namespace())
                return resolved
              },
            }
            levelsForm = target
            return ctx.slots.inject('settings.general.item', () =>
              ctx.slots.register(
                {
                  name: 'settings.general.item',
                  id: 'thinking-slider-levels',
                  order: 13,
                  inject: () => ({ target }),
                },
                LevelsRow,
              ),
            )
          })
        } catch (error) {
          record('settings-levels', error)
        }

        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          const slots = scope.slots
          const sessions = scope.sessions
          const models = scope.modelDirectories

          let recoveries = 0
          let handle = null
          let stopped = false
          /**
           * Whether the seat's slot currently has a live declaration.
           *
           * `conversation.input.model` is declared by ui-conversation's composer
           * bar, NOT by this plugin, and the two plugins' `apply()` order is not
           * guaranteed. Registering while it is undeclared throws
           * `slot "..." is not declared`, so registration is gated on this flag
           * rather than merely on the mode: a profile that applies this plugin
           * first must not be able to reach `register()` at all.
           */
          let declared = false

          /**
           * The per-session face handed to the seat.
           *
           * This runs OUTSIDE the seat's React error boundary, so a throw here
           * retires the slot entry outright — the seat would disappear with no
           * fallback at all. The directory genuinely throws for a session whose
           * scope or binding is not resolvable yet, so degrade instead.
           */
          const face = (sessionId) => {
            try {
              const directory = models.directoryFor(sessionId)
              const available = sessions.subagentAddress(sessionId) === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => {})
                },
                select: (selection) => (available ? directory.select(selection) : Promise.resolve(undefined)),
                // Lets the card off the missing levels right where the user is
                // looking, instead of only from Settings.
                fillLevels: levelsForm === null ? undefined : (route) => fillProviderLevels(levelsForm, route),
              }
            } catch (error) {
              record('inject', error)
              return {
                available: false,
                directory: undefined,
                load: () => {},
                select: () => Promise.resolve(undefined),
              }
            }
          }

          /**
           * Claim the lowest free priority at or below the base.
           *
           * The walk restarts from the base on every call — deliberately NOT a
           * shared counter. Disposing our own registration frees its priority, so
           * a counter would march the seat down one step per remount (mode
           * switches, hot reloads) and eventually exhaust the budget, at which
           * point the seat would silently vanish. Only a priority still held by a
           * genuinely leaked predecessor makes the walk step down.
           */
          const register = () => {
            for (let attempt = 0; attempt < MAX_GENERATIONS; attempt += 1) {
              try {
                handle = slots.register(
                  { name: SLOT, priority: BASE_PRIORITY - attempt, inject: face },
                  (props) => jsx(SeatBoundary, { face: props }),
                )
                return handle
              } catch (error) {
                if (!/already has a registration/.test(String(error?.message ?? ''))) {
                  record('register', error)
                  throw error
                }
                // A predecessor leaked its registration; step down and retry.
              }
            }
            record('register', new Error(`no free priority after ${MAX_GENERATIONS} attempts`))
            return null
          }

          const mountSeat = () => {
            if (stopped || handle !== null || !declared) return handle
            if (getMode() === 'official') return null
            handle = register()
            return handle
          }

          const unmountSeat = () => {
            if (handle === null) return
            try {
              handle()
            } catch {}
            handle = null
          }

          /** Put the seat back after the renderer retired it for a crash. */
          const recover = (error) => {
            record('entry-error', error)
            if (stopped || recoveries >= MAX_RECOVERIES) return
            recoveries += 1
            unmountSeat()
            mountSeat()
          }

          const stopErrors = typeof slots.onEntryError === 'function'
            ? slots.onEntryError((key, _entry, error, info) => {
                if (key !== SLOT || info?.abdicated !== true) return
                if (getMode() === 'official') return
                recover(error)
              })
            : undefined

          /**
           * Mount or unmount the seat to match the current mode.
           *
           * `official` hands the composer back to the shipped selector by simply
           * not registering: an absent entry lets the lower-priority shipped one
           * render, which is why no placeholder is needed. Re-registering after
           * a mode switch reuses the freed base priority.
           */
          const syncMode = () => {
            if (stopped) return
            if (getMode() === 'official') unmountSeat()
            else mountSeat()
          }

          const stopMode = subscribeMode(syncMode)

          /**
           * The one path that can turn registration on.
           *
           * SlotService.inject runs its callback synchronously when the
           * declaration already exists, and again for every later declaration
           * lifetime (collapse disposes it first). Both the first arrival and a
           * re-declaration therefore land here, and both respect the mode.
           */
          const stopInject = slots.inject(SLOT, () => {
            declared = true
            syncMode()
            return () => {
              declared = false
              unmountSeat()
            }
          })

          // Owned by THIS plugin's fiber, so a hot reload disposes the seat
          // instead of leaving a registration that blocks the next generation.
          return () => {
            stopped = true
            try { stopMode() } catch {}
            try { stopInject?.() } catch {}
            try { stopErrors?.() } catch {}
            try { handle?.() } catch {}
            handle = null
          }
        })
      } catch (error) {
        // apply() must never throw: a throwing plugin body takes the seat away
        // with no fallback and no diagnostic.
        record('apply', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
