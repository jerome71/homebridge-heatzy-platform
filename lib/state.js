'use strict';

const { MODES, MODE_ALIASES, DEROG, COMFORT_RANGE, ECO_RANGE, FROST_TEMP } = require('./constants');

/** Case-insensitive lookup (the API mixes `heating_state` / `Heating_state`, `LOCK_C`...). */
function pick(attrs, ...names) {
  const lower = new Map(Object.keys(attrs).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = lower.get(name.toLowerCase());
    if (key !== undefined && attrs[key] !== null && attrs[key] !== undefined) return attrs[key];
  }
  return undefined;
}

/** `mode` may arrive as a label (cft), an index (0) or Chinese (Pilote gen. 1). */
function parseMode(value) {
  if (typeof value === 'number') return MODES[value] ?? null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (MODES.includes(text)) return text;
  if (MODE_ALIASES[text]) return MODE_ALIASES[text];
  if (/^\d+$/.test(text)) return MODES[Number(text)] ?? null;
  return null;
}

function parseBool(value) {
  if (typeof value === 'string') return ['1', 'true', 'on'].includes(value.toLowerCase());
  return Boolean(value);
}

function parseNumber(value) {
  const number = Number(value);
  return value === undefined || value === null || Number.isNaN(number) ? undefined : number;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Raw Gizwits attributes -> normalized state (temperatures in °C). */
function readState(attrs) {
  const curTemp = parseNumber(pick(attrs, 'cur_temp'));
  const cftTemp = parseNumber(pick(attrs, 'cft_temp'));
  const ecoTemp = parseNumber(pick(attrs, 'eco_temp'));
  const humidity = parseNumber(pick(attrs, 'cur_humi'));
  const heating = pick(attrs, 'heating_state');
  return {
    mode: parseMode(pick(attrs, 'mode')),
    curMode: parseMode(pick(attrs, 'cur_mode')),
    curSignal: parseMode(pick(attrs, 'cur_signal')),
    timer: parseBool(pick(attrs, 'timer_switch')),
    lock: parseBool(pick(attrs, 'lock_switch', 'LOCK_C')),
    window: parseBool(pick(attrs, 'window_switch')),
    derogMode: parseNumber(pick(attrs, 'derog_mode')) ?? DEROG.none,
    derogTime: parseNumber(pick(attrs, 'derog_time')) ?? 0,
    currentTemp: curTemp === undefined ? undefined : curTemp / 10,
    comfortTemp: cftTemp === undefined ? undefined : cftTemp / 10,
    ecoTemp: ecoTemp === undefined ? undefined : ecoTemp / 10,
    humidity,
    heating: heating === undefined ? undefined : parseBool(heating),
  };
}

/** Mode actually applied: `cur_mode` (Pro), otherwise the commanded `mode`. */
const effectiveMode = (state) => state.curMode ?? state.mode;

/** Setpoint shown in HomeKit for the applied mode (comfort-1/-2 = comfort minus 1/2 °C). */
function targetTemperature(state) {
  const comfort = state.comfortTemp ?? 19;
  const eco = state.ecoTemp ?? 16;
  switch (effectiveMode(state)) {
    case 'eco':
      return eco;
    case 'cft1':
      return comfort - 1;
    case 'cft2':
      return comfort - 2;
    case 'fro':
      return FROST_TEMP;
    default:
      return comfort;
  }
}

/**
 * Attributes to write to reach `celsius` in the applied mode.
 * Eco -> eco_temp (10-19 °C); comfort / comfort-1 / comfort-2 -> cft_temp (15-30 °C);
 * frost protection and off have no setpoint, so the comfort setpoint is adjusted instead.
 */
function targetTemperatureAttrs(state, celsius) {
  const rounded = Math.round(celsius * 2) / 2;
  const mode = effectiveMode(state);
  if (mode === 'eco') {
    return { eco_temp: Math.round(clamp(rounded, ECO_RANGE.min, ECO_RANGE.max) * 10) };
  }
  const offset = mode === 'cft1' ? 1 : mode === 'cft2' ? 2 : 0;
  return { cft_temp: Math.round(clamp(rounded + offset, COMFORT_RANGE.min, COMFORT_RANGE.max) * 10) };
}

module.exports = { pick, parseMode, parseBool, readState, effectiveMode, targetTemperature, targetTemperatureAttrs, clamp };
