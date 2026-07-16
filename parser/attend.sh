#!/bin/bash
# OEM Raid Attendance Parser - Launcher
# Run this while playing EQ Legends to auto-track raid attendance

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "================================================"
echo "  🌙 Order of the Eternal Moon"
echo "  EQ Legends Raid Attendance Parser"
echo "================================================"
echo ""

node parser/index.js --auto
