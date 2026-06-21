import { useState, useEffect, useRef, useMemo } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const DEFAULT_SETTINGS = {
  node_constant: 2.4, stalk_constant: 1.8, density_factor: 0.92, loss_adjustment: 0.88,
  cost_per_acre: 156000, company_rate: 11050, buy_rate: 8060,
};

const WEATHER_OPTIONS = ["All-season","Dry season only","Wet season only","4WD required","Impassable when wet","Seasonal (graded)"];
const ACCESS_OPTIONS = ["Tarmac road","Murram road","Farm track","Footpath only","River crossing","Bridge access"];

function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function fmt(n, dec=1) { if (n==null||isNaN(n)) return "-"; return Number(n).toFixed(dec); }
function K(n) {
  if (n==null||isNaN(n)) return "-";
  const abs = Math.abs(n);
  const s = abs>=1000000 ? `KES ${(abs/1000000).toFixed(2)}M` : abs>=1000 ? `KES ${(abs/1000).toFixed(1)}K` : `KES ${abs.toFixed(0)}`;
  return n<0 ? "-"+s : s;
}
function generateMockPolygon(cLat=0.5, cLng=35.1, acres=12) {
  const R = Math.sqrt(acres*4046.86)/111320;
  const sides = 5+Math.floor(Math.random()*4);
  return Array.from({length:sides},(_,i)=>{
    const angle=(2*Math.PI*i)/sides+(Math.random()-0.5)*0.5;
    const r=R*(0.7+Math.random()*0.6);
    return {lat:cLat+r*Math.sin(angle),lng:cLng+r*Math.cos(angle)};
  });
}

const DEMO_FIELDS = [
  { id:"f1",name:"Nyamira North A",area_acres:24.5,estimated_total_tons:42.8,
    polygon:generateMockPolygon(0.565,34.935,24.5),
    survey:{avg_nodes:14,avg_stalks:9,date:"2026-04-10",sites:[
      {id:"s1",site_name:"Upper Slope",weather_access:"Dry season only",road_type:"Farm track",notes:"Steep incline"},
      {id:"s2",site_name:"Valley Section",weather_access:"All-season",road_type:"Murram road",notes:"Good year round"},
    ]},
    harvest:{actual_tonnage:39.2,harvest_cost:546000,transport_cost:234000,selling_price:11050,date:"2026-05-02"}},
  { id:"f2",name:"Kericho East 7",area_acres:18.2,estimated_total_tons:31.4,
    polygon:generateMockPolygon(0.368,35.283,18.2),
    survey:{avg_nodes:13,avg_stalks:8,date:"2026-04-14",sites:[
      {id:"s3",site_name:"Main Block",weather_access:"All-season",road_type:"Tarmac road",notes:""},
    ]},
    harvest:null},
  { id:"f3",name:"Muhoroni South",area_acres:32.1,estimated_total_tons:57.6,
    polygon:generateMockPolygon(0.155,35.19,32.1),
    survey:{avg_nodes:16,avg_stalks:10,date:"2026-04-18",sites:[
      {id:"s4",site_name:"Ridge Top",weather_access:"4WD required",road_type:"Farm track",notes:"Rocky terrain"},
      {id:"s5",site_name:"Flood Plain",weather_access:"Impassable when wet",road_type:"Footpath only",notes:"Nov-Jan only"},
    ]},
    harvest:{actual_tonnage:54.1,harvest_cost:793000,transport_cost:312000,selling_price:11050,date:"2026-05-08"}},
  { id:"f4",name:"Awasi West 3",area_acres:15.8,estimated_total_tons:27.2,
    polygon:generateMockPolygon(0.043,34.876,15.8),
    survey:{avg_nodes:12,avg_stalks:8,date:"2026-04-22",sites:[]},harvest:null},
  { id:"f5",name:"Central Nzoia",area_acres:41.0,estimated_total_tons:74.1,
    polygon:generateMockPolygon(0.71,34.95,41.0),
    survey:{avg_nodes:15,avg_stalks:11,date:"2026-04-28",sites:[
      {id:"s6",site_name:"Block A",weather_access:"All-season",road_type:"Murram road",notes:""},
      {id:"s7",site_name:"Block B",weather_access:"Seasonal (graded)",road_type:"Farm track",notes:"Graded Feb-Apr"},
      {id:"s8",site_name:"Riverbank",weather_access:"Wet season only",road_type:"Bridge access",notes:"5t limit"},
    ]},
    harvest:null},
  { id:"f6",name:"Chemelil Outer",area_acres:11.3,estimated_total_tons:18.9,
    polygon:generateMockPolygon(0.096,35.078,11.3),
    survey:{avg_nodes:11,avg_stalks:7,date:"2026-05-01",sites:[]},
    harvest:{actual_tonnage:17.8,harvest_cost:286000,transport_cost:117000,selling_price:11050,date:"2026-05-14"}},
];

const DEMO_TXNS = [
  {id:"t1",farmer_name:"Samuel Omondi",tons:12.4,buy_price:8060,total_cost:99944,expected_payout:137020,gross_profit:37076,date:"2026-05-05",note:""},
  {id:"t2",farmer_name:"Grace Achieng",tons:8.7,buy_price:7800,total_cost:67860,expected_payout:96135,gross_profit:28275,date:"2026-05-06",note:"Morning batch"},
  {id:"t3",farmer_name:"Peter Kiprono",tons:15.2,buy_price:8060,total_cost:122512,expected_payout:167960,gross_profit:45448,date:"2026-05-08",note:""},
  {id:"t4",farmer_name:"Joyce Wanjiku",tons:9.1,buy_price:7930,total_cost:72163,expected_payout:100555,gross_profit:28392,date:"2026-05-09",note:""},
  {id:"t5",farmer_name:"Samuel Omondi",tons:11.8,buy_price:8060,total_cost:95108,expected_payout:130390,gross_profit:35282,date:"2026-05-12",note:""},
  {id:"t6",farmer_name:"John Mutua",tons:6.3,buy_price:8190,total_cost:51597,expected_payout:69615,gross_profit:18018,date:"2026-05-13",note:"Afternoon"},
  {id:"t7",farmer_name:"Grace Achieng",tons:10.5,buy_price:7800,total_cost:81900,expected_payout:116025,gross_profit:34125,date:"2026-05-15",note:""},
  {id:"t8",farmer_name:"David Otieno",tons:14.0,buy_price:8060,total_cost:112840,expected_payout:154700,gross_profit:41860,date:"2026-05-19",note:"Large load"},
];

