import { createContext, useContext, type ReactNode } from 'react'

/** Optional application chrome. Editor boot metadata stays stable during live edits. */
export interface EditorExtension {
  label: string
  active: boolean
  busy: boolean
  setActive: (active: boolean) => void
  projectControls: ReactNode
  toolbarActions: ReactNode
  timelineToolbarActions?: ReactNode
  inspector: ReactNode
  extraTabs?: Array<{
    id: string
    label: string
    active: boolean
    onSelect: () => void
  }>
  onInspectorSelect?: () => void
}
export const EditorExtensionContext = createContext<EditorExtension | null>(null)
export const useEditorExtension = () => useContext(EditorExtensionContext)
