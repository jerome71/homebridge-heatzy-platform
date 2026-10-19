'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('hap-nodejs');

const { HeatzyPlatform } = require('../lib/platform');
const { HeatzyError } = require('../lib/client');

const { Service, Characteristic: C } = hap;
const PRO_KEY = 'a77a929fcf0d4631bc4f669080376891';
const V1_KEY = '9420ae048da545c88fc6274d204dd25f';
const V4_KEY = '46409c7f29d4411c85a3a46e5ee3703e';

class FakeAccessory extends hap.Accessory {
  constructor(name, uuid) {
    super(name, uuid);
    this.context = {};
  }
}

const makeLog = () => {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level}: ${message}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
};

const makeApi = () => ({
  hap,
  platformAccessory: FakeAccessory,
  on() {},
  registerPlatformAccessories() {},
  updatePlatformAccessories() {},
  unregisterPlatformAccessories() {},
});

const PRO_ATTRS = {
  mode: 'cft',
  cur_mode: 'cft',
  cur_signal: 'cft',
  cur_temp: 215,
  cur_humi: 48,
  cft_temp: 195,
  eco_temp: 160,
  lock_switch: 0,
  timer_switch: 0,
  window_switch: 1,
  derog_mode: 0,
  derog_time: 0,
};

async function setup({ bindings, attrsByDid, config = {}, controlImpl }) {
  const calls = [];
  const client = {
    async listBindings() {
      return bindings;
    },
    async getLatest(did) {
      return { ...attrsByDid[did] };
    },
    async control(did, payload) {
      calls.push({ did, payload });
      if (controlImpl) await controlImpl(did, payload, calls.length);
    },
  };
  const log = makeLog();
  const platform = new HeatzyPlatform(log, config, makeApi(), { client });
  await platform.refresh();
  const devices = [...platform.devices.values()];
  return { platform, devices, calls, log };
}

const proBinding = { did: 'pro1', dev_alias: 'Salon', product_key: PRO_KEY, product_name: 'Pilote Pro' };

test('Pilote Pro: thermostat with temperature, humidity and setpoint', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const acc = devices[0].accessory;
  const thermostat = acc.getService(Service.Thermostat);
  assert.ok(thermostat, 'thermostat service present');
  assert.equal(await thermostat.getCharacteristic(C.CurrentTemperature).handleGetRequest(), 21.5);
  assert.equal(await thermostat.getCharacteristic(C.CurrentRelativeHumidity).handleGetRequest(), 48);
  assert.equal(await thermostat.getCharacteristic(C.TargetTemperature).handleGetRequest(), 19.5);
  assert.equal(await thermostat.getCharacteristic(C.TargetHeatingCoolingState).handleGetRequest(), C.TargetHeatingCoolingState.HEAT);
  assert.equal(await thermostat.getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest(), C.CurrentHeatingCoolingState.HEAT);
});

test('Pilote Pro: cur_signal eco -> radiator idle', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: { ...PRO_ATTRS, cur_signal: 'eco' } } });
  const thermostat = devices[0].accessory.getService(Service.Thermostat);
  assert.equal(await thermostat.getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest(), C.CurrentHeatingCoolingState.OFF);
});

test('Pilote Pro: changing the setpoint writes cft_temp in tenths of a degree', async () => {
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const thermostat = devices[0].accessory.getService(Service.Thermostat);
  await thermostat.getCharacteristic(C.TargetTemperature).handleSetRequest(21);
  assert.deepEqual(calls.at(-1).payload, { attrs: { cft_temp: 210 } });
});

test('Pilote Pro: in eco mode the setpoint targets eco_temp (capped at 19 °C)', async () => {
  const attrs = { ...PRO_ATTRS, mode: 'eco', cur_mode: 'eco' };
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: attrs } });
  const thermostat = devices[0].accessory.getService(Service.Thermostat);
  assert.equal(await thermostat.getCharacteristic(C.TargetTemperature).handleGetRequest(), 16);
  await thermostat.getCharacteristic(C.TargetTemperature).handleSetRequest(25);
  assert.deepEqual(calls.at(-1).payload, { attrs: { eco_temp: 190 } });
});

