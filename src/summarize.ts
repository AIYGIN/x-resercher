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
  console.error("Usage: pnpm tsx src/summarize.ts <input-file> [trend|ogiri]");
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
