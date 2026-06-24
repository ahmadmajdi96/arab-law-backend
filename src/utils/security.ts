import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHmacSha256({
  payload,
  signature,
  secret,
}: {
  payload: string | Buffer;
  signature: string | undefined;
  secret: string;
}) {
  if (!signature) return false;

  const normalized = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(normalized, "hex");

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
