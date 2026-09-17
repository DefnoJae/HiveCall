(() => {
  "use strict";

  /* ======================= tiny helpers ======================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const byId = id => document.getElementById(id);
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = arr => arr[rand(0, arr.length - 1)];
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const shortName = n => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const time12 = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtDur = ms => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const djb2 = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return "h" + (h >>> 0).toString(36); };

  /* ======================= Supabase + PeerJS setup ======================= */
  const SUPABASE_URL = "https://xheyslqfzvidoaczlmxz.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhoZXlzbHFmenZpZG9hY3psbXh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzNTIwNTQsImV4cCI6MjEwNDkyODA1NH0.1r1B2H0_51wTDxoaj8v4XF8SYZTsSoiDj42i94hPVyg";
  const supabaseClient = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  /* Optimistic runtime mirrors */
  let DB = { servers: {}, profiles: {}, soundboards: {} };
  const guilds = () => DB.servers;
  const users = () => DB.profiles;
  const saveGuilds = ob => { DB.servers = ob || DB.servers; };
  const saveUsers = ob => { DB.profiles = ob || DB.profiles; };

  /* Device-local prefs ONLY */
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const prefs = () => lsGet("hc_prefs", { autoMute: false, sounds: true, micId: "", camId: "" });
  const savePrefs = p => lsSet("hc_prefs", p);

  /* ======================= PeerJS State Management ======================= */
  let currentPeerSessionToken = null;  // Track current session token
  let peerInitializing = false;        // Prevent double-initialization (React Strict Mode safety)

  /* ======================= Supabase data layer ======================= */
  const hashColor = seed => {
    let h = 0; for (const cc of String(seed || "")) h = (h * 31 + cc.charCodeAt(0)) | 0;
    return COLORS[Math.abs(h) % COLORS.length];
  };
  const mapServerRow = r => ({
    id: r.id, name: r.name || "Unnamed", owner: r.owner_id, invite: r.invite_code,
    color: hashColor(r.invite_code || r.id), members: [], call: [], chat: [], roster: {},
    createdAt: Date.parse(r.created_at || 0) || 0
  });

  async function refreshData() {
    if (!supabaseClient || !S.user) return;
    try {
      const { data: mems } = await supabaseClient.from("server_members").select("server_id,user_id,user_name,user_color");
      if (!mems) return;
      const profiles = {};
      mems.forEach(m => { if (m.user_id) profiles[m.user_id] = ensureProfile(m.user_id, m.user_name, m.user_color); });
      if (S.user) profiles[S.user.id] = ensureProfile(S.user.id, S.user.name, S.user.color);
      const ids = [...new Set(mems.map(m => m.server_id))];
      const servers = {};
      if (ids.length) {
        const { data: sr } = await supabaseClient.from("servers").select("*").in("id", ids);
        (sr || []).forEach(r => {
          servers[r.id] = mapServerRow(r);
          servers[r.id].members = mems.filter(m => m.server_id === r.id).map(m => m.user_id);
        });
      }
      DB.servers = servers;
      DB.profiles = profiles;
      const g = servers[S.activeGuildId];
      if (g) await loadServerData(g);
      return g ? Object.values(servers) : Object.values(servers);
    } catch (e) { console.warn("refreshData failed", e); }
  }

  async function loadServerData(g) {
    if (!supabaseClient) return;
    await loadMembers(g);
    await Promise.all([loadChat(g), loadSoundboard(g)]);
    await loadPresence(g);
  }

  async function loadMembers(g) {
    try {
      const { data } = await supabaseClient.from("server_members").select("user_id,user_name,user_color").eq("server_id", g.id);
      g.members = (data || []).map(r => r.user_id).filter(Boolean);
      (g.members || []).forEach(id => ensureProfile(id, null, null));
    } catch (e) { console.warn("loadMembers failed", e); }
  }

  async function loadChat(g) {
    try {
      const { data } = await supabaseClient.from("messages").select("*").eq("server_id", g.id).order("created_at", { ascending: true }).limit(300);
      g.chat = (data || []).map(m => mapMsgRow(m)).filter(Boolean);
      (g.chat || []).forEach(m => { if (m.authorId) ensureProfile(m.authorId, m.authorName, m.authorColor); });
    } catch (e) { console.warn("loadChat failed", e); }
  }
  const mapMsgRow = r => r ? {
    id: r.id, authorId: r.user_id, authorName: r.user_name, authorColor: r.user_color,
    text: r.content, at: Date.parse(r.created_at) || Date.now()
  } : null;

  const ROSTER_MIRROR = {};
  async function loadPresence(g) {
    try {
      const { data } = await supabaseClient.from("call_presence").select("server_id,active_users").eq("server_id", g.id).maybeSingle();
      applyActiveUsers(g, data ? data.active_users : {});
    } catch (e) { console.warn("loadPresence failed", e); }
  }

  function applyActiveUsers(g, obj, origin) {
    obj = obj && typeof obj === "object" ? obj : {};
    ROSTER_MIRROR[g.id] = obj;
    const prevCall = g.call || [];
    const prevRoster = g.roster || {};
    const roster = {};
    let music = null;
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (k === "_music" && v && typeof v === "object") { music = v; return; }
      if (!v || typeof v !== "object") return;
      roster[k] = v;
      ensureProfile(k, v.name, v.color);
    });
    if (origin === "rt" && S.call && S.call.guildId === g.id) {
      if (S.user && !roster[S.user.id]) {
        const mine = users()[S.user.id] || { name: S.user.name, color: S.user.color };
        roster[S.user.id] = {
          name: mine.name || S.user.name, color: mine.color || S.user.color,
          mic: !!S.call.mic, cam: !!S.call.cam, share: !!S.call.share, joinedAt: S.call.joinAt
        };
        ensureProfile(S.user.id, roster[S.user.id].name, roster[S.user.id].color);
      }
      Object.keys(S.call.peers || {}).forEach(uid => {
        const mc = S.call.peers[uid];
        if (roster[uid] || !mc || !mc.open || uid === S.user.id) return;
        const p = users()[uid] || {};
        roster[uid] = { name: p.name || "", color: p.color || "", mic: false, cam: false, share: false, joinedAt: Date.now() };
        ensureProfile(uid, p.name, p.color);
      });
    }
    g.call = Object.keys(roster);
    g.roster = roster;
    Object.keys(talkState).forEach(uid => { if (!roster[uid]) clearTalkState(uid); });
    if (music && music.queue) S.callMusic = music;
    if (origin === "rt" && S.call && S.call.guildId === g.id) {
      g.call.filter(id => !prevCall.includes(id) && id !== S.user.id).forEach(id => {
        toast(displayName(id, roster[id] && roster[id].name) + " joined the call.", "info");
      });
      prevCall.filter(id => !g.call.includes(id) && id !== S.user.id).forEach(id => {
        toast(displayName(id, prevRoster[id] && prevRoster[id].name) + " left the call.", "info");
      });
      g.call.filter(id => !!((roster[id] || {}).share) && !(prevRoster[id] || {}).share).forEach(id => {
        toast(displayName(id, roster[id] && roster[id].name) + " started sharing their screen.", "info");
      });
      prevCall.filter(id => !((roster[id] || {}).share) && !!((prevRoster[id] || {}).share)).forEach(id => {
        toast(displayName(id, prevRoster[id] && prevRoster[id].name) + " stopped sharing their screen.", "info");
      });
      if (S.call.sharePending) {
        Object.keys(roster).forEach(id => {
          if (id === S.user.id) return;
          if (roster[id].share && !(prevRoster[id] || {}).share) S.call.sharePending[id] = true;
          if (!roster[id].share) delete S.call.sharePending[id];
        });
      }
    }
    if (origin !== "local" && S.call && S.call.guildId === g.id) {
      if (music && music.queue && SP.on) applySpotifySync(music);
      if (peerOpen && S.call && S.call.guildId === g.id) {
        g.call.forEach(id => { if (id !== S.user.id && S.user.id < id) callUser(id); });
        if (S.call.share) ensureShareMesh();
      }
      if (byId("call-view")) {
        const added = g.call.some(id => !prevCall.includes(id));
        const removed = prevCall.some(id => !g.call.includes(id));
        const shareFlip = g.call.some(id => !!((prevRoster[id] || {}).share) !== !!((roster[id] || {}).share));
        if (added || removed || shareFlip) { updateStage(); updateCtl(); }
        else { g.call.forEach(id => updateTileFor(id)); updateCtl(); }
      }
    }
  }

  function broadcastPayload(message) {
    return message && message.payload && typeof message.payload === "object" ? message.payload : (message || {});
  }

  async function loadSoundboard(g) {
    if (!supabaseClient) return;
    try {
      const { data } = await supabaseClient.from("soundboard").select("*").order("id", { ascending: false });
      DB.soundboards[g.id] = (data || []).filter(r => r.server_id === g.id).map(r => ({
        id: r.id, addedBy: r.user_id, name: r.name, emoji: r.emoji, dataUrl: r.data_url,
        at: Date.parse(r.created_at) || 0, server_id: r.server_id
      }));
    } catch (e) { console.warn("loadSoundboard failed", e); }
  }

  let presenceQueue = Promise.resolve();
  function writePresence(gid, patch) {
    if (!supabaseClient || !gid) return;
    presenceQueue = presenceQueue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data } = await supabaseClient.from("call_presence").select("server_id,active_users").eq("server_id", gid).maybeSingle();
          if (data && data.active_users && typeof data.active_users !== "object") return;
          const obj = Object.assign({}, data && data.active_users || {});
          Object.keys(patch).forEach(k => { if (patch[k] === null) delete obj[k]; else obj[k] = patch[k]; });
          if (data) await supabaseClient.from("call_presence").update({ active_users: obj }).eq("server_id", gid);
          else await supabaseClient.from("call_presence").insert({ server_id: gid, active_users: obj });
          return;
        } catch (e) {
          if (attempt === 1) console.warn("presence write failed", e);
        }
      }
    });
  }

  function sendState() {
    const c = S.call;
    if (!c || !S.user || !supabaseClient) return;
    const ch = getChannel(c.guildId);
    if (!ch) return;
    try {
      ch.send({ type: "broadcast", event: "state", payload: {
        from: S.user.id, mic: !!c.mic, cam: !!c.cam, share: !!c.share,
        name: S.user.name, color: S.user.color
      } });
    } catch (e) {}
  }
  function updateTileFor(uid) {
    const c = S.call; if (!c) return;
    const g = guilds()[c.guildId]; if (!g) return;
    const tile = tileEl(uid);
    if (!tile) return;
    const u = users()[uid]; if (!u) return;
    const self = uid === S.user.id;
    const r = g.roster[uid] || {};
    const remoteSt = c.remote[uid];
    const camOn = self ? c.cam : !!r.cam;
    const micOn = self ? c.mic : !!r.mic;
    const hasVid = self ? !!(c.cam && c.stream && c.stream.getVideoTracks().length) : !!(camOn && remoteSt && remoteSt.video);
    const tag = $(".tile-tag", tile);
    if (tag) {
      const mb = $(".mic-badge", tag);
      if (mb) { mb.className = "mic-badge " + (micOn ? "on" : "off"); mb.innerHTML = ic(micOn ? "mic" : "micOff", 13); }
      const nm = $(".tile-name", tag);
      if (nm) nm.textContent = u.name + (self ? "  (you)" : "");
    }
    const av = $(".tile-avatar", tile);
    if (av) av.style.display = (hasVid ? "none" : "");
    const co = $(".tile-camoff", tile);
    if (co) co.style.display = (camOn || self || hasVid) ? "none" : "";
    const vid = byId(self ? "vm-self" : "vm-" + uid);
    if (vid && !self && hasVid && remoteSt) {
      if (vid.srcObject !== remoteSt.stream) vid.srcObject = remoteSt.stream;
      playMedia(vid);
      vid.hidden = false;
    } else if (vid && !self) {
      vid.hidden = true;
    }
    attachMedia();
  }
  function onStateBroadcast(p) {
    p = broadcastPayload(p);
    if (!S.call || !p || !p.from || p.from === S.user.id) return;
    const g = guilds()[S.call.guildId];
    if (!g) return;
    const r = g.roster[p.from];
    if (!r) return;
    const prevShare = !!r.share;
    r.mic = !!p.mic;
    r.cam = !!p.cam;
    r.share = !!p.share;
    if (p.name || p.color) ensureProfile(p.from, p.name, p.color);
    if (S.call.sharePending) {
      if (r.share && !prevShare) S.call.sharePending[p.from] = true;
      if (!r.share) delete S.call.sharePending[p.from];
    }
    if (byId("call-view")) {
      if (r.share !== prevShare) updateStage();
      else updateTileFor(p.from);
    } else { appView(); }
  }

  function pushPresence() {
    const c = S.call; if (!c || !S.user) return;
    sendState();
    writePresence(c.guildId, {
      [S.user.id]: { name: S.user.name, color: S.user.color, mic: !!c.mic, cam: !!c.cam, share: !!c.share, joinedAt: c.joinAt }
    });
  }
  function pushMusic() {
    const c = S.call; if (!c || !S.user) return;
    writePresence(c.guildId, {
      _music: { hostId: SP.hostId, restrict: SP.restrict, index: SP.index, queue: SP.queue, playing: SP.playing, pos: SP.pos, t0: Date.now(), volume: SP.volume }
    });
  }

  /* Real-time channels */
  let hcChannels = [];
  function closeRealtime() { hcChannels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch (e) {} }); hcChannels = []; }
  
  // FIX: Supabase JS v2 prepends "realtime:" to the topic property internally. 
  // By matching on index 0 directly, we bypass any topic parsing issues ensuring broadcasts always send properly!
  function getChannel(gid) { return hcChannels[0] || null; }
  
  function openRealtime(gid) {
    if (!supabaseClient) return;
    closeRealtime();
    const ch = supabaseClient.channel("hc-" + gid);
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "server_id=eq." + gid },
      payload => appendChatMsg(payload.new));
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "call_presence", filter: "server_id=eq." + gid },
      payload => { const g = guilds()[gid]; if (g && payload.new) applyActiveUsers(g, payload.new.active_users, "rt"); });
    ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "call_presence", filter: "server_id=eq." + gid },
      payload => { const g = guilds()[gid]; if (g && payload.new) applyActiveUsers(g, payload.new.active_users, "rt"); });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "soundboard", filter: "server_id=eq." + gid },
      payload => onSoundboardRealtime(payload));
    ch.on("broadcast", { event: "sb_play" }, p => onSbPlay(p));
    ch.on("broadcast", { event: "wreg" }, p => onRenegotiation(p));
    ch.on("broadcast", { event: "state" }, p => onStateBroadcast(p));
    ch.on("broadcast", { event: "talk" }, p => onTalkBroadcast(p));
    ch.on("broadcast", { event: "typing" }, p => onTyping(p));
    ch.on("broadcast", { event: "kick" }, message => { const p = broadcastPayload(message); if (S.call && S.call.guildId === gid && p.userId && p.userId === S.user.id) { toast("You were disconnected by a server member.", "err"); leaveCall(); } });
    ch.on("broadcast", { event: "invite" }, p => {
      p = broadcastPayload(p);
      if (!p || !p.from || p.from === S.user.id) return;
      if (!S.call || S.call.guildId !== gid) {
        const me = users()[p.from];
        const gg = guilds()[gid];
        toast((me ? me.name : "A server member") + " invited you to the Voice Lounge" + (gg ? " in " + gg.name : "") + "!", "info");
      }
    });
    ch.on("broadcast", { event: "music_invite" }, p => onMusicInvite(p, gid));
    ch.subscribe();
    hcChannels = [ch];
  }
  function appView() {
    const g = guild(); if (!g) return;
    const inCallView = !!byId("call-view");
    const ct = byId("side-call-n"); if (ct) ct.textContent = String(g.call.length);
    const cc = byId("call-count"); if (cc) cc.textContent = String(g.call.length);
    const mp = $(".members-panel");
    if (inCallView) { updateStage(); updateCtl(); }
    else if (mp) {
      const isVoice = S.activeChannel === "voice";
      mp.innerHTML = membersHTML(g);
      if (isVoice) renderContent();
    }
  }
  function appendChatMsg(r) {
    const g = guild(); if (!g || !r || r.server_id !== g.id) return;
    const m = mapMsgRow(r); if (!m) return;
    const chat = g.chat || (g.chat = []);
    if (chat.some(x => x.id === m.id)) return;
    const tmpIdx = chat.findIndex(x => x.pending && x.authorId === m.authorId && x.text === m.text && Math.abs((x.at || 0) - (m.at || 0)) < 7000);
    if (tmpIdx !== -1) {
      const tmp = chat[tmpIdx];
      tmp.id = m.id; tmp.pending = false; tmp.at = m.at;
      if (m.authorName) tmp.authorName = m.authorName;
      if (m.authorColor) tmp.authorColor = m.authorColor;
      return;
    }
    chat.push(m);
    if (m.authorId) ensureProfile(m.authorId, m.authorName, m.authorColor);
    const box = byId("chat-msgs");
    if (box && !S.modalOpen) {
      const wrap = document.createElement("div");
      wrap.innerHTML = chatRowHTML(m);
      const n = wrap.firstElementChild;
      if (n) { box.appendChild(n); box.scrollTop = box.scrollHeight; }
    }
  }

  /* ======================= palette / naming ======================= */
  const COLORS = ["#5865f2", "#eb459e", "#faa61a", "#3ba55d", "#f47b67", "#1fb9d4", "#d16b11", "#c4314b", "#8a63d2", "#4f8b3d"];
  const ADJ = ["Amber", "Azure", "Bold", "Cosmic", "Crimson", "Crystal", "Daring", "Dawn", "Ember", "Frost", "Gentle", "Golden", "Happy", "Hidden", "Jolly", "Lively", "Midnight", "Misty", "Neon", "Noble", "Phantom", "Quiet", "Rapid", "Royal", "Scarlet", "Shadow", "Silent", "Solar", "Stellar", "Velvet", "Wild"];
  const ANIM = ["Falcon", "Fox", "Otter", "Wolf", "Phoenix", "Raven", "Tiger", "Lynx", "Badger", "Hawk", "Eagle", "Owl", "Panther", "Sparrow", "Dolphin", "Cheetah", "Panda", "Raccoon", "Walrus", "Toucan", "Koala", "Gecko", "Sloth", "Mantis"];
  const randServerName = () => pick(ADJ) + " " + pick(ANIM);

  /* ======================= profile normalization ======================= */
  const fallbackName = id => "User " + String(id || "").slice(0, 6);
  const isPlaceholder = n => !n || n === "?" || /^User([\s]|$)/i.test(String(n).trim());
  function ensureProfile(id, name, color) {
    if (!id) return null;
    let p = DB.profiles[id];
    const real = name && !isPlaceholder(name);
    if (!p) {
      p = DB.profiles[id] = { id, name: real ? name : fallbackName(id), color: color || COLORS[0] };
    } else {
      if (real) p.name = name;
      else if (isPlaceholder(p.name)) p.name = fallbackName(id);
      if (color) p.color = color;
    }
    if (!p.name || isPlaceholder(p.name)) p.name = fallbackName(id);
    return p;
  }
  function displayName(id, fallback) {
    const p = DB.profiles && DB.profiles[id];
    if (p && p.name && !isPlaceholder(p.name)) return p.name;
    if (fallback && !isPlaceholder(fallback)) return fallback;
    return fallbackName(id);
  }
  function displayColor(id, fallback) {
    const p = DB.profiles && DB.profiles[id];
    if (p && p.color) return p.color;
    return fallback || "#888";
  }

  /* ======================= state ======================= */
  let S = { user: null, activeGuildId: null, activeChannel: "voice", call: null, devices: { audio: [], video: [] } };
  let SESSION_TOKEN = null;
  let callTimerI = null;
  const guild = () => (S.activeGuildId ? guilds()[S.activeGuildId] : null);

  /* ======================= icons ======================= */
  const ICONS = {
    logo: '<path d="M12 2.5l7.5 4.3v8.4L12 19.5l-7.5-4.3V6.8z"/><line x1="12" y1="11.5" x2="12" y2="15.5"/><circle cx="12" cy="8.5" r="1.1"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    voice: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
    micOff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.5 10.5V12a6.5 6.5 0 0 1-1.4 4.1"/><path d="M5 10v2a7 7 0 0 0 11.4 5.6"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/><path d="M12 2a3 3 0 0 0-1.9 2.8"/><path d="M15.5 4.6A3 3 0 0 0 12 2"/>',
    cam: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    camOff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M16 5H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3z"/><path d="M17 10.5l5-3v9l-5-3"/>',
    share: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17V9"/><path d="M8 12l4-4 4 4"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
    leave: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    headphone: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    key: '<path d="M21 2l-2 2"/><path d="M5.44 16.56a4.5 4.5 0 1 1 6.36-6.36 4.5 4.5 0 0 1-6.36 6.36z"/><path d="M15.5 7.5l3 3L22 7l-3-3"/><path d="M11.5 11.5l4 4"/>',
    spotify: '<circle cx="12" cy="12" r="10"/><path d="M7.6 8.3c3.3-.75 7.2.15 9.6 1.6"/><path d="M8.1 11.5c2.7-.6 5.7.1 7.7 1.35"/><path d="M8.7 14.6c2-.4 4.1.1 5.6.95"/><circle cx="7.9" cy="9" r="1.35" fill="currentColor" stroke="none"/>',
    prev: '<path d="M18.5 5.5v13L8 12z"/><line x1="5" y1="5.5" x2="5" y2="18.5"/>',
    next: '<path d="M5.5 5.5v13L16 12z"/><line x1="19" y1="5.5" x2="19" y2="18.5"/>',
    play: '<polygon points="7 4 21 12 7 20 7 4" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
    volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    sound: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    lyrics: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="17" y2="12"/><line x1="4" y1="17" x2="19" y2="17"/>',
    queue: '<line x1="3" y1="7" x2="15" y2="7"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="17" x2="9" y2="17"/><path d="M18 9v7"/><circle cx="21" cy="12" r="1.6"/>',
    musicNote: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-2"/>',
    spPrev: '<polygon points="11 19 2 12 11 5 11 19" fill="currentColor" stroke="none"/><polygon points="22 19 13 12 22 5 22 19" fill="currentColor" stroke="none"/>',
    spNext: '<polygon points="13 19 22 12 13 5 13 19" fill="currentColor" stroke="none"/><polygon points="2 19 11 12 2 5 2 19" fill="currentColor" stroke="none"/>',
    spPlay: '<polygon points="7 4 21 12 7 20 7 4" fill="currentColor" stroke="none"/>',
    spPause: '<rect x="6" y="4" width="4.5" height="16" rx="1.5" fill="currentColor" stroke="none"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.5" fill="currentColor" stroke="none"/>',
    spLyrics: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" fill="none" stroke-width="2"/><path d="M8 9h2v2H9v1.5H8V9zm5 0h2v2h-1v1.5h-1V9z" fill="currentColor" stroke="none"/>',
    spQueue: '<line x1="9" y1="6" x2="20" y2="6" stroke="currentColor" stroke-width="2"/><line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2"/><line x1="9" y1="18" x2="20" y2="18" stroke="currentColor" stroke-width="2"/><circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
    spVolume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="2"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14" stroke="currentColor" stroke-width="2"/>',
    ellipsis: '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/>',
    spLogs: '<polyline points="4 6 9 11 4 16"/><path d="M13 16h7"/>'
  };
  const ic = (name, size = 20) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || "") + "</svg>";

  /* ======================= toasts ======================= */
  function toast(msg, type = "ok") {
    const root = byId("toasts");
    if (!root) return;
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.innerHTML = '<span class="t-icon">' + (type === "ok" ? ic("check", 15) : type === "err" ? ic("x", 15) : ic("info", 15)) + "</span><span></span>";
    el.lastElementChild.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 2800);
  }

  /* ======================= modal helpers ======================= */
  function showModal(html) {
    byId("root-modal").innerHTML = '<div class="modal-back" id="modal-back">' + html + "</div>";
    S.modalOpen = true;
    byId("modal-back").addEventListener("click", e => { if (e.target === byId("modal-back")) closeModal(); });
    $$("[data-close]", byId("modal-back")).forEach(b => b.addEventListener("click", closeModal));
  }
  function closeModal() { byId("root-modal").innerHTML = ""; S.modalOpen = false; }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); return true; } catch (e2) { return false; }
      finally { ta.remove(); }
    }
  }

  /* ======================= playback log recorder ======================= */
  const playerLogs = [];
  const fmtTime = (ms) => {
    const d = new Date(ms);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
  };
  const shortUrl = (u) => {
    u = String(u || "");
    const i = u.indexOf("?");
    const core = i === -1 ? u : u.slice(0, i);
    return u.length > 160 ? core.slice(0, 120) + "…" : u;
  };
  const fmtLogArg = (x) => x instanceof Error ? (x.stack || x.message) : (x && typeof x === "object" ? (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })() : String(x));
  function logPlayer(level, msg) {
    const entry = { t: Date.now(), level: String(level || "info"), msg: String(msg || "") };
    playerLogs.push(entry);
    if (playerLogs.length > 300) playerLogs.shift();
    return entry;
  }
  if (!window.__HC_LOG_PATCHED__) {
    window.__HC_LOG_PATCHED__ = true;
    const oW = console.warn.bind(console);
    const oE = console.error.bind(console);
    console.warn = function (...a) { logPlayer("warn", a.map(fmtLogArg).join(" ")); return oW.apply(console, a); };
    console.error = function (...a) { logPlayer("error", a.map(fmtLogArg).join(" ")); return oE.apply(console, a); };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("error", (e) => logPlayer("error", ("window.onerror: " + (e && e.message ? e.message : String(e))) + (e && e.filename ? " @" + e.filename + (e.lineno ? ":" + e.lineno : "") : "")));
      window.addEventListener("unhandledrejection", (e) => {
        const r = e && e.reason;
        logPlayer("error", "Unhandled promise rejection: " + (r instanceof Error ? (r.stack || r.message) : (r && r.message ? r.message : String(r))));
      });
    }
  }

  /* ======================= audio chime ======================= */
  function playChime() {
    if (!prefs().sounds) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const tone = (f, t, d) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = "sine";
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + d);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d + 0.05);
      };
      tone(523, 0, 0.35); tone(659, 0.09, 0.35); tone(784, 0.18, 0.5);
    } catch (e) { /* ignore */ }
  }

  /* ======================= auth ======================= */
  function boot() {
    if (localStorage.getItem(RESOLVER_CACHE_KEY) === null) markResolverDown();
    if (!supabaseClient) { renderConfigError(); return; }
    
    // Initialize PeerJS lifecycle handlers
    ensureCleanupHandlers();
    
    document.addEventListener("keydown", e => { if (e.key === "Escape" && S.modalOpen) closeModal(); });
    document.addEventListener("click", e => {
      const m = $(".dropdown:not(.hidden)");
      if (m && !m.contains(e.target)) m.classList.add("hidden");
    });
    window.addEventListener("pagehide", e => cleanupOnUnload(e));
    window.addEventListener("beforeunload", () => cleanupOnUnload({ persisted: false }));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) onPageResumed(); });
    window.addEventListener("focus", () => onPageResumed());
    ["click", "pointerdown", "keydown", "touchstart"].forEach(ev =>
      document.addEventListener(ev, () => { resumeTalkContexts(); kickMediaPlayback(); }, true));
    supabaseClient.auth.getSession().then(({ data }) => {
      if (data.session && data.session.user) {
        SESSION_TOKEN = data.session.access_token || null;
        refreshAndGo(data.session.user);
      } else renderAuth();
    });
    supabaseClient.auth.onAuthStateChange((evt, session) => {
      if (evt === "SIGNED_IN" && session) {
        SESSION_TOKEN = session.access_token || null;
        refreshAndGo(session.user);
      } else if (evt === "SIGNED_OUT") {
        SESSION_TOKEN = null;
        if (!S.user) renderAuth();
      }
    });
  }

  function renderConfigError() {
    byId("app").innerHTML =
      '<div class="auth-wrap"><div class="auth-glow"></div><div class="auth-card-wrap"><div class="auth-card" style="text-align:center;">' +
        "<h2>Missing Supabase config</h2>" +
        '<p class="sub">Open ' + esc(new URLSearchParams(location.search).get("f") || "app.js (source)") +
        ' and replace <b>SUPABASE_URL</b> and <b>SUPABASE_ANON_KEY</b> at the top with your project values.</p>' +
        '<p class="sub">The Supabase and PeerJS CDN scripts are already in the &lt;head&gt; of hivecall.html.</p>' +
      "</div></div></div>";
  }

  async function refreshAndGo(remoteUser) {
    if (!supabaseClient) return renderAuth();
    if (!remoteUser) {
      const { data: ud } = await supabaseClient.auth.getUser();
      remoteUser = ud.user;
    }
    if (!remoteUser) return renderAuth();
    const meta = remoteUser.user_metadata || {};
    const uid = remoteUser.id;
    const email = remoteUser.email || "";
    const clean = (meta && (meta.display_name || meta.name)) || "";
    const name = (clean && clean.trim()) || (email && email.split("@")[0].trim()) || fallbackName(uid);
    const color = meta.color || COLORS[0];
    S.user = ensureProfile(uid, name, color);
    supabaseClient.auth.getSession().then(({ data }) => { if (data && data.session) SESSION_TOKEN = data.session.access_token; });
    await refreshData();
    const p = DB.profiles[uid];
    if (p && p.name && !isPlaceholder(p.name)) S.user.name = p.name;
    if (p && p.color) S.user.color = p.color;
    goHome();
  }

  function swatchesHTML(selected) {
    return COLORS.map(c => '<div class="swatch ' + (c === selected ? "selected" : "") + '" style="background:' + c + '" data-color="' + c + '"></div>').join("");
  }

  function renderAuth(mode) {
    mode = mode === "signup" ? "signup" : "login";
    byId("app").innerHTML =
      '<div class="auth-wrap">' +
        '<div class="auth-glow"></div>' +
        '<div class="auth-brand">' +
          '<div class="brand-top"><div class="brand-logo">' + ic("logo", 28) + '</div><div class="brand-name">HiveCall</div></div>' +
          '<div class="brand-hero"><h1>Your servers. Your people. <em>Your call.</em></h1>' +
          '<p>Create an account, spin up a server with a randomly assigned name, and see who is already in the call before you jump in. Pick a server, join voice, go.</p>' +
          '<div class="brand-steps">' +
            '<div class="brand-step"><span class="num">1</span><span>Create an account and your very first server is made for you.</span></div>' +
            '<div class="brand-step"><span class="num">2</span><span>See who is in the voice call before joining — mic, camera, screenshare at your fingertips.</span></div>' +
            '<div class="brand-step"><span class="num">3</span><span>Hand out your invite code so friends can join or leave the call freely.</span></div>' +
          '</div></div>' +
          '<div class="brand-foot"><span>Server name <b>renamable any time</b></span><span>Invite codes</span><span>Group calls</span></div>' +
        '</div>' +
        '<div class="auth-card-wrap"><div class="auth-card">' +
          '<div class="auth-tabs">' +
            '<button class="auth-tab ' + (mode === "login" ? "active" : "") + '" data-auth-tab="login">Sign in</button>' +
            '<button class="auth-tab ' + (mode === "signup" ? "active" : "") + '" data-auth-tab="signup">Create account</button>' +
          '</div>' +
          '<div id="auth-form"></div>' +
        '</div></div>' +
      '</div>';
    renderAuthForm(mode);
    $$(".auth-tab").forEach(t => t.addEventListener("click", () => renderAuth(t.dataset.authTab)));
  }

  function renderAuthForm(mode) {
    const f = byId("auth-form");
    if (mode === "signup") {
      f.innerHTML =
        '<h2>Create your account</h2>' +
        '<p class="sub">Pick a username and an avatar color.</p>' +
        '<div class="field"><label>Display name</label><input id="au-name" type="text" maxlength="24" placeholder="e.g. Nova" autocomplete="off"></div>' +
        '<div class="field"><label>Email</label><input id="au-email" type="email" placeholder="you@example.com" autocomplete="email"></div>' +
        '<div class="field"><label>Password</label><input id="au-pass" type="password" placeholder="6+ characters"></div>' +
        '<div class="field"><label>Avatar color</label><div class="swatch-row" id="au-colors">' + swatchesHTML(COLORS[5]) + '</div></div>' +
        '<div class="auth-error" id="auth-err"></div>' +
        '<button class="btn btn-primary" id="auth-go">Create account  →</button>' +
        '<p class="field"><span class="hint">A server with a random name is created for you automatically. Share its invite code so real friends can join and hop into the call.</span></p>';
    } else {
      f.innerHTML =
        '<h2>Welcome back</h2>' +
        '<p class="sub">Sign in to your HiveCall account.</p>' +
        '<div class="field"><label>Email</label><input id="au-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
        '<div class="field"><label>Password</label><input id="au-pass" type="password"></div>' +
        '<div class="auth-error" id="auth-err"></div>' +
        '<button class="btn btn-primary" id="auth-go">Sign in  →</button>';
    }
    if (mode === "signup") {
      let chosen = COLORS[5];
      $$(".swatch", f).forEach(s => s.addEventListener("click", () => {
        chosen = s.dataset.color;
        $$(".swatch", f).forEach(x => x.classList.toggle("selected", x === s));
      }));
      byId("auth-go").addEventListener("click", () => doSignup(chosen));
      byId("au-pass").addEventListener("keydown", e => { if (e.key === "Enter") doSignup(chosen); });
      byId("au-name").addEventListener("keydown", e => { if (e.key === "Enter") doSignup(chosen); });
      byId("au-email").addEventListener("keydown", e => { if (e.key === "Enter") doSignup(chosen); });
    } else {
      byId("auth-go").addEventListener("click", doLogin);
      byId("au-pass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
      byId("au-email").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    }
  }

  function authError(msg) {
    const el = byId("auth-err");
    el.textContent = msg;
    el.classList.add("show");
  }

  async function doSignup(color) {
    const name = (byId("au-name").value || "").trim();
    const email = (byId("au-email").value || "").trim();
    const pass = byId("au-pass").value || "";
    if (name.length < 2) return authError("Please pick a display name (2+ characters).");
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError("Enter a valid email address.");
    if (pass.length < 6) return authError("Password needs at least 6 characters.");
    const { data, error } = await supabaseClient.auth.signUp({
      email, password: pass,
      options: { data: { display_name: name, color } }
    });
    if (error) return authError(error.message);
    if (data && data.session) {
      S.user = { id: data.session.user.id, name, color };
      await createStarterGuild();
      goHome();
      toast("Welcome to HiveCall, " + name + "!", "ok");
    } else {
      byId("auth-form").innerHTML =
        '<h2>Check your email</h2>' +
        '<p class="sub">We sent a confirmation link to <b>' + esc(email) + '</b>. Confirm it, then sign in.</p>' +
        '<button class="btn btn-primary" style="width:100%;" id="auth-confirm-ok">OK</button>';
      byId("auth-confirm-ok").addEventListener("click", () => renderAuth("login"));
    }
  }

  async function doLogin() {
    const email = (byId("au-email").value || "").trim();
    const pass = byId("au-pass").value || "";
    if (!email || !pass) return authError("Enter your email and password.");
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password: pass });
    if (error) return authError(error.message);
    toast("Signed in.", "ok");
  }

  async function signOut() {
    if (S.call) leaveCall();
    if (supabaseClient) { try { await supabaseClient.auth.signOut(); } catch (e) {} }
    S.user = null; S.activeGuildId = null;
    closeRealtime();
    DB = { servers: {}, profiles: {}, soundboards: {} };
    renderAuth("login");
    toast("Signed out.", "info");
  }

  /* ======================= guilds (Supabase servers) ======================= */
  const goodCode = () => {
    const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
    for (let i = 0; i < 6; i++) s += a[rand(0, a.length - 1)];
    return s;
  };
  async function uniqueInviteCode() {
    for (let tries = 0; tries < 25; tries++) {
      const code = goodCode();
      const { data } = await supabaseClient.from("servers").select("id").eq("invite_code", code).maybeSingle();
      if (!data) return code;
    }
    return goodCode();
  }

  async function createGuild(name) {
    const invite = await uniqueInviteCode();
    const color = hashColor(invite);
    const { data, error } = await supabaseClient.from("servers").insert({
      name: name || randServerName(), owner_id: S.user.id, invite_code: invite
    }).select().single();
    if (error || !data) { toast("Could not create the server (" + (error ? error.message : "no row") + ").", "err"); return null; }
    await upsertMember(data.id);
    const g = mapServerRow(data);
    g.members = [S.user.id];
    DB.servers[g.id] = g;
    if (S.user && !DB.profiles[S.user.id]) DB.profiles[S.user.id] = { id: S.user.id, name: S.user.name, color: S.user.color };
    return g;
  }
  async function upsertMember(serverId) {
    const me = S.user; if (!me || !supabaseClient) return;
    await supabaseClient.from("server_members").upsert(
      { server_id: serverId, user_id: me.id },
      { onConflict: "server_id,user_id" }
    );
  }

  async function createStarterGuild() {
    const g = await createGuild(null);
    if (!g) return;
    S.activeGuildId = g.id;
    S.activeChannel = "voice";
  }

  async function deleteGuild(id) {
    const g = guilds()[id];
    if (!g || g.owner !== S.user.id) return;
    if (S.call && S.call.guildId === id) leaveCall();
    if (supabaseClient) {
      const tid = g.id;
      await supabaseClient.from("messages").delete().eq("server_id", tid);
      await supabaseClient.from("call_presence").delete().eq("server_id", tid);
      await supabaseClient.from("soundboard").delete().eq("server_id", tid);
      await supabaseClient.from("server_members").delete().eq("server_id", tid);
      await supabaseClient.from("servers").delete().eq("id", tid).eq("owner_id", S.user.id);
    }
    closeRealtime();
    delete DB.servers[id];
    if (S.activeGuildId === id) S.activeGuildId = null;
    closeModal();
    goHome();
    toast('"' + g.name + '" was deleted.', "info");
  }

  async function joinGuildByCode(code) {
    code = (code || "").toUpperCase().trim();
    if (!code) return toast("Enter the 6-character invite code.", "err");
    if (code.length !== 6) return toast("Invite codes are 6 characters.", "err");
    const { data, error } = await supabaseClient.from("servers").select("*").eq("invite_code", code).maybeSingle();
    if (error || !data) return toast("No server found for code " + code + ".", "err");
    await upsertMember(data.id);
    DB.profiles[S.user.id] = { id: S.user.id, name: S.user.name, color: S.user.color };
    toast("Joined " + data.name + "!", "ok");
    S.activeGuildId = data.id;
    S.activeChannel = "voice";
    closeModal();
    goHome();
  }

  /* ======================= home ======================= */
  function renderHomeShell() {
    setInCallFlag();
    const joined = Object.values(guilds());
    if (S.activeGuildId && !guilds()[S.activeGuildId]) S.activeGuildId = null;
    if (!S.activeGuildId && joined.length) S.activeGuildId = joined[0].id;
    const gAct = guild();
    if (gAct) openRealtime(gAct.id);
    byId("app").innerHTML =
      '<div class="home">' +
        '<div class="rail" id="rail"></div>' +
        '<div class="sidebar" id="sidebar"></div>' +
        '<div class="content" id="content"></div>' +
      '</div>';
    renderRail();
    renderSidebar();
    renderContent();
  }
  let homeSeq = 0;
  async function goHome(refresh = true) {
    if (callTimerI) { clearInterval(callTimerI); callTimerI = null; }
    const seq = ++homeSeq;
    renderHomeShell();
    if (refresh && seq === homeSeq && supabaseClient && S.user) {
      await refreshData();
      if (seq === homeSeq) renderHomeShell();
    }
  }

  function renderRail() {
    const joined = Object.values(guilds()).filter(g => g.members.includes(S.user.id));
    let html =
      '<button class="rail-btn rail-home ' + (!S.activeGuildId ? "active" : "") + '" id="rail-home" title="Home">' + ic("logo", 26) + "</button>" +
      '<div class="rail-sep"></div>';
    for (const g of joined) {
      const active = g.id === S.activeGuildId;
      html += '<button class="guild-icon ' + (active ? "active" : "") + '" data-guild="' + g.id + '" style="background:linear-gradient(145deg, ' + g.color + ', #050506)" title="' + esc(g.name) + '">' + esc(shortName(g.name)) + "</button>";
    }
    html += '<button class="rail-add" id="rail-add" title="Add a server">' + ic("plus", 24) + "</button>";
    html += '<div class="rail-spacer"></div>';
    html += '<button class="rail-me" id="rail-me" title="Profile & settings"><div class="avatar" style="width:34px;height:34px;background:' + S.user.color + '">' + esc(initials(S.user.name)) + "</div></button>";
    byId("rail").innerHTML = html;
    $$(".guild-icon").forEach(b => b.addEventListener("click", () => {
      S.activeGuildId = b.dataset.guild; S.activeChannel = "voice"; goHome();
    }));
    byId("rail-add").addEventListener("click", createServerModal);
    byId("rail-home").addEventListener("click", () => { S.activeGuildId = null; goHome(); });
    byId("rail-me").addEventListener("click", settingsModal);
  }

  function renderSidebar() {
    const g = guild();
    if (!g) {
      byId("sidebar").innerHTML = '<div class="sidebar-scroll"><div class="channel-label">WELCOME</div><p class="ill-hint" style="padding:0 6px;">Pick a server from the left, or create your own.</p></div>';
      return;
    }
    const inCall = g.call.length;
    let html =
      '<div class="sidebar-head"><span class="gname">' + esc(g.name) + "</span>" +
      '<button class="head-drop-btn" id="drop-btn">' + ic("edit", 16) + "</button>" +
      '<div class="dropdown hidden" id="drop-menu">' +
        '<div class="label">' + esc(g.name) + "</div>" +
        '<button id="drop-rename">' + ic("gear", 15) + " Server settings</button>" +
        (g.owner === S.user.id ? '<button id="drop-del">' + ic("trash", 15) + " Delete server</button>" : "") +
      "</div></div>";
    html +=
      '<div class="sidebar-scroll">' +
        '<div class="channel-label">CHANNELS</div>' +
        '<div class="channel ' + (S.activeChannel === "general" ? "active" : "") + '" data-channel="general">' + ic("hash", 16) + "<span>general</span></div>" +
        '<div class="channel voice ' + (S.activeChannel === "voice" ? "active" : "") + '" data-channel="voice">' + ic("voice", 16) + "<span>Voice Lounge</span>" +
          '<span class="count">' + (inCall ? '<span class="livectl"><span class="live-dot"></span><span id="side-call-n">' + inCall + "</span></span>" : "<span>" + inCall + "</span>") + "</span></div>" +
        '<div class="sidebar-section">' +
          '<div class="channel-label">IN THIS SERVER — ' + g.members.length + "</div>" +
          '<p class="ill-hint" style="padding:0 6px;">The member list on the right shows who is in the voice call before you join.</p>' +
        "</div>" +
      "</div>";
    byId("sidebar").innerHTML = html;
    $$(".channel").forEach(c => c.addEventListener("click", () => {
      S.activeChannel = c.dataset.channel === "general" ? "general" : "voice";
      renderSidebar(); renderContent();
    }));
    byId("drop-btn").addEventListener("click", e => { e.stopPropagation(); byId("drop-menu").classList.toggle("hidden"); });
    byId("drop-rename").addEventListener("click", () => { closeModal(); settingsModal(); });
    const del = byId("drop-del");
    if (del) del.addEventListener("click", () => { closeModal(); confirmDeleteModal(); });
  }

  function renderContent() {
    const g = guild();
    let main;
    if (!g) {
      main = overviewHTML();
      byId("content").innerHTML = '<div class="main-area">' + main + "</div>";
      wireOverview();
      return;
    }
    main = S.activeChannel === "general" ? chatHTML(g) : voiceHTML(g);
    const members = membersHTML(g);
    byId("content").innerHTML = '<div class="main-area">' + main + '</div><div class="members-panel">' + members + "</div>";
    if (S.activeChannel === "general") wireChat(g);
    else wireVoice(g);
  }

  function overviewHTML() {
    const mine = Object.values(guilds()).filter(g => g.members.includes(S.user.id));
    const cards = mine.length ? mine.map(g => {
      const inCall = g.call.length;
      return '<div class="invite-row" style="border:1px solid var(--line-2);border-radius:12px;margin-bottom:10px;">' +
        '<div class="avatar" style="width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,' + g.color + ',#050506);font-size:15px;">' + esc(shortName(g.name)) + "</div>" +
        '<div class="ir-info"><div class="ir-name">' + esc(g.name) + "</div>" +
        '<div class="ir-status">' + g.members.length + " members · " + (inCall ? '<span style="color:var(--green)">' + inCall + " in the call</span>" : "nobody in the call yet") + "</div></div>" +
        '<div class="ir-actions"><button class="ir-action gray" data-ocode="' + g.invite + '">' + ic("copy", 13) + "</button>" +
        '<button class="ir-action add" data-open="' + g.id + '">Open</button></div></div>';
    }).join("") : '<div class="invite-row" style="border:1px dashed var(--line-2);border-radius:12px;"><div class="ir-info"><div class="ir-name" style="color:var(--tx-3);font-weight:600;">No servers yet</div><div class="ir-status">Create one — it gets a random name you can change later.</div></div></div>';
    return '<div class="voice-wrap"><div class="voice-card" style="max-width:560px;text-align:left;align-items:flex-start;">' +
      '<h1>Your servers</h1><p class="vsub" style="margin:8px 0 22px;">Join a server to see who is already in the call, then hop in.</p>' +
      cards +
      '<div class="btn-row" style="margin-top:14px;"><button class="btn btn-green" id="ov-create">' + ic("plus", 17) + " Create a server</button>" +
      '<button class="btn btn-ghost" id="ov-join">' + ic("key", 17) + " Join with code</button></div>" +
      "</div></div>";
  }
  function wireOverview() {
    $$("[data-open]").forEach(b => b.addEventListener("click", () => {
      S.activeGuildId = b.dataset.open; S.activeChannel = "voice"; goHome();
    }));
    $$("[data-ocode]").forEach(b => b.addEventListener("click", async () => {
      const ok = await copyText(b.dataset.ocode);
      toast(ok ? "Invite code copied." : "Could not copy.", ok ? "ok" : "err");
    }));
    byId("ov-create").addEventListener("click", createServerModal);
    byId("ov-join").addEventListener("click", createServerModal);
  }

  function chatRowHTML(m) {
    if (m.system) return '<div class="msg system"><span class="sicon">' + ic("info", 15) + '</span><div class="m-text">' + esc(m.text) + ' <span class="m-time">' + time12(m.at) + "</span></div></div>";
    const name = displayName(m.authorId, m.authorName);
    const color = displayColor(m.authorId, m.authorColor);
    return '<div class="msg"><div class="avatar" style="width:38px;height:38px;background:' + color + '">' + esc(initials(name)) + '</div>' +
      '<div class="m-body"><div class="m-meta"><span class="m-name" style="color:' + color + '">' + esc(name) + '</span><span class="m-time">' + time12(m.at) + "</span></div>" +
      '<div class="m-text">' + esc(m.text) + "</div></div></div>";
  }
  function chatHTML(g) {
    const msgs = (g.chat || []).map(m => chatRowHTML(m)).join("");
    return '<div class="chat-head">' + ic("hash", 18) + "<span>general</span></div>" +
      '<div class="chat-msgs" id="chat-msgs">' + (msgs || '<p class="ill-hint">No messages yet. Say hi!</p>') + "</div>" +
      '<div class="typing" id="typing" style="display:none;color:var(--tx-3);font-size:12px;line-height:1;padding:7px 4px 9px;"></div>' +
      '<div class="chat-comp"><div class="inner"><input id="chat-in" placeholder="Message #general" autocomplete="off"><button class="send" id="chat-send">' + ic("send", 18) + "</button></div></div>";
  }
  function wireChat(g) {
    const sc = byId("chat-msgs"); if (sc) sc.scrollTop = sc.scrollHeight;
    const input = byId("chat-in");
    input.focus();
    const emitTyping = stopped => {
      const ch = getChannel(g.id);
      if (!ch) return;
      try { ch.send({ type: "broadcast", event: "typing", payload: { from: S.user.id, guildId: g.id, stopped: !!stopped } }); } catch (e) {}
    };
    let typT = null;
    input.addEventListener("input", () => {
      if (!input.value.trim()) { emitTyping(true); return; }
      clearTimeout(typT);
      typT = setTimeout(() => typLastSent = 0, 2200);
      if (!typLastSent || Date.now() - typLastSent > 2500) { typLastSent = Date.now(); emitTyping(false); }
    });
    input.addEventListener("blur", () => { clearTimeout(typT); emitTyping(true); });
    const send = async () => {
      const text = input.value.trim();
      if (!text || !supabaseClient) return;
      clearTimeout(typT); typLastSent = 0; emitTyping(true);
      const me = S.user;
      const localId = "m_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const m = { id: localId, pending: true, authorId: me.id, authorName: me.name, authorColor: me.color, text, at: Date.now() };
      g.chat.push(m);
      const box = byId("chat-msgs");
      let node = null;
      if (box) {
        const w = document.createElement("div");
        w.innerHTML = chatRowHTML(m);
        node = w.firstElementChild;
        if (node) { box.appendChild(node); box.scrollTop = box.scrollHeight; }
      }
      input.value = "";
      try {
        const { data, error } = await supabaseClient.from("messages").insert({
          server_id: g.id, user_id: me.id, user_name: me.name, user_color: me.color, content: text,
          created_at: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        const idx = g.chat.findIndex(x => x.id === localId);
        if (idx !== -1) {
          g.chat[idx].id = data && data.id ? data.id : g.chat[idx].id;
          g.chat[idx].pending = false;
          const t = data && Date.parse(data.created_at);
          if (!isNaN(t)) g.chat[idx].at = t;
        }
      } catch (err) {
        const idx = g.chat.findIndex(x => x.id === localId);
        if (idx !== -1) g.chat.splice(idx, 1);
        if (node && node.parentNode) node.parentNode.removeChild(node);
        toast("Message failed: " + ((err && err.message) || "unknown error"), "err");
      }
    };
    byId("chat-send").addEventListener("click", send);
    input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
  }

  let typers = {}, typLastSent = 0, typTimer = null;
  function typingHTML() {
    const me = (S.user && S.user.id) || "";
    const names = Object.keys(typers)
      .filter(uid => uid !== me && Date.now() - typers[uid] <= 4000)
      .map(uid => { const u = users()[uid]; return (u && u.name) || uid; });
    if (!names.length) return "";
    const list = names.length <= 2 ? names.join(" and ") : names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " other" + (names.length === 3 ? "" : "s");
    return esc(list) + " " + (names.length > 1 ? "are" : "is") + " typing…";
  }
  function sweepTypers() {
    const now = Date.now();
    Object.keys(typers).forEach(uid => { if (now - typers[uid] > 4000) delete typers[uid]; });
    renderTyping();
    if (!Object.keys(typers).length) { clearTimeout(typTimer); typTimer = null; }
  }
  function renderTyping() {
    const el = byId("typing");
    if (!el) return;
    const html = typingHTML();
    if (html) { el.style.display = ""; el.innerHTML = html; }
    else { el.style.display = "none"; el.innerHTML = ""; }
  }
  function onTyping(p) {
    p = broadcastPayload(p);
    const me = (S.user && S.user.id) || "";
    if (!p || !p.from || p.from === me) return;
    if (p.stopped) {
      delete typers[p.from];
      if (!Object.keys(typers).length) { clearTimeout(typTimer); typTimer = null; }
    } else {
      typers[p.from] = Date.now();
      clearTimeout(typTimer);
      typTimer = setTimeout(sweepTypers, 4000);
    }
    renderTyping();
  }

  function voiceHTML(g) {
    const inCallIds = g.call || [];
    const inCallUsers = inCallIds.map(id => users()[id]).filter(Boolean);
    const inMyCall = !!(S.call && S.call.guildId === g.id);
    const chips = inCallUsers.length
      ? inCallUsers.map(u => {
          const self = u.id === S.user.id;
          return '<span class="chip"><span class="avatar" style="width:26px;height:26px;background:' + u.color + '">' + esc(initials(u.name)) + '</span><span>' + (self ? "You" : esc(u.name)) + "</span>" + (self ? "" : '<span class="speak">' + ic("headphone", 13) + "</span>") + "</span>";
        }).join("")
      : '<span class="chip empty">The call is empty — be the first to join</span>';
    return '<div class="voice-wrap"><div class="voice-card">' +
      '<div class="voice-hero ' + (inCallUsers.length ? "live" : "idle") + '">' + (inCallUsers.length ? ic("headphone", 42) : ic("voice", 42)) + "</div>" +
      "<h1>Voice Lounge</h1>" +
      '<p class="vsub">' + esc(g.name) + " · a place to hang out. Everyone on the server can see who is in this call before joining." + "</p>" +
      '<div class="voice-status">' + (inCallUsers.length ? '<span class="live-dot"></span>' : ic("users", 15)) +
        "<span>" + inCallUsers.length + " voice participant" + (inCallUsers.length === 1 ? "" : "s") + "</span></div>" +
      '<div class="voice-people">' + chips + "</div>" +
      '<div class="voice-actions">' +
        (inMyCall
          ? '<button class="btn btn-green" id="v-open2">' + ic("voice", 17) + " Return to call</button>"
          : '<button class="btn btn-green" id="v-join">' + ic("voice", 17) + " Join call</button>") +
        '<button class="btn btn-ghost" id="v-invite">' + ic("userPlus", 17) + " Invite</button>" +
      "</div>" +
      '<div class="voice-note">' + ic("info", 13) + " A camera &amp; microphone request appears when you join — decline and you still join with your avatar.</div>" +
    "</div></div>";
  }
  function wireVoice(g) {
    const join = byId("v-join");
    if (join) join.addEventListener("click", joinCall);
    const open = byId("v-open2");
    if (open) open.addEventListener("click", joinCall);
    const inv = byId("v-invite");
    if (inv) inv.addEventListener("click", participantsModal);
  }

  function membersHTML(g) {
    const inCall = (g.call || []).map(id => users()[id]).filter(Boolean);
    const rest = g.members.filter(id => !g.call.includes(id)).map(id => users()[id]).filter(Boolean);
    const row = u => {
      const self = u.id === S.user.id;
      return '<div class="member-row"><div class="a-wrap"><div class="avatar" style="width:30px;height:30px;background:' + u.color + '">' + esc(initials(u.name)) + '</div><div class="status-dot"></div></div>' +
        '<span class="mname" style="' + (self ? "color:#fff;" : "") + '">' + esc(u.name) + (self ? ' <span class="mtag">(you)</span>' : "") + "</span>" +
        "</div>";
    };
    let html = '<div class="members-group">In the call — ' + inCall.length + "</div>"
      + (inCall.length ? inCall.map(u => '<div class="member-row"><div class="a-wrap"><div class="avatar" style="width:30px;height:30px;background:' + u.color + '">' + esc(initials(u.name)) + '</div><div class="status-dot"></div></div><span class="mname">' + esc(u.name) + (u.id === S.user.id ? ' <span class="mtag">(you)</span>' : "") + '</span><span class="in-call-badge" title="In the voice call">' + ic("headphone", 14) + "</span></div>").join("") : '<p class="ill-hint" style="padding:0 8px 8px;">No one is in the call right now.</p>');
    html += '<div class="members-group">In the server — ' + rest.length + "</div>"
      + (rest.length ? rest.map(row).join("") : '<p class="ill-hint" style="padding:0 8px;">Only the people above make up this server.</p>');
    return html;
  }

  /* ======================= CALL ======================= */
  function joinCall() {
    const g = guild();
    if (!g || !S.user || !supabaseClient) return;
    if (S.call) {
      if (S.call.guildId === g.id) {
        renderCall();
        toast("Returned to the call.", "info");
      }
      return;
    }
    if (SP.on) stopSpotify();
    
    // FIX: Respect user's device preference. If `autoMute` is NOT active, user joins with mic UNMUTED!
    // This allows other peers to instantly hear them upon joining.
    const p = prefs();
    const initialMic = !p.autoMute;
    
    const now = Date.now();
    S.call = {
      guildId: g.id, joinAt: now, mic: initialMic, cam: false, share: false,
      stream: null, display: null, hasMedia: false, shareWaiting: false,
      peers: {}, shareMc: {}, soundMc: [], soundLocal: [], soundRemote: [], remote: {}, remoteShare: null, sharePending: {}
    };
    g.roster = g.roster || {};
    g.roster[S.user.id] = { name: S.user.name, color: S.user.color, mic: initialMic, cam: false, share: false, joinedAt: now };
    if (!g.call.includes(S.user.id)) g.call.push(S.user.id);
    if (!DB.profiles[S.user.id]) DB.profiles[S.user.id] = { id: S.user.id, name: S.user.name, color: S.user.color };
    writePresence(g.id, { [S.user.id]: { name: S.user.name, color: S.user.color, mic: initialMic, cam: false, share: false, joinedAt: now } });
    renderCall();
    bootMedia();
    startCallTimer();
    startPresenceBeat();
    playChime();
    scheduleMusicInviteCheck();
    toast("Joined " + g.name + " · Voice Lounge", "ok");
  }

  function leaveCall() {
    const c = S.call;
    if (!c) return;
    const gid = c.guildId;
    releaseCallMedia();
    stopPresenceBeat();
    Object.keys(c.peers || {}).forEach(k => { try { c.peers[k].close(); } catch (e) {} });
    Object.keys(c.shareMc || {}).forEach(k => { try { c.shareMc[k].close(); } catch (e) {} });
    (c.soundMc || []).forEach(mc => { try { mc.close(); } catch (e) {} });
    (c.soundLocal || []).forEach(item => { try { item.audio.pause(); item.audio.src = ""; } catch (e) {} try { item.ctx.close(); } catch (e) {} });
    (c.soundRemote || []).forEach(audio => { 
      try { audio.pause(); audio.srcObject = null; } catch (e) {}
      try { audio.remove(); } catch (e) {} 
    });
    Object.keys(c.remote || {}).forEach(k => unwatchTalkLevel(k));
    // CRITICAL: Clean up PeerJS BEFORE clearing S.call
    cleanupPeerResources();
    if (c.stream) c.stream.getTracks().forEach(t => t.stop());
    if (c.display) c.display.getTracks().forEach(t => t.stop());
    unwatchTalkLevel(S.user.id);
    writePresence(gid, { [S.user.id]: null });
    const g = guilds()[gid];
    if (g) { g.call = (g.call || []).filter(id => id !== S.user.id); delete g.roster[S.user.id]; }
    S.call = null;
    SB.open = false;
    sbStopAllLocal();
    if (SP.on) stopSpotify();
    if (callTimerI) { clearInterval(callTimerI); callTimerI = null; }
    goHome();
    setInCallFlag();
    toast("You left the call.", "info");
  }

  function beaconPresence(gid) {
    if (!supabaseClient || !S.user || gid == null) return;
    const bak = ROSTER_MIRROR[gid];
    if (!bak) return;
    let next = bak;
    try { next = JSON.parse(JSON.stringify(bak)); } catch (e) { return; }
    delete next[S.user.id];
    if (next._music && S.callMusic && S.callMusic.hostId === S.user.id) delete next._music;
    const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/call_presence";
    let body;
    try { body = JSON.stringify({ server_id: gid, active_users: next }); } catch (e) { return; }
    const opt = {
      method: "POST", keepalive: true, body,
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + (SESSION_TOKEN || SUPABASE_ANON_KEY), "Prefer": "resolution=merge-duplicates" }
    };
    try { fetch(url + "?on_conflict=server_id", opt).catch(() => {}); } catch (e) {}
  }
  function cleanupOnUnload(e) {
    if (e && e.persisted) return;
    console.log("[PeerJS] Page unload detected, performing cleanup");

    // Clean up PeerJS connection
    cleanupPeerResources();

    const c = S.call;
    if (c) {
      releaseCallMedia();
      beaconPresence(c.guildId);
    }
    stopPresenceBeat();
    SB.open = false;
  }

  /* ======================= PeerJS Lifecycle Handlers ======================= */
  let cleanupHandlersRegistered = false;

  function registerPeerCleanupHandlers() {
    // Handle page unload/reload
    window.addEventListener("beforeunload", (e) => {
      cleanupPeerResources();
      if (S.call) beaconPresence(S.call.guildId);
    });

    // Handle visibility changes (tab backgrounding)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        console.log("[PeerJS] Page hidden, maintaining connection");
      } else {
        console.log("[PeerJS] Page visible, reconnecting if needed");
        if (S.call && peer && peer.disconnected) {
          try {
            peer.reconnect();
          } catch (e) {
            console.warn("[PeerJS] Reconnection on page visibility failed:", e);
          }
        }
      }
    });

    // Handle browser online/offline
    window.addEventListener("offline", () => {
      console.warn("[PeerJS] Network offline detected");
      if (peer && !peer.disconnected) {
        try { peer.disconnect(); } catch (e) {}
      }
    });

    window.addEventListener("online", () => {
      console.log("[PeerJS] Network online, attempting reconnection");
      if (S.call && peer && peer.disconnected) {
        try {
          peer.reconnect();
        } catch (e) {
          console.warn("[PeerJS] Reconnection on network online failed:", e);
        }
      }
    });
  }

  function ensureCleanupHandlers() {
    if (!cleanupHandlersRegistered) {
      registerPeerCleanupHandlers();
      cleanupHandlersRegistered = true;
    }
  }

  let presenceBeatI = null;
  function startPresenceBeat() {
    stopPresenceBeat();
    presenceBeatI = setInterval(() => {
      if (!S.call) { stopPresenceBeat(); return; }
      pushPresence();
    }, 8000);
  }
  function stopPresenceBeat() { if (presenceBeatI) { clearInterval(presenceBeatI); presenceBeatI = null; } }
  function onPageResumed() {
    resumeTalkContexts();
    if (!S.call) return;
    pushPresence();
    kickMediaPlayback();
    if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) {} }
    tryMesh();
    ensureShareMesh();
  }
  function kickMediaPlayback() {
    const c = S.call;
    if (!c) return;
    let stale = false;
    Object.keys(c.remote || {}).forEach(uid => {
      const a = byId("va-" + uid), v = byId("vm-" + uid);
      if (a && a.srcObject && a.paused) stale = true;
      if (v && v.srcObject && !v.hidden && v.paused) stale = true;
    });
    const sv = byId("share-video");
    if (sv && sv.srcObject && !sv.muted && sv.paused) stale = true;
    if (stale) attachMedia();
  }
  function releaseCallMedia() {
    $$("audio, video").forEach(el => {
      if (!el.closest || !el.closest("#call-view")) return;
      try { el.pause(); } catch (e) {}
      try { el.srcObject = null; } catch (e) {}
    });
    Object.keys(soundWait).forEach(k => { clearTimeout(soundWait[k]); delete soundWait[k]; });
    const c = S.call;
    if (c) {
      Object.keys(c.remote || {}).forEach(uid => {
        const r = c.remote[uid];
        if (r && r.stream) { try { r.stream.getTracks().forEach(t => t.stop()); } catch (e) {} }
        unwatchTalkLevel(uid);
        delete c.remote[uid];
      });
      if (c.remoteShare && c.remoteShare.stream) { try { c.remoteShare.stream.getTracks().forEach(t => t.stop()); } catch (e) {} }
      c.remoteShare = null;
      c.sharePending = {};
      (c.soundRemote || []).forEach(a => {
        try { a.pause(); } catch (e) {}
        try { a.srcObject = null; } catch (e) {}
        try { a.remove(); } catch (e) {}
      });
      c.soundRemote.length = 0;
    }
    clearTalkState();
    talkSent.state = false; talkSent.at = 0; talkSent.level = 0;
  }
  function setInCallFlag() { try { document.body.classList.toggle("in-call", !!S.call); } catch (e) {} }

  /* ======================= PeerJS Initialization Helpers ======================= */
  // UUID v4-like generator for unique session tokens
  const generateSessionToken = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  // Generate unique peer ID with session token to prevent collisions
  function generateUniquePeerId(userId) {
    const sessionToken = generateSessionToken();
    currentPeerSessionToken = sessionToken;
    return `${userId}#${sessionToken}`;
  }

  // Destroy peer and release all resources
  function destroyPeer() {
    if (!peer) return;

    try {
      // Disconnect all active connections
      if (peer._connections) {
        Object.values(peer._connections).forEach(conns => {
          if (Array.isArray(conns)) {
            conns.forEach(conn => {
              try { if (conn.close && !conn.closed) conn.close(); } catch (e) {}
            });
          }
        });
      }

      // Safely disconnect and destroy
      if (!peer.disconnected) {
        try { peer.disconnect(); } catch (e) {}
      }

      if (!peer.destroyed) {
        try { peer.destroy(); } catch (e) {}
      }
    } catch (e) {
      console.warn("[PeerJS] Error during destruction:", e);
    } finally {
      peer = null;
      peerOpen = false;
      currentPeerSessionToken = null;
    }
  }

  // Centralized cleanup function for all peer resources
  function cleanupPeerResources() {
    console.log("[PeerJS] Cleaning up peer resources");

    // Close all media connections
    if (peer && peer._connections) {
      Object.entries(peer._connections).forEach(([peerId, connections]) => {
        if (Array.isArray(connections)) {
          connections.forEach(conn => {
            try {
              if (conn.close && !conn.closed) conn.close();
            } catch (e) {
              console.warn(`[PeerJS] Error closing connection to ${peerId}:`, e);
            }
          });
        }
      });
    }

    // Destroy peer
    destroyPeer();
  }

  let peer = null, peerOpen = false, peerError = false;
  function getPeer() {
    if (typeof window.Peer === "undefined") {
      if (!peerError) {
        peerError = true;
        toast("PeerJS network is ready in the <head> tag — it seems to be missing.", "err");
      }
      return null;
    }

    // Return existing healthy peer
    if (peer && !peer.destroyed) {
      if (peer.disconnected) {
        try { peer.reconnect(); } catch (e) {}
      }
      return peer;
    }

    // Prevent concurrent initialization (Strict Mode safety)
    if (peerInitializing) {
      console.warn("[PeerJS] Initialization already in progress, skipping duplicate attempt");
      return null;
    }

    peerInitializing = true;
    peerError = false;

    try {
      // Generate unique peer ID with session token
      const uniquePeerId = generateUniquePeerId(S.user.id);
      console.log(`[PeerJS] Initializing with ID: ${uniquePeerId}`);

      peer = new window.Peer(uniquePeerId, {
        debug: 1,
      });

      peer.on("open", () => {
        console.log(`[PeerJS] Connection opened for session ${currentPeerSessionToken}`);
        peerOpen = true;
        peerInitializing = false;
        tryMesh();
        ensureShareMesh();
      });

      peer.on("disconnected", () => {
        console.warn("[PeerJS] Peer disconnected");
        peerOpen = false;
        
        if (S.call) {
          try { peer.reconnect(); } catch (e) {}
        }
      });

      peer.on("close", () => {
        console.log("[PeerJS] Peer connection closed");
        peerOpen = false;
        peer = null;
      });

      peer.on("error", (error) => {
        console.error("[PeerJS] Error event:", error);
        peerError = true;

        // Handle ID collision with retry
        if (error && error.type === "unavailable-id") {
          console.error("[PeerJS] ID collision detected! Retrying with new session...");
          destroyPeer();
          // Exponential backoff: 1-3 seconds
          setTimeout(() => {
            peerInitializing = false;
            getPeer();
          }, 1000 + Math.random() * 2000);
        }

        if (error && error.type === "peer-unavailable") {
          console.warn("[PeerJS] Peer unavailable:", error);
        }
      });

      peer.on("call", onIncomingCall);

      return peer;

    } catch (err) {
      console.error("[PeerJS] Exception during initialization:", err);
      peerError = true;
      peerInitializing = false;
      peer = null;
      return null;
    }
  }
  function tryMesh() {
    const c = S.call;
    if (!c || !c.stream || !peerOpen) return;
    const roster = (guilds()[c.guildId] || {}).call || [];
    roster.forEach(id => { if (id !== S.user.id && S.user.id < id) callUser(id); });
  }
  function callUser(uid) {
    const c = S.call;
    if (!c || !c.stream || !peerOpen || !peer) return;
    if (c.peers[uid] && c.peers[uid].open) return;

    try {
      console.log(`[PeerJS] Calling user ${uid}`);
      const mc = peer.call(uid, c.stream, { metadata: { kind: "main" } });
      c.peers[uid] = mc;
      
      mc.on("stream", s => upsertRemote(uid, s));
      mc.on("close", () => {
        console.log(`[PeerJS] Call closed with ${uid}`);
        cleanupRemote(uid);
      });
      mc.on("error", (err) => {
        console.error(`[PeerJS] Error on call with ${uid}:`, err);
        cleanupRemote(uid);
      });
    } catch (e) {
      console.error("[PeerJS] callUser failed for", uid, e);
    }
  }
  function onIncomingCall(mc) {
    const c = S.call, uid = mc.peer;
    if (!c) { try { mc.close(); } catch (e) {} return; }
    const kind = mc.metadata && mc.metadata.kind ? mc.metadata.kind : "";
    const roster = (guilds()[c.guildId] || {}).roster || {};
    const haveMain = !!(c.peers[uid] && c.peers[uid].open);
    if (kind === "sound") {
      try { mc.answer(); } catch (e) {}
      if (soundWait[uid]) { clearTimeout(soundWait[uid]); delete soundWait[uid]; }
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = "none";
      // FIX: Appending the dynamic remote audio element to the document fixes 
      // browsers (like Safari) immediately suspending background / detached audio playback.
      document.body.appendChild(audio); 
      audio.srcObject = null;
      c.soundRemote.push(audio);
      mc.on("stream", s => { audio.srcObject = s; playMedia(audio); });
      const remove = () => { 
        const i = c.soundRemote.indexOf(audio); 
        if (i !== -1) c.soundRemote.splice(i, 1); 
        try { audio.pause(); audio.srcObject = null; } catch (e) {} 
        try { audio.remove(); } catch (e) {} 
      };
      mc.on("close", remove);
      mc.on("error", remove);
      return;
    }
    const isShare = kind === "share" || (!kind && !!(roster[uid] && roster[uid].share) && haveMain);
    if (isShare) {
      try { mc.answer(); } catch (e) {}
      c.shareMc[uid] = mc;
      const drop = () => {
        if (!c || !c.remoteShare || c.remoteShare.id !== uid) return;
        c.remoteShare = null;
        if (c.sharePending && roster[uid] && roster[uid].share) c.sharePending[uid] = true;
        updateStage();
      };
      mc.on("stream", s => { c.remoteShare = { id: uid, stream: s }; if (c.sharePending) delete c.sharePending[uid]; updateStage(); });
      mc.on("close", drop);
      mc.on("error", drop);
      return;
    }
    try { mc.answer(c.stream || undefined); } catch (e) {}
    if (!c.peers[uid] || !c.peers[uid].open) c.peers[uid] = mc;
    mc.on("stream", s => upsertRemote(uid, s));
    mc.on("close", () => {
      console.log(`[PeerJS] Incoming call closed from ${uid}`);
      cleanupRemote(uid);
    });
    mc.on("error", (err) => {
      console.error(`[PeerJS] Error on incoming call from ${uid}:`, err);
      cleanupRemote(uid);
    });
  }
  function upsertRemote(uid, src) {
    const c = S.call; if (!c) return;
    let r = c.remote[uid];
    if (!r) r = c.remote[uid] = { stream: new MediaStream(), video: false, audio: false, watching: false };
    src.getTracks().forEach(t => {
      const isA = t.kind === "audio";
      const cur = isA ? r.stream.getAudioTracks() : r.stream.getVideoTracks();
      cur.forEach(x => { if (x !== t) try { r.stream.removeTrack(x); } catch (e) {} });
      if (!r.stream.getTracks().some(x => x === t)) r.stream.addTrack(t);
    });
    r.video = src.getVideoTracks().length > 0;
    r.audio = src.getAudioTracks().length > 0;
    if (!r.watching && r.audio) { r.watching = true; watchTalkLevel(src, uid); }
    if (r.watching && !r.audio) { r.watching = false; unwatchTalkLevel(uid); }
    updateStage();
  }
  function cleanupRemote(uid) {
    const c = S.call;
    if (!c) return;
    const still = Object.keys(c.peers).some(k => c.peers[k] && c.peers[k].open && !(c.peers[k] === c.shareMc[uid]));
    if (c.shareMc[uid]) { delete c.shareMc[uid]; }
    if (!still) { unwatchTalkLevel(uid); delete c.remote[uid]; clearTalkState(uid); }
    pruneIfGone(uid);
    updateStage();
  }
  function pruneIfGone(uid) {
    const c = S.call;
    if (!c || !uid || uid === S.user.id) return;
    const open = Object.keys(c.peers || {}).some(k => k === uid && c.peers[k] && c.peers[k].open);
    if (open) return;
    const mirror = ROSTER_MIRROR[c.guildId];
    if (mirror && mirror[uid]) return;
    const g = guilds()[c.guildId];
    if (!g || !g.roster[uid]) return;
    delete g.roster[uid];
    g.call = (g.call || []).filter(id => id !== uid);
    clearTalkState(uid);
  }
  function startShareRemote(s) {
    const c = S.call;
    if (!c || !s || !peerOpen || !peer) return 0;
    let dialed = 0;
    const roster = (guilds()[c.guildId] || {}).call || [];
    roster.forEach(uid => {
      if (uid === S.user.id) return;
      const existing = c.shareMc[uid];
      if (existing && existing.open) return;
      try {
        const mc = peer.call(uid, s, { metadata: { kind: "share" } });
        c.shareMc[uid] = mc;
        dialed++;
        mc.on("close", () => { if (c.shareMc[uid] === mc) delete c.shareMc[uid]; });
        mc.on("error", () => { try { mc.close(); } catch (e) {} if (c.shareMc[uid] === mc) delete c.shareMc[uid]; });
      } catch (e) {}
    });
    return dialed;
  }
  function ensureShareMesh() {
    const c = S.call;
    if (!c || !c.share || !c.display || !peerOpen || !peer) return;
    startShareRemote(c.display);
  }

  function renderCall() {
    const c = S.call;
    if (!c) return;
    const g = guilds()[c.guildId] || guild();
    byId("app").innerHTML =
      '<div class="call" id="call-view">' +
        '<div class="call-top">' +
          '<div class="call-left"><span class="pi-tag live"><span class="live-dot"></span>LIVE</span>' +
          '<span class="sname">' + esc(g ? g.name : "Server") + "</span><span class=\"cname\">· Voice Lounge</span></div>" +
          '<div class="call-right">' +
            '<span class="pi-tag">' + ic("clock", 13) + '<span id="call-timer">00:00</span></span>' +
            '<span class="pi-tag">' + ic("users", 14) + ' <span id="call-count">1</span></span>' +
            '<button class="btn btn-ghost btn-sm" id="btn-back">' + ic("home", 14) + " Return</button>" +
          "</div>" +
        "</div>" +
        '<div class="call-stage">' +
          '<div class="stage-main" id="stage-main"></div>' +
          '<div class="stage-strip" id="stage-strip" hidden></div>' +
        "</div>" +
        '<div class="sb-panel hidden" id="sb-panel"></div>' +
        '<div class="call-bar-zone"><div class="call-bar">' +
          '<button class="ctl" id="ctl-mic">' + ic("mic", 22) + '<span class="ctl-tip">Mute microphone</span></button>' +
          '<button class="ctl" id="ctl-cam">' + ic("cam", 22) + '<span class="ctl-tip">Turn camera off</span></button>' +
          '<button class="ctl" id="ctl-share">' + ic("share", 22) + '<span class="ctl-tip">Present your screen</span></button>' +
          '<button class="ctl" id="ctl-spotify">' + ic("spotify", 22) + '<span class="ctl-tip">Collaborative music</span></button>' +
          '<button class="ctl" id="ctl-sound">' + ic("sound", 22) + '<span class="ctl-tip">Sound board</span></button>' +
          '<div class="ctl-sep"></div>' +
          '<button class="ctl leave" id="ctl-leave">' + ic("leave", 24) + '<span class="ctl-tip">Leave the call</span></button>' +
          '<div class="ctl-sep"></div>' +
          '<button class="ctl" id="ctl-invite">' + ic("userPlus", 22) + '<span class="ctl-tip">Add participants</span></button>' +
          '<button class="ctl" id="ctl-settings">' + ic("gear", 22) + '<span class="ctl-tip">Settings</span></button>' +
        "</div></div>" +
      "</div>";
    updateCtl();
    updateStage();
    setInCallFlag();
    byId("btn-back").addEventListener("click", leaveCall);
    byId("ctl-mic").addEventListener("click", toggleMic);
    byId("ctl-cam").addEventListener("click", toggleCam);
    byId("ctl-share").addEventListener("click", toggleShare);
    byId("ctl-spotify").addEventListener("click", toggleSpotify);
    byId("ctl-sound").addEventListener("click", toggleSoundboard);
    byId("ctl-leave").addEventListener("click", leaveCall);
    byId("ctl-invite").addEventListener("click", participantsModal);
    byId("ctl-settings").addEventListener("click", settingsModal);
  }

  function updateCtl() {
    const c = S.call;
    if (!c) return;
    const mic = byId("ctl-mic");
    const cam = byId("ctl-cam");
    const sh = byId("ctl-share");
    if (mic) {
      mic.classList.toggle("off", !c.mic);
      mic.innerHTML = ic(c.mic ? "mic" : "micOff", 22) + '<span class="ctl-tip">' + (c.mic ? "Mute microphone" : "Unmute microphone") + "</span>";
    }
    if (cam) {
      cam.classList.toggle("off", !c.cam);
      cam.innerHTML = ic(c.cam ? "cam" : "camOff", 22) + '<span class="ctl-tip">' + (c.cam ? "Turn camera off" : "Turn camera on") + "</span>";
    }
    if (sh) {
      sh.classList.toggle("on-accent", !!c.share);
      sh.innerHTML = ic("share", 22) + '<span class="ctl-tip">' + (c.share ? "Stop presenting" : "Present your screen") + "</span>";
    }
    const spBtn = byId("ctl-spotify");
    if (spBtn) spBtn.classList.toggle("on-accent", !!SP.on);
    const sbBtn = byId("ctl-sound");
    if (sbBtn) sbBtn.classList.toggle("on-accent", !!SB.open);
  }

  function hasLiveVideoTrack(stream) {
    if (!stream || typeof stream.getVideoTracks !== "function") return false;
    try {
      return (stream.getVideoTracks() || []).some(t => t && t.readyState !== "ended");
    } catch (e) { return false; }
  }

  function updateStage() {
    const c = S.call;
    if (!c) return;
    const g = guilds()[c.guildId];
    if (!g) return;
    const countEl = byId("call-count");
    if (countEl) countEl.textContent = g.call.length;
    const main = byId("stage-main");
    const strip = byId("stage-strip");
    if (!main) return;
    if (c.display && !hasLiveVideoTrack(c.display)) c.display = null;
    if (c.remoteShare && !hasLiveVideoTrack(c.remoteShare.stream)) c.remoteShare = null;
    const liveShare =
      (c.display && hasLiveVideoTrack(c.display)) ||
      (c.remoteShare && c.remoteShare.stream && hasLiveVideoTrack(c.remoteShare.stream));
    const tiles = g.call.map(id => tileFor(id)).join("");
    if (liveShare) {
      main.classList.remove("music");
      main.classList.add("share");
      main.innerHTML = shareTile();
      strip.hidden = false;
      strip.innerHTML = tiles;
    } else if (SP.on) {
      main.classList.remove("share");
      main.classList.add("music");
      if (!byId("sp-root")) renderMusic();
      updateCarousel();
      updateDock();
      strip.hidden = false;
      strip.innerHTML = tiles;
    } else {
      main.classList.remove("music");
      main.classList.remove("share");
      const html = tiles || '<div class="ok-msg">The call is empty.</div>';
      main.innerHTML = '<div class="tiles" id="tiles">' + html + "</div>";
      strip.hidden = true;
      strip.innerHTML = "";
      const t = byId("tiles");
      const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(g.call.length))));
      t.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";
    }
    refreshTalkVisuals();
    attachMedia();
  }

  function tileFor(id) {
    const c = S.call;
    const u = users()[id];
    if (!u || !c) return "";
    const self = id === S.user.id;
    const roster = (guilds()[c.guildId] || {}).roster || {};
    const r = roster[id] || {};
    const remoteSt = c.remote[id];
    const camOn = self ? c.cam : !!r.cam;
    const micOn = self ? c.mic : !!r.mic;
    const hasVideo = self ? (camOn && c.stream && c.stream.getVideoTracks().length) : (camOn && !!(remoteSt && remoteSt.video));
    const fill =
      '<div class="tile-fill" style="background:linear-gradient(140deg,' + u.color + ', #050506);">' +
        '<div class="tile-avatar" style="background:' + u.color + '">' + esc(initials(u.name)) + "</div></div>";
    let body;
    if (self) {
      body = (hasVideo ? '<video id="vm-self" autoplay playsinline muted></video>' : fill);
    } else {
      body = fill +
        '<audio id="va-' + id + '" autoplay playsinline hidden></audio>' +
        '<video id="vm-' + id + '" autoplay playsinline hidden></video>';
    }
    const talking = !!(talkState[id] && talkState[id].talking);
    return '<div class="tile' + (talking ? " talking speaking" : "") + '" data-user-id="' + id + '"' + (self ? ' id="tile-self"' : ' id="tile-' + id + '"') + '>' +
      body +
      (!self && !camOn ? '<div class="tile-camoff">' + ic("camOff", 15) + "</div>" : "") +
      '<div class="tile-tag"><span class="mic-badge ' + (micOn ? "on" : "off") + '">' + ic(micOn ? "mic" : "micOff", 13) + '</span><span class="tile-name">' + esc(u.name) + (self ? "  (you)" : "") + "</span></div>" +
    "</div>";
  }

  function shareTile() {
    const c = S.call;
    if (!c) return "";
    const me = users()[S.user.id];
    const remotePart = c.remoteShare;
    let label = "Screen";
    let stream = null;
    const pendingId = Object.keys(c.sharePending || {}).find(id => !remotePart || remotePart.id !== id);
    if (c.share) {
      stream = c.display;
      label = (me ? me.name : "You") + " is presenting";
    } else if (remotePart && users()[remotePart.id]) {
      stream = remotePart.stream;
      label = users()[remotePart.id].name + " is presenting";
    } else if (pendingId) {
      const pu = users()[pendingId];
      label = (pu ? pu.name : "Someone") + " is presenting";
    }
    const art =
      '<div class="tile-fill"><div style="text-align:center;color:#c9cdd3;">' +
        '<div class="pres-art"><i></i><i></i><i></i><i></i></div>' +
        '<div style="margin-top:16px;font-weight:800;font-size:18px;color:#fff;">' + esc(label || "Screen share") + '</div>' +
        '<div style="font-size:13px;color:#8b8f97;margin-top:4px;">Waiting for the presentation stream…</div>' +
      "</div></div>";
    return '<div class="tile share-tile pres">' +
      (stream ? '<video id="share-video" autoplay playsinline></video>' : art) +
      '<div class="sharing-badge">' + ic("share", 13) + " LIVE</div>" +
      '<div class="tile-tag"><span class="mic-badge on">' + ic("share", 13) + '</span><span>Screen · ' + esc(label) + "</span></div>" +
    "</div>";
  }

  function attachMedia() {
    const c = S.call;
    if (!c) return;
    const roster = (guilds()[c.guildId] || {}).roster || {};
    const tv = byId("vm-self");
    if (tv && c.stream && c.cam) {
      if (tv.srcObject !== c.stream) tv.srcObject = c.stream;
      playMedia(tv);
      tv.hidden = false;
    } else if (tv) { tv.hidden = true; tv.srcObject = null; }
    Object.keys(c.remote || {}).forEach(uid => {
      const r = c.remote[uid];
      if (!r) return;
      const av = byId("va-" + uid);
      if (av && r.audio) {
        if (av.srcObject !== r.stream) av.srcObject = r.stream;
        playMedia(av);
      }
      const el = byId("vm-" + uid);
      const camOn = roster[uid] ? !!roster[uid].cam : true;
      if (el && r.video && camOn) {
        if (el.srcObject !== r.stream) el.srcObject = r.stream;
        playMedia(el);
        el.hidden = false;
      } else if (el) {
        el.hidden = true;
        el.srcObject = null;
      }
    });
    const sv = byId("share-video");
    const shareStream = c.display || (c.remoteShare ? c.remoteShare.stream : null);
    if (sv && shareStream) {
      if (sv.srcObject !== shareStream) sv.srcObject = shareStream;
      sv.muted = !!c.share;
      playMedia(sv);
      sv.hidden = false;
    } else if (sv) { sv.hidden = true; sv.srcObject = null; }
  }

  function bootMedia() {
    const c = S.call;
    if (!c || c.mediaDone) return;
    c.mediaDone = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !supabaseClient) {
      c.hasMedia = false; c.cam = false; c.mic = false;
      updateCtl(); updateStage();
      toast("Camera/microphone are not available here. You joined with your avatar.", "info");
      getPeer();
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        c.stream = stream;
        c.hasMedia = true;
        stream.getAudioTracks().forEach(t => t.enabled = c.mic);
        updateStage();
        watchTalkLevel(stream, S.user.id, val => { applySelfTalk(c.mic ? val : 0); });
        getPeer();
        tryMesh();
        navigator.mediaDevices.enumerateDevices().then(ds => {
          S.devices.audio = ds.filter(d => d.kind === "audioinput");
          S.devices.video = ds.filter(d => d.kind === "videoinput");
        }).catch(() => {});
      })
      .catch(err => {
        c.hasMedia = false; c.cam = false; c.mic = false;
        updateCtl(); updateStage();
        toast("Could not access camera/microphone (" + (err && err.name ? err.name : "blocked") + "). Joining with your avatar.", "err");
        getPeer();
      });
  }

  function toggleMic() {
    const c = S.call;
    if (!c) return;
    c.mic = !c.mic;
    if (c.stream) c.stream.getAudioTracks().forEach(t => t.enabled = c.mic);
    updateCtl(); updateStage();
    pushPresence();
    toast(c.mic ? "Microphone on" : "Microphone muted", "info");
  }

  async function toggleCam() {
    const cur = S.call;
    if (!cur) return;
    if (cur.cam) {
      cur.cam = false;
      if (cur.stream) cur.stream.getVideoTracks().forEach(t => { t.enabled = false; try { cur.stream.removeTrack(t); t.stop(); } catch (e) {} });
      renegotiateCamOff();
      updateCtl(); updateStage();
      pushPresence();
      toast("Camera off", "info");
      return;
    }
    if (cur.stream && cur.stream.getVideoTracks().length) {
      cur.cam = true;
      cur.stream.getVideoTracks().forEach(t => t.enabled = true);
      renegotiateCamOn();
      updateCtl(); updateStage();
      pushPresence();
      toast("Camera on", "info");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("Camera unavailable here.", "err");
      return;
    }
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      if (cur.stream) vs.getVideoTracks().forEach(t => cur.stream.addTrack(t));
      else cur.stream = vs;
      cur.cam = true;
      renegotiateCamOn();
      updateStage(); updateCtl();
      pushPresence();
      toast("Camera on", "ok");
    } catch (err) {
      toast("Camera access denied.", "err");
    }
  }

  function openPeers() {
    const c = S.call; if (!c) return [];
    const out = [];
    Object.keys(c.peers || {}).forEach(uid => {
      const mc = c.peers[uid];
      if (mc && mc.open && mc.peerConnection) out.push(uid);
    });
    return out;
  }
  function renegotiateCamOn() {
    const c = S.call; if (!c || !c.stream) return;
    const vt = c.stream.getVideoTracks()[0];
    openPeers().forEach(uid => {
      if (!vt) return;
      const mc = c.peers[uid];
      try {
        const sending = mc.peerConnection.getSenders().some(s => s.track === vt);
        if (!sending) mc.peerConnection.addTrack(vt, c.stream);
      } catch (e) { }
    });
    openPeers().forEach(uid => sendRenegotiation(uid));
  }
  function renegotiateCamOff() {
    const c = S.call; if (!c) return;
    openPeers().forEach(uid => {
      const mc = c.peers[uid];
      try {
        mc.peerConnection.getSenders().forEach(s => { if (s.track && s.track.kind === "video") mc.peerConnection.removeTrack(s); });
      } catch (e) { }
    });
    openPeers().forEach(uid => sendRenegotiation(uid));
  }
  function sendRenegotiation(uid) {
    const c = S.call; if (!c) return;
    const mc = c.peers[uid];
    if (!mc || !mc.peerConnection || mc.peerConnection.signalingState !== "stable") return;
    const pc = mc.peerConnection;
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        const ch = getChannel(c.guildId);
        if (!ch) return;
        try { ch.send({ type: "broadcast", event: "wreg", payload: { from: S.user.id, to: uid, sdp: pc.localDescription || null } }); } catch (e) {}
      })
      .catch(e => console.warn("cam renegotiation offer failed", uid, e));
  }
  function onRenegotiation(p) {
    p = broadcastPayload(p);
    const c = S.call;
    if (!p || !p.sdp || !p.sdp.type || !c) return;
    if (p.from && p.from === S.user.id) return;
    if (p.to && p.to !== S.user.id) return;
    const uid = p.from;
    const mc = c.peers[uid];
    if (!mc || !mc.peerConnection) return;
    const pc = mc.peerConnection;
    const handle = () => syncRemoteFromMC(uid);
    if (p.sdp.type === "offer") {
      pc.setRemoteDescription(p.sdp)
        .then(() => pc.createAnswer())
        .then(a => pc.setLocalDescription(a))
        .then(() => {
          const ch = getChannel(c.guildId);
          if (ch) { try { ch.send({ type: "broadcast", event: "wreg", payload: { from: S.user.id, to: uid, sdp: pc.localDescription || null } }); } catch (e) {} }
        })
        .then(handle)
        .catch(e => console.warn("cam renegotiation answer failed", uid, e));
    } else {
      pc.setRemoteDescription(p.sdp).then(handle).catch(e => console.warn("cam renegotiation apply failed", uid, e));
    }
  }
  function syncRemoteFromMC(uid) {
    const c = S.call;
    if (!c) return;
    const mc = c.peers[uid], r = c.remote[uid];
    if (!mc || !mc.peerConnection || !r) return;
    let hasVideo = false, hasAudio = false;
    try {
      mc.peerConnection.getReceivers().forEach(x => {
        if (!x.track) return;
        if (x.track.kind === "video" && x.track.readyState !== "ended") {
          hasVideo = true;
          if (!r.stream.getVideoTracks().includes(x.track)) r.stream.addTrack(x.track);
        } else if (x.track.kind === "audio" && x.track.readyState !== "ended") {
          hasAudio = true;
          if (!r.stream.getAudioTracks().includes(x.track)) r.stream.addTrack(x.track);
        }
      });
      r.stream.getTracks().forEach(t => { if (t.readyState === "ended") { try { r.stream.removeTrack(t); } catch (e) {} } });
    } catch (e) {}
    const changed = r.video !== hasVideo || r.audio !== hasAudio;
    r.video = hasVideo; r.audio = hasAudio;
    if (changed) {
      if (byId("call-view") && tileEl(uid)) updateTileFor(uid);
      else attachMedia();
    } else {
      attachMedia();
    }
  }

  async function toggleShare() {
    const c = S.call;
    if (!c) return;
    if (c.share) { stopShare(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return toast("Screen share is not supported in this browser.", "err");
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      c.display = s; c.share = true;
      const vt = s.getVideoTracks()[0];
      if (vt) vt.addEventListener("ended", () => stopShare(true));
      const at = s.getAudioTracks()[0];
      if (at) at.addEventListener("ended", () => stopShare(true));
      const dialed = startShareRemote(s);
      pushPresence();
      updateStage(); updateCtl();
      c.shareWaiting = dialed === 0;
      toast(dialed ? "You are sharing your screen." : "Screen share is live for you — waiting for the other participants to connect.", dialed ? "ok" : "info");
    } catch (err) {}
  }

  function stopShare(auto) {
    const c = S.call;
    if (!c || !c.share) return;
    if (c.display) c.display.getTracks().forEach(t => t.stop());
    c.display = null; c.share = false;
    c.shareWaiting = false;
    Object.keys(c.shareMc || {}).forEach(k => { try { c.shareMc[k].close(); } catch (e) {} });
    c.shareMc = {};
    updateStage(); updateCtl();
    pushPresence();
    toast(auto ? "Screen share ended." : "You stopped sharing.", "info");
  }

  const _watch = {};
  const talkCtxs = new Set();
  const talkState = {};
  const talkSent = { state: false, at: 0, level: 0 };
  const tileEl = uid => document.querySelector('.tile[data-user-id="' + uid + '"]') || byId(uid === S.user.id ? "tile-self" : "tile-" + uid);
  function resumeTalkContexts() {
    talkCtxs.forEach(ctx => { try { if (ctx.state === "suspended") ctx.resume(); } catch (e) {} });
  }
  function setTalkVisual(uid, talking, int) {
    const el = tileEl(uid);
    if (!el) return;
    el.classList.toggle("talking", !!talking);
    el.classList.toggle("speaking", !!talking);
    const av = $(".tile-avatar", el);
    if (av) av.style.setProperty("--talk-int", String(Math.max(0, Math.min(1, int || 0))));
  }
  function refreshTalkVisuals() {
    Object.keys(talkState).forEach(uid => {
      const t = talkState[uid];
      if (t) setTalkVisual(uid, t.talking, t.int);
    });
  }
  function clearTalkState(uid) {
    if (uid) { delete talkState[uid]; setTalkVisual(uid, false, 0); return; }
    Object.keys(talkState).forEach(k => { delete talkState[k]; setTalkVisual(k, false, 0); });
  }
  function broadcastTalk(level) {
    const c = S.call;
    if (!c || !S.user || !supabaseClient) return;
    const talking = level > 0.3;
    const now = Date.now();
    if (talking === talkSent.state) {
      if (!talking) return;
      if (now - talkSent.at < 120) return;
      if (Math.abs(level - talkSent.level) < 0.04 && now - talkSent.at < 500) return;
    }
    talkSent.state = talking; talkSent.at = now; talkSent.level = level;
    const ch = getChannel(c.guildId);
    if (!ch) return;
    try {
      ch.send({ type: "broadcast", event: "talk", payload: { from: S.user.id, talking: talking, level: Math.max(0, Math.min(1, level)) } });
    } catch (e) {}
  }
  function onTalkBroadcast(p) {
    p = broadcastPayload(p);
    if (!S.call || !p || !p.from || p.from === S.user.id) return;
    const talking = !!p.talking;
    const lvl = typeof p.level === "number" ? Math.max(0, Math.min(1, p.level)) : (talking ? 1 : 0);
    talkState[p.from] = { talking: talking, int: lvl, at: Date.now() };
    setTalkVisual(p.from, talking, lvl);
  }
  function playMedia(el) {
    if (!el || !el.play) return;
    el.play().catch(() => {});
  }
  function watchTalkLevel(src, uid, onLevel) {
    unwatchTalkLevel(uid);
    const c = S.call;
    if (!c || !src) return;
    let ctx = null, analyser = null;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      ctx.createMediaStreamSource(src).connect(analyser);
    } catch (e) { return; }
    const resume = () => { if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} } };
    talkCtxs.add(ctx);
    resume();
    resumeTalkContexts();
    const buf = new Float32Array(analyser.fftSize);
    let smooth = 0;
    const watcher = { ctx, analyser, talking: false, int: 0, resume };
    _watch[uid] = watcher;
    const tick = () => {
      if (!S.call || !_watch[uid]) { unwatchTalkLevel(uid); return; }
      try { analyser.getFloatTimeDomainData(buf); } catch (e) { unwatchTalkLevel(uid); return; }
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      smooth = smooth * 0.7 + rms * 0.3;
      watcher.talking = smooth > 0.045;
      watcher.int = watcher.talking ? Math.min(1, (smooth - 0.045) * 30) : 0;
      if (typeof onLevel === "function") {
        onLevel(watcher.int);
      } else {
        const t = talkState[uid];
        if (!t || Date.now() - t.at > 1500) setTalkVisual(uid, watcher.talking, watcher.int);
      }
      watcher.raf = requestAnimationFrame(tick);
    };
    watcher.raf = requestAnimationFrame(tick);
  }
  function unwatchTalkLevel(uid) {
    const w = _watch[uid];
    if (!w) return;
    if (w.raf) cancelAnimationFrame(w.raf);
    if (w.ctx) { talkCtxs.delete(w.ctx); try { w.ctx.close(); } catch (e) {} }
    delete _watch[uid];
    setTalkVisual(uid, false, 0);
  }
  function applySelfTalk(int) {
    const talking = int > 0.3;
    talkState[S.user.id] = { talking: talking, int: int, at: Date.now() };
    setTalkVisual(S.user.id, talking, int);
    broadcastTalk(int);
  }

  /* ======================= SOUND BOARD ======================= */
  let SB = { open: false, vol: 0.8 };
  const _sbAudio = [];
  const SB_EMOJIS = ["🔊", "😂", "😎", "🚨", "💥", "🐷", "🎉", "😲", "👤", "🐕", "🔥", "🪄", "🤖", "💨", "🎯", "🍿", "💀", "😱"];
  const sbList = () => (S.call && DB.soundboards) ? (DB.soundboards[S.call.guildId] || []) : [];
  function sbAllInCall() { return sbList(); }
  function sbPlay(audioUrl) {
    try {
      const a = new Audio(audioUrl);
      a.volume = SB.vol;
      a.play().catch(() => {});
      _sbAudio.push(a);
      a.addEventListener("ended", () => { const i = _sbAudio.indexOf(a); if (i !== -1) _sbAudio.splice(i, 1); });
      return a;
    } catch (e) { return null; }
  }
  function sbStopAllLocal() { _sbAudio.forEach(a => { try { a.pause(); a.src = ""; } catch (e) {} }); _sbAudio.length = 0; }
  const soundWait = {};
  function sbBroadcast(s) {
    if (!S.call || !s || !supabaseClient) return;
    const rtc = playSoundboardToCall(s.dataUrl);
    const ch = getChannel(S.call.guildId);
    if (ch) {
      try { ch.send({ type: "broadcast", event: "sb_play", payload: { id: s.id, name: s.name, emoji: s.emoji, dataUrl: s.dataUrl, player: S.user.id, rtc: !!rtc } }); } catch (e) {}
    }
    const me = users()[S.user.id];
    toast((s.emoji || "🔊") + " " + s.name + " — played by " + (me ? me.name : "someone"), "info");
  }
  function onSbPlay(p) {
    p = broadcastPayload(p);
    if (!S.call || !p) return;
    if (p.player && p.player === S.user.id) return;
    if (p.rtc && p.dataUrl) {
      if (soundWait[p.player]) clearTimeout(soundWait[p.player]);
      soundWait[p.player] = setTimeout(() => {
        delete soundWait[p.player];
        sbPlay(p.dataUrl);
      }, 900);
    } else {
      sbPlay(p.dataUrl);
    }
    const nm = displayName(p.player, null);
    toast((p.emoji || "🔊") + " " + (p.name || "sound") + " — played by " + (nm || "someone"), "info");
  }

  function playSoundboardToCall(audioUrl) {
    const c = S.call;
    if (!c || !audioUrl || !peerOpen || !peer) { sbPlay(audioUrl); return false; }
    try {
      const audio = new Audio(audioUrl);
      audio.crossOrigin = "anonymous";
      audio.volume = SB.vol;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaElementSource(audio);
      const speakers = ctx.createGain();
      const destination = ctx.createMediaStreamDestination();
      source.connect(speakers);
      speakers.connect(ctx.destination);
      source.connect(destination);
      const item = { audio, ctx };
      c.soundLocal.push(item);
      const finish = () => {
        const i = c.soundLocal.indexOf(item);
        if (i !== -1) c.soundLocal.splice(i, 1);
        try { audio.pause(); audio.src = ""; } catch (e) {}
        try { ctx.close(); } catch (e) {}
        c.soundMc = (c.soundMc || []).filter(mc => calls.indexOf(mc) === -1);
        calls.splice(0).forEach(mc => { try { mc.close(); } catch (e) {} });
      };
      audio.addEventListener("ended", finish, { once: true });
      const calls = [];
      const roster = (guilds()[c.guildId] || {}).call || [];
      roster.forEach(uid => {
        if (uid === S.user.id) return;
        try {
          const mc = peer.call(uid, destination.stream, { metadata: { kind: "sound" } });
          calls.push(mc);
          mc.on("close", () => { const i = calls.indexOf(mc); if (i !== -1) calls.splice(i, 1); });
          mc.on("error", () => { try { mc.close(); } catch (e) {} });
        } catch (e) {}
      });
      c.soundMc.push(...calls);
      if (ctx.state === "suspended") { try { const pr = ctx.resume(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {} }
      audio.play().catch(() => {});
      return calls.length > 0;
    } catch (e) {
      sbPlay(audioUrl);
      return false;
    }
  }
  function onSoundboardRealtime(payload) {
    if (!S.call) return;
    const gid = S.call.guildId;
    const e = payload && payload.eventType;
    try {
      const rows = (DB.soundboards[gid] || []);
      if (e === "INSERT") {
        const r = payload.new;
        if (r && !rows.some(x => x.id === r.id)) rows.push({ id: r.id, addedBy: r.user_id, name: r.name, emoji: r.emoji, dataUrl: r.data_url, at: Date.parse(r.created_at) || 0 });
      } else if (e === "DELETE") {
        const id = payload.old ? payload.old.id : null;
        DB.soundboards[gid] = rows.filter(x => x.id !== id);
      }
    } catch (err) {}
    renderSoundboard();
  }
  function toggleSoundboard() {
    if (!S.call) return;
    SB.open = !SB.open;
    updateCtl();
    renderSoundboard();
  }
  function renderSoundboard() {
    const panel = byId("sb-panel");
    if (!panel) return;
    if (!SB.open) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
    panel.classList.remove("hidden");
    panel.innerHTML = soundboardHTML();
    wireSoundboard();
  }
  function soundboardHTML() {
    const rows = sbAllInCall();
    const me = users()[S.user.id];
    const list = rows.length ? rows.map(s => {
      const owner = users()[s.addedBy];
      const mine = s.addedBy === S.user.id;
      return '<div class="sb-row">' +
        '<span class="sb-emoji">' + esc(s.emoji || "🔊") + "</span>" +
        '<span class="sb-info"><span class="sb-name">' + esc(s.name) + '</span>' +
        '<span class="sb-by">by ' + esc(owner ? owner.name : "someone") + "</span></span>" +
        '<button class="sb-act" data-play="' + s.id + '" title="Play to the call">' + ic("sound", 15) + "</button>" +
        '<button class="sb-act" data-self="' + s.id + '" title="Preview for you">' + ic("headphone", 15) + "</button>" +
        (mine ? '<button class="sb-act sb-del" data-del="' + s.id + '" title="Remove">' + ic("trash", 15) + "</button>" : "") +
      "</div>";
    }).join("") : '<div class="sb-empty">No sounds in this call yet.<br><b>+ Add</b> one to share it with everyone.</div>';
    return (
      '<div class="sb-head">' +
        '<span class="sb-title">Sound Board' + (me ? ' <span class="sb-sub">' + esc(me.name) + "</span>" : "") + '</span>' +
        '<div class="sb-head-acts">' +
          '<button class="sb-add" id="sb-add">' + ic("plus", 13) + " Add</button>" +
          '<button class="sb-x" id="sb-x">' + ic("x", 15) + "</button>" +
        "</div>" +
      "</div>" +
      '<div class="sb-vol"><span>' + ic("volume", 14) + "</span>" +
        '<input id="sb-vol" type="range" min="0" max="1" step="0.02" value="' + SB.vol + '">' +
        '<span class="sb-vol-v" id="sb-vol-v">' + Math.round(SB.vol * 100) + "%</span>" +
      "</div>" +
      '<div class="sb-list">' + list + "</div>"
    );
  }
  function wireSoundboard() {
    const panel = byId("sb-panel");
    if (!panel) return;
    const find = id => sbAllInCall().find(s => s.id === id);
    byId("sb-x").addEventListener("click", toggleSoundboard);
    byId("sb-add").addEventListener("click", addSoundModal);
    byId("sb-vol").addEventListener("input", e => {
      SB.vol = parseFloat(e.target.value) || 0.8;
      const v = byId("sb-vol-v");
      if (v) v.textContent = Math.round(SB.vol * 100) + "%";
    });
    $$("[data-play]", panel).forEach(b => b.addEventListener("click", () => { const s = find(b.dataset.play); if (s) sbBroadcast(s); }));
    $$("[data-self]", panel).forEach(b => b.addEventListener("click", () => { const s = find(b.dataset.self); if (s) sbPlay(s.dataUrl); }));
    $$("[data-del]", panel).forEach(b => b.addEventListener("click", () => { const s = find(b.dataset.del); if (s) sbDelete(s); }));
  }
  function sbDelete(s) {
    if (!s || s.addedBy !== S.user.id || !supabaseClient) return;
    supabaseClient.from("soundboard").delete().eq("id", s.id).eq("server_id", s.server_id || S.call.guildId)
      .then(() => {
        DB.soundboards[S.call.guildId] = (DB.soundboards[S.call.guildId] || []).filter(x => x.id !== s.id);
        renderSoundboard();
        toast("Removed " + s.name + ".", "info");
      })
      .catch(err => toast("Could not delete sound: " + err.message, "err"));
  }
  function addSoundModal() {
    showModal(
      '<div class="modal" style="width:460px;">' +
        '<div class="modal-head"><h3>' + ic("sound", 17) + " Add a sound</h3><button class=\"modal-x\" data-close>" + ic("x", 16) + "</button></div>" +
        '<div class="modal-body">' +
          '<div class="field"><label>Sound file</label><input type="file" id="sb-file" accept="audio/wav,audio/x-wav,audio/mp3,audio/mpeg,audio/ogg,audio/oga,audio/webm,audio/mp4,audio/x-m4a,audio/aac,audio/flac">' +
            '<div class="hint">MP3 / WAV / OGG. Keep it under ~1MB — sounds are stored in your server.</div></div>' +
          '<div class="field"><label>Name</label><input id="sb-name" type="text" maxlength="32" placeholder="e.g. Airhorn" autocomplete="off"></div>' +
          '<div class="field"><label>Emoji</label><input id="sb-emoji" type="text" maxlength="8" placeholder="🔊" autocomplete="off">' +
            '<div class="swatch-row" style="margin-top:8px;">' + SB_EMOJIS.map(e => '<span class="sb-emoji-pick" data-e="' + e + '">' + e + "</span>").join("") + "</div></div>" +
        "</div>" +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sb-save" style="width:auto;">Add sound</button></div>' +
      "</div>"
    );
    $$(".sb-emoji-pick").forEach(b => b.addEventListener("click", () => { const t = byId("sb-emoji"); if (t) t.value = b.dataset.e; }));
    byId("sb-save").addEventListener("click", () => {
      const file = byId("sb-file").files && byId("sb-file").files[0];
      if (!file) return toast("Pick an audio file first.", "err");
      if (file.size > 1024 * 1024) return toast("Audio is larger than 1MB — pick a smaller file.", "err");
      const name = (byId("sb-name").value || "").trim();
      if (!name) return toast("Give the sound a name.", "err");
      const emoji = (byId("sb-emoji").value || "🔊").trim() || "🔊";
      const r = new FileReader();
      r.onload = () => {
        supabaseClient.from("soundboard").insert({
          server_id: S.call.guildId, user_id: S.user.id, name, emoji, data_url: r.result,
          created_at: new Date().toISOString()
        }).then(({ error }) => {
          closeModal();
          if (error) return toast("Upload failed: " + error.message, "err");
          toast(emoji + " " + name + " added to the server sound board.", "ok");
          renderSoundboard();
        });
      };
      r.readAsDataURL(file);
    });
  }

  function startCallTimer() {
    if (callTimerI) clearInterval(callTimerI);
    callTimerI = setInterval(() => {
      const el = byId("call-timer");
      if (el && S.call) el.textContent = fmtDur(Date.now() - S.call.joinAt);
    }, 1000);
  }

  /* ======================= modals ======================= */
  function createServerModal() {
    let tab = "create";
    const render = () => {
      const body = tab === "create"
        ? '<div class="field"><label>Server name (optional)</label><input id="cs-name" type="text" maxlength="28" placeholder="Leave empty for a random name" autocomplete="off">' +
          '<div class="hint">Empty → assigned a random name like "' + randServerName() + '". Rename any time in Settings.</div></div>' +
          '<button class="btn btn-green" id="cs-go" style="width:100%;">' + ic("plus", 17) + " Create server</button>"
        : '<div class="field"><label>Invite code</label><input id="cs-code" type="text" maxlength="8" placeholder="e.g. K4LQ2P" autocomplete="off" style="text-transform:uppercase;">' +
          '<div class="hint">Server owners share a 6-character code so you can join their environment.</div></div>' +
          '<button class="btn btn-green" id="cs-go" style="width:100%;">' + ic("key", 17) + " Join server</button>";
      showModal(
        '<div class="modal" style="width:440px;">' +
          '<div class="modal-head"><div style="display:flex;align-items:center;gap:9px;">' + ic("home", 17) + "<div><div style=\"font-weight:800;\">Add a server</div><div style=\"font-size:12px;color:var(--tx-3);\">Create a new environment or join one with a code.</div></div></div>" +
          '<button class="modal-x" data-close>' + ic("x", 18) + "</button></div>" +
          '<div class="modal-body">' +
            '<div class="tabs-inline"><button class="tab-inline ' + (tab === "create" ? "active" : "") + '" data-tab="create">Create</button><button class="tab-inline ' + (tab === "join" ? "active" : "") + '" data-tab="join">Join</button></div>' +
            '<div id="cs-body">' + body + "</div>" +
          "</div></div>"
      );
      wire();
    };
    const wire = () => {
      $$("[data-tab]", byId("modal-back")).forEach(t => t.addEventListener("click", () => { tab = t.dataset.tab; render(); }));
      const go = byId("cs-go");
      const nameIn = byId("cs-name");
      const codeIn = byId("cs-code");
      go.addEventListener("click", () => {
        if (tab === "create") {
          const name = (nameIn.value || "").trim();
          const g = createGuild(name || null);
          S.activeGuildId = g.id; S.activeChannel = "voice";
          closeModal(); goHome();
          toast('Created "' + g.name + '" · invite code ' + g.invite + ".", "ok");
        } else {
          joinGuildByCode(codeIn.value);
        }
      });
      const inp = tab === "create" ? nameIn : codeIn;
      if (inp) inp.addEventListener("keydown", e => { if (e.key === "Enter") go.click(); });
    };
    render();
  }

  function confirmDeleteModal() {
    const g = guild();
    if (!g) return;
    let armed = false;
    showModal(
      '<div class="modal" style="width:430px;">' +
        '<div class="modal-head"><h3>Delete server</h3><button class="modal-x" data-close>' + ic("x", 18) + "</button></div>" +
        '<div class="modal-body">' +
          '<p class="ill-hint">Are you sure you want to delete <b style="color:var(--tx);">' + esc(g.name) + "</b>? This removes it for every member on this device.</p>" +
        "</div>" +
        '<div class="modal-foot"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-danger-soft" id="dd-go-inner">' + ic("trash", 15) + " Delete server</button></div>" +
      "</div>"
    );
    const btn = byId("dd-go-inner");
    btn.addEventListener("click", () => {
      if (!armed) { armed = true; btn.textContent = "Click again to confirm"; }
      else deleteGuild(g.id);
    });
  }

  function copyPill(label, value) {
    return '<div class="field"><label>' + label + "</label>" +
      '<div class="code-pill"><code>' + esc(value) + "</code>" +
      '<button class="ir-action gray btn-sm" data-copy="' + esc(value) + '">' + ic("copy", 13) + " Copy</button></div></div>";
  }

  function settingsModal() {
    const g = guild();
    const p = prefs();
    const isOwner = !!(g && g.owner === S.user.id);
    let tab = "server";
    const renderSection = bodyId => {
      let html = "";
      if (tab === "server") {
        html += (g ? copyPill("Invite code", g.invite) : "");
        html += '<div class="field"><label>Server name</label>' +
          '<div style="display:flex;gap:8px;"><input id="srv-name" type="text" maxlength="28" value="' + esc(g ? g.name : "") + '" ' + (isOwner ? "" : "disabled") + ">" +
          '<button class="btn btn-ghost btn-sm" id="srv-save" ' + (isOwner ? "" : "disabled") + ">Save</button></div>" +
          '<div class="hint">' + (isOwner ? "You own this server — rename it any time." : "Only the owner of the server can rename it.") + "</div></div>";
        if (isOwner) {
          html += '<div class="setting-row"><div><div class="s-title">Danger zone</div><div class="s-desc">Deleting removes the server and its call for everyone.</div></div>' +
            '<button class="btn btn-danger-soft btn-sm" id="srv-del">' + ic("trash", 14) + " Delete server</button></div>";
        }
      } else if (tab === "account") {
        html += '<div class="field"><label>Display name</label>' +
          '<div style="display:flex;gap:8px;"><input id="acc-name" type="text" maxlength="24" value="' + esc(S.user.name) + '">' +
          '<button class="btn btn-ghost btn-sm" id="acc-save">Save</button></div></div>';
        html += '<div class="field"><label>Avatar color</label><div class="swatch-row" id="acc-colors">' + swatchesHTML(S.user.color) + "</div></div>";
        html += '<div class="setting-row"><div><div class="s-title">Session</div><div class="s-desc">Sign out returns to the login screen.</div></div>' +
          '<button class="btn btn-ghost btn-sm" id="acc-out">' + ic("leave", 14) + " Sign out</button></div>";
      } else if (tab === "devices") {
        const mkOpts = (list, sel) => list.length
          ? list.map((d, i) => '<option value="' + esc(d.deviceId) + '" ' + (d.deviceId === sel ? "selected" : "") + ">" + esc(d.label || ("Device " + (i + 1))) + "</option>").join("")
          : '<option value="">No devices detected</option>';
        html += '<div class="field"><label>Microphone</label><select id="dev-mic">' + mkOpts(S.devices.audio, p.micId) + "</select>" +
          '<div class="hint">Applied the next time you join a call.</div></div>';
        html += '<div class="field"><label>Camera</label><select id="dev-cam">' + mkOpts(S.devices.video, p.camId) + "</select></div>";
        if (!S.devices.audio.length && !S.devices.video.length) {
          html += '<p class="ill-hint">Device names appear after you grant camera/microphone access in a call.</p>';
        }
      } else if (tab === "prefs") {
        html += '<div class="setting-row"><div><div class="s-title">Auto-mute on join</div><div class="s-desc">Start every call with your mic switched off.</div></div>' +
          '<label class="switch"><input type="checkbox" data-pref="autoMute" ' + (p.autoMute ? "checked" : "") + '><span class="slider"></span></label></div>';
        html += '<div class="setting-row"><div><div class="s-title">Join chime</div><div class="s-desc">Play a soft sound when you join or leave a call.</div></div>' +
          '<label class="switch"><input type="checkbox" data-pref="sounds" ' + (p.sounds ? "checked" : "") + '><span class="slider"></span></label></div>';
      }
      byId(bodyId).innerHTML = html;
      wireSettingsBody(tab, isOwner, g);
    };
    showModal(
      '<div class="modal">' +
        '<div class="modal-head"><div style="display:flex;align-items:center;gap:9px;">' + ic("gear", 17) + "<div><div style=\"font-weight:800;\">Settings</div><div style=\"font-size:12px;color:var(--tx-3);\">" + esc(S.user.name) + (g ? " · " + esc(g.name) : "") + "</div></div></div>" +
        '<button class="modal-x" data-close>' + ic("x", 18) + "</button></div>" +
        '<div class="modal-body">' +
          '<div class="tabs-inline">' +
            '<button class="tab-inline active" data-set="server">Server</button>' +
            '<button class="tab-inline" data-set="account">Account</button>' +
            '<button class="tab-inline" data-set="devices">Devices</button>' +
            '<button class="tab-inline" data-set="prefs">Preferences</button>' +
          "</div>" +
          '<div id="set-body"></div>' +
        "</div></div>"
    );
    renderSection("set-body");
    $$("[data-set]").forEach(t => t.addEventListener("click", () => {
      tab = t.dataset.set;
      $$("[data-set]").forEach(x => x.classList.toggle("active", x === t));
      renderSection("set-body");
    }));
    $$("[data-copy]").forEach(b => b.addEventListener("click", async () => {
      const ok = await copyText(b.dataset.copy);
      toast(ok ? "Invite code copied." : "Could not copy.", ok ? "ok" : "err");
    }));
  }

  function wireSettingsBody(tab, isOwner, g) {
    const srvName = byId("srv-name"), srvSave = byId("srv-save");
    if (srvSave && isOwner) {
      srvSave.addEventListener("click", async () => {
        const name = (srvName.value || "").trim();
        if (!name) return toast("Server name cannot be empty.", "err");
        if (supabaseClient) {
          const { error } = await supabaseClient.from("servers").update({ name }).eq("id", g.id).eq("owner_id", S.user.id);
          if (error) return toast("Rename failed: " + error.message, "err");
        }
        g.name = name;
        toast("Server renamed to " + name + ".", "ok");
        closeModal(); goHome();
      });
    }
    const srvDel = byId("srv-del");
    if (srvDel) srvDel.addEventListener("click", () => { closeModal(); confirmDeleteModal(); });

    const accSave = byId("acc-save");
    if (accSave) {
      let chosen = S.user.color;
      $$(".swatch", byId("acc-colors")).forEach(s => s.addEventListener("click", () => {
        chosen = s.dataset.color;
        $$(".swatch", byId("acc-colors")).forEach(x => x.classList.toggle("selected", x === s));
      }));
      accSave.addEventListener("click", async () => {
        const name = (byId("acc-name").value || "").trim();
        if (name.length < 2) return toast("Display name needs 2+ characters.", "err");
        S.user = { id: S.user.id, name, color: chosen };
        DB.profiles[S.user.id] = { id: S.user.id, name, color: chosen };
        if (supabaseClient) {
          supabaseClient.auth.updateUser({ data: { display_name: name, color: chosen } }).then(() => {}).catch(() => {});
          pushPresence();
        }
        toast("Account updated.", "ok");
        closeModal(); goHome();
      });
    }
    const accOut = byId("acc-out");
    if (accOut) accOut.addEventListener("click", () => { closeModal(); signOut(); });

    $$("#dev-mic").forEach(s => s.addEventListener("change", () => { const p = prefs(); p.micId = s.value; savePrefs(p); }));
    $$("#dev-cam").forEach(s => s.addEventListener("change", () => { const p = prefs(); p.camId = s.value; savePrefs(p); }));

    $$("[data-pref]").forEach(cb => cb.addEventListener("change", () => {
      const p = prefs();
      p[cb.dataset.pref] = cb.checked;
      savePrefs(p);
      toast(cb.checked ? "Preference enabled." : "Preference disabled.", "info");
    }));
  }

  function participantsModal() {
    const g = guild();
    if (!g) return;
    const renderBody = () => {
      const g2 = guilds()[g.id];
      const rows = g2.members.map(id => {
        const u = users()[id];
        if (!u) return "";
        const inCall = g2.call.includes(id);
        const self = id === S.user.id;
        const action = self ? '<span class="ir-action first">You</span>'
          : inCall ? '<button class="ir-action danger" data-act="dis" data-id="' + id + '">' + ic("x", 13) + " Disconnect</button>"
          : '<button class="ir-action add" data-act="inv" data-id="' + id + '">' + ic("userPlus", 13) + " Invite to call</button>";
        return '<div class="invite-row">' +
          '<div class="avatar" style="width:38px;height:38px;background:' + u.color + '">' + esc(initials(u.name)) + "</div>" +
          '<div class="ir-info"><div class="ir-name">' + esc(u.name) + (self ? ' <span style="color:var(--tx-3);font-weight:600;font-size:12px;">(you)</span>' : "") + "</div>" +
          '<div class="ir-status">' + (inCall ? ic("headphone", 11) + ' <span style="color:var(--green);">In the call</span>' : "In the server · online") + "</div></div>" +
          '<div class="ir-actions">' + action + "</div></div>";
      }).join("");
      byId("iv-rows").innerHTML = rows || '<p class="ill-hint">This server has no other members.</p>';
      $$("[data-act]").forEach(b => b.addEventListener("click", () => {
        const id = b.dataset.id;
        const ch = supabaseClient ? getChannel(g.id) : null;
        if (b.dataset.act === "inv") {
          if (ch) {
            try { ch.send({ type: "broadcast", event: "invite", payload: { guildId: g.id, from: S.user.id } }); } catch (e) {}
          }
          const tgt = users()[id];
          toast((tgt ? tgt.name : "They") + " were invited to the call.", "ok");
        } else {
          if (ch) {
            try { ch.send({ type: "broadcast", event: "kick", payload: { guildId: g.id, userId: id, by: S.user.id } }); } catch (e) {}
          }
          const tgt = users()[id];
          toast((tgt ? tgt.name : "They") + " were disconnected.", "info");
        }
        if (S.call && S.call.guildId === g.id) { updateStage(); updateCtl(); }
        renderBody();
      }));
    };
    showModal(
      '<div class="modal">' +
        '<div class="modal-head"><div style="display:flex;align-items:center;gap:9px;">' + ic("userPlus", 17) + "<div><div style=\"font-weight:800;\">Add participants</div><div style=\"font-size:12px;color:var(--tx-3);\">" + esc(g.name) + " · " + g.call.length + " in the call</div></div></div>" +
        '<button class="modal-x" data-close>' + ic("x", 18) + "</button></div>" +
        '<div class="modal-body">' +
          '<div class="code-pill" style="margin-bottom:14px;">Invite code&nbsp;<code>' + esc(g.invite) + "</code>" +
          '<button class="ir-action gray btn-sm" data-copy="' + esc(g.invite) + '">' + ic("copy", 13) + "</button></div>" +
          '<div id="iv-rows"></div>' +
        "</div></div>"
    );
    $$("[data-copy]").forEach(b => b.addEventListener("click", async () => {
      const ok = await copyText(b.dataset.copy);
      toast(ok ? "Invite code copied." : "Could not copy.", ok ? "ok" : "err");
    }));
    renderBody();
  }

  /* ======================= MUSIC / COLLAB MODE ======================= */
  const TRACK_INDEX = {};
  let SP = {
    on: false, hostId: null, restrict: false,
    queue: [], index: 0, playing: false, pos: 0, dur: 200000, volume: 0.8,
    openPanel: null, tickI: null, panelTab: "queue"
  };
  let _ambT = null;

  const INVIDIOUS_INSTANCES = [
    "https://inv.tux.pizza",
    "https://invidious.nerdvpn.de",
    "https://invidious.privacydev.net",
    "https://iv.melmac.space",
    "https://invidious.fdn.fr"
  ];
  const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.reallyaweso.me",
    "https://api.piped.private.coffee"
  ];

  const RESOLVER_CACHE_KEY = "hc_resolver_down_until";
  const RESOLVER_COOLDOWN_MS = 30 * 60 * 1000;

  function isResolverKnownDown() {
    try {
      const until = parseInt(localStorage.getItem(RESOLVER_CACHE_KEY) || "0", 10);
      return Date.now() < until;
    } catch (e) { return false; }
  }
  function markResolverDown() {
    try { localStorage.setItem(RESOLVER_CACHE_KEY, String(Date.now() + RESOLVER_COOLDOWN_MS)); } catch (e) {}
  }
  function markResolverUp() {
    try { localStorage.removeItem(RESOLVER_CACHE_KEY); } catch (e) {}
  }

  function browserSupports(mime) {
    try {
      const probe = typeof Audio !== "undefined" ? new Audio() : null;
      if (!probe || typeof probe.canPlayType !== "function") return true;
      return !!probe.canPlayType(mime);
    } catch (e) { return true; }
  }

  async function resolveInvidiousCandidates(ytId, timeoutMs) {
    const TIMEOUT = timeoutMs || 8000;
    const wantMp4 = browserSupports("audio/mp4");
    const wantWebm = browserSupports("audio/webm");
    const out = [];
    const pushUrl = (u) => { if (u && out.indexOf(u) === -1) out.push(u); };
    const fetchJson = async (url, ms) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), ms || TIMEOUT);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!res.ok) return null;
        return await res.json();
      } catch (_) {
        return null;
      } finally { clearTimeout(tid); }
    };

    for (const base of INVIDIOUS_INSTANCES) {
      const data = await fetchJson(base + "/api/v1/videos/" + ytId + "?fields=adaptiveFormats,formatStreams");
      if (!data) continue;
      const itags = [];
      if (wantMp4) itags.push("140", "139");
      if (wantWebm) itags.push("251");
      if (!itags.length) itags.push("140");
      itags.forEach(ig => pushUrl(base + "/latest_version?id=" + ytId + "&itag=" + ig));

      const items = [];
      (data.adaptiveFormats || [])
        .filter(f => f.url && f.type && String(f.type).indexOf("audio/") === 0)
        .forEach(f => items.push({ url: f.url, bitrate: f.bitrate || 0, mime: (String(f.type).split(";")[0] || "").toLowerCase() }));
      (data.formatStreams || [])
        .filter(f => f.url)
        .forEach(f => items.push({ url: f.url, bitrate: f.bitrate || 0, mime: (String(f.type).split(";")[0] || "").toLowerCase() }));

      const scored = items.map(it => {
        let score = it.bitrate || 0;
        if (it.mime.indexOf("webm") !== -1) score = wantWebm ? score : -1;
        else if (it.mime.indexOf("mp4") !== -1 || it.mime.indexOf("aac") !== -1 || it.mime.indexOf("m4a") !== -1) score = wantMp4 ? score + 1000000 : -1;
        else score += 500000;
        return { url: it.url, score };
      }).filter(s => s.score >= 0).sort((a, b) => b.score - a.score);
      scored.forEach(s => pushUrl(s.url));

      if (items.length) break;
    }

    if (out.length < 6) {
      for (const base of PIPED_INSTANCES) {
        const data = await fetchJson(base + "/streams/" + ytId, TIMEOUT);
        if (!data) continue;
        const scored = (data.audioStreams || [])
          .filter(s => s && s.url)
          .map(s => {
            const mime = (String(s.mimeType || s.mime_type || "").split(";")[0] || "").toLowerCase();
            let score = s.bitrate || 0;
            if (mime.indexOf("webm") !== -1) score = wantWebm ? score : -1;
            else if (mime.indexOf("mp4") !== -1 || mime.indexOf("aac") !== -1 || mime.indexOf("m4a") !== -1) score = wantMp4 ? score + 1000000 : -1;
            else score += 500000;
            return { url: s.url, score };
          })
          .filter(x => x.score >= 0)
          .sort((a, b) => b.score - a.score);
        scored.forEach(s => pushUrl(s.url));
        if (scored.length) break;
      }
    }
    return out.slice(0, 6);
  }

  let ytPlayer = null;
  let ytPlayerReady = false;
  let ytApiPromise = null;
  let ytReadyTimer = null;
  let ytLoadedId = null;
  const ytFailMemory = {};
  const YT_RETRY_COOLDOWN_MS = 60 * 1000;

  function loadYouTubeIframeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === "function") { try { prev(); } catch(e){} }
        resolve();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.onerror = () => { ytApiPromise = null; reject(new Error("YT API load failed")); };
        document.head.appendChild(tag);
      }
    });
    return ytApiPromise;
  }

  async function playViaYouTubeIframe(ytId, autoplay) {
    if (ytPlayer && ytPlayerReady && ytLoadedId === ytId) {
      if (autoplay) { try { ytPlayer.playVideo(); } catch(e){} }
      else { try { ytPlayer.pauseVideo(); } catch(e){} }
      return true;
    }
    if (Date.now() - (ytFailMemory[ytId] || 0) < YT_RETRY_COOLDOWN_MS) {
      logPlayer("warn", "YouTube IFrame for " + ytId + " failed recently — skipping reload.");
      return false;
    }
    try { await loadYouTubeIframeAPI(); }
    catch (e) { logPlayer("error", "Failed to load YouTube IFrame API: " + e.message); return false; }

    const host = document.getElementById("yt-host");
    if (!host) { logPlayer("error", "yt-host container missing"); return false; }
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; }
    ytLoadedId = null;
    ytPlayerReady = false;
    if (ytReadyTimer) { clearTimeout(ytReadyTimer); ytReadyTimer = null; }
    host.innerHTML = '<div id="yt-target"></div>';

    return new Promise((resolve) => {
      let resolved = false;
      const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
      try {
        ytPlayer = new window.YT.Player("yt-target", {
          height: "1", width: "1", videoId: ytId,
          playerVars: {
            autoplay: autoplay ? 1 : 0, controls: 0, disablekb: 1, fs: 0,
            modestbranding: 1, playsinline: 1, origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              ytPlayerReady = true;
              ytLoadedId = ytId;
              if (ytReadyTimer) { clearTimeout(ytReadyTimer); ytReadyTimer = null; }
              try { e.target.setVolume(Math.round(SP.volume * 100)); } catch(err){}
              if (autoplay) { try { e.target.playVideo(); } catch(err){} }
              logPlayer("info", "YouTube IFrame ready for " + ytId);
              done(true);
            },
            onStateChange: (e) => {
              if (e.data === 0 && SP.on) nextTrack({ auto: true });
              if (e.data === 1) { SP.playing = true; updateDock(); }
              if (e.data === 2) { SP.playing = false; updateDock(); }
            },
            onError: (e) => {
              const codes = { 2: "invalid parameter", 5: "HTML5 error", 100: "video not found", 101: "embed denied", 150: "embed denied" };
              logPlayer("error", "YouTube IFrame error " + e.data + " — " + (codes[e.data] || "unknown"));
              done(false);
            },
          },
        });
        ytReadyTimer = setTimeout(() => { if (!ytPlayerReady) { logPlayer("warn", "YT IFrame did not become ready in 8s"); done(false); } }, 8000);
      } catch (err) {
        logPlayer("error", "YT Player constructor threw: " + err.message);
        done(false);
      }
    });
  }

  function destroyYouTubePlayer() {
    if (ytReadyTimer) { clearTimeout(ytReadyTimer); ytReadyTimer = null; }
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch(e){} }
    ytPlayer = null;
    ytLoadedId = null;
    ytPlayerReady = false;
    const host = document.getElementById("yt-host");
    if (host) host.innerHTML = "";
  }

  let audioEl = null;
  let audioReady = false;
  let audioTrackId = null;
  let audioRetryUrls = [];
  let audioRetryIdx = 0;

  function ensureAudioElement() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.id = "hc-audio-player";
    audioEl.preload = "metadata";
    audioEl.style.cssText = "position:fixed;width:0;height:0;left:-9999px;top:-9999px;";
    audioEl.addEventListener("loadedmetadata", () => {
      audioReady = true;
      const t = curTrack();
      if (t && t.source === "audio" && audioEl.duration && isFinite(audioEl.duration)) {
        const d = audioEl.duration * 1000;
        if (Math.abs(t.dur - d) > 500) t.dur = d;
      }
    });
    audioEl.addEventListener("ended", () => { if (SP.on) nextTrack({ auto: true }); });
    audioEl.addEventListener("error", () => {
      if (!SP.on || !curTrack()) return;
      if (audioRetryIdx + 1 < audioRetryUrls.length) {
        audioRetryIdx++;
        loadAudioSrc(audioRetryUrls[audioRetryIdx]);
        return;
      }
      const t = curTrack();
      if (t && t.ytId) {
        logPlayer("warn", "All <audio> candidates failed for " + (t.title || t.ytId) + " — falling back to YouTube IFrame.");
        t.source = "ytiframe";
        t.url = null; t.audUrls = null;
        playViaYouTubeIframe(t.ytId, true).then(ok => {
          if (!ok) {
            logPlayer("error", "YouTube IFrame also failed for " + t.ytId + " — skipping.");
            toast("This video can't be played — skipping.", "err");
            nextTrack({ auto: true });
          }
        });
        return;
      }
      logPlayer("error", "All audio candidates failed and no ytId to fall back to — skipping.");
      toast("Audio stream error — skipping to next track.", "err");
      nextTrack({ auto: true });
    });
    audioEl.setAttribute("playsinline", "");
    audioEl.setAttribute("webkit-playsinline", "");
    document.body.appendChild(audioEl);
    return audioEl;
  }

  function playAudioTrack(t, autoplay) {
    if (!t || !t.url) return;
    audioTrackId = t.id || null;
    audioRetryUrls = (t.audUrls && t.audUrls.length ? t.audUrls : (t.url ? [t.url] : []));
    audioRetryIdx = 0;
    SP.playing = !!autoplay;
    audioReady = false;
    loadAudioSrc(audioRetryUrls[0] || t.url);
  }

  function loadAudioSrc(url) {
    if (!url) return;
    const el = ensureAudioElement();
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.src = url;
    el.load();
    if (SP.playing) {
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => { SP.playing = true; }).catch(() => { SP.playing = true; });
      }
    }
  }

  function setAudioPlaying(on) {
    const el = ensureAudioElement();
    if (on) {
      SP.playing = true;
      const p = el.play();
      if (p && typeof p.then === "function") p.catch(() => { SP.playing = true; });
    } else {
      el.pause();
      SP.playing = false;
    }
  }

  function pauseAudio() { if (audioEl) { try { audioEl.pause(); } catch (e) {} } }
  function seekAudio(sec) { if (audioEl && sec != null) { try { audioEl.currentTime = sec; } catch (e) {} } }

  let scWidget = null;
  let scWidgetReady = false;
  let scBaseUrl = "";
  const soundcloudEmbedUrl = (t, autoplay) => {
    const url = (t && t.scUrl) ? t.scUrl : "https://soundcloud.com";
    return "https://w.soundcloud.com/player/?url=" + encodeURIComponent(url) +
      "&color=%23ff5500&auto_play=" + (autoplay ? "true" : "false") +
      "&visual=true&show_user=true&show_comments=false&show_reposts=false&hide_related=true&show_teaser=true&buying=true&download=false&sharing=true";
  };
  function ensureSoundCloudAPI() {
    if (window.SC && window.SC.Widget) { window.__SC_READY__ = true; return; }
    if (document.getElementById("sc-widget-api")) return;
    const s = document.createElement("script");
    s.id = "sc-widget-api";
    s.src = "https://w.soundcloud.com/player/api.js";
    s.onload = () => { window.__SC_READY__ = true; };
    document.body.appendChild(s);
  }
  function ensureSoundCloudFrame() {
    let w = document.getElementById("hc-sc-frame");
    if (!w) {
      w = document.createElement("iframe");
      w.id = "hc-sc-frame";
      w.setAttribute("allow", "autoplay; clipboard-write; encrypted-media; picture-in-picture");
      w.allowFullscreen = true;
      w.style.cssText = "position:fixed;width:0;height:0;left:-9999px;top:-9999px;pointer-events:none;visibility:hidden;";
      w.setAttribute("src", soundcloudEmbedUrl({ scUrl: "https://soundcloud.com" }, false));
      document.body.appendChild(w);
    }
    return w;
  }
  function initSCWidget() {
    ensureSoundCloudAPI();
    const w = ensureSoundCloudFrame();
    if (!w || !window.SC || !window.SC.Widget) return;
    try {
      scWidget = window.SC.Widget(w);
      scWidget.bind("READY", () => {
        scWidgetReady = true;
        if (scBaseUrl) { try { scWidget.load(scBaseUrl, { auto_play: SP.playing }); } catch (e) {} }
      });
      scWidget.bind("FINISH", () => { if (SP.on) nextTrack({ auto: true }); });
      scWidget.bind("ERROR", () => { toast("That SoundCloud track was blocked and skipped.", "err"); if (SP.on) nextTrack({ auto: true }); });
    } catch (e) {}
  }
  function loadSoundCloudTrack(t, autoplay) {
    if (!t || !t.scUrl) return;
    scWidgetReady = false;
    scBaseUrl = "https://w.soundcloud.com/player/?url=" + encodeURIComponent(t.scUrl) + "&color=%23ff5500";
    SP.playing = !!autoplay;
    ensureSoundCloudAPI();
    const w = document.getElementById("hc-sc-frame");
    if (w && window.SC && window.SC.Widget && scWidget) {
      scWidgetReady = true;
      try { scWidget.load(scBaseUrl, { auto_play: !!autoplay }); } catch (e) {}
      return;
    }
    initSCWidget();
    if (w && w.setAttribute) w.setAttribute("src", soundcloudEmbedUrl(t, autoplay));
  }
  function setSoundCloudPlaying(on) {
    if (!scWidget || !scWidgetReady) { SP.playing = !!on; return; }
    SP.playing = !!on;
    try { if (on) scWidget.play(); else scWidget.pause(); } catch (e) {}
  }
  function pauseSoundCloud() {
    if (scWidget && scWidgetReady) { try { scWidget.pause(); } catch (e) {} }
    scBaseUrl = "";
  }

  function curTrack() { return SP.queue[SP.index] || null; }
  function ensureHost() {
    if (!S.user) return;
    const g = S.call ? guilds()[S.call.guildId] : null;
    const members = g && g.call.length ? g.call : [S.user.id];
    if (SP.hostId && members.includes(SP.hostId)) return;
    SP.hostId = members[0] || S.user.id;
  }
  const canControl = () => !(SP.on && SP.restrict && SP.hostId && SP.hostId !== S.user.id);

  function artCSS(t) {
    if (!t) return "";
    if (t.artUrl) return 'url("' + t.artUrl + '")';
    if (t.ytId) return 'url("https://img.youtube.com/vi/' + t.ytId + '/hqdefault.jpg")';
    return "";
  }

  function syncSpotify() { if (S.call) pushMusic(); }
  function applySpotifySync(p) {
    if (!p || typeof p !== "object" || !SP.on || !S.call) return;
    if (Array.isArray(p.queue) && p.queue.length) {
      SP.queue = p.queue;
      SP.index = Math.max(0, Math.min(p.index || 0, p.queue.length - 1));
      p.queue.forEach(t => { TRACK_INDEX[t.id] = t; });
    }
    SP.restrict = !!p.restrict;
    if (p.hostId) SP.hostId = p.hostId;
    SP.volume = Math.max(0, Math.min(1, typeof p.volume === "number" ? p.volume : SP.volume));
    SP.playing = !!p.playing; SP.pos = p.pos || 0;
    const t = curTrack();
    if (t) {
      if (t.source === "audio" && t.url) playAudioTrack(t, SP.playing);
      else if (t.source === "sc" && t.scUrl) loadSoundCloudTrack(t, SP.playing);
      else if (t.source === "ytiframe" && t.ytId) {
        if (ytPlayer && ytPlayerReady && ytLoadedId === t.ytId) {
          if (SP.playing) { try { ytPlayer.playVideo(); } catch(e){} }
          else { try { ytPlayer.pauseVideo(); } catch(e){} }
        } else {
          playViaYouTubeIframe(t.ytId, SP.playing);
        }
      }
      else if (t.ytId) loadYouTubeTrack(t.ytId, SP.playing);
    }
    if (S.call) { updateCarousel(); updateDynamicBackground(t); updateDock(); }
  }

  async function loadYouTubeTrack(ytId, autoPlay = true) {
    if (!ytId || !SP.on) return;
    if (autoPlay) SP.playing = true;
    const t = curTrack();

    if (t && t.ytId === ytId && t.source === "audio" && t.url) {
      playAudioTrack(t, autoPlay);
      return;
    }

    if (t && t.ytId === ytId && t.source === "ytiframe" && ytPlayer && ytPlayerReady && ytLoadedId === ytId) {
      if (autoPlay) { try { ytPlayer.playVideo(); } catch(e){} }
      else { try { ytPlayer.pauseVideo(); } catch(e){} }
      return;
    }

    if (Date.now() - (ytFailMemory[ytId] || 0) < YT_RETRY_COOLDOWN_MS) {
      logPlayer("warn", "Skipping " + ytId + " — embed failed recently (retry cooldown).");
      return;
    }

    if (isResolverKnownDown()) {
      logPlayer("info", "Resolvers marked down — using YouTube IFrame directly for " + ytId);
      if (t && t.ytId === ytId) { t.source = "ytiframe"; t.url = null; t.audUrls = null; }
      const ok = await playViaYouTubeIframe(ytId, autoPlay);
      if (!ok) {
        ytFailMemory[ytId] = Date.now();
        logPlayer("error", "YouTube IFrame failed for " + ytId + " — skipping.");
        toast("This video can't be embedded — skipping.", "err");
        if (SP.on && curTrack() && curTrack().ytId === ytId) nextTrack({ auto: true });
      }
      return;
    }

    logPlayer("info", "Resolving audio stream for " + ytId + "…");
    toast("Resolving audio stream…", "info");

    let urls = [];
    try { urls = await resolveInvidiousCandidates(ytId, 3500); } catch(e) { urls = []; }

    if (urls && urls.length) {
      markResolverUp();
      logPlayer("info", "Resolved " + urls.length + " candidate stream(s) for " + ytId);
      if (t && t.ytId === ytId) {
        t.url = urls[0]; t.audUrls = urls; t.source = "audio";
        playAudioTrack(t, autoPlay);
      } else {
        playAudioTrack(Object.assign({}, t || { title: "Unknown", artist: "YouTube", dur: 0, ytId }, { url: urls[0], audUrls: urls, source: "audio" }), autoPlay);
      }
      return;
    }

    markResolverDown();
    logPlayer("warn", "Resolvers unreachable — cached for 30 min. Using YouTube IFrame for " + ytId);
    toast("Resolvers down — using YouTube player.", "info");

    if (t && t.ytId === ytId) { t.source = "ytiframe"; t.url = null; t.audUrls = null; }
    const ok = await playViaYouTubeIframe(ytId, autoPlay);
    if (!ok) {
      ytFailMemory[ytId] = Date.now();
      logPlayer("error", "YouTube IFrame failed for " + ytId + " (embed denied or network). Skipping.");
      toast("This video can't be embedded — skipping.", "err");
      if (SP.on && curTrack() && curTrack().ytId === ytId) nextTrack({ auto: true });
    } else {
      logPlayer("info", "Now playing " + ytId + " via YouTube IFrame.");
    }
  }

  function setTrack(ni, opts) {
    opts = opts || {};
    if (!SP.queue.length || !SP.on) return;
    if (!opts.auto && !canControl()) { toast("The host is controlling playback.", "err"); return; }
    const len = SP.queue.length;
    ni = ((ni % len) + len) % len;
    if (ni === SP.index && !opts.force) return;
    ensureHost();
    SP.index = ni; SP.pos = 0;
    const t = curTrack();
    if (t && t.source === "audio" && t.url) playAudioTrack(t, true);
    else if (t && t.source === "sc" && t.scUrl) loadSoundCloudTrack(t, true);
    else if (t && t.source === "ytiframe" && t.ytId) playViaYouTubeIframe(t.ytId, true);
    else if (t && t.ytId) loadYouTubeTrack(t.ytId, true);
    updateCarousel();
    updateDynamicBackground(t);
    updateDock();
    syncSpotify();
  }
  function nextTrack(opts) { setTrack(SP.index + 1, opts); }
  function prevTrack() { setTrack(SP.index - 1, {}); }
  function togglePlay() {
    if (!SP.on) return;
    if (!canControl()) { toast("The host is controlling playback.", "err"); return; }
    const t = curTrack();
    const shouldPlay = !SP.playing;
    if (shouldPlay) {
      if (!t) { playTestTone(); return; }
      if (t.source === "audio" && t.url) {
        if (audioTrackId !== t.id) playAudioTrack(t, true);
        else setAudioPlaying(true);
      } else if (t.source === "sc" && t.scUrl) loadSoundCloudTrack(t, true);
      else if (t.source === "ytiframe" && t.ytId) {
        if (ytPlayer && ytPlayerReady) { try { ytPlayer.playVideo(); } catch(e){} SP.playing = true; }
        else playViaYouTubeIframe(t.ytId, true);
      } else if (t.ytId) loadYouTubeTrack(t.ytId, true);
    } else {
      SP.playing = false;
      if (t && t.source === "sc") setSoundCloudPlaying(false);
      else if (t && t.source === "ytiframe" && ytPlayer && ytPlayerReady) { try { ytPlayer.pauseVideo(); } catch(e){} }
      else setAudioPlaying(false);
    }
    updateDock();
    syncSpotify();
  }
  function slideTo(o) { if (!o) return; setTrack(SP.index + o, {}); }

  function playTestTone() {
    logPlayer("info", "Playing built-in test tone (0.35s beep) to verify audio output.");
    audioTrackId = null;
    audioRetryUrls = [];
    audioRetryIdx = 0;
    SP.playing = true;
  }

  async function enqueue(t, opts = {}) {
    if (!S.call || !SP.on) { toast("Start collaborative music first.", "err"); return false; }
    if (!canControl()) { toast("The host restricted queue editing.", "err"); return false; }
    const existingIdx = SP.queue.findIndex(q => q.id === t.id);
    if (existingIdx !== -1) {
      if (opts.playNow) { setTrack(existingIdx, { force: true }); toast("Now playing " + t.title + ".", "ok"); return true; }
      toast("Already in the queue.", "err");
      return false;
    }
    TRACK_INDEX[t.id] = t;
    SP.queue.push(t);
    syncSpotify();
    if (opts.playNow) { setTrack(SP.queue.length - 1, { force: true }); toast("Now playing " + t.title + ".", "ok"); }
    else {
      toast("Queued " + t.title + ".", "ok");
      updateCarousel(); updateDock();
      if (SP.openPanel === "queue") refreshPanels();
    }
    return true;
  }
  function dequeueAt(i) {
    if (!SP.on) return;
    if (!canControl()) return toast("The host restricted queue editing.", "err");
    if (i < 0 || i >= SP.queue.length) return;
    if (i === SP.index) return toast("Cannot remove the currently playing track.", "err");
    SP.queue.splice(i, 1);
    if (SP.index > i) SP.index--;
    syncSpotify();
    if (SP.openPanel === "queue") refreshPanels();
    else { updateCarousel(); updateDock(); }
  }
  function toggleRestrict() {
    if (SP.hostId !== S.user.id) return;
    SP.restrict = !SP.restrict; syncSpotify(); updateDock();
    toast(SP.restrict ? "Host lock active: Only you can control playback." : "Unlocked: Everyone can skip and queue.", "info");
  }

  function tickSpotify() {
    const t = curTrack();
    if (!t) { refreshProgress(); return; }
    if (t.source === "sc") {
      if (SP.playing) SP.pos += 250;
      if (SP.playing && t.dur && SP.pos >= t.dur) nextTrack({ auto: true });
    } else if (t.source === "audio") {
      if (audioEl && !audioEl.paused && typeof audioEl.currentTime === "number") {
        try {
          SP.pos = audioEl.currentTime * 1000;
          if (audioEl.duration && isFinite(audioEl.duration)) {
            const d = audioEl.duration * 1000;
            if (Math.abs(t.dur - d) > 500) t.dur = d;
          }
        } catch (e) {}
      } else if (SP.playing) SP.pos += 250;
      if (SP.playing && t.dur && SP.pos >= t.dur) nextTrack({ auto: true });
    } else if (t.source === "ytiframe") {
      if (ytPlayer && ytPlayerReady && ytPlayer.getCurrentTime) {
        try {
          SP.pos = (ytPlayer.getCurrentTime() || 0) * 1000;
          const d = ytPlayer.getDuration() || 0;
          if (d > 0) t.dur = d * 1000;
        } catch (e) {}
      } else if (SP.playing) SP.pos += 250;
    } else {
      if (SP.playing) SP.pos += 250;
    }
    refreshProgress();
  }

  function updateDynamicBackground(t, immediate) {
    const bgA = byId("sp-bg-a"), bgB = byId("sp-bg-b");
    if (!bgA || !bgB) return;
    const imgUrl = t ? (t.artUrl || (t.ytId ? "https://img.youtube.com/vi/" + t.ytId + "/hqdefault.jpg" : "")) : "";
    if (immediate) {
      bgA.style.backgroundImage = imgUrl ? 'url("' + imgUrl + '")' : "none";
      bgB.style.backgroundImage = imgUrl ? 'url("' + imgUrl + '")' : "none";
      bgB.style.opacity = "0";
      return;
    }
    bgB.style.backgroundImage = imgUrl ? 'url("' + imgUrl + '")' : "none";
    bgB.style.opacity = "1";
    if (_ambT) clearTimeout(_ambT);
    _ambT = setTimeout(() => {
      bgA.style.backgroundImage = imgUrl ? 'url("' + imgUrl + '")' : "none";
      bgB.style.opacity = "0";
    }, 800);
  }

  function renderMusic() {
    const main = byId("stage-main");
    if (!main) return;
    ensureHost();
    const hosting = SP.hostId === S.user.id;
    main.innerHTML =
      '<div class="sp-root">' +
        '<div class="sp-bg-stage" id="sp-bg-stage">' +
          '<div class="sp-bg-layer a" id="sp-bg-a"></div>' +
          '<div class="sp-bg-layer b" id="sp-bg-b"></div>' +
        '</div>' +
        '<
