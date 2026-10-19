'use strict';

const { FAMILIES, MODE_SWITCHES, DEFAULT_MODE_SWITCHES, DEROG, COMFORT_RANGE } = require('./constants');
const { defaultNames } = require('./i18n');
const { readState, effectiveMode, targetTemperature, targetTemperatureAttrs, clamp } = require('./state');

const COMFORT_FAMILY = ['cft', 'cft1', 'cft2'];
// The Heatzy cloud sometimes takes several seconds to reflect a command, so re-read several times.
const REFRESH_AFTER_WRITE_MS = [3000, 8000, 15000, 30000];
// How long a value we just wrote takes priority over a still-stale read.
const PENDING_WRITE_MS = 25000;

/**
 * One HomeKit accessory per Heatzy module.
 *  - Pilote Pro: thermostat (temperature, humidity, setpoint, lock, Off/Heat)
 *    + optional switches (boost, vacation, presence, open window, schedule, modes).
 *  - Pilote / Elec'Pro: mode switches + optional extras.
 */
class DeviceAccessory {
  constructor(platform, accessory, binding, product) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.accessory = accessory;
    this.did = binding.did;
    this.product = product;
    this.caps = FAMILIES[product.family];
    this.name = binding.dev_alias || binding.product_name || binding.did;
    this.attrs = {};
    this.state = readState({});
    this.updaters = [];
    this.refreshTimers = [];
    this.pending = {};
    this.setup();
  }

  // ---------- options ----------
  opt(name, proDefault, otherDefault) {
    const value = this.platform.options[name];
    if (value === undefined) return this.caps.pro ? proDefault : otherDefault;
    return Boolean(value);
  }

  /** Single-choice mode tile (separate accessory, created by the platform). */
  get wantsSelector() {
    return this.opt('showModeSelector', false, false);
  }

  /** With the mode tile, also keep one switch per mode (usable in automations). */
  get keepSwitchesWithSelector() {
    return this.opt('showSwitchesWithSelector', false, false);
  }

  /** Modes ticked in the configuration UI, or `null` if none was ever ticked. */
  get configuredModes() {
    const configured = this.platform.options.modes;
    return Array.isArray(configured) && configured.length > 0 ? configured : null;
  }

  /**
   * Presence detection (Pilote Pro) is a mode like the others: it is ticked with the mode toggles.
   * While no mode was ever ticked, the legacy `showPresence` option (on by default) applies.
   */
  get presenceEnabled() {
    if (!this.caps.pro || !this.caps.derog) return false;
    const configured = this.configuredModes;
    return configured ? configured.includes('Presence') : this.opt('showPresence', true, false);
  }

  get boostEnabled() {
    return this.caps.derog && this.opt('showBoost', true, false);
  }

  get vacationEnabled() {
    return this.caps.derog && this.opt('showVacation', false, false);
  }

  /** Individual mode switches (presence is handled separately). */
  get modeSwitchNames() {
    if (this.wantsSelector) return this.selectorModeNames;
    const configured = this.configuredModes;
    if (configured) return configured.filter((name) => name !== 'Presence');
    return this.caps.pro && this.opt('showThermostat', true, false) ? [] : DEFAULT_MODE_SWITCHES;
  }

  /** Modes offered by the selector: the ticked ones, otherwise Comfort / Eco / Frost protection. */
  get selectorModeNames() {
    const configured = this.configuredModes;
    return configured ? configured.filter((name) => name !== 'Presence') : ['Confort', 'Sleep', 'Antifreeze'];
  }

  // ---------- service construction ----------
  setup() {
    const { Service, Characteristic } = this.api.hap;
    const info = this.accessory.getService(Service.AccessoryInformation) || this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Heatzy')
      .setCharacteristic(Characteristic.Model, this.product.name)
      .setCharacteristic(Characteristic.SerialNumber, this.did);

    const wanted = new Set([info]);
    const t = this.platform.t;

    if (this.caps.pro && this.opt('showThermostat', true, false)) wanted.add(this.setupThermostat());

    // With the single-choice mode tile, the ticked modes and presence detection are grouped there, so
    // their individual switches are not created, unless the "also keep one switch per mode" option is
    // on (for automations). Boost and Vacation are not modes: they stay separate switches.
    const individual = !this.wantsSelector || this.keepSwitchesWithSelector;

    for (const name of individual ? this.modeSwitchNames : []) {
      const entry = MODE_SWITCHES[name];
      if (!entry || !this.caps.modes.includes(entry.mode)) continue;
      wanted.add(this.addSwitch(`mode-${entry.mode}`, t(`mode.${entry.mode}`), () => effectiveMode(this.state) === entry.mode, (on) => this.setModeSwitch(entry.mode, on)));
    }

    if (this.boostEnabled) {
      wanted.add(this.addSwitch('boost', t('boost'), () => this.state.derogMode === DEROG.boost, (on) => this.setBoost(on)));
    }
    if (this.vacationEnabled) {
      wanted.add(this.addSwitch('vacation', t('vacation'), () => this.state.derogMode === DEROG.vacation, (on) => this.setVacation(on)));
    }
    if (this.caps.pro) {
      if (individual && this.presenceEnabled) {
        wanted.add(this.addSwitch('presence', t('presence'), () => this.state.derogMode === DEROG.presence, (on) => this.write({ derog_mode: on ? DEROG.presence : DEROG.none, ...(on ? {} : { derog_time: 0 }) })));
      }
      if (this.opt('showWindowDetection', true, false)) {
        wanted.add(this.addSwitch('window', t('window'), () => this.state.window, (on) => this.write({ window_switch: on ? 1 : 0 })));
      }
    }
    if (this.caps.timer && this.opt('showSchedule', true, false)) {
      wanted.add(this.addSwitch('schedule', t('schedule'), () => this.state.timer, (on) => this.write({ timer_switch: on ? 1 : 0 })));
    }
    if (this.caps.lockAttr && !this.caps.pro && this.opt('showLock', false, false)) {
      wanted.add(this.addSwitch('lock', t('lock'), () => this.state.lock, (on) => this.write({ [this.caps.lockAttr]: on ? 1 : 0 })));
    }

    for (const service of [...this.accessory.services]) {
      if (!wanted.has(service)) this.accessory.removeService(service);
    }
  }

  addSwitch(subtype, label, get, set) {
    const { Service, Characteristic } = this.api.hap;
    // Full name "<radiator> <function>", to tell modules apart in the Home app.
    const fullName = `${this.name} ${label}`;
    const service = this.accessory.getServiceById(Service.Switch, subtype) || this.accessory.addService(Service.Switch, fullName, subtype);
    service.setCharacteristic(Characteristic.Name, fullName);
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    // A name chosen by the user is kept; only a previous default name (English or from earlier builds, with or without the
    // radiator name) is replaced.
    const configured = service.getCharacteristic(Characteristic.ConfiguredName);
    const key = subtype.startsWith('mode-') ? `mode.${subtype.slice(5)}` : subtype;
    if (!configured.value || defaultNames(key, this.name).has(configured.value)) configured.updateValue(fullName);
    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => get())
      .onSet(async (value) => set(Boolean(value)));
    this.updaters.push(() => service.updateCharacteristic(Characteristic.On, get()));
    return service;
  }

  setupThermostat() {
    const { Service, Characteristic: C } = this.api.hap;
    const service = this.accessory.getService(Service.Thermostat) || this.accessory.addService(Service.Thermostat, this.name);
    service.setCharacteristic(C.Name, this.name);
    // Not in the HAP thermostat model: declare it to avoid the "Adding anyway" warning.
    service.addOptionalCharacteristic(C.LockPhysicalControls);

    service.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -30, maxValue: 100, minStep: 0.1 }).onGet(() => this.currentTemperature());
    service
      .getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 30, minStep: 0.5 })
      .onGet(() => this.targetTemp())
      .onSet(async (value) => this.write(targetTemperatureAttrs(this.state, value)));
    service.getCharacteristic(C.CurrentHeatingCoolingState).setProps({ validValues: [C.CurrentHeatingCoolingState.OFF, C.CurrentHeatingCoolingState.HEAT] }).onGet(() => this.currentHeatingState());
    service
      .getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT] })
      .onGet(() => this.targetHeatingState())
      .onSet(async (value) => this.setTargetHeatingState(value));
    service.setCharacteristic(C.TemperatureDisplayUnits, C.TemperatureDisplayUnits.CELSIUS);
    service
      .getCharacteristic(C.LockPhysicalControls)
      .onGet(() => (this.state.lock ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED : C.LockPhysicalControls.CONTROL_LOCK_DISABLED))
      .onSet(async (value) => this.write({ [this.caps.lockAttr]: value === C.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 1 : 0 }));
    if (this.opt('showHumidity', true, false)) {
      service.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.state.humidity ?? 0);
    }

    this.updaters.push(() => {
      service.updateCharacteristic(C.CurrentTemperature, this.currentTemperature());
      service.updateCharacteristic(C.TargetTemperature, this.targetTemp());
      service.updateCharacteristic(C.CurrentHeatingCoolingState, this.currentHeatingState());
      service.updateCharacteristic(C.TargetHeatingCoolingState, this.targetHeatingState());
      service.updateCharacteristic(
        C.LockPhysicalControls,
        this.state.lock ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED : C.LockPhysicalControls.CONTROL_LOCK_DISABLED,
      );
      if (this.opt('showHumidity', true, false) && this.state.humidity !== undefined) {
        service.updateCharacteristic(C.CurrentRelativeHumidity, this.state.humidity);
      }
    });
    return service;
  }

  // ---------- HomeKit values ----------
  currentTemperature() {
    return this.state.currentTemp ?? 20;
  }

  targetTemp() {
    return clamp(targetTemperature(this.state), 10, 30);
  }

  currentHeatingState() {
    const { Characteristic: C } = this.api.hap;
    const mode = effectiveMode(this.state);
    if (!mode || mode === 'stop' || mode === 'fro') return C.CurrentHeatingCoolingState.OFF;
    // The Pilote Pro regulates by itself: cur_signal is the order actually sent to the radiator.
    const signal = this.state.curSignal ?? mode;
    return COMFORT_FAMILY.includes(signal) ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF;
  }

  targetHeatingState() {
    const { Characteristic: C } = this.api.hap;
    if (effectiveMode(this.state) === 'stop') return C.TargetHeatingCoolingState.OFF;
    return C.TargetHeatingCoolingState.HEAT;
  }

  // ---------- commands ----------
  /** A vacation/boost override beats everything: cancel it when the user imposes a mode. */
  clearTemporaryDerog(includePresence = false) {
    if (!this.caps.derog) return {};
    const { derogMode } = this.state;
    const temporary = derogMode === DEROG.vacation || derogMode === DEROG.boost || (includePresence && derogMode === DEROG.presence);
    return temporary ? { derog_mode: DEROG.none, derog_time: 0 } : {};
  }

  async setTargetHeatingState(value) {
    const { Characteristic: C } = this.api.hap;
    const timerOff = this.caps.timer ? { timer_switch: 0 } : {};
    if (value === C.TargetHeatingCoolingState.OFF) {
      // Presence would override "off", so it is cancelled too.
      return this.write({ mode: 'stop', ...timerOff, ...this.clearTemporaryDerog(true) });
    }
    const wasStopped = this.state.mode === 'stop' || effectiveMode(this.state) === 'stop';
    return this.write({ ...(wasStopped ? { mode: 'cft' } : {}), ...timerOff, ...this.clearTemporaryDerog() });
  }

  async setModeSwitch(mode, on) {
    if (!on) {
      // A mode cannot be switched "off": put the switch back to its real state.
      setTimeout(() => this.pushState(), 300).unref?.();
      return undefined;
    }
    const lock = this.platform.options.lockThermostats && this.caps.lockAttr ? { [this.caps.lockAttr]: 1 } : {};
    return this.write({ mode, ...this.clearTemporaryDerog(), ...lock });
  }

  async setBoost(on) {
    if (!on) return this.write({ derog_mode: DEROG.none, derog_time: 0 });
    const minutes = clamp(Math.round(this.platform.options.boostMinutes ?? 60), 1, 255);
    return this.write({ derog_mode: DEROG.boost, derog_time: minutes });
  }

  async setVacation(on) {
    if (!on) return this.write({ derog_mode: DEROG.none, derog_time: 0 });
    const days = clamp(Math.round(this.platform.options.vacationDays ?? 7), 1, 255);
    return this.write({ derog_mode: DEROG.vacation, derog_time: days });
  }

  async write(attrs) {
    const { HapStatusError, HAPStatus } = this.api.hap;
    if (Object.keys(attrs).length === 0) return;
    try {
      await this.platform.send(this.did, this.product, attrs);
    } catch (error) {
      this.log.error(`${this.name}: command rejected (${error.message})`);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.debug(`${this.name} : ${JSON.stringify(attrs)}`);
    const expected = { ...attrs, ...this.expectedReadings(attrs) };
    this.attrs = { ...this.attrs, ...expected };
    const until = Date.now() + PENDING_WRITE_MS;
    for (const [key, value] of Object.entries(expected)) {
      if (key !== 'derog_time') this.pending[key] = { value, until };
    }
    this.pushState();
    this.scheduleRefresh();
  }

  /**
   * Read-only values the module will most likely report after this command.
   * Without them, `cur_mode` (the mode actually applied, which takes priority for display) would stay stale
   * until the next read and the tile would briefly snap back to the old mode. The next read corrects it.
   */
  expectedReadings(attrs) {
    if (attrs.derog_mode === DEROG.boost) return { cur_mode: 'cft' };
    if (attrs.derog_mode === DEROG.vacation) return { cur_mode: 'fro' };
    if (attrs.mode && attrs.derog_mode !== DEROG.presence) return { cur_mode: attrs.mode };
    return {};
  }

  // ---------- state ----------
  update(attrs) {
    this.attrs = this.withPending(attrs);
    this.pushState();
  }

  /**
   * Until the cloud catches up with a command we just sent, reads stay stale: keep the written value
   * (for at most PENDING_WRITE_MS) so the tile does not jump back.
   */
  withPending(attrs) {
    const merged = { ...attrs };
    const now = Date.now();
    for (const [key, { value, until }] of Object.entries(this.pending)) {
      const same = String(merged[key]).toLowerCase() === String(value).toLowerCase();
      if (same || now > until) delete this.pending[key];
      else merged[key] = value;
    }
    return merged;
  }

  pushState() {
    this.state = readState(this.attrs);
    for (const updater of this.updaters) {
      try {
        updater();
      } catch (error) {
        this.log.debug(`${this.name}: HomeKit update failed (${error.message})`);
      }
    }
  }

  /** Forced re-reads after a command (3, 8, 15 and 30 s), in addition to periodic polling. */
  scheduleRefresh() {
    this.clearRefreshTimers();
    this.refreshTimers = REFRESH_AFTER_WRITE_MS.map((delay) => {
      const timer = setTimeout(async () => {
        try {
          this.update(await this.platform.client.getLatest(this.did));
        } catch (error) {
          this.log.debug(`${this.name}: re-read failed (${error.message})`);
        }
      }, delay);
      timer.unref?.();
      return timer;
    });
  }

  clearRefreshTimers() {
    for (const timer of this.refreshTimers) clearTimeout(timer);
    this.refreshTimers = [];
  }

  dispose() {
    this.clearRefreshTimers();
  }
}

DeviceAccessory.COMFORT_RANGE = COMFORT_RANGE;
module.exports = { DeviceAccessory };
