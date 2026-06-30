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
  console.error("Usage: pnpm tsx src/collect.ts [trend|ogiri] [limit]");
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
