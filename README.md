# x-researcher

X/Twitter の公開検索結果を `twitter` コマンドで取得し、ローカルLLM（Ollama + qwen3:8b）で要約・CSV化するための小さな実験プロジェクトです。

## 現在のコマンド

既存の汎用的な `x search` ではなく、以下の3パターンだけを扱います。

```bash
# 1. codex OR "AI Agent" を人気寄り・latestで30件取得し、コメント傾向/いいね数/閲覧数つきCSVと日本語説明レポートを作る
pnpm ai-trend

# 2. 企業名 AND 企業コードで最新情報を拾い、コメント内容も含めて要約する
pnpm company-latest --companies data/companies.example.csv

# 3. 企業名 AND 企業コードでコメント/リプライ内容の要約を重視する
pnpm company-comments --companies data/companies.example.csv
```

出力先:

- 生データ: `data/raw/*.json`
- CSV: `data/raw/*.csv`
- 実行トレース: `data/raw/*.trace.jsonl`
- 要約: `data/reports/*.md`

方針として、レポート本体（Markdown要約）以外はすべて `data/raw` に保存します。
`company-latest` / `company-comments` は会社ごとに検索・リプライ取得・要約の開始/終了をトレースへ逐次保存するため、長時間実行中に止まった場合も最後に処理していた会社と段階を確認できます。

会社入力ファイルはCSVまたはJSONに対応しています。

```csv
name,code
トヨタ自動車,7203
ソニーグループ,6758
```

主なオプション:

```bash
pnpm start -- ai-trend --limit 30 --min-likes 0 --max-likes 100 --min-retweets 0 --replies-per-tweet 5
pnpm start -- company-latest --companies data/companies.csv --limit-per-company 10 --min-likes 0 --max-likes 100 --min-retweets 0 --replies-per-tweet 3
pnpm start -- company-comments --companies data/companies.csv --limit-per-company 5 --min-likes 0 --max-likes 100 --min-retweets 0 --replies-per-tweet 10
```

人気度の調整:

- `--min-likes`: いいね数の下限。未指定なら0。
- `--max-likes`: いいね数の上限。未指定なら上限なし。
- `--min-retweets`: リツイート数の下限。未指定なら0。

事前確認だけしたい場合は `--dry-run` を付けます。

## 目的

このプロジェクトでは、以下をローカル環境で試します。

- X/Twitter の公開検索結果を取得する
- AIトレンドを要約する
- 大喜利・ネタ探し用に検索結果を分析する
- Ollama + qwen3:8b を使ってローカルLLM要約を行う
- Agent Reach / twitter-cli / pnpm / TypeScript の学習をする

## 全体構成

```text
X公開検索
  ↓
Agent Reach / twitter-cli
  ↓
検索結果を data/raw に保存
  ↓
Ollama qwen3:8b
  ↓
Markdown要約を data/reports に保存
```

## 前提

このREADMEは macOS を前提にしています。

必要なもの:

- Homebrew
- Node.js
- pnpm
- Python / pipx
- Ollama
- Agent Reach
- Xにログイン済みのブラウザ
- Cookie-Editor などのCookieエクスポート用ブラウザ拡張

## 1. Ollama のインストール

Ollamaをまだ入れていない場合:

```bash
brew install ollama
```

Ollamaを起動します。

```bash
ollama serve
```

別ターミナルで qwen3:8b を取得します。

```bash
ollama pull qwen3:8b
```

動作確認します。

```bash
ollama run qwen3:8b
```

以下のように入力して、日本語で返答があればOKです。

```text
日本語で短く自己紹介して
```

API確認:

```bash
curl http://localhost:11434/api/tags
```

JSONが返ればOKです。

## 2. Agent Reach のインストール

Agent Reach は、GitHub / X / YouTube / RSS / Web などの情報収集ツールをまとめて扱いやすくするためのツールです。

公式リポジトリ:

```text
https://github.com/Panniantong/Agent-Reach
```

