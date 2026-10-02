// Scenes for "John buys Apple as a token": search finds three AAPL tokens from fictional issuers, the compare
// view fills one row per question (what you own, who can act, trading), and John picks one and buys it.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pose, item, panel } = k

  const TOKENS = ['Oakmere', 'Northgate', 'Redcliff']
  const COLX = [215, 540, 865]

  // hook: John thinking about Apple as a token
  const thought = k.bubble(560, 200, '<b style="font-size:44px">Apple stock…</b><span style="font-size:38px">as a token on Solana?</span>')

  // search: the Explore view with three results for AAPL
  const search = panel(980, 1000, 'stocks.html?search=AAPL', `
    <h3>Explore</h3>
    <div style="margin:18px 0 26px;padding:18px 26px;border:3px solid var(--blue);border-radius:16px;font-size:40px;font-weight:700">🔍 AAPL</div>
    <div class="sub" style="margin-bottom:14px">3 tokens track Apple Inc.</div>`)
  const results = TOKENS.map((name) => item(900, 150, `
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="chip" style="font-size:36px">AAPL · ${name}</span><b style="font-size:40px">$229.4</b></div>
    <small>Issuer: ${name} · token on Solana</small>`))

  // compare: header, column chips, and one row per question
  const compare = panel(1000, 1110, 'stocks.html?compare=AAPL', `
    <div style="display:flex;align-items:baseline;gap:22px"><h2>AAPL</h2><span class="sub">Same stock reference. Different product.</span></div>`)
  const colChips = TOKENS.map((name) => item(300, 70, `<span>AAPL · ${name}</span>`, 'chip'))
  colChips.forEach((c) => { c.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:29px;padding:0' })
  const ROWS = {
    own: { label: 'What you own', y: 660, cells: [
      ['good', 'Registered', 'John is on the share register'],
      ['warn', 'Debt note', 'A claim on Northgate that tracks the price'],
      ['bad', 'Price only', 'Pays the price difference. No shares held'],
    ] },
    keys: { label: 'Who can act on your tokens', y: 920, cells: [
      ['good', 'Mint: 3 of 5', 'Freeze: yes<br>Mint: multisig'],
      ['bad', 'Mint: 1 key', 'Freeze: yes<br>Mint: one key'],
      ['bad', 'Mint: 1 key', 'Freeze: yes<br>Mint: one key'],
    ] },
    market: { label: 'Trading', y: 1180, cells: [
      ['warn', 'Thin pool', '+0.5% vs AAPL'],
      ['good', 'Deepest pool', '+0.1% vs AAPL'],
      ['warn', 'Mid pool', '−0.3% vs AAPL'],
    ] },
  }
  const rows = Object.fromEntries(Object.entries(ROWS).map(([id, row]) => {
    const label = item(940, 44, `<h3 style="margin:0;font-size:26px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)">${row.label}</h3>`, '')
    const cells = row.cells.map(([tone, badge, body]) => item(306, 210, `<span class="badge ${tone}" style="align-self:flex-start;font-size:25px">${badge}</span><span style="font-size:32px;line-height:1.2;font-weight:700">${body}</span>`, 'box'))
    cells.forEach((c) => { c.div.style.padding = '14px 18px'; c.div.style.justifyContent = 'flex-start' })
    return [id, { ...row, labelNode: label, cells }]
  }))

  // pick: a frame around John's column, then the purchase toast
  const pickFrame = k.el('rect', { x: -172, y: -445, width: 344, height: 890, rx: 30, fill: 'none', stroke: k.C.blue, 'stroke-width': 8 })
  const pickBadge = item(260, 64, 'John’s pick', 'chip')
  pickBadge.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--blue);color:#fff;font-size:30px;padding:0'
  const bought = item(470, 150, '<b style="font-size:36px">✓ Bought 2</b><b style="font-size:32px">AAPL · Oakmere</b>', 'box center dark')

  const john = k.john()
  const dolphin = k.dolphin('scout')
  const caption = k.caption()
  const outro = k.endCard(['The ticker is familiar.', 'The token is mysterious.'])

  return (c) => {
    const { t, P, stage, current } = c

    // John: big in the hook, then down to the cast strip; back to centre-left on the end card
    const down = easeInOut(P('search', 0, 0.12))
    pose(john, { x: lerp(330, 170, down), y: lerp(900, 1700, down), s: lerp(1.45, 0.68, down) })
    john.setMood(['own', 'keys'].includes(current) ? 'worried' : 'smile')
    stage(thought, ['hook', 0.15], 'hook', { x: 690, y: 520 })

    // dolphin guide bobbing in the cast strip
    const dIn = clamp(P('hook', 0.3, 0.6))
    pose(dolphin, { x: lerp(1300, 850, easeInOut(dIn)), y: 1700 + 14 * Math.sin(t * 2.2), s: 0.95, r: -4 + 3 * Math.sin(t * 1.3) })

    // search
    stage(search, ['search', 0.05], 'search', { x: 540, y: 710 })
    results.forEach((r, i) => stage(r, ['search', 0.2 + i * 0.1], 'search', { x: 540, y: 690 + i * 175 }))

    // compare rows
    stage(compare, ['own', 0], 'pick', { x: 540, y: 745 })
    colChips.forEach((chip, i) => stage(chip, ['own', 0.05], 'pick', { x: COLX[i], y: 440 }))
    // each cell pops when its sentence is spoken
    const CUES = { own: [2, 3, 4], keys: [3, 2, 2], market: [2, 1, 1] }
    const order = ['own', 'keys', 'market']
    for (const [id, row] of Object.entries(rows)) {
      stage(row.labelNode, [id, 0.02], 'pick', { x: 540, y: row.y - 135 })
      row.cells.forEach((cell, i) => stage(cell, [id, c.cue(id, CUES[id][i])], 'pick', { x: COLX[i], y: row.y }))
      const active = current === id
      const past = order.indexOf(current) > order.indexOf(id) || current === 'pick'
      row.cells.forEach((cell) => cell.div.classList.toggle('hl', active))
      row.cells.forEach((cell, i) => cell.setAttribute('opacity', +cell.getAttribute('opacity') * (past && !(current === 'pick' && i === 0) ? 0.55 : 1)))
    }

    // pick
    stage(pickFrame, ['pick', 0.08], 'pick', { x: COLX[0], y: 845 })
    stage(pickBadge, ['pick', 0.12], 'pick', { x: COLX[0], y: 392 })
    stage(bought, ['pick', c.cue('pick', 1, 0.6)], 'pick', { x: 520, y: 1690 })

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
