# Fleet design

How Fleet and the `app.nakomis.com` shell fit together. `PLAN.md` (local, gitignored) holds the original
vision. This document records what was built, and where and why it departs from that plan.

## Environments and domains

| | sandbox (975050268859) | prod (637423226886) |
|---|---|---|
| Shell | `app.sandbox.nakomis.com` | `app.nakomis.com` |
| Fleet API | `api.fleet.sandbox.nakomis.com` | `api.fleet.nakomis.com` |
| Fleet live updates | `wss://ws.fleet.sandbox.nakomis.com` | `wss://ws.fleet.nakomis.com` |
| Firmware bucket | `nakomis-firmware-sandbox` | `nakomis-firmware-prod` |
| Login | `login.sandbox.nakomis.com` | `login.nakomis.com` |

Each env's Fleet only sees the IoT Things in its own account. The home devices (catcam, nakostat
sandbox, tinycrypt) currently live in the sandbox account, so the sandbox shell is the one in daily use.

## Shell and remotes (Module Federation)

- **`nakomis-shell`** is a Vite + `@module-federation/vite` host. It owns login, the sidebar, the MUI
  theme and routing. It shares `react`, `react-dom`, `react-router`, `@mui/material` and `@emotion/*`
  as singletons.
- **Remotes** each expose `./App`, a component that receives `ShellContext` as its props
  (see `nakomis-shell/contract/shell-contract.ts`):
  `{ env, basePath, user, getAccessToken(), getIdToken(), getAwsCredentials(identityPoolId), signOut() }`.
  A remote renders its own `<Routes>` relative to `basePath`.
- **Where the code is served:** one CloudFront distribution per env, backed by one bucket
  `nakomis-shell-{env}`:
  - `shell/…` is the host app. Extensionless paths rewrite to `/shell/index.html`.
  - `remotes/{name}/…` holds each remote's `remoteEntry.js` and assets, deployed by that remote's CI.
