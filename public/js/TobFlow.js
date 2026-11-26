'use strict';

// ####################################################
// TOB LIVE SURVEY JOIN FLOW
// Permission, pre-join, password and lobby screens shown in #tobFlow before the room UI.
// Depends on Room.js globals (room_id, RoomURL, isAudioAllowed, ...) at call time only.
// ####################################################

const TOB_SCREENS = {
    permission: 'tobPermission',
    prejoin: 'initUser',
    password: 'tobPassword',
    lobby: 'tobLobby',
    left: 'tobLeft',
};
const TOB_STEP_LABELS = { room: 'Ruangan', prejoin: 'Persiapan', password: 'Kata sandi', lobby: 'Lobi' };
// Screens that belong to another step in the steps bar
const TOB_SCREEN_STEP = { permission: 'prejoin' };

let tobSteps = ['room', 'prejoin', 'lobby'];
let tobLobbyTimer = null;
let tobLobbyStream = null;
let tobMeter = { stream: null, audioContext: null, analyser: null, buffer: null, raf: null };
let tobMeterToken = 0;
let tobMeterPending = false;

function tobEl(id) {
    return document.getElementById(id);
}

function tobShow(screen) {
    const flow = tobEl('tobFlow');
    flow.classList.remove('hidden');
    tobEl('loadingDiv').classList.add('hidden');
    tobEl('tobHeaderActions').classList.remove('hidden');
    tobEl('tobRoomName').innerText = room_id;
    document.querySelectorAll('#tobFlow .tob-room-label').forEach((el) => (el.innerText = room_id));
    for (const [key, id] of Object.entries(TOB_SCREENS)) {
        tobEl(id).classList.toggle('hidden', key !== screen);
    }
    const inFlow = screen !== 'left';
    tobEl('tobSteps').classList.toggle('hidden', !inFlow);
    if (inFlow) {
        const step = TOB_SCREEN_STEP[screen] || screen;
        if (!tobSteps.includes(step)) tobSteps.splice(tobSteps.indexOf('lobby'), 0, step);
        tobRenderSteps(step);
    }
    flow.scrollTop = 0;
}

// Back to the spinner (e.g. after the permission screen, while the room starts)
function tobShowLoading() {
    Object.values(TOB_SCREENS).forEach((id) => tobEl(id).classList.add('hidden'));
    tobEl('loadingDiv').classList.remove('hidden');
}

function tobHide() {
    tobStopMeter();
    tobStopLobby();
    tobEl('tobFlow').classList.add('hidden');
}

function tobRenderSteps(current) {
    const cur = tobSteps.indexOf(current);
    tobEl('tobSteps').innerHTML = tobSteps
        .map((key, i) => {
            const state = i < cur ? 'done' : i === cur ? 'cur' : 'todo';
            const text = state === 'done' ? 'Selesai' : state === 'cur' ? 'Sekarang' : 'Berikutnya';
            return `
            <div class="tob-step is-${state}">
                <div class="tob-step-num">${String(i + 1).padStart(2, '0')} ${text}</div>
                <div class="tob-step-label">${TOB_STEP_LABELS[key]}</div>
            </div>`;
        })
        .join('');
}

function tobSetDisplayName(name) {
    name = (name || '').trim();
    const initials = name
        ? name
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0].toUpperCase())
              .join('')
        : 'TB';
    document.querySelectorAll('#tobFlow .tob-display-name').forEach((el) => (el.innerText = name || 'Anda'));
    document.querySelectorAll('#tobFlow .tob-initials').forEach((el) => (el.innerText = initials));
}

function tobInitHeader() {
    const copyLink = tobEl('tobCopyLink');
    if (copyLink.onclick) return;
    let copyTimeout;
    copyLink.onclick = () => {
        navigator.clipboard?.writeText(RoomURL).catch(() => {});
        tobEl('tobCopyLabel').innerText = 'Tautan disalin';
        clearTimeout(copyTimeout);
        copyTimeout = setTimeout(() => (tobEl('tobCopyLabel').innerText = 'Salin tautan'), 1600);
    };
}

// ####################################################
// CAMERA / MICROPHONE PERMISSION
// ####################################################

