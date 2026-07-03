import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OLLAMA_MODEL = "qwen3:8b";
const OLLAMA_URL = "http://localhost:11434/api/chat";
const TWITTER_COMMAND_TIMEOUT_MS = 120_000;
const OLLAMA_TIMEOUT_MS = 300_000;

type Command = "ai-trend" | "company-latest" | "company-comments";

type Tweet = {
  id: string;
  text: string;
  author?: {
    name?: string;
    screenName?: string;
    verified?: boolean;
  };
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    quotes?: number;
    views?: number;
    bookmarks?: number;
  };
  createdAtISO?: string;
  createdAtLocal?: string;
  lang?: string;
  urls?: Array<{ expandedUrl?: string; url?: string }>;
  replies?: Reply[];
  searchQuery?: string;
  companyName?: string;
  companyCode?: string;
};

type Reply = {
  id?: string;
  text?: string;
  author?: {
    name?: string;
    screenName?: string;
  };
  metrics?: Tweet["metrics"];
  createdAtISO?: string;
};

type TwitterSearchResponse = {
  ok?: boolean;
  data?: Tweet[];
  error?: unknown;
};

type TwitterTweetResponse = {
  ok?: boolean;
  data?: {
    tweet?: Tweet;
    replies?: Reply[];
  };
  tweet?: Tweet;
  replies?: Reply[];
};

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
};

type Company = {
  name: string;
  code: string;
};

type Options = Record<string, string | boolean>;

type RunEvent = {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  company?: Company;
  details?: Record<string, unknown>;
};

function usage(exitCode = 0): never {
  const text = `
Usage:
  pnpm start -- ai-trend [--limit 30] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--replies-per-tweet 5] [--dry-run]
  pnpm start -- company-latest --companies data/companies.csv [--limit-per-company 10] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--replies-per-tweet 3] [--dry-run]
  pnpm start -- company-comments --companies data/companies.csv [--limit-per-company 5] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--replies-per-tweet 10] [--dry-run]

Patterns:
  ai-trend         codex OR "AI Agent" を人気寄り・latest で30件取得し、qwen3:8bで要約してCSV化します。
  company-latest   企業名 AND 企業コードを会社ファイルから読み、最新情報とコメントを要約します。
  company-comments 企業名 AND 企業コードを会社ファイルから読み、コメント/リプライ内容の要約を重視します。

Company file format:
  CSV: name,code headerあり、または「企業名,企業コード」の2列。
  JSON: [{"name":"トヨタ自動車","code":"7203"}]
`;
  console.log(text.trim());
  process.exit(exitCode);
}

function parseArgs(argv: string[]): { command: Command; options: Options } {
  const commandRaw = argv[0];

  if (!commandRaw || commandRaw === "help" || commandRaw === "--help" || commandRaw === "-h") {
    usage(0);
  }

  if (!["ai-trend", "company-latest", "company-comments"].includes(commandRaw)) {
    console.error(`Unknown command: ${commandRaw}`);
    usage(1);
  }

  const command = commandRaw as Command;
  const options: Options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      console.error(`Unexpected positional argument: ${arg}`);
      usage(1);
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    if (!rawKey) {
      usage(1);
    }

    if (rawValue !== undefined) {
      options[rawKey] = rawValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[rawKey] = next;
      i += 1;
    } else {
      options[rawKey] = true;
    }
  }

  return { command, options };
}

function optionNumber(options: Options, key: string, defaultValue: number): number {
  const raw = options[key];
  if (raw === undefined || raw === true) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return value;
}

