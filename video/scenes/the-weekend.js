// Scenes for "The stock market is closed. The token is not.": Saturday, why the price stays close on weekdays and
// not on weekends, a chart of the token drifting while the stock is closed, the site's premium split into
// market-open and market-closed hours, and what John gets if he sells on Saturday.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pose, item, panel, el, group, C } = k

  // hook: calendar, closed exchange, token still trading
  const cal = group('cal')
  el('rect', { x: -150, y: -160, width: 300, height: 320, rx: 30, fill: '#fff', stroke: C.ink, 'stroke-width': 6 }, cal)
  el('rect', { x: -150, y: -160, width: 300, height: 90, rx: 30, fill: C.coral, stroke: C.ink, 'stroke-width': 6 }, cal)
  k.text(cal, 0, -98, 'SATURDAY', 34, '#fff')
  k.text(cal, 0, 90, 'SAT', 110, C.ink)
  const exch = group('exch')
  el('path', { d: 'M -230 -110 L 0 -210 L 230 -110 Z', fill: '#fff', stroke: C.ink, 'stroke-width': 6, 'stroke-linejoin': 'round' }, exch)
  for (const x of [-180, -90, 0, 90, 180]) el('rect', { x: x - 22, y: -100, width: 44, height: 220, fill: '#fff', stroke: C.ink, 'stroke-width': 5 }, exch)
  el('rect', { x: -250, y: 120, width: 500, height: 40, rx: 8, fill: '#fff', stroke: C.ink, 'stroke-width': 6 }, exch)
  k.text(exch, 0, 205, 'Stock exchange', 34, C.muted, 'middle', 700)
  const closedSign = group('closed')
  el('rect', { x: -170, y: -48, width: 340, height: 96, rx: 14, fill: C.coral, stroke: C.ink, 'stroke-width': 6 }, closedSign)
  k.text(closedSign, 0, 20, 'CLOSED', 60, '#fff')
  const live = item(620, 110, '<div style="display:flex;align-items:center;gap:18px;justify-content:center"><span class="chip" style="font-size:36px">AAPL · Oakmere</span><span style="width:22px;height:22px;border-radius:50%;background:var(--green);display:inline-block"></span><b style="color:var(--green)">trading</b></div>', 'box center')

  // closed: weekday vs weekend
  const weekday = item(940, 330, `
    <span class="badge good" style="align-self:flex-start">Weekday</span>
    <div style="display:flex;align-items:center;justify-content:center;gap:24px;font-size:40px;font-weight:800"><span class="chip" style="font-size:36px">token</span><span style="font-size:56px">⇄</span><span class="chip" style="font-size:36px;background:var(--green-soft);color:var(--green)">real shares</span></div>
    <small style="font-size:34px;color:var(--ink)">Traders buy or sell the shares, so the token stays near the stock price.</small>`, 'box')
  const weekend = item(940, 330, `
    <span class="badge bad" style="align-self:flex-start">Weekend</span>
    <div style="display:flex;align-items:center;justify-content:center;gap:24px;font-size:40px;font-weight:800"><span class="chip" style="font-size:36px">token</span><span style="font-size:56px;color:var(--line)">⇄</span><span class="chip" style="font-size:36px;background:var(--grey-soft);color:var(--muted)">🔒 real shares</span></div>
    <small style="font-size:34px;color:var(--ink)">The shares can’t be traded until Monday.</small>`, 'box')

  // drift: price chart across the weekend
  const chart = group('chart')
  el('rect', { x: -480, y: -330, width: 960, height: 660, rx: 30, fill: '#fff', stroke: C.line, 'stroke-width': 4 }, chart)
  el('rect', { x: -225, y: -300, width: 450, height: 540, fill: '#ebe8e1' }, chart)
  k.text(chart, 0, -260, 'market closed', 30, C.muted, 'middle', 700)
  ;['Fri', 'Sat', 'Sun', 'Mon'].forEach((d, i) => k.text(chart, -337 + i * 225, 305, d, 34, C.muted, 'middle', 800))
  const stockFri = el('path', { d: 'M -450 60 L -400 40 L -350 55 L -300 20 L -225 30', fill: 'none', stroke: C.blue, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, chart)
  const stockFlat = el('path', { d: 'M -225 30 L 225 30', fill: 'none', stroke: C.blue, 'stroke-width': 6, 'stroke-dasharray': '14 14' }, chart)
  const stockMon = el('path', { d: 'M 240 -60 L 300 -80 L 360 -50 L 450 -70', fill: 'none', stroke: C.blue, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, chart)
  const token = el('path', { d: 'M -225 30 L -170 40 L -110 10 L -50 25 L 0 -10 L 30 -130 L 90 -110 L 150 -160 L 225 -140', fill: 'none', stroke: C.coral, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1 }, chart)
  const news = group('', chart)
  el('rect', { x: -90, y: -40, width: 180, height: 80, rx: 40, fill: C.ink }, news)
  k.text(news, 0, 14, 'News', 40, '#fff')
  const monDot = el('circle', { cx: 240, cy: -60, r: 16, fill: C.blue, stroke: '#fff', 'stroke-width': 5 }, chart)
  const legend = item(700, 60, '<div style="display:flex;gap:30px;justify-content:center;font-size:30px;font-weight:800"><span style="color:var(--blue)">━ Apple stock</span><span style="color:var(--coral)">━ AAPL · Oakmere token</span></div>', '', chart)
  legend.setAttribute('transform', 'translate(0 222)')
  legend.setAttribute('opacity', 1)

  // site: premium split by market session
  const site = panel(1000, 920, 'tracking.html?token=AAPL-Oakmere', `
    <h3>Premium &amp; concentration</h3>
    <h2 style="font-size:46px">AAPL · Oakmere</h2>
    <p class="sub">Premium to the real stock, by hour. Shaded: market closed.</p>`)
  const prem = group('prem')
  el('line', { x1: -440, y1: 0, x2: 440, y2: 0, stroke: C.line, 'stroke-width': 3 }, prem)
  const bars = []
  for (let i = 0; i < 40; i++) {
    const closed = i >= 12 && i < 30
    if (closed && i === 12) el('rect', { x: -440 + 12 * 22, y: -170, width: 18 * 22, height: 340, fill: '#ebe8e1' }, prem)
    const h = closed ? 30 + 110 * Math.abs(Math.sin(i * 0.7)) + (i === 22 ? 30 : 0) : 6 + 10 * Math.abs(Math.sin(i * 1.9))
    const sign = closed ? 1 : i % 3 ? 1 : -1
    bars.push({ node: el('rect', { x: -436 + i * 22, y: sign > 0 ? -h : 0, width: 16, height: h, rx: 3, fill: closed ? C.coral : C.blue }, prem), i })
  }
  const statOpen = item(450, 190, '<small>Premium while open</small><b style="font-size:48px;color:var(--blue)">within 0.2%</b>', 'box')
  const statClosed = item(450, 190, '<small>Premium while closed</small><b style="font-size:48px;color:var(--coral)">up to 2.0%</b>', 'box')

  // sell
  const sellSat = item(940, 200, '<small>John sells on Saturday</small><b style="font-size:46px">Gets the token’s weekend price</b>', 'box hl')
  const monOpen = item(940, 200, '<small>Monday</small><b style="font-size:46px">Apple opens wherever it opens</b><small>It doesn’t change John’s Saturday sale</small>', 'box')

  const john = k.john()
  const dolphin = k.dolphin('scout')
  const caption = k.caption()
  const outro = k.endCard(['Check the closed-market premium', 'before you trade at odd hours.'])

  return (c) => {
    const { t, P, stage, cue, current } = c

    pose(john, { x: 170, y: 1700, s: 0.68 })
    john.setMood(current === 'drift' ? 'worried' : 'smile')
    const dIn = clamp(P('hook', 0.1, 0.4))
    pose(dolphin, { x: lerp(1300, 850, easeInOut(dIn)), y: 1700 + 14 * Math.sin(t * 2.2), s: 0.95, r: -4 + 3 * Math.sin(t * 1.3) })

    stage(cal, ['hook', 0.02], 'hook', { x: 280, y: 430, r: -4 })
    stage(exch, ['hook', 0.1], 'hook', { x: 720, y: 520 })
    stage(closedSign, ['hook', cue('hook', 1)], 'hook', { x: 720, y: 540, r: -8 })
    stage(live, ['hook', cue('hook', 1, 1.4)], 'hook', { x: 540, y: 1000 })

    stage(weekday, ['closed', 0.03], 'closed', { x: 540, y: 470 })
    stage(weekend, ['closed', cue('closed', 1)], 'closed', { x: 540, y: 900 })

    stage(chart, ['drift', 0.02], 'drift', { x: 540, y: 740 })
    token.setAttribute('stroke-dashoffset', 1 - easeInOut(clamp((t - c.at('drift', 0.08)) / (0.6 * c.at('drift', 1) - 0.6 * c.at('drift', 0)))))
    const newsAt = c.at('drift', cue('drift', 1))
    pose(news, { x: -110, y: -120, s: t >= newsAt ? k.pop(clamp((t - newsAt) / 0.4)) : 0 })
    const monAt = c.at('drift', cue('drift', 1, 2.2))
    for (const n of [stockMon, monDot]) n.setAttribute('opacity', t >= monAt ? 1 : 0)
    void stockFri; void stockFlat

    stage(site, ['site', 0.02], 'gap', { x: 540, y: 660 })
    stage(prem, ['site', 0.12], 'gap', { x: 540, y: 620 })
    const grow = easeInOut(clamp((t - c.at('site', 0.12)) / 1.2))
    bars.forEach(({ node }) => node.setAttribute('transform', `scale(1 ${Math.max(0.001, grow)})`))
    stage(statOpen, ['gap', cue('gap', 0)], 'gap', { x: 290, y: 980 })
    stage(statClosed, ['gap', cue('gap', 1)], 'gap', { x: 790, y: 980 })

    stage(sellSat, ['sell', 0.05], 'sell', { x: 540, y: 560 })
    stage(monOpen, ['sell', 0.45], 'sell', { x: 540, y: 860 })

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
