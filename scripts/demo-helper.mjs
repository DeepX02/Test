#!/usr/bin/env node
/**
 * Demo helper script.
 *
 * Provides small utilities for the live demo:
 *   - create-user <email> <displayName>  — create an auth user (via nhost GraphQL admin)
 *   - add-member <email> <orgName> <role> — link a user into an org
 *   - list                                — show orgs, members, workflows
 *
 * Requires nhost running locally (`nhost up`) and uses the admin secret from
 * the nhost console (defaults to the local one). Override with env vars:
 *   NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL
 */

const fetch = globalThis.fetch;

const GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
const ADMIN_SECRET =
  process.env.NHOST_ADMIN_SECRET || process.env.NHOST_HASURA_GRAPHQL_ADMIN_SECRET || 'nhost-admin-secret';

async function admin(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

async function findUser(email) {
  const data = await admin(
    `query($email: citext!) { users(where: { email: { _eq: $email } }, limit: 1) { id email display_name } }`,
    { email },
  );
  return data.users[0] ?? null;
}

async function list() {
  const data = await admin(`
    query {
      organizations { id name calls_used calls_allowed }
      org_members { user_id org_id role }
      workflows { id org_id name is_active }
      users { id email display_name }
    }
  `);
  const emailById = Object.fromEntries(data.users.map((u) => [u.id, u.email]));
  console.log('\n=== Organizations ===');
  for (const o of data.organizations) {
    console.log(`${o.name}  (${o.id})  quota ${o.calls_used}/${o.calls_allowed}`);
    const members = data.org_members.filter((m) => m.org_id === o.id);
    for (const m of members) {
      console.log(`   - ${emailById[m.user_id]}  [${m.role}]`);
    }
  }
  console.log('\n=== Workflows ===');
  for (const w of data.workflows) {
    console.log(`${w.name}  (${w.org_id === data.organizations[0]?.id ? 'Acme' : 'Globex'})  ${w.is_active ? 'active' : 'inactive'}`);
  }
}

async function createUser(email, displayName) {
  const existing = await findUser(email);
  if (existing) {
    console.log(`User ${email} already exists (${existing.id}) — skipping.`);
    return;
  }
  const res = await fetch('http://localhost:1337/v1/signup/email-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'WorkflowDemo123!', options: { displayName } }),
  });
  if (!res.ok) {
    throw new Error(`Signup failed: ${await res.text()}`);
  }
  console.log(`Created user ${email} (${displayName}).`);
}

async function addMember(email, orgName, role) {
  const user = await findUser(email);
  if (!user) throw new Error(`No such user: ${email}`);
  const data = await admin(
    `query($name: String!) { organizations(where: { name: { _eq: $name } }, limit: 1) { id } }`,
    { name: orgName },
  );
  const org = data.organizations[0];
  if (!org) throw new Error(`No such org: ${orgName}`);
  await admin(
    `mutation($userId: uuid!, $orgId: uuid!, $role: org_role!) {
       insert_org_members_one(object: { user_id: $userId, org_id: $orgId, role: $role }) { id }
     }`,
    { userId: user.id, orgId: org.id, role },
  );
  console.log(`Added ${email} to ${orgName} as ${role}.`);
}

const [, , cmd, ...args] = process.argv;
const main = {
  list: () => list(),
  'create-user': () => createUser(args[0], args[1] ?? args[0].split('@')[0]),
  'add-member': () => addMember(args[0], args[1], args[2]),
}[cmd];

if (!main) {
  console.log('Usage: node scripts/demo-helper.mjs <list|create-user|add-member> [args...]');
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
