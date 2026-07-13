(function(){
  "use strict";

  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */
  let players = [];        // {id, name, type, level, gamesPlayed, present}
  let nextId = 1;

  let round = 1;            // round counter, odd = Beginner priority, even = Intermediate
  let currentMatchPlayers = []; // array of player ids currently on court
  let matchState = 'idle';  // idle | running | paused | done
  let timeRemaining = 10*60;
  let timerInterval = null;

  /* ---------------------------------------------------------
     PROXY CONFIG
     No token here — this is safe to commit. The Cloudflare Worker holds the
     GitHub token as a server-side secret and does the authenticated calls.
     Update this to your deployed Worker's URL.
  --------------------------------------------------------- */
  const PROXY_CONFIG = {
    endpoint: 'https://pb-github-proxy.andrew-59d.workers.dev/playerlist'
  };

  // sha of the last-loaded file, required by GitHub's API to update (not create) a file
  let githubFileSha = null;

  /* ---------------------------------------------------------
     UTIL
  --------------------------------------------------------- */
  function uid(){ return 'p' + (nextId++); }

  function csvEscape(val){
    val = String(val ?? '');
    if(/[",\n]/.test(val)){
      return '"' + val.replace(/"/g,'""') + '"';
    }
    return val;
  }

  function parseCSV(text){
    // simple RFC4180-ish parser
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for(let i=0;i<text.length;i++){
      const c = text[i];
      if(inQuotes){
        if(c === '"'){
          if(text[i+1] === '"'){ field += '"'; i++; }
          else { inQuotes = false; }
        } else field += c;
      } else {
        if(c === '"') inQuotes = true;
        else if(c === ','){ row.push(field); field=''; }
        else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=''; }
        else if(c === '\r'){ /* skip */ }
        else field += c;
      }
    }
    if(field.length || row.length){ row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f.trim() !== ''));
  }

  function normalizeType(t){
    t = (t||'').trim().toLowerCase();
    if(t.startsWith('visitor')) return 'Visitor';
    return 'HCA';
  }
  function normalizeLevel(l){
    l = (l||'').trim().toLowerCase();
    if(l.startsWith('inter')) return 'Intermediate';
    return 'Beginner';
  }

  function loadPlayersFromCSVText(text){
    const rows = parseCSV(text);
    if(!rows.length) return;
    let startIdx = 0;
    const header = rows[0].map(h => h.trim().toLowerCase());
    const looksLikeHeader = header.includes('name');
    if(looksLikeHeader) startIdx = 1;

    let nameIdx=0, typeIdx=1, levelIdx=2, gamesIdx=3;
    if(looksLikeHeader){
      nameIdx = header.indexOf('name'); if(nameIdx<0) nameIdx=0;
      typeIdx = header.indexOf('type'); if(typeIdx<0) typeIdx=1;
      levelIdx = header.indexOf('level'); if(levelIdx<0) levelIdx=2;
      gamesIdx = header.indexOf('gamesplayed');
      if(gamesIdx<0) gamesIdx = header.indexOf('games');
    }

    const loaded = [];
    for(let i=startIdx;i<rows.length;i++){
      const r = rows[i];
      const name = (r[nameIdx]||'').trim();
      if(!name) continue;
      loaded.push({
        id: uid(),
        name,
        type: normalizeType(r[typeIdx]),
        level: normalizeLevel(r[levelIdx]),
        gamesPlayed: gamesIdx>=0 ? (parseInt(r[gamesIdx],10)||0) : 0,
        present: false
      });
    }
    players = loaded;
    renderAll();
  }

  function playersToCSVText(){
    const lines = ['Name,Type,Level,GamesPlayed'];
    players.forEach(p=>{
      lines.push([csvEscape(p.name), csvEscape(p.type), csvEscape(p.level), p.gamesPlayed].join(','));
    });
    return lines.join('\n');
  }

  /* ---------------------------------------------------------
     LOAD / SAVE VIA CLOUDFLARE WORKER PROXY
  --------------------------------------------------------- */
  function utf8ToBase64(str){
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  function base64ToUtf8(b64){
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function proxyErrText(res){
    try{
      const data = await res.json();
      return data.message || res.statusText;
    }catch(e){
      return res.statusText;
    }
  }

  // Fetches the CSV file's text content via the Worker proxy. Records its sha for later saves.
  // Returns null (with githubFileSha reset) if the file doesn't exist yet (404).
  async function githubLoadCSV(){
    const res = await fetch(PROXY_CONFIG.endpoint);
    if(res.status === 404){
      githubFileSha = null;
      return null;
    }
    if(!res.ok){
      throw new Error('Load failed (' + res.status + '): ' + await proxyErrText(res));
    }
    const data = await res.json();
    githubFileSha = data.sha || null;
    return base64ToUtf8(data.content || '');
  }

  // Writes CSV text via the Worker proxy, which creates or updates the GitHub file.
  async function githubSaveCSV(text){
    const body = { content: utf8ToBase64(text) };
    if(githubFileSha) body.sha = githubFileSha;

    const res = await fetch(PROXY_CONFIG.endpoint, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if(!res.ok){
      throw new Error('Save failed (' + res.status + '): ' + await proxyErrText(res));
    }
    const data = await res.json();
    githubFileSha = (data.content && data.content.sha) || githubFileSha;
    return data;
  }

  /* ---------------------------------------------------------
     FILE LOAD / SAVE
  --------------------------------------------------------- */
  const fileStatusEl = document.getElementById('fileStatus');
  function setFileStatus(msg, type){
    fileStatusEl.innerHTML = '<div class="status-msg ' + (type||'') + '">' + msg + '</div>';
  }

  document.getElementById('btnLoadCsv').addEventListener('click', async () => {
    setFileStatus('Loading player list from GitHub…', '');
    try{
      const text = await githubLoadCSV();
      if(text === null){
        players = [];
        renderAll();
        setFileStatus('No player list file found on GitHub yet — starting with an empty list. Saving will create it.', '');
      } else {
        loadPlayersFromCSVText(text);
        setFileStatus('Loaded ' + players.length + ' players from GitHub.', 'ok');
      }
    }catch(err){
      setFileStatus('Could not load from GitHub: ' + err.message, 'error');
    }
  });

  document.getElementById('btnSaveCsv').addEventListener('click', async () => {
    const text = playersToCSVText();
    setFileStatus('Saving player list to GitHub…', '');
    try{
      await githubSaveCSV(text);
      setFileStatus('Saved ' + players.length + ' players to GitHub.', 'ok');
    }catch(err){
      setFileStatus('Could not save to GitHub: ' + err.message + ' — downloading a local copy instead.', 'error');
      // Fallback so data isn't lost if the GitHub call fails (bad token, offline, etc.)
      const blob = new Blob([text], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'PB_Playerlist.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
  });

  const s = sec % 60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

function updatePriorityBanner(){
  const p = currentPriorityLevel();
  const el = document.getElementById('priorityValue');
  el.textContent = p;
  el.className = 'value ' + p.toLowerCase();
  document.getElementById('roundValue').textContent = round;
}

function currentPriorityLevel(){
  if(matchMode === 'mix') return 'Mix';
  return (matchMode === 'intermediate') ? 'Intermediate' : 'Beginner';
}

function renderTimer(){
  timerDisplay.textContent = formatTime(timeRemaining);
  const total = (parseFloat(durationInput.value)||10)*60;
  timerDisplay.classList.remove('warning','done');
  if(timeRemaining <= 0){
    timerDisplay.classList.add('done');
  } else if(timeRemaining <= Math.min(30, total*0.15)){
    timerDisplay.classList.add('warning');
  }
}

function renderCourt(){
  if(!currentMatchPlayers.length){
    courtEmpty.style.display='block';
    courtPlayersEl.style.display='none';
    return;
  }
  courtEmpty.style.display='none';
  courtPlayersEl.style.display='grid';
  courtPlayersEl.innerHTML = currentMatchPlayers.map(id => {
    const p = players.find(x=>x.id===id);
    if(!p) return '';
    return `<div class="court-player">
    <div class="pname">${escapeHtml(p.name)}</div>
    <span class="pill ${p.level==='Intermediate'?'pill-intermediate':'pill-beginner'}">${p.level}</span>
    </div>`;
  }).join('');
}

function updateControlButtons(){
  btnStart.disabled = (matchState === 'running');
  btnPause.disabled = (matchState !== 'running');
  btnStop.disabled = (matchState === 'idle');
  btnStart.textContent = (matchState === 'paused') ? 'Resume' : (matchState === 'done' ? 'Next Match' : 'Start');
}

function tick(){
  timeRemaining -= 1;
  if(timeRemaining <= 0){
    timeRemaining = 0;
    clearInterval(timerInterval);
    timerInterval = null;
    matchState = 'done';
    matchStateLabel.textContent = "Time's up!";
    round += 1;
    updatePriorityBanner();
    if(navigator.vibrate) navigator.vibrate([200,100,200]);
    updateControlButtons();
  }
  renderTimer();
}

btnStart.addEventListener('click', () => {
  const pool = players.filter(p=>p.present);
  if(pool.length < 4){
    setMatchStatus('Need at least 4 present players to start a match.', 'error');
    return;
  }
  if(matchState === 'idle' || matchState === 'done'){
    // A match is "loaded" onto the court already if a mode button was pressed
    // (or a previous preview is still sitting there from idle). Coming from
    // 'done' the court is showing the match that JUST finished, so always
    // pull a fresh set of players for the next one.
    if(matchState === 'done' || !currentMatchPlayers.length){
      loadMatchPreview();
    }
    if(currentMatchPlayers.length < 4){
      setMatchStatus('Need at least 4 present players to start a match.', 'error');
      return;
    }
    // Games only count now that the match is actually starting.
    currentMatchPlayers.forEach(id => {
      const p = players.find(x => x.id === id);
      if(p) p.gamesPlayed += 1;
    });
      const dur = Math.max(0.1, parseFloat(durationInput.value) || 10);
      timeRemaining = dur*60;
      matchState = 'running';
      matchStateLabel.textContent = 'In Progress';
      renderCourt();
      renderStats();
  } else if(matchState === 'paused'){
    matchState = 'running';
    matchStateLabel.textContent = 'In Progress';
  }
  timerInterval = setInterval(tick, 1000);
  renderTimer();
  updateControlButtons();
});

btnPause.addEventListener('click', () => {
  if(matchState !== 'running') return;
  clearInterval(timerInterval);
  timerInterval = null;
  matchState = 'paused';
  matchStateLabel.textContent = 'Paused';
  updateControlButtons();
});

btnStop.addEventListener('click', () => {
  clearInterval(timerInterval);
  timerInterval = null;
  matchState = 'idle';
  matchStateLabel.textContent = 'Ready';
  round += 1;
  const dur = Math.max(0.1, parseFloat(durationInput.value) || 10);
  timeRemaining = dur*60;
  renderTimer();
  updatePriorityBanner();
  updateControlButtons();
  loadMatchPreview(); // show the next match's players right away (not started yet)
});

durationInput.addEventListener('change', () => {
  if(matchState === 'idle'){
    const dur = Math.max(0.1, parseFloat(durationInput.value) || 10);
    timeRemaining = dur*60;
    renderTimer();
  }
});

/* ---------------------------------------------------------
 *     STATISTICS TAB
 *  --------------------------------------------------------- */
let statSort = {key:'seq', dir:1};

function renderStats(){
  document.getElementById('statTotalPlayers').textContent = players.length;
  document.getElementById('statPresent').textContent = players.filter(p=>p.present).length;
  const totalGameSlots = players.reduce((s,p)=>s+p.gamesPlayed,0);
  document.getElementById('statTotalGames').textContent = Math.round(totalGameSlots/4 * 10)/10;

  const tbody = document.getElementById('statsTableBody');
  const empty = document.getElementById('statsEmptyState');
  tbody.innerHTML = '';

  // --- CHANGE MADE HERE: Added .filter(p => p.present) ---
  let rows = players
  .filter(p => p.present)
  .map((p,i)=>({...p, seq:i+1}));

  if(!rows.length){ empty.style.display='block'; return; }
  empty.style.display='none';

  rows.sort((a,b)=>{
    let av=a[statSort.key], bv=b[statSort.key];
    if(typeof av === 'string'){ av=av.toLowerCase(); bv=bv.toLowerCase(); }
    if(av<bv) return -1*statSort.dir;
    if(av>bv) return 1*statSort.dir;
    return 0;
  });

  rows.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
    <td class="seq">${p.seq}</td>
    <td>${escapeHtml(p.name)}</td>
    <td><span class="pill ${p.type==='Visitor'?'pill-visitor':'pill-hope'}">${p.type==='Visitor'?'Visitor':'HCA'}</span></td>
    <td><span class="pill ${p.level==='Intermediate'?'pill-intermediate':'pill-beginner'}">${p.level}</span></td>
    <td style="text-align:right;font-weight:800;">${p.gamesPlayed}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ---------------------------------------------------------
 *     TABS
 *  --------------------------------------------------------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if(btn.dataset.tab === 'tab-stats') renderStats();
  });
});


  /* ---------------------------------------------------------
     INIT
  --------------------------------------------------------- */
  function renderAll(){
    renderPlayerTable(null);
    renderStats();
    updatePriorityBanner();
  }

  const fileHelperEl = document.getElementById('fileHelper');
  if(fileHelperEl){
    fileHelperEl.textContent =
      'Load pulls the player list from GitHub, and Save writes it back — both go through a Cloudflare Worker proxy (configured in PROXY_CONFIG) that keeps the GitHub token server-side.';
  }

  timeRemaining = (parseFloat(durationInput.value)||10)*60;
  renderTimer();
  updateControlButtons();
  setMatchMode('beginner');
  renderAll();
})();
