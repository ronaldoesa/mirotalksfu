# Remote Flashlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the surveyor (room presenter) turn the customer's camera flashlight on and off during a live survey.

**Architecture:** The customer's browser owns the torch. It reports `torchSupported` and `torch` into its server-side `peer_info` through the existing `updatePeerInfo` event, and it obeys `peerAction { action: 'torch' }`, which the server only relays from presenters. The surveyor's browser keeps a per-peer torch map, seeded from `peer_info` at consume time and updated by broadcasts. It renders a pill, a glow and a timer chip on the customer's tile (design options 1b + 1d). The customer sees a chip and a lit control-bar icon (design option 1g).

**Tech Stack:** Node/Express/Socket.IO server (`app/src`), plain browser JS with no bundler (`public/js`), mocha + should for tests, and the MediaStream `torch` constraint.

Spec: `docs/superpowers/specs/2026-11-24-remote-flashlight-design.md`

---

## File map

| File | Change |
| --- | --- |
| `app/src/Peer.js` | Store `peer_torch_supported` and `peer_torch` in peer info |
| `tests/test-Peer.js` (new) | Unit tests for the Peer torch state |
| `app/src/Server.js` | `'torch'` added to `presenterActions` |
| `public/js/Rules.js` | `BUTTONS.consumerVideo.torchButton` flag |
| `public/js/RoomClient.js` | Customer torch logic, surveyor tile controls, peer-info and peer-action handling |
| `public/views/Room.html` | Customer chip and control-bar status icon |
| `public/css/TobRoom.css` | Styles for the pill, glow, chip and customer indicator |

---

### Task 1: Peer stores torch state (server)

**Files:**
- Create: `tests/test-Peer.js`
- Modify: `app/src/Peer.js:22-33` (constructor) and `app/src/Peer.js:80-86` (switch)

- [ ] **Step 1: Write the failing test**

Create `tests/test-Peer.js`:

```js
'use strict';

// npx mocha tests/test-Peer.js

require('should');

const Peer = require('../app/src/Peer');

describe('test-Peer', () => {
    const newPeer = () => new Peer('socket-1', { peer_info: { peer_name: 'tari', peer_uuid: 'u-1' } });

    it('starts with the torch unsupported and off', () => {
        const peer = newPeer();
        peer.peer_info.peer_torch_supported.should.equal(false);
        peer.peer_info.peer_torch.should.equal(false);
    });

    it('stores torchSupported updates', () => {
        const peer = newPeer();
        peer.updatePeerInfo({ type: 'torchSupported', status: true });
        peer.peer_info.peer_torch_supported.should.equal(true);
    });

    it('stores torch on/off updates', () => {
        const peer = newPeer();
        peer.updatePeerInfo({ type: 'torch', status: true });
        peer.peer_info.peer_torch.should.equal(true);
        peer.updatePeerInfo({ type: 'torch', status: false });
        peer.peer_info.peer_torch.should.equal(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha tests/test-Peer.js`
Expected: FAIL on the first test (`peer_torch_supported` is undefined).

- [ ] **Step 3: Implement**

In `app/src/Peer.js`, after `this.peer_hand = peer_hand;` add:

```js
        // Remote flashlight, reported by the peer's own camera
        this.peer_info.peer_torch_supported = false;
        this.peer_info.peer_torch = false;
```

In `updatePeerInfo`, before `default:` add:

```js
            case 'torchSupported':
                this.peer_info.peer_torch_supported = data.status;
                break;
            case 'torch':
                this.peer_info.peer_torch = data.status;
                break;
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass (51 existing + 3 new = 54 passing).

- [ ] **Step 5: Commit**

```bash
git add tests/test-Peer.js app/src/Peer.js
git commit -m "Store remote flashlight state in peer info"
```

---

### Task 2: Only presenters can toggle the torch (server)

**Files:**
- Modify: `app/src/Server.js:2074-2084` (`presenterActions` in the `peerAction` handler)

- [ ] **Step 1: Implement**

Add `'torch'` to the array:

```js
            const presenterActions = [
                'mute',
                'unmute',
                'hide',
                'unhide',
                'stop',
                'start',
                'eject',
                'ban',
                'geoLocation',
                'torch',
            ];
