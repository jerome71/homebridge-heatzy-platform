'use strict';

// Names shown in HomeKit: English by default, French (as in the Pilote Pro manual) with the `frenchNames` option.
const EN = {
  'mode.cft': 'Comfort',
  'mode.cft1': 'Comfort -1',
  'mode.cft2': 'Comfort -2',
  'mode.eco': 'Eco',
  'mode.fro': 'Frost protection',
  'mode.stop': 'Off',
  presence: 'Presence detection',
  boost: 'Boost',
  vacation: 'Vacation',
  window: 'Open-window detection',
  schedule: 'Schedule',
  lock: 'Lock',
  selector: 'Heating mode',
  'selector.model': 'mode selector',
};

const FR = {
  'mode.cft': 'Confort',
  'mode.cft1': 'Confort -1',
  'mode.cft2': 'Confort -2',
  'mode.eco': 'Éco',
  'mode.fro': 'Hors-gel',
  'mode.stop': 'Arrêt',
  presence: 'Détection de présence',
  boost: 'Boost',
  vacation: 'Vacances',
  window: 'Détection de fenêtre ouverte',
  schedule: 'Programmation',
  lock: 'Verrouillage',
  selector: 'Mode de chauffage',
  'selector.model': 'sélecteur de mode',
};

// Names used by earlier pre-release builds. Like the two sets above, they count as untouched defaults, so
// they get replaced when the language changes; a name the user chose is never touched.
const PREVIOUS_DEFAULTS = {
  window: ['Détection fenêtre ouverte'],
  selector: ['mode'],
};

const makeT = (french) => (key) => (french ? FR : EN)[key] ?? key;

/** Every default name an item has ever had (used to migrate untouched names), with and without the radiator name. */
function defaultNames(key, deviceName) {
  const labels = new Set([EN[key], FR[key], ...(PREVIOUS_DEFAULTS[key] ?? [])].filter(Boolean));
  const names = new Set(labels);
  for (const label of labels) names.add(`${deviceName} ${label}`);
  return names;
}

module.exports = { makeT, defaultNames };
