'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthenticationStatus } from '@nhost/react';
import { useOrg } from '@/components/org-provider';
import AuthForm from '@/components/auth-form';

export default function HomePage() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { ready, memberships } = useOrg();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && ready && memberships.length > 0) {
      router.replace('/dashboard');
    }
  }, [isAuthenticated, isLoading, ready, memberships.length, router]);

  if (isLoading || (isAuthenticated && !ready)) {
    return (
      <div className="container">
        <div className="card">
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  if (isAuthenticated && ready && memberships.length === 0) {
    return (
      <div className="container" style={{ maxWidth: 460 }}>
        <div className="card">
          <h2>Welcome!</h2>
          <p className="muted">
            You are signed in but not a member of any organization yet. Use one of the seeded
            demo accounts to explore a workspace with data.
          </p>
        </div>
      </div>
    );
  }

  return <AuthForm />;
}
