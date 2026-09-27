const active=new Map();
export function beginEditEpoch(projectId){const token={cancelled:false};const old=active.get(projectId);if(old)old.cancelled=true;active.set(projectId,token);return {current:()=>active.get(projectId)===token&&!token.cancelled,cancel:()=>{token.cancelled=true;}};}
