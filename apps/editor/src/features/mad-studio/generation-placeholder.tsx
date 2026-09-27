import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle } from 'lucide-react'
import { useSettledZoomStore } from '@/features/timeline/stores/zoom-store'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { useMadBridge } from './bridge'

/** Transient UI only: no fake media IDs, export items or editorial history entries. */
export function GenerationPlaceholder() {
 const pending=useMadBridge(s=>s.pendingClip)
 const phase=useMadBridge(s=>s.phase)
 const pps=useSettledZoomStore(s=>s.contentPixelsPerSecond)
 const fps=useProjectStore(s=>s.currentProject?.metadata.fps)||30
 const [host,setHost]=useState<Element|null>(null)
 useEffect(()=>{
  if(!pending){setHost(null);return}
  const find=()=>document.querySelector('[data-timeline-drop-target][data-track-id="picture"] [data-timeline-track-content-layer]')
  const target=find();if(target){setHost(target);return}
  const observer=new MutationObserver(()=>{const target=find();if(target){setHost(target);observer.disconnect()}})
  observer.observe(document.body,{childList:true,subtree:true});return()=>observer.disconnect()
 },[pending?.id])
 if(!pending||!host)return null
 return createPortal(<div className="jev-generation-placeholder" role="status" aria-label={`第 ${pending.index} 镜正在生成`} title={`${phase} · ${(pending.from/fps).toFixed(2)}–${(pending.to/fps).toFixed(2)}秒`} style={{left:pending.from/fps*pps,width:Math.max(16,(pending.to-pending.from)/fps*pps)}}>
  <LoaderCircle size={14} className="jev-generating-spinner" aria-hidden="true"/><span>第 {pending.index} 镜生成中</span>
 </div>,host)
}
