/* ============================================================
 * 多人标注同步层（Supabase）
 * ------------------------------------------------------------
 * 设计要点：
 * - 不改动原始渲染逻辑：把云端数据聚合成原有状态（ANNO / HL / PAGES），
 *   再复用页面既有的渲染函数。
 * - 身份：Supabase 匿名登录（免注册）；昵称全局唯一，存在 mm_members。
 * - 权限：服务端 RLS 保证「只能增删改自己名下的记录」。
 * - 实时：postgres_changes 订阅标注 / 高亮 / 对齐页；presence 显示在线人数。
 * - 兼容：首次登录可把旧的本机 localStorage 标注一键上传归到自己名下。
 * ============================================================ */
(function () {
  'use strict';

  var CFG = window.MM_CONFIG || {};
  var DOC = (typeof DOC_KEY !== 'undefined') ? DOC_KEY : 'mindmap:default';

  /* 本脚本在主脚本 boot 之后执行：此刻 ANNO/HL/PAGES 里是"本机旧数据" */
  var LEGACY = {
    anno: (typeof ANNO !== 'undefined') ? JSON.parse(JSON.stringify(ANNO)) : {},
    hl: (typeof HL !== 'undefined') ? JSON.parse(JSON.stringify(HL)) : {},
    pages: (typeof PAGES !== 'undefined') ? JSON.parse(JSON.stringify(PAGES)) : []
  };

  var cloud = window.MMCloud = {
    client: null,
    uid: null,          // 匿名登录 uid
    me: null,           // 已注册昵称时 = uid
    myName: '',
    status: 'init',     // init | SUBSCRIBED | off
    online: 0,
    annoAll: {},        // node_id -> [row]
    hlAll: {},          // node_id -> [row]
    pagesAll: [],       // [row]
    members: {},        // uid -> nickname
    onlyMine: false,
    channel: null,
    presence: null,
    pending: [],
    nickKey: 'mm_nick',
    migratedKey: 'mm_migrated_v1'
  };

  /* ================= 小工具 ================= */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nickOf(id) { return cloud.members[id] || '匿名'; }
  function isMine(id) { return !!(cloud.myName && id === cloud.uid); }
  function titleOf(node) {
    var it = ALLNODE[node];
    return it ? String(it.title || '') : '';
  }
  function toast(msg, ok) { try { flash(msg, ok !== false); } catch (e) {} }
  function nowIso() { return new Date().toISOString(); }
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
      return v.toString(16);
    });
  }
  function fmt(iso) { try { return fmtTime(iso); } catch (e) { return iso || ''; } }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }
  function myAnnoRec(node) {
    var arr = cloud.annoAll[node] || [];
    for (var i = 0; i < arr.length; i++) if (isMine(arr[i].author_id)) return arr[i];
    return null;
  }
  function othersAnno(node) {
    return (cloud.annoAll[node] || []).filter(function (r) { return !isMine(r.author_id) && r.body; });
  }
  function myMark(node) {
    var arr = cloud.hlAll[node] || [];
    for (var i = 0; i < arr.length; i++) if (isMine(arr[i].author_id)) return arr[i].mark;
    return null;
  }
  function hlAuthors(node) {
    var arr = cloud.hlAll[node] || [];
    return arr.map(function (r) { return nickOf(r.author_id); });
  }
  function countMy(kind) {
    var n = 0;
    if (kind === 'anno') Object.keys(cloud.annoAll).forEach(function (k) {
      if (myAnnoRec(k)) n++;
    });
    if (kind === 'hl') Object.keys(cloud.hlAll).forEach(function (k) {
      if (myMark(k) != null) n++;
    });
    if (kind === 'page') cloud.pagesAll.forEach(function (p) { if (isMine(p.author_id)) n++; });
    return n;
  }

  /* ================= DOM 注入 ================= */
  function injectDom() {
    var top = document.querySelector('.top');
    if (top && !$('mmUser')) {
      var tabs = top.querySelector('.tabs');
      var mk = function (id, cls, txt) {
        var el = document.createElement('span');
        el.id = id; el.className = cls; el.textContent = txt || '';
        return el;
      };
      var u = mk('mmUser', 'mmuser', '👤 未设置昵称');
      var o = mk('mmOnline', 'mmonline', '');
      var s = mk('mmSync', 'mmsync', '连接中…');
      if (tabs) tabs.insertAdjacentElement('afterend', u); else top.prepend(u);
      u.insertAdjacentElement('afterend', o);
      o.insertAdjacentElement('afterend', s);
      u.addEventListener('click', function () {
        if (cloud.myName) showNickModal('rename', cloud.myName, '');
        else showNickModal('register', localStorage.getItem(cloud.nickKey) || '', '');
      });
      s.title = '云端同步状态';
    }

    // 侧栏标题：我的标注 → 标注（全部分享）
    var h2 = document.querySelector('#annoList') && $('annoList').closest('.sidebox').querySelector('h2');
    if (h2 && !$('btnOnlyMine')) {
      var cnt = h2.querySelector('#annoCount');
      if (cnt) cnt.insertAdjacentText('beforebegin', '');
      var firstText = h2.firstChild;
      if (firstText && firstText.nodeType === 3) firstText.textContent = '标注';
      else h2.insertAdjacentText('afterbegin', '标注');
      var btn = document.createElement('button');
      btn.id = 'btnOnlyMine'; btn.className = 'mmlink'; btn.textContent = '只看我的';
      btn.title = '只显示你名下标注（再点一次看全部）';
      btn.addEventListener('click', function () {
        cloud.onlyMine = !cloud.onlyMine;
        btn.classList.toggle('on', cloud.onlyMine);
        btn.textContent = cloud.onlyMine ? '看全部' : '只看我的';
        renderAnnoList();
      });
      h2.appendChild(btn);
    }

    // 清空按钮改名
    var btnClear = $('btnClear');
    if (btnClear) { btnClear.textContent = '清空我的'; btnClear.title = '只清空你名下的标注/高亮/对齐页，不影响别人'; }

    // 昵称弹窗
    if (!$('mmModal')) {
      var modal = document.createElement('div');
      modal.className = 'mmmodal'; modal.id = 'mmModal';
      modal.innerHTML =
        '<div class="mmcard">' +
        '<h3 id="mmMTitle">怎么称呼你？</h3>' +
        '<p id="mmMDesc">填一个昵称，标注上会显示你的名字，方便区分是谁标的。昵称全局唯一。</p>' +
        '<input id="mmNick" maxlength="12" autocomplete="off" placeholder="例如：张三">' +
        '<p class="mmerr" id="mmErr"></p>' +
        '<div class="mmbtns">' +
        '<button class="btn pri" id="mmOk">进入</button>' +
        '<button class="btn" id="mmGuest">先看看（只读）</button>' +
        '</div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitNick(); }
        else if (e.key === 'Escape') { cancelNick(); }
      });
      $('mmOk').addEventListener('click', submitNick);
      $('mmGuest').addEventListener('click', cancelNick);
      $('mmNick').addEventListener('input', function () { $('mmErr').textContent = ''; });
    }
  }

  /* ================= 昵称弹窗逻辑 ================= */
  var modalMode = 'register';
  function showNickModal(mode, prefill, err) {
    injectDom();
    modalMode = mode || 'register';
    var m = $('mmModal'); if (!m) return;
    m.classList.add('on');
    $('mmMTitle').textContent = modalMode === 'rename' ? '修改昵称' : '怎么称呼你？';
    $('mmMDesc').textContent = modalMode === 'rename'
      ? '修改后，历史标注会跟随新昵称显示。'
      : '填一个昵称，标注上会显示你的名字，方便区分是谁标的。昵称全局唯一。';
    $('mmGuest').textContent = modalMode === 'rename' ? '取消' : '先看看（只读）';
    $('mmErr').textContent = err || '';
    var inp = $('mmNick');
    inp.value = prefill || '';
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  function hideNickModal() { var m = $('mmModal'); if (m) m.classList.remove('on'); }
  function cancelNick() {
    if (modalMode === 'register') {
      cloud.guestExplicit = true;
      try { localStorage.setItem('mm_guest', '1'); } catch (e) {}
      hideNickModal();
      paintStatus();
    } else hideNickModal();
  }
  var nickBusy = false;
  async function submitNick() {
    if (nickBusy) return;
    var name = ($('mmNick').value || '').trim();
    if (!name) { $('mmErr').textContent = '请输入昵称'; return; }
    if (name.length > 12) { $('mmErr').textContent = '昵称最多 12 个字'; return; }
    nickBusy = true;
    $('mmOk').disabled = true;
    $('mmErr').textContent = '保存中…';
    try {
      var res = modalMode === 'rename' ? await renameNick(name) : await registerNick(name);
      if (res.ok) {
        hideNickModal();
        await loadSnapshot();
        rebuild(); refreshAll({ drawer: true });
        try { localStorage.removeItem('mm_guest'); } catch (e) {}
        toast('欢迎，' + cloud.myName + '！');
        maybeMigrate();
      } else {
        $('mmErr').textContent = res.error || '保存失败，请重试';
      }
    } catch (e) {
      $('mmErr').textContent = '出错：' + (e && e.message || e);
    } finally {
      nickBusy = false;
      $('mmOk').disabled = false;
    }
  }

  /* ================= 身份 ================= */
  async function ensureSession() {
    var sb = cloud.client;
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) return { ok: true, uid: s.data.session.user.id };
    var r = await sb.auth.signInAnonymously();
    if (r.error) return { ok: false, error: '匿名登录失败：' + r.error.message };
    return { ok: true, uid: r.data.user.id };
  }
  async function fetchMember(uid) {
    var r = await cloud.client.from('mm_members').select('id,nickname').eq('id', uid).maybeSingle();
    if (r.error) return null;
    return r.data || null;
  }
  async function registerNick(name) {
    var s = await ensureSession();
    if (!s.ok) return s;
    var uid = s.uid;
    cloud.uid = uid;
    var exist = await fetchMember(uid);
    if (exist) { setIdentity(uid, exist.nickname); return { ok: true }; }
    var ins = await cloud.client.from('mm_members')
      .insert({ id: uid, nickname: name }).select().single();
    if (ins.error) {
      var msg = String(ins.error.message || '');
      if (ins.error.code === '23505' || /duplicate|unique/i.test(msg))
        return { ok: false, error: '昵称「' + name + '」已被占用，换一个吧' };
      return { ok: false, error: '保存失败：' + msg };
    }
    setIdentity(uid, ins.data.nickname);
    return { ok: true };
  }
  async function renameNick(name) {
    if (!cloud.myName) return await registerNick(name);
    var r = await cloud.client.from('mm_members')
      .update({ nickname: name }).eq('id', cloud.uid).select().single();
    if (r.error) {
      var msg = String(r.error.message || '');
      if (r.error.code === '23505' || /duplicate|unique/i.test(msg))
        return { ok: false, error: '昵称「' + name + '」已被占用，换一个吧' };
      return { ok: false, error: '改名失败：' + msg };
    }
    setIdentity(cloud.uid, r.data.nickname);
    return { ok: true };
  }
  function setIdentity(uid, name) {
    cloud.uid = uid;
    cloud.me = uid;
    cloud.myName = name;
    cloud.members[uid] = name;
    localStorage.setItem(cloud.nickKey, name);
    paintStatus();
    updatePresenceTrack();
    if (typeof refreshBadges === 'function') refreshBadges();
  }
  async function touchMember() {
    try {
      await cloud.client.from('mm_members')
        .update({ last_seen_at: nowIso() }).eq('id', cloud.uid);
    } catch (e) {}
  }

  /* ================= 状态显示 ================= */
  function paintStatus() {
    var chip = $('mmSync');
    if (chip) {
      var st = cloud.status;
      chip.textContent = st === 'SUBSCRIBED' ? '● 实时'
        : st === 'init' ? '○ 连接中' : '○ 离线';
      chip.classList.toggle('on', st === 'SUBSCRIBED');
      chip.classList.toggle('mmoffline', st === 'off');
      chip.title = st === 'SUBSCRIBED'
        ? '标注已与云端实时同步'
        : st === 'init' ? '正在连接云端…' : '当前离线，改动暂存本机，恢复后自动重推';
    }
    var u = $('mmUser');
    if (u) {
      if (cloud.myName) {
        u.textContent = '👤 ' + cloud.myName;
        u.classList.add('on');
        u.title = '当前用户：' + cloud.myName + '（点击修改昵称）';
      } else {
        u.textContent = '👤 未设置昵称';
        u.classList.remove('on');
        u.title = '点击填写昵称后即可标注';
      }
    }
    var o = $('mmOnline');
    if (o) {
      o.textContent = cloud.online > 0 ? ('👥 ' + cloud.online) : '';
      o.style.display = cloud.online > 0 ? '' : 'none';
    }
  }

  /* ================= 快照 & 聚合 ================= */
  async function loadSnapshot() {
    var sb = cloud.client;
    var q = [
      sb.from('mm_annotations').select('*').eq('doc_key', DOC),
      sb.from('mm_highlights').select('*').eq('doc_key', DOC),
      sb.from('mm_pages').select('*').eq('doc_key', DOC),
      sb.from('mm_members').select('id,nickname')
    ];
    var rs = await Promise.all(q);
    var err = rs.filter(function (r) { return r.error; })[0];
    if (err) throw new Error('读取云端数据失败：' + err.error.message);
    var annos = rs[0].data || [], hls = rs[1].data || [], pages = rs[2].data || [], mems = rs[3].data || [];
    cloud.annoAll = {}; cloud.hlAll = {}; cloud.pagesAll = []; cloud.members = {};
    mems.forEach(function (m) { cloud.members[m.id] = m.nickname; });
    annos.forEach(function (r) {
      (cloud.annoAll[r.node_id] = cloud.annoAll[r.node_id] || []).push(r);
    });
    hls.forEach(function (r) {
      (cloud.hlAll[r.node_id] = cloud.hlAll[r.node_id] || []).push(r);
    });
    cloud.pagesAll = pages;
    if (cloud.uid && cloud.members[cloud.uid] && !cloud.myName) {
      cloud.myName = cloud.members[cloud.uid];
      cloud.me = cloud.uid;
      localStorage.setItem(cloud.nickKey, cloud.myName);
    }
  }

  /* 把云端记录聚合成页面原有状态：ANNO / HL / PAGES */
  function rebuild() {
    var A = {}, H = {};
    Object.keys(cloud.annoAll).forEach(function (node) {
      var recs = cloud.annoAll[node].slice().sort(function (a, b) {
        return String(a.updated_at || '').localeCompare(String(b.updated_at || ''));
      });
      var mine = null, last = recs[recs.length - 1];
      recs.forEach(function (r) { if (isMine(r.author_id)) mine = r; });
      var rep = mine || last;
      if (rep && rep.body) {
        A[node] = { t: rep.body, s: (typeof rep.anno_state === 'number' ? rep.anno_state : 4),
                    u: rep.updated_at, h: titleOf(node).slice(0, 160) };
      }
    });
    Object.keys(cloud.hlAll).forEach(function (node) {
      var best = null;
      cloud.hlAll[node].forEach(function (r) {
        if (typeof r.mark === 'number' && (best == null || r.mark < best)) best = r.mark;
      });
      if (best != null) H[node] = best;
    });
    ANNO = A;
    HL = H;
    PAGES = cloud.pagesAll.map(function (p) {
      return { id: p.id, name: p.name, desc: p.descr || '',
               marks: (p.marks || []).slice(), _author: p.author_id };
    });
    if (CUR_PAGE !== 'main' && !PAGES.some(function (p) { return p.id === CUR_PAGE; })) {
      CUR_PAGE = 'main';
    }
  }

  function refreshAll(opts) {
    opts = opts || {};
    try {
      if (typeof refreshBadges === 'function') refreshBadges();
      if (typeof refreshHL === 'function') refreshHL();
      if (typeof renderPageList === 'function') renderPageList();
      if (opts.pageTree !== false && typeof CUR_PAGE !== 'undefined' && CUR_PAGE !== 'main'
          && typeof refreshPageTree === 'function') refreshPageTree();
      var chip = document.getElementById('chipHL');
      if (chip && chip.classList.contains('on') && typeof applyFilter === 'function') applyFilter();
      if (opts.drawer && typeof annoFocusId !== 'undefined' && annoFocusId
          && DRAWER.classList.contains('on')) openDrawer(annoFocusId);
    } catch (e) { console.warn('[MMCloud] refresh error', e); }
  }

  /* ================= 实时订阅 ================= */
  var applyTimer = null;
  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = setTimeout(function () {
      applyTimer = null;
      rebuild();
      refreshAll({ drawer: true });
    }, 120);
  }
  function upsertRow(list, row) {
    for (var i = 0; i < list.length; i++) if (list[i].id === row.id) { list[i] = row; return; }
    list.push(row);
  }
  function removeRow(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { list.splice(i, 1); return; }
  }
  /* DELETE 事件的 old 记录通常只有主键 id，按 id 反查所在节点 */
  function removeRowFromMap(map, id) {
    var keys = Object.keys(map);
    for (var k = 0; k < keys.length; k++) {
      var arr = map[keys[k]];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id) {
          arr.splice(i, 1);
          if (!arr.length) delete map[keys[k]];
          return true;
        }
      }
    }
    return false;
  }
  function applyChange(kind, payload) {
    try {
      var type = payload.eventType || payload.event || '';
      var row = payload.new || {};
      var old = payload.old || {};
      if (kind === 'anno' || kind === 'hl') {
        var node = row.node_id || old.node_id;
        var map = kind === 'anno' ? cloud.annoAll : cloud.hlAll;
        if (type === 'DELETE') {
          if (old.id) removeRowFromMap(map, old.id);
          else if (node && map[node]) {
            map[node] = map[node].filter(function (r) { return r.author_id !== old.author_id; });
            if (!map[node].length) delete map[node];
          }
        } else {
          if (!node) return;
          var arr = map[node] || (map[node] = []);
          upsertRow(arr, row);
        }
      } else if (kind === 'page') {
        if (type === 'DELETE') {
          cloud.pagesAll = cloud.pagesAll.filter(function (p) { return p.id !== old.id; });
        } else {
          upsertRow(cloud.pagesAll, row);
        }
      } else if (kind === 'member') {
        if (row.id && row.nickname) { cloud.members[row.id] = row.nickname; }
      }
      scheduleApply();
    } catch (e) { console.warn('[MMCloud] apply change error', e); }
  }
  function subscribe() {
    var sb = cloud.client;
    if (cloud.channel) { try { sb.removeChannel(cloud.channel); } catch (e) {} }
    var ch = sb.channel('mm-doc-' + DOC);
    var base = { schema: 'public', filter: 'doc_key=eq.' + DOC };
    function filterFor(table) { return { event: '*', schema: 'public', table: table, filter: 'doc_key=eq.' + DOC }; }
    ch.on('postgres_changes', filterFor('mm_annotations'), function (p) { applyChange('anno', p); });
    ch.on('postgres_changes', filterFor('mm_highlights'), function (p) { applyChange('hl', p); });
    ch.on('postgres_changes', filterFor('mm_pages'), function (p) { applyChange('page', p); });
    // 注意：不要把 mm_members 的订阅挂在同一个频道上——实测无 filter 的成员表订阅
    // 会让整个频道的 postgres_changes 静默失效；昵称变化在重连/刷新时通过快照同步即可。
    ch.subscribe(function (status) {
      cloud.status = status === 'SUBSCRIBED' ? 'SUBSCRIBED' : (status === 'CLOSED' ? 'off' : 'init');
      paintStatus();
      if (status === 'SUBSCRIBED') {
        // 断线重连后补一次全量
        loadSnapshot().then(function () {
          rebuild(); refreshAll({ drawer: true });
          flushPending();
        }).catch(function () {});
      }
    });
    cloud.channel = ch;
  }

  /* ================= 在线人数 ================= */
  function subscribePresence() {
    var sb = cloud.client;
    if (!sb) return;
    try {
      var p = sb.channel('mm-presence-' + DOC, { config: { presence: { key: cloud.uid || undefined } } });
      p.on('presence', { event: 'sync' }, function () {
        var st = p.presenceState ? p.presenceState() : {};
        var n = Object.keys(st || {}).length;
        cloud.online = n;
        paintStatus();
      });
      p.subscribe(function (status) {
        if (status === 'SUBSCRIBED') updatePresenceTrack();
      });
      cloud.presence = p;
    } catch (e) { console.warn('[MMCloud] presence error', e); }
  }
  function updatePresenceTrack() {
    var p = cloud.presence;
    if (!p || !p.track) return;
    try { p.track({ nickname: cloud.myName || '访客' }); } catch (e) {}
  }

  /* ================= 写入（含失败重试） ================= */
  function queueRetry(fn) {
    cloud.pending.push(fn);
    if (cloud.pending.length > 20) cloud.pending.shift();
    setTimeout(flushPending, 1500);
  }
  async function flushPending() {
    if (!cloud.pending.length || !cloud.client) return;
    var ops = cloud.pending.slice();
    cloud.pending = [];
    for (var i = 0; i < ops.length; i++) {
      var ok = false;
      try { ok = await ops[i](); } catch (e) { ok = false; }
      if (!ok) { cloud.pending.push(ops[i]); break; }
    }
  }
  function needNick() {
    showNickModal('register', localStorage.getItem(cloud.nickKey) || '', '先填个昵称，标注才能保存给其他人看');
    return false;
  }

  async function saveAnno(node, body, state) {
    if (!cloud.myName) return needNick();
    var payload = { doc_key: DOC, node_id: node, author_id: cloud.uid, body: body, anno_state: state };
    var r = await cloud.client.from('mm_annotations')
      .upsert(payload, { onConflict: 'doc_key,node_id,author_id' }).select().single();
    if (r.error) {
      toast('标注保存失败：' + r.error.message, false);
      queueRetry(function () { return saveAnno(node, body, state); });
      return false;
    }
    upsertRow(cloud.annoAll[node] = cloud.annoAll[node] || [], r.data);
    rebuild();
    refreshAll({ drawer: false });
    return true;
  }
  async function delAnno(node) {
    if (!cloud.myName) return needNick();
    var r = await cloud.client.from('mm_annotations').delete()
      .eq('doc_key', DOC).eq('node_id', node).eq('author_id', cloud.uid);
    if (r.error) { toast('删除失败：' + r.error.message, false); return false; }
    if (cloud.annoAll[node]) {
      cloud.annoAll[node] = cloud.annoAll[node].filter(function (x) { return !isMine(x.author_id); });
      if (!cloud.annoAll[node].length) delete cloud.annoAll[node];
    }
    rebuild(); refreshAll({ drawer: true });
    return true;
  }
  async function saveMark(node, mark) {
    if (!cloud.myName) return needNick();
    var r;
    if (mark == null) {
      r = await cloud.client.from('mm_highlights').delete()
        .eq('doc_key', DOC).eq('node_id', node).eq('author_id', cloud.uid);
    } else {
      r = await cloud.client.from('mm_highlights').upsert(
        { doc_key: DOC, node_id: node, author_id: cloud.uid, mark: mark },
        { onConflict: 'doc_key,node_id,author_id' }).select().single();
    }
    if (r.error) {
      toast('高亮保存失败：' + r.error.message, false);
      queueRetry(function () { return saveMark(node, mark); });
      return false;
    }
    var arr = cloud.hlAll[node] || (cloud.hlAll[node] = []);
    if (mark == null) {
      cloud.hlAll[node] = arr.filter(function (x) { return !isMine(x.author_id); });
      if (!cloud.hlAll[node].length) delete cloud.hlAll[node];
    } else {
      upsertRow(arr, r.data);
    }
    rebuild(); refreshAll({ drawer: true });
    return true;
  }
  async function createPage(pg) {
    if (!cloud.myName) return needNick();
    var r = await cloud.client.from('mm_pages').insert({
      id: pg.id, doc_key: DOC, author_id: cloud.uid,
      name: pg.name, descr: pg.desc || '', marks: pg.marks || []
    }).select().single();
    if (r.error) {
      toast('对齐页保存失败：' + r.error.message, false);
      queueRetry(function () { return createPage(pg); });
      return false;
    }
    upsertRow(cloud.pagesAll, r.data);
    rebuild(); refreshAll({ drawer: false });
    return true;
  }
  async function updatePage(pg) {
    if (!cloud.myName) return needNick();
    var r = await cloud.client.from('mm_pages')
      .update({ name: pg.name, descr: pg.desc || '', marks: pg.marks || [] })
      .eq('id', pg.id).eq('author_id', cloud.uid).select().single();
    if (r.error) { toast('对齐页保存失败：' + r.error.message, false); return false; }
    upsertRow(cloud.pagesAll, r.data);
    rebuild(); refreshAll({ drawer: false });
    return true;
  }
  async function deletePageCloud(id) {
    if (!cloud.myName) return needNick();
    var r = await cloud.client.from('mm_pages').delete().eq('id', id).eq('author_id', cloud.uid);
    if (r.error) { toast('删除失败：' + r.error.message, false); return false; }
    cloud.pagesAll = cloud.pagesAll.filter(function (p) { return p.id !== id; });
    rebuild(); refreshAll({ drawer: false });
    return true;
  }
  async function clearMine() {
    if (!cloud.myName) return needNick();
    var sb = cloud.client;
    var rs = await Promise.all([
      sb.from('mm_annotations').delete().eq('doc_key', DOC).eq('author_id', cloud.uid),
      sb.from('mm_highlights').delete().eq('doc_key', DOC).eq('author_id', cloud.uid),
      sb.from('mm_pages').delete().eq('doc_key', DOC).eq('author_id', cloud.uid)
    ]);
    var err = rs.filter(function (r) { return r.error; })[0];
    if (err) { toast('清空失败：' + err.error.message, false); return false; }
    await loadSnapshot();
    rebuild(); refreshAll({ drawer: true });
    return true;
  }

  /* ================= 旧数据迁移 ================= */
  function countLegacy() {
    var a = Object.keys(LEGACY.anno || {}).filter(function (k) { return LEGACY.anno[k] && LEGACY.anno[k].t; }).length;
    var h = Object.keys(LEGACY.hl || {}).length;
    var p = (LEGACY.pages || []).length;
    return { anno: a, hl: h, pages: p, total: a + h + p };
  }
  async function uploadLegacy() {
    var sb = cloud.client;
    var annos = Object.keys(LEGACY.anno || {}).filter(function (k) { return LEGACY.anno[k] && LEGACY.anno[k].t; })
      .map(function (k) {
        return { doc_key: DOC, node_id: k, author_id: cloud.uid,
                 body: LEGACY.anno[k].t, anno_state: (typeof LEGACY.anno[k].s === 'number' ? LEGACY.anno[k].s : 4) };
      });
    var hls = Object.keys(LEGACY.hl || {}).filter(function (k) { return typeof LEGACY.hl[k] === 'number'; })
      .map(function (k) { return { doc_key: DOC, node_id: k, author_id: cloud.uid, mark: LEGACY.hl[k] }; });
    if (annos.length) {
      var r1 = await sb.from('mm_annotations').upsert(annos, { onConflict: 'doc_key,node_id,author_id' });
      if (r1.error) toast('旧标注上传失败：' + r1.error.message, false);
    }
    if (hls.length) {
      var r2 = await sb.from('mm_highlights').upsert(hls, { onConflict: 'doc_key,node_id,author_id' });
      if (r2.error) toast('旧高亮上传失败：' + r2.error.message, false);
    }
    var pages = (LEGACY.pages || []).filter(function (p) { return p && p.name; }).map(function (p) {
      return { id: uuid(), doc_key: DOC, author_id: cloud.uid, name: String(p.name).slice(0, 60),
               descr: String(p.desc || ''), marks: (p.marks || []).filter(function (i) { return typeof i === 'number'; }) };
    });
    if (pages.length) {
      var r3 = await sb.from('mm_pages').insert(pages);
      if (r3.error) toast('旧对齐页上传失败：' + r3.error.message, false);
    }
    await loadSnapshot();
    rebuild(); refreshAll({ drawer: true });
    toast('旧数据已上传并归属到你名下');
  }
  async function maybeMigrate() {
    if (!cloud.myName) return;
    if (localStorage.getItem(cloud.migratedKey) === '1') return;
    var n = countLegacy();
    if (!n.total) { localStorage.setItem(cloud.migratedKey, '1'); return; }
    var mine = countMy('anno') + countMy('hl') + countMy('page');
    if (mine > 0) { localStorage.setItem(cloud.migratedKey, '1'); return; }
    var msg = '检测到本机有 ' + n.anno + ' 条旧标注、' + n.hl + ' 张旧高亮' +
      (n.pages ? '、' + n.pages + ' 个对齐页' : '') +
      '。\n\n是否上传到云端并归属到你（' + cloud.myName + '）名下？\n上传后其他人也能看到。';
    if (window.confirm(msg)) await uploadLegacy();
    localStorage.setItem(cloud.migratedKey, '1');
  }

  /* ================= 覆盖页面函数：让 UI 接上云端数据 ================= */
  function pageOwner(pg) { return (pg && pg._author) || null; }
  function canEditPage(pg) { return !pageOwner(pg) || isMine(pageOwner(pg)); }

  function installOverrides() {

    /* 侧栏：全部人标注 + 只看我的 */
    window.renderAnnoList = function () {
      var box = $('annoList'); if (!box) return;
      var rows = [];
      Object.keys(cloud.annoAll).forEach(function (node) {
        (cloud.annoAll[node] || []).forEach(function (r) {
          if (!r.body) return;
          if (cloud.onlyMine && !isMine(r.author_id)) return;
          rows.push({ node: node, rec: r });
        });
      });
      rows.sort(function (a, b) {
        return String(b.rec.updated_at || '').localeCompare(String(a.rec.updated_at || ''));
      });
      var total = 0;
      Object.keys(cloud.annoAll).forEach(function (n) {
        total += (cloud.annoAll[n] || []).filter(function (r) { return !!r.body; }).length;
      });
      if ($('annoCount')) $('annoCount').textContent = (cloud.onlyMine ? rows.length + ' 条（我）' : total + ' 条');
      box.innerHTML = '';
      if (!rows.length) {
        var d = document.createElement('div');
        d.className = 'empty';
        d.textContent = cloud.myName
          ? '还没有标注。点开图中任意节点，在右侧「我的标注」里写批注，云端会实时同步。'
          : '还没有标注。填写昵称后就可以给节点写批注，并与其他人的标注实时同步。';
        box.appendChild(d);
        return;
      }
      rows.forEach(function (x) {
        var r = x.rec, st = (STATES[r.anno_state] || STATES[4]);
        var known = !!ALLNODE[x.node];
        var row = document.createElement('div');
        row.className = 'annorow' + (known ? '' : ' orphan');
        var dt = document.createElement('span');
        dt.className = 'dt'; dt.style.background = st.c;
        var tx = document.createElement('div'); tx.className = 'tx';
        var b = document.createElement('b');
        b.textContent = st.k + ' · ' + (known ? titleOf(x.node).slice(0, 52) : '（原卡片已不在结构中）');
        var au = document.createElement('span'); au.className = 'mmau';
        au.textContent = nickOf(r.author_id) + (isMine(r.author_id) ? '（我）' : '');
        var sp = document.createElement('span');
        sp.textContent = r.body;
        tx.appendChild(b); tx.appendChild(au); tx.appendChild(sp);
        row.appendChild(dt); row.appendChild(tx);
        row.title = '点击定位到该节点';
        row.addEventListener('click', function () { gotoAnno(x.node); });
        box.appendChild(row);
      });
    };

    /* 抽屉：我的标注（可编辑）+ 其他人的标注（只读） */
    window.renderAnnoBlock = function (id, body) {
      annoFocusId = id;
      var own = myAnnoRec(id);
      var d = document.createElement('div'); d.className = 'anno';
      var ah = document.createElement('div'); ah.className = 'ah';
      var h4 = document.createElement('h4'); h4.textContent = '我的标注';
      var tm = document.createElement('span'); tm.className = 'tm';
      ah.appendChild(h4); ah.appendChild(tm);
      var ab = document.createElement('div'); ab.className = 'ab';
      d.appendChild(ah); d.appendChild(ab);

      if (!cloud.myName) {
        var hint = document.createElement('div'); hint.className = 'mmauthhint';
        hint.innerHTML = '当前是只读浏览。填写昵称后，你的标注会保存到云端，并和其他人实时同步。';
        var b = document.createElement('button'); b.className = 'btn pri'; b.textContent = '填写昵称，开始标注';
        b.addEventListener('click', function () { showNickModal('register', localStorage.getItem(cloud.nickKey) || '', ''); });
        hint.appendChild(document.createElement('br')); hint.appendChild(b);
        ab.appendChild(hint);
        tm.textContent = '只读';
      } else {
        var ta = document.createElement('textarea');
        ta.placeholder = '写点什么：这一步为什么卡住 / 要找谁要材料 / 需要核对的口径…（停止输入后自动保存，云端实时同步）';
        ta.value = own && own.body ? own.body : '';
        var cur = (own && typeof own.anno_state === 'number') ? own.anno_state : DEFAULT_STATE;
        var states = document.createElement('div'); states.className = 'states';
        var chips = STATES.map(function (s, i) {
          var c = document.createElement('span');
          c.className = 'st' + (i === cur ? ' on' : '');
          c.textContent = s.k; c.title = '标为「' + s.k + '」';
          if (i === cur) c.style.background = s.c;
          c.addEventListener('click', function () {
            cur = i;
            chips.forEach(function (x, j) {
              x.classList.toggle('on', i === j);
              x.style.background = (i === j) ? STATES[j].c : '';
            });
            commit(false);
          });
          states.appendChild(c);
          return c;
        });
        var foot = document.createElement('div'); foot.className = 'foot';
        var bSave = document.createElement('button'); bSave.className = 'btn pri'; bSave.textContent = '保存';
        var bDel = document.createElement('button'); bDel.className = 'btn del'; bDel.textContent = '删除标注';
        foot.appendChild(bSave); foot.appendChild(bDel);
        ab.appendChild(ta); ab.appendChild(states); ab.appendChild(foot);

        function paint() {
          var r = myAnnoRec(id);
          tm.textContent = (r && r.body) ? (stateOf(r.anno_state).k + ' · ' + fmt(r.updated_at)) : '未标注';
        }
        function commit(showMsg) {
          var t = ta.value.trim();
          if (!t) {
            if (myAnnoRec(id)) {
              delAnno(id); if (showMsg) toast('已清空并删除该标注');
            }
          } else {
            ANNO[id] = { t: t, s: cur, u: nowIso(),
                         h: (IDMAP[id] ? IDMAP[id].node.title : '').slice(0, 160) };
            updateBadge(id);
            saveAnno(id, t, cur);
            if (showMsg) toast('已保存 ' + hhmm());
          }
          updateBadge(id); renderAnnoList(); paint();
        }
        var t1 = null;
        ta.addEventListener('input', function () {
          if (t1) clearTimeout(t1);
          t1 = setTimeout(function () { commit(false); }, 900);
        });
        ta.addEventListener('blur', function () { if (t1) clearTimeout(t1); commit(false); });
        bSave.addEventListener('click', function () { if (t1) clearTimeout(t1); commit(true); });
        bDel.addEventListener('click', function () {
          if (!myAnnoRec(id)) { ta.value = ''; paint(); return; }
          if (!confirm('删除你的这条标注？')) return;
          ta.value = '';
          delAnno(id); paint(); toast('已删除你的标注');
        });
        paint();
      }

      body.insertBefore(d, body.firstChild);

      /* 其他人的标注 */
      var others = othersAnno(id);
      var od = document.createElement('div'); od.className = 'anno';
      var oah = document.createElement('div'); oah.className = 'ah';
      var oh4 = document.createElement('h4'); oh4.textContent = '其他人的标注';
      var otm = document.createElement('span'); otm.className = 'tm';
      otm.textContent = others.length ? (others.length + ' 条') : '暂无';
      oah.appendChild(oh4); oah.appendChild(otm);
      var oab = document.createElement('div'); oab.className = 'ab';
      var wrap = document.createElement('div'); wrap.className = 'mmoth';
      if (!others.length) {
        var e = document.createElement('div'); e.className = 'empty2'; e.textContent = '还没有其他人标注这个节点。';
        wrap.appendChild(e);
      } else {
        others.sort(function (a, b) {
          return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
        }).forEach(function (r) {
          var st = (STATES[r.anno_state] || STATES[4]);
          var row = document.createElement('div'); row.className = 'row2';
          var hd = document.createElement('div'); hd.className = 'hd';
          var who = document.createElement('span'); who.className = 'who'; who.textContent = nickOf(r.author_id);
          var chip = document.createElement('span'); chip.className = 'st2'; chip.style.background = st.c; chip.textContent = st.k;
          var tm2 = document.createElement('span'); tm2.className = 'tm2'; tm2.textContent = fmt(r.updated_at);
          hd.appendChild(who); hd.appendChild(chip); hd.appendChild(tm2);
          var tx = document.createElement('div'); tx.textContent = r.body;
          row.appendChild(hd); row.appendChild(tx);
          wrap.appendChild(row);
        });
      }
      oab.appendChild(wrap);
      od.appendChild(oah); od.appendChild(oab);
      body.insertBefore(od, d.nextSibling);
    };

    /* 抽屉：高亮标记（作者可见，只能改自己的） */
    window.renderHlBlock = function (id, body) {
      var d = document.createElement('div'); d.className = 'anno';
      var ah = document.createElement('div'); ah.className = 'ah';
      var h4 = document.createElement('h4'); h4.textContent = '高亮标记';
      var tm = document.createElement('span'); tm.className = 'tm';
      var own = myMark(id);
      var arr = cloud.hlAll[id] || [];
      if (arr.length) {
        var byMark = {};
        arr.forEach(function (r) { (byMark[r.mark] = byMark[r.mark] || []).push(nickOf(r.author_id)); });
        tm.textContent = MARKS.map(function (m, i) {
          return byMark[i] ? (m.k + '（' + byMark[i].join('、') + '）') : '';
        }).filter(Boolean).join('；');
      } else tm.textContent = '未标记';
      ah.appendChild(h4); ah.appendChild(tm);

      var ab = document.createElement('div'); ab.className = 'ab';
      var states = document.createElement('div');
      states.className = 'states'; states.style.margin = '0';
      MARKS.forEach(function (m, i) {
        var c = document.createElement('span');
        c.className = 'st' + (own === i ? ' on' : '');
        c.textContent = m.k;
        c.title = m.d + (cloud.myName ? '（点击设置/取消你自己的标记）' : '（填写昵称后可标记）');
        if (own === i) c.style.background = m.c;
        c.addEventListener('click', function () {
          if (!cloud.myName) { needNick(); return; }
          setMark(id, own === i ? null : i);
          if (IDMAP[id]) openDrawer(id);
        });
        states.appendChild(c);
      });
      ab.appendChild(states);
      if (arr.length) {
        var tip = document.createElement('div'); tip.className = 'mmro';
        tip.textContent = '每个参与者都可以独立标记，卡片颜色按优先级显示第一批 > 第二批 > 第三批 > 重点 > 存疑。';
        ab.appendChild(tip);
      }
      d.appendChild(ah); d.appendChild(ab);
      body.insertBefore(d, body.firstChild);
    };

    /* 高亮：卡片 chip 显示作者数 */
    window.paintHL = function (id) {
      var it = IDMAP[id]; if (!it) return;
      var m = (typeof markOf === 'function') ? markOf(id) : (HL[id] != null ? MARKS[HL[id]] : null);
      var chip = it.el.querySelector(':scope > .hlc');
      if (!m) {
        if (chip) chip.remove();
        it.el.classList.remove('hl');
        it.el.style.removeProperty('--hlc');
        it.el.style.removeProperty('--hlt');
        return;
      }
      it.el.classList.add('hl');
      it.el.style.setProperty('--hlc', m.c);
      it.el.style.setProperty('--hlt', m.c + '14');
      if (!chip) { chip = document.createElement('span'); chip.className = 'hlc'; it.el.appendChild(chip); }
      var arr = cloud.hlAll[id] || [];
      var names = arr.map(function (r) { return nickOf(r.author_id); });
      chip.style.background = m.c;
      chip.textContent = m.k + (arr.length > 1 ? ' ' + arr.length : '');
      chip.title = m.k + '：' + m.d + (names.length ? '\n标记人：' + names.join('、') : '');
    };

    /* 标记：写云端 */
    window.setMark = function (id, idx) {
      if (!cloud.myName) { needNick(); return; }
      if (idx == null || idx === '') delete HL[id]; else HL[id] = idx;
      hideHlPop();
      annotateMain(ROOT, 'root');
      paintHL(id);
      renderHLLegend();
      buildNav();
      renderPageList();
      var chipHL = document.getElementById('chipHL');
      if (chipHL && chipHL.classList.contains('on')) applyFilter();
      if (CUR_PAGE !== 'main') refreshPageTree();
      saveMark(id, idx);
    };

    /* 对齐页：列表带作者，只有作者本人能改名/删除 */
    window.renderPageList = function () {
      var box = $('pageList'); if (!box) return;
      if ($('pageCount')) $('pageCount').textContent = PAGES.length + ' 个';
      box.innerHTML = '';
      var rows = [{ id: 'main', name: '全景图', n: st.total, on: CUR_PAGE === 'main' }].concat(
        PAGES.map(function (p) {
          return { id: p.id, name: p.name, n: markIds(p.marks).length, pg: p, on: CUR_PAGE === p.id };
        })
      );
      rows.forEach(function (r) {
        var d = document.createElement('div');
        d.className = 'pagerow' + (r.on ? ' on' : '');
        var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.name;
        var ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = r.n + ' 张';
        d.appendChild(nm); d.appendChild(ct);
        if (r.pg) {
          var owner = pageOwner(r.pg);
          if (owner && !isMine(owner)) {
            var au = document.createElement('span'); au.className = 'mmau'; au.textContent = nickOf(owner);
            d.appendChild(au);
          } else {
            var x = document.createElement('button');
            x.className = 'x'; x.textContent = '×'; x.title = '删除这个对齐页（不影响卡片上的高亮）';
            x.addEventListener('click', function (e) { e.stopPropagation(); delPage(r.pg.id); });
            d.appendChild(x);
            d.title = '单击切换；双击重命名';
            d.addEventListener('dblclick', function (e) { e.stopPropagation(); renameInline(nm, r); });
          }
          if (owner && !isMine(owner)) d.title = '由 ' + nickOf(owner) + ' 创建（只读）';
        } else {
          d.title = '全景图（默认页）';
        }
        d.addEventListener('click', function () { if (CUR_PAGE !== r.id) setPage(r.id); });
        box.appendChild(d);
      });
    };
    window.renameInline = function (nm, r) {
      if (!canEditPage(r.pg)) { toast('只能修改你自己创建的对齐页', false); return; }
      var inp = document.createElement('input');
      inp.value = r.pg.name;
      nm.replaceWith(inp);
      inp.focus(); inp.select();
      var closed = false;
      function done(ok) {
        if (closed) return;
        closed = true;
        var v = (inp.value || '').trim().slice(0, 60);
        if (ok && v) {
          r.pg.name = v;
          if (CUR_PAGE === r.pg.id) {
            var h = $('phName'); if (h) h.textContent = v;
            var it = IDMAP['pgroot'];
            if (it) { var t = it.el.querySelector('.tt'); if (t) t.textContent = v; }
          }
          updatePage(r.pg);
          toast('已改名为「' + v + '」');
        }
        renderPageList();
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { done(false); }
      });
      inp.addEventListener('blur', function () { done(true); });
    };
    window.delPage = function (id) {
      var pg = pageById(id);
      if (!pg) return;
      if (!canEditPage(pg)) { toast('只能删除你自己创建的对齐页', false); return; }
      if (!confirm('删除对齐页「' + pg.name + '」？\n卡片上的高亮标记不会删掉，可以再重新生成。')) return;
      if (CUR_PAGE === id) CUR_PAGE = 'main';
      deletePageCloud(id);
      renderPage();
      toast('已删除该对齐页');
    };

    /* 对齐页标题：作者可编辑，其他人只读 */
    window.paintPageHead = function (info) {
      var head = $('pageHead');
      if (info.isMain) { head.classList.add('off'); return; }
      head.classList.remove('off');
      var pg = info.pg || pageById(CUR_PAGE);
      var ed = canEditPage(pg);
      var nm = $('phName'), ds = $('phDesc');
      if ((nm.textContent || '').trim() !== info.name) nm.textContent = info.name;
      if ((ds.textContent || '').trim() !== (info.desc || '').trim()) ds.textContent = info.desc || '';
      nm.contentEditable = ed ? 'true' : 'false';
      ds.contentEditable = ed ? 'true' : 'false';
      $('phMeta').textContent = info.count + ' 张卡片' +
        (ed ? ' · 抽取自高亮' : ' · ' + nickOf(pageOwner(pg)) + ' 创建（只读）');
    };
    window.paintMarksChips = function (info) {
      var box = $('phMarks'); if (!box) return;
      box.innerHTML = '';
      if (info.isMain) return;
      var pg = info.pg;
      var ed = canEditPage(pg);
      MARKS.forEach(function (m, i) {
        var on = pg.marks.indexOf(i) > -1;
        var s = document.createElement('span');
        s.className = 'mk' + (on ? ' on' : ' off');
        s.title = ed ? (on ? ('点一下把「' + m.k + '」移出本页') : ('点一下把「' + m.k + '」加入本页'))
                     : ('由 ' + nickOf(pageOwner(pg)) + ' 创建，只读');
        if (!ed) s.style.opacity = '.6';
        var ic = document.createElement('i'); ic.style.background = m.c;
        var sp = document.createElement('span');
        sp.textContent = m.k; sp.style.color = on ? 'var(--ink)' : 'var(--ink3)';
        s.appendChild(ic); s.appendChild(sp);
        s.addEventListener('click', function () {
          if (!ed) { toast('只能修改你自己创建的对齐页', false); return; }
          var k = pg.marks.indexOf(i);
          if (k > -1) pg.marks.splice(k, 1); else pg.marks.push(i);
          pg.marks.sort(function (a, b) { return a - b; });
          renderPage();
          updatePage(pg);
          toast('已' + (k > -1 ? '移出' : '加入') + '「' + m.k + '」');
        });
        box.appendChild(s);
      });
    };

    /* 新建对齐页：写云端 */
    window.newPageFromHL = function () {
      if (!cloud.myName) { needNick(); return; }
      var ids = Object.keys(HL).filter(function (id) { return ALLNODE[id] && MARKS[HL[id]]; });
      if (!ids.length) { toast('先在卡片上标高亮，再生成对齐页', false); return; }
      var marks = [];
      MARKS.forEach(function (m, i) {
        if (ids.some(function (id) { return HL[id] === i; })) marks.push(i);
      });
      var label = marks.map(function (i) { return MARKS[i].k; }).join(' + ');
      var pg = { id: uuid(), name: label + ' · ' + ids.length + ' 张卡片', desc: '', marks: marks, _author: cloud.uid };
      PAGES.push(pg);
      setPage(pg.id);
      toast('已生成对齐页「' + pg.name + '」，标题和说明直接点开就能改', true);
      createPage(pg);
    };

    /* 导出：带上作者信息 */
    function mmExport() {
      var records = { annotations: [], highlights: [], pages: [] };
      Object.keys(cloud.annoAll).forEach(function (n) {
        (cloud.annoAll[n] || []).forEach(function (r) {
          records.annotations.push({ node: n, author: nickOf(r.author_id), author_id: r.author_id,
            body: r.body, state: r.anno_state, updated: r.updated_at });
        });
      });
      Object.keys(cloud.hlAll).forEach(function (n) {
        (cloud.hlAll[n] || []).forEach(function (r) {
          records.highlights.push({ node: n, author: nickOf(r.author_id), author_id: r.author_id,
            mark: r.mark, updated: r.updated_at });
        });
      });
      cloud.pagesAll.forEach(function (p) {
        records.pages.push({ name: p.name, desc: p.descr, marks: p.marks,
          author: nickOf(p.author_id), author_id: p.author_id, updated: p.updated_at });
      });
      var payload = { v: 3, doc: document.title, exported: nowIso(), shared: true,
                      nodeCount: st.total, anonymized: false, records: records,
                      anno: ANNO, hl: HL, pages: PAGES };
      var d = new Date();
      var name = '思维导图标注_' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) +
        ('0' + d.getDate()).slice(-2) + '_' + hhmm().replace(':', '') + '.json';
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      toast('已导出（含作者信息）：标注 ' + records.annotations.length + ' 条 · 高亮 ' +
        records.highlights.length + ' 张 · 对齐页 ' + records.pages.length + ' 个');
    }
    window.exportBackup = mmExport;

    /* 导入：合并并上传到自己的名下 */
    window.importBackup = function (file) {
      var fr = new FileReader();
      fr.onload = function () {
        var d = null;
        try { d = JSON.parse(fr.result); } catch (e) { toast('导入失败：不是有效的 JSON 文件', false); return; }
        if (!cloud.myName) { needNick(); return; }
        var annos = [], hls = [], pages = [];
        if (d && d.records) {
          (d.records.annotations || []).forEach(function (r) {
            if (!r.node || !r.body) return;
            annos.push({ doc_key: DOC, node_id: r.node, author_id: cloud.uid, body: r.body,
              anno_state: (typeof r.state === 'number' ? r.state : 4) });
          });
          (d.records.highlights || []).forEach(function (r) {
            if (!r.node || typeof r.mark !== 'number') return;
            hls.push({ doc_key: DOC, node_id: r.node, author_id: cloud.uid, mark: r.mark });
          });
          (d.records.pages || []).forEach(function (p) {
            if (!p.name) return;
            pages.push({ id: uuid(), doc_key: DOC, author_id: cloud.uid, name: String(p.name).slice(0, 60),
              descr: String(p.desc || ''), marks: (p.marks || []).filter(function (i) { return typeof i === 'number'; }) });
          });
        } else {
          var src = (d && d.anno && typeof d.anno === 'object') ? d.anno : null;
          if (!src) { toast('导入失败：文件里没有标注数据', false); return; }
          Object.keys(src).forEach(function (k) {
            var v = src[k];
            if (v && typeof v === 'object' && typeof v.t === 'string' && v.t.trim()) {
              annos.push({ doc_key: DOC, node_id: k, author_id: cloud.uid, body: v.t,
                anno_state: (typeof v.s === 'number' ? v.s : 4) });
            }
          });
          if (d && d.hl && typeof d.hl === 'object') {
            Object.keys(d.hl).forEach(function (k) {
              var i = d.hl[k];
              if (typeof i === 'number' && i >= 0 && i < MARKS.length && ALLNODE[k]) {
                hls.push({ doc_key: DOC, node_id: k, author_id: cloud.uid, mark: i });
              }
            });
          }
          if (d && Array.isArray(d.pages)) {
            d.pages.forEach(function (p) {
              if (!p || !p.name) return;
              pages.push({ id: uuid(), doc_key: DOC, author_id: cloud.uid, name: String(p.name).slice(0, 60),
                descr: String(p.desc || ''), marks: (p.marks || []).filter(function (i) { return typeof i === 'number'; }) });
            });
          }
        }
        (async function () {
          var sb = cloud.client;
          if (annos.length) {
            var r1 = await sb.from('mm_annotations').upsert(annos, { onConflict: 'doc_key,node_id,author_id' });
            if (r1.error) toast('导入标注失败：' + r1.error.message, false);
          }
          if (hls.length) {
            var r2 = await sb.from('mm_highlights').upsert(hls, { onConflict: 'doc_key,node_id,author_id' });
            if (r2.error) toast('导入高亮失败：' + r2.error.message, false);
          }
          if (pages.length) {
            var r3 = await sb.from('mm_pages').insert(pages);
            if (r3.error) toast('导入对齐页失败：' + r3.error.message, false);
          }
          await loadSnapshot();
          rebuild(); refreshAll({ drawer: true });
          toast('已导入并归属到你名下：标注 ' + annos.length + ' 条 · 高亮 ' + hls.length + ' 张 · 对齐页 ' + pages.length + ' 个');
        })();
      };
      fr.readAsText(file);
    };

    /* 顶栏的导出按钮替换（原监听绑定了旧函数） */
    ['btnExport', 'btnExport2'].forEach(function (id) {
      var old = $(id);
      if (!old) return;
      var clone = old.cloneNode(true);
      old.replaceWith(clone);
      clone.addEventListener('click', mmExport);
    });

    /* 清空：只清自己的 */
    var btnClear = $('btnClear');
    if (btnClear) {
      var c2 = btnClear.cloneNode(true);
      btnClear.replaceWith(c2);
      c2.textContent = '清空我的';
      c2.title = '只清空你名下的标注/高亮/对齐页，不影响别人';
      c2.addEventListener('click', async function () {
        if (!cloud.myName) { needNick(); return; }
        var n = countMy('anno'), m = countMy('hl'), p = countMy('page');
        if (!n && !m && !p) { toast('你名下还没有标注'); return; }
        if (!confirm('将清空「你名下」的 ' + n + ' 条标注、' + m + ' 张高亮、' + p + ' 个对齐页。\n不会影响其他人的标注。确定？')) return;
        var ok = await clearMine();
        if (ok) toast('已清空你名下的标注、高亮与对齐页', false);
      });
    }

    /* 按高亮生成对齐页：原按钮监听绑定旧函数，替换节点 */
    var btnNew = $('btnNewPage');
    if (btnNew) {
      var n2 = btnNew.cloneNode(true);
      btnNew.replaceWith(n2);
      n2.addEventListener('click', function () { newPageFromHL(); });
    }

    /* 对齐页标题/说明编辑 → 云端 */
    var phNameEl = $('phName'), phDescEl = $('phDesc');
    if (phNameEl) {
      var saveName = debounce(function () {
        var pg = pageById(CUR_PAGE); if (!pg || !canEditPage(pg)) return;
        updatePage(pg);
      }, 700);
      phNameEl.addEventListener('input', saveName);
      phNameEl.addEventListener('blur', function () {
        var pg = pageById(CUR_PAGE); if (!pg || !canEditPage(pg)) return;
        updatePage(pg);
      });
    }
    if (phDescEl) {
      var saveDesc = debounce(function () {
        var pg = pageById(CUR_PAGE); if (!pg || !canEditPage(pg)) return;
        updatePage(pg);
      }, 700);
      phDescEl.addEventListener('input', saveDesc);
      phDescEl.addEventListener('blur', function () {
        var pg = pageById(CUR_PAGE); if (!pg || !canEditPage(pg)) return;
        updatePage(pg);
      });
    }
  }

  /* ================= 启动 ================= */
  async function boot() {
    injectDom();
    installOverrides();
    paintStatus();
    if (!window.supabase || !CFG.url || !CFG.anonKey) {
      cloud.status = 'off'; paintStatus();
      console.warn('[MMCloud] 缺少 Supabase SDK 或配置');
      return;
    }
    cloud.client = window.supabase.createClient(CFG.url, CFG.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    try {
      var s = await ensureSession();
      if (!s.ok) { cloud.status = 'off'; paintStatus(); toast(s.error, false); return; }
      cloud.uid = s.uid;
      var mem = await fetchMember(cloud.uid);
      if (mem) {
        cloud.me = cloud.uid;
        cloud.myName = mem.nickname;
        cloud.members[mem.id] = mem.nickname;
        localStorage.setItem(cloud.nickKey, mem.nickname);
        touchMember();
      } else {
        var saved = localStorage.getItem(cloud.nickKey) || '';
        if (saved) {
          var rr = await registerNick(saved);
          if (!rr.ok) {
            localStorage.removeItem(cloud.nickKey);
            showNickModal('register', '', rr.error || '');
          }
        } else {
          var guestWanted = false;
          try { guestWanted = localStorage.getItem('mm_guest') === '1'; } catch (e) {}
          if (!guestWanted) showNickModal('register', '', '');
        }
      }
      await loadSnapshot();
      rebuild();
      refreshAll({ drawer: false });
      subscribe();
      subscribePresence();
      paintStatus();
      if (cloud.myName) maybeMigrate();
    } catch (e) {
      console.error('[MMCloud] boot error', e);
      cloud.status = 'off'; paintStatus();
      toast('云端连接失败：' + (e && e.message || e), false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
