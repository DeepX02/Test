'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthenticationStatus } from '@nhost/react';
import { useOrg } from '@/components/org-provider';
import { request, INSERT_WORKFLOW } from '@/lib/graphql';

export default function NewWorkflowPage() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { ready, activeMembership, canEdit } = useOrg();
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (isLoading || !ready || !isAuthenticated) {
    return (
      <div className="container">
        <div className="card">
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div className="container" style={{ maxWidth: 560 }}>
        <div className="card">
          <h2>Permission required</h2>
          <p className="muted">
            Your role (<strong>{activeMembership?.role}</strong>) can view workflows but cannot
            create them. Ask an owner or editor.
          </p>
          <a href="/dashboard">← Back to dashboard</a>
        </div>
      </div>
    );
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMembership || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await request<{ insert_workflows_one: { id: string } }>(INSERT_WORKFLOW, {
        orgId: activeMembership.org_id,
        name: name.trim(),
        description: description.trim() || null,
      });
      router.push(`/workflows/${res.insert_workflows_one.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="container" style={{ maxWidth: 560 }}>
      <div className="card">
        <h2>New workflow</h2>
        <p className="muted" style={{ marginTop: -6 }}>
          In {activeMembership?.org.name}
        </p>
        <form onSubmit={create}>
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support Triage"
            autoFocus
          />
          <label>Description</label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what does this workflow do?"
          />
          {error && <div className="error-box">{error}</div>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Creating…' : 'Create workflow'}
            </button>
            <a href="/dashboard">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  );
}
