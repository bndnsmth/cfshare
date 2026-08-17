/// <reference types="node" />

import type { Buffer } from "node:buffer";

export type CFShareBackend = "drop" | "self-hosted";

export const CFSHARE_FORMAT = "cfshare/v1";
export const CFSHARE_UPLOAD_PROTOCOL = "cfshare-upload/v1";
export const MAX_FILE_SIZE: number = 250 * 1024 * 1024;
export const MAX_ENCRYPTED_SIZE: number = MAX_FILE_SIZE + 16;
export const MAX_PAYLOAD_COUNT: number = 1000;
export const MAX_TRANSPORT_BYTES: number = 50 * 1024 * 1024;
export const PBKDF2_ITERATIONS: number = 600_000;

export interface PayloadDescriptor {
  path: string;
  size: number;
}

export interface CryptoMetadata {
  algorithm: "AES-GCM";
  kdf: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
  salt: string;
  iv: string;
}

export interface CFShareManifest {
  format: typeof CFSHARE_FORMAT;
  name: string;
  type: string;
  size: number;
  storedSize: number;
  createdAt: string;
  expiresAt: string;
  payloads: PayloadDescriptor[];
  crypto: CryptoMetadata;
}

export interface CFShareProgress {
  phase:
    | "preparing"
    | "prepared"
    | "uploading"
    | "deploying"
    | "receiving"
    | "saving"
    | "saved"
    | "complete";
  loaded?: number;
  total?: number;
  inputPath?: string;
  output?: string;
  path?: string;
  url?: string;
  expiresAt?: string;
  backend?: CFShareBackend;
  claimUrl?: string | null;
  name?: string;
  size?: number;
  metadata?: CFShareManifest;
  manifest?: CFShareManifest;
}

export type ProgressListener = (progress: CFShareProgress) => void;

export interface CFShareClientOptions {
  server?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ShareOptions {
  passphrase?: string;
  ttl?: string | number;
  acceptCloudflareTerms?: boolean;
  token?: string;
  onProgress?: ProgressListener;
  retryDelays?: number[];
}

export interface ShareResult {
  url: string;
  expiresAt: string;
  backend: CFShareBackend;
  claimUrl: string | null;
  generatedPassphrase: string | null;
  name: string;
  size: number;
}

export interface DownloadOptions {
  passphrase?: string;
  onProgress?: ProgressListener;
}

export interface DownloadToFileOptions extends DownloadOptions {
  output?: string;
  force?: boolean;
}

export interface DownloadResult {
  manifest: CFShareManifest;
  data: Buffer;
}

export interface SavedDownload {
  manifest: CFShareManifest;
  path: string;
}

export interface SelfHostedUploadResult {
  url: string;
  expiresAt: string;
}
