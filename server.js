import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { randomUUID as uid } from 'crypto';
try { for (const l of fs.readFileSync('.env','utf8').split('\n')) { const m=l.match(/^(\w+)=(.*)$/); if(m) process.env[m[1]]??=m[2]; } } catch {}
const KEY = process.env.GEMINI_API_KEY, MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const D = 'data'; for (const d of ['uploads','projects','renders','thumbs']) fs.mkdirSync(`${D}/${d}`, {recursive:true});
const STYLES = JSON.parse(fs.readFileSync('styles.json'));
const app = express(); app.use(express.json({limit:'10mb'})); app.use(express.static('public'));
app.use('/media', express.static(`${D}/uploads`)); app.use('/thumbs', express.static(`${D}/thumbs`)); app.use('/renders', express.static(`${D}/renders`));
const up = multer({ dest:`${D}/uploads`, limits:{fileSize:2e9}, fileFilter:(r,f,cb)=>cb(null,/\.(mp4|mov|webm)$/i.test(f.originalname)) });
const pf = id => `${D}/projects/${id}.json`;
const load = id => JSON.parse(fs.readFileSync(pf(id)));
const save = p => fs.writeFileSync(pf(p.id), JSON.stringify(p));
const probe = f => JSON.parse(execFileSync('ffprobe',['-v','error','-print_format','json','-show_streams','-show_format',f]).toString());

app.get('/api/health',(_,r)=>r.json({ok:true,gemini:!!KEY}));
app.get('/api/styles', (_,r)=>r.json(STYLES));
app.get('/api/projects', (_,r)=>r.json(fs.readdirSync(`${D}/projects`).map(f=>{const p=JSON.parse(fs.readFileSync(`${D}/projects/${f}`));return {id:p.id,name:p.name,created:p.created,duration:p.duration,status:p.status,thumb:p.thumb};}).sort((a,b)=>b.created-a.created)));
app.get('/api/projects/:id', (q,r)=>fs.existsSync(pf(q.params.id))?r.json(load(q.params.id)):r.status(404).json({error:'Not found'}));
app.put('/api/projects/:id', (q,r)=>{const p={...load(q.params.id),...q.body,id:q.params.id};save(p);r.json({ok:true});});
app.delete('/api/projects/:id', (q,r)=>{try{const p=load(q.params.id);for(const f of [pf(p.id),`${D}/uploads/${p.file}`])fs.rmSync(f,{force:true});}catch{}r.json({ok:true});});

app.post('/api/upload', up.single('video'), (q,r)=>{
  if(!q.file) return r.status(400).json({error:'Upload an MP4, MOV or WebM file'});
  try {
    const id=uid(), info=probe(q.file.path), v=info.streams.find(s=>s.codec_type==='video');
    if(!v) throw new Error('No video stream');
    execFileSync('ffmpeg',['-v','error','-y','-ss','1','-i',q.file.path,'-frames:v','1','-vf','scale=320:-2',`${D}/thumbs/${id}.jpg`]);
    const p={id,name:q.file.originalname.replace(/\.\w+$/,''),file:q.file.filename,ext:path.extname(q.file.originalname).toLowerCase(),created:Date.now(),duration:+info.format.duration,w:v.width,h:v.height,hasAudio:info.streams.some(s=>s.codec_type==='audio'),status:'uploaded',thumb:`/thumbs/${id}.jpg`,segments:[],important:[],mode:'full',styleKey:'ref2',style:{...STYLES.ref2}};
    fs.renameSync(q.file.path,q.file.path+p.ext); p.file+=p.ext; save(p); r.json(p);
  } catch(e){ r.status(400).json({error:'Could not read video: '+e.message}); }
});

