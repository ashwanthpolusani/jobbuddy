// ═══════════════════════════════════════════════════════════════════════════════
// Rolenaut Resilient Auth Core — Persistent, Synchronous & Unified Session Manager
// Ensures zero-flicker session hydration on reload and standardizes top-right UI
// ═══════════════════════════════════════════════════════════════════════════════

(function () {
    // 1. Synchronously retrieve user from localStorage to eliminate refresh flicker
    function getStoredUser() {
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

    // 2. Retrieve JWT access token with fallback to stored token
    async function getAuthToken() {
        if (window.netlifyIdentity && typeof window.netlifyIdentity.currentUser === 'function') {
            const current = window.netlifyIdentity.currentUser();
            if (current && typeof current.jwt === 'function') {
                try {
                    const t = await current.jwt();
                    if (t) return t;
                } catch (e) {}
            }
        }
        try {
            const raw = localStorage.getItem('gotrue.user');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.token && parsed.token.access_token) {
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

        // Fallback for local session validation
        const stored = getStoredUser();
        if (stored && stored.email) {
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

    function setDisplayName(name) {
        const cleanName = String(name || '').trim();
        if (cleanName) {
            localStorage.setItem('rolenaut_display_name', cleanName);
            const user = getStoredUser();
            if (user) {
                user.display_name = cleanName;
                if (!user.user_metadata) user.user_metadata = {};
                user.user_metadata.display_name = cleanName;
                persistUserCache(user);
            }
            renderAuthHeader();
            // Crucial: Do NOT call dispatchAuthEvent here - setting display name is purely visual and must not re-trigger lifecycle auth loops!
        }
    }

    // Helper: notify auth state changes across all listeners (both modern and legacy events)
    function dispatchAuthEvent(user) {
        const detail = { user };
        window.dispatchEvent(new CustomEvent('rolenaut_auth_change', { detail }));
        window.dispatchEvent(new CustomEvent('jb_auth_change', { detail }));
    }

    // 4. Open Auth Modal reliably
    function openAuthModal(action) {
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
        persistUserCache(null);
        localStorage.removeItem('rolenaut_custom_mongo_uri');
        localStorage.removeItem('jobbuddy_custom_mongo_uri');
        if (window.netlifyIdentity && typeof window.netlifyIdentity.logout === 'function') {
            try { window.netlifyIdentity.logout(); } catch (e) {}
        }
        dispatchAuthEvent(null);
        renderAuthHeader();
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

    // Close menu when clicking outside
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
    });

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
        const isCustomDb = !!localStorage.getItem('rolenaut_custom_mongo_uri') ||
                           !!localStorage.getItem('jobbuddy_custom_mongo_uri') || 
                           (user.user_metadata && user.user_metadata.has_custom_db);

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
                        <div class="mini-user-info">
                            <div class="mini-user-name">${escapeHtml(displayName)}</div>
                            <div class="mini-user-email">${escapeHtml(email)}</div>
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
                            ${typeof window.openDbModal === 'function' ? `
                            <button type="button" class="mini-menu-item" onclick="window.RolenautAuth.openDataSourceModal()">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                                <span>${isCustomDb ? 'Quick Database Modal' : 'Quick Connect Modal'}</span>
                            </button>
                            ` : ''}
                            ${isCustomDb ? `
                            <button type="button" class="mini-menu-item" onclick="window.RolenautAuth.resetToDefaultStream()" style="color: var(--muted);">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                                <span>Switch to Curated Freshers Stream</span>
                            </button>
                            ` : ''}
                            <a href="/profile" class="mini-menu-item">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                <span>Candidate Profile &amp; Data Source</span>
                            </a>
                            <a href="/scraper-guide" class="mini-menu-item">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                <span>Scraper Setup Guide</span>
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
    function setupIdentityListeners() {
        if (identityInitialized) return;
        if (!window.netlifyIdentity) {
            setTimeout(setupIdentityListeners, 50);
            return;
        }
        identityInitialized = true;

        window.netlifyIdentity.on('init', (user) => {
            const finalUser = user || getStoredUser();
            persistUserCache(finalUser);
            dispatchAuthEvent(finalUser);
            renderAuthHeader();
        });

        window.netlifyIdentity.on('login', (user) => {
            if (window.netlifyIdentity) window.netlifyIdentity.close();
            persistUserCache(user);
            dispatchAuthEvent(user);
            renderAuthHeader();
        });

        window.netlifyIdentity.on('logout', () => {
            persistUserCache(null);
            localStorage.removeItem('rolenaut_custom_mongo_uri');
            localStorage.removeItem('jobbuddy_custom_mongo_uri');
            dispatchAuthEvent(null);
            renderAuthHeader();
        });

        // In case the widget initialized before listeners attached
        const current = window.netlifyIdentity.currentUser();
        if (current) {
            persistUserCache(current);
            dispatchAuthEvent(current);
            renderAuthHeader();
        }
    }

    // 11. Initial Synchronous Render
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderAuthHeader();
            setupIdentityListeners();
        });
    } else {
        renderAuthHeader();
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
                'iframe[src*="netlify"]',
                'img[alt*="Deploys by Netlify"]',
                'img[alt*="Powered by Netlify"]',
                'img[alt*="Netlify"]'
            ];
            document.querySelectorAll(selectors.join(',')).forEach(el => {
                if (el && el.parentNode) {
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
            setTimeout(killNetlifyBadges, 3000);
        });

        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => killNetlifyBadges());
            if (document.documentElement) {
                observer.observe(document.documentElement, { childList: true, subtree: true });
                setTimeout(() => observer.disconnect(), 15000);
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