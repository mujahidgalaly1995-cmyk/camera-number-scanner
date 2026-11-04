(() => {
    'use strict';

    const STORAGE_KEY = 'mujahid-scanner-items-v1';
    const HINT_KEY = 'mujahid-scanner-install-hint';
    const AUTO_PREF_KEY = 'mujahid-scanner-auto';
    const AUTO_SCAN_INTERVAL_MS = 1200;
    const AUTO_MIN_CONFIDENCE = 55;
    const MANUAL_MIN_CONFIDENCE = 55;

    // ---------- State ----------
    let items = loadItems();
    let videoStream = null;
    let isProcessing = false;
    let autoScanTimer = null;
    let isAutoScanActive = false;
    let tesseractWorker = null;
    let workerPromise = null;
    let audioCtx = null;
    let lastAutoAdd = { value: null };
    let autoMisses = 0;
    let toastTimer = null;
    let cameraBlocked = false;
    let autoScanPref = loadAutoPref();
    let searchQuery = '';
    let zoomLevel = 1;
    let hardwareZoom = false;

    // ---------- Elements ----------
    const $ = (id) => document.getElementById(id);
    const video = $('cameraVideo');
    const viewfinder = $('viewfinder');
    const cropCanvas = $('cropCanvas');
    const analysisCanvas = document.createElement('canvas');
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    const startCameraBtn = $('startCameraBtn');
    const cameraPlaceholder = $('cameraPlaceholder');
    const captureScanBtn = $('captureScanBtn');
    const scanSpinner = $('scanSpinner');
    const zoomButtons = Array.from(document.querySelectorAll('[data-zoom]'));
    const manualNumberInput = $('manualNumberInput');
    const manualAddBtn = $('manualAddBtn');
    const numbersListContainer = $('numbersListContainer');
    const totalSumDisplay = $('totalSumDisplay');
    const itemsCountBadge = $('itemsCountBadge');
    const listBadge = $('listBadge');
    const avgDisplay = $('avgDisplay');
    const maxDisplay = $('maxDisplay');
    const clearAllBtn = $('clearAllBtn');
    const copyListBtn = $('copyListBtn');
    const exportTextBtn = $('exportTextBtn');
    const autoScanToggle = $('autoScanToggle');
    const autoScanDot = $('autoScanDot');
    const autoScanText = $('autoScanText');
    const toast = $('toast');
    const toastMsg = $('toastMsg');
    const toastIcon = $('toastIcon');
    const installHint = $('installHint');
    const dismissInstallHint = $('dismissInstallHint');
    const headerShareBtn = $('headerShareBtn');
    const searchInput = $('searchInput');
    const searchCount = $('searchCount');
    const countCardValue = $('countCardValue');
    const lastDisplay = $('lastDisplay');
    const manualFab = $('manualFab');
    const manualSheet = $('manualSheet');
    const sheetBackdrop = $('sheetBackdrop');
    const manualCloseBtn = $('manualCloseBtn');

    // ---------- Persistence ----------
    function loadItems() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter((it) => it && typeof it.value === 'number' && Number.isFinite(it.value) && it.value > 0)
                .map((it) => ({
                    id: String(it.id || `${it.createdAt || Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
                    value: it.value,
                    time: String(it.time || ''),
                    source: String(it.source || 'دەستی'),
                    createdAt: Number(it.createdAt) || Date.now(),
                }));
        } catch (e) {
            return [];
        }
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch (e) {
            // Storage can be unavailable in private mode; app still works in memory.
        }
    }

    function loadAutoPref() {
        try {
            const stored = localStorage.getItem(AUTO_PREF_KEY);
            return stored === null ? true : stored === '1';
        } catch (e) {
            return true;
        }
    }

    function saveAutoPref(active) {
        try {
            localStorage.setItem(AUTO_PREF_KEY, active ? '1' : '0');
        } catch (e) {
            // ignore
        }
    }

    // ---------- Sound & haptics ----------
    function playBeep(success = true) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(success ? 1046.5 : 196, now);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.2, now + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + (success ? 0.14 : 0.22));
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + (success ? 0.16 : 0.24));
        } catch (e) {
            // Audio can be blocked before the first user gesture.
        }
        if (navigator.vibrate) navigator.vibrate(success ? 40 : [50, 50, 50]);
    }

    // ---------- Toast ----------
    function showNotification(message, type = 'info') {
        toastMsg.textContent = message;
        if (type === 'success') {
            toastIcon.className = 'fa-solid fa-circle-check text-emerald-500';
        } else if (type === 'error') {
            toastIcon.className = 'fa-solid fa-circle-exclamation text-rose-500';
        } else {
            toastIcon.className = 'fa-solid fa-circle-info text-emerald-500';
        }
        toast.classList.remove('opacity-0', 'pointer-events-none');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.add('opacity-0', 'pointer-events-none');
        }, 2600);
    }

    // ---------- Camera ----------
    function stopCameraStream() {
        if (videoStream) {
            videoStream.getTracks().forEach((track) => track.stop());
            videoStream = null;
        }
    }

    function isCameraReady() {
        return Boolean(
            videoStream &&
            video.readyState >= 2 &&
            !video.paused &&
            !video.ended
        );
    }

    async function startCamera(notifyUser = true) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showNotification('ئەم وێبگەڕە پشتگیری کامێرا ناکات', 'error');
            return;
        }

        stopCameraStream();
        hardwareZoom = false;

        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 2560 },
                    height: { ideal: 1440 },
                },
                audio: false,
            });
            video.srcObject = videoStream;
            await video.play().catch(() => {});
            const track = videoStream.getVideoTracks()[0];
            if (track && track.applyConstraints) {
                track
                    .applyConstraints({
                        advanced: [
                            { focusMode: 'continuous', exposureMode: 'continuous', whiteBalanceMode: 'continuous' },
                        ],
                    })
                    .catch(() => {});
            }
            cameraBlocked = false;
            cameraPlaceholder.classList.add('hidden');
            setZoom(zoomLevel);
            if (notifyUser) showNotification('کامێرا بە سەرکەوتوویی کرایەوە', 'success');
            initTesseractWorker();
        } catch (err) {
            console.error('Camera access error:', err);
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                cameraBlocked = true;
            }
            cameraPlaceholder.classList.remove('hidden');
            showNotification('تکایە ڕێگە بە کامێرا بدە لە ڕێکخستنەکاندا', 'error');
        }
    }

    function ensureCameraRunning() {
        if (cameraBlocked) return;
        const track = videoStream && videoStream.getVideoTracks ? videoStream.getVideoTracks()[0] : null;
        if (track && track.readyState === 'live') {
            if (video.paused) video.play().catch(() => {});
            return;
        }
        startCamera(false);
    }

    // ---------- Zoom ----------
    function updateZoomControls() {
        zoomButtons.forEach((btn) => {
            btn.classList.toggle('zoom-btn-on', Number(btn.dataset.zoom) === zoomLevel);
        });
    }

    async function setZoom(level) {
        zoomLevel = level;
        hardwareZoom = false;
        updateZoomControls();
        video.style.transform = level > 1 ? `scale(${level})` : '';

        const track = videoStream && videoStream.getVideoTracks ? videoStream.getVideoTracks()[0] : null;
        if (!track || typeof track.getCapabilities !== 'function') return;

        try {
            const caps = track.getCapabilities();
            if (caps.zoom && level >= caps.zoom.min && level <= caps.zoom.max) {
                await track.applyConstraints({ advanced: [{ zoom: level }] });
                hardwareZoom = true;
                video.style.transform = '';
            }
        } catch (e) {
            hardwareZoom = false;
        }
    }

    // ---------- OCR worker ----------
    function warmUpWorker(worker) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 260;
            canvas.height = 90;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#111111';
            ctx.font = 'bold 52px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('000', 24, 46);
            worker.recognize(canvas).catch(() => {});
        } catch (e) {
            // Warm-up is best effort only.
        }
    }

    function initTesseractWorker() {
        if (tesseractWorker) return Promise.resolve(tesseractWorker);
        if (workerPromise) return workerPromise;

        workerPromise = (async () => {
            if (!window.Tesseract) throw new Error('Tesseract library not loaded');
            const worker = await window.Tesseract.createWorker('eng', 1, {
                workerPath: new URL('assets/vendor/tesseract/worker.min.js', document.baseURI).href,
                corePath: new URL('assets/vendor/tesseract/', document.baseURI).href,
                langPath: new URL('assets/tessdata', document.baseURI).href,
                workerBlobURL: false,
                gzip: true,
            });
            await worker.setParameters({
                tessedit_char_whitelist: '0123456789.,',
                tessedit_pageseg_mode: '7',
                load_system_dawg: '0',
                load_freq_dawg: '0',
                user_defined_dpi: '300',
            });
            warmUpWorker(worker);
            tesseractWorker = worker;
            return worker;
        })().catch((err) => {
            workerPromise = null;
            throw err;
        });

        return workerPromise;
    }

    // ---------- Frame capture (maps the on-screen viewfinder to video pixels) ----------
    function getStripMapping() {
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;

        // The video may be CSS-scaled for digital zoom, so measure its stage
        // instead of the transformed video box.
        const stageRect = video.parentElement.getBoundingClientRect();
        const frameRect = viewfinder.getBoundingClientRect();
        if (!stageRect.width || !stageRect.height) return null;

        const digitalZoom = hardwareZoom ? 1 : zoomLevel;
        const scale = Math.max(stageRect.width / video.videoWidth, stageRect.height / video.videoHeight) * digitalZoom;
        const mediaW = video.videoWidth * scale;
        const mediaH = video.videoHeight * scale;
        const mediaLeft = stageRect.left + (stageRect.width - mediaW) / 2;
        const mediaTop = stageRect.top + (stageRect.height - mediaH) / 2;

        const padX = Math.max(4, frameRect.width * 0.03);
        const padY = Math.max(6, frameRect.height * 0.15);

        let sx = (frameRect.left - padX - mediaLeft) / scale;
        let sy = (frameRect.top - padY - mediaTop) / scale;
        let sw = (frameRect.width + padX * 2) / scale;
        let sh = (frameRect.height + padY * 2) / scale;

        sx = Math.max(0, sx);
        sy = Math.max(0, sy);
        sw = Math.min(sw, video.videoWidth - sx);
        sh = Math.min(sh, video.videoHeight - sy);
        if (sw < 8 || sh < 8) return null;

        return { sx, sy, sw, sh };
    }

    function enhanceCanvas(canvas, binarize = true) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const width = canvas.width;
        const height = canvas.height;
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        const total = width * height;
        const gray = new Uint8ClampedArray(total);
        const histogram = new Uint32Array(256);

        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
            gray[p] = g;
            histogram[g]++;
        }

        const low = ScannerOCR.percentileFromHistogram(histogram, total, 0.02);
        const high = ScannerOCR.percentileFromHistogram(histogram, total, 0.98);
        const span = Math.max(1, high - low);
        const stretched = new Uint32Array(256);
        for (let p = 0; p < total; p++) {
            const value = Math.max(0, Math.min(255, Math.round(((gray[p] - low) * 255) / span)));
            gray[p] = value;
            stretched[value]++;
        }

        const threshold = binarize ? ScannerOCR.otsuFromHistogram(stretched, total) : -1;
        for (let p = 0; p < total; p++) {
            const value = binarize ? (gray[p] < threshold ? 0 : 255) : gray[p];
            const i = p * 4;
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
            data[i + 3] = 255;
        }

        ctx.putImageData(imgData, 0, 0);
    }

    function captureViewfinderFrame(binarize = true) {
        const mapping = getStripMapping();
        if (!mapping) return null;

        const { sx, sy, sw, sh } = mapping;
        const stripW = Math.max(1, Math.round(sw));
        const stripH = Math.max(1, Math.round(sh));

        // Locate the printed line first, then crop tightly around it.
        const analysisScale = Math.min(1, 900 / stripW);
        const aw = Math.max(1, Math.round(stripW * analysisScale));
        const ah = Math.max(1, Math.round(stripH * analysisScale));

        analysisCanvas.width = aw;
        analysisCanvas.height = ah;
        analysisCtx.drawImage(video, sx, sy, sw, sh, 0, 0, aw, ah);

        const analysisData = analysisCtx.getImageData(0, 0, aw, ah).data;
        const totalPixels = aw * ah;
        const gray = new Uint8ClampedArray(totalPixels);

        for (let i = 0, p = 0; i < analysisData.length; i += 4, p++) {
            gray[p] = (analysisData[i] * 0.299 + analysisData[i + 1] * 0.587 + analysisData[i + 2] * 0.114) | 0;
        }

        const binary = ScannerOCR.adaptiveBinarize(gray, aw, ah);

        const region = ScannerOCR.findTextRegion(binary, aw, ah);

        let cropX = sx;
        let cropY = sy;
        let cropW = sw;
        let cropH = sh;
        let upscale = Math.min(2.5, Math.max(1.5, 900 / Math.max(1, sw)));

        if (region) {
            const inverseScale = 1 / analysisScale;
            const padXp = Math.max(8, Math.round(region.width * 0.14));
            const padYp = Math.max(8, Math.round(region.height * 0.5));
            const rx = Math.max(0, region.left - padXp);
            const ry = Math.max(0, region.top - padYp);
            const rw = Math.min(aw, region.left + region.width + padXp) - rx;
            const rh = Math.min(ah, region.top + region.height + padYp) - ry;

            cropX = sx + rx * inverseScale;
            cropY = sy + ry * inverseScale;
            cropW = rw * inverseScale;
            cropH = rh * inverseScale;

            const regionVideoHeight = region.height * inverseScale;
            upscale = Math.min(6, Math.max(2, 60 / Math.max(1, regionVideoHeight)));
        }

        cropX = Math.max(0, cropX);
        cropY = Math.max(0, cropY);
        cropW = Math.min(cropW, video.videoWidth - cropX);
        cropH = Math.min(cropH, video.videoHeight - cropY);
        if (cropW < 8 || cropH < 8) return null;

        // Keep the line near 1000px wide: enough detail for Tesseract without
        // wasting time on oversized images.
        upscale = Math.min(upscale, 1000 / Math.max(1, cropW));
        const outW = Math.max(1, Math.round(cropW * upscale));
        const outH = Math.max(1, Math.round(cropH * upscale));

        cropCanvas.width = outW;
        cropCanvas.height = outH;
        const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

        enhanceCanvas(cropCanvas, binarize);

        // Tesseract needs whitespace around the glyphs; a plain white frame
        // measurably improves recognition of short digit strings.
        const margin = Math.max(14, Math.round(outH * 0.25));
        const padded = document.createElement('canvas');
        padded.width = outW + margin * 2;
        padded.height = outH + margin * 2;
        const paddedCtx = padded.getContext('2d');
        paddedCtx.fillStyle = '#ffffff';
        paddedCtx.fillRect(0, 0, padded.width, padded.height);
        paddedCtx.drawImage(cropCanvas, margin, margin);

        return padded;
    }

    // ---------- OCR ----------
    function parseNumberFromOCR(text) {
        return window.ScannerOCR ? ScannerOCR.parseNumber(text) : null;
    }

    async function recognizeFrame(worker, image) {
        const result = await worker.recognize(image);
        const data = (result && result.data) || {};
        const candidate = parseNumberFromOCR(data.text || '');
        const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
        return { candidate, confidence };
    }

    async function performScan(isAuto = false) {
        if (isProcessing) return;

        if (!isCameraReady()) {
            if (!isAuto) {
                cameraPlaceholder.classList.remove('hidden');
                showNotification('تکایە سەرەتا کامێرا بکەرەوە', 'error');
            }
            return;
        }

        isProcessing = true;
        if (!isAuto) scanSpinner.classList.remove('hidden');

        try {
            const worker = await initTesseractWorker();
            const frames = isAuto
                ? [() => captureViewfinderFrame(true)]
                : [
                    () => captureViewfinderFrame(true),
                    () => captureViewfinderFrame(false),
                    () => captureViewfinderFrame(true),
                ];
            let best = null;

            for (let attempt = 0; attempt < frames.length; attempt++) {
                const image = frames[attempt]();
                if (!image) continue;

                const result = await recognizeFrame(worker, image);
                if (result.candidate !== null && (!best || result.confidence > best.confidence)) {
                    best = result;
                }
                if (best && best.confidence >= MANUAL_MIN_CONFIDENCE) break;
                if (attempt < frames.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, isAuto ? 60 : 120));
                }
            }

            if (best && best.candidate !== null) {
                if (isAuto) {
                    if (best.confidence < AUTO_MIN_CONFIDENCE) {
                        autoMisses++;
                        if (autoMisses >= 2) lastAutoAdd = { value: null };
                        return;
                    }
                    autoMisses = 0;
                    // Keep aiming at the same paper without adding duplicates.
                    if (lastAutoAdd.value === best.candidate) return;

                    lastAutoAdd = { value: best.candidate };
                    playBeep(true);
                    addNumberToList(best.candidate, 'کامێرا (خۆکار)');
                    showNotification(`ژمارەی ${formatNumber(best.candidate)} زیادکرا`, 'success');
                } else {
                    playBeep(true);
                    lastAutoAdd = { value: best.candidate };
                    autoMisses = 0;
                    addNumberToList(best.candidate, 'کامێرا');
                    if (best.confidence >= MANUAL_MIN_CONFIDENCE) {
                        showNotification(`ژمارەی ${formatNumber(best.candidate)} زیادکرا`, 'success');
                    } else {
                        showNotification(`ژمارەی ${formatNumber(best.candidate)} زیادکرا، بەڵام کەمێک ناڕوون بوو`, 'error');
                    }
                }
            } else if (isAuto) {
                autoMisses++;
                if (autoMisses >= 2) lastAutoAdd = { value: null };
            } else {
                playBeep(false);
                showNotification('ژمارەکە بە تەواوی لەناو چوارگۆشەکە دابنێ و دووبارە تاقی بکەرەوە', 'error');
            }
        } catch (err) {
            console.error('Scan Error:', err);
            tesseractWorker = null;
            workerPromise = null;
            if (!isAuto) showNotification('هەڵەیەک لە خوێندنەوە ڕوویدا', 'error');
        } finally {
            isProcessing = false;
            scanSpinner.classList.add('hidden');
        }
    }

    // ---------- List & calculations ----------
    function addNumberToList(num, source = 'دەستی') {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });

        items.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            value: num,
            time: timeStr,
            source,
            createdAt: Date.now(),
        });

        persist();
        renderList();
        updateCalculations();
    }

    function removeItem(id) {
        items = items.filter((item) => item.id !== id);
        persist();
        renderList();
        updateCalculations();
        showNotification('ژمارەکە سڕایەوە');
    }

    function formatNumber(num) {
        return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function updateCalculations() {
        const count = items.length;
        itemsCountBadge.textContent = `${count} دانە`;
        listBadge.textContent = count;
        countCardValue.textContent = count;
        lastDisplay.textContent = count ? formatNumber(items[0].value) : '0';

        if (count === 0) {
            totalSumDisplay.textContent = '0';
            avgDisplay.textContent = '0';
            maxDisplay.textContent = '0';
            return;
        }

        const total = items.reduce((acc, curr) => acc + curr.value, 0);
        const avg = total / count;
        const max = Math.max(...items.map((item) => item.value));

        totalSumDisplay.textContent = formatNumber(total);
        avgDisplay.textContent = formatNumber(Math.round(avg * 100) / 100);
        maxDisplay.textContent = formatNumber(max);
    }

    function getFilteredItems() {
        const query = searchQuery.trim();
        if (!query) return items;

        const digits = query.replace(/[,\s]/g, '');
        return items.filter((item) => {
            const formatted = formatNumber(item.value);
            return formatted.includes(query) || String(item.value).includes(digits);
        });
    }

    function emptyStateMarkup(filteredOut) {
        if (filteredOut) {
            return `
                <div class="py-10 px-5 text-center border-2 border-dashed border-[#dbe5e0] rounded-[24px]">
                    <div class="w-14 h-14 mx-auto rounded-2xl bg-[#f2f5f4] text-[#a9b8b0] flex items-center justify-center text-2xl mb-3">
                        <i class="fa-solid fa-magnifying-glass"></i>
                    </div>
                    <p class="text-sm font-bold text-slate-700">هیچ ئەنجامێک نەدۆزرایەوە</p>
                    <p class="text-[11px] text-slate-500 mt-1">ژمارەیەکی تر تاقی بکەرەوە</p>
                </div>
            `;
        }

        return `
            <div class="py-10 px-5 text-center border-2 border-dashed border-[#dbe5e0] rounded-[24px]">
                <div class="w-14 h-14 mx-auto rounded-2xl bg-[#f2f5f4] text-[#a9b8b0] flex items-center justify-center text-2xl mb-3">
                    <i class="fa-regular fa-folder-open"></i>
                </div>
                <p class="text-sm font-bold text-slate-700">هیچ ژمارەیەک تۆمار نەکراوە</p>
                <p class="text-[11px] text-slate-500 mt-1 mb-4">بۆ دەستپێکردن کامێراکە بکەرەوە یان بە دەست زیاد بکە</p>
                <button data-empty-add class="px-5 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-xs font-bold active:scale-95 transition">
                    زیادکردنی ژمارەی نوێ
                </button>
            </div>
        `;
    }

    function renderList() {
        const visible = getFilteredItems();
        searchCount.textContent = `${visible.length} ئەنجام`;
        searchCount.classList.toggle('hidden', !searchQuery.trim());

        if (visible.length === 0) {
            numbersListContainer.innerHTML = emptyStateMarkup(items.length > 0);
            return;
        }

        numbersListContainer.innerHTML = visible
            .map((item, index) => {
                const displayIndex = visible.length - index;
                return `
                <div class="bg-white rounded-2xl border border-[#eef1ef] px-3.5 py-3 flex items-center justify-between gap-3 shadow-[0_2px_10px_rgba(18,45,35,0.04)]">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="w-8 h-8 shrink-0 rounded-xl bg-emerald-50 text-emerald-600 font-bold text-[11px] flex items-center justify-center font-mono">
                            ${displayIndex}
                        </span>
                        <div class="min-w-0">
                            <div class="text-[17px] font-extrabold text-slate-900 font-mono tracking-wide tabular truncate" dir="ltr">
                                ${formatNumber(item.value)}
                            </div>
                            <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
                                <span><i class="fa-regular fa-clock ml-1"></i>${item.time}</span>
                                <span class="w-1 h-1 rounded-full bg-slate-300"></span>
                                <span class="text-emerald-600/90 font-medium">${item.source}</span>
                            </div>
                        </div>
                    </div>
                    <button data-remove="${item.id}" class="w-8 h-8 shrink-0 rounded-xl bg-[#f6f8f7] hover:bg-rose-50 hover:text-rose-500 text-slate-400 flex items-center justify-center text-xs transition" aria-label="سڕینەوە">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </div>
                `;
            })
            .join('');
    }

    // ---------- Copy & share ----------
    function buildListText() {
        const total = items.reduce((acc, curr) => acc + curr.value, 0);
        let text = '📋 لیستی ژمارەکان:\n';
        text += '-------------------------\n';
        items
            .slice()
            .reverse()
            .forEach((item, i) => {
                text += `${i + 1}. ${formatNumber(item.value)}\n`;
            });
        text += '-------------------------\n';
        text += `کۆی گشتی: ${formatNumber(total)}\n`;
        text += `ژمارەی بڕگەکان: ${items.length}\n`;
        text += 'دیزاینکراوە لەلایەن: MUJAHED GALALY';
        return text;
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {
            // fall through to legacy path
        }
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch (e) {
            return false;
        }
    }

    async function copyListToClipboard() {
        if (items.length === 0) {
            showNotification('هیچ ژمارەیەک نییە بۆ کۆپیکردن!', 'error');
            return;
        }
        const ok = await copyText(buildListText());
        if (ok) {
            playBeep(true);
            showNotification('تەواوی لیست و کۆی گشتی کۆپی کرا', 'success');
        } else {
            showNotification('کۆپیکردن سەرکەوتوو نەبوو', 'error');
        }
    }

    async function shareOrExport() {
        if (items.length === 0) {
            showNotification('هیچ زانیارییەک نییە بۆ هاوبەشکردن', 'error');
            return;
        }

        const total = items.reduce((acc, curr) => acc + curr.value, 0);
        const shareData = {
            title: 'کۆی گشتی ژمارەکان',
            text: `کۆی گشتی: ${formatNumber(total)} (${items.length} ژمارە)`,
        };

        if (navigator.share) {
            try {
                await navigator.share(shareData);
                return;
            } catch (err) {
                if (err && err.name === 'AbortError') return;
            }
        }
        copyListToClipboard();
    }

    // ---------- Auto scan ----------
    function setAutoScanUi(active) {
        if (active) {
            autoScanDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
            autoScanText.textContent = 'خۆکار: بەڵێ';
            autoScanToggle.classList.add('auto-chip-on');
        } else {
            autoScanDot.className = 'w-2 h-2 rounded-full bg-slate-400';
            autoScanText.textContent = 'خۆکار: نا';
            autoScanToggle.classList.remove('auto-chip-on');
        }
    }

    function setAutoScan(active, announce = true) {
        isAutoScanActive = active;
        autoScanPref = active;
        saveAutoPref(active);
        setAutoScanUi(active);

        clearInterval(autoScanTimer);
        autoScanTimer = null;

        if (active) {
            if (announce) showNotification('خوێندنەوەی خۆکار چالاک کرا', 'success');
            ensureCameraRunning();
            autoScanTimer = setInterval(() => {
                if (!isProcessing && isAutoScanActive) performScan(true);
            }, AUTO_SCAN_INTERVAL_MS);
        } else {
            lastAutoAdd = { value: null };
            if (announce) showNotification('خوێندنەوەی خۆکار ناچالاک کرا');
        }
    }

    function toggleAutoScan() {
        setAutoScan(!isAutoScanActive, true);
    }

    // ---------- Reset ----------
    function resetAll() {
        if (items.length === 0) return;
        const confirmed = window.confirm('دڵنیایی لە سڕینەوەی هەموو ژمارەکان؟');
        if (!confirmed) return;

        items = [];
        lastAutoAdd = { value: null };
        searchQuery = '';
        searchInput.value = '';
        persist();
        renderList();
        updateCalculations();
        showNotification('هەموو ژمارەکان پاککرانەوە');
    }

    // ---------- Install hint (iOS Safari) ----------
    function setupInstallHint() {
        const standalone =
            window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true;
        const isIOS =
            /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        let dismissed = false;
        try {
            dismissed = localStorage.getItem(HINT_KEY) === '1';
        } catch (e) {
            dismissed = false;
        }

        if (!standalone && isIOS && !dismissed) {
            installHint.classList.remove('hidden');
        }

        dismissInstallHint.addEventListener('click', () => {
            installHint.classList.add('hidden');
            try {
                localStorage.setItem(HINT_KEY, '1');
            } catch (e) {
                // ignore
            }
        });
    }

    // ---------- Manual add sheet ----------
    function openManualSheet() {
        manualSheet.classList.remove('hidden');
        window.setTimeout(() => manualNumberInput.focus(), 120);
    }

    function closeManualSheet() {
        manualSheet.classList.add('hidden');
        manualNumberInput.blur();
    }

    // ---------- Events ----------
    startCameraBtn.addEventListener('click', () => {
        cameraBlocked = false;
        startCamera(true);
    });
    captureScanBtn.addEventListener('click', () => performScan(false));
    autoScanToggle.addEventListener('click', toggleAutoScan);
    zoomButtons.forEach((btn) => {
        btn.addEventListener('click', () => setZoom(Number(btn.dataset.zoom)));
    });

    manualAddBtn.addEventListener('click', () => {
        const val = parseFloat(manualNumberInput.value);
        if (!Number.isFinite(val) || val <= 0) {
            showNotification('تکایە ژمارەیەکی دروست بنووسە', 'error');
            return;
        }
        addNumberToList(val, 'دەستی');
        manualNumberInput.value = '';
        closeManualSheet();
        showNotification(`ژمارەی ${formatNumber(val)} زیادکرا`, 'success');
    });

    manualNumberInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') manualAddBtn.click();
    });

    manualFab.addEventListener('click', openManualSheet);
    manualCloseBtn.addEventListener('click', closeManualSheet);
    sheetBackdrop.addEventListener('click', closeManualSheet);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !manualSheet.classList.contains('hidden')) closeManualSheet();
    });

    numbersListContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove]');
        if (removeBtn) {
            removeItem(removeBtn.getAttribute('data-remove'));
            return;
        }
        if (e.target.closest('[data-empty-add]')) openManualSheet();
    });

    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderList();
    });

    clearAllBtn.addEventListener('click', resetAll);
    copyListBtn.addEventListener('click', copyListToClipboard);
    exportTextBtn.addEventListener('click', shareOrExport);
    headerShareBtn.addEventListener('click', shareOrExport);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) ensureCameraRunning();
    });

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) ensureCameraRunning();
    });

    // ---------- Boot ----------
    renderList();
    updateCalculations();
    setupInstallHint();

    if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    window.setTimeout(() => {
        if (autoScanPref) {
            setAutoScan(true, false);
        } else {
            startCamera(false);
        }
    }, 350);
})();
