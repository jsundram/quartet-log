// Pull-to-refresh for installed-PWA mode (iOS Home Screen). Mobile Safari
// already has a native PTR that reloads the page; iOS strips that gesture
// when running standalone (no browser chrome) so we provide an in-app
// version that re-fetches the sheet and re-renders without losing the
// current view. Only enables when display-mode is standalone so we never
// double-fire with the browser's native PTR.

const THRESHOLD = 80;  // px of pulled distance past which release triggers refresh
const MAX_PULL = 120;  // visual cap so the indicator doesn't fly off-screen
const DAMPING = 0.5;   // pulled distance maps to half the visual offset (rubber-band feel)

// True when the touch started inside an element that can consume the drag
// itself — the open player dropdown's list, a long tooltip, the tab strip,
// a fullscreen lightbox. Such a gesture is a scroll or a pan, not a pull, so PTR has to
// keep its hands off it: page scrollY is 0 the whole time (the filter bar
// lives at the top of the page), so without this the first downward move
// inside the list gets preventDefault()'d into a refresh pull and the list
// simply won't scroll back up.
//
// Structural test rather than a class-name allowlist (same reasoning as the
// tooltip's ownership walk), so any new scrollable panel is covered for
// free. `styleOf` returns null for non-elements — text nodes can be a touch
// target and getComputedStyle would throw on them.
//
// EITHER axis counts. A horizontal pan is not a pull, but PTR only sees the
// vertical component of it, so a sideways swipe with a few pixels of drift
// hits `delta > 0` in _onMove and gets frozen into a refresh. That bites the
// tab strip and the date-range buttons (both `overflow-x: auto`, both right
// where a pull starts) and the fullscreen calendar, whose year columns pan
// horizontally while its height is fitted to the viewport — so it has no
// vertical overflow to detect, and `body.calendar-fullscreen-open` pins
// scrollY at 0 so the _scrollTop() guard misses it too. The cost is that a
// genuinely vertical pull starting on one of those stops refreshing once it
// overflows horizontally; the page around them stays pullable.
//
// Pure — exported for tests.
export function startsInScroller(target, stopAt, styleOf) {
    const scrolls = (overflow, scrollSize, clientSize) =>
        (overflow === 'auto' || overflow === 'scroll') && scrollSize - clientSize > 1;
    for (let el = target; el && el !== stopAt; el = el.parentElement) {
        const style = styleOf(el);
        if (!style) continue;
        if (scrolls(style.overflowY, el.scrollHeight, el.clientHeight)) return true;
        if (scrolls(style.overflowX, el.scrollWidth, el.clientWidth)) return true;
    }
    return false;
}

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

    _startedInScroller(target) {
        return startsInScroller(target, document.body,
            (el) => (el.nodeType === 1 ? window.getComputedStyle(el) : null));
    }

    _onStart(e) {
        if (this.refreshing) return;
        // _reset() rather than just clearing startY: a second finger landing
        // inside a scroller mid-pull bails here, and _onEnd() early-returns
        // on a null startY — which would strand the half-pulled indicator
        // on screen.
        if (this._scrollTop() > 0 || this._startedInScroller(e.target)) {
            this._reset();
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
