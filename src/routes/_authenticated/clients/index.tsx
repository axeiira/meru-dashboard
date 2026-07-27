import { createFileRoute } from '@tanstack/react-router'
import { ClientsPage } from '@/features/meru/pages'

export const Route = createFileRoute('/_authenticated/clients/')({
  component: ClientsPage,
})