```

`torchFailed` stays a plain relay (customer → surveyor) and needs no server change. Requests from non-presenters are dropped by the existing `if (!isPresenter) return;`, which checks `data.from_peer_name` / `data.from_peer_uuid`. The client must therefore send both (Task 5 does).

- [ ] **Step 2: Syntax check**

Run: `node --check app/src/Server.js && npm test`
Expected: no output from `--check`, and 54 passing.

- [ ] **Step 3: Commit**

```bash
git add app/src/Server.js
git commit -m "Restrict the torch peer action to presenters"
```

---

### Task 3: Button flag

**Files:**
- Modify: `public/js/Rules.js:61-73` (`consumerVideo`)

- [ ] **Step 1: Implement**

In `consumerVideo`, after `snapShotButton: true,` add:

```js
        torchButton: true, // Presenter: remote flashlight on the customer's camera
```

- [ ] **Step 2: Commit**

```bash
git add public/js/Rules.js
git commit -m "Add torchButton flag for consumer video"
```

---

### Task 4: Customer side — report and apply the torch

**Files:**
- Modify: `public/js/RoomClient.js`
  - constructor, after `this.peer_uuid = peer_uuid;` (~line 223)
  - `produce()` switch, `case mediaType.video` (~line 1767)
  - `closeProducer()` switch, `case mediaType.video` (~line 2412)
  - new methods after `captureLocalEvidence()` (~line 1125)
  - `handlePeerAction` (~line 1161)

- [ ] **Step 1: Constructor state**

After `this.peer_info = peer_info;` add:

```js
        // Remote flashlight: own camera track + torch, and the remote peers' torch state
        this.cameraTrack = null;
        this.torchOn = false;
        this.peerTorch = new Map(); // peer_id -> { supported, on, since, pending }
        this.peerTorchTimer = null;
```

- [ ] **Step 2: Customer methods**

Insert after the closing brace of `captureLocalEvidence()`:

```js
    // ####################################################
    // REMOTE FLASHLIGHT (camera owner side)
    // ####################################################

    isTorchSupported(track) {
        try {
            return !!(track && track.readyState === 'live' && track.getCapabilities().torch);
        } catch (err) {
            return false;
        }
    }

    reportTorch(supported, on) {
        this.torchOn = on;
        this.updatePeerInfo(this.peer_name, this.peer_id, 'torchSupported', supported);
        this.updatePeerInfo(this.peer_name, this.peer_id, 'torch', on);
        this.setTorchIndicator(on);
    }

    async applyTorch(on) {
        const track = this.cameraTrack;
        if (!this.isTorchSupported(track)) throw new Error('Torch not supported on this camera');
        // applyConstraints replaces every constraint, keep the current ones (resolution, fps, device)
        const { advanced, ...current } = track.getConstraints();
        await track.applyConstraints({ ...current, advanced: [{ torch: on }] });
    }

    async handleTorchRequest(data) {
        try {
            await this.applyTorch(data.status);
            this.torchOn = data.status;
            this.updatePeerInfo(this.peer_name, this.peer_id, 'torch', data.status);
            this.setTorchIndicator(data.status);
        } catch (err) {
            console.warn('Torch toggle failed', err);
            this.socket.emit('peerAction', {
                action: 'torchFailed',
                peer_id: data.from_peer_id,
                from_peer_id: this.peer_id,
                from_peer_name: this.peer_name,
            });
        }
    }

    setTorchIndicator(on) {
        const chip = this.getId('tobTorchChip');
        const status = this.getId('tobTorchStatus');
        if (chip) chip.classList.toggle('hidden', !on);
        if (status) status.classList.toggle('hidden', !on);
    }
```

- [ ] **Step 3: Hook into produce / closeProducer**

In `produce()`, replace the video case of the final switch:

```js
                case mediaType.video:
                    this.setIsVideo(true);
                    this.event(_EVENTS.startVideo);
                    // A new camera track always starts with the torch off
                    this.cameraTrack = track;
                    this.reportTorch(this.isTorchSupported(track), false);
                    break;
```

In `closeProducer()`, replace the video case of the final switch:

```js
            case mediaType.video:
                this.setIsVideo(false);
                this.event(_EVENTS.stopVideo);
                this.cameraTrack = null;
                this.reportTorch(false, false);
                break;
```

- [ ] **Step 4: Peer action handling (both sides)**

In `handlePeerAction`, after the snapshot block and before the final `this.peerAction(...)` call, add:

```js
        // 🔦 REMOTE FLASHLIGHT
        if (data.action === 'torch') {
            this.handleTorchRequest(data);
            return;
        }
        if (data.action === 'torchFailed') {
            this.handleTorchFailed(data.from_peer_id);
            return;
        }
