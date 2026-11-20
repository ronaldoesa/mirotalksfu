# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fork (`origin` = ronaldoesa/mirotalksfu, `upstream` = miroslavpejic85/mirotalksfu) of **MiroTalk SFU**, a WebRTC video-conferencing server built on mediasoup + Socket.IO + Express. Work happens on the `test_update` branch; upstream changes are pulled in via merges of `upstream/main`.

The fork adds a **live-survey evidence capture** flow for insurance claims: a participant snapshots their own camera, the image is timestamp-watermarked client-side and uploaded to Azure Blob Storage (see "Fork-specific code" below). It also disables various upstream UI buttons.

## Commands

```bash
npm install                 # mediasoup builds a native worker: needs Python 3, gcc/g++/make (or MSVC on Windows)
npm start                   # node app/src/Server.js  -> https://localhost:3010 (PORT=3011 npm start to override)
npm run start-dev           # nodemon
npm test                    # mocha tests/*.js
npx mocha tests/test-Validator.js           # single test file
npx mocha tests/*.js --grep "some test name" # single test
npm run lint                # prettier --write . (4 spaces, single quotes, printWidth 120, trailing commas)
npm run compile             # rebuild public/sfu/MediasoupClient.js via browserify (only after bumping mediasoup-client)
```

Tests `require('../app/src/config')`, so `app/src/config.js` must exist (CI copies it from `config.template.js`). Tests only cover `ServerApi`, `Validator` and `XSS` — the server and the browser client have no automated tests.

Docker: `docker-compose.template.yml` → `docker-compose.yml`; `npm run docker-build` / `docker-run`. RTMP side-servers live in `rtmpServers/` (`npm run rtmp-start`, `nms-start`). `cloud/` and `webhook/` are separate small Node apps with their own `package.json`.

## Configuration

All server configuration is one JS module: `app/src/config.js` (template: `app/src/config.template.js`). In this fork `config.js` **is committed** and differs from the template (hard-coded public `IPv4`, `azure` section, other env-specific values). When merging upstream, new keys added to `config.template.js` must be ported into `config.js` manually or the server will read `undefined`. Key sections: `server` (listen port, SSL, `hostUrl`), `host` (host protection / user auth), `oidc`, `api` (REST API secret + allowed endpoints), `jwt`, `ui` (feature/button toggles sent to the client), `mediasoup` (workers, port range `rtcMinPort`–`rtcMaxPort`, `announcedAddress`), and `azure` (`env` must match the deployment: `UAT` vs `LIVE`).

The browser fetches `/config` and `/brand` at load; `config.ui.buttons` drives which buttons the client shows.

## Architecture

### Server (`app/src/`)

- **`Server.js`** (~3.4k lines) is the whole backend in one file: Express routes (pages, `/join` URL-param join flow, OIDC/host login, RTMP control, REST API under `config.api.basePath` = `/api/v1`, Swagger docs at `/api/v1/docs`), mediasoup worker creation (`createWorkers` / round-robin `getMediasoupWorker`), and **all Socket.IO handlers** inside `io.on('connection')`. In-memory state: `roomList` (Map roomId → `Room`) — nothing is persisted; rooms vanish when the last peer leaves or the process restarts.
- **`Room.js`** — one mediasoup `Router` per room, plus audio-level / active-speaker observers, peers map, lock/lobby/broadcast state, polls, RTMP streamers, and `broadCast` / `sendTo` / `sendToAll` helpers that emit over Socket.IO.
- **`Peer.js`** — per-socket transports, producers, consumers and peer info (name, audio/video state, presenter flag).
- **`ServerApi.js`** — REST API auth/token/meeting URL helpers (the only part with real unit tests).
- `XSS.js` / `Validator.js` sanitize every incoming socket payload (`checkXSS`), `Host.js` tracks authorized host IPs, `RtmpFile`/`RtmpUrl`/`RtmpStreamer` wrap ffmpeg, `Discord`/`Mattermost` are chat integrations.
- `app/api/` contains example REST clients (js/php/py/sh) and `swagger.yaml`.

### Client (`public/`)

Plain browser JS, **no bundler/modules** — scripts are loaded via `<script defer>` tags in `public/views/*.html` and share globals. CDN libraries (socket.io client, sweetalert2, fabric, etc.) are pulled in by the HTML.

- **`public/js/Room.js`** (~5k lines) — page bootstrap: reads URL params / local storage, device setup and "init" screen, builds the toolbar, wires DOM buttons, then constructs the global `rc = new RoomClient(...)`.
- **`public/js/RoomClient.js`** (~9.7k lines) — the in-call engine: Socket.IO signaling (`initSockets` registers all `socket.on` handlers), mediasoup-client `Device` + send/recv transports, produce/consume of audio/video/screen, video element creation, chat, whiteboard, file sharing, recording, polls, etc.
- `public/sfu/MediasoupClient.js` is a **generated** browserify bundle — don't edit by hand.
- `VideoGrid.js` lays out video tiles; `Rules.js` applies host/guest UI restrictions; `LocalStorage.js` persists user settings.

### Signaling flow

Client and server talk via Socket.IO request/ack events whose names match on both sides (e.g. `createRoom` → `join` → `getRouterRtpCapabilities` → `createWebRtcTransport` → `connectTransport` → `produce` / `consume` → `resumeConsumer`). Server-to-client events (`newProducers`, `consumerClosed`, `roomAction`, `peerAction`, `cmd`, …) are handled in `RoomClient.initSockets`. When adding a feature, add the `socket.on` handler in `Server.js`, the emit/handler in `RoomClient.js`, and usually a `Room` method for broadcasting.

## Fork-specific code

- `RoomClient.captureLocalEvidence()` selects the local `<video name="<socket.id>">`, draws it to a canvas at native resolution, watermarks a timestamp, rate-limits to one snap per 3s, and POSTs the PNG as multipart `file` to `/api/v1/uploadToAzure` (filename `<roomId>-<datetime>-SNAPSHOT.png`).
- `Server.js` `POST /api/v1/uploadToAzure` (multer memory storage) uploads to blob path `${azure.env}/${azure.folderName}/${caseName}/${fileName}`, where `caseName` is parsed from the filename with `/^MV-\d+-\d+/` — so **room IDs are expected to be claim case numbers like `MV-123-456`**, otherwise the folder becomes `null`. `/uploadToAzureOld` (base64 dataURL body) is the legacy variant.
