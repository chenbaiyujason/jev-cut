import { createLazyFileRoute } from '@tanstack/react-router'
import { Editor } from '@/features/editor/components/editor'
import { NativeMadEntry } from '@/features/mad-studio/native-mad-entry'

export const Route = createLazyFileRoute('/editor/$projectId')({
  component: EditorPage,
})

function EditorPage() {
  const { projectId } = Route.useParams()
  const { project, migration } = Route.useLoaderData()

  return <NativeMadEntry><Editor projectId={projectId} project={project} migration={migration} /></NativeMadEntry>
}
