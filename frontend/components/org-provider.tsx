'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuthenticationStatus, useUserData } from '@nhost/react';
import { nhost, setOrgSessionVars } from '@/lib/nhost';
import { request, MY_MEMBERSHIPS } from '@/lib/graphql';
import type { OrgMembership, OrgRole } from '@/lib/types';

interface OrgContextValue {
  ready: boolean;
  memberships: OrgMembership[];
  activeMembership: OrgMembership | null;
  role: OrgRole | null;
  isOwner: boolean;
  canEdit: boolean;
  canTrigger: boolean;
  switchOrg: (orgId: string) => void;
  reload: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider');
  return ctx;
}

const STORAGE_KEY = 'active-org-id';

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuthenticationStatus();
  const user = useUserData();
  const userId = user?.id ?? null;

  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const applyVars = useCallback((orgId: string | null, role: OrgRole | null) => {
    if (orgId && role) {
      setOrgSessionVars(orgId, role);
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await request<{ org_members: OrgMembership[] }>(MY_MEMBERSHIPS);
      const list = data?.org_members ?? [];
      setMemberships(list);

      const saved = window.localStorage.getItem(STORAGE_KEY);
      let active = list.find((m) => m.org_id === saved) ?? null;
      if (!active && list.length > 0) active = list[0];
      setActiveOrgId(active?.org_id ?? null);

      if (active) {
        window.localStorage.setItem(STORAGE_KEY, active.org_id);
        applyVars(active.org_id, active.role);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      setLoaded(true);
    } catch (err) {
      // e.g. no session; treat as logged out
      setMemberships([]);
      setActiveOrgId(null);
      setLoaded(true);
      console.error('Failed to load org memberships', err);
    }
  }, [applyVars]);

  useEffect(() => {
    if (!isAuthenticated) {
      setMemberships([]);
      setActiveOrgId(null);
      setLoaded(true);
      return;
    }
    if (authLoading) return;
    if (userId) {
      void reload();
    }
  }, [isAuthenticated, authLoading, userId, reload]);

  const switchOrg = useCallback(
    (orgId: string) => {
      const membership = memberships.find((m) => m.org_id === orgId) ?? null;
      if (!membership) return;
      window.localStorage.setItem(STORAGE_KEY, orgId);
      setActiveOrgId(orgId);
      applyVars(orgId, membership.role);
    },
    [memberships, applyVars],
  );

  const activeMembership = useMemo(
    () => memberships.find((m) => m.org_id === activeOrgId) ?? null,
    [memberships, activeOrgId],
  );

  const value = useMemo<OrgContextValue>(() => {
    const role = activeMembership?.role ?? null;
    const canEdit = role === 'owner' || role === 'editor';
    return {
      ready: loaded,
      memberships,
      activeMembership,
      role,
      isOwner: role === 'owner',
      canEdit,
      canTrigger: canEdit,
      switchOrg,
      reload,
    };
  }, [loaded, memberships, activeMembership, switchOrg, reload]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export { nhost };