test('Pilote Pro: in comfort-1 the displayed setpoint is cft_temp - 1 °C', async () => {
  const attrs = { ...PRO_ATTRS, mode: 'cft1', cur_mode: 'cft1' };
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: attrs } });
  const thermostat = devices[0].accessory.getService(Service.Thermostat);
  assert.equal(await thermostat.getCharacteristic(C.TargetTemperature).handleGetRequest(), 18.5);
  await thermostat.getCharacteristic(C.TargetTemperature).handleSetRequest(18);
  assert.deepEqual(calls.at(-1).payload, { attrs: { cft_temp: 190 } });
});

test('Pilote Pro: the thermostat only has Off / Heat, Auto is a separate switch', async () => {
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const target = devices[0].accessory.getService(Service.Thermostat).getCharacteristic(C.TargetHeatingCoolingState);
  await target.handleSetRequest(C.TargetHeatingCoolingState.OFF);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 3, timer_switch: 0 } });
  await target.handleSetRequest(C.TargetHeatingCoolingState.HEAT);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 0, timer_switch: 0 } }, 'goes back to comfort from off');
  assert.deepEqual(target.props.validValues, [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT]);
  const schedule = devices[0].accessory.getServiceById(Service.Switch, 'schedule');
  assert.ok(schedule, 'Schedule switch present by default on the Pilote Pro');
  await schedule.getCharacteristic(C.On).handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { timer_switch: 1 } });
  assert.equal(await schedule.getCharacteristic(C.On).handleGetRequest(), true);
  await schedule.getCharacteristic(C.On).handleSetRequest(false);
  assert.deepEqual(calls.at(-1).payload, { attrs: { timer_switch: 0 } });
});

test('Pilote Pro: an active schedule shows as Heat, not Auto', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: { ...PRO_ATTRS, timer_switch: 1 } } });
  const target = devices[0].accessory.getService(Service.Thermostat).getCharacteristic(C.TargetHeatingCoolingState);
  assert.equal(await target.handleGetRequest(), C.TargetHeatingCoolingState.HEAT);
  assert.equal(await devices[0].accessory.getServiceById(Service.Switch, 'schedule').getCharacteristic(C.On).handleGetRequest(), true);
});

test('Pilote Pro: after Off the tile reflects the new state immediately (stale cur_mode corrected)', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const thermostat = devices[0].accessory.getService(Service.Thermostat);
  const target = thermostat.getCharacteristic(C.TargetHeatingCoolingState);
  await target.handleSetRequest(C.TargetHeatingCoolingState.OFF);
  assert.equal(await target.handleGetRequest(), C.TargetHeatingCoolingState.OFF);
  assert.equal(await thermostat.getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest(), C.CurrentHeatingCoolingState.OFF);
});

test('Pilote Pro: a running boost is cancelled when Off is imposed', async () => {
  const attrs = { ...PRO_ATTRS, derog_mode: 2, derog_time: 30 };
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: attrs } });
  const target = devices[0].accessory.getService(Service.Thermostat).getCharacteristic(C.TargetHeatingCoolingState);
  await target.handleSetRequest(C.TargetHeatingCoolingState.OFF);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 3, timer_switch: 0, derog_mode: 0, derog_time: 0 } });
});

test('Pilote Pro: lock, boost, presence and open window', async () => {
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { boostMinutes: 45 } });
  const acc = devices[0].accessory;
  const on = (subtype) => acc.getServiceById(Service.Switch, subtype).getCharacteristic(C.On);

  await acc.getService(Service.Thermostat).getCharacteristic(C.LockPhysicalControls).handleSetRequest(C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
  assert.deepEqual(calls.at(-1).payload, { attrs: { lock_switch: 1 } });

  await on('boost').handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { derog_mode: 2, derog_time: 45 } });
  assert.equal(await on('boost').handleGetRequest(), true, 'optimistic state after a write');
  await on('boost').handleSetRequest(false);
  assert.deepEqual(calls.at(-1).payload, { attrs: { derog_mode: 0, derog_time: 0 } });

  await on('presence').handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { derog_mode: 3 } });

  assert.equal(await on('window').handleGetRequest(), true, 'window_switch=1 read from the API');
  await on('window').handleSetRequest(false);
  assert.deepEqual(calls.at(-1).payload, { attrs: { window_switch: 0 } });
});

