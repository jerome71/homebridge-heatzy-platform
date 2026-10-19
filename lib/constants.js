'use strict';

// The Heatzy API is the Gizwits platform (official Heatzy Open API documentation).
const API_BASE_URL = 'https://euapi.gizwits.com/app';
const APPLICATION_ID = 'c70a66ff039d41b4a220e198b0fcc8b3';

// Order = numeric index of the `mode` / `cur_mode` / `cur_signal` enumeration.
const MODES = ['cft', 'eco', 'fro', 'stop', 'cft1', 'cft2'];

// Alternative labels the API may return when reading (including Chinese labels on the Pilote gen. 1).
const MODE_ALIASES = {
  off: 'stop',
  '停止': 'stop',
  '经济': 'eco',
  '舒适': 'cft',
  '解冻': 'fro',
};

// Pilote gen. 1: positional order [1,1,n].
const MODE_V1_INDEX = { cft: 0, eco: 1, fro: 2, stop: 3 };

// Mode names inherited from the previous plugin (legacy `modes` config key). Display names come from i18n.
const MODE_SWITCHES = {
  Confort: { mode: 'cft' },
  Eco: { mode: 'cft1' },
  'Eco Plus': { mode: 'cft2' },
  Sleep: { mode: 'eco' },
  Antifreeze: { mode: 'fro' },
  Off: { mode: 'stop' },
};
// Labels shown in the configuration UI -> canonical mode name.
// Used to read the legacy `modes` list however the UI stored the ticked box.
const MODE_TITLES = {
  'Comfort -1 (Eco)': 'Eco',
  'Comfort -2 (Eco Plus)': 'Eco Plus',
  'Eco (Sleep)': 'Sleep',
  'Frost protection (Antifreeze)': 'Antifreeze',
  Comfort: 'Confort',
  'Frost protection': 'Antifreeze',
  Presence: 'Presence',
  'Presence detection': 'Presence',
  'Confort -1 (Eco)': 'Eco',
  'Confort -2 (Eco Plus)': 'Eco Plus',
  'Éco (Sleep)': 'Sleep',
  'Hors-gel (Antifreeze)': 'Antifreeze',
  'Arrêt (Off)': 'Off',
  'Détection de présence': 'Presence',
  'Détection de présence (Pilote Pro uniquement)': 'Presence',
};
const DEFAULT_MODE_SWITCHES = ['Confort', 'Sleep', 'Antifreeze', 'Off'];

// Overrides (derog_mode)
const DEROG = { none: 0, vacation: 1, boost: 2, presence: 3 };

// Capabilities per product family.
const BASE_MODES = ['cft', 'eco', 'fro', 'stop'];
const FAMILIES = {
  v1: { modes: BASE_MODES, raw: true, derog: false, timer: false, lockAttr: null, pro: false },
  v2: { modes: BASE_MODES, raw: false, derog: true, timer: true, lockAttr: 'lock_switch', pro: false },
  v4: { modes: MODES, raw: false, derog: true, timer: true, lockAttr: 'lock_switch', pro: false },
  pro: { modes: MODES, raw: false, derog: true, timer: true, lockAttr: 'lock_switch', pro: true },
  // Glow / Onyx / Shine: minimal support (modes, lock, overrides), untested on hardware.
  glow: { modes: MODES, raw: false, derog: true, timer: true, lockAttr: 'LOCK_C', pro: false },
};

// product_key -> product (official generations guide + Gizwits schemas).
const PRODUCTS = {
  '9420ae048da545c88fc6274d204dd25f': { name: 'Pilote (gen. 1)', family: 'v1' },
  '51d16c22a5f74280bc3cfe9ebcdc6402': { name: 'Pilote (gen. 2)', family: 'v2' },
  '4fc968a21e7243b390e9ede6f1c6465d': { name: "Elec'Pro (gen. 2)", family: 'v2' },
  b9a67b6ce24b437d9794103fd317e627: { name: 'Pilote (gen. 3)', family: 'v2' },
  b8c6657b66c34148b4dee64d615cefc7: { name: "Elec'Pro (gen. 3)", family: 'v2' },
  '46409c7f29d4411c85a3a46e5ee3703e': { name: 'Pilote (gen. 4)', family: 'v4' },
  '9dacde7ef459421eaf8dc4bea9385634': { name: "Elec'Pro (gen. 4)", family: 'v4' },
  a77a929fcf0d4631bc4f669080376891: { name: 'Pilote Pro', family: 'pro' },
  '2fd622e45283470f9e27e8e6167d7533': { name: 'Glow', family: 'glow' },
  cffa0df68a52449085c5d1e72c2f6bb0: { name: 'Glow', family: 'glow' },
  '2884feb88e0b4f30b75ea5572276a102': { name: 'Shine', family: 'glow' },
  bb10d064f8de409db633b750faa22a52: { name: 'Onyx', family: 'glow' },
};

// Pilote Pro setpoint ranges (°C), from the official documentation.
const COMFORT_RANGE = { min: 15, max: 30 };
const ECO_RANGE = { min: 10, max: 19 };
const FROST_TEMP = 7;

module.exports = {
  API_BASE_URL,
  APPLICATION_ID,
  MODES,
  MODE_ALIASES,
  MODE_V1_INDEX,
  MODE_SWITCHES,
  MODE_TITLES,
  DEFAULT_MODE_SWITCHES,
  DEROG,
  FAMILIES,
  PRODUCTS,
  COMFORT_RANGE,
  ECO_RANGE,
  FROST_TEMP,
};
