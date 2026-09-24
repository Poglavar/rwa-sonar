// Scenes for "Caught: the terms changed": John holds a fictional issuer's token, the site re-reads every cited
// document daily and checks each quote word for word, the issuer edits its terms one Tuesday night, the next read
// catches it (change journal card, before/after dated, model-rated holder impact), the hourly key read flags a
// freeze key moving from a 3-of-5 multisig to one key, and both changes land in John's Telegram digest.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pop, pose, item, panel, el, group, C } = k

  const grey = (w) => `<div style="height:22px;border-radius:11px;background:#ebe8e1;width:${w}%;margin:16px 0"></div>`
  const row = (left, right) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:16px">${left}${right}</div>`

  /** The issuer's terms page (not a site panel): the fee line and the new clause are toggled per frame. */
  function termsPage(w, h) {
    const node = item(w, h, `
      <span style="font:500 66px/1.1 Georgia,serif;letter-spacing:-0.02em">Oakmere Terms</span>
      <small style="font-size:32px">Section 5 · Redemptions</small>
      ${grey(94)}${grey(82)}
      <div style="font-size:50px;font-weight:800;margin:8px 0">Redemption fee: <span class="old" style="padding:0 8px;border-radius:10px">0.25%</span> <span class="new" style="color:var(--accent);opacity:0">2%</span> <span class="pen" style="display:inline-block;opacity:0;font-size:64px">✏️</span></div>
      ${grey(90)}
      <div class="added" style="font-size:46px;font-weight:800;line-height:1.22;padding:16px 20px;border-radius:16px;background:#fff3b0;opacity:0;display:flex;gap:16px;align-items:flex-start"><span class="badge bad" style="flex:none;font-size:30px;margin-top:6px">New</span><span>Oakmere may suspend redemptions at its discretion.</span></div>
      ${grey(88)}${grey(64)}`, 'box')
    node.div.style.justifyContent = 'flex-start'
    node.div.style.padding = '34px 40px'
    const q = (s) => node.div.querySelector(s)
    return Object.assign(node, { old: q('.old'), fresh: q('.new'), pen: q('.pen'), added: q('.added') })
  }

  // intro: John, his token, and the terms he read when he bought
  const coin = group('coin')
  el('circle', { cx: 0, cy: 0, r: 70, fill: C.blue, stroke: C.ink, 'stroke-width': 6 }, coin)
  el('circle', { cx: 0, cy: 0, r: 54, fill: 'none', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 4 }, coin)
  k.text(coin, 0, 14, 'AAPL', 34, '#fff')
  const coinTag = item(300, 64, 'AAPL · Oakmere', 'chip')
  coinTag.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;padding:0'
  const introTerms = termsPage(940, 800)
  const readTag = item(560, 76, '<span class="badge good" style="font-size:32px;white-space:nowrap">✓ Read when bought · 2 Sep</span>', 'box center')
  readTag.div.style.cssText += ';border:0;background:transparent;padding:0'

  // reread: the cited documents, re-read daily, and each quote checked word for word
  const DOCS = ['Terms', 'Prospectus', 'Docs page']
  const docs = DOCS.map((title) => {
    const g = group('')
    el('rect', { x: -145, y: -180, width: 290, height: 360, rx: 18, fill: '#fff', stroke: C.line, 'stroke-width': 4 }, g)
    el('path', { d: 'M 95 -180 L 145 -130 L 95 -130 Z', fill: '#efece5', stroke: C.line, 'stroke-width': 4 }, g)
    k.text(g, -115, -128, 'Oakmere', 26, C.muted, 'start', 700)
    k.text(g, -115, -86, title, 36, C.ink, 'start', 800)
    for (const [y, w] of [[-40, 220], [-6, 200], [28, 230], [62, 170], [96, 215], [130, 140]]) el('rect', { x: -115, y, width: w, height: 16, rx: 8, fill: '#ebe8e1' }, g)
    const scan = el('rect', { x: -140, y: -50, width: 280, height: 34, fill: C.blue, opacity: 0.22 }, g)
    const tick = group('', g)
    el('circle', { cx: 100, cy: 140, r: 34, fill: C.green, stroke: '#fff', 'stroke-width': 5 }, tick)
    el('path', { d: 'M 84 140 L 96 153 L 118 127', fill: 'none', stroke: '#fff', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, tick)
    return Object.assign(g, { scan, tick })
  })
  const daily = item(360, 76, '<span>⟳ Daily re-read</span>', 'chip')
  daily.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:34px;padding:0;background:var(--blue);color:#fff'
  const quotes = panel(1000, 560, 'cards/aapl-oakmere#sources', `
    <h3>Quoted sentences</h3>
    <p class="sub">Checked word for word against today’s copy</p>`)
  const QUOTES = [['“Redemption fee: 0.25%.”', 'Oakmere Terms · section 5'], ['“Shares are held in a segregated account.”', 'Prospectus · section 4.2'], ['“Holders remain on the register.”', 'Docs page · Custody']]
  const quoteRows = QUOTES.map(([quote, src]) => {
    const r = item(940, 116, row(`<div><span class="quote" style="font-size:34px">${quote}</span><br><small>${src}</small></div>`, '<span class="badge good ok" style="opacity:0;flex:none">✓ Match</span>'), 'box')
    r.div.style.padding = '8px 24px'
    return Object.assign(r, { ok: r.div.querySelector('.ok') })
  })

  // edit: Tuesday night, the terms page changes
  const night = group('night')
  el('rect', { x: 40, y: 180, width: 1000, height: 1120, rx: 40, fill: '#1c2140' }, night)
  for (const [x, y, r] of [[140, 430, 4], [420, 250, 3], [560, 330, 5], [980, 470, 3], [700, 240, 4], [90, 1250, 3], [1000, 1240, 4], [620, 420, 3]]) el('circle', { cx: x, cy: y, r, fill: '#fff', opacity: 0.8 }, night)
  el('circle', { cx: 870, cy: 320, r: 80, fill: '#f6e7b0' }, night)
  el('circle', { cx: 905, cy: 290, r: 72, fill: '#1c2140' }, night)
  const nightClock = item(360, 150, '<small style="color:#aab3e0;font-size:30px">Tue 15 Sep</small><b style="font-size:64px;font-family:SF Mono,Menlo,monospace">23:40</b>', 'box center dark')
  nightClock.div.style.cssText += ';background:#0e1230;border-color:#3a4270;color:#ff7a70;gap:0'
  const editTerms = termsPage(960, 820)

  // caught: the next read fails the quote, then the change-journal card
  const miss = item(940, 150, row(`<div><small>Daily read · Wed 16 Sep</small><br><span class="quote" style="font-size:38px"><s>“Redemption fee: 0.25%.”</s></span></div>`, '<span class="badge bad" style="flex:none;font-size:30px">✗ No match</span>'), 'box')
  miss.div.style.padding = '10px 28px'
  miss.div.style.borderColor = C.coral
  const card = panel(1000, 930, 'watch.html#oakmere-terms', `
    <h3>Change journal</h3>
    <h2 style="font-size:46px;margin-bottom:16px">Oakmere Terms changed</h2>
    <div class="box" style="height:auto;padding:12px 22px;margin-bottom:16px">${row('<div><small>Claim on the token card</small><br><span class="quote" style="font-size:36px">“Redemption fee: 0.25%.”</span></div>', '<span class="badge warn" style="flex:none;font-size:30px">Changed</span>')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div class="box col" style="justify-content:flex-start;height:370px;background:var(--red-soft);border-color:#ebb9b3"><span class="badge bad" style="align-self:flex-start">Before · 14 Sep</span>
        <s style="font-size:36px;font-weight:700">Redemption fee: 0.25%.</s>
        <small>(no suspension clause)</small></div>
      <div class="box col" style="justify-content:flex-start;height:370px;background:var(--green-soft);border-color:#a9d3c1"><span class="badge good" style="align-self:flex-start">After · 16 Sep</span>
        <b style="font-size:36px">Redemption fee: 2%.</b>
        <b style="font-size:34px;line-height:1.22">Oakmere may suspend redemptions at its discretion.</b></div>
    </div>
    <div class="impact" style="margin-top:18px;display:flex;align-items:center;gap:16px;opacity:0">
      <span class="chip" style="background:var(--red-soft);color:var(--accent);font-size:40px;padding:10px 26px">▲ high holder impact</span>
      <span class="badge unknown model" style="font-size:26px">model assessment</span></div>`)
  const cardCols = [...card.div.querySelectorAll('.col')]
  const impact = card.div.querySelector('.impact')
  const modelLabel = card.div.querySelector('.model')

  // rating: the model reads the difference
  const model = item(940, 150, `<div style="display:flex;align-items:center;gap:22px"><span style="font-size:72px;line-height:1">🤖</span><div><b style="font-size:40px">Language model</b><br><span style="font-size:32px">reads before → after, rates holder impact</span></div></div>`, 'box')
  model.div.style.padding = '10px 28px'

  // keys: who holds the freeze key, read every hour
  const keysPanel = panel(1000, 1080, 'cards/aapl-oakmere#keys', `
    <h3>Who holds the keys</h3>
    <h2 style="font-size:46px">AAPL · Oakmere</h2>
    <div style="display:flex;gap:14px;margin-top:14px"><span class="badge info" style="font-size:28px">⟳ Hourly</span><span class="badge info" style="font-size:28px">Read on Solana</span></div>`)
  const keyIcon = (parent, x, y, s, fill) => {
    const g = group('', parent)
    g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`)
    el('path', { d: 'M -4 -7 L 44 -7 L 44 7 L 36 7 L 36 20 L 27 20 L 27 7 L 19 7 L 19 16 L 11 16 L 11 7 L -4 7 Z', fill, stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round' }, g)
    el('circle', { cx: -22, cy: 0, r: 21, fill, stroke: C.ink, 'stroke-width': 5 }, g)
    el('circle', { cx: -22, cy: 0, r: 7, fill: '#fff', stroke: C.ink, 'stroke-width': 3 }, g)
    return g
  }
  const multisig = group('multisig')
  el('rect', { x: -390, y: -130, width: 780, height: 260, rx: 30, fill: C.panel, stroke: C.blue, 'stroke-width': 5 }, multisig)
  k.text(multisig, -350, -68, 'Freeze key', 34, C.muted, 'start', 700)
  k.text(multisig, 350, -68, '3-of-5 multisig', 40, C.blueDark, 'end', 800)
  for (let i = 0; i < 5; i++) {
    const on = i < 3
    const x = -280 + i * 140
    el('circle', { cx: x + 8, cy: 40, r: 62, fill: on ? C.blueSoft : 'none', stroke: on ? C.blue : C.line, 'stroke-width': on ? 6 : 3, 'stroke-dasharray': on ? 'none' : '10 8' }, multisig)
    const key = keyIcon(multisig, x, 40, 1.3, on ? '#f2c14e' : '#e6e2da')
    if (!on) key.setAttribute('opacity', 0.55)
  }
  const arrow = group('arrow')
  el('path', { d: 'M 0 -40 L 0 26', stroke: C.ink, 'stroke-width': 10, 'stroke-linecap': 'round' }, arrow)
  el('path', { d: 'M -28 10 L 0 44 L 28 10', fill: 'none', stroke: C.ink, 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, arrow)
  const single = group('single')
  el('rect', { x: -300, y: -95, width: 600, height: 190, rx: 30, fill: '#f8e0dd', stroke: C.coral, 'stroke-width': 5 }, single)
  keyIcon(single, -170, 0, 2, '#f2c14e')
  k.text(single, 40, -8, 'Freeze key', 32, C.muted, 'start', 700)
  k.text(single, 40, 42, 'one key', 50, C.accent, 'start', 800)
  const keyEvent = item(920, 140, `${row('<span class="badge bad" style="font-size:30px">Key changed</span>', '<small>16 Sep · 02:00</small>')}<b style="font-size:34px">Freeze key: 3-of-5 multisig → single key</b>`, 'box')
  keyEvent.div.style.padding = '10px 26px'
  keyEvent.div.style.borderColor = C.coral

  // digest: John's phone the next morning
  const watching = item(560, 80, '<span>✓ John watches AAPL · Oakmere</span>', 'chip')
  watching.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:32px;padding:0;background:var(--green-soft);color:var(--green)'
  const phone = group('phone')
  el('rect', { x: -350, y: -490, width: 700, height: 980, rx: 80, fill: C.ink }, phone)
  el('rect', { x: -322, y: -462, width: 644, height: 924, rx: 56, fill: '#e9eef4' }, phone)
  el('rect', { x: -80, y: -450, width: 160, height: 30, rx: 15, fill: C.ink }, phone)
  k.text(phone, -270, -392, '08:02 ☀️', 30, C.ink, 'start', 800)
  k.text(phone, 270, -392, 'John’s phone', 28, C.muted, 'end', 700)
  el('rect', { x: -322, y: -364, width: 644, height: 96, fill: '#fff' }, phone)
  k.sonarMark(phone, -252, -316, 0.9)
  k.text(phone, -197, -304, 'RWA Sonar', 38, C.ink, 'start', 800)
  k.text(phone, 270, -304, 'Telegram', 28, C.muted, 'end', 600)
  el('rect', { x: -110, y: -246, width: 220, height: 50, rx: 25, fill: 'rgba(23,21,29,0.12)' }, phone)
  k.text(phone, 0, -211, 'Wed 16 Sep', 28, C.ink, 'middle', 700)
  const message = item(620, 540, `
    <b style="font-size:38px">RWA Sonar · daily digest</b>
    <span class="chip" style="align-self:flex-start;font-size:34px;margin:4px 0">AAPL · Oakmere</span>
    <div style="font-size:36px;line-height:1.25"><b>Terms changed</b><br>redemption fee 0.25% → 2%; new suspension clause</div>
    <div style="font-size:36px;line-height:1.25;margin-top:6px"><b>Freeze key</b><br>3-of-5 multisig → single key</div>
    ${row('<span class="badge unknown" style="font-size:26px">example</span>', '<small>08:02</small>')}`, 'box')
  message.div.style.cssText += ';justify-content:flex-start;gap:12px;border-radius:30px 30px 30px 8px;padding:24px 28px'

  const john = k.john()
  const dolphin = k.dolphin('scout')
  const caption = k.caption()
  const outro = k.endCard(['Terms and keys can change', 'after you buy. Know when.'])

  return (c) => {
    const { t, P, at, stage, cue, current } = c
    // a scene fraction `f` of the way through sentence n (up to the next sentence, or the scene end)
    const within = (id, n, f) => { let next = 1; try { next = cue(id, n + 1) } catch { /* last sentence */ } return lerp(cue(id, n), next, f) }
    // pops a node in at time a and out at time b (both absolute seconds)
    const between = (node, a, b, pos) => {
      const v = t < a || t >= b ? 0 : pop(clamp((t - a) / 0.4)) * (1 - easeInOut(clamp((t - (b - 0.3)) / 0.3)))
      pose(node, { ...pos, s: (pos.s ?? 1) * v, o: v > 0 ? 1 : 0 })
      return v
    }

    // John: big in the intro, then down to the cast strip
    const down = easeInOut(P('reread', 0, 0.12))
    pose(john, { x: lerp(250, 170, down), y: lerp(900, 1700, down), s: lerp(1.45, 0.68, down) })
    const introWorry = current === 'intro' && t >= at('intro', cue('intro', 2))
    john.setMood(introWorry || current === 'edit' ? 'worried' : current === 'digest' ? 'awake' : 'smile')
    const dIn = clamp(P('reread', 0.05, 0.3))
    pose(dolphin, { x: lerp(1300, 850, easeInOut(dIn)), y: 1700 + 14 * Math.sin(t * 2.2), s: 0.95, r: -4 + 3 * Math.sin(t * 1.3) })

    // intro
    stage(coin, ['intro', 0.04], 'intro', { x: 700, y: 1020, s: 1.25 })
    stage(coinTag, ['intro', 0.04], 'intro', { x: 700, y: 1150, s: 1.15 })
    stage(introTerms, ['intro', cue('intro', 1)], 'intro', { x: 700, y: 520, s: 0.66 })
    stage(readTag, ['intro', cue('intro', 1, 0.5)], 'intro', { x: 700, y: 840 })
    const scribble = t >= at('intro', cue('intro', 2, 0.3))
    introTerms.pen.style.opacity = scribble ? 1 : 0
    introTerms.pen.style.transform = `translate(${6 * Math.sin(t * 14)}px, ${4 * Math.cos(t * 11)}px) rotate(${-8 + 6 * Math.sin(t * 9)}deg)`
    introTerms.old.style.background = scribble ? '#fbecd2' : 'transparent'

    // reread
    // the documents sit mid-frame while they are read, then rise to make room for the quote panel
    const rise = easeInOut(P('reread', 0.46, 0.54))
    const docsV = docs.map((d, i) => stage(d, ['reread', 0.04 + i * 0.05], 'reread', { x: 215 + i * 325, y: lerp(640, 470, rise), r: (i - 1) * 3 }))
    docs.forEach((d, i) => {
      const scanP = clamp(P('reread', 0.12 + i * 0.06, 0.5 + i * 0.03))
      d.scan.setAttribute('y', -170 + ((scanP * 2.4) % 1) * 300)
      d.scan.setAttribute('opacity', scanP > 0 && scanP < 1 ? 0.22 : 0)
      pose(d.tick, { s: pop(clamp(P('reread', 0.5 + i * 0.03, 0.56 + i * 0.03))), o: docsV[i] > 0 ? 1 : 0 })
    })
    stage(daily, ['reread', 0.38], 'reread', { x: 540, y: 225 })
    stage(quotes, ['reread', 0.5], 'reread', { x: 540, y: 1000 })
    quoteRows.forEach((r, i) => {
      stage(r, ['reread', 0.52 + i * 0.03], 'reread', { x: 540, y: 950 + i * 124 })
      r.ok.style.opacity = c.after('reread', 0.66 + i * 0.08) ? 1 : 0
    })

    // edit
    const nightV = current === 'edit' ? easeInOut(P('edit', 0, 0.06)) : current === 'caught' ? 1 - easeInOut(P('caught', 0, 0.06)) : 0
    night.setAttribute('opacity', nightV)
    stage(nightClock, ['edit', 0.04], 'edit', { x: 250, y: 320 })
    stage(editTerms, ['edit', 0.08], 'edit', { x: 540, y: 860 })
    const feeFocus = t >= at('edit', within('edit', 1, 0.2)) && t < at('edit', cue('edit', 2))
    const feeDone = t >= at('edit', within('edit', 1, 0.78))
    editTerms.old.style.background = feeFocus && !feeDone ? '#fbecd2' : 'transparent'
    editTerms.old.style.textDecoration = feeDone ? 'line-through' : 'none'
    editTerms.old.style.color = feeDone ? 'var(--muted)' : ''
    editTerms.fresh.style.opacity = feeDone ? 1 : 0
    editTerms.pen.style.opacity = feeFocus ? 1 : 0
    editTerms.pen.style.transform = `translate(${6 * Math.sin(t * 14)}px, ${4 * Math.cos(t * 11)}px) rotate(${-8 + 6 * Math.sin(t * 9)}deg)`
    const addP = clamp((t - at('edit', cue('edit', 2, 0.2))) / 0.5)
    editTerms.added.style.opacity = easeInOut(addP)
    editTerms.added.style.transform = `translateX(${(1 - easeInOut(addP)) * 40}px)`

    // caught: the failed quote first fills the frame, then moves up above the journal card
    const cardAt = at('caught', cue('caught', 1))
    const up = easeInOut(clamp((t - cardAt) / 0.5))
    stage(miss, ['caught', 0.04], 'caught', { x: 540, y: lerp(700, 275, up), s: lerp(1.08, 1, up) })
    stage(card, ['caught', cue('caught', 1)], 'rating', { x: 540, y: 820 })
    // rating
    stage(model, ['rating', 0.03], 'rating', { x: 540, y: 275 })
    const reading = current === 'rating' && t < at('rating', cue('rating', 1))
    cardCols.forEach((col) => col.classList.toggle('hl', reading))
    const rated = clamp((t - at('rating', cue('rating', 1))) / 0.35)
    impact.style.opacity = rated
    impact.style.transform = `scale(${lerp(0.85, 1, pop(rated))})`
    impact.style.transformOrigin = 'left center'
    const labelled = current === 'rating' && t >= at('rating', cue('rating', 2))
    modelLabel.style.boxShadow = labelled ? `0 0 0 ${4 + 2 * Math.sin(t * 6)}px ${C.blue}` : 'none'

    // keys
    stage(keysPanel, ['keys', 0.02], 'keys', { x: 540, y: 745 })
    const moveAt = at('keys', cue('keys', 1))
    const moved = easeInOut(clamp((t - moveAt - 0.8) / 0.6))
    const msV = stage(multisig, ['keys', 0.12], 'keys', { x: 540, y: 660 })
    multisig.setAttribute('opacity', msV > 0 ? lerp(1, 0.45, moved) : 0)
    stage(arrow, ['keys', cue('keys', 1, 0.8)], 'keys', { x: 540, y: 845 })
    stage(single, ['keys', cue('keys', 1, 1.1)], 'keys', { x: 540, y: 990 })
    stage(keyEvent, ['keys', within('keys', 1, 0.78)], 'keys', { x: 540, y: 1180 })

    // digest
    stage(watching, ['digest', 0.03], 'digest', { x: 540, y: 235 })
    stage(phone, ['digest', 0.1], 'digest', { x: 540, y: 795 })
    const msgAt = at('digest', 0.3)
    between(message, msgAt, at('digest', 1), { x: 540, y: 880 + 60 * (1 - easeInOut(clamp((t - msgAt) / 0.5))) })

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
