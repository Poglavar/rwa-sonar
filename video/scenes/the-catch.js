// Scenes for "The docs say one thing, the chain shows another": a fictional lending market's docs call an admin
// key a co-signer that cannot act alone, the transaction list shows it signing refinances alone, the site's
// "Claim vs observed reality" card puts both side by side with dates, and John saves a watch.
Kit.run((k) => {
  k.background()
  const { clamp, lerp, easeInOut, pose, item, panel, el, group, C } = k

  // hook: the protocol page
  const proto = panel(1000, 400, 'protocols/lanternfish-lend', `
    <h3>Protocol</h3>
    <h2>Lanternfish Lend</h2>
    <p class="sub">Lending market on Solana. Accepts tokenized stocks as collateral.</p>`)
  const accepted = ['AAPL · Oakmere', 'NVDA · Northgate', 'TSLA · Redcliff'].map((name) => {
    const n = item(420, 72, name, 'chip')
    n.div.style.cssText = 'box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:32px;padding:0'
    return n
  })

  // docs: a document page with the quote highlighted
  const doc = group('doc')
  el('rect', { x: -420, y: -380, width: 840, height: 760, rx: 20, fill: '#fff', stroke: C.line, 'stroke-width': 4 }, doc)
  el('path', { d: 'M 340 -380 L 420 -300 L 340 -300 Z', fill: '#efece5', stroke: C.line, 'stroke-width': 4 }, doc)
  k.text(doc, -370, -310, 'Lanternfish docs · Security', 34, C.muted, 'start', 700)
  for (const [y, w] of [[-250, 700], [-210, 640], [-170, 720], [150, 680], [190, 720], [230, 560], [270, 700], [310, 420]]) el('rect', { x: -370, y, width: w, height: 18, rx: 9, fill: '#ebe8e1' }, doc)
  const mark = el('rect', { x: -385, y: -120, width: 770, height: 230, rx: 16, fill: '#fff3b0' }, doc)
  const docQuote = item(740, 220, '<span class="quote" style="font-size:42px">“The admin key is a co-signer. It cannot act on its own.”</span>', '', doc)
  docQuote.setAttribute('opacity', 1)
  docQuote.setAttribute('transform', 'translate(0 -5)')

  // chain: transactions signed by the admin key alone
  const txPanel = panel(1000, 1000, 'protocols/lanternfish-lend#transactions', `
    <h3>Read on Solana</h3>
    <h2 style="font-size:46px">Refinance transactions</h2>`)
  const txs = ['5kQ…w8R', '3nV…p2L', '9aT…m4C', '2hF…x7D'].map((sig) => item(920, 110, `
    <div style="display:flex;justify-content:space-between;align-items:center"><span class="mono">${sig} · refinance</span><span class="badge bad">1 signer</span></div>
    <small>signed by admin key 7Qd…k3F</small>`, 'box'))
  txs.forEach((tx) => { tx.div.style.padding = '10px 24px' })
  const stamp = group('stamp')
  el('rect', { x: -330, y: -60, width: 660, height: 120, rx: 18, fill: 'rgba(255,255,255,0.9)', stroke: C.coral, 'stroke-width': 10 }, stamp)
  k.text(stamp, 0, 20, 'No second signature', 56, C.accent)

  // side: the discrepancy card
  const card = panel(1000, 1000, 'protocols/lanternfish-lend#discrepancies', `
    <h3>Claim vs observed reality</h3>
    <p class="sub" style="margin-bottom:22px">Published claim differs from observed reality</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div class="box" style="justify-content:flex-start;height:640px"><span class="badge info" style="align-self:flex-start">Published claim</span>
        <span class="quote" style="font-size:42px">“The admin key is a co-signer. It cannot act on its own.”</span>
        <small>Lanternfish docs · read 23 Sep 2026</small></div>
      <div class="box" style="justify-content:flex-start;height:640px"><span class="badge bad" style="align-self:flex-start">Observed reality</span>
        <b style="font-size:42px">The admin key signs refinances alone.</b>
        <span class="mono">4 of 4 transactions · 1 signer</span>
        <small>Solana transactions · observed 23 Sep 2026</small></div>
    </div>`)

  // why: one key over John's loan
  const why = item(640, 520, `
    <span class="chip" style="font-size:32px;align-self:flex-start">John’s collateral</span>
    <b style="font-size:40px">↓ Lanternfish Lend loan</b>
    <div style="display:flex;align-items:center;gap:18px;margin-top:18px"><span style="font-size:72px">🔑</span><b style="font-size:42px;color:var(--accent)">One key can refinance it alone</b></div>`, 'box')

  // watch: saved watch and a daily digest message
  const watch = panel(1000, 520, 'watch.html', `
    <h3>Watch</h3>
    <h2 style="font-size:46px">Lanternfish Lend market</h2>
    <p class="sub">Baseline recorded. Reports material changes to documents and keys.</p>
    <div style="margin-top:20px;display:flex;gap:16px;align-items:center"><span class="badge good">✓ Watching</span><span class="badge info">Daily digest on Telegram</span></div>`)
  const digest = item(820, 300, `
    <small>Telegram · RWA Sonar daily digest · example</small>
    <b style="font-size:38px">1 change on a watched market</b>
    <span>Lanternfish Lend · admin key changed</span>
    <small>before → after, with the transaction</small>`, 'box')
  digest.div.style.borderRadius = '34px'

  const john = k.john()
  const dolphin = k.dolphin('scout')
  const caption = k.caption()
  const outro = k.endCard(['What they say, and what', 'the chain shows. Side by side.'])

  return (c) => {
    const { t, P, stage, cue, current } = c

    const inWhy = easeInOut(P('why', 0, 0.12)) * (1 - easeInOut(P('watch', 0, 0.12)))
    pose(john, { x: lerp(170, 210, inWhy), y: lerp(1700, 900, inWhy), s: lerp(0.68, 1.3, inWhy) })
    john.setMood(current === 'why' ? 'worried' : 'smile')
    const dIn = clamp(P('hook', 0.1, 0.4))
    pose(dolphin, { x: lerp(1300, 850, easeInOut(dIn)), y: 1700 + 14 * Math.sin(t * 2.2), s: 0.95, r: -4 + 3 * Math.sin(t * 1.3) })

    stage(proto, ['hook', 0.03], 'hook', { x: 540, y: 420 })
    accepted.forEach((a, i) => stage(a, ['hook', 0.35 + i * 0.1], 'hook', { x: 540, y: 760 + i * 110 }))

    stage(doc, ['docs', 0.03], 'docs', { x: 540, y: 740 })
    const hi = easeInOut(clamp((t - c.at('docs', cue('docs', 1))) / 0.6))
    mark.setAttribute('width', 770 * hi)

    stage(txPanel, ['chain', 0.03], 'chain', { x: 540, y: 700 })
    txs.forEach((tx, i) => stage(tx, ['chain', 0.12 + i * 0.06], 'chain', { x: 540, y: 470 + i * 135 }))
    stage(stamp, ['chain', cue('chain', 2)], 'chain', { x: 540, y: 1080, r: -4 })

    stage(card, ['side', 0.03], 'side', { x: 540, y: 700 })

    stage(why, ['why', cue('why', 1)], 'why', { x: 690, y: 600 })

    stage(watch, ['watch', 0.03], 'watch', { x: 540, y: 470 })
    stage(digest, ['watch', cue('watch', 1)], 'watch', { x: 540, y: 1060 })

    stage(outro, ['outro', 0.05], 'outro', { x: 540, y: 680 })
    c.setCaption(caption)
  }
})
