(function () {
  type InteractionOwner = 'grid' | 'columnFilter' | 'search' | 'cellEdit' | 'other';

  interface ClipboardDataLike {
    getData(format: string): string;
    setData(format: string, data: string): void;
  }

  interface ClipboardEventLike {
    preventDefault(): void;
    clipboardData?: ClipboardDataLike | null;
  }

  interface TableClipboardHandlers {
    getCopyText: () => string;
    pasteText: (text: string, raw: boolean) => boolean;
  }

  interface NavigatorClipboardLike {
    writeText?(data: string): Promise<void>;
    readText?(): Promise<string>;
  }

  const root = globalThis as typeof globalThis & {
    document?: {
      addEventListener(
        type: string,
        listener: (event: ClipboardEventLike) => void,
        options?: boolean,
      ): void;
    };
    navigator?: {
      clipboard?: NavigatorClipboardLike;
    };
    DBAdminTableClipboard?: TableClipboardApi;
  };

  let owner: InteractionOwner = 'other';
  let pendingFilterRestore = false;
  let pendingRawPaste = false;
  let bound = false;
  let handlers: TableClipboardHandlers | null = null;

  function setOwner(next: InteractionOwner): void {
    owner = next;
    if (next === 'grid' || next === 'cellEdit' || next === 'other') {
      pendingFilterRestore = false;
    }
    if (next === 'columnFilter') {
      pendingFilterRestore = true;
    }
  }

  function getOwner(): InteractionOwner {
    return owner;
  }

  function isGridShortcutTarget(): boolean {
    return owner === 'grid';
  }

  function clearPendingFilterRestore(): void {
    pendingFilterRestore = false;
  }

  function shouldRestoreFilterFocus(): boolean {
    return owner === 'columnFilter' && pendingFilterRestore;
  }

  function markRawPaste(): void {
    pendingRawPaste = true;
  }

  function writeText(text: string, clipboardData?: ClipboardDataLike | null): void {
    const value = text || '';
    if (clipboardData) {
      clipboardData.setData('text/plain', value);
      return;
    }

    const clipboard = root.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(value).catch(() => undefined);
    }
  }

  function readTextFromEvent(event?: ClipboardEventLike): string {
    if (event && event.clipboardData) {
      return event.clipboardData.getData('text/plain') || '';
    }
    return '';
  }

  function handleCopy(event?: ClipboardEventLike): boolean {
    if (!isGridShortcutTarget() || !handlers) {
      return false;
    }

    if (event) {
      event.preventDefault();
    }

    writeText(handlers.getCopyText(), event?.clipboardData || null);
    return true;
  }

  function pasteWithText(text: string, raw: boolean): boolean {
    if (!handlers) {
      return false;
    }
    return handlers.pasteText(text, raw);
  }

  function handlePaste(event?: ClipboardEventLike, raw?: boolean): boolean {
    if (!isGridShortcutTarget() || !handlers) {
      pendingRawPaste = false;
      return false;
    }

    const isRaw = Boolean(raw || pendingRawPaste);
    pendingRawPaste = false;

    if (event) {
      event.preventDefault();
      return pasteWithText(readTextFromEvent(event), isRaw);
    }

    const clipboard = root.navigator?.clipboard;
    if (clipboard && typeof clipboard.readText === 'function') {
      clipboard.readText()
        .then((value) => {
          pasteWithText(value, isRaw);
        })
        .catch(() => undefined);
      return true;
    }

    return false;
  }

  function handleCut(event?: ClipboardEventLike): boolean {
    return handleCopy(event);
  }

  function bind(nextHandlers: TableClipboardHandlers): void {
    handlers = nextHandlers;
    if (bound || !root.document) {
      return;
    }

    bound = true;
    root.document.addEventListener('copy', (event) => {
      handleCopy(event);
    });
    root.document.addEventListener('paste', (event) => {
      handlePaste(event);
    });
    root.document.addEventListener('cut', (event) => {
      handleCut(event);
    });
  }

  const api = {
    setOwner,
    getOwner,
    isGridShortcutTarget,
    writeText,
    clearPendingFilterRestore,
    shouldRestoreFilterFocus,
    markRawPaste,
    handleCopy,
    handlePaste,
    handleCut,
    bind,
  };

  type TableClipboardApi = typeof api;
  root.DBAdminTableClipboard = api;
})();
