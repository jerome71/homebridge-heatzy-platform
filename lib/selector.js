'use strict';

const { DEROG, MODE_SWITCHES } = require('./constants');
const { effectiveMode } = require('./state');
const { defaultNames } = require('./i18n');

// Stable source identifiers (HomeKit remembers the selected source).
const MODE_IDS = { cft: 1, eco: 2, fro: 3, cft1: 5, cft2: 6, stop: 7 };
const DEROG_INPUTS = [{ id: 4, key: 'presence', derog: DEROG.presence }];
// Display order of the modes, whatever order they were ticked in.
const MODE_ORDER = ['Confort', 'Eco', 'Eco Plus', 'Sleep', 'Antifreeze', 'Off'];

/**
 * Single-choice tile: a HomeKit "television" whose sources are the settings ticked in the configuration
 * (modes and presence detection). Boost and Vacation are not part of it.
 * The selected source is what is actually applied.
 * It lives in its own accessory so the thermostat tile does not turn into a television.
 */
class ModeSelector {
  constructor(device, accessory) {
    this.device = device;
    this.accessory = accessory;
    this.inputs = this.buildInputs();
    this.lastId = this.inputs[0].id;

    const { Service, Characteristic: C } = device.api.hap;
    const name = `${device.name} ${device.platform.t('selector')}`;
    const previousDefaults = defaultNames('selector', device.name); // any previous default name

    const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(C.Manufacturer, 'Heatzy')
      .setCharacteristic(C.Model, `${device.product.name} – ${device.platform.t('selector.model')}`)
      .setCharacteristic(C.SerialNumber, `${device.did}-mode`);

    const tv = accessory.getService(Service.Television) || accessory.addService(Service.Television, name);
    // A name chosen by the user in the Home app is kept; only a previous default name is replaced.
    const current = tv.getCharacteristic(C.ConfiguredName).value;
    if (!current || previousDefaults.has(current)) tv.setCharacteristic(C.ConfiguredName, name);
    if (previousDefaults.has(accessory.displayName)) {
      accessory.displayName = name;
      info.setCharacteristic(C.Name, name);
    }
    tv.setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    tv.getCharacteristic(C.Active)
      .onGet(() => this.isActive())
      .onSet(async (value) => this.setActive(value === C.Active.ACTIVE));
    tv.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.selectedId())
      .onSet(async (value) => this.select(Number(value)));
    tv.getCharacteristic(C.RemoteKey).onSet(async () => undefined);

    const wanted = new Set([info, tv]);
    for (const input of this.inputs) {
      const service = accessory.getServiceById(Service.InputSource, `input-${input.key}`) || accessory.addService(Service.InputSource, input.label, `input-${input.key}`);
      service
        .setCharacteristic(C.Identifier, input.id)
        .setCharacteristic(C.ConfiguredName, input.label)
        .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .setCharacteristic(C.InputSourceType, C.InputSourceType.OTHER)
        .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
      tv.addLinkedService(service);
      wanted.add(service);
    }
    for (const service of [...accessory.services]) {
      if (!wanted.has(service)) accessory.removeService(service);
    }

    this.tv = tv;
    device.updaters.push(() => {
      tv.updateCharacteristic(C.Active, this.isActive() ? C.Active.ACTIVE : C.Active.INACTIVE);
      tv.updateCharacteristic(C.ActiveIdentifier, this.selectedId());
    });
  }

  /** Sources = settings ticked in the configuration, filtered by what the module supports. */
  buildInputs() {
    const { device } = this;
    const t = device.platform.t;
    const selected = new Set(device.selectorModeNames);
    const inputs = [];
    for (const name of MODE_ORDER) {
      const entry = MODE_SWITCHES[name];
      if (!selected.has(name) || !entry || !device.caps.modes.includes(entry.mode)) continue;
      inputs.push({ id: MODE_IDS[entry.mode], key: entry.mode, label: t(`mode.${entry.mode}`), mode: entry.mode });
    }
    const enabled = { presence: device.presenceEnabled };
    for (const input of DEROG_INPUTS) {
      if (enabled[input.key]) inputs.push({ ...input, label: t(input.key) });
    }
    // Safeguard: a selector without any source makes no sense.
    if (inputs.length === 0) inputs.push({ id: MODE_IDS.cft, key: 'cft', label: t('mode.cft'), mode: 'cft' });
    return inputs;
  }

  has(key) {
    return this.inputs.find((input) => input.key === key);
  }

  isActive() {
    return effectiveMode(this.device.state) !== 'stop';
  }

  selectedId() {
    const { state } = this.device;
    const active = DEROG_INPUTS.find((input) => input.derog === state.derogMode && this.has(input.key));
    if (active) return active.id;
    const mode = effectiveMode(state);
    // comfort-1 / comfort-2 without their own source are shown as "Comfort".
    const input = this.has(mode) || (mode === 'cft1' || mode === 'cft2' ? this.has('cft') : undefined);
    if (input) this.lastId = input.id;
    return this.lastId;
  }

  async setActive(on) {
    const { Characteristic: C } = this.device.api.hap;
    return this.device.setTargetHeatingState(on ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF);
  }

  async select(id) {
    const { device } = this;
    const input = this.inputs.find((candidate) => candidate.id === id);
    if (!input) return undefined;
    if (input.key === 'presence') return device.write({ derog_mode: DEROG.presence });
    if (input.mode === 'stop') {
      const { Characteristic: C } = device.api.hap;
      return device.setTargetHeatingState(C.TargetHeatingCoolingState.OFF);
    }
    // Exclusive choice: any override (vacation, boost, presence) is cancelled, otherwise it would win.
    const clear = device.caps.derog && device.state.derogMode !== DEROG.none ? { derog_mode: DEROG.none, derog_time: 0 } : {};
    return device.write({ mode: input.mode, ...clear });
  }
}

module.exports = { ModeSelector };
