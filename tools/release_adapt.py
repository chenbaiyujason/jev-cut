"""Deterministic public-package adaptations. Never writes to live source trees."""
import json
import re

def adapt(dest, data):
    if dest.endswith(('.png','.jpg','.jpeg','.webp','.ico','.woff','.woff2','.ttf','.wasm')):
        return data
    try: text=data.decode('utf-8-sig')
    except UnicodeDecodeError: return data
    if dest.startswith('apps/backend/') and dest.endswith('.mjs'):
        text=text.replace("path.join(root,'.venv/Scripts/python.exe')", "(process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'))")
        text=text.replace("path.join(root,'.venv','Scripts','python.exe')", "(process.env.MAD_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'))")
    if dest=='apps/backend/studio-project.mjs':
        text=re.sub(r"studioRoot=process.env.MAD_STUDIO_ROOT\|\|[^;\n]+", "studioRoot=process.env.MAD_STUDIO_ROOT||path.resolve(root,'../editor')", text)
        text="import {emptyProject} from './release-runtime.mjs';\n"+text
        text=text.replace('project:migrateLegacyProject(library)', 'project:library.project?migrateLegacyProject(library):emptyProject()')
    if dest=='apps/backend/winnow.mjs':
        a=text.index('const endpoint=');b=text.index('export async function annotate',a)
        text=text[:a]+"export {decide} from './decision-provider.mjs';\nimport {decide} from './decision-provider.mjs';\n\n"+text[b:]
    if dest in ['apps/backend/global-sequence.mjs','apps/backend/progressive-generation.mjs','apps/backend/sequence.mjs','apps/backend/server.mjs']:
        text="import {expectedSourceCount} from './release-runtime.mjs';\n"+text
        text=text.replace('.size<11', '.size<expectedSourceCount(library)').replace('sources.length<11','sources.length<expectedSourceCount(library)')
        text=text.replace('expectedEpisodes:11','expectedEpisodes:expectedSourceCount(library)')
        text=text.replace('全11集','全量素材').replace('/11 集','/全部素材').replace('完整11集','完整素材库')
    if dest=='apps/backend/planning.mjs': text=text.replace('完整11集','完整素材库')
    if dest in ['apps/backend/scripts/enrich-catalog.mjs','apps/backend/scripts/build-embeddings.mjs']:
        if 'done.size>=11' not in text: raise ValueError('Catalog completion hook changed; review adaptation')
        text="import {expectedCatalogEpisodes} from '../release-catalog.mjs';\nconst expectedEpisodes=await expectedCatalogEpisodes();\n"+text
        text=text.replace('done.size>=11','done.size>=expectedEpisodes.length').replace('11 集 Gemini 理解完成','全部清单素材 Gemini 理解完成')
        if dest.endswith('enrich-catalog.mjs'):
            text=text.replace('const sources=await preparedSources();','const sources=(await preparedSources()).filter(s=>expectedEpisodes.includes(s.episode));')
            text=text.replace("state.stage=process.exitCode?", "if(!pilot&&!watch&&done.size!==expectedEpisodes.length){process.exitCode=1;state.errors.push({message:'清单素材未全部完成，请检查本地准备及失败记录'});}\nstate.stage=process.exitCode?")
        else:
            text=text.replace("if(source.semanticStatus!=='complete'", "if(!expectedEpisodes.includes(source.episode)||source.semanticStatus!=='complete'")
            text=text.replace('if(done.size>=expectedEpisodes.length)await saveIndex();','if(done.size>=expectedEpisodes.length)await saveIndex();else if(!watch)process.exitCode=1;')
    if dest=='apps/backend/scripts/prepare-editor-proxies.mjs':
        text=text.replace('{readFile,writeFile,stat,rename}', '{readFile,writeFile,stat,rename,mkdir}')
        old="const library=JSON.parse(await readFile('.local/library.json','utf8'));"
        if old not in text: raise ValueError('Editor proxy input hook changed; review adaptation')
        text=text.replace(old,"import {preparedSources} from '../catalog.mjs';\nimport {expectedCatalogEpisodes} from '../release-catalog.mjs';\nconst expected=await expectedCatalogEpisodes();\nconst library=process.argv.includes('--catalog')?{sources:(await preparedSources()).filter(s=>expected.includes(s.episode))}:JSON.parse(await readFile('.local/library.json','utf8'));")
        gpu=next(line for line in text.splitlines() if "await run('ffmpeg'," in line)
        cpu=gpu.replace("'h264_nvenc'","'libx264'").replace("'-preset','p2','-rc','vbr','-cq','24','-b:v','0'","'-preset','veryfast','-crf','24'")
        if cpu==gpu or "'h264_nvenc'" in cpu: raise ValueError('Editor proxy codec hook changed')
        text=text.replace(gpu,"      if(process.argv.includes('--cpu')) {\n"+cpu+'\n      } else {\n      try {\n'+gpu+'\n      } catch {\n'+cpu+'\n      }\n      }')
        text=text.replace("await writeFile('.local/studio/verification/motion/editor-proxies.json'", "await mkdir('.local/studio/verification/motion',{recursive:true});\nawait writeFile('.local/studio/verification/motion/editor-proxies.json'")
    if dest=='apps/backend/production-menu.mjs':
        text,count=re.subn(r'^const defaults=\[.*?\];$', 'const defaults=[];',text, count=1, flags=re.M)
        if count!=1: raise ValueError('production menu defaults changed; review adaptation')
    if dest=='apps/backend/catalog.mjs': text=text.replace('这是小圆剧场版总集篇 TV Edition 第${source.episode}集的一小段','这是用户素材第${source.episode}项的一小段')
    if dest=='apps/backend/studio-api.mjs':
        text=text.replace("||'晓美焰，帅气、轮回、忧郁'", "||''")
        text=re.sub(r"versions:\[\{id:'homura-20s'.*?\]\}", "versions:[]}",text,count=1)
    if dest=='apps/editor/src/features/mad-studio/edit-panel.tsx':
        text=text.replace("useState('晓美焰，帅气、轮回、忧郁')", "useState('')")
    if dest=='apps/backend/requirements.txt': text += '\nopencv-python-headless>=4.10\n'
    if dest=='apps/backend/scripts/catalog_preprocess.py':
        old="    ffmpeg(['-i',source,'-map','0:s:0',srt])"
        new="""    external=cfg.get('JEV_SUBTITLE')
    if external:
        ffmpeg(['-i',external,srt])
    else:
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','s','-show_streams','-of','json',str(source)]))
        if probe.get('streams'): ffmpeg(['-i',source,'-map','0:s:0',srt])
        else: srt.write_text('',encoding='utf-8')"""
        if old not in text: raise ValueError('catalog subtitle hook changed; review adaptation')
        text=text.replace(old,new).replace("'Madoka Movie TV Edition 01-11'","cfg.get('JEV_COLLECTION','User supplied footage')")
        text=text.replace("'type':'embedded','language':'jpn','aligned':'same-container'", "'type':'external' if external else 'embedded-or-none','language':cfg.get('JEV_SUBTITLE_LANGUAGE','und'),'aligned':'user-verified' if external else 'same-container'")
        text=text[:text.index("if __name__=='__main__':")]+"if __name__=='__main__':\n    raise SystemExit('Use scripts/prepare_sources.py with a source manifest')\n"
    if dest=='apps/backend/scripts/find_repeated_sequences.py':
        text=text.replace("for ep in range(1,12):\n        directory=ROOT/f'.local/catalog-v2/episode-{ep:02d}';", "for directory in sorted((ROOT/'.local/catalog-v2').glob('episode-*')):\n        ")
    if dest=='apps/backend/package.json':
        p=json.loads(text);p['name']='jev-cut-backend';p['scripts']['catalog']='python scripts/prepare_sources.py --help';text=json.dumps(p,ensure_ascii=False,indent=2)+'\n'
    if dest=='apps/editor/vite.config.ts':
        text=text.replace('const oxlintConfig =', "const apiTarget = process.env.JEV_API_URL || 'http://127.0.0.1:8794'\n\nconst oxlintConfig =")
        text=text.replace("target: 'http://127.0.0.1:8794'",'target: apiTarget').replace('port: 8796','port: Number(process.env.JEV_EDITOR_PORT || 8796)')
    return text.replace('\r\n','\n').encode('utf-8')
