#!/usr/bin/env bash
# Install the versioned rwasonar.com nginx site and headers snippet on host `prod-de`, test the whole
# nginx config, and reload only if the test passes (the host serves other sites too). Keeps a
# timestamped backup of whatever was installed before.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ssh prod-de "cp /etc/nginx/sites-available/rwasonar /root/rwasonar.nginx.bak-$STAMP && cp /etc/nginx/snippets/rwasonar-headers.conf /root/rwasonar-headers.bak-$STAMP 2>/dev/null || true"
scp -q "$HERE/rwasonar.conf" prod-de:/etc/nginx/sites-available/rwasonar
scp -q "$HERE/rwasonar-headers.conf" prod-de:/etc/nginx/snippets/rwasonar-headers.conf
if ssh prod-de "nginx -t"; then
    ssh prod-de "systemctl reload nginx" && echo "nginx reloaded (backups: /root/*.bak-$STAMP)"
else
    echo "nginx -t failed — restoring the previous files" >&2
    ssh prod-de "cp /root/rwasonar.nginx.bak-$STAMP /etc/nginx/sites-available/rwasonar; cp /root/rwasonar-headers.bak-$STAMP /etc/nginx/snippets/rwasonar-headers.conf 2>/dev/null; nginx -t"
    exit 1
fi