```

`handleTorchFailed` is added in Task 5.

- [ ] **Step 5: Commit after Task 5** (Task 4 alone references `handleTorchFailed`)

---

### Task 5: Surveyor side — tile controls

**Files:**
- Modify: `public/js/RoomClient.js`
  - `handleConsumer()`, after `d.appendChild(pm);` (~line 2709)
  - the receive branch of `updatePeerInfo()` (`emit = false`, ~line 8629)
  - new methods after the Task 4 methods

- [ ] **Step 1: Surveyor methods**

Insert after `setTorchIndicator()`:

```js
    // ####################################################
    // REMOTE FLASHLIGHT (surveyor side)
    // ####################################################

    createTorchControls(peer_id, peer_info) {
        // The map holds every broadcast received so far, so it is never older than peer_info
        if (!this.peerTorch.has(peer_id)) {
            this.peerTorch.set(peer_id, {
                supported: !!peer_info.peer_torch_supported,
                on: !!peer_info.peer_torch,
                since: peer_info.peer_torch ? Date.now() : 0,
                pending: null,
            });
        }
        const icon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z"/><path d="M6 6h12"/></svg>';
        const wrap = document.createElement('div');
        wrap.id = peer_id + '__torch';
        wrap.className = 'tob-torch';
        wrap.innerHTML =
            `<div class="tob-torch-chip">${icon}<span>Senter</span><span class="tob-torch-time">00:00</span>` +
            `<button type="button">Matikan</button></div>` +
            `<button type="button" class="tob-torch-pill">${icon}<span class="tob-torch-label">Senter</span></button>`;
        const toggle = (e) => {
            e.stopPropagation();
            this.requestTorch(peer_id);
        };
        wrap.querySelector('.tob-torch-pill').onclick = toggle;
        wrap.querySelector('.tob-torch-chip button').onclick = toggle;
        return wrap;
    }

    requestTorch(peer_id) {
        const state = this.peerTorch.get(peer_id);
        if (!state || !state.supported || state.pending) return;
        state.pending = setTimeout(() => {
            state.pending = null;
            this.renderTorch(peer_id);
        }, 5000);
        this.socket.emit('peerAction', {
            action: 'torch',
            status: !state.on,
            peer_id: peer_id,
            from_peer_id: this.peer_id,
            from_peer_name: this.peer_name,
            from_peer_uuid: this.peer_uuid,
        });
        this.renderTorch(peer_id);
    }

    setPeerTorch(peer_id, type, status) {
        const state = this.peerTorch.get(peer_id) || { supported: false, on: false, since: 0, pending: null };
        this.peerTorch.set(peer_id, state);
        if (type === 'torchSupported') {
            state.supported = status;
        } else {
            if (status && !state.on) state.since = Date.now();
            state.on = status;
            if (state.pending) {
                clearTimeout(state.pending);
                state.pending = null;
                this.userLog(status ? 'success' : 'info', status ? 'Senter dinyalakan' : 'Senter dimatikan', 'top-end', 3000);
            }
        }
        this.renderTorch(peer_id);
    }

    handleTorchFailed(peer_id) {
        const state = this.peerTorch.get(peer_id);
        if (state && state.pending) {
            clearTimeout(state.pending);
            state.pending = null;
        }
        this.userLog('error', 'Gagal menyalakan senter', 'top-end', 4000);
        this.renderTorch(peer_id);
    }

    renderTorch(peer_id) {
        const wrap = this.getId(peer_id + '__torch');
        const state = this.peerTorch.get(peer_id);
        if (wrap && state) {
            const pill = wrap.querySelector('.tob-torch-pill');
            wrap.classList.toggle('is-on', state.supported && state.on);
            wrap.classList.toggle('is-unavailable', !state.supported);
            wrap.classList.toggle('is-pending', !!state.pending);
            pill.disabled = !state.supported || !!state.pending;
            pill.querySelector('.tob-torch-label').textContent = !state.supported
                ? 'Tidak tersedia'
                : state.on
                  ? 'Senter menyala'
                  : 'Senter';
            pill.title = !state.supported
                ? 'Senter tidak tersedia di kamera ini'
                : state.on
                  ? 'Matikan senter'
                  : 'Nyalakan senter';
        }
        this.updateTorchTimes();
    }

    updateTorchTimes() {
        let anyOn = false;
        this.peerTorch.forEach((state, peer_id) => {
            if (!state.on) return;
            anyOn = true;
            const wrap = this.getId(peer_id + '__torch');
            const time = wrap && wrap.querySelector('.tob-torch-time');
            if (time) time.textContent = tobMmss(Math.floor((Date.now() - state.since) / 1000));
        });
        if (anyOn && !this.peerTorchTimer) this.peerTorchTimer = setInterval(() => this.updateTorchTimes(), 1000);
        if (!anyOn && this.peerTorchTimer) {
            clearInterval(this.peerTorchTimer);
            this.peerTorchTimer = null;
        }
    }
