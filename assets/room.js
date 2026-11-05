/* Paper Games — shared invite-room layer
   Host-authoritative rooms over BroadcastChannel (same browser) or Trystero (P2P).
   The game owns the rules; this layer owns seats, codes, and snapshots.

   Rooms survive a host leaving: every peer keeps the last snapshot, and the
   lowest online seat is promoted. Seats survive a browser restart: each
   browser keeps a secret resume token per room. */
(function(){
  'use strict';

  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const APP_ID = 'paper-games-v1';
  const CDN = 'https://cdn.jsdelivr.net/npm/trystero/+esm';
  const SEAT_COLORS = ['#bf5a4e', '#6f8f5f', '#c99a2c', '#5f7f9f'];
  const HOST_SILENCE = 6500;   // ms without a host word before we elect a new one
  const PEER_SILENCE = 7000;   // ms without a ping before the host marks a seat away

  let opts = {};
  let modal = null;
  let bodyEl = null;
  let roomBtn = null;
  let role = null;          // 'host' | 'guest'
  let code = null;
  let myId = null;
  let mySeat = null;
  let players = [];
  let transport = null;
  let started = false;
  let busy = false;
  let error = '';
  let joinTimer = null;
  let joinTries = 0;
  let hostId = null;
  let hostPeer = null;
  let epoch = 0;            // incremented on every host handover
  let lastHostSeen = 0;
  let electing = false;
  let skipped = {};         // seats that stayed silent when we looked for a new host
  let cachedName = null;
  let heartbeatTimer = null;
  let hostPingTimer = null;
  let hostWatchTimer = null;
  let pingTimer = null;
  let electTimer = null;
  let p2pError = null;
  let localForced = false;

  function store(key, value){
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
      return value;
    } catch (e) { return null; }
  }

  function sessionStore(key, value){
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, value);
      return value;
    } catch (e) { return null; }
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function randomId(){
    return 'p' + Math.random().toString(36).slice(2, 10);
  }

  function genCode(){
    const bytes = new Uint8Array(7);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 7; i++) bytes[i] = Math.floor(Math.random() * 256);
    let out = '';
    for (let i = 0; i < 7; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  function randToken(){
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    let out = '';
    for (let i = 0; i < 16; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }

  /* ---------- seat resume token ---------- */

  function seatKey(){
    return 'pg-seat-' + (opts.gameId || 'game') + '-' + (code || '');
  }

  function storedTokens(){
    try {
      const raw = store(seatKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(function(t){ return typeof t === 'string'; });
      return (parsed && parsed.token) ? [parsed.token] : [];
    } catch (e) { return []; }
  }

  /* this tab's token first, then any token this browser used for this room —
     enough to find our seat again after a reload or a reopened tab. */
  function seatTokens(){
    const out = [];
    const mine = sessionStore(seatKey() + '-tab');
    if (mine) out.push(mine);
    storedTokens().forEach(function(t){ if (out.indexOf(t) === -1) out.push(t); });
    return out.slice(0, 8);
  }

  function ensureSeatToken(){
    let token = sessionStore(seatKey() + '-tab');
    if (!token){
      token = randToken();
      sessionStore(seatKey() + '-tab', token);
    }
    try {
      const list = storedTokens().filter(function(t){ return t !== token; });
      list.unshift(token);
      store(seatKey(), JSON.stringify(list.slice(0, 8)));
    } catch (e) {}
    return token;
  }

  function forgetSeatToken(){
    const mine = sessionStore(seatKey() + '-tab');
    try {
      if (mine) store(seatKey(), JSON.stringify(storedTokens().filter(function(t){ return t !== mine; })));
    } catch (e) {}
    try { sessionStorage.removeItem(seatKey() + '-tab'); } catch (e) {}
  }

  function norm(s){
    let v = String(s || '').trim();
    const hash = v.indexOf('#');
    if (hash !== -1) v = v.slice(hash + 1);
    return v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
  }

  function valid(s){
    return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/.test(s);
  }

  function displayCode(c){
    return c.slice(0, 3) + '-' + c.slice(3);
  }

  function getName(){
    if (cachedName) return cachedName;
    let n = (store('pg-name') || '').trim();
    if (!n){
      n = 'pencil ' + Math.floor(Math.random() * 900 + 100);
      store('pg-name', n);
    }
    cachedName = n;
    return n;
  }

  function saveName(n){
    cachedName = String(n || '').slice(0, 18);
    store('pg-name', cachedName);
  }

  /* ---------- modal ---------- */

  function build(){
    modal = document.createElement('div');
    modal.className = 'pg-room-overlay';
    modal.innerHTML =
      '<div class="pg-room-card" role="dialog" aria-modal="true" aria-label="Play with a friend">' +
        '<div id="pgRoomBody"></div>' +
      '</div>';
    document.body.appendChild(modal);
    bodyEl = document.getElementById('pgRoomBody');

    modal.addEventListener('click', function(e){
      if (e.target === modal){ close(); return; }
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'close') close();
      else if (act === 'create') createRoom();
      else if (act === 'join') joinFromInput();
      else if (act === 'copy') copyLink(el);
      else if (act === 'leave') leaveRoom();
      else if (act === 'start') startRoom();
    });

    modal.addEventListener('keydown', function(e){
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && e.target && e.target.id === 'pgCode'){
        e.preventDefault();
        joinFromInput();
      }
    });
  }

  function open(){
    if (!modal) return;
    modal.classList.add('show');
    render();
    const focus = document.getElementById(role ? 'pgCode' : 'pgName');
    if (focus) setTimeout(function(){ try { focus.focus(); } catch (e) {} }, 50);
  }

  function close(){
    if (modal) modal.classList.remove('show');
  }

  function updateBtn(){
    if (!roomBtn) return;
    roomBtn.textContent = role ? 'room' : 'invite';
    roomBtn.classList.toggle('active', !!role);
  }

  function busyHTML(message){
    return '<div class="pg-busy"><span class="pg-pencil"></span><br>' + esc(message) + '</div>';
  }

  function idleHTML(){
    const hashCode = norm(location.hash.replace(/^#/, ''));
    return '' +
      '<div class="pg-room-head"><h2>play with a friend</h2><button class="pg-x" data-act="close" aria-label="Close">×</button></div>' +
      '<p class="pg-room-sub">one code, one page. open the same game on the other device, then join.</p>' +
      '<label class="pg-field"><span>your name</span><input id="pgName" maxlength="18" autocomplete="off"></label>' +
      '<div class="pg-room-actions"><button class="pg-btn primary" data-act="create">create a room</button></div>' +
      '<div class="pg-or">or</div>' +
      '<label class="pg-field"><span>join with a code</span><input id="pgCode" class="pg-code-input" maxlength="200" placeholder="ABC-1234" autocomplete="off" spellcheck="false" value="' + esc(code || hashCode) + '"></label>' +
      '<div class="pg-room-actions"><button class="pg-btn" data-act="join">join a room</button></div>' +
      (error ? '<p class="pg-error">' + esc(error) + '</p>' : '') +
      '<p class="pg-room-hint">codes are 7 characters. rooms are peer-to-peer; come back with the same browser and you keep your seat.</p>';
  }

  function playerRows(){
    const names = opts.seatNames || ['player 1', 'player 2', 'player 3', 'player 4'];
    const colors = opts.seatColors || SEAT_COLORS;
    let html = '';
    for (let i = 0; i < opts.maxPlayers; i++){
      const p = players.find(function(x){ return x.seat === i; });
      const isMe = p && p.id === myId;
      const isHost = p && p.id === hostId;
      const tag = isMe ? (isHost ? 'you · host' : 'you')
        : (isHost ? 'host' : (p && p.online === false ? 'away' : ''));
      html += '<div class="pg-player' + (p ? '' : ' empty') + '">' +
        '<span class="pg-dot" style="background:' + (p ? (colors[i] || '#fdf8ea') : 'transparent') + '"></span>' +
        '<span class="pg-seat">' + esc(names[i] || ('seat ' + (i + 1))) + '</span>' +
        '<span class="pg-name">' + (p ? esc(p.name) : 'waiting') + '</span>' +
        '<span class="pg-tag">' + tag + '</span>' +
      '</div>';
    }
    return html;
  }

  function roomHTML(){
    const onlineCount = players.filter(function(p){ return p.online !== false; }).length;
    const minPlayers = opts.minPlayers || opts.maxPlayers;
    const ready = onlineCount >= minPlayers;
    const isHost = role === 'host';
    const canStart = isHost && opts.canStart && ready && !started;
    const note = transport && transport.kind === 'local'
      ? (localForced ? 'local room — same browser only' : 'offline room — same browser only, invite links will not work')
      : 'peer-to-peer room';

    let status;
    if (electing) status = 'finding a new host…';
    else if (started) status = 'game in progress';
    else if (!ready) status = 'waiting for ' + Math.max(1, minPlayers - onlineCount) + ' more';
    else if (opts.canStart && isHost) status = 'ready — start when you are';
    else if (opts.canStart) status = 'ready — waiting for the host';
    else status = 'both players are here';

    return '' +
      '<div class="pg-room-head"><h2>your room</h2><button class="pg-x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="pg-code-box"><span class="pg-code">' + esc(displayCode(code || '-------')) + '</span><button class="pg-copy" data-act="copy">copy link</button></div>' +
      '<p class="pg-room-sub">share this code. they open <b>' + esc(opts.gameName || 'the game') + '</b> and join.</p>' +
      '<div class="pg-players">' + playerRows() + '</div>' +
      '<p class="pg-status"><b>' + esc(status) + '</b><br>' + esc(note) + '</p>' +
      '<div class="pg-room-actions">' +
        (canStart ? '<button class="pg-btn primary" data-act="start">start game</button>' : '') +
        '<button class="pg-btn" data-act="leave">leave room</button>' +
      '</div>' +
      (error ? '<p class="pg-error">' + esc(error) + '</p>' : '') +
      '<p class="pg-room-hint">' + (isHost
        ? 'the room keeps running if you close this tab — the next player takes over.'
        : 'if the host drops, the room carries on with the next player.') + '</p>';
  }

  function wireInputs(){
    const name = document.getElementById('pgName');
    if (name){
      name.value = getName();
      name.addEventListener('input', function(){ saveName(name.value); });
    }
    const ci = document.getElementById('pgCode');
    if (ci){
      ci.addEventListener('input', function(){ ci.value = norm(ci.value); });
    }
  }

  function render(){
    if (!bodyEl) return;
    if (busy){ bodyEl.innerHTML = busyHTML('opening the page…'); return; }
    if (!role){ bodyEl.innerHTML = idleHTML(); wireInputs(); return; }
    bodyEl.innerHTML = roomHTML();
  }

  function inviteUrl(){
    // never pass the ?local=1 debug flag on to the person you invite.
    try {
      const u = new URL(location.href);
      u.searchParams.delete('local');
      u.hash = code || '';
      return u.toString();
    } catch (e) {
      return location.href.split('#')[0] + '#' + code;
    }
  }

  function copyLink(btn){
    const url = inviteUrl();
    const done = function(){
      btn.textContent = 'copied';
      setTimeout(function(){ btn.textContent = 'copy link'; }, 1300);
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(done).catch(function(){
        window.prompt('copy this invite link', url);
      });
    } else {
      window.prompt('copy this invite link', url);
    }
  }

  /* ---------- transport ---------- */

  function LocalTransport(roomCode){
    const ch = new BroadcastChannel('pg-' + opts.gameId + '-' + roomCode);
    const ping = setInterval(function(){
      try { ch.postMessage({type: 'ping', id: myId, from: myId}); } catch (e) {}
    }, 2000);
    this.kind = 'local';
    this.selfId = null;
    this.send = function(msg, to){
      ch.postMessage(Object.assign({}, msg, {id: myId, from: myId, to: to || null}));
    };
    this.close = function(){ clearInterval(ping); try { ch.close(); } catch (e) {} };
    ch.onmessage = function(e){
      const m = e.data;
      if (!m || m.from === myId) return;
      if (m.to && m.to !== myId) return;
      onMsg(m, m.from);
    };
  }

  async function makeP2P(roomCode){
    const mod = await Promise.race([
      import(CDN),
      new Promise(function(_, reject){
        setTimeout(function(){ reject(new Error('trystero timeout')); }, 9000);
      })
    ]);
    const room = mod.joinRoom({appId: APP_ID}, opts.gameId + '-' + roomCode);

    // trystero has two live APIs:
    //   old: pair = [send(data, peerId), recv(fn)]
    //   new: pair = { send(data, {target}), onMessage = fn(data, {peerId}) }
    const pair = room.makeAction('m');
    const legacy = Array.isArray(pair) || typeof pair === 'function';
    const send = legacy ? pair[0] : pair.send;
    const recvFn = legacy ? pair[1] : (typeof pair.onMessage === 'function' ? pair.onMessage : null);
    if (typeof send !== 'function') throw new Error('trystero action api not recognised');

    const deliver = function(msg, peerId){
      if (!msg || msg.id === myId) return;
      onMsg(msg, peerId);
    };

    const t = {
      kind: 'p2p',
      selfId: mod.selfId || null,
      send: function(msg, to){
        const payload = Object.assign({}, msg, {id: myId});
        if (legacy) return send(payload, to || undefined);
        return send(payload, to ? {target: to} : {});
      },
      close: function(){ try { room.leave(); } catch (e) {} }
    };

    if (recvFn){
      recvFn(function(msg, meta){
        deliver(msg, typeof meta === 'string' ? meta : (meta && meta.peerId));
      });
    } else {
      pair.onMessage = function(msg, meta){ deliver(msg, meta && meta.peerId); };
    }
    // old trystero exposes onPeerJoin(fn); new builds take an assignment.
    const onJoin = function(peerId){ onMsg({type: 'peer-join'}, peerId); };
    const onLeave = function(peerId){ onMsg({type: 'peer-leave'}, peerId); };
    if (typeof room.onPeerJoin === 'function') room.onPeerJoin(onJoin);
    else room.onPeerJoin = onJoin;
    if (typeof room.onPeerLeave === 'function') room.onPeerLeave(onLeave);
    else room.onPeerLeave = onLeave;
    return t;
  }

  async function makeTransport(roomCode){
    localForced = /[?&]local=1/.test(location.search);
    if (!localForced && opts.p2p !== false && navigator.onLine && window.RTCPeerConnection){
      try {
        return await makeP2P(roomCode);
      } catch (e) {
        p2pError = (e && (e.message || String(e))) || 'unknown';
        if (window.console) console.warn('[paper-games] peer-to-peer unavailable:', e);
      }
    }
    return new LocalTransport(roomCode);
  }

  /* ---------- timers ---------- */

  function startPing(){
    clearInterval(pingTimer);
    pingTimer = setInterval(function(){
      if (role !== 'guest' || !transport){ clearInterval(pingTimer); return; }
      try { transport.send({type: 'ping'}); } catch (e) {}
    }, 2000);
  }

  function stopHostTimers(){
    clearInterval(heartbeatTimer);
    clearInterval(hostPingTimer);
    heartbeatTimer = null;
    hostPingTimer = null;
  }

  function startHostTimers(){
    stopHostTimers();
    heartbeatTimer = setInterval(function(){
      if (role !== 'host') return;
      let changed = false;
      const now = Date.now();
      players.forEach(function(p){
        if (p.id !== myId && p.online !== false && p.lastSeen && now - p.lastSeen > PEER_SILENCE){
          p.online = false;
          changed = true;
        }
      });
      if (changed){
        if (opts.onPlayers) opts.onPlayers(players);
        broadcast();
        render();
      }
    }, 3000);
    hostPingTimer = setInterval(function(){
      if (role !== 'host' || !transport) return;
      try { transport.send({type: 'host-ping', host: myId, epoch: epoch}); } catch (e) {}
    }, 2000);
  }

  function startHostWatch(){
    clearInterval(hostWatchTimer);
    hostWatchTimer = setInterval(function(){
      if (role !== 'guest'){ clearInterval(hostWatchTimer); return; }
      if (lastHostSeen && Date.now() - lastHostSeen > HOST_SILENCE) hostLost();
    }, 2000);
  }

  /* ---------- room logic ---------- */

  function broadcast(){
    if (role !== 'host' || !transport) return;
    transport.send({
      type: 'state',
      state: opts.getSnapshot ? opts.getSnapshot() : null,
      players: players,
      started: started,
      host: myId,
      epoch: epoch
    });
  }

  function publish(){
    if (role === 'host') broadcast();
  }

  function applyState(msg, peer){
    if (typeof msg.epoch === 'number') epoch = Math.max(epoch, msg.epoch);
    players = Array.isArray(msg.players) ? msg.players : [];
    started = !!msg.started;
    if (msg.host) hostId = msg.host;
    if (peer) hostPeer = peer;
    lastHostSeen = Date.now();
    skipped = {};
    electing = false;
    clearTimeout(electTimer);
    const me = players.find(function(p){ return p.id === myId; });
    if (me) mySeat = me.seat;
    clearInterval(joinTimer);
    error = '';
    if (opts.applySnapshot && msg.state) opts.applySnapshot(msg.state);
    if (opts.onSeat) opts.onSeat(mySeat, players);
    if (opts.onPlayers) opts.onPlayers(players);
    render();
    updateBtn();
    // the game is live now — get the room panel out of the way.
    if (started && modal && modal.classList.contains('show')) close();
  }

  function seatOf(id){
    const p = players.find(function(x){ return x.id === id; });
    return p ? p.seat : null;
  }

  /* ---------- host handover ---------- */

  function roomEnded(message){
    clearInterval(joinTimer);
    clearInterval(heartbeatTimer);
    clearInterval(hostPingTimer);
    clearInterval(hostWatchTimer);
    clearInterval(pingTimer);
    clearTimeout(electTimer);
    if (transport){ try { transport.close(); } catch (e) {} }
    transport = null;
    role = null;
    players = [];
    mySeat = null;
    started = false;
    busy = false;
    electing = false;
    hostId = null;
    hostPeer = null;
    epoch = 0;
    error = message;
    if (opts.onLeave) opts.onLeave();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    render();
    open();
    updateBtn();
  }

  function becomeHost(nextEpoch){
    if (!transport || !players.length) { roomEnded('the room ended.'); return; }
    clearInterval(hostWatchTimer);
    clearInterval(pingTimer);
    clearTimeout(electTimer);
    role = 'host';
    epoch = nextEpoch || (epoch + 1);
    hostId = myId;
    hostPeer = 'self';
    lastHostSeen = Date.now();
    electing = false;
    busy = false;
    error = '';
    skipped = {};
    const now = Date.now();
    players.forEach(function(p){ p.lastSeen = now; });
    const me = players.find(function(p){ return p.id === myId; });
    if (me) mySeat = me.seat;
    startHostTimers();
    if (opts.onSeat) opts.onSeat(mySeat, players);
    if (opts.onPlayers) opts.onPlayers(players);
    render();
    updateBtn();
    broadcast();
  }

  function adoptHost(msg, peer){
    stopHostTimers();
    role = 'guest';
    epoch = typeof msg.epoch === 'number' ? msg.epoch : epoch;
    hostId = msg.host;
    hostPeer = peer;
    lastHostSeen = Date.now();
    electing = false;
    skipped = {};
    clearTimeout(electTimer);
    startHostWatch();
    startPing();
    updateBtn();
  }

  function hostLost(){
    if (!role || role === 'host' || !players.length || electing) return;
    const old = players.find(function(p){ return p.id === hostId; });
    if (old && old.online !== false && old.id !== myId){
      old.online = false;
      if (opts.onPlayers) opts.onPlayers(players);
    }
    const online = players.filter(function(p){ return p.online !== false; })
      .sort(function(a, b){ return a.seat - b.seat; });
    const me = players.find(function(p){ return p.id === myId; });
    const pick = online.find(function(p){ return !skipped[p.id]; });
    if (!pick || !online.length){ roomEnded('the room ended.'); return; }

    if (pick.id === myId && me){
      becomeHost(epoch + 1);
      return;
    }

    electing = true;
    render();
    clearTimeout(electTimer);
    const seenAt = lastHostSeen;
    electTimer = setTimeout(function(){
      if (role !== 'guest' || lastHostSeen !== seenAt) return;
      // the elected seat stayed silent too — skip it and try the next one.
      skipped[pick.id] = true;
      electing = false;
      hostLost();
    }, 4500);
  }

  /* ---------- messages ---------- */

  function onMsg(msg, peer){
    if (!msg || !msg.type) return;

    // A newer host supersedes us. Equal-epoch claims are settled by seat order.
    if (msg.type === 'state' && msg.host && msg.host !== myId){
      const newer = typeof msg.epoch === 'number' && msg.epoch > epoch;
      // two peers can promote at the same instant; the lower seat wins.
      const tieBreak = typeof msg.epoch === 'number' && msg.epoch === epoch && msg.host !== hostId &&
        seatOf(msg.host) != null && seatOf(hostId) != null && seatOf(msg.host) < seatOf(hostId);
      if (newer || tieBreak){
        adoptHost(msg, peer);
        applyState(msg, peer);
        return;
      }
      if (msg.host !== hostId) return; // an older or foreign host; ignore
    }

    if (role === 'host'){
      if (msg.type === 'state' || msg.type === 'host-ping') return;

      if (msg.type === 'ping'){
        const p = players.find(function(x){ return x.id === msg.id; });
        if (p){
          p.lastSeen = Date.now();
          if (p.online === false){
            p.online = true;
            if (opts.onPlayers) opts.onPlayers(players);
            broadcast();
            render();
          }
        }
        return;
      }
      if (msg.type === 'join'){
        const id = msg.id || peer;
        if (!id) return;
        const token = String(msg.token || '');
        const candidates = Array.isArray(msg.tokens) ? msg.tokens.slice(0, 8) : (token ? [token] : []);
        let existing = players.find(function(p){ return p.id === id; });
        // a browser that comes back with its seat token gets its seat again,
        // unless somebody else is actively sitting in it.
        if (!existing){
          for (let i = 0; i < candidates.length && !existing; i++){
            const claimed = players.find(function(p){ return p.token === candidates[i]; });
            if (claimed && (claimed.online === false || claimed.id === id)) existing = claimed;
          }
        }
        if (existing){
          existing.online = true;
          existing.peer = peer;
          existing.id = id;
          existing.lastSeen = Date.now();
          if (token) existing.token = token;
          if (opts.onPlayers) opts.onPlayers(players);
          broadcast();
          render();
          return;
        }
        if (players.length >= opts.maxPlayers){
          let off = -1;
          const canReplace = !started && (opts.canStart || (opts.canReplace && opts.canReplace()));
          if (canReplace){
            for (let i = 0; i < players.length; i++){
              if (players[i].online === false){ off = i; break; }
            }
          }
          if (off === -1){
            if (transport) transport.send({type: 'full'}, peer);
            return;
          }
          players.splice(off, 1);
        }
        const used = players.map(function(p){ return p.seat; });
        let seat = 0;
        while (used.indexOf(seat) !== -1) seat++;
        players.push({
          id: id,
          name: String(msg.name || 'player').slice(0, 18),
          seat: seat,
          peer: peer,
          token: token,
          online: true,
          lastSeen: Date.now()
        });
        broadcast();
        if (opts.onPlayers) opts.onPlayers(players);
        render();
      } else if (msg.type === 'action'){
        const p = players.find(function(x){ return x.id === (msg.id || peer); });
        if (!p || p.online === false) return;
        const ok = opts.onAction ? opts.onAction(msg.action, p.seat) : false;
        if (ok) broadcast();
      } else if (msg.type === 'leave'){
        const p = players.find(function(x){ return x.id === (msg.id || peer); });
        if (p){
          p.online = false;
          if (opts.onPlayers) opts.onPlayers(players);
          broadcast();
          render();
        }
      } else if (msg.type === 'peer-leave'){
        const p = players.find(function(x){ return x.peer === peer; });
        if (p){
          p.online = false;
          if (opts.onPlayers) opts.onPlayers(players);
          broadcast();
          render();
        }
      }
    } else if (role === 'guest'){
      if (msg.type === 'state'){
        if (!hostId || msg.host === hostId) applyState(msg, peer);
      } else if (msg.type === 'host-ping'){
        if (!hostId || msg.host === hostId || msg.id === hostId) lastHostSeen = Date.now();
      } else if (msg.type === 'full'){
        clearInterval(joinTimer);
        clearInterval(pingTimer);
        if (transport) transport.close();
        transport = null;
        role = null;
        players = [];
        mySeat = null;
        started = false;
        error = 'that room is already full.';
        if (opts.onLeave) opts.onLeave();
        render();
        open();
        updateBtn();
      } else if (msg.type === 'leave' && msg.id === hostId){
        hostLost();
      } else if (msg.type === 'peer-leave'){
        if (peer === hostPeer || peer === hostId) hostLost();
      }
    }
  }

  async function createRoom(){
    if (busy || role) return;
    busy = true;
    error = '';
    render();
    clearInterval(pingTimer);
    try {
      const c = genCode();
      const t = await makeTransport(c);
      code = c;
      role = 'host';
      myId = t.selfId || myId;
      mySeat = 0;
      started = false;
      epoch = 1;
      hostId = myId;
      hostPeer = 'self';
      lastHostSeen = Date.now();
      const token = ensureSeatToken();
      players = [{id: myId, name: getName(), seat: 0, peer: 'self', token: token, online: true, lastSeen: Date.now()}];
      transport = t;
      busy = false;
      try { history.replaceState(null, '', location.pathname + location.search + '#' + c); } catch (e) {}
      startHostTimers();
      if (opts.onSeat) opts.onSeat(0, players);
      if (opts.onPlayers) opts.onPlayers(players);
      render();
      updateBtn();
    } catch (e) {
      busy = false;
      role = null;
      error = 'could not open a room. try again.';
      render();
    }
  }

  function joinFromInput(){
    const input = document.getElementById('pgCode');
    const name = document.getElementById('pgName');
    if (name) saveName(name.value);
    joinRoom(input ? input.value : '');
  }

  async function joinRoom(c){
    const cc = norm(c);
    if (!valid(cc)){
      error = 'that code is not 7 characters.';
      render();
      return;
    }
    if (busy) return;
    busy = true;
    error = '';
    code = cc;
    role = null;
    mySeat = null;
    players = [];
    started = false;
    epoch = 0;
    hostId = null;
    electing = false;
    try { history.replaceState(null, '', location.pathname + location.search + '#' + cc); } catch (e) {}
    render();
    try {
      const t = await makeTransport(cc);
      transport = t;
      myId = t.selfId || myId;
      role = 'guest';
      busy = false;
      lastHostSeen = 0; // the clock starts when the first state arrives
      startHostWatch();
      render();
      updateBtn();
      t.send({type: 'join', name: getName(), token: ensureSeatToken(), tokens: seatTokens()});
      startPing();
      joinTries = 0;
      clearInterval(joinTimer);
      joinTimer = setInterval(function(){
        if (role !== 'guest' || mySeat != null){
          clearInterval(joinTimer);
          return;
        }
        joinTries++;
        if (joinTries > 6){
          clearInterval(joinTimer);
          if (transport){ try { transport.close(); } catch (e) {} }
          transport = null;
          role = null;
          mySeat = null;
          error = 'no room answered. check the code, and make sure the host has the page open.';
          render();
          updateBtn();
          return;
        }
        if (transport) transport.send({type: 'join', name: getName(), token: ensureSeatToken(), tokens: seatTokens()});
      }, 1400);
    } catch (e) {
      busy = false;
      role = null;
      error = 'could not join. try again.';
      render();
    }
  }

  function startRoom(){
    if (role !== 'host' || started) return;
    const minPlayers = opts.minPlayers || opts.maxPlayers;
    const onlineCount = players.filter(function(p){ return p.online !== false; }).length;
    if (onlineCount < minPlayers) return;
    started = true;
    if (opts.onStart) opts.onStart(players);
    broadcast();
    render();
    close();
  }

  function leaveRoom(){
    clearInterval(joinTimer);
    clearInterval(heartbeatTimer);
    clearInterval(hostPingTimer);
    clearInterval(hostWatchTimer);
    clearInterval(pingTimer);
    clearTimeout(electTimer);
    if (transport){
      try { transport.send({type: 'leave', id: myId, host: role === 'host'}); } catch (e) {}
      try { transport.close(); } catch (e) {}
    }
    transport = null;
    role = null;
    mySeat = null;
    players = [];
    started = false;
    error = '';
    busy = false;
    electing = false;
    hostId = null;
    hostPeer = null;
    epoch = 0;
    forgetSeatToken();
    code = null;
    if (opts.onLeave) opts.onLeave();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    render();
    updateBtn();
  }

  function sendAction(action){
    if (!transport || role !== 'guest' || mySeat == null) return false;
    transport.send({type: 'action', action: action, seat: mySeat});
    return true;
  }

  /* ---------- boot ---------- */

  function init(o){
    if (modal) return;
    opts = o || {};
    opts.maxPlayers = opts.maxPlayers || 2;
    myId = sessionStore('pg-player-id') || randomId();
    sessionStore('pg-player-id', myId);
    build();
    roomBtn = document.getElementById(opts.roomBtn || 'roomBtn');
    if (roomBtn) roomBtn.addEventListener('click', open);
    updateBtn();
    const hash = norm(location.hash.replace(/^#/, ''));
    if (valid(hash)){
      code = hash;
      open();
      setTimeout(function(){ joinRoom(hash); }, 350);
    }
  }

  window.addEventListener('pagehide', function(){
    if ((role === 'host' || role === 'guest') && transport){
      try { transport.send({type: 'leave', id: myId, host: role === 'host'}); } catch (e) {}
    }
  });

  window.PaperRoom = {
    init: init,
    open: open,
    close: close,
    create: createRoom,
    join: joinRoom,
    sendAction: sendAction,
    publish: publish,
    leave: leaveRoom,
    inviteUrl: inviteUrl,
    get code(){ return code; },
    get seat(){ return mySeat; },
    get role(){ return role; },
    get epoch(){ return epoch; },
    get hostId(){ return hostId; }
  };
})();
