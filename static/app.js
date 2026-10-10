/* ============== 名片宝 · 前端 ============== */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ---------- 会话（token）---------- */
let ME = null;                       // 当前登录用户
const TOKEN_KEY = 'cr_token';
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = t => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

function authHeaders(extra){
  const h = Object.assign({'Content-Type':'application/json'}, extra||{});
  const t = getToken();
  if(t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
function api(u, opt){
  opt = opt || {};
  opt.headers = authHeaders(opt.headers);
  return fetch(u, opt).then(r => {
    if(r.status === 401){ handleUnauthorized(); return Promise.reject(r); }
    return r.ok ? r.json() : Promise.reject(r);
  });
}
function handleUnauthorized(){
  setToken('');
  ME = null;
  showGate();
  toast('登录已过期，请重新登录');
}

let lastImage = "";   // 当前名片图文件名
let lastReport = null;
let lastSavedId = null;

/* ---------- 角色判定 ---------- */
const isAdmin = () => !!(ME && ME.role === 'admin');

/* ---------- 侧栏 / 路由 ---------- */
function toggleSidebar(){ if(window.innerWidth<=820){ closeSidebar(); } else { $('#sidebar').classList.toggle('collapsed'); } }
function openSidebar(){ const s=$('#sidebar'); s.classList.remove('collapsed'); s.classList.add('open'); $('#sbOverlay').classList.add('show'); }
function closeSidebar(){ $('#sidebar').classList.remove('open'); $('#sbOverlay').classList.remove('show'); }
window.addEventListener('resize', ()=>{ if(window.innerWidth>820) closeSidebar(); });

function renderSidebarUser(){
  const host = $('#sbUser');
  if(!host) return;
  if(!ME){ host.innerHTML=''; return; }
  const initial = (ME.display_name||ME.username||'?').trim().charAt(0).toUpperCase();
  const roleTxt = isAdmin() ? '管理员' : '普通用户';
  host.innerHTML = `
    <div class="sb-avatar">${esc(initial)}</div>
    <div class="sb-user-txt"><b>${esc(ME.display_name||ME.username)}</b><span>${roleTxt} · @${esc(ME.username)}</span></div>
    <button class="sb-logout" title="退出登录" onclick="doLogout()">⎋</button>`;
}

function applyRoleUI(){
  $$('.admin-only').forEach(el => el.style.display = isAdmin() ? '' : 'none');
  renderSidebarUser();
}

function go(view){
  // 权限保护：非管理员不能进入后台相关视图
  if((view==='admin' || view==='settings') && !isAdmin()){ toast('需要管理员权限'); view='entry'; }
  $$('.sb-link').forEach(l => l.classList.remove('active'));
  const nav = $('#nav-'+view); if(nav) nav.classList.add('active');
  ['entry','library','settings','admin'].forEach(v=>{
    const el = $('#view-'+v); if(el) el.style.display = v===view ? '' : 'none';
  });
  if(view==='entry'){ $('#tb-title').textContent='名片宝'; $('#tb-sub').textContent=''; renderHelpBtn(); renderEntry(); }
  else if(view==='library'){ $('#tb-title').textContent='客户库'; $('#tb-sub').textContent='所有调研过的客户，可筛选、批量导出'; renderHelpBtn(); renderLibrary(); }
  else if(view==='settings'){ $('#tb-title').textContent='API 设置'; $('#tb-sub').textContent='配置 API Key（即时生效，无需重启）'; renderHelpBtn(); renderSettings(); }
  else { $('#tb-title').textContent='账户管理'; $('#tb-sub').textContent='用户账号与角色权限'; renderHelpBtn(); renderAdmin(); }
  if(window.innerWidth<=820) closeSidebar();
}

// 右上角「应用说明」问号按钮（视图切换后重建，保持始终存在）
function renderHelpBtn(){
  const host = $('#tb-actions'); if(!host) return;
  const wasOpen = $('#helpPop') && $('#helpPop').style.display !== 'none';
  host.innerHTML = '<button class="help-btn' + (wasOpen?' active':'') + '" id="helpBtn" onclick="toggleHelp()" aria-label="应用说明" title="应用说明">?</button>';
}

/* ---------- Toast / Lightbox ---------- */
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }
function lightbox(src){ const h=$('#lightbox-host'); h.innerHTML=`<div class="lightbox" onclick="this.remove()"><button class="lb-close" onclick="this.closest('.lightbox').remove()">✕</button><img src="${esc(src)}"></div>`; }

/* ---------- 应用说明（右上角 ? 开关） ---------- */
function toggleHelp(force){
  const pop = $('#helpPop'), btn = $('#helpBtn');
  const open = (typeof force==='boolean') ? force : pop.style.display==='none';
  pop.style.display = open ? 'block' : 'none';
  pop.classList.toggle('show', open);
  if(btn) btn.classList.toggle('active', open);
}
// 点击弹层外部 / 按 Esc 关闭
document.addEventListener('click', e=>{
  const pop = $('#helpPop'); if(!pop || pop.style.display==='none') return;
  if(!pop.contains(e.target) && !e.target.closest('#helpBtn')) toggleHelp(false);
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') toggleHelp(false); });

/* ---------- 录入视图（名片 → OCR → 调研，三步各自独立）---------- */
let currentCardId = null;     // 当前选中的名片 id
let currentCard = null;       // 当前选中的名片对象

function renderEntry(){
  $('#view-entry').innerHTML = `
  <div class="steps">
    <div class="step"><span class="num">1</span><span class="stxt">上传名片</span></div>
    <div class="step-arrow">→</div>
    <div class="step"><span class="num">2</span><span class="stxt">OCR 识别</span></div>
    <div class="step-arrow">→</div>
    <div class="step"><span class="num">3</span><span class="stxt">AI 调研</span></div>
  </div>
  <div class="two-col">
    <div class="stack">
      <div class="glass">
        <div class="card-title">📇 名片夹 <span class="title-hint">上传即保存到本账号</span></div>
        <div class="dropzone" id="dz" onclick="$('#file').click()">
          <div class="dz-ic">📇</div>
          <div class="dz-t">点击或拖拽名片照片</div>
          <div class="dz-s">JPG · PNG · 支持手机拍照</div>
        </div>
        <input type="file" id="file" accept="image/*" style="display:none">
        <div id="imgBox"></div>
        <div class="card-strip" id="cardStrip"></div>
      </div>
    </div>

    <div class="glass">
      <div class="card-title">📝 基本信息 <span class="title-hint" id="formHint">可先上传名片 OCR 预填，也可直接输入名称调研</span></div>
      <div class="form-grid">
        <div class="form-row"><label>客户/公司名称 <span class="req">*</span></label><input id="f_company" placeholder="如 Dollar Tree"></div>
        <div class="form-row"><label>国家/地区 <span class="req">*</span></label><input id="f_country" placeholder="如 美国"></div>
        <div class="form-row"><label>联系人</label><input id="f_contact" placeholder="名片上的人名"></div>
        <div class="form-row"><label>职位</label><input id="f_title" placeholder="如 Purchasing Manager"></div>
        <div class="form-row"><label>电话</label><input id="f_phone" placeholder=""></div>
        <div class="form-row"><label>邮箱</label><input id="f_email" placeholder=""></div>
        <div class="form-row"><label>网站</label><input id="f_website" placeholder=""></div>
        <div class="form-row"><label>地址</label><input id="f_address" placeholder=""></div>
        <div class="form-row full"><label>我们的产品品类 <span class="req">*</span></label><input id="f_category" placeholder="如 家居收纳、厨房小工具"></div>
        <div class="form-row full"><label>展会 / 展位 / 补充线索</label><input id="f_notes" placeholder="如 2026 广交会 A区12展位，线上渠道为主"></div>
        <div class="form-row full"><label>标签（逗号分隔）</label><input id="f_tags" placeholder="如 重点,家居,欧美"></div>
      </div>
      <div class="entry-actions">
        <button class="btn btn-primary" id="researchBtn" onclick="doResearch()">🔍 开始 AI 调研</button>
        <button class="btn btn-ghost" id="ocrBtn" onclick="runOcr()" style="display:none">🔎 重新识别（OCR）</button>
        <button class="btn btn-ghost" onclick="resetEntry()">↺ 清空重来</button>
      </div>
      <div class="entry-meta"><span class="quota-pill" id="quotaPill"></span></div>
    </div>
  </div>
  <div id="reportHost"></div>`;

  // 上传交互
  const dz = $('#dz'), file = $('#file');
  ['dragover','dragenter'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop', ev=>{ if(ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]); });
  file.addEventListener('change', ev=>{ if(ev.target.files[0]) handleFile(ev.target.files[0]); });

  loadCards();
  loadQuota();
}

/* —— 名片夹：列出本账号已保存的名片 —— */
function loadCards(){
  api('/api/cards').then(rows=>{
    const host = $('#cardStrip'); if(!host) return;
    if(!rows.length){ host.innerHTML = `<div class="strip-empty">还没有名片，上传一张即自动存入名片夹</div>`; return; }
    host.innerHTML = `<div class="strip-title">已存名片 · ${rows.length}</div><div class="strip-grid">${rows.map(cardChip).join('')}</div>`;
  }).catch(()=>{});
}

function cardChip(c){
  const linked = c.customer;
  const active = c.id===currentCardId;
  const ocrTag = c.ocr_json ? `<span class="cchip-tag ocr">已识别</span>` : ``;
  return `<div class="cchip ${active?'active':''}" onclick="selectCard(${c.id})" title="${esc(c.original_name||('名片 #'+c.id))}">
    <img src="/uploads/${esc(c.filename)}" loading="lazy" alt="名片">
    <div class="cchip-meta">
      <span class="cchip-no">CR-${String(c.id).padStart(4,'0')}</span>
      ${linked?`<span class="cchip-tag ok" onclick="event.stopPropagation();viewCustomer(${linked.id})" title="查看调研报告">已调研</span>`:`<span class="cchip-tag">待调研</span>`}${ocrTag}
    </div>
    <button class="cchip-del" title="删除名片" onclick="event.stopPropagation();delCard(${c.id})">✕</button>
  </div>`;
}

function selectCard(id){
  api('/api/cards/'+id).then(c=>{
    currentCardId = c.id; currentCard = c;
    lastImage = c.filename;
    // 回填 OCR 结果（若有）
    if(c.ocr_json) fillFormFromFields(c.ocr_json);
    $('#imgBox').innerHTML = `<div class="img-preview"><img src="/uploads/${esc(c.filename)}"><div class="meta">已选中名片 CR-${String(c.id).padStart(4,'0')}（可重新识别或直接调研）</div></div>`;
    $('#ocrBtn').style.display = '';
    const hint = $('#formHint'); if(hint) hint.textContent = c.ocr_json ? '已载入该名片的 OCR 结果，可修改' : '该名片尚未识别，点「重新识别（OCR）」';
    // 高亮
    $$('.cchip').forEach(el=>el.classList.remove('active'));
    loadCards();
    toast('已选名片 CR-'+String(c.id).padStart(4,'0'));
  }).catch(()=>toast('加载名片失败'));
}

function delCard(id){
  if(!confirm('确认删除这张名片？（已生成的调研客户不会被删除）')) return;
  api('/api/cards/'+id, {method:'DELETE'}).then(()=>{
    if(currentCardId===id){ currentCardId=null; currentCard=null; $('#imgBox').innerHTML=''; const o=$('#ocrBtn'); if(o) o.style.display='none'; }
    toast('名片已删除'); loadCards();
  }).catch(()=>toast('删除失败'));
}

/* —— OCR（独立功能，前提是已有名片）—— */
function runOcr(){
  if(!currentCardId){ toast('请先上传或选择一张名片'); return; }
  const btn = $('#ocrBtn'); if(btn) btn.disabled = true;
  $('#imgBox').innerHTML = `<div class="img-preview"><img src="/uploads/${esc(currentCard.filename)}"><div class="meta">识别中…</div></div>`;
  api('/api/cards/'+currentCardId+'/ocr', {method:'POST'})
    .then(d=>{
      if(d.warn) toast(d.warn);
      fillFormFromFields(d.fields||{});
      currentCard.ocr_json = d.fields||{};
      $('#imgBox').innerHTML = `<div class="img-preview"><img src="/uploads/${esc(currentCard.filename)}"><div class="meta">识别完成 · 请核对并修正客户名</div></div>`;
      const hint=$('#formHint'); if(hint) hint.textContent='已载入 OCR 结果，可修改';
      loadCards();
    })
    .catch(()=>toast('OCR 失败，可手动填写'))
    .finally(()=>{ if(btn) btn.disabled=false; });
}

function fillFormFromFields(f2){
  const set=(id,v)=>{ const el=$('#'+id); if(el && v) el.value=v; };
  set('f_company', f2.company); set('f_contact', f2.contact_name); set('f_title', f2.title);
  set('f_country', f2.country); set('f_phone', f2.phone); set('f_email', f2.email);
  set('f_website', f2.website); set('f_address', f2.address);
}

/* ---------- API 设置（仅管理员可访问）---------- */
function renderSettings(){
  renderSettingsInto('#view-settings');
}

function renderSettingsInto(sel){
  const host = document.querySelector(sel);
  if(!host) return;
  host.innerHTML = `
  <div class="glass">
    <div class="card-title">⚙️ API 配置</div>
    <div class="note note-info" style="margin-bottom:14px">密钥仅存储于服务端 config.json，页面以掩码显示，绝不外泄。修改后即时生效，无需重启容器。</div>
    <div class="form-grid">
      <div class="form-row full"><label>DeepSeek API Key（调研文本生成 · 必填）</label><input id="s_deepseek" placeholder="填入 DeepSeek Key"></div>
      <div class="form-row"><label>视觉模型 Provider</label>
        <select id="s_vprovider">
          <option value="openai">OpenAI 兼容</option>
          <option value="qwen">通义千问 VL（免费推荐）</option>
          <option value="kimi">Kimi 视觉（免费）</option>
          <option value="ollama">本地 Ollama（离线）</option>
        </select></div>
      <div class="form-row"><label>视觉 API Key（名片 OCR · 选填）</label><input id="s_vkey" placeholder="选填，填了 OCR 更准"></div>
      <div class="form-row full"><label>搜索源 Provider</label>
        <select id="s_sprovider">
          <option value="ddg">DuckDuckGo（免 Key）</option>
          <option value="serper">Serper（图片+视频墙）</option>
          <option value="brave">Brave Search</option>
          <option value="tavily">Tavily</option>
        </select></div>
      <div class="form-row"><label>Serper Key</label><input id="s_serper" placeholder="选填"></div>
      <div class="form-row"><label>Tavily Key</label><input id="s_tavily" placeholder="选填"></div>
      <div class="form-row"><label>Brave Key</label><input id="s_brave" placeholder="选填"></div>
      <div class="form-row"><label>调研并发数（同时执行任务数，改后需重启生效）</label><input id="s_concurrency" type="number" min="1" max="16" placeholder="默认 2"></div>
      <div class="form-row"><label>每账号每日调研配额（0 = 不限）</label><input id="s_quota" type="number" min="0" placeholder="默认 10"></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="saveSettings()">💾 保存配置</button>
      <button class="btn btn-ghost" onclick="loadSettings(${JSON.stringify(sel)})">↺ 重新载入</button>
    </div>
    <div id="cfgStatus" class="cfg-status"></div>
  </div>`;
  loadSettings(sel);
}

function loadSettings(sel){
  api('/api/config').then(d=>{
    $('#s_vprovider').value = d.vision_provider || 'openai';
    $('#s_sprovider').value = d.search_provider || 'ddg';
    $('#s_deepseek').placeholder = d.deepseek_api_key ? ('当前已配置（'+d.deepseek_api_key+'）· 留空保留') : '必填 · 填入 DeepSeek Key';
    $('#s_vkey').placeholder = d.vision_api_key ? ('当前已配置（'+d.vision_api_key+'）· 留空保留') : '选填 · 填入视觉 Key';
    $('#s_serper').placeholder = d.serper_api_key ? ('当前已配置（'+d.serper_api_key+'）· 留空保留') : '选填 · 填入 Serper Key';
    $('#s_tavily').placeholder = d.tavily_api_key ? ('当前已配置（'+d.tavily_api_key+'）· 留空保留') : '选填 · 填入 Tavily Key';
    $('#s_brave').placeholder = d.brave_api_key ? ('当前已配置（'+d.brave_api_key+'）· 留空保留') : '选填 · 填入 Brave Key';
    if($('#s_concurrency')) $('#s_concurrency').value = d.research_concurrency ?? '';
    if($('#s_quota')) $('#s_quota').value = d.daily_quota ?? '';
  }).catch(()=>{ /* 非管理员或读取失败时不打扰 */ });
}

function saveSettings(){
  const payload = {
    deepseek_api_key: $('#s_deepseek').value.trim(),
    vision_provider: $('#s_vprovider').value,
    vision_api_key: $('#s_vkey').value.trim(),
    vision_base_url: '',
    vision_model: '',
    search_provider: $('#s_sprovider').value,
    serper_api_key: $('#s_serper').value.trim(),
    brave_api_key: $('#s_brave').value.trim(),
    tavily_api_key: $('#s_tavily').value.trim(),
    research_concurrency: $('#s_concurrency') ? $('#s_concurrency').value.trim() : '',
    daily_quota: $('#s_quota') ? $('#s_quota').value.trim() : '',
  };
  $('#cfgStatus').innerHTML = '<span style="color:var(--text-weak)">保存中…</span>';
  api('/api/config', {method:'PUT', body: JSON.stringify(payload)})
    .then(d=>{
      $('#cfgStatus').innerHTML = '<span style="color:var(--success)">✅ 已保存并即时生效。DeepSeek: '+(d.deepseek?'已配置':'未配置')+' · 视觉: '+(d.vision?'已配置':'未配置')+' · 搜索源: '+d.search_provider+'</span>';
      toast('配置已保存');
    })
    .catch(async e=>{ let m='保存失败'; try{ m=(await e.json()).detail||m; }catch{} $('#cfgStatus').innerHTML = '<span style="color:var(--danger)">'+esc(m)+'</span>'; });
}

function handleFile(f){
  if(!f.type.startsWith('image/')){ toast('请上传图片文件'); return; }
  const fd = new FormData(); fd.append('file', f);
  $('#imgBox').innerHTML = `<div class="img-preview"><img src="${URL.createObjectURL(f)}"><div class="meta">保存名片中…</div></div>`;
  // 功能 1：存名片（落盘 + 入库，按账号分目录）
  fetch('/api/cards', {method:'POST', body: fd, headers:{'Authorization':'Bearer '+getToken()}})
    .then(r=>{ if(r.status===401){ handleUnauthorized(); return Promise.reject(r); } return r.json(); })
    .then(d=>{
      if(!d.card){ toast('名片保存失败'); return; }
      currentCardId = d.card.id; currentCard = d.card; lastImage = d.card.filename;
      $('#ocrBtn').style.display = '';
      $('#imgBox').innerHTML = `<div class="img-preview"><img src="/uploads/${esc(lastImage)}"><div class="meta">名片已保存 CR-${String(currentCardId).padStart(4,'0')} · 识别中…</div></div>`;
      loadCards();
      // 功能 2：自动 OCR（可再手动重试）
      return runOcr();
    })
    .catch(e=>{ console.error(e); $('#imgBox').innerHTML=`<div class="meta" style="color:var(--danger)">名片保存失败，可重试</div>`; toast('名片保存失败'); });
}

function collectForm(){
  return {
    company: $('#f_company').value.trim(),
    country: $('#f_country').value.trim(),
    contact_name: $('#f_contact').value.trim(),
    title: $('#f_title').value.trim(),
    phone: $('#f_phone').value.trim(),
    email: $('#f_email').value.trim(),
    website: $('#f_website').value.trim(),
    address: $('#f_address').value.trim(),
    category: $('#f_category').value.trim(),
    notes: $('#f_notes').value.trim(),
    tags: $('#f_tags').value.trim(),
    card_image: lastImage,
    card_id: currentCardId || null,
  };
}

/* —— 功能 3：AI 调研（提交到队列，轮询进度）—— */
let researchPollTimer = null;
function doResearch(){
  const f = collectForm();
  if(!f.company || !f.country || !f.category){ toast('请填写 客户名称 / 国家 / 产品品类'); return; }
  const btn = $('#researchBtn'); if(btn) btn.disabled = true;
  $('#reportHost').innerHTML = `<div class="glass"><div class="progress-wrap"><div class="spinner"></div><p id="jobMsg">正在提交调研任务…</p></div></div>`;
  $('#reportHost').scrollIntoView({behavior:'smooth'});
  api('/api/research', {method:'POST', body: JSON.stringify(f)})
    .then(d=>{
      toast('已进入调研队列：'+(d.position>1?('前面还有 '+(d.position-1)+' 个任务'):'即将开始'));
      pollJob(d.job_id);
    })
    .catch(async e=>{
      let msg='提交失败';
      try{ const b=await e.json(); msg=b.detail||msg; }catch{}
      $('#reportHost').innerHTML=`<div class="glass"><div class="note note-warn">${esc(msg)}</div></div>`;
      toast(msg); if(btn) btn.disabled=false;
    });
}

function pollJob(jobId){
  clearTimeout(researchPollTimer);
  const tick = ()=>{
    api('/api/research/jobs/'+jobId).then(j=>{
      const msg = $('#jobMsg');
      if(j.status==='queued'){
        if(msg) msg.textContent = j.position>1 ? `排队中：前面还有 ${j.position-1} 个任务…` : '排队中：即将开始…';
        researchPollTimer = setTimeout(tick, 2500);
      } else if(j.status==='running'){
        if(msg) msg.textContent = '正在搜索公开资料并调用 AI 生成报告，约 20–60 秒…';
        researchPollTimer = setTimeout(tick, 2500);
      } else if(j.status==='done'){
        const res = j.result||{};
        lastSavedId = res.customer_id || null;
        renderReport({report: res.report, images: res.images||[], videos: res.videos||[]});
        toast('调研完成，已存入客户库');
        const btn=$('#researchBtn'); if(btn) btn.disabled=false;
        loadCards(); loadQuota();
      } else {
        $('#reportHost').innerHTML=`<div class="glass"><div class="note note-warn">${esc(j.error||'调研失败')}</div></div>`;
        toast('调研失败'); const btn=$('#researchBtn'); if(btn) btn.disabled=false;
      }
    }).catch(()=>{ researchPollTimer = setTimeout(tick, 3000); });
  };
  tick();
}

/* —— 每日配额 —— */
function loadQuota(){
  api('/api/quota').then(q=>{
    const el = $('#quotaPill'); if(!el) return;
    if(!q.limit){ el.textContent = '今日调研不限量'; el.className='quota-pill'; return; }
    const left = q.remaining;
    el.textContent = `今日调研配额 ${q.used}/${q.limit}`;
    el.className = 'quota-pill' + (left<=0 ? ' out' : left<=2 ? ' low' : '');
  }).catch(()=>{});
}

function mdToHtml(md){
  if(!md) return '<p style="color:var(--text-weak)">（无内容）</p>';
  let h = esc(md)
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/^####?\s+(.*)/gm,'<h4>$1</h4>')
    .replace(/^[-*]\s+(.*)/gm,'<li>$1</li>')
    .replace(/\[未查到公开信息\]/g,'<span class="tag-red">[未查到公开信息]</span>')
    .replace(/\[推测\]/g,'<span class="tag-yellow">[推测]</span>');
  h = h.replace(/(<li>.*?<\/li>\n?)+/gs, m=>'<ul>'+m+'</ul>');
  h = h.replace(/\n\n+/g,'</p><p>');
  return '<p>'+h+'</p>'.replace(/<p>\s*<\/p>/g,'').replace(/<p>\s*<ul>/g,'<ul>').replace(/<\/ul>\s*<\/p>/g,'</ul>').replace(/<p>\s*<h4>/g,'<h4>').replace(/<\/h4>\s*<\/p>/g,'</h4>');
}

function matchClass(s){ return s==='高'?'match-high':s==='低'?'match-low':'match-medium'; }

function renderReport(d){
  const r = d.report; lastReport = d;
  const info = d.report;
  const imgs = d.images||[], vids = d.videos||[];
  const f = collectForm();
  let secHtml = (r.sections||[]).map(s=>{
    const empty = !s.content || !s.content.trim();
    return `<div class="section${empty?' sec-empty':''}">
      <div class="sec-hd" onclick="const bd=this.nextElementSibling; bd.classList.toggle('off'); this.querySelector('.arr').textContent=bd.classList.contains('off')?'▶':'▼';">
        <span>${s.icon||'📄'}</span><h3>${esc(s.title)}</h3>${empty?'<span class="sec-na">暂无</span>':''}<span class="arr">▼</span>
      </div>
      <div class="sec-bd">${empty?'<span class="sec-na-txt">未检索到相关信息</span>':mdToHtml(s.content)}</div>
    </div>`;
  }).join('');
  let media = '';
  if(imgs.length){ media += `<div class="media-sec"><h4>🖼️ 相关图片 · ${imgs.length}（来自公开搜索）</h4><div class="gallery">${imgs.map(i=>`<img src="${esc(i.url)}" onclick="lightbox('${esc(i.url)}')" title="${esc(i.title)}" loading="lazy">`).join('')}</div></div>`; }
  if(vids.length){ media += `<div class="media-sec"><h4>🎬 相关视频 · ${vids.length}</h4><div class="vid-grid">${vids.map(v=>`<div class="vid-card"><a href="${esc(v.url)}" target="_blank" rel="noopener"><div class="thumb" style="background-image:url('${esc(v.thumbnail)}')"><div class="play">▶</div></div><div class="vt">${esc(v.title)}<br><span style="color:var(--text-weak);font-size:11px">${esc(v.source)}</span></div></a></div>`).join('')}</div></div>`; }

  const filled = (r.sections||[]).filter(s=>s.content && s.content.trim()).length;
  const total = (r.sections||[]).length;

  $('#reportHost').innerHTML = `
  <div class="rptcard">
    <div class="rpt-head">
      <div>
        <h2>📋 ${esc(f.company||'客户')} · 调研报告</h2>
        <div class="meta">${esc(f.country)} · ${esc(f.category)} · ${new Date().toLocaleString('zh-CN')} ${lastSavedId?`· 档案 CR-${String(lastSavedId).padStart(4,'0')}`:''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="badge ${matchClass(r.match_score)}">匹配度：${esc(r.match_score)}</span>
        <button class="btn btn-sm btn-ghost" onclick="window.print()">🖨️ 打印/PDF</button>
        <button class="btn btn-sm btn-ghost" onclick="go('library')">🗂️ 去客户库</button>
        <button class="btn btn-sm btn-ghost" onclick="resetEntry()">🔄 新调研</button>
      </div>
    </div>
    ${rptSummaryHTML(r)}
    <div class="rpt-body">
      <div class="rpt-bar">
        <div class="rpt-bar-l"><span class="rpt-bar-n">${filled}/${total} 个维度有内容</span></div>
        <div class="rpt-bar-r">
          <button class="btn btn-sm btn-ghost" onclick="rptToggleAll(true)">全部展开</button>
          <button class="btn btn-sm btn-ghost" onclick="rptToggleAll(false)">全部折叠</button>
        </div>
      </div>
      ${secHtml}
      ${r.recommendation?`<div class="section"><div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')"><span>🎯</span><h3>开发切入建议</h3><span class="arr">▼</span></div><div class="sec-bd">${mdToHtml(r.recommendation)}</div></div>`:''}
      ${r.risks?`<div class="section"><div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')"><span>⚠️</span><h3>潜在风险</h3><span class="arr">▼</span></div><div class="sec-bd">${mdToHtml(r.risks)}</div></div>`:''}
      ${media}
    </div>
    ${r.search_note?`<div class="note note-warn" style="margin:16px 0 0">${esc(r.search_note)}</div>`:''}
    <div class="rpt-disclaimer">⚠️ 报告由 AI 基于公开信息生成，标注 [推测] / [未查到公开信息] 处请进一步核实，重要决策以实地确认为准。</div>
  </div>`;
  $('#reportHost').scrollIntoView({behavior:'smooth'});
}

function resetEntry(){ lastImage=''; lastReport=null; lastSavedId=null; currentCardId=null; currentCard=null; clearTimeout(researchPollTimer); renderEntry(); }

/* ---------- 客户库 ---------- */
let libFilter = {q:'', status:'', country:'', scope:''};
function renderLibrary(){
  $('#view-library').innerHTML = `
  <div class="lib-stats" id="libStats"></div>
  <div class="lib-bar">
    <div class="search lib-search"><span class="si">🔍</span><input id="libSearch" placeholder="搜索公司 / 联系人 / 邮箱" oninput="debounceLib()"></div>
    <select class="status-select" id="libStatus" onchange="libFilter.status=this.value; loadLib()">
      <option value="">全部状态</option><option value="new">新建</option><option value="researched">已调研</option><option value="contacted">已联系</option><option value="deal">商机</option>
    </select>
    ${isAdmin()?`<select class="status-select" id="libScope" onchange="libFilter.scope=this.value; loadLib()">
      <option value="">全部客户（团队）</option><option value="mine">仅我的客户</option>
    </select>`:''}
    <div class="view-toggle" id="libViewToggle">
      <button class="vt-btn active" data-v="card" onclick="setLibView('card')" title="卡片视图">▦</button>
      <button class="vt-btn" data-v="table" onclick="setLibView('table')" title="列表视图">☰</button>
    </div>
    <div class="lib-bar-right">
      <div class="exp-menu">
        <button class="btn btn-sm btn-ghost" onclick="toggleExpMenu(event)">⬇️ 导出 ▾</button>
        <div class="exp-pop" id="expPop">
          <button onclick="exportLib('csv'); toggleExpMenu()">CSV 表格</button>
          <button onclick="exportLib('excel'); toggleExpMenu()">Excel 工作簿</button>
          <button onclick="exportLib('json'); toggleExpMenu()">JSON 数据</button>
        </div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="go('entry')">＋ 新建调研</button>
    </div>
  </div>
  <div id="libHost"><div class="empty"><div class="e-ic">⏳</div>加载中…</div></div>`;
  loadLib();
}
let libTimer;
function debounceLib(){ clearTimeout(libTimer); libTimer=setTimeout(()=>{ libFilter.q=$('#libSearch').value.trim(); loadLib(); }, 300); }

let libData = [];
let libView = localStorage.getItem('cr_libview') || 'card';

function setLibView(v){
  libView = v; localStorage.setItem('cr_libview', v);
  $$('#libViewToggle .vt-btn').forEach(b=>b.classList.toggle('active', b.dataset.v===v));
  paintLib();
}

function toggleExpMenu(e){
  if(e) e.stopPropagation();
  const p = $('#expPop'); if(p) p.classList.toggle('show');
}
document.addEventListener('click', ()=>{ const p=$('#expPop'); if(p) p.classList.remove('show'); });

function loadLib(){
  const p = new URLSearchParams(libFilter).toString();
  const host = $('#libHost');
  api('/api/customers?'+p).then(rows=>{
    libData = rows;
    renderLibStats(rows);
    if(!rows.length){
      host.innerHTML = `<div class="empty-lg"><div class="e-ic">🗂️</div>
        <div class="e-t">暂无客户档案</div>
        <div class="e-s">去「名片宝」上传一张名片，即可自动生成客户档案与调研报告</div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="go('entry')">＋ 新建调研</button></div>`;
      return;
    }
    paintLib();
  }).catch(()=>{ host.innerHTML = `<div class="empty"><div class="e-ic">⚠️</div>加载失败，请刷新重试</div>`; });
}

function renderLibStats(rows){
  const total = rows.length;
  const cnt = s => rows.filter(r=>r.status===s).length;
  const high = rows.filter(r=>String(r.match_score||'').includes('高')).length;
  const el = $('#libStats'); if(!el) return;
  el.innerHTML = `
    <div class="ls-card"><div class="ls-v">${total}</div><div class="ls-k">客户总数</div></div>
    <div class="ls-card"><div class="ls-v" style="color:#4f6ef7">${cnt('researched')}</div><div class="ls-k">已调研</div></div>
    <div class="ls-card"><div class="ls-v" style="color:#16a34a">${cnt('contacted')}</div><div class="ls-k">已联系</div></div>
    <div class="ls-card"><div class="ls-v" style="color:#b45309">${cnt('deal')}</div><div class="ls-k">商机</div></div>
    <div class="ls-card"><div class="ls-v" style="color:#e11d48">${high}</div><div class="ls-k">高匹配</div></div>`;
}

function paintLib(){
  const host = $('#libHost'); if(!host) return;
  if(!libData.length) return;
  host.innerHTML = libView==='card' ? libCardHTML() : libTableHTML();
}

/* —— 卡片视图：整齐的客户档案卡 —— */
function libCardHTML(){
  return `<div class="cust-grid">${libData.map(custCard).join('')}</div>`;
}
function custCard(r){
  const name = r.company || '未命名客户';
  const initial = (name||'?').trim().charAt(0).toUpperCase();
  const hasReport = !!(r.report_json && (r.report_json.sections||[]).some(s=>s.content));
  const tags = (r.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
  const contactLine = [r.contact_name, r.title].filter(Boolean).join(' · ');
  const loc = [r.country, r.category].filter(Boolean).join(' · ');
  return `
  <article class="ccard" onclick="viewCustomer(${r.id})">
    <div class="cc-top">
      <div class="cc-avatar">${esc(initial)}</div>
      <div class="cc-id">
        <h3 class="cc-name" title="${esc(name)}">${esc(name)}</h3>
        <div class="cc-sub">${contactLine?esc(contactLine):'<span class="cc-dim">未填写联系人</span>'}</div>
      </div>
      <span class="badge badge-${r.status} cc-badge">${stLabel(r.status)}</span>
    </div>
    <div class="cc-meta">
      ${loc?`<div class="cc-row"><span class="cc-ic">📍</span>${esc(loc)}</div>`:''}
      ${r.email?`<div class="cc-row"><span class="cc-ic">✉️</span>${esc(r.email)}</div>`:''}
      ${r.phone?`<div class="cc-row"><span class="cc-ic">📞</span>${esc(r.phone)}</div>`:''}
      ${!loc&&!r.email&&!r.phone?`<div class="cc-row cc-dim">暂无联系方式</div>`:''}
    </div>
    ${tags.length?`<div class="cc-tags">${tags.slice(0,4).map(t=>`<span class="cc-tag">${esc(t)}</span>`).join('')}${tags.length>4?`<span class="cc-tag cc-tag-more">+${tags.length-4}</span>`:''}</div>`:''}
    <div class="cc-foot">
      <div class="cc-score">
        ${r.match_score?`<span class="badge ${matchClass(r.match_score)}">匹配 ${esc(r.match_score)}</span>`:`<span class="cc-dim">未评估</span>`}
      </div>
      <div class="cc-flag ${hasReport?'ok':'none'}">${hasReport?'● 已出报告':'○ 待调研'}</div>
    </div>
    <div class="cc-date">更新于 ${esc((r.updated_at||'').slice(0,16))}</div>
    <div class="cc-actions" onclick="event.stopPropagation()">
      <button class="btn btn-sm btn-ghost" onclick="viewCustomer(${r.id})">查看档案</button>
      <button class="btn btn-sm btn-icon btn-ghost" title="删除" onclick="delCustomer(${r.id})">🗑️</button>
    </div>
  </article>`;
}

/* —— 列表视图 —— */
function libTableHTML(){
  return `<div class="glass" style="padding:6px;background:rgba(255,255,255,0.82)">
  <div class="table-wrap"><table class="tbl" id="libTable"><thead><tr>
    <th>客户/公司</th><th>联系人</th><th>国家</th><th>品类</th><th>状态</th><th>匹配度</th><th>更新时间</th><th>操作</th>
  </tr></thead><tbody>
  ${libData.map(r=>`
    <tr onclick="viewCustomer(${r.id})">
      <td data-label="客户/公司"><div class="c-name">${esc(r.company||'—')}</div><div class="c-sub">${esc(r.tags||'')}</div></td>
      <td data-label="联系人">${esc(r.contact_name||'—')}<div class="c-sub">${esc(r.title||'')}</div></td>
      <td data-label="国家">${esc(r.country||'—')}</td>
      <td data-label="品类">${esc(r.category||'—')}</td>
      <td data-label="状态"><select class="status-select" onclick="event.stopPropagation()" onchange="setStatus(${r.id}, this.value)">
        ${['new','researched','contacted','deal'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${stLabel(s)}</option>`).join('')}
      </select></td>
      <td data-label="匹配度">${r.match_score?`<span class="badge ${matchClass(r.match_score)}">${esc(r.match_score)}</span>`:'<span class="c-sub">—</span>'}</td>
      <td data-label="更新"><span class="c-sub">${esc(r.updated_at||'')}</span></td>
      <td data-label="操作"><div class="row-actions" onclick="event.stopPropagation()">
        <button class="btn btn-sm btn-ghost" onclick="viewCustomer(${r.id})">查看</button>
        <button class="btn btn-sm btn-icon btn-ghost" title="删除" onclick="delCustomer(${r.id})">🗑️</button>
      </div></td>
    </tr>`).join('')}
  </tbody></table></div></div>`;
}

function stLabel(s){ return {new:'新建',researched:'已调研',contacted:'已联系',deal:'商机'}[s]||s; }
function setStatus(id, v){ api('/api/customers/'+id, {method:'PUT', body: JSON.stringify({status:v})}).then(()=>{toast('状态已更新');loadLib();}).catch(()=>toast('更新失败')); }
function delCustomer(id){ if(!confirm('确认删除该客户？')) return; api('/api/customers/'+id,{method:'DELETE'}).then(()=>{toast('已删除');loadLib();}).catch(()=>toast('删除失败')); }
function exportLib(fmt){
  const p = new URLSearchParams(libFilter).toString();
  // 带鉴权头下载（window.open 无法携带 Authorization）
  fetch('/api/export?format='+fmt+'&'+p, {headers:{'Authorization':'Bearer '+getToken()}})
    .then(r=>{ if(r.status===401){ handleUnauthorized(); return Promise.reject(r); } return r.blob(); })
    .then(b=>{
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = 'customers.' + (fmt==='excel'?'xlsx':fmt);
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('已导出');
    })
    .catch(()=>toast('导出失败'));
}

function viewCustomer(id){
  api('/api/customers/'+id).then(r=>{
    const report = r.report_json || null;
    const hasReport = !!(report && (report.sections||[]).some(s=>s.content));
    const imgs = r.images_json||[], vids = r.videos_json||[];
    const name = r.company || '未命名客户';
    const initial = (name||'?').trim().charAt(0).toUpperCase();
    const tags = (r.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
    const mediaCount = imgs.length + vids.length;

    const reportTab = hasReport
      ? renderReportHTML(report, imgs, vids, r)
      : `<div class="empty-lg" style="padding:44px 20px"><div class="e-ic">📝</div>
           <div class="e-t">尚未生成 AI 调研报告</div>
           <div class="e-s">可在「名片宝」中对该客户重新发起调研，或先查看基础档案</div></div>`;

    $('#lightbox-host').innerHTML = `
      <div class="lb-scrim" onclick="if(event.target===this)closeProfile()">
        <div class="profile" onclick="event.stopPropagation()">
          <header class="pf-head">
            <div class="pf-avatar">${esc(initial)}</div>
            <div class="pf-id">
              <h2 class="pf-name">${esc(name)}</h2>
              <div class="pf-sub">
                <span class="badge badge-${r.status}">${stLabel(r.status)}</span>
                ${r.match_score?`<span class="badge ${matchClass(r.match_score)}">匹配 ${esc(r.match_score)}</span>`:''}
                <span class="pf-no">档案编号 CR-${String(r.id).padStart(4,'0')}</span>
              </div>
            </div>
            <button class="pf-close" onclick="closeProfile()" aria-label="关闭">✕</button>
          </header>

          <nav class="pf-tabs">
            <button class="pf-tab active" data-t="info" onclick="pfTab('info')">📋 客户档案</button>
            <button class="pf-tab" data-t="report" onclick="pfTab('report')">📊 调研报告${hasReport?'':' · 无'}</button>
            <button class="pf-tab" data-t="media" onclick="pfTab('media')">🖼️ 媒体资料<span class="pf-tab-n">${mediaCount}</span></button>
          </nav>

          <div class="pf-body">
            <section class="pf-pane active" data-p="info">
              ${r.card_image?`<div class="pf-cardimg"><img src="/uploads/${esc(r.card_image)}" onclick="lightbox('/uploads/${esc(r.card_image)}')" alt="名片原图"><div class="pf-cardimg-cap">名片原图 · 点击放大</div></div>`:''}
              ${profileFieldsHTML(r, tags)}
            </section>
            <section class="pf-pane" data-p="report">${reportTab}</section>
            <section class="pf-pane" data-p="media">${mediaHTML(imgs, vids)}</section>
          </div>

          <footer class="pf-foot">
            <div class="pf-foot-l">
              <select class="status-select" onchange="setStatus(${r.id}, this.value)">
                ${['new','researched','contacted','deal'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${stLabel(s)}</option>`).join('')}
              </select>
              <button class="btn btn-sm btn-ghost" onclick="editCustomer(${r.id})">✏️ 编辑档案</button>
            </div>
            <button class="btn btn-sm btn-danger" onclick="delCustomerFromProfile(${r.id})">🗑️ 删除客户</button>
          </footer>
        </div>
      </div>`;
  }).catch(()=>toast('加载失败'));
}

function closeProfile(){ $('#lightbox-host').innerHTML=''; }
function pfTab(t){
  $$('.pf-tab').forEach(b=>b.classList.toggle('active', b.dataset.t===t));
  $$('.pf-pane').forEach(p=>p.classList.toggle('active', p.dataset.p===t));
}
function delCustomerFromProfile(id){
  if(!confirm('确认删除该客户？此操作不可恢复。')) return;
  api('/api/customers/'+id,{method:'DELETE'}).then(()=>{ closeProfile(); toast('已删除'); loadLib(); }).catch(()=>toast('删除失败'));
}

/* 结构化客户档案字段 */
function profileFieldsHTML(r, tags){
  const groups = [
    { title:'联系方式', rows:[
      ['联系人', r.contact_name], ['职位', r.title],
      ['电话', r.phone], ['邮箱', r.email, 'mailto'],
      ['网站', r.website, 'link'], ['地址', r.address],
    ]},
    { title:'业务信息', rows:[
      ['国家 / 地区', r.country], ['产品品类', r.category],
      ['来源', r.source], ['展会 / 展位线索', r.notes],
    ]},
    { title:'档案信息', rows:[
      ['创建时间', r.created_at], ['最近更新', r.updated_at],
    ]},
  ];
  let html = '';
  for(const g of groups){
    const filled = g.rows.filter(([,v])=>v && String(v).trim());
    if(!filled.length) continue;
    html += `<div class="pf-group">
      <div class="pf-group-t">${g.title}</div>
      <div class="pf-fields">
        ${filled.map(([k,v,kind])=>{
          let val = esc(v);
          if(kind==='link') val = `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)} ↗</a>`;
          if(kind==='mailto') val = `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
          return `<div class="pf-field"><div class="pf-fk">${k}</div><div class="pf-fv">${val}</div></div>`;
        }).join('')}
      </div></div>`;
  }
  if(tags.length){
    html += `<div class="pf-group"><div class="pf-group-t">标签</div><div class="pf-tags">${tags.map(t=>`<span class="cc-tag">${esc(t)}</span>`).join('')}</div></div>`;
  }
  return html || `<div class="empty"><div class="e-ic">📋</div>暂无档案信息</div>`;
}

function mediaHTML(imgs, vids){
  if(!imgs.length && !vids.length){
    return `<div class="empty-lg" style="padding:44px 20px"><div class="e-ic">🖼️</div>
      <div class="e-t">暂无媒体资料</div>
      <div class="e-s">配置 Serper 等搜索源后，调研报告会自动附带相关图片与视频</div></div>`;
  }
  let h = '';
  if(imgs.length) h += `<div class="media-sec"><h4>🖼️ 相关图片 · ${imgs.length}</h4><div class="gallery">${imgs.map(i=>`<img src="${esc(i.url)}" onclick="lightbox('${esc(i.url)}')" loading="lazy">`).join('')}</div></div>`;
  if(vids.length) h += `<div class="media-sec"><h4>🎬 相关视频 · ${vids.length}</h4><div class="vid-grid">${vids.map(v=>`<div class="vid-card"><a href="${esc(v.url)}" target="_blank" rel="noopener"><div class="thumb" style="background-image:url('${esc(v.thumbnail)}')"><div class="play">▶</div></div><div class="vt">${esc(v.title)}</div></a></div>`).join('')}</div></div>`;
  return h;
}

/* 编辑客户档案（内联表单） */
function editCustomer(id){
  const r = libData.find(x=>x.id===id) || {};
  const fields = [
    ['company','客户 / 公司名称'], ['country','国家 / 地区'], ['contact_name','联系人'],
    ['title','职位'], ['phone','电话'], ['email','邮箱'], ['website','网站'],
    ['address','地址'], ['category','产品品类'], ['source','来源'],
    ['notes','展会 / 展位 / 线索'], ['tags','标签（逗号分隔）'],
  ];
  $('#lightbox-host').innerHTML = `
    <div class="lb-scrim" onclick="if(event.target===this)closeProfile()">
      <div class="profile" style="max-width:620px" onclick="event.stopPropagation()">
        <header class="pf-head">
          <div class="pf-avatar">✏️</div>
          <div class="pf-id"><h2 class="pf-name">编辑客户档案</h2><div class="pf-sub">CR-${String(id).padStart(4,'0')}</div></div>
          <button class="pf-close" onclick="closeProfile()">✕</button>
        </header>
        <div class="pf-body">
          <div class="form-grid">
            ${fields.map(([k,label])=>`<div class="form-row ${['notes'].includes(k)?'full':''}"><label>${label}</label><input id="ed_${k}" value="${esc(r[k]||'')}"></div>`).join('')}
          </div>
        </div>
        <footer class="pf-foot">
          <button class="btn btn-sm btn-ghost" onclick="closeProfile()">取消</button>
          <button class="btn btn-sm btn-primary" onclick="saveCustomer(${id})">保存修改</button>
        </footer>
      </div>
    </div>`;
}
function saveCustomer(id){
  const body = {};
  ['company','country','contact_name','title','phone','email','website','address','category','source','notes','tags']
    .forEach(k=>{ const el=$('#ed_'+k); if(el) body[k]=el.value.trim(); });
  api('/api/customers/'+id, {method:'PUT', body: JSON.stringify(body)})
    .then(()=>{ toast('已保存'); closeProfile(); loadLib(); })
    .catch(()=>toast('保存失败'));
}

function basicInfoHTML(r){
  const items=[['联系人',r.contact_name],['职位',r.title],['电话',r.phone],['邮箱',r.email],['网站',r.website],['地址',r.address],['品类',r.category],['展会线索',r.notes],['标签',r.tags]];
  return `<div class="form-grid" style="margin:12px 0">${items.map(([k,v])=>`<div class="form-row"><label>${k}</label><div style="font-size:13px;color:var(--text-body);padding:4px 0">${esc(v||'—')}${k==='网站'&&v?` <a href="${esc(v)}" target="_blank" style="color:var(--primary)">↗</a>`:''}</div></div>`).join('')}</div>`;
}
function renderReportHTML(r, imgs, vids, meta){
  const secs = r.sections || [];
  const filled = secs.filter(s=>s.content && s.content.trim());
  let secHtml = secs.map(s=>{
    const empty = !s.content || !s.content.trim();
    return `<div class="section${empty?' sec-empty':''}">
      <div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')">
        <span>${s.icon||'📄'}</span><h3>${esc(s.title)}</h3>
        ${empty?'<span class="sec-na">暂无</span>':''}<span class="arr">▼</span>
      </div>
      <div class="sec-bd">${empty?'<span class="sec-na-txt">未检索到相关信息</span>':mdToHtml(s.content)}</div>
    </div>`;
  }).join('');
  let media='';
  if(imgs&&imgs.length) media+=`<div class="media-sec"><h4>🖼️ 相关图片 · ${imgs.length}</h4><div class="gallery">${imgs.map(i=>`<img src="${esc(i.url)}" onclick="lightbox('${esc(i.url)}')" loading="lazy">`).join('')}</div></div>`;
  if(vids&&vids.length) media+=`<div class="media-sec"><h4>🎬 相关视频 · ${vids.length}</h4><div class="vid-grid">${vids.map(v=>`<div class="vid-card"><a href="${esc(v.url)}" target="_blank" rel="noopener"><div class="thumb" style="background-image:url('${esc(v.thumbnail)}')"><div class="play">▶</div></div><div class="vt">${esc(v.title)}</div></a></div>`).join('')}</div></div>`;

  const bar = `<div class="rpt-bar">
    <div class="rpt-bar-l">
      ${r.match_score?`<span class="badge ${matchClass(r.match_score)}">合作匹配度 ${esc(r.match_score)}</span>`:''}
      <span class="rpt-bar-n">${filled.length}/${secs.length} 个维度有内容</span>
    </div>
    <div class="rpt-bar-r">
      <button class="btn btn-sm btn-ghost" onclick="rptToggleAll(true)">全部展开</button>
      <button class="btn btn-sm btn-ghost" onclick="rptToggleAll(false)">全部折叠</button>
    </div>
  </div>`;

  return `${rptSummaryHTML(r)}
    <div class="rpt-body">${bar}${secHtml}
    ${r.recommendation?`<div class="section"><div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')"><span>🎯</span><h3>开发切入建议</h3><span class="arr">▼</span></div><div class="sec-bd">${mdToHtml(r.recommendation)}</div></div>`:''}
    ${r.risks?`<div class="section"><div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')"><span>⚠️</span><h3>潜在风险</h3><span class="arr">▼</span></div><div class="sec-bd">${mdToHtml(r.risks)}</div></div>`:''}
    ${media}</div>`;
}
function rptToggleAll(open){
  $$('.rpt-body .sec-bd').forEach(b=>b.classList.toggle('off', !open));
}
function rptSummaryHTML(r){
  return `<div class="rpt-hero">
    ${r.summary?`<div class="rpt-hero-sum">📌 ${esc(r.summary)}</div>`:''}
    ${r.match_reason?`<div class="rpt-hero-reason"><b>匹配理由</b>${esc(r.match_reason)}</div>`:''}
  </div>`;
}

/* ================= 登录 / 注册 ================= */
let authMode = 'login';
function showGate(){ const g=$('#authGate'); if(g) g.style.display='flex'; }
function hideGate(){ const g=$('#authGate'); if(g) g.style.display='none'; }

function switchAuth(mode){
  authMode = mode;
  $('#tabLogin').classList.toggle('active', mode==='login');
  $('#tabRegister').classList.toggle('active', mode==='register');
  renderAuthForm();
}

function renderAuthForm(){
  const f = $('#authForm');
  if(authMode==='login'){
    f.innerHTML = `
      <div class="form-row"><label>用户名</label><input id="au_user" placeholder="请输入用户名" autocomplete="username"></div>
      <div class="form-row"><label>密码</label><input id="au_pass" type="password" placeholder="请输入密码" autocomplete="current-password"></div>
      <button class="btn btn-primary auth-submit" onclick="doLogin()">登录</button>
      <div class="auth-hint">还没有账号？<a onclick="switchAuth('register')">立即注册</a></div>`;
  } else {
    f.innerHTML = `
      <div class="form-row"><label>用户名 <span class="req">*</span></label><input id="au_user" placeholder="3-32 位字母/数字/下划线" autocomplete="username"></div>
      <div class="form-row"><label>显示名称</label><input id="au_name" placeholder="如 张三（选填）"></div>
      <div class="form-row"><label>邮箱</label><input id="au_email" placeholder="选填"></div>
      <div class="form-row"><label>密码 <span class="req">*</span></label><input id="au_pass" type="password" placeholder="至少 6 位" autocomplete="new-password"></div>
      <div class="form-row"><label>确认密码 <span class="req">*</span></label><input id="au_pass2" type="password" placeholder="再次输入密码" autocomplete="new-password"></div>
      <button class="btn btn-primary auth-submit" onclick="doRegister()">注册并登录</button>
      <div class="auth-hint">已有账号？<a onclick="switchAuth('login')">去登录</a></div>`;
  }
  const u = $('#au_user'); if(u) u.focus();
}

function authErr(msg){ toast(msg); }

function doLogin(){
  const username = $('#au_user').value.trim();
  const password = $('#au_pass').value;
  if(!username || !password){ authErr('请输入用户名和密码'); return; }
  api('/api/auth/login', {method:'POST', body: JSON.stringify({username, password})})
    .then(d=>{ setToken(d.token); ME = d.user; afterLogin(); })
    .catch(async e=>{ let m='登录失败'; try{ m=(await e.json()).detail||m; }catch{} authErr(m); });
}

function doRegister(){
  const username = $('#au_user').value.trim();
  const password = $('#au_pass').value;
  const password2 = $('#au_pass2').value;
  if(!username || !password){ authErr('请填写用户名和密码'); return; }
  if(password !== password2){ authErr('两次输入的密码不一致'); return; }
  api('/api/auth/register', {method:'POST', body: JSON.stringify({
    username, password, display_name: $('#au_name').value.trim(), email: $('#au_email').value.trim()
  })})
    .then(d=>{ setToken(d.token); ME = d.user; afterLogin(); toast('注册成功，欢迎使用'); })
    .catch(async e=>{ let m='注册失败'; try{ m=(await e.json()).detail||m; }catch{} authErr(m); });
}

function doLogout(){
  api('/api/auth/logout', {method:'POST'}).catch(()=>{}).finally(()=>{
    setToken(''); ME = null; showGate(); switchAuth('login'); toast('已退出登录');
  });
}

function afterLogin(){
  hideGate();
  applyRoleUI();
  go('entry');
}

/* ================= 账户管理（管理员） ================= */
function renderAdmin(){
  $('#view-admin').innerHTML = `
  <div id="adminStats" class="stat-row"></div>
  <div class="glass" style="margin-top:16px">
    <div class="card-title" style="justify-content:space-between">
      <span>👥 用户账号</span>
      <button class="btn btn-sm btn-primary" onclick="openUserForm()">＋ 新增用户</button>
    </div>
    <div class="table-wrap"><table class="tbl" id="userTable"><thead><tr>
      <th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th>
    </tr></thead><tbody><tr><td colspan="5"><div class="empty"><div class="e-ic">⏳</div>加载中…</div></td></tr></tbody></table></div>
  </div>
  <div class="glass" style="margin-top:16px">
    <div class="card-title">🔑 AI / 搜索 API Key</div>
    <div class="note note-info" style="margin-bottom:14px">仅管理员可配置。密钥存储于服务端，页面以掩码显示；保存后即时生效，无需重启容器。</div>
    <div id="adminSettingsHost"></div>
  </div>`;
  loadAdminStats();
  loadUsers();
  renderSettingsInto('#adminSettingsHost');
}

function loadAdminStats(){
  api('/api/admin/stats').then(s=>{
    $('#adminStats').innerHTML = `
      ${statCard('用户总数', s.users)}
      ${statCard('启用账号', s.active_users)}
      ${statCard('管理员', s.admins)}
      ${statCard('客户记录', s.customers)}`;
  }).catch(()=>{});
}
function statCard(label, val){
  return `<div class="stat-card"><div class="sv">${esc(val)}</div><div class="sl">${esc(label)}</div></div>`;
}

function loadUsers(){
  api('/api/admin/users').then(rows=>{
    const tb = $('#userTable tbody');
    if(!tb) return;
    if(!rows.length){ tb.innerHTML=`<tr><td colspan="5"><div class="empty">暂无用户</div></td></tr>`; return; }
    tb.innerHTML = rows.map(u=>`
      <tr>
        <td data-label="用户"><div class="c-name">${esc(u.display_name||u.username)}</div><div class="c-sub">@${esc(u.username)}${u.email?' · '+esc(u.email):''}</div></td>
        <td data-label="角色"><span class="badge ${u.role==='admin'?'role-admin':'role-user'}">${u.role==='admin'?'管理员':'普通用户'}</span></td>
        <td data-label="状态"><span class="badge ${u.active?'st-on':'st-off'}">${u.active?'启用':'已禁用'}</span></td>
        <td data-label="最近登录"><span class="c-sub">${esc(u.last_login||'—')}</span></td>
        <td data-label="操作"><div class="row-actions">
          <button class="btn btn-sm btn-ghost" onclick='openUserForm(${JSON.stringify(u).replace(/'/g,"&#39;")})'>编辑</button>
          <button class="btn btn-sm btn-icon btn-ghost" title="删除" onclick="delUser(${u.id}, '${esc(u.username)}')">🗑️</button>
        </div></td>
      </tr>`).join('');
  }).catch(()=>toast('加载用户失败'));
}

function openUserForm(u){
  u = u || {};
  const editing = !!u.id;
  const body = `
    <div class="form-grid">
      <div class="form-row"><label>用户名 <span class="req">*</span></label><input id="u_username" value="${esc(u.username||'')}" ${editing?'disabled':''} placeholder="登录名"></div>
      <div class="form-row"><label>显示名称</label><input id="u_name" value="${esc(u.display_name||'')}" placeholder="如 张三"></div>
      <div class="form-row"><label>邮箱</label><input id="u_email" value="${esc(u.email||'')}" placeholder="选填"></div>
      <div class="form-row"><label>角色</label><select id="u_role">
        <option value="user" ${u.role!=='admin'?'selected':''}>普通用户</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>管理员</option>
      </select></div>
      <div class="form-row"><label>状态</label><select id="u_active">
        <option value="1" ${u.active===0?'':'selected'}>启用</option>
        <option value="0" ${u.active===0?'selected':''}>禁用</option>
      </select></div>
      <div class="form-row full"><label>${editing?'重置密码（留空则不修改）':'密码'} ${editing?'':'<span class="req">*</span>'}</label><input id="u_pass" type="password" placeholder="${editing?'留空保持原密码':'至少 6 位'}"></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="this.closest('.lightbox').remove()">取消</button>
      <button class="btn btn-primary" onclick="saveUser(${editing?u.id:0})">保存</button>
    </div>`;
  $('#lightbox-host').innerHTML = `
    <div class="lightbox" style="background:rgba(15,23,42,0.5);align-items:flex-start;padding:40px 20px;overflow:auto" onclick="if(event.target===this)this.remove()">
      <div class="glass" style="max-width:560px;width:100%;margin:auto" onclick="event.stopPropagation()">
        <div class="rpt-head"><h2 style="font-size:18px">${editing?'编辑用户':'新增用户'}</h2>
        <button class="btn btn-sm btn-ghost" onclick="this.closest('.lightbox').remove()">✕</button></div>
        ${body}
      </div>
    </div>`;
}

function saveUser(uid){
  const payload = {
    username: $('#u_username') ? $('#u_username').value.trim() : '',
    display_name: $('#u_name').value.trim(),
    email: $('#u_email').value.trim(),
    role: $('#u_role').value,
    active: parseInt($('#u_active').value, 10),
    password: $('#u_pass').value,
  };
  const req = uid
    ? api('/api/admin/users/'+uid, {method:'PUT', body: JSON.stringify(payload)})
    : api('/api/admin/users', {method:'POST', body: JSON.stringify(payload)});
  req.then(()=>{
    const lb = $('.lightbox'); if(lb) lb.remove();
    toast(uid?'已保存':'已创建');
    loadUsers(); loadAdminStats();
  }).catch(async e=>{ let m='保存失败'; try{ m=(await e.json()).detail||m; }catch{} toast(m); });
}

function delUser(id, name){
  if(!confirm('确认删除用户「'+name+'」？该账号将无法登录。')) return;
  api('/api/admin/users/'+id, {method:'DELETE'}).then(()=>{ toast('已删除'); loadUsers(); loadAdminStats(); })
    .catch(async e=>{ let m='删除失败'; try{ m=(await e.json()).detail||m; }catch{} toast(m); });
}

/* ---------- 启动 ---------- */
function boot(){
  if(getToken()){
    api('/api/auth/me').then(d=>{ ME=d.user; applyRoleUI(); hideGate(); go('entry'); })
      .catch(()=>{ setToken(''); showGate(); switchAuth('login'); });
  } else {
    showGate(); switchAuth('login');
  }
}
boot();
