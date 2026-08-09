import jwt from 'jsonwebtoken';

export interface VerifiedUser {
  userId: string;
  defaultRole: string;
  allowedRoles: string[];
}

/**
 * Resolve the JWT secret config used to verify nhost access tokens.
 * nhost injects this as NHOST_JWT_SECRET (a JSON string such as
 * `{"type":"HS256","key":"..."}` or `{"type":"RS256","key":"<public pem>"}`).
 */
function getJwtConfig(): { type: 'HS256' | 'RS256' | 'HS384' | 'HS512'; key: string } {
  const raw = process.env.NHOST_JWT_SECRET || process.env.HASURA_GRAPHQL_JWT_SECRET;
  if (!raw) {
    throw new Error('Missing JWT secret environment variable (NHOST_JWT_SECRET)');
  }
  try {
    const parsed = JSON.parse(raw) as { type?: string; key?: string };
    const type = parsed.type || 'HS256';
    if (!parsed.key) throw new Error('JWT secret config has no key');
    return { type: type as never, key: parsed.key };
  } catch (err) {
    // fall back to treating the raw value as a symmetric key (legacy)
    return { type: 'HS256', key: raw };
  }
}

/** Verify a bearer token and extract the user + role claims. */
export function verifyAccessToken(token: string): VerifiedUser {
  const cfg = getJwtConfig();
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, cfg.key, {
      algorithms: [cfg.type],
    }) as jwt.JwtPayload;
  } catch (err) {
    throw new Error(`Invalid access token: ${(err as Error).message}`);
  }
  const userId = decoded['x-hasura-user-id'] ?? decoded.sub;
  if (!userId) {
    throw new Error('Access token is missing a user id');
  }
  return {
    userId: String(userId),
    defaultRole: String(decoded['x-hasura-default-role'] ?? 'user'),
    allowedRoles: (decoded['x-hasura-allowed-roles'] as string[]) ?? ['user'],
  };
}

/** Read a `Bearer <token>` from the Authorization header (case-insensitive). */
export function getBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['authorization'] ?? headers['Authorization'] ?? '';
  const value = Array.isArray(raw) ? raw[0] ?? '' : raw;
  if (!value.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}
