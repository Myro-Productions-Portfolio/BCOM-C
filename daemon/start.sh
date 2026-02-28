#!/bin/bash
# Start the BCOM-C metrics daemon on the DGX Spark.
# Runs in the foreground — use nohup or systemd to daemonize.
#
# Usage:
#   ./start.sh                         # Spark only, port 8090
#   ./start.sh --linux-host windows-pc # + Linux desktop via SSH
#   ./start.sh --port 9000             # Custom port

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/metrics_daemon.py" "$@"
