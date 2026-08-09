import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Validate the `nhost-webhook-secret` header that Hasura event/cron triggers
 * send (configured from the NHOST_WEBHOOK_SECRET env var in metadata).
 */
export function validWebhookSecret(headers: Record<string, string | string[] | undefined>): boolean {
  const providedRaw = headers['nhost-webhook-secret'] ?? headers['Nhost-Webhook-Secret'];
  const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;
  const expected = process.env.NHOST_WEBHOOK_SECRET;
  if (!provided || !expected) return false;
  const h = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(provided), h(expected));
}