```

(`tobMmss` is a global from `public/js/TobFlow.js`.)

- [ ] **Step 2: Add the controls to the customer's tile**

In `handleConsumer()`, right after `d.appendChild(pm);`:

```js
                const showTorch = !remoteIsScreen && isPresenter && BUTTONS.consumerVideo.torchButton;
                if (showTorch) d.appendChild(this.createTorchControls(remotePeerId, peer_info));
```

After `this.videoMediaContainer.appendChild(d);` (the element must be in the DOM for `getId`):

```js
                if (showTorch) this.renderTorch(remotePeerId);
```

- [ ] **Step 3: Receive peer-info broadcasts**

In `updatePeerInfo()`, in the `else` (receive) branch switch, before `default:`:

```js
                case 'torchSupported':
                case 'torch':
                    this.setPeerTorch(peer_id, type, status);
                    break;
```

- [ ] **Step 4: Syntax check**

Run: `node --check public/js/RoomClient.js`
Expected: no output.

- [ ] **Step 5: Commit Tasks 4 and 5**

```bash
git add public/js/RoomClient.js
git commit -m "Add remote flashlight control for the surveyor"
```

---

### Task 6: Customer chip, status icon and styles

**Files:**
- Modify: `public/views/Room.html` (inside `#bottomButtons`, before `#exitButton`, ~line 604; and after `</header>` of `#tobRoomHeader`)
- Modify: `public/css/TobRoom.css` (new section before `# Small screens`)

- [ ] **Step 1: Markup**

In `#bottomButtons`, directly before `<button id="exitButton" class="hidden">`:

```html
            <span id="tobTorchStatus" class="tob-torch-status hidden" title="Senter menyala">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z" /></svg>
            </span>
```

Directly after the closing `</header>` of `#tobRoomHeader`:

```html
        <div id="tobTorchChip" class="tob-torch-notice hidden">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z" /></svg>
            <span>Senter dinyalakan surveyor</span>
        </div>
```

- [ ] **Step 2: Styles**

Add to `public/css/TobRoom.css` before the `# Small screens` comment block:

```css
/*--------------------------------------------------------------
# Remote flashlight (amber = light on, used for nothing else)
--------------------------------------------------------------*/

:root {
    --tob-torch: #f5b300;
    --tob-torch-ink: #3b2a00;
}

/* Surveyor: overlay on the customer's tile */
.tob-torch {
    position: absolute;
    inset: 0;
    z-index: 3;
    border-radius: 16px;
    pointer-events: none;
    transition: box-shadow 0.2s;
}

.tob-torch.is-on {
    box-shadow:
        inset 0 0 0 3px var(--tob-torch),
        inset 0 0 36px rgba(245, 179, 0, 0.35);
}

.tob-torch-pill {
    position: absolute;
    right: 12px;
    bottom: 12px;
    height: 34px;
    padding: 0 12px 0 10px;
    display: flex;
    align-items: center;
    gap: 7px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(10, 15, 28, 0.66);
    backdrop-filter: blur(6px);
    color: #ffffff;
    font: 700 12px/1 var(--tob-sans);
    white-space: nowrap;
    cursor: pointer;
    pointer-events: auto;
}

.tob-torch-pill:hover {
    background: rgba(10, 15, 28, 0.8);
}

.tob-torch.is-on .tob-torch-pill {
    background: var(--tob-torch);
    color: var(--tob-torch-ink);
    border-color: transparent;
    box-shadow:
        0 0 0 4px rgba(245, 179, 0, 0.25),
        0 6px 18px rgba(245, 179, 0, 0.45);
}

.tob-torch.is-on .tob-torch-pill svg {
    display: none;
}

.tob-torch.is-on .tob-torch-pill::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--tob-torch-ink);
    animation: tob-torch-pulse 1.6s ease-in-out infinite;
}

.tob-torch.is-pending .tob-torch-pill {
    opacity: 0.6;
    cursor: progress;
}

.tob-torch.is-unavailable .tob-torch-pill {
    color: rgba(255, 255, 255, 0.5);
    background: rgba(10, 15, 28, 0.5);
    cursor: not-allowed;
}

.tob-torch-chip {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    height: 30px;
    padding: 0 6px 0 11px;
    display: none;
    align-items: center;
    gap: 8px;
    border-radius: 9999px;
    background: rgba(10, 15, 28, 0.72);
    backdrop-filter: blur(6px);
    color: #ffffff;
    font: 700 11.5px/1 var(--tob-sans);
    white-space: nowrap;
    pointer-events: auto;
}

.tob-torch.is-on .tob-torch-chip {
    display: flex;
}

.tob-torch-chip svg {
    color: #fcd34d;
}

.tob-torch-time {
    font-family: var(--tob-mono);
    color: #fcd34d;
}

.tob-torch-chip button {
    height: 22px;
    padding: 0 9px;
    border: none;
    border-radius: 9999px;
    background: var(--tob-torch);
    color: var(--tob-torch-ink);
    font: 800 10.5px/1 var(--tob-sans);
    cursor: pointer;
}

@keyframes tob-torch-pulse {
    50% {
        opacity: 0.35;
    }
}

/* Customer: chip under the header + lit status in the control bar */
.tob-torch-notice {
    position: fixed;
    top: 76px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 4;
    height: 28px;
    padding: 0 11px;
    display: flex;
    align-items: center;
    gap: 6px;
    border-radius: 9999px;
    background: var(--tob-torch);
    color: var(--tob-torch-ink);
    font: 800 11px/1 var(--tob-sans);
    white-space: nowrap;
    box-shadow: 0 6px 16px rgba(245, 179, 0, 0.45);
}

.tob-torch-status {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid #fcd34d;
    background: #fef3c7;
    color: #b45309;
}
```

