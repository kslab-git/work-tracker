import { useState, useEffect, useMemo } from "react";

const STORAGE_KEY  = "wt2_records";
const SETTINGS_KEY = "wt2_settings";
const PERIOD_KEY   = "wt2_period";
const SHEET_ID_KEY = "wt2_sheet_id";
const DEFAULT_SETTINGS = { hourlyRate: 1200, currency: "¥", closingDay: 25 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toMin = (t) => { const [h,m]=t.split(":").map(Number); return h*60+m; };
const pad   = (n) => String(n).padStart(2,"0");
const fmtH  = (min) => { const h=Math.floor(min/60),m=min%60; return m===0?`${h}h`:`${h}h${pad(m)}m`; };
const fmtMoney = (n,cur) => `${cur}${Math.round(n).toLocaleString()}`;
const getTodayStr = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const nowStr = () => { const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateLbl = (s) => { const d=new Date(s+"T00:00:00"); return `${d.getMonth()+1}/${d.getDate()}(${["日","月","火","水","木","金","土"][d.getDay()]})`; };

// ─── Wage Calculation（休憩差し引き対応）────────────────────────────────────
// breaks: [{in:"12:00", out:"12:45"}, ...]
function calcWage(segments, breaks, rate) {
  // 休憩分をセットに変換（分単位）
  const breakSet = new Set();
  for (const b of (breaks||[])) {
    if (!b.in || !b.out) continue;
    const bs = toMin(b.in), be = toMin(b.out);
    for (let m=bs; m<be; m++) breakSet.add(m % (24*60));
  }

  let totalWorkMin=0, nm=0, om=0, ln=0, lno=0;
  let totalBreakMin = breakSet.size;

  for (const seg of segments) {
    if (!seg.in || !seg.out) continue;
    const start=toMin(seg.in);
    let end=toMin(seg.out);
    if (end<=start) end+=24*60;
    for (let m=start; m<end; m++) {
      const mod = m % (24*60);
      if (breakSet.has(mod)) continue; // 休憩中はスキップ
      const isLate = mod>=22*60 || mod<5*60;
      const isOT   = totalWorkMin>=480;
      totalWorkMin++;
      if (!isOT&&!isLate) nm++;
      else if (isOT&&!isLate) om++;
      else if (!isOT&&isLate) ln++;
      else lno++;
    }
  }
  const normalPay=(nm/60)*rate, otPay=(om/60)*rate*1.25;
  const lnPay=(ln/60)*rate*1.25, lnoPay=(lno/60)*rate*1.5;
  return { nm,om,ln,lno,normalPay,otPay,lnPay,lnoPay,
    totalPay:normalPay+otPay+lnPay+lnoPay,
    totalMin:nm+om+ln+lno,
    totalBreakMin };
}

// ─── Period Logic ─────────────────────────────────────────────────────────────
function getPeriodBounds(periodKey,closingDay) {
  const [y,m]=periodKey.split("-").map(Number);
  if (closingDay===0) { const last=new Date(y,m,0).getDate(); return {start:`${y}-${pad(m)}-01`,end:`${y}-${pad(m)}-${pad(last)}`}; }
  const fmt=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return {start:fmt(new Date(y,m-2,closingDay+1)),end:fmt(new Date(y,m-1,closingDay))};
}
const getPeriodLabel = (pk,cd) => {
  const {start,end}=getPeriodBounds(pk,cd);
  if (cd===0) return pk.replace("-","年")+"月";
  const [,ms,ds]=start.split("-"); const [,me,de]=end.split("-");
  return `${+ms}/${+ds} 〜 ${+me}/${+de}`;
};
const isInPeriod = (d,pk,cd) => { const {start,end}=getPeriodBounds(pk,cd); return d>=start&&d<=end; };
const shiftPeriod = (pk,delta) => { const [y,m]=pk.split("-").map(Number); const d=new Date(y,m-1+delta,1); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; };
function currentPeriodKey(cd) {
  const t=new Date(),y=t.getFullYear(),m=t.getMonth()+1,day=t.getDate();
  if (cd===0) return `${y}-${pad(m)}`;
  if (day>cd) { const d=new Date(y,m,1); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
  return `${y}-${pad(m)}`;
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000,
      mcp_servers:[{type:"url",url:"https://drivemcp.googleapis.com/mcp/v1",name:"gdrive"}],
      messages:[{role:"user",content:prompt}] }),
  });
  return await res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function WorkTracker() {
  const [records,setRecords] = useState(()=>{ try{return JSON.parse(localStorage.getItem(STORAGE_KEY))||[];}catch{return [];} });
  const [settings,setSettings] = useState(()=>{ try{return {...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY))};}catch{return DEFAULT_SETTINGS;} });
  const [periodKey,setPeriodKey] = useState(()=>{ const s={...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}")}; return localStorage.getItem(PERIOD_KEY)||currentPeriodKey(s.closingDay); });
  const [sheetId,setSheetId] = useState(()=>localStorage.getItem(SHEET_ID_KEY)||"");
  const [view,setView] = useState("input");
  const [settingsForm,setSettingsForm] = useState(settings);
  const [toast,setToast] = useState({msg:"",type:"ok"});
  const [expandedDay,setExpandedDay] = useState(null);
  const [syncing,setSyncing] = useState(false);

  const emptyForm = () => ({ id:null, date:getTodayStr(), segments:[{in:"",out:""}], breaks:[], memo:"" });
  const [form,setForm] = useState(emptyForm());

  useEffect(()=>{localStorage.setItem(STORAGE_KEY,JSON.stringify(records));},[records]);
  useEffect(()=>{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));},[settings]);
  useEffect(()=>{localStorage.setItem(PERIOD_KEY,periodKey);},[periodKey]);
  useEffect(()=>{if(sheetId)localStorage.setItem(SHEET_ID_KEY,sheetId);},[sheetId]);

  const showToast=(msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast({msg:"",type:"ok"}),2500);};

  const periodRecords = useMemo(()=>records.filter(r=>isInPeriod(r.date,periodKey,settings.closingDay)).sort((a,b)=>b.date.localeCompare(a.date)),[records,periodKey,settings.closingDay]);

  const periodTotals = useMemo(()=>{
    let nm=0,om=0,ln=0,lno=0,nP=0,oP=0,lP=0,loP=0,bMin=0;
    for(const r of periodRecords){const w=calcWage(r.segments,r.breaks||[],settings.hourlyRate);nm+=w.nm;om+=w.om;ln+=w.ln;lno+=w.lno;nP+=w.normalPay;oP+=w.otPay;lP+=w.lnPay;loP+=w.lnoPay;bMin+=w.totalBreakMin;}
    return {nm,om,ln,lno,normalPay:nP,otPay:oP,lnPay:lP,lnoPay:loP,totalPay:nP+oP+lP+loP,totalMin:nm+om+ln+lno,totalBreakMin:bMin};
  },[periodRecords,settings.hourlyRate]);

  // Segments
  const updSeg=(i,f,v)=>setForm(fm=>{const s=[...fm.segments];s[i]={...s[i],[f]:v};return{...fm,segments:s};});
  const addSeg=()=>setForm(f=>({...f,segments:[...f.segments,{in:"",out:""}]}));
  const rmSeg=(i)=>setForm(f=>({...f,segments:f.segments.filter((_,idx)=>idx!==i)}));
  const stampSeg=(i,field)=>updSeg(i,field,nowStr());

  // Breaks
  const updBrk=(i,f,v)=>setForm(fm=>{const b=[...fm.breaks];b[i]={...b[i],[f]:v};return{...fm,breaks:b};});
  const addBrk=()=>setForm(f=>({...f,breaks:[...f.breaks,{in:"",out:""}]}));
  const rmBrk=(i)=>setForm(f=>({...f,breaks:f.breaks.filter((_,idx)=>idx!==i)}));
  const stampBrk=(i,field)=>updBrk(i,field,nowStr());

  const formWage = useMemo(()=>calcWage(form.segments,form.breaks,settings.hourlyRate),[form.segments,form.breaks,settings.hourlyRate]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.segments.some(s=>s.in||s.out)) return;
    let updatedRecords, savedRecord, toastMsg="保存しました";
    if (form.id) {
      savedRecord={...form};
      updatedRecords=records.map(r=>r.id===form.id?savedRecord:r);
      toastMsg="更新しました";
    } else {
      const existing=records.find(r=>r.date===form.date);
      if (existing) {
        const mergedSegs=existing.segments.map(s=>({...s}));
        for (const ns of form.segments) {
          if (ns.in&&!ns.out) mergedSegs.push({in:ns.in,out:""});
          else if (!ns.in&&ns.out) { const idx=mergedSegs.findIndex(s=>s.in&&!s.out); if(idx>=0)mergedSegs[idx]={...mergedSegs[idx],out:ns.out};else mergedSegs.push({in:"",out:ns.out}); }
          else if (ns.in&&ns.out) mergedSegs.push({...ns});
        }
        // 休憩はマージ（重複除去）
        const allBreaks=[...(existing.breaks||[]),...form.breaks].filter(b=>b.in&&b.out);
        savedRecord={...existing,segments:mergedSegs,breaks:allBreaks,memo:form.memo||existing.memo};
        updatedRecords=records.map(r=>r.id===existing.id?savedRecord:r);
        toastMsg="同日レコードにマージしました";
      } else {
        savedRecord={...form,id:Date.now().toString()};
        updatedRecords=[...records,savedRecord];
      }
    }
    setRecords(updatedRecords);
    setForm(emptyForm());
    showToast(toastMsg);

    // 出退勤が両方揃っている区間がある場合のみSheets同期
    // 休憩のみ・出勤のみ・退勤のみの場合はスキップ
    const hasComplete = savedRecord.segments.some(s=>s.in&&s.out);
    if (hasComplete) {
      await syncToSheet(savedRecord);
    } else {
      showToast("ローカルに保存しました（Sheets同期は出退勤揃った時）");
    }
  };

  const syncToSheet = async (record) => {
    setSyncing(true);
    try {
      const w=calcWage(record.segments,record.breaks||[],settings.hourlyRate);
      const segStr=record.segments.map(s=>`${s.in||"-"}〜${s.out||"勤務中"}`).join(" / ");
      const brkStr=(record.breaks||[]).filter(b=>b.in&&b.out).map(b=>`${b.in}〜${b.out}`).join(" / ")||"なし";
      const row=[record.date,segStr,brkStr,fmtH(w.totalBreakMin),fmtH(w.totalMin),Math.round(w.normalPay),Math.round(w.otPay),Math.round(w.lnPay),Math.round(w.lnoPay),Math.round(w.totalPay),record.memo||""];

      if (!sheetId) {
        // 新規作成＋データ書き込みを1回で行う
        const createPrompt = `Google Driveに「勤怠記録」という名前の新しいスプレッドシートを作成し、「勤怠」というシートに以下のヘッダーとデータを追加してください。
ヘッダー行: 日付, 勤務区間, 休憩時間, 休憩合計, 実働時間, 通常給与, 残業手当, 深夜手当, 深夜残業, 合計給与, メモ
データ行: ${row.join(", ")}
完了後、作成したスプレッドシートのIDを「ID:XXXXXXX」の形式で返してください。`;
        const data=await callClaude(createPrompt);
        const txt=data.content?.filter(b=>b.type==="text").map(b=>b.text).join("").trim();
        console.log("Create response:", txt);
        const idMatch=txt.match(/ID:([a-zA-Z0-9_-]{20,})/)||txt.match(/([a-zA-Z0-9_-]{44})/)||txt.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
        if (idMatch) {
          const newId=idMatch[1];
          setSheetId(newId);
          localStorage.setItem(SHEET_ID_KEY,newId);
          showToast("スプレッドシートを作成・保存しました ✓");
        } else {
          showToast("シート作成に失敗。設定からGoogle連携を確認してください","err");
          console.error("Could not extract sheet ID from:", txt);
        }
      } else {
        await writeRow(sheetId,row);
        showToast("スプレッドシートに保存しました ✓");
      }
    } catch(e){ showToast("同期エラー: "+e.message,"err"); }
    finally { setSyncing(false); }
  };

  const writeRow = async (id,row) => {
    const prompt=`Google Driveのスプレッドシート（ID: ${id}）の「勤怠」シートにデータを追記してください。ヘッダーがなければ先に追加してください。
ヘッダー: 日付, 勤務区間, 休憩時間, 休憩合計, 実働時間, 通常給与, 残業手当, 深夜手当, 深夜残業, 合計給与, メモ
データ: ${row.join(", ")}
成功したらOKとだけ返してください。`;
    await callClaude(prompt);
  };

  const handleDelete=(id)=>{setRecords(prev=>prev.filter(r=>r.id!==id));showToast("削除しました");};
  const handleEdit=(r)=>{setForm({id:r.id,date:r.date,segments:r.segments.map(s=>({...s})),breaks:(r.breaks||[]).map(b=>({...b})),memo:r.memo||""});setView("input");};
  const handleSettingsSave=()=>{setSettings({...settingsForm});setPeriodKey(currentPeriodKey(settingsForm.closingDay));showToast("設定を保存しました");};
  const handleOpenSheet=()=>{if(sheetId)window.open(`https://docs.google.com/spreadsheets/d/${sheetId}`,"_blank");};
  const handleResetSheet=()=>{if(window.confirm("連携を解除しますか？")){setSheetId("");localStorage.removeItem(SHEET_ID_KEY);showToast("連携を解除しました");}};

  // ─── Colors ───────────────────────────────────────────────────────────────
  const C={bg:"#f5f6f8",surface:"#ffffff",border:"#e0e3e8",borderAccent:"#d0d4db",
    gold:"#b8860b",text:"#1a1a2e",muted:"#6b7280",dim:"#9ca3af",
    green:"#16a34a",blue:"#2563eb",red:"#dc2626",ot:"#ea580c",ln:"#7c3aed",lno:"#be185d",
    orange:"#f59e0b"};
  const inp={background:"#f9fafb",border:`1px solid ${C.border}`,borderRadius:8,
    color:C.text,fontSize:16,fontWeight:500,padding:"9px 12px",outline:"none",
    fontFamily:"inherit",boxSizing:"border-box",width:"100%"};

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,
      fontFamily:"'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif",
      display:"flex",flexDirection:"column",alignItems:"center",paddingBottom:60}}>

      {toast.msg&&(
        <div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",
          background:"#fff",border:`1px solid ${toast.type==="err"?C.red:C.gold}`,
          borderRadius:10,padding:"10px 22px",fontSize:14,fontWeight:600,
          color:toast.type==="err"?C.red:C.gold,zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.12)",whiteSpace:"nowrap"}}>
          {toast.type==="err"?"⚠️":"✓"} {toast.msg}
        </div>
      )}

      <div style={{width:"100%",maxWidth:500,padding:"28px 16px 0",boxSizing:"border-box"}}>

        {/* Header */}
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:22,fontWeight:800,color:C.text}}>勤怠・給与管理</span>
            {sheetId
              ? <button onClick={handleOpenSheet} style={{background:"#e8f5e9",border:"1px solid #a5d6a7",borderRadius:8,color:"#2e7d32",fontSize:12,fontWeight:700,padding:"5px 10px",cursor:"pointer"}}>📊 シートを開く</button>
              : <span style={{fontSize:11,color:C.dim,background:"#fef3c7",border:"1px solid #fcd34d",borderRadius:6,padding:"3px 8px"}}>未連携</span>}
          </div>
          <div style={{height:1,background:`linear-gradient(90deg,${C.gold},transparent)`}}/>
        </div>

        {/* Period */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
          <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,-1))} style={arrowBtn(C)}>‹</button>
          <div style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:12,color:C.muted,fontWeight:500,marginBottom:2}}>{settings.closingDay===0?"月末締め":`${settings.closingDay}日締め`}</div>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{getPeriodLabel(periodKey,settings.closingDay)}</div>
          </div>
          <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,1))} style={arrowBtn(C)}>›</button>
        </div>

        <SummaryCard t={periodTotals} settings={settings} C={C}/>

        {/* Nav */}
        <div style={{display:"flex",gap:6,margin:"18px 0 20px"}}>
          {[["input","✏️ 打刻入力"],["history","📋 履歴"],["settings","⚙️ 設定"],["help","❓ 使い方"]].map(([k,label])=>(
            <button key={k} onClick={()=>setView(k)} style={{flex:1,padding:"10px 4px",borderRadius:9,border:"none",
              background:view===k?C.gold:C.surface,color:view===k?"#fff":C.muted,
              fontWeight:view===k?700:500,fontSize:13,cursor:"pointer",
              boxShadow:view===k?"0 2px 8px rgba(184,134,11,0.3)":"none"}}>{label}</button>
          ))}
        </div>

        {/* ── INPUT ─────────────────────────────────────────────────────── */}
        {view==="input"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>

            {/* 日付 */}
            <div style={{marginBottom:14}}>
              <Lbl>日付</Lbl>
              <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={inp}/>
            </div>

            {/* 出退勤区間 */}
            <Lbl>出退勤</Lbl>
            {form.segments.map((seg,i)=>(
              <div key={i} style={{background:"#f3f4f6",border:`1px solid ${C.borderAccent}`,borderRadius:10,padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",marginBottom:8,gap:6}}>
                  <span style={{fontSize:13,fontWeight:600,color:C.muted}}>区間 {i+1}</span>
                  {i>0&&<span style={{fontSize:12,fontWeight:600,color:C.blue}}>（中抜け後）</span>}
                  <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
                    <button onClick={handleSave} disabled={syncing} style={{
                      padding:"4px 10px",borderRadius:7,border:"none",
                      background:syncing?"#d4a017":C.gold,color:"#fff",
                      fontWeight:700,fontSize:13,cursor:syncing?"not-allowed":"pointer",
                    }}>{syncing?"…":"保存"}</button>
                    {form.segments.length>1&&<button onClick={()=>rmSeg(i)} style={{background:"none",border:"none",color:C.red,fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>}
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[["in","🟢 出勤"],["out","🔴 退勤"]].map(([field,lbl])=>(
                    <div key={field}>
                      <div style={{fontSize:12,fontWeight:600,color:C.muted,marginBottom:4}}>{lbl}</div>
                      <div style={{display:"flex",gap:4}}>
                        <input type="time" value={seg[field]} onChange={e=>updSeg(i,field,e.target.value)} style={{...inp,flex:1}}/>
                        <button onClick={()=>stampSeg(i,field)} style={stampBtn(C)}>今</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={addSeg} style={{width:"100%",padding:"8px",borderRadius:8,border:`1px dashed ${C.borderAccent}`,background:"none",color:C.muted,fontSize:14,fontWeight:500,cursor:"pointer",marginBottom:16}}>＋ 中抜け区間を追加</button>

            {/* 休憩時間 */}
            <Lbl>☕ 休憩時間</Lbl>
            {form.breaks.length===0&&(
              <div style={{fontSize:13,color:C.dim,marginBottom:8,fontWeight:500}}>休憩なし</div>
            )}
            {form.breaks.map((brk,i)=>(
              <div key={i} style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",marginBottom:8,gap:6}}>
                  <span style={{fontSize:13,fontWeight:600,color:C.orange}}>休憩 {i+1}</span>
                  {brk.in&&brk.out&&(
                    <span style={{fontSize:12,color:C.orange,fontWeight:600}}>
                      （{fmtH(toMin(brk.out)-toMin(brk.in))}）
                    </span>
                  )}
                  <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
                    <button onClick={handleSave} disabled={syncing} style={{
                      padding:"4px 10px",borderRadius:7,border:"none",
                      background:syncing?"#d4a017":C.gold,color:"#fff",
                      fontWeight:700,fontSize:13,cursor:syncing?"not-allowed":"pointer",
                    }}>{syncing?"…":"保存"}</button>
                    <button onClick={()=>rmBrk(i)} style={{background:"none",border:"none",color:C.red,fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[["in","開始"],["out","終了"]].map(([field,lbl])=>(
                    <div key={field}>
                      <div style={{fontSize:12,fontWeight:600,color:C.orange,marginBottom:4}}>{lbl}</div>
                      <div style={{display:"flex",gap:4}}>
                        <input type="time" value={brk[field]} onChange={e=>updBrk(i,field,e.target.value)} style={{...inp,flex:1,borderColor:"#fde68a"}}/>
                        <button onClick={()=>stampBrk(i,field)} style={{...stampBtn(C),borderColor:"#fde68a",color:C.orange}}>今</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={addBrk} style={{width:"100%",padding:"8px",borderRadius:8,border:"1px dashed #fcd34d",background:"#fffbeb",color:C.orange,fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:16}}>＋ 休憩を追加</button>

            {/* メモ */}
            <div style={{marginBottom:16}}>
              <Lbl>メモ（任意）</Lbl>
              <input type="text" value={form.memo} placeholder="業務内容など" onChange={e=>setForm(f=>({...f,memo:e.target.value}))} style={inp}/>
            </div>

            {/* Preview */}
            {formWage.totalMin>0&&<WageBreakdown w={formWage} settings={settings} C={C} compact/>}

            <button onClick={handleSave} disabled={syncing} style={{width:"100%",marginTop:14,padding:"14px 0",borderRadius:10,border:"none",
              background:syncing?"#d4a017":C.gold,color:"#fff",fontWeight:700,fontSize:16,cursor:syncing?"not-allowed":"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              {syncing?<><Spin/>同期中...</>:(form.id?"更新する":"記録を保存 → Sheets")}
            </button>
            {form.id&&<button onClick={()=>setForm(emptyForm())} style={{width:"100%",marginTop:8,padding:"10px 0",borderRadius:10,border:`1px solid ${C.border}`,background:"none",color:C.muted,fontSize:15,fontWeight:500,cursor:"pointer"}}>キャンセル</button>}

            <div style={{marginTop:12,padding:"10px 12px",borderRadius:8,background:sheetId?"#f0fdf4":"#fffbeb",border:`1px solid ${sheetId?"#bbf7d0":"#fde68a"}`,fontSize:12,fontWeight:500,color:sheetId?"#15803d":"#92400e"}}>
              {sheetId?"📊 Googleスプレッドシートと連携中":"⚠️ 初回保存時にスプレッドシートを自動作成します"}
            </div>
          </div>
        )}

        {/* ── HISTORY ───────────────────────────────────────────────────── */}
        {view==="history"&&(
          <div>
            {periodRecords.length===0
              ?<div style={{textAlign:"center",padding:"40px 0",color:C.dim,fontSize:15,fontWeight:500}}>この期間の記録はありません</div>
              :periodRecords.map(r=>{
                const w=calcWage(r.segments,r.breaks||[],settings.hourlyRate);
                const isOpen=expandedDay===r.id;
                return(
                  <div key={r.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,marginBottom:8,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
                    <div style={{display:"flex",alignItems:"center",padding:"13px 14px",cursor:"pointer"}} onClick={()=>setExpandedDay(isOpen?null:r.id)}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:700}}>{dateLbl(r.date)}</div>
                        <div style={{fontSize:13,fontWeight:500,color:C.muted,marginTop:2}}>
                          {r.segments.map(s=>`${s.in||"?"}–${s.out||"勤務中"}`).join(" / ")}
                        </div>
                        {(r.breaks||[]).filter(b=>b.in&&b.out).length>0&&(
                          <div style={{fontSize:12,color:C.orange,fontWeight:500,marginTop:2}}>
                            ☕ 休憩 {fmtH(w.totalBreakMin)}（{(r.breaks||[]).filter(b=>b.in&&b.out).map(b=>`${b.in}〜${b.out}`).join(" / ")}）
                          </div>
                        )}
                      </div>
                      <div style={{textAlign:"right",marginRight:10}}>
                        <div style={{color:w.totalMin===0?C.green:C.gold,fontWeight:700,fontSize:16}}>
                          {w.totalMin===0?"勤務中":fmtMoney(w.totalPay,settings.currency)}
                        </div>
                        <div style={{fontSize:13,fontWeight:500,color:C.muted}}>{w.totalMin>0?fmtH(w.totalMin):""}</div>
                      </div>
                      <span style={{color:C.muted,fontSize:14,fontWeight:600}}>{isOpen?"▲":"▼"}</span>
                    </div>
                    {isOpen&&(
                      <div style={{borderTop:`1px solid ${C.border}`,padding:"12px 14px"}}>
                        <WageBreakdown w={w} settings={settings} C={C}/>
                        <div style={{display:"flex",gap:8,marginTop:12}}>
                          <button onClick={()=>handleEdit(r)} style={{flex:1,padding:"8px",borderRadius:8,border:`1px solid ${C.borderAccent}`,background:"none",color:C.muted,fontSize:13,fontWeight:600,cursor:"pointer"}}>編集</button>
                          <button onClick={()=>handleDelete(r.id)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid #fecaca",background:"none",color:C.red,fontSize:13,fontWeight:600,cursor:"pointer"}}>削除</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            }
          </div>
        )}

        {/* ── SETTINGS ──────────────────────────────────────────────────── */}
        {view==="settings"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <div style={{marginBottom:16}}><Lbl>時給（円）</Lbl><input type="number" value={settingsForm.hourlyRate} onChange={e=>setSettingsForm(s=>({...s,hourlyRate:Number(e.target.value)}))} style={inp}/></div>
            <div style={{marginBottom:16}}><Lbl>通貨記号</Lbl><input type="text" value={settingsForm.currency} maxLength={3} onChange={e=>setSettingsForm(s=>({...s,currency:e.target.value}))} style={{...inp,width:80}}/></div>
            <div style={{marginBottom:20}}>
              <Lbl>締め日</Lbl>
              <select value={settingsForm.closingDay} onChange={e=>setSettingsForm(s=>({...s,closingDay:Number(e.target.value)}))} style={{...inp,cursor:"pointer"}}>
                {[...Array(28)].map((_,i)=><option key={i+1} value={i+1}>{i+1}日締め</option>)}
                <option value={0}>月末締め</option>
              </select>
            </div>
            <div style={{background:"#f3f4f6",borderRadius:10,padding:"14px",marginBottom:16,border:`1px solid ${C.border}`,lineHeight:2}}>
              <div style={{fontWeight:700,marginBottom:6,fontSize:14}}>割増賃金の計算基準</div>
              {[["通常時間","×1.00",C.text],["残業（8h超）","×1.25",C.ot],["深夜（22〜翌5時）","×1.25",C.ln],["深夜＋残業","×1.50",C.lno]].map(([l,r,col])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:500}}>
                  <span style={{color:C.muted}}>{l}</span><span style={{color:col,fontWeight:700}}>{r}</span>
                </div>
              ))}
              <div style={{fontSize:12,color:C.dim,marginTop:6,fontWeight:500}}>※ 休憩時間は給与計算から自動除外</div>
            </div>
            <button onClick={handleSettingsSave} style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:16}}>設定を保存</button>
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16}}>
              <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:10}}>📊 Googleスプレッドシート連携</div>
              {sheetId?(
                <div>
                  <div style={{fontSize:12,fontWeight:500,color:C.muted,marginBottom:8,wordBreak:"break-all",background:"#f3f4f6",padding:"8px 10px",borderRadius:6}}>ID: {sheetId}</div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={handleOpenSheet} style={{flex:1,padding:"9px 0",borderRadius:8,border:"1px solid #a5d6a7",background:"#f0fdf4",color:"#15803d",fontSize:13,fontWeight:700,cursor:"pointer"}}>シートを開く</button>
                    <button onClick={handleResetSheet} style={{padding:"9px 12px",borderRadius:8,border:"1px solid #fecaca",background:"none",color:C.red,fontSize:13,fontWeight:600,cursor:"pointer"}}>連携解除</button>
                  </div>
                </div>
              ):(
                <div style={{fontSize:13,fontWeight:500,color:C.muted,background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px"}}>初回保存時に自動的にスプレッドシートが作成されます</div>
              )}
            </div>
          </div>
        )}

        {/* ── HELP VIEW ──────────────────────────────────────────────────── */}
        {view==="help"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>

            <HelpSection title="📱 基本の使い方" C={C}>
              {[
                {n:"1",h:"出勤時：「今」ボタンをタップ",p:"打刻入力タブで出勤欄の「今」をタップすると現在時刻が自動入力されます。"},
                {n:"2",h:"休憩がある場合：「＋休憩を追加」",p:"休憩の開始・終了を入力すると給与から自動差し引きされます。複数回OK。"},
                {n:"3",h:"退勤時：退勤欄の「今」をタップ",p:"給与内訳がリアルタイムでプレビューされます。"},
                {n:"4",h:"「記録を保存 → Sheets」をタップ",p:"ローカル保存とGoogleスプレッドシートへの転記が同時に行われます。"},
              ].map((s,i)=>(
                <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
                  <div style={{background:C.gold,color:"#fff",fontWeight:800,fontSize:13,width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{s.n}</div>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{s.h}</div>
                    <div style={{fontSize:13,color:C.muted}}>{s.p}</div>
                  </div>
                </div>
              ))}
            </HelpSection>

            <HelpSection title="🔄 中抜け勤務" C={C}>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.8}}>
                <div>① 区間1に午前の出退勤を入力</div>
                <div>② 「＋中抜け区間を追加」をタップ</div>
                <div>③ 区間2に午後の出退勤を入力</div>
                <div style={{marginTop:8,padding:"8px 12px",background:"#fffbeb",borderRadius:8,border:"1px solid #fde68a",color:"#92400e",fontWeight:500}}>
                  💡 出勤だけ保存 → 退勤時に同じ日付で再保存すると1レコードに自動マージ
                </div>
              </div>
            </HelpSection>

            <HelpSection title="💰 給与計算の基準" C={C}>
              <div style={{fontSize:13}}>
                {[
                  {label:"通常時間",rate:"×1.00",color:C.text,note:"8時間以内・深夜以外"},
                  {label:"残業手当",rate:"×1.25",color:C.ot,note:"1日8時間超"},
                  {label:"深夜手当",rate:"×1.25",color:C.ln,note:"22時〜翌5時（8h以内）"},
                  {label:"深夜残業",rate:"×1.50",color:C.lno,note:"22時〜翌5時（8h超）"},
                ].map((r,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
                    <div>
                      <span style={{fontWeight:700,color:r.color}}>{r.label}</span>
                      <span style={{color:C.dim,marginLeft:8,fontSize:12}}>{r.note}</span>
                    </div>
                    <span style={{fontWeight:800,color:r.color,fontSize:15}}>{r.rate}</span>
                  </div>
                ))}
                <div style={{marginTop:10,fontSize:12,color:C.dim}}>※ 休憩時間は給与計算から自動除外されます</div>
              </div>
            </HelpSection>

            <HelpSection title="📲 ホーム画面への追加" C={C}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div style={{background:"#f3f4f6",borderRadius:10,padding:"12px",fontSize:13}}>
                  <div style={{fontWeight:700,marginBottom:8}}>🍎 iPhone</div>
                  {["SafariでURLを開く","共有ボタン（□↑）をタップ","「ホーム画面に追加」を選択","「追加」をタップ"].map((s,i)=>(
                    <div key={i} style={{color:C.muted,marginBottom:4}}>{"0123"[i]}. {s}</div>
                  ))}
                </div>
                <div style={{background:"#f3f4f6",borderRadius:10,padding:"12px",fontSize:13}}>
                  <div style={{fontWeight:700,marginBottom:8}}>🤖 Android</div>
                  {["ChromeでURLを開く","右上の「⋮」をタップ","「ホーム画面に追加」を選択","「追加」をタップ"].map((s,i)=>(
                    <div key={i} style={{color:C.muted,marginBottom:4}}>{"0123"[i]}. {s}</div>
                  ))}
                </div>
              </div>
            </HelpSection>

            <HelpSection title="❓ よくある質問" C={C}>
              {[
                {q:"出勤だけ先に保存できる？",a:"できます。退勤後に同じ日付で再保存すると自動マージされます。"},
                {q:"過去の記録を修正できる？",a:"履歴タブ → 日付をタップ → 「編集」で修正できます。"},
                {q:"データはどこに保存される？",a:"ブラウザ内とGoogleスプレッドシートの2箇所に保存されます。"},
                {q:"時給を変更したら過去も変わる？",a:"アプリ表示は変わりますが、スプレッドシートの過去データは変わりません。"},
              ].map((f,i)=>(
                <div key={i} style={{padding:"12px 0",borderBottom:`1px solid ${C.border}`}}>
                  <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>Q. {f.q}</div>
                  <div style={{fontSize:13,color:C.muted}}>A. {f.a}</div>
                </div>
              ))}
            </HelpSection>

            <div style={{textAlign:"center",marginTop:20,padding:"16px",background:"#f0fdf4",borderRadius:10,border:"1px solid #bbf7d0"}}>
              <div style={{fontSize:13,fontWeight:600,color:"#15803d",marginBottom:6}}>詳しい取扱説明書</div>
              <a href="https://work-tracker-sepia.vercel.app/help" target="_blank"
                style={{fontSize:13,color:"#15803d",fontWeight:700}}>
                オンラインマニュアルを開く →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub Components ───────────────────────────────────────────────────────────
function Lbl({children}){return <div style={{fontSize:13,fontWeight:600,color:"#4b5563",letterSpacing:"0.5px",marginBottom:6}}>{children}</div>;}
function Spin(){return <span style={{display:"inline-block",width:14,height:14,border:"2px solid rgba(255,255,255,0.4)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></span>;}

function SummaryCard({t,settings,C}){
  const rows=[
    {label:"通常時間",min:t.nm,rate:settings.hourlyRate,pay:t.normalPay,color:C.text},
    {label:"残業手当",min:t.om,rate:settings.hourlyRate*1.25,pay:t.otPay,color:C.ot},
    {label:"深夜手当",min:t.ln,rate:settings.hourlyRate*1.25,pay:t.lnPay,color:C.ln},
    {label:"深夜残業",min:t.lno,rate:settings.hourlyRate*1.5,pay:t.lnoPay,color:C.lno},
  ].filter(r=>r.min>0);
  return(
    <div style={{background:"linear-gradient(135deg,#fff8ee,#ffffff)",border:`1px solid #d0d4db`,borderRadius:16,padding:"18px 18px 14px",position:"relative",overflow:"hidden",boxShadow:"0 2px 12px rgba(0,0,0,0.06)"}}>
      <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(184,134,11,0.06)"}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:t.totalBreakMin>0?8:14}}>
        <div>
          <div style={{fontSize:12,fontWeight:600,color:C.muted,letterSpacing:"1px",marginBottom:4}}>期間合計</div>
          <div style={{fontSize:32,fontWeight:800,color:C.gold,letterSpacing:"-1px"}}>{settings.currency}{Math.round(t.totalPay).toLocaleString()}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:12,fontWeight:600,color:C.muted,marginBottom:4}}>実働時間</div>
          <div style={{fontSize:24,fontWeight:700,color:C.text}}>{fmtH(t.totalMin)}</div>
          {t.totalBreakMin>0&&<div style={{fontSize:12,fontWeight:500,color:"#f59e0b"}}>休憩 {fmtH(t.totalBreakMin)}</div>}
        </div>
      </div>
      {rows.length>0&&(
        <div style={{borderTop:`1px solid #e0e3e8`,paddingTop:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:"4px 10px",alignItems:"center"}}>
            {["区分","時間","単価","金額"].map(h=><div key={h} style={{fontSize:12,fontWeight:600,color:C.dim,paddingBottom:4}}>{h}</div>)}
            {rows.map((r,i)=>(
              <div key={i} style={{display:"contents"}}>
                <div style={{fontSize:13,fontWeight:600,color:r.color}}>{r.label}</div>
                <div style={{fontSize:13,fontWeight:500,color:C.muted,textAlign:"right"}}>{fmtH(r.min)}</div>
                <div style={{fontSize:12,fontWeight:500,color:C.dim,textAlign:"right"}}>{settings.currency}{Math.round(r.rate).toLocaleString()}</div>
                <div style={{fontSize:14,fontWeight:700,color:r.color,textAlign:"right"}}>{settings.currency}{Math.round(r.pay).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WageBreakdown({w,settings,C,compact}){
  const rows=[
    {label:"通常時間",min:w.nm,rate:settings.hourlyRate,pay:w.normalPay,color:C.text},
    {label:"残業手当",min:w.om,rate:settings.hourlyRate*1.25,pay:w.otPay,color:C.ot},
    {label:"深夜手当",min:w.ln,rate:settings.hourlyRate*1.25,pay:w.lnPay,color:C.ln},
    {label:"深夜残業",min:w.lno,rate:settings.hourlyRate*1.5,pay:w.lnoPay,color:C.lno},
  ].filter(r=>r.min>0);
  return(
    <div style={{background:compact?"rgba(184,134,11,0.05)":"#f9fafb",border:`1px solid ${compact?"rgba(184,134,11,0.2)":C.border}`,borderRadius:10,padding:compact?"12px":"0"}}>
      {compact&&<div style={{fontSize:13,fontWeight:700,color:C.gold,marginBottom:8}}>給与内訳プレビュー</div>}
      {w.totalBreakMin>0&&(
        <div style={{fontSize:13,fontWeight:500,color:"#f59e0b",marginBottom:8,background:"#fffbeb",borderRadius:6,padding:"6px 10px",border:"1px solid #fde68a"}}>
          ☕ 休憩 {fmtH(w.totalBreakMin)} を差し引き済み
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:"4px 10px",alignItems:"center"}}>
        {["区分","時間","単価","金額"].map(h=><div key={h} style={{fontSize:12,fontWeight:600,color:C.dim,paddingBottom:2}}>{h}</div>)}
        {rows.map((r,i)=>(
          <div key={i} style={{display:"contents"}}>
            <div style={{fontSize:13,fontWeight:600,color:r.color}}>{r.label}</div>
            <div style={{fontSize:13,fontWeight:500,color:C.muted,textAlign:"right"}}>{fmtH(r.min)}</div>
            <div style={{fontSize:12,fontWeight:500,color:C.dim,textAlign:"right"}}>{settings.currency}{Math.round(r.rate).toLocaleString()}</div>
            <div style={{fontSize:14,fontWeight:700,color:r.color,textAlign:"right"}}>{settings.currency}{Math.round(r.pay).toLocaleString()}</div>
          </div>
        ))}
        <div style={{fontSize:14,fontWeight:700,color:C.gold,borderTop:`1px solid ${C.border}`,paddingTop:6,marginTop:2}}>合計</div>
        <div style={{fontSize:13,fontWeight:600,color:C.gold,textAlign:"right",borderTop:`1px solid ${C.border}`,paddingTop:6}}>{fmtH(w.totalMin)}</div>
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:6}}/>
        <div style={{fontSize:15,fontWeight:800,color:C.gold,textAlign:"right",borderTop:`1px solid ${C.border}`,paddingTop:6}}>{settings.currency}{Math.round(w.totalPay).toLocaleString()}</div>
      </div>
    </div>
  );
}


function HelpSection({title, children, C}) {
  return (
    <div style={{marginBottom:20}}>
      <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:12,paddingBottom:8,borderBottom:`2px solid ${C.gold}`}}>
        {title}
      </div>
      {children}
    </div>
  );
}

function arrowBtn(C){return{background:"none",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,fontSize:20,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700};}
function stampBtn(C){return{background:"#fff",border:`1px solid ${C.border}`,borderRadius:7,color:C.text,fontSize:13,fontWeight:600,padding:"0 10px",cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"};}
