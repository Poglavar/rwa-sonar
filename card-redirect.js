// card.html?mint=|symbol= shim: looks the token up in cards/index.json and redirects to its static card.
// External (2026-09-23) so the page works under a Content-Security-Policy without inline scripts.
(function () {
    var params = new URLSearchParams(location.search);
    var mint = (params.get('mint') || '').trim();
    var symbol = (params.get('symbol') || '').trim().toLowerCase();
    var msg = document.getElementById('msg');
    if (!mint && !symbol) {
        msg.textContent = 'Add ?mint=<address> or ?symbol=<ticker> to this URL.';
        return;
    }
    msg.textContent = 'Looking up ' + (mint || symbol) + '…';
    fetch('cards/index.json', { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('cards/index.json returned ' + res.status);
        return res.json();
    }).then(function (list) {
        var hit = null;
        for (var i = 0; i < list.length && hit === null; i += 1) {
            if (mint && list[i].mint === mint) hit = list[i];
            else if (symbol && String(list[i].symbol || '').toLowerCase() === symbol) hit = list[i];
        }
        if (hit === null) {
            msg.textContent = 'No card for ' + (mint || symbol) + '.';
            return;
        }
        location.replace('cards/' + encodeURIComponent(hit.slug) + '.html');
    }).catch(function (err) {
        msg.textContent = 'Could not read the card index: ' + err.message;
    });
})();
