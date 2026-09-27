import { createFileRoute } from '@tanstack/react-router'
import { DocsHome, DocsShell } from '@/features/docs/docs-shell'

export const Route = createFileRoute('/docs/')({
  component: DocsIndexPage,
})

function DocsIndexPage() {
  return (
    <DocsShell>
      <DocsHome />
    </DocsShell>
  )
}
