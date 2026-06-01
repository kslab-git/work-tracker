import { useState, useEffect, useMemo, useRef } from "react";

// ─── Storage Keys ──────────────────────────────────────────────────────────────
const STORAGE_KEY  = "wt4_records";
const SETTINGS_KEY = "wt4_settings";
const PERIOD_KEY   = "wt4_period";
const BACKUP_KEY   = "wt4_last_backup";

// 職場定義
const WPS = ["A","B"];
const DEFAULT_WP = (id) => ({
  name: id === "A" ? "職場A" : "職場B",
  rateHistory: [{ from: "2020-01-01", rate: 1200 }],
  closingDay: 25,
  payDay: 10,
});
const DEFAULT_SETTINGS = {
  currency: "¥",
  workplaces: { A: DEFAULT_WP("A"), B: DEFAULT_WP("B") },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
const toMin  = (t) => { const [h,m]=t.split(":").map(Number); return h*60+m; };
const pad    = (n) => String(n).padStart(2,"0");
const fmtH   = (min) => { const h=Math.floor(Math.abs(min)/60),m=Math.abs(min)%60; return m===0?`${h}h`:`${h}h${pad(m)}m`; };
const fmtMoney = (n,cur="¥") => `${cur}${Math.round(n).toLocaleString()}`;
const getTodayStr = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const nowStr  = () => { const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateLbl = (s) => { const d=new Date(s+"T00:00:00"); return `${d.getMonth()+1}/${d.getDate()}(${["日","月","火","水","木","金","土"][d.getDay()]})`; };

function getRateForDate(dateStr, rateHistory) {
  if (!rateHistory || rateHistory.length === 0) return 1200;
  const sorted = [...rateHistory].sort((a,b)=>b.from.localeCompare(a.from));
  const match = sorted.find(r=>r.from<=dateStr);
  return match ? match.rate : sorted[sorted.length-1].rate;
}

// ─── 給与計算（労基法準拠）───────────────────────────────────────────────────
function calcWage(segments, breaks, rate) {
  const breakSet = new Set();
  for (const b of (breaks||[])) {
    if (!b.in||!b.out) continue;
    const bs=toMin(b.in), be=toMin(b.out);
    if (be>bs) { for(let m=bs;m<be;m++) breakSet.add(m%(24*60)); }
  }
  let totalWorkMin=0,nm=0,om=0,ln=0,lno=0;
  for (const seg of segments) {
    if (!seg.in||!seg.out) continue;
    const start=toMin(seg.in);
    let end=toMin(seg.out);
    if (end<=start) end+=24*60;
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
  const normalPay=(nm/60)*rate, otPay=(om/60)*rate*1.25;
  const lnPay=(ln/60)*rate*1.25, lnoPay=(lno/60)*rate*1.5;
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
const minToDecimal = (min) => Math.round(min/60*100)/100;

function downloadCSV(records, settings, label="勤怠記録") {
  const cur = settings.currency||"¥";
  const wps = settings.workplaces||{};
  const header = [
    "日付","曜日",
    "A出勤1","A退勤1","A出勤2","A退勤2","A休憩","A休憩合計h",
    "A通常h","A通常給与","A残業h","A残業給与","A深夜h","A深夜給与","A深夜残業h","A深夜残業給与","A小計",
    "B出勤1","B退勤1","B出勤2","B退勤2","B休憩","B休憩合計h",
    "B通常h","B通常給与","B残業h","B残業給与","B深夜h","B深夜給与","B深夜残業h","B深夜残業給与","B小計",
    "合計給与","メモ"
  ];
  const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
  const rows=sorted.map(r=>{
    const d=new Date(r.date+"T00:00:00");
    const wd=["日","月","火","水","木","金","土"][d.getDay()];
    const row=[r.date,wd];
    let grandTotal=0;
    for(const wp of WPS){
      const wpRec=r[wp];
      const wpCfg=wps[wp]||DEFAULT_WP(wp);
      if(!wpRec||!(wpRec.segments||[]).some(s=>s.in||s.out)){
        row.push("","","","","","","","","","","","","","","","");
        continue;
      }
      const rate=getRateForDate(r.date,wpCfg.rateHistory);
      const w=calcWage(wpRec.segments||[],wpRec.breaks||[],rate);
      const segs=wpRec.segments||[];
      const brkStr=(wpRec.breaks||[]).filter(b=>b.in&&b.out).map(b=>`${b.in}〜${b.out}`).join(" / ")||"なし";
      row.push(
        segs[0]?.in||"",segs[0]?.out||"",
        segs[1]?.in||"",segs[1]?.out||"",
        brkStr,minToDecimal(w.totalBreakMin),
        minToDecimal(w.nm),Math.round(w.normalPay),
        minToDecimal(w.om),Math.round(w.otPay),
        minToDecimal(w.ln),Math.round(w.lnPay),
        minToDecimal(w.lno),Math.round(w.lnoPay),
        Math.round(w.totalPay)
      );
      grandTotal+=w.totalPay;
    }
    row.push(Math.round(grandTotal),r.memo||"");
    return row;
  });
  const allRows=[header,...rows];
  const csv=allRows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;a.download=`${label}_${getTodayStr()}.csv`;a.click();
  URL.revokeObjectURL(url);
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function WorkTracker() {
  const [records,setRecords]=useState(()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY))||[];}catch{return[];}});
  const [settings,setSettings]=useState(()=>{
    try{
      const s={...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}")};
      if(!s.workplaces) s.workplaces={A:DEFAULT_WP("A"),B:DEFAULT_WP("B")};
      if(!s.workplaces.A) s.workplaces.A=DEFAULT_WP("A");
      if(!s.workplaces.B) s.workplaces.B=DEFAULT_WP("B");
      return s;
    }catch{return DEFAULT_SETTINGS;}
  });
  const [periodKey,setPeriodKey]=useState(()=>{
    const s={...DEFAULT_SETTINGS,...JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}")};
    const cd=s.workplaces?.A?.closingDay||25;
    return localStorage.getItem(PERIOD_KEY)||currentPeriodKey(cd);
  });
  const [view,setView]=useState("input");
  const [activeWP,setActiveWP]=useState("A");
  const [summaryMode,setSummaryMode]=useState("closing"); // "closing" | "payMonth"
  const [toast,setToast]=useState({msg:"",type:"ok"});
  const [expandedDay,setExpandedDay]=useState(null);
  const [warnings,setWarnings]=useState([]);
  const [settingsForm,setSettingsForm]=useState(()=>JSON.parse(JSON.stringify(settings)));
  const importRef=useRef();

  const emptyForm=()=>({id:null,date:getTodayStr(),wp:activeWP,segments:[{in:"",out:""}],breaks:[],memo:""});
  const [form,setForm]=useState(emptyForm());

  useEffect(()=>{localStorage.setItem(STORAGE_KEY,JSON.stringify(records));},[records]);
  useEffect(()=>{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));},[settings]);
  useEffect(()=>{localStorage.setItem(PERIOD_KEY,periodKey);},[periodKey]);

  // 毎日自動バックアップ
  useEffect(()=>{
    const today=getTodayStr();
    const last=localStorage.getItem(BACKUP_KEY);
    if(last!==today&&records.length>0){
      downloadCSV(records,settings,"自動バックアップ");
      localStorage.setItem(BACKUP_KEY,today);
    }
  },[]);

  const showToast=(msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast({msg:"",type:"ok"}),2500);};

  const activeCD=settings.workplaces[activeWP]?.closingDay||25;
  const periodRecords=useMemo(()=>
    records.filter(r=>isInPeriod(r.date,periodKey,activeCD))
      .sort((a,b)=>b.date.localeCompare(a.date)),
    [records,periodKey,activeCD]);

  const periodTotals=useMemo(()=>{
    const result={A:{nm:0,om:0,ln:0,lno:0,normalPay:0,otPay:0,lnPay:0,lnoPay:0,totalPay:0,totalMin:0,totalBreakMin:0},
                  B:{nm:0,om:0,ln:0,lno:0,normalPay:0,otPay:0,lnPay:0,lnoPay:0,totalPay:0,totalMin:0,totalBreakMin:0}};
    for(const r of periodRecords){
      for(const wp of WPS){
        const wpRec=r[wp];
        if(!wpRec||(wpRec.segments||[]).every(s=>!s.in&&!s.out)) continue;
        const rate=getRateForDate(r.date,settings.workplaces[wp]?.rateHistory||[]);
        const w=calcWage(wpRec.segments||[],wpRec.breaks||[],rate);
        const t=result[wp];
        t.nm+=w.nm;t.om+=w.om;t.ln+=w.ln;t.lno+=w.lno;
        t.normalPay+=w.normalPay;t.otPay+=w.otPay;t.lnPay+=w.lnPay;t.lnoPay+=w.lnoPay;
        t.totalPay+=w.totalPay;t.totalMin+=w.totalMin;t.totalBreakMin+=w.totalBreakMin;
      }
    }
    return result;
  },[periodRecords,settings]);

  const combinedTotals=useMemo(()=>{
    const a=periodTotals.A,b=periodTotals.B;
    return{totalPay:a.totalPay+b.totalPay,totalMin:a.totalMin+b.totalMin,totalBreakMin:a.totalBreakMin+b.totalBreakMin};
  },[periodTotals]);

  // Segments
  const updSeg=(i,f,v)=>setForm(fm=>{const s=[...fm.segments];s[i]={...s[i],[f]:v};return{...fm,segments:s};});
  const addSeg=()=>{if(form.segments.length>=2) return;setForm(f=>({...f,segments:[...f.segments,{in:"",out:""}]}));};
  const rmSeg=(i)=>setForm(f=>({...f,segments:f.segments.filter((_,idx)=>idx!==i)}));
  const stampSeg=(i,field)=>updSeg(i,field,nowStr());

  const updBrk=(i,f,v)=>{
    setForm(fm=>{const b=[...fm.breaks];b[i]={...b[i],[f]:v};return{...fm,breaks:b};});
    if(f==="out"){
      setForm(fm=>{
        const brk=fm.breaks[i];
        if(!brk?.in&&v){setWarnings(w=>[...w,`休憩${i+1}：開始時間が未入力です`]);setTimeout(()=>setWarnings([]),3000);}
        return fm;
      });
    }
  };
  const addBrk=()=>setForm(f=>({...f,breaks:[...f.breaks,{in:"",out:""}]}));
  const rmBrk=(i)=>setForm(f=>({...f,breaks:f.breaks.filter((_,idx)=>idx!==i)}));
  const stampBrk=(i,field)=>{
    if(field==="out"){
      const brk=form.breaks[i];
      if(!brk?.in){setWarnings([`休憩${i+1}：開始時間を先に入力してください`]);setTimeout(()=>setWarnings([]),3000);return;}
    }
    updBrk(i,field,nowStr());
  };

  const currentRate=useMemo(()=>getRateForDate(form.date,settings.workplaces[form.wp||activeWP]?.rateHistory||[]),[form.date,form.wp,activeWP,settings]);
  const formWage=useMemo(()=>calcWage(form.segments,form.breaks,currentRate),[form.segments,form.breaks,currentRate]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave=()=>{
    if(!form.segments.some(s=>s.in||s.out)) return;
    const brkWarns=form.breaks.map((b,i)=>(!b.in&&b.out)?`休憩${i+1}：開始時間が未入力です`:null).filter(Boolean);
    if(brkWarns.length>0){setWarnings(brkWarns);setTimeout(()=>setWarnings([]),4000);}

    const wp=form.wp||activeWP;
    let updatedRecords,toastMsg="保存しました";

    const existing=records.find(r=>r.date===form.date);
    if(form.id&&!existing){
      // 編集モード
      updatedRecords=records.map(r=>r.id===form.id?{...r,[wp]:{segments:form.segments,breaks:form.breaks},memo:form.memo}:r);
      toastMsg="更新しました";
    } else if(existing&&!form.id){
      // 同日マージ
      const existWP=existing[wp]||{segments:[],breaks:[]};
      const mergedSegs=[...existWP.segments.map(s=>({...s}))];
      for(const ns of form.segments){
        if(ns.in&&!ns.out) mergedSegs.push({in:ns.in,out:""});
        else if(!ns.in&&ns.out){
          const idx=mergedSegs.findIndex(s=>s.in&&!s.out);
          if(idx>=0)mergedSegs[idx]={...mergedSegs[idx],out:ns.out};
          else mergedSegs.push({in:"",out:ns.out});
        }else if(ns.in&&ns.out) mergedSegs.push({...ns});
      }
      const allBreaks=[...(existWP.breaks||[]),...form.breaks];
      const uniqueBreaks=allBreaks.filter((b,i,arr)=>b.in&&b.out&&arr.findIndex(x=>x.in===b.in&&x.out===b.out)===i);
      updatedRecords=records.map(r=>r.id===existing.id?{...r,[wp]:{segments:mergedSegs.slice(0,2),breaks:uniqueBreaks},memo:form.memo||existing.memo}:r);
      toastMsg="同日レコードにマージしました";
    } else if(form.id&&existing){
      updatedRecords=records.map(r=>r.id===form.id?{...r,[wp]:{segments:form.segments,breaks:form.breaks},memo:form.memo}:r);
      toastMsg="更新しました";
    } else {
      updatedRecords=[...records,{id:Date.now().toString(),date:form.date,[wp]:{segments:form.segments,breaks:form.breaks},memo:form.memo}];
    }
    setRecords(updatedRecords);
    setForm(emptyForm());
    showToast(toastMsg);
  };

  const handleDelete=(id)=>{setRecords(prev=>prev.filter(r=>r.id!==id));showToast("削除しました");};
  const handleEdit=(r)=>{
    const wpRec=r[activeWP]||{segments:[{in:"",out:""}],breaks:[]};
    setForm({id:r.id,date:r.date,wp:activeWP,segments:wpRec.segments.map(s=>({...s})),breaks:(wpRec.breaks||[]).map(b=>({...b})),memo:r.memo||""});
    setView("input");setExpandedDay(null);
  };
  const handleSettingsSave=()=>{
    setSettings({...settingsForm});
    const newCD=settingsForm.workplaces?.A?.closingDay||25;
    setPeriodKey(currentPeriodKey(newCD));
    showToast("設定を保存しました");
  };

  const handleImport=(e)=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      const lines=ev.target.result.trim().split("\n").slice(1);
      const imported=[];
      for(const line of lines){
        const cols=line.split(",").map(c=>c.replace(/^"|"$/g,"").replace(/""/g,'"'));
        if(!cols[0]||cols[0]==="合計")continue;
        const date=cols[0];
        // A職場
        const aSegs=[{in:cols[2]||"",out:cols[3]||""},{in:cols[4]||"",out:cols[5]||""}].filter(s=>s.in||s.out);
        const aBrks=cols[6]==="なし"?[]:cols[6]?.split(" / ").filter(Boolean).map(b=>{const[i,o]=b.split("〜");return{in:i||"",out:o||""};});
        // B職場
        const bSegs=[{in:cols[17]||"",out:cols[18]||""},{in:cols[19]||"",out:cols[20]||""}].filter(s=>s.in||s.out);
        const bBrks=cols[21]==="なし"?[]:cols[21]?.split(" / ").filter(Boolean).map(b=>{const[i,o]=b.split("〜");return{in:i||"",out:o||""};});
        const rec={id:Date.now().toString()+Math.random(),date,memo:cols[33]||""};
        if(aSegs.length>0)rec.A={segments:aSegs,breaks:aBrks||[]};
        if(bSegs.length>0)rec.B={segments:bSegs,breaks:bBrks||[]};
        if(aSegs.length>0||bSegs.length>0)imported.push(rec);
      }
      if(imported.length===0){showToast("インポートできるデータがありませんでした","err");return;}
      const merged=[...records];
      for(const imp of imported){const idx=merged.findIndex(r=>r.date===imp.date);if(idx>=0)merged[idx]={...merged[idx],...imp};else merged.push(imp);}
      setRecords(merged);
      showToast(`${imported.length}件をインポートしました`);
    };
    reader.readAsText(file,"UTF-8");
    e.target.value="";
  };

  // 職場切り替え時にフォームをリセット
  const switchWP=(wp)=>{
    setActiveWP(wp);
    setForm(f=>({...emptyForm(),wp}));
  };

  // ─── Colors ─────────────────────────────────────────────────────────────────
  const C={bg:"#f5f6f8",surface:"#ffffff",border:"#e0e3e8",borderAccent:"#d0d4db",
    gold:"#b8860b",text:"#1a1a2e",muted:"#6b7280",dim:"#9ca3af",
    green:"#16a34a",blue:"#2563eb",red:"#dc2626",ot:"#ea580c",ln:"#7c3aed",lno:"#be185d",
    orange:"#f59e0b"};
  const inp={background:"#f9fafb",border:`1px solid ${C.border}`,borderRadius:8,
    color:C.text,fontSize:16,fontWeight:500,padding:"9px 12px",outline:"none",
    fontFamily:"inherit",boxSizing:"border-box",width:"100%"};

  const SaveBtn=({label="保存"})=>(
    <button onClick={handleSave} style={{padding:"4px 10px",borderRadius:7,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>{label}</button>
  );

  // ─── Summary: 支払月別 ────────────────────────────────────────────────────
  const payMonthSummary=useMemo(()=>{
    // 各職場の支払月に対応する締め期間を計算
    const now=new Date(),y=now.getFullYear(),m=now.getMonth()+1;
    return WPS.map(wp=>{
      const cfg=settings.workplaces[wp];
      const cd=cfg.closingDay||25;
      const pd=cfg.payDay||10;
      // 今月支払い = 前月締め期間
      const prevPK=shiftPeriod(`${y}-${pad(m)}`,-1);
      const{start,end}=getPeriodBounds(`${y}-${pad(m)}`,cd);
      // 当月締め
      const wpRecords=records.filter(r=>r.date>=start&&r.date<=end&&r[wp]&&(r[wp].segments||[]).some(s=>s.in||s.out));
      let totalPay=0,totalMin=0;
      for(const r of wpRecords){
        const rate=getRateForDate(r.date,cfg.rateHistory||[]);
        const w=calcWage(r[wp].segments||[],r[wp].breaks||[],rate);
        totalPay+=w.totalPay;totalMin+=w.totalMin;
      }
      return{wp,name:cfg.name,totalPay,totalMin,start,end,payDay:pd};
    });
  },[records,settings]);

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
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:22,fontWeight:800,color:C.text}}>勤怠・給与管理</span>
            <span style={{fontSize:11,color:"#15803d",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:6,padding:"3px 8px",fontWeight:600}}>📥 CSV対応</span>
          </div>
          <div style={{height:1,background:`linear-gradient(90deg,${C.gold},transparent)`}}/>
        </div>

        {/* 職場切り替え（打刻・履歴タブ時のみ） */}
        {(view==="input"||view==="history")&&(
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {WPS.map(wp=>(
              <button key={wp} onClick={()=>switchWP(wp)} style={{
                flex:1,padding:"10px 8px",borderRadius:9,border:`2px solid ${activeWP===wp?C.gold:C.border}`,
                background:activeWP===wp?C.gold:C.surface,
                color:activeWP===wp?"#fff":C.muted,
                fontWeight:700,fontSize:14,cursor:"pointer",
                boxShadow:activeWP===wp?"0 2px 8px rgba(184,134,11,0.3)":"none",
              }}>
                {settings.workplaces[wp]?.name||`職場${wp}`}
              </button>
            ))}
          </div>
        )}

        {/* Period selector */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
          <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,-1))} style={arrowBtn(C)}>‹</button>
          <div style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:12,color:C.muted,fontWeight:500,marginBottom:2}}>
              {activeCD===0?"月末締め":`${activeCD}日締め`}（{settings.workplaces[activeWP]?.name}）
            </div>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>{getPeriodLabel(periodKey,activeCD)}</div>
          </div>
          <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,1))} style={arrowBtn(C)}>›</button>
        </div>

        {/* Summary card */}
        <SummaryCard t={periodTotals[activeWP]} combined={combinedTotals} settings={settings} activeWP={activeWP} wpName={settings.workplaces[activeWP]?.name} C={C}/>

        {/* Nav */}
        <div style={{display:"flex",gap:6,margin:"14px 0 18px"}}>
          {[["input","✏️ 打刻"],["history","📋 履歴"],["summary","📊 集計"],["settings","⚙️ 設定"],["help","❓ 使い方"]].map(([k,label])=>(
            <button key={k} onClick={()=>setView(k)} style={{flex:1,padding:"9px 2px",borderRadius:9,border:"none",
              background:view===k?C.gold:C.surface,color:view===k?"#fff":C.muted,
              fontWeight:view===k?700:500,fontSize:11,cursor:"pointer",
              boxShadow:view===k?"0 2px 8px rgba(184,134,11,0.3)":"none"}}>{label}</button>
          ))}
        </div>

        {/* ── INPUT ───────────────────────────────────────────────────────── */}
        {view==="input"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <div style={{marginBottom:14}}>
              <Lbl>日付</Lbl>
              <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={inp}/>
              <div style={{fontSize:12,color:C.muted,marginTop:4,fontWeight:500}}>
                適用時給：¥{getRateForDate(form.date,settings.workplaces[form.wp||activeWP]?.rateHistory||[]).toLocaleString()}円
              </div>
            </div>

            <Lbl>出退勤（{settings.workplaces[form.wp||activeWP]?.name}）</Lbl>
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
            {form.segments.length<2&&(
              <button onClick={addSeg} style={{width:"100%",padding:"8px",borderRadius:8,border:`1px dashed ${C.borderAccent}`,background:"none",color:C.muted,fontSize:14,fontWeight:500,cursor:"pointer",marginBottom:16}}>＋ 中抜け区間を追加</button>
            )}

            <Lbl>☕ 休憩時間</Lbl>
            {form.breaks.length===0&&<div style={{fontSize:13,color:C.dim,marginBottom:8,fontWeight:500}}>休憩なし</div>}
            {form.breaks.map((brk,i)=>(
              <div key={i} style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",marginBottom:8,gap:6}}>
                  <span style={{fontSize:13,fontWeight:600,color:C.orange}}>休憩 {i+1}</span>
                  {brk.in&&brk.out&&<span style={{fontSize:12,color:C.orange,fontWeight:600}}>（{fmtH(toMin(brk.out)>=toMin(brk.in)?toMin(brk.out)-toMin(brk.in):toMin(brk.out)+1440-toMin(brk.in))}）</span>}
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

        {/* ── HISTORY ─────────────────────────────────────────────────────── */}
        {view==="history"&&(
          <div>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={()=>downloadCSV(periodRecords,settings,`勤怠_${getPeriodLabel(periodKey,activeCD)}`)} style={{flex:1,padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.gold,fontWeight:700,fontSize:14,cursor:"pointer"}}>
                📥 この期間をCSV出力
              </button>
              <button onClick={()=>downloadCSV(records,settings,"勤怠_全期間")} style={{padding:"11px 14px",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.muted,fontWeight:600,fontSize:13,cursor:"pointer"}}>全期間</button>
              <button onClick={()=>importRef.current.click()} style={{padding:"11px 14px",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.blue,fontWeight:600,fontSize:13,cursor:"pointer"}}>📂 取込</button>
              <input ref={importRef} type="file" accept=".csv" onChange={handleImport} style={{display:"none"}}/>
            </div>

            {periodRecords.filter(r=>r[activeWP]&&(r[activeWP].segments||[]).some(s=>s.in||s.out)).length===0
              ?<div style={{textAlign:"center",padding:"40px 0",color:C.dim,fontSize:15,fontWeight:500}}>この期間の記録はありません</div>
              :periodRecords.filter(r=>r[activeWP]&&(r[activeWP].segments||[]).some(s=>s.in||s.out)).map(r=>{
                const wpRec=r[activeWP];
                const rate=getRateForDate(r.date,settings.workplaces[activeWP]?.rateHistory||[]);
                const w=calcWage(wpRec.segments||[],wpRec.breaks||[],rate);
                const isOpen=expandedDay===r.id;
                return(
                  <div key={r.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,marginBottom:8,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.05)"}}>
                    <div style={{display:"flex",alignItems:"center",padding:"13px 14px",cursor:"pointer"}} onClick={()=>setExpandedDay(isOpen?null:r.id)}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:700}}>{dateLbl(r.date)}</div>
                        <div style={{fontSize:13,fontWeight:500,color:C.muted,marginTop:2}}>
                          {(wpRec.segments||[]).map(s=>`${s.in||"?"}–${s.out||"勤務中"}`).join(" / ")}
                        </div>
                        {(wpRec.breaks||[]).filter(b=>b.in&&b.out).length>0&&(
                          <div style={{fontSize:12,color:C.orange,fontWeight:500,marginTop:2}}>☕ 休憩 {fmtH(w.totalBreakMin)}</div>
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

        {/* ── SUMMARY ─────────────────────────────────────────────────────── */}
        {view==="summary"&&(
          <div>
            <div style={{display:"flex",gap:6,marginBottom:16}}>
              {[["closing","締め日別"],["payMonth","支払月別"]].map(([k,lbl])=>(
                <button key={k} onClick={()=>setSummaryMode(k)} style={{flex:1,padding:"10px",borderRadius:9,border:"none",
                  background:summaryMode===k?C.gold:C.surface,color:summaryMode===k?"#fff":C.muted,
                  fontWeight:summaryMode===k?700:500,fontSize:13,cursor:"pointer",
                  boxShadow:summaryMode===k?"0 2px 8px rgba(184,134,11,0.3)":"none"}}>{lbl}</button>
              ))}
            </div>

            {summaryMode==="closing"&&(
              <div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px"}}>
                  <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,-1))} style={arrowBtn(C)}>‹</button>
                  <div style={{flex:1,textAlign:"center",fontSize:15,fontWeight:700}}>{getPeriodLabel(periodKey,activeCD)}</div>
                  <button onClick={()=>setPeriodKey(k=>shiftPeriod(k,1))} style={arrowBtn(C)}>›</button>
                </div>
                {WPS.map(wp=>{
                  const cfg=settings.workplaces[wp];
                  const cd=cfg?.closingDay||25;
                  const wpPeriodRecords=records.filter(r=>isInPeriod(r.date,periodKey,cd)&&r[wp]&&(r[wp].segments||[]).some(s=>s.in||s.out));
                  let totalPay=0,totalMin=0;
                  const dailyRows=wpPeriodRecords.map(r=>{
                    const rate=getRateForDate(r.date,cfg?.rateHistory||[]);
                    const w=calcWage(r[wp].segments||[],r[wp].breaks||[],rate);
                    totalPay+=w.totalPay;totalMin+=w.totalMin;
                    return{date:r.date,w,rate};
                  }).sort((a,b)=>a.date.localeCompare(b.date));
                  return(
                    <div key={wp} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px",marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                        <div>
                          <div style={{fontSize:16,fontWeight:800,color:C.text}}>{cfg?.name||`職場${wp}`}</div>
                          <div style={{fontSize:12,color:C.muted,marginTop:2}}>{cd===0?"月末締め":`${cd}日締め`} / 支払日 {cfg?.payDay===0?"月末":`${cfg?.payDay??10}日`}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:22,fontWeight:800,color:C.gold}}>{fmtMoney(totalPay,settings.currency||"¥")}</div>
                          <div style={{fontSize:13,color:C.muted,fontWeight:500}}>{fmtH(totalMin)}</div>
                        </div>
                      </div>
                      {dailyRows.length>0&&(
                        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:10}}>
                          {dailyRows.map(({date,w,rate})=>(
                            <div key={date} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid ${C.bg}`}}>
                              <span style={{fontSize:13,fontWeight:600,color:C.text}}>{dateLbl(date)}</span>
                              <div style={{textAlign:"right"}}>
                                <span style={{fontSize:13,fontWeight:700,color:C.gold}}>{fmtMoney(w.totalPay,"¥")}</span>
                                <span style={{fontSize:12,color:C.dim,marginLeft:6}}>{fmtH(w.totalMin)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {dailyRows.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:C.dim,fontSize:13}}>この期間の記録はありません</div>}
                    </div>
                  );
                })}
                {/* 合計 */}
                <div style={{background:"linear-gradient(135deg,#fff8ee,#ffffff)",border:`2px solid ${C.gold}`,borderRadius:14,padding:"16px",textAlign:"center"}}>
                  <div style={{fontSize:13,color:C.muted,fontWeight:600,marginBottom:4}}>両職場合計</div>
                  <div style={{fontSize:28,fontWeight:800,color:C.gold}}>{fmtMoney(WPS.reduce((s,wp)=>{
                    const cfg=settings.workplaces[wp];const cd=cfg?.closingDay||25;
                    return s+records.filter(r=>isInPeriod(r.date,periodKey,cd)&&r[wp]&&(r[wp].segments||[]).some(s=>s.in||s.out)).reduce((ps,r)=>{
                      const w=calcWage(r[wp].segments||[],r[wp].breaks||[],getRateForDate(r.date,cfg?.rateHistory||[]));
                      return ps+w.totalPay;
                    },0);
                  },0),settings.currency||"¥")}</div>
                </div>
              </div>
            )}

            {summaryMode==="payMonth"&&(
              <div>
                {payMonthSummary.map(({wp,name,totalPay,totalMin,start,end,payDay})=>(
                  <div key={wp} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px",marginBottom:12,boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <div style={{fontSize:16,fontWeight:800,color:C.text}}>{name}</div>
                        <div style={{fontSize:12,color:C.muted,marginTop:2}}>集計期間：{start} 〜 {end}</div>
                        <div style={{fontSize:12,color:C.green,fontWeight:600,marginTop:2}}>支払予定日：{payDay===0?"月末":`${payDay}日`}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:22,fontWeight:800,color:C.gold}}>{fmtMoney(totalPay,settings.currency||"¥")}</div>
                        <div style={{fontSize:13,color:C.muted,fontWeight:500}}>{fmtH(totalMin)}</div>
                      </div>
                    </div>
                  </div>
                ))}
                <div style={{background:"linear-gradient(135deg,#fff8ee,#ffffff)",border:`2px solid ${C.gold}`,borderRadius:14,padding:"16px",textAlign:"center"}}>
                  <div style={{fontSize:13,color:C.muted,fontWeight:600,marginBottom:4}}>今月の受取合計（予定）</div>
                  <div style={{fontSize:28,fontWeight:800,color:C.gold}}>{fmtMoney(payMonthSummary.reduce((s,r)=>s+r.totalPay,0),settings.currency||"¥")}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SETTINGS ────────────────────────────────────────────────────── */}
        {view==="settings"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <div style={{marginBottom:16}}>
              <Lbl>通貨記号</Lbl>
              <input type="text" value={settingsForm.currency||"¥"} maxLength={3} onChange={e=>setSettingsForm(s=>({...s,currency:e.target.value}))} style={{...inp,width:80}}/>
            </div>

            {WPS.map(wp=>{
              const cfg=settingsForm.workplaces?.[wp]||DEFAULT_WP(wp);
              const updateWP=(field,val)=>setSettingsForm(s=>({...s,workplaces:{...s.workplaces,[wp]:{...cfg,[field]:val}}}));
              return(
                <div key={wp} style={{borderTop:`1px solid ${C.border}`,paddingTop:16,marginBottom:16}}>
                  <div style={{fontSize:15,fontWeight:800,color:C.text,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{background:C.gold,color:"#fff",borderRadius:6,padding:"2px 10px",fontSize:13}}>{wp}</span>
                    <span>{cfg.name}</span>
                  </div>
                  <div style={{marginBottom:10}}>
                    <Lbl>職場名</Lbl>
                    <input value={cfg.name} onChange={e=>updateWP("name",e.target.value)} style={inp}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                    <div>
                      <Lbl>締め日</Lbl>
                      <select value={cfg.closingDay} onChange={e=>updateWP("closingDay",Number(e.target.value))} style={{...inp,cursor:"pointer"}}>
                        {[...Array(28)].map((_,i)=><option key={i+1} value={i+1}>{i+1}日締め</option>)}
                        <option value={0}>月末締め</option>
                      </select>
                    </div>
                    <div>
                      <Lbl>支払日</Lbl>
                      <select value={cfg.payDay??10} onChange={e=>updateWP("payDay",Number(e.target.value))} style={{...inp,cursor:"pointer"}}>
                        {[...Array(28)].map((_,i)=><option key={i+1} value={i+1}>{i+1}日</option>)}
                        <option value={0}>月末</option>
                      </select>
                    </div>
                  </div>
                  <Lbl>💰 時給履歴（日単位）</Lbl>
                  <div style={{fontSize:12,color:C.muted,marginBottom:8,fontWeight:500}}>日付ごとに時給を設定。その日以降のレコードに自動適用されます。</div>
                  {[...(cfg.rateHistory||[])].sort((a,b)=>b.from.localeCompare(a.from)).map(r=>(
                    <div key={r.from} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#f3f4f6",borderRadius:8,marginBottom:6}}>
                      <span style={{fontSize:14,fontWeight:600}}>{r.from}〜</span>
                      <span style={{fontSize:15,fontWeight:700,color:C.gold}}>¥{Number(r.rate).toLocaleString()}</span>
                      <button onClick={()=>{
                        if((cfg.rateHistory||[]).length<=1){showToast("最低1件の時給が必要です","err");return;}
                        updateWP("rateHistory",(cfg.rateHistory||[]).filter(x=>x.from!==r.from));
                      }} style={{background:"none",border:"none",color:C.red,fontSize:16,cursor:"pointer"}}>×</button>
                    </div>
                  ))}
                  <AddRateForm cfg={cfg} updateWP={updateWP} inp={inp} C={C}/>
                </div>
              );
            })}

            <button onClick={handleSettingsSave} style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:15,cursor:"pointer",marginBottom:20}}>設定を保存</button>

            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16}}>
              <Lbl>📥 データ管理</Lbl>
              <div style={{fontSize:12,color:C.muted,marginBottom:10,fontWeight:500,background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px"}}>
                ✅ 完全無料・費用ゼロ<br/>
                📥 CSVダウンロード → ExcelやGoogleスプレッドシートで開けます<br/>
                📂 CSVを修正して再取込も可能<br/>
                🔄 アプリを開くたびに自動バックアップ
              </div>
              <button onClick={()=>downloadCSV(records,settings,"勤怠_全データバックアップ")} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.gold,fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:8}}>
                📥 全データをCSVバックアップ
              </button>
              <button onClick={()=>importRef.current.click()} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,color:C.blue,fontWeight:700,fontSize:14,cursor:"pointer"}}>
                📂 CSVから取込（修正データ）
              </button>
              <input ref={importRef} type="file" accept=".csv" onChange={handleImport} style={{display:"none"}}/>
            </div>
          </div>
        )}

        {/* ── HELP ────────────────────────────────────────────────────────── */}
        {view==="help"&&(
          <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 16px",boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
            <HelpSection title="📱 基本の使い方" C={C}>
              {[
                {n:"1",h:"出勤時：職場を選んで「今」ボタン",p:"上部の職場ボタンで職場A/Bを切り替え、出勤欄の「今」をタップ。"},
                {n:"2",h:"保存ボタンで即保存",p:"各区間の右上にある「保存」ボタン、または「記録を保存」で保存。"},
                {n:"3",h:"退勤時も同様に",p:"同じ日付・職場で退勤時刻を入力して保存すると自動マージされます。"},
                {n:"4",h:"集計タブで給与確認",p:"締め日別・支払月別の両職場合算が確認できます。"},
              ].map((s,i)=>(
                <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
                  <div style={{background:C.gold,color:"#fff",fontWeight:800,fontSize:13,width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{s.n}</div>
                  <div><div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{s.h}</div><div style={{fontSize:13,color:C.muted}}>{s.p}</div></div>
                </div>
              ))}
            </HelpSection>
            <HelpSection title="💰 給与計算ルール" C={C}>
              <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"6px 16px",fontSize:13}}>
                {[["通常時間（〜8h）","× 1.00"],["残業（8h超）","× 1.25"],["深夜（22時〜翌5時）","× 1.25"],["深夜残業（両方）","× 1.50"]].map(([k,v])=>(
                  <><div key={k} style={{color:C.muted}}>{k}</div><div style={{fontWeight:700,color:C.gold,textAlign:"right"}}>{v}</div></>
                ))}
              </div>
            </HelpSection>
            <HelpSection title="📥 CSVの使い方" C={C}>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.9}}>
                <div>① 履歴タブ → 「この期間をCSV出力」</div>
                <div>② ExcelやGoogleスプレッドシートで修正</div>
                <div>③ 履歴タブ → 「📂取込」で再インポート</div>
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

// ─── Sub Components ───────────────────────────────────────────────────────────
function AddRateForm({cfg,updateWP,inp,C}){
  const [from,setFrom]=useState(getTodayStr());
  const [rate,setRate]=useState(cfg.rateHistory?.[cfg.rateHistory.length-1]?.rate||1200);
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,marginTop:8}}>
      <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={inp}/>
      <input type="number" value={rate} onChange={e=>setRate(e.target.value)} placeholder="時給" style={inp}/>
      <button onClick={()=>{
        if(!from||!rate)return;
        const updated=[...(cfg.rateHistory||[]).filter(r=>r.from!==from),{from,rate:Number(rate)}].sort((a,b)=>a.from.localeCompare(b.from));
        updateWP("rateHistory",updated);
      }} style={{padding:"9px 14px",borderRadius:8,border:"none",background:C.gold,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>追加</button>
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

function SummaryCard({t,combined,settings,activeWP,wpName,C}){
  const cur=settings.currency||"¥";
  const rows=[
    {label:"通常時間",min:t.nm,pay:t.normalPay,color:C.text},
    {label:"残業手当",min:t.om,pay:t.otPay,color:C.ot},
    {label:"深夜手当",min:t.ln,pay:t.lnPay,color:C.ln},
    {label:"深夜残業",min:t.lno,pay:t.lnoPay,color:C.lno},
  ].filter(r=>r.min>0);
  return(
    <div style={{background:"linear-gradient(135deg,#fff8ee,#ffffff)",border:"1px solid #d0d4db",borderRadius:16,padding:"18px 18px 14px",position:"relative",overflow:"hidden",boxShadow:"0 2px 12px rgba(0,0,0,0.06)",marginBottom:6}}>
      <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(184,134,11,0.06)"}}/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:C.muted,letterSpacing:"1px",marginBottom:2}}>{wpName}（今期）</div>
          <div style={{fontSize:30,fontWeight:800,color:C.gold,letterSpacing:"-1px"}}>{cur}{Math.round(t.totalPay).toLocaleString()}</div>
          {combined.totalPay!==t.totalPay&&(
            <div style={{fontSize:12,color:C.muted,fontWeight:500,marginTop:2}}>両職場合計：{cur}{Math.round(combined.totalPay).toLocaleString()}</div>
          )}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:12,fontWeight:600,color:C.muted,marginBottom:2}}>実働時間</div>
          <div style={{fontSize:22,fontWeight:700,color:C.text}}>{fmtH(t.totalMin)}</div>
          {t.totalBreakMin>0&&<div style={{fontSize:12,fontWeight:500,color:"#f59e0b"}}>休憩 {fmtH(t.totalBreakMin)}</div>}
        </div>
      </div>
      {rows.length>0&&(
        <div style={{borderTop:"1px solid #e0e3e8",paddingTop:10}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:"4px 10px",alignItems:"center"}}>
            {["区分","時間","金額"].map(h=><div key={h} style={{fontSize:12,fontWeight:600,color:C.dim,paddingBottom:2}}>{h}</div>)}
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
