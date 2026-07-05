import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client, ensureBucketExists, getS3ConfigFromEnv } from "./s3-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "data", "public");

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
}

async function uploadFiles(): Promise<void> {
  const config = getS3ConfigFromEnv();
  const client = createS3Client();

  await ensureBucketExists(client, config.bucketName);

  const files = await walkFiles(publicDir);
  if (files.length === 0) {
    console.log(`No files found in ${publicDir}`);
    return;
  }

  for (const filePath of files) {
    const relativePath = path.relative(publicDir, filePath);
    const key = relativePath.split(path.sep).join("/");
    const fileStats = await stat(filePath);

    await client.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: await import("node:fs/promises").then(({ readFile }) => readFile(filePath)),
        ContentType: "text/csv",
        ContentLength: fileStats.size,
      }),
    );

    console.log(`Uploaded ${key}`);
  }
}

async function main(): Promise<void> {
  try {
    await uploadFiles();
    console.log("Publishing completed successfully.");
  } catch (error) {
    console.error("Publishing failed.");
    console.error(error);
    process.exitCode = 1;
  }
}

await main();