// Show the permission screen: waiting for the browser prompt, or blocked
function tobShowPermission(denied = false) {
    tobInitHeader();
    tobShow('permission');
    tobEl('tobPermission').querySelector('.tob-perm').classList.toggle('is-denied', denied);
    tobEl('tobPermAskingImg').classList.toggle('hidden', denied);
    tobEl('tobPermDeniedImg').classList.toggle('hidden', !denied);
    tobEl('tobPermDeniedActions').classList.toggle('hidden', !denied);
    tobEl('tobPermPill').lastChild.textContent = denied ? 'Akses ditolak' : 'Menunggu izin';
    tobEl('tobPermTitle').innerText = denied ? 'Kamera dan mikrofon diblokir' : 'Izinkan akses kamera dan mikrofon';
    tobEl('tobPermBody').innerText = denied
        ? 'Surveyor perlu melihat dan mendengar Anda selama survei. Aktifkan akses di pengaturan browser untuk melanjutkan.'
        : 'Pilih "Izinkan" pada pop-up browser agar surveyor dapat melihat dan mendengar Anda.';
    document
        .querySelectorAll('#tobPermission .tob-perm-status')
        .forEach((el) => (el.innerText = denied ? 'Diblokir' : 'Menunggu izin'));
}

// True when the browser already granted both camera and microphone (no prompt will open)
async function tobPermissionsGranted() {
    try {
        const [cam, mic] = await Promise.all(
            ['camera', 'microphone'].map((name) => navigator.permissions.query({ name })),
        );
        return cam.state === 'granted' && mic.state === 'granted';
    } catch (err) {
        return false; // Permissions API or these names unsupported (e.g. Firefox)
    }
}

// Show the blocked screen and resolve with 'retry' or 'skip'
function tobPermissionDenied() {
    tobShowPermission(true);
    return new Promise((resolve) => {
        tobEl('tobPermRetry').onclick = () => {
            tobShowPermission(false);
            resolve('retry');
        };
        tobEl('tobPermSkip').onclick = () => resolve('skip');
    });
}

// ####################################################
// PRE-JOIN
// ####################################################

function tobSetTool(button, { off = false, active = false, icon, label }) {
    if (!button) return;
    button.classList.toggle('is-off', off);
    button.classList.toggle('is-active', active);
    const i = button.querySelector('i');
    if (i && icon) i.className = icon;
    const span = button.querySelector('.tob-tool-label');
    if (span && label) span.innerText = label;
}

// Reflect the Room.js init media state (isAudioAllowed, isVideoAllowed, ...) on the pre-join screen
function tobSyncPrejoin() {
    tobSetTool(initVideoButton, {
        off: !isVideoAllowed,
        icon: 'fas fa-video' + (isVideoAllowed ? '' : '-slash'),
        label: isVideoAllowed ? 'Kamera' : 'Kamera mati',
    });
    tobSetTool(initAudioButton, {
        off: !isAudioAllowed,
        icon: 'fas fa-microphone' + (isAudioAllowed ? '' : '-slash'),
        label: isAudioAllowed ? 'Mikrofon' : 'Mikrofon mati',
    });
    tobSetTool(initAudioVideoButton, {
        off: !isAudioVideoAllowed,
        icon: 'fas fa-eye' + (isAudioVideoAllowed ? '' : '-slash'),
    });
    tobSetTool(initVideoMirrorButton, { active: !joinRoomWithScreen && initVideo.classList.contains('mirror') });

    tobEl('tobNamebarMicOff').classList.toggle('hidden', isAudioAllowed);
    tobEl('tobShareBadge').classList.toggle('hidden', !joinRoomWithScreen);
    tobEl('tobCamFallbackText').innerText =
        isVideoAllowed || joinRoomWithScreen ? 'Menyiapkan kamera' : 'Kamera dimatikan';

    // Hide a device field when Room.js hid its select
    document.querySelectorAll('#tobFlow [data-select]').forEach((field) => {
        const select = tobEl(field.dataset.select);
        const hidden = select.classList.contains('hidden') || select.style.display === 'none';
        field.classList.toggle('hidden', hidden);
    });

    const prejoinVisible = !tobEl('initUser').classList.contains('hidden');
    isAudioAllowed && prejoinVisible ? tobStartMeter() : tobStopMeter();
}

