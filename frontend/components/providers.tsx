'use client';

import { NhostProvider } from '@nhost/react';
import { nhost } from '@/lib/nhost';
import { OrgProvider } from './org-provider';
import OrgHeader from './org-header';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NhostProvider nhost={nhost}>
      <OrgProvider>
        <OrgHeader />
        {children}
      </OrgProvider>
    </NhostProvider>
  );
}
