// ==UserScript==
// @name         Перевод текста и аудио на английский
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Translate russian to english both speech and text
// @author       Assistant
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      translate.googleapis.com
// @connect      clients5.google.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    if (window.EnhancedTextFieldAssistant) return;
    window.EnhancedTextFieldAssistant = true;

    // ===== CONSOLE ERROR SUPPRESSION =====
    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = (...args) => {
        const msg = args.join(' ');
        if (['RecoverableError', 'Minified React error #418', 'DialogContent', 'DialogTitle',
             'Intercom not booted', 'PerformanceObserver', 'ERR_BLOCKED_BY_CLIENT'].some(err => msg.includes(err))) return;
        originalError.apply(console, args);
    };

    console.warn = (...args) => {
        const msg = args.join(' ');
        if (['DialogContent', 'DialogTitle', 'Missing `Description`', 'aria-describedby'].some(err => msg.includes(err))) return;
        originalWarn.apply(console, args);
    };

    // ===== UTILITIES =====
    const safeExecute = (fn, context = 'Unknown') => {
        try { return fn(); } catch (error) { return null; }
    };

    const debounce = (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    };

    // ===== BACKGROUND BRIGHTNESS DETECTION =====
    function detectBackgroundBrightness(element) {
        try {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            const checkPoints = [
                {x: x, y: y},
                {x: rect.left + 10, y: y},
                {x: rect.right - 10, y: y},
                {x: x, y: rect.top + 10},
                {x: x, y: rect.bottom - 10}
            ];

            let totalBrightness = 0;
            let validSamples = 0;

            for (let point of checkPoints) {
                const elementUnder = document.elementFromPoint(point.x, point.y);
                if (elementUnder) {
                    const styles = getComputedStyle(elementUnder);
                    const bgColor = styles.backgroundColor;

                    if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
                        const rgb = bgColor.match(/\d+/g);
                        if (rgb && rgb.length >= 3) {
                            const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
                            totalBrightness += brightness;
                            validSamples++;
                        }
                    }
                }
            }

            if (validSamples > 0) {
                const avgBrightness = totalBrightness / validSamples;
                return avgBrightness > 128 ? 'light' : 'dark';
            }

            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch (error) {
            return 'light';
        }
    }

    // ===== LANGUAGE DETECTION =====
    const LanguageDetector = {
        isRussian(text) {
            const cyrillicRegex = /[\u0400-\u04FF]/;
            return cyrillicRegex.test(text) || /^(это|что|как|где|когда|почему|кто|да|нет|привет|спасибо|пожалуйста)/i.test(text);
        },

        isEnglish(text) {
            const englishRegex = /^[a-zA-Z\s.,!?'"0-9]+$/;
            return englishRegex.test(text) || /^(this|that|what|how|where|when|why|who|yes|no|hello|thank|please)/i.test(text);
        },

        detectLanguage(text) {
            if (this.isRussian(text)) return 'ru';
            if (this.isEnglish(text)) return 'en';
            return 'auto';
        }
    };

    // ===== STATE MANAGEMENT =====
    const State = {
        processedFields: new WeakSet(),
        processedElements: new Map(),
        observers: [], intervals: [], iconCount: 0,
        isProcessing: false, isListening: false, isTranslating: false, isSpeaking: false,
        recognition: null, synthesis: null,
        speechTimeout: null, silenceTimer: null
    };

    // ===== JONY IVE AURORA METAL ICONS =====
    const SynthesisIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path class="line-1" d="M2 12h2"/>
            <path class="line-2" d="M6 8v8"/>
            <path class="line-3" d="M10 6v12"/>
            <path class="line-4" d="M14 4v16"/>
            <path class="line-5" d="M18 7v10"/>
            <path class="line-6" d="M22 10v4"/>
        </svg>
    `;

    const CapitalizeIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5l-7 8h14l-7-8z"/>
        </svg>
    `;

    const SpeakIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5,6 9,2 9,2 15,6 15,11 19,11 5"/>
            <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
            <path d="M18.3 5.4a9 9 0 0 1 0 13.2"/>
        </svg>
    `;

    const ClearIcon = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    `;

    // Fallback icons
    const FallbackSynthesisIcon = `<span style="font-size: 12px;">🎤</span>`;
    const FallbackCapitalizeIcon = `<span style="font-size: 16px;">▲</span>`;
    const FallbackSpeakIcon = `<span style="font-size: 16px;">🔊</span>`;
    const FallbackClearIcon = `<span style="font-size: 10px;">✕</span>`;

    // ===== JONY IVE AURORA BOREALIS METAL DESIGN =====
    GM_addStyle(`
        /* Jony Ive Aurora Borealis Selection Animation */
        @keyframes jonyvieAuroraSelection {
            0% {
                background-position: 0% 50%;
                box-shadow:
                    0 0 15px rgba(140, 200, 255, 0.3),
                    0 0 30px rgba(180, 220, 255, 0.2),
                    0 0 45px rgba(200, 235, 255, 0.1);
            }
            25% {
                background-position: 25% 50%;
                box-shadow:
                    0 0 18px rgba(160, 210, 255, 0.35),
                    0 0 36px rgba(190, 230, 255, 0.25),
                    0 0 54px rgba(210, 245, 255, 0.15);
            }
            50% {
                background-position: 50% 50%;
                box-shadow:
                    0 0 22px rgba(180, 220, 255, 0.4),
                    0 0 44px rgba(200, 240, 255, 0.3),
                    0 0 66px rgba(220, 250, 255, 0.2);
            }
            75% {
                background-position: 75% 50%;
                box-shadow:
                    0 0 18px rgba(160, 210, 255, 0.35),
                    0 0 36px rgba(190, 230, 255, 0.25),
                    0 0 54px rgba(210, 245, 255, 0.15);
            }
            100% {
                background-position: 100% 50%;
                box-shadow:
                    0 0 15px rgba(140, 200, 255, 0.3),
                    0 0 30px rgba(180, 220, 255, 0.2),
                    0 0 45px rgba(200, 235, 255, 0.1);
            }
        }

        ::selection {
            background: linear-gradient(90deg,
                rgba(220, 235, 255, 0.8),
                rgba(190, 220, 250, 0.9),
                rgba(160, 200, 240, 1),
                rgba(140, 180, 230, 1),
                rgba(160, 200, 240, 1),
                rgba(190, 220, 250, 0.9),
                rgba(220, 235, 255, 0.8)
            );
            background-size: 400% 400%;
            animation: jonyvieAuroraSelection 12s cubic-bezier(0.4, 0, 0.2, 1) infinite;
            color: rgba(30, 30, 30, 0.95);
        }

        /* Aurora Borealis Wave Animation */
        @keyframes auroraWave {
            0%, 100% {
                stroke-dasharray: 3 9;
                stroke-dashoffset: 0;
                opacity: 0.6;
                filter: drop-shadow(0 0 4px currentColor) brightness(1.1);
                stroke: rgba(140, 200, 255, 0.8);
            }
            25% {
                stroke-dasharray: 6 6;
                stroke-dashoffset: -3;
                opacity: 0.8;
                filter: drop-shadow(0 0 6px currentColor) brightness(1.2);
                stroke: rgba(160, 210, 255, 0.9);
            }
            50% {
                stroke-dasharray: 9 3;
                stroke-dashoffset: -6;
                opacity: 1;
                filter: drop-shadow(0 0 8px currentColor) brightness(1.3);
                stroke: rgba(180, 220, 255, 1);
            }
            75% {
                stroke-dasharray: 6 6;
                stroke-dashoffset: -9;
                opacity: 0.8;
                filter: drop-shadow(0 0 6px currentColor) brightness(1.2);
                stroke: rgba(160, 210, 255, 0.9);
            }
        }

        /* Main Speech Synthesis Button - Perfect Circle, Always Visible */
        .ert-speech-button {
            position: absolute !important;
            right: 12px !important;
            top: 50% !important;
            transform: translateY(-50%) !important;
            width: 26px !important;
            height: 26px !important;
            border: none !important;
            border-radius: 50% !important;
            cursor: pointer !important;
            z-index: 10001 !important;
            transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 12px !important;
            font-weight: 500 !important;

            /* Jony Ive Aurora Metal Base */
            background: linear-gradient(145deg,
                rgba(245, 248, 252, 0.95) 0%,
                rgba(230, 240, 250, 0.9) 25%,
                rgba(215, 235, 248, 0.85) 50%,
                rgba(200, 230, 245, 0.9) 75%,
                rgba(220, 240, 250, 0.95) 100%
            ) !important;

            box-shadow:
                0 2px 12px rgba(140, 180, 220, 0.25),
                0 4px 24px rgba(160, 200, 240, 0.15),
                inset 0 1px 0 rgba(255, 255, 255, 0.6),
                inset 0 -1px 0 rgba(140, 180, 220, 0.2) !important;

            backdrop-filter: blur(20px) saturate(180%) !important;
            border: 1px solid rgba(140, 180, 220, 0.3) !important;
            color: rgba(60, 80, 100, 0.9) !important;

            pointer-events: auto !important;
            visibility: visible !important;
            opacity: 1 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
        }

        .ert-speech-button:hover {
            background: linear-gradient(145deg,
                rgba(240, 245, 252, 0.98) 0%,
                rgba(220, 235, 250, 0.95) 25%,
                rgba(200, 230, 248, 0.9) 50%,
                rgba(180, 225, 245, 0.95) 75%,
                rgba(210, 235, 250, 0.98) 100%
            ) !important;

            box-shadow:
                0 4px 20px rgba(140, 180, 220, 0.35),
                0 8px 40px rgba(160, 200, 240, 0.25),
                inset 0 1px 0 rgba(255, 255, 255, 0.8),
                inset 0 -1px 0 rgba(140, 180, 220, 0.3) !important;

            transform: translateY(-50%) scale(1.08) !important;
            border-color: rgba(140, 180, 220, 0.5) !important;
        }

        .ert-speech-button:active {
            background: linear-gradient(145deg,
                rgba(210, 225, 240, 0.9) 0%,
                rgba(190, 215, 235, 0.85) 50%,
                rgba(170, 205, 230, 0.9) 100%
            ) !important;

            box-shadow:
                0 1px 6px rgba(140, 180, 220, 0.4),
                inset 0 2px 4px rgba(140, 180, 220, 0.3),
                inset 0 1px 0 rgba(255, 255, 255, 0.4) !important;

            transform: translateY(-50%) scale(0.96) !important;
        }

        /* Aurora Metal Icon Styling - Normal State */
        .ert-speech-button svg {
            width: 14px !important;
            height: 14px !important;
            stroke: rgba(60, 80, 100, 0.85) !important;
            fill: none !important;
            stroke-width: 1.8 !important;
            stroke-linecap: round !important;
            stroke-linejoin: round !important;
            transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1) !important;
            filter: drop-shadow(0 0 1px rgba(140, 180, 220, 0.4)) !important;
        }

        .ert-speech-button:hover svg {
            stroke: rgba(30, 50, 70, 0.95) !important;
            filter: drop-shadow(0 0 2px rgba(140, 180, 220, 0.6)) !important;
        }

        /* FULLY FIXED: Dark Icons During Active States on Light Buttons - Higher Specificity */
        .ert-speech-button.listening svg,
        .ert-speech-button.listening svg path,
        .ert-speech-button.translating svg,
        .ert-speech-button.translating svg path,
        .ert-speech-button.success svg,
        .ert-speech-button.success svg path {
            stroke: rgba(15, 25, 35, 0.95) !important;
            filter: drop-shadow(0 0 3px rgba(15, 25, 35, 0.5)) !important;
        }

        .ert-speech-button.error svg,
        .ert-speech-button.error svg path {
            stroke: rgba(140, 40, 30, 0.95) !important;
            filter: drop-shadow(0 0 3px rgba(140, 40, 30, 0.5)) !important;
        }

        /* Force dark color on active state SVG elements */
        .ert-speech-button.listening svg .line-1,
        .ert-speech-button.listening svg .line-2,
        .ert-speech-button.listening svg .line-3,
        .ert-speech-button.listening svg .line-4,
        .ert-speech-button.listening svg .line-5,
        .ert-speech-button.listening svg .line-6 {
            stroke: rgba(15, 25, 35, 0.95) !important;
        }

        /* Dark Background Adaptation */
        .ert-speech-button[data-bg="dark"] {
            background: linear-gradient(145deg,
                rgba(80, 90, 105, 0.95) 0%,
                rgba(70, 85, 100, 0.9) 25%,
                rgba(60, 80, 95, 0.85) 50%,
                rgba(55, 75, 90, 0.9) 75%,
                rgba(65, 85, 100, 0.95) 100%
            ) !important;

            border-color: rgba(160, 180, 200, 0.4) !important;
            box-shadow:
                0 2px 12px rgba(20, 30, 40, 0.4),
                0 4px 24px rgba(10, 20, 30, 0.3),
                inset 0 1px 0 rgba(160, 180, 200, 0.3),
                inset 0 -1px 0 rgba(20, 30, 40, 0.5) !important;
        }

        .ert-speech-button[data-bg="dark"] svg {
            stroke: rgba(180, 200, 220, 0.9) !important;
            filter: drop-shadow(0 0 1px rgba(180, 200, 220, 0.3)) !important;
        }

        /* Dark background active states keep light icons */
        .ert-speech-button[data-bg="dark"].listening svg,
        .ert-speech-button[data-bg="dark"].listening svg path,
        .ert-speech-button[data-bg="dark"].translating svg,
        .ert-speech-button[data-bg="dark"].translating svg path,
        .ert-speech-button[data-bg="dark"].success svg,
        .ert-speech-button[data-bg="dark"].success svg path {
            stroke: rgba(220, 240, 255, 0.98) !important;
            filter: drop-shadow(0 0 4px rgba(220, 240, 255, 0.6)) !important;
        }

        /* Hover-Only Button Group - Perfect Circles */
        .ert-hover-buttons {
            position: absolute !important;
            right: 42px !important;
            top: 50% !important;
            transform: translateY(-50%) translateX(12px) !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            z-index: 2147483647 !important;
            opacity: 0 !important;
            pointer-events: none !important;
            transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1) !important;
        }

        .ert-field-wrapper:hover .ert-hover-buttons,
        .ert-field-wrapper:focus-within .ert-hover-buttons {
            opacity: 1 !important;
            pointer-events: auto !important;
            transform: translateY(-50%) translateX(0) !important;
        }

        /* Individual Hover Buttons - Perfect Circles with Aurora Metal */
        .ert-hover-button {
            width: 24px !important;
            height: 24px !important;
            border: none !important;
            border-radius: 50% !important;
            cursor: pointer !important;
            transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1) !important;

            /* Aurora Metal Styling */
            background: linear-gradient(145deg,
                rgba(245, 248, 252, 0.92) 0%,
                rgba(230, 240, 250, 0.88) 25%,
                rgba(215, 235, 248, 0.82) 50%,
                rgba(200, 230, 245, 0.88) 75%,
                rgba(220, 240, 250, 0.92) 100%
            ) !important;

            box-shadow:
                0 2px 10px rgba(140, 180, 220, 0.2),
                0 4px 20px rgba(160, 200, 240, 0.12),
                inset 0 1px 0 rgba(255, 255, 255, 0.5),
                inset 0 -1px 0 rgba(140, 180, 220, 0.15) !important;

            backdrop-filter: blur(15px) saturate(160%) !important;
            border: 1px solid rgba(140, 180, 220, 0.25) !important;
            color: rgba(60, 80, 100, 0.85) !important;

            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
        }

        .ert-hover-button:hover {
            background: linear-gradient(145deg,
                rgba(240, 245, 252, 0.95) 0%,
                rgba(220, 235, 250, 0.92) 25%,
                rgba(200, 230, 248, 0.88) 50%,
                rgba(180, 225, 245, 0.92) 75%,
                rgba(210, 235, 250, 0.95) 100%
            ) !important;

            box-shadow:
                0 4px 16px rgba(140, 180, 220, 0.3),
                0 8px 32px rgba(160, 200, 240, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.7),
                inset 0 -1px 0 rgba(140, 180, 220, 0.25) !important;

            transform: scale(1.12) !important;
            border-color: rgba(140, 180, 220, 0.4) !important;
        }

        .ert-hover-button:active {
            background: linear-gradient(145deg,
                rgba(210, 225, 240, 0.88) 0%,
                rgba(190, 215, 235, 0.82) 50%,
                rgba(170, 205, 230, 0.88) 100%
            ) !important;

            box-shadow:
                0 1px 4px rgba(140, 180, 220, 0.3),
                inset 0 2px 3px rgba(140, 180, 220, 0.25),
                inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;

            transform: scale(0.94) !important;
        }

        /* Aurora Metal Icon Styling for Hover Buttons */
        .ert-hover-button svg {
            width: 11px !important;
            height: 11px !important;
            stroke: rgba(60, 80, 100, 0.8) !important;
            fill: none !important;
            stroke-width: 2.2 !important;
            stroke-linecap: round !important;
            transition: all 0.3s ease !important;
            opacity: 0.85 !important;
            filter: drop-shadow(0 0 1px rgba(140, 180, 220, 0.3)) !important;
        }

        .ert-hover-button:hover svg {
            stroke: rgba(30, 50, 70, 0.95) !important;
            opacity: 1 !important;
            filter: drop-shadow(0 0 2px rgba(140, 180, 220, 0.5)) !important;
        }

        /* Clear Button Special Aurora Effect */
        .ert-clear:hover svg {
            transform: rotate(90deg) !important;
            stroke: rgba(255, 100, 80, 0.9) !important;
            filter: drop-shadow(0 0 3px rgba(255, 140, 120, 0.4)) !important;
        }

        .ert-clear:hover {
            background: linear-gradient(145deg,
                rgba(255, 240, 238, 0.95) 0%,
                rgba(250, 220, 215, 0.9) 50%,
                rgba(245, 200, 195, 0.95) 100%
            ) !important;
            border-color: rgba(255, 140, 120, 0.4) !important;
        }

        /* Aurora Activity States - No Red/Green */
        .ert-speech-button.listening {
            animation: aurora-listening 3s infinite ease-in-out !important;
            background: linear-gradient(145deg,
                rgba(200, 230, 255, 0.95) 0%,
                rgba(180, 220, 250, 0.9) 25%,
                rgba(160, 210, 245, 0.85) 50%,
                rgba(140, 200, 240, 0.9) 75%,
                rgba(170, 215, 248, 0.95) 100%
            ) !important;
        }

        .ert-speech-button.listening svg {
            animation: auroraWave 2.5s ease-in-out infinite !important;
        }

        .ert-speech-button.translating {
            animation: aurora-translating 2s infinite linear !important;
            background: linear-gradient(145deg,
                rgba(220, 240, 255, 0.95) 0%,
                rgba(200, 230, 250, 0.9) 25%,
                rgba(180, 220, 245, 0.85) 50%,
                rgba(160, 210, 240, 0.9) 75%,
                rgba(190, 225, 248, 0.95) 100%
            ) !important;
        }

        .ert-speech-button.success {
            animation: aurora-success 0.8s ease-out !important;
            background: linear-gradient(145deg,
                rgba(210, 245, 255, 0.95) 0%,
                rgba(190, 235, 250, 0.9) 25%,
                rgba(170, 225, 245, 0.85) 50%,
                rgba(150, 215, 240, 0.9) 75%,
                rgba(180, 230, 248, 0.95) 100%
            ) !important;
        }

        .ert-speech-button.error {
            animation: aurora-error 0.6s ease-in-out !important;
            background: linear-gradient(145deg,
                rgba(255, 230, 220, 0.95) 0%,
                rgba(250, 215, 200, 0.9) 50%,
                rgba(245, 200, 180, 0.95) 100%
            ) !important;
        }

        /* Individual Aurora Wave Lines for Synthesis */
        .ert-speech-button.listening svg .line-1 { animation: auroraWave 2.5s ease-in-out infinite 0s; }
        .ert-speech-button.listening svg .line-2 { animation: auroraWave 2.5s ease-in-out infinite 0.15s; }
        .ert-speech-button.listening svg .line-3 { animation: auroraWave 2.5s ease-in-out infinite 0.3s; }
        .ert-speech-button.listening svg .line-4 { animation: auroraWave 2.5s ease-in-out infinite 0.45s; }
        .ert-speech-button.listening svg .line-5 { animation: auroraWave 2.5s ease-in-out infinite 0.6s; }
        .ert-speech-button.listening svg .line-6 { animation: auroraWave 2.5s ease-in-out infinite 0.75s; }

        /* Enhanced Field Wrapper */
        .ert-field-wrapper {
            position: relative !important;
            display: inline-block !important;
            width: 100% !important;
            transition: all 0.4s cubic-bezier(0.23, 1, 0.32, 1) !important;
        }

        .ert-field-wrapper:hover {
            filter: brightness(1.02) contrast(1.02) saturate(1.05) !important;
        }

        .ert-field-enhanced {
            padding-right: 90px !important;
            transition: all 0.5s cubic-bezier(0.23, 1, 0.32, 1) !important;
            position: relative !important;
        }

        /* FIXED: Prevent highlight on clear - No focus/blur effects on delete */
        .ert-field-enhanced.ert-clearing {
            outline: none !important;
            border-color: inherit !important;
            box-shadow: none !important;
            background: inherit !important;
        }

        /* FIXED: ChatGPT-specific field highlighting improvements */
        [data-testid="textbox"].ert-field-enhanced,
        .ert-field-enhanced[contenteditable="true"] {
            padding-right: 90px !important;
            /* Preserve ChatGPT's original styling */
            border-radius: inherit !important;
            border-color: inherit !important;
            background-color: inherit !important;
        }

        /* ChatGPT specific focus fix */
        [data-testid="textbox"].ert-field-enhanced:focus {
            border-color: inherit !important;
            box-shadow: inherit !important;
            outline: inherit !important;
        }

        /* Prevent focus effects during clearing */
        [data-testid="textbox"].ert-field-enhanced.ert-clearing:focus,
        .ert-field-enhanced.ert-clearing:focus {
            border-color: inherit !important;
            box-shadow: inherit !important;
            outline: inherit !important;
            background: inherit !important;
        }

        /* Aurora Focus Effect - More Subtle for ChatGPT */
        .ert-field-enhanced:focus:not([data-testid="textbox"]):not(.ert-clearing) {
            outline: none !important;
            border-color: rgba(140, 180, 220, 0.6) !important;
            box-shadow:
                0 0 0 1px rgba(140, 180, 220, 0.4),
                0 0 25px 6px rgba(160, 200, 240, 0.2),
                0 0 50px 12px rgba(180, 220, 255, 0.1),
                inset 0 1px 0 rgba(255, 255, 255, 0.3) !important;
            background: linear-gradient(135deg,
                rgba(240, 248, 255, 0.05),
                rgba(220, 235, 250, 0.03)
            ) !important;
        }

        /* Jony Ive Aurora Animations */
        @keyframes aurora-listening {
            0%, 100% {
                opacity: 0.9;
                transform: translateY(-50%) scale(1);
                box-shadow:
                    0 0 20px rgba(140, 200, 255, 0.4),
                    0 0 40px rgba(160, 220, 255, 0.2);
            }
            50% {
                opacity: 1;
                transform: translateY(-50%) scale(1.06);
                box-shadow:
                    0 0 30px rgba(140, 200, 255, 0.6),
                    0 0 60px rgba(160, 220, 255, 0.3);
            }
        }

        @keyframes aurora-translating {
            0% { transform: translateY(-50%) rotate(0deg); }
            100% { transform: translateY(-50%) rotate(360deg); }
        }

        @keyframes aurora-success {
            0%, 20%, 40%, 60%, 80%, 100% { transform: translateY(-50%) scale(1); }
            10%, 30%, 50%, 70%, 90% { transform: translateY(-50%) scale(1.15); }
        }

        @keyframes aurora-error {
            0%, 100% { transform: translateY(-50%) translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateY(-50%) translateX(-2px); }
            20%, 40%, 60%, 80% { transform: translateY(-50%) translateX(2px); }
        }

        /* Responsive Design */
        @media (max-width: 768px) {
            .ert-speech-button {
                width: 22px !important;
                height: 22px !important;
                right: 10px !important;
            }

            .ert-speech-button svg {
                width: 12px !important;
                height: 12px !important;
            }

            .ert-hover-buttons {
                right: 36px !important;
                gap: 6px !important;
            }

            .ert-hover-button {
                width: 20px !important;
                height: 20px !important;
            }

            .ert-hover-button svg {
                width: 9px !important;
                height: 9px !important;
            }

            .ert-field-enhanced {
                padding-right: 75px !important;
            }
        }

        /* Accessibility & Reduced Motion */
        .ert-speech-button:focus,
        .ert-hover-button:focus {
            outline: 2px solid rgba(140, 180, 220, 0.8) !important;
            outline-offset: 3px !important;
        }

        @media (prefers-reduced-motion: reduce) {
            .ert-speech-button,
            .ert-hover-button,
            .ert-field-enhanced,
            .ert-hover-buttons {
                transition: none !important;
                animation: none !important;
            }
        }
    `);

    // ===== TRANSLATION SERVICE =====
    const TranslationService = {
        async translateText(text, targetLang = 'en', sourceLang = 'auto') {
            return new Promise((resolve, reject) => {
                const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 15000,
                    onload: (response) => {
                        try {
                            const result = JSON.parse(response.responseText);
                            const translation = result[0]?.map(item => item[0]).join('') || '';
                            const detectedLang = result[2] || sourceLang;

                            if (translation && translation !== text) {
                                resolve({
                                    translatedText: translation,
                                    detectedLanguage: detectedLang,
                                    service: 'Google Translate'
                                });
                            } else {
                                reject(new Error('No translation needed or available'));
                            }
                        } catch (error) { reject(error); }
                    },
                    onerror: reject, ontimeout: reject
                });
            });
        }
    };

    // ===== FIELD VALUE MANAGER =====
    const FieldManager = {
        setValue(field, value) {
            safeExecute(() => {
                if (field.contentEditable === 'true') {
                    field.textContent = value;
                } else {
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

                    if (field.tagName.toLowerCase() === 'input' && nativeInputValueSetter) {
                        nativeInputValueSetter.call(field, value);
                    } else if (field.tagName.toLowerCase() === 'textarea' && nativeTextAreaValueSetter) {
                        nativeTextAreaValueSetter.call(field, value);
                    } else {
                        field.value = value;
                    }
                }
                this.dispatchEvents(field);
            });
        },

        getValue(field) {
            if (field.contentEditable === 'true') {
                return field.textContent || field.innerText || '';
            }
            return field.value || '';
        },

        dispatchEvents(field) {
            ['input', 'change', 'keyup', 'blur'].forEach(type => {
                const event = new Event(type, { bubbles: true, cancelable: true });
                field.dispatchEvent(event);
            });

            // React-specific events
            const reactEvent = new Event('input', { bubbles: true });
            Object.defineProperty(reactEvent, 'target', { value: field, enumerable: true });
            field.dispatchEvent(reactEvent);
        },

        // FIXED: Clear field without triggering highlight
        clearField(field) {
            // Add clearing class to prevent focus effects
            field.classList.add('ert-clearing');

            // Clear the value
            this.setValue(field, '');

            // Remove clearing class after a brief delay
            setTimeout(() => {
                field.classList.remove('ert-clearing');
            }, 50);

            // Don't focus the field to prevent highlight
            // field.focus(); // REMOVED THIS LINE
        },

        capitalizeText(field) {
            const text = this.getValue(field);
            if (text.trim()) this.setValue(field, text.toUpperCase());
        }
    };

    // ===== ENHANCED SPEECH SERVICES WITH LONGER WAIT TIME =====
    const SpeechService = {
        async speak(text, lang = 'en-US') {
            return new Promise((resolve, reject) => {
                if (!text.trim()) return reject(new Error('No text to speak'));

                speechSynthesis.cancel();

                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = lang;
                utterance.rate = 0.9;
                utterance.pitch = 1.0;
                utterance.volume = 1.0;

                utterance.onend = () => {
                    State.isSpeaking = false;
                    resolve();
                };

                utterance.onerror = (error) => {
                    State.isSpeaking = false;
                    reject(error);
                };

                State.isSpeaking = true;
                speechSynthesis.speak(utterance);
            });
        },

        startRecognition(field, button) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) {
                this.showFeedback(button, 'error');
                return;
            }

            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'ru-RU';
            recognition.maxAlternatives = 1;

            State.isListening = true;
            State.recognition = recognition;
            button.classList.add('listening');

            let finalTranscript = '';
            let lastSpeechTime = Date.now();
            let silenceTimeout;

            if (State.speechTimeout) clearTimeout(State.speechTimeout);
            if (State.silenceTimer) clearTimeout(State.silenceTimer);

            recognition.onresult = async (event) => {
                let interimTranscript = '';
                lastSpeechTime = Date.now();

                if (silenceTimeout) {
                    clearTimeout(silenceTimeout);
                    silenceTimeout = null;
                }

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcript + ' ';
                    } else {
                        interimTranscript += transcript;
                    }
                }

                const currentText = finalTranscript + interimTranscript;
                if (currentText.trim()) {
                    FieldManager.setValue(field, currentText.trim());
                }

                silenceTimeout = setTimeout(() => {
                    const timeSinceLastSpeech = Date.now() - lastSpeechTime;
                    if (timeSinceLastSpeech >= 2500 && finalTranscript.trim()) {
                        this.endRecognition(recognition, button, field, finalTranscript);
                    }
                }, 2500);
            };

            recognition.onend = () => {
                if (State.isListening) {
                    this.endRecognition(recognition, button, field, finalTranscript);
                }
            };

            recognition.onerror = (error) => {
                console.warn('Speech recognition error:', error);
                if (error.error === 'no-speech' || error.error === 'audio-capture') {
                    return;
                }

                State.isListening = false;
                State.recognition = null;
                button.classList.remove('listening');
                this.showFeedback(button, 'error');

                if (silenceTimeout) clearTimeout(silenceTimeout);
                if (State.speechTimeout) clearTimeout(State.speechTimeout);
            };

            try {
                recognition.start();

                State.speechTimeout = setTimeout(() => {
                    if (State.isListening) {
                        this.endRecognition(recognition, button, field, finalTranscript);
                    }
                }, 30000);

            } catch (error) {
                State.isListening = false;
                State.recognition = null;
                button.classList.remove('listening');
                this.showFeedback(button, 'error');
            }
        },

        async endRecognition(recognition, button, field, finalTranscript) {
            State.isListening = false;
            State.recognition = null;
            button.classList.remove('listening');

            if (State.speechTimeout) {
                clearTimeout(State.speechTimeout);
                State.speechTimeout = null;
            }
            if (State.silenceTimer) {
                clearTimeout(State.silenceTimer);
                State.silenceTimer = null;
            }

            try {
                recognition.stop();
            } catch (e) {
                // Recognition might already be stopped
            }

            if (finalTranscript.trim()) {
                try {
                    button.classList.add('translating');
                    const result = await TranslationService.translateText(finalTranscript.trim(), 'en', 'ru');

                    if (result?.translatedText) {
                        FieldManager.setValue(field, result.translatedText);
                        this.showFeedback(button, 'success');
                    } else {
                        FieldManager.setValue(field, finalTranscript.trim());
                        this.showFeedback(button, 'success');
                    }
                } catch (error) {
                    FieldManager.setValue(field, finalTranscript.trim());
                    this.showFeedback(button, 'success');
                } finally {
                    button.classList.remove('translating');
                }
            } else {
                this.showFeedback(button, 'error');
            }
        },

        showFeedback(element, type) {
            element.classList.remove('listening', 'translating', 'success', 'error');
            element.classList.add(type);
            if (!['listening', 'translating'].includes(type)) {
                setTimeout(() => element.classList.remove(type), 2000);
            }
        }
    };

    // ===== FIELD DETECTION =====
    const FieldDetector = {
        selectors: [
            'input[type="text"]:not([readonly]):not([disabled])',
            'input[type="email"]:not([readonly]):not([disabled])',
            'input[type="search"]:not([readonly]):not([disabled])',
            'input:not([type]):not([readonly]):not([disabled])',
            'textarea:not([readonly]):not([disabled])',
            '[contenteditable="true"]',
            '[role="textbox"]:not([readonly]):not([disabled])'
        ],

        findFields() {
            const fields = [];
            this.selectors.forEach(selector => {
                safeExecute(() => {
                    document.querySelectorAll(selector).forEach(el => {
                        if (this.shouldProcess(el)) fields.push(el);
                    });
                });
            });
            return [...new Set(fields)];
        },

        shouldProcess(element) {
            try {
                if (State.processedFields.has(element) &&
                    !element.classList.contains('ert-field-enhanced') &&
                    !element.closest('.ert-field-wrapper')) {
                    State.processedFields.delete(element);
                    element.dataset.ertProcessed = 'false';
                }

                if (State.processedFields.has(element) ||
                    element.dataset.ertProcessed === 'true' ||
                    element.closest('.ert-field-wrapper')) return false;

                if (['SVG', 'IMG', 'BUTTON'].includes(element.tagName) ||
                    element.type === 'password' || element.disabled || element.readOnly) return false;

                const rect = element.getBoundingClientRect();
                if (rect.width < 50 || rect.height < 20) return false;

                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

                return true;
            } catch { return false; }
        }
    };

    // ===== UI BUILDER WITH JONY IVE AURORA STYLING =====
    const UIBuilder = {
        createIcon(field) {
            if (State.processedFields.has(field)) return null;

            this.wrapField(field);
            const wrapper = field.closest('.ert-field-wrapper');
            if (!wrapper) return null;

            const speechButton = this.createSpeechButton(field);
            const hoverButtons = this.createHoverButtons(field);

            const bgType = detectBackgroundBrightness(field);
            speechButton.setAttribute('data-bg', bgType);
            hoverButtons.querySelectorAll('.ert-hover-button').forEach(button => {
                button.setAttribute('data-bg', bgType);
            });

            wrapper.appendChild(speechButton);
            wrapper.appendChild(hoverButtons);

            field.classList.add('ert-field-enhanced');
            field.dataset.ertProcessed = 'true';
            State.processedFields.add(field);
            State.iconCount++;

            return speechButton;
        },

        wrapField(field) {
            if (field.closest('.ert-field-wrapper')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'ert-field-wrapper';
            field.parentNode.insertBefore(wrapper, field);
            wrapper.appendChild(field);
        },

        createSpeechButton(field) {
            const button = document.createElement('button');
            button.className = 'ert-speech-button';
            button.innerHTML = document.implementation.hasFeature("http://www.w3.org/TR/SVG11/feature#BasicStructure", "1.1") ?
                             SynthesisIcon : FallbackSynthesisIcon;
            button.title = 'Empty: Russian Speech → English Text (2.5s silence wait) | Text: Russian → English Translation';
            button.setAttribute('type', 'button');
            button.setAttribute('aria-label', 'Speech Recognition or Translate');

            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleMainSpeechAction(field, button);
            });

            return button;
        },

        createHoverButtons(field) {
            const container = document.createElement('div');
            container.className = 'ert-hover-buttons';

            const isSVGSupported = document.implementation.hasFeature("http://www.w3.org/TR/SVG11/feature#BasicStructure", "1.1");

            const buttons = [
                {
                    icon: isSVGSupported ? CapitalizeIcon : FallbackCapitalizeIcon,
                    title: 'Capitalize',
                    className: 'ert-hover-button-capitalize',
                    action: () => FieldManager.capitalizeText(field)
                },
                {
                    icon: isSVGSupported ? SpeakIcon : FallbackSpeakIcon,
                    title: 'Translate to Russian & Speak',
                    className: 'ert-hover-button-speak',
                    action: () => this.handleSpeakerButton(field)
                },
                {
                    icon: isSVGSupported ? ClearIcon : FallbackClearIcon,
                    title: 'Clear Field',
                    className: 'ert-hover-button-clear ert-clear',
                    action: (e) => {
                        // FIXED: Prevent any focus/highlight effects during clear
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        // Prevent field from getting focus
                        field.blur();

                        // Clear without triggering highlight
                        FieldManager.clearField(field);

                        // Ensure no focus after clear
                        setTimeout(() => {
                            field.blur();
                            document.activeElement?.blur();
                        }, 10);
                    }
                }
            ];

            buttons.forEach(({ icon, title, className, action }) => {
                const btn = document.createElement('button');
                btn.className = `ert-hover-button ${className}`;
                btn.innerHTML = icon;
                btn.title = title;
                btn.setAttribute('type', 'button');
                btn.setAttribute('aria-label', title);
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof action === 'function') {
                        if (className.includes('clear')) {
                            action(e); // Pass event for clear button
                        } else {
                            action();
                        }
                    }
                });
                container.appendChild(btn);
            });

            return container;
        },

        async handleMainSpeechAction(field, button) {
            const text = FieldManager.getValue(field).trim();

            if (!text) {
                SpeechService.startRecognition(field, button);
            } else {
                await this.translateRussianToEnglish(field, button);
            }
        },

        async handleSpeakerButton(field) {
            const text = FieldManager.getValue(field).trim();
            if (!text) return;

            try {
                const result = await TranslationService.translateText(text, 'ru', 'en');

                if (result?.translatedText) {
                    await SpeechService.speak(result.translatedText, 'ru-RU');
                } else {
                    const detectedLang = LanguageDetector.detectLanguage(text);
                    const speechLang = detectedLang === 'ru' ? 'ru-RU' : 'en-US';
                    await SpeechService.speak(text, speechLang);
                }
            } catch (error) {
                try {
                    const detectedLang = LanguageDetector.detectLanguage(text);
                    const speechLang = detectedLang === 'ru' ? 'ru-RU' : 'en-US';
                    await SpeechService.speak(text, speechLang);
                } catch (speechError) {
                    console.warn('Speech failed:', speechError);
                }
            }
        },

        async translateRussianToEnglish(field, button) {
            const text = FieldManager.getValue(field).trim();
            if (!text) return;

            try {
                State.isTranslating = true;
                button.classList.add('translating');

                const result = await TranslationService.translateText(text, 'en', 'ru');

                if (result?.translatedText) {
                    FieldManager.setValue(field, result.translatedText);
                    SpeechService.showFeedback(button, 'success');
                } else {
                    SpeechService.showFeedback(button, 'success');
                }
            } catch (error) {
                SpeechService.showFeedback(button, 'error');
            } finally {
                State.isTranslating = false;
                button.classList.remove('translating');
            }
        }
    };

    // ===== PROCESSOR WITH ENHANCED REACT SUPPORT =====
    const Processor = {
        processFields() {
            if (State.isProcessing) return 0;
            State.isProcessing = true;

            try {
                const fields = FieldDetector.findFields();
                let processed = 0;
                fields.forEach(field => {
                    if (UIBuilder.createIcon(field)) processed++;
                });
                return processed;
            } finally {
                State.isProcessing = false;
            }
        },

        setupObserver() {
            if (!window.MutationObserver) return;

            const observer = new MutationObserver(debounce(() => {
                State.processedElements.forEach((data, id) => {
                    if (!document.body.contains(data.element)) {
                        State.processedFields.delete(data.element);
                        State.processedElements.delete(id);
                        State.iconCount = Math.max(0, State.iconCount - 1);
                    }
                });

                this.processFields();
            }, 200));

            observer.observe(document.body, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['style', 'class', 'data-reactroot', 'hidden']
            });

            State.observers.push(observer);
            this.setupReactMonitoring();
        },

        setupReactMonitoring() {
            let currentUrl = window.location.href;
            const urlMonitor = setInterval(() => {
                if (window.location.href !== currentUrl) {
                    currentUrl = window.location.href;
                    setTimeout(() => this.processFields(), 500);
                    setTimeout(() => this.processFields(), 1500);
                }
            }, 1000);
            State.intervals.push(urlMonitor);

            if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
                const original = window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot;
                window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = (...args) => {
                    if (original) original.apply(this, args);
                    setTimeout(() => this.processFields(), 50);
                };
            }

            const originalReactError = window.onerror;
            window.onerror = (message, source, lineno, colno, error) => {
                if (message && message.includes('Minified React error')) {
                    setTimeout(() => this.processFields(), 100);
                }
                if (originalReactError) return originalReactError(message, source, lineno, colno, error);
            };
        }
    };

    // ===== INITIALIZATION =====
    function initialize() {
        console.log('ETA: Initializing Fixed Delete Highlight & Dark Icon Version...');

        Processor.setupObserver();

        [50, 200, 800, 2000, 4000].forEach((delay, i) => {
            setTimeout(() => {
                const processed = Processor.processFields();
                if (processed > 0) {
                    console.log(`ETA: Enhanced ${processed} fields (scan ${i + 1})`);
                }
            }, delay);
        });

        const monitor = setInterval(() => {
            if (!State.isProcessing) {
                const processed = Processor.processFields();
                if (processed > 0) {
                    console.log(`ETA: Recovered ${processed} fields from React update`);
                }
            }
        }, 3000);
        State.intervals.push(monitor);

        window.addEventListener('beforeunload', () => {
            State.intervals.forEach(clearInterval);
            State.observers.forEach(observer => observer.disconnect());
            if (State.recognition) State.recognition.stop();
            if (State.speechTimeout) clearTimeout(State.speechTimeout);
            if (State.silenceTimer) clearTimeout(State.silenceTimer);
            speechSynthesis.cancel();
        });
    }

    // ===== STARTUP =====
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoader', initialize);
    } else {
        setTimeout(initialize, 100);
    }

})();
