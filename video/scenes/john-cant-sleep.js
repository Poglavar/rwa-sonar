// Scenes for "John can't sleep": a night-time hook, then the What if… page for his token. Each question gets a
// row with its answer state (documented / unknown / read from the chain) and a detail card quoting the fictional
// issuer's or protocol's own documents; the last scene shows where the research looked when the answer is unknown.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pose, item, panel, el, group, C } = k

  // hook: night
  const night = group('night')
  el('rect', { x: 40, y: 180, width: 1000, height: 1120, rx: 40, fill: '#1c2140' }, night)
  for (const [x, y, r] of [[140, 260, 4], [300, 330, 3], [520, 240, 5], [880, 420, 3], [760, 300, 4], [200, 520, 3], [960, 600, 4]]) el('circle', { cx: x, cy: y, r, fill: '#fff', opacity: 0.8 }, night)
  el('circle', { cx: 850, cy: 330, r: 80, fill: '#f6e7b0' }, night)
  el('circle', { cx: 885, cy: 300, r: 72, fill: '#1c2140' }, night)
  const clockBox = item(300, 120, '<b style="font-size:64px;font-family:SF Mono,Menlo,monospace">2:07</b>', 'box center dark')
  clockBox.div.style.cssText += ';background:#0e1230;border-color:#3a4270;color:#ff7a70'
  const bed = group('bed')
  el('rect', { x: -330, y: 60, width: 660, height: 230, rx: 40, fill: '#8aa0e8', stroke: C.ink, 'stroke-width': 6 }, bed)
  el('rect', { x: -360, y: 250, width: 720, height: 60, rx: 20, fill: '#5a3e2b', stroke: C.ink, 'stroke-width': 6 }, bed)
  const worry = k.bubble(520, 150, '<b style="font-size:48px">What if…?</b>')

  // What if… page for AAPL · Oakmere
  const page = panel(1000, 1110, 'whatif.html?token=AAPL-Oakmere', `
    <h3>What if…</h3>
    <h2 style="font-size:48px">AAPL · Oakmere</h2>
    <p class="sub">Answered from each party’s own documents.</p>`)
  const Q = [
    ['bankrupt', 'Oakmere goes bankrupt', 'good', 'Documented'],
    ['custodian', 'The custodian fails', 'unknown', 'Unknown'],
    ['hack', 'Lanternfish Lend is hacked', 'good', 'Documented'],
    ['keys', 'An Oakmere key is stolen', 'info', 'From the chain'],
  ]
  const rows = Q.map(([id, q, tone, state]) => {
    const r = item(940, 92, `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><b style="font-size:34px">${q}</b><span class="badge ${tone} state" style="opacity:0">${state}</span></div>`, 'box')
    r.div.style.padding = '10px 24px'
    return { id, r, badge: r.div.querySelector('.state') }
  })
  const detail = (html) => { const d = item(940, 410, html, 'box'); d.div.style.fontSize = '38px'; d.div.style.justifyContent = 'flex-start'; return d }
  const DETAIL = {
    bankrupt: detail(`<span class="badge good" style="align-self:flex-start">Documented</span>
      <span class="quote">“Shares are held in a segregated account at the custodian. Token holders remain on the register.”</span>
      <small>Oakmere prospectus · section 4.2</small>`),
    custodian: detail(`<span class="badge unknown" style="align-self:flex-start">Unknown</span>
      <div><b>Custodian named:</b> yes, section 4.2</div>
      <div><b>How shares move if it fails:</b> <span style="color:var(--accent)">not addressed</span></div>
      <small>We looked. The gap is the finding.</small>`),
    hack: detail(`<span class="badge good" style="align-self:flex-start">Documented</span>
      <span class="quote">“Lanternfish Lend does not repay losses from exploits or bugs.”</span>
      <small>Lanternfish Lend terms of use · section 9</small>`),
    keys: detail(`<span class="badge info" style="align-self:flex-start">From the chain</span>
      <div style="display:flex;justify-content:space-between"><span>Mint new tokens</span><b>3-of-5 multisig</b></div>
      <div style="display:flex;justify-content:space-between"><span>One stolen key</span><b style="color:var(--green)">cannot mint alone</b></div>
      <small>Who holds the keys · read on Solana</small>`),
    unknown: detail(`<span class="badge unknown" style="align-self:flex-start">Unknown · where we looked</span>
      <div>Prospectus <span style="color:var(--muted)">· not addressed</span></div>
      <div>Custody terms summary <span style="color:var(--muted)">· not addressed</span></div>
      <div>Issuer FAQ <span style="color:var(--muted)">· not addressed</span></div>`),
  }

  const john = k.john()
  john.after(bed) // the blanket covers John's legs while he sits up in bed
  const dolphin = k.dolphin('patrol')
  const caption = k.caption()
  const outro = k.endCard(['Which answers are in writing,', 'and which are missing.'])

  return (c) => {
    const { t, P, stage, cue, current } = c

    // night hook: John sitting up in bed, awake
    const nightOut = easeInOut(P('bankrupt', 0, 0.08))
    night.setAttribute('opacity', current === 'hook' || (current === 'bankrupt' && nightOut < 1) ? 1 - nightOut : 0)
    stage(clockBox, ['hook', 0.05], 'hook', { x: 260, y: 360 })
    stage(bed, ['hook', 0], 'hook', { x: 540, y: 900 })
    const down = easeInOut(P('bankrupt', 0, 0.1))
    pose(john, { x: lerp(540, 170, down), y: lerp(870, 1700, down), s: lerp(1.35, 0.68, down) })
    john.setMood(current === 'hook' || current === 'bankrupt' ? 'awake' : current === 'outro' ? 'smile' : 'worried')
    stage(worry, ['hook', cue('hook', 1)], 'hook', { x: 700, y: 560 })

    const dIn = clamp(P('bankrupt', 0.1, 0.3))
    pose(dolphin, { x: lerp(1300, 880, easeInOut(dIn)), y: 1700 + 12 * Math.sin(t * 2), s: 1.2, r: 6 * Math.sin(t * 1.1) })

    // what-if page, rows, badges, detail card
    stage(page, ['bankrupt', 0.03], 'unknown', { x: 540, y: 745 })
    const hl = current === 'unknown' ? 'custodian' : current
    rows.forEach(({ id, r, badge }, i) => {
      stage(r, ['bankrupt', 0.08 + i * 0.03], 'unknown', { x: 540, y: 485 + i * 100 })
      r.div.classList.toggle('hl', hl === id)
      const answered = c.after(id, id === 'bankrupt' ? cue('bankrupt', 3) : id === 'custodian' ? cue('custodian', 2) : cue(id, 1))
      badge.style.opacity = answered ? 1 : 0
    })
    stage(DETAIL.bankrupt, ['bankrupt', cue('bankrupt', 2)], 'bankrupt', { x: 540, y: 1070 })
    stage(DETAIL.custodian, ['custodian', cue('custodian', 1)], 'custodian', { x: 540, y: 1070 })
    stage(DETAIL.hack, ['hack', cue('hack', 1)], 'hack', { x: 540, y: 1070 })
    stage(DETAIL.keys, ['keys', cue('keys', 1)], 'keys', { x: 540, y: 1070 })
    stage(DETAIL.unknown, ['unknown', 0.1], 'unknown', { x: 540, y: 1070 })

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
