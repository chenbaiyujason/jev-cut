import { useCallback, useEffect, useMemo, useState } from 'react'
import { Editor } from '@/features/editor/components/editor'
import { EditorExtensionContext } from '@/features/editor/components/editor-extension'
import { useEditorStore } from '@/shared/state/editor'
import { Button } from '@/components/ui/button'
import { Sparkles } from 'lucide-react'
import { type StudioProject } from './api'
import { initializeMadStudio, startMadBridge, useMadBridge, madMigration } from './bridge'
import { EditPanel } from './edit-panel'
import { JevProjectMenu, JevToolbar } from './jev-chrome'
import './mad-studio.css'

function ConnectedStudio({ data }: { data: StudioProject }) {
  useEffect(() => startMadBridge(), [])
  const applying = useMadBridge((s) => s.applying)
  const pending = useMadBridge((s) => s.pending)
  const [active, setActive] = useState(true)
  useEffect(() => {
    const editor = useEditorStore.getState()
    editor.setRightSidebarOpen(true)
    if (editor.rightSidebarWidth < 340) editor.setRightSidebarWidth(360)
    document.title = 'jev剪辑'
  }, [])
  const activate = useCallback((value: boolean) => {
    setActive(value)
    useEditorStore.getState().setRightSidebarOpen(true)
  }, [])
  useEffect(() => {
    if (!applying) return
    const block = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('.jev-controls')) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', block, true)
    return () => window.removeEventListener('keydown', block, true)
  }, [applying])
  const extension = useMemo(
    () => ({
      label: 'jev剪辑',
      active,
      busy: pending,
      setActive: activate,
      projectControls: <JevProjectMenu />,
      toolbarActions: <JevToolbar active={active} onOpen={() => activate(true)} />,
      inspector: <EditPanel />,
    }),
    [active, pending, activate],
  )
  // Boot metadata must never change: live updates use stores, not reopening Editor.
  const project = data.project
  const blockPointer = (e: React.SyntheticEvent) => {
    if (applying && e.target instanceof HTMLElement && !e.target.closest('.jev-controls')) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  return (
    <EditorExtensionContext.Provider value={extension}>
      <div className="mad-studio-shell">
        <div
          className="mad-editor-host"
          aria-busy={applying}
          onPointerDownCapture={blockPointer}
          onClickCapture={blockPointer}
        >
          <Editor
            projectId={project.id}
            project={{
              id: project.id,
              name: project.name,
              width: project.metadata.width,
              height: project.metadata.height,
              fps: project.metadata.fps,
              backgroundColor: project.metadata.backgroundColor,
            }}
            migration={madMigration}
          />
        </div>
      </div>
    </EditorExtensionContext.Provider>
  )
}

export function MadStudio() {
  const [data, setData] = useState<StudioProject | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    void initializeMadStudio()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((value: unknown) => {
        if (!cancelled) setError(value instanceof Error ? value.message : String(value))
      })
    return () => {
      cancelled = true
    }
  }, [attempt])
  if (data) return <ConnectedStudio data={data} />
  return (
    <div className="mad-loading">
      <Sparkles size={32} />
      <h1>jev剪辑</h1>
      <p>{error || '连接本机镜头库与音乐工程…'}</p>
      {error ? (
        <Button
          onClick={() => {
            setError(null)
            setAttempt((value) => value + 1)
          }}
        >
          重新连接
        </Button>
      ) : null}
    </div>
  )
}
