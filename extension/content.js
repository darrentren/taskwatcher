// Task Watcher – Google Meet Caption Monitor
// Runs on meet.google.com, reads live captions, sends to localhost:3747

const SERVER = 'http://127.0.0.1:3747';
const seen = new Set();
let meetActive = false;
let captionObserver = null;
let currentSpeaker = '';

function post(endpoint, data) {
    fetch(`${SERVER}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(r => {
        if (!r.ok) console.warn('[TaskWatcher] Server responded', r.status, endpoint);
    }).catch(e => console.warn('[TaskWatcher] Cannot reach server:', e.message));
}

// URL pattern: meet.google.com/xxx-xxx-xxx means we're in a call
function isInCall() {
    // More permissive: allow letters/numbers, any segment length, case-insensitive
    return /meet\.google\.com\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(location.href)
        || /meet\.google\.com\/lookup\//i.test(location.href);
}

// Try multiple selectors to find speaker names near a node
function findSpeakerNear(el) {
    if (!el) return '';
    let parent = el.parentElement;
    for (let depth = 0; depth < 8 && parent; depth++) {
        // Google Meet puts speaker name in a label-like element near caption text
        const candidates = parent.querySelectorAll('[data-self-name], [data-participant-id], [aria-label]');
        for (const c of candidates) {
            const label = c.getAttribute('aria-label') || c.getAttribute('data-self-name') || '';
            if (label && label.length < 60 && !label.includes('Turn') && !label.includes('button')) {
                return label.split(' is speaking')[0].trim();
            }
        }
        // Also check direct text of short sibling elements that look like names
        const siblings = parent.querySelectorAll('span, div');
        for (const s of siblings) {
            const t = s.textContent.trim();
            if (t.length > 1 && t.length < 40 && !t.includes(' ') || /^[\w]+ [\w]+$/.test(t)) {
                if (s !== el && !s.contains(el)) {
                    const style = window.getComputedStyle(s);
                    if (style.fontWeight >= 600 || style.fontWeight === 'bold') {
                        return t;
                    }
                }
            }
        }
        parent = parent.parentElement;
    }
    return currentSpeaker;
}

// Caption buffer to batch sends and reduce noise
let captionBuffer = [];
let flushTimer = null;

function queueCaption(text, speaker) {
    if (!text || text.length < 3 || seen.has(text)) return;
    seen.add(text);
    if (seen.size > 200) {
        // Keep only last 50 to prevent memory growth
        const arr = [...seen].slice(-50);
        seen.clear();
        arr.forEach(v => seen.add(v));
    }
    captionBuffer.push({ text, speaker: speaker || 'Unknown', time: new Date().toISOString() });

    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        const batch = captionBuffer.splice(0);
        if (batch.length > 0) {
            post('/api/meet/caption', { captions: batch });
        }
    }, 400);
}

// Observe all DOM mutations and look for aria-live caption updates
function startCaptionObserver() {
    if (captionObserver) captionObserver.disconnect();

    captionObserver = new MutationObserver((mutations) => {
        if (!isInCall()) return;

        for (const m of mutations) {
            // Text node changed directly
            if (m.type === 'characterData') {
                const text = m.target.textContent.trim();
                const speaker = findSpeakerNear(m.target.parentElement);
                if (text) queueCaption(text, speaker);
                continue;
            }

            // New nodes added
            for (const node of m.addedNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent.trim();
                    if (text) queueCaption(text, findSpeakerNear(node.parentElement));
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    // Look for aria-live containers (Google Meet uses these for captions)
                    const liveEls = [
                        ...(node.getAttribute?.('aria-live') ? [node] : []),
                        ...node.querySelectorAll('[aria-live]')
                    ];

                    for (const liveEl of liveEls) {
                        const text = liveEl.textContent.trim();
                        if (text.length > 2) {
                            queueCaption(text, findSpeakerNear(liveEl));
                        }
                    }

                    // Also look for text in nodes that look like captions
                    // (short blocks of text, appearing in the bottom portion of screen)
                    const rect = node.getBoundingClientRect?.();
                    if (rect && rect.top > window.innerHeight * 0.5) {
                        const text = node.textContent?.trim();
                        if (text && text.length > 5 && text.length < 300) {
                            queueCaption(text, findSpeakerNear(node));
                        }
                    }
                }
            }
        }
    });

    captionObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: false
    });
}

// Monitor call state changes (join / leave)
function monitorCallState() {
    const check = () => {
        const inCall = isInCall();
        if (inCall !== meetActive) {
            meetActive = inCall;
            post('/api/meet/status', {
                joined: inCall,
                title: document.title.replace(' - Google Meet', '').trim(),
                url: location.href,
                time: new Date().toISOString()
            });
            console.log(`[TaskWatcher] Meet ${inCall ? 'joined' : 'left'}: ${document.title}`);
        }
    };

    check();
    setInterval(check, 2000);

    // Catch SPA navigation
    const origPush = history.pushState.bind(history);
    history.pushState = (...args) => { origPush(...args); setTimeout(check, 600); };
    window.addEventListener('popstate', () => setTimeout(check, 600));
}

// Go
startCaptionObserver();
monitorCallState();
console.log('[TaskWatcher] Meet monitor active');
