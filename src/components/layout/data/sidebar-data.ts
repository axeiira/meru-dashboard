import {
  LayoutDashboard,
  FolderKanban,
  Building2,
  Users,
  Settings,
  UserCog,
  Palette,
  Bell,
  Monitor,
  Wrench,
  HelpCircle,
  Command,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: '',
    email: '',
    avatar: '',
  },
  teams: [
    {
      name: 'Meru',
      logo: Command,
      plan: 'Construction SaaS',
    },
  ],
  navGroups: [
    {
      title: 'Workspace',
      items: [
        { title: 'Dashboard', url: '/', icon: LayoutDashboard },
        { title: 'Projects', url: '/projects', icon: FolderKanban },
        { title: 'Clients', url: '/clients', icon: Building2 },
        { title: 'Team', url: '/team', icon: Users },
      ],
    },
    {
      title: 'Other',
      items: [
        {
          title: 'Settings',
          icon: Settings,
          items: [
            { title: 'Profile', url: '/settings', icon: UserCog },
            { title: 'Account', url: '/settings/account', icon: Wrench },
            { title: 'Appearance', url: '/settings/appearance', icon: Palette },
            {
              title: 'Notifications',
              url: '/settings/notifications',
              icon: Bell,
            },
            { title: 'Display', url: '/settings/display', icon: Monitor },
          ],
        },
        { title: 'Help Center', url: '/help-center', icon: HelpCircle },
      ],
    },
  ],
}
