import { useState, useEffect, useMemo, useRef } from "react";

const STORAGE_KEY   = "wt3_records";
const SETTINGS_KEY  = "wt3_settings";
const PERIOD_KEY    = "wt3_period";
const RATE_HIST_KEY = "wt3_rate_history";
const BACKUP_KEY    = "wt3_last_backup";

const DEFAULT_SETTINGS = { currency:"¥", closingDay:25 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toMin = (t) => { const [h,m]=t.split(":").map(Number); return h*60+m; };
const pad   = (n) => String(n).padStart(2,"0");
const fmtH  = (min) => { const h=Math.floor(Math.abs(min)/60),m=Math.abs(min)%60; return m===0?`${h}h`:`${h}h${pad(m)}m`; };
const fmtMoney = (n,cur) => `${cur}${Math.round(n).toLocaleString()}`;
const getTodayStr = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const nowStr = () => { const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateLbl = (s) => { const d=new Date(s+"T00:00:00"); return `${d.getMonth()+1}/${d.getDate()}(${["日","月","火","水","木","金","土"][d.getDay()]})`; };

// ─── 時給履歴から日付に対応する時給を取得 ─────────────────────────────────
function getRateForDate(dateStr, rateHistory) {
  if (!rateHistory || rateHistory.length === 0) return 1200;
  const sorted = [...rateHistory].sort((a,b) => b.from.localeCompare(a.from));
  const match = sorted.find(r => r.from <= dateStr);
  return match ? match.rate : sorted[sorted.length-1].rate;
}

// ─── Wage Calculation ─────────────────────────────────────────────────────────
function calcWage(segments, breaks, rate) {
  const breakSet = new Set();
  for (const b of (breaks||[])) {
    if (!b.in || !b.out) continue;
    const bs=toMin(b.in), be=toMin(b.out);
    if (be > bs) { for(let m=bs;m<be;m++) breakSet.add(m%(24*60)); }
  }
  let totalWorkMin=0,nm=0,om=0,ln=0,lno=0;
  for (const seg of segments) {
    if (!seg.in||!seg.out) continue;
    const start=toMin(seg.in);
    let end=toMin(seg.out);
    if (end<=start) end+=24*60; // 日またぎ対応
    for(let m=start;m<end;m++){
      const mod=m%(24*60);
      if(breakSet.has(mod)) continue;
      const isLate=mod>=22*60||mod<5*60;
      const isOT=totalWorkMin>=480;
      totalWorkMin++;
      if(!isOT&&!isLate) nm++;
      else if(isOT&&!isLate) om++;
      else if(!isOT&&isLate) ln++;
      else lno++;
    }
  }
  const normalPay=(nm/60)*rate,otPay=(om/60)*rate*1.25;
  const lnPay=(ln/60)*rate*1.25,lnoPay=(lno/60)*rate*1.5;
  return {nm,om,ln,lno,normalPay,otPay,lnPay,lnoPay,
    totalPay:normalPay+otPay+lnPay+lnoPay,
    totalMin:nm+om+ln+lno, totalBreakMin:breakSet.size};
}

// ─── Period Logic ─────────────────────────────────────────────────────────────
function getPeriodBounds(pk,cd){
  const [y,m]=pk.split("-").map(Number);
  if(cd===0){const last=new Date(y,m,0).getDate();return{start:`${y}-${pad(m)}-01`,end:`${y}-${pad(m)}-${pad(last)}`};}
  const fmt=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return{start:fmt(new Date(y,m-2,cd+1)),end:fmt(new Date(y,m-1,cd))};
}
const getPeriodLabel=(pk,cd)=>{
  const{start,end}=getPeriodBounds(pk,cd);
  if(cd===0)return pk.replace("-","年")+"月";
  const[,ms,ds]=start.split("-");const[,me,de]=end.split("-");
  return`${+ms}/${+ds} 〜 ${+me}/${+de}`;
};
const isInPeriod=(d,pk,cd)=>{const{start,end}=getPeriodBounds(pk,cd);return d>=start&&d<=end;};
const shiftPeriod=(pk,delta)=>{const[y,m]=pk.split("-").map(Number);const d=new Date(y,m-1+delta,1);return`${d.getFullYear()}-${pad(d.getMonth()+1)}`;};
function currentPeriodKey(cd){
  const t=new Date(),y=t.getFullYear(),m=t.getMonth()+1,day=t.getDate();
  if(cd===0)return`${y}-${pad(m)}`;
  if(day>cd){const d=new Date(y,m,1);return`${d.getFullYear()}-${pad(d.getMonth()+1)}`;}
  return`${y}-${pad(m)}`;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function recordsToCSVRows(records, rateHistory) {
  return records.map(r => {
    const rate = getRateForDate(r.date, rateHistory);
    const w = calcWage(r.segments, r.breaks||[], rate);
    const segStr = r.segments.map(s=>`${s.in||"-"}〜${s.out||"勤務中"}`).join(" / ");
    const brkStr = (r.breaks||[]).filter(b=>b.in&&b.out).map(b=>`${b.in}〜${b.out}`).join(" / ")||"なし";
    return [
      r.date, segStr, brkStr, fmtH(w.totalBreakMin), fmtH(w.totalMin),
      Math.round(w.normalPay), Math.round(w.otPay), Math.round(w.lnPay),
      Math.round(w.lnoPay), Math.round(w.totalPay), rate, r.memo||""
    ];
  });
}

function downloadCSV(records, rateHistory, label="勤怠記録") {
  const header = ["日付","勤務区間","休憩時間","休憩合計","実働時間","通常給与","残業手当","深夜手当","深夜残業","合計給与","時給","メモ"];
  const rows = recordsToCSVRows(records, rateHistory);
  const sorted = [...rows].sort((a,b)=>a[0].localeCompare(b[0]));
  const csv = [header,...sorted].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download=`${label}_${getTodayStr()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── CSV Import ───────────────────────────────────────────────────────────────
function parseCSVImport(text) {
  const lines = text.trim().split("\n").slice(1); // skip header
  const results = [];
  for (const line of lines) {
    const cols = line.split(",").map(c=>c.replace(/^"|"$/g,"").replace(/""/g,'"'));
    if (!cols[0]) continue;
    const date = cols[0];
    // parse segments from col[1]: "08:00〜17:00 / 18:00〜20:00"
    const segParts = cols[1]?.split(" / ")||[];
    const segments = segParts.map(s=>{
      const [i,o]=s.split("〜");
      return {in:i==="-"?"":i||"", out:o==="勤務中"?"":o||""};
    });
    // parse breaks from col[2]
    const brkParts = cols[2]==="なし"?[]:cols[2]?.split(" / ")||[];
    const breaks = brkParts.filter(b=>b&&b!=="なし").map(b=>{
      const [i,o]=b.split("〜");
      return {in:i||"",out:o||""};
    });
    results.push({id:Date.now().toString()+Math.random(),date,segments,breaks,memo:cols[11]||""});
  }
  return results;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function WorkTracker() {
  const [records,setRecords] = useState(()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY))||[];}catch{return[];}});
  const [settings,setSettings] = useState(()=>{try{return{...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY))};}catch{return DEFAULT_SETTINGS;}});
  const [rateHistory,setRateHistory] = useState(()=>{
    try{return JSON.parse(localStorage.getItem(RATE_HIST_KEY))||[{from:"2020-01-01",rate:1200}];}
    catch{return [{from:"2020-01-01",rate:1200}];}
  });
  const [periodKey,setPeriodKey] = useState(()=>{
    const s={...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}")};
    return localStorage.getItem(PERIOD_KEY)||currentPeriodKey(s.closingDay);
  });
  const [view,setView] = useState("input");
  const [settingsForm,setSettingsForm] = useState(settings);
  const [toast,setToast] = useState({msg:"",type:"ok"});
  const [expandedDay,setExpandedDay] = useState(null);
  const [warnings,setWarnings] = useState([]);
  const importRef = useRef();

  // Rate history form
  const [newRateFrom,setNewRateFrom] = useState(getTodayStr());
  const [newRateValue,setNewRateValue] = useState(1200);

  const emptyForm = () => ({id:null,date:getTodayStr(),segments:[{in:"",out:""}],breaks:[],memo:""});
  const [form,setForm] = useState(emptyForm());

  useEffect(()=>{localStorage.setItem(STORAGE_KEY,JSON.stringify(records));},[records]);
  useEffect(()=>{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));},[settings]);
  useEffect(()=>{localStorage.setItem(PERIOD_KEY,periodKey);},[periodKey]);
  useEffect(()=>{localStorage.setItem(RATE_HIST_KEY,JSON.stringify(rateHistory));},[rateHistory]);

  // 毎日自動バックアップ
  useEffect(()=>{
    const today = getTodayStr();
    const last = localStorage.getItem(BACKUP_KEY);
    if (last !== today && records.length > 0) {
      downloadCSV(records, rateHistory, "自動バックアップ");
      localStorage.setItem(BACKUP_KEY, today);
    }
  },[]);

  const showToast=(msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast({msg:"",type:"ok"}),2500);};

  const periodRecords=useMemo(()=>
    records.filter(r=>isInPeriod(r.date,periodKey,settings.closingDay))
      .sort((a,b)=>b.date.localeCompare(a.date)),
    [records,periodKey,settings.closingDay]);

  const periodTotals=useMemo(()=>{
    let nm=0,om=0,ln=0,lno=0,nP=0,oP=0,lP=0,loP=0,bMin=0;
    for(const r of periodRecords){
      const rate=getRateForDate(r.date,rateHistory);
      const w=calcWage(r.segments,r.breaks||[],rate);
      nm+=w.nm;om+=w.om;ln+=w.ln;lno+=w.lno;
      nP+=w.normalPay;oP+=w.otPay;lP+=w.lnPay;loP+=w.lnoPay;bMin+=w.totalBreakMin;
    }
    return{nm,om,ln,lno,normalPay:nP,otPay:oP,lnPay:lP,lnoPay:loP,
      totalPay:nP+oP+lP+loP,totalMin:nm+om+ln+lno,totalBreakMin:bMin};
  },[periodRecords,rateHistory]);

  // Segments
  const updSeg=(i,f,v)=>setForm(fm=>{const s=[...fm.segments];s[i]={...s[i],[f]:v};return{...fm,segments:s};});
  const addSeg=()=>setForm(f=>({...f,segments:[...f.segments,{in:"",out:""}]}));
  const rmSeg=(i)=>setForm(f=>({...f,segments:f.segments.filter((_,idx)=>idx!==i)}));
  const stampSeg=(i,field)=>updSeg(i,field,nowStr());

  // Breaks - 開始なし警告
  const updBrk=(i,f,v)=>{
    setForm(fm=>{const b=[...fm.breaks];b[i]={...b[i],[f]:v};return{...fm,breaks:b};});
    if(f==="out"){
      setForm(fm=>{
        const brk=fm.breaks[i];
        if(!brk?.in && v){
          setWarnings(w=>[...w,`休憩${i+1}：開始時間が未入力です`]);
          setTimeout(()=>setWarnings([]),3000);
        }
        return fm;
      });
    }
  };
  const addBrk=()=>setForm(f=>({...f,breaks:[...f.breaks,{in:"",out:""}]}));
  const rmBrk=(i)=>setForm(f=>({...f,breaks:f.breaks.filter((_,idx)=>idx!==i)}));
  const stampBrk=(i,field)=>{
    if(field==="out"){
      const brk=form.breaks[i];
      if(!brk?.in){
        setWarnings([`休憩${i+1}：開始時間を先に入力してください`]);
        setTimeout(()=>setWarnings([]),3000);
        return;
      }
    }
    updBrk(i,field,nowStr());
  };

  const currentRate = useMemo(()=>getRateForDate(form.date,rateHistory),[form.date,rateHistory]);
  const formWage = useMemo(()=>calcWage(form.segments,form.breaks,currentRate),[form.segments,form.breaks,currentRate]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = () => {
    if(!form.segments.some(s=>s.in||s.out)) return;

    // 休憩バリデーション：終了だけ入っている場合警告
    const brkWarns = form.breaks
      .map((b,i)=>(!b.in&&b.out)?`休憩${i+1}：開始時間が未入力です`:null)
      .filter(Boolean);
    if(brkWarns.length>0){
      setWarnings(brkWarns);
      setTimeout(()=>setWarnings([]),4000);
      // 警告は出すが保存は続行
    }

    let updatedRecords,savedRecord,toastMsg="保存しました";
    if(form.id){
      savedRecord={...form};
      updatedRecords=records.map(r=>r.id===form.id?savedRecord:r);
      toastMsg="更新しました";
    } else {
      const existing=records.find(r=>r.date===form.date);
      if(existing){
        const mergedSegs=existing.segments.map(s=>({...s}));
        for(const ns of form.segments){
          if(ns.in&&!ns.out) mergedSegs.push({in:ns.in,out:""});
          else if(!ns.in&&ns.out){
            const idx=mergedSegs.findIndex(s=>s.in&&!s.out);
            if(idx>=0)mergedSegs[idx]={...mergedSegs[idx],out:ns.out};
            else mergedSegs.push({in:"",out:ns.out});
          } else if(ns.in&&ns.out) mergedSegs.push({...ns});
        }
        // 休憩マージ（重複除去）
        const allBreaks=[...(existing.breaks||[]),...form.breaks];
        const uniqueBreaks=allBreaks.filter((b,i,arr)=>
          b.in&&b.out&&arr.findIndex(x=>x.in===b.in&&x.out===b.out)===i
        );
        savedRecord={...existing,segments:mergedSegs,breaks:uniqueBreaks,memo:form.memo||existing.memo};
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
  };

  const handleDelete=(id)=>{setRecords(prev=>prev.filter(r=>r.id!==id));showToast("削除しました");};
  const handleEdit=(r)=>{setForm({id:r.id,date:r.date,segments:r.segments.map(s=>({...s})),breaks:(r.breaks||[]).map(b=>({...b})),memo:r.memo||""});setView("input");setExpandedDay(null);};
  const handleSettingsSave=()=>{setSettings({...settingsForm});setPeriodKey(currentPeriodKey(settingsForm.closingDay));showToast("設定を保存しました");};

  const handleAddRate=()=>{
    if(!newRateFrom||!newRateValue) return;
    const updated=[...rateHistory.filter(r=>r.from!==newRateFrom),{from:newRateFrom,rate:Number(newRateValue)}]
      .sort((a,b)=>a.from.localeCompare(b.from));
    setRateHistory(updated);
    showToast(`${newRateFrom}から¥${Number(newRateValue).toLocaleString()}に設定しました`);
  };
  const handleRemoveRate=(from)=>{
    if(rateHistory.length<=1){showToast("最低1件の時給が必要です","err");return;}
    setRateHistory(prev=>prev.filter(r=>r.from!==from));
  };

  // CSV Import
  const handleImport=(e)=>{
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      const imported=parseCSVImport(ev.target.result);
      if(imported.length===0){showToast("インポートできるデータがありませんでした","err");return;}
      // 既存データとマージ（日付が一致する場合は上書き）
      const merged=[...records];
      for(const imp of imported){
        const idx=merged.findIndex(r=>r.date===imp.date);
        if(idx>=0) merged[idx]={...merged[idx],...imp};
        else merged.push(imp);
      }
      setRecords(merged);
      showToast(`${imported.length}件をインポートしました`);
    };
    reader.readAsText(file,"UTF-8");
    e.target.value="";
  };

  // ─── Colors ───────────────────────────────────────────────────────────────
  const C={bg:"#f5f6f8",surface:"#ffffff",border:"#e0e3e8",borderAccent:"#d0d4db",
    gold:"#b8860b",text:"#1a1a2e",muted:"#6b7280",dim:"#9ca3af",
    green:"#16a34a",blue:"#2563eb",red:"#dc2626",ot:"#ea580c",ln:"#7c3aed",lno:"#be185d",
    orange:"#f59e0b"};
  const inp={background:"#f9fafb",border:`1px solid ${C.border}`,borderRadius:8,
    color:C.text,fontSize:16,fontWeight:500,padding:"9px 12px",outline:"none",
    fontFamily:"inherit",boxSizing:"border-box",width:"100%"};

  const SaveBtn=({label="保存"})=>(
    <button onClick={handleSave} style={{
      padding:"4px 10px",borderRadius:7,border:"none",
      background:C.gold,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",
    }}>{label}</button>
  );

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,
      fontFamily:"'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif",
      display:"flex",flexDirection:"column",alignItems:"center",paddingBottom:60}}>

      {/* Toast */}
      {toast.msg&&(
        <div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",
          background:"#fff",border:`1px solid ${toast.type==="err"?C.red:C.gold}`,
          borderRadius:10,padding:"10px 22px",fontSize:14,fontWeight:600,
          color:toast.type==="err"?C.red:C.gold,zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.12)",whiteSpace:"nowrap"}}>
          {toast.type==="err"?"⚠️":"✓"} {toast.msg}
        </div>
      )}

      {/* Warning */}
      {warnings.length>0&&(
        <div style={{position:"fixed",top:70,left:"50%",transform:"translateX(-50%)",
          background:"#fff",border:"1px solid #f59e0b",borderRadius:10,padding:"10px 18px",
          fontSize:13,fontWeight:600,color:"#92400e",zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.1)"}}>
          {warnings.map((w,i)=><div key={i}>⚠️ {w}</div>)}
        </div>
      )}

      <div style={{width:"100%",maxWidth:500,padding:"28px 16px 0",boxSizing:"border-box"}}>

        {/* Header */}
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:22,fontWeight:800,color:C.text}}>勤怠・給与管理</span>
            <span style={{fontSize:11,color:"#15803d",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:6,padding:"3px 8px",fontWeight:600}}>📥 CSV対応</span>
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

        <SummaryCard t={periodTotals} rateHistory={rateHistory} C={C} settings={settings}/>

        {/* Nav */}
        <div style={{display:"flex",gap:6,margin:"18px 0 20px"}}>
          {[["input","✏️ 打刻"],["history","📋 履歴"],["settings","⚙️ 設定"],["help","❓ 使い方"]].map(([k,label])=>(
            <button key={k} onClick={()=>setView(k)} style={{flex:1,padding:"10px 4px",borderRadius:9,border:"none",
              background:view===k?C.gold:C.surface,color:view===k?"#fff":C.muted,
              fontWeight:view===k?700:500,fontSize:12,cursor:"pointer",
              boxShadow:view===k?"0 2px 8px rgba(184,134,11,0.3)":"none"}}>{label}</button>
          ))}
        </div>

        {/* ── INPUT ─────────────────────────────────────────────────────── */}
        {view==="input"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <div style={{marginBottom:14}}>
              <Lbl>日付</Lbl>
              <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={inp}/>
              <div style={{fontSize:12,color:C.muted,marginTop:4,fontWeight:500}}>
                適用時給：{C.currency||"¥"}{getRateForDate(form.date,rateHistory).toLocaleString()}円
              </div>
            </div>

            <Lbl>出退勤</Lbl>
            {form.segments.map((seg,i)=>(
              <div key={i} style={{background:"#f3f4f6",border:`1px solid ${C.borderAccent}`,borderRadius:10,padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",marginBottom:8,gap:6}}>
                  <span style={{fontSize:13,fontWeight:600,color:C.muted}}>区間 {i+1}</span>
                  {i>0&&<span style={{fontSize:12,fontWeight:600,color:C.blue}}>（中抜け後）</span>}
                  <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
                    <SaveBtn/>
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

            <Lbl>☕ 休憩時間</Lbl>
            {form.breaks.length===0&&<div style={{fontSize:13,color:C.dim,marginBottom:8,fontWeight:500}}>休憩なし</div>}
            {form.breaks.map((brk,i)=>(
              <div key={i} style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",marginBottom:8,gap:6}}>
                  <span style={{fontSize:13,fontWeight:600,color:C.orange}}>休憩 {i+1}</span>
                  {brk.in&&brk.out&&<span style={{fontSize:12,color:C.orange,fontWeight:600}}>（{fmtH(toMin(brk.out)-toMin(brk.in))}）</span>}
                  <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
                    <SaveBtn/>
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

            <div style={{marginBottom:16}}>
              <Lbl>メモ（任意）</Lbl>
              <input type="text" value={form.memo} placeholder="業務内容など" onChange={e=>setForm(f=>({...f,memo:e.target.value}))} style={inp}/>
            </div>

            {formWage.totalMin>0&&<WageBreakdown w={formWage} rate={currentRate} C={C} compact/>}

            <button onClick={handleSave} style={{width:"100%",marginTop:14,padding:"14px 0",borderRadius:10,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:16,cursor:"pointer"}}>
              {form.id?"更新する":"記録を保存"}
            </button>
            {form.id&&<button onClick={()=>setForm(emptyForm())} style={{width:"100%",marginTop:8,padding:"10px 0",borderRadius:10,border:`1px solid ${C.border}`,background:"none",color:C.muted,fontSize:15,fontWeight:500,cursor:"pointer"}}>キャンセル</button>}

            <div style={{marginTop:12,padding:"10px 12px",borderRadius:8,background:"#f0fdf4",border:"1px solid #bbf7d0",fontSize:12,fontWeight:500,color:"#15803d"}}>
              📥 データはこのデバイスに保存。履歴タブからCSVダウンロードできます。
            </div>
          </div>
        )}

        {/* ── HISTORY ───────────────────────────────────────────────────── */}
        {view==="history"&&(
          <div>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={()=>downloadCSV(periodRecords,rateHistory,`勤怠_${getPeriodLabel(periodKey,settings.closingDay)}`)} style={{
                flex:1,padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,
                background:C.surface,color:C.gold,fontWeight:700,fontSize:14,cursor:"pointer",
              }}>📥 この期間をCSV出力</button>
              <button onClick={()=>downloadCSV(records,rateHistory,"勤怠_全期間")} style={{
                padding:"11px 14px",borderRadius:10,border:`1px solid ${C.border}`,
                background:C.surface,color:C.muted,fontWeight:600,fontSize:13,cursor:"pointer",
              }}>全期間</button>
              <button onClick={()=>importRef.current.click()} style={{
                padding:"11px 14px",borderRadius:10,border:`1px solid ${C.border}`,
                background:C.surface,color:C.blue,fontWeight:600,fontSize:13,cursor:"pointer",
              }}>📂 取込</button>
              <input ref={importRef} type="file" accept=".csv" onChange={handleImport} style={{display:"none"}}/>
            </div>

            {periodRecords.length===0
              ?<div style={{textAlign:"center",padding:"40px 0",color:C.dim,fontSize:15,fontWeight:500}}>この期間の記録はありません</div>
              :periodRecords.map(r=>{
                const rate=getRateForDate(r.date,rateHistory);
                const w=calcWage(r.segments,r.breaks||[],rate);
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
                            ☕ 休憩 {fmtH(w.totalBreakMin)}
                          </div>
                        )}
                      </div>
                      <div style={{textAlign:"right",marginRight:10}}>
                        <div style={{color:w.totalMin===0?C.green:C.gold,fontWeight:700,fontSize:16}}>
                          {w.totalMin===0?"勤務中":fmtMoney(w.totalPay,settings.currency||"¥")}
                        </div>
                        <div style={{fontSize:12,fontWeight:500,color:C.muted}}>{w.totalMin>0?fmtH(w.totalMin):""}</div>
                        <div style={{fontSize:11,color:C.dim}}>時給¥{rate.toLocaleString()}</div>
                      </div>
                      <span style={{color:C.muted,fontSize:14,fontWeight:600}}>{isOpen?"▲":"▼"}</span>
                    </div>
                    {isOpen&&(
                      <div style={{borderTop:`1px solid ${C.border}`,padding:"12px 14px"}}>
                        <WageBreakdown w={w} rate={rate} C={C}/>
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
            <div style={{marginBottom:16}}><Lbl>通貨記号</Lbl><input type="text" value={settingsForm.currency||"¥"} maxLength={3} onChange={e=>setSettingsForm(s=>({...s,currency:e.target.value}))} style={{...inp,width:80}}/></div>
            <div style={{marginBottom:20}}>
              <Lbl>締め日</Lbl>
              <select value={settingsForm.closingDay} onChange={e=>setSettingsForm(s=>({...s,closingDay:Number(e.target.value)}))} style={{...inp,cursor:"pointer"}}>
                {[...Array(28)].map((_,i)=><option key={i+1} value={i+1}>{i+1}日締め</option>)}
                <option value={0}>月末締め</option>
              </select>
            </div>
            <button onClick={handleSettingsSave} style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:20}}>設定を保存</button>

            {/* 時給履歴 */}
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16,marginBottom:16}}>
              <Lbl>💰 時給履歴（日単位）</Lbl>
              <div style={{fontSize:12,color:C.muted,marginBottom:10,fontWeight:500}}>
                日付ごとに時給を設定できます。その日以降のレコードに自動適用されます。
              </div>
              {[...rateHistory].sort((a,b)=>b.from.localeCompare(a.from)).map(r=>(
                <div key={r.from} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#f3f4f6",borderRadius:8,marginBottom:6}}>
                  <span style={{fontSize:14,fontWeight:600}}>{r.from}〜</span>
                  <span style={{fontSize:15,fontWeight:700,color:C.gold}}>¥{r.rate.toLocaleString()}</span>
                  <button onClick={()=>handleRemoveRate(r.from)} style={{background:"none",border:"none",color:C.red,fontSize:16,cursor:"pointer"}}>×</button>
                </div>
              ))}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,marginTop:10}}>
                <input type="date" value={newRateFrom} onChange={e=>setNewRateFrom(e.target.value)} style={inp}/>
                <input type="number" value={newRateValue} onChange={e=>setNewRateValue(e.target.value)} placeholder="時給" style={inp}/>
                <button onClick={handleAddRate} style={{padding:"9px 14px",borderRadius:8,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>追加</button>
              </div>
            </div>

            {/* CSV */}
            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16}}>
              <Lbl>📥 データ管理</Lbl>
              <div style={{fontSize:12,color:C.muted,marginBottom:10,fontWeight:500,background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px"}}>
                ✅ 完全無料・費用ゼロ<br/>
                📥 CSVダウンロード → ExcelやGoogleスプレッドシートで開けます<br/>
                📂 CSVを修正して再取込も可能<br/>
                🔄 アプリを開くたびに自動バックアップ
              </div>
              <button onClick={()=>downloadCSV(records,rateHistory,"勤怠_全データバックアップ")} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.gold,fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:8}}>
                📥 全データをCSVバックアップ
              </button>
              <button onClick={()=>importRef.current.click()} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.blue,fontWeight:700,fontSize:14,cursor:"pointer"}}>
                📂 CSVから取込（修正データ）
              </button>
              <input ref={importRef} type="file" accept=".csv" onChange={handleImport} style={{display:"none"}}/>
            </div>
          </div>
        )}

        {/* ── HELP ──────────────────────────────────────────────────────── */}
        {view==="help"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <HelpSection title="📱 基本の使い方" C={C}>
              {[
                {n:"1",h:"出勤時：「今」ボタンをタップ",p:"出勤欄の「今」をタップで現在時刻が自動入力されます。"},
                {n:"2",h:"保存ボタンで即保存",p:"各区間の右上にある「保存」ボタン、または一番下の「記録を保存」で保存。"},
                {n:"3",h:"退勤時も同様に",p:"同じ日付で退勤時刻を入力して保存すると自動マージされます。"},
                {n:"4",h:"履歴タブでCSV出力",p:"期間ごとにCSV出力できます。ExcelやGoogleスプレッドシートで開けます。"},
              ].map((s,i)=>(
                <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
                  <div style={{background:C.gold,color:"#fff",fontWeight:800,fontSize:13,width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{s.n}</div>
                  <div><div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{s.h}</div><div style={{fontSize:13,color:C.muted}}>{s.p}</div></div>
                </div>
              ))}
            </HelpSection>
            <HelpSection title="💰 時給の日単位変更" C={C}>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.9}}>
                <div>設定タブ → 時給履歴から日付と時給を追加</div>
                <div>例：5/1から¥1,200、5/10から¥1,250に変更</div>
                <div>→ 各レコードの日付に応じた時給で自動計算されます</div>
              </div>
            </HelpSection>
            <HelpSection title="📥 CSVの使い方" C={C}>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.9}}>
                <div>① 履歴タブ → 「この期間をCSV出力」</div>
                <div>② ExcelやGoogleスプレッドシートで開いて修正</div>
                <div>③ 履歴タブ → 「📂取込」で修正データを再インポート</div>
                <div style={{marginTop:8,padding:"8px",background:"#fffbeb",borderRadius:6,border:"1px solid #fde68a",color:"#92400e",fontWeight:500}}>
                  ⚠️ インポート時は日付が一致するレコードが上書きされます
                </div>
              </div>
            </HelpSection>
            <HelpSection title="⚠️ 注意事項" C={C}>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.9}}>
                <div>• 日またぎ勤務（例：23:00〜翌7:00）も正確に計算されます</div>
                <div>• ブラウザのデータ消去でデータが消えます。定期的にCSVバックアップを推奨</div>
                <div>• アプリを開くたびに自動バックアップCSVがダウンロードされます</div>
              </div>
            </HelpSection>
          </div>
        )}
      </div>
    </div>
  );
}

function Lbl({children}){return <div style={{fontSize:13,fontWeight:600,color:"#4b5563",letterSpacing:"0.5px",marginBottom:6}}>{children}</div>;}

function HelpSection({title,children,C}){
  return(
    <div style={{marginBottom:20}}>
      <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:12,paddingBottom:8,borderBottom:`2px solid ${C.gold}`}}>{title}</div>
      {children}
    </div>
  );
}

function SummaryCard({t,settings,rateHistory,C}){
  const cur=settings.currency||"¥";
  const rows=[
    {label:"通常時間",min:t.nm,rate:null,pay:t.normalPay,color:C.text},
    {label:"残業手当",min:t.om,rate:null,pay:t.otPay,color:C.ot},
    {label:"深夜手当",min:t.ln,rate:null,pay:t.lnPay,color:C.ln},
    {label:"深夜残業",min:t.lno,rate:null,pay:t.lnoPay,color:C.lno},
  ].filter(r=>r.min>0);
  return(
    <div style={{background:"linear-gradient(135deg,#fff8ee,#ffffff)",border:"1px solid #d0d4db",borderRadius:16,padding:"18px 18px 14px",position:"relative",overflow:"hidden",boxShadow:"0 2px 12px rgba(0,0,0,0.06)"}}>
      <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(184,134,11,0.06)"}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
        <div>
          <div style={{fontSize:12,fontWeight:600,color:C.muted,letterSpacing:"1px",marginBottom:4}}>期間合計</div>
          <div style={{fontSize:32,fontWeight:800,color:C.gold,letterSpacing:"-1px"}}>{cur}{Math.round(t.totalPay).toLocaleString()}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:12,fontWeight:600,color:C.muted,marginBottom:4}}>実働時間</div>
          <div style={{fontSize:24,fontWeight:700,color:C.text}}>{fmtH(t.totalMin)}</div>
          {t.totalBreakMin>0&&<div style={{fontSize:12,fontWeight:500,color:"#f59e0b"}}>休憩 {fmtH(t.totalBreakMin)}</div>}
        </div>
      </div>
      {rows.length>0&&(
        <div style={{borderTop:"1px solid #e0e3e8",paddingTop:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:"4px 10px",alignItems:"center"}}>
            {["区分","時間","金額"].map(h=><div key={h} style={{fontSize:12,fontWeight:600,color:C.dim,paddingBottom:4}}>{h}</div>)}
            {rows.map((r,i)=>(
              <div key={i} style={{display:"contents"}}>
                <div style={{fontSize:13,fontWeight:600,color:r.color}}>{r.label}</div>
                <div style={{fontSize:13,fontWeight:500,color:C.muted,textAlign:"right"}}>{fmtH(r.min)}</div>
                <div style={{fontSize:14,fontWeight:700,color:r.color,textAlign:"right"}}>{cur}{Math.round(r.pay).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WageBreakdown({w,rate,C,compact}){
  const rows=[
    {label:"通常時間",min:w.nm,r:rate,pay:w.normalPay,color:C.text},
    {label:"残業手当",min:w.om,r:Math.round(rate*1.25),pay:w.otPay,color:C.ot},
    {label:"深夜手当",min:w.ln,r:Math.round(rate*1.25),pay:w.lnPay,color:C.ln},
    {label:"深夜残業",min:w.lno,r:Math.round(rate*1.5),pay:w.lnoPay,color:C.lno},
  ].filter(r=>r.min>0);
  return(
    <div style={{background:compact?"rgba(184,134,11,0.05)":"#f9fafb",border:`1px solid ${compact?"rgba(184,134,11,0.2)":C.border}`,borderRadius:10,padding:compact?"12px":"0"}}>
      {compact&&<div style={{fontSize:13,fontWeight:700,color:C.gold,marginBottom:8}}>給与内訳プレビュー</div>}
      {w.totalBreakMin>0&&<div style={{fontSize:13,fontWeight:500,color:"#f59e0b",marginBottom:8,background:"#fffbeb",borderRadius:6,padding:"6px 10px",border:"1px solid #fde68a"}}>☕ 休憩 {fmtH(w.totalBreakMin)} を差し引き済み</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:"4px 10px",alignItems:"center"}}>
        {["区分","時間","単価","金額"].map(h=><div key={h} style={{fontSize:12,fontWeight:600,color:C.dim,paddingBottom:2}}>{h}</div>)}
        {rows.map((r,i)=>(
          <div key={i} style={{display:"contents"}}>
            <div style={{fontSize:13,fontWeight:600,color:r.color}}>{r.label}</div>
            <div style={{fontSize:13,fontWeight:500,color:C.muted,textAlign:"right"}}>{fmtH(r.min)}</div>
            <div style={{fontSize:12,fontWeight:500,color:C.dim,textAlign:"right"}}>¥{r.r.toLocaleString()}</div>
            <div style={{fontSize:14,fontWeight:700,color:r.color,textAlign:"right"}}>¥{Math.round(r.pay).toLocaleString()}</div>
          </div>
        ))}
        <div style={{fontSize:14,fontWeight:700,color:C.gold,borderTop:`1px solid ${C.border}`,paddingTop:6,marginTop:2}}>合計</div>
        <div style={{fontSize:13,fontWeight:600,color:C.gold,textAlign:"right",borderTop:`1px solid ${C.border}`,paddingTop:6}}>{fmtH(w.totalMin)}</div>
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:6}}/>
        <div style={{fontSize:15,fontWeight:800,color:C.gold,textAlign:"right",borderTop:`1px solid ${C.border}`,paddingTop:6}}>¥{Math.round(w.totalPay).toLocaleString()}</div>
      </div>
    </div>
  );
}

function arrowBtn(C){return{background:"none",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,fontSize:20,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700};}
function stampBtn(C){return{background:"#fff",border:`1px solid ${C.border}`,borderRadius:7,color:C.text,fontSize:13,fontWeight:600,padding:"0 10px",cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"};}
