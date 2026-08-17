import type { JsonValue } from "../../src/json";
import { parseManifest, type ManifestParseResult } from "../../src/manifest";
import { MAX_TRANSPORT_BYTES } from "../../src/types";

export { MAX_TRANSPORT_BYTES };

export function parseUploadManifest(value: JsonValue, maxUploadBytes: number): ManifestParseResult {
  return parseManifest(value, {
    maxStoredBytes: maxUploadBytes,
    maxPayloadBytes: MAX_TRANSPORT_BYTES,
  });
}
