"use strict";

const axios = require("axios");
const https = require("https");

// UniFi OS consoles use a self-signed certificate.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-protect-alarm", "ProtectAlarm", UnifiAlarmPlatform);
};

class UnifiAlarmPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!api) return;

    if (!this.config.controller || !this.config.apiKey) {
      this.log.error(
        "Missing required config: 'controller' (host/IP) and 'apiKey' are both required. " +
        "Generate an API key in UniFi OS: Settings -> Control Plane -> Integrations."
      );
      return;
    }

    api.on("didFinishLaunching", () => {
      const uuid = UUIDGen.generate("unifi-alarm-" + this.config.controller);
      const cached = this.accessories.find(a => a.UUID === uuid);
      const stale = this.accessories.filter(a => a.UUID !== uuid);
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories("homebridge-protect-alarm", "ProtectAlarm", stale);
      }
      if (cached) {
        this.log("Restoring UniFi Alarm from cache.");
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, cached);
      } else {
        const accessory = new this.api.platformAccessory(this.config.name || "Security System", uuid);
        new UnifiAlarmAccessory(this.log, this.config, this.api, Service, Characteristic, accessory);
        this.api.registerPlatformAccessories("homebridge-protect-alarm", "ProtectAlarm", [accessory]);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class UnifiAlarmAccessory {
  constructor(log, config, api, Service, Characteristic, accessory) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.accessory = accessory;

    this.name = config.name || "Security System";
    this.controller = config.controller;
    this.apiKey = config.apiKey;

    // Profiles are discovered by name on startup. Either name can be customised,
    // and an explicit ID may be supplied to bypass name matching entirely.
    this.awayProfileName = config.awayProfileName || "Away";
    this.nightProfileName = config.nightProfileName || "Night";
    this.awayArmProfileId = config.awayArmProfileId || null;
    this.nightArmProfileId = config.nightArmProfileId || null;

    this.pollSeconds = Number.isFinite(config.pollInterval) && config.pollInterval > 0
      ? config.pollInterval
      : 5;

    this.currentTargetState = null;
    this.isArmed = false;
    this.activeProfileId = null;

    this.informationService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, "Ubiquiti")
      .setCharacteristic(Characteristic.Model, "UniFi Protect")
      .setCharacteristic(Characteristic.SerialNumber, this.controller);

    this.securityService = accessory.getService(Service.SecuritySystem)
      || accessory.addService(Service.SecuritySystem, this.name);
    this.securityService.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState());
    this.securityService.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.targetState())
      .onSet(this.handleTargetStateSet.bind(this));

    if (api) {
      api.on("shutdown", () => {
        if (this.pollInterval) clearInterval(this.pollInterval);
      });
    }

    this.init();
  }

  get baseUrl() {
    return `https://${this.controller}`;
  }

  get headers() {
    return { "X-API-KEY": this.apiKey, "Content-Type": "application/json" };
  }

  // ---- HomeKit state helpers ------------------------------------------------

  currentState() {
    const C = this.Characteristic.SecuritySystemCurrentState;
    if (!this.isArmed) return C.DISARMED;
    if (this.resolvedTarget() === this.Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
      return C.NIGHT_ARM;
    }
    return C.AWAY_ARM;
  }

  targetState() {
    const C = this.Characteristic.SecuritySystemTargetState;
    if (!this.isArmed) return C.DISARM;
    return this.resolvedTarget();
  }

  // Work out whether the current armed state is Away or Night. Prefer the
  // active profile reported by the NVR (so external arming via a FOB/automation
  // reflects correctly in HomeKit); fall back to the last target we set.
  resolvedTarget() {
    const C = this.Characteristic.SecuritySystemTargetState;
    if (this.activeProfileId && this.nightArmProfileId &&
        this.activeProfileId === this.nightArmProfileId) {
      return C.NIGHT_ARM;
    }
    if (this.activeProfileId && this.awayArmProfileId &&
        this.activeProfileId === this.awayArmProfileId) {
      return C.AWAY_ARM;
    }
    return this.currentTargetState !== null ? this.currentTargetState : C.AWAY_ARM;
  }

  // ---- UniFi integration API ------------------------------------------------

  // GET /nvrs returns the NVR object (some firmwares wrap it in an array).
  async getNvr() {
    const response = await axios.get(
      `${this.baseUrl}/proxy/protect/integration/v1/nvrs`,
      { httpsAgent, timeout: 15000, headers: this.headers }
    );
    const data = response.data;
    return Array.isArray(data) ? data[0] : data;
  }

  async getArmProfiles() {
    const response = await axios.get(
      `${this.baseUrl}/proxy/protect/integration/v1/arm-profiles`,
      { httpsAgent, timeout: 15000, headers: this.headers }
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  // Match profiles by name unless an explicit ID was supplied in config.
  async discoverProfiles() {
    const profiles = await this.getArmProfiles();
    const byName = (wanted) => {
      const hit = profiles.find(p => (p.name || "").toLowerCase() === wanted.toLowerCase());
      return hit ? hit.id : null;
    };

    if (!this.awayArmProfileId) this.awayArmProfileId = byName(this.awayProfileName);
    if (!this.nightArmProfileId) this.nightArmProfileId = byName(this.nightProfileName);

    this.log(`[${this.name}] Away profile ("${this.awayProfileName}"): ${this.awayArmProfileId || "NOT FOUND"}`);
    this.log(`[${this.name}] Night profile ("${this.nightProfileName}"): ${this.nightArmProfileId || "NOT FOUND"}`);

    if (!this.awayArmProfileId && !this.nightArmProfileId) {
      this.log.warn(
        `[${this.name}] No matching arm profiles found. Available: ` +
        profiles.map(p => `"${p.name}"`).join(", ")
      );
    }
  }

  applyArmMode(armMode) {
    armMode = armMode || {};
    const status = armMode.status;
    this.isArmed = status === "armed" || status === "arming";
    this.activeProfileId = this.isArmed ? (armMode.armProfileId || null) : null;
  }

  async init() {
    try {
      await this.discoverProfiles();
      const nvr = await this.getNvr();
      this.applyArmMode(nvr && nvr.armMode);

      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState, this.currentState());
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemTargetState, this.targetState());

      this.log(`[${this.name}] State: ${this.isArmed ? "Armed" : "Disarmed"}`);
    } catch (err) {
      this.log.error(`[${this.name}] Initialization failed: ${describe(err)}`);
      return;
    }

    this.pollInterval = setInterval(() => {
      this.poll().catch(err => this.log.error(`[${this.name}] Poll error: ${describe(err)}`));
    }, this.pollSeconds * 1000);
  }

  async poll() {
    const nvr = await this.getNvr();
    const wasArmed = this.isArmed;
    const prevProfile = this.activeProfileId;
    this.applyArmMode(nvr && nvr.armMode);

    if (wasArmed !== this.isArmed || prevProfile !== this.activeProfileId) {
      this.log(`[${this.name}] State changed: ${this.isArmed ? "Armed" : "Disarmed"}`);
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState, this.currentState());
      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemTargetState, this.targetState());
    }
  }

  async handleTargetStateSet(value) {
    const C = this.Characteristic.SecuritySystemTargetState;

    try {
      if (value === C.DISARM) {
        this.currentTargetState = null;
        await axios.post(
          `${this.baseUrl}/proxy/protect/integration/v1/arm-profiles/disable`,
          {}, { httpsAgent, timeout: 15000, headers: this.headers }
        );
        this.isArmed = false;
        this.activeProfileId = null;
        this.log(`[${this.name}] Disarmed.`);
      } else {
        // Home (STAY_ARM) is treated as Disarm to match the UniFi model.
        if (value === C.STAY_ARM) {
          this.log(`[${this.name}] Home selected, treating as Disarm.`);
          return this.handleTargetStateSet(C.DISARM);
        }

        const isNight = value === C.NIGHT_ARM;
        const profileId = isNight ? this.nightArmProfileId : this.awayArmProfileId;
        if (!profileId) {
          this.log.error(`[${this.name}] No ${isNight ? "Night" : "Away"} arm profile available.`);
          return;
        }

        this.log(`[${this.name}] Arming ${isNight ? "Night" : "Away"} profile: ${profileId}`);
        this.currentTargetState = value;
        await axios.patch(
          `${this.baseUrl}/proxy/protect/integration/v1/arm-profiles/settings`,
          { armProfileId: profileId },
          { httpsAgent, timeout: 15000, headers: this.headers }
        );
        await axios.post(
          `${this.baseUrl}/proxy/protect/integration/v1/arm-profiles/enable`,
          {}, { httpsAgent, timeout: 15000, headers: this.headers }
        );
        this.isArmed = true;
        this.activeProfileId = profileId;
        this.log(`[${this.name}] Armed.`);
      }

      this.securityService.updateCharacteristic(
        this.Characteristic.SecuritySystemCurrentState, this.currentState());
    } catch (err) {
      this.log.error(`[${this.name}] Command failed: ${describe(err)}`);
    }
  }
}

function describe(err) {
  return err.response
    ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
    : err.message;
}
