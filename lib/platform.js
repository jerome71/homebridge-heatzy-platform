'use strict';

const { HeatzyClient, HeatzyError } = require('./client');
const { DeviceAccessory } = require('./device');
const { ModeSelector } = require('./selector');
const { PRODUCTS, MODES, MODE_V1_INDEX, MODE_SWITCHES, MODE_TITLES } = require('./constants');
const { makeT } = require('./i18n');

const PLUGIN_NAME = '@jerome71/homebridge-heatzy-platform';
const PLATFORM_NAME = 'HeatzyPlatform';
const CONCURRENCY = 4;

const fold = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const KNOWN_MODE_NAMES = new Map(
  [...Object.keys(MODE_SWITCHES), 'Presence'].map((name) => [fold(name), name])
    .concat(Object.entries(MODE_TITLES).map(([title, name]) => [fold(title), name])),
);

/** Maps each `modes` entry to a canonical name (name, displayed label, different case or accents). */
function normalizeModes(modes) {
  const known = [];
  const ignored = [];
  for (const entry of Array.isArray(modes) ? modes : []) {
    const name = KNOWN_MODE_NAMES.get(fold(entry));
    if (name) {
      if (!known.includes(name)) known.push(name);
    } else {
      ignored.push(entry);
    }
  }
  return { known, ignored };
}

// One toggle per mode in the config UI -> canonical mode name (display order).
const MODE_TOGGLES = {
  showModeComfort: 'Confort',
  showModeComfort1: 'Eco',
  showModeComfort2: 'Eco Plus',
  showModeEco: 'Sleep',
  showModeFrostProtection: 'Antifreeze',
  showModeOff: 'Off',
  showModePresence: 'Presence',
};

/**
 * Modes to show: as soon as one "Mode: …" toggle exists in the configuration, the toggles decide
 * (missing = off). Otherwise the legacy `modes` list (previous plugin or earlier version) is read.
 */
function resolveModes(config) {
  const toggled = Object.keys(MODE_TOGGLES).some((key) => config[key] !== undefined);
  if (toggled) return { known: Object.entries(MODE_TOGGLES).filter(([key]) => config[key] === true).map(([, name]) => name), ignored: [] };
  return normalizeModes(config.modes);
}

function normalizeOptions(config) {
  const interval = Number(config.pollInterval);
  return {
    ...config,
    pollInterval: Number.isFinite(interval) ? Math.min(600, Math.max(15, interval)) : 60,
    modes: resolveModes(config).known,
  };
}

