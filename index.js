'use strict';

const { HeatzyPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, HeatzyPlatform);
};