test('Pilote Pro: the (legacy) mode switches are optional', async () => {
  const { devices, calls } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    config: { modes: ['Confort', 'Eco Plus', 'Sleep'] },
  });
  const acc = devices[0].accessory;
  const sw = (mode) => acc.getServiceById(Service.Switch, `mode-${mode}`).getCharacteristic(C.On);
  assert.equal(await sw('cft').handleGetRequest(), true);
  assert.equal(await sw('eco').handleGetRequest(), false);
  await sw('cft2').handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 5 } });
  assert.equal(acc.getServiceById(Service.Switch, 'mode-stop'), undefined, 'Off not requested');
});

test('Pilote 4: default switches, no thermostat, comfort-1 available', async () => {
  const binding = { did: 'p4', dev_alias: 'Chambre', product_key: V4_KEY, product_name: 'Pilote_Soc_C3' };
  const { devices, calls } = await setup({
    bindings: [binding],
    attrsByDid: { p4: { mode: 'eco', timer_switch: 0, lock_switch: 0, derog_mode: 0 } },
    config: { modes: ['Confort', 'Eco', 'Off'], lockThermostats: true },
  });
  const acc = devices[0].accessory;
  assert.equal(acc.getService(Service.Thermostat), undefined);
  await acc.getServiceById(Service.Switch, 'mode-cft1').getCharacteristic(C.On).handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 4, lock_switch: 1 } });
});

test('Pilote 1: positional raw order and Chinese labels', async () => {
  const binding = { did: 'p1', dev_alias: 'Bureau', product_key: V1_KEY, product_name: 'Heatzy' };
  const { devices, calls } = await setup({ bindings: [binding], attrsByDid: { p1: { mode: '舒适' } } });
  const acc = devices[0].accessory;
  const on = (mode) => acc.getServiceById(Service.Switch, `mode-${mode}`).getCharacteristic(C.On);
  assert.equal(await on('cft').handleGetRequest(), true, '舒适 = comfort');
  assert.equal(acc.getServiceById(Service.Switch, 'mode-cft1'), undefined, 'pas de confort-1 sur le Pilote 1');
  await on('stop').handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { raw: [1, 1, 3] });
});

test('If the API refuses numeric modes, fall back to labels', async () => {
  const { devices, calls, platform } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    config: { modes: ['Off'] },
    controlImpl: async (_did, payload) => {
      if (payload.attrs && typeof payload.attrs.mode === 'number') throw new HeatzyError('HTTP 400', { status: 400, code: 9999 });
    },
  });
  const acc = devices[0].accessory;
  await acc.getServiceById(Service.Switch, 'mode-stop').getCharacteristic(C.On).handleSetRequest(true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].payload, { attrs: { mode: 'stop' } });
  assert.equal(platform.modeEncoding, 'label');
});

test('Write failure: HomeKit error, no fake state', async () => {
  const { devices } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    controlImpl: async () => {
      throw new HeatzyError('Network: down');
    },
  });
  const target = devices[0].accessory.getService(Service.Thermostat).getCharacteristic(C.TargetHeatingCoolingState);
  // HAP-NodeJS converts the HapStatusError into a status code returned to HomeKit.
  await assert.rejects(target.handleSetRequest(C.TargetHeatingCoolingState.OFF), (status) => status === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(await target.handleGetRequest(), C.TargetHeatingCoolingState.HEAT);
});

test('Mode selector: off by default', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  assert.equal(devices[0].selector, undefined);
});

