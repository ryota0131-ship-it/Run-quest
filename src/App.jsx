import React, { useState, useCallback, useEffect } from "react";
import { storage } from "./lib/storage";
import { supabase } from "./lib/supabaseClient";
import { signInWithGoogle, signOut, loadMyPlayerRow, playerKeyForUser } from "./lib/auth";
import { Flame, HeartPulse, Footprints, ChevronRight, X, Settings, LogOut } from "lucide-react";

// ---------- Game economy (RUN QUEST BIBLE v0.3) ----------

function expForLevel(n) {
  if (n < 10) return 100 + 78 * (n - 1);
  return 450 * Math.pow(1.04, n - 10);
}

function getLevelState(totalExp) {
  let level = 1;
  let remaining = totalExp;
  while (true) {
    const need = expForLevel(level);
    if (remaining < need) return { level, into: Math.round(remaining), need: Math.round(need) };
    remaining -= need;
    level += 1;
    if (level > 200) return { level, into: 0, need: Math.round(expForLevel(level)) };
  }
}

// 称号: title changes with level band (lightweight, reinforces "meaning of level")
function titleForLevel(lv) {
  if (lv >= 80) return "マラソンマスター";
  if (lv >= 50) return "挑戦者";
  if (lv >= 35) return "冒険者";
  if (lv >= 20) return "続ける力";
  if (lv >= 10) return "走り始めた人";
  return "はじめの一歩";
}

// ---------- Monster battles ----------
// Three parallel solo tracks (normal / training / boss) the player can switch
// between freely without losing progress, plus a shared clan monster anyone
// can join alongside whichever solo track they're fighting.

const MONSTER_KINDS = ["slime", "wolf", "dragon"];
const MONSTER_NAMES = { slime: "スライム", wolf: "ウルフ", dragon: "ドラゴン" };

// Monster art pools (original pixel-art sprites, background-removed, base64-embedded)
const NORMAL_MONSTER_POOL = [
  { name: "グリーンシード", img: "/assets/normal_greenseed.png", aspect: 112/110 },
  { name: "ラビッツ", img: "/assets/normal_rabbitz.png", aspect: 94/110 },
  { name: "ヴェノスネイク", img: "/assets/normal_venosnake.png", aspect: 102/110 }
];

const TRAINING_MONSTER_POOL = [
  { name: "ブルホーン", img: "/assets/training_bullhorn.png", aspect: 102/110 },
  { name: "オークアックス", img: "/assets/training_orcaxe.png", aspect: 90/110 },
  { name: "フェンリル", img: "/assets/training_fenrir.png", aspect: 132/110 }
];

const SHOP_ITEMS = [
  { id: "damageBoost", name: "ダメージブースト", desc: "次の1回だけ、ダメージ+30%", cost: 50, icon: "⚡" },
  { id: "recoveryTicket", name: "回復チケット", desc: "次回、条件なしで回復ボーナス+20EXP", cost: 30, icon: "💊" },
];

const BOSS_MONSTER_POOL = [
  { name: "フレイムキング", img: "/assets/boss_flame_king.png", aspect: 108/140 },
  { name: "オメガスライム", img: "/assets/boss_omega_slime.png", aspect: 96/140 },
  { name: "ダンデリオルドゴーレム", img: "/assets/boss_dunderiord_golem.png", aspect: 105/140 },
  { name: "ホロウリーパー", img: "/assets/boss_hollow_reaper.png", aspect: 87/140 },
  { name: "ヴェノムウィドウ", img: "/assets/boss_venom_widow.png", aspect: 73/140 },
  { name: "エルダーウィジョンガーディアン", img: "/assets/boss_elderwtion_guardian.png", aspect: 85/140 }
];

const CLAN_MONSTER_POOL = [
  { name: "エバーフレイムドラゴン", img: "/assets/clan_everflame_dragon.png", aspect: 97/130 },
  { name: "ウィンドドレイクリング", img: "/assets/clan_wind_drakeling.png", aspect: 88/130 },
  { name: "ブロッサムハッチリング", img: "/assets/clan_blossom_hatchling.png", aspect: 95/130 },
  { name: "ペブルワーム", img: "/assets/clan_pebble_wyrm.png", aspect: 72/130 },
  { name: "グリッドレイク", img: "/assets/clan_gliddrake.png", aspect: 66/130 },
  { name: "サンダーワイバーン", img: "/assets/clan_thunder_wyvern.png", aspect: 75/130 }
];

// Damage a single run deals, before any track-specific gating.
// - base: distance × 20
// - pace bonus: only applies if minutes were entered (faster pace → higher multiplier)
// - long-run bonus: flat bonus for a single long-distance run
function computeDamage(distance, minutes) {
  const base = Math.round(distance * 20);
  let paceMult = 1.0;
  let pace = null;
  if (minutes > 0 && distance > 0) {
    pace = minutes / distance;
    if (pace <= 6) paceMult = 1.5;
    else if (pace <= 7) paceMult = 1.3;
    else if (pace <= 8) paceMult = 1.15;
  }
  let longRunBonus = 0;
  if (distance >= 5) longRunBonus = 80;
  else if (distance >= 3) longRunBonus = 40;
  const total = Math.round(base * paceMult) + longRunBonus;
  return { base, paceMult, pace, longRunBonus, total };
}

function bestDistanceSoFar(runs) {
  return runs.reduce((m, r) => Math.max(m, r.distance), 0);
}

function bestPaceSoFar(runs) {
  const paced = runs.filter((r) => r.distance > 0 && r.minutes > 0).map((r) => r.minutes / r.distance);
  return paced.length ? Math.min(...paced) : null;
}

function runsInWindow(runs, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  return runs.filter((r) => r.date >= cutoffISO);
}

function normalMonsterInfo(user) {
  const n = user.normalKillCount || 0;
  const art = NORMAL_MONSTER_POOL[n % NORMAL_MONSTER_POOL.length];
  return { img: art.img, aspect: art.aspect, name: art.name, hp: 100 + n * 60, damage: user.normalDamage || 0 };
}

function trainingMonsterInfo(user) {
  const n = user.trainingKillCount || 0;
  const art = TRAINING_MONSTER_POOL[n % TRAINING_MONSTER_POOL.length];
  return { img: art.img, aspect: art.aspect, name: `特訓の${art.name}`, hp: 150 + n * 80, damage: user.trainingDamage || 0 };
}

function bossMonsterInfo(user) {
  const n = user.bossCycle || 0;
  const art = BOSS_MONSTER_POOL[n % BOSS_MONSTER_POOL.length];
  return { img: art.img, aspect: art.aspect, name: art.name, hp: 600 + n * 300, damage: user.bossDamage || 0 };
}

// Looks up sprite art for a bestiary entry name across all monster pools
// (normal / training / boss / clan), since the bestiary only stores names.
function findMonsterArt(name) {
  let found = NORMAL_MONSTER_POOL.find((m) => m.name === name);
  if (found) return found;
  found = TRAINING_MONSTER_POOL.find((m) => `特訓の${m.name}` === name);
  if (found) return { ...found, name: `特訓の${found.name}` };
  found = BOSS_MONSTER_POOL.find((m) => m.name === name);
  if (found) return found;
  found = CLAN_MONSTER_POOL.find((m) => `クラン討伐:${m.name}` === name);
  if (found) return { ...found, name: `クラン討伐:${found.name}` };
  return null;
}

// ---------- Menus: optional, multi-selectable trackers layered on top of the main quest ----------
const MENU_CONFIG = {
  diet: {
    id: "diet",
    name: "ダイエット管理",
    icon: Flame,
    desc: "体重を記録して、目標の減量に近づく",
  },
  habit: {
    id: "habit",
    name: "生活習慣管理",
    icon: HeartPulse,
    desc: "週の実施回数で、継続そのものを評価する",
  },
  stress: {
    id: "stress",
    name: "ストレス発散管理",
    icon: Footprints,
    desc: "ラン後の気分を記録して、発散できているか見る",
  },
};

const MOOD_OPTIONS = ["スッキリ", "まあまあ", "もやもや"];

const MILESTONES = [
  { km: 1, exp: 100, label: "初・1km到達" },
  { km: 2, exp: 100, label: "初・2km到達" },
  { km: 3, exp: 100, label: "初・3km到達" },
  { km: 5, exp: 300, label: "初5km達成" },
  { km: 10, exp: 600, label: "初10km達成" },
];

function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

