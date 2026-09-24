// Scenes for "John wants yield on his token": the token page lists where the exact token is used in DeFi (a
// lending market, a yield vault, an LP pool; all fictional), each use gets a small diagram and its added risk, and
// the last scene stacks the parties John now depends on.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pose, item, panel, el, group, C } = k

  const coin = (label, fill = C.blue) => {
    const g = group('')
    el('circle', { cx: 0, cy: 0, r: 70, fill, stroke: C.ink, 'stroke-width': 6 }, g)
    el('circle', { cx: 0, cy: 0, r: 54, fill: 'none', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 4 }, g)
    k.text(g, 0, 14, label, label.length > 3 ? 34 : 44, '#fff')
    g.setAttribute('opacity', 0)
    return g
  }

  // hook
  const heldCoin = coin('AAPL')
  const heldTag = item(300, 64, 'AAPL · Oakmere', 'chip')
  heldTag.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;padding:0'
  const thought = k.bubble(520, 190, '<b style="font-size:44px">Earn something?</b><b style="font-size:44px">Borrow against it?</b>')
  const lost = item(420, 90, '<b style="font-size:40px">Where? How?</b>', 'box center')

  // usage list on the token page
  const USES = [
    ['Lanternfish Lend', 'Lending market', 'Collateral for a loan'],
    ['Saltmarsh Vaults', 'Yield vault', 'Deposits run a strategy'],
    ['Brinepool', 'LP pool', 'Token paired with dollars'],
  ]
  const page = panel(1000, 500, 'cards/aapl-oakmere', `
    <h3>DeFi use of this exact token</h3>
    <h2 style="font-size:46px">AAPL · Oakmere</h2>`)
  const useRows = USES.map(([name, kind, what]) => item(940, 92, `
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:36px">${name}</b><span class="badge info">${kind}</span></div>`, 'box'))
  useRows.forEach((r) => { r.div.style.padding = '10px 24px' })

  // lend: token → market → dollars, then a falling price crossing the liquidation line
  const flow = (a, b, c) => item(980, 170, `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:34px;font-weight:800">
      <span class="chip" style="font-size:32px">${a}</span><span style="font-size:48px;color:var(--muted)">→</span>
      <span class="box" style="width:auto;height:auto;padding:16px 22px;display:inline-flex">${b}</span><span style="font-size:48px;color:var(--muted)">→</span>
      <span class="chip" style="font-size:32px;background:var(--green-soft);color:var(--green)">${c}</span></div>`, '')
  const lendFlow = flow('AAPL · Oakmere', 'Lanternfish Lend', '$ loan')
  const chart = group('chart')
  el('rect', { x: -440, y: -150, width: 880, height: 300, rx: 26, fill: '#fff', stroke: C.line, 'stroke-width': 3 }, chart)
  k.text(chart, -410, -106, 'AAPL price', 30, C.muted, 'start', 700)
  el('line', { x1: -410, y1: 70, x2: 410, y2: 70, stroke: C.coral, 'stroke-width': 5, 'stroke-dasharray': '16 12' }, chart)
  k.text(chart, -410, 118, 'liquidation price', 28, C.accent, 'start', 700)
  const priceLine = el('path', { d: 'M -410 -60 L -300 -80 L -200 -40 L -100 -70 L 0 -10 L 100 10 L 200 50 L 300 95 L 400 130', fill: 'none', stroke: C.blue, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1 }, chart)
  const sold = item(360, 76, '<b>Tokens sold</b>', 'box center')
  sold.div.style.cssText += ';background:var(--red-soft);color:var(--accent);border-color:var(--coral);padding:8px'
  const riskLend = item(860, 90, '<span class="badge bad">Added risk</span><b>Liquidation if Apple falls</b>', 'box')

  // vault
  const vaultFlow = flow('AAPL · Oakmere', 'Saltmarsh Vaults', 'yield')
  const vaultKeys = item(860, 210, `
    <span class="badge info" style="align-self:flex-start">Who holds the keys · vault</span>
    <div style="display:flex;justify-content:space-between"><span>Upgrade program</span><b style="color:var(--accent)">one key</b></div>
    <div style="display:flex;justify-content:space-between"><span>Pause deposits</span><b>3-of-5 multisig</b></div>`, 'box')
  const riskVault = item(860, 90, '<span class="badge bad">Added risk</span><b>The vault’s own keys</b>', 'box')

  // pool: the mix John gets back after the price moves
  const poolFlow = flow('AAPL · Oakmere', 'Brinepool', 'fees')
  const mix = group('mix')
  const bar = (y, label) => {
    k.text(mix, -420, y - 18, label, 30, C.muted, 'start', 700)
    const a = el('rect', { x: -420, y, width: 420, height: 70, rx: 12, fill: C.blue }, mix)
    const b = el('rect', { x: 0, y, width: 420, height: 70, rx: 12, fill: C.green }, mix)
    const ta = k.text(mix, -400, y + 47, 'AAPL', 32, '#fff', 'start', 800)
    const tb = k.text(mix, 400, y + 47, '$', 32, '#fff', 'end', 800)
    return { a, b, ta, tb }
  }
  const mixIn = bar(-80, 'Put in')
  const mixOut = bar(80, 'Taken out, after Apple rose')
  const riskPool = item(860, 90, '<span class="badge bad">Added risk</span><b>A different mix comes back</b>', 'box')

  // stack of parties
  const LAYERS = [['John', 'info'], ['Saltmarsh Vaults', 'warn'], ['Oakmere · issuer', 'warn'], ['Custodian', 'warn'], ['Apple shares', 'good']]
  const stackTitle = item(900, 80, '<h3 style="font-size:32px">Who John depends on, in order</h3>', '')
  const layers = LAYERS.map(([name, tone], i) => item(760 - i * 40, 150, `<b style="font-size:40px">${name}</b>`, `box center`))
  layers.forEach((l, i) => { const tone = LAYERS[i][1]; if (i === 0) l.div.classList.add('dark'); else l.div.style.background = `var(--${tone === 'good' ? 'green' : tone === 'warn' ? 'amber' : 'blue'}-soft)` })

  const john = k.john()
  const dolphin = k.dolphin('scout')
  const caption = k.caption()
  const outro = k.endCard(['See where your token is used,', 'and what each use adds.'])

  return (c) => {
    const { t, P, stage, cue, current } = c

    const down = easeInOut(P('usage', 0, 0.12))
    pose(john, { x: lerp(300, 170, down), y: lerp(900, 1700, down), s: lerp(1.45, 0.68, down) })
    john.setMood(current === 'hook' && t > c.at('hook', cue('hook', 2)) ? 'worried' : 'smile')
    stage(heldCoin, ['hook', 0.05], 'hook', { x: 640, y: 1000 })
    stage(heldTag, ['hook', 0.05], 'hook', { x: 640, y: 1110 })
    stage(thought, ['hook', cue('hook', 1)], 'hook', { x: 700, y: 480 })
    stage(lost, ['hook', cue('hook', 2)], 'hook', { x: 780, y: 750 })

    const dIn = clamp(P('hook', 0.3, 0.6))
    pose(dolphin, { x: lerp(1300, 850, easeInOut(dIn)), y: 1700 + 14 * Math.sin(t * 2.2), s: 0.95, r: -4 + 3 * Math.sin(t * 1.3) })

    // token page with its three uses; the active one is highlighted
    stage(page, ['usage', 0.02], 'pool', { x: 540, y: 445 })
    const active = { lend: 0, vault: 1, pool: 2 }[current]
    useRows.forEach((r, i) => {
      stage(r, ['usage', cue('usage', 1) + i * 0.08], 'pool', { x: 540, y: 440 + i * 95 })
      r.div.classList.toggle('hl', active === i)
      if (active !== undefined && active !== i) r.setAttribute('opacity', 0.5 * +r.getAttribute('opacity'))
    })

    // lend
    stage(lendFlow, ['lend', 0.05], 'lend', { x: 540, y: 790 })
    stage(chart, ['lend', cue('lend', 1)], 'lend', { x: 540, y: 1040 })
    priceLine.setAttribute('stroke-dashoffset', 1 - easeInOut(clamp((t - c.at('lend', cue('lend', 1))) / 2.2)))
    stage(sold, ['lend', cue('lend', 2)], 'lend', { x: 800, y: 1150 })
    stage(riskLend, ['lend', cue('lend', 2, 0.6)], 'lend', { x: 540, y: 1250 })

    // vault
    stage(vaultFlow, ['vault', 0.05], 'vault', { x: 540, y: 790 })
    stage(vaultKeys, ['vault', cue('vault', 1)], 'vault', { x: 540, y: 1030 })
    stage(riskVault, ['vault', cue('vault', 2, 1.2)], 'vault', { x: 540, y: 1250 })

    // pool
    stage(poolFlow, ['pool', 0.05], 'pool', { x: 540, y: 790 })
    const mixV = stage(mix, ['pool', cue('pool', 1)], 'pool', { x: 540, y: 1010 })
    const shift = easeInOut(clamp((t - c.at('pool', cue('pool', 1, 0.6))) / 1.5))
    const aw = lerp(420, 260, shift)
    mixOut.a.setAttribute('width', aw)
    mixOut.b.setAttribute('x', -420 + aw); mixOut.b.setAttribute('width', 840 - aw)
    mixIn.b.setAttribute('x', 0)
    void mixV
    stage(riskPool, ['pool', cue('pool', 1, 1.8)], 'pool', { x: 540, y: 1250 })

    // stack
    stage(stackTitle, ['stack', 0.02], 'stack', { x: 540, y: 250 })
    layers.forEach((l, i) => stage(l, ['stack', 0.06 + i * 0.1], 'stack', { x: 540, y: 390 + i * 190 }))

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
