// ═══════════════════════════════════════════════════════════════════════════════
// Rolenaut Resilient Auth Core — Persistent, Synchronous & Unified Session Manager
// Ensures zero-flicker session hydration on reload and standardizes top-right UI
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
    // State latch: prevents Netlify Identity widget's in-memory user from resurrecting during async logout
    let isExplicitlyLoggedOut = false;

    // 1. Synchronously retrieve user from localStorage to eliminate refresh flicker
    function getStoredUser() {
        if (isExplicitlyLoggedOut) return null;

        try {
            const raw = localStorage.getItem('gotrue.user');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && (parsed.email || parsed.id)) return parsed;
            }
        } catch (e) {}

        try {
            const rolenautCached = localStorage.getItem('rolenaut_cached_user');
            if (rolenautCached) {
                const parsed = JSON.parse(rolenautCached);
                if (parsed && (parsed.email || parsed.id)) {
                    if (!parsed.display_name && localStorage.getItem('rolenaut_display_name')) {
                        parsed.display_name = localStorage.getItem('rolenaut_display_name');
                    }
                    return parsed;
                }
            }
        } catch (e) {}

        try {
            const cached = localStorage.getItem('jb_cached_user');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && (parsed.email || parsed.id)) return parsed;
            }
        } catch (e) {}

        try {
            const rolenautSession = localStorage.getItem('rolenaut_user_session');
            if (rolenautSession) {
                const p = JSON.parse(rolenautSession);
                if (p && (p.email || p.id)) return p;
            }
        } catch (e) {}

        try {
            const legacy = localStorage.getItem('jobbuddy_user_session');
            if (legacy) {
                const parsed = JSON.parse(legacy);
                if (parsed && (parsed.email || parsed.id)) return parsed;
            }
        } catch (e) {}

        if (window.netlifyIdentity && typeof window.netlifyIdentity.currentUser === 'function') {
            const current = window.netlifyIdentity.currentUser();
            if (current) return current;
        }
        return null;
    }

    // 2. Retrieve JWT access token with fallback to stored token and proactive refresh
    async function getAuthToken() {
        if (isExplicitlyLoggedOut) return null;

        // If netlifyIdentity widget is still loading during early boot, wait briefly
        if (!window.netlifyIdentity && typeof window !== 'undefined') {
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 50));
                if (window.netlifyIdentity) break;
            }
        }

        if (window.netlifyIdentity && typeof window.netlifyIdentity.currentUser === 'function') {
            const current = window.netlifyIdentity.currentUser();
            if (current && typeof current.jwt === 'function') {
                try {
                    const t = await current.jwt();
                    if (t) {
                        if (current.token) persistUserCache(current);
                        return t;
                    }
                } catch (e) {
                    try {
                        const fallback = current.token && current.token.access_token;
                        if (fallback) return fallback;
                    } catch (err) {}
                }
            }
        }
        try {
            const raw = localStorage.getItem('gotrue.user');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.token && parsed.token.access_token) {
                    const exp = parsed.token.expires_at;
                    const expMs = exp ? (exp > 1e11 ? exp : exp * 1000) : 0;
                    const isExpired = expMs > 0 && (Date.now() > expMs);

                    // If token is expired and refresh_token exists, attempt direct GoTrue refresh
                    if (isExpired && parsed.token.refresh_token) {
                        try {
                            const res = await fetch('/.netlify/identity/token', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: new URLSearchParams({
                                    grant_type: 'refresh_token',
                                    refresh_token: parsed.token.refresh_token
                                })
                            });
                            if (res.ok) {
                                const newTok = await res.json();
                                if (newTok && newTok.access_token) {
                                    parsed.token.access_token = newTok.access_token;
                                    parsed.token.refresh_token = newTok.refresh_token || parsed.token.refresh_token;
                                    parsed.token.expires_at = Date.now() + (newTok.expires_in || 3600) * 1000;
                                    localStorage.setItem('gotrue.user', JSON.stringify(parsed));
                                    persistUserCache(parsed);
                                    return newTok.access_token;
                                }
                            }
                        } catch (refreshErr) {
                            console.warn('[RolenautAuth] Direct GoTrue token refresh notice:', refreshErr && refreshErr.message);
                        }
                    }
                    return parsed.token.access_token;
                }
            }
        } catch (e) {}
        try {
            const rolenautCached = localStorage.getItem('rolenaut_cached_user');
            if (rolenautCached) {
                const parsed = JSON.parse(rolenautCached);
                if (parsed && parsed.token && parsed.token.access_token) {
                    return parsed.token.access_token;
                }
            }
        } catch (e) {}
        try {
            const cached = localStorage.getItem('jb_cached_user');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.token && parsed.token.access_token) {
                    return parsed.token.access_token;
                }
            }
        } catch (e) {}

        // Fallback for local session validation only
        const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const stored = getStoredUser();
        if (isLocalHost && stored && stored.email) {
            return "dev_token_" + btoa(stored.email);
        }
        return null;
    }

    // 3. Persist user session to cache (synchronous write with backward-compatible mirrors)
    function persistUserCache(user) {
        if (!user) {
            localStorage.removeItem('rolenaut_cached_user');
            localStorage.removeItem('jb_cached_user');
            localStorage.removeItem('gotrue.user');
            localStorage.removeItem('rolenaut_user_session');
            localStorage.removeItem('jobbuddy_user_session');
            localStorage.removeItem('rolenaut_custom_mongo_uri');
            localStorage.removeItem('jobbuddy_custom_mongo_uri');
            localStorage.removeItem('rolenaut_display_name');
            return;
        }
        const savedDisplayName = localStorage.getItem('rolenaut_display_name') || user.display_name || (user.user_metadata && (user.user_metadata.display_name || user.user_metadata.full_name)) || '';
        if (user.user_metadata && savedDisplayName) {
            user.user_metadata.display_name = savedDisplayName;
            user.user_metadata.full_name = savedDisplayName;
        }
        const cache = {
            id: user.id || ('usr_' + btoa(user.email).replace(/=/g, '').slice(0, 16)),
            email: user.email,
            display_name: savedDisplayName,
            user_metadata: user.user_metadata || {},
            token: user.token || {}
        };
        try {
            if (savedDisplayName) localStorage.setItem('rolenaut_display_name', savedDisplayName);
            localStorage.setItem('rolenaut_cached_user', JSON.stringify(cache));
            localStorage.setItem('jb_cached_user', JSON.stringify(cache));
            localStorage.setItem('rolenaut_user_session', JSON.stringify({ id: cache.id, email: user.email, display_name: savedDisplayName }));
            localStorage.setItem('jobbuddy_user_session', JSON.stringify({ id: cache.id, email: user.email, display_name: savedDisplayName }));
        } catch (e) {}
    }

    async function setDisplayName(name) {
        const cleanName = String(name || '').trim();
        if (!cleanName) return;

        localStorage.setItem('rolenaut_display_name', cleanName);
        const user = getStoredUser();
        if (user) {
            user.display_name = cleanName;
            if (!user.user_metadata) user.user_metadata = {};
            user.user_metadata.display_name = cleanName;
            user.user_metadata.full_name = cleanName;
            persistUserCache(user);
        }
        renderAuthHeader();

        // Two-way sync: persist display_name and full_name to Netlify Identity GoTrue cloud metadata
        try {
            if (window.netlifyIdentity && typeof window.netlifyIdentity.currentUser === 'function') {
                const idUser = window.netlifyIdentity.currentUser();
                if (idUser && typeof idUser.update === 'function') {
                    const updatedUser = await idUser.update({
                        data: {
                            display_name: cleanName,
                            full_name: cleanName
                        }
                    });
                    if (updatedUser) {
                        persistUserCache(updatedUser);
                    }
                }
            }
        } catch (err) {
            console.warn('[RolenautAuth] GoTrue metadata cloud sync notice:', err && err.message);
        }

        window.dispatchEvent(new CustomEvent('rolenaut_display_name_change', { detail: { displayName: cleanName } }));
    }

    // Helper: notify auth state changes across all listeners (both modern and legacy events)
    function dispatchAuthEvent(user) {
        const detail = { user };
        window.dispatchEvent(new CustomEvent('rolenaut_auth_change', { detail }));
        window.dispatchEvent(new CustomEvent('jb_auth_change', { detail }));
    }

    // 4. Open Auth Modal reliably
    function openAuthModal(action) {
        isExplicitlyLoggedOut = false;
        if (window.netlifyIdentity) {
            window.netlifyIdentity.open(action || 'login');
        } else {
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                if (window.netlifyIdentity) {
                    clearInterval(timer);
                    window.netlifyIdentity.open(action || 'login');
                } else if (tries > 40) {
                    clearInterval(timer);
                    console.info("Netlify Identity widget initializing or offline.");
                }
            }, 50);
        }
    }

    // 5. Logout reliably
    function logoutUser() {
        isExplicitlyLoggedOut = true;
        persistUserCache(null);
        localStorage.removeItem('rolenaut_custom_mongo_uri');
        localStorage.removeItem('jobbuddy_custom_mongo_uri');
        localStorage.removeItem('rolenaut_display_name');
        localStorage.removeItem('rolenaut_active_stream');
        document.cookie = "nf_jwt=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";

        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && (k.startsWith("rolenaut_cache_") || k.startsWith("jobbuddy_cache_") || k.startsWith("jb_cache_") || k.startsWith("jb_v"))) {
                    localStorage.removeItem(k);
                }
            }
        } catch (e) {}

        const card = document.getElementById('mini-profile-card');
        if (card) card.style.display = 'none';

        if (window.netlifyIdentity && typeof window.netlifyIdentity.logout === 'function') {
            try { window.netlifyIdentity.logout(); } catch (e) {}
        }
        dispatchAuthEvent(null);
        renderAuthHeader();

        // Immediate clean exit: if logged out while on /profile or /onboarding, redirect to home immediately
        if (window.location.pathname.startsWith('/profile') || window.location.pathname.startsWith('/onboarding')) {
            window.location.replace('/');
            return;
        }
        // If on /jobs, reload feed cleanly as guest
        if (window.location.pathname.startsWith('/jobs')) {
            window.location.reload();
        }
    }

    // 6. Toggle Mini-Profile Menu
    function toggleProfileMenu(e) {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        const card = document.getElementById('mini-profile-card');
        const trigger = document.getElementById('user-profile-trigger');
        if (!card) return;
        const isHidden = card.style.display === 'none' || !card.style.display;
        card.style.display = isHidden ? 'block' : 'none';
        if (trigger) {
            trigger.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
        }
    }

    // 7. Open Data Source Modal or navigate to profile
    function openDataSourceModal() {
        const card = document.getElementById('mini-profile-card');
        if (card) card.style.display = 'none';
        if (typeof window.openDbModal === 'function') {
            window.openDbModal();
        } else {
            window.location.href = '/profile#data-source';
        }
    }

    // 8. Reset to Default Stream
    function resetToDefaultStream() {
        const card = document.getElementById('mini-profile-card');
        if (card) card.style.display = 'none';
        if (typeof window.disconnectDatabase === 'function') {
            window.disconnectDatabase();
        } else {
            localStorage.removeItem('rolenaut_custom_mongo_uri');
            localStorage.removeItem('jobbuddy_custom_mongo_uri');
            window.location.reload();
        }
    }

    // Close menus when clicking outside or pressing Escape
    document.addEventListener('click', function (e) {
        const container = document.querySelector('.user-profile-menu-container');
        const card = document.getElementById('mini-profile-card');
        const trigger = document.getElementById('user-profile-trigger');
        if (card && card.style.display !== 'none') {
            if (!container || !container.contains(e.target)) {
                card.style.display = 'none';
                if (trigger) trigger.setAttribute('aria-expanded', 'false');
            }
        }
        const navLinks = document.querySelector('.header-nav-links');
        const mobileBtn = document.getElementById('btn-mobile-nav');
        if (navLinks && navLinks.classList.contains('mobile-open')) {
            if (!navLinks.contains(e.target) && (!mobileBtn || !mobileBtn.contains(e.target))) {
                navLinks.classList.remove('mobile-open');
                if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'false');
            }
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            const card = document.getElementById('mini-profile-card');
            const trigger = document.getElementById('user-profile-trigger');
            if (card && card.style.display !== 'none') {
                card.style.display = 'none';
                if (trigger) {
                    trigger.setAttribute('aria-expanded', 'false');
                    trigger.focus();
                }
            }
            const navLinks = document.querySelector('.header-nav-links');
            if (navLinks && navLinks.classList.contains('mobile-open')) {
                navLinks.classList.remove('mobile-open');
                const mobileBtn = document.getElementById('btn-mobile-nav');
                if (mobileBtn) {
                    mobileBtn.setAttribute('aria-expanded', 'false');
                    mobileBtn.focus();
                }
            }
        }
    });

    function setupMobileNav() {
        const headerActions = document.querySelector('.header-actions');
        const navLinks = document.querySelector('.header-nav-links');
        if (!headerActions || !navLinks || document.getElementById('btn-mobile-nav')) return;

        const btn = document.createElement('button');
        btn.id = 'btn-mobile-nav';
        btn.className = 'btn-mobile-nav-toggle';
        btn.setAttribute('aria-label', 'Toggle Navigation Menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
        btn.onclick = function (e) {
            e.stopPropagation();
            const isOpen = navLinks.classList.toggle('mobile-open');
            btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };

        const authWrapper = document.getElementById('auth-header-wrapper');
        if (authWrapper) {
            headerActions.insertBefore(btn, authWrapper);
        } else {
            headerActions.appendChild(btn);
        }
    }

    // 9. Render Auth Header synchronously
    function renderAuthHeader() {
        const wrapper = document.getElementById('auth-header-wrapper');
        if (!wrapper) return;

        const user = getStoredUser();
        if (!user) {
            wrapper.innerHTML = `
                <button class="btn-header-auth" id="btn-header-signin" onclick="window.RolenautAuth.openModal()" aria-label="Sign In or Register">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                        <circle cx="12" cy="7" r="4"/>
                    </svg>
                    <span>Sign In / Register</span>
                </button>
            `;
            return;
        }

        const email = user.email || 'Candidate';
        const savedDisplayName = localStorage.getItem('rolenaut_display_name') || user.display_name || (user.user_metadata && user.user_metadata.display_name) || '';
        const fullName = (user.user_metadata && user.user_metadata.full_name) || '';
        const displayName = savedDisplayName || fullName || email.split('@')[0] || 'Candidate';
        const initial = displayName.charAt(0).toUpperCase();
        const customUri = (localStorage.getItem('rolenaut_custom_mongo_uri') || localStorage.getItem('jobbuddy_custom_mongo_uri') || '').trim();
        const hasValidCustomUri = customUri && customUri !== '[CONFIGURED]' && customUri.startsWith('mongodb+srv://');
        const activeStream = localStorage.getItem('rolenaut_active_stream') || (hasValidCustomUri ? 'custom' : 'curated');
        const isCustomDb = (activeStream === 'custom') && (hasValidCustomUri || (user.user_metadata && user.user_metadata.has_custom_db));

        wrapper.innerHTML = `
            <div class="user-profile-menu-container">
                <button class="user-profile-pill" id="user-profile-trigger" onclick="window.RolenautAuth.toggleProfileMenu(event)" aria-expanded="false" aria-label="User Account Menu">
                    <span class="user-avatar-circle">${initial}</span>
                    <span class="user-pill-name">${escapeHtml(displayName)}</span>
                    <svg class="chevron-down" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <div class="mini-profile-card" id="mini-profile-card" style="display: none;">
                    <div class="mini-profile-header">
                        <div class="mini-avatar-large">${initial}</div>
                        <div class="mini-user-info" style="min-width: 0;">
                            <div class="mini-user-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</div>
                            <div class="mini-user-email" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(email)}</div>
                        </div>
                    </div>
                    <div class="mini-profile-body">
                        <div class="source-status-block">
                            <div class="source-status-label">Active Data Stream</div>
                            <div class="source-badge ${isCustomDb ? 'custom' : 'default'}">
                                <span class="source-dot"></span>
                                <span>${isCustomDb ? 'Custom Scraper Mongo' : 'Verified Freshers Stream'}</span>
                            </div>
                        </div>
                        <div class="mini-nav-links">
                            <a href="/profile" class="mini-menu-item">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                <span>Profile &amp; Settings</span>
                            </a>
                        </div>
                    </div>
                    <div class="mini-profile-footer">
                        <button class="btn-signout" onclick="window.RolenautAuth.logout()">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                            <span>Sign Out</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 10. Identity listeners setup with retry polling
    let identityInitialized = false;
    let identityRetries = 0;
    function setupIdentityListeners() {
        if (identityInitialized) return;
        if (!window.netlifyIdentity) {
            identityRetries++;
            if (identityRetries < 40) {
                setTimeout(setupIdentityListeners, 50);
            }
            return;
        }
        identityInitialized = true;

        window.netlifyIdentity.on('init', (user) => {
            if (user) isExplicitlyLoggedOut = false;
            const finalUser = user || getStoredUser();
            persistUserCache(finalUser);
            dispatchAuthEvent(finalUser);
            renderAuthHeader();
        });

        window.netlifyIdentity.on('login', (user) => {
            isExplicitlyLoggedOut = false;
            if (window.netlifyIdentity) window.netlifyIdentity.close();
            persistUserCache(user);
            dispatchAuthEvent(user);
            renderAuthHeader();
        });

        window.netlifyIdentity.on('logout', () => {
            isExplicitlyLoggedOut = true;
            persistUserCache(null);
            localStorage.removeItem('rolenaut_custom_mongo_uri');
            localStorage.removeItem('jobbuddy_custom_mongo_uri');
            localStorage.removeItem('rolenaut_display_name');
            localStorage.removeItem('rolenaut_active_stream');
            dispatchAuthEvent(null);
            renderAuthHeader();
            if (window.location.pathname.startsWith('/profile') || window.location.pathname.startsWith('/onboarding')) {
                window.location.replace('/');
            }
        });

        // In case the widget initialized before listeners attached
        const current = window.netlifyIdentity.currentUser();
        if (current && !isExplicitlyLoggedOut) {
            persistUserCache(current);
            dispatchAuthEvent(current);
            renderAuthHeader();
        }
    }

    // Cross-tab synchronization via storage event
    window.addEventListener('storage', (e) => {
        if (e.key === 'gotrue.user' || e.key === 'rolenaut_cached_user') {
            if (!e.newValue) {
                // Another tab logged out
                isExplicitlyLoggedOut = true;
                renderAuthHeader();
                dispatchAuthEvent(null);
                if (window.location.pathname.startsWith('/profile') || window.location.pathname.startsWith('/onboarding')) {
                    window.location.replace('/');
                }
            } else {
                isExplicitlyLoggedOut = false;
                renderAuthHeader();
                dispatchAuthEvent(getStoredUser());
            }
        } else if (e.key === 'rolenaut_display_name') {
            renderAuthHeader();
            window.dispatchEvent(new CustomEvent('rolenaut_display_name_change', { detail: { displayName: e.newValue || '' } }));
        } else if (e.key === 'rolenaut_active_stream' || e.key === 'rolenaut_custom_mongo_uri') {
            renderAuthHeader();
            window.dispatchEvent(new CustomEvent('rolenaut_stream_change', { detail: { stream: localStorage.getItem('rolenaut_active_stream') || 'curated' } }));
        }
    });

    // 11. Initial Synchronous Render
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderAuthHeader();
            setupMobileNav();
            setupIdentityListeners();
        });
    } else {
        renderAuthHeader();
        setupMobileNav();
        setupIdentityListeners();
    }

    // 12. Universal Netlify Badge Elimination (removes injected badges & iframes)
    function killNetlifyBadges() {
        try {
            const selectors = [
                'a[href*="netlify.com"][style*="fixed"]',
                'a[href*="netlify.app"][style*="fixed"]',
                'a[href*="netlify.com"][target="_blank"]',
                '[data-netlify-deploy-id]',
                '#nl-badge-frame',
                '.netlify-badge',
                'iframe[src*="netlify"]:not(#netlify-identity-widget)',
                'img[alt*="Deploys by Netlify"]',
                'img[alt*="Powered by Netlify"]',
                'img[alt*="Netlify"]'
            ];
            document.querySelectorAll(selectors.join(',')).forEach(el => {
                if (el && el.id !== 'netlify-identity-widget' && el.parentNode) {
                    el.remove();
                }
            });
        } catch (e) {}
    }

    if (typeof window !== 'undefined') {
        killNetlifyBadges();
        document.addEventListener('DOMContentLoaded', killNetlifyBadges);
        window.addEventListener('load', () => {
            killNetlifyBadges();
            setTimeout(killNetlifyBadges, 500);
            setTimeout(killNetlifyBadges, 1500);
        });

        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => killNetlifyBadges());
            if (document.documentElement) {
                observer.observe(document.documentElement, { childList: true, subtree: true });
                setTimeout(() => observer.disconnect(), 4000);
            }
        }
    }

    // Export globally: Modern RolenautAuth with JobBuddyAuth backward-compatibility alias
    window.RolenautAuth = {
        getUser: getStoredUser,
        getToken: getAuthToken,
        persistUser: persistUserCache,
        setDisplayName: setDisplayName,
        openModal: openAuthModal,
        logout: logoutUser,
        toggleProfileMenu: toggleProfileMenu,
        openDataSourceModal: openDataSourceModal,
        resetToDefaultStream: resetToDefaultStream,
        renderHeader: renderAuthHeader
    };
    window.JobBuddyAuth = window.RolenautAuth;
})();