まず `pipx` を入れます。

```bash
brew install pipx
pipx ensurepath
```

一度ターミナルを開き直してください。

Agent Reach をインストールします。

```bash
pipx install https://github.com/Panniantong/agent-reach/archive/main.zip
```

初期セットアップ:

```bash
agent-reach install --env=auto
```

状態確認:

```bash
agent-reach doctor
```

## 3. Twitter/X チャンネルの追加

X検索を使うため、Twitter/X チャンネルを追加します。

```bash
agent-reach install --env=auto --channels=twitter
```

確認:

```bash
agent-reach doctor
```

`twitter` コマンドが使えるか確認します。

```bash
twitter --help
```

## 4. X Cookie の設定

Xの公開検索でも、Cookieが必要になる場合があります。

### Cookie取得手順

1. Chromeで `https://x.com` を開く
2. Xにログインする
3. Chrome拡張の Cookie-Editor を入れる
4. x.com を開いた状態で Cookie-Editor を開く
5. Export を押す
6. `Header String` 形式でコピーする

出力は以下のような形式です。

```text
auth_token=...; ct0=...; twid=...; guest_id=...;
```

これを Agent Reach に設定します。

```bash
agent-reach configure twitter-cookies "auth_token=...; ct0=...; twid=...;"
```

注意:

Cookieはログイン情報に近いものです。  
GitHub、Slack、ChatGPTなどに貼らないでください。

## 5. X検索の動作確認

まず少量で確認します。

```bash
twitter search "Ollama" -n 5
```

AIトレンド系:

```bash
twitter search "AI Agent" -n 10
twitter search "Claude Code" -n 10
twitter search "local LLM" -n 10
```

大喜利系:

```bash
twitter search "生成AI 大喜利" -n 10
twitter search "エンジニア 大喜利" -n 10
twitter search "画像で一言" -n 10
```

検索結果が表示されればOKです。

## 6. プロジェクト作成

```bash
mkdir -p ~/git/x-researcher
cd ~/git/x-researcher
```

pnpmプロジェクトを作成します。

```bash
pnpm init
```

TypeScript関連を入れます。

```bash
pnpm add -D typescript tsx @types/node
```

ディレクトリを作ります。

```bash
mkdir -p src data/raw data/reports
```

## 7. tsconfig.json

```bash
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
EOF
```

## 8. package.json の設定

`pnpm pkg set` は `:` を含む script 名で失敗する場合があるため、Node.jsで直接編集します。

```bash
node <<'EOF'
const fs = require("fs");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

pkg.type = "module";
pkg.packageManager = "pnpm@11.4.0";

if (pkg.devEngines && pkg.devEngines.packageManager) {
  delete pkg.devEngines.packageManager;
  if (Object.keys(pkg.devEngines).length === 0) {
    delete pkg.devEngines;
  }
}

pkg.scripts = {
  ...(pkg.scripts ?? {}),
  "collect:trend": "pnpm exec tsx src/collect.ts trend 10",
  "collect:ogiri": "pnpm exec tsx src/collect.ts ogiri 10",
  "summarize:trend": "pnpm exec tsx src/summarize.ts data/raw/x-trend-$(date +%F).txt trend",
  "summarize:ogiri": "pnpm exec tsx src/summarize.ts data/raw/x-ogiri-$(date +%F).txt ogiri",
  "trend": "pnpm collect:trend && pnpm summarize:trend",
  "ogiri": "pnpm collect:ogiri && pnpm summarize:ogiri",
  "typecheck": "tsc --noEmit"
};

fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
EOF
```

pnpmのバージョンが違う場合は、確認してから `packageManager` を合わせます。

```bash
pnpm --version
```

例:

```json
"packageManager": "pnpm@11.4.0"
```

## 9. X検索結果を収集する collect.ts

