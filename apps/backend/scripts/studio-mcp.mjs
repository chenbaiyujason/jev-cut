#!/usr/bin/env node
import readline from 'node:readline';
const base=process.env.MAD_STUDIO_API||'http://127.0.0.1:8794/api/studio';
const object={type:'object',additionalProperties:true};
const tools=[
  {name:'mad_director_trace',description:'Read Winnow narrative, insertion decisions, and comparable retrieval-similarity candidates for the latest directed edit.',inputSchema:{type:'object',properties:{}}},
  {name:'mad_preview_emotion_change',description:'Ask Winnow to reconsider one occurrence with a new emotional preference. Returns a proposal only; never applies it.',inputSchema:{type:'object',properties:{baseRevision:{type:'integer'},occurrenceId:{type:'string'},prompt:{type:'string',maxLength:500}},required:['baseRevision','occurrenceId','prompt']}},
  {name:'mad_capabilities',description:'Read supported bounded techniques, native engine operations and parameter schemas.',inputSchema:{type:'object',properties:{}}},
  {name:'mad_get_project',description:'Read the live Freecut project and revision. Read before any edit.',inputSchema:{type:'object',properties:{}}},
  {name:'mad_get_catalog',description:'Read indexed source shots and their source-native safe frame ranges.',inputSchema:{type:'object',properties:{}}},
  {name:'mad_autodirect',description:'Render and compare bounded first-accent effect programs with Winnow, then apply the selected program with revision protection.',inputSchema:{type:'object',properties:{baseRevision:{type:'integer'}},required:['baseRevision']}},
  {name:'mad_compile',description:'Compile one bounded technique into native ops without modifying the timeline.',inputSchema:{type:'object',properties:{request:object},required:['request']}},
  {name:'mad_apply_ops',description:'Apply native Freecut operations atomically with a required base revision. Intentional repeated shot use is allowed.',inputSchema:{type:'object',properties:{baseRevision:{type:'integer'},ops:{type:'array',items:object,minItems:1,maxItems:1000}},required:['baseRevision','ops']}},
  {name:'mad_compare_candidates',description:'Render 2–8 candidate edit programs and ask Winnow to compare real frames. A candidate has label and request or requests[]. apply defaults false.',inputSchema:{type:'object',properties:{baseRevision:{type:'integer'},context:{type:'string'},frames:{type:'array',items:{type:'integer'},minItems:1,maxItems:3},candidates:{type:'array',items:object,minItems:2,maxItems:8},apply:{type:'boolean'}},required:['baseRevision','candidates']}},
  {name:'mad_render_frame',description:'Render a frame through the same Freecut compositor as preview and export. Optional ops are preview-only.',inputSchema:{type:'object',properties:{frame:{type:'integer',minimum:0},width:{type:'integer'},height:{type:'integer'},ops:{type:'array',items:object}}}},
  {name:'mad_render',description:'Export the current project or a short range through Freecut. Optional ops are preview-only, not persisted.',inputSchema:{type:'object',properties:{in:{type:'number',minimum:0},duration:{type:'number',exclusiveMinimum:0},ops:{type:'array',items:object}}}},
];
const routes={mad_director_trace:['director/trace','GET'],mad_preview_emotion_change:['director/preview-change','POST'],mad_capabilities:['capabilities','GET'],mad_get_project:['project','GET'],mad_get_catalog:['catalog','GET'],mad_autodirect:['autodirect','POST'],mad_compile:['compile','POST'],mad_apply_ops:['ops','POST'],mad_compare_candidates:['decide','POST'],mad_render_frame:['frame','POST'],mad_render:['render','POST']};
async function call(name,args={}){
  const route=routes[name];if(!route)throw Error('Unknown tool');
  const [path,method]=route,r=await fetch(base+'/'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(args)}:{})});
  if(!r.ok)throw Error(`HTTP ${r.status}: ${(await r.text()).slice(0,1000)}`);
  if(name==='mad_render_frame')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(await r.arrayBuffer()).toString('base64')}]};
  return {content:[{type:'text',text:JSON.stringify(await r.json())}]};
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){if(!line.trim())continue;let request;try{request=JSON.parse(line);if(request.id===undefined)continue;
  let result;if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'winnow-mad-studio',version:'1.0.0'}};
  else if(request.method==='ping')result={};else if(request.method==='tools/list')result={tools};
  else if(request.method==='tools/call'){try{result=await call(request.params?.name,request.params?.arguments);}catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}}
  else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32603,message:e.message}})+'\n');}}
