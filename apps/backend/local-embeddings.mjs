import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {root} from './catalog.mjs';
import {studioRoot} from './studio-project.mjs';
export const localEmbeddingFolder=path.join(root,'.local/text-encoder');
export const localIndexFile=path.join(localEmbeddingFolder,'index.json');
let encoderPromise,indexCache;
export async function localEncoder(){
 encoderPromise??=(async()=>{const model=JSON.parse(await readFile(path.join(localEmbeddingFolder,'model.json'),'utf8'));const require=createRequire(path.join(studioRoot,'package.json'));const {pipeline,env}=require('@huggingface/transformers');env.cacheDir=localEmbeddingFolder;return pipeline('feature-extraction',model.repo,{revision:model.revision,device:'cpu',dtype:model.dtype,local_files_only:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});})().catch(e=>{encoderPromise=null;throw e;});return encoderPromise;
}
export async function encodeLocal(texts,{query=false}={}){const encoder=await localEncoder(),input=texts.map(text=>(query?'为这个句子生成表示以用于检索相关文章：':'')+text);const output=await encoder(input,{pooling:'cls',normalize:true,truncation:true,max_length:512});if(output.dims.at(-1)!==512)throw Error('本地向量维度错误');return new Float32Array(output.data);}
export async function localIndex(){try{const info=await stat(localIndexFile);if(indexCache?.mtime===info.mtimeMs)return indexCache;const metadata=JSON.parse(await readFile(localIndexFile,'utf8')),bytes=await readFile(path.join(localEmbeddingFolder,metadata.vectorFile));const vectors=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));if(vectors.length!==metadata.entries.length*metadata.dimensions)throw Error('本地索引未完整发布');indexCache={metadata,vectors,mtime:info.mtimeMs};return indexCache;}catch{return null;}}
export async function localQueryVector(query){return Array.from(await encodeLocal([query],{query:true}));}
