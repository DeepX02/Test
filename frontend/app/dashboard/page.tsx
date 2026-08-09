'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthenticationStatus } from '@nhost/react';
import { useOrg } from '@/components/org-provider';
import { request, DASHBOARD, type DashboardData } from '@/lib/graphql';
import type { OrgMembership } from '@/lib/types';

export default function DashboardPage() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { ready, activeMembership, role, canEdit, reload } = useOrg();
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeMembership) return;
    try {
      const d = await request<DashboardData>(DASHBOARD, { orgId: activeMembership.org_id });
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeMembership]);

  useEffect(() => {
    if (isLoading || !ready) return;
    if (!isAuthenticated) {
      router.replace('/');
      return;
    }
    void load();
  }, [isLoading, isAuthenticated, ready, activeMembership?.org_id, load, router]);

  if (isLoading || !ready || !isAuthenticated) {
    return (
      <div className="container">
        <div className="card">
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  const org = data?.organizations?.[0];
  const usage = org?.monthly_usage;

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>
          {activeMembership?.org.name} — Workflows
        </h1>
        <span className="spacer" />
        {org && (
          <span className="badge" title="Rolling 30-day org quota">
            Quota {org.calls_used} / {org.calls_allowed} ({usage?.calls_used_percent ?? 0}%)
          </span>
        )}
        {usage && (
          <span className="badge">
            {usage.runs_this_month} runs this month
          </span>
        )}
        <button className="btn" onClick={() => void reload().then(load)}>
          Refresh
        </button>
        {canEdit && (
          <button className="btn primary" onClick={() => router.push('/workflows/new')}>
            + New workflow
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="row stretch">
        {data?.workflows.length === 0 && (
          <div className="card" style={{ width: '100%' }}>
            <span className="empty">
              No workflows yet in {activeMembership?.org.name}.
              {canEdit ? ' Create one to get started.' : ' Ask an owner or editor to create one.'}
            </span>
          </div>
        )}
        {data?.workflows.map((wf) => {
          const latest = wf.runs?.[0];
          return (
            <div className="card" key={wf.id} style={{ flex: '1 1 300px' }}>
              <div className="row">
                <strong>{wf.name}</strong>
                <span className="spacer" />
                {latest && <span className={`badge ${latest.status}`}>{latest.status}</span>}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {wf.steps.length} steps · {wf.triggers.map((t) => t.trigger_type).join(', ') || 'no triggers'}
                {wf.is_active ? '' : ' · inactive'}
              </div>
              <div style={{ marginTop: 10 }}>
                <a href={`/workflows/${wf.id}`}>Open builder →</a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
