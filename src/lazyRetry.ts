import { lazy, type ComponentType } from 'react';

// React.lazy, but survives a deploy happening while a page is open.
//
// Every build gives each code chunk a content-hashed filename, and a
// deploy deletes the old files. A tab that was opened — or whose
// index.html the browser cached — before the deploy still asks for the
// old filename. That file no longer exists, hosting's catch-all rewrite
// answers with index.html instead, the browser can't run HTML as a
// module, and the import fails. Plain lazy() then leaves the tab on
// "Loading…" forever with nothing to tell the user what went wrong.
//
// A failed chunk load in this situation almost always means "this page
// is out of date", and a reload fetches the fresh index.html that names
// the right files. So: reload once, automatically. The sessionStorage
// flag is what stops a chunk that is genuinely broken (not just stale)
// from reloading in an endless loop — the second failure in a row is
// thrown as a real error instead. A successful load clears the flag, so
// the next deploy gets its own one reload.

const RELOAD_FLAG = 'chunk-reload-attempted';

// sessionStorage can throw (storage disabled, some private modes). Being
// unable to remember "already reloaded" must not itself become a crash,
// so failures here are treated as "no flag set / couldn't set it".
function readFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) !== null;
  } catch {
    return false;
  }
}
function setFlag(): boolean {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
    return true;
  } catch {
    return false;
  }
}
function clearFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* nothing to clear */
  }
}

export function lazyRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const loaded = await factory();
      clearFlag();
      return loaded;
    } catch (error) {
      // Only reload if we could record that we did — otherwise a failing
      // chunk plus unwritable storage would reload forever.
      if (!readFlag() && setFlag()) {
        window.location.reload();
        // The page is going away; never settle so React doesn't render
        // an error flash in the moment before the reload lands.
        return new Promise<never>(() => {});
      }
      throw error;
    }
  });
}
