#!/bin/bash
# ============================================================
# iaADN — Firewall setup for the API
# Run as: bash deploy/firewall.sh            (private: SSH tunnel only)
#     or: bash deploy/firewall.sh --public   (HTTPS via Caddy on 80/443)
#
# The API listens on 127.0.0.1:9091 and requires a token. Port 9091 is
# never opened to the internet: reach it through an SSH tunnel, or put a
# reverse proxy with HTTPS in front (see deploy/Caddyfile.example).
# ============================================================

set -e

# Remove the old rule that opened 9091 to everyone (earlier versions of this
# script added it). Harmless if it isn't there.
if sudo iptables -C INPUT -m state --state NEW -p tcp --dport 9091 -j ACCEPT 2>/dev/null; then
  echo "Removing old rule that exposed port 9091..."
  sudo iptables -D INPUT -m state --state NEW -p tcp --dport 9091 -j ACCEPT
  sudo netfilter-persistent save
fi

if [ "$1" = "--public" ]; then
  echo "Opening ports 80 and 443 for Caddy (HTTPS reverse proxy)..."
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save

  echo ""
  echo "Ports 80/443 are open. Next:"
  echo "  1. In the Oracle Cloud console (Networking > VCN > Security Lists),"
  echo "     add ingress rules for TCP 80 and 443. Do NOT add 9091."
  echo "     If an old ingress rule for 9091 exists there, delete it."
  echo "  2. Point a domain at this VPS, install Caddy, and copy"
  echo "     deploy/Caddyfile.example to /etc/caddy/Caddyfile (edit the domain)."
  echo "  3. In data/config.json set \"network\": { \"trustProxy\": true } so rate"
  echo "     limiting uses the real client IP, then restart iaADN."
  echo "  4. Open https://<your-domain>/ and enter the token from:"
  echo "       node src/index.js --show-token"
else
  echo ""
  echo "Port 9091 stays closed to the internet (recommended)."
  echo "If the Oracle Cloud console has an ingress rule for 9091, delete it."
  echo ""
  echo "To use the chat from your own computer, open an SSH tunnel:"
  echo "  ssh -L 9091:localhost:9091 <user>@<YOUR_VPS_IP>"
  echo "then browse to http://localhost:9091 and enter the token from:"
  echo "  node src/index.js --show-token   (run on the VPS)"
  echo ""
  echo "For public HTTPS access instead, re-run with: bash deploy/firewall.sh --public"
fi
