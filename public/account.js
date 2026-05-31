// Shared Kalshi-account selection across all dashboard pages.
//
// Exactly one account is "active" at a time. The choice is persisted to
// localStorage (so it survives reloads and is shared across the Live / Recap /
// Comparison pages) and surfaced through a header <select id="account-select">.
//
// Every page routes its API calls through withAccount(), which appends
// ?account=<active> so the server signs/pulls for the right Kalshi account.
// The account list itself comes from the server (/api/accounts) so adding a
// third account later needs no frontend change.

const STORAGE_KEY = "rfq_account";
export const DEFAULT_ACCOUNT = "MVPeav";

let _accounts = [DEFAULT_ACCOUNT];

export function getAccount() {
  try {
    const a = localStorage.getItem(STORAGE_KEY);
    if (a && _accounts.includes(a)) return a;
    return _accounts.includes(DEFAULT_ACCOUNT) ? DEFAULT_ACCOUNT : _accounts[0];
  } catch {
    return DEFAULT_ACCOUNT;
  }
}

export function setAccount(a) {
  try { localStorage.setItem(STORAGE_KEY, a); } catch {}
}

// Append ?account=<active> (or &account=) to a same-origin API path.
export function withAccount(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}account=${encodeURIComponent(getAccount())}`;
}

// Populate the header switcher and wire its change handler. onChange(newAccount)
// fires after the selection (and storage) have been updated. Returns the active
// account. Safe to call on pages without a #account-select element (no-op).
export async function initAccountPicker(onChange) {
  // Fetch the available accounts; fall back to the default on any error.
  try {
    const r = await fetch("/api/accounts");
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.accounts) && j.accounts.length) _accounts = j.accounts;
    }
  } catch { /* keep default */ }

  const active = getAccount();
  setAccount(active); // normalise any stale/invalid stored value

  const sel = document.getElementById("account-select");
  if (!sel) return active;

  sel.innerHTML = _accounts
    .map((a) => `<option value="${a}"${a === active ? " selected" : ""}>${a}</option>`)
    .join("");

  sel.addEventListener("change", () => {
    setAccount(sel.value);
    if (typeof onChange === "function") onChange(sel.value);
  });

  return active;
}
