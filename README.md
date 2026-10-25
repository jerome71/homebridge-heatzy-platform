# Homebridge Heatzy Platform

[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

[Homebridge](https://homebridge.io) plugin for **Heatzy** modules: Pilote (gen. 1 to 4), Acova Elec'Pro and **Pilote Pro**. It uses the Heatzy cloud with your Heatzy app account (no local API).

Developed and tested on a Pilote Pro. Other models follow the official Heatzy documentation and are less tested. See [Known limitations](#known-limitations) and the [changelog](CHANGELOG.md).

## Installation

In the Homebridge UI, search for **Heatzy Platform** in *Plugins*, install it, then enter your Heatzy app e-mail and password in its settings.

## What you get in HomeKit

Per Pilote Pro module:

| Accessory | Description |
|---|---|
| Thermostat | Current temperature and humidity, target temperature, Off / Heat, heating state. Optional lock of the module buttons. |
| Mode switches | One per mode enabled in the settings, or a single "Heating mode" tile (see below). |
| Schedule switch | On: the module follows the schedule set in the Heatzy app. Off: it keeps the chosen mode. |
| Boost switch | Temporary comfort, `boostMinutes` long (60 by default). |
| Vacation switch | Optional. Frost protection for `vacationDays` days (7 by default). |
| Open-window detection switch | Enables or disables the module's open-window detection. |

Pilote / Elec'Pro modules get the mode switches plus optional Boost, Vacation, Schedule and Lock (gen. 2 and later). Comfort -1 / -2 exist on gen. 4 only. Glow, Onyx and Shine have minimal support.

### Names

HomeKit names are in English by default. Turn on **French names in HomeKit** (`frenchNames`) to use the names of the Pilote Pro manual:

| English | French (manual) |
|---|---|
| Comfort | Mode Confort |
| Comfort -1, Comfort -2 | Confort -1, Confort -2 (6 modes via the Heatzy app) |
| Eco | Mode Eco |
| Frost protection | Mode Hors-Gel |
| Off | Mode Arrêt |
| Schedule | Mode Programmation |
| Presence detection | Détection de présence |
| Vacation | Mode Vacances |
| Lock | Mode Verrouillage |
| Open-window detection | Détection de fenêtre ouverte |

Names you change in the Home app are kept; untouched names follow the language setting.

### Modes

Each mode has its own "Mode: …" toggle in the settings, all off by default: Comfort, Comfort -1, Comfort -2, Eco, Frost protection, Off and Presence detection (Pilote Pro only).

- **Comfort:** heats to the comfort setpoint.
- **Comfort -1 / -2:** the comfort setpoint lowered by 1 / 2 °C (the steps the module applies in presence detection after 30 and 60 minutes without presence).
- **Eco:** heats to the separate, lower eco setpoint. Use it when the room is not used.
- With no toggle enabled, a Pilote Pro shows no mode switch (the thermostat is enough) plus presence detection; other modules show Comfort / Eco / Frost protection / Off.

### "Heating mode" tile

`showModeSelector` groups the enabled modes in one tile whose choices are the modes, instead of separate switches. HomeKit shows it with a television icon, the only way to get a named list of choices. Its power button turns the heating off or on.

The Home app cannot use this tile in automations. `showSwitchesWithSelector` keeps one switch per mode next to it, in sync, for that purpose.

### Target temperature

Like the "+" and "−" buttons of the module, the thermostat changes the setpoint of the **active mode**:

- **Comfort:** sets the comfort setpoint (15–30 °C).
- **Eco:** sets the eco setpoint (10–19 °C).
- **Comfort -1 / -2:** shows the comfort setpoint minus 1 / 2 °C; changing it changes the comfort setpoint.
- **Frost protection and Off:** have no setpoint; the thermostat shows and changes the comfort one.

Values outside the allowed range are clamped.

### Behavior

- **Thermostat:** Off and Heat only. Choosing either turns the schedule off, otherwise the schedule would override your choice. Off also cancels presence detection.
- **Boost, Vacation and Presence** are mutually exclusive: enabling one replaces the other. Boost and Vacation take precedence over the chosen mode, and choosing a mode or Off cancels them.
- **Schedules** are created in the Heatzy app; the plugin does not edit them.

## Configuration

Everything is in the Homebridge settings screen. Main options:

| Option | Purpose |
|---|---|
| `showModeComfort`, `showModeComfort1`, `showModeComfort2`, `showModeEco`, `showModeFrostProtection`, `showModeOff`, `showModePresence` | Mode toggles: Comfort, Comfort -1, Comfort -2, Eco, Frost protection, Off, Presence detection. |
| `frenchNames` | French names in HomeKit (Confort, Éco, Hors-gel…). |
| `showModeSelector`, `showSwitchesWithSelector` | "Heating mode" tile, and optional switches next to it. |
| `pollInterval` | Sync interval, 15–600 s (default 60). |
| `dryRun` | Reads everything but sends no command (useful for a first try). |

## How it works

- Sync every `pollInterval` seconds, plus forced re-reads 3, 8, 15 and 30 s after each command, because the Heatzy cloud can be slow. Meanwhile the value you just set is kept (25 s at most) so tiles do not jump back. A change made on the module or in the Heatzy app can take up to a minute to show.
- Automatic re-login when the token expires.
- A module with an unknown `product_key` is ignored, with a warning in the log.

## Known limitations

- The Pilote Pro exposes no "presence detected" status. The plugin does not guess it, nor simulate the Comfort -1 / Comfort -2 / Eco steps the module applies after 30, 60 and 90 minutes without presence.
- Schedules (time slots) can only be created and edited in the Heatzy app. In HomeKit you can only turn the schedule on or off.
- The "Heating mode" tile shows a television icon.
- Glow, Onyx and Shine are untested.
- The Heatzy cloud is required: no internet, no control.

## Support

[GitHub issues](https://github.com/jerome71/homebridge-heatzy-platform/issues). Please include the plugin version, your module model and the relevant log lines (never your password).

If you find this plugin useful, you can [donate via PayPal](https://www.paypal.com/donate/?hosted_button_id=JF4V45QWF2QHQ).

## Credits

Inspired by [homebridge-heatzy-pilote-platform](https://github.com/julienott/homebridge-heatzy-pilote-platform) by Julien Ott (Apache-2.0), which itself credits:

- [homebridge-heatzy-pilote-eco](https://github.com/Fourni-j/homebridge-heatzy-pilote-eco)
- [homebridge-heatzy-as-switch](https://github.com/AlainKaim/homebridge-heatzy-as-switch)

## License

Apache-2.0. See [LICENSE](LICENSE).
