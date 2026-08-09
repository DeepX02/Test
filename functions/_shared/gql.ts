/** Minimal admin GraphQL client against the nhost GraphQL engine. */

function graphqlUrl(): string {
  if (process.env.NHOST_GRAPHQL_URL) {
    let url = process.env.NHOST_GRAPHQL_URL;
    if (!url.endsWith('/graphql')) url = url.replace(/\/+$/, '') + '/graphql';
    return url;
  }
  const { NHOST_SUBDOMAIN, NHOST_REGION } = process.env;
  if (NHOST_SUBDOMAIN && NHOST_REGION) {
    return `https://${NHOST_SUBDOMAIN}.graphql.${NHOST_REGION}.nhost.run/v1/graphql`;
  }
  return 'http://localhost:8080/v1/graphql';
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = graphqlUrl();
  const adminSecret = process.env.NHOST_ADMIN_SECRET || process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminSecret) headers['x-hasura-admin-secret'] = adminSecret;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string; extensions?: unknown }> };
  if (json.errors && json.errors.length > 0) {
    const err = new Error(json.errors.map((e) => e.message).join('; '));
    (err as Error & { extensions?: unknown }).extensions = json.errors[0]?.extensions;
    throw err;
  }
  return json.data as T;
}