function optionalNumber(options: Options, key: string): number | undefined {
  const raw = options[key];
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${key} requires a value`);

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return value;
}

function optionString(options: Options, key: string, defaultValue?: string): string | undefined {
  const raw = options[key];
  if (raw === undefined) return defaultValue;
  if (raw === true) throw new Error(`--${key} requires a value`);
  return String(raw);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(startedAtMs: number): string {
  return `${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`;
}

function logRunEvent(events: RunEvent[], event: Omit<RunEvent, "at">): void {
  const entry: RunEvent = { at: nowIso(), ...event };
  events.push(entry);
  const company = entry.company ? ` ${entry.company.name}(${entry.company.code})` : "";
  const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  const line = `[${entry.at}] ${entry.level.toUpperCase()}:${company} ${entry.message}${details}`;
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

async function writeRunEvents(tracePath: string, events: RunEvent[]): Promise<void> {
  await writeFile(tracePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

function engagement(tweet: Tweet): number {
  const m = tweet.metrics ?? {};
  return (m.likes ?? 0) + (m.retweets ?? 0) * 2 + (m.replies ?? 0) * 1.5 + (m.quotes ?? 0) * 2 + (m.bookmarks ?? 0);
}

function matchesPopularity(tweet: Tweet, minLikes: number, maxLikes: number | undefined, minRetweets: number): boolean {
  const likes = tweet.metrics?.likes ?? 0;
  const retweets = tweet.metrics?.retweets ?? 0;
  return likes >= minLikes && (maxLikes === undefined || likes <= maxLikes) && retweets >= minRetweets;
}

function describePopularity(minLikes: number, maxLikes: number | undefined, minRetweets: number): string {
  return `minLikes=${minLikes}, maxLikes=${maxLikes ?? "none"}, minRetweets=${minRetweets}`;
}

function tweetUrl(tweet: Tweet): string {
  const screenName = tweet.author?.screenName ?? "i";
  return `https://x.com/${screenName}/status/${tweet.id}`;
}

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function compactTweet(tweet: Tweet): Record<string, unknown> {
  const m = tweet.metrics ?? {};
  const replies = tweet.replies ?? [];
  return {
    createdAt: tweet.createdAtISO ?? tweet.createdAtLocal ?? "",
    author: tweet.author?.screenName ? `@${tweet.author.screenName}` : tweet.author?.name ?? "",
    text: tweet.text.replace(/\s+/g, " ").trim(),
    likes: m.likes ?? 0,
    retweets: m.retweets ?? 0,
    replies: m.replies ?? 0,
    quotes: m.quotes ?? 0,
    views: m.views ?? 0,
    engagement: engagement(tweet),
    replySamples: replies.map((reply) => reply.text?.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5).join(" / "),
    url: tweetUrl(tweet),
  };
}

async function searchTwitter(query: string, max: number, type: "latest" | "top" = "latest"): Promise<Tweet[]> {
  const args = ["search", query, "--type", type, "-n", String(max), "--json", "--full-text"];
  const { stdout } = await execFileAsync("twitter", args, { maxBuffer: 10 * 1024 * 1024, timeout: TWITTER_COMMAND_TIMEOUT_MS });
  const json = JSON.parse(stdout) as TwitterSearchResponse;

  if (!json.ok) {
    throw new Error(`twitter search failed: ${JSON.stringify(json.error ?? json, null, 2)}`);
  }

  return json.data ?? [];
}

async function fetchReplies(tweetId: string, max: number): Promise<Reply[]> {
  if (max <= 0) return [];

  try {
    const { stdout } = await execFileAsync("twitter", ["tweet", tweetId, "-n", String(max), "--json", "--full-text"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: TWITTER_COMMAND_TIMEOUT_MS,
    });
    const json = JSON.parse(stdout) as TwitterTweetResponse;
    return json.data?.replies ?? json.replies ?? [];
  } catch (error) {
    console.warn(`WARN: failed to fetch replies for ${tweetId}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function withReplies(tweets: Tweet[], maxReplies: number): Promise<Tweet[]> {
  if (maxReplies <= 0) return tweets;

  const enriched: Tweet[] = [];
  for (const tweet of tweets) {
    enriched.push({ ...tweet, replies: await fetchReplies(tweet.id, maxReplies) });
  }
  return enriched;
}

async function callOllama(system: string, prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 1200 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `/no_think\n${prompt}` },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status}\n${await res.text()}`);
  }

  const json = (await res.json()) as OllamaChatResponse;
  if (!json.message?.content) {
    throw new Error(`No content from Ollama: ${JSON.stringify(json, null, 2)}`);
  }
  return json.message.content;
}

function systemPrompt(): string {
  return [
    "あなたはX/Twitter検索結果を整理する日本語リサーチ補助です。",
    "入力に含まれる情報だけを使い、外部知識で補完しないでください。",
    "事実、推測、要確認事項を分け、不明なことは不明と書いてください。",
    "投稿本文の丸写しは避け、短く実務向けに要約してください。",
  ].join("\n");
}

async function summarizeAiTrend(tweets: Tweet[]): Promise<string> {
  const rows = tweets.map(compactTweet);
  return callOllama(
    systemPrompt(),
    `以下は「codex OR AI Agent」の人気寄りlatest検索結果です。\n` +
      `必ず日本語で、専門用語を並べるだけでなく「何が起きているか」「なぜ注目されているか」「どの投稿指標からそう言えるか」を説明してください。\n` +
      `30ツイートの傾向、多頻度なコメント/反応、いいね数・閲覧数から見える注目度を説明してください。\n` +
      `出力は「要約」「注目トピック」「コメント/反応の傾向」「いいね数・閲覧数から見える人気度」「CSVの読み方」「要確認事項」に分けてください。\n` +
      `英語の見出しや英語だけの箇条書きは禁止です。入力にない情報は推測せず、不明と書いてください。\n\n` +
      JSON.stringify(rows, null, 2),
  );
}

async function summarizeCompany(company: Company, tweets: Tweet[], focusComments: boolean): Promise<string> {
  return callOllama(
    systemPrompt(),
    `企業名「${company.name}」と企業コード「${company.code}」のAND検索結果です。\n` +
      `最新情報をピックアップし、${focusComments ? "コメント/リプライ内容を重視して" : "コメント/リプライ内容も含めて"}要約してください。\n` +
      `出力は「要点」「確認できた材料」「コメント傾向」「投資判断には使えない未確認点」「次に確認する情報源」に分けてください。\n\n` +
      JSON.stringify(tweets.map(compactTweet), null, 2),
  );
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

async function readCompanies(filePath: string): Promise<Company[]> {
  const text = await readFile(filePath, "utf-8");
  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(text) as Company[];
    return parsed.map((row) => ({ name: String(row.name ?? "").trim(), code: String(row.code ?? "").trim() })).filter((row) => row.name && row.code);
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const first = parseCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const hasHeader = first.includes("name") || first.includes("code") || first.includes("企業名") || first.includes("企業コード");
  const nameIndex = hasHeader ? Math.max(first.indexOf("name"), first.indexOf("企業名")) : 0;
  const codeIndex = hasHeader ? Math.max(first.indexOf("code"), first.indexOf("企業コード")) : 1;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map(parseCsvLine)
    .map((cells) => ({ name: cells[nameIndex]?.trim() ?? "", code: cells[codeIndex]?.trim() ?? "" }))
    .filter((row) => row.name && row.code);
}

async function runAiTrend(options: Options): Promise<void> {
  const limit = optionNumber(options, "limit", 30);
  const minLikes = optionNumber(options, "min-likes", 0);
  const maxLikes = optionalNumber(options, "max-likes");
  const minRetweets = optionNumber(options, "min-retweets", 0);
  const repliesPerTweet = optionNumber(options, "replies-per-tweet", 5);
  const dryRun = options["dry-run"] === true;
  const outDir = optionString(options, "out-dir", "data") ?? "data";
  const query = `(codex OR "AI Agent") -filter:retweets`;

  console.log(`Query: ${query}`);
  console.log(`Mode: latest + post-sort by engagement, limit=${limit}, ${describePopularity(minLikes, maxLikes, minRetweets)}`);
  if (dryRun) return;

  await mkdir(path.join(outDir, "raw"), { recursive: true });
  await mkdir(path.join(outDir, "reports"), { recursive: true });

  const rawTweets = await searchTwitter(query, Math.max(limit * 3, limit), "latest");
  const filtered = rawTweets
    .filter((tweet) => matchesPopularity(tweet, minLikes, maxLikes, minRetweets))
    .sort((a, b) => engagement(b) - engagement(a) || String(b.createdAtISO ?? "").localeCompare(String(a.createdAtISO ?? "")))
    .slice(0, limit);
  if (filtered.length === 0) {
    console.warn("WARN: popularity filters matched 0 tweets. Empty raw/csv files and an empty-input summary will be generated.");
  }
  const tweets = await withReplies(filtered, repliesPerTweet);

  const stamp = today();
  const jsonPath = path.join(outDir, "raw", `ai-trend-${stamp}.json`);
  const csvPath = path.join(outDir, "raw", `ai-trend-${stamp}.csv`);
  const mdPath = path.join(outDir, "reports", `ai-trend-${stamp}.md`);

  await writeFile(jsonPath, JSON.stringify(tweets, null, 2), "utf-8");
  await writeFile(csvPath, toCsv(tweets.map(compactTweet)) + "\n", "utf-8");
  await writeFile(mdPath, await summarizeAiTrend(tweets), "utf-8");

  console.log(`Saved raw: ${jsonPath}`);
  console.log(`Saved csv: ${csvPath}`);
  console.log(`Saved summary: ${mdPath}`);
}

async function runCompany(options: Options, focusComments: boolean): Promise<void> {
  const companiesPath = optionString(options, "companies");
  if (!companiesPath) throw new Error("--companies is required");

  const limitPerCompany = optionNumber(options, "limit-per-company", focusComments ? 5 : 10);
  const minLikes = optionNumber(options, "min-likes", 0);
  const maxLikes = optionalNumber(options, "max-likes");
  const minRetweets = optionNumber(options, "min-retweets", 0);
  const repliesPerTweet = optionNumber(options, "replies-per-tweet", focusComments ? 10 : 3);
  const dryRun = options["dry-run"] === true;
  const outDir = optionString(options, "out-dir", "data") ?? "data";
  const companies = await readCompanies(companiesPath);
  const events: RunEvent[] = [];

  if (companies.length === 0) throw new Error(`No companies found: ${companiesPath}`);

  console.log(`Companies: ${companies.length}`);
  console.log(`Mode: latest + post-sort by engagement, limitPerCompany=${limitPerCompany}, ${describePopularity(minLikes, maxLikes, minRetweets)}`);
  for (const company of companies) {
    console.log(`Query: "${company.name}" ${company.code} -filter:retweets`);
  }
  if (dryRun) return;

  await mkdir(path.join(outDir, "raw"), { recursive: true });
  await mkdir(path.join(outDir, "reports"), { recursive: true });

  const stamp = today();
  const prefix = focusComments ? "company-comments" : "company-latest";
  const jsonPath = path.join(outDir, "raw", `${prefix}-${stamp}.json`);
  const csvPath = path.join(outDir, "raw", `${prefix}-${stamp}.csv`);
  const mdPath = path.join(outDir, "reports", `${prefix}-${stamp}.md`);
  const tracePath = path.join(outDir, "raw", `${prefix}-${stamp}.trace.jsonl`);
  const reportParts: string[] = [`# 企業X検索まとめ ${stamp}`];
  const csvRows: Array<Record<string, unknown>> = [];
  const allTweets: Tweet[] = [];

  logRunEvent(events, {
    level: "info",
    message: "run started",
    details: { companies: companies.length, limitPerCompany, repliesPerTweet, focusComments, outDir },
  });

  for (const [index, company] of companies.entries()) {
    const companyStartedAt = Date.now();
    const query = `"${company.name}" ${company.code} -filter:retweets`;
    logRunEvent(events, {
      level: "info",
      message: "company started",
      company,
      details: { index: index + 1, total: companies.length, query },
    });
    await writeRunEvents(tracePath, events);

    try {
      logRunEvent(events, { level: "info", message: "search started", company, details: { max: Math.max(limitPerCompany * 3, limitPerCompany) } });
      await writeRunEvents(tracePath, events);
      const searched = await searchTwitter(query, Math.max(limitPerCompany * 3, limitPerCompany), "latest");
      logRunEvent(events, { level: "info", message: "search finished", company, details: { count: searched.length } });

      const filtered = searched
        .filter((tweet) => matchesPopularity(tweet, minLikes, maxLikes, minRetweets))
        .sort((a, b) => engagement(b) - engagement(a) || String(b.createdAtISO ?? "").localeCompare(String(a.createdAtISO ?? "")))
        .slice(0, limitPerCompany);
      if (filtered.length === 0) {
        logRunEvent(events, { level: "warn", message: "popularity filters matched 0 tweets", company });
      }

      logRunEvent(events, { level: "info", message: "replies fetch started", company, details: { tweets: filtered.length, repliesPerTweet } });
      await writeRunEvents(tracePath, events);
      const tweets = (await withReplies(filtered, repliesPerTweet)).map((tweet) => ({ ...tweet, companyName: company.name, companyCode: company.code, searchQuery: query }));
      logRunEvent(events, { level: "info", message: "replies fetched", company, details: { tweets: tweets.length, repliesPerTweet } });

      allTweets.push(...tweets);
      csvRows.push(...tweets.map((tweet) => ({ companyName: company.name, companyCode: company.code, ...compactTweet(tweet) })));
      reportParts.push(`\n## ${company.name} (${company.code})\n`);
      logRunEvent(events, { level: "info", message: "summary started", company, details: { tweets: tweets.length } });
      await writeRunEvents(tracePath, events);
      reportParts.push(await summarizeCompany(company, tweets, focusComments));
      logRunEvent(events, { level: "info", message: "summary finished", company, details: { duration: formatDuration(companyStartedAt) } });
    } catch (error) {
      const message = errorMessage(error);
      logRunEvent(events, { level: "error", message: "company failed; continuing with remaining companies", company, details: { error: message } });
      reportParts.push(`\n## ${company.name} (${company.code})\n`);
      reportParts.push(["この企業の処理は失敗しました。", "", `- エラー: ${message}`, `- クエリ: ${query}`, "- 詳細: trace JSONL を確認してください。"].join("\n"));
    }

    await writeRunEvents(tracePath, events);
    await writeFile(jsonPath, JSON.stringify(allTweets, null, 2), "utf-8");
    await writeFile(csvPath, toCsv(csvRows) + "\n", "utf-8");
    await writeFile(mdPath, reportParts.join("\n\n"), "utf-8");
  }

  logRunEvent(events, { level: "info", message: "run finished", details: { tweets: allTweets.length, companies: companies.length } });

  await writeFile(jsonPath, JSON.stringify(allTweets, null, 2), "utf-8");
  await writeFile(csvPath, toCsv(csvRows) + "\n", "utf-8");
  await writeFile(mdPath, reportParts.join("\n\n"), "utf-8");
  await writeRunEvents(tracePath, events);

  console.log(`Saved raw: ${jsonPath}`);
  console.log(`Saved csv: ${csvPath}`);
  console.log(`Saved summary: ${mdPath}`);
  console.log(`Saved trace: ${tracePath}`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "ai-trend") await runAiTrend(options);
  if (command === "company-latest") await runCompany(options, false);
  if (command === "company-comments") await runCompany(options, true);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
