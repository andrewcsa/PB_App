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
  let timeRemaining = 0;
  let timerInterval = null;
  let noTimerMode = false;  // true when duration is set to 0 -> no countdown timer for the match
  let pendingSwapSlot = null; // player id of the on-court slot awaiting a manual swap-in

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

  /* ---------------------------------------------------------
   *     ADD / EDIT / REMOVE PLAYER
   *  --------------------------------------------------------- */
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
   *     RENDER: SETUP TAB
   *  --------------------------------------------------------- */
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
        <option ${p.type==='HCA'?'selected':''}>HCA</option>
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
        <td><span class="pill ${p.type==='Visitor'?'pill-visitor':'pill-hope'}">${p.type==='Visitor'?'Visitor':'HCA'}</span></td>
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
   *     MATCHMAKING ALGORITHM
   *  --------------------------------------------------------- */
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

  // Returns { selected: [players...], shortfall: bool }
  function generateNextMatch(){
    if(matchMode === 'mix'){
      return generateMixMatch();
    }
    const priority = currentPriorityLevel(); // 'Beginner' or 'Intermediate', driven by matchMode
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

  // Mix mode: pick 2 Beginner + 2 Intermediate players (each group weighted by lowest
  // gamesPlayed first). If one group falls short of 2, fill the remainder from whichever
  // present players haven't already been selected (weighted by lowest gamesPlayed).
  function generateMixMatch(){
    const pool = players.filter(p => p.present);
    if(pool.length < 4){
      return { selected: [], priority:'Mix', shortfall:true };
    }

    // Lowest games played among all present players
    const minGames = Math.min(...pool.map(p => p.gamesPlayed));

    // Only players with the lowest game count
    let lowestPool = pool.filter(p => p.gamesPlayed === minGames);

    let beginners = lowestPool.filter(p => p.level === 'Beginner');
    let intermediates = lowestPool.filter(p => p.level === 'Intermediate');

    let selected = [];

    // Try to keep 2 Beginner + 2 Intermediate
    selected.push(...shuffle(beginners).slice(0,2));
    selected.push(...shuffle(intermediates).slice(0,2));

    // If not enough players with the minimum game count,
    // gradually include players with the next lowest counts.
    if(selected.length < 4){
      const remaining = pool
      .filter(p => !selected.some(s => s.id === p.id))
      .sort((a,b) => a.gamesPlayed - b.gamesPlayed);

      let currentGames = -1;
      let bucket = [];

      for(const p of remaining){
        if(currentGames === -1){
          currentGames = p.gamesPlayed;
        }

        if(p.gamesPlayed !== currentGames){
          shuffle(bucket);
          while(bucket.length && selected.length < 4){
            selected.push(bucket.pop());
          }
          currentGames = p.gamesPlayed;
          bucket = [];
        }

        bucket.push(p);
      }

      shuffle(bucket);
      while(bucket.length && selected.length < 4){
        selected.push(bucket.pop());
      }
    }

    return {
      selected,
      priority:'Mix',
      shortfall:selected.length < 4
    };
  }

  /* ---------------------------------------------------------
   *     MATCH TAB RENDER / LOGIC
   *  --------------------------------------------------------- */
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

  /* ---------------------------------------------------------
   *     PRIORITY MODE SELECTOR (Beginner / Intermediate / Mix)
   *  --------------------------------------------------------- */
  let matchMode = 'beginner'; // 'beginner' | 'intermediate' | 'mix'

  const priorityModeWrap = document.createElement('div');
  priorityModeWrap.id = 'priorityModeWrap';
  priorityModeWrap.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;';
  priorityModeWrap.innerHTML = `
  <button type="button" class="mode-btn" data-mode="beginner">Beginner</button>
  <button type="button" class="mode-btn" data-mode="intermediate">Intermediate</button>
  <button type="button" class="mode-btn" data-mode="mix">Mix</button>
  `;
  btnStart.parentNode.insertBefore(priorityModeWrap, btnStart);

  const modeBtnStyleEl = document.createElement('style');
  modeBtnStyleEl.textContent = `
  .mode-btn{padding:8px 16px;border-radius:8px;border:2px solid #d0d5dd;background:#fff;
    font-weight:700;cursor:pointer;color:#344054;font-size:14px;}
    .mode-btn.active{background:#2563eb;border-color:#2563eb;color:#fff;}
    .court-player.swappable .pname{cursor:pointer;transition:background .15s,color .15s;border-radius:6px;padding:4px 8px;}
    .court-player.swappable .pname:hover{background:#eff6ff;}
    .court-player.swap-selected .pname{background:#2563eb !important;color:#fff !important;}
    .stat-name.swap-target{cursor:pointer;}
    .stat-name.swap-target:hover{text-decoration:underline;color:#2563eb;}
    .stat-name.on-court{color:#98a2b3;}
    .swap-hint{margin-bottom:10px;padding:10px 14px;border-radius:8px;background:#eff6ff;
      border:1px solid #bfdbfe;color:#1d4ed8;font-weight:600;font-size:14px;display:none;}
    `;
    document.head.appendChild(modeBtnStyleEl);

    function setMatchMode(mode){
      matchMode = mode;
      priorityModeWrap.querySelectorAll('.mode-btn').forEach(b=>{
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      updatePriorityBanner();
      // Selecting a mode loads/refreshes the match list on the court right away.
      // Games only start counting once the Start button is actually pressed.
      if(matchState === 'idle' || matchState === 'done'){
        loadMatchPreview();
      }
    }

    // Selects the next match's players (per the current mode) and shows them on the
    // court WITHOUT starting the timer or incrementing anyone's gamesPlayed.
    function loadMatchPreview(){
      pendingSwapSlot = null; // a freshly loaded preview invalidates any old swap selection
      const pool = players.filter(p => p.present);
      if(pool.length < 4){
        currentMatchPlayers = [];
        renderCourt();
        setMatchStatus('');
        return;
      }
      const { selected, priority, shortfall } = generateNextMatch();
      currentMatchPlayers = selected.map(p => p.id);
      renderCourt();
      if(shortfall){
        const msg = (priority === 'Mix')
        ? 'Not enough players in one level to make an even 2/2 mix — filled remaining spots from the other level.'
        : 'Not enough ' + priority.toLowerCase() + ' players present — filled remaining spots from other level.';
        setMatchStatus(msg, '');
      } else {
        setMatchStatus('');
      }
    }

    priorityModeWrap.querySelectorAll('.mode-btn').forEach(b=>{
      b.addEventListener('click', () => {
        if(matchState === 'running' || matchState === 'paused') return; // don't allow switching mid-match
        setMatchMode(b.dataset.mode);
      });
    });

    // Reads the duration input as a number. Unlike `parseFloat(x) || 10`, this
    // correctly treats an explicit 0 as "no timer" instead of falling back to 10
    // (0 is falsy in JS, so the old `||` pattern silently discarded it).
    function getDurationMinutes(){
      const v = parseFloat(durationInput.value);
      return isNaN(v) ? 0 : v;
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

    function currentPriorityLevel(){
      if(matchMode === 'mix') return 'Mix';
      return (matchMode === 'intermediate') ? 'Intermediate' : 'Beginner';
    }

    function renderTimer(){
      if(noTimerMode){
        // Duration is 0 -> no timer for this match, so remove it from view entirely.
        timerDisplay.style.display = 'none';
        timerDisplay.textContent = '';
        timerDisplay.classList.remove('warning','done');
        return;
      }
      timerDisplay.style.display = '';
      timerDisplay.textContent = formatTime(timeRemaining);
      const total = Math.max(0.1, getDurationMinutes())*60;
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
      const swappable = true; // manual swaps are allowed any time there's a match on the court
      courtPlayersEl.innerHTML = currentMatchPlayers.map(id => {
        const p = players.find(x=>x.id===id);
        if(!p) return '';
        const selected = (pendingSwapSlot === id);
        return `<div class="court-player ${swappable?'swappable':''} ${selected?'swap-selected':''}" data-id="${p.id}">
        <div class="pname" style="font-size:1.6rem;font-weight:700;">
        ${escapeHtml(p.name)}
        </div>
        </div>`;
      }).join('');

      if(swappable){
        courtPlayersEl.querySelectorAll('.court-player').forEach(el => {
          el.addEventListener('click', () => startPlayerSwap(el.dataset.id));
        });
      }
    }

    // Click a court player's name (while the match is running or paused) to select
    // them for a manual swap, then click a present player's name on the
    // Statistics tab to bring them onto the court in that slot.
    function startPlayerSwap(id){
      if(!currentMatchPlayers.length) return;
      pendingSwapSlot = (pendingSwapSlot === id) ? null : id;
      renderCourt();
      renderStats();
      if(pendingSwapSlot){
        const p = players.find(x=>x.id===id);
        setMatchStatus('Selected ' + escapeHtml(p ? p.name : '') + ' — tap a present player on the Statistics tab to swap them in (or tap ' + escapeHtml(p ? p.name : 'this player') + ' again to cancel).', '');
      } else {
        setMatchStatus('');
      }
    }

    // Called by clicking a player's name on the Statistics tab. Only does
    // anything while a court slot is selected via startPlayerSwap above.
    function completePlayerSwap(newId){
      if(!pendingSwapSlot) return;
      if(!currentMatchPlayers.length){
        pendingSwapSlot = null;
        return;
      }
      if(newId === pendingSwapSlot){
        pendingSwapSlot = null;
        renderCourt();
        renderStats();
        setMatchStatus('');
        return;
      }
      if(currentMatchPlayers.includes(newId)) return; // already on court, ignore
      const newPlayer = players.find(x => x.id === newId);
      if(!newPlayer || !newPlayer.present){
        setMatchStatus('Only present players can be swapped onto the court.', 'error');
        return;
      }
      const slotIdx = currentMatchPlayers.indexOf(pendingSwapSlot);
      if(slotIdx === -1){ pendingSwapSlot = null; return; }
      const oldPlayer = players.find(x => x.id === pendingSwapSlot);
      currentMatchPlayers[slotIdx] = newId;
      pendingSwapSlot = null;
      renderCourt();
      renderStats();
      setMatchStatus('Swapped ' + escapeHtml(oldPlayer ? oldPlayer.name : 'player') + ' out for ' + escapeHtml(newPlayer.name) + '.', 'ok');
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
        pendingSwapSlot = null;
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
          // NOTE: gamesPlayed is no longer incremented here. It's committed when
          // the Stop button is pressed, once the match has actually been played.
          pendingSwapSlot = null; // a fresh match starts with no swap selection
          const dur = getDurationMinutes();
          noTimerMode = (dur === 0);
          timeRemaining = noTimerMode ? 0 : Math.max(0.1, dur)*60;
          matchState = 'running';
          matchStateLabel.textContent = 'In Progress';
          renderCourt();
          renderStats();
      } else if(matchState === 'paused'){
        matchState = 'running';
        matchStateLabel.textContent = 'In Progress';
      }
      if(noTimerMode){
        // Duration is 0 -> no countdown timer for this match; nothing to tick.
        if(timerInterval){ clearInterval(timerInterval); timerInterval = null; }
      } else {
        timerInterval = setInterval(tick, 1000);
      }
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
      // Games are committed here, now that the match has actually been played,
      // rather than pre-emptively when it was started.
      currentMatchPlayers.forEach(id => {
        const p = players.find(x => x.id === id);
        if(p) p.gamesPlayed += 1;
      });

      clearInterval(timerInterval);
      timerInterval = null;
      matchState = 'idle';
      matchStateLabel.textContent = 'Ready';
      round += 1;
      pendingSwapSlot = null;
      const dur = getDurationMinutes();
      noTimerMode = (dur === 0);
      timeRemaining = noTimerMode ? 0 : Math.max(0.1, dur)*60;
      renderTimer();
      updatePriorityBanner();
      updateControlButtons();
      renderStats(); // reflect newly-committed gamesPlayed immediately
      loadMatchPreview(); // show the next match's players right away (not started yet)
    });

    durationInput.addEventListener('change', () => {
      if(matchState === 'idle'){
        const dur = getDurationMinutes();
        noTimerMode = (dur === 0);
        timeRemaining = noTimerMode ? 0 : Math.max(0.1, dur)*60;
        renderTimer();
      }
    });

    /* ---------------------------------------------------------
     *     STATISTICS TAB
     *  --------------------------------------------------------- */
    let statSort = {key:'seq', dir:1};

    // Banner shown above the stats table while a court slot is selected for swap.
    const statsSwapHintEl = document.createElement('div');
    statsSwapHintEl.id = 'statsSwapHint';
    statsSwapHintEl.className = 'swap-hint';
    const statsTableForHint = document.getElementById('statsTableBody').closest('table');
    if(statsTableForHint && statsTableForHint.parentNode){
      statsTableForHint.parentNode.insertBefore(statsSwapHintEl, statsTableForHint);
    }

    function renderStats(){
      document.getElementById('statTotalPlayers').textContent = players.length;
      document.getElementById('statPresent').textContent = players.filter(p=>p.present).length;
      const totalGameSlots = players.reduce((s,p)=>s+p.gamesPlayed,0);
      document.getElementById('statTotalGames').textContent = Math.round(totalGameSlots/4 * 10)/10;

      if(pendingSwapSlot){
        const outP = players.find(x => x.id === pendingSwapSlot);
        statsSwapHintEl.textContent = 'Tap a player name below to bring them onto the court in place of ' + (outP ? outP.name : 'the selected player') + '.';
        statsSwapHintEl.style.display = 'block';
      } else {
        statsSwapHintEl.style.display = 'none';
      }

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

      const onCourtSet = new Set(currentMatchPlayers);
      rows.forEach(p => {
        const tr = document.createElement('tr');
        tr.dataset.id = p.id;
        const onCourt = onCourtSet.has(p.id);
        tr.innerHTML = `
        <td class="seq">${p.seq}</td>
        <td class="stat-name ${onCourt ? 'on-court' : 'swap-target'}">${escapeHtml(p.name)}${onCourt ? ' <span style="font-size:11px;font-weight:700;">(On Court)</span>' : ''}</td>
        <td style="text-align:right;font-weight:800;">${p.gamesPlayed}</td>
        `;
        /*tr.innerHTML = `
         < t*d class="seq">${p.seq}</td>
         <td>${escapeHtml(p.name)}</td>
         // <td><span class="pill ${p.type==='Visitor'?'pill-visitor':'pill-hope'}">${p.type==='Visitor'?'Visitor':'HCA'}</span></td>
         // <td><span class="pill ${p.level==='Intermediate'?'pill-intermediate':'pill-beginner'}">${p.level}</span></td>
         <td style="text-align:right;font-weight:800;">${p.gamesPlayed}</td>
         `;*/
        tbody.appendChild(tr);
      });

      // Clicking a present player's name completes a pending court swap
      // (started by clicking a player's name on the court in the Match tab).
      tbody.querySelectorAll('.stat-name.swap-target').forEach(td => {
        td.addEventListener('click', () => {
          completePlayerSwap(td.closest('tr').dataset.id);
        });
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

  durationInput.value = 0; // default setup time is now 0 (no timer) instead of 10
  noTimerMode = (getDurationMinutes() === 0);
  timeRemaining = noTimerMode ? 0 : Math.max(0.1, getDurationMinutes())*60;
  renderTimer();
  updateControlButtons();
  setMatchMode('beginner');
  renderAll();
})();
