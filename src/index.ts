import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OLLAMA_MODEL = "qwen3:8b";
const OLLAMA_URL = "http://localhost:11434/api/chat";
const TWITTER_COMMAND_TIMEOUT_MS = 120_000;
const TWITTER_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.TWITTER_RATE_LIMIT_MAX_ATTEMPTS ?? 3);
const TWITTER_RATE_LIMIT_SLEEP_MS = Number(process.env.TWITTER_RATE_LIMIT_SLEEP_MS ?? 60_000);
const OLLAMA_TIMEOUT_MS = 300_000;
const DEFAULT_SENTIMENT_URL = "http://127.0.0.1:8000/analyze";
const SENTIMENT_TIMEOUT_MS = 30_000;

type Command = "ai-trend" | "company-latest" | "company-summary-csv";

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
  parentTweetId?: string;
  parentTweetUrl?: string;
  companyName?: string;
  companyCode?: string;
};

type TwitterSearchResponse = {
  ok?: boolean;
  data?: Tweet[];
  error?: unknown;
};

type TwitterTweetResponse = {
  ok?: boolean;
  data?:
    | Array<Tweet | Reply>
    | {
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

type CompanySummary = {
  companyName: string;
  companyCode: string;
  tweetSummary: string;
  commentSummary: string;
  investmentIssues: string;
  investmentHints: string;
  summaryEvidence: string;
};

type SentimentSummary = {
  enabled: boolean;
  score0To100?: number;
  averageRawScore?: number;
  analyzedCount: number;
  failedCount: number;
  error?: string;
};

type SentimentResponse = {
  score?: number;
  sentiment?: { score?: number };
  result?: { score?: number };
};

function usage(exitCode = 0): never {
  const text = `
Usage:
  pnpm start -- ai-trend [--limit 30] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--replies-per-tweet 5] [--dry-run]
  pnpm start -- company-latest --companies data/companies.csv [--limit-per-company 10] [--company-concurrency 3] [--with-replies] [--replies-per-tweet 10] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--sentiment] [--sentiment-url http://127.0.0.1:8000/analyze] [--dry-run]
  pnpm start -- company-summary-csv --companies data/companies.csv [--limit-per-company 10] [--company-concurrency 3] [--with-replies] [--replies-per-tweet 10] [--min-likes 0] [--max-likes N] [--min-retweets 0] [--sentiment] [--sentiment-url http://127.0.0.1:8000/analyze] [--dry-run]

Patterns:
  ai-trend         codex OR "AI Agent" を人気寄り・latest で30件取得し、qwen3:8bで要約してCSV化します。
  company-latest   企業名 AND 企業コードを会社ファイルから読み、最新情報・コメント・任意の感情スコアを固定フォーマットで要約します。

Company file format:
  CSV: name,code headerあり、または「企業名,企業コード」の2列。
  JSON: [{"name":"トヨタ自動車","code":"7203"}]
`;
  console.log(text.trim());
  process.exit(exitCode);
}

function parseArgs(argv: string[]): { command: Command; options: Options } {
  const normalizedArgs = argv[0] === "--" ? argv.slice(1) : argv;
  const commandRaw = normalizedArgs[0];

  if (!commandRaw || commandRaw === "help" || commandRaw === "--help" || commandRaw === "-h") {
    usage(0);
  }

  if (!["ai-trend", "company-latest", "company-summary-csv"].includes(commandRaw)) {
    console.error(`Unknown command: ${commandRaw}`);
    usage(1);
  }

  const command = commandRaw as Command;
  const options: Options = {};
  for (let i = 1; i < normalizedArgs.length; i += 1) {
    const arg = normalizedArgs[i];
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ExecLikeError = Error & { stdout?: string; stderr?: string };

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as ExecLikeError;
    return [error.message, execError.stdout, execError.stderr].filter(Boolean).join("\n");
  }
  return String(error);
}

function isTwitterRateLimit(text: string): boolean {
  return /rate limited|429/i.test(text);
}

async function execTwitter(args: string[], _context: string): Promise<string> {
  const { stdout } = await execFileAsync("twitter", args, { maxBuffer: 10 * 1024 * 1024, timeout: TWITTER_COMMAND_TIMEOUT_MS });
  return stdout;
}

async function withTwitterRateLimitRetry<T>(context: string, operation: () => Promise<T>): Promise<T> {
  const maxAttempts = Math.max(1, Number.isFinite(TWITTER_RATE_LIMIT_MAX_ATTEMPTS) ? TWITTER_RATE_LIMIT_MAX_ATTEMPTS : 3);
  const sleepMs = Math.max(0, Number.isFinite(TWITTER_RATE_LIMIT_SLEEP_MS) ? TWITTER_RATE_LIMIT_SLEEP_MS : 60_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const details = errorDetails(error);
      if (isTwitterRateLimit(details) && attempt < maxAttempts) {
        console.warn(`WARN: twitter rate limited during ${context}. sleeping ${(sleepMs / 1000).toFixed(0)}s before retry ${attempt + 1}/${maxAttempts}`);
        await sleep(sleepMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`twitter ${context} failed after ${maxAttempts} attempts`);
}

async function writeRunEvents(tracePath: string, events: RunEvent[]): Promise<void> {
  await writeFile(tracePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

async function appendRunEvent(tracePath: string, event: RunEvent): Promise<void> {
  await appendFile(tracePath, JSON.stringify(event) + "\n", "utf-8");
}

function logRunEvent(events: RunEvent[], event: Omit<RunEvent, "at">): RunEvent {
  const entry: RunEvent = { at: nowIso(), ...event };
  events.push(entry);
  const company = entry.company ? ` ${entry.company.name}(${entry.company.code})` : "";
  const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  const line = `[${entry.at}] ${entry.level.toUpperCase()}:${company} ${entry.message}${details}`;
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
  return entry;
}

function createRunLogger(events: RunEvent[], tracePath?: string): (event: Omit<RunEvent, "at">) => Promise<void> {
  return async (event: Omit<RunEvent, "at">) => {
    const entry = logRunEvent(events, event);
    if (tracePath) await appendRunEvent(tracePath, entry);
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function safePathSegment(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
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

function normalizeCsvText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const normalized = normalizeCsvText(text);
  return `"${normalized.replaceAll('"', '""')}"`;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function compactSummaryRowForCsv(summaryRow: Record<string, unknown>): Record<string, unknown> {
  const parseScore = (value: unknown): number | "" => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : "";
    }
    return "";
  };

  return {
    companyName: summaryRow.companyName ?? "",
    companyCode: summaryRow.companyCode ?? "",
    tweetSummary: summaryRow.tweetSummary ?? "",
    commentSummary: summaryRow.commentSummary ?? "",
    investmentIssues: summaryRow.investmentIssues ?? "",
    investmentHints: summaryRow.investmentHints ?? "",
    tweetSentimentScore: parseScore(summaryRow.tweetSentimentScore0To100 ?? summaryRow.tweetSentimentScore),
    commentSentimentScore: parseScore(summaryRow.commentSentimentScore0To100 ?? summaryRow.commentSentimentScore),
  };
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function parseSentimentScoreFromText(text: string): number | "" {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/(\d+)(?:\/100)?/);
  return match ? Number(match[1]) : "";
}

function parseReportMarkdownToSummaryRow(markdown: string): Record<string, unknown> | null {
  const lines = markdown.split(/\r?\n/);
  const tableLines = lines.filter((line) => line.trim().startsWith("|"));
  if (tableLines.length < 3) return null;

  const headerCells = parseMarkdownTableRow(tableLines[0]);
  const dataCells = parseMarkdownTableRow(tableLines[2]);
  if (headerCells.length === 0 || dataCells.length === 0 || headerCells.length !== dataCells.length) return null;

  const row = Object.fromEntries(headerCells.map((header, index) => [header, dataCells[index] ?? ""]));
  return {
    companyName: row["会社名"] ?? "",
    companyCode: row["会社コード"] ?? "",
    tweetSummary: row["ツイート要約"] ?? "",
    commentSummary: row["コメント要約"] ?? "",
    investmentIssues: row["投資判断の課題"] ?? "",
    investmentHints: row["投資判断のヒント"] ?? "",
    tweetSentimentScore0To100: parseSentimentScoreFromText(String(row["ツイート感情スコア"] ?? "")),
    commentSentimentScore0To100: parseSentimentScoreFromText(String(row["コメント感情スコア"] ?? "")),
  };
}

async function writeSummaryCsvsFromReports(reportsDir: string, outDir: string): Promise<void> {
  const csvDir = path.join(outDir, "reports", "csv");
  await mkdir(csvDir, { recursive: true });

  const reportEntries = (await readdir(reportsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.startsWith("company-latest-") && !entry.name.endsWith("-index.md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (reportEntries.length === 0) {
    throw new Error(`No company report markdown files found in ${reportsDir}`);
  }

  await Promise.all(
    reportEntries.map(async (entry) => {
      const reportPath = path.join(reportsDir, entry.name);
      const markdown = await readFile(reportPath, "utf-8");
      const summaryRow = parseReportMarkdownToSummaryRow(markdown);
      if (!summaryRow || !summaryRow.companyCode) return;

      const companyCode = String(summaryRow.companyCode).trim();
      const outputPath = path.join(csvDir, `${safePathSegment(companyCode)}-aisummary.csv`);
      await writeFile(outputPath, toCsv([compactSummaryRowForCsv(summaryRow as Record<string, unknown>)]) + "\n", "utf-8");
    }),
  );
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
    fetchedCommentCount: replies.length,
    replySamples: replies.map((reply) => reply.text?.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5).join(" / "),
    url: tweetUrl(tweet),
  };
}

function replyUrl(reply: Reply): string {
  if (!reply.id) return reply.parentTweetUrl ?? "";
  const screenName = reply.author?.screenName ?? "i";
  return `https://x.com/${screenName}/status/${reply.id}`;
}

function compactReply(reply: Reply): Record<string, unknown> {
  const m = reply.metrics ?? {};
  return {
    parentTweetId: reply.parentTweetId ?? "",
    parentTweetUrl: reply.parentTweetUrl ?? "",
    companyName: reply.companyName ?? "",
    companyCode: reply.companyCode ?? "",
    createdAt: reply.createdAtISO ?? "",
    author: reply.author?.screenName ? `@${reply.author.screenName}` : reply.author?.name ?? "",
    text: (reply.text ?? "").replace(/\s+/g, " ").trim(),
    likes: m.likes ?? 0,
    retweets: m.retweets ?? 0,
    replies: m.replies ?? 0,
    quotes: m.quotes ?? 0,
    views: m.views ?? 0,
    url: replyUrl(reply),
  };
}

function flattenReplies(tweets: Tweet[]): Reply[] {
  return tweets.flatMap((tweet) =>
    (tweet.replies ?? []).map((reply) => ({
      ...reply,
      parentTweetId: tweet.id,
      parentTweetUrl: tweetUrl(tweet),
      companyName: tweet.companyName,
      companyCode: tweet.companyCode,
    })),
  );
}

async function searchTwitter(query: string, max: number, type: "latest" | "top" = "latest"): Promise<Tweet[]> {
  const args = ["search", query, "--type", type, "-n", String(max), "--json", "--full-text"];
  return withTwitterRateLimitRetry(`search ${query}`, async () => {
    const stdout = await execTwitter(args, `search ${query}`);
    const json = JSON.parse(stdout) as TwitterSearchResponse;

    if (!json.ok) {
      throw new Error(`twitter search failed: ${JSON.stringify(json.error ?? json, null, 2)}`);
    }

    return json.data ?? [];
  });
}

function extractTweetReplies(json: TwitterTweetResponse, parentTweetId: string): Reply[] {
  if (Array.isArray(json.data)) {
    return json.data
      .filter((item) => item.id && item.id !== parentTweetId)
      .map((item) => item as Reply);
  }
  if (json.data && !Array.isArray(json.data) && "replies" in json.data) return json.data.replies ?? [];
  return json.replies ?? [];
}

async function fetchReplies(tweetId: string, max: number): Promise<Reply[]> {
  if (max <= 0) return [];

  try {
    return await withTwitterRateLimitRetry(`tweet ${tweetId}`, async () => {
      const stdout = await execTwitter(["tweet", tweetId, "-n", String(max), "--json", "--full-text"], `tweet ${tweetId}`);
      const json = JSON.parse(stdout) as TwitterTweetResponse;
      return extractTweetReplies(json, tweetId);
    });
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

async function callOllama(system: string, prompt: string, jsonMode = false): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      ...(jsonMode ? { format: "json" } : {}),
      options: { temperature: 0.2, num_predict: jsonMode ? 4096 : 1200 },
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

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function compactTweetForSummary(tweet: Tweet): Record<string, unknown> {
  const compact = compactTweet(tweet);
  return {
    ...compact,
    text: truncateText(String(compact.text), 220),
    replySamples: truncateText(String(compact.replySamples), 240),
  };
}

function compactReplyForSummary(reply: Reply): Record<string, unknown> {
  const compact = compactReply(reply);
  return {
    ...compact,
    text: truncateText(String(compact.text), 220),
  };
}

function formatTweetEvidence(tweet: Tweet): string {
  const m = tweet.metrics ?? {};
  return `${truncateText(tweet.text, 80)}（likes=${m.likes ?? 0}, retweets=${m.retweets ?? 0}, replies=${m.replies ?? 0}, Xリンク: ${tweetUrl(tweet)}）`;
}

function deterministicCompanySummary(company: Company, tweets: Tweet[], comments: Reply[] = [], reason?: string): CompanySummary {
  const rankedTweets = [...tweets].sort((a, b) => engagement(b) - engagement(a)).slice(0, 3);
  const rankedComments = [...comments]
    .filter((comment) => (comment.text ?? "").trim())
    .sort((a, b) => ((b.metrics?.likes ?? 0) + (b.metrics?.retweets ?? 0) * 2) - ((a.metrics?.likes ?? 0) + (a.metrics?.retweets ?? 0) * 2))
    .slice(0, 5);
  const tweetEvidenceLines = rankedTweets.map((tweet, index) => `- ツイート${index + 1}: ${formatTweetEvidence(tweet)}`);
  const commentEvidenceLines = rankedComments.map((comment, index) => `- コメント${index + 1}: ${truncateText(comment.text ?? "", 90)}（likes=${comment.metrics?.likes ?? 0}, Xリンク: ${replyUrl(comment) || comment.parentTweetUrl || "不明"}）`);
  const evidenceLines = [...tweetEvidenceLines, ...commentEvidenceLines];
  const reasonNote = reason ? `AI要約が不安定だったため、取得済み投稿・コメントrawから機械的に生成しました（${reason}）。` : "取得済み投稿・コメントrawから機械的に生成しました。";

  const tweetSummary = rankedTweets.length > 0
    ? truncateText(rankedTweets.map((tweet) => truncateText(tweet.text, 45)).join(" / "), 100)
    : "不明";
  const commentSummary = rankedComments.length > 0
    ? truncateText(rankedComments.map((comment) => truncateText(comment.text ?? "", 35)).join(" / "), 100)
    : "取得コメントなし";

  return {
    companyName: company.name,
    companyCode: company.code,
    tweetSummary,
    commentSummary,
    investmentIssues: "X投稿とコメントだけでは業績、適時開示、決算、需給、ニュース原文を確認できません。投資判断には一次情報の確認が必要です。",
    investmentHints: rankedTweets.length > 0 || rankedComments.length > 0 ? "反応が大きい投稿・コメントのURL、投稿日時、指標を起点に、会社開示・ニュース原文・株価出来高を確認してください。" : "検索条件を広げるか、企業名・証券コードを確認してください。",
    summaryEvidence: [`- 要約: ${reasonNote}`, ...evidenceLines].join("\n"),
  };
}

function normalizeSummaryField(value: unknown, fallback = "不明", maxChars?: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  const normalized = text.length > 0 ? text : fallback;
  return maxChars === undefined ? normalized : truncateText(normalized, maxChars);
}

function isUnknownSummary(summary: CompanySummary): boolean {
  const fields = [summary.tweetSummary, summary.commentSummary, summary.investmentIssues, summary.investmentHints, summary.summaryEvidence];
  return fields.every((field) => /^(不明|取得コメントなし|正確ではない可能性があります)\s*$/u.test(field.trim()));
}

function parseCompanySummary(company: Company, text: string, tweets: Tweet[], comments: Reply[]): CompanySummary {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<CompanySummary>;
    const summary = {
      companyName: company.name,
      companyCode: company.code,
      tweetSummary: normalizeSummaryField(parsed.tweetSummary ?? parsed["ツイート要約" as keyof CompanySummary] ?? parsed["tweet要約" as keyof CompanySummary], "不明", 100),
      commentSummary: normalizeSummaryField(parsed.commentSummary ?? parsed["コメント要約" as keyof CompanySummary], comments.length > 0 ? "不明" : "取得コメントなし", 100),
      investmentIssues: normalizeSummaryField(parsed.investmentIssues ?? parsed["投資判断の課題" as keyof CompanySummary]),
      investmentHints: normalizeSummaryField(parsed.investmentHints ?? parsed["投資判断のヒント" as keyof CompanySummary]),
      summaryEvidence: normalizeSummaryField(parsed.summaryEvidence ?? parsed["要約の根拠" as keyof CompanySummary]),
    };
    if (isUnknownSummary(summary)) {
      console.warn(`WARN: company summary JSON was uninformative for ${company.name}(${company.code}); using deterministic fallback summary`);
      return deterministicCompanySummary(company, tweets, comments, "AI要約が不明のみを返しました");
    }
    return summary;
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`WARN: company summary JSON was invalid for ${company.name}(${company.code}); using deterministic fallback summary: ${message}`);
    return deterministicCompanySummary(company, tweets, comments, message);
  }
}

function cleanLlmSummary(text: string, fallback: string): string {
  const cleaned = text
    .trim()
    .replace(/^```(?:json|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^要約[:：]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  if (!cleaned || /^(不明|なし|null)$/i.test(cleaned)) return fallback;
  if (/以下は|提供された|整理した|分析です|参考になります|^#+\s|---/.test(cleaned)) return fallback;
  return truncateText(cleaned, 100);
}

async function summarizeTextGroup(label: "ツイート" | "コメント", rows: Array<Record<string, unknown>>, fallback: string): Promise<string> {
  const texts = rows
    .map((row) => String(row.text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  if (texts.length === 0) return fallback;
  try {
    const response = await callOllama(
      systemPrompt(),
      `${label}本文に何が書かれているかだけを、日本語100字以内で要約してください。\n` +
        `投資分析、外部知識、日付の推測、前置きは禁止です。\n` +
        `「以下は」「提供された」「分析」「参考」のようなメタ説明は禁止です。\n` +
        `箇条書き・Markdown・JSONは禁止。要約文だけを1文で返してください。\n\n` +
        JSON.stringify(texts, null, 2),
      false,
    );
    return cleanLlmSummary(response, fallback);
  } catch (error) {
    console.warn(`WARN: failed to summarize ${label}; using deterministic fallback summary: ${errorMessage(error)}`);
    return fallback;
  }
}

async function summarizeCompany(company: Company, tweets: Tweet[], comments: Reply[]): Promise<CompanySummary> {
  const fallback = deterministicCompanySummary(company, tweets, comments, tweets.length === 0 ? "対象投稿なし" : undefined);
  if (tweets.length === 0) return fallback;

  const tweetSummary = await summarizeTextGroup("ツイート", tweets.map(compactTweetForSummary), fallback.tweetSummary);
  const commentSummary = await summarizeTextGroup("コメント", comments.map(compactReplyForSummary), fallback.commentSummary);

  return {
    ...fallback,
    tweetSummary,
    commentSummary,
  };
}

function tweetTexts(tweets: Tweet[]): string[] {
  return tweets
    .map((tweet) => tweet.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function replyTexts(comments: Reply[]): string[] {
  return comments
    .map((reply) => (reply.text ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractSentimentScore(json: SentimentResponse): number | undefined {
  const score = json.score ?? json.sentiment?.score ?? json.result?.score;
  return typeof score === "number" && Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : undefined;
}

async function analyzeSentiment(texts: string[], sentimentUrl: string): Promise<SentimentSummary> {
  if (texts.length === 0) return { enabled: true, analyzedCount: 0, failedCount: 0, error: "分析対象コメントなし" };

  const scores: number[] = [];
  let failedCount = 0;
  for (const text of texts) {
    try {
      const res = await fetch(sentimentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(SENTIMENT_TIMEOUT_MS),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`sentiment API error: ${res.status} ${await res.text()}`);
      const score = extractSentimentScore((await res.json()) as SentimentResponse);
      if (score === undefined) throw new Error("sentiment API response does not include score");
      scores.push(score);
    } catch (error) {
      failedCount += 1;
      console.warn(`WARN: failed to analyze sentiment: ${errorMessage(error)}`);
    }
  }

  if (scores.length === 0) {
    return { enabled: true, analyzedCount: 0, failedCount, error: "有効な感情スコアなし" };
  }

  const averageRawScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const score0To100 = Math.round((averageRawScore + 1) * 50);
  return { enabled: true, score0To100, averageRawScore: Number(averageRawScore.toFixed(4)), analyzedCount: scores.length, failedCount };
}

function formatSentiment(sentiment: SentimentSummary): string {
  if (!sentiment.enabled) return "未実行（--sentiment 未指定）";
  if (sentiment.score0To100 === undefined) return `不明（${sentiment.error ?? "スコアなし"}、成功${sentiment.analyzedCount}件/失敗${sentiment.failedCount}件）`;
  return `${sentiment.score0To100}/100（平均raw=${sentiment.averageRawScore}、成功${sentiment.analyzedCount}件/失敗${sentiment.failedCount}件）`;
}

function markdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function sourceUrls(tweets: Tweet[]): string[] {
  return [...new Set(tweets.map(tweetUrl).filter(Boolean))];
}

function completeSummaryEvidence(summaryEvidence: string, tweets: Tweet[]): string {
  const cleaned = summaryEvidence.trim();
  if (cleaned.length > 0) return cleaned;

  const urls = sourceUrls(tweets).slice(0, 5);
  if (urls.length === 0) return "不明";
  return ["取得済みX投稿URL:", ...urls.map((url) => `- ${url}`)].join("\n");
}

function formatCompanyReport(summary: CompanySummary, tweetSentiment: SentimentSummary, commentSentiment: SentimentSummary, tweets: Tweet[]): string {
  const completedSummaryEvidence = completeSummaryEvidence(summary.summaryEvidence, tweets);
  const headers = ["会社名", "会社コード", "ツイート要約", "コメント要約", "投資判断の課題", "投資判断のヒント", "ツイート感情スコア", "コメント感情スコア"];
  const values = [
    summary.companyName,
    summary.companyCode,
    summary.tweetSummary,
    summary.commentSummary,
    summary.investmentIssues,
    summary.investmentHints,
    formatSentiment(tweetSentiment),
    formatSentiment(commentSentiment),
  ];
  return [
    `# ${summary.companyName} (${summary.companyCode})`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    `| ${values.map(markdownTableCell).join(" | ")} |`,
    "",
    "# 要約の根拠",
    "",
    completedSummaryEvidence,
  ].join("\n");
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
  const query = `(codex OR "AI Agent") -filter:nativeretweets -filter:links min_retweets:5 min_faves:10`;

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

type CompanyResult = {
  company: Company;
  tweets: Tweet[];
  comments: Reply[];
  csvRows: Array<Record<string, unknown>>;
  commentRows: Array<Record<string, unknown>>;
  reportPath: string;
  reportBody: string;
  summaryRow: Record<string, unknown>;
  error?: string;
};

async function processCompany(params: {
  company: Company;
  index: number;
  total: number;
  prefix: string;
  stamp: string;
  reportsDir: string;
  limitPerCompany: number;
  minLikes: number;
  maxLikes?: number;
  minRetweets: number;
  repliesPerTweet: number;
  sentimentEnabled: boolean;
  sentimentUrl: string;
  log: (event: Omit<RunEvent, "at">) => Promise<void>;
}): Promise<CompanyResult> {
  const {
    company,
    index,
    total,
    prefix,
    stamp,
    reportsDir,
    limitPerCompany,
    minLikes,
    maxLikes,
    minRetweets,
    repliesPerTweet,
    sentimentEnabled,
    sentimentUrl,
    log,
  } = params;
  const companyStartedAt = Date.now();
  const query = `"${company.name}" ${company.code} -filter:nativeretweets`;
  const reportPath = path.join(reportsDir, `${prefix}-${stamp}-${safePathSegment(company.code)}-${safePathSegment(company.name)}.md`);

  await log({
    level: "info",
    message: "company started",
    company,
    details: { index: index + 1, total, query },
  });

  try {
    await log({ level: "info", message: "search started", company, details: { max: Math.max(limitPerCompany * 3, limitPerCompany) } });
    const searched = await searchTwitter(query, Math.max(limitPerCompany * 3, limitPerCompany), "latest");
    await log({ level: "info", message: "search finished", company, details: { count: searched.length } });

    const filtered = searched
      .filter((tweet) => matchesPopularity(tweet, minLikes, maxLikes, minRetweets))
      .sort((a, b) => engagement(b) - engagement(a) || String(b.createdAtISO ?? "").localeCompare(String(a.createdAtISO ?? "")))
      .slice(0, limitPerCompany);
    if (filtered.length === 0) {
      await log({ level: "warn", message: "popularity filters matched 0 tweets", company });
    }

    await log({ level: "info", message: "replies fetch started", company, details: { tweets: filtered.length, repliesPerTweet } });
    const tweets = (await withReplies(filtered, repliesPerTweet)).map((tweet) => ({ ...tweet, companyName: company.name, companyCode: company.code, searchQuery: query }));
    const comments = flattenReplies(tweets);
    await log({ level: "info", message: "replies fetched", company, details: { tweets: tweets.length, comments: comments.length, repliesPerTweet } });

    await log({ level: "info", message: "summary started", company, details: { tweets: tweets.length, comments: comments.length } });
    const summary = await summarizeCompany(company, tweets, comments);
    const tweetSentiment = sentimentEnabled
      ? await analyzeSentiment(tweetTexts(tweets), sentimentUrl)
      : { enabled: false, analyzedCount: 0, failedCount: 0 };
    const commentSentiment = sentimentEnabled
      ? await analyzeSentiment(replyTexts(comments), sentimentUrl)
      : { enabled: false, analyzedCount: 0, failedCount: 0 };
    const completedSummaryEvidence = completeSummaryEvidence(summary.summaryEvidence, tweets);
    const reportBody = formatCompanyReport(summary, tweetSentiment, commentSentiment, tweets);
    await writeFile(reportPath, reportBody, "utf-8");
    await log({ level: "info", message: "summary finished", company, details: { duration: formatDuration(companyStartedAt), reportPath, tweetSentiment: formatSentiment(tweetSentiment), commentSentiment: formatSentiment(commentSentiment) } });

    return {
      company,
      tweets,
      comments,
      csvRows: tweets.map((tweet) => ({ companyName: company.name, companyCode: company.code, ...compactTweet(tweet) })),
      commentRows: comments.map(compactReply),
      reportPath,
      reportBody,
      summaryRow: {
        companyName: summary.companyName,
        companyCode: summary.companyCode,
        tweetSummary: summary.tweetSummary,
        commentSummary: summary.commentSummary,
        investmentIssues: summary.investmentIssues,
        investmentHints: summary.investmentHints,
        summaryEvidence: completedSummaryEvidence,
        tweetCount: tweets.length,
        commentCount: comments.length,
        tweetSentimentScore: formatSentiment(tweetSentiment),
        tweetSentimentScore0To100: tweetSentiment.score0To100 ?? "",
        tweetSentimentAverageRawScore: tweetSentiment.averageRawScore ?? "",
        tweetSentimentAnalyzedCount: tweetSentiment.analyzedCount,
        tweetSentimentFailedCount: tweetSentiment.failedCount,
        commentSentimentScore: formatSentiment(commentSentiment),
        commentSentimentScore0To100: commentSentiment.score0To100 ?? "",
        commentSentimentAverageRawScore: commentSentiment.averageRawScore ?? "",
        commentSentimentAnalyzedCount: commentSentiment.analyzedCount,
        commentSentimentFailedCount: commentSentiment.failedCount,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    await log({ level: "error", message: "company failed; continuing with remaining companies", company, details: { error: message } });
    const reportBody = [
      `# ${company.name} (${company.code})`,
      "",
      "この企業の処理は失敗しました。",
      "",
      `- エラー: ${message}`,
      `- クエリ: ${query}`,
      "- 詳細: trace JSONL を確認してください。",
    ].join("\n");
    await writeFile(reportPath, reportBody, "utf-8");
    return {
      company,
      tweets: [],
      comments: [],
      csvRows: [],
      commentRows: [],
      reportPath,
      reportBody,
      summaryRow: {
        companyName: company.name,
        companyCode: company.code,
        tweetSummary: "処理失敗",
        commentSummary: "不明",
        investmentIssues: "trace JSONL を確認してください。",
        investmentHints: "不明",
        summaryEvidence: message,
        tweetSentimentScore: "不明",
        commentSentimentScore: "不明",
      },
      error: message,
    };
  }
}

async function runCompanyWithOutputs(options: Options, outputMode: "company-latest" | "company-summary-csv"): Promise<void> {
  const companiesPath = optionString(options, "companies");
  if (!companiesPath) throw new Error("--companies is required");

  const limitPerCompany = optionNumber(options, "limit-per-company", 10);
  const companyConcurrency = Math.max(1, optionNumber(options, "company-concurrency", 3));
  const minLikes = optionNumber(options, "min-likes", 0);
  const maxLikes = optionalNumber(options, "max-likes");
  const minRetweets = optionNumber(options, "min-retweets", 0);
  const repliesEnabled = options["with-replies"] === true || options["replies"] === true || options["replies-per-tweet"] !== undefined;
  const repliesPerTweet = repliesEnabled ? optionNumber(options, "replies-per-tweet", 10) : 0;
  const sentimentEnabled = options["sentiment"] === true;
  const sentimentUrl = optionString(options, "sentiment-url", DEFAULT_SENTIMENT_URL) ?? DEFAULT_SENTIMENT_URL;
  const dryRun = options["dry-run"] === true;
  const outDir = optionString(options, "out-dir", "data") ?? "data";
  const companies = await readCompanies(companiesPath);
  const events: RunEvent[] = [];

  if (companies.length === 0) throw new Error(`No companies found: ${companiesPath}`);

  console.log(`Companies: ${companies.length}`);
  console.log(`Mode: latest + post-sort by engagement, limitPerCompany=${limitPerCompany}, companyConcurrency=${companyConcurrency}, repliesPerTweet=${repliesPerTweet}, ${describePopularity(minLikes, maxLikes, minRetweets)}`);
  for (const company of companies) {
    console.log(`Query: "${company.name}" ${company.code} -filter:nativeretweets`);
  }
  if (dryRun) return;

  await mkdir(path.join(outDir, "raw"), { recursive: true });
  await mkdir(path.join(outDir, "reports"), { recursive: true });
  await mkdir(path.join(outDir, "reports", "csv"), { recursive: true });

  const stamp = today();
  const prefix = "company-latest";
  const jsonPath = path.join(outDir, "raw", `${prefix}-${stamp}.json`);
  const csvPath = path.join(outDir, "raw", `${prefix}-${stamp}.csv`);
  const commentsJsonPath = path.join(outDir, "raw", `${prefix}-${stamp}-comments.json`);
  const commentsCsvPath = path.join(outDir, "raw", `${prefix}-${stamp}-comments.csv`);
  const summaryCsvPath = path.join(outDir, "raw", `${prefix}-${stamp}-summary.csv`);
  const indexPath = path.join(outDir, "reports", `${prefix}-${stamp}-index.md`);
  const tracePath = path.join(outDir, "raw", `${prefix}-${stamp}.trace.jsonl`);

  await writeFile(tracePath, "", "utf-8");
  const log = createRunLogger(events, tracePath);

  await log({
    level: "info",
    message: "run started",
    details: { companies: companies.length, limitPerCompany, repliesPerTweet, companyConcurrency, sentimentEnabled, sentimentUrl, outDir, outputMode },
  });

  const results = await mapWithConcurrency(companies, companyConcurrency, (company, index) =>
    processCompany({
      company,
      index,
      total: companies.length,
      prefix,
      stamp,
      reportsDir: path.join(outDir, "reports"),
      limitPerCompany,
      minLikes,
      maxLikes,
      minRetweets,
      repliesPerTweet,
      sentimentEnabled,
      sentimentUrl,
      log,
    }),
  );

  const allTweets = results.flatMap((result) => result.tweets);
  const allComments = results.flatMap((result) => result.comments);
  const csvRows = results.flatMap((result) => result.csvRows);
  const commentRows = results.flatMap((result) => result.commentRows);
  const summaryRows = results.map((result) => result.summaryRow);
  const indexBody = [
    `# 企業X検索まとめ ${stamp}`,
    "",
    `- 企業数: ${companies.length}`,
    `- 並列数: ${companyConcurrency}`,
    `- ツイート数: ${allTweets.length}`,
    `- 取得コメント数: ${allComments.length}`,
    `- コメントraw: ${path.relative(path.join(outDir, "reports"), commentsJsonPath)}`,
    `- 感情分析: ${sentimentEnabled ? `実行（${sentimentUrl}）` : "未実行"}`,
    `- 失敗企業数: ${results.filter((result) => result.error).length}`,
    "",
    "## 会社別レポート",
    "",
    ...results.map((result) => `- ${result.company.name} (${result.company.code}): ${path.relative(path.join(outDir, "reports"), result.reportPath)}${result.error ? "（失敗）" : ""}`),
  ].join("\n");

  await writeFile(jsonPath, JSON.stringify(allTweets, null, 2), "utf-8");
  await writeFile(csvPath, toCsv(csvRows) + "\n", "utf-8");
  await writeFile(commentsJsonPath, JSON.stringify(allComments, null, 2), "utf-8");
  await writeFile(commentsCsvPath, toCsv(commentRows) + "\n", "utf-8");
  await writeFile(indexPath, indexBody + "\n", "utf-8");

  if (outputMode === "company-latest") {
    await writeFile(summaryCsvPath, toCsv(summaryRows) + "\n", "utf-8");
  } else {
    await Promise.all(
      results.map(async (result) => {
        const summaryCsvPathForCompany = path.join(outDir, "reports", "public", `${safePathSegment(result.company.code)}-aisummary.csv`);
        await writeFile(summaryCsvPathForCompany, toCsv([compactSummaryRowForCsv(result.summaryRow)]) + "\n", "utf-8");
      }),
    );
  }

  await log({ level: "info", message: "run finished", details: { tweets: allTweets.length, comments: allComments.length, companies: companies.length, failedCompanies: results.filter((result) => result.error).length } });
  await writeRunEvents(tracePath, events);

  console.log(`Saved raw: ${jsonPath}`);
  console.log(`Saved csv: ${csvPath}`);
  console.log(`Saved comments raw: ${commentsJsonPath}`);
  console.log(`Saved comments csv: ${commentsCsvPath}`);
  if (outputMode === "company-latest") {
    console.log(`Saved summary csv: ${summaryCsvPath}`);
  } else {
    console.log(`Saved ai summary csvs: ${path.join(outDir, "reports", "csv", "<code>-aisummary.csv")}`);
  }
  console.log(`Saved report index: ${indexPath}`);
  console.log(`Saved company reports: ${path.join(outDir, "reports", `${prefix}-${stamp}-<code>-<name>.md`)}`);
  console.log(`Saved trace: ${tracePath}`);
}

async function runCompany(options: Options): Promise<void> {
  await runCompanyWithOutputs(options, "company-latest");
}

async function runCompanySummaryCsv(options: Options): Promise<void> {
  const outDir = optionString(options, "out-dir", "data") ?? "data";
  const reportsDir = path.join(outDir, "reports");
  await writeSummaryCsvsFromReports(reportsDir, outDir);
  console.log(`Generated per-company summary CSVs from reports in ${reportsDir}`);
}

export { writeSummaryCsvsFromReports };

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "ai-trend") await runAiTrend(options);
  if (command === "company-latest") await runCompany(options);
  if (command === "company-summary-csv") await runCompanySummaryCsv(options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
