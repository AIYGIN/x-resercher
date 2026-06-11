#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${HERMES_PROFILE:=researcher}"

mkdir -p data

printf '[1/3] Fetching X recent search results...\n'
pnpm exec tsx src/fetch-x.ts

if [[ ! -s data/x-posts.json ]]; then
  echo 'data/x-posts.json was not created or is empty.' >&2
  exit 1
fi

printf '[2/3] Generating digest with Hermes profile: %s...\n' "$HERMES_PROFILE"
prompt_file="$(mktemp)"
trap 'rm -f "$prompt_file"' EXIT

{
  cat <<'PROMPT'
あなたはX投稿のリサーチダイジェスト作成者です。
以下のJSONはX API v2 Recent Searchの取得結果です。

要件:
- 日本語でMarkdownのみを出力する
- 先頭に `# X Daily Digest` を置く
- `## 概要` に3〜5個の箇条書きで全体傾向を書く
- `## トピック別ハイライト` に topic ごとの傾向を書く
- `## 注目ポスト` に重要な投稿を最大10件、URL・投稿者・score・要約・示唆つきで並べる
- `## 次のアクション` に調査・返信・深掘り候補を書く
- 投稿が0件なら、その旨とクエリ改善案を書く
- 架空の事実は足さず、JSONにある情報だけを使う

JSON:
PROMPT
  cat data/x-posts.json
} > "$prompt_file"

hermes --profile "$HERMES_PROFILE" chat -Q -q "$(cat "$prompt_file")" > data/digest.md

if [[ ! -s data/digest.md ]]; then
  echo 'data/digest.md was not created or is empty.' >&2
  exit 1
fi

printf '[3/3] Sending digest to Slack...\n'
pnpm exec tsx src/send-slack.ts

printf 'Done. Digest: %s/data/digest.md\n' "$(pwd)"