```bash
cat > src/collect.ts <<'EOF'
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Mode = "trend" | "ogiri";

function isMode(value: string): value is Mode {
  return value === "trend" || value === "ogiri";
}

const modeArg = process.argv[2] ?? "trend";
const limitArg = process.argv[3] ?? "10";

if (!isMode(modeArg)) {
  console.error("Usage: pnpm exec tsx src/collect.ts [trend|ogiri] [limit]");
  process.exit(1);
}

const limit = Number(limitArg);

if (!Number.isInteger(limit) || limit <= 0) {
  console.error("limit must be a positive integer");
  process.exit(1);
}

const keywords: Record<Mode, string[]> = {
  trend: [
    "Ollama",
    "Open WebUI",
    "local LLM",
    "AI Agent",
    "Claude Code",
    "Qwen",
  ],
  ogiri: [
    "生成AI 大喜利",
    "AI 大喜利",
    "エンジニア 大喜利",
    "画像で一言",
  ],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function searchTwitter(keyword: string, limit: number): Promise<string> {
  const { stdout } = await execFileAsync("twitter", [
    "search",
    keyword,
    "-n",
    String(limit),
  ]);

  return stdout;
}

async function main(): Promise<void> {
  const mode = modeArg;
  await mkdir("data/raw", { recursive: true });

  const outputPath = `data/raw/x-${mode}-${today()}.txt`;
  let output = "";

  for (const keyword of keywords[mode]) {
    console.log(`Searching: ${keyword}`);

    output += `\n\n# Keyword: ${keyword}\n\n`;

    try {
      const result = await searchTwitter(keyword, limit);
      output += result.trim() ? result : "(no results)";
      output += "\n";
    } catch (error) {
      output += `ERROR: failed to search keyword "${keyword}"\n`;
      output += error instanceof Error ? error.message : String(error);
      output += "\n";
    }
  }

  await writeFile(outputPath, output, "utf-8");
  console.log(`Saved: ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
EOF
```

## 10. qwen3:8b で要約する summarize.ts

```bash
cat > src/summarize.ts <<'EOF'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Mode = "trend" | "ogiri";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

function isMode(value: string): value is Mode {
  return value === "trend" || value === "ogiri";
}

const inputPath = process.argv[2];
const modeArg = process.argv[3] ?? "trend";

if (!inputPath) {
  console.error("Usage: pnpm exec tsx src/summarize.ts <input-file> [trend|ogiri]");
  process.exit(1);
}

if (!isMode(modeArg)) {
  console.error("mode must be 'trend' or 'ogiri'");
  process.exit(1);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const systemPrompt = `
あなたはX検索結果を整理する日本語リサーチ補助です。

必ず守るルール:
- 出力は必ず日本語。
- 入力された検索結果に含まれる情報だけを使う。
- 外部知識で補完しない。
- 入力にない公式情報、価格、ライセンス、性能、コマンド例を断定しない。
- 不明なことは「不明」と書く。
- 投稿本文の丸写しは避ける。
- 英語で出力しない。
- 話を盛らない。
- 事実、推測、要確認事項を分ける。
`.trim();

function buildPrompt(mode: Mode, raw: string): string {
  if (mode === "ogiri") {
    return `
以下はX検索結果です。
大喜利・ネタ作りの参考として日本語で分析してください。

重要:
- 投稿本文の丸写しは避ける。
- 既存投稿のコピーではなく、面白さの型やお題案に変換する。
- 入力にない流行や背景を断定しない。

出力形式:

# X話題まとめ: 大喜利ネタ

## 1. 目立ったネタの型
- 

## 2. 面白さの構造
- 

## 3. 使えそうなお題案
- 

## 4. 自分で投稿するならどうアレンジするか
- 

## 5. 要確認事項
- 

--- X検索結果ここから ---
${raw}
--- X検索結果ここまで ---
`.trim();
  }

  return `
以下はX検索結果です。
AIトレンド調査として日本語で要約してください。

出力形式:

# X話題まとめ: AIトレンド

## 1. 何が話題か
- 

## 2. 入力から確認できた事実
- 

## 3. 推測・未確認情報
- 

## 4. 技術者が次に調べるべきキーワード
- 

## 5. 要確認事項
- 

--- X検索結果ここから ---
${raw}
--- X検索結果ここまで ---
`.trim();
}

async function callOllama(prompt: string): Promise<string> {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen3:8b",
      stream: false,
      options: {
        temperature: 0.2,
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Ollama API error: ${res.status}\n${errorText}`);
  }

  const json = (await res.json()) as OllamaChatResponse;
  const content = json.message?.content;

  if (!content) {
    throw new Error(`No content from Ollama: ${JSON.stringify(json, null, 2)}`);
  }

  return content;
}