- The shell fetches `/shell/remotes.json` (written by the shell's CDK per env) to decide which remotes
  appear in the sidebar. This is how the prod shell has no Sandbox panel.
- **Remote CI** publishes with the shell's `nakomis-shell-remote-deployer-{env}` managed policy, attached to the
  remote's own CI role, or to a `nakomis-<repo>-remote-ci-{env}` role the shell creates for repos without CDK.
- **Stable context:** the shell memoises each remote's `ShellContext` and keys it on the user's identity, not the
  token; remotes should still key their services on stable fields and read token getters through a ref.
- **Departure from the plan:** there is no `@nakomis/shell-ui` npm package in CodeArtifact. The host
  passes auth, credentials and theme to remotes at runtime, which removes the need for a private npm
  registry in every CI job. CodeArtifact only hosts cargo today. Remote URLs are `/remotes/{name}/` rather
  than `/{name}/remoteEntry.js`, so that SPA routes such as `/fleet/devices` never collide with assets.

## Auth

- One app client, `nakomis-shell-{env}`, on the shared `nakomis-infra` user pool. Its id is exported to
  SSM at `/nakomis-shell/{env}/cognito/client-id`.
- APIs that are new for Fleet use API Gateway **JWT authorisers** (issuer: shared pool, audience: the
  shell client), so the browser needs no AWS credentials.
- Remotes that already use SigV4 (nakom-admin, bootboots) keep their identity pools and add the shell
  client as a second provider. The shell exposes `getAwsCredentials(identityPoolId)`.

## Fleet backend (`infra/` in this repo)

- **Device registry**, DynamoDB `nakomis-fleet-devices-{env}`, partition key `deviceId`, holding
  project, deviceType, hwType, capabilities, currentVersion, lastSeen, lastStatus, otaState and notes.
  - The list endpoint merges the registry with IoT Things (attributes `project`, `deviceType`,
    `capabilities`), so existing Things show up without registering.
  - An IoT rule on `+/+/responses` and `+/+/status` keeps `lastSeen`, `currentVersion` (from
    `version` / `ota_*` messages) and `otaState` up to date.
- **HTTP API** (JWT auth):
  - `GET /devices`, `GET /devices/{id}`, `PUT /devices/{id}` (register, or edit project and
    metadata).
  - `POST /devices/{id}/ota` with body `{version}`. The server checks capabilities, presigns a
    10-minute HTTPS URL and publishes `ota_update`. It sends `url_chunk` messages when the payload would
    exceed the device MQTT buffer (2 KB).
  - `POST /devices/{id}/ota/cancel`, `POST /devices/{id}/command` (generic passthrough: `reboot`,
    `get_version`, `ping`, `set_setting`, …).
  - `POST /devices/{id}/wipe`, which sends `wipe` and moves the device to another project in the
    registry and the Thing attribute.
  - `GET /projects`, `GET /projects/{p}/firmware`, `GET /projects/{p}/firmware/{v}/url` (a presigned
    URL for the BLE path).
  - `POST /projects/{p}/firmware/{v}/promote` (prod only). This copies a build from the sandbox bucket
    into the prod bucket. The sandbox bucket grants read to the prod promoter role.
- **WebSocket API** for live device responses. The token is passed in the query string and verified
  against the shared pool. The router fans `{project}/{deviceId}/responses` out to subscribed
  connections. This is a port of sandboxsite's `responseRouter`.

## OTA protocol (unchanged on the wire)

- **Commands** go to `{project}/{deviceId}/commands`:
  `{"command":"ota_update","url","version"}`, or
  `{"command":"url_chunk","chunk_index","total_chunks","chunk_data","version"}` (at most 10 chunks), or
  `{"command":"ota_cancel"}`.
- **Responses** come back on `{project}/{deviceId}/responses`: `ota_progress {progress,status,version}`,
  `ota_complete {version}` and `ota_error {message}`.
- **Today's devices never send `ota_complete`.** They reboot instead. Fleet therefore treats "the device
  reports the target version after the update was sent" as completion. The UI polls `get_version` while an
  update is in flight, and the ingest Lambda sends `get_version` when a heartbeat arrives mid-update, so
  completion is detected even with no Fleet tab open. Version-less `ota_progress` (URL-chunk acks) can't reopen
  a finished update.
- **Wipe** is only offered to devices with the `wipe` capability; no firmware implements it yet.

### Optional secure tier

- **Manifest:** versions may carry `sha256` (always computed by FLEET-2's Lambda) and `signed: true`
  (from upload metadata `signed=true`).
- **Capabilities** on the Thing:
  - `ota-signed`: Fleet only offers, and the API only accepts, versions with `signed: true`.
  - `ota-approval`: the UI expects
    `ota_progress {status:"awaiting_approval"}` → `{status:"approved"}` or
    `ota_error {message:"rejected"|"approval timed out"}`, and allows up to 15 minutes before calling
    it stuck.
  - `ota_error {message:"rolled back"}` is shown as a rollback.
- **Fleet is not the trust anchor.** Secure devices verify signatures and require physical approval
  themselves. Fleet only says "please update".
- **Cheap hygiene for everyone:** private buckets, HTTPS-only presigned URLs lasting minutes, IoT
  publish scoped to `*/*/commands`, and per-env buckets.

## Pi devices (FLEET-5)

- Pi releases sit in the same buckets as `{Project}/{version}/artefact.tar.gz`; the manifest gains
  `artefactType: "tarball"`.
- The agent (`agent/`, see its README) is a systemd service that speaks the ESP32 protocol, so Fleet treats a
  Pi like any device. Fleet adds the build's `sha256` to `ota_update` (or the last `url_chunk`), which the agent
  requires; ESP32 firmware ignores it.
- Install = unpack to `releases/<version>`, swap `current`, restart the unit, health-check (three `is-active`
  checks plus an optional command); any failure rolls back and reports `ota_error {message: "rolled back"}`.
  A pending marker lets a restarted agent finish or roll back an interrupted install.
- **Departure from the plan:** push (Fleet sends `ota_update`) rather than the agent polling the manifest, so
  ESP32s and Pis share one OTA path, UI and progress reporting. The agent lives in this repo rather than a
  separate `nakomis-pi-agent`, as it shares the protocol.
