#!/bin/bash
# ============================================================
# iaADN — Open firewall ports for the API
# Run as: bash deploy/firewall.sh
# ============================================================

set -e

echo "Opening ports for iaADN..."

# Ubuntu firewall (iptables — Oracle Cloud default)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 9091 -j ACCEPT
sudo netfilter-persistent save

echo ""
echo "Port 9091 is now open."
echo ""
echo "IMPORTANT: You also need to open port 9091 in the Oracle Cloud console:"
echo "  1. Go to cloud.oracle.com"
echo "  2. Networking > Virtual Cloud Networks > your VCN"
echo "  3. Security Lists > Default Security List"
echo "  4. Add Ingress Rule:"
echo "     - Source CIDR: 0.0.0.0/0"
echo "     - Destination Port: 9091"
echo "     - Protocol: TCP"
echo ""
echo "After that, access the chat at: http://<YOUR_VPS_IP>:9091"
