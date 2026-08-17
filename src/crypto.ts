import { randomBytes, webcrypto } from "node:crypto";
import { PBKDF2_ITERATIONS, type CryptoMetadata } from "./types";

export { PBKDF2_ITERATIONS };

const encoder = new TextEncoder();

interface EncryptedBuffer {
  data: Buffer;
  crypto: CryptoMetadata;
}

async function deriveKey(passphrase: string | undefined, salt: Uint8Array, usages: KeyUsage[]) {
  if (!passphrase) {
    throw new Error("A non-empty passphrase is required");
  }

  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return webcrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function encryptBuffer(
  input: ArrayBuffer | ArrayBufferView,
  passphrase: string,
): Promise<EncryptedBuffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);

  const key = await deriveKey(passphrase, salt, ["encrypt"]);
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, input);

  return {
    data: Buffer.from(encrypted),
    crypto: {
      algorithm: "AES-GCM",
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: Buffer.from(salt).toString("base64url"),
      iv: Buffer.from(iv).toString("base64url"),
    },
  };
}

export async function decryptBuffer(
  input: ArrayBuffer | ArrayBufferView,
  passphrase: string | undefined,
  cryptoMetadata: CryptoMetadata,
): Promise<Buffer> {
  if (
    cryptoMetadata?.algorithm !== "AES-GCM" ||
    cryptoMetadata?.kdf !== "PBKDF2" ||
    cryptoMetadata?.hash !== "SHA-256" ||
    cryptoMetadata?.iterations !== PBKDF2_ITERATIONS
  ) {
    throw new Error("Unsupported encryption format");
  }

  const salt = Buffer.from(cryptoMetadata.salt, "base64url");
  const iv = Buffer.from(cryptoMetadata.iv, "base64url");
  const key = await deriveKey(passphrase, salt, ["decrypt"]);

  try {
    const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, input);
    return Buffer.from(decrypted);
  } catch {
    throw new Error("Wrong passphrase or corrupted share");
  }
}
