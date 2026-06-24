import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

export function createStorageClient() {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

export class StorageService {
  constructor(private readonly client = createStorageClient()) {}

  async healthCheck() {
    await this.client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  }

  async signedUploadUrl(input: {
    key: string;
    contentType: string;
    expiresIn?: number;
  }) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: input.key,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresIn ?? 900 },
    );
  }

  async signedDownloadUrl(input: {
    key: string;
    filename?: string | undefined;
    download?: boolean | undefined;
    expiresIn?: number;
  }) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: input.key,
        ResponseContentDisposition:
          input.download && input.filename
            ? `attachment; filename="${input.filename.replace(/"/g, "")}"`
            : undefined,
      }),
      { expiresIn: input.expiresIn ?? 3600 },
    );
  }

  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
      }),
    );
  }
}
