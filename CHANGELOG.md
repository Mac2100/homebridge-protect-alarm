# Changelog

## 1.0.0 — 2026-06-10

Initial public release.

- Native HomeKit Security System accessory for the UniFi Protect alarm
- Single UniFi OS **API-key** authentication (no username/password)
- Automatic arm-profile discovery by name (`Away` / `Night`, configurable)
- Two-way state sync via NVR polling, including which mode is active when
  armed externally (keyfob, Protect app, automations)
- Exit-delay ("arming") treated as armed to prevent HomeKit state flicker
- Configurable poll interval; advanced explicit profile-ID overrides
