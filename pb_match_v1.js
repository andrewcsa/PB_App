(function(){
  "use strict";

  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */
  let players = [];        // {id, name, type, level, gamesPlayed, present}
  let nextId = 1;
  let csvFileHandle = null; // File System Access API handle, if supported

  let round = 1;            // round counter, odd = Beginner priority, even = Intermediate
  let currentMatchPlayers = []; // array of player ids currently on court
  let matchState = 'idle';  // idle | running | paused | done
  let timeRemaining = 10*60;
  let timerInterval = null;

  const supportsFSAccess = 'showOpenFilePicker' in window;

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
    return 'Hope Church';
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
        present: true
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
     FILE LOAD / SAVE
  --------------------------------------------------------- */
  const fileStatusEl = document.getElementById('fileStatus');
  function setFileStatus(msg, type){
    fileStatusEl.innerHTML = '<div class="status-msg ' + (type||'') + '">' + msg + '</div>';
  }

  document.getElementById('btnLoadCsv').addEventListener('click', async () => {
    if(supportsFSAccess){
      try{
        const [handle] = await window.showOpenFilePicker({
          types: [{description:'CSV', accept:{'text/csv':['.csv']}}],
          multiple:false
        });
        csvFileHandle = handle;
        const file = await handle.getFile();
        const text = await file.text();
        loadPlayersFromCSVText(text);
        setFileStatus('Loaded ' + players.length + ' players from ' + file.name + '. This file will be reused on Save.', 'ok');
      }catch(err){
        if(err.name !== 'AbortError') setFileStatus('Could not load file: ' + err.message, 'error');
      }
    } else {
      document.getElementById('fileInputFallback').click();
    }
  });

  document.getElementById('fileInputFallback').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      loadPlayersFromCSVText(reader.result);
      setFileStatus('Loaded ' + players.length + ' players from ' + file.name + '. Your browser can\'t auto-save to this file — Save will download a copy.', 'ok');
    };
    reader.readAsText(file);
  });

  document.getElementById('btnSaveCsv').addEventListener('click', async () => {
    const text = playersToCSVText();
    if(supportsFSAccess){
      try{
        if(!csvFileHandle){
          csvFileHandle = await window.showSaveFilePicker({
            suggestedName: 'PB_Playerlist.csv',
            types: [{description:'CSV', accept:{'text/csv':['.csv']}}]
          });
        }
        const writable = await csvFileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        setFileStatus('Saved ' + players.length + ' players to ' + csvFileHandle.name + '.', 'ok');
        return;
      }catch(err){
        if(err.name === 'AbortError') return;
        setFileStatus('Could not save directly: ' + err.message + ' — downloading a copy instead.', 'error');
      }
    }
    // fallback: download
    const blob = new Blob([text], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'PB_Playerlist.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setFileStatus('Downloaded PB_Playerlist.csv (' + players.length + ' players). Move it into your app folder to reuse next time.', 'ok');
  });

  /* ---------------------------------------------------------
     ADD / EDIT / REMOVE PLAYER
  --------------------------------------------------------- */
  document.getElementById('btnAddPlayer').addEventListener('click', () => {
    const nameEl = document.getElementById('newName');
    const name = nameEl.value.trim();
    if(!name){ nameEl.focus(); return; }
    players.push({
      id: uid(),
      name,
      type: document.getElementById('newType').value,
      level: document.getElementById('newLevel').value,
      gamesPlayed: 0,
      present: true
    });
    nameEl.value = '';
    renderAll();
  });

  function removePlayer(id){
    players = players.filter(p => p.id !== id);
    currentMatchPlayers = currentMatchPlayers.filter(pid => pid !== id);
    renderAll();
  }

  function startEdit(id){
    renderPlayerTable(id);
  }

  function saveEdit(id){
    const tr = document.querySelector('tr[data-id="'+id+'"]');
    if(!tr) return;
    const p = players.find(x=>x.id===id);
    if(!p) return;
    p.name = tr.querySelector('.edit-name').value.trim() || p.name;
    p.type = tr.querySelector('.edit-type').value;
    p.level = tr.querySelector('.edit-level').value;
    renderAll();
  }

  /* ---------------------------------------------------------
     RENDER: SETUP TAB
  --------------------------------------------------------- */
  function renderPlayerTable(editingId){
    const tbody = document.getElementById('playerTableBody');
    const empty = document.getElementById('playerEmptyState');
    tbody.innerHTML = '';
    document.getElementById('playerCount').textContent = players.length;

    if(!players.length){ empty.style.display='block'; return; }
    empty.style.display='none';

    players.forEach((p, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.id = p.id;
      if(editingId === p.id){
        tr.classList.add('edit-inline');
        tr.innerHTML = `
          <td class="seq">${idx+1}</td>
          <td><input type="text" class="edit-name" value="${escapeHtml(p.name)}"></td>
          <td>
            <select class="edit-type">
              <option ${p.type==='Hope Church'?'selected':''}>Hope Church</option>
              <option ${p.type==='Visitor'?'selected':''}>Visitor</option>
            </select>
          </td>
          <td>
            <select class="edit-level">
              <option ${p.level==='Beginner'?'selected':''}>Beginner</option>
              <option ${p.level==='Intermediate'?'selected':''}>Intermediate</option>
            </select>
          </td>
          <td style="text-align:center;">—</td>
          <td class="row-actions">
            <button class="icon-btn" data-action="save" title="Save">✓</button>
            <button class="icon-btn" data-action="cancel" title="Cancel">✕</button>
          </td>
        `;
      } else {
        tr.innerHTML = `
          <td class="seq">${idx+1}</td>
          <td>${escapeHtml(p.name)}</td>
          <td><span class="pill ${p.type==='Visitor'?'pill-visitor':'pill-hope'}">${p.type==='Visitor'?'Visitor':'Hope Ch.'}</span></td>
          <td><span class="pill ${p.level==='Intermediate'?'pill-intermediate':'pill-beginner'}">${p.level}</span></td>
          <td style="text-align:center;"><input type="checkbox" class="present-toggle" ${p.present?'checked':''}></td>
          <td class="row-actions">
            <button class="icon-btn" data-action="edit" title="Edit">✎</button>
            <button class="icon-btn" data-action="delete" title="Remove">🗑</button>
          </td>
        `;
      }
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if(action==='edit') startEdit(id);
        else if(action==='delete') removePlayer(id);
        else if(action==='save') saveEdit(id);
        else if(action==='cancel') renderPlayerTable(null);
      });
    });

    tbody.querySelectorAll('.present-toggle').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.closest('tr').dataset.id;
        const p = players.find(x=>x.id===id);
        if(p) p.present = e.target.checked;
        renderStats();
      });
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ---------------------------------------------------------
     MATCHMAKING ALGORITHM
  --------------------------------------------------------- */
  // Pick `count` players from pool, prioritizing those with fewer games played.
  // Ties are broken randomly.
  function weightedPick(pool, count){
    const byGames = {};
    pool.forEach(p => {
      (byGames[p.gamesPlayed] = byGames[p.gamesPlayed] || []).push(p);
    });
    const tiers = Object.keys(byGames).map(Number).sort((a,b)=>a-b);
    const result = [];
    for(const tier of tiers){
      if(result.length >= count) break;
      const bucket = byGames[tier].slice();
      shuffle(bucket);
      for(const p of bucket){
        if(result.length >= count) break;
        result.push(p);
      }
    }
    return result;
  }

  function shuffle(arr){
    for(let i=arr.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [arr[i],arr[j]] = [arr[j],arr[i]];
    }
    return arr;
  }

  function currentPriorityLevel(){
    return (round % 2 === 1) ? 'Beginner' : 'Intermediate';
  }

  // Returns { selected: [players...], shortfall: bool }
  function generateNextMatch(){
    const priority = currentPriorityLevel();
    const pool = players.filter(p => p.present);
    const primary = pool.filter(p => p.level === priority);
    const secondary = pool.filter(p => p.level !== priority);

    let selected = weightedPick(primary, 4);
    if(selected.length < 4){
      const need = 4 - selected.length;
      const fill = weightedPick(secondary, need);
      selected = selected.concat(fill);
    }
    return { selected, priority, shortfall: selected.length < 4 };
  }

  /* ---------------------------------------------------------
     MATCH TAB RENDER / LOGIC
  --------------------------------------------------------- */
  const timerDisplay = document.getElementById('timerDisplay');
  const matchStateLabel = document.getElementById('matchStateLabel');
  const courtEmpty = document.getElementById('courtEmpty');
  const courtPlayersEl = document.getElementById('courtPlayers');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const durationInput = document.getElementById('durationInput');
  const matchStatusEl = document.getElementById('matchStatus');

  function setMatchStatus(msg, type){
    matchStatusEl.innerHTML = msg ? '<div class="status-msg '+(type||'')+'">'+msg+'</div>' : '';
  }

  function formatTime(sec){
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec/60);
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
      const { selected, priority, shortfall } = generateNextMatch();
      currentMatchPlayers = selected.map(p=>p.id);
      selected.forEach(p => p.gamesPlayed += 1);
      const dur = Math.max(1, parseFloat(durationInput.value) || 10);
      timeRemaining = dur*60;
      matchState = 'running';
      matchStateLabel.textContent = 'In Progress';
      renderCourt();
      if(shortfall){
        setMatchStatus('Not enough ' + priority.toLowerCase() + ' players present — filled remaining spots from other level.', '');
      } else {
        setMatchStatus('');
      }
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
    currentMatchPlayers = [];
    round += 1;
    const dur = Math.max(1, parseFloat(durationInput.value) || 10);
    timeRemaining = dur*60;
    renderTimer();
    renderCourt();
    updatePriorityBanner();
    updateControlButtons();
    setMatchStatus('');
  });

  durationInput.addEventListener('change', () => {
    if(matchState === 'idle'){
      const dur = Math.max(1, parseFloat(durationInput.value) || 10);
      timeRemaining = dur*60;
      renderTimer();
    }
  });

  /* ---------------------------------------------------------
     STATISTICS TAB
  --------------------------------------------------------- */
  let statSort = {key:'seq', dir:1};

  function renderStats(){
    document.getElementById('statTotalPlayers').textContent = players.length;
    document.getElementById('statPresent').textContent = players.filter(p=>p.present).length;
    const totalGameSlots = players.reduce((s,p)=>s+p.gamesPlayed,0);
    document.getElementById('statTotalGames').textContent = Math.round(totalGameSlots/4 * 10)/10;

    const tbody = document.getElementById('statsTableBody');
    const empty = document.getElementById('statsEmptyState');
    tbody.innerHTML = '';
    if(!players.length){ empty.style.display='block'; return; }
    empty.style.display='none';

    let rows = players.map((p,i)=>({...p, seq:i+1}));
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
        <td><span class="pill ${p.type==='Visitor'?'pill-visitor':'pill-hope'}">${p.type==='Visitor'?'Visitor':'Hope Ch.'}</span></td>
        <td><span class="pill ${p.level==='Intermediate'?'pill-intermediate':'pill-beginner'}">${p.level}</span></td>
        <td style="text-align:right;font-weight:800;">${p.gamesPlayed}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if(statSort.key === key) statSort.dir *= -1;
      else { statSort.key = key; statSort.dir = 1; }
      renderStats();
    });
  });

  /* ---------------------------------------------------------
     TABS
  --------------------------------------------------------- */
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

  if(!supportsFSAccess){
    document.getElementById('fileHelper').textContent =
      'Your browser doesn\'t support direct file saving — Load opens a file picker, and Save downloads PB_Playerlist.csv (move it into your app folder to reuse it next time).';
  }

  timeRemaining = (parseFloat(durationInput.value)||10)*60;
  renderTimer();
  updateControlButtons();
  renderAll();
})();
