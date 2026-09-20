/* ============== 客户背景调研工具 · 前端 ============== */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const api = (u, opt) => fetch(u, Object.assign({headers:{'Content-Type':'application/json'}}, opt)).then(r => r.ok ? r.json() : Promise.reject(r));

let lastImage = "";   // 当前名片图文件名
let lastReport = null;
let lastSavedId = null;

/* ---------- 侧栏 / 路由 ---------- */
function toggleSidebar(){ if(window.innerWidth<=820){ closeSidebar(); } else { $('#sidebar').classList.toggle('collapsed'); } }
function openSidebar(){ const s=$('#sidebar'); s.classList.remove('collapsed'); s.classList.add('open'); $('#sbOverlay').classList.add('show'); }
function closeSidebar(){ $('#sidebar').classList.remove('open'); $('#sbOverlay').classList.remove('show'); }
window.addEventListener('resize', ()=>{ if(window.innerWidth>820) closeSidebar(); });

function go(view){
  $$('.sb-link').forEach(l => l.classList.remove('active'));
  $('#nav-'+view).classList.add('active');
  $('#view-entry').style.display = view==='entry' ? '' : 'none';
  $('#view-library').style.display = view==='library' ? '' : 'none';
  $('#view-settings').style.display = view==='settings' ? '' : 'none';
  if(view==='entry'){ $('#tb-title').textContent='名片宝'; $('#tb-sub').textContent=''; $('#tb-actions').innerHTML=''; renderEntry(); }
  else if(view==='library'){ $('#tb-title').textContent='客户库'; $('#tb-sub').textContent='所有调研过的客户，可筛选、批量导出'; $('#tb-actions').innerHTML=''; renderLibrary(); }
  else { $('#tb-title').textContent='设置'; $('#tb-sub').textContent='配置 API Key（即时生效，无需重启）'; $('#tb-actions').innerHTML=''; renderSettings(); }
  if(window.innerWidth<=820) closeSidebar();
}

/* ---------- Toast / Lightbox ---------- */
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }
function lightbox(src){ const h=$('#lightbox-host'); h.innerHTML=`<div class="lightbox" onclick="this.remove()"><button class="lb-close" onclick="this.closest('.lightbox').remove()">✕</button><img src="${esc(src)}"></div>`; }

/* ---------- 录入视图 ---------- */
function renderEntry(){
  $('#view-entry').innerHTML = `
  <div class="steps">
    <div class="step"><span class="num">1</span> 名片拍照上传</div>
    <div class="step-arrow">→</div>
    <div class="step"><span class="num">2</span> OCR 识别</div>
    <div class="step-arrow">→</div>
    <div class="step"><span class="num">3</span> AI 调研出报告</div>
  </div>
  <div class="two-col">
    <div class="stack">
      <div class="glass">
        <div class="card-title">📷 上传名片</div>
        <div class="dropzone" id="dz" onclick="$('#file').click()">
          <div class="dz-ic">📇</div>
          <div class="dz-t">点击或拖拽名片照片</div>
          <div class="dz-s">支持手机拍照 / 截图，JPG·PNG</div>
        </div>
        <input type="file" id="file" accept="image/*" style="display:none">
        <div id="imgBox"></div>
      </div>
      <div class="glass">
        <div class="card-title">💡 成熟产品做法</div>
        <div class="note note-info">
          • 拍照即 OCR，自动填好姓名/公司/电话/邮箱<br>
          • 关键字段（客户名）可手动校正<br>
          • 一键搜索+AI 出结构化报告<br>
          • 自动留存名片原图，沉淀进客户库
        </div>
      </div>
    </div>

    <div class="glass">
      <div class="card-title">📝 基本信息 <span style="font-size:11px;font-weight:500;color:var(--text-weak)">（OCR 已预填，可修改）</span></div>
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
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
        <button class="btn btn-primary" id="researchBtn" onclick="doResearch()">🔍 开始 AI 调研</button>
        <button class="btn btn-ghost" onclick="resetEntry()">↺ 清空重来</button>
      </div>
    </div>
  </div>
  <div id="reportHost"></div>`;

  // 上传交互
  const dz = $('#dz'), file = $('#file');
  ['dragover','dragenter'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop', ev=>{ if(ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]); });
  file.addEventListener('change', ev=>{ if(ev.target.files[0]) handleFile(ev.target.files[0]); });
}

/* ---------- 设置页（API Key 配置，即时生效）---------- */
function renderSettings(){
  $('#view-settings').innerHTML = `
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
    </div>
    <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="saveSettings()">💾 保存配置</button>
      <button class="btn btn-ghost" onclick="loadSettings()">↺ 重新载入</button>
    </div>
    <div id="cfgStatus" class="cfg-status"></div>
  </div>`;
  loadSettings();
}

function loadSettings(){
  api('/api/config').then(d=>{
    $('#s_vprovider').value = d.vision_provider || 'openai';
    $('#s_sprovider').value = d.search_provider || 'ddg';
    $('#s_deepseek').placeholder = d.deepseek_api_key ? ('当前已配置（'+d.deepseek_api_key+'）· 留空保留') : '必填 · 填入 DeepSeek Key';
    $('#s_vkey').placeholder = d.vision_api_key ? ('当前已配置（'+d.vision_api_key+'）· 留空保留') : '选填 · 填入视觉 Key';
    $('#s_serper').placeholder = d.serper_api_key ? ('当前已配置（'+d.serper_api_key+'）· 留空保留') : '选填 · 填入 Serper Key';
    $('#s_tavily').placeholder = d.tavily_api_key ? ('当前已配置（'+d.tavily_api_key+'）· 留空保留') : '选填 · 填入 Tavily Key';
    $('#s_brave').placeholder = d.brave_api_key ? ('当前已配置（'+d.brave_api_key+'）· 留空保留') : '选填 · 填入 Brave Key';
  }).catch(()=>toast('读取配置失败'));
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
  };
  $('#cfgStatus').innerHTML = '<span style="color:var(--text-weak)">保存中…</span>';
  api('/api/config', {method:'PUT', body: JSON.stringify(payload)})
    .then(d=>{
      $('#cfgStatus').innerHTML = '<span style="color:var(--success)">✅ 已保存并即时生效。DeepSeek: '+(d.deepseek?'已配置':'未配置')+' · 视觉: '+(d.vision?'已配置':'未配置')+' · 搜索源: '+d.search_provider+'</span>';
      toast('配置已保存');
      loadSettings();
    })
    .catch(()=>{ $('#cfgStatus').innerHTML = '<span style="color:var(--danger)">保存失败，请重试</span>'; });
}