// Show the pre-join screen and resolve with a validated name
function tobAskName(defaultName, forceName) {
    tobInitHeader();
    tobShow('prejoin');

    const input = tobEl('usernameInput');
    const error = tobEl('usernameError');
    input.value = defaultName || '';
    input.disabled = !!forceName;
    tobSetDisplayName(input.value);
    tobSyncPrejoin();

    initMicrophoneSelect.addEventListener('change', () => tobStartMeter(true));
    tobEl('initBackButton').onclick = () => openURL('/');

    const setError = (text) => {
        error.innerText = text || '';
        error.classList.toggle('hidden', !text);
        input.classList.toggle('is-invalid', !!text);
    };
    input.oninput = () => {
        setError('');
        tobSetDisplayName(input.value);
    };

    return new Promise((resolve) => {
        const submit = () => {
            let name = input.value.trim();
            if (!name) return setError('Isi nama Anda agar host mengenali Anda.');
            if (name.length > 30) return setError('Nama maksimal 30 karakter.');
            name = filterXSS(name);
            if (isHtml(name)) return setError('Nama tidak valid.');
            setError('');
            tobStopMeter();
            tobEl('initJoinButton').disabled = true;
            resolve(name);
        };
        tobEl('initJoinButton').onclick = submit;
        input.onkeyup = (e) => {
            if (e.key === 'Enter') submit();
        };
    });
}

async function tobStartMeter(restart = false) {
    if ((tobMeter.stream || tobMeterPending) && !restart) return;
    tobStopMeter();
    if (!isAudioAllowed || !isAudioContextSupported()) return;
    const token = tobMeterToken;
    tobMeterPending = true;
    try {
        const deviceId = initMicrophoneSelect.value;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        // Stopped or restarted while getUserMedia was pending
        if (token !== tobMeterToken) return stopTracks(stream);
        tobMeterPending = false;
        if (!isAudioAllowed || tobEl('initUser').classList.contains('hidden')) return stopTracks(stream);
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        tobMeter = { stream, audioContext, analyser, buffer: new Uint8Array(analyser.fftSize), raf: null };
        // Autoplay policy keeps the context suspended until the first user gesture on this page
        if (audioContext.state === 'suspended') {
            const resume = () => audioContext.resume().catch(() => {});
            resume();
            document.addEventListener('pointerdown', resume, { once: true });
            document.addEventListener('keydown', resume, { once: true });
        }
        tobDrawMeter();
    } catch (err) {
        if (token === tobMeterToken) tobMeterPending = false;
        console.warn('TOB mic meter', err.message);
    }
}

function tobDrawMeter() {
    const { analyser, buffer } = tobMeter;
    let level = 0;
    if (analyser) {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            const v = (buffer[i] - 128) / 128;
            sum += v * v;
        }
        level = Math.min(1, Math.sqrt(sum / buffer.length) * 4);
    }
    tobPaintMeter(level);
    if (analyser) tobMeter.raf = requestAnimationFrame(tobDrawMeter);
}

function tobPaintMeter(level) {
    const lit = Math.round(level * 16);
    Array.from(tobEl('tobMicMeter').children).forEach((bar, i) => {
        bar.style.background = i < lit ? (i < 10 ? '#059669' : i < 14 ? '#D97706' : '#DC2626') : '#EDF0F4';
    });
}

function tobStopMeter() {
    tobMeterToken++;
    tobMeterPending = false;
    if (tobMeter.raf) cancelAnimationFrame(tobMeter.raf);
    if (tobMeter.stream) tobMeter.stream.getTracks().forEach((track) => track.stop());
    if (tobMeter.audioContext) tobMeter.audioContext.close().catch(() => {});
    tobMeter = { stream: null, audioContext: null, analyser: null, buffer: null, raf: null };
    tobPaintMeter(0);
}

// ####################################################
// PASSWORD
// ####################################################

// Show the password screen and resolve with the entered password; onCancel runs on "Batal"
function tobAskPassword(errorText, onCancel) {
    tobInitHeader();
    tobShow('password');

    const input = tobEl('tobRoomPassword');
    const error = tobEl('tobRoomPasswordError');
    const setError = (text) => {
        error.innerText = text || '';
        error.classList.toggle('hidden', !text);
        input.classList.toggle('is-invalid', !!text);
    };
    input.value = '';
    setError(errorText);
    input.oninput = () => setError('');
    input.focus();

    tobEl('tobRoomPasswordToggle').onclick = () => {
        input.type = input.type === 'password' ? 'text' : 'password';
    };
    tobEl('tobRoomPasswordCancel').onclick = onCancel;

    return new Promise((resolve) => {
        const submit = () => {
            const pwd = input.value.trim();
            if (!pwd) return setError('Masukkan kata sandi ruangan.');
            resolve(pwd);
        };
        tobEl('tobRoomPasswordSubmit').onclick = submit;
        input.onkeyup = (e) => {
            if (e.key === 'Enter') submit();
        };
    });
}

// ####################################################
// LOBBY
// ####################################################

