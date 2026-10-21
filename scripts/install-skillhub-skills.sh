#!/usr/bin/env bash
set -u
export PATH="$HOME/.local/bin:$PATH"
DIR="$HOME/.agents/skills"

echo "== install ui-ux-pro-max-zh =="
skillhub install ui-ux-pro-max-zh --namespace org-02qudk26 --dir "$DIR" 2>&1 | tail -15

echo "== 目录 =="
ls -1 "$DIR" | grep -i -E 'ui-ux|pro-max' || echo "（没有）"

echo "== SKILL.md 位置 =="
find "$DIR" -maxdepth 2 -iname 'SKILL.md' -newermt '-10 minutes' 2>/dev/null | head -5
