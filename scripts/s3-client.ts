import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface S3PublishConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  forcePathStyle: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadEnvFile(): void {
  const envPath = path.join(projectRoot, ".env");

  try {
    const contents = readFileSync(envPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing .env files and use the process environment.
  }
}

loadEnvFile();

export function getS3ConfigFromEnv(overrides: Partial<S3PublishConfig> = {}): S3PublishConfig {
  return {
    endpoint: overrides.endpoint ?? process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_S3 ?? "http://localhost:9000",
    region: overrides.region ?? process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    accessKeyId: overrides.accessKeyId ?? process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey:
      overrides.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
    bucketName: overrides.bucketName ?? process.env.S3_BUCKET_NAME ?? "company-data",
    forcePathStyle: overrides.forcePathStyle ?? parseBoolean(process.env.S3_FORCE_PATH_STYLE),
  };
}

export function createS3Client(overrides: Partial<S3PublishConfig> = {}): S3Client {
  const config = getS3ConfigFromEnv(overrides);

  const clientConfig: S3ClientConfig = {
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  };

  return new S3Client(clientConfig);
}

export async function ensureBucketExists(client: S3Client, bucketName: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return;
    }

    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  const metadata = candidate.$metadata;
  const code = metadata && typeof metadata === "object" && "httpStatusCode" in metadata ? metadata.httpStatusCode : undefined;

  if (code === 409) {
    return true;
  }

  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  return name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists";
}