function handleFile(f){
  if(!f.type.startsWith('image/')){ toast('请上传图片文件'); return; }
  const fd = new FormData(); fd.append('file', f);
  $('#imgBox').innerHTML = `<div class="img-preview"><img src="${URL.createObjectURL(f)}"><div class="meta">识别中…</div></div>`;
  fetch('/api/ocr', {method:'POST', body: fd})
    .then(r=>r.json())
    .then(d=>{
      if(d.warn) toast(d.warn);
      const f2 = d.fields || {};
      const set=(id,v)=>{ const el=$('#'+id); if(el && v) el.value=v; };
      set('f_company', f2.company); set('f_contact', f2.contact_name); set('f_title', f2.title);
      set('f_country', f2.country); set('f_phone', f2.phone); set('f_email', f2.email);
      set('f_website', f2.website); set('f_address', f2.address);
      lastImage = d.image || "";
      $('#imgBox').innerHTML = `<div class="img-preview"><img src="/uploads/${esc(lastImage)}"><div class="meta">已识别 · 请核对并修正客户名</div></div>`;
    })
    .catch(e=>{ console.error(e); $('#imgBox').innerHTML=`<div class="meta" style="color:var(--danger)">OCR 失败，可手动填写</div>`; toast('OCR 失败，请手动填写'); });
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
  };
}