function comebackMultiplier(days) {
  if (days <= 2) return 1.0;
  if (days <= 4) return 1.2;
  if (days <= 7) return 1.4;
  return 1.6;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// アスト (whale mascot) messages by context
function astMessage(ctx) {
  if (ctx === "fatigue") return "無理しなくていい。休むことも、未来への準備だよ。";
  if (ctx === "sabori3") return "ここまで来た。焦らなくていい。一歩ずつでいい。";
  if (ctx === "sabori5") return "久しぶりだね。積み上げた分は消えていないよ。";
  if (ctx === "sabori8") return "おかえり。次の一歩は、いつもより成長しやすいよ。";
  if (ctx === "levelup") return "レベルは、昨日の自分を少し超えた証だよ。";
  return "今日も一歩だけ、未来に近づこう!";
}

// ---------- Design tokens (traced from the pixel-art RPG moodboard) ----------
// Tailwind arbitrary-value classes (bg-[#...]) do NOT compile in this runtime,
// so all custom colors are inline styles.

const C = {
  skyTop: "#7FC8F0",
  skyBottom: "#A9DCF5",
  cloud: "#FFFFFF",
  paper: "#F4EFE3",     // cream body
  panel: "#FFFFFF",
  panelBorder: "#E4DBC7",
  ink: "#2B2A26",       // near-black warm text
  inkSoft: "#6E6A5F",
  inkFaint: "#9A9484",
  gold: "#F2B33D",
  goldDeep: "#D9922A",
  green: "#7BB661",
  greenSoft: "#E6F0DC",
  greenBorder: "#C4DDB0",
  blueTag: "#3E6FB0",
  night: "#20355C",     // header text block / boss card
  nightSoft: "#33477040",
  whale: "#3E5C8A",
  cardShadow: "0 2px 0 rgba(0,0,0,0.08)",
};

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=DotGothic16&family=Zen+Maru+Gothic:wght@500;700;900&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap');
  .rq-pixel { font-family: 'DotGothic16', sans-serif; }
  .rq-display { font-family: 'Zen Maru Gothic', sans-serif; }
  .rq-body { font-family: 'Zen Kaku Gothic New', sans-serif; }
  .fs11 { font-size: 11px; }
  .fs10 { font-size: 10px; }
`;

// Small pixel whale (アスト) drawn as inline SVG so no assets are needed
function Ast({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-label="アスト">
      <g fill={C.whale}>
        <rect x="3" y="5" width="9" height="6" />
        <rect x="2" y="6" width="1" height="4" />
        <rect x="12" y="6" width="2" height="1" />
        <rect x="12" y="9" width="2" height="1" />
        <rect x="13" y="5" width="1" height="1" />
        <rect x="13" y="10" width="1" height="1" />
      </g>
      <rect x="4" y="10" width="7" height="2" fill="#AFC6E4" />
      <rect x="5" y="6" width="1" height="1" fill="#fff" />
      <rect x="4" y="4" width="2" height="1" fill={C.whale} />
    </svg>
  );
}

// Pixel-art monster icons for the main quest (original designs, no external assets)
// Renders an image-based monster sprite (from NORMAL_MONSTER_POOL / TRAINING_MONSTER_POOL),
// contained within a fixed square box regardless of the source image's aspect ratio.
function MonsterArt({ img, aspect = 1, size = 40 }) {
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "hidden" }}>
      <img
        src={img}
        alt="monster"
        style={{ imageRendering: "pixelated", display: "block", maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" }}
      />
    </div>
  );
}

function MonsterIcon({ kind = "slime", size = 40 }) {
  if (kind === "wolf") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 14" shapeRendering="crispEdges" aria-label="ウルフ">
        <rect x="1" y="1" width="3" height="3" fill="#5B5468" />
        <rect x="12" y="1" width="3" height="3" fill="#5B5468" />
        <rect x="0" y="3" width="2" height="2" fill="#3A3548" />
        <rect x="14" y="3" width="2" height="2" fill="#3A3548" />
        <rect x="2" y="4" width="12" height="7" fill="#6C6478" />
        <rect x="2" y="4" width="4" height="3" fill="#7D7589" />
        <rect x="10" y="4" width="4" height="3" fill="#7D7589" />
        <rect x="5" y="8" width="6" height="4" fill="#8B849A" />
        <rect x="4" y="6" width="2" height="2" fill="#D94C4C" />
        <rect x="10" y="6" width="2" height="2" fill="#D94C4C" />
        <rect x="4" y="6" width="1" height="1" fill="#ffe08a" />
        <rect x="10" y="6" width="1" height="1" fill="#ffe08a" />
        <rect x="6" y="11" width="1" height="2" fill="#ffffff" />
        <rect x="9" y="11" width="1" height="2" fill="#ffffff" />
        <rect x="6" y="10" width="4" height="1" fill="#3A3548" />
      </svg>
    );
  }
  if (kind === "dragon") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 13" shapeRendering="crispEdges" aria-label="ドラゴン">
        <rect x="1" y="3" width="3" height="6" fill="#7A1F2B" />
        <rect x="12" y="3" width="3" height="6" fill="#7A1F2B" />
        <rect x="0" y="1" width="2" height="2" fill="#2B2A26" />
        <rect x="14" y="1" width="2" height="2" fill="#2B2A26" />
        <rect x="3" y="0" width="2" height="2" fill="#4A4340" />
        <rect x="11" y="0" width="2" height="2" fill="#4A4340" />
        <rect x="3" y="3" width="10" height="7" fill="#B33A3A" />
        <rect x="3" y="3" width="10" height="2" fill="#C94848" />
        <rect x="5" y="5" width="2" height="2" fill="#FFD24C" />
        <rect x="9" y="5" width="2" height="2" fill="#FFD24C" />
        <rect x="5" y="5" width="1" height="1" fill="#2B2A26" />
        <rect x="9" y="5" width="1" height="1" fill="#2B2A26" />
        <rect x="6" y="9" width="4" height="2" fill="#8C2E2E" />
        <rect x="7" y="11" width="1" height="1" fill="#FFA23A" />
        <rect x="8" y="11" width="1" height="1" fill="#FFD24C" />
      </svg>
    );
  }
  // slime (default)
  return (
    <svg width={size} height={size} viewBox="0 0 14 15" shapeRendering="crispEdges" aria-label="スライム">
      <rect x="4" y="10" width="8" height="4" fill="#3F8F3F" />
      <rect x="3" y="8" width="10" height="2" fill="#4CAF50" />
      <rect x="2" y="6" width="12" height="2" fill="#5CBF5C" />
      <rect x="3" y="4" width="10" height="2" fill="#6FCF6F" />
      <rect x="5" y="2" width="6" height="2" fill="#7FDD7F" />
      <rect x="4" y="12" width="8" height="2" fill="#2E7D32" />
      <rect x="6" y="7" width="2" height="2" fill="#123312" />
      <rect x="9" y="7" width="2" height="2" fill="#123312" />
      <rect x="6" y="7" width="1" height="1" fill="#ffffff" />
      <rect x="9" y="7" width="1" height="1" fill="#ffffff" />
    </svg>
  );
}

// Player character growth stages: the look changes with level, tied to the
// same thresholds as the 称号 (title) system (titleForLevel), so text and
// visual grow together. Each CHARACTERS entry holds 5 stage images.
const GROWTH_THRESHOLDS = [1, 10, 20, 35, 50];

function stageIndexForLevel(lv) {
  let idx = 0;
  for (let i = 0; i < GROWTH_THRESHOLDS.length; i++) {
    if (lv >= GROWTH_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

const CHARACTERS = {
  hero: {
    name: "ランナー(男性)",
    stages: [
    { img: "/assets/hero_male_s1.png", aspect: 225/150 },
    { img: "/assets/hero_male_s2.png", aspect: 213/150 },
    { img: "/assets/hero_male_s3.png", aspect: 209/150 },
    { img: "/assets/hero_male_s4.png", aspect: 177/150 },
    { img: "/assets/hero_male_s5.png", aspect: 156/150 },
    ],
  },
  hero_f: {
    name: "ランナー(女性)",
    stages: [
    { img: "/assets/hero_female_s1.png", aspect: 190/150 },
    { img: "/assets/hero_female_s2.png", aspect: 196/150 },
    { img: "/assets/hero_female_s3.png", aspect: 194/150 },
    { img: "/assets/hero_female_s4.png", aspect: 166/150 },
    { img: "/assets/hero_female_s5.png", aspect: 149/150 },
    ],
  },
};

function PlayerAvatar({ size = 64, characterId = "hero", level = 1 }) {
  const char = CHARACTERS[characterId] || CHARACTERS.hero;
  const idx = stageIndexForLevel(level);
  const stage = char.stages[idx] || char.stages[0];
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "hidden" }}>
      <img
        src={stage.img}
        alt={char.name}
        style={{
          imageRendering: "pixelated",
          display: "block",
          maxWidth: "100%",
          maxHeight: "100%",
          width: "auto",
          height: "auto",
        }}
      />
    </div>
  );
}

export default function RunQuestMVP() {
  const [screen, setScreen] = useState("name");
  const [nickname, setNickname] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [selectedMenus, setSelectedMenus] = useState([]);
  const [clanMonster, setClanMonster] = useState(null);
  const [cardView, setCardView] = useState(null); // null = follow battleMode; "clan" = show clan tab
  const [menuDietWeight, setMenuDietWeight] = useState("");
  const [menuDietTarget, setMenuDietTarget] = useState("");
  const [menuHabitGoal, setMenuHabitGoal] = useState(3);
  const [user, setUser] = useState(null);
  const [overlay, setOverlay] = useState("none");
  const [distanceInput, setDistanceInput] = useState("");
  const [minutesInput, setMinutesInput] = useState("");
  const [weightInput, setWeightInput] = useState("");
  const [moodInput, setMoodInput] = useState(null);
  const [feeling, setFeeling] = useState(null);
  const [kansoInput, setKansoInput] = useState("");
  const [recoveryFocus, setRecoveryFocus] = useState(false);
  const [resultData, setResultData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [nameStatus, setNameStatus] = useState("idle");
  const [characterId, setCharacterId] = useState("hero");
  const [settingsNickname, setSettingsNickname] = useState("");
  const [settingsCharacterId, setSettingsCharacterId] = useState("hero");
  const [settingsMenus, setSettingsMenus] = useState([]);
  const [settingsDietWeight, setSettingsDietWeight] = useState("");
  const [settingsDietTarget, setSettingsDietTarget] = useState("");
  const [settingsHabitGoal, setSettingsHabitGoal] = useState(3);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  const storageKey = (userId) => playerKeyForUser(userId);

  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Once a session appears (fresh login or page reload with an existing
  // session), try to load that Google account's saved player row.
  useEffect(() => {
    if (session && screen === "name") {
      attemptLoad();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleGoogleLogin = async () => {
    setAuthError("");
    try {
      await signInWithGoogle();
    } catch (e) {
      setAuthError("ログインに失敗しました。もう一度お試しください");
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
    setScreen("name");
  };

  const attemptLoad = useCallback(async () => {
    setNameStatus("checking");
    try {
      const row = await loadMyPlayerRow();
      if (row && row.value) {
        const loaded = JSON.parse(row.value);
        setUser(loaded);
        setCharacterId(loaded.characterId || "hero");
        setNickname(loaded.nickname || "");
        setNameStatus("idle");
        setScreen("home");
      } else {
        setNameStatus("idle");
        setScreen("menu-select");
      }
    } catch (e) {
      setNameStatus("retry");
    }
  }, []);

  const persist = async (nextUser) => {
    if (!session) return;
    setSaving(true);
    try {
      await storage.set(storageKey(session.user.id), JSON.stringify(nextUser), true);
    } catch (e) {}
    setSaving(false);
  };

  const toggleMenu = (id) => {
    setSelectedMenus((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const startAdventure = async () => {
    if (!nicknameInput.trim()) return;
    const menus = {};
    if (selectedMenus.includes("diet")) {
      const w = parseFloat(menuDietWeight);
      const t = parseFloat(menuDietTarget);
      if (!w || w <= 0 || !t || t <= 0) return;
      menus.diet = { enabled: true, startWeight: w, targetLossKg: t, weightLogs: [{ date: todayISO(), weight: w }], cleared: false };
    }
    if (selectedMenus.includes("habit")) {
      menus.habit = { enabled: true, weeklyGoal: menuHabitGoal };
    }
    if (selectedMenus.includes("stress")) {
      menus.stress = { enabled: true, moodLogs: [] };
    }

    const newUser = {
      nickname: nicknameInput.trim(),
      characterId,
      battleMode: "normal",
      normalKillCount: 0,
      normalDamage: 0,
      trainingKillCount: 0,
      trainingDamage: 0,
      bossAvailable: false,
      bossCycle: 0,
      bossDamage: 0,
      clanJoined: false,
      coins: 0,
      inventory: { damageBoost: 0, recoveryTicket: 0 },
      bestiary: {},
      menus,
      totalExp: 0,
      runs: [],
      lastRunDate: null,
      fatigueFlag: false,
    };
    setUser(newUser);
    setNickname(newUser.nickname);
    setScreen("home");
    await persist(newUser);
  };

  const weeklyRunCount = (runs) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 6);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    return runs.filter((r) => r.date >= cutoffISO).length;
  };

  const clanArt = (generation) => CLAN_MONSTER_POOL[generation % CLAN_MONSTER_POOL.length];

  const loadClanMonster = async () => {
    try {
      const { data, error } = await supabase.from("clan_state").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      const row = data || { generation: 0, hp: 2000, damage: 0, contributors: {} };
      const art = clanArt(row.generation);
      setClanMonster({
        img: art.img,
        aspect: art.aspect,
        name: `クラン討伐:${art.name}`,
        hp: row.hp,
        damage: row.damage,
        generation: row.generation,
        contributors: row.contributors || {},
      });
    } catch (e) {
      const art = clanArt(0);
      setClanMonster({ img: art.img, aspect: art.aspect, name: `クラン討伐:${art.name}`, hp: 2000, damage: 0, generation: 0, contributors: {} });
    }
  };

  // Atomic damage via a Postgres function (see supabase/schema.sql: damage_clan_monster).
  // This replaces the old best-effort read-modify-write with a real row-locked
  // update, so concurrent hits from different testers no longer overwrite each other.
  const damageClanMonster = async (amount, byNickname) => {
    const { data, error } = await supabase.rpc("damage_clan_monster", {
      p_amount: amount,
      p_nickname: byNickname,
    });
    if (error || !data) throw error || new Error("damage_clan_monster returned no data");
    const row = Array.isArray(data) ? data[0] : data;
    const art = clanArt(row.generation);
    const next = {
      img: art.img,
      aspect: art.aspect,
      name: `クラン討伐:${art.name}`,
      hp: row.hp,
      damage: row.damage,
      generation: row.generation,
      contributors: row.contributors || {},
    };
    const defeatedArt = row.just_defeated ? clanArt(row.generation - 1) : null;
    return {
      ...next,
      justDefeated: row.just_defeated,
      defeatedName: defeatedArt ? `クラン討伐:${defeatedArt.name}` : null,
      finalContributors: row.just_defeated ? row.last_contributors || {} : next.contributors,
    };
  };

  const toggleClanJoin = async () => {
    const nextUser = { ...user, clanJoined: !user.clanJoined };
    setUser(nextUser);
    await persist(nextUser);
    if (nextUser.clanJoined && !clanMonster) loadClanMonster();
  };

  const switchBattleMode = async (mode) => {
    const nextUser = { ...user, battleMode: mode };
    setUser(nextUser);
    await persist(nextUser);
  };

  const buyItem = async (item) => {
    if ((user.coins || 0) < item.cost) return;
    const nextInventory = { ...(user.inventory || {}) };
    nextInventory[item.id] = (nextInventory[item.id] || 0) + 1;
    const nextUser = { ...user, coins: user.coins - item.cost, inventory: nextInventory };
    setUser(nextUser);
    await persist(nextUser);
  };

  useEffect(() => {
    if (screen === "home" && user) {
      loadClanMonster();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const openSettings = () => {
    setSettingsNickname(user.nickname);
    setSettingsCharacterId(user.characterId || "hero");
    const menus = user.menus || {};
    setSettingsMenus(Object.keys(menus).filter((k) => menus[k] && menus[k].enabled));
    setSettingsDietWeight(menus.diet ? String(menus.diet.startWeight) : "");
    setSettingsDietTarget(menus.diet ? String(menus.diet.targetLossKg) : "");
    setSettingsHabitGoal(menus.habit ? menus.habit.weeklyGoal : 3);
    setSettingsError("");
    setOverlay("settings");
  };

  const toggleSettingsMenu = (id) => {
    setSettingsMenus((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const saveSettings = async () => {
    const newName = settingsNickname.trim();
    if (!newName) {
      setSettingsError("ニックネームを入力してください");
      return;
    }
    if (settingsMenus.includes("diet") && (!settingsDietWeight || !settingsDietTarget)) {
      setSettingsError("ダイエット管理の体重・目標を入力してください");
      return;
    }
    setSettingsSaving(true);

    const prevMenus = user.menus || {};
    const nextMenus = {};
    if (settingsMenus.includes("diet")) {
      if (prevMenus.diet && prevMenus.diet.enabled) {
        nextMenus.diet = { ...prevMenus.diet, startWeight: parseFloat(settingsDietWeight), targetLossKg: parseFloat(settingsDietTarget) };
      } else {
        const w = parseFloat(settingsDietWeight);
        nextMenus.diet = { enabled: true, startWeight: w, targetLossKg: parseFloat(settingsDietTarget), weightLogs: [{ date: todayISO(), weight: w }], cleared: false };
      }
    }
    if (settingsMenus.includes("habit")) {
      nextMenus.habit = { enabled: true, weeklyGoal: settingsHabitGoal };
    }
    if (settingsMenus.includes("stress")) {
      nextMenus.stress = prevMenus.stress && prevMenus.stress.enabled ? prevMenus.stress : { enabled: true, moodLogs: [] };
    }

    const nextUser = { ...user, nickname: newName, characterId: settingsCharacterId, menus: nextMenus };
    try {
      await storage.set(storageKey(session.user.id), JSON.stringify(nextUser), true);
      setUser(nextUser);
      setNickname(newName);
      setCharacterId(settingsCharacterId);
      setOverlay("none");
    } catch (e) {
      setSettingsError("保存に失敗しました。もう一度お試しください");
    }
    setSettingsSaving(false);
  };

  const daysSinceLastRun = user && user.lastRunDate ? daysBetween(user.lastRunDate, todayISO()) : null;
  const multiplier = daysSinceLastRun === null ? 1.0 : comebackMultiplier(daysSinceLastRun);

  const openRunSheet = () => {
    setDistanceInput("");
    setMinutesInput("");
    setWeightInput("");
    setMoodInput(null);
    setFeeling(null);
    setKansoInput("");
    setRecoveryFocus(false);
    setOverlay("sheet");
  };

  const submitRun = async () => {
    const distance = parseFloat(distanceInput);
    if (!distance || distance <= 0 || !feeling) return;
    const minutes = parseFloat(minutesInput) || 0;

    const beforeLevel = getLevelState(user.totalExp).level;
    const actionExp = 45;
    const runExp = Math.round(distance * 15);
    const mult = multiplier;
    const multipliedExp = Math.round((actionExp + runExp) * mult);

    const priorMax = user.runs.reduce((m, r) => Math.max(m, r.distance), 0);
    let challengeExp = 0;
    let challengeLabel = null;
    const crossed = MILESTONES.find((m) => priorMax < m.km && distance >= m.km);
    if (crossed) {
      challengeExp = crossed.exp;
      challengeLabel = crossed.label;
    } else if (distance > priorMax && user.runs.length > 0) {
      challengeExp = 70;
      challengeLabel = "自己ベスト更新";
    } else if (user.runs.length === 0) {
      challengeExp = 150;
      challengeLabel = "初めて外に出た";
    }

    const ticketAvailable = (user.inventory && user.inventory.recoveryTicket) || 0;
    const useTicket = recoveryFocus && ticketAvailable > 0 && !user.fatigueFlag;
    const recoveryBonus = recoveryFocus ? 20 : 0;

    // Menus: diet weight log
    const dietOn = user.menus && user.menus.diet && user.menus.diet.enabled;
    const newWeight = parseFloat(weightInput);
    const dietWeightLogs =
      dietOn && newWeight > 0
        ? [...(user.menus.diet.weightLogs || []), { date: todayISO(), weight: newWeight }]
        : (user.menus && user.menus.diet && user.menus.diet.weightLogs) || [];

    // Menus: stress mood log
    const stressOn = user.menus && user.menus.stress && user.menus.stress.enabled;
    const stressMoodLogs =
      stressOn && moodInput
        ? [...(user.menus.stress.moodLogs || []), { date: todayISO(), mood: moodInput }]
        : (user.menus && user.menus.stress && user.menus.stress.moodLogs) || [];

    // Diet menu: clear check (reaching the target loss)
    let menuBonusExp = 0;
    let dietJustCleared = false;
    if (dietOn && !user.menus.diet.cleared && user.menus.diet.startWeight && user.menus.diet.targetLossKg) {
      const latestWeight = dietWeightLogs.length ? dietWeightLogs[dietWeightLogs.length - 1].weight : user.menus.diet.startWeight;
      const lost = user.menus.diet.startWeight - latestWeight;
      if (lost >= user.menus.diet.targetLossKg) {
        menuBonusExp += Math.round(user.menus.diet.targetLossKg * 600);
        dietJustCleared = true;
      }
    }

    // Solo monster battle: apply damage to whichever track is currently selected
    const mode = user.battleMode || "normal";
    const boostAvailable = (user.inventory && user.inventory.damageBoost) || 0;
    const useBoost = boostAvailable > 0;
    const rawDamage = computeDamage(distance, minutes);
    if (useBoost) rawDamage.total = Math.round(rawDamage.total * 1.3);
    let soloDamage = rawDamage.total;
    let trackQualifies = true;

    if (mode === "training") {
      const bd = bestDistanceSoFar(user.runs);
      const bp = bestPaceSoFar(user.runs);
      const distanceOk = bd === 0 || distance >= bd * 1.1;
      const paceOk = rawDamage.pace !== null && bp !== null && rawDamage.pace <= bp * 0.9;
      trackQualifies = distanceOk || paceOk;
      soloDamage = trackQualifies ? Math.round(rawDamage.total * 1.2) : 0;
    } else if (mode === "boss") {
      const bossReady = rawDamage.pace !== null && rawDamage.pace <= 8 && distance >= 2;
      trackQualifies = bossReady;
      soloDamage = bossReady ? rawDamage.total : Math.round(rawDamage.total * 0.2);
    }

    let soloExp = 0;
    let soloJustCleared = false;
    let clearedMonsterName = null;
    let bossJustSpawned = false;
    let coinsEarned = 0;
    const nextFields = {};
    const nextBestiary = { ...(user.bestiary || {}) };

    const recordDefeat = (name) => {
      nextBestiary[name] = (nextBestiary[name] || 0) + 1;
    };

    if (mode === "normal") {
      const info = normalMonsterInfo(user);
      const newDamage = info.damage + soloDamage;
      if (newDamage >= info.hp) {
        soloExp = 150;
        coinsEarned += 20;
        soloJustCleared = true;
        clearedMonsterName = info.name;
        recordDefeat(info.name);
        const nextKillCount = (user.normalKillCount || 0) + 1;
        nextFields.normalKillCount = nextKillCount;
        nextFields.normalDamage = 0;
        if (nextKillCount % 3 === 0 && !user.bossAvailable) {
          nextFields.bossAvailable = true;
          nextFields.battleMode = "boss";
          bossJustSpawned = true;
        }
      } else {
        nextFields.normalDamage = newDamage;
      }
    } else if (mode === "training") {
      const info = trainingMonsterInfo(user);
      const newDamage = info.damage + soloDamage;
      if (newDamage >= info.hp) {
        soloExp = 300;
        coinsEarned += 40;
        soloJustCleared = true;
        clearedMonsterName = info.name;
        recordDefeat(info.name);
        nextFields.trainingKillCount = (user.trainingKillCount || 0) + 1;
        nextFields.trainingDamage = 0;
      } else {
        nextFields.trainingDamage = newDamage;
      }
    } else if (mode === "boss") {
      const info = bossMonsterInfo(user);
      const newDamage = info.damage + soloDamage;
      if (newDamage >= info.hp) {
        soloExp = 800;
        coinsEarned += 100;
        soloJustCleared = true;
        clearedMonsterName = info.name;
        recordDefeat(info.name);
        nextFields.bossCycle = (user.bossCycle || 0) + 1;
        nextFields.bossDamage = 0;
        nextFields.bossAvailable = false;
        nextFields.battleMode = "normal";
      } else {
        nextFields.bossDamage = newDamage;
      }
    }

    // Clan monster: independent, shared across everyone using this app.
    // Best-effort read-modify-write against shared storage (last write wins).
    let clanResult = null;
    if (user.clanJoined) {
      try {
        clanResult = await damageClanMonster(rawDamage.total, user.nickname);
        coinsEarned += 10;
        if (clanResult && clanResult.justDefeated) {
          coinsEarned += 50;
          recordDefeat(clanResult.defeatedName);
        }
      } catch (e) {}
    }

    // Consume boost/ticket if they were used this run
    const nextInventory = { ...(user.inventory || { damageBoost: 0, recoveryTicket: 0 }) };
    if (useBoost) nextInventory.damageBoost = Math.max(0, (nextInventory.damageBoost || 0) - 1);
    if (useTicket) nextInventory.recoveryTicket = Math.max(0, (nextInventory.recoveryTicket || 0) - 1);

    const menuBonusExpTotal = menuBonusExp;
    const totalGain = multipliedExp + challengeExp + recoveryBonus + menuBonusExpTotal + soloExp;
    const newTotalExp = user.totalExp + totalGain;
    const afterLevel = getLevelState(newTotalExp).level;

    const recentFeelings = [...user.runs.slice(-1).map((r) => r.feeling), feeling];
    const twoTiredInRow = recentFeelings.length === 2 && recentFeelings.every((f) => f === "しんどい");

    const newRun = {
      date: todayISO(),
      distance,
      minutes,
      feeling,
      kanso: kansoInput,
      exp: totalGain,
      breakdown: { actionExp, runExp, mult, challengeExp, challengeLabel, recoveryBonus, menuBonusExp: menuBonusExpTotal, soloExp },
    };

    const nextMenus = { ...(user.menus || {}) };
    if (dietOn) nextMenus.diet = { ...user.menus.diet, weightLogs: dietWeightLogs, cleared: user.menus.diet.cleared || dietJustCleared };
    if (stressOn) nextMenus.stress = { ...user.menus.stress, moodLogs: stressMoodLogs };

    const nextUser = {
      ...user,
      ...nextFields,
      totalExp: newTotalExp,
      runs: [...user.runs, newRun],
      lastRunDate: todayISO(),
      fatigueFlag: twoTiredInRow,
      menus: nextMenus,
      coins: (user.coins || 0) + coinsEarned,
      bestiary: nextBestiary,
      inventory: nextInventory,
    };

    setUser(nextUser);
    await persist(nextUser);
    if (clanResult) setClanMonster(clanResult);
    setResultData({
      gained: totalGain,
      leveledUp: afterLevel > beforeLevel,
      fromLevel: beforeLevel,
      toLevel: afterLevel,
      newTitle: afterLevel > beforeLevel && titleForLevel(afterLevel) !== titleForLevel(beforeLevel) ? titleForLevel(afterLevel) : null,
      dietCleared: dietJustCleared,
      soloCleared: soloJustCleared,
      clearedMonsterName,
      bossJustSpawned,
      trackQualifies,
      battleMode: mode,
      damageDealt: rawDamage,
      soloDamage,
      clanDamage: user.clanJoined ? rawDamage.total : 0,
      clanDefeated: clanResult ? clanResult.justDefeated : false,
      clanFinalContributors: clanResult && clanResult.justDefeated ? clanResult.finalContributors : null,
      coinsEarned,
      usedBoost: useBoost,
      usedTicket: useTicket,
      breakdown: newRun.breakdown,
    });
    setOverlay("result");
  };

  const levelState = user ? getLevelState(user.totalExp) : null;
  const title = levelState ? titleForLevel(levelState.level) : "";
  const progressPct = levelState ? Math.min(100, Math.round((levelState.into / levelState.need) * 100)) : 0;
  const activeMode = user ? user.battleMode || "normal" : "normal";
  const activeMonster = user
    ? activeMode === "training"
      ? trainingMonsterInfo(user)
      : activeMode === "boss"
      ? bossMonsterInfo(user)
      : normalMonsterInfo(user)
    : null;
  const activeMonsterPct = activeMonster ? Math.min(100, Math.round((activeMonster.damage / activeMonster.hp) * 100)) : 0;

  const recentRuns = user ? runsInWindow(user.runs, 90) : [];
  const recentBestDistance = bestDistanceSoFar(recentRuns);
  const recentBestPace = bestPaceSoFar(recentRuns);
  const allTimeBestDistance = user ? bestDistanceSoFar(user.runs) : 0;
  const allTimeBestPace = user ? bestPaceSoFar(user.runs) : null;

  const bossNeedDistance = 2;
  const bossNeedPace = 8;
  const trainingNeedDistance = allTimeBestDistance > 0 ? +(allTimeBestDistance * 1.1).toFixed(1) : null;
  const trainingNeedPace = allTimeBestPace !== null ? +(allTimeBestPace * 0.9).toFixed(1) : null;

  let readiness = null;
  if (user && activeMode === "boss") {
    const needDistance = bossNeedDistance;
    const needPace = bossNeedPace;
    const distOk = recentBestDistance >= needDistance;
    const paceOk = recentBestPace !== null && recentBestPace <= needPace;
    readiness = {
      clear: distOk && paceOk,
      lines: [
        { label: "距離", have: recentBestDistance ? `${recentBestDistance}km` : "記録なし", need: `${needDistance}km以上`, ok: distOk },
        { label: "ペース", have: recentBestPace !== null ? `${recentBestPace.toFixed(1)}分/km` : "記録なし", need: `${needPace}分/km以内`, ok: paceOk },
      ],
    };
  } else if (user && activeMode === "training") {
    const needDistance = trainingNeedDistance || 0;
    const needPace = trainingNeedPace;
    const distOk = needDistance > 0 && recentBestDistance >= needDistance;
    const paceOk = needPace !== null && recentBestPace !== null && recentBestPace <= needPace;
    readiness = {
      clear: distOk || paceOk,
      lines: [
        { label: "距離", have: recentBestDistance ? `${recentBestDistance}km` : "記録なし", need: needDistance > 0 ? `${needDistance}km以上` : "まず1回記録を", ok: distOk },
        { label: "ペース", have: recentBestPace !== null ? `${recentBestPace.toFixed(1)}分/km` : "記録なし", need: needPace !== null ? `${needPace}分/km以内` : "時間の記録が必要", ok: paceOk },
      ],
    };
  }

  let saboriCtx = null;
  if (daysSinceLastRun !== null) {
    if (daysSinceLastRun >= 8) saboriCtx = "sabori8";
    else if (daysSinceLastRun >= 5) saboriCtx = "sabori5";
    else if (daysSinceLastRun >= 3) saboriCtx = "sabori3";
  }
  const astCtx = user && user.fatigueFlag ? "fatigue" : saboriCtx || "default";

  const inputStyle = { backgroundColor: "#FFFFFF", border: `2px solid ${C.panelBorder}`, color: C.ink };
  const cardStyle = { backgroundColor: C.panel, border: `2px solid ${C.panelBorder}`, boxShadow: C.cardShadow };

  return (
    <div className="min-h-screen w-full rq-body flex justify-center" style={{ backgroundColor: C.paper, color: C.ink }}>
      <style>{FONT_STYLE}</style>
      <div className="w-full max-w-md min-h-screen flex flex-col relative">

        {/* ---------- NAME ---------- */}
        {screen === "name" && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 gap-8"
            style={{ background: `linear-gradient(${C.skyTop}, ${C.skyBottom})` }}>
            <div className="text-center flex flex-col items-center gap-2">
              <PlayerAvatar size={88} characterId={characterId} />
              <h1 className="rq-pixel text-3xl mt-2" style={{ color: C.night }}>RUN QUEST</h1>
              <p className="rq-display text-sm font-bold" style={{ color: C.night }}>走ることが、冒険になる。</p>
              <p className="text-xs" style={{ color: "#4A5E82" }}>未来の自分に会いに行くRPG</p>
            </div>
            <div className="w-full flex flex-col gap-3">
              {!authChecked ? (
                <p className="text-xs text-center" style={{ color: "#4A5E82" }}>読み込み中…</p>
              ) : !session ? (
                <>
                  <button
                    onClick={handleGoogleLogin}
                    className="w-full rounded-xl py-3 rq-display font-bold flex items-center justify-center gap-2"
                    style={{ backgroundColor: "#fff", color: C.night, border: `2px solid ${C.panelBorder}`, boxShadow: C.cardShadow }}
                  >
                    Googleでログイン
                  </button>
                  {authError && <p className="text-xs text-center" style={{ color: "#C23A3C" }}>{authError}</p>}
                </>
              ) : (
                <p className="text-xs text-center" style={{ color: "#4A5E82" }}>
                  {nameStatus === "checking" ? "記録を確認しています…" : "準備しています…"}
                </p>
              )}

              {nameStatus === "retry" && (
                <div className="rounded-xl px-4 py-3 flex flex-col gap-3" style={cardStyle}>
                  <p className="text-xs leading-relaxed" style={{ color: C.inkSoft }}>
                    記録を確認できませんでした。通信の問題の可能性があります。
                  </p>
                  <button onClick={() => attemptLoad()} className="w-full rounded-lg py-2 text-sm rq-display font-bold"
                    style={{ backgroundColor: C.night, color: "#fff" }}>もう一度読み込む</button>
                </div>
              )}
              <p className="fs10 text-center leading-relaxed" style={{ color: "#4A5E82" }}>
                ※検証用の簡易版です。Googleアカウントでログインして進めます。
              </p>
            </div>
          </div>
        )}

        {/* ---------- MENU SELECT ---------- */}
        {screen === "menu-select" && (
          <div className="flex-1 flex flex-col px-6 py-10 gap-6">
            <div>
              <h2 className="rq-pixel text-xl" style={{ color: C.night }}>プロフィールを作る</h2>
              <p className="text-sm mt-1" style={{ color: C.inkSoft }}>ログイン成功。表示名とキャラクターを決めよう。</p>
            </div>

            <div className="rounded-2xl px-4 py-4 flex flex-col gap-3" style={cardStyle}>
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.night }}>ニックネーム(表示名)</label>
                <input
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  placeholder="例: たろう"
                  className="w-full mt-1 rounded-xl px-4 py-3 outline-none"
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.night }}>キャラクター</label>
                <div className="flex justify-center mt-2 mb-1">
                  <PlayerAvatar size={72} characterId={characterId} />
                </div>
                <div className="flex gap-2 mt-1">
                  {Object.entries(CHARACTERS).map(([id, c]) => (
                    <button
                      key={id}
                      onClick={() => setCharacterId(id)}
                      className="flex-1 rounded-xl py-2 px-2 flex items-center justify-center gap-2 text-xs rq-display font-bold"
                      style={
                        characterId === id
                          ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                          : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }
                      }
                    >
                      <PlayerAvatar size={28} characterId={id} />
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <h2 className="rq-pixel text-lg" style={{ color: C.night }}>メニューを選ぶ</h2>
              <p className="text-sm mt-1" style={{ color: C.inkSoft }}>
                走ることそのものは、レベルとしてずっと成長していく。あわせて気にしたいものがあれば選んでおこう(あとで設定から変更できます)。
              </p>
            </div>

            <div className="flex flex-col gap-3">
              {Object.values(MENU_CONFIG).map((m) => {
                const Icon = m.icon;
                const on = selectedMenus.includes(m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => toggleMenu(m.id)}
                    className="flex items-center gap-4 rounded-2xl px-4 py-4 text-left"
                    style={on ? { backgroundColor: C.night, border: `2px solid ${C.night}` } : cardStyle}
                  >
                    <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
                      style={{ backgroundColor: on ? C.gold : C.greenSoft, color: on ? "#fff" : C.green, border: `2px solid ${on ? C.goldDeep : C.greenBorder}` }}>
                      <Icon size={20} />
                    </div>
                    <div className="flex-1">
                      <div className="rq-display font-bold" style={{ color: on ? "#fff" : C.ink }}>{m.name}</div>
                      <div className="text-xs" style={{ color: on ? "#B9C4DA" : C.inkSoft }}>{m.desc}</div>
                    </div>
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                      style={{ backgroundColor: on ? C.gold : "transparent", border: `2px solid ${on ? C.goldDeep : C.panelBorder}` }}
                    >
                      {on && <span style={{ color: "#fff", fontSize: 12 }}>✓</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedMenus.includes("diet") && (
              <div className="rounded-2xl px-4 py-5 flex flex-col gap-3" style={cardStyle}>
                <p className="rq-display font-bold text-sm" style={{ color: C.night }}>ダイエット管理の設定</p>
                <div>
                  <label className="text-xs" style={{ color: C.inkSoft }}>現在の体重(kg)</label>
                  <input type="number" inputMode="decimal" value={menuDietWeight} onChange={(e) => setMenuDietWeight(e.target.value)}
                    placeholder="例: 60" className="w-full mt-1 rounded-xl px-4 py-3 outline-none" style={inputStyle} />
                </div>
                <div>
                  <label className="text-xs" style={{ color: C.inkSoft }}>目標の減量(kg)</label>
                  <input type="number" inputMode="decimal" value={menuDietTarget} onChange={(e) => setMenuDietTarget(e.target.value)}
                    placeholder="例: 5" className="w-full mt-1 rounded-xl px-4 py-3 outline-none" style={inputStyle} />
                </div>
              </div>
            )}

            {selectedMenus.includes("habit") && (
              <div className="rounded-2xl px-4 py-5 flex flex-col gap-3" style={cardStyle}>
                <p className="rq-display font-bold text-sm" style={{ color: C.night }}>生活習慣管理の設定</p>
                <label className="text-xs" style={{ color: C.inkSoft }}>週に何回くらい動けそうですか?</label>
                <div className="flex gap-2">
                  {[2, 3, 4].map((g) => (
                    <button key={g} onClick={() => setMenuHabitGoal(g)} className="flex-1 py-2 rounded-xl text-sm rq-display font-bold"
                      style={menuHabitGoal === g
                        ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                        : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }}>
                      {g === 4 ? "週4回以上" : `週${g === 2 ? "1〜2" : g}回`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedMenus.includes("stress") && (
              <div className="rounded-2xl px-4 py-4" style={cardStyle}>
                <p className="text-xs leading-relaxed" style={{ color: C.inkSoft }}>
                  ラン記録のたびに、今日の気分({MOOD_OPTIONS.join("/")})を聞くようになります。
                </p>
              </div>
            )}

            <button
              onClick={startAdventure}
              disabled={!nicknameInput.trim() || (selectedMenus.includes("diet") && (!menuDietWeight || !menuDietTarget))}
              className="w-full rounded-2xl py-4 rq-display font-bold disabled:opacity-50"
              style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}
            >
              ぼうけんを はじめる
            </button>
          </div>
        )}

        {/* ---------- HOME ---------- */}
        {screen === "home" && user && levelState && (
          <div className="flex-1 flex flex-col">
            {/* Sky header */}
            <div className="px-5 pt-7 pb-7 relative" style={{ background: `linear-gradient(${C.skyTop}, ${C.skyBottom})` }}>
              {/* pixel clouds */}
              <div className="absolute rq-pixel" style={{ top: 10, right: 130, color: "#fff", opacity: 0.9, fontSize: 12, pointerEvents: "none" }}>☁</div>
              <div className="absolute rq-pixel" style={{ top: 26, right: 90, color: "#fff", opacity: 0.8, fontSize: 18, pointerEvents: "none" }}>☁</div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: "#fff", border: `2px solid ${C.night}` }}>
                    <PlayerAvatar size={40} characterId={user.characterId} level={levelState.level} />
                  </div>
                  <div>
                    <div className="rq-display font-bold text-lg leading-tight" style={{ color: C.night }}>{user.nickname}</div>
                    <div className="rq-pixel fs11" style={{ color: C.night }}>
                      称号:{title}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setOverlay("bestiary")} aria-label="図鑑"
                    className="rq-pixel fs11 px-2 py-1 rounded-full" style={{ backgroundColor: "#ffffffaa", color: C.night }}>
                    📖
                  </button>
                  <button onClick={() => setOverlay("shop")} aria-label="ショップ"
                    className="rq-pixel fs11 px-2 py-1 rounded-full flex items-center gap-1" style={{ backgroundColor: "#ffffffaa", color: C.night }}>
                    🪙 {user.coins || 0}
                  </button>
                  <button onClick={openSettings} aria-label="設定">
                    <Settings size={20} style={{ color: C.night }} />
                  </button>
                </div>
              </div>

              {/* Lv badge + progress */}
              <div className="mt-4 flex items-end gap-3">
                <div className="rq-pixel px-3 py-1 rounded-md text-lg" style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}>
                  Lv.{levelState.level}
                </div>
                <div className="flex-1">
                  <div className="w-full h-3 rounded-full overflow-hidden" style={{ backgroundColor: "#ffffff80", border: `1px solid ${C.night}30` }}>
                    <div className="h-full" style={{ width: `${progressPct}%`, backgroundColor: C.gold }} />
                  </div>
                  <div className="rq-pixel fs11 mt-1" style={{ color: C.night }}>
                    あと {Math.max(0, levelState.need - levelState.into)} EXP で Lv.{levelState.level + 1}
                  </div>
                </div>
              </div>
            </div>

            {/* Readiness: how your recent fitness stacks up against the current fight */}
            {readiness && (
              <div className="mx-4 mt-4 rounded-2xl px-4 py-3" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <span className="rq-display font-bold text-sm" style={{ color: C.night }}>直近3ヶ月の実力</span>
                  <span
                    className="fs11 px-2 py-0.5 rounded-full rq-display font-bold"
                    style={readiness.clear ? { backgroundColor: C.greenSoft, color: C.green } : { backgroundColor: C.pinkBg, color: C.pinkText }}
                  >
                    {readiness.clear ? "挑戦圏内" : "まだ足りない"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {readiness.lines.map((l) => (
                    <div key={l.label} className="flex items-center justify-between fs11" style={{ color: C.inkSoft }}>
                      <span>{l.label}: {l.have}</span>
                      <span style={{ color: l.ok ? C.green : C.inkFaint }}>必要 {l.need}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Battle mode tabs */}
            <div className="mx-4 mt-4 flex gap-2">
              {[user.bossAvailable ? "boss" : "normal", "training", "clan"].map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    if (m === "clan") {
                      setCardView("clan");
                    } else {
                      switchBattleMode(m);
                      setCardView(m);
                    }
                  }}
                  className="flex-1 rounded-xl py-2 text-xs rq-display font-bold"
                  style={
                    (cardView || activeMode) === m
                      ? { backgroundColor: C.night, color: "#fff", border: `2px solid ${C.night}` }
                      : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }
                  }
                >
                  {m === "normal" ? "通常" : m === "training" ? "修行" : m === "boss" ? "ボス" : "🤝クラン"}
                </button>
              ))}
            </div>

            {(cardView || activeMode) === "clan" ? (
              /* Clan monster card (shared, joinable alongside any solo battle) */
              <div className="mx-4 mt-2 rounded-2xl px-4 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <span className="rq-display font-bold text-sm" style={{ color: C.night }}>🤝 クランモンスター</span>
                  <button
                    onClick={toggleClanJoin}
                    className="fs11 px-3 py-1 rounded-full rq-display font-bold"
                    style={
                      user.clanJoined
                        ? { backgroundColor: C.gold, color: "#fff" }
                        : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }
                    }
                  >
                    {user.clanJoined ? "参戦中" : "参戦する"}
                  </button>
                </div>
                {clanMonster ? (
                  <div className="flex items-center gap-3">
                    <div className="shrink-0">
                      {clanMonster.img ? <MonsterArt img={clanMonster.img} aspect={clanMonster.aspect} size={44} /> : <MonsterIcon kind={clanMonster.kind} size={44} />}
                    </div>
                    <div className="flex-1">
                      <div className="rq-display font-bold text-sm" style={{ color: C.ink }}>{clanMonster.name}</div>
                      <div className="fs11" style={{ color: C.inkFaint }}>HP {Math.max(0, clanMonster.hp - clanMonster.damage)}/{clanMonster.hp}</div>
                      <div className="mt-1 w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: C.paper }}>
                        <div className="h-full transition-all" style={{ width: `${Math.max(0, 100 - Math.round((clanMonster.damage / clanMonster.hp) * 100))}%`, backgroundColor: "#E85B5B" }} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="fs11" style={{ color: C.inkFaint }}>読み込み中…</p>
                )}
                {clanMonster && clanMonster.contributors && Object.keys(clanMonster.contributors).length > 0 && (
                  <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.panelBorder}` }}>
                    <div className="fs11 rq-display font-bold mb-1" style={{ color: C.inkSoft }}>貢献度ランキング</div>
                    <div className="flex flex-col gap-1">
                      {Object.entries(clanMonster.contributors)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([name, dmg], i) => (
                          <div key={name} className="flex items-center justify-between fs11" style={{ color: name === user.nickname ? C.goldDeep : C.inkSoft }}>
                            <span>{i + 1}. {name}{name === user.nickname ? "(あなた)" : ""}</span>
                            <span className="rq-pixel">{dmg}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
                <p className="fs11 mt-2" style={{ color: C.inkFaint }}>
                  他のモンスターと討伐中でも参戦できます。参戦すると、記録するたびにこのモンスターにもダメージが入ります(今選んでいるタブに関わらず有効です)。
                </p>
              </div>
            ) : (
              /* Monster card */
              <div className="mx-4 mt-2 rounded-2xl px-4 py-4" style={{ backgroundColor: C.night, boxShadow: C.cardShadow }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="rq-pixel fs11 px-2 py-0.5 rounded" style={{ backgroundColor: "#ffffff22", color: "#fff" }}>
                    {activeMode === "normal" ? "通常モンスター" : activeMode === "training" ? "修行モンスター" : "ボスモンスター"}
                  </span>
                  {activeMode === "training" && (
                    <span className="fs11" style={{ color: "#B9C4DA" }}>
                      {trainingNeedDistance ? `距離${trainingNeedDistance}km以上` : "まず1回記録を"}
                      {trainingNeedPace !== null ? ` or ペース${trainingNeedPace}分/km以内` : ""}
                    </span>
                  )}
                  {activeMode === "boss" && (
                    <span className="fs11" style={{ color: "#B9C4DA" }}>距離{bossNeedDistance}km以上 & ペース{bossNeedPace}分/km以内</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <div className="shrink-0">
                    {activeMonster.img ? (
                      <MonsterArt img={activeMonster.img} aspect={activeMonster.aspect} size={activeMode === "boss" ? 56 : 44} />
                    ) : (
                      <MonsterIcon kind={activeMonster.kind} size={activeMode === "boss" ? 56 : 44} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="rq-display font-bold text-white">{activeMonster.name}</div>
                    <div className="flex items-center justify-between fs11 mt-1" style={{ color: "#B9C4DA" }}>
                      <span>HP {Math.max(0, activeMonster.hp - activeMonster.damage)}/{activeMonster.hp}</span>
                    </div>
                    <div className="mt-1 w-full h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: "#ffffff22" }}>
                      <div className="h-full transition-all" style={{ width: `${100 - activeMonsterPct}%`, backgroundColor: "#E85B5B" }} />
                    </div>
                  </div>
                </div>
                {!user.bossAvailable && (
                  <div className="mt-2 fs11" style={{ color: "#7C87A8" }}>通常モンスターを3体倒すとボスが現れる</div>
                )}
                {user.clanJoined && (
                  <div className="mt-2 fs11" style={{ color: C.gold }}>🤝 クランにも参戦中(並行してダメージが入ります)</div>
                )}
              </div>
            )}

            {/* Menu cards */}
            {user.menus && user.menus.diet && user.menus.diet.enabled && (() => {
              const d = user.menus.diet;
              const latest = d.weightLogs && d.weightLogs.length ? d.weightLogs[d.weightLogs.length - 1].weight : d.startWeight;
              const lost = Math.max(0, d.startWeight - latest);
              const remaining = Math.max(0, d.targetLossKg - lost);
              const pct = Math.min(100, Math.round((lost / d.targetLossKg) * 100));
              return (
                <div className="mx-4 mt-3 rounded-2xl px-4 py-3" style={cardStyle}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="rq-display font-bold text-sm" style={{ color: C.night }}>🔥 ダイエット管理</span>
                    <span className="fs11" style={{ color: C.inkFaint }}>{d.cleared ? "達成!" : `あと-${remaining.toFixed(1)}kg`}</span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: C.paper }}>
                    <div className="h-full" style={{ width: `${pct}%`, backgroundColor: C.green }} />
                  </div>
                  <div className="fs11 mt-1" style={{ color: C.inkFaint }}>体重 -{lost.toFixed(1)}kg / 目標 -{d.targetLossKg}kg</div>
                </div>
              );
            })()}

            {user.menus && user.menus.habit && user.menus.habit.enabled && (() => {
              const h = user.menus.habit;
              const count = weeklyRunCount(user.runs);
              const pct = Math.min(100, Math.round((count / h.weeklyGoal) * 100));
              return (
                <div className="mx-4 mt-3 rounded-2xl px-4 py-3" style={cardStyle}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="rq-display font-bold text-sm" style={{ color: C.night }}>🌱 生活習慣管理</span>
                    <span className="fs11" style={{ color: C.inkFaint }}>今週 {count}/{h.weeklyGoal}回</span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: C.paper }}>
                    <div className="h-full" style={{ width: `${pct}%`, backgroundColor: C.green }} />
                  </div>
                </div>
              );
            })()}

            {user.menus && user.menus.stress && user.menus.stress.enabled && (() => {
              const logs = user.menus.stress.moodLogs || [];
              const recent = logs.slice(-7);
              const sukkiri = recent.filter((l) => l.mood === "スッキリ").length;
              return (
                <div className="mx-4 mt-3 rounded-2xl px-4 py-3" style={cardStyle}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="rq-display font-bold text-sm" style={{ color: C.night }}>🧘 ストレス発散管理</span>
                    <span className="fs11" style={{ color: C.inkFaint }}>直近{recent.length}回中{sukkiri}回スッキリ</span>
                  </div>
                  {logs.length === 0 ? (
                    <p className="fs11" style={{ color: C.inkFaint }}>記録するとここに気分の推移が出ます</p>
                  ) : (
                    <div className="flex gap-1 mt-1">
                      {recent.map((l, i) => (
                        <span key={i} className="fs11 px-2 py-0.5 rounded-full" style={{ backgroundColor: C.paper, color: C.inkSoft }}>
                          {l.mood}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* アスト message */}
            <div className="mx-4 mt-4 rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "#EAF2FA", border: `2px solid #CFE0F0` }}>
              <Ast size={34} />
              <p className="text-xs leading-relaxed rq-display font-bold" style={{ color: C.night }}>{astMessage(astCtx)}</p>
            </div>

            {/* CTA */}
            <div className="px-4 mt-4">
              <button onClick={openRunSheet} className="w-full rounded-2xl py-4 flex items-center justify-center gap-2 text-lg rq-display font-bold"
                style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}`, boxShadow: C.cardShadow }}>
                ⚔️ たたかいに行く!
              </button>
            </div>

            {/* Records */}
            <div className="px-4 mt-6 flex-1 pb-8">
              <div className="rq-pixel text-sm mb-3" style={{ color: C.night }}>ランニング記録</div>
              {user.runs.length === 0 && (
                <p className="text-xs" style={{ color: C.inkFaint }}>まだ記録がありません。最初の一歩を刻もう。</p>
              )}
              <div className="flex flex-col gap-2">
                {[...user.runs].reverse().map((r, i) => (
                  <div key={i} className="rounded-xl px-4 py-3" style={cardStyle}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="rq-pixel fs11" style={{ color: C.inkSoft }}>{r.date}</span>
                      <span className="rq-pixel text-sm" style={{ color: C.goldDeep }}>+{r.exp} EXP</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">{r.distance}km ・ {r.feeling}</span>
                      {r.breakdown.challengeLabel && (
                        <span className="fs10 px-2 py-0.5 rounded-full" style={{ backgroundColor: C.greenSoft, color: C.green, border: `1px solid ${C.greenBorder}` }}>
                          {r.breakdown.challengeLabel}
                        </span>
                      )}
                    </div>
                    {r.kanso && <p className="text-xs mt-2 leading-relaxed" style={{ color: C.inkSoft }}>{r.kanso}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------- SETTINGS ---------- */}
        {overlay === "settings" && user && (
          <div className="fixed inset-0 z-30 flex items-end justify-center">
            <div className="absolute inset-0" style={{ backgroundColor: "rgba(20,30,50,0.55)" }} onClick={() => setOverlay("none")} />
            <div className="relative w-full max-w-md rounded-t-3xl px-6 pt-6 pb-8 flex flex-col gap-5" style={{ backgroundColor: C.paper }}>
              <div className="flex items-center justify-between">
                <h3 className="rq-pixel text-lg" style={{ color: C.night }}>設定</h3>
                <button onClick={() => setOverlay("none")}><X size={20} style={{ color: C.inkSoft }} /></button>
              </div>

              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>ニックネーム</label>
                <input
                  value={settingsNickname}
                  onChange={(e) => setSettingsNickname(e.target.value)}
                  className="w-full mt-1 rounded-xl px-4 py-3 outline-none"
                  style={inputStyle}
                />
              </div>

              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>キャラクター</label>
                <div className="flex gap-2 mt-2">
                  {Object.entries(CHARACTERS).map(([id, c]) => (
                    <button
                      key={id}
                      onClick={() => setSettingsCharacterId(id)}
                      className="flex-1 rounded-xl py-2 text-xs rq-display font-bold"
                      style={
                        settingsCharacterId === id
                          ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                          : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }
                      }
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>メニュー</label>
                <div className="flex flex-col gap-2 mt-2">
                  {Object.values(MENU_CONFIG).map((m) => {
                    const Icon = m.icon;
                    const on = settingsMenus.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => toggleSettingsMenu(m.id)}
                        className="flex items-center gap-3 rounded-xl px-3 py-3 text-left"
                        style={on ? { backgroundColor: C.night, border: `2px solid ${C.night}` } : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}` }}
                      >
                        <Icon size={16} style={{ color: on ? C.gold : C.inkFaint }} />
                        <span className="rq-display font-bold text-sm flex-1" style={{ color: on ? "#fff" : C.ink }}>{m.name}</span>
                        <span style={{ color: on ? C.gold : C.inkFaint, fontSize: 11 }}>{on ? "ON" : "OFF"}</span>
                      </button>
                    );
                  })}
                </div>

                {settingsMenus.includes("diet") && (
                  <div className="mt-2 rounded-xl px-3 py-3 flex flex-col gap-2" style={cardStyle}>
                    <div>
                      <label className="text-xs" style={{ color: C.inkSoft }}>現在の体重(kg)</label>
                      <input type="number" inputMode="decimal" value={settingsDietWeight} onChange={(e) => setSettingsDietWeight(e.target.value)}
                        className="w-full mt-1 rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
                    </div>
                    <div>
                      <label className="text-xs" style={{ color: C.inkSoft }}>目標の減量(kg)</label>
                      <input type="number" inputMode="decimal" value={settingsDietTarget} onChange={(e) => setSettingsDietTarget(e.target.value)}
                        className="w-full mt-1 rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
                    </div>
                  </div>
                )}

                {settingsMenus.includes("habit") && (
                  <div className="mt-2 rounded-xl px-3 py-3 flex flex-col gap-2" style={cardStyle}>
                    <label className="text-xs" style={{ color: C.inkSoft }}>週に何回くらい動けそうですか?</label>
                    <div className="flex gap-2">
                      {[2, 3, 4].map((g) => (
                        <button key={g} onClick={() => setSettingsHabitGoal(g)} className="flex-1 py-2 rounded-lg text-xs rq-display font-bold"
                          style={settingsHabitGoal === g
                            ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                            : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }}>
                          {g === 4 ? "週4回以上" : `週${g === 2 ? "1〜2" : g}回`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {settingsError && (
                <p className="text-xs" style={{ color: "#C23A3C" }}>{settingsError}</p>
              )}

              <p className="text-[10px] leading-relaxed" style={{ color: C.inkFaint }}>
                ニックネームを変えると、これまでの記録は新しいニックネームに引き継がれます(元のニックネームでは開けなくなります)。
              </p>

              <button
                onClick={saveSettings}
                disabled={settingsSaving}
                className="w-full rounded-xl py-3 rq-display font-bold disabled:opacity-50"
                style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}
              >
                {settingsSaving ? "保存中…" : "保存する"}
              </button>

              <button
                onClick={handleSignOut}
                className="w-full rounded-xl py-3 rq-display font-bold flex items-center justify-center gap-2"
                style={{ backgroundColor: "transparent", border: `2px solid ${C.panelBorder}`, color: C.inkSoft }}
              >
                <LogOut size={16} /> ログアウト
              </button>
            </div>
          </div>
        )}

        {/* ---------- SHOP ---------- */}
        {overlay === "shop" && user && (
          <div className="fixed inset-0 z-30 flex items-end justify-center">
            <div className="absolute inset-0" style={{ backgroundColor: "rgba(20,30,50,0.55)" }} onClick={() => setOverlay("none")} />
            <div className="relative w-full max-w-md rounded-t-3xl px-6 pt-6 pb-8 flex flex-col gap-4" style={{ backgroundColor: C.paper }}>
              <div className="flex items-center justify-between">
                <h3 className="rq-pixel text-lg" style={{ color: C.night }}>🛒 ショップ</h3>
                <button onClick={() => setOverlay("none")}><X size={20} style={{ color: C.inkSoft }} /></button>
              </div>
              <div className="rq-display font-bold text-sm" style={{ color: C.goldDeep }}>🪙 所持コイン: {user.coins || 0}</div>
              <div className="flex flex-col gap-3">
                {SHOP_ITEMS.map((item) => {
                  const owned = (user.inventory && user.inventory[item.id]) || 0;
                  const affordable = (user.coins || 0) >= item.cost;
                  return (
                    <div key={item.id} className="rounded-2xl px-4 py-4 flex items-center gap-3" style={cardStyle}>
                      <div className="text-3xl shrink-0">{item.icon}</div>
                      <div className="flex-1">
                        <div className="rq-display font-bold text-sm" style={{ color: C.night }}>{item.name}</div>
                        <div className="fs11" style={{ color: C.inkSoft }}>{item.desc}</div>
                        {owned > 0 && <div className="fs11 mt-1" style={{ color: C.green }}>所持: {owned}個</div>}
                      </div>
                      <button
                        onClick={() => buyItem(item)}
                        disabled={!affordable}
                        className="rounded-xl px-3 py-2 text-xs rq-display font-bold disabled:opacity-40"
                        style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}
                      >
                        {item.cost}枚
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="fs11" style={{ color: C.inkFaint }}>
                コインはモンスター討伐(通常20・修行40・ボス100)や、クランモンスターへの参戦(参加+10・討伐+50)で貯まります。
              </p>
            </div>
          </div>
        )}

        {/* ---------- BESTIARY ---------- */}
        {overlay === "bestiary" && user && (
          <div className="fixed inset-0 z-30 flex items-end justify-center">
            <div className="absolute inset-0" style={{ backgroundColor: "rgba(20,30,50,0.55)" }} onClick={() => setOverlay("none")} />
            <div className="relative w-full max-w-md rounded-t-3xl px-6 pt-6 pb-8 flex flex-col gap-4" style={{ backgroundColor: C.paper, maxHeight: "80vh", overflowY: "auto" }}>
              <div className="flex items-center justify-between">
                <h3 className="rq-pixel text-lg" style={{ color: C.night }}>📖 モンスター図鑑</h3>
                <button onClick={() => setOverlay("none")}><X size={20} style={{ color: C.inkSoft }} /></button>
              </div>
              {Object.keys(user.bestiary || {}).length === 0 ? (
                <p className="text-xs" style={{ color: C.inkFaint }}>まだ討伐記録がありません。モンスターを倒すとここに記録されます。</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(user.bestiary || {}).map(([name, count]) => {
                    const art = findMonsterArt(name);
                    return (
                      <div key={name} className="rounded-xl px-3 py-3 flex flex-col items-center text-center" style={cardStyle}>
                        {art ? (
                          <MonsterArt img={art.img} aspect={art.aspect} size={56} />
                        ) : (
                          <MonsterIcon kind="slime" size={40} />
                        )}
                        <div className="rq-display font-bold text-xs mt-1" style={{ color: C.night }}>{name}</div>
                        <div className="rq-pixel text-lg mt-0.5" style={{ color: C.goldDeep }}>×{count}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------- RUN SHEET ---------- */}
        {overlay === "sheet" && (
          <div className="fixed inset-0 z-30 flex items-end justify-center">
            <div className="absolute inset-0" style={{ backgroundColor: "rgba(20,30,50,0.55)" }} onClick={() => setOverlay("none")} />
            <div className="relative w-full max-w-md rounded-t-3xl px-6 pt-6 pb-8 flex flex-col gap-5" style={{ backgroundColor: C.paper }}>
              <div className="flex items-center justify-between">
                <h3 className="rq-pixel text-lg" style={{ color: C.night }}>今日の記録</h3>
                <button onClick={() => setOverlay("none")}><X size={20} style={{ color: C.inkSoft }} /></button>
              </div>
              {activeMode === "training" && (
                <div className="rounded-xl px-3 py-2 fs11" style={{ backgroundColor: C.pinkBg, color: C.pinkText }}>
                  修行モンスターにダメージを与えるには: {trainingNeedDistance ? `距離${trainingNeedDistance}km以上` : "まず1回記録が必要"}
                  {trainingNeedPace !== null ? `、またはペース${trainingNeedPace}分/km以内` : ""}
                </div>
              )}
              {activeMode === "boss" && (
                <div className="rounded-xl px-3 py-2 fs11" style={{ backgroundColor: C.pinkBg, color: C.pinkText }}>
                  ボスにしっかりダメージを与えるには: 距離{bossNeedDistance}km以上 かつ ペース{bossNeedPace}分/km以内
                </div>
              )}
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>走った距離(km)</label>
                <input type="number" inputMode="decimal" value={distanceInput} onChange={(e) => setDistanceInput(e.target.value)}
                  placeholder="例: 1.5" className="w-full mt-1 rounded-xl px-4 py-3 outline-none" style={inputStyle} />
              </div>
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>かかった時間(分)・任意</label>
                <input type="number" inputMode="decimal" value={minutesInput} onChange={(e) => setMinutesInput(e.target.value)}
                  placeholder="ペースの記録に使います" className="w-full mt-1 rounded-xl px-4 py-3 outline-none" style={inputStyle} />
              </div>
              {user?.menus?.diet?.enabled && (
                <div>
                  <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>今日の体重(kg)・任意</label>
                  <input type="number" inputMode="decimal" value={weightInput} onChange={(e) => setWeightInput(e.target.value)}
                    placeholder="測った日だけでOK" className="w-full mt-1 rounded-xl px-4 py-3 outline-none" style={inputStyle} />
                </div>
              )}
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>今日の身体の感じは?</label>
                <div className="flex gap-2 mt-2">
                  {["絶好調", "ふつう", "しんどい"].map((f) => (
                    <button key={f} onClick={() => setFeeling(f)} className="flex-1 py-2 rounded-xl text-sm rq-display font-bold"
                      style={feeling === f
                        ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                        : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              {user?.menus?.stress?.enabled && (
                <div>
                  <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>今日の気分は?</label>
                  <div className="flex gap-2 mt-2">
                    {MOOD_OPTIONS.map((m) => (
                      <button key={m} onClick={() => setMoodInput(m)} className="flex-1 py-2 rounded-xl text-sm rq-display font-bold"
                        style={moodInput === m
                          ? { backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }
                          : { backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft, fontWeight: 400 }}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {(user?.fatigueFlag || (user?.inventory && user.inventory.recoveryTicket > 0)) && (
                <label className="flex items-center gap-2 text-xs" style={{ color: C.inkSoft }}>
                  <input type="checkbox" checked={recoveryFocus} onChange={(e) => setRecoveryFocus(e.target.checked)} />
                  {user?.fatigueFlag
                    ? "今日は回復に専念する(+20EXP)"
                    : `回復チケットを使う(+20EXP・残り${user.inventory.recoveryTicket}枚)`}
                </label>
              )}
              <div>
                <label className="text-xs rq-display font-bold" style={{ color: C.inkSoft }}>感想(任意)</label>
                <textarea value={kansoInput} onChange={(e) => setKansoInput(e.target.value)} rows={2} placeholder="今日の一言"
                  className="w-full mt-1 rounded-xl px-4 py-3 outline-none resize-none" style={inputStyle} />
              </div>
              <button onClick={submitRun} disabled={!distanceInput || !feeling || saving}
                className="w-full rounded-xl py-3 rq-display font-bold disabled:opacity-50"
                style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}>
                記録してEXPを獲得
              </button>
            </div>
          </div>
        )}

        {/* ---------- RESULT ---------- */}
        {overlay === "result" && resultData && (
          <div className="fixed inset-0 z-40 flex items-center justify-center px-8">
            <div className="absolute inset-0" style={{ backgroundColor: "rgba(20,30,50,0.65)" }} onClick={() => setOverlay("none")} />
            <div className="relative w-full max-w-sm rounded-3xl px-6 py-8 text-center flex flex-col items-center gap-3"
              style={{ backgroundColor: C.paper, border: `3px solid ${C.gold}` }}>
              {resultData.soloCleared ? (
                <>
                  <div className="text-3xl">🏆</div>
                  <div className="rq-pixel text-sm" style={{ color: C.goldDeep }}>★ モンスター討伐 ★</div>
                  <div className="rq-display font-bold text-lg" style={{ color: C.night }}>
                    {resultData.clearedMonsterName}を倒した!
                  </div>
                  {resultData.bossJustSpawned && (
                    <div className="rq-display font-bold text-sm px-3 py-1 rounded-full" style={{ backgroundColor: "#7A1F2B", color: "#fff" }}>
                      ボスモンスターが現れた!
                    </div>
                  )}
                </>
              ) : resultData.dietCleared ? (
                <>
                  <div className="text-3xl">🎉</div>
                  <div className="rq-pixel text-sm" style={{ color: C.goldDeep }}>★ 目標達成 ★</div>
                  <div className="rq-display font-bold text-lg" style={{ color: C.night }}>
                    ダイエットの目標を達成しました!
                  </div>
                </>
              ) : resultData.leveledUp ? (
                <>
                  <div className="rq-pixel text-sm" style={{ color: C.goldDeep }}>★ LEVEL UP ★</div>
                  <div className="rq-pixel text-4xl" style={{ color: C.goldDeep }}>
                    Lv{resultData.fromLevel} → Lv{resultData.toLevel}
                  </div>
                  {resultData.newTitle && (
                    <div className="rq-display font-bold text-sm px-3 py-1 rounded-full" style={{ backgroundColor: C.night, color: "#fff" }}>
                      称号「{resultData.newTitle}」を獲得!
                    </div>
                  )}
                </>
              ) : (
                <>
                  <Ast size={40} />
                  <div className="rq-pixel text-3xl" style={{ color: C.goldDeep }}>+{resultData.gained} EXP</div>
                </>
              )}

              {resultData.battleMode === "training" && !resultData.trackQualifies && (
                <div className="w-full rounded-xl px-4 py-3 text-xs leading-relaxed" style={{ backgroundColor: C.pinkBg, border: `1px solid ${C.pinkBorder}`, color: C.pinkText }}>
                  自己ベスト+10%に届かず、修行モンスターにはダメージが入らなかった。通常モンスターならこの記録でもダメージが入るよ。
                </div>
              )}
              {resultData.battleMode === "boss" && !resultData.trackQualifies && (
                <div className="w-full rounded-xl px-4 py-3 text-xs leading-relaxed" style={{ backgroundColor: C.pinkBg, border: `1px solid ${C.pinkBorder}`, color: C.pinkText }}>
                  ボスには距離とペースの両方が必要。ダメージはかなり抑えられている。
                </div>
              )}

              {resultData.damageDealt && (
                <div className="w-full text-left rounded-xl px-4 py-3 text-xs leading-relaxed" style={{ backgroundColor: C.night, color: "#fff" }}>
                  <div className="flex items-center justify-between rq-pixel text-sm mb-1">
                    <span>⚔️ {activeMode === "normal" ? "通常" : activeMode === "training" ? "修行" : "ボス"}モンスターへのダメージ</span>
                    <span style={{ color: C.gold }}>{resultData.soloDamage}</span>
                  </div>
                  <div style={{ color: "#B9C4DA" }}>基本:{resultData.damageDealt.base}</div>
                  {resultData.damageDealt.paceMult > 1 && (
                    <div style={{ color: "#B9C4DA" }}>ペースボーナス:×{resultData.damageDealt.paceMult.toFixed(1)}</div>
                  )}
                  {resultData.damageDealt.longRunBonus > 0 && (
                    <div style={{ color: "#B9C4DA" }}>ロングランボーナス:+{resultData.damageDealt.longRunBonus}</div>
                  )}
                  {resultData.clanDamage > 0 && (
                    <div className="mt-1 pt-1" style={{ borderTop: "1px solid #ffffff22", color: C.gold }}>
                      🤝 クランモンスターにも {resultData.clanDamage} ダメージ
                      {resultData.clanDefeated && "(討伐!)"}
                    </div>
                  )}
                  {resultData.clanDefeated && resultData.clanFinalContributors && (
                    <div className="mt-1" style={{ color: "#B9C4DA" }}>
                      {Object.entries(resultData.clanFinalContributors)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 3)
                        .map(([name, dmg], i) => `${i + 1}.${name}(${dmg})`)
                        .join(" / ")}
                    </div>
                  )}
                </div>
              )}
              <div className="w-full text-left rounded-xl px-4 py-3 mt-1 text-xs leading-relaxed" style={{ backgroundColor: "#fff", border: `2px solid ${C.panelBorder}`, color: C.inkSoft }}>
                <div>行動EXP:{resultData.breakdown.actionExp}</div>
                <div>ランEXP:{resultData.breakdown.runExp}(倍率×{resultData.breakdown.mult.toFixed(1)})</div>
                {resultData.breakdown.challengeLabel && (
                  <div>チャレンジEXP:{resultData.breakdown.challengeExp}({resultData.breakdown.challengeLabel})</div>
                )}
                {resultData.breakdown.recoveryBonus > 0 && <div>回復ボーナス:{resultData.breakdown.recoveryBonus}{resultData.usedTicket ? "(回復チケット使用)" : ""}</div>}
                {resultData.breakdown.soloExp > 0 && <div>討伐ボーナス:{resultData.breakdown.soloExp}</div>}
                {resultData.breakdown.menuBonusExp > 0 && <div>達成ボーナス:{resultData.breakdown.menuBonusExp}</div>}
                {resultData.coinsEarned > 0 && (
                  <div className="mt-1 pt-1" style={{ borderTop: `1px solid ${C.panelBorder}`, color: C.goldDeep }}>🪙 コイン獲得:+{resultData.coinsEarned}</div>
                )}
                {resultData.usedBoost && <div style={{ color: C.goldDeep }}>⚡ダメージブースト使用中</div>}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Ast size={26} />
                <p className="text-xs rq-display font-bold" style={{ color: C.night }}>
                  {resultData.soloCleared || resultData.dietCleared ? "ここまでの積み重ねは消えない。おめでとう。" : astMessage("levelup")}
                </p>
              </div>
              <button onClick={() => setOverlay("none")} className="w-full rounded-xl py-3 mt-1 rq-display font-bold"
                style={{ backgroundColor: C.gold, color: "#fff", border: `2px solid ${C.goldDeep}` }}>
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
