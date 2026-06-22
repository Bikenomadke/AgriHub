import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api, setToken, getToken } from "./api.js";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Html5Qrcode } from "html5-qrcode";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { calculateGeodesicArea, validatePolygon, simplifyPolygon, smoothPolygon, calculateSurveyConfidence } from "./gisEngine.js";
import { supabase } from "./supabase";

const DEFAULT_SETTINGS = {
  est_tons_per_acre: 30,
  cost_per_acre: 156000, company_rate: 11050, buy_rate: 8060,
  target_profitability: 18,
  coeff_poor: 0.22,
  coeff_fair: 0.24,
  coeff_good: 0.27,
  coeff_excellent: 0.30,
  // Investor-specific settings
  harvest_cost_per_ton: 300,
  investor_profit_margin: 10,
  winch_cost_per_ton: 0,
  transport_zone_1_rate: 950,  // 0-6km
  transport_zone_2_rate: 1050, // 6-12km
  transport_zone_3_rate: 1150, // 12-18km
  transport_zone_4_rate: 1250, // 18-24km+
};

const getRatoonMultiplier = (cycle) => {
  if (cycle === "ratoon_1") return 0.85;
  if (cycle === "ratoon_2") return 0.70;
  if (cycle === "ratoon_3_plus") return 0.55;
  return 1.0; // plant or default
};

const getDensityCoefficient = (rating, settings) => {
  const r = (rating || "fair").toLowerCase();
  const poor = settings?.coeff_poor !== undefined ? +settings.coeff_poor : 0.22;
  const fair = settings?.coeff_fair !== undefined ? +settings.coeff_fair : 0.24;
  const good = settings?.coeff_good !== undefined ? +settings.coeff_good : 0.27;
  const excellent = settings?.coeff_excellent !== undefined ? +settings.coeff_excellent : 0.30;
  
  if (r === "poor") return poor;
  if (r === "good") return good;
  if (r === "excellent") return excellent;
  return fair; // default
};

function calculateNewEstimate({ stalks, nodes, densityRating, spacing, ratoonCycle, acres, settings }) {
  const coeff = getDensityCoefficient(densityRating, settings);
  const s = +stalks || 8;
  const n = +nodes || 12;
  const sp = +spacing || 1.3;
  const rMult = getRatoonMultiplier(ratoonCycle);
  const ac = +acres || 0;
  
  return +(ac * (s * n * (coeff / sp) * rMult)).toFixed(1);
}

function calculateOriginalEstimate({ stalks, nodes, spacing, ratoonCycle, acres }) {
  const s = +stalks || 8;
  const n = +nodes || 12;
  const sp = +spacing || 1.3;
  const rMult = getRatoonMultiplier(ratoonCycle);
  const ac = +acres || 0;

  return +(ac * (s * n * (0.34398 / sp) * rMult)).toFixed(1);
}

function calculateFarmerPayout({ estimatedTons, factoryPrice, distanceKm, miscCost, acres, targetProfitPct }) {
  const tons = parseFloat(estimatedTons) || 0;
  const price = parseFloat(factoryPrice) || 0;
  const dist = parseFloat(distanceKm) || 0;
  const misc = parseFloat(miscCost) || 0;
  const ac = parseFloat(acres) || 0;
  const profitMargin = Math.max(10, Math.min(25, parseFloat(targetProfitPct) || 18)) / 100;

  const revenue = tons * price;
  const zoneIdx = dist > 0 ? Math.max(0, Math.ceil(dist / 6) - 1) : 0;
  const transportRate = 950 + (zoneIdx * 100);
  const harvestCost = tons * 350;
  const transportCost = tons * transportRate;
  const totalOpsCost = harvestCost + transportCost + misc;

  const netMargin = revenue - totalOpsCost;
  const payout = netMargin * (1 - profitMargin);
  const payoutPerAcre = ac > 0 ? payout / ac : 0;

  return {
    totalPayout: Math.max(0, Math.round(payout)),
    perAcre: Math.max(0, Math.round(payoutPerAcre)),
    profitMargin: Math.round(profitMargin * 100),
    revenue,
    totalOpsCost,
    harvestCost,
    transportCost,
    transportRate
  };
}

function calculateInvestorReturn({ estimatedTons, factoryPrice, distanceKm, acres, settings, customCosts = 0 }) {
  const tons = parseFloat(estimatedTons) || 0;
  const price = parseFloat(factoryPrice) || 0;
  const dist = parseFloat(distanceKm) || 0;
  const ac = parseFloat(acres) || 0;
  
  // Get investor-specific settings
  const harvestCostPerTon = settings?.harvest_cost_per_ton || 300;
  const investorMarginPct = (settings?.investor_profit_margin || 10) / 100;
  const winchCostPerTon = settings?.winch_cost_per_ton || 0;
  
  // Transport zone calculation
  let transportRate;
  if (dist <= 6) {
    transportRate = settings?.transport_zone_1_rate || 950;
  } else if (dist <= 12) {
    transportRate = settings?.transport_zone_2_rate || 1050;
  } else if (dist <= 18) {
    transportRate = settings?.transport_zone_3_rate || 1150;
  } else {
    transportRate = settings?.transport_zone_4_rate || 1250;
  }
  
  const revenue = tons * price;
  const harvestCost = tons * harvestCostPerTon;
  const transportCost = tons * transportRate;
  const winchCost = tons * winchCostPerTon;
  const totalOpsCost = harvestCost + transportCost + winchCost + customCosts;
  
  const grossProfit = revenue - totalOpsCost;
  const investorProfit = grossProfit * investorMarginPct;
  const netToInvestor = grossProfit - investorProfit;
  
  const fairFieldValuation = netToInvestor > 0 ? netToInvestor : 0;
  const valuationPerAcre = ac > 0 ? fairFieldValuation / ac : 0;
  
  return {
    fairFieldValuation: Math.round(fairFieldValuation),
    valuationPerAcre: Math.round(valuationPerAcre),
    investorProfit: Math.round(investorProfit),
    investorProfitMargin: Math.round(investorMarginPct * 100),
    revenue,
    totalOpsCost,
    harvestCost,
    transportCost,
    winchCost,
    customCosts,
    transportRate,
    transportZone: dist <= 6 ? "Zone 1 (0-6km)" : dist <= 12 ? "Zone 2 (6-12km)" : dist <= 18 ? "Zone 3 (12-18km)" : "Zone 4 (18km+)",
    grossProfit
  };
}

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

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}



function PolygonMap({coords,size=80,color="#3ddc84"}) {
  if (!coords||coords.length<3) return (
    <div style={{width:size,height:size,background:"#0f1f14",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#5ca873",fontSize:10}}>-</div>
  );
  const lats=coords.map(c=>c.lat),lngs=coords.map(c=>c.lng);
  const minLat=Math.min(...lats),maxLat=Math.max(...lats),minLng=Math.min(...lngs),maxLng=Math.max(...lngs);
  const pad=10;
  const toX=lng=>pad+((lng-minLng)/(maxLng-minLng||1))*(size-2*pad);
  const toY=lat=>size-pad-((lat-minLat)/(maxLat-minLat||1))*(size-2*pad);
  const pts=coords.map(c=>`${toX(c.lng)},${toY(c.lat)}`).join(" ");
  return (
    <svg width={size} height={size} style={{borderRadius:8,background:"#0a140a"}}>
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
    <div style={{background:"#0d1a10",border:"1px solid #1a3320",borderRadius:8,padding:"8px 12px",fontFamily:"monospace",fontSize:11}}>
      <div style={{color:"#86efac",marginBottom:4}}>{label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{color:p.color||"#3ddc84"}}>{p.name}: {prefix}{typeof p.value==="number"?p.value.toLocaleString():p.value}{suffix}</div>
      ))}
    </div>
  );
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@300;400;500&family=Crimson+Pro:ital,wght@0,300;1,300&display=swap');

/* === HIGH-CONTRAST THEME VARIABLES === */
:root {
  --bg-body: #FFFFFF;
  --bg-card: #FFFFFF;
  --bg-input: #FFFFFF;
  --bg-alt: #F5F5F5;
  --bg-inverse: #000000;
  --bg-modal: rgba(255,255,255,0.96);
  --text-primary: #000000;
  --text-inverse: #FFFFFF;
  --text-muted: #595959;
  --text-danger: #CC0000;
  --text-warning: #CC8800;
  --text-success: #006600;
  --border: #DADADA;
  --border-strong: #000000;
  --accent-danger: #CC0000;
  --accent-success: #006600;
  --accent-warning: #CC8800;
  --shadow: rgba(0,0,0,0.12);
  --shadow-strong: rgba(0,0,0,0.4);
  --primary-rgb: 0,0,0;
}

[data-theme="dark"] {
  --bg-body: #000000;
  --bg-card: #121212;
  --bg-input: #121212;
  --bg-alt: #1A1A1A;
  --bg-inverse: #FFFFFF;
  --bg-modal: rgba(0,0,0,0.96);
  --text-primary: #FFFFFF;
  --text-inverse: #000000;
  --text-muted: #AAAAAA;
  --text-danger: #FF6666;
  --text-warning: #FFCC66;
  --text-success: #66FF66;
  --border: #444444;
  --border-strong: #FFFFFF;
  --accent-danger: #FF6666;
  --accent-success: #66FF66;
  --accent-warning: #FFCC66;
  --shadow: rgba(0,0,0,0.5);
  --shadow-strong: rgba(0,0,0,0.8);
  --primary-rgb: 255,255,255;
}

*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:var(--bg-body);color:var(--text-primary);}
::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px;}
input,select,textarea{background:var(--bg-input);border:1.5px solid var(--border);color:var(--text-primary);border-radius:8px;padding:9px 12px;font-family:'DM Mono',monospace;font-size:12px;width:100%;outline:none;transition:border .15s;}
input:focus,select:focus{border-color:var(--border-strong);box-shadow:0 0 0 3px rgba(var(--primary-rgb),0.15);}
input::placeholder{color:var(--text-muted);}
select option{background:var(--bg-input);color:var(--text-primary);}
button{cursor:pointer;border:none;font-family:'DM Mono',monospace;}

/* Buttons */
.btn-gold{background:var(--bg-inverse);color:var(--text-inverse);border-radius:9px;padding:11px 20px;font-weight:600;font-size:12px;letter-spacing:.04em;transition:all .15s;box-shadow:0 3px 8px var(--shadow);}
.btn-gold:hover{background:var(--text-primary);transform:translateY(-1px);}
.btn-ghost{background:var(--bg-card);border:1.5px solid var(--border-strong);color:var(--text-primary);border-radius:9px;padding:9px 14px;font-size:11px;font-weight:600;transition:all .15s;}
.btn-ghost:hover{border-color:var(--text-primary);color:var(--text-primary);background:var(--bg-alt);}
.btn-danger{background:var(--bg-card);border:1.5px solid var(--accent-danger);color:var(--accent-danger);border-radius:9px;padding:9px 14px;font-size:11px;font-weight:600;}
.btn-sm{padding:5px 10px!important;font-size:10px!important;border-radius:7px!important;}

/* Cards */
.card{background:var(--bg-card);border:1.5px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 4px 12px var(--shadow);}
.card-hover{transition:border-color .15s,transform .15s;}
.card-hover:hover{border-color:var(--border-strong);transform:translateY(-1px);}
.label{color:var(--text-primary);font-size:9px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px;display:block;font-family:'DM Mono',monospace;font-weight:700;}
.stat-val{font-family:'Bebas Neue',sans-serif;letter-spacing:.03em;line-height:1;color:var(--text-primary);}

/* Badges - high contrast semantic */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;font-family:'DM Mono',monospace;}
.badge-gold{background:var(--bg-inverse);color:var(--text-inverse);border:1.5px solid var(--border-strong);font-weight:600;}
.badge-green{background:var(--bg-inverse);color:var(--text-inverse);border:1.5px solid var(--border-strong);font-weight:600;}
.badge-red{background:var(--bg-card);color:var(--text-danger);border:1.5px solid var(--text-danger);font-weight:600;}
.badge-gray{background:var(--bg-alt);color:var(--text-primary);border:1.5px solid var(--border);font-weight:600;}
.badge-blue{background:var(--bg-alt);color:var(--text-primary);border:1.5px solid var(--border);font-weight:600;}
.badge-orange{background:var(--bg-alt);color:var(--text-primary);border:1.5px solid var(--border);font-weight:600;}

/* Tabs */
.tab{padding:7px 14px;border-radius:20px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-family:'DM Mono',monospace;cursor:pointer;transition:all .15s;border:1px solid var(--border-strong);background:var(--bg-card);color:var(--text-primary);white-space:nowrap;font-weight:600;}
.tab.on{background:var(--bg-inverse);color:var(--text-inverse);border-color:var(--bg-inverse);}
.tab:hover:not(.on){color:var(--text-primary);background:var(--bg-alt);}

/* Animations */
.fade{animation:fd .22s ease;}
@keyframes fd{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
.glow-text{text-shadow:none;}
.progress{height:6px;background:var(--bg-alt);border-radius:3px;overflow:hidden;}
.progress-fill{height:100%;border-radius:3px;transition:width .8s cubic-bezier(.4,0,.2,1);}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;}
.rate-pill{display:inline-flex;align-items:center;gap:6px;background:var(--bg-alt);border:1.5px solid var(--border-strong);border-radius:20px;padding:5px 12px;}
.rate-input{background:transparent!important;border:none!important;padding:0!important;width:80px!important;font-family:'Bebas Neue',sans-serif!important;font-size:20px!important;color:var(--text-primary)!important;box-shadow:none!important;text-align:right;}
.site-table{width:100%;border-collapse:collapse;font-size:11px;font-family:'DM Mono',monospace;background:var(--bg-card);}
.site-table th{color:var(--text-primary);font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:8px;border-bottom:2.5px solid var(--border-strong);text-align:left;font-weight:700;background:var(--bg-alt);}
.site-table td{padding:8px;border-bottom:1.5px solid var(--border);vertical-align:top;color:var(--text-primary);}
.site-table tr:last-child td{border-bottom:none;}
.site-table input,.site-table select{padding:5px 7px!important;font-size:11px!important;border-radius:6px!important;}
.login-card{background:var(--bg-card);border:1.5px solid var(--border);border-radius:20px;padding:36px 28px;width:100%;max-width:400px;box-shadow:0 10px 30px var(--shadow);}
.login-card input{font-size:13px;padding:13px 44px 13px 14px;background:var(--bg-input);color:var(--text-primary);border:1.5px solid var(--border);}
.input-wrap{position:relative;margin-bottom:14px;}
.input-wrap .eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-primary);font-size:16px;cursor:pointer;padding:4px;}
.input-wrap .eye:hover{color:var(--text-muted);}
.login-divider{border:none;border-top:1.5px solid var(--border);margin:20px 0;}
@keyframes loginFade{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:none;}}
.login-anim{animation:loginFade .4s ease;}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(var(--primary-rgb),0.3);}50%{box-shadow:0 0 0 8px transparent;}}
.btn-login{width:100%;background:var(--bg-inverse);color:var(--text-inverse);border-radius:12px;padding:14px;font-size:13px;font-weight:600;letter-spacing:.06em;transition:all .2s;border:none;box-shadow:0 4px 12px var(--shadow);}
.btn-login:hover{transform:translateY(-2px);background:var(--text-primary);box-shadow:0 8px 24px var(--shadow-strong);}
.btn-login:active{transform:none;}
.role-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:9px;letter-spacing:.1em;font-family:'DM Mono',monospace;text-transform:uppercase;}
@keyframes progress-move { 0% { left: -40%; } 100% { left: 100%; } }
.blink { animation: blk 1.2s infinite alternate; }
@keyframes blk { from { opacity: 0.6; } to { opacity: 1; } }

/* Layout */
.app-layout {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100vh;
  background: var(--bg-body);
  color: var(--text-primary);
  position: relative;
  display: flex;
  flex-direction: column;
}
.main-content { flex: 1; position: relative; width: 100%; padding-bottom: 65px; background: var(--bg-body); }
.desktop-nav {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border-top: 1.5px solid var(--border);
  display: flex;
  z-index: 99;
  padding-bottom: env(safe-area-inset-bottom, 8px);
}
.nav-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 4px 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-primary);
}
.nav-icon { font-size: 16px; transition: all .15s; }
.nav-label { font-size: 8.5px; letter-spacing: .1em; text-transform: uppercase; font-family: 'DM Mono', monospace; color: var(--text-primary); }

@media (min-width: 800px) {
  .app-layout { max-width: 1200px; flex-direction: row; align-items: flex-start; }
  .main-content { flex: 1; padding-bottom: 0; min-width: 0; }
  .desktop-nav {
    position: sticky;
    top: 0;
    left: auto;
    bottom: auto;
    transform: none;
    width: 180px;
    min-width: 180px;
    height: 100vh;
    max-width: none;
    border-top: none;
    border-right: 1.5px solid var(--border);
    flex-direction: column;
    justify-content: flex-start;
    padding-top: 40px;
    padding-bottom: 0;
    overflow-y: auto;
    z-index: 99;
  }
  .nav-btn { flex: none; padding: 16px 20px; flex-direction: row; justify-content: flex-start; gap: 12px; }
  .nav-label { font-size: 11px; }
  .grid2, .grid3 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
}

/* HIGH-SPECIFICITY OVERRIDES - map legacy colors to variables */
.app-layout *, .main-content * {
  text-shadow: none !important;
}
.card span[style*="color:var(--text-muted)"],
.card div[style*="color:var(--text-muted)"] {
  color: var(--text-muted) !important;
}
.card div[style*="color:var(--accent-danger)"],
.card span[style*="color:var(--accent-danger)"] {
  color: var(--accent-danger) !important;
  font-weight: bold !important;
}
.card div[style*="color:var(--accent-warning)"],
.card span[style*="color:var(--accent-warning)"] {
  color: var(--accent-warning) !important;
  font-weight: bold !important;
}

/* Screen headers */
.main-content > div > div[style*="background:linear-gradient"] {
  background: linear-gradient(180deg, var(--bg-alt) 0%, var(--bg-body) 100%) !important;
  border-bottom: 1.5px solid var(--border) !important;
}
.main-content > div > div[style*="background:linear-gradient"] h1 {
  color: var(--text-primary) !important;
}
.main-content > div > div[style*="background:linear-gradient"] div {
  color: var(--text-primary) !important;
}
.main-content > div > div[style*="background:linear-gradient"] span {
  color: var(--text-primary) !important;
}

/* Modal overlays */
div[style*="position:fixed"][style*="background:rgba(4,7,5,0.95)"],
div[style*="position:fixed"][style*="background:rgba(0,0,0,0.85)"] {
  background: var(--bg-modal) !important;
  backdrop-filter: blur(8px) !important;
}
div[style*="position:fixed"] > div {
  background: var(--bg-card) !important;
  border: 2px solid var(--border) !important;
  box-shadow: 0 10px 40px var(--shadow) !important;
}
div[style*="position:fixed"] > div * {
  color: var(--text-primary) !important;
}
div[style*="position:fixed"] > div label {
  color: var(--text-primary) !important;
}
div[style*="position:fixed"] > div .btn-gold {
  color: var(--text-inverse) !important;
}

/* Leaflet map controls */
.leaflet-control-layers {
  background: var(--bg-card) !important;
  color: var(--text-primary) !important;
  border: 1.5px solid var(--border) !important;
}

/* Force light backgrounds to use variables */
div[style*="background:#0a140a"],
div[style*="background:#0c0f0c"],
div[style*="background:#050805"],
div[style*="background:#0d1a10"],
div[style*="background:#0f1f14"] {
  background: var(--bg-card) !important;
  border-color: var(--border) !important;
}
div[style*="background:#0a140a"] *,
div[style*="background:#0c0f0c"] *,
div[style*="background:#050805"] *,
div[style*="background:#0d1a10"] *,
div[style*="background:#0f1f14"] * {
  color: var(--text-primary) !important;
}

/* Map common inline hex colors to theme vars for WCAG AA */
/* Primary text replacements */
.app-layout *[style*="color:#1a4d25"],
.app-layout *[style*="color:#052011"],
.app-layout *[style*="color:#d0d0d8"],
.app-layout *[style*="color:#a1a1aa"],
.app-layout *[style*="color:#a7f3d0"],
.app-layout *[style*="color:#5ca873"],
.app-layout *[style*="color:#cfece4"] {
  color: var(--text-primary) !important;
}

/* Success accents -> readable on both themes */
.app-layout *[style*="color:#3ddc84"],
.app-layout *[style*="color:#86efac"],
.app-layout *[style*="color:#7dff9e"] {
  color: var(--accent-success) !important;
}

/* Warning accents */
.app-layout *[style*="color:#eab308"],
.app-layout *[style*="color:#ffa540"] {
  color: var(--accent-warning) !important;
}

/* Danger accents */
.app-layout *[style*="color:#ff8060"],
.app-layout *[style*="color:#ff6b4a"],
.app-layout *[style*="color:#991b1b"] {
  color: var(--accent-danger) !important;
}

