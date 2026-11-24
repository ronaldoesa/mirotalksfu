# Remote flashlight (Senter jarak jauh) — design

Date: 2026-11-24
Branch: `test_update`
Design: Claude Design project "TOB Live Survey", file `TOB Live Survey Flashlight.dc.html`, options **1b + glow from 1d** (surveyor) and **1g** (customer).

## Goal

During a live survey the surveyor can turn the customer's camera flashlight on and off, so damage in dark areas (under a bumper, inside a wheel arch, at night) is visible in the stream and in snapshots.

## Decisions

- **Only the surveyor (room presenter) can toggle.** Enforced on the server, not just hidden in the UI.
- **No approval step.** The light switches immediately; the customer is told by an on-screen chip.
- **Unavailable = disabled with a reason.** If the customer's current camera has no torch, the surveyor's control is greyed out and says why. The customer's camera is never switched automatically.
- **State lives in the customer's server-side peer info** (`peer_torch_supported`, `peer_torch`), the same way mic/camera/hand status is kept, so a surveyor who joins late or reconnects sees the correct state.

## Platform constraints

- Uses `MediaStreamTrack.getCapabilities().torch` and `applyConstraints({ advanced: [{ torch: bool }] })`.
- Works on Chrome for Android with the rear camera. Front cameras have no torch. iPhone Safari and desktop webcams generally report no `torch` capability, so they show as unavailable. Support is detected at runtime, never by user agent.
- `applyConstraints` replaces all existing constraints, and omitted ones fall back to defaults. The call must merge the track's current constraints (`track.getConstraints()`) with the torch setting, otherwise the resolution can drop from 1080p.
- Any new camera track (swap camera, change device, video off/on) starts with the torch off. State is re-reported on every new video producer.
- Room presenter = first participant to join (`config.presenters.join_first`). If the customer joins the room first, they become presenter and the surveyor won't get the control. This is existing behaviour and out of scope here.

## Behaviour

### Customer device (torch owner)

1. After the local **camera** video producer is created (`RoomClient.produce` for `mediaType.video`, including swap and device change), read `track.getCapabilities().torch`.
2. Report `{ type: 'torchSupported', status: <bool> }` and `{ type: 'torch', status: false }` via `updatePeerInfo` (broadcast).
3. When the local camera producer closes (`closeProducer` for video), report `torchSupported: false` and `torch: false`.
4. On `peerAction` with `action: 'torch'` and `status: <bool>`:
   - Apply the torch with merged constraints.
   - On success, report `{ type: 'torch', status }` and show/hide the 1g chip "Senter dinyalakan surveyor". The flashlight icon in the customer's control bar shows the lit state (status only, not clickable).
   - On failure, send a `peerAction` back to the requester with `action: 'torchFailed'`, and leave the state unchanged.

### Surveyor (presenter)

- On the customer's video tile, an always-visible pill at bottom-right (1b), only rendered when the local user is presenter and the tile is a remote **camera** (not screen share):
  - **Off:** "Senter" with the flashlight icon. Tap sends `peerAction { action: 'torch', status: true, peer_id }`.
  - **On:** amber pill "Senter menyala" with a pulsing dot, the tile gets the amber glow ring, and a top-centre chip shows "Senter mm:ss" and a "Matikan" button (from 1d). Tapping the pill or "Matikan" sends `status: false`.
  - **Pending:** after tapping, the pill is non-interactive until the customer's `torch` peer-info update arrives, or 5 s pass (then it re-enables with no state change).
  - **Unavailable:** greyed pill, label "Tidak tersedia", tooltip "Senter tidak tersedia di kamera ini".
- Toasts (1e) via existing `userLog`, triggered by the customer's confirmed state change: "Senter dinyalakan" / "Senter dimatikan"; on `torchFailed`: "Gagal menyalakan senter".
- The on-timer counts from when the surveyor's client receives `torch: true`. It is display only.
- Initial state comes from `peer_info.peer_torch_supported` / `peer_info.peer_torch` at consume time, so late join and reconnect are correct.

## Changes by file

- `app/src/Peer.js`
  - New `updatePeerInfo` cases `torchSupported` → `peer_info.peer_torch_supported`, `torch` → `peer_info.peer_torch`.
  - Initialise both to `false`.
- `app/src/Server.js`
  - Add `'torch'` to `presenterActions` in the `peerAction` handler, so non-presenters can't toggle.
  - `torchFailed` is a plain relay back to the presenter.
- `public/js/RoomClient.js`
  - Customer side: `reportTorchCapability()`, `applyTorch(status)`, the peer-action handlers for `torch`, and the hooks in `produce` and `closeProducer`.
  - Surveyor side: build the pill and the on-chip in the consumer video tile, plus `handleTorchToggle(peer_id)`.
  - In the receive branch of `updatePeerInfo` (`emit = false`), new `torchSupported` / `torch` cases that update the tile UI and show toasts.
- `public/js/Rules.js`
  - Add `BUTTONS.consumerVideo.torchButton: true` so it can be switched off like the other buttons.
- `public/css/TobRoom.css`
  - Styles for the pill (off / on / pending / unavailable), the glow ring and top chip on the tile, and the customer chip and lit control-bar icon.
  - Amber `#F5B300` is only for "light on".
- `public/views/Room.html`
  - Customer-side flashlight status icon in the bottom bar (hidden unless torch is on).

## Error handling

- `getCapabilities` missing or throws → treated as unsupported.
- `applyConstraints` rejects → `torchFailed` to the surveyor, and the customer's state stays as it was.
- Customer leaves or the camera stops → the producer close hook reports unsupported/off, and the surveyor's tile is removed anyway.
- A non-presenter emitting `torch` → dropped by the server.

## Testing

- No automated client tests exist in this repo. Verify manually:
  - **Android Chrome customer + desktop surveyor on UAT:** on, off, swap to the front camera (pill becomes unavailable, light off), swap back (available, off), video off/on, surveyor reload mid-session (state restored), and a snapshot taken with the torch on.
  - **iPhone Safari customer:** pill shows unavailable.
  - **Non-presenter:** a second, non-presenter participant sees no pill, and a hand-crafted `peerAction torch` emit from the console is ignored by the server.
- Puppeteer, with a fake camera (no torch): checks the unavailable state renders, and that the pill appears only for the presenter.
- `npm test` still passes.
