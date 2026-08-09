'use client';

import { useSignOut } from '@nhost/react';
import { useRouter } from 'next/navigation';
import { useOrg } from './org-provider';

export default function OrgHeader() {
  const { signOut } = useSignOut();
  const router = useRouter();
  const { memberships, activeMembership, switchOrg, role, ready } = useOrg();

  const onSignOut = async () => {
    await signOut();
    router.replace('/');
  };

  return (
    <header>
      <div className="container" style={{ paddingBottom: 0 }}>
        <div className="nav">
          <a href="/dashboard" style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
            ⚙ Agent Workflow Builder
          </a>
          <span className="spacer" />
          {ready && memberships.length > 0 && (
            <select
              value={activeMembership?.org_id ?? ''}
              onChange={(e) => switchOrg(e.target.value)}
              style={{ width: 'auto', minWidth: 180 }}
            >
              {memberships.map((m) => (
                <option key={m.id} value={m.org_id}>
                  {m.org.name} · {m.role}
                </option>
              ))}
            </select>
          )}
          {activeMembership && role && (
            <span className={`badge ${role}`}>
              {activeMembership.org.name} · {role}
            </span>
          )}
          <button className="btn small" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