/* Background swaps for legacy dark greens */
.app-layout *[style*="background:#0a150e"],
.app-layout *[style*="background:#0a140a"],
.app-layout *[style*="background:#0d1a10"],
.app-layout *[style*="background:#0f1f14"],
.app-layout *[style*="background:#050805"],
.app-layout *[style*="background:#0c0f0c"] {
  background: var(--bg-card) !important;
  border-color: var(--border) !important;
}
`;

function weatherBadge(val) {
  if (!val) return <span className="badge badge-gray">-</span>;
  const bad = val.includes("Impassable")||val.includes("4WD");
  const ok = val.includes("All-season")||val.includes("Tarmac");
  return <span className={`badge ${bad?"badge-red":ok?"badge-green":"badge-orange"}`}>{val}</span>;
}

function Nav({screen,setScreen,role}) {
  const all = [
    {id:"dashboard",icon:"#",label:"Dashboard",roles:["Admin"]},
    {id:"investor",icon:"$",label:"Investor",roles:["Admin"]},
    {id:"fields",icon:"o",label:"Fields",roles:["Admin","Field Officer"]},
    {id:"weighbridge",icon:"~",label:"Trade",roles:["Admin","Weighbridge Trader"]},
    {id:"reports",icon:"^",label:"Reports",roles:["Admin"]},
    {id:"diagnostics",icon:"📊",label:"Diagnostics",roles:["Admin", "Field Officer"]},
    {id:"settings",icon:"⚙",label:"Settings",roles:["Admin"]},
  ];
  const items = all.filter(i=>i.roles.includes(role));
  return (
    <nav className="desktop-nav">
      {items.map(({id,icon,label})=>(
        <button key={id} onClick={()=>setScreen(id)} className="nav-btn" style={{color:screen===id?"#3ddc84":"#5ca873"}}>
          <span className="nav-icon" style={{color:screen===id?"#3ddc84":"#5ca873"}}>{icon}</span>
          <span className="nav-label" style={{color:screen===id?"#3ddc84":"#5ca873"}}>{label}</span>
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
        <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84",letterSpacing:".04em"}}>Site Accessibility</div>
        <button className="btn-ghost btn-sm" onClick={addRow}>+ Add Site</button>
      </div>
      {sites.length===0 && (
        <div style={{padding:"14px",background:"#0a140a",borderRadius:8,textAlign:"center",color:"#7dff9e",fontSize:11,fontFamily:"'DM Mono',monospace"}}>
          No sites recorded. Click + Add Site.
        </div>
      )}
      {sites.length>0 && (
        <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #1a4d25"}}>
          <table className="site-table">
            <thead>
              <tr style={{background:"#0a140a"}}>
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
              <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Site"}:</span>
              {weatherBadge(s.weather_access)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SignaturePad({ onSign, onClear }) {
  const canvasRef = useRef(null);
  const lastPos = useRef({ x: 0, y: 0 });
  const [isDrawing, setIsDrawing] = useState(false);

  const getCtx = () => {
    const ctx = canvasRef.current.getContext('2d');
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    return ctx;
  };

  const getCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (e.touches && e.touches.length > 0) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const startDrawing = (e) => {
    const { x, y } = getCoordinates(e);
    lastPos.current = { x, y };
    setIsDrawing(true);
  };

  const draw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const { x, y } = getCoordinates(e);
    const ctx = getCtx();
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastPos.current = { x, y };
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    onSign(canvasRef.current.toDataURL());
  };

  return (
    <div style={{ border: "1px dashed #3ddc8440", borderRadius: 8, background: "#0a140a", padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "#a7f3d0", fontFamily: "'DM Mono',monospace" }}>Farmer Signature (Required)</span>
        <button className="btn-ghost btn-sm" onClick={(e) => {
          e.preventDefault();
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          onClear();
        }}>Clear</button>
      </div>
      <canvas
        ref={canvasRef}
        width={300}
        height={100}
        style={{ width: "100%", background: "#000", touchAction: "none", borderRadius: 4, cursor: "crosshair" }}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
      />
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
  const acquisitionSpend = fields.reduce((s,f)=>s+(f.area_acres||0)*(f.buying_price_per_acre||settings.cost_per_acre),0);
  const harvestSpend = harvestedFields.reduce((s,f)=>s+(f.harvest.harvest_cost||0),0);
  const transportSpend = harvestedFields.reduce((s,f)=>s+(f.harvest.transport_cost||0),0);
  const otherSpend = harvestedFields.reduce((s,f)=>s+(f.harvest.other_cost||0),0);
  const totalSpent = acquisitionSpend+harvestSpend+transportSpend+otherSpend;
  const actualRevenue = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate),0);
  const estFutureRevenue = pendingFields.reduce((s,f)=>s+(f.estimated_total_tons||0)*settings.company_rate,0);
  const totalExpectedReturn = actualRevenue+estFutureRevenue;
  const realizedProfit = actualRevenue-harvestedFields.reduce((s,f)=>s+((f.area_acres||0)*(f.buying_price_per_acre||settings.cost_per_acre))+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0)+(f.harvest.other_cost||0),0);
  const totalMargin = totalExpectedReturn>0?((totalExpectedReturn-totalSpent)/totalExpectedReturn*100):0;
  const wbTons = transactions.reduce((s,t)=>s+t.tons,0);
  const wbSpend = transactions.reduce((s,t)=>s+t.total_cost,0);
  const wbExpected = transactions.reduce((s,t)=>s+t.expected_payout,0);
  const wbProfit = wbExpected-wbSpend;
  const wbPaid = transactions.filter(t => t.payment_status === "completed").reduce((s,t) => s + (t.payment_amount||0), 0);
  const wbPending = Math.max(0, wbSpend - wbPaid);
  const payPct = wbSpend > 0 ? (wbPaid / wbSpend) * 100 : 0;

  const fieldChartData = fields.map(f=>({
    name:f.name.split(" ").slice(-1)[0],
    estimated:+(f.estimated_total_tons||0).toFixed(1),
    actual:f.harvest?.actual_tonnage?+f.harvest.actual_tonnage.toFixed(1):0,
  }));
  const donutData = [
    {name:"Harvested",value:totalActualTons,color:"#3ddc84"},
    {name:"Pending",value:Math.max(0,totalEstTons-totalActualTons),color:"#1a4d25"},
  ];
  const sortedHarvests = harvestedFields.filter(f=>f.harvest?.date).sort((a,b)=>new Date(a.harvest.date)-new Date(b.harvest.date));
  let cumRev=0,cumCost=0;
  const revenueTimeline = sortedHarvests.map(f=>{
    cumRev+=f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate);
    cumCost+=(f.area_acres||0)*settings.cost_per_acre+(f.harvest.harvest_cost||0)+(f.harvest.transport_cost||0);
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
      <div style={{padding:"44px 20px 20px",background:"linear-gradient(180deg,#0d1a10 0%,#0a150e 100%)",borderBottom:"1px solid #1a4d25",position:"relative",overflow:"hidden"}}>
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".22em",color:"#5ca873",marginBottom:4}}>AGRIHUB . KES</div>
              <h1 style={{fontFamily:"'Bebas Neue'",fontSize:44,lineHeight:1,letterSpacing:".04em",color:"#3ddc84"}} className="glow-text">FIELD COMMAND</h1>
              <div style={{fontFamily:"'Crimson Pro',serif",fontStyle:"italic",fontSize:13,color:"#7dff9e",marginTop:4}}>{fields.length} fields . {fmt(totalAcres)} acres surveyed</div>
            </div>
            <button className="btn-ghost btn-sm" onClick={()=>generateReportPDF({fields, transactions, settings, title: "Dashboard Summary"})} style={{fontSize:9,padding:"7px 12px",whiteSpace:"nowrap",color:"#3ddc84",borderColor:"#3ddc8440"}}>
              📄 PDF
            </button>
          </div>
        </div>
        <div style={{marginBottom:16}}>
          <span className="label">Factory Rate (KES/ton) - edit anytime</span>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div className="rate-pill">
              <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",letterSpacing:".06em"}}>KES</span>
              {editingRate
                ? <input className="rate-input" type="number" value={rateInput} onChange={e=>setRateInput(e.target.value)} onBlur={saveRate} onKeyDown={e=>e.key==="Enter"&&saveRate()} autoFocus/>
                : <span style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"#3ddc84",letterSpacing:".03em",cursor:"text",minWidth:60}} onClick={()=>{setRateInput(settings.company_rate);setEditingRate(true);}}>{settings.company_rate.toLocaleString()}</span>
              }
              <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>/ton</span>
            </div>
            {!editingRate && <button className="btn-ghost btn-sm" onClick={()=>{setRateInput(settings.company_rate);setEditingRate(true);}}>edit</button>}
            {editingRate && <button className="btn-gold btn-sm" onClick={saveRate}>save</button>}
          </div>
        </div>
        <div className="grid2" style={{gap:8}}>
          {[
            {l:"Total Surveyed Cane",v:fmt(totalEstTons)+" t",sub:fmt(totalAcres)+" acres mapped"},
            {l:"Harvest Progress",v:fmt(harvestProgress)+"%",sub:`${harvestedFields.length} of ${fields.length} fields done`},
            {l:"Money Spent",v:K(totalSpent),sub:"Acq + Harvest + Transport + Logistics"},
            {l:"Expected Returns",v:K(totalExpectedReturn),sub:K(realizedProfit)+" realized profit"},
          ].map(({l,v,sub})=>(
            <div key={l} className="card" style={{padding:"14px"}}>
              <span className="label">{l}</span>
              <div className="stat-val" style={{fontSize:20,marginBottom:2}}>{v}</div>
              <div style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Modular Cost Breakdown Card */}
        <div className="card" style={{marginTop:12,border:"1px solid #3ddc8425",background:"linear-gradient(180deg,#0a150e 0%,#0d1a10 100%)"}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#3ddc84",marginBottom:10,letterSpacing:".05em"}}>Season Financial Breakdown</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {[
              {l:"1. Field Buying (Acquisition) Cost",v:acquisitionSpend,color:"#ff8060"},
              {l:"2. Sugarcane Harvesting Cost",v:harvestSpend,color:"#ff8060"},
              {l:"3. Sugarcane Transportation Cost",v:transportSpend,color:"#ff8060"},
              {l:"4. Other Logistics Costs (Loaders, Permits)",v:otherSpend,color:"#ff8060"},
              {l:"Total Money Spent",v:totalSpent,color:"#ffa540",bold:true},
              {l:"Total Realized Revenue (Weighed)",v:actualRevenue,color:"#3ddc84"},
              {l:"Total Net Profitability",v:realizedProfit,color:realizedProfit>0?"#3ddc84":"#ff6b4a",bold:true},
            ].map(({l,v,color,bold})=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #0f1f14",paddingBottom:4,fontWeight:bold?"bold":"normal"}}>
                <span style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:bold?"#a7f3d0":"#86efac"}}>{l}</span>
                <span style={{fontFamily:"'Bebas Neue'",fontSize:bold?16:14,color}}>{K(v)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{padding:"16px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
            <div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0"}}>Harvest Progress</div>
              <div style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginTop:2}}>{fmt(totalActualTons)}t of {fmt(totalEstTons)}t estimated</div>
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
                <div className="progress-fill" style={{width:`${Math.min(100,harvestProgress)}%`,background:"linear-gradient(90deg,#1b4d22,#3ddc84,#52fa95)"}}/>
              </div>
              <div className="grid2">
                {[
                  {l:"Harvested",v:harvestedFields.length,c:"#3ddc84"},
                  {l:"Pending",v:pendingFields.length,c:"#3ddc84"},
                  {l:"Actual Tons",v:fmt(totalActualTons),c:"#3ddc84"},
                  {l:"Remaining Est.",v:fmt(Math.max(0,totalEstTons-totalActualTons)),c:"#7dff9e"},
                ].map(({l,v,c})=>(
                  <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:c}}>{v}</div></div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {revenueTimeline.length>0 && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0",marginBottom:4}}>Cumulative P&amp;L</div>
            <div style={{fontSize:10,color:"#7dff9e",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>Revenue vs. cost over harvest cycle (KES)</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={revenueTimeline} margin={{top:4,right:4,left:-20,bottom:0}}>
                <defs>
                  <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3ddc84" stopOpacity={0.3}/><stop offset="95%" stopColor="#3ddc84" stopOpacity={0}/></linearGradient>
                  <linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ff6b4a" stopOpacity={0.2}/><stop offset="95%" stopColor="#ff6b4a" stopOpacity={0}/></linearGradient>
                  <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3ddc84" stopOpacity={0.25}/><stop offset="95%" stopColor="#3ddc84" stopOpacity={0}/></linearGradient>
                </defs>
                <CartesianGrid stroke="#1a4d25" strokeDasharray="3 0" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#7dff9e",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:"#7dff9e",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}K`}/>
                <Tooltip content={<ChartTooltip prefix="KES "/>}/>
                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#3ddc84" strokeWidth={1.5} fill="url(#gr)"/>
                <Area type="monotone" dataKey="cost" name="Cost" stroke="#ff6b4a" strokeWidth={1.5} fill="url(#gc)"/>
                <Area type="monotone" dataKey="profit" name="Profit" stroke="#3ddc84" strokeWidth={1.5} fill="url(#gp)"/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0",marginBottom:4}}>Tons by Field</div>
          <div style={{fontSize:10,color:"#7dff9e",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>Estimated vs. actual tonnage</div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={fieldChartData} margin={{top:4,right:4,left:-20,bottom:0}} barCategoryGap="30%">
              <CartesianGrid stroke="#1a4d25" strokeDasharray="3 0" vertical={false}/>
              <XAxis dataKey="name" tick={{fill:"#7dff9e",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:"#7dff9e",fontSize:9,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
              <Tooltip content={<ChartTooltip suffix=" t"/>}/>
              <Bar dataKey="estimated" name="Estimated" fill="#3ddc8435" stroke="#3ddc8460" strokeWidth={1} radius={[3,3,0,0]}/>
              <Bar dataKey="actual" name="Actual" fill="#3ddc84" radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0",marginBottom:14}}>Financial Breakdown</div>
          {[
            {l:"Field Acquisition",v:acquisitionSpend,pct:totalSpent>0?acquisitionSpend/totalSpent*100:0,c:"#3ddc84"},
            {l:"Harvest & Transport",v:harvestSpend+transportSpend+otherSpend,pct:totalSpent>0?(harvestSpend+transportSpend+otherSpend)/totalSpent*100:0,c:"#5b9cf6"},
            {l:"Realized Revenue",v:actualRevenue,pct:100,c:"#3ddc84",pos:true},
            {l:"Est. Future Revenue",v:estFutureRevenue,pct:100,c:"#3ddc8460",pos:true},
          ].map(({l,v,pct,c,pos})=>(
            <div key={l} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{l}</span>
                <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:pos?"#3ddc84":"#a7f3d0"}}>{K(v)}</span>
              </div>
              <div className="progress"><div className="progress-fill" style={{width:`${Math.min(100,isNaN(pct)?0:pct)}%`,background:c}}/></div>
            </div>
          ))}
          <div style={{borderTop:"1px solid #1a4d25",paddingTop:12,marginTop:4,display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>Expected Margin</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:20,color:totalMargin>20?"#3ddc84":totalMargin>0?"#3ddc84":"#ff6b4a"}}>{fmt(totalMargin)}%</span>
          </div>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0",marginBottom:4}}>Weighbridge Trading</div>
          <div style={{fontSize:10,color:"#7dff9e",marginBottom:12,fontFamily:"'DM Mono',monospace"}}>{transactions.length} transactions . KES arbitrage</div>
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
            <ResponsiveContainer width="100%" height={90} style={{marginBottom:12}}>
              <BarChart data={wbChartData} margin={{top:0,right:0,left:-24,bottom:0}}>
                <CartesianGrid stroke="#1a1800" strokeDasharray="3 0" vertical={false}/>
                <XAxis dataKey="date" tick={{fill:"#4a3e10",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:"#4a3e10",fontSize:8,fontFamily:"monospace"}} axisLine={false} tickLine={false}/>
                <Tooltip content={<ChartTooltip suffix=" t"/>}/>
                <Bar dataKey="tons" name="Tons" fill="#3ddc8480" radius={[2,2,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          )}
          <div style={{marginTop:12,paddingTop:12,borderTop:"1px dashed #1a4d25"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>M-PESA DISBURSEMENT STATUS</span>
              <span className="badge badge-gold" style={{fontSize:8}}>{fmt(payPct)}% Paid</span>
            </div>
            <div className="grid3">
              <div><span className="label">Disbursed (Paid)</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84"}}>{K(wbPaid)}</div></div>
              <div><span className="label">Pending Payout</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#ffa540"}}>{K(wbPending)}</div></div>
              <div><span className="label">Total Obligation</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#a7f3d0"}}>{K(wbSpend)}</div></div>
            </div>
            <div className="progress" style={{marginTop:8}}>
              <div className="progress-fill" style={{width:`${payPct}%`,background:"linear-gradient(90deg,#1b4d22,#3ddc84)"}}/>
            </div>
          </div>
        </div>

        {yieldAccuracy.length>0 && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:".06em",color:"#a7f3d0",marginBottom:14}}>Yield Accuracy</div>
            {yieldAccuracy.map(f=>(
              <div key={f.name} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:10,color:"#86efac",fontFamily:"'DM Mono',monospace"}}>{f.name}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{f.actual}t / {f.estimated}t</span>
                    <span className={`badge ${f.pct>=95?"badge-green":f.pct>=85?"badge-gold":"badge-red"}`}>{f.pct}%</span>
                  </div>
                </div>
                <div className="progress"><div className="progress-fill" style={{width:`${Math.min(100,f.pct)}%`,background:f.pct>=95?"#3ddc84":f.pct>=85?"#3ddc84":"#ff6b4a"}}/></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GPS AREA HELPERS ─────────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function perimeterMeters(pts) {
  if (pts.length < 2) return 0;
  let d = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    d += haversine(pts[i], pts[(i + 1) % n]);
  }
  return d;
}

// UTM Zone and Coordinates Conversion Helper
function latLngToUTM(lat, lng) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return "—";
  
  const zone = Math.floor((lng + 180) / 6) + 1;
  const latRad = lat * Math.PI / 180;
  const lngRad = lng * Math.PI / 180;
  const zcm = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  
  const a = 6378137; // WGS-84 equatorial radius
  const f = 1 / 298.257223563; // WGS-84 flattening
  const k0 = 0.9996; // UTM scale factor
  const e2 = 2 * f - f * f; // Eccentricity squared
  
  const n = f / (2 - f);
  const n2 = n * n;
  const n3 = n * n * n;
  const n4 = n * n * n * n;
  
  const A = (a / (1 + n)) * (1 + 1/4 * n2 + 1/64 * n4);
  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));
  const T = Math.tan(latRad) * Math.tan(latRad);
  const C = (e2 / (1 - e2)) * Math.cos(latRad) * Math.cos(latRad);
  const LA = lngRad - zcm;
  
  const M = a * ((1 - e2/4 - 3*e2*e2/64) * latRad - (3*e2/8 + 3*e2*e2/32) * Math.sin(2*latRad) + (15*e2*e2/256) * Math.sin(4*latRad));
  
  const E = k0 * N * (LA + (1 - T + C) * LA*LA*LA / 6 + (5 - 18*T + T*T + 72*C) * LA*LA*LA*LA*LA / 120);
  const Easting = 500000 + E;
  
  const N_val = k0 * (M + N * Math.tan(latRad) * (LA*LA / 2 + (5 - T + 9*C + 4*C*C) * LA*LA*LA*LA / 24 + (61 - 58*T + T*T + 600*C) * LA*LA*LA*LA*LA*LA / 720));
  const Northing = lat < 0 ? 10000000 + N_val : N_val;
  
  const hemisphere = lat >= 0 ? "N" : "S";
  return `Zone ${zone}${hemisphere} E: ${Math.round(Easting)} N: ${Math.round(Northing)}`;
}

// ─── DYNAMIC LOGISTICS & VALUATION HELPERS ───────────────────────────────────────
function calculateFieldLogistics(distanceKm, estimatedTons) {
  const dist = parseFloat(distanceKm) || 0;
  const tons = parseFloat(estimatedTons) || 0;

  // Harvesting: KES 350 per ton
  const harvestingRate = 350;
  const harvestingCost = tons * harvestingRate;

  // Transport: KES 950 per ton on Zone A (0 to 6 km), increases by KES 100 on subsequent zones (every 6 kms)
  // zoneIndex: 0 for Zone A (0-6), 1 for Zone B (6-12), 2 for Zone C (12-18), etc.
  const zoneIndex = dist > 0 ? Math.max(0, Math.ceil(dist / 6) - 1) : 0;
  const zoneLetter = String.fromCharCode(65 + zoneIndex); // A, B, C, D...
  const transportRate = 950 + (zoneIndex * 100);
  const transportCost = tons * transportRate;

  return {
    distance: dist,
    zone: `Zone ${zoneLetter}`,
    harvestingRate,
    harvestingCost,
    transportRate,
    transportCost,
    totalCost: harvestingCost + transportCost
  };
}

function getPolygonCentroid(polygon) {
  if (!polygon || polygon.length === 0) return null;
  let latSum = 0, lngSum = 0;
  polygon.forEach(p => {
    latSum += p.lat;
    lngSum += p.lng;
  });
  return { lat: latSum / polygon.length, lng: lngSum / polygon.length };
}

function getFieldDistanceToWeighbridge(fieldOrPolygon, distanceField) {
  // If there's an explicit manual override, use it
  if (distanceField != null && distanceField !== "" && !isNaN(distanceField)) {
    return parseFloat(distanceField);
  }
  
  // Otherwise, try to calculate from the polygon centroid
  const polygon = Array.isArray(fieldOrPolygon) ? fieldOrPolygon : (fieldOrPolygon?.polygon || []);
  if (polygon && polygon.length > 0) {
    const centroid = getPolygonCentroid(polygon);
    if (centroid) {
      const WEIGHBRIDGE_COORDS = { lat: 0.3541, lng: 34.5028 };
      const meters = haversine(centroid, WEIGHBRIDGE_COORDS);
      return +(meters / 1000).toFixed(2);
    }
  }
  
  return 5.0; // Default fallback distance (within Zone A)
}