function tobShowLobby(onLeave) {
    tobInitHeader();
    tobSetDisplayName(peer_name);
    tobShow('lobby');
    tobEl('tobLobbyLeave').onclick = onLeave;

    let secs = 0;
    const time = tobEl('tobLobbyTime');
    time.innerText = '00:00';
    clearInterval(tobLobbyTimer);
    tobLobbyTimer = setInterval(() => {
        secs++;
        time.innerText = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
    }, 1000);

    const video = tobEl('tobLobbyVideo');
    video.classList.toggle('mirror', isInitVideoMirror);
    if (isVideoAllowed && !tobLobbyStream) {
        const deviceId = initVideoSelect.value;
        navigator.mediaDevices
            .getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true })
            .then((stream) => {
                if (tobEl('tobLobby').classList.contains('hidden')) return stopTracks(stream);
                tobLobbyStream = stream;
                video.srcObject = stream;
            })
            .catch((err) => console.warn('TOB lobby preview', err.message));
    }
}

function tobStopLobby() {
    clearInterval(tobLobbyTimer);
    tobLobbyTimer = null;
    if (tobLobbyStream) {
        tobLobbyStream.getTracks().forEach((track) => track.stop());
        tobLobbyStream = null;
        tobEl('tobLobbyVideo').srcObject = null;
    }
}

// ####################################################
// IN ROOM
// ####################################################

let tobRoomStart = null;
let tobRoomTimer = null;

function tobMmss(secs) {
    return String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
}

// Surveyors are identified by name (the server applies the same rule to the torch)
function isSurveyorName(name) {
    return typeof name === 'string' && name.toLowerCase().includes('surveyor');
}

function tobRoomElapsed() {
    return tobMmss(tobRoomStart ? Math.floor((Date.now() - tobRoomStart) / 1000) : 0);
}

// Show the room header and start the session timer (called once the server lets the peer in)
function tobStartRoomHeader() {
    const header = tobEl('tobRoomHeader');
    header.classList.remove('hidden');
    header.querySelectorAll('.tob-room-label').forEach((el) => (el.innerText = room_id));
    tobEl('tobRoomShare').onclick = () => shareRoom();
    if (!tobRoomStart) tobRoomStart = Date.now();
    clearInterval(tobRoomTimer);
    tobRoomTimer = setInterval(() => (tobEl('tobRoomElapsed').innerText = tobRoomElapsed()), 1000);
}

// "Anda telah keluar dari survei" screen
function tobShowLeft() {
    clearInterval(tobRoomTimer);
    // The page stays open, so release the camera and mic ourselves
    const streams = [rc?.localAudioStream, rc?.localVideoStream, rc?.localScreenStream];
    document.querySelectorAll('video, audio').forEach((el) => streams.push(el.srcObject));
    streams.forEach((stream) => stream?.getTracks?.().forEach((track) => track.stop()));
    tobEl('tobRoomHeader').classList.add('hidden');
    tobEl('tobLeftDuration').innerText = tobRoomElapsed();
    tobEl('tobLeftRejoin').onclick = () => openURL('/join/?room=' + room_id);
    tobInitHeader();
    tobShow('left');
}

// Confirm dialog in the design's style; resolves true on OK
function tobConfirm({ title, body, ok, cancel = 'Batal', danger = false }) {
    const icon = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path>
        </svg>`;
    return Swal.fire({
        title,
        text: body,
        showCancelButton: true,
        confirmButtonText: ok,
        cancelButtonText: cancel,
        reverseButtons: true,
        customClass: { popup: 'tob-dialog-left' + (danger ? ' tob-danger' : '') },
        didRender: (popup) => {
            if (!popup.querySelector('.tob-pop-icon')) {
                popup
                    .querySelector('.swal2-title')
                    .insertAdjacentHTML('beforebegin', `<div class="tob-pop-icon">${icon}</div>`);
            }
        },
        showClass: { popup: 'animate__animated animate__fadeIn' },
        hideClass: { popup: 'animate__animated animate__fadeOut' },
    }).then((result) => result.isConfirmed);
}

// Status popup body (reconnect, server away, time limit)
function tobStatusHtml({ spinner = false, mascot = false, pill, tone = 'amber', title, body, barSecs = 0 }) {
    return `
        <div class="tob-status">
            ${spinner ? '<div class="tob-status-spinner"></div>' : ''}
            ${mascot ? '<img src="../images/tob/lala-bingung.png" alt="Lala" />' : ''}
            <span class="tob-pill is-${tone}"><span class="tob-dot"></span>${pill}</span>
            <div><h2>${title}</h2><p>${body}</p></div>
            ${barSecs ? `<div class="tob-timer-bar"><span style="animation-duration:${barSecs}s"></span></div>` : ''}
        </div>`;
}
