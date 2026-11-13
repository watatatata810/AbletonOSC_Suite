#!/bin/bash
# Mac で Finder からダブルクリックして起動する用 (ターミナルが開いてランチャーを起動する)
cd "$(dirname "$0")"
echo "Starting AbletonOSC Suite Launcher..."
npm run start:launcher
