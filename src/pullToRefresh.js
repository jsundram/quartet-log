// Pull-to-refresh for installed-PWA mode (iOS Home Screen). Mobile Safari
// already has a native PTR that reloads the page; iOS strips that gesture
// when running standalone (no browser chrome) so we provide an in-app
// version that re-fetches the sheet and re-renders without losing the
// current view. Only enables when display-mode is standalone so we never
// double-fire with the browser's native PTR.

const THRESHOLD = 80;  // px of pulled distance past which release triggers refresh
const MAX_PULL = 120;  // visual cap so the indicator doesn't fly off-screen
const DAMPING = 0.5;   // pulled distance maps to half the visual offset (rubber-band feel)

export class PullToRefresh {
    constructor({ onRefresh }) {
        this.onRefresh = onRefresh;
        this.startY = null;
        this.currentPull = 0;
        this.refreshing = false;
        this.indicator = null;
    }

    init() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
        if (!standalone) return;

        this._createIndicator();
        document.addEventListener('touchstart', (e) => this._onStart(e), { passive: true });
        // touchmove needs passive:false so we can preventDefault during an
        // active pull (otherwise iOS rubber-bands the whole page).
        document.addEventListener('touchmove', (e) => this._onMove(e), { passive: false });
        document.addEventListener('touchend', () => this._onEnd(), { passive: true });
        document.addEventListener('touchcancel', () => this._reset(), { passive: true });
    }

    _createIndicator() {
        const div = document.createElement('div');
        div.id = 'ptr-indicator';
        div.innerHTML = '<div class="ptr-spinner"></div>';
        document.body.appendChild(div);
        this.indicator = div;
    }

    _scrollTop() {
        return window.scrollY || document.documentElement.scrollTop || 0;
    }

    _onStart(e) {
        if (this.refreshing) return;
        if (this._scrollTop() > 0) {
            this.startY = null;
            return;
        }
        this.startY = e.touches[0].clientY;
        this.currentPull = 0;
    }

    _onMove(e) {
        if (this.refreshing || this.startY === null) return;
        // Bail if the page started scrolling after touchstart (e.g. user
        // started at top then immediately swiped up past it).
        if (this._scrollTop() > 0) {
            this._reset();
            return;
        }
        const delta = e.touches[0].clientY - this.startY;
        if (delta <= 0) return;
        e.preventDefault();
        this.currentPull = Math.min(delta * DAMPING, MAX_PULL);
        this.indicator.classList.add('pulling');
        this.indicator.style.setProperty('--ptr-y', `${this.currentPull}px`);
        this.indicator.style.setProperty('--ptr-opacity', String(Math.min(this.currentPull / THRESHOLD, 1)));
    }

    _onEnd() {
        if (this.refreshing || this.startY === null) return;
        this.indicator.classList.remove('pulling');
        if (this.currentPull >= THRESHOLD) {
            this._trigger();
        } else {
            this._reset();
        }
    }

    async _trigger() {
        this.refreshing = true;
        this.indicator.classList.add('refreshing');
        this.indicator.style.setProperty('--ptr-y', `${THRESHOLD}px`);
        this.indicator.style.setProperty('--ptr-opacity', '1');
        try {
            await this.onRefresh();
        } catch (e) {
            console.error('Pull-to-refresh failed', e);
        }
        this._reset();
    }

    _reset() {
        this.refreshing = false;
        this.startY = null;
        this.currentPull = 0;
        if (!this.indicator) return;
        this.indicator.classList.remove('pulling');
        this.indicator.classList.remove('refreshing');
        this.indicator.style.setProperty('--ptr-y', '0px');
        this.indicator.style.setProperty('--ptr-opacity', '0');
    }
}