async function gemini(parts, schema){
  if(!KEY) throw new Error('GEMINI_API_KEY is not set on the server');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':KEY},
    body:JSON.stringify({contents:[{parts}],generationConfig:{responseMimeType:'application/json',responseSchema:schema,temperature:0.1}})});
  const j=await res.json(); if(!res.ok) throw new Error(j.error?.message||'Gemini error');
  return JSON.parse(j.candidates[0].content.parts[0].text);
}
// Word timing: Gemini gives segment-level times. Words inside a segment are spread by character weight
// and flagged est:true. Swap in forced alignment (e.g. WhisperX) in alignWords() for true word-level times.
function alignWords(text,start,end){
  const ws=text.split(/\s+/).filter(Boolean), tot=ws.reduce((a,w)=>a+w.length+1,0); let t=start;
  return ws.map(w=>{const d=(end-start)*(w.length+1)/tot,o={w,s:+t.toFixed(3),e:+(t+d).toFixed(3),est:true};t+=d;return o;});
}
app.post('/api/projects/:id/transcribe', async (q,r)=>{
  try{
    const p=load(q.params.id); if(!p.hasAudio) throw new Error('Video has no audio track');
    const a=`${D}/uploads/${p.id}.mp3`;
    execFileSync('ffmpeg',['-v','error','-y','-i',`${D}/uploads/${p.file}`,'-vn','-ac','1','-ar','16000','-b:a','48k',a]);
    const audio=fs.readFileSync(a).toString('base64'); fs.rmSync(a);
    const prompt=`Transcribe the speech in this audio into Roman Urdu / Roman English (Latin script only; never Urdu script). Speakers mix Urdu, Hindi and English: keep the exact spoken words and meaning, do NOT translate to formal English. Keep names, brand and technical words as spoken (ChatGPT, Gemini, COMAC). Add natural punctuation. Split into short caption segments of at most 7 words each. start and end are seconds from the start of the audio, accurate to 0.1s; the audio is ${p.duration.toFixed(1)}s long. Skip non-speech.`;
    const out=await gemini([{text:prompt},{inline_data:{mime_type:'audio/mp3',data:audio}}],{type:'ARRAY',items:{type:'OBJECT',properties:{start:{type:'NUMBER'},end:{type:'NUMBER'},text:{type:'STRING'}},required:['start','end','text']}});
    p.segments=out.filter(s=>s.end>s.start).map(s=>({id:uid(),start:s.start,end:Math.min(s.end,p.duration),text:s.text.trim(),words:alignWords(s.text,s.start,s.end)}));
    p.status='ready'; save(p); r.json(p);
  }catch(e){ r.status(500).json({error:e.message}); }
});
app.post('/api/projects/:id/important', async (q,r)=>{
  try{
    const p=load(q.params.id); if(!p.segments.length) throw new Error('Generate the transcript first');
    const tr=p.segments.map((s,i)=>`[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}: ${s.text}`).join('\n');
    const out=await gemini([{text:`From this transcript pick the most important moments (hook, key facts, main points, call to action), roughly one per 8 seconds. Rewrite each as a punchy on-screen caption of 2-6 words in the same Roman Urdu/English language. Give the transcript segment index it comes from.\n${tr}`}],{type:'ARRAY',items:{type:'OBJECT',properties:{from:{type:'INTEGER'},text:{type:'STRING'}},required:['from','text']}});
    p.important=out.filter(o=>p.segments[o.from]).map(o=>{const s=p.segments[o.from];return{id:uid(),start:s.start,end:s.end,text:o.text,words:alignWords(o.text,s.start,s.end)};});
    save(p); r.json(p);
  }catch(e){ r.status(500).json({error:e.message}); }
});

