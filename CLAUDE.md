# nakomis-fleet

Fleet: device registry, firmware OTA and device management for nakomis ESP32 and Pi devices. A Module Federation
remote of `nakomis-shell`, plus its own backend.

## AWS credentials

- Sandbox: `AWS_PROFILE=nakom.is-sandbox` (the home devices live here)
- Production: `AWS_PROFILE=nakom.is-admin` (or `nakom.is-prod`)

## Repository layout

- `web/` — remote (pnpm, Vite 8, Vitest, Biome, MUI 7). `src/shell-contract.ts` is a copy from nakomis-shell.
- `infra/` — CDK + Lambdas (pnpm, Jest). `lambda/shared/types.ts` is mirrored in `web/src/api/types.ts`; keep in step.
- `docs/architecture/design.md` — the design, including the OTA protocol and secure tier.

## Rules

- Never weaken the secure tier: `ota_update`/`url_chunk` only via `POST /devices/{id}/ota`, which checks `ota-signed`.
- Presigned URLs stay HTTPS and short (10 min). Never make firmware buckets public.
- The API role may publish only to `*/*/commands`.
- Device-facing protocol is shared with esp32-bootstrap's MqttOTA/BluetoothOTA: don't change message shapes here
  without changing them there.

## Testing

```bash
cd infra && pnpm test     # ≥70% lines
cd web && pnpm test && pnpm lint
```

## Architecture diagrams

Source: `docs/architecture/nakomis-fleet.drawio` — SVG auto-regenerated on commit by `.githooks/pre-commit`.

```bash
git config core.hooksPath .githooks
```