- [ ] **Step 3: Commit**

```bash
git add public/views/Room.html public/css/TobRoom.css
git commit -m "Style the remote flashlight controls and customer notice"
```

---

### Task 7: Verify locally

A headless Chrome fake camera has no torch, so the automated check covers the unavailable state, presenter-only rendering, and the visual states (forced through `setPeerTorch`). The real torch is checked on a phone in Task 8.

- [ ] **Step 1:** `npm test` → 54 passing.
- [ ] **Step 2:** Start the server: `PORT=3011 npm start` (background). Use the scratchpad puppeteer helper (`pp/node_modules/puppeteer-core`, Chrome with `--use-fake-device-for-media-stream`). Join room `torch-test` as "Surveyor" first, then as "tari" in a second page.
- [ ] **Step 3:** On the Surveyor page, assert `document.querySelector('.tob-torch.is-unavailable .tob-torch-pill').disabled === true` and that the label reads "Tidak tersedia". Screenshot.
- [ ] **Step 4:** On the tari page (not presenter), assert `document.querySelectorAll('.tob-torch').length === 0`.
- [ ] **Step 5:** On the Surveyor page, run `rc.setPeerTorch(id, 'torchSupported', true)`, then screenshot the off state. Run `rc.setPeerTorch(id, 'torch', true)`, wait 2 s, and screenshot the on state: glow, amber pill and the timer chip counting. `id` is the tari tile's `video[name]` attribute.
- [ ] **Step 6:** On the tari page, run `rc.setTorchIndicator(true)` and take a mobile-width screenshot (390×844) of the chip and the lit icon.
- [ ] **Step 7:** Non-presenter guard: on the tari page, emit `rc.socket.emit('peerAction', { action: 'torch', status: true, peer_id: <surveyor id>, from_peer_name: 'tari', from_peer_uuid: rc.peer_uuid })`. Check that the Surveyor page's `handlePeerAction` never logs a torch request; listen with `page.on('console')`.
- [ ] **Step 8:** Stop the server. Fix anything found, then commit.

### Task 8: UAT and real-device check (only when the user asks to deploy)

- [ ] Push `test_update`. On the EC2 host, in `/home/ubuntu/mirotalksfu-uat`: `git pull --ff-only`, then `pm2 restart uat` (server files changed: `Peer.js`, `Server.js`).
- [ ] Desktop surveyor joins first, then an Android Chrome customer on the rear camera: on, off, swap to the front camera (pill becomes unavailable, light off), swap back, video off/on, surveyor reload with the torch on (state restored), and a snapshot taken with the torch on.
- [ ] iPhone Safari customer: the pill shows "Tidak tersedia".