// ─── PDF REPORT GENERATOR ─────────────────────────────────────────────────────────
function generateReportPDF({ fields, transactions, settings, title }) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const green = "#1b8a3d";
  const dark = "#222";
  const light = "#666";
  const pageW = 190;
  let y = 20;

  const header = () => {
    doc.setFontSize(22);
    doc.setTextColor(green);
    doc.text("AgriHub Field Command", pageW / 2, y, { align: "center" });
    y += 7;
    doc.setFontSize(9);
    doc.setTextColor(light);
    doc.text(`${title} — ${new Date().toLocaleDateString("en-KE", { year: "numeric", month: "long", day: "numeric" })}`, pageW / 2, y, { align: "center" });
    y += 5;
    doc.setDrawColor(green);
    doc.setLineWidth(0.5);
    doc.line(10, y, 200, y);
    y += 8;
  };
  header();

  const totalAcres = fields.reduce((s, f) => s + (f.area_acres || 0), 0);
  const harvested = fields.filter(f => f.harvest?.actual_tonnage);
  const totalEst = fields.reduce((s, f) => s + (f.estimated_total_tons || 0), 0);
  const totalAct = harvested.reduce((s, f) => s + f.harvest.actual_tonnage, 0);
  const acqCost = fields.reduce((s, f) => s + (f.area_acres || 0) * (f.buying_price_per_acre || settings.cost_per_acre), 0);
  const harvCost = harvested.reduce((s, f) => s + (f.harvest.harvest_cost || 0), 0);
  const transCost = harvested.reduce((s, f) => s + (f.harvest.transport_cost || 0), 0);
  const otherCost = harvested.reduce((s, f) => s + (f.harvest.other_cost || 0), 0);
  const totalCost = acqCost + harvCost + transCost + otherCost;
  const actRevenue = harvested.reduce((s, f) => s + f.harvest.actual_tonnage * (f.harvest.selling_price || settings.company_rate), 0);
  const estFuture = fields.filter(f => !f.harvest?.actual_tonnage).reduce((s, f) => s + (f.estimated_total_tons || 0) * settings.company_rate, 0);
  const wbProfit = transactions.reduce((s, t) => s + (t.gross_profit || 0), 0);
  const totalReturn = actRevenue + estFuture;
  const margin = totalReturn > 0 ? ((totalReturn - totalCost) / totalReturn * 100) : 0;

  // Season Overview Table
  doc.setFontSize(13);
  doc.setTextColor(green);
  doc.text("Season Overview", 10, y);
  y += 6;
  autoTable(doc, {
    startY: y,
    head: [["Metric", "Value"]],
    body: [
      ["Total Fields", String(fields.length)],
      ["Harvested", String(harvested.length)],
      ["Total Acres", totalAcres.toFixed(2)],
      ["Est. Tons", totalEst.toFixed(1)],
      ["Actual Tons", totalAct.toFixed(1)],
      ["Yield Accuracy", totalEst > 0 ? (totalAct / totalEst * 100).toFixed(1) + "%" : "-"],
    ],
    theme: "grid",
    headStyles: { fillColor: green, textColor: "#fff", fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: dark },
    alternateRowStyles: { fillColor: "#f0f7f0" },
    styles: { cellPadding: 2.5 },
    margin: { left: 10, right: 10 },
  });
  y = doc.lastAutoTable.finalY + 10;

  // P&L Summary Table
  doc.setFontSize(13);
  doc.setTextColor(green);
  doc.text("Profit & Loss Summary", 10, y);
  y += 6;
  const fmtK = (n) => {
    if (n == null) return "-";
    const abs = Math.abs(n);
    return (abs >= 1e6 ? "KES " + (abs / 1e6).toFixed(2) + "M" : "KES " + (abs / 1e3).toFixed(1) + "K");
  };
  autoTable(doc, {
    startY: y,
    head: [["Item", "Amount"]],
    body: [
      ["Field Acquisition Cost", fmtK(acqCost)],
      ["Harvesting Cost", fmtK(harvCost)],
      ["Transportation Cost", fmtK(transCost)],
      ["Other Logistics", fmtK(otherCost)],
      ["Total Expenses", fmtK(totalCost)],
      ["Realized Revenue", fmtK(actRevenue)],
      ["Est. Future Revenue", fmtK(estFuture)],
      ["Weighbridge Trading Profit", fmtK(wbProfit)],
      ["Expected Margin", margin.toFixed(1) + "%"],
    ],
    theme: "grid",
    headStyles: { fillColor: green, textColor: "#fff", fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: dark },
    alternateRowStyles: { fillColor: "#f0f7f0" },
    styles: { cellPadding: 2.5 },
    margin: { left: 10, right: 10 },
  });
  y = doc.lastAutoTable.finalY + 10;

  // Fields List
  doc.setFontSize(13);
  doc.setTextColor(green);
  doc.text("Field Register", 10, y);
  y += 6;
  autoTable(doc, {
    startY: y,
    head: [["Field", "Acres", "Est. Tons", "Actual", "Status"]],
    body: fields.map(f => [
      f.name,
      (f.area_acres || 0).toFixed(1),
      (f.estimated_total_tons || 0).toFixed(1),
      f.harvest?.actual_tonnage ? f.harvest.actual_tonnage.toFixed(1) : "-",
      f.harvest?.actual_tonnage ? "Harvested" : "Pending",
    ]),
    theme: "grid",
    headStyles: { fillColor: green, textColor: "#fff", fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 8, textColor: dark },
    alternateRowStyles: { fillColor: "#f0f7f0" },
    styles: { cellPadding: 2 },
    margin: { left: 10, right: 10 },
  });
  y = doc.lastAutoTable.finalY + 10;

  // Top Farmers
  const farmerMap = {};
  transactions.forEach(t => {
    if (!farmerMap[t.farmer_name]) farmerMap[t.farmer_name] = { name: t.farmer_name, tons: 0, profit: 0, loads: 0 };
    farmerMap[t.farmer_name].tons += t.tons;
    farmerMap[t.farmer_name].profit += t.gross_profit;
    farmerMap[t.farmer_name].loads++;
  });
  const farmers = Object.values(farmerMap).sort((a, b) => b.tons - a.tons).slice(0, 10);
  if (farmers.length > 0) {
    if (y > 240) { doc.addPage(); y = 20; header(); }
    doc.setFontSize(13);
    doc.setTextColor(green);
    doc.text("Top Farmers", 10, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      head: [["#", "Farmer", "Loads", "Tons", "Profit"]],
      body: farmers.map((f, i) => [String(i + 1), f.name, String(f.loads), f.tons.toFixed(1), fmtK(f.profit)]),
      theme: "grid",
      headStyles: { fillColor: green, textColor: "#fff", fontStyle: "bold", fontSize: 9 },
      bodyStyles: { fontSize: 9, textColor: dark },
      alternateRowStyles: { fillColor: "#f0f7f0" },
      styles: { cellPadding: 2.5 },
      margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // Transactions Summary
  if (transactions.length > 0) {
    if (y > 240) { doc.addPage(); y = 20; header(); }
    doc.setFontSize(13);
    doc.setTextColor(green);
    doc.text("Recent Transactions", 10, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Farmer", "Tons", "Buy Price", "Total Cost", "Profit"]],
      body: transactions.slice(0, 20).map(t => [
        t.date || "-",
        t.farmer_name,
        t.tons.toFixed(1),
        "KES " + (t.buy_price || 0).toLocaleString(),
        fmtK(t.total_cost),
        fmtK(t.gross_profit),
      ]),
      theme: "grid",
      headStyles: { fillColor: green, textColor: "#fff", fontStyle: "bold", fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: dark },
      alternateRowStyles: { fillColor: "#f0f7f0" },
      styles: { cellPadding: 2 },
      margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 10;
// ─── M-PESA PAYMENT MODAL ─────────────────────────────────────────────────────
  }

  doc.save(`${title.replace(/\s+/g, "-").toLowerCase()}.pdf`);
}
function MPesaPaymentModal({ transaction, onClose, onPaymentComplete }) {
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState(transaction?.total_cost || 0);
  const [step, setStep] = useState("form");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef(null);

  const validatePhone = (p) => /^(254|0)[17]\d{8}$/.test(p);
  const formatPhone = (p) => p.startsWith("0") ? "254" + p.slice(1) : p;
  const maskedPhone = (p) => { const f = formatPhone(p); return f.slice(0, 5) + "****" + f.slice(-3); };

  // Auto-poll backend status every 3s after STK push sent
  const startPolling = (transactionId) => {
    let count = 0;
    pollRef.current = setInterval(async () => {
      count++;
      setPollCount(count);
      try {
        const status = await api.mpesaStatus(transactionId);
        if (status.payment_status === "completed") {
          clearInterval(pollRef.current);
          setReceipt(status.payment_reference);
          await onPaymentComplete({ transaction_id: transactionId });
          setStep("success");
        } else if (status.payment_status === "failed") {
          clearInterval(pollRef.current);
          setStep("failed");
        }
        // If still "pending", keep polling until 40s timeout (≈13 polls)
        if (count >= 13) {
          clearInterval(pollRef.current);
          // Don't auto-fail — let user decide
        }
      } catch (err) {
        console.warn("Poll error:", err);
      }
    }, 3000);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const initiatePayment = async () => {
    if (!validatePhone(phone)) { setError("Enter a valid M-Pesa number (e.g. 2547XXXXXXXX or 07XXXXXXXX)"); return; }
    if (amount <= 0) { setError("Amount must be greater than 0"); return; }
    setError("");
    setStep("sending");
    try {
      await api.stkPush(transaction.id, phone, amount);
      setStep("waiting");
      startPolling(transaction.id);
    } catch (e) {
      setError(e.message);
      setStep("form");
    }
  };

  const manualConfirm = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setStep("sending");
    try {
      await api.mpesaConfirm(transaction.id, true);
      await onPaymentComplete({ transaction_id: transaction.id });
      setStep("success");
    } catch (err) {
      console.error("Payment confirmation failed", err);
      setStep("failed");
    }
  };

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(4,7,5,0.95)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#0d1a10", border: "1px solid #3ddc8440", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400 }}>
        {step === "form" && (
          <div className="fade">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#3ddc84", letterSpacing: ".04em" }}>M-PESA Payment</div>
                <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono',monospace", marginTop: 2 }}>Safaricom STK Push · Live Daraja API</div>
              </div>
              <button onClick={onClose} style={{ background: "none", border: "1px solid #1a4d25", color: "#86efac", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace" }}>Close</button>
            </div>
            {transaction && (
              <div style={{ background: "#0a140a", borderRadius: 8, padding: 12, marginBottom: 14, border: "1px solid #1a4d25" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "#86efac" }}>Farmer</span>
                  <span style={{ fontSize: 10, color: "#a7f3d0" }}>{transaction.farmer_name}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 10, color: "#86efac" }}>Tons / Ticket</span>
                  <span style={{ fontSize: 10, color: "#a7f3d0" }}>{transaction.tons}t / #{transaction.ticket_number}</span>
                </div>
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label className="label">M-Pesa Phone Number</label>
              <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="e.g. 254712345678" style={{ marginTop: 4 }} />
              <div style={{ fontSize: 8, color: "#7dff9e", marginTop: 4 }}>Enter farmer's M-Pesa registered number (2547XXXXXXXX or 07XXXXXXXX)</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="label">Amount (KES)</label>
              <input type="number" value={amount} onChange={e => setAmount(+e.target.value)} style={{ marginTop: 4 }} />
            </div>
            {error && <div style={{ background: "#ff6b4a12", border: "1px solid #ff6b4a30", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 10, color: "#ff8060", fontFamily: "'DM Mono',monospace" }}>{error}</div>}
            <button className="btn-gold" onClick={initiatePayment} style={{ width: "100%", padding: 13, fontSize: 13 }}>
              💳 Send KES {amount.toLocaleString()} via M-Pesa
            </button>
          </div>
        )}

        {step === "sending" && (
          <div style={{ textAlign: "center", padding: 32 }} className="fade">
            <div style={{ fontSize: 40, marginBottom: 12 }} className="blink">📱</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#3ddc84", marginBottom: 8 }}>SENDING STK PUSH</div>
            <div style={{ fontSize: 10, color: "#86efac", fontFamily: "'DM Mono',monospace" }}>Contacting Safaricom Daraja API...</div>
            <div style={{ width: 120, height: 2, background: "#0d1a10", margin: "16px auto", position: "relative", overflow: "hidden", borderRadius: 1 }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: "40%", background: "#3ddc84", animation: "progress-move 1.2s infinite ease-in-out" }} />
            </div>
          </div>
        )}

        {step === "waiting" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 42, marginBottom: 8 }} className="blink">💳</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#3ddc84", marginBottom: 6, letterSpacing: ".04em" }}>
              CHECK YOUR PHONE
            </div>
            <div style={{ background: "#0a140a", borderRadius: 8, padding: 12, marginBottom: 14, border: "1px solid #1a4d25", fontSize: 10, color: "#a7f3d0", fontFamily: "'DM Mono',monospace", lineHeight: 1.6, textAlign: "left" }}>
              M-Pesa STK Push sent to <strong style={{color:"#3ddc84"}}>{phone ? maskedPhone(phone) : "the farmer"}</strong>
              <br/>
              KES <strong style={{color:"#3ddc84"}}>{amount.toLocaleString()}</strong>
              <br/><br/>
              1. Check the M-Pesa prompt on the phone
              <br/>
              2. Enter your M-Pesa PIN to authorize
              <br/>
              3. This screen will update automatically ✓
            </div>
            {/* Auto-poll progress indicator */}
            <div style={{ background: "#0a140a", borderRadius: 8, padding: "8px 12px", marginBottom: 14, border: "1px solid #1a4d25", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3ddc84", animation: "pulse 1.5s infinite" }} />
              <span style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono',monospace" }}>
                Awaiting M-Pesa confirmation... (poll {pollCount}/13)
              </span>
            </div>
            <button className="btn-ghost" onClick={manualConfirm} style={{ width: "100%", fontSize: 11, marginBottom: 6 }}>
              ✓ Mark as Confirmed Manually
            </button>
            <button className="btn-ghost" onClick={() => { if (pollRef.current) clearInterval(pollRef.current); setStep("form"); }} style={{ width: "100%", fontSize: 11 }}>
              ← Back to Payment Form
            </button>
          </div>
        )}

        {step === "success" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#3ddc84", marginBottom: 4 }}>PAYMENT SUCCESSFUL</div>
            <div style={{ fontSize: 10, color: "#86efac", fontFamily: "'DM Mono',monospace", marginBottom: 12 }}>
              KES {amount.toLocaleString()} sent to {transaction?.farmer_name}
            </div>
            <div style={{ background: "#0a140a", borderRadius: 8, padding: 12, border: "1px solid #1a4d25", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 9, color: "#86efac" }}>M-Pesa Ref:</span>
                <span style={{ fontSize: 9, color: "#3ddc84", fontWeight: "bold" }}>{receipt || "MP" + Date.now().toString(36).toUpperCase()}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9, color: "#86efac" }}>Phone:</span>
                <span style={{ fontSize: 9, color: "#a7f3d0" }}>{phone ? maskedPhone(phone) : "-"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ fontSize: 9, color: "#86efac" }}>Status:</span>
                <span style={{ fontSize: 9, color: "#3ddc84" }}>Completed · Daraja API</span>
              </div>
            </div>
            <button className="btn-gold" onClick={onClose} style={{ width: "100%", fontSize: 12, padding: "10px" }}>Close</button>
          </div>
        )}

        {step === "failed" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 48, marginBottom: 8 }}>❌</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#ff6b4a", marginBottom: 4 }}>PAYMENT FAILED</div>
            <div style={{ fontSize: 10, color: "#ff8060", fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>
              Transaction declined or timed out.
            </div>
            <div style={{ background: "#ff6b4a10", borderRadius: 8, padding: 10, marginBottom: 16, border: "1px solid #ff6b4a20", fontSize: 9, color: "#ffa080", fontFamily: "'DM Mono',monospace" }}>
              Common reasons: wrong number, insufficient M-Pesa balance, wrong PIN, or network error.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-gold" onClick={() => setStep("form")} style={{ flex: 1, fontSize: 11 }}>Try Again</button>
              <button className="btn-ghost" onClick={onClose} style={{ flex: 1, fontSize: 11 }}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ANALYSIS UNLOCK MODAL ─────────────────────────────────────────────────────
function AnalysisUnlockModal({ field, onClose, onUnlockComplete }) {
  const [phone, setPhone] = useState("");
  const [priceInfo, setPriceInfo] = useState(null);
  const [step, setStep] = useState("loading");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [unlockId, setUnlockId] = useState(null);
  const pollRef = useRef(null);

  const validatePhone = (p) => /^(254|0)[17]\d{8}$/.test(p);
  const formatPhone = (p) => p.startsWith("0") ? "254" + p.slice(1) : p;
  const maskedPhone = (p) => { const f = formatPhone(p); return f.slice(0, 5) + "****" + f.slice(-3); };

  useEffect(() => {
    api.analysis.getUnlockPrice(field.id)
      .then(res => {
        if (res.alreadyUnlocked) {
          onUnlockComplete();
        } else {
          setPriceInfo(res);
          setStep("form");
        }
      })
      .catch(err => {
        setError(err.message);
        setStep("failed");
      });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [field.id, onUnlockComplete]);

  const startPolling = (uid) => {
    let count = 0;
    pollRef.current = setInterval(async () => {
      count++;
      setPollCount(count);
      try {
        const status = await api.analysis.checkUnlockStatus(uid);
        if (status.status === "completed") {
          clearInterval(pollRef.current);
          setReceipt(status.mpesaReceipt);
          await onUnlockComplete();
          setStep("success");
        } else if (status.status === "failed") {
          clearInterval(pollRef.current);
          setStep("failed");
        }
        if (count >= 13) {
          clearInterval(pollRef.current);
        }
      } catch (err) {
        console.warn("Poll error:", err);
      }
    }, 3000);
  };

  const initiatePayment = async () => {
    if (!validatePhone(phone)) { setError("Enter a valid M-Pesa number"); return; }
    setError("");
    setStep("sending");
    try {
      const res = await api.analysis.requestUnlock(field.id, phone);
      if (res.status === "pending" || res.simulated) {
        setUnlockId(res.unlockId);
        setStep("waiting");
        startPolling(res.unlockId);
      } else {
        throw new Error(res.message || "Failed to initiate payment");
      }
    } catch (e) {
      setError(e.message);
      setStep("form");
    }
  };

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(4,7,5,0.95)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#0d1a10", border: "1px solid #eab30840", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400 }}>
        {step === "loading" && (
          <div style={{ textAlign: "center", padding: 32, color: "#eab308", fontFamily: "'DM Mono',monospace" }}>
            Loading price info...
          </div>
        )}
        
        {step === "form" && (
          <div className="fade">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#eab308", letterSpacing: ".04em" }}>Unlock Field Analysis</div>
                <div style={{ fontSize: 9, color: "#fef08a", fontFamily: "'DM Mono',monospace", marginTop: 2 }}>M-Pesa STK Push Payment</div>
              </div>
              <button onClick={onClose} style={{ background: "none", border: "1px solid #713f12", color: "#fef08a", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace" }}>Cancel</button>
            </div>
            
            <div style={{ background: "#1a1608", borderRadius: 8, padding: 12, marginBottom: 14, border: "1px solid #713f12" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#fef08a" }}>Field</span>
                <span style={{ fontSize: 10, color: "#eab308", fontWeight: "bold" }}>{field.name}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, color: "#fef08a" }}>Unlock Fee</span>
                <span style={{ fontSize: 10, color: "#eab308", fontWeight: "bold" }}>KES {priceInfo?.price}</span>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className="label">Your M-Pesa Phone Number</label>
              <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="e.g. 254712345678" style={{ marginTop: 4, borderColor: "#eab30840" }} />
              <div style={{ fontSize: 8, color: "#fef08a", marginTop: 4 }}>Enter number to pay from (2547XXXXXXXX)</div>
            </div>
            
            {error && <div style={{ background: "#ff6b4a12", border: "1px solid #ff6b4a30", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 10, color: "#ff8060", fontFamily: "'DM Mono',monospace" }}>{error}</div>}
            
            <button className="btn-gold" onClick={initiatePayment} style={{ width: "100%", padding: 13, fontSize: 13 }}>
              💳 Pay KES {priceInfo?.price} to Unlock
            </button>
          </div>
        )}

        {step === "sending" && (
          <div style={{ textAlign: "center", padding: 32 }} className="fade">
            <div style={{ fontSize: 40, marginBottom: 12 }} className="blink">📱</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#eab308", marginBottom: 8 }}>SENDING STK PUSH</div>
            <div style={{ fontSize: 10, color: "#fef08a", fontFamily: "'DM Mono',monospace" }}>Please wait...</div>
          </div>
        )}

        {step === "waiting" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 42, marginBottom: 8 }} className="blink">💳</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#eab308", marginBottom: 6 }}>CHECK YOUR PHONE</div>
            <div style={{ background: "#1a1608", borderRadius: 8, padding: 12, marginBottom: 14, border: "1px solid #713f12", fontSize: 10, color: "#fef08a", textAlign: "left" }}>
              M-Pesa prompt sent to <strong style={{color:"#eab308"}}>{phone ? maskedPhone(phone) : "your phone"}</strong><br/><br/>
              1. Enter your M-Pesa PIN<br/>
              2. Waiting for confirmation... (poll {pollCount}/13)
            </div>
            <button className="btn-ghost" onClick={() => { if (pollRef.current) clearInterval(pollRef.current); setStep("form"); }} style={{ width: "100%", fontSize: 11 }}>
              ← Cancel
            </button>
          </div>
        )}

        {step === "success" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#3ddc84", marginBottom: 4 }}>ANALYSIS UNLOCKED</div>
            <div style={{ fontSize: 10, color: "#86efac", fontFamily: "'DM Mono',monospace", marginBottom: 12 }}>
              Payment of KES {priceInfo?.price} received. Ref: {receipt}
            </div>
            <button className="btn-gold" onClick={onClose} style={{ width: "100%", fontSize: 12, padding: "10px" }}>View Field Analysis</button>
          </div>
        )}

        {step === "failed" && (
          <div style={{ textAlign: "center", padding: 24 }} className="fade">
            <div style={{ fontSize: 48, marginBottom: 8 }}>❌</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#ff6b4a", marginBottom: 4 }}>PAYMENT FAILED</div>
            <div style={{ fontSize: 10, color: "#ff8060", fontFamily: "'DM Mono',monospace", marginBottom: 8 }}>
              {error || "Transaction declined or timed out."}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-gold" onClick={() => setStep("form")} style={{ flex: 1, fontSize: 11 }}>Try Again</button>
              <button className="btn-ghost" onClick={onClose} style={{ flex: 1, fontSize: 11 }}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldMapper({ onConfirm, onCancel, initialPts=[], existingFields=[], currentFieldId=null }) {
  const [pts, setPts] = useState(() => {
    return initialPts.map((p, idx) => ({
      lat: p.lat,
      lng: p.lng,
      label: p.label || "Boundary Pin",
      note: p.note || ""
    }));
  });
  const [mapReady, setMapReady] = useState(false);
  const [gpsStatus, setGpsStatus] = useState("");
  const [mapCenter, setMapCenter] = useState({ lat: 0.37, lng: 35.12 }); // Kenya default
  const [displayUnit, setDisplayUnit] = useState("acres"); // acres | hectares | sqmeters
  const [exportFormat, setExportFormat] = useState(null); // 'geojson' | 'kml' | null
  const [walkMode, setWalkMode] = useState(false);
  const [walkPaused, setWalkPaused] = useState(false);
  const walkPausedRef = useRef(false);
  const [walkPath, setWalkPath] = useState([]);
  const [walkAccuracy, setWalkAccuracy] = useState(null);
  const [walkInterval, setWalkInterval] = useState(5);
  const walkWatcherRef = useRef(null);
  const lastWalkPosRef = useRef(null);
  const iframeRef = useRef(null);

  const acres = calculateGeodesicArea(pts);
  const perim = perimeterMeters(pts);

  const validation = useMemo(() => validatePolygon(pts), [pts]);
  const confidence = useMemo(() => calculateSurveyConfidence(pts, 12.0), [pts]);

  // Conversion calculations
  const areaDisplay = useMemo(() => {
    if (displayUnit === "hectares") return (acres * 0.404686).toFixed(2) + " ha";
    if (displayUnit === "sqmeters") return (acres * 4046.86).toLocaleString(undefined, {maximumFractionDigits: 0}) + " m²";
    return acres.toFixed(2) + " ac";
  }, [acres, displayUnit]);

  const perimeterDisplay = useMemo(() => {
    if (perim >= 1000) return (perim / 1000).toFixed(2) + " km";
    return Math.round(perim) + " m";
  }, [perim]);

  // Build the self-contained Leaflet HTML with Layer Control Map Styles
  const buildMapHTML = (center, existingPts) => {
    const ptsJson = JSON.stringify(existingPts);
    const otherFields = JSON.stringify(existingFields.filter(f => f.id !== currentFieldId));
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body,#map{width:100%;height:100%;background:#0a0800;}
  .leaflet-container{background:#111;}
  .pin-marker{width:28px;height:38px;position:relative;cursor:grab;}
  .pin-body{width:28px;height:28px;background:#e83030;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.5);}
  .pin-dot{position:absolute;top:7px;left:7px;width:10px;height:10px;background:#fff;border-radius:50%;transform:rotate(45deg);}
  .first-pin .pin-body{background:#3ddc84;border-color:#fff;}
  #stats{position:fixed;top:8px;left:8px;background:rgba(61,220,132,0.95);color:#0a150e;padding:8px 14px;border-radius:8px;font-family:monospace;font-size:13px;font-weight:700;display:none;z-index:1000;line-height:1.6;box-shadow:0 2px 8px rgba(0,0,0,0.5);}
  #hint{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#3ddc84;padding:7px 16px;border-radius:20px;font-family:monospace;font-size:11px;white-space:nowrap;z-index:1000;pointer-events:none;}
  #gps-btn{position:fixed;bottom:50px;right:10px;background:#3ddc84;color:#0a150e;border:none;border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.4);}
  #undo-btn{position:fixed;bottom:100px;right:10px;background:#1a1a1a;color:#3ddc84;border:1px solid #3ddc8455;border-radius:50%;width:44px;height:44px;font-size:14px;cursor:pointer;z-index:1000;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4);}
  .leaflet-control-layers{background:#0d1a10 !important;color:#a7f3d0 !important;border:1px solid #1a4d25 !important;border-radius:8px;font-family:monospace;padding:6px;}
</style>
</head><body>
<div id="map"></div>
<div id="stats"></div>
<div id="hint">Tap map to drop boundary pins</div>
<button id="gps-btn" title="My location">◎</button>
<button id="undo-btn" title="Undo last">↩</button>
<script>
var pts = ${ptsJson};
var otherFields = ${otherFields};
var markers = [];
var polygon = null;
var edgeLabels = [];
var walkPathLayer = null;
var walkPathData = [];

// Snapping logic
function findSnapPoint(latlng) {
  var snapRadiusMeters = 8; // 8 meters snapping distance
  var closestPt = null;
  var minDistance = Infinity;

  otherFields.forEach(function(f) {
    if (!f.polygon) return;
    f.polygon.forEach(function(p) {
      var d = haversine(latlng, p);
      if (d < snapRadiusMeters && d < minDistance) {
        minDistance = d;
        closestPt = p;
      }
    });
  });

  return closestPt ? {lat: closestPt.lat, lng: closestPt.lng} : latlng;
}

var map = L.map('map', {
  center: [${center.lat}, ${center.lng}],
  zoom: 17,
  zoomControl: true,
  attributionControl: false,
});

// Satellite Layer
var satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 20, attribution: 'ESRI Satellite'
});

// Outdoors Layer
var outdoors = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: 'OSM Outdoors'
});

// Terrain Layer
var terrain = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17, attribution: 'Topo Terrain'
});

var baseLayers = {
  "Satellite Map": satellite,
  "Standard Map": outdoors,
  "Terrain Topo": terrain
};

satellite.addTo(map);
L.control.layers(baseLayers).addTo(map);

// Thin label overlay to overlay streets on top of satellite
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, opacity: 0.7
}).addTo(map);

// Draw neighbors with grey dashed boundaries for context snapping
otherFields.forEach(function(f) {
  if (f.polygon && f.polygon.length >= 3) {
    var lls = f.polygon.map(function(p){return [p.lat,p.lng];});
    L.polygon(lls, {color:'#a7f3d0',weight:1.5,dashArray:'4,4',fillColor:'#a7f3d0',fillOpacity:0.05,interactive:false}).addTo(map);
  }
});

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
function geodesicArea(coords) {
  if (!coords || coords.length < 3) return 0;
  var points = JSON.parse(JSON.stringify(coords));
  if (points[0].lat !== points[points.length - 1].lat || points[0].lng !== points[points.length - 1].lng) {
    points.push(points[0]);
  }
  var totalArea = 0, len = points.length;
  for (var i = 0; i < len - 1; i++) {
    var x1 = points[i].lng * Math.PI / 180;
    var y1 = points[i].lat * Math.PI / 180;
    var x2 = points[i + 1].lng * Math.PI / 180;
    var y2 = points[i + 1].lat * Math.PI / 180;
    totalArea += (x2 - x1) * (2 + Math.sin(y1) + Math.sin(y2));
  }
  var authalicRadiusSq = 6378137.0 * 6356752.3142;
  var areaMeters = Math.abs(totalArea * authalicRadiusSq / 2);
  return areaMeters / 4046.8564224;
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
  markers.forEach(function(m){map.removeLayer(m);});
  markers=[];
  clearEdgeLabels();
  if (polygon) { map.removeLayer(polygon); polygon=null; }

  pts.forEach(function(p,i){
    var m = L.marker([p.lat,p.lng], {icon:makePinIcon(i===0), draggable:true});
    m.on('dragend', function(e){
      var ll=e.target.getLatLng();
      var snapped = findSnapPoint(ll);
      pts[i]={lat:+snapped.lat.toFixed(6),lng:+snapped.lng.toFixed(6)};
      redraw(); sendPts();
    });
    m.addTo(map);
    markers.push(m);
  });

  if (pts.length>=2) {
    for (var i=0;i<pts.length;i++){
      var a=pts[i], b=pts[(i+1)%pts.length];
      if (pts.length<3 && i===pts.length-1) break;
      var dist=haversine(a,b);
      var label=dist>=1000?(dist/1000).toFixed(2)+'km':Math.round(dist)+'m';
      var midLat=(a.lat+b.lat)/2, midLng=(a.lng+b.lng)/2;
      var el=L.divIcon({className:'',html:'<div style="background:rgba(61,220,132,0.9);color:#0a150e;padding:2px 7px;border-radius:4px;font-size:11px;font-family:monospace;font-weight:700;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.3)">'+label+'</div>',iconAnchor:[20,10]});
      edgeLabels.push(L.marker([midLat,midLng],{icon:el,interactive:false}).addTo(map));
    }
  }

  if (pts.length>=3) {
    var lls=pts.map(function(p){return [p.lat,p.lng];});
    polygon=L.polygon(lls, {color:'#3ddc84',weight:2.5,fillColor:'#3ddc84',fillOpacity:0.2}).addTo(map);
    var ac=geodesicArea(pts), perim=perimeterMeters(pts);
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
  var snapped = findSnapPoint(e.latlng);
  pts.push({lat:+snapped.lat.toFixed(6),lng:+snapped.lng.toFixed(6)});
  redraw(); sendPts();
});

document.getElementById('undo-btn').onclick=function(){
  pts.pop(); redraw(); sendPts();
};

document.getElementById('gps-btn').onclick=function(){
  window.parent.postMessage({type:'GPS_REQUEST'},'*');
};

function sendPts(){
  window.parent.postMessage({type:'MAP_PTS',pts:pts},'*');
}

window.addEventListener('message',function(e){
  if (!e.data) return;
  if (e.data.type==='CLEAR'){pts=[];redraw();sendPts();}
  if (e.data.type==='GOTO'){map.setView([e.data.lat,e.data.lng],18);}
  if (e.data.type==='ADD_PT' && e.data.lat && e.data.lng){
    pts.push({lat:e.data.lat,lng:e.data.lng});
    redraw(); sendPts();
  }
  if (e.data.type==='INIT_PTS' && e.data.pts && e.data.pts.length>0){
    pts=e.data.pts;
    redraw();
    var lats=pts.map(function(p){return p.lat;}), lngs=pts.map(function(p){return p.lng;});
    map.fitBounds([[Math.min.apply(null,lats),Math.min.apply(null,lngs)],[Math.max.apply(null,lats),Math.max.apply(null,lngs)]],{padding:[40,40]});
  }
  if (e.data.type==='WALK_PATH' && e.data.path){
    walkPathData = e.data.path;
    if (walkPathLayer) map.removeLayer(walkPathLayer);
    if (walkPathData.length>1){
      var ll=walkPathData.map(function(p){return [p.lat,p.lng];});
      walkPathLayer=L.polyline(ll,{color:'#ffa540',weight:3,opacity:0.6,dashArray:'8,6'}).addTo(map);
    }
  }
  if (e.data.type==='CLOSE_POLYGON' && pts.length>=2){
    var first=pts[0];
    pts.push({lat:first.lat,lng:first.lng});
    redraw(); sendPts();
  }
});

redraw();
if (pts.length>0){
  var lats=pts.map(function(p){return p.lat;}), lngs=pts.map(function(p){return p.lng;});
  map.fitBounds([[Math.min.apply(null,lats),Math.min.apply(null,lngs)],[Math.max.apply(null,lats),Math.max.apply(null,lngs)]],{padding:[40,40]});
}
</script>
</body></html>`;
  };

  // Listen for coordinates and GPS requests from the Map iframe
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'MAP_PTS') {
        setPts(currentPts => {
          return e.data.pts.map((newPt, idx) => {
            const currentPt = currentPts[idx] || {};
            return {
              lat: newPt.lat,
              lng: newPt.lng,
              label: currentPt.label || "Boundary Pin",
              note: currentPt.note || ""
            };
          });
        });
      }
      if (e.data?.type === 'GPS_REQUEST') {
        setGpsStatus("Looking up GPS location...");
        const setPin = (la, lo) => {
          iframeRef.current?.contentWindow?.postMessage({ type: 'GOTO', lat: la, lng: lo }, '*');
          iframeRef.current?.contentWindow?.postMessage({ type: 'ADD_PT', lat: la, lng: lo }, '*');
          setGpsStatus(`Pin at ${la.toFixed(4)}, ${lo.toFixed(4)}`);
          setTimeout(() => setGpsStatus(""), 3000);
        };
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            pos => {
              const la = +pos.coords.latitude.toFixed(6);
              const lo = +pos.coords.longitude.toFixed(6);
              setPin(la, lo);
            },
            err => {
              console.warn("GPS error, trying IP fallback:", err);
              tryIPFallback();
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
          );
        } else {
          tryIPFallback();
        }

        function tryIPFallback() {
          fetch('https://ipapi.co/json/')
            .then(r => r.json())
            .then(d => { if (d.latitude && d.longitude) setPin(d.latitude, d.longitude); else ipFail(); })
            .catch(ipFail);
        }
        function ipFail() {
          fetch('https://ipinfo.io/json')
            .then(r => r.json())
            .then(d => { if (d.loc) { const [la, lo] = d.loc.split(','); setPin(+la, +lo); } else setGpsStatus("Could not determine location. Pin manually on the map."); })
            .catch(() => setGpsStatus("Could not determine location. Pin manually on the map."));
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Try to center map on start via live GPS, fallback to IP geolocation
  useEffect(() => {
    if (initialPts.length > 0) return;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          setMapCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          fetch('https://ipapi.co/json/')
            .then(r => r.json())
            .then(d => { if (d.latitude && d.longitude) setMapCenter({ lat: d.latitude, lng: d.longitude }); })
            .catch(() => {});
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    } else {
      fetch('https://ipapi.co/json/')
        .then(r => r.json())
        .then(d => { if (d.latitude && d.longitude) setMapCenter({ lat: d.latitude, lng: d.longitude }); })
        .catch(() => {});
    }
  }, []);

  const mapHTML = buildMapHTML(mapCenter, initialPts);
  const blobUrl = useMemo(() => {
    const blob = new Blob([mapHTML], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [mapCenter.lat, mapCenter.lng, initialPts.length]);

  const sendToMap = (msg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  };

  const grabGPS = () => {
    setGpsStatus("Looking up GPS location...");
    const center = (la, lo) => {
      sendToMap({ type: 'GOTO', lat: la, lng: lo });
      setGpsStatus(`Centered: ${la.toFixed(4)}, ${lo.toFixed(4)}`);
      setTimeout(() => setGpsStatus(""), 3000);
    };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const la = +pos.coords.latitude.toFixed(6);
          const lo = +pos.coords.longitude.toFixed(6);
          center(la, lo);
        },
        err => {
          console.warn("GPS error, trying IP fallback:", err);
          tryIPFallback();
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } else {
      tryIPFallback();
    }

    function tryIPFallback() {
      fetch('https://ipapi.co/json/')
        .then(r => r.json())
        .then(d => { if (d.latitude && d.longitude) center(d.latitude, d.longitude); else ipFail(); })
        .catch(ipFail);
    }
    function ipFail() {
      fetch('https://ipinfo.io/json')
        .then(r => r.json())
        .then(d => { if (d.loc) { const [la, lo] = d.loc.split(','); center(+la, +lo); } else setGpsStatus("Could not determine location."); })
        .catch(() => setGpsStatus("Could not determine location."));
    }
  };

  // Walk/Tracking using watchPosition (continuous, distance-filtered)
  const toggleWalkMode = () => {
    if (walkMode) {
      if (walkWatcherRef.current) {
        navigator.geolocation.clearWatch(walkWatcherRef.current);
        walkWatcherRef.current = null;
      }
      lastWalkPosRef.current = null;
      setWalkMode(false);
      setWalkPaused(false);
      walkPausedRef.current = false;
      setWalkAccuracy(null);
      setGpsStatus(`Walk stopped. ${pts.length} boundary points.`);
      setTimeout(() => setGpsStatus(""), 3000);
    } else {
      if (!navigator.geolocation) { alert("GPS not available on this device."); return; }
      setWalkPath([]);
      setWalkMode(true);
      setWalkPaused(false);
      walkPausedRef.current = false;
      setGpsStatus("Starting GPS walk...");

      walkWatcherRef.current = navigator.geolocation.watchPosition(
        pos => {
          if (walkPausedRef.current) return; // Skip updating while paused

          const la = +pos.coords.latitude.toFixed(6);
          const lo = +pos.coords.longitude.toFixed(6);
          const acc = Math.round(pos.coords.accuracy);
          setWalkAccuracy(acc);

          // Filtering poor GPS fixes for high precision (commercial-grade < 12 meters)
          if (acc > 12) {
            setGpsStatus(`Unstable GPS accuracy (±${acc}m). Ignoring point for quality control.`);
            return;
          }

          setWalkPath(prev => {
            const next = [...prev, { lat: la, lng: lo }];
            sendToMap({ type: 'WALK_PATH', path: next });
            return next;
          });

          const lastPos = lastWalkPosRef.current;
          if (lastPos) {
            const dist = haversine(lastPos, { lat: la, lng: lo });
            if (dist < walkInterval) return;
          }
          lastWalkPosRef.current = { lat: la, lng: lo };

          setPts(currentPts => {
            const exists = currentPts.some(p => Math.abs(p.lat - la) < 0.00001 && Math.abs(p.lng - lo) < 0.00001);
            if (exists) return currentPts;
            sendToMap({ type: 'ADD_PT', lat: la, lng: lo });
            return [...currentPts, { lat: la, lng: lo, label: "Boundary Pin", note: `Walk #${currentPts.length + 1}`, accuracy: acc, timestamp: new Date().toISOString() }];
          });
        },
        err => setGpsStatus("GPS error: " + (err.message || "unknown")),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
      );
    }
  };

  const togglePauseWalk = () => {
    const nextVal = !walkPaused;
    setWalkPaused(nextVal);
    walkPausedRef.current = nextVal;
    setGpsStatus(nextVal ? "GPS walk paused." : "GPS walk resumed.");
    setTimeout(() => setGpsStatus(""), 3000);
  };

  // Close polygon: snap last point to first (send to iframe + React)
  const closePolygon = () => {
    if (pts.length < 2) return;
    sendToMap({ type: 'CLOSE_POLYGON' });
    setPts(curr => {
      const first = curr[0];
      return [...curr, { lat: first.lat, lng: first.lng, label: "Closing Pin", note: "Closed to start" }];
    });
  };

  useEffect(() => {
    return () => {
      if (walkWatcherRef.current) navigator.geolocation.clearWatch(walkWatcherRef.current);
    };
  }, []);

  const handleSimplify = () => {
    if (pts.length < 3) return;
    const simplified = simplifyPolygon(pts, 0.00003);
    setPts(simplified);
    sendToMap({ type: 'CLEAR' });
    setTimeout(() => {
      sendToMap({ type: 'INIT_PTS', pts: simplified });
    }, 100);
    setGpsStatus(`Boundary simplified. Vertices reduced from ${pts.length} to ${simplified.length}.`);
    setTimeout(() => setGpsStatus(""), 3000);
  };

  const handleSmooth = () => {
    if (pts.length < 3) return;
    const smoothed = smoothPolygon(pts, 1);
    setPts(smoothed);
    sendToMap({ type: 'CLEAR' });
    setTimeout(() => {
      sendToMap({ type: 'INIT_PTS', pts: smoothed });
    }, 100);
    setGpsStatus("Boundary smoothed via Chaikin corner-cutting.");
    setTimeout(() => setGpsStatus(""), 3000);
  };

  const handleClear = () => {
    if (!window.confirm("Are you sure you want to clear the current survey?")) return;
    setPts([]);
    sendToMap({ type: 'CLEAR' });
  };

  // GIS Data Builders
  const getGeoJSON = () => {
    const closedPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
    const geojson = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          name: "Field Survey Survey",
          acres: +acres.toFixed(2),
          hectares: +(acres * 0.404686).toFixed(2),
          perimeter_meters: Math.round(perim),
          surveyDate: new Date().toISOString().slice(0, 10)
        },
        geometry: {
          type: "Polygon",
          coordinates: [closedPts.map(p => [p.lng, p.lat])]
        }
      }]
    };
    return JSON.stringify(geojson, null, 2);
  };

  const getKML = () => {
    const closedPts = pts.length >= 3 ? [...pts, pts[0]] : pts;
    const coordsStr = closedPts.map(p => `${p.lng},${p.lat},0`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>AgriHub Boundary Map</name>
    <Placemark>
      <name>Survey Field Boundary</name>
      <description>Area: ${acres.toFixed(2)} acres. Perimeter: ${Math.round(perim)}m.</description>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
${coordsStr}
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert("GIS boundary data successfully copied!");
  };

  const updatePtLabel = (idx, labelVal) => {
    setPts(curr => curr.map((p, i) => i === idx ? { ...p, label: labelVal } : p));
  };

  const updatePtNote = (idx, noteVal) => {
    setPts(curr => curr.map((p, i) => i === idx ? { ...p, note: noteVal } : p));
  };

  return (
    <div className="fade" style={{display:"flex",flexDirection:"column",gap:0}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"#3ddc84",letterSpacing:".05em",lineHeight:1}}>AgriHub Professional Survey</div>
          <div style={{fontSize:10,color:"#86efac",fontFamily:"'DM Mono',monospace",marginTop:3,display:"flex",alignItems:"center",gap:6}}>
            <span>QField-Grade GIS Engine</span>
            {pts.length > 0 && (
              <span style={{
                fontSize: 9,
                color: confidence >= 85 ? "#3ddc84" : confidence >= 60 ? "#ffa540" : "#ff8060",
                background: "#0d1a10",
                padding: "2px 6px",
                borderRadius: 4,
                border: "1px solid #1a3320",
                fontFamily: "monospace",
                fontWeight: "bold"
              }}>
                ⭐ CONFIDENCE: {confidence}% ({confidence >= 85 ? "GIS GRADE" : confidence >= 60 ? "STABLE" : "LOW QUALITY"})
              </span>
            )}
          </div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button className="btn-ghost btn-sm" onClick={grabGPS}>◎ Centre GPS</button>
          {walkAccuracy !== null && (
            <span className="badge" style={{background:"#0d1a10",color:walkAccuracy<=8?"#3ddc84":walkAccuracy<=12?"#ffa540":"#ff6b4a",border:"1px solid #1a4d25",fontSize:8}}>
              📶 ±{walkAccuracy}m
            </span>
          )}
          {walkMode && (
            <button className={`btn-sm ${walkPaused ? 'btn-gold' : 'btn-ghost'}`} onClick={togglePauseWalk}>
              {walkPaused ? "▶️ Resume Walk" : "⏸️ Pause Walk"}
            </button>
          )}
          <button className={`btn-sm ${walkMode ? 'btn-danger' : 'btn-ghost'}`} onClick={toggleWalkMode}>
            {walkMode ? "⏹ Stop Walk" : "🚶 Walk Route"}
          </button>
        </div>
      </div>

      {/* Walk interval config */}
      {walkMode && (
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,background:"#0a1408",padding:"6px 12px",borderRadius:10,border:"1px solid #ffa54040"}} className="fade">
          <span style={{fontSize:9,color:"#ffa540",fontFamily:"'DM Mono',monospace"}}>Min. point spacing:</span>
          {[3,5,10,20].map(v => (
            <button key={v}
              style={{
                background: walkInterval === v ? "#ffa540" : "transparent",
                color: walkInterval === v ? "#0a150e" : "#ffa540",
                padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: "bold",
              }}
              onClick={() => setWalkInterval(v)}
            >{v}m</button>
          ))}
          <span style={{fontSize:8,color:"#7dff9e",marginLeft:"auto",fontFamily:"'DM Mono',monospace"}}>{pts.length} pts · {walkPath.length} GPS fixes</span>
        </div>
      )}

      {/* AgriHub Unit Toggle Box */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,background:"#0a140a",padding:"6px 12px",borderRadius:10,border:"1px solid #1a4d25"}}>
        <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>DISPLAY MEASUREMENT UNIT:</span>
        <div style={{display:"flex",gap:4}}>
          {["acres", "hectares", "sqmeters"].map(unit => (
            <button
              key={unit}
              onClick={() => setDisplayUnit(unit)}
              style={{
                background: displayUnit === unit ? "#3ddc84" : "transparent",
                color: displayUnit === unit ? "#0a150e" : "#7dff9e",
                padding: "3px 8px",
                borderRadius: 5,
                fontSize: 9,
                fontWeight: "bold",
                textTransform: "uppercase"
              }}
            >
              {unit === "sqmeters" ? "m²" : unit.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>

      {/* Stats bar — Live conversions */}
      <div style={{display:"flex",gap:0,marginBottom:8,background:"#0d1a10",borderRadius:10,border:`1px solid ${pts.length>=3?"#3ddc8440":"#1a4d25"}`,overflow:"hidden"}}>
        {[
          {l:"CALCULATED AREA", v: pts.length>=3 ? areaDisplay : "—", c:"#3ddc84"},
          {l:"TOTAL PERIMETER", v: pts.length>=2 ? perimeterDisplay : "—", c:"#a7f3d0"},
          {l:"SURVEY VERTICES", v: pts.length, c:"#86efac"},
        ].map(({l,v,c},i)=>(
          <div key={l} style={{flex:1,textAlign:"center",padding:"10px 6px",borderRight:i<2?"1px solid #1a4d25":"none"}}>
            <div className="label" style={{marginBottom:2,fontSize:8}}>{l}</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:c}}>{v}</div>
          </div>
        ))}
      </div>

      {/* Validation alert banner */}
      {!validation.valid && (
        <div style={{background:"#ff6b4a15",border:"1px solid #ff6b4a40",borderRadius:10,padding:"10px 12px",marginBottom:8,fontSize:10,color:"#ff8060",fontFamily:"'DM Mono',monospace"}}>
          ⚠️ <strong>INVALID BOUNDARY GEOMETRY:</strong>
          <ul style={{marginLeft:16,marginTop:4}}>
            {validation.issues.map((iss, idx) => <li key={idx}>{iss}</li>)}
          </ul>
        </div>
      )}

      {/* SATELLITE MAP IFRAME */}
      <div style={{borderRadius:14,overflow:"hidden",border:`2px solid ${pts.length>=3?"#3ddc8450":"#1a4d25"}`,position:"relative",marginBottom:10}}>
        <iframe
          ref={iframeRef}
          src={blobUrl}
          onLoad={() => setMapReady(true)}
          style={{width:"100%",height:380,border:"none",display:"block"}}
          title="Field Map"
        />
        {!mapReady && (
          <div style={{position:"absolute",inset:0,background:"#0a140a",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#7dff9e"}}>Initialising survey maps…</div>
          </div>
        )}
      </div>

      {/* Professional GIS Geometry Tool Belt */}
      {pts.length >= 3 && (
        <div style={{display:"flex",gap:6,marginBottom:10,background:"#0d1a10",padding:8,borderRadius:10,border:"1px solid #1a4d25",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",textTransform:"uppercase"}}>GIS Tools:</span>
          <div style={{display:"flex",gap:6}}>
            <button className="btn-ghost btn-sm" onClick={handleSimplify} title="Simplify boundary vertices using Ramer-Douglas-Peucker">⚡ Simplify</button>
            <button className="btn-ghost btn-sm" onClick={handleSmooth} title="Smooth boundary edges using Chaikin Corner-Cutting">✨ Smooth</button>
            <button className="btn-ghost btn-sm" onClick={closePolygon} title="Snap last point to first point to close polygon">🔒 Close & Snap</button>
            <button className="btn-danger btn-sm" style={{padding:"5px 10px"}} onClick={handleClear}>🗑️ Clear</button>
          </div>
        </div>
      )}

      {/* GPS status */}
      {gpsStatus && (
        <div style={{fontSize:10,color:"#3ddc84",fontFamily:"'DM Mono',monospace",marginBottom:8,textAlign:"center",padding:"6px",background:"#0a1408",borderRadius:6,border:"1px solid #3ddc8430"}}>
          {gpsStatus}
        </div>
      )}

      {/* Coordinate list & Landmark Tagging Drawer */}
      {pts.length > 0 && (
        <div style={{background:"#0d1a10",borderRadius:12,padding:"10px",marginBottom:10,border:"1px solid #1a4d25"}}>
          <div style={{fontSize:10,color:"#86efac",fontFamily:"'DM Mono',monospace",marginBottom:8,textTransform:"uppercase",letterSpacing:".1em",display:"flex",justifyContent:"space-between"}}>
            <span>Boundary Node Specifications</span>
            <span>UTM & LAT/LNG</span>
          </div>
          <div style={{maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            {pts.map((p,i)=>(
              <div key={i} style={{background:"#0a140a",borderRadius:8,padding:8,border:"1px solid #1a3320"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{background:"#3ddc8420",color:"#3ddc84",fontSize:10,padding:"2px 5px",borderRadius:4,fontFamily:"'DM Mono',monospace",fontWeight:"bold"}}>#{i+1}</span>
                    <select
                      value={p.label}
                      onChange={e=>updatePtLabel(i, e.target.value)}
                      style={{width:110,padding:"2px 4px",fontSize:10,borderRadius:4,background:"#0d1a10",borderColor:"#1a3320",color:"#a7f3d0",outline:"none"}}
                    >
                      <option value="Boundary Pin">📍 Boundary Pin</option>
                      <option value="Corner Post">🪧 Corner Post</option>
                      <option value="Access Gate">🚪 Access Gate</option>
                      <option value="Water Source">💧 Water Source</option>
                      <option value="Obstacle/Rock">🪨 Obstacle/Rock</option>
                      <option value="Ridge Peak">⛰️ Ridge Peak</option>
                    </select>
                  </div>
                  
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{latLngToUTM(p.lat, p.lng)}</span>
                    <button onClick={()=>{const np=pts.filter((_,j)=>j!==i);setPts(np);sendToMap({type:'CLEAR'});setTimeout(()=>sendToMap({type:'INIT_PTS',pts:np}),50);}} style={{background:"none",border:"none",color:"#ff6b4a",fontSize:12,cursor:"pointer",padding:"0 4px"}}>×</button>
                  </div>
                </div>

                <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"space-between"}}>
                  <input
                    value={p.note}
                    onChange={e=>updatePtNote(i, e.target.value)}
                    placeholder="Enter landmark survey description..."
                    style={{padding:"4px 8px",fontSize:10,background:"#0a140a",border:"none",borderBottom:"1px solid #1a4d25",borderRadius:0,color:"#a7f3d0",width:"60%"}}
                  />
                  <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace",whiteSpace:"nowrap"}}>
                    {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        {pts.length > 0 && (
          <button className="btn-ghost" style={{flex:1,fontSize:10}} onClick={()=>{
            const np=pts.slice(0,-1); setPts(np);
            sendToMap({type:'CLEAR'}); setTimeout(()=>sendToMap({type:'INIT_PTS',pts:np}),50);
          }}>↩ Undo Last</button>
        )}
        {pts.length >= 2 && (
          <button className="btn-ghost" style={{flex:1,fontSize:10,color:"#ffa540",borderColor:"#ffa54040"}} onClick={closePolygon}>
            🔒 Close Polygon
          </button>
        )}
        {pts.length >= 3 && (
          <button className="btn-ghost" style={{flex:1,fontSize:10,color:"#3ddc84",borderColor:"#3ddc8440"}} onClick={() => setExportFormat("geojson")}>
            💾 Export GIS Data
          </button>
        )}
        {pts.length > 0 && (
          <button className="btn-danger" style={{fontSize:10,padding:"9px 14px"}} onClick={()=>{
            setPts([]); sendToMap({type:'CLEAR'});
          }}>Clear All</button>
        )}
      </div>

      {/* GIS Export Modal Overlay */}
      {exportFormat && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"#0d1a10",border:"1px solid #3ddc8440",borderRadius:14,padding:20,maxWidth:440,width:"100%"}} className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#3ddc84"}}>GIS Boundary Export</span>
              <button className="btn-ghost btn-sm" onClick={() => setExportFormat(null)}>×</button>
            </div>
            
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button
                className={`tab ${exportFormat==='geojson'?'on':''}`}
                onClick={()=>setExportFormat("geojson")}
                style={{flex:1}}
              >
                GeoJSON
              </button>
              <button
                className={`tab ${exportFormat==='kml'?'on':''}`}
                onClick={()=>setExportFormat("kml")}
                style={{flex:1}}
              >
                KML Format
              </button>
            </div>

            <textarea
              readOnly
              value={exportFormat === 'geojson' ? getGeoJSON() : getKML()}
              style={{height:180,fontFamily:"monospace",fontSize:10,background:"#0a140a",borderColor:"#1a3320",color:"#ffd84a",padding:10,borderRadius:8,resize:"none"}}
            />

            <div style={{display:"flex",gap:8,marginTop:14}}>
              <button className="btn-gold" style={{flex:1,fontSize:11}} onClick={() => copyToClipboard(exportFormat === 'geojson' ? getGeoJSON() : getKML())}>
                Copy to Clipboard
              </button>
              <button className="btn-ghost" style={{flex:1,fontSize:11}} onClick={() => setExportFormat(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {pts.length >= 3 && (
        <button className="btn-gold" style={{width:"100%",marginBottom:8,fontSize:13,padding:"13px"}} onClick={()=>{
          const surveyMethod = walkPath.length > 0 ? (walkMode ? "Hybrid Walk" : "Manual Walk") : "Manual Pinning";
          const avgAcc = pts.reduce((sum, p) => sum + (p.accuracy || 5.0), 0) / pts.length;
          const metadata = {
            survey_id: "srv_" + Math.random().toString(36).slice(2, 9),
            survey_method: surveyMethod,
            gps_accuracy: +avgAcc.toFixed(1),
            confidence_score: confidence,
            survey_duration: walkPath.length * 2, // approximation of tracking time in seconds
          };
          onConfirm(pts, acres, metadata);
        }}>
          ✓ Confirm Boundary · {areaDisplay}
        </button>
      )}
      <button className="btn-ghost" style={{width:"100%",fontSize:11}} onClick={onCancel}>Cancel</button>
    </div>
  );
}

// ─── FIELDS EXPORT PANEL (Field Officer) ─────────────────────────────────────────────────
function FieldsExportPanel({ fields }) {
  const [open, setOpen] = useState(false);
  const ts = new Date().toISOString().slice(0,10);

  const exportGeoJSON = () => {
    const gj = { type:"FeatureCollection", metadata:{exportDate:new Date().toISOString(),source:"AgriHub Field Officer",fieldCount:fields.length},
      features: fields.map(f => ({ type:"Feature",
        properties:{ id:f.id, name:f.name, area_acres:f.area_acres, estimated_total_tons:f.estimated_total_tons,
          avg_nodes:f.survey?.avg_nodes, avg_stalks:f.survey?.avg_stalks, survey_date:f.survey?.date,
          harvested:!!f.harvest, actual_tonnage:f.harvest?.actual_tonnage||null },
        geometry: f.polygon?.length>=3 ? { type:"Polygon", coordinates:[[...f.polygon.map(p=>[p.lng,p.lat]),[f.polygon[0].lng,f.polygon[0].lat]]] } : null
      }))
    };
    downloadFile(JSON.stringify(gj,null,2), `agrihub-fields-${ts}.geojson`, "application/geo+json");
  };

  const exportKML = () => {
    const pms = fields.map(f => {
      if (!f.polygon?.length) return "";
      const coords = [...f.polygon, f.polygon[0]].map(p=>`${p.lng},${p.lat},0`).join("\n");
      return `<Placemark><name>${f.name}</name><description>Area: ${f.area_acres}ac | Est: ${f.estimated_total_tons}t</description><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }).join("");
    downloadFile(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>AgriHub Fields ${ts}</name>${pms}</Document></kml>`,
      `agrihub-fields-${ts}.kml`, "application/vnd.google-earth.kml+xml");
  };

  const exportAgriHub = () => {
    downloadFile(JSON.stringify({type:"agrihub_fields",version:"1.0",exportDate:new Date().toISOString(),data:fields},null,2),
      `agrihub-fields-${ts}.json`, "application/json");
  };

  return (
    <div style={{background:"#0a0d0a",border:"1px solid #3ddc8430",borderRadius:12,padding:"12px 14px",marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:15,color:"#3ddc84",letterSpacing:".06em"}}>Export Field Data</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#7dff9e",marginTop:2}}>{fields.length} fields ready to export</div>
        </div>
        <button className="btn-ghost btn-sm" style={{color:"#3ddc84",borderColor:"#3ddc8430"}} onClick={()=>setOpen(o=>!o)}>{open?"Close":"Export ↓"}</button>
      </div>
      {open && (
        <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}} className="fade">
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#7dff9e",letterSpacing:".1em",textTransform:"uppercase",marginBottom:2}}>Choose export format:</div>
          <button className="btn-ghost" style={{textAlign:"left",fontSize:11,padding:"10px 12px"}} onClick={exportGeoJSON}>
            <div style={{color:"#a7f3d0",fontWeight:"bold"}}>📍 GeoJSON</div>
            <div style={{color:"#7dff9e",fontSize:9,marginTop:2}}>All field polygons in GeoJSON format (for QGIS, Google Earth, etc.)</div>
          </button>
          <button className="btn-ghost" style={{textAlign:"left",fontSize:11,padding:"10px 12px"}} onClick={exportKML}>
            <div style={{color:"#a7f3d0",fontWeight:"bold"}}>🗺️ KML (Google Earth)</div>
            <div style={{color:"#7dff9e",fontSize:9,marginTop:2}}>All field boundaries in KML format for Google Earth / Maps</div>
          </button>
          <button className="btn-gold" style={{textAlign:"left",fontSize:11,padding:"10px 12px"}} onClick={exportAgriHub}>
            <div style={{fontWeight:"bold"}}>📦 AgriHub Data File (.json)</div>
            <div style={{fontSize:9,marginTop:2,opacity:0.7}}>Full field data for Admin import — share with Administrator</div>
          </button>
        </div>
      )}
    </div>
  );
}

function FieldsScreen({fields,setFields,settings,role,user}) {
  const [tab,setTab] = useState("list");
  const [showAdd,setShowAdd] = useState(false);
  const [editHarvest,setEditHarvest] = useState(null);
  const [harvestForm,setHarvestForm] = useState({});
  const [expandSites,setExpandSites] = useState({});
  const [remapFieldId,setRemapFieldId] = useState(null);
  const [editFieldId, setEditFieldId] = useState(null);
  const [unlockingField, setUnlockingField] = useState(null);
  const [editFieldForm, setEditFieldForm] = useState({});
  const [form,setForm] = useState({
    name:"",
    avg_nodes:"",
    avg_stalks:"",
    buying_price_per_acre:"",
    factory_paying_price:"",
    miscellaneous_pulling_cost:"",
    farmer_phone:"",
    farmer_id_no:"",
    row_spacing:"1.3",
    ratoon_cycle:"plant",
    planted_date: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    distance_to_weighbridge_km:"",
    density_rating:"fair"
  });
  const [mappedPolygon,setMappedPolygon] = useState(null);
  const [mappedAcres,setMappedAcres] = useState(null);
  const [newSites,setNewSites] = useState([]);
  const [signature, setSignature] = useState(null);
  const [surveyMetadata, setSurveyMetadata] = useState(null);

  const getCaneAgeMonths = (plantedDate) => {
    if (!plantedDate) return null;
    const diffMs = Date.now() - new Date(plantedDate).getTime();
    const ageMonths = diffMs / (30 * 24 * 3600 * 1000);
    return Math.max(0, +ageMonths.toFixed(1));
  };

  const liveSpacing = +form.row_spacing || 1.3;
  const liveRatoonMult = getRatoonMultiplier(form.ratoon_cycle);
  const liveCoeff = getDensityCoefficient(form.density_rating, settings);
  const liveEstYieldPerAcre = (+form.avg_stalks || 8) * (+form.avg_nodes || 12) * (liveCoeff / liveSpacing) * liveRatoonMult;
  const liveTotalEstYield = mappedAcres ? mappedAcres * liveEstYieldPerAcre : 0;

  const liveDistance = mappedPolygon && mappedPolygon.length > 0 ? getFieldDistanceToWeighbridge(mappedPolygon, form.distance_to_weighbridge_km) : (form.distance_to_weighbridge_km !== "" ? parseFloat(form.distance_to_weighbridge_km) : null);
  const liveZoneIndex = liveDistance != null ? (liveDistance <= 0 ? 0 : Math.max(0, Math.ceil(liveDistance / 6) - 1)) : 0;
  const liveTransportRate = 950 + (liveZoneIndex * 100);
  const liveHarvestCost = liveTotalEstYield * 350;
  const liveTransportCost = liveTotalEstYield * liveTransportRate;
  const liveMiscPullingCost = form.miscellaneous_pulling_cost !== "" ? parseFloat(form.miscellaneous_pulling_cost) : 0;
  const liveTotalLogistics = liveHarvestCost + liveTransportCost + liveMiscPullingCost;
  const liveFactoryPayingPrice = form.factory_paying_price !== "" ? parseFloat(form.factory_paying_price) : settings.company_rate;
  const liveGrossValue = liveTotalEstYield * liveFactoryPayingPrice;
  const liveFairValuation = liveGrossValue - liveTotalLogistics;

  const addField = async ()=>{
    if (!form.name) return;
    const acres = mappedAcres || 0;
    if (acres < 0.01) { alert("Please map the field boundary first."); return; }
    if (!form.farmer_id_no) { alert("Farmer ID Number is required."); return; }
    if (!form.farmer_phone) { alert("Farmer Phone Number is required."); return; }
    if (!signature) { alert("Farmer signature is required to authorize the purchase."); return; }
    const nodes=+form.avg_nodes||12, stalks=+form.avg_stalks||8, s=settings;
    const acqRate = form.buying_price_per_acre !== "" ? +form.buying_price_per_acre : s.cost_per_acre;
    const factRate = form.factory_paying_price !== "" ? +form.factory_paying_price : s.company_rate;
    const miscPulling = form.miscellaneous_pulling_cost !== "" ? +form.miscellaneous_pulling_cost : 0;
    const spacing = +form.row_spacing || 1.3;
    const ratoonMult = getRatoonMultiplier(form.ratoon_cycle);
    const estimatedTons = calculateNewEstimate({
      stalks: stalks,
      nodes: nodes,
      densityRating: form.density_rating,
      spacing: spacing,
      ratoonCycle: form.ratoon_cycle,
      acres: acres,
      settings
    });

    try {
      const nf = await api.createField({
        name: form.name,
        farmer_id_no: form.farmer_id_no,
        farmer_phone: form.farmer_phone,
        area_acres: +acres.toFixed(2),
        estimated_total_tons: estimatedTons,
        buying_price_per_acre: acqRate,
        factory_paying_price: factRate,
        miscellaneous_pulling_cost: miscPulling,
        polygon: mappedPolygon,
        avg_nodes: nodes,
        avg_stalks: stalks,
        row_spacing: spacing,
        ratoon_cycle: form.ratoon_cycle,
        density_rating: form.density_rating || "fair",
        planted_date: form.planted_date,
        survey_date: new Date().toISOString().slice(0, 10),
        farmer_signature: signature,
        sites: newSites,
        // New GIS-grade metadata
        survey_id: surveyMetadata?.survey_id || "srv_" + Math.random().toString(36).slice(2, 9),
        survey_method: surveyMetadata?.survey_method || "Manual Pinning",
        gps_accuracy: surveyMetadata?.gps_accuracy || 5.0,
        confidence_score: surveyMetadata?.confidence_score || 85,
        survey_duration: surveyMetadata?.survey_duration || 120,
        is_sofa_survey: surveyMetadata ? (surveyMetadata.survey_method === "Manual Pinning" || surveyMetadata.survey_duration < 15) : true,
        revision_number: 1,
        created_by: user ? user.name : "System",
        distance_to_weighbridge_km: form.distance_to_weighbridge_km !== "" ? parseFloat(form.distance_to_weighbridge_km) : null,
      });
      setFields(fs => [nf, ...fs]);
    } catch (e) { alert("Failed to save field: " + e.message); }

    setForm({
      name:"",
      avg_nodes:"",
      avg_stalks:"",
      buying_price_per_acre:"",
      farmer_phone:"",
      farmer_id_no:"",
      row_spacing:"1.3",
      ratoon_cycle:"plant",
      planted_date: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      distance_to_weighbridge_km:"",
      density_rating:"fair"
    });
    setMappedPolygon(null); setMappedAcres(null);
    setNewSites([]); setSignature(null); setShowAdd(false);
  };

  const saveHarvest = async (field)=>{
    const h=harvestForm;
    if (!h.actual_tonnage) return;
    try {
      const updated = await api.updateField(field.id, {
        harvest: {
          actual_tonnage: +h.actual_tonnage,
          harvest_cost: +h.harvest_cost||0,
          transport_cost: +h.transport_cost||0,
          other_cost: +h.other_cost||0,
          selling_price: +h.selling_price||settings.company_rate,
          date: h.date||new Date().toISOString().slice(0,10),
        },
      });
      setFields(fs=>fs.map(f=>f.id===field.id?updated:f));
    } catch (e) { alert("Failed to save harvest: " + e.message); }
    setEditHarvest(null);
  };

  const updateFieldSites = async (fieldId, sites) => {
    try {
      const updated = await api.updateField(fieldId, { sites });
      setFields(fs => fs.map(f => f.id === fieldId ? updated : f));
    } catch (e) { alert("Failed to update sites: " + e.message); }
  };

  const deleteField = async id => {
    if (!confirm("Delete this field?")) return;
    try {
      await api.deleteField(id);
      setFields(fs => fs.filter(f => f.id !== id));
    } catch (e) { alert("Failed to delete field: " + e.message); }
  };

  const startEditField = (field) => {
    setEditFieldId(field.id);
    setEditFieldForm({
      name: field.name,
      farmer_id_no: field.farmer_id_no || "",
      farmer_phone: field.farmer_phone || "",
      avg_nodes: field.avg_nodes || 12,
      avg_stalks: field.avg_stalks || 8,
      row_spacing: field.row_spacing || "1.3",
      ratoon_cycle: field.ratoon_cycle || "plant",
      density_rating: field.density_rating || "fair",
      planted_date: field.planted_date || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      buying_price_per_acre: field.buying_price_per_acre !== undefined ? field.buying_price_per_acre : "",
      factory_paying_price: field.factory_paying_price !== undefined ? field.factory_paying_price : "",
      miscellaneous_pulling_cost: field.miscellaneous_pulling_cost !== undefined ? field.miscellaneous_pulling_cost : "",
      distance_to_weighbridge_km: field.distance_to_weighbridge_km !== undefined && field.distance_to_weighbridge_km !== null ? field.distance_to_weighbridge_km : "",
    });
  };

  const saveFieldDetails = async (field) => {
    if (!editFieldForm.name) { alert("Field Name is required."); return; }
    if (!editFieldForm.farmer_id_no) { alert("Farmer ID Number is required."); return; }
    if (!editFieldForm.farmer_phone) { alert("Farmer Phone Number is required."); return; }

    const nodes = +editFieldForm.avg_nodes || 12;
    const stalks = +editFieldForm.avg_stalks || 8;
    const spacing = +editFieldForm.row_spacing || 1.3;
    const acres = field.area_acres || 0;
    const estimatedTons = calculateNewEstimate({
      stalks,
      nodes,
      densityRating: editFieldForm.density_rating || "fair",
      spacing,
      ratoonCycle: editFieldForm.ratoon_cycle,
      acres,
      settings
    });
    const buyingPrice = editFieldForm.buying_price_per_acre !== "" ? +editFieldForm.buying_price_per_acre : settings.cost_per_acre;
    const factoryPrice = editFieldForm.factory_paying_price !== "" ? +editFieldForm.factory_paying_price : settings.company_rate;
    const pullingPrice = editFieldForm.miscellaneous_pulling_cost !== "" ? +editFieldForm.miscellaneous_pulling_cost : 0;

    try {
      const updated = await api.updateField(field.id, {
        name: editFieldForm.name,
        farmer_id_no: editFieldForm.farmer_id_no,
        farmer_phone: editFieldForm.farmer_phone,
        avg_nodes: nodes,
        avg_stalks: stalks,
        row_spacing: spacing,
        ratoon_cycle: editFieldForm.ratoon_cycle,
        density_rating: editFieldForm.density_rating || "fair",
        planted_date: editFieldForm.planted_date,
        estimated_total_tons: estimatedTons,
        buying_price_per_acre: buyingPrice,
        factory_paying_price: factoryPrice,
        miscellaneous_pulling_cost: pullingPrice,
        distance_to_weighbridge_km: editFieldForm.distance_to_weighbridge_km !== "" ? parseFloat(editFieldForm.distance_to_weighbridge_km) : null,
      });
      setFields(fs => fs.map(f => f.id === field.id ? updated : f));
      setEditFieldId(null);
    } catch (e) { alert("Failed to save changes: " + e.message); }
  };

  const confirmRemap = async (fieldId, newPts, newAcres, metadata) => {
    try {
      const s = settings;
      const existingField = fields.find(f => f.id === fieldId) || {};
      const nextRevision = (existingField.revision_number || 1) + 1;
      const nodes = existingField.avg_nodes || 12;
      const stalks = existingField.avg_stalks || 8;
      const spacing = existingField.row_spacing || 1.3;
      const estimatedTons = calculateNewEstimate({
        stalks,
        nodes,
        densityRating: existingField.density_rating || "fair",
        spacing,
        ratoonCycle: existingField.ratoon_cycle || "plant",
        acres: newAcres,
        settings
      });

      const updated = await api.updateField(fieldId, {
        polygon: newPts,
        area_acres: +newAcres.toFixed(2),
        estimated_total_tons: estimatedTons,
        survey_id: metadata?.survey_id || "srv_" + Math.random().toString(36).slice(2, 9),
        survey_method: metadata?.survey_method || "Manual Pinning",
        gps_accuracy: metadata?.gps_accuracy || 5.0,
        confidence_score: metadata?.confidence_score || 85,
        survey_duration: metadata?.survey_duration || 120,
        is_sofa_survey: metadata ? (metadata.survey_method === "Manual Pinning" || metadata.survey_duration < 15) : true,
        revision_number: nextRevision,
        last_modified_by: user ? user.name : "System"
      });
      setFields(fs => fs.map(f => f.id === fieldId ? updated : f));
    } catch (e) { alert("Failed to remap: " + e.message); }
    setRemapFieldId(null);
  };

  const handleUnlockComplete = async () => {
    try {
      const updatedFields = await api.getFields();
      setFields(updatedFields);
    } catch (e) { console.error("Failed to refresh fields after unlock:", e); }
    setUnlockingField(null);
  };

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a4d25"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:14}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:2}}>SURVEY & MANAGEMENT</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#3ddc84"}}>FIELDS</div>
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
        {role==="Field Officer" && fields.length > 0 && <FieldsExportPanel fields={fields}/>}
        {showAdd && (
          <div className="card fade" style={{marginBottom:14,borderColor:"#3ddc8430"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#3ddc84",marginBottom:14,letterSpacing:".04em"}}>New Field Survey</div>
            <div style={{marginBottom:10}}>
              <label className="label">Field Name *</label>
              <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Awasi Block 5" required/>
            </div>

            <div className="grid2" style={{marginBottom:10}}>
              <div>
                <label className="label">Farmer ID Number *</label>
                <input value={form.farmer_id_no} onChange={e=>setForm(f=>({...f,farmer_id_no:e.target.value}))} placeholder="e.g. 32049876" required/>
              </div>
              <div>
                <label className="label">Farmer Phone Number *</label>
                <input value={form.farmer_phone} onChange={e=>setForm(f=>({...f,farmer_phone:e.target.value}))} placeholder="e.g. 0712345678" required/>
              </div>
            </div>

            <div style={{marginBottom:14}}>
              <label className="label">Farm Buying Price per Acre (KES)</label>
              <input 
                type="number" 
                value={form.buying_price_per_acre} 
                onChange={e=>setForm(f=>({...f,buying_price_per_acre:e.target.value}))} 
                placeholder={`Default benchmark: ${settings.cost_per_acre.toLocaleString()}`}
              />
              <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>Leave empty to use the system benchmark of KES {settings.cost_per_acre.toLocaleString()}/acre.</span>
            </div>

            <div style={{marginBottom:14}}>
              <label className="label">Factory Paying Price per Ton (KES)</label>
              <input 
                type="number" 
                value={form.factory_paying_price} 
                onChange={e=>setForm(f=>({...f,factory_paying_price:e.target.value}))} 
                placeholder={`Default benchmark: ${settings.company_rate.toLocaleString()}`}
              />
              <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>Leave empty to use the system benchmark of KES {settings.company_rate.toLocaleString()}/ton.</span>
            </div>

            <div style={{marginBottom:14}}>
              <label className="label">Winch / Tractor Pulling / Wet Terrain Cost (KES)</label>
              <input 
                type="number" 
                value={form.miscellaneous_pulling_cost} 
                onChange={e=>setForm(f=>({...f,miscellaneous_pulling_cost:e.target.value}))} 
                placeholder="e.g. 15000 (0 if none)"
              />
              <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>Extra transport logistics allowance for tractors stuck in wet/difficult terrains.</span>
            </div>

            <div style={{marginBottom:14}}>
              <label className="label">Distance to Weighbridge (km) - Optional Override</label>
              <input 
                type="number" 
                step="0.1"
                value={form.distance_to_weighbridge_km} 
                onChange={e=>setForm(f=>({...f,distance_to_weighbridge_km:e.target.value}))} 
                placeholder="Auto-calculated from polygon centroid if empty"
              />
              <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>
                {liveDistance != null ? `Calculated/Used distance: ${liveDistance.toFixed(2)} km (Zone ${String.fromCharCode(65 + Math.min(25, liveZoneIndex))})` : "Will be automatically calculated based on the field's polygon centroid."}
              </span>
            </div>
            
            <div style={{marginBottom:14,border:"1px dashed #3ddc8440",borderRadius:12,padding:14}}>
              <FieldMapper
                initialPts={mappedPolygon||[]}
                existingFields={fields}
                onConfirm={(pts, acres, metadata)=>{setMappedPolygon(pts); setMappedAcres(acres); setSurveyMetadata(metadata);}}
                onCancel={()=>{setMappedPolygon(null); setMappedAcres(null);}}
              />
            </div>

            <div className="grid3" style={{marginBottom:14, gap:10}}>
              <div>
                <span className="label">Area (Mapped)</span>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#3ddc84",padding:"8px 0"}}>
                  {mappedAcres ? `${mappedAcres.toFixed(2)} ac` : "N/A"}
                </div>
              </div>
              <div>
                <label className="label">Avg. Nodes / Stalk</label>
                <input type="number" value={form.avg_nodes} onChange={e=>setForm(f=>({...f,avg_nodes:e.target.value}))} placeholder="12"/>
              </div>
              <div>
                <label className="label">Avg. Stalks / Meter</label>
                <input type="number" value={form.avg_stalks} onChange={e=>setForm(f=>({...f,avg_stalks:e.target.value}))} placeholder="8"/>
              </div>
            </div>

            <div className="grid2" style={{marginBottom:14, gap:10}}>
              <div>
                <label className="label">Cane Density Rating</label>
                <select value={form.density_rating} onChange={e=>setForm(f=>({...f,density_rating:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"9px 12px",fontSize:12}}>
                  <option value="poor">Poor (0.22 coeff)</option>
                  <option value="fair">Fair (0.24 coeff - Default)</option>
                  <option value="good">Good (0.27 coeff)</option>
                  <option value="excellent">Excellent (0.30 coeff)</option>
                </select>
              </div>
              <div>
                <label className="label">Planted / Ratooned Date</label>
                <input type="date" value={form.planted_date} onChange={e=>setForm(f=>({...f,planted_date:e.target.value}))} style={{fontSize:12, padding:"9px 12px", background:"#ffffff", color:"#052011", border:"1.5px solid #1a4d25", borderRadius:8}}/>
              </div>
            </div>

            <div className="grid2" style={{marginBottom:14, gap:10}}>
              <div>
                <label className="label">Row Spacing</label>
                <select value={form.row_spacing} onChange={e=>setForm(f=>({...f,row_spacing:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"9px 12px",fontSize:12}}>
                  <option value="1.2">1.2 m (Narrow Density)</option>
                  <option value="1.3">1.3 m (Standard Row)</option>
                  <option value="1.4">1.4 m (Wide Row)</option>
                </select>
              </div>
              <div>
                <label className="label">Ratoon Cycle</label>
                <select value={form.ratoon_cycle} onChange={e=>setForm(f=>({...f,ratoon_cycle:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"9px 12px",fontSize:12}}>
                  <option value="plant">Plant Cane (100%)</option>
                  <option value="ratoon_1">Ratoon 1 (-15%)</option>
                  <option value="ratoon_2">Ratoon 2 (-30%)</option>
                  <option value="ratoon_3_plus">Ratoon 3+ (-45%)</option>
                </select>
              </div>
            </div>

            <div style={{marginBottom:14, background:"#0a140a", padding:12, borderRadius:8, border:"1px dashed #eab30840"}}>
              <span className="label" style={{color:"#eab308"}}>Live Pre-Harvest Yield Estimation Potential</span>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", marginTop:4}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:"#eab308"}}>
                  {liveTotalEstYield > 0 ? `${liveTotalEstYield.toFixed(1)} tons` : "Map field & input counters"}
                </div>
              </div>
              {liveTotalEstYield > 0 && (
                <div style={{marginTop:8, borderTop:"1px dashed #eab30830", paddingTop:8, fontSize:10, fontFamily:"'DM Mono',monospace", color:"#eab308"}}>
                  {(() => {
                    const payout = calculateFarmerPayout({
                      estimatedTons: liveTotalEstYield,
                      factoryPrice: liveFactoryPayingPrice,
                      distanceKm: liveDistance || 0,
                      miscCost: liveMiscPullingCost,
                      acres: mappedAcres,
                      targetProfitPct: settings.target_profitability
                    });
                    return (
                      <>
                        <div style={{display:"flex", justifyContent:"space-between", marginBottom:2}}>
                          <span>Distance:</span>
                          <span>{liveDistance != null ? `${liveDistance.toFixed(2)} km (Zone ${String.fromCharCode(65 + Math.min(25, liveZoneIndex))})` : "Auto (from Centroid)"}</span>
                        </div>
                        <div style={{display:"flex", justifyContent:"space-between", marginBottom:2}}>
                          <span>Factory Price:</span>
                          <span>KES {liveFactoryPayingPrice.toLocaleString()}/t</span>
                        </div>
                        <div style={{display:"flex", justifyContent:"space-between", marginBottom:2, color:"#ff8060"}}>
                          <span>Harvesting ({payout.harvestCost > 0 ? '350' : '-'}/t):</span>
                          <span>- KES {payout.harvestCost.toLocaleString(undefined, {maximumFractionDigits:0})}</span>
                        </div>
                        <div style={{display:"flex", justifyContent:"space-between", marginBottom:2, color:"#ff8060"}}>
                          <span>Transport ({payout.transportRate}/t):</span>
                          <span>- KES {payout.transportCost.toLocaleString(undefined, {maximumFractionDigits:0})}</span>
                        </div>
                        {payout.totalOpsCost > 0 && (
                          <div style={{display:"flex", justifyContent:"space-between", marginBottom:2, fontSize:9, color:"#d0d0d8"}}>
                            <span>Total Ops Cost:</span>
                            <span>- KES {payout.totalOpsCost.toLocaleString(undefined, {maximumFractionDigits:0})}</span>
                          </div>
                        )}
                        <div style={{display:"flex", justifyContent:"space-between", borderTop:"1px dotted #eab30820", paddingTop:4, fontWeight:"bold", color:"#3ddc84"}}>
                          <span>Suggested Farmer Payout:</span>
                          <span>KES {payout.totalPayout.toLocaleString()}</span>
                        </div>
                        <div style={{display:"flex", justifyContent:"space-between", fontSize:9, color:"#7dff9e"}}>
                          <span>{payout.profitMargin}% target profitability on net</span>
                          <span>{K(payout.perAcre)}/ac</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
            <div style={{borderTop:"1px solid #1a4d25",paddingTop:14,marginBottom:14}}>
              <SiteTable sites={newSites} setSites={setNewSites}/>
            </div>
            <div style={{marginBottom:14}}>
              <SignaturePad onSign={(data) => setSignature(data)} onClear={() => setSignature(null)} />
            </div>
            <button className="btn-gold" onClick={addField} style={{width:"100%"}}>Save Field</button>
          </div>
        )}

        {tab==="list" && (
          <div>
            {fields.length===0 && (
              <div className="card" style={{textAlign:"center",padding:"40px 20px",color:"#7dff9e"}}>
                <div style={{fontSize:32,marginBottom:8}}>~</div>
                <div style={{fontSize:12,fontFamily:"'DM Mono',monospace"}}>No fields yet. Add your first field above.</div>
              </div>
            )}
            {fields.map(f=>{
              const distance = getFieldDistanceToWeighbridge(f.polygon, f.distance_to_weighbridge_km);
              const isHarvested=!!f.harvest?.actual_tonnage;
              const tonsVal = isHarvested ? f.harvest.actual_tonnage : (f.estimated_total_tons || 0);
              const harvVal = tonsVal * 350;
              
              const zoneIdx = distance <= 0 ? 0 : Math.max(0, Math.ceil(distance / 6) - 1);
              const transRate = 950 + (zoneIdx * 100);
              const transVal = tonsVal * transRate;
              const miscPulling = f.miscellaneous_pulling_cost || 0;
              const totalLog = harvVal + transVal + miscPulling;

              const purchaseCost=(f.area_acres||0)*(f.buying_price_per_acre||settings.cost_per_acre);
              const factoryRate=f.factory_paying_price || settings.company_rate;
              const actRevenue=isHarvested?f.harvest.actual_tonnage*(f.harvest.selling_price||factoryRate):null;
              const estRevenue=(f.estimated_total_tons||0)*factoryRate;
              
              const currentHarvestCost = isHarvested && f.harvest.harvest_cost !== undefined && f.harvest.harvest_cost !== "" ? parseFloat(f.harvest.harvest_cost) : harvVal;
              const currentTransportCost = isHarvested && f.harvest.transport_cost !== undefined && f.harvest.transport_cost !== "" ? parseFloat(f.harvest.transport_cost) : transVal;
              const currentOtherCost = isHarvested ? (parseFloat(f.harvest.other_cost) || 0) : 0;
              
              const grossVal = isHarvested ? actRevenue : estRevenue;
              const fairValuation = grossVal - totalLog;
              const profit = grossVal - purchaseCost - currentHarvestCost - currentTransportCost - currentOtherCost - miscPulling;
              const zoneLetter = String.fromCharCode(65 + Math.min(25, zoneIdx));
              const zoneName = `Zone ${zoneLetter} (${(zoneIdx * 6).toFixed(0)}-${((zoneIdx + 1) * 6).toFixed(0)} km)`;

              const recommendedPayout = calculateFarmerPayout({
                estimatedTons: f.estimated_total_tons,
                factoryPrice: factoryRate,
                distanceKm: distance,
                miscCost: miscPulling,
                acres: f.area_acres,
                targetProfitPct: settings.target_profitability
              });

              const sites=f.sites||[];
              const isSitesOpen=expandSites[f.id];
              return (
                <div key={f.id} className="card card-hover" style={{marginBottom:10, borderColor: "#1a4d25"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#a7f3d0",letterSpacing:".03em"}}>{f.name}</div>
                      </div>
                      <div style={{display:"flex",gap:4,flexWrap:"wrap",rowGap:4}}>
                        <span className={`badge ${isHarvested?"badge-green":f.survey_date?"badge-gold":"badge-gray"}`} style={{fontSize:8}}>
                          {isHarvested?"OK Harvested":f.survey_date?"Surveyed":"Mapped"}
                        </span>
                        {f.is_sofa_survey ? (
                          <span className="badge" style={{fontSize:8,background:"#ff806015",color:"#ff8060",border:"1px solid #ff806040"}} title="Field agent did not walk the route. Fabricated or remote manual survey.">⚠️ Desk Survey (Manual)</span>
                        ) : (
                          <span className="badge" style={{fontSize:8,background:"#3ddc8415",color:"#3ddc84",border:"1px solid #3ddc8440"}} title="Field agent verified the boundary by physically walking around the parcel.">✅ Verified Walk</span>
                        )}
                        <span className="badge badge-gray" style={{fontSize:8}}>{fmt(f.area_acres)} ac</span>
                        <span className="badge badge-gray" style={{fontSize:8}}>{f.row_spacing || "1.3"}m spacing</span>
                        <span className="badge badge-gold" style={{fontSize:8, textTransform:"capitalize"}}>{f.ratoon_cycle ? f.ratoon_cycle.replace("_", " ") : "Plant Cane"}</span>
                        {f.planted_date && (() => {
                          const age = getCaneAgeMonths(f.planted_date);
                          const isMature = age >= 14.0;
                          return (
                            <span className={`badge ${isMature ? "badge-green" : "badge-blue"}`} style={{fontSize:8, border: isMature ? "1px solid #3ddc8440" : "1px solid #3b82f640"}}>
                              {isMature ? `🔥 Mature (${age} mo)` : `🌱 Growing (${age} mo)`}
                            </span>
                          );
                        })()}
                        {sites.length>0&&<span className="badge badge-blue" style={{fontSize:8}}>{sites.length} site{sites.length>1?"s":""}</span>}
                      </div>
                    </div>
                    <PolygonMap coords={f.polygon} size={70}/>
                  </div>
                  <div style={{background:"#0a140a",border:"1px solid #141200",borderRadius:8,padding:"10px 12px",marginBottom:10, position: "relative"}}>
                    {f.locked && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                        background: "rgba(10, 20, 10, 0.85)", backdropFilter: "blur(3px)", zIndex: 10,
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                        borderRadius: 8, padding: 20, textAlign: "center"
                      }}>
                        <div style={{fontSize: 32, marginBottom: 8}}>🔒</div>
                        <div style={{fontFamily: "'Bebas Neue'", fontSize: 20, color: "#eab308", letterSpacing: ".05em", marginBottom: 6}}>Analysis Locked</div>
                        <div style={{fontSize: 9, color: "#fef08a", fontFamily: "'DM Mono',monospace", marginBottom: 12}}>
                          Yield estimation, financial logistics, and profitability metrics are locked.
                        </div>
                        <button className="btn-gold" style={{fontSize: 10, padding: "8px 16px"}} onClick={() => setUnlockingField(f)}>
                          Unlock Field Analysis
                        </button>
                      </div>
                    )}
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#86efac",letterSpacing:".05em",marginBottom:6,textTransform:"uppercase", filter: f.locked ? "blur(2px)" : "none"}}>Financial Module Breakdown</div>
                    
                    <div className="grid2" style={{gap:6, filter: f.locked ? "blur(2px)" : "none"}}>
                      <div>
                        <span className="label">1. Buying Cost (Acquisition)</span>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#a7f3d0"}}>{f.locked ? "---" : K(purchaseCost)}</div>
                        <div style={{fontSize:8,color:"#7dff9e"}}>{fmt(f.area_acres)} ac @ {f.locked ? "---" : K(f.buying_price_per_acre || settings.cost_per_acre)}/ac</div>
                      </div>
                      
                      <div>
                        <span className="label">2. Yield Output</span>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#3ddc84"}}>
                          {f.locked ? "---" : (isHarvested ? `Actual: ${fmt(f.harvest.actual_tonnage)} t` : `Est: ${fmt(f.estimated_total_tons)} t`)}
                        </div>
                        <div style={{fontSize:8,color:"#7dff9e"}}>
                          {f.locked ? "---" : (isHarvested ? `Diff: ${fmt(f.harvest.actual_tonnage - f.estimated_total_tons)} t` : "Pending harvest weighment")}
                        </div>
                      </div>
                    </div>

                    {/* Dynamic Logistics & Fair Field Valuation Ledger */}
                    <div style={{marginTop:10, padding:10, borderRadius:8, background:"#081014", border:"1px solid #0284c730"}}>
                      <div style={{fontSize:9, fontFamily:"'DM Mono',monospace", color:"#38bdf8", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                        <span>📈 INVESTOR VALUATION &amp; LOGISTICS</span>
                        <span style={{fontSize:8, color:"#38bdf8", background:"#0c4a6e", padding:"1px 6px", borderRadius:4, fontWeight:"bold"}}>
                          {zoneName} | {distance.toFixed(1)} km
                        </span>
                      </div>
                      
                      <div className="grid3" style={{gap:6, fontSize:9, fontFamily:"'DM Mono',monospace"}}>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Gross Value:</span>
                          <div style={{color:"#eab308", fontWeight:"bold"}}>{K(grossVal)}</div>
                          <span style={{fontSize:7, color:"#7dff9e"}}>{fmt(tonsVal)} t @ {K(factoryRate)}/t</span>
                        </div>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Harvest (350/t):</span>
                          <div style={{color:"#ff8060"}}>-{K(currentHarvestCost)}</div>
                          <span style={{fontSize:7, color:"#7dff9e"}}>Field cutting cost</span>
                        </div>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Transport ({transRate}/t):</span>
                          <div style={{color:"#ff8060"}}>-{K(currentTransportCost)}</div>
                          <span style={{fontSize:7, color:"#7dff9e"}}>Zone rates applied</span>
                        </div>
                      </div>
                      {miscPulling > 0 && (
                        <div style={{marginTop:6, display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:9, fontFamily:"'DM Mono',monospace", padding:"4px 0", borderTop:"1px dashed #ff806020"}}>
                          <span style={{color:"#ff8060"}}>Winch / Terrain Pulling Cost:</span>
                          <span style={{color:"#ff8060", fontWeight:"bold"}}>-{K(miscPulling)}</span>
                        </div>
                      )}
                      
                      <div style={{marginTop:8, borderTop:"1px dashed #38bdf830", paddingTop:6, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                        <span style={{fontSize:9, color:"#38bdf8", fontWeight:"bold"}}>FAIR FIELD VALUATION (PAYOUT):</span>
                        <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, color:"#38bdf8", fontWeight:"bold"}} title="The fair amount that should be paid for this field after accounting for harvesting and zone transport logistics.">
                          {K(fairValuation)}
                        </span>
                      </div>
                    </div>

                    {/* Recommended Farmer Payout based on target profitability */}
                    <div style={{marginTop:10, padding:10, borderRadius:8, background:"#0f1a05", border:"1px solid #3ddc8460"}}>
                      <div style={{fontSize:9, fontFamily:"'DM Mono',monospace", color:"#3ddc84", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                        <span>RECOMMENDED FARMER PAYOUT</span>
                        <span style={{fontSize:8, color:"#a7f3d0", background:"#1a4d25", padding:"1px 6px", borderRadius:4, fontWeight:"bold"}}>
                          {recommendedPayout.profitMargin}% target margin on net
                        </span>
                      </div>
                      <div style={{display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ff8060", marginBottom:4}}>
                        <span>Harvesting (350/t):</span>
                        <span>- {K(recommendedPayout.harvestCost)}</span>
                      </div>
                      <div style={{display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ff8060", marginBottom:4}}>
                        <span>Transport ({recommendedPayout.transportRate}/t):</span>
                        <span>- {K(recommendedPayout.transportCost)}</span>
                      </div>
                      <div className="grid2" style={{gap:6, fontSize:9, fontFamily:"'DM Mono',monospace", borderTop:"1px dotted #3ddc8430", paddingTop:6, marginTop:4}}>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Total Payout:</span>
                          <div style={{color:"#3ddc84", fontWeight:"bold", fontSize:13}}>{K(recommendedPayout.totalPayout)}</div>
                        </div>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Per Acre:</span>
                          <div style={{color:"#3ddc84", fontWeight:"bold", fontSize:13}}>{K(recommendedPayout.perAcre)}</div>
                          <span style={{fontSize:7, color:"#7dff9e"}}>{fmt(f.area_acres)} ac basis</span>
                        </div>
                      </div>
                    </div>

                    {isHarvested && (
                      <div className="grid3" style={{gap:6,marginTop:8,borderTop:"1px dashed #141200",paddingTop:8}}>
                        <div>
                          <span className="label">Harvesting Cost</span>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ff8060"}}>{K(f.harvest.harvest_cost || 0)}</div>
                        </div>
                        <div>
                          <span className="label">Transportation Cost</span>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ff8060"}}>{K(f.harvest.transport_cost || 0)}</div>
                        </div>
                        <div>
                          <span className="label">Other Costs</span>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ff8060"}}>{K(f.harvest.other_cost || 0)}</div>
                        </div>
                      </div>
                    )}

                    {/* Transparent Farmer Net Settlement Ledger (Secure Outgrower Protection) */}
                    <div style={{marginTop:10, padding:10, borderRadius:8, background:"#0d1a10", border:"1px solid #3ddc8430"}}>
                      <div style={{fontSize:9, fontFamily:"'DM Mono',monospace", color:"#3ddc84", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                        <span>🔒 LOCKED FARMER SETTLEMENT DETAILS</span>
                        <span style={{fontSize:8, color:"#a7f3d0", background:"#1a4d25", padding:"1px 4px", borderRadius:4}}>Zero Hidden Agent Fees</span>
                      </div>
                      <div className="grid3" style={{gap:6, fontSize:9, fontFamily:"'DM Mono',monospace"}}>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Gross Acquisition:</span>
                          <div style={{color:"#a7f3d0", fontWeight:"bold"}}>{K(purchaseCost)}</div>
                        </div>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Harvest Deduction:</span>
                          <div style={{color:"#ff8060"}}>-{K((isHarvested ? f.harvest.actual_tonnage : f.estimated_total_tons) * 600)}</div>
                        </div>
                        <div>
                          <span style={{color:"#d0d0d8"}}>Transport Deduction:</span>
                          <div style={{color:"#ff8060"}}>-{K((isHarvested ? f.harvest.actual_tonnage : f.estimated_total_tons) * 450)}</div>
                        </div>
                      </div>
                      <div style={{marginTop:8, borderTop:"1px dashed #3ddc8430", paddingTop:6, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                        <span style={{fontSize:9, color:"#3ddc84", fontWeight:"bold"}}>GUARANTEED NET TO FARMER:</span>
                        <span style={{fontFamily:"'DM Mono',monospace", fontSize:12, color:"#3ddc84", fontWeight:"bold"}}>
                          {K(purchaseCost - ((isHarvested ? f.harvest.actual_tonnage : f.estimated_total_tons) * 600) - ((isHarvested ? f.harvest.actual_tonnage : f.estimated_total_tons) * 450))}
                        </span>
                      </div>
                    </div>

                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,borderTop:"1px solid #141200",paddingTop:8}}>
                      <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#86efac"}}>RETURNS &amp; PROFITABILITY</span>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:profit>0?"#3ddc84":"#ff6b4a"}}>
                          {profit > 0 ? "+" : ""}{K(profit)}
                        </div>
                        <div style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>
                          Margin: {isHarvested ? fmt((profit / actRevenue) * 100) : fmt((profit / estRevenue) * 100)}%
                        </div>
                      </div>
                    </div>
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
                            <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"-"}:</span>
                            {weatherBadge(s.weather_access)}
                          </div>
                        ))}
                      </div>
                    )}
                      <div style={{marginTop:10, borderTop: "1px solid #1a4d25", paddingTop: 10}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:"'DM Mono',monospace",color:"#86efac",marginBottom:6}}>
                          <span>Farmer ID: {f.farmer_id_no || "N/A"}</span>
                          <span>Phone: {f.farmer_phone || "N/A"}</span>
                        </div>
                        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6}}>
                          <span style={{fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono',monospace"}}>FARMER AUTHORIZATION:</span>
                          {f.farmer_signature ? (
                            <img src={f.farmer_signature} alt="Signature" style={{height: 30, filter: "drop-shadow(0 0 1px #3ddc84)"}}/>
                          ) : (
                            <span style={{fontSize: 10, color: "#ff6b4a"}}>Not Signed</span>
                          )}
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:8,fontFamily:"'DM Mono',monospace",color:"#7dff9e",borderTop:"1px dashed #1a4d25",paddingTop:6}}>
                          <span>Registered by: <span style={{color:"#3ddc84"}}>{f.created_by || "System"}</span></span>
                          <span>Sync: {f.synced_by ? <span style={{color:"#5b9cf6"}}>✓ Synced ({f.synced_by})</span> : <span style={{color:"#ffa540"}}>Local Cache Only</span>}</span>
                        </div>
                      </div>
                    </div>

                  {editFieldId===f.id && (
                    <div style={{background:"#0a140a",borderRadius:10,padding:12,marginBottom:10,border:"1px solid #3ddc8430"}} className="fade">
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84",marginBottom:10}}>Edit Survey &amp; Farmer Details</div>
                      
                      <div style={{marginBottom:8}}>
                        <label className="label">Field Name *</label>
                        <input value={editFieldForm.name} onChange={e=>setEditFieldForm(f=>({...f,name:e.target.value}))}/>
                      </div>

                      <div className="grid2" style={{marginBottom:8}}>
                        <div>
                          <label className="label">Farmer ID Number *</label>
                          <input value={editFieldForm.farmer_id_no} onChange={e=>setEditFieldForm(f=>({...f,farmer_id_no:e.target.value}))}/>
                        </div>
                        <div>
                          <label className="label">Farmer Phone Number *</label>
                          <input value={editFieldForm.farmer_phone} onChange={e=>setEditFieldForm(f=>({...f,farmer_phone:e.target.value}))}/>
                        </div>
                      </div>

                      <div className="grid2" style={{marginBottom:8}}>
                        <div>
                          <label className="label">Avg. Nodes / Stalk</label>
                          <input type="number" value={editFieldForm.avg_nodes} onChange={e=>setEditFieldForm(f=>({...f,avg_nodes:e.target.value}))}/>
                        </div>
                        <div>
                          <label className="label">Avg. Stalks / Meter</label>
                          <input type="number" value={editFieldForm.avg_stalks} onChange={e=>setEditFieldForm(f=>({...f,avg_stalks:e.target.value}))}/>
                        </div>
                      </div>

                      <div className="grid2" style={{marginBottom:8}}>
                        <div>
                          <label className="label">Cane Density Rating</label>
                          <select value={editFieldForm.density_rating || "fair"} onChange={e=>setEditFieldForm(f=>({...f,density_rating:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"6px 8px",fontSize:11}}>
                            <option value="poor">Poor (0.22 coeff)</option>
                            <option value="fair">Fair (0.24 coeff - Default)</option>
                            <option value="good">Good (0.27 coeff)</option>
                            <option value="excellent">Excellent (0.30 coeff)</option>
                          </select>
                        </div>
                        <div>
                          <label className="label">Row Spacing</label>
                          <select value={editFieldForm.row_spacing} onChange={e=>setEditFieldForm(f=>({...f,row_spacing:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"6px 8px",fontSize:11}}>
                            <option value="1.2">1.2 m (Narrow)</option>
                            <option value="1.3">1.3 m (Standard)</option>
                            <option value="1.4">1.4 m (Wide)</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid2" style={{marginBottom:8}}>
                        <div>
                          <label className="label">Ratoon Cycle</label>
                          <select value={editFieldForm.ratoon_cycle} onChange={e=>setEditFieldForm(f=>({...f,ratoon_cycle:e.target.value}))} className="input" style={{width:"100%",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8,padding:"6px 8px",fontSize:11}}>
                            <option value="plant">Plant Cane</option>
                            <option value="ratoon_1">Ratoon 1</option>
                            <option value="ratoon_2">Ratoon 2</option>
                            <option value="ratoon_3_plus">Ratoon 3+</option>
                          </select>
                        </div>
                        <div>
                          <label className="label">Planted Date</label>
                          <input type="date" value={editFieldForm.planted_date} onChange={e=>setEditFieldForm(f=>({...f,planted_date:e.target.value}))} style={{fontSize:11,padding:"5px",background:"#ffffff",color:"#052011",border:"1.5px solid #1a4d25",borderRadius:8}}/>
                        </div>
                      </div>

                      <div style={{marginBottom:10}}>
                        <label className="label">Buying Price per Acre (KES)</label>
                        <input type="number" value={editFieldForm.buying_price_per_acre} onChange={e=>setEditFieldForm(f=>({...f,buying_price_per_acre:e.target.value}))} placeholder={`Default: ${settings.cost_per_acre}`}/>
                      </div>

                      <div style={{marginBottom:10}}>
                        <label className="label">Factory Paying Price per Ton (KES)</label>
                        <input type="number" value={editFieldForm.factory_paying_price} onChange={e=>setEditFieldForm(f=>({...f,factory_paying_price:e.target.value}))} placeholder={`Default: ${settings.company_rate}`}/>
                      </div>

                      <div style={{marginBottom:10}}>
                        <label className="label">Winch / Tractor Pulling / Wet Terrain Cost (KES)</label>
                        <input type="number" value={editFieldForm.miscellaneous_pulling_cost} onChange={e=>setEditFieldForm(f=>({...f,miscellaneous_pulling_cost:e.target.value}))} placeholder="e.g. 15000 (0 if none)"/>
                      </div>

                      <div style={{marginBottom:10}}>
                        <label className="label">Distance to Weighbridge (km) - Optional Override</label>
                        <input 
                          type="number" 
                          step="0.1" 
                          value={editFieldForm.distance_to_weighbridge_km} 
                          onChange={e=>setEditFieldForm(f=>({...f,distance_to_weighbridge_km:e.target.value}))} 
                          placeholder="Auto-calculated from polygon if empty"
                        />
                        <span style={{fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>
                          Calculated Distance: {getFieldDistanceToWeighbridge(f.polygon, editFieldForm.distance_to_weighbridge_km).toFixed(2)} km
                        </span>
                      </div>

                      {/* Live recalculation based on edit values */}
                      {(() => {
                        const estTons = calculateNewEstimate({
                          stalks: editFieldForm.avg_stalks,
                          nodes: editFieldForm.avg_nodes,
                          densityRating: editFieldForm.density_rating || "fair",
                          spacing: editFieldForm.row_spacing,
                          ratoonCycle: editFieldForm.ratoon_cycle,
                          acres: f.area_acres,
                          settings
                        });
                        const factoryPrice = editFieldForm.factory_paying_price !== "" ? +editFieldForm.factory_paying_price : settings.company_rate;
                        const distance = getFieldDistanceToWeighbridge(f.polygon, editFieldForm.distance_to_weighbridge_km);
                        const misc = editFieldForm.miscellaneous_pulling_cost !== "" ? +editFieldForm.miscellaneous_pulling_cost : 0;
                        const payout = calculateFarmerPayout({
                          estimatedTons: estTons,
                          factoryPrice,
                          distanceKm: distance,
                          miscCost: misc,
                          acres: f.area_acres,
                          targetProfitPct: settings.target_profitability
                        });
                        return (
                          <div style={{marginBottom:10, background:"#f3fbf7", padding:8, borderRadius:6, border:"1px dashed #1a4d25"}}>
                            <div style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:"#1a4d25",marginBottom:4}}>
                              Estimated Tonnage: <strong>{estTons.toFixed(1)} tons</strong>
                            </div>
                            <div style={{display:"flex", justifyContent:"space-between", fontSize:10, fontFamily:"'DM Mono',monospace", color:"#b91c1c", marginBottom:2}}>
                              <span>Harvesting (350/t):</span>
                              <span>- KES {payout.harvestCost.toLocaleString(undefined, {maximumFractionDigits:0})}</span>
                            </div>
                            <div style={{display:"flex", justifyContent:"space-between", fontSize:10, fontFamily:"'DM Mono',monospace", color:"#b91c1c", marginBottom:2}}>
                              <span>Transport ({payout.transportRate}/t):</span>
                              <span>- KES {payout.transportCost.toLocaleString(undefined, {maximumFractionDigits:0})}</span>
                            </div>
                            <div style={{display:"flex", justifyContent:"space-between", borderTop:"1px dotted #1a4d2530", paddingTop:4, fontSize:10, fontFamily:"'DM Mono',monospace", fontWeight:"bold", color:"#1a4d25"}}>
                              <span>Suggested Farmer Payout:</span>
                              <span>KES {payout.totalPayout.toLocaleString()} ({K(payout.perAcre)}/ac)</span>
                            </div>
                            <div style={{fontSize:9,color:"#6b8e72",fontFamily:"'DM Mono',monospace",marginTop:2}}>
                              {payout.profitMargin}% target profitability on net after ops costs
                            </div>
                          </div>
                        );
                      })()}

                      <div style={{display:"flex",gap:8}}>
                        <button className="btn-gold" onClick={()=>saveFieldDetails(f)} style={{flex:1}}>Save Changes</button>
                        <button className="btn-ghost" onClick={()=>setEditFieldId(null)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {remapFieldId===f.id && (
                    <div style={{background:"#0a140a",borderRadius:12,padding:14,marginBottom:10,border:"1px solid #3ddc8440"}} className="fade">
                      <FieldMapper
                        initialPts={f.polygon||[]}
                        existingFields={fields}
                        currentFieldId={f.id}
                        onConfirm={(pts,acres,metadata)=>confirmRemap(f.id,pts,acres,metadata)}
                        onCancel={()=>setRemapFieldId(null)}
                      />
                    </div>
                  )}

                  {editHarvest===f.id && (
                    <div style={{background:"#0a140a",borderRadius:10,padding:12,marginBottom:10}} className="fade">
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84",marginBottom:10}}>Record Harvest &amp; Transport Expenses</div>
                      <div className="grid2" style={{marginBottom:8}}>
                        <div><label className="label">Actual Tonnage (weighed)</label><input type="number" placeholder="0.0" onChange={e=>setHarvestForm(h=>({...h,actual_tonnage:e.target.value}))}/></div>
                        <div><label className="label">Factory Price (KES/t)</label><input type="number" defaultValue={settings.company_rate} onChange={e=>setHarvestForm(h=>({...h,selling_price:e.target.value}))}/></div>
                        <div><label className="label">Harvesting Cost (KES)</label><input type="number" placeholder="e.g. 12000" onChange={e=>setHarvestForm(h=>({...h,harvest_cost:e.target.value}))}/></div>
                        <div><label className="label">Transport Cost (KES)</label><input type="number" placeholder="e.g. 8000" onChange={e=>setHarvestForm(h=>({...h,transport_cost:e.target.value}))}/></div>
                        <div style={{gridColumn:"span 2"}}><label className="label">Other Expenses (loaders, permits, etc - KES)</label><input type="number" placeholder="e.g. 3000" onChange={e=>setHarvestForm(h=>({...h,other_cost:e.target.value}))}/></div>
                      </div>
                      <div style={{marginBottom:10}}><label className="label">Weighment Date</label><input type="date" defaultValue={new Date().toISOString().slice(0,10)} onChange={e=>setHarvestForm(h=>({...h,date:e.target.value}))}/></div>
                      <div style={{display:"flex",gap:8}}>
                        <button className="btn-gold" onClick={()=>saveHarvest(f)} style={{flex:1}}>Save Harvest &amp; Expenses</button>
                        <button className="btn-ghost" onClick={()=>setEditHarvest(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {remapFieldId!==f.id && (
                      <button className="btn-ghost" style={{flex:1,minWidth:"70px",fontSize:10,padding:"6px 8px"}} onClick={()=>setRemapFieldId(f.id)}>
                        o Remap
                      </button>
                    )}
                    {editFieldId!==f.id && (
                      <button className="btn-ghost" style={{flex:1,minWidth:"70px",fontSize:10,padding:"6px 8px"}} onClick={()=>startEditField(f)}>
                        📝 Edit Details
                      </button>
                    )}
                    {!isHarvested&&editHarvest!==f.id && (
                      <button className="btn-ghost" style={{flex:1,minWidth:"70px",fontSize:10,padding:"6px 8px"}} onClick={()=>{setEditHarvest(f.id);setHarvestForm({});}}>+ Record Harvest</button>
                    )}
                    <button className="btn-danger" style={{fontSize:10,padding:"6px 12px"}} onClick={()=>deleteField(f.id)}>x</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab==="map" && (
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#7dff9e",marginBottom:12}}>Field boundary previews - {fields.length} fields</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {fields.map(f=>(
                <div key={f.id} className="card" style={{padding:10,textAlign:"center",position:"relative"}}>
                  {f.locked && (
                    <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,background:"rgba(10,20,10,0.85)",backdropFilter:"blur(2px)",zIndex:5,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:12}}>
                      <button className="btn-gold btn-sm" onClick={()=>setUnlockingField(f)} style={{fontSize:9}}>🔒 Unlock</button>
                    </div>
                  )}
                  <PolygonMap coords={f.polygon} size={120} color={f.harvest?.actual_tonnage?"#3ddc84":"#3ddc84"}/> 
                  <div style={{marginTop:8,fontFamily:"'DM Mono',monospace",fontSize:10,color:"#86efac"}}>{f.name}</div>
                  <div style={{fontSize:9,color:"#7dff9e"}}>{fmt(f.area_acres)} ac . {f.locked ? "---" : fmt(f.estimated_total_tons)} t</div>
                  {(f.sites||[]).length>0 && (
                    <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:4,justifyContent:"center"}}>
                      {f.sites.map(s=>weatherBadge(s.weather_access))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {unlockingField && (
        <AnalysisUnlockModal
          field={unlockingField}
          onClose={()=>setUnlockingField(null)}
          onUnlockComplete={handleUnlockComplete}
        />
      )}
    </div>
  );
}

// ─── TRADE EXPORT PANEL (Weighbridge Trader) ────────────────────────────────────────────────
function TradeExportPanel({ transactions }) {
  const [open, setOpen] = useState(false);
  const ts = new Date().toISOString().slice(0,10);

  const exportCSV = () => {
    const header = "ID,Farmer,Tons,Buy Price (KES/t),Total Cost (KES),Expected Payout (KES),Gross Profit (KES),Date,Note";
    const rows = transactions.map(t =>
      `${t.id},"${t.farmer_name}",${t.tons},${t.buy_price},${t.total_cost},${t.expected_payout},${t.gross_profit},${t.date},"${t.note||''}"`);
    downloadFile([header,...rows].join('\n'), `agrihub-trades-${ts}.csv`, "text/csv");
  };

  const exportAgriHub = () => {
    downloadFile(
      JSON.stringify({type:"agrihub_trades",version:"1.0",exportDate:new Date().toISOString(),data:transactions},null,2),
      `agrihub-trades-${ts}.json`, "application/json"
    );
  };

  return (
    <div style={{background:"#0a0a1a",border:"1px solid #5b9cf630",borderRadius:12,padding:"12px 14px",marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:15,color:"#5b9cf6",letterSpacing:".06em"}}>Export Trade Data</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#7dff9e",marginTop:2}}>{transactions.length} transactions ready to export</div>
        </div>
        <button className="btn-ghost btn-sm" style={{color:"#5b9cf6",borderColor:"#5b9cf630"}} onClick={()=>setOpen(o=>!o)}>{open?"Close":"Export ↓"}</button>
      </div>
      {open && (
        <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}} className="fade">
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#7dff9e",letterSpacing:".1em",textTransform:"uppercase",marginBottom:2}}>Choose export format:</div>
          <button className="btn-ghost" style={{textAlign:"left",fontSize:11,padding:"10px 12px"}} onClick={exportCSV}>
            <div style={{color:"#a7f3d0",fontWeight:"bold"}}>📊 CSV (Spreadsheet)</div>
            <div style={{color:"#7dff9e",fontSize:9,marginTop:2}}>All transactions in CSV format — open in Excel or Google Sheets</div>
          </button>
          <button className="btn-gold" style={{textAlign:"left",fontSize:11,padding:"10px 12px"}} onClick={exportAgriHub}>
            <div style={{fontWeight:"bold"}}>📦 AgriHub Data File (.json)</div>
            <div style={{fontSize:9,marginTop:2,opacity:0.7}}>Full trade data for Admin import — share with Administrator</div>
          </button>
        </div>
      )}
    </div>
  );
}

function TicketScanner({ onScan, onClose }) {
  const [cameras, setCameras] = useState([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [error, setError] = useState("");
  const qrRef = useRef(null);

  useEffect(() => {
    let html5QrCode;
    
    // Explicitly request user media stream first to trigger native browser/WebView camera permission dialog
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        // Stop temporary stream immediately
        stream.getTracks().forEach(track => track.stop());
        
        // Now query devices since permission is granted
        return Html5Qrcode.getCameras();
      })
      .then((devices) => {
        if (devices && devices.length > 0) {
          setCameras(devices);
          // Prefer back camera if available
          const backCam = devices.find((d) => d.label.toLowerCase().includes("back") || d.label.toLowerCase().includes("environment"));
          const selectedCam = backCam ? backCam.id : devices[0].id;
          setActiveCameraId(selectedCam);
          startScanner(selectedCam);
        } else {
          setError("No cameras found. Please check device permissions.");
        }
      })
      .catch((err) => {
        setError("Camera permission denied or camera not accessible.");
        console.error(err);
      });

    const startScanner = (cameraId) => {
      initAndStart(cameraId);
    };

    const initAndStart = (cameraId) => {
      html5QrCode = new Html5Qrcode("scanner-view");
      qrRef.current = html5QrCode;
      
      html5QrCode.start(
        cameraId,
        {
          fps: 15,
          qrbox: (width, height) => {
            const size = Math.min(width, height) * 0.7;
            return { width: size, height: size };
          }
        },
        (decodedText) => {
          html5QrCode.stop().then(() => {
            onScan(decodedText);
          }).catch(err => {
            console.error(err);
            onScan(decodedText);
          });
        },
        () => {}
      ).catch((err) => {
        setError("Failed to start camera. It might be in use by another app.");
        console.error(err);
      });
    };

    return () => {
      if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().catch(err => console.error("Error stopping scanner on unmount", err));
      }
    };
  }, [onScan]);

  const handleCameraChange = (e) => {
    const newId = e.target.value;
    setActiveCameraId(newId);
    if (qrRef.current) {
      qrRef.current.stop().then(() => {
        const freshScanner = new Html5Qrcode("scanner-view");
        qrRef.current = freshScanner;
        freshScanner.start(
          newId,
          {
            fps: 15,
            qrbox: (width, height) => {
              const size = Math.min(width, height) * 0.7;
              return { width: size, height: size };
            }
          },
          (decodedText) => {
            freshScanner.stop().then(() => onScan(decodedText)).catch(() => onScan(decodedText));
          },
          () => {}
        );
      });
    }
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(4, 7, 5, 0.95)", zIndex: 9999,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: 20, backdropFilter: "blur(8px)"
    }}>
      <div style={{
        background: "#0d1a10", border: "1px solid #3ddc8430",
        borderRadius: 16, padding: 20, width: "100%", maxWidth: 440,
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h3 style={{ fontFamily: "'Bebas Neue'", fontSize: 22, color: "#3ddc84", letterSpacing: "0.05em" }}>📷 Ticket Scanner</h3>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#7dff9e" }}>Hold barcode or QR code up to camera</p>
          </div>
          <button className="btn-danger btn-sm" onClick={onClose} style={{ borderRadius: 8 }}>Close</button>
        </div>

        {error ? (
          <div style={{ background: "#ff6b4a15", border: "1px solid #ff6b4a30", color: "#ff8060", padding: 12, borderRadius: 8, fontSize: 11, textAlign: "center", fontFamily: "monospace" }}>
            {error}
          </div>
        ) : (
          <div style={{ position: "relative", width: "100%", aspectRatio: "1/1", background: "#0a150e", borderRadius: 12, overflow: "hidden", border: "1px solid #1a4d25" }}>
            <div id="scanner-view" style={{ width: "100%", height: "100%" }}></div>
            <div style={{
              position: "absolute", left: "10%", right: "10%", height: 2, background: "#3ddc84",
              boxShadow: "0 0 8px #3ddc84", top: "50%",
              animation: "laser-sweep 2s ease-in-out infinite"
            }} />
          </div>
        )}

        {cameras.length > 1 && (
          <div style={{ marginTop: 14 }}>
            <label className="label">Select Camera</label>
            <select value={activeCameraId} onChange={handleCameraChange}>
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>{cam.label || `Camera ${cameras.indexOf(cam) + 1}`}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <style>{`
        @keyframes laser-sweep {
          0% { top: 15%; opacity: 0.3; }
          50% { top: 85%; opacity: 1; }
          100% { top: 15%; opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

function WeighbridgeScreen({transactions,setTransactions,settings,setSettings,role,user}) {
  const isAdmin = role === "Admin";
  const canPay = role === "Admin" || role === "Weighbridge Trader";
  const [tab,setTab] = useState("buy");
  const [scanning,setScanning] = useState(false);
  const [payingTxn, setPayingTxn] = useState(null);
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);
  const [form,setForm] = useState({farmer_name:"",tons:"",buy_price:settings.buy_rate,date:new Date().toISOString().slice(0,10),note:"", ticket_number: "", ticket_image: null});
  const [factoryRateInput,setFactoryRateInput] = useState(settings.company_rate);
  const [payImmediately, setPayImmediately] = useState(false);

  const handlePaymentComplete = async (updatedTxn) => {
    try {
      const updated = await api.updateTransaction(payingTxn.id, {
        payment_status: "completed",
        payment_amount: payingTxn.total_cost,
        payment_reference: "MP" + Math.random().toString(36).slice(2, 9).toUpperCase(),
        payment_date: new Date().toISOString()
      });
      setTransactions(ts => ts.map(t => t.id === payingTxn.id ? updated : t));
    } catch (e) {
      console.error(e);
    }
    setPayingTxn(null);
  };

  const totalPaid = transactions.reduce((s, t) => s + (t.payment_status === "completed" ? (t.payment_amount||0) : 0), 0);
  const pendingPayments = transactions.filter(t => t.payment_status !== "completed");
  const completedPayments = transactions.filter(t => t.payment_status === "completed");

  const tons=+form.tons||0, buyPrice=+form.buy_price||0;
  const totalCost=tons*buyPrice, expectedPayout=tons*settings.company_rate;
  const grossProfit=expectedPayout-totalCost, margin=expectedPayout>0?(grossProfit/expectedPayout*100):0;

  const addTxn = async ()=>{
    if (!form.farmer_name) { alert("Farmer Name is required!"); return; }
    if (!form.tons) { alert("Tons is required!"); return; }
    if (!form.ticket_number) { alert("Factory Ticket Number is required!"); return; }
    try {
      const newTxn = await api.createTransaction({
        farmer_name: form.farmer_name, tons, buy_price: buyPrice,
        total_cost: totalCost, expected_payout: expectedPayout,
        gross_profit: grossProfit, date: form.date, note: form.note,
        ticket_number: form.ticket_number, ticket_image: form.ticket_image,
        created_by: user ? user.name : "System",
      });
      setTransactions(ts=>[newTxn,...ts]);
      setForm(f=>({...f,farmer_name:"",tons:"",note:"", ticket_number: "", ticket_image: null}));
      if (payImmediately) {
        setPayingTxn(newTxn);
      }
    } catch (e) { alert("Failed to save transaction: " + e.message); }
  };
  const deleteTxn = async id => {
    if (!confirm("Delete this transaction?")) return;
    try {
      await api.deleteTransaction(id);
      setTransactions(ts=>ts.filter(t=>t.id!==id));
    } catch (e) { alert("Failed to delete: " + e.message); }
  };

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
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a4d25"}}>
        <div style={{marginBottom:14}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:2}}>BUY . TRACK . REPORT . KES</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#3ddc84"}}>WEIGHBRIDGE</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          {[["buy","Buy"],["history","History"],["weekly","Weekly"]].map(([t,l])=>(
            <button key={t} className={`tab ${tab===t?"on":""}`} onClick={()=>setTab(t)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"14px 20px 0"}}>
        {/* Export panel for Weighbridge Trader */}
        {role==="Weighbridge Trader" && transactions.length > 0 && <TradeExportPanel transactions={transactions}/>}
        {tab==="buy" && (
          <div className="fade">
            {tons>0 && (
              <div className="card" style={{marginBottom:14,borderColor:"#3ddc8430",background:"#3ddc8408"}}>
                <div style={{display:"grid",gap:10,gridTemplateColumns:isAdmin?"1fr 1fr 1fr":"1fr"}}>
                  {[
                    {l:"Cash Out",v:K(totalCost),c:"#ff8060"},
                    ...(isAdmin ? [
                      {l:"Expected In",v:K(expectedPayout),c:"#3ddc84"},
                      {l:"Gross Profit",v:K(grossProfit),c:grossProfit>0?"#3ddc84":"#ff6b4a"}
                    ] : [])
                  ].map(({l,v,c})=>(
                    <div key={l} style={{textAlign:"center"}}>
                      <span className="label">{l}</span>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                {isAdmin && (
                  <>
                    <div className="progress" style={{marginTop:10}}><div className="progress-fill" style={{width:`${Math.min(100,margin)}%`,background:"#3ddc84"}}/></div>
                    <div style={{textAlign:"right",fontSize:9,color:"#7dff9e",marginTop:4,fontFamily:"'DM Mono',monospace"}}>{fmt(margin,1)}% margin</div>
                  </>
                )}
              </div>
            )}
            <div className="card">
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"#3ddc84",marginBottom:14,letterSpacing:".04em"}}>New Purchase</div>
              <div style={{marginBottom:10}}><label className="label">Farmer Name</label><input value={form.farmer_name} onChange={e=>setForm(f=>({...f,farmer_name:e.target.value}))} placeholder="Farmer name"/></div>
              <div className="grid2" style={{marginBottom:10}}>
                <div><label className="label">Tons</label><input type="number" value={form.tons} onChange={e=>setForm(f=>({...f,tons:e.target.value}))} placeholder="0.0"/></div>
                <div><label className="label">Buy Price (KES/t)</label><input type="number" value={form.buy_price} onChange={e=>setForm(f=>({...f,buy_price:e.target.value}))}/></div>
              </div>
              <div className="grid2" style={{marginBottom:10}}>
                <div>
                  <label className="label">Factory Ticket No. *</label>
                  <div style={{display:"flex",gap:6}}>
                    <input value={form.ticket_number} onChange={e=>setForm(f=>({...f,ticket_number:e.target.value}))} placeholder="e.g. TKT-8932"/>
                    <button type="button" className="btn-ghost" onClick={()=>setScanning(true)} style={{padding:"9px 12px",whiteSpace:"nowrap",flexShrink:0}}>📷 Scan</button>
                  </div>
                </div>
                <div>
                  <label className="label">Upload Ticket Photo</label>
                  <label style={{display:"block",padding:"8px 10px",background:"#0d1a10",border:"1px dashed #3ddc8440",borderRadius:8,color:"#3ddc84",fontSize:10,textAlign:"center",cursor:"pointer"}}>
                    {form.ticket_image ? "✓ Image Attached" : "+ Choose File"}
                    <input type="file" accept="image/*" onChange={(e)=>{
                      const file = e.target.files[0];
                      if(file){ const r = new FileReader(); r.onload=ev=>setForm(f=>({...f,ticket_image:ev.target.result})); r.readAsDataURL(file); }
                    }} style={{display:"none"}}/>
                  </label>
                </div>
              </div>
              {scanning && (
                <TicketScanner
                  onScan={(text)=>{
                    setForm(f=>({...f,ticket_number:text}));
                    setScanning(false);
                  }}
                  onClose={()=>setScanning(false)}
                />
              )}
              {isAdmin && (
                <div style={{marginBottom:10,padding:"8px 10px",background:"#0a140a",borderRadius:8,fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <span>Factory rate (KES/t):</span>
                  <input type="number" value={factoryRateInput}
                    onChange={e=>setFactoryRateInput(e.target.value)}
                    onBlur={()=>{const v=+factoryRateInput;if(v>0)setSettings(s=>({...s,company_rate:v}));}}
                    onKeyDown={e=>{if(e.key==="Enter"){const v=+factoryRateInput;if(v>0)setSettings(s=>({...s,company_rate:v}));e.target.blur();}}}
                    style={{width:90,padding:"3px 7px",fontSize:12,color:"#3ddc84",background:"#081208",border:"1px solid #3ddc8440",borderRadius:6,fontFamily:"'Bebas Neue'",letterSpacing:".03em"}}
                  />
                  <span style={{color:"#7dff9e",fontSize:9}}>edit anytime</span>
                </div>
              )}
              <div className="grid2" style={{marginBottom:10}}>
                <div><label className="label">Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
                <div><label className="label">Note</label><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="Optional"/></div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <input
                  id="pay-immediately"
                  type="checkbox"
                  checked={payImmediately}
                  onChange={e=>setPayImmediately(e.target.checked)}
                  style={{width:16,height:16,accentColor:"#3ddc84",cursor:"pointer"}}
                />
                <label htmlFor="pay-immediately" style={{fontSize:10,color:"#3ddc84",fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:".06em"}}>
                  💳 TRIGGER IMMEDIATE M-PESA PAYOUT (STK PUSH)
                </label>
              </div>
              <button className="btn-gold" onClick={addTxn} style={{width:"100%"}}>Record Purchase</button>
            </div>
          </div>
        )}

        {tab==="history" && (
          <div className="fade">
            {/* Payment Summary Strip */}
            {canPay && transactions.length > 0 && (
              <div className="card" style={{marginBottom:10,borderColor:"#3ddc8430",padding:"12px 14px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84",letterSpacing:".05em"}}>M-PESA PAYMENTS</span>
                  <button className="btn-ghost btn-sm" onClick={()=>setShowPaymentHistory(s=>!s)}>{showPaymentHistory?"Hide":"History"}</button>
                </div>
                <div className="grid3">
                  <div><span className="label">Total Paid</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#3ddc84"}}>{K(totalPaid)}</div></div>
                  <div><span className="label">Completed</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#3ddc84"}}>{completedPayments.length}</div></div>
                  <div><span className="label">Pending</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#ffa540"}}>{pendingPayments.length}</div></div>
                </div>
                {showPaymentHistory && completedPayments.length > 0 && (
                  <div style={{marginTop:10,borderTop:"1px solid #1a4d25",paddingTop:10}} className="fade">
                    <div style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginBottom:6,textTransform:"uppercase",letterSpacing:".1em"}}>Payment History</div>
                    {completedPayments.map(p => (
                      <div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #0f1f14",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                        <span style={{color:"#86efac"}}>{p.farmer_name}</span>
                        <span style={{color:"#3ddc84"}}>{K(p.payment_amount)}</span>
                        <span style={{color:"#7dff9e"}}>{p.ticket_number}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {transactions.length===0&&<div className="card" style={{textAlign:"center",padding:32,color:"#7dff9e",fontSize:12}}>No transactions yet.</div>}
            {transactions.map(t=>(
              <div key={t.id} className="card" style={{marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:"#a7f3d0",marginBottom:4}}>{t.farmer_name}</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      <span className="badge badge-gray">{t.date}</span>
                      <span className="badge badge-gold">{fmt(t.tons)} t</span>
                      {t.ticket_number && <span className="badge badge-blue">#{t.ticket_number}</span>}
                      {isAdmin && <span className="badge badge-green">+{K(t.gross_profit)}</span>}
                      {t.payment_status === "completed" && <span className="badge badge-green">✓ Paid</span>}
                      {t.payment_status !== "completed" && canPay && <span className="badge badge-orange">⏳ Unpaid</span>}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
                    {t.payment_status !== "completed" && canPay && (
                      <button className="btn-gold btn-sm" onClick={()=>setPayingTxn(t)} style={{fontSize:9,padding:"5px 8px"}}>💳 Pay</button>
                    )}
                    {t.payment_status === "completed" && (
                      <span style={{fontSize:16}} title={`M-Pesa Ref: ${t.payment_reference}`}>✅</span>
                    )}
                    <button className="btn-danger btn-sm" onClick={()=>deleteTxn(t.id)}>x</button>
                  </div>
                </div>
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #1a4d25",display:"flex",gap:16}}>
                  <div><span className="label">Paid</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#ff8060"}}>{K(t.total_cost)}</div></div>
                  {isAdmin && <div><span className="label">Expected</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84"}}>{K(t.expected_payout)}</div></div>}
                  <div><span className="label">KES/ton</span><div style={{fontFamily:"'Bebas Neue'",fontSize:16}}>{t.buy_price.toLocaleString()}</div></div>
                </div>
                {t.payment_reference && (
                  <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #0f1f14",fontSize:8,color:"#7dff9e",fontFamily:"'DM Mono',monospace",display:"flex",gap:12}}>
                    <span>M-Pesa Ref: {t.payment_reference}</span>
                    <span>{new Date(t.payment_date).toLocaleString("en-KE")}</span>
                  </div>
                )}
                {t.note&&<div style={{fontSize:10,color:"#7dff9e",fontStyle:"italic",marginTop:6,fontFamily:"'Crimson Pro',serif"}}>{t.note}</div>}
                {t.ticket_image && <div style={{marginTop:8}}><img src={t.ticket_image} alt="Factory Ticket" style={{maxHeight: 120, borderRadius: 6, border: "1px solid #1a4d25", objectFit: "cover"}}/></div>}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:8,fontFamily:"'DM Mono',monospace",color:"#7dff9e",marginTop:8,borderTop:"1px dashed #1a4d25",paddingTop:6}}>
                  <span>Recorded by: <span style={{color:"#5b9cf6"}}>{t.created_by || "System"}</span></span>
                  <span>Sync: {t.synced_by ? <span style={{color:"#5b9cf6"}}>✓ Synced ({t.synced_by})</span> : <span style={{color:"#ffa540"}}>Local Cache Only</span>}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab==="weekly" && (
          <div className="fade">
            {weeks.length===0&&<div className="card" style={{textAlign:"center",padding:32,color:"#7dff9e",fontSize:12}}>No transactions yet.</div>}
            {weeks.map((w,i)=>(
              <div key={i} className="card" style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#3ddc84"}}>Week {w.week}</div>
                  <span className="badge badge-gray">{w.count} loads</span>
                </div>
                <div className="grid2">
                  {[
                    {l:"Tons",v:fmt(w.tons),c:"#3ddc84"},
                    {l:"Cash Out",v:K(w.cost),c:"#ff8060"},
                    ...(isAdmin ? [
                      {l:"Gross Profit",v:K(w.profit),c:"#3ddc84"},
                      {l:"Expected In",v:K(w.revenue),c:"#5b9cf6"},
                    ] : [])
                  ].map(({l,v,c})=>(
                    <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:c}}>{v}</div></div>
                  ))}
                </div>
                {isAdmin && <div className="progress" style={{marginTop:10}}><div className="progress-fill" style={{width:`${Math.min(100,w.revenue>0?w.profit/w.revenue*100:0)}%`,background:"#3ddc84"}}/></div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {payingTxn && (
        <MPesaPaymentModal
          transaction={payingTxn}
          onClose={()=>setPayingTxn(null)}
          onPaymentComplete={handlePaymentComplete}
        />
      )}
    </div>
  );
}

function ReportsScreen({fields,transactions,settings}) {
  const harvestedFields = fields.filter(f=>f.harvest?.actual_tonnage);
  const pendingFields = fields.filter(f=>!f.harvest?.actual_tonnage);
  const totalEstTons = fields.reduce((s,f)=>s+(f.estimated_total_tons||0),0);
  const totalActTons = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage,0);
  const totalAcres = fields.reduce((s,f)=>s+(f.area_acres||0),0);
  const avgYield = totalAcres>0?totalEstTons/totalAcres:0;
  const avgActYield = harvestedFields.length>0?totalActTons/harvestedFields.reduce((s,f)=>s+(f.area_acres||0),0):0;
  const acqCost = fields.reduce((s,f)=>s+(f.area_acres||0)*(f.buying_price_per_acre||settings.cost_per_acre),0);
  const harvCost = harvestedFields.reduce((s,f)=>s+(f.harvest.harvest_cost||0),0);
  const transCost = harvestedFields.reduce((s,f)=>s+(f.harvest.transport_cost||0),0);
  const otherCost = harvestedFields.reduce((s,f)=>s+(f.harvest.other_cost||0),0);
  const totalCost = acqCost + harvCost + transCost + otherCost;
  const actRevenue = harvestedFields.reduce((s,f)=>s+f.harvest.actual_tonnage*(f.harvest.selling_price||settings.company_rate),0);
  const estFuture = pendingFields.reduce((s,f)=>s+(f.estimated_total_tons||0)*settings.company_rate,0);
  const wbProfit = transactions.reduce((s,t)=>s+t.gross_profit,0);
  const disbursedAmount = transactions.filter(t => t.payment_status === "completed").reduce((s,t) => s + (t.payment_amount||0), 0);
  const pendingAmount = Math.max(0, transactions.reduce((s,t)=>s+t.total_cost,0) - disbursedAmount);
  const compRate = transactions.length > 0 ? (transactions.filter(t => t.payment_status === "completed").length / transactions.length * 100) : 0;

  const farmerMap={};
  transactions.forEach(t=>{
    if (!farmerMap[t.farmer_name]) farmerMap[t.farmer_name]={name:t.farmer_name,tons:0,profit:0,loads:0};
    farmerMap[t.farmer_name].tons+=t.tons; farmerMap[t.farmer_name].profit+=t.gross_profit; farmerMap[t.farmer_name].loads++;
  });
  const farmers=Object.values(farmerMap).sort((a,b)=>b.tons-a.tons).slice(0,8);

  const allSites=fields.flatMap(f=>(f.sites||[]).map(s=>({...s,field:f.name})));
  const badSites=allSites.filter(s=>s.weather_access?.includes("Impassable")||s.weather_access?.includes("4WD"));
  const warnSites=allSites.filter(s=>s.weather_access&&!s.weather_access.includes("Impassable")&&!s.weather_access.includes("4WD")&&!s.weather_access.includes("All-season"));

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a4d25"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:2}}>SEASON SUMMARY . KES</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#3ddc84"}}>REPORTS</div>
          </div>
          <button className="btn-gold btn-sm" onClick={()=>generateReportPDF({fields, transactions, settings, title: "Season Report"})} style={{fontSize:9,padding:"8px 14px"}}>
            📄 Download PDF
          </button>
        </div>
      </div>

      <div style={{padding:"16px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Season Overview</div>
          <div className="grid2" style={{gap:12}}>
            {[
              {l:"Total Fields",v:fields.length},
              {l:"Harvested",v:harvestedFields.length},
              {l:"Total Acres",v:fmt(totalAcres)},
              {l:"Est. Tons",v:fmt(totalEstTons)},
              {l:"Actual Tons",v:fmt(totalActTons),c:"#3ddc84"},
              {l:"Yield Accuracy",v:totalEstTons>0?fmt(totalActTons/totalEstTons*100)+"%":"-",c:"#3ddc84"},
              {l:"Avg Est. Yield/ac",v:fmt(avgYield)+" t"},
              {l:"Avg Act. Yield/ac",v:avgActYield>0?fmt(avgActYield)+" t":"-",c:"#3ddc84"},
            ].map(({l,v,c})=>(
              <div key={l}><span className="label">{l}</span><div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:c||"#a7f3d0"}}>{v}</div></div>
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>P&amp;L Summary</div>
          {[
            {l:"1. Field Acquisition Cost",v:acqCost,color:"#ff8060",dir:"v"},
            {l:"2. Harvesting Cost",v:harvCost,color:"#ff8060",dir:"v"},
            {l:"3. Transportation Cost",v:transCost,color:"#ff8060",dir:"v"},
            {l:"4. Other Logistics Costs",v:otherCost,color:"#ff8060",dir:"v"},
            {l:"Total Realized Expenses",v:totalCost,color:"#ffa540",dir:"v"},
            {l:"Realized Revenue (Factory)",v:actRevenue,color:"#3ddc84",dir:"^"},
            {l:"Estimated Future Revenue",v:estFuture,color:"#5b9cf6",dir:"~"},
            {l:"Weighbridge Trading Profit",v:wbProfit,color:"#3ddc84",dir:"^"},
          ].map(({l,v,color,dir})=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #1a4d25"}}>
              <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:"#86efac"}}>{l}</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:9,color:"#7dff9e"}}>{dir}</span>
                <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color}}>{K(v)}</span>
              </div>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:12,marginTop:4}}>
            <span style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>Expected Season Total Margin</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:22,color:(actRevenue+estFuture)>totalCost?"#3ddc84":"#ff6b4a"}}>
              {(actRevenue+estFuture)>0?fmt(((actRevenue+estFuture-totalCost)/(actRevenue+estFuture))*100)+"%":"-"}
            </span>
          </div>
        </div>

        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>M-Pesa Disbursal Report</div>
          <div className="grid3" style={{marginBottom:14}}>
            <div><span className="label">Total Paid (M-Pesa)</span><div className="stat-val" style={{fontSize:20,color:"#3ddc84"}}>{K(disbursedAmount)}</div></div>
            <div><span className="label">Total Outstanding</span><div className="stat-val" style={{fontSize:20,color:"#ffa540"}}>{K(pendingAmount)}</div></div>
            <div><span className="label">Disbursal Rate</span><div className="stat-val" style={{fontSize:20,color:"#3ddc84"}}>{fmt(compRate)}%</div></div>
          </div>
          <div className="progress"><div className="progress-fill" style={{width:`${compRate}%`,background:"#3ddc84"}}/></div>
        </div>

        {(badSites.length>0||warnSites.length>0) && (
          <div className="card">
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Access Risk Summary</div>
            {badSites.length>0 && (
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"#ff8060",fontFamily:"'DM Mono',monospace",marginBottom:6}}>! High Risk Sites ({badSites.length})</div>
                {badSites.map(s=>(
                  <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #0f1f14"}}>
                    <div>
                      <span style={{fontSize:10,color:"#a7f3d0",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Unnamed"}</span>
                      <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginLeft:8}}>{s.field}</span>
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
                  <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #0f1f14"}}>
                    <div>
                      <span style={{fontSize:10,color:"#a7f3d0",fontFamily:"'DM Mono',monospace"}}>{s.site_name||"Unnamed"}</span>
                      <span style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginLeft:8}}>{s.field}</span>
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
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Top Farmers</div>
            {farmers.map((f,i)=>(
              <div key={f.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0f1f14"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:i===0?"#3ddc84":"#7dff9e",minWidth:18}}>#{i+1}</span>
                  <div>
                    <div style={{fontSize:11,color:"#a7f3d0",fontFamily:"'DM Mono',monospace"}}>{f.name}</div>
                    <div style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace"}}>{f.loads} loads . {fmt(f.tons)} t</div>
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

const USERS = [];

function loginToEmail(login) {
  const value = login.trim().toLowerCase();
  return value.includes("@") ? value : `${value}@agrihub.local`;
}

function supabaseUserToAppUser(authUser) {
  const metadata = authUser?.user_metadata || {};
  const emailUsername = authUser?.email ? authUser.email.split("@")[0] : authUser?.id;
  return {
    id: authUser.id,
    username: (metadata.username || emailUsername || "").toLowerCase(),
    role: metadata.role || "Field Officer",
    name: metadata.name || metadata.full_name || authUser.email || emailUsername || "AgriHub User",
    color: metadata.color || "#3ddc84",
    email: authUser.email || null
  };
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError("");
    if (!username || !password) { setError("Please enter your credentials."); return; }
    setLoading(true);
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: loginToEmail(username),
        password
      });

      if (authError) throw authError;
      if (!data.session || !data.user) throw new Error("Supabase did not return a login session.");

      const appUser = supabaseUserToAppUser(data.user);
      if (remember) localStorage.setItem("agrihub_user", JSON.stringify(appUser));
      onLogin(appUser, data.session.access_token);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:"#0a150e",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20,position:"relative",overflow:"hidden"}}>
      {/* Ambient glow */}
      <div style={{position:"absolute",top:"-20%",left:"50%",transform:"translateX(-50%)",width:400,height:400,background:"radial-gradient(circle,#3ddc8412 0%,transparent 70%)",pointerEvents:"none"}}/>
      <div className="login-card login-anim">
        {/* Branding */}
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".3em",color:"#7dff9e",marginBottom:8}}>KENYA . SUGARCANE . ERP</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:52,letterSpacing:".06em",color:"#3ddc84",lineHeight:1}} className="glow-text">AgriHub</div>
          <div style={{fontFamily:"'Crimson Pro',serif",fontStyle:"italic",fontSize:14,color:"#86efac",marginTop:4}}>Field Command & Trade Intelligence</div>
        </div>

        {/* Credentials */}
        <div style={{marginBottom:10}}>
          <label className="label">Email or Username</label>
          <div className="input-wrap">
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter your Supabase login"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoComplete="username"
            />
          </div>
        </div>

        <div style={{marginBottom:6}}>
          <label className="label">Password</label>
          <div className="input-wrap">
            <input
              id="login-password"
              type={showPw ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoComplete="current-password"
            />
            <button className="eye" onClick={() => setShowPw(s => !s)} type="button">{showPw ? "○" : "●"}</button>
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:20}}>
          <input
            id="remember-me"
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            style={{width:16,height:16,accentColor:"#3ddc84",cursor:"pointer"}}
          />
          <label htmlFor="remember-me" style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",cursor:"pointer",letterSpacing:".06em"}}>REMEMBER ME ON THIS DEVICE</label>
        </div>

        {error && (
          <div style={{background:"#ff6b4a12",border:"1px solid #ff6b4a30",borderRadius:8,padding:"9px 12px",marginBottom:14,fontSize:11,color:"#ff8060",fontFamily:"'DM Mono',monospace"}}>
            {error}
          </div>
        )}

        <button id="login-submit" className="btn-login" onClick={handleLogin} disabled={loading}>
          {loading ? "AUTHENTICATING…" : "SIGN IN TO AGRIHUB"}
        </button>

      </div>

      <div style={{marginTop:24,fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",letterSpacing:".1em"}}>AGRIHUB © 2026 · KENYA SUGARCANE ERP</div>
    </div>
  );
}

// ─── ADMIN SYNC BANNER (with file import) ────────────────────────────────────────────────
function AdminSyncBanner({ onSync, onFileImport, lastSync }) {
  const hasFields = JSON.parse(localStorage.getItem("agrihub_fields") || "[]").length > 0;
  const hasTxns   = JSON.parse(localStorage.getItem("agrihub_transactions") || "[]").length > 0;
  const hasAny    = hasFields || hasTxns;
  const fieldsRef = useRef(null);
  const tradesRef = useRef(null);

  const handleFile = (e, type) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        if (type === "fields") {
          const parsed = JSON.parse(ev.target.result);
          const data = parsed.type === "agrihub_fields" ? parsed.data
            : parsed.type === "FeatureCollection" ? null : null;
          if (data) onFileImport("fields", data);
          else alert("Invalid fields file. Please use an AgriHub Fields .json file.");
        } else {
          const parsed = JSON.parse(ev.target.result);
          const data = parsed.type === "agrihub_trades" ? parsed.data : null;
          if (data) onFileImport("trades", data);
          else alert("Invalid trades file. Please use an AgriHub Trades .json file.");
        }
      } catch { alert("Could not parse file. Make sure it is a valid AgriHub JSON export."); }
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  return (
    <div style={{background:"#0c0f0c",border:"1px solid #3ddc8430",borderRadius:12,padding:"14px 16px",marginBottom:14}}>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"#3ddc84",letterSpacing:".06em",marginBottom:10}}>Admin Data Import Hub</div>

      {/* Live sync from localStorage */}
      <div style={{background:"#0a140a",borderRadius:8,padding:"10px 12px",marginBottom:10,border:"1px solid #1a4d25"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#86efac",letterSpacing:".1em",textTransform:"uppercase",marginBottom:4}}>Live Team Sync (same device)</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {hasFields ? <span className="badge badge-green">Field Officer Data Ready</span> : <span className="badge badge-gray">No Field Data Yet</span>}
              {hasTxns   ? <span className="badge badge-blue">Trader Data Ready</span>   : <span className="badge badge-gray">No Trade Data Yet</span>}
              {lastSync  && <span className="badge badge-gray">Synced: {lastSync}</span>}
            </div>
          </div>
          <button className={hasAny?"btn-gold btn-sm":"btn-ghost btn-sm"} onClick={onSync} disabled={!hasAny}>↓ Sync</button>
        </div>
      </div>

      {/* File-based import */}
      <div style={{background:"#0a140a",borderRadius:8,padding:"10px 12px",border:"1px solid #1a4d25"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#86efac",letterSpacing:".1em",textTransform:"uppercase",marginBottom:8}}>Import from File (cross-device)</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button className="btn-ghost btn-sm" style={{color:"#3ddc84",borderColor:"#3ddc8430"}} onClick={()=>fieldsRef.current?.click()}>
            📂 Import Fields (.json)
          </button>
          <button className="btn-ghost btn-sm" style={{color:"#5b9cf6",borderColor:"#5b9cf630"}} onClick={()=>tradesRef.current?.click()}>
            📂 Import Trades (.json)
          </button>
        </div>
        <input ref={fieldsRef} type="file" accept=".json" style={{display:"none"}} onChange={e=>handleFile(e,"fields")}/>
        <input ref={tradesRef} type="file" accept=".json" style={{display:"none"}} onChange={e=>handleFile(e,"trades")}/>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#7dff9e",marginTop:8}}>Use AgriHub .json exports generated by Field Officer and Trader</div>
      </div>
    </div>
  );
}

// ─── YIELD DIAGNOSTICS SCREEN (Admin Only) ────────────────────────────────────────────────
function YieldDiagnosticsScreen({ fields, settings }) {
  const harvestedFields = useMemo(() => {
    return fields.filter(f => f.harvest?.actual_tonnage);
  }, [fields]);

  const diagnosticsData = useMemo(() => {
    return harvestedFields.map(f => {
      const origEst = calculateOriginalEstimate({
        stalks: f.avg_stalks,
        nodes: f.avg_nodes,
        spacing: f.row_spacing,
        ratoonCycle: f.ratoon_cycle,
        acres: f.area_acres
      });
      const newEst = calculateNewEstimate({
        stalks: f.avg_stalks,
        nodes: f.avg_nodes,
        densityRating: f.density_rating || "fair",
        spacing: f.row_spacing,
        ratoonCycle: f.ratoon_cycle,
        acres: f.area_acres,
        settings
      });
      const actual = f.harvest.actual_tonnage;
      
      const origDiff = origEst - actual;
      const newDiff = newEst - actual;
      
      const origErr = origEst > 0 ? (origDiff / origEst) * 100 : 0;
      const newErr = newEst > 0 ? (newDiff / newEst) * 100 : 0;

      return {
        id: f.id,
        name: f.name,
        acres: f.area_acres || 0,
        densityRating: f.density_rating || "fair",
        origEst,
        newEst,
        actual,
        origDiff,
        newDiff,
        origErr,
        newErr
      };
    });
  }, [harvestedFields, settings]);

  const summary = useMemo(() => {
    if (diagnosticsData.length === 0) return null;
    
    let totalOrigErr = 0;
    let totalNewErr = 0;
    let totalOrigDiff = 0;
    let totalNewDiff = 0;
    
    diagnosticsData.forEach(d => {
      totalOrigErr += Math.abs(d.origErr);
      totalNewErr += Math.abs(d.newErr);
      totalOrigDiff += Math.abs(d.origDiff);
      totalNewDiff += Math.abs(d.newDiff);
    });

    const avgOrigErr = totalOrigErr / diagnosticsData.length;
    const avgNewErr = totalNewErr / diagnosticsData.length;
    const avgOrigDiff = totalOrigDiff / diagnosticsData.length;
    const avgNewDiff = totalNewDiff / diagnosticsData.length;

    return {
      count: diagnosticsData.length,
      avgOrigErr,
      avgNewErr,
      avgOrigDiff,
      avgNewDiff,
      improvement: avgOrigErr - avgNewErr
    };
  }, [diagnosticsData]);

  const exportCSV = () => {
    if (diagnosticsData.length === 0) return;
    const headers = ["Field Name", "Acres", "Density Rating", "Original Estimate (0.34398)", "New Estimate", "Actual Harvest (tons)", "Original Diff (tons)", "New Diff (tons)", "Original Error %", "New Error %"];
    const rows = diagnosticsData.map(d => [
      d.name,
      d.acres,
      d.densityRating.toUpperCase(),
      d.origEst.toFixed(1),
      d.newEst.toFixed(1),
      d.actual.toFixed(1),
      d.origDiff.toFixed(1),
      d.newDiff.toFixed(1),
      d.origErr.toFixed(1),
      d.newErr.toFixed(1)
    ]);
    
    const csvContent = [headers.join(","), ...rows.map(r => r.map(v => `"${v}"`).join(","))].join("\n");
    downloadFile(csvContent, "agrihub_yield_calibration_log.csv", "text/csv;charset=utf-8;");
  };

  return (
    <div style={{ paddingBottom: 100 }} className="fade">
      <div style={{ padding: "44px 20px 14px", borderBottom: "1px solid #1a4d25" }}>
        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 9, letterSpacing: ".2em", color: "#1a4d25", marginBottom: 2 }}>BIOMASS CALIBRATION & DIAGNOSTICS</div>
        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 36, letterSpacing: ".04em", color: "#1a4d25" }}>YIELD DIAGNOSTICS</div>
      </div>

      <div style={{ padding: "14px 20px 0", display: "flex", flexDirection: "column", gap: 16 }}>
        {summary ? (
          <>
            <div className="card" style={{ borderLeft: "4px solid #1a4d25" }}>
              <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#1a4d25", marginBottom: 8, letterSpacing: ".05em" }}>Calibration Summary Outcome</div>
              <div style={{ fontSize: 11, color: "#052011", marginBottom: 12 }}>
                Comparing the previous fixed coefficient (<span style={{ fontFamily: "monospace", fontWeight: "bold" }}>0.34398</span>) against the new density-configurable baseline (<span style={{ fontFamily: "monospace", fontWeight: "bold" }}>{settings.coeff_fair || 0.24}</span>) across <span style={{ fontWeight: "bold" }}>{summary.count}</span> harvested fields.
              </div>

              <div className="grid2" style={{ gap: 12, marginBottom: 12 }}>
                <div style={{ background: "#f3fbf7", padding: 10, borderRadius: 8, border: "1.5px solid #cfece4" }}>
                  <span className="label" style={{ fontSize: 8 }}>Original Formula Avg Error</span>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, color: "#c2410c" }}>{summary.avgOrigErr.toFixed(1)}%</div>
                  <span style={{ fontSize: 9, color: "#6b8e72" }}>Avg Diff: {summary.avgOrigDiff.toFixed(1)} tons</span>
                </div>
                <div style={{ background: "#f3fbf7", padding: 10, borderRadius: 8, border: "1.5px solid #1a4d25" }}>
                  <span className="label" style={{ fontSize: 8 }}>New Configurable Formula Avg Error</span>
                  <div style={{ fontFamily: "'Bebas Neue'", fontSize: 24, color: "#065f46" }}>{summary.avgNewErr.toFixed(1)}%</div>
                  <span style={{ fontSize: 9, color: "#1a4d25", fontWeight: "bold" }}>Avg Diff: {summary.avgNewDiff.toFixed(1)} tons</span>
                </div>
              </div>

              <div style={{ background: "#e6f4f0", padding: "8px 12px", borderRadius: 8, fontSize: 11, color: "#052011" }}>
                {summary.improvement > 0 ? (
                  <div>
                    🎉 <strong>Systematic overestimation reduced by {summary.improvement.toFixed(1)}%</strong>! The crop-density coefficient model significantly reduces field overvaluation and provides closer financial matches.
                  </div>
                ) : (
                  <div>
                    💡 The error difference is {summary.improvement.toFixed(1)}%. Modify the density coefficients in <strong>Settings</strong> to further fine-tune and calibrate estimated crop tonnage.
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#1a4d25", letterSpacing: ".05em" }}>Harvest Outcome Calibration Log</div>
                <button className="btn-gold btn-sm" onClick={exportCSV}>
                  📊 Export Calibration CSV
                </button>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="site-table" style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th>Field Name</th>
                      <th>Acres</th>
                      <th>Rating</th>
                      <th style={{ textAlign: "right" }}>Old Est (Err %)</th>
                      <th style={{ textAlign: "right" }}>New Est (Err %)</th>
                      <th style={{ textAlign: "right" }}>Actual Harvest</th>
                      <th style={{ textAlign: "right" }}>Err Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnosticsData.map(d => {
                      const errImproved = Math.abs(d.origErr) - Math.abs(d.newErr);
                      return (
                        <tr key={d.id}>
                          <td style={{ fontWeight: "bold" }}>{d.name}</td>
                          <td>{d.acres.toFixed(2)} ac</td>
                          <td>
                            <span className={`badge badge-${d.densityRating === "poor" ? "red" : d.densityRating === "good" ? "blue" : d.densityRating === "excellent" ? "green" : "gold"}`}>
                              {d.densityRating}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {d.origEst.toFixed(1)} t <span style={{ color: "#c2410c", fontSize: 9 }}>({d.origErr.toFixed(0)}%)</span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {d.newEst.toFixed(1)} t <span style={{ color: "#065f46", fontSize: 9, fontWeight: "bold" }}>({d.newErr.toFixed(0)}%)</span>
                          </td>
                          <td style={{ textAlign: "right", fontWeight: "bold", color: "#1a4d25" }}>{d.actual.toFixed(1)} t</td>
                          <td style={{ textAlign: "right", fontWeight: "bold" }}>
                            {errImproved >= 0 ? (
                              <span style={{ color: "#065f46" }}>+{errImproved.toFixed(0)}% improved</span>
                            ) : (
                              <span style={{ color: "#c2410c" }}>{errImproved.toFixed(0)}%</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🌾</div>
            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#1a4d25", marginBottom: 4 }}>No Harvest Records Logged Yet</div>
            <div style={{ fontSize: 11, color: "#6b8e72" }}>Go to the Fields screen and log the actual weight (tonnage) for fields to populate diagnostic calibration data.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── INVESTOR VIEW (Investor Decision-Making) ───────────────────────────────────────────────
function InvestorView({ fields, settings, setSettings }) {
  const [selectedField, setSelectedField] = useState(null);
  const [customCosts, setCustomCosts] = useState(0);
  const [editingHarvestCost, setEditingHarvestCost] = useState(false);
  const [harvestCostInput, setHarvestCostInput] = useState(settings.harvest_cost_per_ton);
  const [editingInvestorMargin, setEditingInvestorMargin] = useState(false);
  const [investorMarginInput, setInvestorMarginInput] = useState(settings.investor_profit_margin);
  const [editingWinchCost, setEditingWinchCost] = useState(false);
  const [winchCostInput, setWinchCostInput] = useState(settings.winch_cost_per_ton);

  const handleHarvestCostSave = () => {
    const val = parseFloat(harvestCostInput);
    if (val > 0) {
      setSettings(s => ({ ...s, harvest_cost_per_ton: val }));
      setEditingHarvestCost(false);
    }
  };

  const handleInvestorMarginSave = () => {
    const val = parseFloat(investorMarginInput);
    if (val >= 0 && val <= 100) {
      setSettings(s => ({ ...s, investor_profit_margin: val }));
      setEditingInvestorMargin(false);
    }
  };

  const handleWinchCostSave = () => {
    const val = parseFloat(winchCostInput);
    if (val >= 0) {
      setSettings(s => ({ ...s, winch_cost_per_ton: val }));
      setEditingWinchCost(false);
    }
  };

  const calculateFieldMetrics = (field) => {
    const estimatedTons = field.estimated_total_tons || 0;
    const distanceKm = field.distance_km || 0;
    const acres = field.area_acres || 0;
    
    return calculateInvestorReturn({
      estimatedTons,
      factoryPrice: settings.company_rate,
      distanceKm,
      acres,
      settings,
      customCosts
    });
  };

  const totalFields = fields.length;
  const totalAcres = fields.reduce((s, f) => s + (f.area_acres || 0), 0);
  const totalEstimatedTons = fields.reduce((s, f) => s + (f.estimated_total_tons || 0), 0);
  
  const totalMetrics = calculateInvestorReturn({
    estimatedTons: totalEstimatedTons,
    factoryPrice: settings.company_rate,
    distanceKm: fields.reduce((s, f) => s + (f.distance_km || 0), 0) / (totalFields || 1),
    acres: totalAcres,
    settings,
    customCosts: customCosts * totalFields
  });

  return (
    <div style={{ paddingBottom: 80 }} className="fade">
      <div style={{ padding: "44px 20px 20px", background: "linear-gradient(180deg,#0d1a10 0%,#0a150e 100%)", borderBottom: "1px solid #1a4d25" }}>
        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 32, letterSpacing: ".04em", color: "#3ddc84", marginBottom: 8 }}>
          INVESTOR VIEW
        </div>
        <div style={{ fontSize: 11, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>
          Decision-making dashboard for field investments
        </div>
      </div>

      <div style={{ padding: "16px 20px" }}>
        {/* Cost Configuration */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84", marginBottom: 12, letterSpacing: ".05em" }}>
            Cost Configuration
          </div>
          
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Harvest Cost */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span className="label">Harvest Cost per Ton</span>
                <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>Default: 300 KES/ton</div>
              </div>
              <div className="rate-pill">
                <span style={{ fontSize: 10, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>KES</span>
                {editingHarvestCost ? (
                  <input
                    className="rate-input"
                    type="number"
                    value={harvestCostInput}
                    onChange={e => setHarvestCostInput(e.target.value)}
                    onBlur={handleHarvestCostSave}
                    onKeyDown={e => e.key === "Enter" && handleHarvestCostSave()}
                    autoFocus
                  />
                ) : (
                  <span
                    style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#3ddc84", letterSpacing: ".03em", cursor: "text", minWidth: 60 }}
                    onClick={() => { setHarvestCostInput(settings.harvest_cost_per_ton); setEditingHarvestCost(true); }}
                  >
                    {settings.harvest_cost_per_ton}
                  </span>
                )}
                <span style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>/ton</span>
              </div>
              {!editingHarvestCost && (
                <button className="btn-ghost btn-sm" onClick={() => { setHarvestCostInput(settings.harvest_cost_per_ton); setEditingHarvestCost(true); }}>
                  edit
                </button>
              )}
              {editingHarvestCost && (
                <button className="btn-gold btn-sm" onClick={handleHarvestCostSave}>save</button>
              )}
            </div>

            {/* Investor Profit Margin */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span className="label">Investor Profit Margin</span>
                <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>Default: 10%</div>
              </div>
              <div className="rate-pill">
                {editingInvestorMargin ? (
                  <input
                    className="rate-input"
                    type="number"
                    value={investorMarginInput}
                    onChange={e => setInvestorMarginInput(e.target.value)}
                    onBlur={handleInvestorMarginSave}
                    onKeyDown={e => e.key === "Enter" && handleInvestorMarginSave()}
                    autoFocus
                  />
                ) : (
                  <span
                    style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#3ddc84", letterSpacing: ".03em", cursor: "text", minWidth: 60 }}
                    onClick={() => { setInvestorMarginInput(settings.investor_profit_margin); setEditingInvestorMargin(true); }}
                  >
                    {settings.investor_profit_margin}%
                  </span>
                )}
              </div>
              {!editingInvestorMargin && (
                <button className="btn-ghost btn-sm" onClick={() => { setInvestorMarginInput(settings.investor_profit_margin); setEditingInvestorMargin(true); }}>
                  edit
                </button>
              )}
              {editingInvestorMargin && (
                <button className="btn-gold btn-sm" onClick={handleInvestorMarginSave}>save</button>
              )}
            </div>

            {/* Winch Cost */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span className="label">Winch Cost per Ton</span>
                <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>Optional: 0 KES/ton</div>
              </div>
              <div className="rate-pill">
                <span style={{ fontSize: 10, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>KES</span>
                {editingWinchCost ? (
                  <input
                    className="rate-input"
                    type="number"
                    value={winchCostInput}
                    onChange={e => setWinchCostInput(e.target.value)}
                    onBlur={handleWinchCostSave}
                    onKeyDown={e => e.key === "Enter" && handleWinchCostSave()}
                    autoFocus
                  />
                ) : (
                  <span
                    style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#3ddc84", letterSpacing: ".03em", cursor: "text", minWidth: 60 }}
                    onClick={() => { setWinchCostInput(settings.winch_cost_per_ton); setEditingWinchCost(true); }}
                  >
                    {settings.winch_cost_per_ton}
                  </span>
                )}
                <span style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>/ton</span>
              </div>
              {!editingWinchCost && (
                <button className="btn-ghost btn-sm" onClick={() => { setWinchCostInput(settings.winch_cost_per_ton); setEditingWinchCost(true); }}>
                  edit
                </button>
              )}
              {editingWinchCost && (
                <button className="btn-gold btn-sm" onClick={handleWinchCostSave}>save</button>
              )}
            </div>

            {/* Custom Costs */}
            <div>
              <span className="label">Other Custom Costs (per field)</span>
              <input
                type="number"
                value={customCosts}
                onChange={e => setCustomCosts(parseFloat(e.target.value) || 0)}
                placeholder="0"
                style={{ marginTop: 4 }}
              />
            </div>
          </div>
        </div>

        {/* Overall Summary */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84", marginBottom: 12, letterSpacing: ".05em" }}>
            Portfolio Summary
          </div>
          <div className="grid2" style={{ gap: 8 }}>
            {[
              { l: "Fair Field Valuation", v: K(totalMetrics.fairFieldValuation), sub: `KES ${totalMetrics.valuationPerAcre.toLocaleString()}/acre` },
              { l: "Investor's Expected Profit", v: K(totalMetrics.investorProfit), sub: `${totalMetrics.investorProfitMargin}% margin` },
              { l: "Tonnage Estimate", v: fmt(totalEstimatedTons) + " t", sub: `${fmt(totalAcres)} acres surveyed` },
              { l: "Gross Revenue", v: K(totalMetrics.revenue), sub: `@ KES ${settings.company_rate}/ton` },
            ].map(({ l, v, sub }) => (
              <div key={l} className="card" style={{ padding: "14px", background: "linear-gradient(180deg,#0a150e 0%,#0d1a10 100%)" }}>
                <span className="label">{l}</span>
                <div className="stat-val" style={{ fontSize: 20, marginBottom: 2 }}>{v}</div>
                <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Cost Breakdown */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84", marginBottom: 12, letterSpacing: ".05em" }}>
            Cost Breakdown
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { l: "Harvest Cost", v: totalMetrics.harvestCost, c: "#ff8060" },
              { l: "Transport Cost", v: totalMetrics.transportCost, c: "#ff8060" },
              { l: "Winch Cost", v: totalMetrics.winchCost, c: "#ff8060" },
              { l: "Custom Costs", v: totalMetrics.customCosts, c: "#ff8060" },
              { l: "Total Operating Costs", v: totalMetrics.totalOpsCost, c: "#ffa540", bold: true },
              { l: "Gross Profit", v: totalMetrics.grossProfit, c: totalMetrics.grossProfit > 0 ? "#3ddc84" : "#ff6b4a", bold: true },
            ].map(({ l, v, c, bold }) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #0f1f14", paddingBottom: 4, fontWeight: bold ? "bold" : "normal" }}>
                <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: bold ? "#a7f3d0" : "#86efac" }}>{l}</span>
                <span style={{ fontFamily: "'Bebas Neue'", fontSize: bold ? 16 : 14, color: c }}>{K(v)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Field List */}
        <div className="card">
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84", marginBottom: 12, letterSpacing: ".05em" }}>
            Field Data
          </div>
          {fields.length === 0 ? (
            <div style={{ textAlign: "center", padding: "20px", color: "#7dff9e", fontSize: 11, fontFamily: "'DM Mono', monospace" }}>
              No fields surveyed yet
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {fields.map(field => {
                const metrics = calculateFieldMetrics(field);
                return (
                  <div
                    key={field.id}
                    className="card card-hover"
                    style={{ padding: "12px", cursor: "pointer", background: selectedField?.id === field.id ? "linear-gradient(180deg,#0a150e 0%,#0d1a10 100%)" : "" }}
                    onClick={() => setSelectedField(selectedField?.id === field.id ? null : field)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 14, color: "#3ddc84" }}>{field.name}</div>
                        <div style={{ fontSize: 9, color: "#7dff9e", fontFamily: "'DM Mono', monospace" }}>
                          {fmt(field.area_acres)} acres • {fmt(field.distance_km)} km • {metrics.transportZone}
                        </div>
                      </div>
                      <span className={`badge ${metrics.fairFieldValuation > 0 ? "badge-green" : "badge-red"}`}>
                        {K(metrics.fairFieldValuation)}
                      </span>
                    </div>
                    
                    {selectedField?.id === field.id && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #1a4d25" }}>
                        <div className="grid2" style={{ gap: 8, marginBottom: 8 }}>
                          <div>
                            <span className="label">Tonnage Estimate</span>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84" }}>{fmt(field.estimated_total_tons)} t</div>
                          </div>
                          <div>
                            <span className="label">Valuation/Acre</span>
                            <div style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#3ddc84" }}>KES {metrics.valuationPerAcre.toLocaleString()}</div>
                          </div>
                        </div>
                        <div style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#7dff9e" }}>
                          Investor Profit: {K(metrics.investorProfit)} ({metrics.investorProfitMargin}%)
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SYSTEM SETTINGS SCREEN (Admin Only) ──────────────────────────────────────────────────
function SettingsScreen({ settings, setSettings, onSync, onFileImport, lastSync, fields, transactions }) {
  const [localSettings, setLocalSettings] = useState(settings);
  const [users, setUsers] = useState(() => JSON.parse(localStorage.getItem("agrihub_users") || "[]"));
  const [newUser, setNewUser] = useState({ name: "", username: "", password: "", role: "Field Officer" });

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  // Re-read users from localStorage whenever a sync happens (cross-device)
  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem("agrihub_users") || "[]");
    setUsers(stored);
  }, [lastSync]);

  const handleChange = (key, val) => {
    setLocalSettings(s => ({ ...s, [key]: val }));
  };

  const handleSave = () => {
    setSettings(localSettings);
    alert("System settings updated successfully!");
  };

  const handleAddUser = () => {
    alert("Supabase Auth now manages sign-in accounts. Create the user in Supabase Authentication, then set user_metadata with name, username, role, and color.");
    return;

    if (!newUser.name || !newUser.username || !newUser.password) {
      alert("Please fill in all user fields.");
      return;
    }
    if (users.some(u => u.username.toLowerCase() === newUser.username.toLowerCase().trim())) {
      alert("A user with this username already exists.");
      return;
    }

    const colors = ["#3ddc84", "#5b9cf6", "#ffa540", "#a7f3d0", "#a855f7", "#ec4899"];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    
    const userRecord = {
      id: "u_" + Math.random().toString(36).slice(2, 9),
      name: newUser.name.trim(),
      username: newUser.username.toLowerCase().trim(),
      password: newUser.password,
      role: newUser.role,
      color: randomColor
    };

    const updatedUsers = [...users, userRecord];
    setUsers(updatedUsers);
    localStorage.setItem("agrihub_users", JSON.stringify(updatedUsers));
    setNewUser({ name: "", username: "", password: "", role: "Field Officer" });
    alert(`User "${userRecord.name}" created successfully!\nRole: ${userRecord.role}\nLogin details: ${userRecord.username} / ${userRecord.password}`);
  };

  const handleDeleteUser = (id) => {
    if (id === "admin") {
      alert("Cannot delete the default Admin account.");
      return;
    }
    if (!confirm("Are you sure you want to delete this user?")) return;
    const updated = users.filter(u => u.id !== id);
    setUsers(updated);
    localStorage.setItem("agrihub_users", JSON.stringify(updated));
  };

  return (
    <div style={{paddingBottom:100}} className="fade">
      <div style={{padding:"44px 20px 14px",borderBottom:"1px solid #1a4d25"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:2}}>SYSTEM CONFIGURATION &amp; OVERRIDES</div>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:36,letterSpacing:".04em",color:"#3ddc84"}}>SETTINGS</div>
      </div>

      <div style={{padding:"14px 20px 0",display:"flex",flexDirection:"column",gap:16}}>
        {/* Admin Data Import Banner */}
        <AdminSyncBanner onSync={onSync} onFileImport={onFileImport} lastSync={lastSync}/>

        {/* User Access & Credentials Management */}
        <div className="card" style={{borderColor: "#3ddc8430"}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#3ddc84",marginBottom:14,letterSpacing:".05em"}}>User Access &amp; Profiles</div>
          
          {/* Add User Form */}
          <div style={{background:"#0a140a", padding:12, borderRadius:8, border:"1px solid #1a4d25", marginBottom:14}}>
            <div style={{fontSize:10, fontFamily:"'DM Mono',monospace", color:"#3ddc84", marginBottom:10, textTransform:"uppercase"}}>Supabase Auth Managed</div>
            <div className="grid2" style={{gap:8, marginBottom:10}}>
              <div>
                <label className="label">Full Name</label>
                <input 
                  type="text" 
                  value={newUser.name} 
                  onChange={e => setNewUser(u => ({ ...u, name: e.target.value }))} 
                  placeholder="e.g. John Doe"
                  style={{fontSize:11, padding:"6px 8px"}}
                />
              </div>
              <div>
                <label className="label">Username</label>
                <input 
                  type="text" 
                  value={newUser.username} 
                  onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))} 
                  placeholder="e.g. johndoe"
                  style={{fontSize:11, padding:"6px 8px"}}
                />
              </div>
            </div>
            
            <div className="grid2" style={{gap:8, marginBottom:12}}>
              <div>
                <label className="label">Password</label>
                <input 
                  type="text" 
                  value={newUser.password} 
                  onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))} 
                  placeholder="password123"
                  style={{fontSize:11, padding:"6px 8px"}}
                />
              </div>
              <div>
                <label className="label">Distinctive Role</label>
                <select 
                  value={newUser.role} 
                  onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))} 
                  className="input" 
                  style={{width:"100%",background:"#0a0802",color:"#3ddc84",border:"1px solid #1a4d25",borderRadius:6,padding:"7px 8px",fontSize:11}}
                >
                  <option value="Field Officer">Field Officer</option>
                  <option value="Weighbridge Trader">Weighbridge Trader</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>
            </div>
            
            <button className="btn-gold" style={{width:"100%", fontSize:11, padding:"8px 12px"}} onClick={handleAddUser}>
              + Add User Account
            </button>
          </div>

          {/* User Accounts List */}
          <div style={{fontSize:10, fontFamily:"'DM Mono',monospace", color:"#86efac", marginBottom:6, textTransform:"uppercase"}}>Existing Team Accounts ({users.length})</div>
          <div style={{maxHeight:150, overflowY:"auto", display:"flex", flexDirection:"column", gap:6}}>
            {users.map(u => (
              <div key={u.id} style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 10px", background:"#050805", border:"1px solid #1a4d25", borderRadius:6}}>
                <div>
                  <div style={{fontSize:11, fontWeight:"bold", color:"#a7f3d0", display:"flex", alignItems:"center", gap:6}}>
                    <span style={{width:8, height:8, borderRadius:"50%", background:u.color}}/>
                    {u.name}
                  </div>
                  <div style={{fontSize:9, color:"#7dff9e", fontFamily:"'DM Mono',monospace", marginTop:2}}>
                    {u.username} . {u.role} . Pass: <span style={{color:"#86efac"}}>{u.password}</span>
                  </div>
                </div>
                {u.id !== "admin" && (
                  <button className="btn-ghost" style={{padding:"2px 8px", color:"#ff8060", border:"1px solid #ff806030", fontSize:9}} onClick={() => handleDeleteUser(u.id)}>
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Financial Benchmarks */}
        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Financial Rates (KES)</div>
          
          <div style={{marginBottom:10}}>
            <label className="label">Factory Purchase Rate (KES / ton)</label>
            <input 
              type="number" 
              value={localSettings.company_rate} 
              onChange={e => handleChange("company_rate", +e.target.value)}
              placeholder="e.g. 11050"
            />
          </div>

          <div style={{marginBottom:10}}>
            <label className="label">Weighbridge Buying Rate (KES / ton)</label>
            <input 
              type="number" 
              value={localSettings.buy_rate} 
              onChange={e => handleChange("buy_rate", +e.target.value)}
              placeholder="e.g. 8060"
            />
          </div>

          <div style={{marginBottom:10}}>
            <label className="label">Field Buying / Acquisition Price (KES / acre)</label>
            <input 
              type="number" 
              value={localSettings.cost_per_acre} 
              onChange={e => handleChange("cost_per_acre", +e.target.value)}
              placeholder="e.g. 156000"
            />
          </div>

          <div style={{marginBottom:10}}>
            <label className="label">Target Profitability (%)</label>
            <input 
              type="number" 
              min={10}
              max={25}
              value={localSettings.target_profitability} 
              onChange={e => {
                const v = Math.max(10, Math.min(25, +e.target.value));
                handleChange("target_profitability", v);
              }}
              placeholder="e.g. 18"
            />
            <div style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginTop:4}}>Range 10% - 25%. Determines the recommended farmer payout.</div>
          </div>
        </div>

        {/* Yield Forecasting Multipliers */}
        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Yield Estimation Baseline</div>
          <div style={{marginBottom:10}}>
            <label className="label">Estimated Sugarcane Yield per Acre (Tons / Acre)</label>
            <input 
              type="number" 
              value={localSettings.est_tons_per_acre} 
              onChange={e => handleChange("est_tons_per_acre", +e.target.value)}
              placeholder="e.g. 30"
            />
            <div style={{fontSize:9,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginTop:4}}>Standard standard used for field boundary estimations.</div>
          </div>
        </div>

        {/* Agronomic Density Coefficients */}
        <div className="card">
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:14,letterSpacing:".05em"}}>Agronomic Density Coefficients</div>
          <div style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginBottom:12}}>
            Configure the sugarcane biomass density coefficients used in yield calculations based on cane density ratings:
          </div>
          <div className="grid2" style={{gap:10, marginBottom:10}}>
            <div>
              <label className="label">Poor Density Rating</label>
              <input 
                type="number" 
                step="0.01"
                value={localSettings.coeff_poor ?? 0.22} 
                onChange={e => handleChange("coeff_poor", +e.target.value)}
                placeholder="0.22"
              />
            </div>
            <div>
              <label className="label">Fair Density Rating (Default)</label>
              <input 
                type="number" 
                step="0.01"
                value={localSettings.coeff_fair ?? 0.24} 
                onChange={e => handleChange("coeff_fair", +e.target.value)}
                placeholder="0.24"
              />
            </div>
          </div>
          <div className="grid2" style={{gap:10, marginBottom:10}}>
            <div>
              <label className="label">Good Density Rating</label>
              <input 
                type="number" 
                step="0.01"
                value={localSettings.coeff_good ?? 0.27} 
                onChange={e => handleChange("coeff_good", +e.target.value)}
                placeholder="0.27"
              />
            </div>
            <div>
              <label className="label">Excellent Density Rating</label>
              <input 
                type="number" 
                step="0.01"
                value={localSettings.coeff_excellent ?? 0.30} 
                onChange={e => handleChange("coeff_excellent", +e.target.value)}
                placeholder="0.30"
              />
            </div>
          </div>
        </div>

        <button className="btn-gold" onClick={handleSave} style={{padding:"14px",fontWeight:600}}>
          Save Settings &amp; Benchmarks
        </button>

        <div className="card" style={{borderColor:"#3ddc8430"}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"#a7f3d0",marginBottom:8,letterSpacing:".05em"}}>Export Reports</div>
          <div style={{fontSize:10,color:"#7dff9e",fontFamily:"'DM Mono',monospace",marginBottom:12}}>Generate a comprehensive PDF report of all field data, transactions, and financial summaries.</div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn-gold" style={{flex:1,fontSize:11,padding:"12px 14px"}} onClick={()=>generateReportPDF({fields, transactions, settings, title: "Complete Season Report"})}>
              📄 Full Season Report
            </button>
            <button className="btn-ghost" style={{flex:1,fontSize:11,padding:"12px 14px"}} onClick={()=>generateReportPDF({fields, transactions, settings, title: "Financial Summary"})}>
              📊 Financial Only
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── ROLE HOME SCREENS ────────────────────────────────────────────────────────
function OfficerHome() {
  return (
    <div style={{padding:"60px 20px 20px",textAlign:"center"}}>
      <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:8}}>FIELD DATA OFFICER</div>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:38,color:"#3ddc84",lineHeight:1,marginBottom:8}}>Field Survey Mode</div>
      <div style={{fontFamily:"'Crimson Pro',serif",fontStyle:"italic",fontSize:13,color:"#7dff9e",marginBottom:24}}>Record field boundaries, survey data and site accessibility. Your data syncs to the admin dashboard.</div>
      <div style={{background:"#0d1a0d",border:"1px solid #3ddc8430",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#3ddc84",letterSpacing:".1em",marginBottom:4}}>YOUR CONTRIBUTION</div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#7dff9e"}}>All field data you add is automatically saved and made available to Admin for import.</div>
      </div>
    </div>
  );
}

function TraderHome() {
  return (
    <div style={{padding:"60px 20px 20px",textAlign:"center"}}>
      <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:".2em",color:"#7dff9e",marginBottom:8}}>WEIGHBRIDGE TRADER</div>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:38,color:"#5b9cf6",lineHeight:1,marginBottom:8}}>Trade Desk Mode</div>
      <div style={{fontFamily:"'Crimson Pro',serif",fontStyle:"italic",fontSize:13,color:"#7dff9e",marginBottom:24}}>Log cane purchases, weighbridge entries and payout calculations. All transactions sync to admin.</div>
      <div style={{background:"#0a0d1a",border:"1px solid #5b9cf630",borderRadius:12,padding:"14px 16px"}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#5b9cf6",letterSpacing:".1em",marginBottom:4}}>YOUR CONTRIBUTION</div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#7dff9e"}}>All transactions you record are automatically saved and made available to Admin for import.</div>
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen]           = useState("dashboard");
  const [fields, setFields]           = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [settings, setSettings]       = useState(() => {
    const saved = localStorage.getItem("agrihub_settings");
    if (saved) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      } catch (e) {
        console.error("Failed to parse settings from localStorage:", e);
      }
    }
    return DEFAULT_SETTINGS;
  });
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [syncing, setSyncing]         = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(() => localStorage.getItem("agrihub_last_sync") || null);
  const [theme, setTheme]             = useState(() => {
    const saved = localStorage.getItem("agrihub_theme");
    return saved === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session?.user) {
        setToken(data.session.access_token);
        setCurrentUser(supabaseUserToAppUser(data.session.user));
      } else {
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (session?.user) {
        setToken(session.access_token);
        setCurrentUser(supabaseUserToAppUser(session.user));
      } else {
        setToken(null);
        localStorage.removeItem("agrihub_user");
        setCurrentUser(null);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("agrihub_theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === "light" ? "dark" : "light");

  const handleSync = async () => {
    if (!currentUser) return;
    setSyncing(true);
    try {
      // 1. Load local data
      const localFields = JSON.parse(localStorage.getItem("agrihub_fields") || "[]");
      const localTxns = JSON.parse(localStorage.getItem("agrihub_transactions") || "[]");
      const localUsers = JSON.parse(localStorage.getItem("agrihub_users") || "[]");

      // Tag any local fields and transactions that were created by the current user
      const updatedLocalFields = localFields.map(f => {
        if (!f.created_by) f.created_by = currentUser.name;
        if (!f.synced_by) f.synced_by = currentUser.username;
        f.synced_at = new Date().toISOString();
        return f;
      });

      const updatedLocalTxns = localTxns.map(t => {
        if (!t.created_by) t.created_by = currentUser.name;
        if (!t.synced_by) t.synced_by = currentUser.username;
        t.synced_at = new Date().toISOString();
        return t;
      });

      // Save back updated tagged data to local storage
      localStorage.setItem("agrihub_fields", JSON.stringify(updatedLocalFields));
      localStorage.setItem("agrihub_transactions", JSON.stringify(updatedLocalTxns));

      // 2. Perform Supabase Upsert
      if (localUsers.length > 0) {
        const usersToSync = localUsers.map(u => ({
          id: u.id,
          username: u.username,
          password: u.password,
          role: u.role,
          name: u.name,
          color: u.color
        }));
        await supabase.from("agrihub_users").upsert(usersToSync);
      }

      if (updatedLocalFields.length > 0) {
        await supabase.from("agrihub_fields").upsert(updatedLocalFields);
      }

      if (updatedLocalTxns.length > 0) {
        await supabase.from("agrihub_transactions").upsert(updatedLocalTxns);
      }

      // 3. Fetch remote updates from Supabase (Two-way sync!)
      const { data: remoteUsers } = await supabase.from("agrihub_users").select("*");
      const { data: remoteFields } = await supabase.from("agrihub_fields").select("*");
      const { data: remoteTxns } = await supabase.from("agrihub_transactions").select("*");

      if (remoteUsers) {
        localStorage.setItem("agrihub_users", JSON.stringify(remoteUsers));
      }
      if (remoteFields) {
        localStorage.setItem("agrihub_fields", JSON.stringify(remoteFields));
        setFields(remoteFields);
      } else {
        setFields(updatedLocalFields);
      }
      if (remoteTxns) {
        localStorage.setItem("agrihub_transactions", JSON.stringify(remoteTxns));
        setTransactions(remoteTxns);
      } else {
        setTransactions(updatedLocalTxns);
      }

      // 4. Update sync timestamp
      const nowStr = new Date().toLocaleTimeString("en-KE", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      localStorage.setItem("agrihub_last_sync", nowStr);
      setLastSyncTime(nowStr);
      alert(`Sync Successful!\n- Fields Synced: ${updatedLocalFields.length}\n- Transactions Synced: ${updatedLocalTxns.length}\nAll data is now reflected in the cloud.`);
    } catch (err) {
      console.warn("Supabase sync failed:", err);
      const nowStr = new Date().toLocaleTimeString("en-KE", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      localStorage.setItem("agrihub_last_sync", nowStr);
      setLastSyncTime(nowStr);
      const errMsg = err?.message || err?.error_description || String(err);
      alert(`⚠️ Sync Error\n${errMsg}\n\nYour local data is safe. Retrying will push changes once the connection is restored.`);
    } finally {
      setSyncing(false);
    }
  };

  // Silent background pull from Supabase (no alerts, no spinner)
  const pullFromCloud = useCallback(async () => {
    try {
      const [{ data: remoteFields }, { data: remoteTxns }, { data: remoteUsers }] = await Promise.all([
        supabase.from("agrihub_fields").select("*"),
        supabase.from("agrihub_transactions").select("*"),
        supabase.from("agrihub_users").select("*")
      ]);

      if (remoteFields && remoteFields.length > 0) {
        localStorage.setItem("agrihub_fields", JSON.stringify(remoteFields));
        setFields(remoteFields);
      }
      if (remoteTxns && remoteTxns.length > 0) {
        localStorage.setItem("agrihub_transactions", JSON.stringify(remoteTxns));
        setTransactions(remoteTxns);
      }
      if (remoteUsers && remoteUsers.length > 0) {
        localStorage.setItem("agrihub_users", JSON.stringify(remoteUsers));
      }
    } catch (err) {
      console.warn("Background cloud pull unavailable:", err);
    }
  }, []);

  // Sync settings state to localStorage on any change
  useEffect(() => {
    localStorage.setItem("agrihub_settings", JSON.stringify(settings));
  }, [settings]);

  // Load data from backend after login
  const loadData = useCallback(async () => {
    if (!currentUser) return;
    try {
      const [f, t, d] = await Promise.all([
        api.getFields().catch(() => []),
        api.getTransactions().catch(() => []),
        api.dashboard().catch(() => null),
      ]);
      setFields(f);
      setTransactions(t);

      // Silent background pull from cloud for cross-device sync
      await pullFromCloud();
    } catch (e) {
      console.error("Failed to load data:", e);
    } finally {
      setLoading(false);
    }
  }, [currentUser, pullFromCloud]);

  useEffect(() => {
    if (currentUser) {
      loadData();
    } else {
      setLoading(false);
    }
  }, [currentUser, loadData]);

  const handleLogin = async (user, accessToken) => {
    if (accessToken) setToken(accessToken);
    setCurrentUser(user);
    setLoading(true);
    if (user.role === "Field Officer") {
      setScreen("fields");
    } else if (user.role === "Weighbridge Trader") {
      setScreen("weighbridge");
    } else {
      setScreen("dashboard");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("agrihub_user");
    setToken(null);
    setCurrentUser(null);
    setFields([]);
    setTransactions([]);
    setScreen("dashboard");
  };

  if (!currentUser) return (
    <div className="app-layout" style={{justifyContent:"center",alignItems:"center"}}>
      <style>{CSS}</style>
      <div style={{width:"100%",maxWidth:400}}>
        <LoginScreen onLogin={handleLogin}/>
      </div>
    </div>
  );

  if (loading && fields.length === 0 && transactions.length === 0) return (
    <div className="app-layout" style={{justifyContent:"center",alignItems:"center"}}>
      <style>{CSS}</style>
      <div style={{textAlign:"center",color:"#3ddc84",fontFamily:"'Bebas Neue'",fontSize:24}} className="blink">LOADING...</div>
    </div>
  );

  const isAdmin   = currentUser.role === "Admin";
  const isOfficer = currentUser.role === "Field Officer";
  const isTrader  = currentUser.role === "Weighbridge Trader";

  return (
    <div className="app-layout">
      <style>{CSS}</style>
      <Nav screen={screen} setScreen={setScreen} role={currentUser.role}/>

      <div className="main-content">
      {/* Top Header Controls */}
      <div style={{position:"fixed",top:8,right:8,zIndex:200,display:"flex",alignItems:"center",gap:8}}>
        {/* Sync Button for Cloud Integration */}
        <button 
          onClick={handleSync} 
          disabled={syncing}
          className="btn-gold" 
          style={{
            padding: "6px 12px", 
            fontSize: 10, 
            display: "flex", 
            alignItems: "center", 
            gap: 6, 
            borderRadius: 20,
            background: syncing ? "var(--bg-alt)" : "var(--bg-inverse)",
            borderColor: syncing ? "var(--border)" : "var(--bg-inverse)",
            color: syncing ? "var(--text-muted)" : "var(--text-inverse)",
            boxShadow: "0 4px 12px var(--shadow-strong)",
            cursor: "pointer"
          }}
          title="Sync local offline data to/from Supabase Cloud"
        >
          <span>{syncing ? "⏳ Syncing..." : "☁ Sync Cloud"}</span>
          {lastSyncTime && (
            <span style={{fontSize: 8, opacity: 0.8, fontFamily: "'DM Mono',monospace"}}>
              ({lastSyncTime})
            </span>
          )}
        </button>

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          title={theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--bg-inverse)",
            color: "var(--text-inverse)",
            border: "1.5px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            cursor: "pointer",
            boxShadow: "0 2px 8px var(--shadow)"
          }}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>

        {/* User pill */}
        <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--bg-card)",border:"1px solid var(--border)",borderRadius:20,padding:"5px 10px 5px 8px",boxShadow:"0 4px 12px var(--shadow-strong)"}}>
          <div style={{width:22,height:22,borderRadius:"50%",background:"var(--bg-alt)",border:`1px solid var(--border)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:11,color:"var(--text-primary)"}}>{currentUser.name[0]}</span>
          </div>
          <div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"var(--text-primary)",lineHeight:1.2}}>{currentUser.name.split(" ")[0]}</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"var(--text-muted)",letterSpacing:".06em"}}>{currentUser.role}</div>
          </div>
          <button onClick={handleLogout} style={{background:"none",border:"none",color:"var(--text-muted)",fontSize:14,cursor:"pointer",padding:"0 2px",lineHeight:1}} title="Sign out">⏻</button>
        </div>
      </div>

      {/* Role-gated screens */}
      {isOfficer && screen==="fields"     && <FieldsScreen fields={fields} setFields={setFields} settings={settings} role={currentUser.role} user={currentUser}/>}
      {isTrader  && screen==="weighbridge" && <WeighbridgeScreen transactions={transactions} setTransactions={setTransactions} settings={settings} setSettings={setSettings} role={currentUser.role} user={currentUser}/>}

      {isAdmin && screen==="dashboard"    && <Dashboard fields={fields} transactions={transactions} settings={settings} setSettings={setSettings}/>}
      {isAdmin && screen==="investor"     && <InvestorView fields={fields} settings={settings} setSettings={setSettings}/>}
      {isAdmin && screen==="fields"       && <FieldsScreen fields={fields} setFields={setFields} settings={settings} role={currentUser.role} user={currentUser}/>}
      {isAdmin && screen==="weighbridge"  && <WeighbridgeScreen transactions={transactions} setTransactions={setTransactions} settings={settings} setSettings={setSettings} role={currentUser.role} user={currentUser}/>}
      {isAdmin && screen==="reports"      && <ReportsScreen fields={fields} transactions={transactions} settings={settings}/>}
      {(isAdmin || isOfficer) && screen==="diagnostics"  && <YieldDiagnosticsScreen fields={fields} settings={settings}/>}
      {isAdmin && screen==="settings"     && <SettingsScreen settings={settings} setSettings={setSettings} onSync={handleSync} onFileImport={()=>{}} lastSync={lastSyncTime} fields={fields} transactions={transactions}/>}
      </div>
    </div>
  );
}
