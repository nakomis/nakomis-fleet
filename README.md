# nakomis-fleet — Unified device fleet management

Firmware OTA, configuration, and provisioning for nakomis ESP32 and Raspberry Pi devices, with a single web UI behind shared Cognito auth.

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=nakomis-fleet)

## Status

Greenfield. The repo currently holds only the planning document (gitignored — see `PLAN.md` locally) and this README. Implementation begins once the foundations in `nakomis-infra` (per-environment firmware buckets, reusable CI role construct) are in place.

## What this is

A device-agnostic fleet manager:

- **Firmware OTA** — list versions per project, push updates to a specific device, manage sandbox vs prod channels
- **Device configuration** — push config blobs over BLE or MQTT (camera params, thresholds, MQTT topics, etc.)
- **Wipe and re-purpose** — reset a device's NVS and reassign it to a different project
- **Mixed estate** — ESP32 (`.bin` over BLE/SD bootloader) and Raspberry Pi (tarball or OCI image via a Pi-side agent) treated uniformly

## Where it lives

Hosted at **`fleet.nakomis.com`** (and surfaced as the Fleet panel in the unified `app.nakomis.com` shell — exact wiring TBD). Frontend is a Vite + Module Federation remote so it can be loaded standalone or embedded in the shell.

## Repository layout

To be filled in as the project grows. Expected top-level directories:

- `web/` — React + Vite + MUI frontend (Module Federation remote)
- `infra/` — CDK stacks: API Gateway, Lambdas, DynamoDB device registry, CloudFront distribution
- `agent/` — Raspberry Pi-side update agent (later phase)
- `docs/architecture/` — drawio source + auto-generated SVG

## Related repos

- [`nakomis-infra`](https://github.com/nakomis/nakomis-infra) — shared Cognito user pool, GitHub OIDC roles, and (forthcoming) per-environment firmware buckets
- [`bootboots`](https://github.com/nakomis/bootboots) — first ESP32 project to use the fleet; donates the existing `build_and_upload.py` and BLE service code
- [`esp32-bootloader`](https://github.com/nakomis/esp32-bootloader) — generic single-partition OTA bootloader used by all fleet ESP32 devices
- [`sandboxsite`](https://github.com/nakomis/sandboxsite) — current home of the firmware-management UI; will be gutted as Fleet takes over

## Licence

CC0 1.0 Universal — see [`LICENSE.md`](LICENSE.md).

## Support

If you find this useful, please consider buying me a coffee:

[![Donate with PayPal](https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?hosted_button_id=Q3BESC73EWVNN&custom=nakomis-fleet)
