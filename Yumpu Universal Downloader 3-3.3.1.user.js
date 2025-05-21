// ==UserScript==
// @name         Yumpu Universal Downloader 3
// @namespace    http://tampermonkey.net/
// @version      3.3.1
// @description  Downloads Yumpu docs. PDF/Searchable PDF (OCR), pipelined processing, client-side OCR image preprocessing, and separate TXT OCR output.
// @author       Your Name (Enhanced by AI)
// @match        *://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yumpu.com
// @require      https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @require      https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_log
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @grant        unsafeWindow
// @connect      yumpu.com
// @connect      img.yumpu.com
// @connect      api.ocr.space
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @connect      rawcdn.githack.com
// @run-at       document-idle
// ==/UserScript==

(async function() {
    'use strict';

    // --- Script Info (Dynamic) ---
    const GM_SCRIPT_NAME = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.name : 'Yumpu Universal Downloader';
    const GM_SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : 'N/A';
    const SCRIPT_DISPLAY_NAME = `${GM_SCRIPT_NAME} v${GM_SCRIPT_VERSION}`;
    const LOG_PREFIX = `[${GM_SCRIPT_NAME} v${GM_SCRIPT_VERSION}] `;

    // --- Constants & User-Configurable Settings (with GM_getValue for defaults) ---
    const DEBUG_MODE_GM_VAR = 'YUD_DEBUG_MODE';
    const DEBUG_PAGE_LIMIT_GM_VAR = 'YUD_DEBUG_PAGE_LIMIT';
    const MAX_CONCURRENT_FETCHES_GM_VAR = 'YUD_MAX_CONCURRENT_FETCHES';
    const MAX_CONCURRENT_OCR_GM_VAR = 'YUD_MAX_CONCURRENT_OCR';

    const OCR_PREPROCESS_ENABLED_GM_VAR = 'YUD_OCR_PREPROCESS_ENABLED';
    const OCR_PREPROCESS_QUALITY_GM_VAR = 'YUD_OCR_PREPROCESS_QUALITY';
    const OCR_PREPROCESS_MAX_DIM_GM_VAR = 'YUD_OCR_PREPROCESS_MAX_DIM';
    const OCR_API_SCALE_ENABLED_GM_VAR = 'YUD_OCR_API_SCALE_ENABLED';
    const OCR_SPACE_API_KEY_GM_VAR = 'K88821594088957';

    const DEFAULT_DEBUG_MODE = false;
    const DEFAULT_DEBUG_PAGE_LIMIT = 2;
    const DEFAULT_MAX_CONCURRENT_FETCHES = 4;
    const DEFAULT_MAX_CONCURRENT_OCR = 2;
    const DEFAULT_OCR_LANGUAGE = 'eng';
    const DEFAULT_OCR_PREPROCESS_ENABLED = true;
    const DEFAULT_OCR_PREPROCESS_QUALITY = 0.82;
    const DEFAULT_OCR_PREPROCESS_MAX_DIM = 1800;
    const DEFAULT_OCR_API_SCALE_ENABLED = false;

    const IMAGE_QUALITY_PARAMETER = 100;
    const PREFERRED_RESOLUTION_STUB = "1024x1458";

    const FONT_URLS_TO_TRY = [
        'https://rawcdn.githack.com/google/fonts/main/apache/robotoslab/RobotoSlab%5Bwght%5D.ttf',
        'https://rawcdn.githack.com/senotrusov/dejavu-fonts-ttf/master/ttf/DejaVuSans.ttf'
    ];
    const CACHED_FONT_GM_VAR = `yumpuDownloaderCachedFont_v${GM_SCRIPT_VERSION.replace(/\./g, '_')}_RobotoSlab`;
    let embeddedFontBytes = null;

    const FETCH_TIMEOUT_MS = 90000;
    const OCR_OPERATION_TIMEOUT_MS = 120000;

    function shouldScriptRun() {
        const isYumpuDomain = /yumpu\.com/.test(window.location.hostname);
        if (isYumpuDomain) { return (window.location.href.includes('/embed/view/') || window.location.href.includes('/document/view/')); }
        if (window.self !== window.top) { try { const scripts = Array.from(document.getElementsByTagName('script')); return scripts.some(s => s.textContent && s.textContent.includes('playerConfig') && s.textContent.includes('jsonUrl')); } catch (e) { /* ignore */ } }
        return false;
    }
    if (!shouldScriptRun()) { return; }

    const LOG_JSON_STRINGIFY_LIMIT = 1500;
    const LOG_STACK_TRACE_LIMIT = 2000;
    function log(...args) { console.log(LOG_PREFIX, ...args); GM_log(LOG_PREFIX + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 1).substring(0, LOG_JSON_STRINGIFY_LIMIT) : arg ).join(' ')); }
    function errorLog(contextOrError, ...additionalArgs) { let messageParts = []; let stackTrace = ''; if (contextOrError instanceof Error) { messageParts.push(`Error: ${contextOrError.message}`); if (additionalArgs.length > 0) { messageParts.unshift(additionalArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 1).substring(0, LOG_JSON_STRINGIFY_LIMIT) : arg).join(' ')); } stackTrace = `\nStack: ${(contextOrError.stack || '(no stack trace)').substring(0, LOG_STACK_TRACE_LIMIT)}`; console.error(LOG_PREFIX, ...messageParts, contextOrError); } else { messageParts.push(contextOrError); messageParts.push(...additionalArgs); const lastArg = additionalArgs[additionalArgs.length - 1]; if (lastArg instanceof Error) { stackTrace = `\nStack: ${(lastArg.stack || '(no stack trace)').substring(0, LOG_STACK_TRACE_LIMIT)}`; } console.error(LOG_PREFIX, contextOrError, ...additionalArgs); } const gmLogMessage = LOG_PREFIX + 'ERROR: ' + messageParts.map(part => typeof part === 'object' && !(part instanceof Error) ? JSON.stringify(part, null, 1).substring(0, LOG_JSON_STRINGIFY_LIMIT) : (part instanceof Error ? `Error: ${part.message}` : part) ).join(' ') + stackTrace; GM_log(gmLogMessage); }
    async function withTimeout(promise, ms, operationLabel = "Operation") { let timeoutId; const timeoutPromise = new Promise((_, reject) => { timeoutId = setTimeout(() => { reject(new Error(`'${operationLabel}' timed out after ${ms / 1000}s`)); }, ms); }); try { return await Promise.race([promise, timeoutPromise]); } finally { clearTimeout(timeoutId); } }

    log(`Script starting. Version: ${GM_SCRIPT_VERSION}`);
    if (typeof window.PDFLib === 'undefined' || typeof window.fontkit === 'undefined') { const missing = [ ...(typeof window.PDFLib === 'undefined' ? ['PDFLib'] : []), ...(typeof window.fontkit === 'undefined' ? ['fontkit (for OCR text)'] : []) ].join(', '); errorLog(new Error(`Critical libraries not available: ${missing}.`)); alert(`${SCRIPT_DISPLAY_NAME}: Critical libraries (${missing}) failed to load. Check Tampermonkey console.`); return; }
    log('PDFLib and fontkit loaded.');
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;

    function arrayBufferToBase64(buffer) { let binary = ''; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); } return window.btoa(binary); }
    function base64ToArrayBuffer(base64) { try { const base64Data = base64.startsWith('data:') ? base64.substring(base64.indexOf(',') + 1) : base64; const binaryString = window.atob(base64Data); const len = binaryString.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); } return bytes.buffer; } catch (e) { errorLog(new Error("Error decoding base64 font: " + e.message)); GM_setValue(CACHED_FONT_GM_VAR, null); return null; } }
    async function prepareFont() { if (embeddedFontBytes) return true; const cachedFontBase64 = GM_getValue(CACHED_FONT_GM_VAR, null); if (cachedFontBase64) { log('Found cached font. Decoding...'); embeddedFontBytes = base64ToArrayBuffer(cachedFontBase64); if (embeddedFontBytes) { log('Font loaded from cache, size:', embeddedFontBytes.byteLength); return true; } else { errorLog(new Error('Failed to decode cached font. Fetching.')); } } for (const fontUrl of FONT_URLS_TO_TRY) { log('Fetching font from:', fontUrl); try { const fetchedBytes = await GM_fetch(fontUrl, 'arraybuffer', 'GET', null, {}, true); if (fetchedBytes && fetchedBytes.byteLength > 10000) { embeddedFontBytes = fetchedBytes; log('Font fetched, size:', embeddedFontBytes.byteLength); GM_setValue(CACHED_FONT_GM_VAR, arrayBufferToBase64(embeddedFontBytes)); log('Font cached.'); return true; } else { log('Fetched font invalid/small from:', fontUrl); } } catch (e) { errorLog(`Failed to fetch font from ${fontUrl}`, e); } } errorLog(new Error('All font fetch methods failed.')); if(statusElement) statusElement.textContent = 'Error: Font load failed for OCR.'; return false; }
    function GM_fetch(url, responseType = 'arraybuffer', method = 'GET', data = null, headers = {}, expectSuccess = true, isFormData = false) { let effectiveHeaders = { 'User-Agent': navigator.userAgent, ...headers }; if (!isFormData && method === 'POST' && data && typeof data === 'object' && !(data instanceof FormData)) { if (!effectiveHeaders['Content-Type']) { effectiveHeaders['Content-Type'] = 'application/json;charset=UTF-8'; data = JSON.stringify(data); } } if (!effectiveHeaders['Accept']) { if (responseType === 'arraybuffer') effectiveHeaders['Accept'] = 'application/octet-stream, */*;q=0.8'; else if (responseType === 'text' && (url.includes('.json') || (typeof data === 'string' && data.startsWith('{')))) effectiveHeaders['Accept'] = 'application/json, text/plain, */*;q=0.8'; else effectiveHeaders['Accept'] = '*/*'; } return new Promise((resolve, reject) => { GM_xmlhttpRequest({ method, url, data, headers: effectiveHeaders, responseType, timeout: FETCH_TIMEOUT_MS, onload: (response) => { if (response.status >= 200 && response.status < 400) { resolve(responseType === 'text' ? response.responseText : response.response); } else { const errorMsg = `GM_fetch HTTP Error: ${response.status} ${response.statusText || ''} for ${url}. Response: ${response.responseText ? response.responseText.substring(0,250) : '(empty)'}`; if (expectSuccess) errorLog(new Error(errorMsg), "Details:", response); reject(new Error(errorMsg)); } }, onerror: (response) => { const errorDetail = response.error || response.statusText || 'Unknown network error'; const errorMsg = `GM_fetch Network Error for ${url}: ${errorDetail}`; if (expectSuccess) errorLog(new Error(errorMsg), "Details:", response); reject(new Error(errorMsg)); }, ontimeout: () => { const errorMsg = `GM_fetch Timeout for ${url} after ${FETCH_TIMEOUT_MS / 1000}s`; if (expectSuccess) errorLog(new Error(errorMsg)); reject(new Error(errorMsg)); }, onabort: () => { const errorMsg = `GM_fetch Abort for ${url}`; if (expectSuccess) errorLog(new Error(errorMsg)); reject(new Error(errorMsg)); } }); }); }
    function getPlayerConfig() { try { if (unsafeWindow?.playerConfig?.jsonUrl) { log("Found playerConfig in unsafeWindow"); return unsafeWindow.playerConfig; } const scripts = Array.from(document.getElementsByTagName('script')); for (const script of scripts) { if (script.textContent?.includes('playerConfig') && script.textContent?.includes('"jsonUrl":')) { const match = script.textContent.match(/(?:const|var|let)?\s*playerConfig\s*=\s*(\{[\s\S]*?\})\s*;/i); if (match?.[1]) { try { const config = (new Function(`return ${match[1]}`))(); if (config?.jsonUrl) { log("Found playerConfig in script tag"); return config; } } catch (e) { errorLog('Error parsing playerConfig from script:', e, match[1].substring(0,200)); } } } } } catch (e) { errorLog('getPlayerConfig error:', e); } log("playerConfig not found."); return null; }
    function sanitizeFilename(name) { return String(name).replace(/[^a-z0-9_.\- ()[\]{}]/gi, '_').replace(/_+/g, '_').substring(0, 150); }

    let downloadPdfButton, setApiKeyButton, statusElement;

    function updateButtonLabelsAndStatus(isDownloading = false) {
        const apiKeyPresent = !!GM_getValue(OCR_SPACE_API_KEY_GM_VAR, "");
        let buttonText;

        if (isDownloading) {
            buttonText = "Processing...";
        } else if (apiKeyPresent) {
            buttonText = 'Download PDF (Searchable)';
        } else {
            buttonText = 'Download PDF (Images Only)';
        }

        if (downloadPdfButton) {
            downloadPdfButton.textContent = buttonText;
            downloadPdfButton.disabled = isDownloading;
        }
        if (setApiKeyButton) {
            setApiKeyButton.disabled = isDownloading;
        }
    }

    function addUI() {
        if (document.getElementById('yumpuDownloaderControlsContainer')) return true;
        if (!document.body) { errorLog(new Error('addUI: No document.body.')); return false; }

        const controlsContainer = document.createElement('div');
        controlsContainer.id = 'yumpuDownloaderControlsContainer';

        downloadPdfButton = document.createElement('button');
        downloadPdfButton.id = 'yumpuDownloaderPdfBtn';
        downloadPdfButton.onclick = handleDownload;
        controlsContainer.appendChild(downloadPdfButton);

        setApiKeyButton = document.createElement('button');
        setApiKeyButton.textContent = 'Set OCR.space API Key';
        setApiKeyButton.id = 'yumpuSetApiKeyBtn';
        setApiKeyButton.onclick = promptForApiKey;
        controlsContainer.appendChild(setApiKeyButton);

        const apiKeyLink = document.createElement('a');
        apiKeyLink.href = 'https://ocr.space/ocrapi/freekey';
        apiKeyLink.textContent = 'Get key?';
        apiKeyLink.target = '_blank';
        apiKeyLink.className = 'yud-apikey-link';
        controlsContainer.appendChild(apiKeyLink);

        statusElement = document.createElement('div');
        statusElement.id = 'yumpuDownloaderStatus';
        statusElement.textContent = 'Idle.';
        controlsContainer.appendChild(statusElement);

        updateButtonLabelsAndStatus(false);

        document.body.appendChild(controlsContainer);
        log('addUI: UI elements added.');
        GM_addStyle(`
            #yumpuDownloaderControlsContainer { position: fixed; top: 10px; right: 10px; z-index: 2147483647; background-color: #f8f9fa; padding: 12px; border: 1px solid #ced4da; border-radius: 6px; box-shadow: 0 4px 8px rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 8px; color: #212529; font-family: Arial, sans-serif; font-size: 13px; max-width: 250px; }
            #yumpuDownloaderControlsContainer button { background-color: #007bff; color: white; padding: 8px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; text-align: center; transition: background-color 0.2s ease-in-out; }
            #yumpuDownloaderControlsContainer button:hover { background-color: #0056b3; }
            #yumpuDownloaderControlsContainer button:disabled { background-color: #adb5bd; cursor: not-allowed; }
            #yumpuSetApiKeyBtn { background-color: #17a2b8 !important; }
            #yumpuSetApiKeyBtn:hover { background-color: #117a8b !important; }
            .yud-apikey-link { font-size: 11px; text-align: center; color: #0056b3; margin-top: -4px; text-decoration: underline; }
            #yumpuDownloaderStatus { margin-top: 5px; font-size: 11px; color: #495057; word-break: break-word; text-align: center; }
        `);
        return true;
    }

    function promptForApiKey() {
        const currentKey = GM_getValue(OCR_SPACE_API_KEY_GM_VAR, "");
        const apiKey = prompt(`Enter OCR.space API key for ${SCRIPT_DISPLAY_NAME} (current: ${currentKey ? 'Set' : 'Not Set'}):\n(Get a free key via the link below the button)`, currentKey || "");
        if (apiKey !== null) {
            GM_setValue(OCR_SPACE_API_KEY_GM_VAR, apiKey.trim());
            log('API Key set/updated.');
            updateButtonLabelsAndStatus(false);
            if (statusElement) statusElement.textContent = apiKey.trim() ? 'API Key Set. Ready for OCR.' : 'API Key Cleared. Images only.';
        }
    }

    class Semaphore { constructor(maxConcurrency) { this.maxConcurrency = maxConcurrency; this.currentConcurrency = 0; this.waiting = []; } async acquire() { if (this.currentConcurrency < this.maxConcurrency) { this.currentConcurrency++; return Promise.resolve(); } return new Promise(resolve => { this.waiting.push(resolve); }); } release() { this.currentConcurrency--; if (this.waiting.length > 0) { const nextResolve = this.waiting.shift(); this.currentConcurrency++; nextResolve(); } } async withLock(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } } }

    async function processImageForOcrUpload(imageArrayBuffer, pageNumForLog) {
        const ocrPreprocessEnabled = GM_getValue(OCR_PREPROCESS_ENABLED_GM_VAR, DEFAULT_OCR_PREPROCESS_ENABLED);
        if (!ocrPreprocessEnabled) { log(`Page ${pageNumForLog}: Client OCR preprocessing disabled. Using original.`); return imageArrayBuffer; }
        const quality = GM_getValue(OCR_PREPROCESS_QUALITY_GM_VAR, DEFAULT_OCR_PREPROCESS_QUALITY);
        const maxDim = GM_getValue(OCR_PREPROCESS_MAX_DIM_GM_VAR, DEFAULT_OCR_PREPROCESS_MAX_DIM);
        const ocrApiMaxBytes = 1024 * 1024; const MIN_SIZE_TO_PROCESS_KB = 50;
        if (imageArrayBuffer.byteLength < MIN_SIZE_TO_PROCESS_KB * 1024) { log(`Page ${pageNumForLog}: Image small (${(imageArrayBuffer.byteLength / 1024).toFixed(1)}KB). Skipping preprocess.`); return imageArrayBuffer; }
        log(`Page ${pageNumForLog}: Client preprocess. Quality: ${quality}, MaxDim: ${maxDim}px. Original: ${(imageArrayBuffer.byteLength / 1024).toFixed(1)}KB`);
        return new Promise((resolve) => { const blob = new Blob([imageArrayBuffer]); const imageUrl = URL.createObjectURL(blob); const img = new Image(); img.onload = async () => { URL.revokeObjectURL(imageUrl); let width = img.width; let height = img.height; let needsResize = false; if (width > maxDim || height > maxDim) { needsResize = true; if (width > height) { if (width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; } } else { if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; } } } if (!needsResize && imageArrayBuffer.byteLength < ocrApiMaxBytes * 0.85) { log(`Page ${pageNumForLog}: No resize needed & original good size. Using original.`); resolve(imageArrayBuffer); return; } log(`Page ${pageNumForLog}: Orig dims: ${img.width}x${img.height}. Canvas target: ${width}x${height}.`); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height); canvas.toBlob( (outputBlob) => { if (!outputBlob) { errorLog(new Error(`Page ${pageNumForLog}: Canvas toBlob failed. Using original.`)); resolve(imageArrayBuffer); return; } log(`Page ${pageNumForLog}: Canvas blob size: ${(outputBlob.size / 1024).toFixed(1)}KB.`); const originalAcceptable = imageArrayBuffer.byteLength < ocrApiMaxBytes; if (originalAcceptable && outputBlob.size > imageArrayBuffer.byteLength * 0.95) { log(`Page ${pageNumForLog}: Processed not much smaller/larger than acceptable original. Using original.`); resolve(imageArrayBuffer); return; } if (outputBlob.size > ocrApiMaxBytes * 1.2) { errorLog(`Page ${pageNumForLog}: Processed image (${(outputBlob.size / 1024).toFixed(1)}KB) still exceeds OCR API limit significantly.`); } const reader = new FileReader(); reader.onloadend = () => resolve(reader.result); reader.onerror = (e) => { errorLog(`Page ${pageNumForLog}: FileReader error. Using original.`, e); resolve(imageArrayBuffer); }; reader.readAsArrayBuffer(outputBlob); }, 'image/jpeg', quality ); }; img.onerror = (err) => { URL.revokeObjectURL(imageUrl); errorLog(`Page ${pageNumForLog}: Failed to load image for canvas. Using original.`, err); resolve(imageArrayBuffer); }; img.src = imageUrl; }); }
    function getOcrLanguageCode(docLang) { const lang = (docLang || '').toLowerCase().trim(); const langMap = { 'bg': 'bul', 'en': 'eng', 'eng': 'eng', 'bul': 'bul', 'de': 'ger', 'fr': 'fre', 'es': 'spa', 'it': 'ita', 'ru':'rus', 'pt': 'por', 'nl': 'dut', 'pl': 'pol', 'cs': 'ces', 'sv': 'swe' }; const mapped = langMap[lang] || lang; if (mapped.length === 3 && /^[a-z]{3}$/.test(mapped)) { return mapped; } log(`OCR Lang: Unmapped/invalid '${docLang}' (to '${mapped}'), defaulting to '${DEFAULT_OCR_LANGUAGE}'.`); return DEFAULT_OCR_LANGUAGE; }
    async function getOcrData(apiKey, imageArrayBuffer, lang, pageNumForLog) { let processedBuffer = imageArrayBuffer; const clientPreprocessEnabled = GM_getValue(OCR_PREPROCESS_ENABLED_GM_VAR, DEFAULT_OCR_PREPROCESS_ENABLED); if (clientPreprocessEnabled) { statusElement.textContent = `Page ${pageNumForLog}: Preprocessing...`; try { processedBuffer = await withTimeout( processImageForOcrUpload(imageArrayBuffer, pageNumForLog), OCR_OPERATION_TIMEOUT_MS / 2, `Preprocess p${pageNumForLog}` ); log(`Page ${pageNumForLog}: Client preprocess. Orig: ${(imageArrayBuffer.byteLength/1024).toFixed(1)}KB, New: ${(processedBuffer.byteLength/1024).toFixed(1)}KB`); } catch (preprocessError) { errorLog(`Page ${pageNumForLog}: Client preprocess failed/timed out. Using original.`, preprocessError); processedBuffer = imageArrayBuffer; } } const ocrLang = getOcrLanguageCode(lang); let ocrEngine = (['ara', 'kor', 'jpn', 'chs', 'cht'].includes(ocrLang) || ocrLang === 'bul') ? '1' : '2'; if (ocrLang === 'rus') ocrEngine = '1'; const useOcrApiScaling = GM_getValue(OCR_API_SCALE_ENABLED_GM_VAR, DEFAULT_OCR_API_SCALE_ENABLED); const formData = new FormData(); formData.append('apikey', apiKey); formData.append('language', ocrLang); formData.append('isOverlayRequired', 'true'); formData.append('detectOrientation', 'true'); formData.append('scale', String(useOcrApiScaling)); formData.append('OCREngine', ocrEngine); formData.append('file', new Blob([processedBuffer], {type: 'image/jpeg'}), 'image.jpg'); log(`Page ${pageNumForLog}: To OCR.space. Lang:${ocrLang},Eng:${ocrEngine},APIScale:${useOcrApiScaling},Size:${(processedBuffer.byteLength/1024).toFixed(1)}KB`); statusElement.textContent = `Page ${pageNumForLog}: Uploading OCR...`; try { const ocrResultText = await GM_fetch('https://api.ocr.space/parse/image', 'text', 'POST', formData, {}, true, true); const ocrJson = JSON.parse(ocrResultText); if (ocrJson.IsErroredOnProcessing || !ocrJson.ParsedResults || ocrJson.ParsedResults.length === 0) { let errMsgs = ocrJson.ErrorMessage || []; if (ocrJson.ParsedResults?.[0]?.ErrorMessage) errMsgs.push(ocrJson.ParsedResults[0].ErrorMessage); throw new Error(errMsgs.join('; ') || 'OCR.space error.'); } if (ocrJson.ParsedResults[0].FileParseExitCode !== 1 && ![ -10, -20, -30].includes(ocrJson.ParsedResults[0].FileParseExitCode) ) { log(`OCR.space FileParseExitCode p${pageNumForLog}: ${ocrJson.ParsedResults[0].FileParseExitCode}. Details: ${ocrJson.ParsedResults[0].ErrorDetails || ocrJson.ParsedResults[0].ErrorMessage}`); } return ocrJson.ParsedResults[0]; } catch (error) { errorLog(`Page ${pageNumForLog}: getOcrData Error:`, error); if (error.message.includes("language") && error.message.includes("invalid")) { throw new Error(`OCR.space rejected lang '${ocrLang}'. Orig:'${lang}'. Err:${error.message}`); } if (error.message.includes("File size") && error.message.includes("limit")) { errorLog(`Page ${pageNumForLog}: OCR.space file size limit. Sent:${(processedBuffer.byteLength/1024).toFixed(1)}KB. Err:${error.message}`); statusElement.textContent = `Page ${pageNumForLog}: OCR fail (size).`; } throw error; } }
    async function fetchPageImageCore(pageIndex, documentInfo, documentId, filenameStub) { const currentPageNumber = pageIndex + 1; const pageData = documentInfo.pages?.[pageIndex] || { nr: currentPageNumber }; const pageQS = pageData.qs || ""; let imageUrlToFetch = null; let imageSourceInfo = "None"; const imageHost = `https://${documentInfo.image_host || 'img.yumpu.com'}`; const basePageWidth = pageData.width || documentInfo.width || 700; const basePageHeight = pageData.height || documentInfo.height || 996; if (pageData.images) { let bestImage = null; if (pageData.images.original?.url) bestImage = { ...pageData.images.original, type: "original" }; if (pageData.images.alternatives?.length) { const sortedAlts = pageData.images.alternatives.filter(alt => alt.url && alt.width && alt.height).sort((a,b) => (b.width * b.height) - (a.width * a.height)); if (sortedAlts.length > 0 && (!bestImage || (sortedAlts[0].width * sortedAlts[0].height > bestImage.width * bestImage.height))) { bestImage = { ...sortedAlts[0], type: `alternatives (${sortedAlts[0].width}x${sortedAlts[0].height})` }; } } if (!bestImage && pageData.images.zoom?.url) bestImage = { url: pageData.images.zoom.url, type: "zoom" }; if (!bestImage && pageData.images.jpg?.url) bestImage = { url: pageData.images.jpg.url, type: "jpg" }; if (bestImage) { imageUrlToFetch = bestImage.url; imageSourceInfo = `Direct JSON images.${bestImage.type}`; } } if (!imageUrlToFetch && pageData.urls?.original) { imageUrlToFetch = pageData.urls.original; imageSourceInfo = `Direct JSON urls.original`; } if (!imageUrlToFetch && pageData.image_url) { imageUrlToFetch = pageData.image_url; imageSourceInfo = `Direct JSON image_url`; } if (imageUrlToFetch && !imageUrlToFetch.startsWith('http')) { imageUrlToFetch = imageUrlToFetch.startsWith('/') ? imageHost + imageUrlToFetch : imageHost + '/' + imageUrlToFetch; imageUrlToFetch = imageUrlToFetch.replace(/([^:])\/\//g, '$1/'); } if (!imageUrlToFetch) { let pageSpecificDimStub = (pageData.width && pageData.height) ? `${pageData.width}x${pageData.height}` : null; const docDimStub = (basePageWidth && basePageHeight) ? `${basePageWidth}x${basePageHeight}` : null; const resolutionPathsToTry = ["original"]; if (PREFERRED_RESOLUTION_STUB) resolutionPathsToTry.push(PREFERRED_RESOLUTION_STUB); if (pageSpecificDimStub) resolutionPathsToTry.push(pageSpecificDimStub); if (docDimStub && docDimStub !== "450x640") resolutionPathsToTry.push(docDimStub); resolutionPathsToTry.push("2000x3000", "1600x2400", "1200x1800", "1024x1500"); const firstPageSettingsRes = documentInfo.pages?.[0]?.settings?.resolution; if (firstPageSettingsRes) resolutionPathsToTry.push(firstPageSettingsRes); if (docDimStub === "450x640") resolutionPathsToTry.push("450x640"); resolutionPathsToTry.push("700x996"); const uniquePaths = [...new Set(resolutionPathsToTry.filter(p => p))]; for (const resPath of uniquePaths) { let tempUrl = `https://img.yumpu.com/${documentId}/${currentPageNumber}/${resPath}/${filenameStub}.jpg`; let currentQS = pageQS; if (IMAGE_QUALITY_PARAMETER !== null) { currentQS = currentQS ? (currentQS.toLowerCase().includes('quality=') ? currentQS.replace(/quality=\d+/i, `quality=${IMAGE_QUALITY_PARAMETER}`) : `${currentQS}&quality=${IMAGE_QUALITY_PARAMETER}`) : `quality=${IMAGE_QUALITY_PARAMETER}`; } if (currentQS) tempUrl += `?${currentQS.replace(/^&+|&+$/g, '')}`; try { const testBytes = await GM_fetch(tempUrl, 'arraybuffer', 'GET', null, {}, false); if (testBytes && testBytes.byteLength > 1000) { imageUrlToFetch = tempUrl; imageSourceInfo = `Constructed with resPath "${resPath}"`; log(`Page ${currentPageNumber}: Test fetch success: ${imageUrlToFetch}`); break; } } catch (e) { /* Test fetch failed */ } } } if (!imageUrlToFetch) { const imgElement = document.querySelector(`.eagle-page[data-page="${pageIndex}"] .eagle-page-content img[src^="https://img.yumpu.com"]`); if (imgElement?.src && (imgElement.naturalWidth > 50 || imgElement.src.includes('/x'))) { imageUrlToFetch = imgElement.src; imageSourceInfo = `DOM Fallback (${imgElement.naturalWidth||'unk'}x${imgElement.naturalHeight||'unk'})`; if (IMAGE_QUALITY_PARAMETER !== null && !imageUrlToFetch.includes('quality=')) { imageUrlToFetch = `${imageUrlToFetch}${imageUrlToFetch.includes('?')?'&':'?'}quality=${IMAGE_QUALITY_PARAMETER}`; } log(`Page ${currentPageNumber}: DOM fallback: ${imageUrlToFetch}`); } } if (!imageUrlToFetch) { errorLog(new Error(`Page ${currentPageNumber}: All image fetch methods failed. Skipping.`)); return null; } log(`Page ${currentPageNumber}: Final URL (${imageSourceInfo}): ${imageUrlToFetch}`); try { const imageBytes = await GM_fetch(imageUrlToFetch, 'arraybuffer'); return { pageIndex, imageBytes, imageUrl: imageUrlToFetch, pageDataFromDoc: pageData, sourceInfo: imageSourceInfo }; } catch (fetchError) { errorLog(`Page ${currentPageNumber}: Failed to fetch final image ${imageUrlToFetch}`, fetchError); return null; } }

    async function addPageToPdf(pageProcessData, pdfDoc, allOcrTextPerPageRef) { // Added allOcrTextPerPageRef
        const { fetchedPage, documentInfo, effectiveMode, customFontForPdf, userApiKey } = pageProcessData;
        const currentPageNumber = fetchedPage.pageIndex + 1;
        try {
            const imageMime = getImageMimeType(fetchedPage.imageBytes.slice(0, 12)) || 'image/jpeg';
            let embeddedImage;
            if (imageMime === 'image/png') embeddedImage = await pdfDoc.embedPng(fetchedPage.imageBytes);
            else if (imageMime === 'image/jpeg') embeddedImage = await pdfDoc.embedJpg(fetchedPage.imageBytes);
            else { errorLog(new Error(`Page ${currentPageNumber}: Unsupported image type ${imageMime}. Skipping.`)); return false; }

            if (!embeddedImage?.width || !embeddedImage?.height) { throw new Error('Embedded image invalid dimensions.'); }
            const pdfPage = pdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
            pdfPage.drawImage(embeddedImage, { x: 0, y: 0, width: embeddedImage.width, height: embeddedImage.height });

            if (effectiveMode === 'searchable_pdf' && userApiKey && customFontForPdf) {
                try {
                    const ocrResultData = await withTimeout(
                        getOcrData(userApiKey, fetchedPage.imageBytes, documentInfo.language || DEFAULT_OCR_LANGUAGE, currentPageNumber),
                        OCR_OPERATION_TIMEOUT_MS, `OCR op p${currentPageNumber}`
                    );

                    if (ocrResultData?.ParsedText && ocrResultData.ParsedText.trim() !== "") {
                        allOcrTextPerPageRef.push({ pageIndex: fetchedPage.pageIndex, text: ocrResultData.ParsedText });
                        log(`Page ${currentPageNumber}: OCR Text collected. Length: ${ocrResultData.ParsedText.length}`);
                    } else {
                        log(`Page ${currentPageNumber}: OCR returned no ParsedText.`);
                    }

                    if (ocrResultData?.TextOverlay?.Lines?.length > 0) {
                        log(`Page ${currentPageNumber}: OCR Overlay OK. Lines:${ocrResultData.TextOverlay.Lines.length}. Orient:${ocrResultData.TextOrientation}`);
                        let wordsDrawn = 0;
                        ocrResultData.TextOverlay.Lines.forEach(line => {
                            line.Words.forEach(word => {
                                if (!word.WordText || word.WordText.trim() === "") return;
                                const fontSize = Math.max(5, word.Height * 0.75);
                                const pdfY_baseline = pdfPage.getHeight() - word.Top - word.Height;
                                try { pdfPage.drawText(word.WordText, { x: word.Left, y: pdfY_baseline, font: customFontForPdf, size: fontSize, color: rgb(0,0,0), opacity: 0.001 }); wordsDrawn++; }
                                catch (drawError) { if (!drawError.message.includes("WinAnsi") && !drawError.message.includes("encode") && !drawError.message.includes("font does not have glyph") && !drawError.message.includes("cmap format")) { errorLog(`Page ${currentPageNumber}: Error drawing word "${word.WordText}"`, drawError); } }
                            });
                        });
                        log(`Page ${currentPageNumber}: OCR text overlay added (${wordsDrawn} words).`);
                    } else {
                        log(`Page ${currentPageNumber}: OCR no text overlay. Code:${ocrResultData?.FileParseExitCode},Msg:${ocrResultData?.ErrorMessage || ocrResultData?.ErrorDetails}`);
                    }
                } catch (ocrError) {
                    errorLog(`Page ${currentPageNumber}: OCR process failed/timed out`, ocrError);
                }
            } else if (effectiveMode === 'searchable_pdf') {
                log(`Page ${currentPageNumber}: Skipping OCR (key/font issue).`);
            }
            return true;
        } catch (error) {
            errorLog(`Page ${currentPageNumber}: Error embedding image/PDF processing`, error);
            return false;
        }
    }

    async function handleDownload() {
        let userApiKey = GM_getValue(OCR_SPACE_API_KEY_GM_VAR, "").trim();
        if (!userApiKey) { // If user has not set a key or cleared it
            userApiKey = "K88821594088957"; // Use the hardcoded default/testing key
            log("User API key not set or empty, using default testing key K88821594088957 for OCR operations.");
        }
        const currentDebugMode = GM_getValue(DEBUG_MODE_GM_VAR, DEFAULT_DEBUG_MODE);
        const currentDebugPages = GM_getValue(DEBUG_PAGE_LIMIT_GM_VAR, DEFAULT_DEBUG_PAGE_LIMIT);
        const effectiveMode = userApiKey ? 'searchable_pdf' : 'pdf';

        log(`--- Download Start --- Mode: ${effectiveMode}. Debug Mode: ${currentDebugMode ? 'ON' : 'OFF'}${currentDebugMode ? ` (Limit: ${currentDebugPages}pg)` : ''}`);
        updateButtonLabelsAndStatus(true);

        const reEnableUI = () => { updateButtonLabelsAndStatus(false); };

        if (effectiveMode === 'searchable_pdf' && !await prepareFont()) { /* Error logged */ }

        const playerConfig = getPlayerConfig();
        if (!playerConfig?.jsonUrl) { statusElement.textContent = 'Error: Player config not found.'; reEnableUI(); return; }

        let docDataJson;
        try { statusElement.textContent = 'Fetching doc info...'; const jsonText = await GM_fetch(playerConfig.jsonUrl, 'text'); docDataJson = JSON.parse(jsonText); }
        catch (error) { statusElement.textContent = `Error fetching doc JSON: ${error.message.substring(0,50)}`; errorLog("Doc JSON fetch/parse error:", error); reEnableUI(); return; }

        const documentInfo = docDataJson?.document;
        if (!documentInfo) { statusElement.textContent = 'Error: Invalid doc data.'; errorLog(new Error("Invalid doc data"), docDataJson); reEnableUI(); return; }

        let totalPages = documentInfo.page_count || documentInfo.pages?.length || 0;
        let totalPagesToProcess = currentDebugMode ? Math.min(totalPages, currentDebugPages) : totalPages;
        if (totalPagesToProcess === 0) { statusElement.textContent = 'Error: No pages in doc.'; reEnableUI(); return; }

        const documentId = documentInfo.id;
        const documentTitle = sanitizeFilename(documentInfo.title || `yumpu_doc_${documentId}`);
        log(`Doc: "${documentTitle}", ID:${documentId}, Pages:${totalPagesToProcess}/${totalPages}`);
        let filenameStub = playerConfig.shareCoverUrl?.split('/')?.pop()?.split('.')[0] || documentInfo.slug?.split('/')?.pop() || "page";
        filenameStub = sanitizeFilename(filenameStub.replace(/[^a-zA-Z0-9_-]/g, ''));

        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle(documentTitle); pdfDoc.setAuthor(documentInfo.author_name || GM_SCRIPT_NAME);
        pdfDoc.setCreator(SCRIPT_DISPLAY_NAME); pdfDoc.setCreationDate(new Date()); pdfDoc.setModificationDate(new Date());

        let customFontForPdf = null;
        if (effectiveMode === 'searchable_pdf' && typeof window.fontkit !== 'undefined') {
            try { pdfDoc.registerFontkit(window.fontkit);
                 if (embeddedFontBytes) { customFontForPdf = await pdfDoc.embedFont(embeddedFontBytes, { subset: true }); log("Custom font embedded."); }
                 else { customFontForPdf = await pdfDoc.embedFont(StandardFonts.Helvetica); log("Helvetica for OCR (no custom font).");}
                } catch (fontError) { errorLog("Font embed error:", fontError); try { if (!customFontForPdf) customFontForPdf = await pdfDoc.embedFont(StandardFonts.Helvetica); } catch (e) { errorLog("Helvetica fallback failed:", e); } }
        } else if (effectiveMode === 'searchable_pdf') { log("Fontkit N/A. Helvetica for OCR."); try { customFontForPdf = await pdfDoc.embedFont(StandardFonts.Helvetica); } catch(e){ errorLog("Helvetica failed:", e); } }

        const fetchedImageBuffer = [];
        const processedPdfPageResults = [];
        const allOcrTextPerPage = []; // To store OCR text for the TXT file

        const fetchSemaphore = new Semaphore(GM_getValue(MAX_CONCURRENT_FETCHES_GM_VAR, DEFAULT_MAX_CONCURRENT_FETCHES));
        const ocrSemaphore = new Semaphore(GM_getValue(MAX_CONCURRENT_OCR_GM_VAR, DEFAULT_MAX_CONCURRENT_OCR));

        let pagesFetchedCount = 0;
        let pagesProcessedCount = 0;
        statusElement.textContent = `Starting... (0/${totalPagesToProcess} fetched, 0 processed)`;
        const allPageIndices = Array.from({ length: totalPagesToProcess }, (_, i) => i);

        const fetchPage = async (pageIndex) => {
            return fetchSemaphore.withLock(async () => {
                statusElement.textContent = `Fetching p${pageIndex + 1}/${totalPagesToProcess}...`;
                const fetchedData = await fetchPageImageCore(pageIndex, documentInfo, documentId, filenameStub);
                if (fetchedData) {
                    pagesFetchedCount++;
                    fetchedImageBuffer.push(fetchedData);
                    log(`Fetched page ${pageIndex + 1}. Buffer size: ${fetchedImageBuffer.length}`);
                } else {
                    log(`Failed to fetch page ${pageIndex + 1}. It will be skipped.`);
                    // To ensure processed count can eventually match totalPagesToProcess if fetches fail
                    processedPdfPageResults.push({ pageIndex: pageIndex, success: false, skippedFetch: true });
                }
                statusElement.textContent = `Fetched ${pagesFetchedCount}/${totalPagesToProcess}. Processing ${pagesProcessedCount}...`;
            });
        };

        const processPage = async () => {
            return ocrSemaphore.withLock(async () => {
                if (fetchedImageBuffer.length === 0) { return 'buffer_empty'; }

                const fetchedPage = fetchedImageBuffer.shift();
                if (!fetchedPage) return 'buffer_empty'; // Should not occur if length check passes

                statusElement.textContent = `Processing p${fetchedPage.pageIndex + 1}/${totalPagesToProcess} (OCR/Embed)...`;
                const success = await addPageToPdf(
                    { fetchedPage, documentInfo, effectiveMode, customFontForPdf, userApiKey },
                    pdfDoc,
                    allOcrTextPerPage // Pass the array reference
                );
                processedPdfPageResults.push({ pageIndex: fetchedPage.pageIndex, success });
                pagesProcessedCount++;
                statusElement.textContent = `Fetched ${pagesFetchedCount}/${totalPagesToProcess}. Processed ${pagesProcessedCount}...`;
                return 'processed_one';
            });
        };

        let fetchPromises = [];
        let processPromises = [];
        let currentFetchIdx = 0;

        while(pagesProcessedCount < totalPagesToProcess) {
            // Try to queue up new fetch tasks if not all pages are fetched/fetching and semaphore allows
            while(currentFetchIdx < totalPagesToProcess && fetchPromises.length < GM_getValue(MAX_CONCURRENT_FETCHES_GM_VAR, DEFAULT_MAX_CONCURRENT_FETCHES)) {
                const promise = fetchPage(allPageIndices[currentFetchIdx]).then(() => {
                    fetchPromises = fetchPromises.filter(p => p !== promise); // Remove self when done
                }).catch(err => {
                    errorLog(`Unhandled error in fetchPage promise for index ${allPageIndices[currentFetchIdx]}`, err);
                    fetchPromises = fetchPromises.filter(p => p !== promise);
                });
                fetchPromises.push(promise);
                currentFetchIdx++;
            }

            // Try to queue up new process tasks if there are fetched images and semaphore allows
            while(fetchedImageBuffer.length > 0 && processPromises.length < GM_getValue(MAX_CONCURRENT_OCR_GM_VAR, DEFAULT_MAX_CONCURRENT_OCR)) {
                const promise = processPage().then((result) => {
                    processPromises = processPromises.filter(p => p !== promise);
                    if (result === 'buffer_empty' && pagesFetchedCount === totalPagesToProcess && fetchedImageBuffer.length === 0) {
                        // This signals the processor might be done if all fetches are complete
                    }
                }).catch(err => {
                    errorLog(`Unhandled error in processPage promise`, err);
                    processPromises = processPromises.filter(p => p !== promise);
                });
                processPromises.push(promise);
            }

            if (fetchPromises.length === 0 && processPromises.length === 0 && (pagesFetchedCount < totalPagesToProcess || fetchedImageBuffer.length > 0)) {
                // This state means all active slots are busy, or no work could be queued.
                // If fetches are not complete, or buffer has items, something should be happening.
                // This might happen if semaphores are full. We wait for a slot to open.
                await Promise.race([
                    ...(fetchPromises.length > 0 ? fetchPromises : [new Promise(()=>{})]), // non-resolving if no fetch promises
                    ...(processPromises.length > 0 ? processPromises : [new Promise(()=>{})]) // non-resolving if no process promises
                    // Add a timeout to prevent infinite loop if logic error
                ].filter(p => p)).catch(() => {}); // Wait for any active task or just continue if none
            }


            // If all pages are fetched, buffer is empty, and no processing tasks are active, we should be done.
            if (pagesFetchedCount === totalPagesToProcess && fetchedImageBuffer.length === 0 && processPromises.length === 0) {
                // Ensure processed count matches the number of pages intended for processing
                // This might take a few more cycles if some `addPageToPdf` calls were skipped due to fetch failures.
                if (pagesProcessedCount >= totalPagesToProcess - (totalPagesToProcess - processedPdfPageResults.filter(r=>r.skippedFetch).length)) {
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 50)); // Small delay to prevent tight loop if no work queued immediately
        }


        log(`Pipeline finished. Fetched: ${pagesFetchedCount}, Processed PDF attempts: ${pagesProcessedCount}`);
        const successfulPdfPages = processedPdfPageResults.filter(p => p.success).length;

        if (successfulPdfPages === 0 && totalPagesToProcess > 0) { // Check totalPagesToProcess to avoid error if 0 pages
            statusElement.textContent = 'Error: No pages were successfully added to the PDF.';
            errorLog(new Error("No pages added to PDF. Aborting save."));
        } else if (totalPagesToProcess > 0) { // Only save if there were pages to process
            statusElement.textContent = `Finalizing PDF (${successfulPdfPages} pages)...`;
            try {
                const pdfBytes = await pdfDoc.save();
                const finalPdfFilename = effectiveMode === 'searchable_pdf' ? `${documentTitle}_Searchable.pdf` : `${documentTitle}.pdf`;
                downloadBlob(pdfBytes, finalPdfFilename, 'application/pdf');
                statusElement.textContent = `PDF: "${finalPdfFilename}" (${successfulPdfPages} pages). `;

                // --- Generate and Download TXT file ---
                if (effectiveMode === 'searchable_pdf' && allOcrTextPerPage.length > 0) {
                    log(`Generating TXT file from ${allOcrTextPerPage.length} OCR'd pages.`);
                    statusElement.textContent += "Generating TXT...";
                    allOcrTextPerPage.sort((a, b) => a.pageIndex - b.pageIndex); // Ensure pages are in order

                    let combinedText = `OCR Text for: ${documentTitle}\n${SCRIPT_DISPLAY_NAME}\n\n`;
                    allOcrTextPerPage.forEach(pageText => {
                        combinedText += `--- Page ${pageText.pageIndex + 1} ---\n`;
                        combinedText += pageText.text.trim() + "\n\n";
                    });

                    const txtBlob = new Blob([combinedText], { type: 'text/plain;charset=utf-8' });
                    const finalTxtFilename = `${documentTitle}_OCR.txt`;
                    downloadBlob(txtBlob, finalTxtFilename, 'text/plain');
                    log(`TXT file "${finalTxtFilename}" initiated for download.`);
                    statusElement.textContent = `Downloads: PDF & TXT!`;
                } else if (effectiveMode === 'searchable_pdf') {
                    log("No OCR text collected for TXT file.");
                    statusElement.textContent += ` (No OCR text for TXT).`;
                }

            } catch (error) {
                statusElement.textContent = `Error saving files: ${error.message.substring(0,50)}`;
                errorLog(`handleDownload: Error saving files:`, error);
            }
        } else {
            statusElement.textContent = "No pages processed."; // Case where totalPagesToProcess was 0 initially
        }
        reEnableUI();
        log(`--- Download End ---`);
    }

    function getImageMimeType(headerBytes) { try { const uint = new Uint8Array(headerBytes); if (uint.length < 12) { return null; } if (uint[0] === 0x89 && uint[1] === 0x50 && uint[2] === 0x4E && uint[3] === 0x47 && uint[4] === 0x0D && uint[5] === 0x0A && uint[6] === 0x1A && uint[7] === 0x0A) return 'image/png'; if (uint[0] === 0xFF && uint[1] === 0xD8 && uint[2] === 0xFF) return 'image/jpeg'; if (uint[0] === 0x47 && uint[1] === 0x49 && uint[2] === 0x46 && uint[3] === 0x38 && (uint[4] === 0x37 || uint[4] === 0x39) && uint[5] === 0x61) return 'image/gif'; if (uint[0] === 0x52 && uint[1] === 0x49 && uint[2] === 0x46 && uint[3] === 0x46 && uint[8] === 0x57 && uint[9] === 0x45 && uint[10] === 0x42 && uint[11] === 0x50) return 'image/webp'; if (uint[0] === 0x42 && uint[1] === 0x4D) return 'image/bmp'; return null; } catch (e) { errorLog('getImageMimeType error:', e); return null; } }
    function downloadBlob(data, fileName, mimeType) { try { const blob = new Blob([data], { type: mimeType }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); log(`downloadBlob: Initiated "${fileName}".`); }, 100); } catch (e) { errorLog(`downloadBlob error for "${fileName}" by ${SCRIPT_DISPLAY_NAME}:`, e); if (statusElement) statusElement.textContent = `Download trigger error.`; } }

    log('Initialization: Starting checks.');
    let attempts = 0; const maxAttempts = 40;
    const initInterval = setInterval(async () => { attempts++; let config = null; try { config = getPlayerConfig(); } catch (e) { errorLog(`Init getPlayerConfig error`, e); } if (config?.jsonUrl) { log('Initialization: playerConfig found!', config.jsonUrl.substring(0,100)+"..."); clearInterval(initInterval); try { if(addUI()) { log('Initialization: UI added.'); if (GM_getValue(OCR_SPACE_API_KEY_GM_VAR, "")) { statusElement.textContent = 'Preparing font...'; await prepareFont(); updateButtonLabelsAndStatus(); if(statusElement.textContent === 'Preparing font...') statusElement.textContent = 'Ready (API Key set).'; } } else { errorLog(new Error('Initialization: addUI() failed.')); } } catch (e) { errorLog(`Init addUI/prepareFont error`, e); } } else if (attempts > maxAttempts) { clearInterval(initInterval); errorLog(new Error(`${SCRIPT_DISPLAY_NAME}: playerConfig not found after ${maxAttempts} attempts. URL: ${window.location.href}`)); if (document.body && (window.self === window.top || window.location.href.includes('yumpu.com/embed/'))) { const errorDiv = document.createElement('div'); errorDiv.textContent = `${SCRIPT_DISPLAY_NAME}: Player config not found. Script cannot run.`; errorDiv.style.cssText = "position:fixed;top:10px;right:10px;background:red;color:white;padding:10px;z-index:2147483647;font-family:Arial,sans-serif;font-size:14px;"; document.body.appendChild(errorDiv); setTimeout(() => { try { errorDiv.remove(); } catch(e){} }, 15000); } } }, 500);

})();