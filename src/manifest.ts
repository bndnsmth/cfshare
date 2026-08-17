import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "./json";
import {
  CFSHARE_FORMAT,
  MAX_ENCRYPTED_SIZE,
  MAX_FILE_SIZE,
  MAX_PAYLOAD_COUNT,
  PBKDF2_ITERATIONS,
  type CFShareManifest,
  type CryptoMetadata,
  type PayloadDescriptor,
} from "./types";

export interface ManifestLimits {
  maxStoredBytes?: number;
  maxPayloadBytes?: number;
}

export type ManifestParseResult =
  | { ok: true; manifest: CFShareManifest }
  | { ok: false; error: string };

function isNonNegativeSafeInteger(value: JsonValue | undefined): value is number {
  return isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: JsonValue | undefined): value is string {
  return isJsonString(value) && Number.isFinite(Date.parse(value));
}

function isPayloadPath(value: JsonValue | undefined): value is string {
  if (!isJsonString(value) || value.length === 0 || value.length > 1024) {
    return false;
  }

  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function parseCrypto(value: JsonValue | undefined): CryptoMetadata | null {
  if (
    !isJsonObject(value) ||
    value.algorithm !== "AES-GCM" ||
    value.kdf !== "PBKDF2" ||
    value.hash !== "SHA-256" ||
    value.iterations !== PBKDF2_ITERATIONS ||
    !isJsonString(value.salt) ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.salt) ||
    !isJsonString(value.iv) ||
    !/^[A-Za-z0-9_-]{16}$/.test(value.iv)
  ) {
    return null;
  }

  return {
    algorithm: value.algorithm,
    kdf: value.kdf,
    hash: value.hash,
    iterations: value.iterations,
    salt: value.salt,
    iv: value.iv,
  };
}

export function parseManifest(
  value: JsonValue,
  { maxStoredBytes = MAX_ENCRYPTED_SIZE, maxPayloadBytes = maxStoredBytes }: ManifestLimits = {},
): ManifestParseResult {
  if (!isJsonObject(value) || value.format !== CFSHARE_FORMAT) {
    return { ok: false, error: "Unsupported transfer format" };
  }

  if (
    !isJsonString(value.name) ||
    value.name.length === 0 ||
    value.name.length > 1024 ||
    value.name.includes("/") ||
    value.name.includes("\\") ||
    hasControlCharacters(value.name)
  ) {
    return { ok: false, error: "Invalid transfer name" };
  }

  if (!isJsonString(value.type) || value.type.length === 0 || value.type.length > 255) {
    return { ok: false, error: "Invalid content type" };
  }

  if (!isNonNegativeSafeInteger(value.size) || value.size > MAX_FILE_SIZE) {
    return { ok: false, error: "Invalid file size" };
  }

  if (!isNonNegativeSafeInteger(value.storedSize) || value.storedSize > maxStoredBytes) {
    return { ok: false, error: "Invalid stored size" };
  }

  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.expiresAt)) {
    return { ok: false, error: "Invalid transfer timestamps" };
  }

  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    return { ok: false, error: "Transfer expiration must follow its creation time" };
  }

  if (
    !Array.isArray(value.payloads) ||
    value.payloads.length === 0 ||
    value.payloads.length > MAX_PAYLOAD_COUNT
  ) {
    return { ok: false, error: "Invalid payload list" };
  }

  const payloads: PayloadDescriptor[] = [];
  let total = 0;

  for (const payload of value.payloads) {
    if (
      !isJsonObject(payload) ||
      !isPayloadPath(payload.path) ||
      !isNonNegativeSafeInteger(payload.size) ||
      payload.size > maxPayloadBytes
    ) {
      return { ok: false, error: "Invalid payload descriptor" };
    }

    total += payload.size;
    if (!Number.isSafeInteger(total) || total > maxStoredBytes) {
      return { ok: false, error: "Invalid stored size" };
    }

    payloads.push({ path: payload.path, size: payload.size });
  }

  if (total !== value.storedSize) {
    return { ok: false, error: "Payload sizes do not match stored size" };
  }

  const crypto = parseCrypto(value.crypto);
  if (!crypto) {
    return { ok: false, error: "Invalid crypto metadata" };
  }

  return {
    ok: true,
    manifest: {
      format: CFSHARE_FORMAT,
      name: value.name,
      type: value.type,
      size: value.size,
      storedSize: value.storedSize,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      payloads,
      crypto,
    },
  };
}
