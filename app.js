(() => {
    'use strict';

    const STORAGE_KEY = 'mujahid-scanner-items-v1';
    const HINT_KEY = 'mujahid-scanner-install-hint';
    const AUTO_SCAN_INTERVAL_MS = 2200;
    const AUTO_DUP_WINDOW_MS = 8000;

    // ---------- State ----------
    let items = loadItems();
    let videoStream = null;
    let isProcessing = false;
    let autoScanTimer = null;
    let isAutoScanActive = false;
    let tesseractWorker = null;
    let workerPromise = null;
    let audioCtx = null;
    let lastAutoAdd = { value: null, at: 0 };
    let toastTimer = null;
    let cameraBlocked = false;

    // ---------- Elements ----------
    const $ = (id) => document.getElementById(id);
    const video = $('cameraVideo');
    const viewfinder = $('viewfinder');
    const cropCanvas = $('cropCanvas');
    const startCameraBtn = $('startCameraBtn');
    const cameraPlaceholder = $('cameraPlaceholder');
    const captureScanBtn = $('captureScanBtn');
    const footerScanBtn = $('footerScanBtn');
    const scanSpinner = $('scanSpinner');
    const candidateCard = $('candidateCard');
    const candidateInput = $('candidateInput');
    const confirmCandidateBtn = $('confirmCandidateBtn');
    const closeCandidateBtn = $('closeCandidateBtn');
    const manualNumberInput = $('manualNumberInput');
    const manualAddBtn = $('manualAddBtn');
    const numbersListContainer = $('numbersListContainer');
    const totalSumDisplay = $('totalSumDisplay');
    const itemsCountBadge = $('itemsCountBadge');
    const listBadge = $('listBadge');
    const avgDisplay = $('avgDisplay');
    const maxDisplay = $('maxDisplay');
    const clearAllBtn = $('clearAllBtn');
    const footerResetBtn = $('footerResetBtn');
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
            toastIcon.className = 'fa-solid fa-circle-check text-emerald-400';
        } else if (type === 'error') {
            toastIcon.className = 'fa-solid fa-circle-exclamation text-rose-400';
        } else {
            toastIcon.className = 'fa-solid fa-circle-info text-indigo-400';
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

        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            });
            video.srcObject = videoStream;
            await video.play().catch(() => {});
            cameraBlocked = false;
            cameraPlaceholder.classList.add('hidden');
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

    // ---------- OCR worker ----------
    function initTesseractWorker() {
        if (tesseractWorker) return Promise.resolve(tesseractWorker);
        if (workerPromise) return workerPromise;

        workerPromise = (async () => {
            if (!window.Tesseract) throw new Error('Tesseract library not loaded');
            const worker = await window.Tesseract.createWorker('eng');
            await worker.setParameters({
                tessedit_char_whitelist: '0123456789.,',
                tessedit_pageseg_mode: '7',
            });
            tesseractWorker = worker;
            return worker;
        })().catch((err) => {
            workerPromise = null;
            throw err;
        });

        return workerPromise;
    }

    // ---------- Frame capture (maps the on-screen viewfinder to video pixels) ----------
    function captureViewfinderFrame() {
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;

        const videoRect = video.getBoundingClientRect();
        const frameRect = viewfinder.getBoundingClientRect();
        if (!videoRect.width || !videoRect.height) return null;

        const scale = Math.max(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
        const mediaW = video.videoWidth * scale;
        const mediaH = video.videoHeight * scale;
        const mediaLeft = videoRect.left + (videoRect.width - mediaW) / 2;
        const mediaTop = videoRect.top + (videoRect.height - mediaH) / 2;

        const padX = frameRect.width * 0.06;
        const padY = frameRect.height * 0.5;

        let sx = (frameRect.left - padX - mediaLeft) / scale;
        let sy = (frameRect.top - padY - mediaTop) / scale;
        let sw = (frameRect.width + padX * 2) / scale;
        let sh = (frameRect.height + padY * 2) / scale;

        sx = Math.max(0, sx);
        sy = Math.max(0, sy);
        sw = Math.min(sw, video.videoWidth - sx);
        sh = Math.min(sh, video.videoHeight - sy);
        if (sw < 8 || sh < 8) return null;

        const outW = Math.round(sw);
        const outH = Math.round(sh);
        cropCanvas.width = outW;
        cropCanvas.height = outH;
        const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);

        const imgData = ctx.getImageData(0, 0, outW, outH);
        const data = imgData.data;
        const total = outW * outH;
        const gray = new Uint8ClampedArray(total);
        const histogram = new Uint32Array(256);

        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
            gray[p] = g;
            histogram[g]++;
        }

        // Otsu threshold: works in low light and on faint prints.
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * histogram[t];
        let sumB = 0;
        let weightB = 0;
        let maxVariance = 0;
        let threshold = 135;
        for (let t = 0; t < 256; t++) {
            weightB += histogram[t];
            if (weightB === 0) continue;
            const weightF = total - weightB;
            if (weightF === 0) break;
            sumB += t * histogram[t];
            const meanB = sumB / weightB;
            const meanF = (sum - sumB) / weightF;
            const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = t;
            }
        }
        threshold = Math.min(200, Math.max(70, threshold));

        for (let p = 0; p < total; p++) {
            const value = gray[p] < threshold ? 0 : 255;
            const i = p * 4;
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
            data[i + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);

        return cropCanvas.toDataURL('image/png');
    }

    // ---------- OCR ----------
    function parseNumberFromOCR(text) {
        if (!text) return null;
        const westernText = text
            .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
            .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

        const matches = westernText.match(/\d[\d,.]*\d|\d/g) || [];
        let best = null;

        for (const raw of matches) {
            const cleaned = raw.replace(/,/g, '');
            if (!/^\d+(\.\d+)?$/.test(cleaned)) continue;
            const num = parseFloat(cleaned);
            if (!Number.isFinite(num) || num <= 0) continue;
            if (!best || cleaned.length > best.length) {
                best = { num, length: cleaned.length };
            }
        }

        return best ? best.num : null;
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

        const imageDataUrl = captureViewfinderFrame();
        if (!imageDataUrl) {
            if (!isAuto) showNotification('وێنە وەرنەگیرا، دووبارە هەوڵ بدە', 'error');
            return;
        }

        isProcessing = true;
        if (!isAuto) scanSpinner.classList.remove('hidden');

        try {
            const worker = await initTesseractWorker();
            const result = await worker.recognize(imageDataUrl);
            const text = (result && result.data && result.data.text) || '';
            const candidate = parseNumberFromOCR(text);

            if (candidate !== null) {
                if (isAuto) {
                    const now = Date.now();
                    if (lastAutoAdd.value === candidate && now - lastAutoAdd.at < AUTO_DUP_WINDOW_MS) {
                        return;
                    }
                    lastAutoAdd = { value: candidate, at: now };
                    playBeep(true);
                    addNumberToList(candidate, 'کامێرا (خۆکار)');
                    showNotification(`ژمارەی ${formatNumber(candidate)} زیادکرا`, 'success');
                } else {
                    playBeep(true);
                    candidateInput.value = String(candidate);
                    candidateCard.classList.remove('hidden');
                    candidateCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            } else if (!isAuto) {
                playBeep(false);
                showNotification('ژمارە بە ڕوونی نەدۆزرایەوە، کامێراکە نزیکتر بکەوە', 'error');
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

    function renderList() {
        if (items.length === 0) {
            numbersListContainer.innerHTML = `
                <div class="py-10 text-center border-2 border-dashed border-slate-800 rounded-2xl">
                    <div class="w-12 h-12 mx-auto rounded-full bg-slate-800/70 text-slate-500 flex items-center justify-center text-xl mb-2">
                        <i class="fa-solid fa-calculator"></i>
                    </div>
                    <p class="text-xs font-semibold text-slate-400">هیچ ژمارەیەک هێشتا زیاد نەکراوە</p>
                    <p class="text-[11px] text-slate-500 mt-0.5">بە کامێرا سکان بکە یان بەدەست زیادی بکە</p>
                </div>
            `;
            return;
        }

        numbersListContainer.innerHTML = items
            .map((item, index) => {
                const displayIndex = items.length - index;
                return `
                <div class="bg-slate-850/80 hover:bg-slate-800 border border-slate-800 rounded-xl p-3 flex items-center justify-between transition">
                    <div class="flex items-center gap-3">
                        <span class="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 font-bold text-xs flex items-center justify-center font-mono">
                            ${displayIndex}
                        </span>
                        <div>
                            <div class="text-base font-extrabold text-white font-mono tracking-wide tabular" dir="ltr">
                                ${formatNumber(item.value)}
                            </div>
                            <div class="text-[10px] text-slate-400 flex items-center gap-2">
                                <span><i class="fa-regular fa-clock ml-1"></i>${item.time}</span>
                                <span>•</span>
                                <span class="text-indigo-400/90">${item.source}</span>
                            </div>
                        </div>
                    </div>
                    <button data-remove="${item.id}" class="w-8 h-8 rounded-lg bg-slate-800/80 hover:bg-rose-950/50 hover:text-rose-400 text-slate-500 flex items-center justify-center text-xs transition" aria-label="سڕینەوە">
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
            autoScanDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping';
            autoScanText.textContent = 'خۆکار: بەڵێ';
            autoScanToggle.classList.add('border-emerald-500/50', 'text-emerald-300');
        } else {
            autoScanDot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
            autoScanText.textContent = 'خۆکار: نا';
            autoScanToggle.classList.remove('border-emerald-500/50', 'text-emerald-300');
        }
    }

    function toggleAutoScan() {
        isAutoScanActive = !isAutoScanActive;

        if (isAutoScanActive) {
            setAutoScanUi(true);
            showNotification('دۆخی خۆکار چالاک کرا', 'success');
            ensureCameraRunning();
            autoScanTimer = setInterval(() => {
                if (!isProcessing && isAutoScanActive) performScan(true);
            }, AUTO_SCAN_INTERVAL_MS);
        } else {
            clearInterval(autoScanTimer);
            autoScanTimer = null;
            lastAutoAdd = { value: null, at: 0 };
            setAutoScanUi(false);
            showNotification('دۆخی خۆکار ناچالاک کرا');
        }
    }

    // ---------- Reset ----------
    function resetAll() {
        if (items.length === 0) return;
        const confirmed = window.confirm('دڵنیایی لە سڕینەوەی هەموو ژمارەکان؟');
        if (!confirmed) return;

        items = [];
        persist();
        renderList();
        updateCalculations();
        candidateCard.classList.add('hidden');
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

    // ---------- Events ----------
    startCameraBtn.addEventListener('click', () => {
        cameraBlocked = false;
        startCamera(true);
    });
    captureScanBtn.addEventListener('click', () => performScan(false));
    footerScanBtn.addEventListener('click', () => performScan(false));
    autoScanToggle.addEventListener('click', toggleAutoScan);

    confirmCandidateBtn.addEventListener('click', () => {
        const val = parseFloat(candidateInput.value);
        if (!Number.isFinite(val) || val <= 0) {
            showNotification('تکایە ژمارەیەکی دروست بنووسە', 'error');
            return;
        }
        addNumberToList(val, 'کامێرا');
        candidateCard.classList.add('hidden');
        candidateInput.value = '';
        showNotification(`ژمارەی ${formatNumber(val)} زیادکرا`, 'success');
    });

    closeCandidateBtn.addEventListener('click', () => {
        candidateCard.classList.add('hidden');
    });

    manualAddBtn.addEventListener('click', () => {
        const val = parseFloat(manualNumberInput.value);
        if (!Number.isFinite(val) || val <= 0) {
            showNotification('تکایە ژمارەیەکی دروست بنووسە', 'error');
            return;
        }
        addNumberToList(val, 'دەستی');
        manualNumberInput.value = '';
        showNotification(`ژمارەی ${formatNumber(val)} زیادکرا`, 'success');
    });

    manualNumberInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') manualAddBtn.click();
    });

    numbersListContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (btn) removeItem(btn.getAttribute('data-remove'));
    });

    clearAllBtn.addEventListener('click', resetAll);
    footerResetBtn.addEventListener('click', resetAll);
    copyListBtn.addEventListener('click', copyListToClipboard);
    exportTextBtn.addEventListener('click', shareOrExport);

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

    window.setTimeout(() => startCamera(false), 350);
})();
