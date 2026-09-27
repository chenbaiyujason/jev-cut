import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await readFile(new URL('./editor-assets.json',import.meta.url),'utf8'));
for(const item of manifest.files){
 const file=path.resolve(root,item.path);if(!file.startsWith(path.resolve(root)+path.sep))throw Error('Unsafe model destination');
 let data;try{data=await readFile(file);}catch{}
 if(!data||createHash('sha256').update(data).digest('hex')!==item.sha256){const response=await fetch(item.url);if(!response.ok)throw Error('Editor asset download failed '+response.status);data=Buffer.from(await response.arrayBuffer());if(data.length!==item.bytes||createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error('Editor model hash mismatch');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,data);}
 console.log('Verified '+item.path);
}
