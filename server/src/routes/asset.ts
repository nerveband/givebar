import type { Database } from "bun:sqlite";
import { getEventState } from "../ledger";
import { INLINE_IMAGE_FIELDS } from "../projection";

/**
 * Serves an image uploaded in Settings (stored inline as a data: URL in event_state) as a
 * cacheable file. Projections reference /api/asset/<name>?v=<settings_seq>, so a new upload
 * changes the URL and every screen refetches once; a gift never re-sends the bytes.
 */
export function handleAssetRequest(db: Database, name: string): Response {
  const field = INLINE_IMAGE_FIELDS[name];
  if (!field) return new Response("Not Found", { status: 404 });
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(getEventState(db)[field]);
  if (!match) return new Response("Not Found", { status: 404 });
  return new Response(Buffer.from(match[2], "base64"), { headers: { "Content-Type": match[1], "Cache-Control": "public, max-age=31536000, immutable" } });
}