test('Mode selector: list of sources and current selection', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeSelector: true } });
  const tv = devices[0].selector.accessory.getService(Service.Television);
  const names = devices[0].selector.accessory.services.filter((s) => s.UUID === Service.InputSource.UUID).map((s) => s.getCharacteristic(C.ConfiguredName).value);
  assert.deepEqual(names, ['Comfort', 'Eco', 'Frost protection', 'Presence detection']);
  assert.equal(await tv.getCharacteristic(C.ActiveIdentifier).handleGetRequest(), 1);
  assert.equal(await tv.getCharacteristic(C.Active).handleGetRequest(), C.Active.ACTIVE);
});

test('Mode selector: reflects eco, frost protection, presence and off', async () => {
  const states = [
    [{ mode: 'eco', cur_mode: 'eco' }, 2, C.Active.ACTIVE],
    [{ mode: 'fro', cur_mode: 'fro' }, 3, C.Active.ACTIVE],
    [{ mode: 'cft1', cur_mode: 'cft1' }, 1, C.Active.ACTIVE],
    [{ derog_mode: 3, cur_mode: 'cft' }, 4, C.Active.ACTIVE],
    [{ mode: 'stop', cur_mode: 'stop' }, 1, C.Active.INACTIVE],
  ];
  for (const [patch, id, active] of states) {
    const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: { ...PRO_ATTRS, ...patch } }, config: { showModeSelector: true } });
    const tv = devices[0].selector.accessory.getService(Service.Television);
    assert.equal(await tv.getCharacteristic(C.ActiveIdentifier).handleGetRequest(), id, JSON.stringify(patch));
    assert.equal(await tv.getCharacteristic(C.Active).handleGetRequest(), active, JSON.stringify(patch));
  }
});

test('Mode selector: choosing a mode cancels presence/boost, choosing presence enables it', async () => {
  const { devices, calls } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: { ...PRO_ATTRS, derog_mode: 3 } },
    config: { showModeSelector: true },
  });
  const tv = devices[0].selector.accessory.getService(Service.Television);
  const select = tv.getCharacteristic(C.ActiveIdentifier);
  await select.handleSetRequest(2);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 1, derog_mode: 0, derog_time: 0 } });
  await select.handleSetRequest(3);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 2 } }, 'no override left to cancel');
  await select.handleSetRequest(4);
  assert.deepEqual(calls.at(-1).payload, { attrs: { derog_mode: 3 } });
  assert.equal(await select.handleGetRequest(), 4, 'optimistic state');
  await select.handleSetRequest(1);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 0, derog_mode: 0, derog_time: 0 } });
});

test('Mode selector: the on/off button turns the heating off then on', async () => {
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeSelector: true } });
  const active = devices[0].selector.accessory.getService(Service.Television).getCharacteristic(C.Active);
  await active.handleSetRequest(C.Active.INACTIVE);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 3, timer_switch: 0 } });
  await active.handleSetRequest(C.Active.ACTIVE);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 0, timer_switch: 0 } });
});

const inputNames = (device) => device.selector.accessory.services.filter((s) => s.UUID === Service.InputSource.UUID).map((s) => s.getCharacteristic(C.ConfiguredName).value);
const switchSubtypes = (device) => device.accessory.services.filter((s) => s.UUID === Service.Switch.UUID).map((s) => s.subtype);

test('With the selector, only the mode and presence switches disappear (Boost and Vacation stay)', async () => {
  const config = { modes: ['Confort', 'Sleep', 'Presence'], showVacation: true };
  const without = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config });
  assert.deepEqual(switchSubtypes(without.devices[0]).sort(), ['boost', 'mode-cft', 'mode-eco', 'presence', 'schedule', 'vacation', 'window']);

  const withSelector = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { ...config, showModeSelector: true } });
  assert.deepEqual(switchSubtypes(withSelector.devices[0]).sort(), ['boost', 'schedule', 'vacation', 'window'], 'Boost, Vacation, Schedule and open window are not modes');
  assert.ok(withSelector.devices[0].accessory.getService(Service.Thermostat), 'le thermostat reste');
});