function doResearch(){
  const f = collectForm();
  if(!f.company || !f.country || !f.category){ toast('请填写 客户名称 / 国家 / 产品品类'); return; }
  $('#researchBtn').disabled = true;
  $('#reportHost').innerHTML = `<div class="glass"><div class="progress-wrap"><div class="spinner"></div><p>正在搜索公开资料并调用 AI 生成报告，约 20–60 秒…</p></div></div>`;
  $('#reportHost').scrollIntoView({behavior:'smooth'});
  api('/api/research', {method:'POST', body: JSON.stringify({...f, save:true})})
    .then(d=>{ lastReport=d; lastSavedId=d.id; renderReport(d); toast('调研完成，已存入客户库'); })
    .catch(async e=>{ let msg='调研失败'; try{ msg=(await e.json()).detail||msg; }catch{} $('#reportHost').innerHTML=`<div class="glass"><div class="note note-warn">${esc(msg)}<br>请检查后端 .env 中的 DEEPSEEK_API_KEY 是否已配置。</div></div>`; toast(msg); })
    .finally(()=>{ $('#researchBtn').disabled=false; });
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
  let secHtml = (r.sections||[]).map(s=>`
    <div class="section">
      <div class="sec-hd" onclick="const bd=this.nextElementSibling; bd.classList.toggle('off'); this.querySelector('.arr').textContent=bd.classList.contains('off')?'▶':'▼';">
        <span>${s.icon||'📄'}</span><h3>${esc(s.title)}</h3><span class="arr">▼</span>
      </div>
      <div class="sec-bd">${mdToHtml(s.content)}</div>
    </div>`).join('');
  let media = '';
  if(imgs.length){ media += `<div class="media-sec"><h4>🖼️ 相关图片（来自公开搜索）</h4><div class="gallery">${imgs.map(i=>`<img src="${esc(i.url)}" onclick="lightbox('${esc(i.url)}')" title="${esc(i.title)}">`).join('')}</div></div>`; }
  if(vids.length){ media += `<div class="media-sec"><h4>🎬 相关视频</h4><div class="vid-grid">${vids.map(v=>`<div class="vid-card"><a href="${esc(v.url)}" target="_blank"><div class="thumb" style="background-image:url('${esc(v.thumbnail)}')"><div class="play">▶</div></div><div class="vt">${esc(v.title)}<br><span style="color:var(--text-weak);font-size:11px">${esc(v.source)}</span></div></a></div>`).join('')}</div></div>`; }

  $('#reportHost').innerHTML = `
  <div class="glass" style="margin-top:18px">
    <div class="rpt-head">
      <div>
        <h2>📋 ${esc(f.company||'客户')} · 调研报告</h2>
        <div class="meta">${esc(f.country)} · ${esc(f.category)} · ${new Date().toLocaleString('zh-CN')} ${lastSavedId?`· #${lastSavedId}`:''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="badge ${matchClass(r.match_score)}">匹配度：${esc(r.match_score)}</span>
        <button class="btn btn-sm btn-ghost" onclick="window.print()">🖨️ 打印/PDF</button>
        <button class="btn btn-sm btn-ghost" onclick="go('library')">🗂️ 去客户库</button>
        <button class="btn btn-sm btn-ghost" onclick="resetEntry()">🔄 新调研</button>
      </div>
    </div>
    ${r.summary?`<div class="rpt-summary">📌 ${esc(r.summary)}</div>`:''}
    ${r.match_reason?`<div class="note note-info" style="margin-bottom:14px"><b>匹配理由：</b>${esc(r.match_reason)}</div>`:''}
    ${secHtml}
    ${r.recommendation?`<div class="section"><div class="sec-hd"><span>🎯</span><h3>开发切入建议</h3></div><div class="sec-bd">${mdToHtml(r.recommendation)}</div></div>`:''}
    ${r.risks?`<div class="section"><div class="sec-hd"><span>⚠️</span><h3>潜在风险</h3></div><div class="sec-bd">${mdToHtml(r.risks)}</div></div>`:''}
    ${media}
    ${r.search_note?`<div class="note note-warn" style="margin-top:14px">${esc(r.search_note)}</div>`:''}
    <div class="note" style="margin-top:14px;color:var(--text-weak)">⚠️ 报告由 AI 基于公开信息生成，标注[推测]/[未查到公开信息]处请进一步核实，重要决策以实地确认为准。</div>
  </div>`;
  $('#reportHost').scrollIntoView({behavior:'smooth'});
}

function resetEntry(){ lastImage=''; lastReport=null; lastSavedId=null; renderEntry(); }

/* ---------- 客户库 ---------- */
let libFilter = {q:'', status:'', country:''};
function renderLibrary(){
  $('#view-library').innerHTML = `
  <div class="glass">
    <div class="toolbar">
      <div class="search"><span class="si">🔍</span><input id="libSearch" placeholder="搜索公司 / 联系人 / 邮箱" oninput="debounceLib()"></div>
      <select class="status-select" id="libStatus" onchange="libFilter.status=this.value; loadLib()">
        <option value="">全部状态</option><option value="new">新建</option><option value="researched">已调研</option><option value="contacted">已联系</option><option value="deal">商机</option>
      </select>
      <button class="btn btn-sm btn-ghost" onclick="exportLib('csv')">⬇️ CSV</button>
      <button class="btn btn-sm btn-ghost" onclick="exportLib('excel')">⬇️ Excel</button>
      <button class="btn btn-sm btn-ghost" onclick="exportLib('json')">⬇️ JSON</button>
      <button class="btn btn-sm btn-primary" onclick="go('entry')">＋ 新建调研</button>
    </div>
    <div class="table-wrap"><table class="tbl" id="libTable"><thead><tr>
      <th>客户/公司</th><th>联系人</th><th>国家</th><th>品类</th><th>状态</th><th>匹配度</th><th>更新时间</th><th>操作</th>
    </tr></thead><tbody><tr><td colspan="8"><div class="empty"><div class="e-ic">📭</div>加载中…</div></td></tr></tbody></table></div>
  </div>`;
  loadLib();
}
let libTimer;
function debounceLib(){ clearTimeout(libTimer); libTimer=setTimeout(()=>{ libFilter.q=$('#libSearch').value.trim(); loadLib(); }, 300); }

function loadLib(){
  const p = new URLSearchParams(libFilter).toString();
  api('/api/customers?'+p).then(rows=>{
    const tb = $('#libTable tbody');
    if(!rows.length){ tb.innerHTML=`<tr><td colspan="8"><div class="empty"><div class="e-ic">📭</div>暂无客户，去「录入调研」上传名片吧</div></td></tr>`; return; }
    tb.innerHTML = rows.map(r=>`
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
      </tr>`).join('');
  }).catch(()=>toast('加载失败'));
}
function stLabel(s){ return {new:'新建',researched:'已调研',contacted:'已联系',deal:'商机'}[s]||s; }
function setStatus(id, v){ api('/api/customers/'+id, {method:'PUT', body: JSON.stringify({status:v})}).then(()=>toast('状态已更新')).catch(()=>toast('更新失败')); }
function delCustomer(id){ if(!confirm('确认删除该客户？')) return; api('/api/customers/'+id,{method:'DELETE'}).then(()=>{toast('已删除');loadLib();}).catch(()=>toast('删除失败')); }
function exportLib(fmt){ const p=new URLSearchParams(libFilter).toString(); window.open('/api/export?format='+fmt+'&'+p); }

function viewCustomer(id){
  api('/api/customers/'+id).then(r=>{
    const report = r.report_json || null;
    let body;
    if(report){
      body = renderReportHTML(report, r.images_json||[], r.videos_json||[], r);
    } else {
      body = `<div class="note note-warn">该客户尚未生成 AI 报告。</div>` + basicInfoHTML(r);
    }
    $('#lightbox-host').innerHTML = `
      <div class="lightbox" style="background:rgba(15,23,42,0.5);align-items:flex-start;padding:40px 20px;overflow:auto" onclick="if(event.target===this)this.remove()">
        <div class="glass" style="max-width:860px;width:100%;margin:auto" onclick="event.stopPropagation()">
          <div class="rpt-head"><div><h2 style="font-size:18px">${esc(r.company||'客户')} #${r.id}</h2><div class="meta">${esc(r.country)} · ${stLabel(r.status)}</div></div>
          <button class="btn btn-sm btn-ghost" onclick="this.closest('.lightbox').remove()">✕ 关闭</button></div>
          ${basicInfoHTML(r)}
          ${body}
        </div>
      </div>`;
  });
}
function basicInfoHTML(r){
  const items=[['联系人',r.contact_name],['职位',r.title],['电话',r.phone],['邮箱',r.email],['网站',r.website],['地址',r.address],['品类',r.category],['展会线索',r.notes],['标签',r.tags]];
  return `<div class="form-grid" style="margin:12px 0">${items.map(([k,v])=>`<div class="form-row"><label>${k}</label><div style="font-size:13px;color:var(--text-body);padding:4px 0">${esc(v||'—')}${k==='网站'&&v?` <a href="${esc(v)}" target="_blank" style="color:var(--primary)">↗</a>`:''}</div></div>`).join('')}</div>`;
}
function renderReportHTML(r, imgs, vids, meta){
  let secHtml=(r.sections||[]).map(s=>`
    <div class="section"><div class="sec-hd" onclick="this.nextElementSibling.classList.toggle('off')"><span>${s.icon||'📄'}</span><h3>${esc(s.title)}</h3><span class="arr">▼</span></div>
    <div class="sec-bd">${mdToHtml(s.content)}</div></div>`).join('');
  let media='';
  if(imgs&&imgs.length) media+=`<div class="media-sec"><h4>🖼️ 相关图片</h4><div class="gallery">${imgs.map(i=>`<img src="${esc(i.url)}" onclick="lightbox('${esc(i.url)}')">`).join('')}</div></div>`;
  if(vids&&vids.length) media+=`<div class="media-sec"><h4>🎬 相关视频</h4><div class="vid-grid">${vids.map(v=>`<div class="vid-card"><a href="${esc(v.url)}" target="_blank"><div class="thumb" style="background-image:url('${esc(v.thumbnail)}')"><div class="play">▶</div></div><div class="vt">${esc(v.title)}</div></a></div>`).join('')}</div></div>`;
  return `${r.summary?`<div class="rpt-summary">📌 ${esc(r.summary)}</div>`:''}
    ${r.match_reason?`<div class="note note-info" style="margin-bottom:12px"><b>匹配理由：</b>${esc(r.match_reason)}</div>`:''}
    ${secHtml}
    ${r.recommendation?`<div class="section"><div class="sec-hd"><span>🎯</span><h3>开发建议</h3></div><div class="sec-bd">${mdToHtml(r.recommendation)}</div></div>`:''}
    ${r.risks?`<div class="section"><div class="sec-hd"><span>⚠️</span><h3>风险</h3></div><div class="sec-bd">${mdToHtml(r.risks)}</div></div>`:''}
    ${media}`;
}

/* ---------- 启动 ---------- */
go('entry');
