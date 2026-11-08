#!/bin/bash
# kc-worker.sh — launch one module worker against a prompt file. usage: kc-worker.sh <slug>
# slugs: kart | track | items | art | ui   (see docs/PLAN.md ownership table)
cd /home/hermes/projects/kartclash || exit 2
case "$1" in
  kart)  A="claude-medium"; P="docs/prompts/w1-kart.txt" ;;
  track) A="claude-medium"; P="docs/prompts/w2-track.txt" ;;
  items) A="claude-medium"; P="docs/prompts/w3-items.txt" ;;
  art)   A="free-model";   P="docs/prompts/w4-art.txt" ;;
  ui)    A="free-model";   P="docs/prompts/w5-ui.txt" ;;
  ag)     A="claude-medium"; P="docs/prompts/w6-ag.txt" ;;
  models) A="claude-medium"; P="docs/prompts/w7-models.txt" ;;
  *) echo "unknown slug: $1"; exit 2 ;;
esac
# The prompt is passed through the environment and expanded INSIDE the interactive shell, so its
# content is never re-parsed by the outer shell (quotes, $ and backticks in the text stay literal).
KC_PROMPT="$(cat "$P")" bash -ic "$A --yolo -z \"\$KC_PROMPT\""