test('The selector uses exactly the ticked modes and presence, without Boost or Vacation', async () => {
  const { devices, calls } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    config: { modes: ['Off', 'Eco Plus', 'Confort', 'Presence'], showModeSelector: true, showBoost: true, boostMinutes: 30, showVacation: true, vacationDays: 3 },
  });
  const device = devices[0];
  assert.deepEqual(inputNames(device), ['Comfort', 'Comfort -2', 'Off', 'Presence detection']);
  const tv = device.selector.accessory.getService(Service.Television);
  const select = tv.getCharacteristic(C.ActiveIdentifier);
  const idOf = (key) => device.selector.inputs.find((input) => input.key === key).id;

  await select.handleSetRequest(idOf('cft2'));
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 5 } });
  await select.handleSetRequest(idOf('presence'));
  assert.deepEqual(calls.at(-1).payload, { attrs: { derog_mode: 3 } });
  assert.equal(await select.handleGetRequest(), idOf('presence'));
  await select.handleSetRequest(idOf('stop'));
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 3, timer_switch: 0, derog_mode: 0, derog_time: 0 } });
  assert.equal(await select.handleGetRequest(), idOf('stop'));
});

test('Without "Presence" in the mode list, no presence (neither switch nor source)', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { modes: ['Confort', 'Sleep'], showModeSelector: true } });
  assert.ok(!inputNames(devices[0]).includes('Presence detection'));
  const classic = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { modes: ['Confort'] } });
  assert.ok(!switchSubtypes(classic.devices[0]).includes('presence'));
});

test('Without a mode list, presence stays available (showPresence compatibility)', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  assert.ok(switchSubtypes(devices[0]).includes('presence'));
  const off = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showPresence: false } });
  assert.ok(!switchSubtypes(off.devices[0]).includes('presence'));
});

test('Selector: comfort-1 without its own source shows as Comfort, with its own source as Comfort -1', async () => {
  const attrs = { ...PRO_ATTRS, mode: 'cft1', cur_mode: 'cft1' };
  const plain = await setup({ bindings: [proBinding], attrsByDid: { pro1: attrs }, config: { showModeSelector: true } });
  const idPlain = plain.devices[0].selector.inputs.find((i) => i.key === 'cft').id;
  assert.equal(await plain.devices[0].selector.accessory.getService(Service.Television).getCharacteristic(C.ActiveIdentifier).handleGetRequest(), idPlain);

  const dedicated = await setup({ bindings: [proBinding], attrsByDid: { pro1: attrs }, config: { modes: ['Confort', 'Eco'], showModeSelector: true } });
  const idDedicated = dedicated.devices[0].selector.inputs.find((i) => i.key === 'cft1').id;
  assert.equal(await dedicated.devices[0].selector.accessory.getService(Service.Television).getCharacteristic(C.ActiveIdentifier).handleGetRequest(), idDedicated);
});

test('Selector: no "presence" source on a classic Pilote', async () => {
  const binding = { did: 'p4', dev_alias: 'Chambre', product_key: V4_KEY, product_name: 'Pilote_Soc_C3' };
  const { devices } = await setup({ bindings: [binding], attrsByDid: { p4: { mode: 'cft', derog_mode: 0 } }, config: { showModeSelector: true } });
  assert.deepEqual(devices[0].selector.inputs.map((i) => i.key), ['cft', 'eco', 'fro']);
});