// ---------- export ----------
const ass$=h=>{const n=parseInt(h.slice(1),16);return ((n&255)<<16|(n>>8&255)<<8|n>>16).toString(16).padStart(6,'0').toUpperCase();};
const alpha=o=>Math.round((1-o)*255).toString(16).padStart(2,'0').toUpperCase();
const ts=t=>{const h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=t%60;return `${h}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;};
function buildAss(p,W,H,segs){
  const s=p.style,k=H/1280*(W<H?1:W/H*0.56),sz=Math.round(s.size*k*1.3),pad=s.box?Math.round(s.size*.3*k):Math.round(s.outline*k);
  const anim={pop:'\\fscx70\\fscy70\\t(0,140,\\fscx108\\fscy108)\\t(140,220,\\fscx100\\fscy100)',scale:'\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)',bounce:'\\fscx60\\fscy60\\t(0,160,\\fscx115\\fscy115)\\t(160,260,\\fscx100\\fscy100)',blur:'\\blur8\\t(0,220,\\blur0)',fade:'\\fad(150,120)','slide-up':'\\fad(120,100)'}[s.anim]||'\\fad(120,100)';
  let o=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n`;
  o+=`Style: Default,${s.font},${sz},&H00${ass$(s.color)},&H00${ass$(s.karaoke?s.upcoming:s.color)},&H${s.box?alpha(s.boxOpacity)+ass$(s.boxColor):'00000000'},&H${s.box?alpha(s.boxOpacity)+ass$(s.boxColor):'80000000'},${s.weight>=600?-1:0},0,0,0,100,100,0,0,${s.box?3:1},${s.box?pad:Math.round(s.outline*k)},${Math.round(s.shadow*k)},5,${Math.round(W*.06)},${Math.round(W*.06)},0,1\n\n[Events]\nFormat: Layer,Start,End,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const yEnd=Math.round(H*s.y/100), yStart=yEnd+(s.anim==='slide-up'?Math.round(H*.015):0);
  for(const g of segs){
    const text=g.words.map(w=>{const cs=Math.max(1,Math.round((w.e-w.s)*100)),t=s.caps?w.w.toUpperCase():w.w;
      return `{\\k${cs}${w.k?`\\c&H${ass$(s.hl)}&`:''}}${t}`;}).join(' ');
    const mv=s.anim==='slide-up'?`\\move(${W/2},${yStart},${W/2},${yEnd},0,180)`:`\\pos(${W/2},${yEnd})`;
    const plain=g.words.map(w=>s.caps?w.w.toUpperCase():w.w).join(' ');
    if(s.box) o+=`Dialogue: 0,${ts(g.start)},${ts(g.end)},Default,0,0,0,,{\\an5${mv}${anim}\\1a&HFF&\\k0}${plain}\n`;
    o+=`Dialogue: 1,${ts(g.start)},${ts(g.end)},Default,0,0,0,,{\\an5${mv}${anim}${s.box?'\\bord0\\shad0':''}}${text}\n`;
  }
  return o;
}
const jobs={};
app.post('/api/projects/:id/render', (q,r)=>{
  const p=load(q.params.id), segs=q.body.mode==='important'?p.important:p.segments;
  if(!segs.length) return r.status(400).json({error:'No captions to render'});
  const maxH=+q.body.height||p.h, scale=Math.min(1,maxH/Math.min(p.w,p.h)); // never upscales
  const W=Math.round(p.w*scale/2)*2,H=Math.round(p.h*scale/2)*2, job=uid(); jobs[job]={progress:0,status:'running'};
  const assF=`${D}/renders/${job}.ass`, out=`${D}/renders/${job}.mp4`;
  fs.writeFileSync(assF,buildAss(p,W,H,segs));
  const ff=spawn('ffmpeg',['-y','-i',`${D}/uploads/${p.file}`,'-vf',`scale=${W}:${H},ass=${assF}:fontsdir=fonts`,'-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart','-progress','pipe:1',out]);
  let err=''; ff.stderr.on('data',d=>err+=d);
  ff.stdout.on('data',d=>{const m=/out_time_ms=(\d+)/.exec(d); if(m) jobs[job].progress=Math.min(.99,m[1]/1e6/p.duration);});
  ff.on('close',c=>{ if(c===0) Object.assign(jobs[job],{progress:1,status:'done',url:`/renders/${job}.mp4`}); else Object.assign(jobs[job],{status:'error',error:err.slice(-300)}); });
  r.json({job});
});
app.get('/api/render/:job',(q,r)=>r.json(jobs[q.params.job]||{status:'error',error:'Unknown job'}));
app.listen(process.env.PORT||3000,()=>console.log('Captionly on http://localhost:'+(process.env.PORT||3000)));
