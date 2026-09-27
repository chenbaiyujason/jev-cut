// Musical phrase architecture. Patterns describe rhythm and local jobs, never allowed-shot lists.
const patterns={
 action_chain:{label:'完整动作组：准备→发动→结果，句中快切，句尾让结果可读',weights:[2,1,1,2],jobs:['交代人物与动作的对象，准备必须能看懂','接住上一镜准备并发起动作，优先同方向或同场景','动作到达关键结果，避免插入无关眼睛','交代结果或保护对象的反应，让这一小事件成立']},
 reaction_pair:{label:'关系对切：对象→回应→关系成立，保留眼神方向与空间关系',weights:[2,1,2],jobs:['交代保护对象或两人的真实关系','用对方的反应承接，不连续换相似眼睛','给出关系或守护承诺的具体画面，让情绪有落点']},
 action_hold:{label:'完整动作主镜＋细节＋结果，动作中途不机械换人',weights:[3,1,2],jobs:['选能完整读出的持续行动，允许持镜经过多个鼓点','接同一行动的细节或对象，不打断动作逻辑','以结果、落地、爆炸或守护者的反应收束']},
 match_chain:{label:'姿态或运动方向匹配的短组：两次相接，末镜展开',weights:[1,1,2,2],jobs:['建立清楚的运动方向和主体构图','与前镜动作阶段/构图匹配，无法匹配时用真实动作延续','沿同方向将动作推进，不用滤镜伪装不相干画面','展开景别看清动作结果或人物关系']}
};
export async function planPhraseEditing({phrases,duration,events,musicIntent,goal,ask}){
 const units=phrases.phrases.flatMap((p,i)=>{const b=[p.start,...p.breaks,p.end];return b.slice(0,-1).map((start,j)=>({id:`p${i}_${j}`,start,end:b[j+1],meaning:p.meaning,confidence:p.confidence}));});
 const groups=[];for(const unit of units){if(unit.end-unit.start<1||unit.start>=duration)continue;groups.push({...unit,end:Math.min(duration,unit.end)});}
 if(!groups.length)groups.push({id:'instrumental',start:0,end:duration,meaning:musicIntent.summary});
 // Instrumental gaps belong to the neighboring phrase; the timeline remains fully covered.
 groups[0].start=0;for(let i=0;i<groups.length-1;i++)groups[i].end=groups[i+1].start;groups.at(-1).end=duration;
 const arcs={balanced:['action_chain','reaction_pair','action_chain','reaction_pair','action_hold','match_chain','action_chain','action_hold'],action_forward:['action_chain','action_hold','match_chain','reaction_pair','action_chain','match_chain','action_hold','action_chain'],story_forward:['action_chain','reaction_pair','action_hold','reaction_pair','action_chain','match_chain','action_chain','reaction_pair']};
 const state={goal,music:{summary:musicIntent.summary,sections:musicIntent.sections},groups,plans:Object.fromEntries(Object.entries(arcs).map(([k,a])=>[k,groups.map((g,i)=>({phrase:g.id,structure:patterns[a[i%a.length]].label}))])),rule:'选择完整的半句节奏组合，避免每半句都相同。开头第一个节奏建立点须有真实动作释放；随后用关系/动作/结果交替，不能只堆眼神。不得预选素材或固定剧集范围。'};
 const questions={arc:{type:'choice',instructions:'结合音乐与主题，从三套完整编排中选择最有呼吸和冲击反差的一套。',criteria:{balanced:'动作与关系交替，句尾可读',action_forward:'动作密集，少量关系留白',story_forward:'先关系后行动，保留清晰动机'}}};
 const response=await ask({state,questions}),slots=[];
 const arc=arcs[response.result.answers.arc?.choice];if(!arc)throw Error('Invalid phrase arc');
 for(const [groupIndex,group]of groups.entries()){const mode=arc[groupIndex%arc.length],pattern=patterns[mode];const total=pattern.weights.reduce((a,b)=>a+b,0),cuts=[Math.round(group.start*30)];let w=0;
  for(const weight of pattern.weights.slice(0,-1)){w+=weight;const target=group.start+(group.end-group.start)*w/total;
   const nearby=(events.events||[]).filter(e=>Math.abs(e.time-target)<.13&&e.time>cuts.at(-1)/30+.22).sort((a,b)=>(b.strength||0)-(a.strength||0));cuts.push(Math.round((nearby[0]?.time??target)*30));}
  cuts.push(Math.round(group.end*30));
  if(groupIndex===0){const entry=events.firstEntry??events.primaryAccents?.[0]?.time;if(entry>0.2&&entry<cuts[2]/30-.2)cuts[1]=Math.round(entry*30);}
  for(let i=0;i<cuts.length-1;i++){const start=cuts[i]/30,end=cuts[i+1]/30;if(end<=start)continue;const accent=(events.events||[]).filter(e=>e.time>=start&&e.time<end).sort((a,b)=>b.strength-a.strength)[0];
   const physical=mode!=='reaction_pair'&&i<pattern.jobs.length-1;
   slots.push({start,end,intent:`本半句含义：${group.meaning}。${pattern.label}。当前职责（第${i+1}/${pattern.jobs.length}镜）：${pattern.jobs[i]}。${physical?'必须有实际身体行动、武器动作或行动造成的结果，不能以神情坚定替代行动。':''}人物与保护对象以goal为准。`,physical,phrase:{id:group.id,start:group.start,end:group.end,meaning:group.meaning,progress:(start-group.start)/(group.end-group.start)},accent:accent?.time??start,mode});}
 }
 return {slots,groups,decision:{input:{state,questions},output:response.result,ms:response.ms}};
}