function PolygonMap({coords,size=80,color="#f5c842"}) {
  if (!coords||coords.length<3) return (
    <div style={{width:size,height:size,background:"#0f0d00",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#2a2400",fontSize:10}}>-</div>
  );
  const lats=coords.map(c=>c.lat),lngs=coords.map(c=>c.lng);
  const minLat=Math.min(...lats),maxLat=Math.max(...lats),minLng=Math.min(...lngs),maxLng=Math.max(...lngs);
  const pad=10;
  const toX=lng=>pad+((lng-minLng)/(maxLng-minLng||1))*(size-2*pad);
  const toY=lat=>size-pad-((lat-minLat)/(maxLat-minLat||1))*(size-2*pad);
  const pts=coords.map(c=>`${toX(c.lng)},${toY(c.lat)}`).join(" ");
  return (
    <svg width={size} height={size} style={{borderRadius:8,background:"#0a0800"}}>
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.05"/>
        </linearGradient>
      </defs>
      <polygon points={pts} fill="url(#pg)" stroke={color} strokeWidth="1.5"/>
    </svg>
  );
}

const ChartTooltip = ({active,payload,label,prefix="",suffix=""}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:"#0f0d00",border:"1px solid #2a2400",borderRadius:8,padding:"8px 12px",fontFamily:"monospace",fontSize:11}}>
      <div style={{color:"#6a5a20",marginBottom:4}}>{label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{color:p.color||"#f5c842"}}>{p.name}: {prefix}{typeof p.value==="number"?p.value.toLocaleString():p.value}{suffix}</div>
      ))}
    </div>
  );
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@300;400;500&family=Crimson+Pro:ital,wght@0,300;1,300&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#0a0800;}
::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:#1e1a00;border-radius:2px;}
input,select,textarea{background:#0f0d00;border:1px solid #1e1a00;color:#e8d87a;border-radius:8px;padding:9px 12px;font-family:'DM Mono',monospace;font-size:12px;width:100%;outline:none;transition:border .15s;}
input:focus,select:focus{border-color:#f5c84280;box-shadow:0 0 0 3px #f5c84210;}
input::placeholder{color:#3a3000;}
select option{background:#0f0d00;}
button{cursor:pointer;border:none;font-family:'DM Mono',monospace;}
.btn-gold{background:#f5c842;color:#0a0800;border-radius:9px;padding:11px 20px;font-weight:500;font-size:12px;letter-spacing:.04em;transition:all .15s;}
.btn-gold:hover{background:#ffd84a;transform:translateY(-1px);}
.btn-ghost{background:transparent;border:1px solid #1e1a00;color:#6a5a20;border-radius:9px;padding:9px 14px;font-size:11px;transition:all .15s;}
.btn-ghost:hover{border-color:#f5c84260;color:#f5c842;}
.btn-danger{background:#ff6b4a15;border:1px solid #ff6b4a30;color:#ff8060;border-radius:9px;padding:9px 14px;font-size:11px;}
.btn-sm{padding:5px 10px!important;font-size:10px!important;border-radius:7px!important;}
.card{background:#0f0d00;border:1px solid #1e1a00;border-radius:14px;padding:16px;}
.card-hover{transition:border-color .15s,transform .15s;}
.card-hover:hover{border-color:#f5c84240;transform:translateY(-1px);}
.label{color:#4a3e10;font-size:9px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px;display:block;font-family:'DM Mono',monospace;}
.stat-val{font-family:'Bebas Neue',sans-serif;letter-spacing:.03em;line-height:1;color:#f5c842;}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;font-family:'DM Mono',monospace;}
.badge-gold{background:#f5c84218;color:#f5c842;border:1px solid #f5c84230;}
.badge-green{background:#3ddc8418;color:#3ddc84;border:1px solid #3ddc8430;}
.badge-red{background:#ff6b4a15;color:#ff8060;border:1px solid #ff6b4a25;}
.badge-gray{background:#1e1a00;color:#5a4e18;border:1px solid #2a2400;}
.badge-blue{background:#5b9cf618;color:#7ab4f5;border:1px solid #5b9cf630;}
.badge-orange{background:#ffa54018;color:#ffa540;border:1px solid #ffa54030;}
.tab{padding:7px 14px;border-radius:20px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-family:'DM Mono',monospace;cursor:pointer;transition:all .15s;border:1px solid transparent;background:transparent;color:#4a3e10;white-space:nowrap;}
.tab.on{background:#f5c84220;color:#f5c842;border-color:#f5c84235;}
.tab:hover:not(.on){color:#8a7a30;}
.fade{animation:fd .22s ease;}
@keyframes fd{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
.glow-text{text-shadow:0 0 20px #f5c84260;}
.progress{height:5px;background:#1a1800;border-radius:3px;overflow:hidden;}
.progress-fill{height:100%;border-radius:3px;transition:width .8s cubic-bezier(.4,0,.2,1);}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
.rate-pill{display:inline-flex;align-items:center;gap:6px;background:#f5c84215;border:1px solid #f5c84235;border-radius:20px;padding:5px 12px;}
.rate-input{background:transparent!important;border:none!important;padding:0!important;width:80px!important;font-family:'Bebas Neue',sans-serif!important;font-size:20px!important;color:#f5c842!important;box-shadow:none!important;text-align:right;}
.site-table{width:100%;border-collapse:collapse;font-size:11px;font-family:'DM Mono',monospace;}
.site-table th{color:#4a3e10;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #1e1a00;text-align:left;font-weight:400;}
.site-table td{padding:8px;border-bottom:1px solid #141200;vertical-align:top;}
.site-table tr:last-child td{border-bottom:none;}
.site-table input,.site-table select{padding:5px 7px!important;font-size:11px!important;border-radius:6px!important;}
`;

function weatherBadge(val) {
  if (!val) return <span className="badge badge-gray">-</span>;
  const bad = val.includes("Impassable")||val.includes("4WD");
  const ok = val.includes("All-season")||val.includes("Tarmac");
  return <span className={`badge ${bad?"badge-red":ok?"badge-green":"badge-orange"}`}>{val}</span>;
}

function Nav({screen,setScreen}) {
  const items = [
    {id:"dashboard",icon:"#",label:"Dashboard"},
    {id:"fields",icon:"o",label:"Fields"},
    {id:"weighbridge",icon:"~",label:"Trade"},
    {id:"reports",icon:"^",label:"Reports"},
  ];
  return (
    <nav style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#0a0800",borderTop:"1px solid #1e1a00",display:"flex",zIndex:99,paddingBottom:"env(safe-area-inset-bottom,8px)"}}>
      {items.map(({id,icon,label})=>(
        <button key={id} onClick={()=>setScreen(id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"10px 4px 8px",background:"none",border:"none",cursor:"pointer"}}>
          <span style={{fontSize:16,color:screen===id?"#f5c842":"#3a3000",transition:"all .15s"}}>{icon}</span>
          <span style={{fontSize:8.5,letterSpacing:".1em",textTransform:"uppercase",fontFamily:"'DM Mono',monospace",color:screen===id?"#f5c842":"#3a3000"}}>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function SiteTable({sites,setSites}) {
  const addRow = ()=>setSites(ss=>[...ss,{id:uuid(),site_name:"",weather_access:"",road_type:"",notes:""}]);
  const updateRow = (id,key,val)=>setSites(ss=>ss.map(s=>s.id===id?{...s,[key]:val}:s));
  const deleteRow = id=>setSites(ss=>ss.filter(s=>s.id!==id));
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#f5c842",letterSpacing:".04em"}}>Site Accessibility</div>
        <button className="btn-ghost btn-sm" onClick={addRow}>+ Add Site</button>
      </div>
      {sites.length===0 && (
        <div style={{padding:"14px",background:"#0a0800",borderRadius:8,textAlign:"center",color:"#3a3000",fontSize:11,fontFamily:"'DM Mono',monospace"}}>
          No sites recorded. Click + Add Site.
        </div>
      )}
      {sites.length>0 && (
        <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #1e1a00"}}>
          <table className="site-table">
            <thead>
              <tr style={{background:"#0a0800"}}>
                <th>Site Name</th>
                <th>Weather Access</th>
                <th>Road Type</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sites.map(s=>(
                <tr key={s.id}>
                  <td><input value={s.site_name} onChange={e=>updateRow(s.id,"site_name",e.target.value)} placeholder="e.g. Upper Block"/></td>
                  <td>
                    <select value={s.weather_access} onChange={e=>updateRow(s.id,"weather_access",e.target.value)}>
                      <option value="">Select...</option>
                      {WEATHER_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={s.road_type} onChange={e=>updateRow(s.id,"road_type",e.target.value)}>
                      <option value="">Select...</option>
                      {ACCESS_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td><input value={s.notes} onChange={e=>updateRow(s.id,"notes",e.target.value)} placeholder="Optional"/></td>
                  <td><button className="btn-danger btn-sm" onClick={()=>deleteRow(s.id)}>x</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sites.length>0 && (
        <div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:6}}>
          {sites.filter(s=>s.weather_access).map(s=>(
            <div key={s.id} style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:9,color:"#5a4e18",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Site"}:</span>
              {weatherBadge(s.weather_access)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dashboard({fields,transactions,settings,setSettings}) {
  const [editingRate,setEditingRate] = useState(false);
  const [rateInput,setRateInput] = useState(settings.company_rate);

  const totalAcres = fields.reduce((s,f)=>s+(f.area_acres||0),0);
  const totalEstTons = fields.reduce((s,f)=>s+(f.estimated_total_tons||0),0);
  const harvestedFields = fields.filter(f=>f.harvest?.actual_tonnage);
  const pendingFields = fields.filter(f=>!f.harvest?.actual_tonnage);
  const totalActualTons = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage,0);
  const harvestProgress = totalEstTons>0?(totalActualTons/totalEstTons)*100:0;
  const acquisitionSpend = fields.reduce((s,f)=>s+(f.area_acres||0)*settings.cost_per_acre,0);
  const harvestCosts = harvestedFields.reduce((s,f)=>s+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0),0);
  const totalSpent = acquisitionSpend+harvestCosts;
  const actualRevenue = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate),0);
  const estFutureRevenue = pendingFields.reduce((s,f)=>s+(f.estimated_total_tons||0)*settings.company_rate,0);
  const totalExpectedReturn = actualRevenue+estFutureRevenue;
  const realizedProfit = actualRevenue-harvestedFields.reduce((s,f)=>s+(f.area_acres*settings.cost_per_acre)+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0),0);
  const totalMargin = totalExpectedReturn>0?((totalExpectedReturn-totalSpent)/totalExpectedReturn*100):0;
  const wbTons = transactions.reduce((s,t)=>s+t.tons,0);
  const wbSpend = transactions.reduce((s,t)=>s+t.total_cost,0);
  const wbExpected = transactions.reduce((s,t)=>s+t.expected_payout,0);
  const wbProfit = wbExpected-wbSpend;

  const fieldChartData = fields.map(f=>({
    name:f.name.split(" ").slice(-1)[0],
    estimated:+(f.estimated_total_tons||0).toFixed(1),
    actual:f.harvest?.actual_tonnage?+f.harvest.actual_tonnage.toFixed(1):0,
  }));
  const donutData = [
    {name:"Harvested",value:totalActualTons,color:"#f5c842"},
    {name:"Pending",value:Math.max(0,totalEstTons-totalActualTons),color:"#1e1a00"},
  ];
  const sortedHarvests = harvestedFields.filter(f=>f.harvest?.date).sort((a,b)=>new Date(a.harvest.date)-new Date(b.harvest.date));
  let cumRev=0,cumCost=0;
  const revenueTimeline = sortedHarvests.map(f=>{
    cumRev+=f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate);
    cumCost+=f.area_acres*settings.cost_per_acre+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0);
    return {date:f.harvest.date.slice(5),revenue:+cumRev.toFixed(0),cost:+cumCost.toFixed(0),profit:+(cumRev-cumCost).toFixed(0)};
  });
  const wbByDay={};
  transactions.forEach(t=>{
    const k=t.date.slice(5);
    if (!wbByDay[k]) wbByDay[k]={date:k,tons:0,profit:0};
    wbByDay[k].tons+=t.tons; wbByDay[k].profit+=t.gross_profit;
  });
  const wbChartData = Object.values(wbByDay).sort((a,b)=>a.date.localeCompare(b.date)).slice(-10);
  const yieldAccuracy = harvestedFields.map(f=>({
    name:f.name.split(" ").slice(-1)[0],
    estimated:+(f.estimated_total_tons||0).toFixed(1),
    actual:+f.harvest.actual_tonnage.toFixed(1),
    pct:+((f.harvest.actual_tonnage/(f.estimated_total_tons||1))*100).toFixed(0),
  }));
  const saveRate = ()=>{
    const v=+rateInput; if (v>0) setSettings(s=>({...s,company_rate:v})); setEditingRate(false);
  };

  return (
    <div style={{paddingBottom:80}} className="fade">
      <div style={{padding:"44px 20px 20px",background:"linear-gradient(180deg,#0f0d00 0%,#0a0800 100%)",borderBottom:"1px solid #1a1800",position:"relative",overflow:"hidden"}}>
        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".22em",color:"#3a3000",marginBottom:4}}>AGRIHUB . KES</div>
          <h1 style={{fontFamily:"'Bebas Neue'",fontSize:44,lineHeight:1,letterSpacing:".04em",color:"#f5c842"}} className="glow-text">FIELD COMMAND</h1>
          <div style={{fontFamily:"'Crimson Pro',serif",fontStyle:"italic",fontSize:13,color:"#6a5a20",marginTop:4}}>{fields.length} fields . {fmt(totalAcres)} acres surveyed</div>
        </div>
        <div style={{marginBottom:16}}>
          <span className="label">Factory Rate (KES/ton) - edit anytime</span>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div className="rate-pill">
              <span style={{fontSize:10,color:"#6a5a20",fontFamily:"'DM Mono',monospace",letterSpacing:".06em"}}>KES</span>
              {editingRate
                ? <input className="rate-input" type="number" value={rateInput} onChange={e=>setRateInput(e.target.value)} onBlur={saveRate} onKeyDown={e=>e.key==="Enter"&&saveRate()} autoFocus/>
                : <span style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"#f5c842",letterSpacing:".03em",cursor:"text",minWidth:60}} onClick={()=>{setRateInput(settings.company_rate);setEditingRate(true);}}>{settings.company_rate.toLocaleString()}</span>
              }
              <span style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace"}}>/ton</span>
            </div>
            {!editingRate && <button className="btn-ghost btn-sm" onClick={()=>{setRateInput(settings.company_rate);setEditingRate(true);}}>edit</button>}
            {editingRate && <button className="btn-gold btn-sm" onClick={saveRate}>save</button>}
          </div>
        </div>
        <div className="grid2" style={{gap:8}}>
          {[
            {l:"Total Surveyed Cane",v:fmt(totalEstTons)+" t",sub:fmt(totalAcres)+" acres mapped"},
            {l:"Harvest Progress",v:fmt(harvestProgress)+"%",sub:`${harvestedFields.length} of ${fields.length} fields done`},
            {l:"Money Spent",v:K(totalSpent),sub:"Acquisition + harvest costs"},
            {l:"Expected Returns",v:K(totalExpectedReturn),sub:K(realizedProfit)+" realized profit"},
          ].map(({l,v,sub})=>(
            <div key={l} className="card" style={{padding:"14px"}}>
              <span className="label">{l}</span>
              <div className="stat-val" style={{fontSize:20,marginBottom:2}}>{v}</div>
              <div style={{fontSize:9,color:"#5a4e18",fontFamily:"'DM Mono',monospace"}}>{sub}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{padding:"16px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
            <div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a"}}>Harvest Progress</div>
              <div style={{fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace",marginTop:2}}>{fmt(totalActualTons)}t of {fmt(totalEstTons)}t estimated</div>
            </div>
            <span className="badge badge-gold">{fmt(harvestProgress)}%</span>
          </div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            <PieChart width={100} height={100}>
              <Pie data={donutData} cx={46} cy={46} innerRadius={30} outerRadius={46} dataKey="value" strokeWidth={0} startAngle={90} endAngle={-270}>
                {donutData.map((d,i)=><Cell key={i} fill={d.color}/>)}
              </Pie>
            </PieChart>
            <div style={{flex:1}}>
              <div className="progress" style={{marginBottom:8}}>
                <div className="progress-fill" style={{width:`${Math.min(100,harvestProgress)}%`,background:"linear-gradient(90deg,#c49a20,#f5c842,#ffd84a)"}}/>
              </div>
              <div className="grid2">
                {[
                  {l:"Harvested",v:harvestedFields.length,c:"#3ddc84"},
                  {l:"Pending",v:pendingFields.length,c:"#f5c842"},
                  {l:"Actual Tons",v:fmt(totalActualTons),c:"#3ddc84"},
                  {l:"Remaining Est.",v:fmt(Math.max(0,totalEstTons-totalActualTons)),c:"#6a5a20"},
                ].map(({l,v,c})=>(
                  <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:c}}>{v}</div></div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {revenueTimeline.length>0 && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a",marginBottom:4}}>Cumulative P&amp;L</div>
            <div style={{fontSize:10,color:"#5a4e18",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>Revenue vs. cost over harvest cycle (KES)</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={revenueTimeline} margin={{top:4,right:4,left:-20,bottom:0}}>
                <defs>
                  <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f5c842" stopOpacity={0.3}/><stop offset="95%" stopColor="#f5c842" stopOpacity={0}/></linearGradient>
                  <linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ff6b4a" stopOpacity={0.2}/><stop offset="95%" stopColor="#ff6b4a" stopOpacity={0}/></linearGradient>
                  <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3ddc84" stopOpacity={0.25}/><stop offset="95%" stopColor="#3ddc84" stopOpacity={0}/></linearGradient>
                </defs>
                <CartesianGrid stroke="#1a1800" strokeDasharray="3 0" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#4a3e10",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:"#4a3e10",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}K`}/>
                <Tooltip content={<ChartTooltip prefix="KES "/>}/>
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#f5c842" strokeWidth={1.5} fill="url(#gr)"/>
                <Area type="monotone" dataKey="cost" name="Cost" stroke="#ff6b4a" strokeWidth={1.5} fill="url(#gc)"/>
                <Area type="monotone" dataKey="profit" name="Profit" stroke="#3ddc84" strokeWidth={1.5} fill="url(#gp)"/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a",marginBottom:4}}>Tons by Field</div>
          <div style={{fontSize:10,color:"#5a4e18",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>Estimated vs. actual tonnage</div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={fieldChartData} margin={{top:4,right:4,left:-20,bottom:0}} barCategoryGap="30%">
              <CartesianGrid stroke="#1a1800" strokeDasharray="3 0" vertical={false}/>
              <XAxis dataKey="name" tick={{fill:"#4a3e10",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:"#4a3e10",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
              <Tooltip content={<ChartTooltip suffix=" t"/>}/>
              <Bar dataKey="estimated" name="Estimated" fill="#f5c84235" stroke="#f5c84260" strokeWidth={1} radius={[3,3,0,0]}/>
              <Bar dataKey="actual" name="Actual" fill="#f5c842" radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a",marginBottom:14}}>Financial Breakdown</div>
          {[
            {l:"Field Acquisition",v:acquisitionSpend,pct:totalSpent>0?acquisitionSpend/totalSpent*100:0,c:"#f5c842"},
            {l:"Harvest & Transport",v:harvestCosts,pct:totalSpent>0?harvestCosts/totalSpent*100:0,c:"#5b9cf6"},
            {l:"Realized Revenue",v:actualRevenue,pct:100,c:"#3ddc84",pos:true},
            {l:"Est. Future Revenue",v:estFutureRevenue,pct:100,c:"#f5c84260",pos:true},
          ].map(({l,v,pct,c,pos})=>(
            <div key={l} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace"}}>{l}</span>
                <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:pos?"#3ddc84":"#e8d87a"}}>{K(v)}</span>
              </div>
              <div className="progress"><div className="progress-fill" style={{width:`${Math.min(100,isNaN(pct)?0:pct)}%`,background:c}}/></div>
            </div>
          ))}
          <div style={{borderTop:"1px solid #1a1800",paddingTop:12,marginTop:4,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace"}}>Expected Margin</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:20,color:totalMargin>20?"#3ddc84":totalMargin>0?"#f5c842":"#ff6b4a"}}>{fmt(totalMargin)}%</span>
          </div>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a",marginBottom:4}}>Weighbridge Trading</div>
          <div style={{fontSize:10,color:"#5a4e18",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>{transactions.length} transactions . KES arbitrage</div>
          <div className="grid3" style={{marginBottom:14}}>
            {[
              {l:"Tons Traded",v:fmt(wbTons)},
              {l:"Cash Out",v:K(wbSpend)},
              {l:"Gross Profit",v:K(wbProfit)},
            ].map(({l,v})=>(
              <div key={l}><span className="label">{l}</span><div className="stat-val" style={{fontSize:18}}>{v}</div></div>
            ))}
          </div>
          {wbChartData.length>0 && (
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={wbChartData} margin={{top:0,right:0,left:-24,bottom:0}}>
                <CartesianGrid stroke="#1a1800" strokeDasharray="3 0" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#4a3e10",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:"#4a3e10",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <Tooltip content={<ChartTooltip suffix=" t"/>}/>
                <Bar dataKey="tons" name="Tons" fill="#f5c84280" radius={[2,2,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {yieldAccuracy.length>0 && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#e8d87a",marginBottom:14}}>Yield Accuracy</div>
            {yieldAccuracy.map(f=>(
              <div key={f.name} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:10,color:"#8a7a30",fontFamily:"'DM Mono',monospace"}}>{f.name}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace"}}>{f.actual}t / {f.estimated}t</span>
                    <span className={`badge ${f.pct>=95?"badge-green":f.pct>=85?"badge-gold":"badge-red"}`}>{f.pct}%</span>
                  </div>
                </div>
                <div className="progress"><div className="progress-fill" style={{width:`${Math.min(100,f.pct)}%`,background:f.pct>=95?"#3ddc84":f.pct>=85?"#f5c842":"#ff6b4a"}}/></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GPS AREA HELPERS ─────────────────────────────────────────────────────────
function shoelaceAcres(pts) {
  if (pts.length < 3) return 0;
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].lng * pts[j].lat;
    area -= pts[j].lng * pts[i].lat;
  }
  const avgLat = pts.reduce((s, p) => s + p.lat, 0) / n;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(avgLat * Math.PI / 180);
  const sqMeters = Math.abs(area) / 2 * metersPerDegLat * metersPerDegLng;
  return sqMeters / 4046.86;
}
function perimeterMeters(pts) {
  if (pts.length < 2) return 0;
  let d = 0;
  const n = pts.length;
  const R = 6371000;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    d += R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  }
  return d;
}

// ─── SATELLITE FIELD MAPPER ───────────────────────────────────────────────────
function FieldMapper({ onConfirm, onCancel, initialPts=[] }) {
  const [pts, setPts] = useState(initialPts);
  const [mapReady, setMapReady] = useState(false);
  const [gpsStatus, setGpsStatus] = useState("");
  const [mapCenter, setMapCenter] = useState({ lat: 0.37, lng: 35.12 }); // Kenya default
  const iframeRef = useRef(null);

  const acres = shoelaceAcres(pts);
  const perim = perimeterMeters(pts);

  // Build the self-contained Leaflet HTML that lives inside the iframe
  const buildMapHTML = (center, existingPts) => {
    const ptsJson = JSON.stringify(existingPts);
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body,#map{width:100%;height:100%;background:#0a0800;}
  .leaflet-container{background:#111;}
  /* Red pin marker like the screenshot */
  .pin-marker{width:28px;height:38px;position:relative;cursor:grab;}
  .pin-body{width:28px;height:28px;background:#e83030;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.5);}
  .pin-dot{position:absolute;top:7px;left:7px;width:10px;height:10px;background:#fff;border-radius:50%;transform:rotate(45deg);}
  .first-pin .pin-body{background:#f5c842;border-color:#fff;}
  /* Stats overlay */
  #stats{position:fixed;top:8px;left:8px;background:rgba(180,30,30,.9);color:#fff;padding:8px 14px;border-radius:8px;font-family:monospace;font-size:13px;font-weight:700;display:none;z-index:1000;line-height:1.6;backdrop-filter:blur(4px);}
  /* Hint */
  #hint{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#f5c842;padding:7px 16px;border-radius:20px;font-family:monospace;font-size:11px;white-space:nowrap;z-index:1000;pointer-events:none;}
  /* GPS btn */
  #gps-btn{position:fixed;bottom:50px;right:10px;background:#f5c842;color:#0a0800;border:none;border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.4);}
  /* Undo btn */
  #undo-btn{position:fixed;bottom:100px;right:10px;background:#1a1a1a;color:#f5c842;border:1px solid #f5c84255;border-radius:50%;width:44px;height:44px;font-size:14px;cursor:pointer;z-index:1000;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4);}
</style>
</head><body>
<div id="map"></div>
<div id="stats"></div>
<div id="hint">Tap map to drop boundary pins</div>
<button id="gps-btn" title="My location">◎</button>
<button id="undo-btn" title="Undo last">↩</button>
<script>
var pts = ${ptsJson};
var markers = [];
var polygon = null;
var edgeLabels = [];

var map = L.map('map', {
  center: [${center.lat}, ${center.lng}],
  zoom: 17,
  zoomControl: true,
  attributionControl: false,
});

// Satellite tiles (ESRI World Imagery - free, no API key)
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 20, minZoom: 2,
  attribution: 'ESRI'
}).addTo(map);

// Thin OSM label overlay for place names on top of satellite
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, opacity: 0.7
}).addTo(map);

function makePinIcon(isFirst) {
  return L.divIcon({
    className: '',
    html: '<div class="pin-marker' + (isFirst?' first-pin':'') + '"><div class="pin-body"><div class="pin-dot"></div></div></div>',
    iconSize: [28,38], iconAnchor: [14,38]
  });
}

function haversine(a, b) {
  var R=6371000, dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  var x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function shoelaceAcres(p) {
  if (p.length<3) return 0;
  var area=0, n=p.length;
  for (var i=0;i<n;i++){var j=(i+1)%n;area+=p[i].lng*p[j].lat;area-=p[j].lng*p[i].lat;}
  var avgLat=p.reduce(function(s,x){return s+x.lat;},0)/n;
  var mLat=111320, mLng=111320*Math.cos(avgLat*Math.PI/180);
  return Math.abs(area)/2*mLat*mLng/4046.86;
}
function perimeterMeters(p) {
  if (p.length<2) return 0;
  var d=0, n=p.length;
  for (var i=0;i<n;i++) d+=haversine(p[i],p[(i+1)%n]);
  return d;
}

function clearEdgeLabels() {
  edgeLabels.forEach(function(l){map.removeLayer(l);});
  edgeLabels=[];
}

function redraw() {
  // Update markers
  markers.forEach(function(m){map.removeLayer(m);});
  markers=[];
  clearEdgeLabels();
  if (polygon) { map.removeLayer(polygon); polygon=null; }

  pts.forEach(function(p,i){
    var m = L.marker([p.lat,p.lng], {icon:makePinIcon(i===0), draggable:true});
    m.on('dragend', function(e){
      var ll=e.target.getLatLng();
      pts[i]={lat:+ll.lat.toFixed(6),lng:+ll.lng.toFixed(6)};
      redraw(); sendPts();
    });
    m.addTo(map);
    markers.push(m);
  });

  if (pts.length>=2) {
    // Draw edge lines with distance labels
    for (var i=0;i<pts.length;i++){
      var a=pts[i], b=pts[(i+1)%pts.length];
      if (pts.length<3 && i===pts.length-1) break;
      var dist=haversine(a,b);
      var label=dist>=1000?(dist/1000).toFixed(2)+'km':Math.round(dist)+'m';
      var midLat=(a.lat+b.lat)/2, midLng=(a.lng+b.lng)/2;
      var el=L.divIcon({className:'',html:'<div style="background:rgba(220,40,40,.85);color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-family:monospace;font-weight:700;white-space:nowrap;">'+label+'</div>',iconAnchor:[20,10]});
      edgeLabels.push(L.marker([midLat,midLng],{icon:el,interactive:false}).addTo(map));
    }
  }

  if (pts.length>=3) {
    var lls=pts.map(function(p){return [p.lat,p.lng];});
    polygon=L.polygon(lls, {color:'#ffffff',weight:2,fillColor:'#3ddc84',fillOpacity:0.25}).addTo(map);
    var ac=shoelaceAcres(pts), perim=perimeterMeters(pts);
    var ps=perim>=1000?(perim/1000).toFixed(2)+'km':Math.round(perim)+'m';
    document.getElementById('stats').style.display='block';
    document.getElementById('stats').innerHTML='Area: '+ac.toFixed(2)+'ac<br>Perimeter: '+ps;
    document.getElementById('hint').textContent='Drag pins to adjust · Tap to add more';
  } else {
    document.getElementById('stats').style.display='none';
    var hints=['Tap map to drop boundary pins','Add one more pin','One more to close polygon'];
    document.getElementById('hint').textContent=hints[Math.min(pts.length,2)];
  }
  document.getElementById('undo-btn').style.display=pts.length>0?'block':'none';
}

map.on('click', function(e) {
  pts.push({lat:+e.latlng.lat.toFixed(6),lng:+e.latlng.lng.toFixed(6)});
  redraw(); sendPts();
});

document.getElementById('undo-btn').onclick=function(){
  pts.pop(); redraw(); sendPts();
};

document.getElementById('gps-btn').onclick=function(){
  if (!navigator.geolocation){alert('GPS unavailable');return;}
  navigator.geolocation.getCurrentPosition(function(pos){
    var la=+pos.coords.latitude.toFixed(6),lo=+pos.coords.longitude.toFixed(6);
    map.setView([la,lo],18);
    pts.push({lat:la,lng:lo});
    redraw(); sendPts();
  },function(){alert('GPS denied or unavailable');},{enableHighAccuracy:true,timeout:10000});
};

function sendPts(){
  window.parent.postMessage({type:'MAP_PTS',pts:pts},'*');
}

// Receive commands from parent (e.g. clear, add GPS point)
window.addEventListener('message',function(e){
  if (!e.data) return;
  if (e.data.type==='CLEAR'){pts=[];redraw();sendPts();}
  if (e.data.type==='GOTO'){map.setView([e.data.lat,e.data.lng],18);}
  if (e.data.type==='INIT_PTS' && e.data.pts && e.data.pts.length>0){
    pts=e.data.pts;
    redraw();
    var lats=pts.map(function(p){return p.lat;}), lngs=pts.map(function(p){return p.lng;});
    map.fitBounds([[Math.min.apply(null,lats),Math.min.apply(null,lngs)],[Math.max.apply(null,lats),Math.max.apply(null,lngs)]],{padding:[40,40]});
  }
});

// Initial draw if pts exist
redraw();
if (pts.length>0){
  var lats=pts.map(function(p){return p.lat;}), lngs=pts.map(function(p){return p.lng;});
  map.fitBounds([[Math.min.apply(null,lats),Math.min.apply(null,lngs)],[Math.max.apply(null,lats),Math.max.apply(null,lngs)]],{padding:[40,40]});
}
</script>
</body></html>`;
  };

  // Listen for postMessage from iframe
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'MAP_PTS') {
        setPts(e.data.pts);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Try to get user location to center map on load
  useEffect(() => {
    if (initialPts.length > 0) return; // already have points, no need to geolocate
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => setMapCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {}, { timeout: 5000 }
      );
    }
  }, []);

  const mapHTML = buildMapHTML(mapCenter, initialPts);
  const blobUrl = useMemo(() => {
    const blob = new Blob([mapHTML], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [mapCenter.lat, mapCenter.lng]);

  const sendToMap = (msg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  };

  const grabGPS = () => {
    if (!navigator.geolocation) { setGpsStatus("GPS not available"); return; }
    setGpsStatus("Locating...");
    navigator.geolocation.getCurrentPosition(
      pos => {
        const la = +pos.coords.latitude.toFixed(6);
        const lo = +pos.coords.longitude.toFixed(6);
        sendToMap({ type: 'GOTO', lat: la, lng: lo });
        setGpsStatus(`Centered: ${la.toFixed(4)}, ${lo.toFixed(4)}`);
        setTimeout(() => setGpsStatus(""), 3000);
      },
      () => setGpsStatus("GPS unavailable — try on a real device"),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  return (
    <div className="fade" style={{display:"flex",flexDirection:"column",gap:0}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"#f5c842",letterSpacing:".05em",lineHeight:1}}>Map Field Boundary</div>
          <div style={{fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace",marginTop:3}}>
            Tap the satellite map to drop boundary pins · Drag to adjust
          </div>
        </div>
        <button className="btn-ghost" style={{fontSize:10,padding:"6px 10px"}} onClick={grabGPS}>◎ Centre GPS</button>
      </div>

      {/* Stats bar — live */}
      <div style={{display:"flex",gap:0,marginBottom:8,background:"#0f0d00",borderRadius:10,border:`1px solid ${pts.length>=3?"#f5c84240":"#1e1a00"}`,overflow:"hidden"}}>
        {[
          {l:"AREA", v: pts.length>=3 ? acres.toFixed(2)+" ac" : "—", c:"#f5c842"},
          {l:"PERIMETER", v: pts.length>=3 ? (perim>=1000?(perim/1000).toFixed(2)+"km":Math.round(perim)+"m") : "—", c:"#e8d87a"},
          {l:"PINS", v: pts.length, c:"#8a7a30"},
        ].map(({l,v,c},i)=>(
          <div key={l} style={{flex:1,textAlign:"center",padding:"10px 6px",borderRight:i<2?"1px solid #1e1a00":"none"}}>
            <div className="label" style={{marginBottom:2}}>{l}</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:c}}>{v}</div>
          </div>
        ))}
      </div>

      {/* SATELLITE MAP IFRAME */}
      <div style={{borderRadius:14,overflow:"hidden",border:`2px solid ${pts.length>=3?"#3ddc8460":"#2a2400"}`,position:"relative",marginBottom:10}}>
        <iframe
          ref={iframeRef}
          src={blobUrl}
          onLoad={() => setMapReady(true)}
          style={{width:"100%",height:380,border:"none",display:"block"}}
          title="Field Map"
        />
        {!mapReady && (
          <div style={{position:"absolute",inset:0,background:"#0a0800",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#4a3e10"}}>Loading satellite map…</div>
          </div>
        )}
      </div>

      {/* GPS status */}
      {gpsStatus && (
        <div style={{fontSize:10,color:"#5a9a40",fontFamily:"'DM Mono',monospace",marginBottom:8,textAlign:"center",padding:"6px",background:"#0a1408",borderRadius:6}}>
          {gpsStatus}
        </div>
      )}

      {/* Point list — scrollable */}
      {pts.length > 0 && (
        <div style={{background:"#0a0800",borderRadius:10,padding:"8px 10px",marginBottom:8,border:"1px solid #1e1a00",maxHeight:100,overflowY:"auto"}}>
          <div style={{fontSize:9,color:"#3a3000",fontFamily:"'DM Mono',monospace",marginBottom:4,textTransform:"uppercase",letterSpacing:".1em"}}>Pin Coordinates</div>
          {pts.map((p,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:i<pts.length-1?"1px solid #141200":"none"}}>
              <span style={{fontSize:9,color:i===0?"#f5c842":"#4a3e10",fontFamily:"'DM Mono',monospace",minWidth:22}}>#{i+1}</span>
              <span style={{fontSize:9,color:"#7a6a28",fontFamily:"'DM Mono',monospace",flex:1}}>{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</span>
              <button onClick={()=>{const np=pts.filter((_,j)=>j!==i);setPts(np);sendToMap({type:'CLEAR'});setTimeout(()=>sendToMap({type:'INIT_PTS',pts:np}),50);}} style={{background:"none",border:"none",color:"#ff6b4a",fontSize:12,cursor:"pointer",padding:"0 4px"}}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        {pts.length > 0 && (
          <button className="btn-ghost" style={{flex:1,fontSize:10}} onClick={()=>{
            const np=pts.slice(0,-1); setPts(np);
            sendToMap({type:'CLEAR'}); setTimeout(()=>sendToMap({type:'INIT_PTS',pts:np}),50);
          }}>↩ Undo Last</button>
        )}
        {pts.length > 0 && (
          <button className="btn-danger" style={{fontSize:10,padding:"9px 14px"}} onClick={()=>{
            setPts([]); sendToMap({type:'CLEAR'});
          }}>Clear All</button>
        )}
      </div>

      {pts.length >= 3 && (
        <button className="btn-gold" style={{width:"100%",marginBottom:8,fontSize:13,padding:"13px"}} onClick={()=>onConfirm(pts, acres)}>
          ✓ Confirm Boundary · {acres.toFixed(2)} ac
        </button>
      )}
      <button className="btn-ghost" style={{width:"100%",fontSize:11}} onClick={onCancel}>Cancel</button>
    </div>
  );
}

function FieldsScreen({fields,setFields,settings}) {
  const [tab,setTab] = useState("list");
  const [showAdd,setShowAdd] = useState(false);
  const [mapping,setMapping] = useState(false);
  const [editHarvest,setEditHarvest] = useState(null);
  const [harvestForm,setHarvestForm] = useState({});
  const [expandSites,setExpandSites] = useState({});
  const [remapFieldId,setRemapFieldId] = useState(null);  // which field is being remapped
  const [form,setForm] = useState({name:"",avg_nodes:"",avg_stalks:""});
  const [mappedPolygon,setMappedPolygon] = useState(null);
  const [mappedAcres,setMappedAcres] = useState(null);
  const [newSites,setNewSites] = useState([]);

  const addField = ()=>{
    if (!form.name) return;
    const acres = mappedAcres || 0;
    if (acres < 0.01) { alert("Please map the field boundary first."); return; }
    const nodes=+form.avg_nodes||12, stalks=+form.avg_stalks||8, s=settings;
    const yieldPerAcre=(nodes*s.node_constant+stalks*s.stalk_constant)*s.density_factor*s.loss_adjustment;
    const cLat = mappedPolygon ? mappedPolygon.reduce((a,p)=>a+p.lat,0)/mappedPolygon.length : 0.5;
    const cLng = mappedPolygon ? mappedPolygon.reduce((a,p)=>a+p.lng,0)/mappedPolygon.length : 35.1;
    const nf={id:uuid(),name:form.name,area_acres:+acres.toFixed(2),estimated_total_tons:+(yieldPerAcre*acres).toFixed(1),
      polygon: mappedPolygon || generateMockPolygon(cLat,cLng,acres),
      survey:{avg_nodes:nodes,avg_stalks:stalks,date:new Date().toISOString().slice(0,10),sites:newSites},harvest:null};
    setFields(fs=>[nf,...fs]);
    setForm({name:"",avg_nodes:"",avg_stalks:""});
    setMappedPolygon(null); setMappedAcres(null);
    setNewSites([]); setShowAdd(false); setMapping(false);
  };

  const saveHarvest = (field)=>{
    const h=harvestForm;
    if (!h.actual_tonnage) return;
    setFields(fs=>fs.map(f=>f.id===field.id?{...f,harvest:{actual_tonnage:+h.actual_tonnage,harvest_cost:+h.harvest_cost||0,transport_cost:+h.transport_cost||0,selling_price:+h.selling_price||settings.company_rate,date:h.date||new Date().toISOString().slice(0,10)}}:f));
    setEditHarvest(null);
  };

  const updateFieldSites = (fieldId,sites)=>{
    setFields(fs=>fs.map(f=>f.id===fieldId?{...f,survey:{...f.survey,sites}}:f));
  };

  const deleteField = id=>setFields(fs=>fs.filter(f=>f.id!==id));

  const confirmRemap = (fieldId, newPts, newAcres) => {
    setFields(fs => fs.map(f => {
      if (f.id !== fieldId) return f;
      const nodes = f.survey?.avg_nodes || 12;
      const stalks = f.survey?.avg_stalks || 8;
      const s = settings;
      const yieldPerAcre = (nodes*s.node_constant + stalks*s.stalk_constant) * s.density_factor * s.loss_adjustment;
      return { ...f, polygon: newPts, area_acres: +newAcres.toFixed(2), estimated_total_tons: +(yieldPerAcre * newAcres).toFixed(1) };
    }));
    setRemapFieldId(null);
  };

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a1800"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:14}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#3a3000",marginBottom:2}}>SURVEY & MANAGEMENT</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#f5c842"}}>FIELDS</div>
          </div>
          <button className="btn-gold" onClick={()=>setShowAdd(s=>!s)} style={{padding:"9px 16px",fontSize:11}}>
            {showAdd?"x Cancel":"+ Add Field"}
          </button>
        </div>
        <div style={{display:"flex",gap:6}}>
          {["list","map"].map(t=><button key={t} className={`tab ${tab===t?"on":""}`} onClick={()=>setTab(t)}>{t}</button>)}
        </div>
      </div>

      <div style={{padding:"14px 20px 0"}}>
        {showAdd && (
          <div className="card fade" style={{marginBottom:14,borderColor:"#f5c84230"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#f5c842",marginBottom:14,letterSpacing:".04em"}}>New Field Survey</div>
            <div style={{marginBottom:10}}><label className="label">Field Name</label><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Awasi Block 5"/></div>
            <div className="grid2" style={{marginBottom:10}}>
              <div><label className="label">Area (acres)</label><input type="number" value={form.area_acres} onChange={e=>setForm(f=>({...f,area_acres:e.target.value}))} placeholder="0.0"/></div>
              <div><label className="label">Avg. Nodes</label><input type="number" value={form.avg_nodes} onChange={e=>setForm(f=>({...f,avg_nodes:e.target.value}))} placeholder="12"/></div>
            </div>
            <div className="grid2" style={{marginBottom:14}}>
              <div><label className="label">Avg. Stalks</label><input type="number" value={form.avg_stalks} onChange={e=>setForm(f=>({...f,avg_stalks:e.target.value}))} placeholder="8"/></div>
              <div><label className="label">GPS Lat</label><input type="number" value={form.lat} step="0.001" onChange={e=>setForm(f=>({...f,lat:e.target.value}))}/></div>
            </div>
            <div style={{borderTop:"1px solid #1e1a00",paddingTop:14,marginBottom:14}}>
              <SiteTable sites={newSites} setSites={setNewSites}/>
            </div>
            <button className="btn-gold" onClick={addField} style={{width:"100%"}}>Save Field</button>
          </div>
        )}

        {tab==="list" && (
          <div>
            {fields.length===0 && (
              <div className="card" style={{textAlign:"center",padding:"40px 20px",color:"#2a2400"}}>
                <div style={{fontSize:32,marginBottom:8}}>~</div>
                <div style={{fontSize:12,fontFamily:"'DM Mono',monospace"}}>No fields yet. Add your first field above.</div>
              </div>
            )}
            {fields.map(f=>{
              const purchaseCost=f.area_acres*settings.cost_per_acre;
              const isHarvested=!!f.harvest?.actual_tonnage;
              const actRevenue=isHarvested?f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate):null;
              const estRevenue=(f.estimated_total_tons||0)*settings.company_rate;
              const profit=isHarvested?actRevenue-purchaseCost-(f.harvest.harvest_cost||0)-(f.harvest.transport_cost||0):estRevenue-purchaseCost;
              const sites=f.survey?.sites||[];
              const isSitesOpen=expandSites[f.id];
              return (
                <div key={f.id} className="card card-hover" style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#e8d87a",letterSpacing:".03em",marginBottom:5}}>{f.name}</div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        <span className={`badge ${isHarvested?"badge-green":f.survey?"badge-gold":"badge-gray"}`}>
                          {isHarvested?"OK Harvested":f.survey?"Surveyed":"Mapped"}
                        </span>
                        <span className="badge badge-gray">{fmt(f.area_acres)} ac</span>
                        {sites.length>0&&<span className="badge badge-blue">{sites.length} site{sites.length>1?"s":""}</span>}
                      </div>
                    </div>
                    <PolygonMap coords={f.polygon} size={70}/>
                  </div>
                  <div className="grid2" style={{marginBottom:10}}>
                    <div><span className="label">Est. Tons</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#f5c842"}}>{fmt(f.estimated_total_tons)}</div></div>
                    {isHarvested&&<div><span className="label">Actual Tons</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#3ddc84"}}>{fmt(f.harvest.actual_tonnage)}</div></div>}
                    <div><span className="label">Acq. Cost</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16}}>{K(purchaseCost)}</div></div>
                    <div><span className="label">{isHarvested?"Actual Profit":"Est. Profit"}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:profit>0?"#3ddc84":"#ff6b4a"}}>{K(profit)}</div></div>
                  </div>

                  <div style={{borderTop:"1px solid #141200",paddingTop:10,marginBottom:10}}>
                    <button className="btn-ghost" style={{width:"100%",textAlign:"left",fontSize:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}
                      onClick={()=>setExpandSites(e=>({...e,[f.id]:!e[f.id]}))}>
                      <span>o Site Accessibility ({sites.length} sites)</span>
                      <span>{isSitesOpen?"^":"v"}</span>
                    </button>
                    {isSitesOpen && (
                      <div style={{marginTop:10}} className="fade">
                        <SiteTable sites={sites} setSites={newSites=>updateFieldSites(f.id,newSites)}/>
                      </div>
                    )}
                    {!isSitesOpen&&sites.length>0 && (
                      <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:6}}>
                        {sites.map(s=>(
                          <div key={s.id} style={{display:"flex",alignItems:"center",gap:4}}>
                            <span style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"-"}:</span>
                            {weatherBadge(s.weather_access)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {remapFieldId===f.id && (
                    <div style={{background:"#0a0800",borderRadius:12,padding:14,marginBottom:10,border:"1px solid #3ddc8440"}} className="fade">
                      <FieldMapper
                        initialPts={f.polygon||[]}
                        onConfirm={(pts,acres)=>confirmRemap(f.id,pts,acres)}
                        onCancel={()=>setRemapFieldId(null)}
                      />
                    </div>
                  )}

                  {editHarvest===f.id && (
                    <div style={{background:"#0a0800",borderRadius:10,padding:12,marginBottom:10}} className="fade">
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#f5c842",marginBottom:10}}>Record Harvest</div>
                      <div className="grid2" style={{marginBottom:8}}>
                        <div><label className="label">Actual Tonnage</label><input type="number" placeholder="0.0" onChange={e=>setHarvestForm(h=>({...h,actual_tonnage:e.target.value}))}/></div>
                        <div><label className="label">Factory Price (KES/t)</label><input type="number" defaultValue={settings.company_rate} onChange={e=>setHarvestForm(h=>({...h,selling_price:e.target.value}))}/></div>
                        <div><label className="label">Harvest Cost (KES)</label><input type="number" placeholder="0" onChange={e=>setHarvestForm(h=>({...h,harvest_cost:e.target.value}))}/></div>
                        <div><label className="label">Transport Cost (KES)</label><input type="number" placeholder="0" onChange={e=>setHarvestForm(h=>({...h,transport_cost:e.target.value}))}/></div>
                      </div>
                      <div style={{marginBottom:10}}><label className="label">Date</label><input type="date" defaultValue={new Date().toISOString().slice(0,10)} onChange={e=>setHarvestForm(h=>({...h,date:e.target.value}))}/></div>
                      <div style={{display:"flex",gap:8}}>
                        <button className="btn-gold" onClick={()=>saveHarvest(f)} style={{flex:1}}>Save</button>
                        <button className="btn-ghost" onClick={()=>setEditHarvest(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  <div style={{display:"flex",gap:8}}>
                    {remapFieldId!==f.id && (
                      <button className="btn-ghost" style={{flex:1,fontSize:10}} onClick={()=>setRemapFieldId(f.id)}>
                        o Remap Boundary
                      </button>
                    )}
                    {!isHarvested&&editHarvest!==f.id && (
                      <button className="btn-ghost" style={{flex:1,fontSize:10}} onClick={()=>{setEditHarvest(f.id);setHarvestForm({});}}>+ Record Harvest</button>
                    )}
                    <button className="btn-danger" style={{fontSize:10,padding:"8px 12px"}} onClick={()=>deleteField(f.id)}>x</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab==="map" && (
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#4a3e10",marginBottom:12}}>Field boundary previews - {fields.length} fields</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {fields.map(f=>(
                <div key={f.id} className="card" style={{padding:10,textAlign:"center"}}>
                  <PolygonMap coords={f.polygon} size={120} color={f.harvest?.actual_tonnage?"#3ddc84":"#f5c842"}/>
                  <div style={{marginTop:8,fontFamily:"'DM Mono',monospace",fontSize:10,color:"#8a7a30"}}>{f.name}</div>
                  <div style={{fontSize:9,color:"#4a3e10"}}>{fmt(f.area_acres)} ac . {fmt(f.estimated_total_tons)} t</div>
                  {(f.survey?.sites||[]).length>0 && (
                    <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:4,justifyContent:"center"}}>
                      {f.survey.sites.map(s=>weatherBadge(s.weather_access))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WeighbridgeScreen({transactions,setTransactions,settings,setSettings}) {
  const [tab,setTab] = useState("buy");
  const [form,setForm] = useState({farmer_name:"",tons:"",buy_price:settings.buy_rate,date:new Date().toISOString().slice(0,10),note:""});
  const [factoryRateInput,setFactoryRateInput] = useState(settings.company_rate);

  const tons=+form.tons||0, buyPrice=+form.buy_price||0;
  const totalCost=tons*buyPrice, expectedPayout=tons*settings.company_rate;
  const grossProfit=expectedPayout-totalCost, margin=expectedPayout>0?(grossProfit/expectedPayout*100):0;

  const addTxn = ()=>{
    if (!form.tons||!form.farmer_name) return;
    setTransactions(ts=>[{id:uuid(),farmer_name:form.farmer_name,tons,buy_price:buyPrice,total_cost:totalCost,expected_payout:expectedPayout,gross_profit:grossProfit,date:form.date,note:form.note},...ts]);
    setForm(f=>({...f,farmer_name:"",tons:"",note:""}));
  };
  const deleteTxn = id=>setTransactions(ts=>ts.filter(t=>t.id!==id));

  function getWeekLabel(mon) {
    const sun=new Date(mon); sun.setDate(mon.getDate()+6);
    const f=d=>`${d.getDate()}/${d.getMonth()+1}`;
    return `${f(mon)}-${f(sun)}`;
  }
  const byWeek={};
  transactions.forEach(t=>{
    const d=new Date(t.date); const day=d.getDay();
    const diff=day===0?-6:1-day;
    const mon=new Date(d); mon.setDate(d.getDate()+diff); mon.setHours(0,0,0,0);
    const k=mon.toISOString().slice(0,10);
    if (!byWeek[k]) byWeek[k]={week:getWeekLabel(mon),tons:0,cost:0,revenue:0,profit:0,count:0};
    byWeek[k].tons+=t.tons; byWeek[k].cost+=t.total_cost; byWeek[k].revenue+=t.expected_payout; byWeek[k].profit+=t.gross_profit; byWeek[k].count++;
  });
  const weeks=Object.entries(byWeek).sort((a,b)=>b[0].localeCompare(a[0])).map(([,v])=>v);

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a1800"}}>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#3a3000",marginBottom:2}}>BUY . TRACK . REPORT . KES</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#f5c842"}}>WEIGHBRIDGE</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          {[["buy","Buy"],["history","History"],["weekly","Weekly"]].map(([t,l])=>(
            <button key={t} className={`tab ${tab===t?"on":""}`} onClick={()=>setTab(t)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"14px 20px 0"}}>
        {tab==="buy" && (
          <div className="fade">
            {tons>0 && (
              <div className="card" style={{marginBottom:14,borderColor:"#f5c84230",background:"#f5c84208"}}>
                <div className="grid3">
                  {[
                    {l:"Cash Out",v:K(totalCost),c:"#ff8060"},
                    {l:"Expected In",v:K(expectedPayout),c:"#3ddc84"},
                    {l:"Gross Profit",v:K(grossProfit),c:grossProfit>0?"#f5c842":"#ff6b4a"},
                  ].map(({l,v,c})=>(
                    <div key={l} style={{textAlign:"center"}}>
                      <span className="label">{l}</span>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                <div className="progress" style={{marginTop:10}}><div className="progress-fill" style={{width:`${Math.min(100,margin)}%`,background:"#f5c842"}}/></div>
                <div style={{textAlign:"right",fontSize:9,color:"#5a4e18",marginTop:4,fontFamily:"'DM Mono',monospace"}}>{fmt(margin,1)}% margin</div>
              </div>
            )}
            <div className="card">
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#f5c842",marginBottom:14,letterSpacing:".04em"}}>New Purchase</div>
              <div style={{marginBottom:10}}><label className="label">Farmer Name</label><input value={form.farmer_name} onChange={e=>setForm(f=>({...f,farmer_name:e.target.value}))} placeholder="Farmer name"/></div>
              <div className="grid2" style={{marginBottom:10}}>
                <div><label className="label">Tons</label><input type="number" value={form.tons} onChange={e=>setForm(f=>({...f,tons:e.target.value}))} placeholder="0.0"/></div>
                <div><label className="label">Buy Price (KES/t)</label><input type="number" value={form.buy_price} onChange={e=>setForm(f=>({...f,buy_price:e.target.value}))}/></div>
              </div>
              <div style={{marginBottom:10,padding:"8px 10px",background:"#0a0800",borderRadius:8,fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span>Factory rate (KES/t):</span>
                <input type="number" value={factoryRateInput}
                  onChange={e=>setFactoryRateInput(e.target.value)}
                  onBlur={()=>{const v=+factoryRateInput;if(v>0)setSettings(s=>({...s,company_rate:v}));}}
                  onKeyDown={e=>{if(e.key==="Enter"){const v=+factoryRateInput;if(v>0)setSettings(s=>({...s,company_rate:v}));e.target.blur();}}}
                  style={{width:90,padding:"3px 7px",fontSize:12,color:"#f5c842",background:"#151200",border:"1px solid #f5c84240",borderRadius:6,fontFamily:"'Bebas Neue'",letterSpacing:".03em"}}
                />
                <span style={{color:"#3a3000",fontSize:9}}>edit anytime</span>
              </div>
              <div className="grid2" style={{marginBottom:10}}>
                <div><label className="label">Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
                <div><label className="label">Note</label><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="Optional"/></div>
              </div>
              <button className="btn-gold" onClick={addTxn} style={{width:"100%"}}>Record Purchase</button>
            </div>
          </div>
        )}

        {tab==="history" && (
          <div className="fade">
            {transactions.length===0&&<div className="card" style={{textAlign:"center",padding:32,color:"#2a2400",fontSize:12}}>No transactions yet.</div>}
            {transactions.map(t=>(
              <div key={t.id} className="card" style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:"#e8d87a",marginBottom:4}}>{t.farmer_name}</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      <span className="badge badge-gray">{t.date}</span>
                      <span className="badge badge-gold">{fmt(t.tons)} t</span>
                      <span className="badge badge-green">+{K(t.gross_profit)}</span>
                    </div>
                  </div>
                  <button className="btn-danger" style={{padding:"6px 10px",fontSize:10}} onClick={()=>deleteTxn(t.id)}>x</button>
                </div>
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #1a1800",display:"flex",gap:16}}>
                  <div><span className="label">Paid</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#ff8060"}}>{K(t.total_cost)}</div></div>
                  <div><span className="label">Expected</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84"}}>{K(t.expected_payout)}</div></div>
                  <div><span className="label">KES/ton</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16}}>{t.buy_price.toLocaleString()}</div></div>
                </div>
                {t.note&&<div style={{fontSize:10,color:"#4a3e10",fontStyle:"italic",marginTop:6,fontFamily:"'Crimson Pro',serif"}}>{t.note}</div>}
              </div>
            ))}
          </div>
        )}

        {tab==="weekly" && (
          <div className="fade">
            {weeks.length===0&&<div className="card" style={{textAlign:"center",padding:32,color:"#2a2400",fontSize:12}}>No transactions yet.</div>}
            {weeks.map((w,i)=>(
              <div key={i} className="card" style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#f5c842"}}>Week {w.week}</div>
                  <span className="badge badge-gray">{w.count} loads</span>
                </div>
                <div className="grid2">
                  {[
                    {l:"Tons",v:fmt(w.tons),c:"#f5c842"},
                    {l:"Gross Profit",v:K(w.profit),c:"#3ddc84"},
                    {l:"Cash Out",v:K(w.cost),c:"#ff8060"},
                    {l:"Expected In",v:K(w.revenue),c:"#5b9cf6"},
                  ].map(({l,v,c})=>(
                    <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:c}}>{v}</div></div>
                  ))}
                </div>
                <div className="progress" style={{marginTop:10}}><div className="progress-fill" style={{width:`${Math.min(100,w.revenue>0?w.profit/w.revenue*100:0)}%`,background:"#f5c842"}}/></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportsScreen({fields,transactions,settings}) {
  const harvestedFields = fields.filter(f=>f.harvest?.actual_tonnage);
  const pendingFields = fields.filter(f=>!f.harvest?.actual_tonnage);
  const totalEstTons = fields.reduce((s,f)=>s+(f.estimated_total_tons||0),0);
  const totalActTons = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage,0);
  const totalAcres = fields.reduce((s,f)=>s+f.area_acres,0);
  const avgYield = totalAcres>0?totalEstTons/totalAcres:0;
  const avgActYield = harvestedFields.length>0?totalActTons/harvestedFields.reduce((s,f)=>s+f.area_acres,0):0;
  const acqCost = fields.reduce((s,f)=>s+f.area_acres*settings.cost_per_acre,0);
  const harvestCost = harvestedFields.reduce((s,f)=>s+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0),0);
  const actRevenue = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate),0);
  const estFuture = pendingFields.reduce((s,f)=>s+(f.estimated_total_tons||0)*settings.company_rate,0);
  const wbProfit = transactions.reduce((s,t)=>s+t.gross_profit,0);

  const farmerMap={};
  transactions.forEach(t=>{
    if (!farmerMap[t.farmer_name]) farmerMap[t.farmer_name]={name:t.farmer_name,tons:0,profit:0,loads:0};
    farmerMap[t.farmer_name].tons+=t.tons; farmerMap[t.farmer_name].profit+=t.gross_profit; farmerMap[t.farmer_name].loads++;
  });
  const farmers=Object.values(farmerMap).sort((a,b)=>b.tons-a.tons).slice(0,8);

  const allSites=fields.flatMap(f=>(f.survey?.sites||[]).map(s=>({...s,field:f.name})));
  const badSites=allSites.filter(s=>s.weather_access?.includes("Impassable")||s.weather_access?.includes("4WD"));
  const warnSites=allSites.filter(s=>s.weather_access&&!s.weather_access.includes("Impassable")&&!s.weather_access.includes("4WD")&&!s.weather_access.includes("All-season"));

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 20px",borderBottom:"1px solid #1a1800"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#3a3000",marginBottom:2}}>SEASON SUMMARY . KES</div>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#f5c842"}}>REPORTS</div>
      </div>

      <div style={{padding:"16px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#e8d87a",marginBottom:14,letterSpacing:".05em"}}>Season Overview</div>
          <div className="grid2" style={{gap:12}}>
            {[
              {l:"Total Fields",v:fields.length},
              {l:"Harvested",v:harvestedFields.length},
              {l:"Total Acres",v:fmt(totalAcres)},
              {l:"Est. Tons",v:fmt(totalEstTons)},
              {l:"Actual Tons",v:fmt(totalActTons),c:"#3ddc84"},
              {l:"Yield Accuracy",v:totalEstTons>0?fmt(totalActTons/totalEstTons*100)+"%":"-",c:"#f5c842"},
              {l:"Avg Est. Yield/ac",v:fmt(avgYield)+" t"},
              {l:"Avg Act. Yield/ac",v:avgActYield>0?fmt(avgActYield)+" t":"-",c:"#3ddc84"},
            ].map(({l,v,c})=>(
              <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:c||"#e8d87a"}}>{v}</div></div>
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#e8d87a",marginBottom:14,letterSpacing:".05em"}}>P&amp;L Summary</div>
          {[
            {l:"Field Acquisition Cost",v:acqCost,color:"#ff8060",dir:"v"},
            {l:"Harvest & Transport Cost",v:harvestCost,color:"#ff8060",dir:"v"},
            {l:"Realized Revenue",v:actRevenue,color:"#3ddc84",dir:"^"},
            {l:"Estimated Future Revenue",v:estFuture,color:"#5b9cf6",dir:"~"},
            {l:"Weighbridge Profit",v:wbProfit,color:"#f5c842",dir:"^"},
          ].map(({l,v,color,dir})=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #1a1800"}}>
              <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:"#8a7a30"}}>{l}</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:9,color:"#3a3000"}}>{dir}</span>
                <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color}}>{K(v)}</span>
              </div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:12,marginTop:4}}>
            <span style={{fontSize:10,color:"#5a4e18",fontFamily:"'DM Mono',monospace"}}>Expected Total Margin</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:22,color:(actRevenue+estFuture)>(acqCost+harvestCost)?"#3ddc84":"#ff6b4a"}}>
              {(actRevenue+estFuture)>0?fmt(((actRevenue+estFuture-acqCost-harvestCost)/(actRevenue+estFuture))*100)+"%":"-"}
            </span>
          </div>
        </div>

        {(badSites.length>0||warnSites.length>0) && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#e8d87a",marginBottom:14,letterSpacing:".05em"}}>Access Risk Summary</div>
            {badSites.length>0 && (
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"#ff8060",fontFamily:"'DM Mono',monospace",marginBottom:6}}>! High Risk Sites ({badSites.length})</div>
                {badSites.map(s=>(
                  <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #141200"}}>
                    <div>
                      <span style={{fontSize:10,color:"#e8d87a",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Unnamed"}</span>
                      <span style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace",marginLeft:8}}>{s.field}</span>
                    </div>
                    {weatherBadge(s.weather_access)}
                  </div>
                ))}
              </div>
            )}
            {warnSites.length>0 && (
              <div>
                <div style={{fontSize:10,color:"#ffa540",fontFamily:"'DM Mono',monospace",marginBottom:6}}>! Seasonal Access ({warnSites.length})</div>
                {warnSites.map(s=>(
                  <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #141200"}}>
                    <div>
                      <span style={{fontSize:10,color:"#e8d87a",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Unnamed"}</span>
                      <span style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace",marginLeft:8}}>{s.field}</span>
                    </div>
                    {weatherBadge(s.weather_access)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {farmers.length>0 && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#e8d87a",marginBottom:14,letterSpacing:".05em"}}>Top Farmers</div>
            {farmers.map((f,i)=>(
              <div key={f.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #141200"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:i===0?"#f5c842":"#4a3e10",minWidth:18}}>#{i+1}</span>
                  <div>
                    <div style={{fontSize:11,color:"#e8d87a",fontFamily:"'DM Mono',monospace"}}>{f.name}</div>
                    <div style={{fontSize:9,color:"#4a3e10",fontFamily:"'DM Mono',monospace"}}>{f.loads} loads . {fmt(f.tons)} t</div>
                  </div>
                </div>
                <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84"}}>{K(f.profit)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [screen,setScreen] = useState("dashboard");
  const [fields,setFields] = useState(DEMO_FIELDS);
  const [transactions,setTransactions] = useState(DEMO_TXNS);
  const [settings,setSettings] = useState(DEFAULT_SETTINGS);
  return (
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100vh",background:"#0a0800",color:"#e8d87a",position:"relative"}}>
      <style>{CSS}</style>
      {screen==="dashboard"&&<Dashboard fields={fields} transactions={transactions} settings={settings} setSettings={setSettings}/>}
      {screen==="fields"&&<FieldsScreen fields={fields} setFields={setFields} settings={settings}/>}
      {screen==="weighbridge"&&<WeighbridgeScreen transactions={transactions} setTransactions={setTransactions} settings={settings} setSettings={setSettings}/>}
      {screen==="reports"&&<ReportsScreen fields={fields} transactions={transactions} settings={settings}/>}
      <Nav screen={screen} setScreen={setScreen}/>
    </div>
  );
}
