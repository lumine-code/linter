// Small dependency-free helpers, replacing the handful of lodash functions the
// linter used (uniq + debounce). Keeping these local drops the lodash runtime
// dependency without changing observable behavior.

/**
 * Returns a new array with duplicate values removed, preserving first-seen order.
 * Replacement for `lodash/uniq`.
 * @param {Array} array
 * @returns {Array}
 */
function unique(array) {
  return Array.from(new Set(array));
}

/**
 * Creates a debounced function that delays invoking `func` until `wait` ms have
 * elapsed since the last call. Mirrors the subset of `lodash/debounce` the
 * linter relies on: the leading/trailing edges and `.cancel()`.
 *
 * - `{ leading: false, trailing: true }` (the default) invokes once on the
 *   trailing edge.
 * - `{ leading: true }` invokes on the leading edge, and again on the trailing
 *   edge only if the debounced function was called more than once during the
 *   wait window (matching lodash, where `trailing` defaults to true).
 *
 * @param {Function} func
 * @param {number} wait
 * @param {{leading?: boolean, trailing?: boolean}} [options]
 * @returns {Function & {cancel: Function}}
 */
function debounce(func, wait, options = {}) {
  const leading = options.leading === true;
  const trailing = options.trailing !== false;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  let calledDuringWait = false;

  function invoke() {
    const args = lastArgs;
    const ctx = lastThis;
    lastArgs = null;
    lastThis = null;
    func.apply(ctx, args);
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    const isLeadingEdge = timer === null;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (leading && isLeadingEdge) {
      calledDuringWait = false;
      invoke();
    } else {
      calledDuringWait = true;
    }
    timer = setTimeout(() => {
      timer = null;
      if (trailing && calledDuringWait) {
        invoke();
      }
      calledDuringWait = false;
    }, wait);
  }

  debounced.cancel = function cancel() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
    lastArgs = null;
    lastThis = null;
    calledDuringWait = false;
  };

  return debounced;
}

module.exports = { unique, debounce };
