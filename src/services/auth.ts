import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const passwordParams = {
  keyLength: 64,
  saltLength: 16,
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
};

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: {
    N: number;
    r: number;
    p: number;
  },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export type AccessTokenClaims = {
  sub: string;
  email: string;
  typ: "access";
};

function jwtSecret() {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(passwordParams.saltLength);
  const derived = await deriveKey(password, salt, passwordParams.keyLength, {
    N: passwordParams.cost,
    r: passwordParams.blockSize,
    p: passwordParams.parallelization,
  });

  return [
    "scrypt",
    passwordParams.cost,
    passwordParams.blockSize,
    passwordParams.parallelization,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, cost, blockSize, parallelization, salt, hash] = storedHash.split("$");
  if (scheme !== "scrypt" || !cost || !blockSize || !parallelization || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64url");
  const derived = await deriveKey(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelization),
  });

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export async function signAccessToken(input: { userId: string; email: string }) {
  return new SignJWT({
    email: input.email,
    typ: "access",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(jwtSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, jwtSecret(), {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  if (payload.typ !== "access" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token");
  }

  return {
    sub: payload.sub,
    email: String(payload.email ?? ""),
    typ: "access",
  };
}
