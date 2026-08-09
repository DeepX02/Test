import { NhostClient } from '@nhost/nhost-js';

export const nhost = new NhostClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'local',
  region: process.env.NEXT_PUBLIC_NHOST_REGION || 'local',
  start: true,
});

/** Set the org-scoping session variables used by every Hasura permission rule. */
export function setOrgSessionVars(orgId: string, role: string) {
  nhost.graphql.setHeaders({
    'x-hasura-org-id': orgId,
    'x-hasura-org-role': role,
  });
}
