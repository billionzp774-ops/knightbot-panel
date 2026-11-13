/**
 * Knight Bot Panel — server.js
 * Express + ws. Serves the static UI, spawns/manages the bot child process,
 * streams stdout/stderr to the browser, and runs git-based Update.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SESSION_DIR = path.join(ROOT, 'session');
const CREDS_FILE = path.join(SESSION_DIR, 'creds.json');
const BOT_INDEX = path.join(ROOT, 'index.js');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- bot process manager ----------
let bot = null;
let restarts = 0;
let startedAt = 0;
let shouldRun = false;     // user wants it running
let retryTimer = null;
const clients = new Set();

function broadcast(obj){ const s = JSON.stringify(obj); for(const c of clients){ if(c.readyState===1) c.send(s); } }
function logLine(line){
  const t = String(line).replace(/\r/g,'');
  if(!t) return;
  broadcast({type:'log', line:t});
}
function emitState(){
  broadcast({
    type:'state',
    state: bot ? 'online' : (shouldRun ? 'starting' : 'offline'),
    uptime: bot ? humanUptime(Date.now()-startedAt) : null,
    restarts, pid: bot ? bot.pid : null,
  });
}

function humanUptime(ms){
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if(h) return `${h}h ${m}m`;
  if(m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function ensureSessionDir(){
  if(!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, {recursive:true});
}

function writeCreds(jsonString){
  ensureSessionDir();
  // Baileys multi-file auth only strictly needs creds.json to boot a paired session
  fs.writeFileSync(CREDS_FILE, jsonString, {encoding:'utf8'});
}

function spawnBot(){
  if(bot) return;
  shouldRun = true;
  startedAt = Date.now();
  logLine('>>> spawning bot: node index.js');
  bot = spawn('node', [BOT_INDEX], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV:'production' },
    stdio: ['ignore','pipe','pipe'],
  });
  bot.stdout.on('data', d => { d.toString().split('\n').forEach(l => l.trim() && logLine(l)); });
  bot.stderr.on('data', d => { d.toString().split('\n').forEach(l => l.trim() && logLine(l)); });
  bot.on('exit', (code, sig) => {
    logLine(`<<< bot exited code=${code} sig=${sig}`);
    bot = null;
    emitState();
    if(shouldRun){
      restarts++;
      const delay = Math.min(15000, 3000 * restarts);
      logLine(`>>> auto-restart in ${Math.round(delay/1000)}s (attempt ${restarts})`);
      retryTimer = setTimeout(() => {
        if(shouldRun && !bot) spawnBot();
      }, delay);
    } else {
      restarts = 0;
    }
    emitState();
  });
  emitState();
}

function stopBot(){
  shouldRun = false;
  if(retryTimer){ clearTimeout(retryTimer); retryTimer=null; }
  if(!bot) return Promise.resolve({ok:true});
  return new Promise(resolve => {
    const p = bot;
    let killed = false;
    const fin = () => { if(!killed){ killed=true; resolve({ok:true}); } };
    p.once('exit', fin);
    try { p.kill('SIGTERM'); } catch(e){}
    // escalate after 5s
    setTimeout(() => {
      if(!p.killed && p.exitCode===null && p.signalCode===null){
        try { p.kill('SIGKILL'); } catch(e){}
      }
    }, 5000);
    setTimeout(fin, 7000);
  });
}

async function restartBot(){
  await stopBot();
  shouldRun = true;
  spawnBot();
  return {ok:true};
}

// ---------- routes ----------
app.get('/api/meta', (req,res)=>{
  let repo='—', head='—';
  try{
    repo = fs.readFileSync(path.join(ROOT,'.git/config'),'utf8')
      .match(/url = (.+)/)?.[1] || '—';
  }catch(e){}
  try{
    head = fs.readFileSync(path.join(ROOT,'.git/refs/heads/main'),'utf8').trim()
      || fs.readFileSync(path.join(ROOT,'.git/HEAD'),'utf8').trim();
  }catch(e){}
  res.json({ok:true, repo, head});
});

app.get('/api/status', (req,res)=>{
  res.json({
    ok:true,
    state: bot ? 'online' : (shouldRun ? 'starting' : 'offline'),
    uptime: bot ? Date.now()-startedAt : null,
    restarts, pid: bot ? bot.pid : null,
  });
});

app.post('/api/start', async (req,res)=>{
  const sess = req.body && req.body.session;
  if(!sess || typeof sess !== 'string') return res.status(400).json({ok:false, error:'No session provided'});
  let parsed;
  try { parsed = JSON.parse(sess); }
  catch(e){ return res.status(400).json({ok:false, error:'Session is not valid JSON'}); }
  if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return res.status(400).json({ok:false, error:'creds.json must be an object'});
  try {
    writeCreds(sess);
  } catch(e){
    return res.status(500).json({ok:false, error:'Failed to write session: '+e.message});
  }
  if(bot){ await stopBot(); }
  restarts = 0;
  spawnBot();
  res.json({ok:true, msg:'Bot starting'});
});

app.post('/api/stop', async (req,res)=>{ const r = await stopBot(); res.json({...r, msg:'Stopping'}); });
app.post('/api/restart', async (req,res)=>{ const r = await restartBot(); res.json({...r, msg:'Restarting'}); });

app.post('/api/clear', (req,res)=>{
  try {
    stopBot();
    if(fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, {recursive:true, force:true});
    fs.mkdirSync(SESSION_DIR, {recursive:true});
    res.json({ok:true, msg:'Session cleared'});
  } catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

// git-based Update
app.post('/api/update', (req,res)=>{
  res.json({ok:true, msg:'Update started'});
  runUpdate();
});

function runGit(args){ return new Promise((resolve)=>{
  execFile('git', args, {cwd:ROOT, maxBuffer: 2*1024*1024}, (e,out,err)=>{
    resolve({ok:!e, out:(out||'').toString().trim(), err:(err||'').toString().trim(), code:e});
  });
}); }

async function runUpdate(){
  broadcast({type:'update', info:'Fetching latest…'});
  logLine('>>> git fetch origin');
  let r = await runGit(['fetch','--all','--prune']);
  if(!r.ok){ broadcast({type:'update', done:true, ok:false, info:'git fetch failed'}); logLine('!!! git fetch: '+r.err); return; }

  // hard reset to origin/main (or master fallback)
  let branch = 'main';
  r = await runGit(['rev-parse','--verify','origin/main']);
  if(!r.ok){ r = await runGit(['rev-parse','--verify','origin/master']); if(r.ok) branch='master'; }
  broadcast({type:'update', info:`Resetting to origin/${branch}…`});
  logLine(`>>> git reset --hard origin/${branch}`);
  r = await runGit(['reset','--hard', `origin/${branch}`]);
  if(!r.ok){ broadcast({type:'update', done:true, ok:false, info:'git reset failed'}); logLine('!!! git reset: '+r.err); return; }

  broadcast({type:'update', info:'Reinstalling dependencies…'});
  logLine('>>> npm install --omit=dev --legacy-peer-deps');
  await new Promise((resolve)=>{
    const np = spawn('npm', ['install','--omit=dev','--legacy-peer-deps'], {cwd:ROOT, stdio:'pipe', shell:false});
    np.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && logLine('   '+l)));
    np.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && logLine('   '+l)));
    np.on('exit', resolve);
    np.on('error', resolve);
  });

  // grab new HEAD
  let head='—';
  try{ head = fs.readFileSync(path.join(ROOT,'.git/refs/heads/'+branch),'utf8').trim(); }catch(e){}
  broadcast({type:'update', done:true, ok:true, info:`Updated to ${branch}@${head.slice(0,7)}`});
  logLine(`>>> update complete: origin/${branch}@${head.slice(0,7)}`);

  // restart bot if it was running
  if(shouldRun){
    logLine('>>> restarting bot after update');
    await stopBot(); spawnBot();
  }
}

// ---------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path:'/ws' });
wss.on('connection', (ws)=>{
  clients.add(ws);
  ws.on('close', ()=> clients.delete(ws));
  ws.on('message', ()=>{ /* UI uses HTTP for commands */ });
  emitState();
});

server.listen(PORT, ()=> console.log('Panel listening on :'+PORT));

// auto-start if creds already present (Railway redeploy recovery)
ensureSessionDir();
if(fs.existsSync(CREDS_FILE)){
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'));
    if(c && typeof c === 'object' && (c.noiseKey || c.registered || c.me)){
      shouldRun = true;
      spawnBot();
    }
  } catch(e){ /* ignore broken creds */ }
}

// health/keepalive ping so Railway doesn't sleep
setInterval(() => {
  fetchSelf();
}, 25*60*1000);
function fetchSelf(){
  try {
    require('http').get(`http://127.0.0.1:${PORT}/api/status`, ()=>{}).on('error',()=>{});
  } catch(e){}
}