test('Unknown product: ignored with a single warning', async () => {
  const unknown = { did: 'x', dev_alias: 'Mystery', product_key: 'ffff', product_name: 'Futur' };
  const { devices, log, platform } = await setup({ bindings: [unknown, proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  await platform.refresh();
  assert.equal(devices.length, 1);
  assert.equal(log.lines.filter((line) => line.includes('unknown product_key')).length, 1);
});

test('After a command, a still-stale cloud read does not cancel the written value', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const device = devices[0];
  const schedule = device.accessory.getServiceById(Service.Switch, 'schedule').getCharacteristic(C.On);
  await schedule.handleSetRequest(true);
  device.update({ ...PRO_ATTRS, timer_switch: 0 }); // the cloud has not caught up yet
  assert.equal(await schedule.handleGetRequest(), true, 'written value kept');
  device.update({ ...PRO_ATTRS, timer_switch: 1 }); // the cloud caught up
  device.update({ ...PRO_ATTRS, timer_switch: 0 }); // change made afterwards from the Heatzy app
  assert.equal(await schedule.handleGetRequest(), false, 'the cloud value takes over again');
  device.dispose();
});

test('The mode list accepts names, displayed labels, case and accents', async () => {
  const { devices, log } = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    config: { modes: ['Confort', 'Eco (Sleep)', 'presence detection', 'nonsense'], showModeSelector: true },
  });
  assert.deepEqual(inputNames(devices[0]), ['Comfort', 'Eco', 'Presence detection']);
  assert.ok(log.lines.some((line) => line.startsWith('info: Heatzy: modes in use: Confort, Sleep, Presence')));
  assert.ok(log.lines.some((line) => line.startsWith('warn:') && line.includes('unrecognized')));
});

test('"Mode: …" toggles decide alone as soon as one exists, otherwise the legacy modes list is read', async () => {
  const toggled = await setup({
    bindings: [proBinding],
    attrsByDid: { pro1: PRO_ATTRS },
    config: { modes: ['Off'], showModeComfort: true, showModeComfort1: false, showModePresence: true, showModeSelector: true },
  });
  assert.deepEqual(inputNames(toggled.devices[0]), ['Comfort', 'Presence detection']);
  const legacy = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { modes: ['Off', 'Presence'], showModeSelector: true } });
  assert.deepEqual(inputNames(legacy.devices[0]), ['Off', 'Presence detection']);
  const none = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeComfort: false, showModeSelector: true } });
  assert.deepEqual(inputNames(none.devices[0]), ['Comfort', 'Eco', 'Frost protection', 'Presence detection'], 'everything off: default settings');
});

test('The mode tile is named "<radiator> Heating mode"; a previous default name is replaced, a custom name is kept', async () => {
  const fresh = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeSelector: true } });
  const accessory = fresh.devices[0].selector.accessory;
  assert.equal(accessory.displayName, 'Salon Heating mode');
  assert.equal(accessory.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Salon Heating mode');

  const { ModeSelector } = require('../lib/selector');
  const old = new FakeAccessory('Salon mode', hap.uuid.generate('old'));
  old.addService(Service.Television, 'Salon mode').setCharacteristic(C.ConfiguredName, 'Salon mode');
  new ModeSelector(fresh.devices[0], old);
  assert.equal(old.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Salon Heating mode');

  const custom = new FakeAccessory('Salon mode', hap.uuid.generate('custom'));
  custom.addService(Service.Television, 'Salon mode').setCharacteristic(C.ConfiguredName, 'Living room heating');
  new ModeSelector(fresh.devices[0], custom);
  assert.equal(custom.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Living room heating');
});

test('Switches carry the radiator name; a custom name is kept', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS } });
  const boost = devices[0].accessory.getServiceById(Service.Switch, 'boost');
  assert.equal(boost.getCharacteristic(C.Name).value, 'Salon Boost');
  assert.equal(boost.getCharacteristic(C.ConfiguredName).value, 'Salon Boost');
  // previous default name (without radiator) -> replaced; custom name -> kept
  boost.getCharacteristic(C.ConfiguredName).updateValue('Boost');
  devices[0].accessory.getServiceById(Service.Switch, 'window').getCharacteristic(C.ConfiguredName).updateValue('Open window');
  devices[0].setup();
  assert.equal(boost.getCharacteristic(C.ConfiguredName).value, 'Salon Boost');
  assert.equal(devices[0].accessory.getServiceById(Service.Switch, 'window').getCharacteristic(C.ConfiguredName).value, 'Open window');
});