class HeatzyPlatform {
  constructor(log, config, api, { client } = {}) {
    this.log = log;
    this.api = api;
    this.options = normalizeOptions(config || {});
    this.t = makeT(this.options.frenchNames === true);
    if (this.options.modes.length > 0) {
      const { known, ignored } = resolveModes(config || {});
      log.info(`Heatzy: modes in use: ${known.join(', ') || 'none'}.`);
      if (ignored.length > 0) log.warn(`Heatzy: unrecognized modes ignored: ${ignored.map((entry) => JSON.stringify(entry)).join(', ')}.`);
    }
    this.cached = new Map(); // uuid -> PlatformAccessory (restored by Homebridge)
    this.devices = new Map(); // uuid -> DeviceAccessory
    this.unknownProducts = new Set();
    this.failing = false;
    this.refreshing = false;
    this.timer = null;
    // The API takes modes as indexes (per its documentation); fall back to labels if it refuses them.
    this.modeEncoding = 'index';

    if (!client && (!this.options.username || !this.options.password)) {
      log.error('Heatzy: enter the e-mail and password of your Heatzy app account in the plugin configuration.');
      return;
    }
    this.client = client || new HeatzyClient({ username: this.options.username, password: this.options.password, log });

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.options.pollInterval * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    for (const device of this.devices.values()) device.dispose();
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const bindings = await this.client.listBindings();
      const seen = new Set();
      const known = [];
      for (const binding of bindings) {
        const product = PRODUCTS[binding.product_key];
        if (!product) {
          if (!this.unknownProducts.has(binding.product_key)) {
            this.unknownProducts.add(binding.product_key);
            this.log.warn(`Module "${binding.dev_alias || binding.did}" ignored: unknown product_key (${binding.product_key}, ${binding.product_name}).`);
          }
          continue;
        }
        const uuid = this.api.hap.uuid.generate(`heatzy:${binding.did}`);
        seen.add(uuid);
        if (this.options.showModeSelector) seen.add(this.selectorUuid(binding.did));
        known.push({ binding, device: this.devices.get(uuid) || this.addDevice(binding, product, uuid) });
      }
      this.removeStale(seen);
      await this.readAll(known);
      if (this.failing) this.log.info('Heatzy: connection restored.');
      this.failing = false;
    } catch (error) {
      // One line per outage, not one per cycle.
      if (!this.failing) this.log.error(`Heatzy: sync failed (${error.message}). Will retry on the next cycle.`);
      this.failing = true;
    } finally {
      this.refreshing = false;
    }
  }

  addDevice(binding, product, uuid) {
    const name = binding.dev_alias || binding.product_name || binding.did;
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.log.info(`Adding ${name} (${product.name})`);
    }
    accessory.context = { did: binding.did };
    const device = new DeviceAccessory(this, accessory, binding, product);
    this.devices.set(uuid, device);
    this.publish(accessory, uuid, isNew);
    if (device.wantsSelector) this.addSelector(device, binding);
    return device;
  }

  selectorUuid(did) {
    return this.api.hap.uuid.generate(`heatzy:${did}:mode-selector`);
  }

  /** Mode selector: a separate "television" accessory tied to the module's state. */
  addSelector(device, binding) {
    const uuid = this.selectorUuid(binding.did);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(`${device.name} ${this.t('selector')}`, uuid, this.api.hap.Categories.TELEVISION);
      this.log.info(`Adding the mode selector of ${device.name}`);
    }
    accessory.context = { did: binding.did, selector: true };
    device.selector = new ModeSelector(device, accessory);
    this.publish(accessory, uuid, isNew);
  }

  publish(accessory, uuid, isNew) {
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    } else {
      this.api.updatePlatformAccessories?.([accessory]);
    }
  }

  removeStale(seen) {
    const stale = [...this.cached.entries()].filter(([uuid]) => !seen.has(uuid));
    for (const [uuid, accessory] of stale) {
      this.log.info(`Removing ${accessory.displayName} (no longer in the Heatzy account)`);
      this.devices.get(uuid)?.dispose();
      this.devices.delete(uuid);
      this.cached.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  async readAll(entries) {
    const queue = [...entries];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          item.device.update(await this.client.getLatest(item.binding.did));
        } catch (error) {
          this.log.warn(`${item.device.name}: read failed (${error.message})`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  /** Sends attributes to a module (Pilote gen. 1: positional `raw` order). */
  async send(did, product, attrs) {
    if (this.options.dryRun) {
      this.log.info(`[dryRun] ${did} <- ${JSON.stringify(attrs)}`);
      return;
    }
    const family = product.family;
    if (family === 'v1') {
      const index = MODE_V1_INDEX[attrs.mode];
      if (index === undefined) throw new Error('This module (Pilote gen. 1) only supports comfort, eco, frost protection and off.');
      await this.client.control(did, { raw: [1, 1, index] });
      return;
    }
    const encode = (encoding) => ({
      attrs: { ...attrs, ...(attrs.mode ? { mode: encoding === 'index' ? MODES.indexOf(attrs.mode) : attrs.mode } : {}) },
    });
    try {
      await this.client.control(did, encode(this.modeEncoding));
    } catch (error) {
      if (!attrs.mode || !(error instanceof HeatzyError) || error.status !== 400) throw error;
      const other = this.modeEncoding === 'index' ? 'label' : 'index';
      await this.client.control(did, encode(other));
      this.modeEncoding = other;
      this.log.info(`Heatzy: modes are now sent as ${other === 'index' ? 'numeric index' : 'label'}.`);
    }
  }
}

module.exports = { HeatzyPlatform, PLUGIN_NAME, PLATFORM_NAME };
