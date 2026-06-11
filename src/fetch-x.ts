import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.X_BEARER_TOKEN;

if (!token || token.startsWith("replace_")) {
  throw new Error("X_BEARER_TOKEN is missing");
}

const queries = [
  {
    topic: "AI / LLM",
    query:
      '("OpenAI" OR "ChatGPT" OR "Anthropic" OR "Claude" OR "Gemini" OR "Mistral") lang:en -is:retweet',
  },
  {
    topic: "Codex / AI Coding",
    query:
      '("Codex" OR "Claude Code" OR "Cursor" OR "Windsurf" OR "GitHub Copilot") lang:en -is:retweet',
  },
  {
    topic: "Frontend / Next.js",
    query:
      '("Next.js" OR "Vercel" OR "React" OR "Turbopack" OR "TypeScript") lang:en -is:retweet',
  },
  {
    topic: "JP / AI / Frontend",
    query:
      '("Next.js" OR "React" OR "フロントエンド" OR "AI" OR "Codex" OR "Cursor") lang:ja -is:retweet',
  },
];

type XUser = {
  id: string;
  username: string;
  name: string;
  verified?: boolean;
};

type XPost = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
};

type NormalizedPost = {
  source: "x";
  topic: string;
  id: string;
  text: string;
  created_at?: string;
  author: {
    username: string;
    name: string;
    verified: boolean;
  } | null;
  url: string;
  metrics?: XPost["public_metrics"];
  score?: number;
};

type XSearchResponse = {
  data?: XPost[];
  includes?: {
    users?: XUser[];
  };
};

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const searchX = async (
  topic: string,
  query: string,
): Promise<NormalizedPost[]> => {
  const url = new URL("https://api.x.com/2/tweets/search/recent");

  url.searchParams.set("query", query);
  url.searchParams.set("max_results", "25");
  url.searchParams.set("start_time", hoursAgo(24));
  url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,verified");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`X API error: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as XSearchResponse;

  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));

  return (json.data ?? []).map((post) => {
    const user = post.author_id ? users.get(post.author_id) : undefined;

    return {
      source: "x",
      topic,
      id: post.id,
      text: post.text,
      created_at: post.created_at,
      author: user
        ? {
            username: user.username,
            name: user.name,
            verified: user.verified ?? false,
          }
        : null,
      url: user
        ? `https://x.com/${user.username}/status/${post.id}`
        : `https://x.com/i/web/status/${post.id}`,
      metrics: post.public_metrics,
    };
  });
};

const score = (post: NormalizedPost): number => {
  const m = post.metrics ?? {};

  return (
    (m.like_count ?? 0) +
    (m.retweet_count ?? 0) * 3 +
    (m.reply_count ?? 0) * 2 +
    (m.quote_count ?? 0) * 2
  );
};

const main = async (): Promise<void> => {
  await mkdir("data", { recursive: true });

  const posts: NormalizedPost[] = [];

  for (const q of queries) {
    posts.push(...(await searchX(q.topic, q.query)));
  }

  const sorted = posts
    .map((p) => ({ ...p, score: score(p) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);

  await writeFile(
    "data/x-posts.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        window: "last_24_hours",
        posts: sorted,
      },
      null,
      2,
    ),
  );

  console.log(`saved ${sorted.length} posts to data/x-posts.json`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
