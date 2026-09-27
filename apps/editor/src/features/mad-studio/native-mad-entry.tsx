import { useEffect, useState, type ReactNode } from 'react'
import { EditorExtensionContext } from '@/features/editor/components/editor-extension'
import { useEditorStore } from '@/shared/state/editor'
import { Button } from '@/components/ui/button'
import { ProjectActions } from './project-actions'
import './mad-studio.css'

export function NativeMadEntry({ children }: { children: ReactNode }) {
 const [active,setActive]=useState(true),[goal,setGoal]=useState('')
 useEffect(()=>{const editor=useEditorStore.getState();editor.setRightSidebarOpen(true);if(editor.rightSidebarWidth<340)editor.setRightSidebarWidth(360)},[])
 const activate=(value:boolean)=>{setActive(value);useEditorStore.getState().setRightSidebarOpen(true)}
 return <EditorExtensionContext.Provider value={{label:'jev剪辑',active,busy:false,setActive:activate,projectControls:null,toolbarActions:<Button variant="outline" onClick={()=>activate(true)}>jev剪辑</Button>,inspector:<section className="jev-edit-panel jev-controls"><div className="jev-panel-scroll"><div className="jev-goal"><span className="jev-label">全片目标</span><textarea aria-label="全片目标" value={goal} onChange={e=>setGoal(e.target.value)} placeholder="留空由音乐决定；也可以写角色、情绪" /><ProjectActions goal={goal} connected={false}/></div></div></section>}}>{children}</EditorExtensionContext.Provider>
}
