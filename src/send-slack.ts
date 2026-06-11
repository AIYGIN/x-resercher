import "dotenv/config";
import { readFile } from "node:fs/promises";

const digestPath = "data/digest.md";
const slackTextLimit = 2900;

const webhookUrlEnv = process.env.SLACK_WEBHOOK_URL;

if (
  !webhookUrlEnv ||
  webhookUrlEnv.includes("xxxx/yyyy/zzzz") ||
  webhookUrlEnv.includes("replace")
) {
  throw new Error("SLACK_WEBHOOK_URL is missing");
}

const webhookUrl = webhookUrlEnv;

const truncateForSlack = (text: string): string => {
  if (text.length <= slackTextLimit) return text;
  return `${text.slice(0, slackTextLimit - 120)}\n\n…(truncated; see data/digest.md for full digest)`;
};

const main = async (): Promise<void> => {
  const digest = await readFile(digestPath, "utf8");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: truncateForSlack(digest),
      mrkdwn: true,
      username: process.env.SLACK_USERNAME || "x-resercher",
      icon_emoji: process.env.SLACK_ICON_EMOJI || ":newspaper:",
    }),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`Slack webhook error: ${res.status} ${body}`);
  }

  console.log(`sent ${digestPath} to Slack`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
