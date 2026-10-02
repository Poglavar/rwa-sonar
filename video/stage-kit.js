/**
 * Shared cast and timing kit for the RWA Sonar explainer shorts: SVG builders (the header wordmark, John, the
 * dolphin guide, HTML "site panels" and boxes inside foreignObject, captions, end card) and pure timing helpers.
 * A short's scene file calls Kit.run(k => renderAt) and poses everything from time t alone, so any frame renders
 * the same every time. Layout zones (1080×1920): header 40–150, main 180–1300, caption 1330–1530, cast 1560–1900.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.getElementById('stage')
  const C = { ink: '#17151d', muted: '#67636f', paper: '#f7f5f0', panel: '#fffdf8', line: '#d8d3c8', blue: '#3154d8', blueDark: '#203a9f', blueSoft: '#e7ebff', coral: '#dd625b', accent: '#a73532', green: '#27735b', skin: '#f3d2b5', hair: '#4a3222' }

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
  const lerp = (a, b, p) => a + (b - a) * p
  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)
  const easeOut = (p) => 1 - Math.pow(1 - p, 3)
  const easeOutBack = (p) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2) }
  const pop = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : easeOutBack(p))

  const el = (tag, attrs = {}, parent = svg) => {
    const node = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    parent.appendChild(node)
    return node
  }
  const group = (id, parent = svg) => el('g', id ? { id } : {}, parent)
  const text = (parent, x, y, content, size, fill = C.ink, anchor = 'middle', weight = 800, family) => {
    const node = el('text', { x, y, 'font-size': size, fill, 'text-anchor': anchor, 'font-weight': weight, ...(family ? { 'font-family': family } : {}) }, parent)
    node.textContent = content
    return node
  }
  const pose = (node, { x = 0, y = 0, s = 1, o = 1, r = 0 } = {}) => {
    node.setAttribute('transform', `translate(${x} ${y}) rotate(${r}) scale(${Math.max(0, s)})`)
    node.setAttribute('opacity', clamp(o))
  }

  // Images must be decoded before a frame is captured; render.mjs waits for window.stageReady.
  const pending = []
  const image = (parent, href, w, h) => {
    const node = el('image', { href, x: -w / 2, y: -h / 2, width: w, height: h }, parent)
    pending.push(new Promise((resolve, reject) => { node.addEventListener('load', resolve); node.addEventListener('error', () => reject(new Error(`image failed: ${href}`))) }))
    return node
  }

  /** An HTML block drawn centred on (0, 0) of its own group; pose the group to place and animate it. */
  function item(w, h, html, cls = 'box', parent = svg) {
    const g = group('', parent)
    const fo = el('foreignObject', { x: -w / 2, y: -h / 2, width: w, height: h }, g)
    const div = document.createElement('div')
    div.className = cls
    div.innerHTML = html
    fo.appendChild(div)
    g.setAttribute('opacity', 0)
    return Object.assign(g, { div })
  }
  /** A stylised rwasonar.com page: browser bar with the path, then the body HTML. */
  const panel = (w, h, path, body, parent = svg) => item(w, h, `<div class="bar"><i></i><i></i><i></i><span>rwasonar.com/${path}</span></div><div class="body">${body}</div>`, 'panel', parent)

  function sonarMark(parent, x, y, s = 1) {
    const g = group('', parent)
    g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`)
    el('path', { d: 'M 0 0 L 30 -12 A 32 32 0 0 1 30 12 Z', fill: C.blue, opacity: 0.22 }, g)
    el('circle', { cx: 0, cy: 0, r: 32, fill: 'none', stroke: C.blue, 'stroke-width': 4 }, g)
    el('circle', { cx: 0, cy: 0, r: 19, fill: 'none', stroke: C.blue, 'stroke-width': 2, opacity: 0.45 }, g)
    el('circle', { cx: 17, cy: -9, r: 6, fill: C.coral }, g)
    return g
  }

  function background() {
    el('rect', { x: 0, y: 0, width: 1080, height: 1920, fill: C.paper })
    const rings = group('rings')
    for (const r of [220, 380, 540, 700]) el('circle', { cx: 940, cy: 110, r, fill: 'none', stroke: C.blue, 'stroke-width': 3, opacity: 0.07 }, rings)
    const header = group('header')
    el('rect', { x: 330, y: 48, width: 420, height: 92, rx: 46, fill: '#fff', stroke: C.line, 'stroke-width': 3 }, header)
    sonarMark(header, 402, 94, 1.05)
    text(header, 458, 110, 'RWA Sonar', 46, C.ink, 'start', 800)
    return { rings }
  }

  /** John, the fictional retail investor. setMood('smile' | 'worried' | 'awake'). */
  function john(id = 'john') {
    const g = group(id)
    el('ellipse', { cx: 0, cy: 190, rx: 90, ry: 16, fill: 'rgba(23,21,29,0.10)' }, g)
    el('rect', { x: -74, y: -20, width: 148, height: 200, rx: 58, fill: C.blue, stroke: C.ink, 'stroke-width': 6 }, g)
    el('path', { d: 'M -30 -20 L 0 20 L 30 -20', fill: '#fff', stroke: C.ink, 'stroke-width': 5, 'stroke-linejoin': 'round' }, g)
    el('circle', { cx: 0, cy: -95, r: 66, fill: C.skin, stroke: C.ink, 'stroke-width': 6 }, g)
    el('path', { d: 'M -66 -110 Q -60 -175 0 -168 Q 62 -175 66 -110 Q 40 -140 -10 -132 Q -45 -128 -66 -110 Z', fill: C.hair, stroke: C.ink, 'stroke-width': 5 }, g)
    const eyes = group('', g)
    el('circle', { cx: -22, cy: -98, r: 7, fill: C.ink }, eyes)
    el('circle', { cx: 22, cy: -98, r: 7, fill: C.ink }, eyes)
    const wide = group('', g)
    for (const x of [-22, 22]) { el('circle', { cx: x, cy: -100, r: 13, fill: '#fff', stroke: C.ink, 'stroke-width': 4 }, wide); el('circle', { cx: x, cy: -98, r: 5, fill: C.ink }, wide) }
    const mouths = {
      smile: el('path', { d: 'M -22 -68 Q 0 -50 22 -68', fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, g),
      worried: el('path', { d: 'M -20 -58 Q 0 -72 20 -58', fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, g),
      awake: el('ellipse', { cx: 0, cy: -62, rx: 9, ry: 7, fill: C.ink }, g),
    }
    el('rect', { x: -78, y: 206, width: 156, height: 56, rx: 28, fill: '#fff', stroke: C.ink, 'stroke-width': 4 }, g)
    text(g, 0, 246, 'John', 34)
    g.setMood = (mood) => {
      for (const [k, m] of Object.entries(mouths)) m.setAttribute('opacity', k === mood ? 1 : 0)
      eyes.setAttribute('opacity', mood === 'awake' ? 0 : 1)
      wide.setAttribute('opacity', mood === 'awake' ? 1 : 0)
    }
    g.setMood('smile')
    return g
  }

  /** The site's dolphin detective (a transparent cut-out from images/dolphin-detectives/). */
  function dolphin(which = 'scout') {
    const g = group('dolphin')
    if (which === 'patrol') image(g, '../images/dolphin-detectives/patrol-v1-256.webp', 256, 256)
    else image(g, '../images/dolphin-detectives/scout-v1-384.webp', 384, 256)
    return g
  }

  /** A thought/speech bubble centred on (0, 0) with a tail pointing down-left. */
  function bubble(w, h, html) {
    const g = group('')
    el('path', { d: `M ${-w / 2 + 70} ${h / 2 - 4} L ${-w / 2 + 40} ${h / 2 + 50} L ${-w / 2 + 120} ${h / 2 - 4} Z`, fill: '#fff', stroke: C.ink, 'stroke-width': 5, 'stroke-linejoin': 'round' }, g)
    const box = item(w, h, html, 'box center', g)
    box.setAttribute('opacity', 1)
    box.div.style.borderColor = C.ink
    box.div.style.borderWidth = '5px'
    box.div.style.borderRadius = '40px'
    g.setAttribute('opacity', 0)
    return g
  }

  function caption() {
    const fo = el('foreignObject', { x: 50, y: 1330, width: 980, height: 200 })
    const div = document.createElement('div')
    div.className = 'caption'
    fo.appendChild(div)
    return { fo, div }
  }

  /** End card drawn around (0, 0): pose it at (540, 680). */
  function endCard(lines) {
    const outer = group('outro')
    const g = group('', outer)
    g.setAttribute('transform', 'translate(-540 -680)')
    el('rect', { x: 110, y: 330, width: 860, height: 700, rx: 60, fill: '#fff', stroke: C.line, 'stroke-width': 4 }, g)
    sonarMark(g, 540, 480, 2.4)
    text(g, 540, 660, 'RWA Sonar', 96, C.ink, 'middle', 800)
    lines.forEach((line, i) => text(g, 540, 750 + i * 62, line, 44, C.muted, 'middle', 600))
    el('rect', { x: 240, y: 860, width: 600, height: 110, rx: 55, fill: C.blue }, g)
    text(g, 540, 933, 'rwasonar.com', 58, '#fff', 'middle', 800)
    outer.setAttribute('opacity', 0)
    return outer
  }

  /** Timing for one render call. Scenes are addressed by id; fractions are of that scene's duration. */
  function clock(timeline, t) {
    const scene = (id) => timeline.scenes.find((s) => s.id === id) || { start: Infinity, duration: 1 }
    const P = (id, a, b) => { const s = scene(id); return clamp((t - s.start - a * s.duration) / ((b - a) * s.duration)) }
    const after = (id, frac = 0) => { const s = scene(id); return t >= s.start + frac * s.duration }
    const at = (id, frac = 0) => scene(id).start + frac * scene(id).duration
    const current = (timeline.scenes.find((s) => t >= s.start && t < s.start + s.duration) || timeline.scenes[timeline.scenes.length - 1] || {}).id
    /**
     * Pops `node` in at fraction `a` of scene `id` (0.4 s), keeps it until the end of scene `until` (default: the same
     * scene), then shrinks it away over the last 0.3 s. Returns the visibility 0..1.
     */
    const stage = (node, [id, a], until, pos = {}) => {
      const start = at(id, a)
      const end = at(until || id, 1)
      const pin = clamp((t - start) / 0.4)
      const last = end >= timeline.total - 1e-6
      const pout = last ? 0 : clamp((t - (end - 0.3)) / 0.3)
      const v = t < start || (t >= end && !last) ? 0 : pop(pin) * (1 - easeInOut(pout))
      pose(node, { ...pos, s: (pos.s ?? 1) * v, o: v > 0 ? 1 : 0 })
      return v
    }
    /** Fraction of scene `id` at which its n-th caption sentence starts (plus `offset` seconds): syncs visuals to words. */
    const cue = (id, n, offset = 0) => {
      const sentence = (timeline.captions || []).filter((c) => c.scene === id)[n]
      if (!sentence) throw new Error(`no caption ${n} in scene ${id}`)
      return (sentence.start + offset - scene(id).start) / scene(id).duration
    }
    const setCaption = (cap) => {
      const cur = timeline.captions?.find((c) => t >= c.start && t < c.end)
      cap.div.textContent = cur ? cur.text : ''
      // long sentences step down in size so they always fit three lines
      cap.div.style.fontSize = !cur ? '' : cur.text.length > 125 ? '37px' : cur.text.length > 95 ? '41px' : ''
      cap.fo.setAttribute('opacity', cur ? 1 : 0)
    }
    return { t, P, after, at, current, stage, cue, setCaption }
  }

  let timeline = { scenes: [], captions: [], total: 0 }
  window.setTimeline = (tl) => { timeline = tl }
  window.Kit = {
    C, clamp, lerp, easeInOut, easeOut, pop, el, group, text, pose, image, item, panel, sonarMark,
    background, john, dolphin, bubble, caption, endCard,
    /** A scene file registers its per-frame function; render.mjs calls window.renderAt(t) once stageReady is true. */
    run(build) {
      let frame
      try { frame = build(window.Kit) } catch (error) { window.stageError = `scene build failed: ${error.stack || error}`; throw error }
      window.renderAt = (t) => frame(clock(timeline, t))
      Promise.all([...pending, document.fonts.ready]).then(() => { window.stageReady = true }, (error) => { window.stageError = String(error) })
    },
  }
})()
