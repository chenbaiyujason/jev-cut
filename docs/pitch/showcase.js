(() => {
  const $ = id => document.getElementById(id);
  const modal = $('screening'), video = $('film-video');
  let catalog, loading, film, active = -1, chapterIndex = -1, opener;
  const time = s => `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
  const exact = s => `${time(s)}.${String(Math.floor(s % 1 * 1000)).padStart(3,'0')}`;
  function node(tag, text, className) { const el = document.createElement(tag); if(text !== undefined) el.textContent = text; if(className) el.className = className; return el; }
  function jump(seconds) { video.currentTime = seconds; update(); }
  function probabilityRow(a) {
    const row = node('div',undefined,'choice-row'+(a.selected?' selected':''));
    const top = node('div'); top.append(node('span',`${a.selected?'✓ 已选 · ':''}EP${String(a.episode ?? '?').padStart(2,'0')} · ${a.description}${a.sourceRange?' · '+exact(a.sourceRange[0])+'–'+exact(a.sourceRange[1]):''}`),node('b',a.probability == null?'—':`${(a.probability*100).toFixed(1)}%`));
    row.append(top,node('i')); row.style.setProperty('--probability',`${Math.max(0,Math.min(100,(a.probability||0)*100))}%`); return row;
  }
  function update() {
    if(!film) return;
    const t = video.currentTime || 0;
    $('film-clock').textContent = `${time(t)} / ${time(film.duration)}`;
    $('film-wave').style.setProperty('--playhead',`${Math.min(100,t/film.duration*100)}%`);
    let ci = film.clips.findIndex(c => t >= c.start && t < c.end);
    if(ci < 0) ci = t >= film.duration-.1 ? film.clips.length-1 : 0;
    const ch = film.chapters.reduce((a,c,i) => t >= c.start ? i : a,0);
    if(ch !== chapterIndex) {
      chapterIndex=ch; const c=film.chapters[ch]; $('chapter-title').textContent=c.title; $('chapter-description').textContent=c.description;
      [...$('film-chapters').children].forEach((b,i)=>b.classList.toggle('active',i===ch));
    }
    if(ci === active) return; active=ci;
    [...$('film-cuts').children].forEach((b,i)=>{b.classList.toggle('active',i===ci); b.setAttribute('aria-pressed',String(i===ci));});
    const c=film.clips[ci],trace=c.trace;
    $('cut-number').textContent=`CUT ${String(ci+1).padStart(2,'0')} / ${film.clipCount}`;
    $('cut-source').textContent=`EP${String(c.episode).padStart(2,'0')}  ·  ${exact(c.sourceStart)} → ${exact(c.sourceEnd)}`;
    $('cut-description').textContent=c.description;
    $('cut-pills').replaceChildren(...[c.audio,c.treatment,`${(c.end-c.start).toFixed(2)} 秒`].map(v=>node('span',v)));
    $('cut-intent').textContent=trace?.context || c.intent || '此镜头未记录独立目标。';
    $('decision-flow').replaceChildren();
    if(trace) {
      [[trace.recallCount,'RAG 召回'],[trace.judgedCount,'Jev 评分'],[1,'最终落镜']].forEach(([n,label],i)=>{if(i) $('decision-flow').append(node('i','→')); const block=node('div');block.append(node('b',String(n)),node('span',label));$('decision-flow').append(block);});
    } else $('decision-flow').append(node('span','此镜头无可对应的完整选择记录'));
    $('choice-model').textContent=trace?.models.join(' / ') || '无记录';
    const choices=trace?.alternatives || [];
    $('cut-choices').replaceChildren(...choices.slice(0,3).map(probabilityRow));
    $('all-choices').replaceChildren(...choices.slice(3).map(probabilityRow));
    document.querySelector('.decision-more').hidden=choices.length<=3;
  }
  function selectFilm(id) {
    const next=catalog.items.find(f=>f.id===id)||catalog.items[0];
    if(film?.id===next.id) return;
    video.pause();film=next;active=-1;chapterIndex=-1;
    $('video-error').hidden=true;video.poster=film.opening || film.poster;video.src=film.video;video.load();
    $('copy-prompt').textContent='复制输入 ↗';
    $('film-title').textContent=`${film.character} · ${film.title}`;$('film-summary').textContent=film.summary;
    $('film-prompt-text').value=film.prompt;$('film-download').href=film.video;
    $('film-facts').textContent=`完整成片 ${film.duration.toFixed(1)} 秒 · ${film.clipCount} 个时间轴片段 / ${film.uniqueShots} 个独立镜头 · 跨 ${film.episodes.length} 集 · 960 × 540 · ${(film.bytes/1000000).toFixed(1)} MB · ${film.sourceEdition}`;
    $('film-wave').replaceChildren(...film.waveform.map(n=>{const e=node('i');e.style.height=`${Math.max(6,n*100)}%`;return e;}));
    $('film-cuts').replaceChildren(...film.clips.map((c,i)=>{const b=node('button');b.type='button';b.style.flexBasis=`${(c.end-c.start)/film.duration*100}%`;b.style.setProperty('--hue',String((c.episode*31+260)%360));b.title=`${time(c.start)} · EP${c.episode} · ${c.description}`;b.setAttribute('aria-label',`镜头 ${i+1}，${b.title}`);b.addEventListener('click',()=>jump(c.start));return b;}));
    $('film-chapters').replaceChildren(...film.chapters.map(c=>{const b=node('button',`${time(c.start)}  ${c.title}`);b.type='button';b.addEventListener('click',()=>jump(c.start));return b;}));
    [...$('film-list').children].forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.film===film.id)));
    $('film-content').hidden=false;update();
  }
  async function open() {
    if(!modal.open){opener=document.activeElement;dispatchEvent(new Event('open-showcase'));modal.showModal();}
    try {
      loading ||= fetch('showcase/catalog.json').then(r=>{if(!r.ok)throw Error('目录加载失败');return r.json();});
      catalog=await loading;
      $('screening-error').hidden=true;
      if(!$('film-list').children.length) catalog.items.forEach((f,i)=>{
        const b=node('button',undefined,'film-option');b.type='button';b.dataset.film=f.id;
        const img=node('img');img.src=f.poster;img.alt='';img.loading='lazy';const text=node('span');text.append(node('strong',f.title),node('small',`${f.character} · ${f.music} · ${Math.round(f.duration)}s`));
        b.append(img,text,node('b',String(i+1).padStart(2,'0')));b.addEventListener('click',()=>{selectFilm(f.id);history.replaceState(null,'',`#films/${f.id}`);});$('film-list').append(b);
      });
      selectFilm(location.hash.split('/')[1]);
    } catch(e){loading=null;$('screening-error').hidden=false;$('screening-error').textContent='作品目录暂时无法加载，请刷新后重试。';}
  }
  function close(){video.pause();modal.close();history.replaceState(null,'',location.pathname+location.search);opener?.focus();}
  $('screening-close').addEventListener('click',close);
  modal.addEventListener('cancel',e=>{e.preventDefault();close();});
  video.addEventListener('timeupdate',update);video.addEventListener('seeked',update);video.addEventListener('loadedmetadata',update);
  video.addEventListener('error',()=>{$('video-error').hidden=false;});
  if(video.requestVideoFrameCallback){const frame=()=>{if(modal.open) update();video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);}
  $('copy-prompt').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(film.prompt);$('copy-prompt').textContent='已复制 ✓';}catch{$('film-prompt-text').focus();$('film-prompt-text').select();$('copy-prompt').textContent='已选中，可手动复制';}});
  addEventListener('hashchange',()=>{if(location.hash.startsWith('#films'))open();else if(modal.open){video.pause();modal.close();}});
  if(location.hash.startsWith('#films'))open();
})();
