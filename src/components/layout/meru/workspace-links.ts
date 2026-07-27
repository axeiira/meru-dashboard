import { Building2, Gauge, Grid2X2, Users } from 'lucide-react'
import { isTenantAdmin, useAuthStore } from '@/stores/auth-store'

export const workspaceLinks = [
  { label: 'Dashboard', to: '/', icon: Gauge },
  { label: 'Projects', to: '/projects', icon: Grid2X2, adminOnly: true },
  { label: 'Clients', to: '/clients', icon: Building2, adminOnly: true },
  { label: 'Team & organisation', to: '/team', icon: Users, adminOnly: true },
] as const

export type WorkspaceLink = (typeof workspaceLinks)[number]

// Managers only get their project list (the root '/'); the portfolio register
// and org management are Admin-only.
export function useWorkspaceLinks(): WorkspaceLink[] {
  const { auth } = useAuthStore()
  const admin = isTenantAdmin(auth.user)
  return workspaceLinks.filter((l) => admin || !('adminOnly' in l && l.adminOnly))
}