async function main(): Promise<void> {
  const raw = await readFile(inputPath, "utf-8");

  if (!raw.trim()) {
    throw new Error(`Input file is empty: ${inputPath}`);
  }

  const mode = modeArg;
  const prompt = buildPrompt(mode, raw);
  const output = await callOllama(prompt);

  await mkdir("data/reports", { recursive: true });

  const baseName = path.basename(inputPath).replace(/\.[^.]+$/, "");
  const outputPath = `data/reports/${baseName}-${mode}-${today()}.md`;

  await writeFile(outputPath, output, "utf-8");

  console.log(`Saved: ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
EOF
```

## 11. 実行方法

AIトレンド:

```bash
pnpm trend
```

大喜利:

```bash
pnpm ogiri
```

個別に実行する場合:

```bash
pnpm collect:trend
pnpm summarize:trend
```

```bash
pnpm collect:ogiri
pnpm summarize:ogiri
```

## 12. 結果を見る

レポート一覧:

```bash
ls -la data/reports
```

最新レポートを見る:

```bash
cat "data/reports/$(ls -t data/reports | head -1)"
```

rawデータを見る:

```bash
ls -la data/raw
cat "data/raw/$(ls -t data/raw | head -1)"
```

## 13. 型チェック

```bash
pnpm typecheck
```

## 14. よくあるエラー

### `tsx: command not found`

`tsx` が入っていません。

```bash
pnpm add -D tsx typescript @types/node
```

または、scriptを `pnpm exec tsx ...` にしてください。

### `twitter: command not found`

Twitter/Xチャンネルが未インストールです。

```bash
agent-reach install --env=auto --channels=twitter
```

確認:

```bash
twitter --help
```

### `twitter search` が失敗する

Cookieが未設定、または期限切れの可能性があります。

```bash
agent-reach configure twitter-cookies "Cookie Header String"
```

CookieはチャットやGitHubに貼らないでください。

### `Ollama API error`

Ollamaが起動していない可能性があります。

```bash
ollama serve
```

確認:

```bash
curl http://localhost:11434/api/tags
```

### qwen3:8b がない

```bash
ollama pull qwen3:8b
```

### pnpm の `packageManager` エラー

`package.json` に以下のような範囲指定があると失敗する場合があります。

```json
"packageManager": "pnpm@^11.4.0"
```

このように正確なバージョンにします。

```json
"packageManager": "pnpm@11.4.0"
```

## 15. 今後の改善案

- キーワードを `config.json` に切り出す
- 重複投稿を除外する
- URLだけの投稿や短すぎる投稿を除外する
- 取得件数をコマンドライン引数で変える
- レポートを日付ごとに保存する
- 毎朝自動実行する
- Open WebUIと連携する
- RSSやGitHubトレンドも同じ仕組みに入れる
- AIトレンドと大喜利でモデルやプロンプトを分ける

## メモ

このプロジェクトでは、LLMに検索そのものを任せず、検索は `twitter-cli`、要約は `Ollama qwen3:8b` に分けています。

理由:

- 取得処理と要約処理を分離できる
- 生データを保存できる
- LLMの出力が怪しい場合に元データを確認できる
- ローカルLLMの学習に向いている