test('With showSwitchesWithSelector, mode and presence switches stay next to the tile and stay in sync', async () => {
  const config = { showModeComfort: true, showModeEco: true, showModePresence: true, showModeSelector: true, showSwitchesWithSelector: true };
  const { devices, calls } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config });
  const device = devices[0];
  assert.deepEqual(inputNames(device), ['Comfort', 'Eco', 'Presence detection']);
  assert.deepEqual(switchSubtypes(device).filter((name) => name === 'presence' || name.startsWith('mode-')).sort(), ['mode-cft', 'mode-eco', 'presence']);
  const eco = device.accessory.getServiceById(Service.Switch, 'mode-eco').getCharacteristic(C.On);
  await eco.handleSetRequest(true);
  assert.deepEqual(calls.at(-1).payload, { attrs: { mode: 1 } });
  const tv = device.selector.accessory.getService(Service.Television);
  assert.equal(await tv.getCharacteristic(C.ActiveIdentifier).handleGetRequest(), 2, 'the tile follows the switch');
  assert.equal(await device.accessory.getServiceById(Service.Switch, 'mode-cft').getCharacteristic(C.On).handleGetRequest(), false);
  await tv.getCharacteristic(C.ActiveIdentifier).handleSetRequest(1);
  assert.equal(await eco.handleGetRequest(), false, 'the switch follows the tile');
  assert.equal(await device.accessory.getServiceById(Service.Switch, 'mode-cft').getCharacteristic(C.On).handleGetRequest(), true);
});

test('Without showSwitchesWithSelector, no mode switch next to the tile', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeComfort: true, showModeSelector: true } });
  assert.ok(!switchSubtypes(devices[0]).some((name) => name === 'presence' || name.startsWith('mode-')));
});

test('previous French default names are replaced by the English ones; a custom name is kept', async () => {
  const { devices } = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { showModeSelector: true } });
  const device = devices[0];
  const window = device.accessory.getServiceById(Service.Switch, 'window').getCharacteristic(C.ConfiguredName);
  const schedule = device.accessory.getServiceById(Service.Switch, 'schedule').getCharacteristic(C.ConfiguredName);
  window.updateValue('Salon Détection fenêtre ouverte');
  schedule.updateValue('My schedule');
  device.setup();
  assert.equal(window.value, 'Salon Open-window detection');
  assert.equal(schedule.value, 'My schedule');
  assert.equal(device.selector.accessory.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Salon Heating mode');
});

test('frenchNames: HomeKit names follow the Pilote Pro manual, and untouched names switch language', async () => {
  const config = { showModeComfort: true, showModeEco: true, showModeFrostProtection: true, showModePresence: true, showModeSelector: true };
  const english = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config });
  assert.deepEqual(inputNames(english.devices[0]), ['Comfort', 'Eco', 'Frost protection', 'Presence detection']);

  const french = await setup({ bindings: [proBinding], attrsByDid: { pro1: PRO_ATTRS }, config: { ...config, frenchNames: true } });
  assert.deepEqual(inputNames(french.devices[0]), ['Confort', 'Éco', 'Hors-gel', 'Détection de présence']);
  assert.equal(french.devices[0].selector.accessory.displayName, 'Salon Mode de chauffage');

  // A tile named in English and untouched becomes French; a custom name stays.
  const { ModeSelector } = require('../lib/selector');
  const untouched = new FakeAccessory('Salon Heating mode', hap.uuid.generate('en'));
  untouched.addService(Service.Television, 'Salon Heating mode').setCharacteristic(C.ConfiguredName, 'Salon Heating mode');
  new ModeSelector(french.devices[0], untouched);
  assert.equal(untouched.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Salon Mode de chauffage');
  const custom = new FakeAccessory('Salon Heating mode', hap.uuid.generate('custom-fr'));
  custom.addService(Service.Television, 'Salon Heating mode').setCharacteristic(C.ConfiguredName, 'Chauffage salon');
  new ModeSelector(french.devices[0], custom);
  assert.equal(custom.getService(Service.Television).getCharacteristic(C.ConfiguredName).value, 'Chauffage salon');
});
