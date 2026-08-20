/**
 * Notebook renderer for DBAdmin SQL Book integrated tables.
 * Runs in the notebook output iframe (ESM).
 * @param {import('vscode-notebook-renderer').RendererContext} context
 */

const FALLBACK_I18N = {
  "webview.renderer.rows": "linha(s)",
  "webview.renderer.open": "Abrir",
  "webview.renderer.filter": "Filtrar",
  "webview.renderer.export": "Exportar",
  "webview.renderer.noResults": "(sem resultados)",
  "webview.renderer.showColFilters": "Mostrar filtros de coluna",
  "webview.renderer.hideColFilters": "Ocultar filtros de coluna",
  "webview.renderer.widthMin": "Colunas com largura mínima (conteúdo)",
  "webview.renderer.widthEqual": "Colunas com largura igual",
  "webview.renderer.clear": "Limpar",
  "webview.renderer.filterColumn": "Filtrar {column}",
};

export function activate(context) {
  return {
    /**
     * @param {import('vscode-notebook-renderer').OutputItem} outputItem
     * @param {HTMLElement} element
     */
    renderOutputItem(outputItem, element) {
      const data = safeJson(outputItem);
      const cleanup = element.__dbadminItCleanup;
      if (typeof cleanup === "function") {
        cleanup();
        element.__dbadminItCleanup = undefined;
      }
      element.replaceChildren();
      const built = buildTable(data, context);
      element.appendChild(built.root);
      element.__dbadminItCleanup = built.cleanup;
    },
  };
}

/**
 * @param {import('vscode-notebook-renderer').OutputItem} outputItem
 */
function safeJson(outputItem) {
  try {
    const value = outputItem.json();
    if (value && typeof value === "object") {
      return value;
    }
  } catch {
    // fall through
  }
  return { columns: [], rows: [], rowCount: 0, command: "" };
}

/**
 * @param {{ columns?: string[], rows?: Record<string, unknown>[], rowCount?: number, command?: string, sql?: string, connectionId?: string, connectionHost?: string, connectionPort?: number, databaseName?: string, schemaName?: string, i18n?: Record<string, string> }} data
 * @param {import('vscode-notebook-renderer').RendererContext} context
 */
function buildTable(data, context) {
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
  const sourceRows = Array.isArray(data.rows) ? data.rows : [];
  const rowCount = Number.isFinite(data.rowCount)
    ? Number(data.rowCount)
    : sourceRows.length;
  const command = String(data.command || "").trim();
  const dict =
    data.i18n && typeof data.i18n === "object" ? data.i18n : FALLBACK_I18N;
  const t = (key, fallback) =>
    dict[key] != null && dict[key] !== "" ? String(dict[key]) : fallback;
  const tf = (key, vars, fallback) => {
    let s = t(key, fallback);
    if (!vars) {
      return s;
    }
    return String(s).replace(/\{(\w+)\}/g, (_, k) =>
      vars[k] != null ? String(vars[k]) : `{${k}}`,
    );
  };
  const rowsLabel = t("webview.renderer.rows", "linha(s)");
  const summary =
    command.length > 0
      ? `${rowCount} ${rowsLabel} — ${command}`
      : `${rowCount} ${rowsLabel}`;

  const root = el("div", { className: "dbadmin-it" });
  injectStyles(root);
  const shell = el("div", { className: "dbadmin-it__shell" });
  root.appendChild(shell);

  if (columns.length === 0 || sourceRows.length === 0) {
    shell.appendChild(
      el("p", {
        className: "dbadmin-it__empty",
        textContent: command
          ? `${command} — ${rowCount} ${rowsLabel}`
          : t("webview.renderer.noResults", "(sem resultados)"),
      }),
    );
    return { root, cleanup: () => {} };
  }

  const EQUAL_COL_WIDTH = 160;

  /** @type {{ global: string, columns: string[], sortCol: number | null, sortDir: 'asc' | 'desc' | null, showColFilters: boolean, equalWidth: boolean }} */
  const state = {
    global: "",
    columns: columns.map(() => ""),
    sortCol: null,
    sortDir: null,
    showColFilters: false,
    equalWidth: false,
  };

  /** @type {(number | null)[]} */
  const colWidths = columns.map(() => null);

  const header = el("div", { className: "dbadmin-it__header" });
  const searchWrap = el("div", { className: "dbadmin-it__search-wrap" });
  const search = /** @type {HTMLInputElement} */ (
    el("input", {
      className: "dbadmin-it__search",
      type: "text",
      placeholder: summary,
    })
  );
  const searchLupa = el("span", { className: "dbadmin-it__search-lupa" });
  searchLupa.innerHTML = SEARCH_ICON;
  searchLupa.setAttribute("aria-hidden", "true");
  searchWrap.append(search, searchLupa);

  const showFiltersLabel = t(
    "webview.renderer.showColFilters",
    "Mostrar filtros de coluna",
  );
  const filterToggleBtn = el("button", {
    className: "dbadmin-it__icon-btn",
    type: "button",
    title: showFiltersLabel,
  });
  filterToggleBtn.innerHTML = FILTER_ICON;
  filterToggleBtn.setAttribute("aria-label", showFiltersLabel);
  filterToggleBtn.setAttribute("aria-pressed", "false");

  const widthMinLabel = t(
    "webview.renderer.widthMin",
    "Colunas com largura mínima (conteúdo)",
  );
  const widthToggleBtn = el("button", {
    className: "dbadmin-it__icon-btn",
    type: "button",
    title: widthMinLabel,
  });
  widthToggleBtn.innerHTML = WIDTH_MIN_ICON;
  widthToggleBtn.setAttribute("aria-label", widthMinLabel);

  const exportLabel = t("webview.renderer.export", "Exportar");
  const exportBtn = el("button", {
    className: "dbadmin-it__icon-btn",
    type: "button",
    title: exportLabel,
  });
  exportBtn.innerHTML = EXPORT_ICON;
  exportBtn.setAttribute("aria-label", exportLabel);
  exportBtn.setAttribute("aria-haspopup", "menu");
  exportBtn.setAttribute("aria-expanded", "false");

  const openBtn = el("button", {
    className: "dbadmin-it__btn",
    type: "button",
    textContent: t("webview.renderer.open", "Abrir"),
  });
  openBtn.addEventListener("click", () => {
    context.postMessage?.({
      type: "openLastResult",
      payload: {
        columns: data.columns,
        rows: data.rows,
        rowCount: data.rowCount,
        command: data.command,
        sql: data.sql,
        connectionId: data.connectionId,
        connectionHost: data.connectionHost,
        connectionPort: data.connectionPort,
        databaseName: data.databaseName,
        schemaName: data.schemaName,
      },
    });
  });
  header.append(searchWrap, widthToggleBtn, filterToggleBtn, exportBtn, openBtn);

  const scroll = el("div", { className: "dbadmin-it__scroll" });
  scroll.tabIndex = -1;
  const table = el("table", { className: "dbadmin-it__table is-min-width" });
  const colgroup = el("colgroup");
  /** @type {HTMLElement[]} */
  const colEls = columns.map(() => {
    const colEl = el("col");
    colgroup.appendChild(colEl);
    return colEl;
  });

  const thead = el("thead");
  const headerRow = el("tr");
  /** @type {HTMLSpanElement[]} */
  const sortMarks = [];
  /** @type {HTMLInputElement[]} */
  const colFilterInputs = [];
  /** @type {HTMLElement[]} */
  const lupaBtns = [];
  /** @type {HTMLElement[]} */
  const searchSlots = [];
  /** @type {HTMLElement[]} */
  const filterLabels = [];
  /** @type {HTMLElement[]} */
  const thEls = [];

  /** @type {number | null} */
  let openPopoverCol = null;

  const measureCanvas = root.ownerDocument.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");

  const popover = el("div", { className: "dbadmin-it__popover" });
  popover.hidden = true;
  root.ownerDocument
    .querySelectorAll(".dbadmin-it__popover")
    .forEach((node) => node.remove());
  const popoverInput = /** @type {HTMLInputElement} */ (
    el("input", {
      className: "dbadmin-it__popover-input",
      type: "text",
      placeholder: t("webview.renderer.filter", "Filtrar") + "…",
    })
  );
  const popoverClear = el("button", {
    className: "dbadmin-it__popover-clear",
    type: "button",
    title: t("webview.renderer.clear", "Limpar"),
    textContent: "×",
  });
  popover.append(popoverInput, popoverClear);
  popoverClear.disabled = true;
  popoverClear.setAttribute("aria-disabled", "true");
  root.ownerDocument.body.appendChild(popover);

  const exportMenu = el("div", { className: "dbadmin-it__menu" });
  exportMenu.hidden = true;
  exportMenu.setAttribute("role", "menu");
  root.ownerDocument
    .querySelectorAll(".dbadmin-it__menu")
    .forEach((node) => node.remove());
  const exportJsonBtn = el("button", {
    className: "dbadmin-it__menu-item",
    type: "button",
    textContent: "JSON",
  });
  exportJsonBtn.setAttribute("role", "menuitem");
  const exportCsvBtn = el("button", {
    className: "dbadmin-it__menu-item",
    type: "button",
    textContent: "CSV",
  });
  exportCsvBtn.setAttribute("role", "menuitem");
  exportMenu.append(exportJsonBtn, exportCsvBtn);
  root.ownerDocument.body.appendChild(exportMenu);

  exportBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (exportMenu.hidden) {
      closePopover();
      openExportMenu();
    } else {
      closeExportMenu();
    }
  });
  exportJsonBtn.addEventListener("click", () => {
    closeExportMenu();
    exportVisibleRows("json");
  });
  exportCsvBtn.addEventListener("click", () => {
    closeExportMenu();
    exportVisibleRows("csv");
  });

  /** @type {HTMLElement | null} */
  let popoverAnchor = null;

  columns.forEach((col, colIdx) => {
    const th = el("th");
    th.classList.add("dbadmin-it__th");
    thEls.push(th);
    const stack = el("div", { className: "dbadmin-it__th-stack" });

    const titleRow = el("div", { className: "dbadmin-it__th-row" });
    const titleBtn = el("button", {
      className: "dbadmin-it__th-title",
      type: "button",
    });
    const titleText = el("span", {
      className: "dbadmin-it__th-name",
      textContent: col,
    });
    const sortMark = el("span", { className: "dbadmin-it__sort is-none" });
    sortMark.innerHTML = SORT_ICON_NONE;
    sortMarks.push(sortMark);
    titleBtn.append(titleText, sortMark);
    titleBtn.addEventListener("click", () => {
      if (state.sortCol === colIdx) {
        state.sortDir =
          state.sortDir === "asc"
            ? "desc"
            : state.sortDir === "desc"
              ? null
              : "asc";
        if (state.sortDir === null) {
          state.sortCol = null;
        }
      } else {
        state.sortCol = colIdx;
        state.sortDir = "asc";
      }
      renderBody();
      updateSortMarks();
    });

    const searchSlot = el("div", { className: "dbadmin-it__search-slot" });
    searchSlot.title = tf("webview.renderer.filterColumn", { column: col }, `Filtrar ${col}`);
    searchSlots.push(searchSlot);
    const filterLabel = el("span", { className: "dbadmin-it__filter-label" });
    filterLabels.push(filterLabel);

    const lupaBtn = el("span", { className: "dbadmin-it__lupa" });
    lupaBtn.innerHTML = SEARCH_ICON;
    lupaBtn.setAttribute("aria-hidden", "true");
    lupaBtns.push(lupaBtn);

    const openFilterUi = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.showColFilters) {
        return;
      }
      if (openPopoverCol === colIdx) {
        closePopover();
        return;
      }
      openPopover(colIdx, searchSlot);
    };
    searchSlot.addEventListener("click", openFilterUi);

    searchSlot.append(filterLabel, lupaBtn);
    titleRow.append(titleBtn, searchSlot);

    const colFilter = /** @type {HTMLInputElement} */ (
      el("input", {
        className: "dbadmin-it__col-filter",
        type: "text",
        placeholder: t("webview.renderer.filter", "Filtrar"),
      })
    );
    colFilter.setAttribute("size", "1");
    colFilter.hidden = true;
    colFilterInputs.push(colFilter);
    colFilter.addEventListener("input", () => {
      setColumnFilter(colIdx, colFilter.value, { from: "row" });
    });

    const colFilterWrap = el("div", { className: "dbadmin-it__col-filter-wrap" });
    colFilterWrap.append(colFilter);

    const resizer = el("div", { className: "dbadmin-it__resizer" });
    resizer.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startResize(colIdx, event.clientX, resizer);
    });

    stack.append(titleRow, colFilterWrap);
    th.append(stack, resizer);
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  const tbody = el("tbody");
  table.append(colgroup, thead, tbody);
  scroll.appendChild(table);
  root.appendChild(shell);
  shell.append(header, scroll);

  table.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (
      target.closest(
        "input, button, textarea, .dbadmin-it__search-slot, .dbadmin-it__resizer",
      )
    ) {
      return;
    }
    scroll.focus({ preventScroll: true });
  });

  search.addEventListener("input", () => {
    search.classList.toggle("is-filled", search.value.trim().length > 0);
    state.global = search.value;
    renderBody();
  });

  filterToggleBtn.addEventListener("click", () => {
    state.showColFilters = !state.showColFilters;
    filterToggleBtn.classList.toggle("is-active", state.showColFilters);
    filterToggleBtn.setAttribute(
      "aria-pressed",
      state.showColFilters ? "true" : "false",
    );
    filterToggleBtn.title = state.showColFilters
      ? t("webview.renderer.hideColFilters", "Ocultar filtros de coluna")
      : t("webview.renderer.showColFilters", "Mostrar filtros de coluna");
    filterToggleBtn.setAttribute("aria-label", filterToggleBtn.title);
    if (state.showColFilters) {
      closePopover();
      closeExportMenu();
    }
    syncColFilterVisibility();
  });

  widthToggleBtn.addEventListener("click", () => {
    state.equalWidth = !state.equalWidth;
    if (state.equalWidth) {
      for (let i = 0; i < colWidths.length; i += 1) {
        colWidths[i] = null;
      }
    }
    syncWidthToggleBtn();
    applyColumnLayout();
  });

  const doc = root.ownerDocument;
  const win = doc.defaultView;

  /** @param {KeyboardEvent} event */
  const stopKeyToNotebook = (event) => {
    event.stopPropagation();
  };

  /** @param {KeyboardEvent} event */
  const onPopoverKeyBubble = (event) => {
    event.stopPropagation();
  };

  /** @param {KeyboardEvent} event */
  const onDocKeyDown = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (!exportMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeExportMenu();
      return;
    }
    if (popover.hidden || openPopoverCol === null) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || !popover.contains(target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closePopover();
  };

  root.addEventListener("keydown", stopKeyToNotebook, true);
  root.addEventListener("keyup", stopKeyToNotebook, true);
  popover.addEventListener("keydown", onPopoverKeyBubble, false);
  popover.addEventListener("keyup", onPopoverKeyBubble, false);

  /** @param {MouseEvent} event */
  const onDocMouseDown = (event) => {
    if (!root.isConnected) {
      teardownPopoverListeners();
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (
      !popover.hidden &&
      openPopoverCol !== null &&
      !popover.contains(target) &&
      !searchSlots[openPopoverCol]?.contains(target)
    ) {
      closePopover();
    }
    if (
      !exportMenu.hidden &&
      !exportMenu.contains(target) &&
      !exportBtn.contains(target)
    ) {
      closeExportMenu();
    }
  };

  const onWindowBlur = () => {
    closePopover();
    closeExportMenu();
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState === "hidden") {
      closePopover();
    }
  };

  const onViewportChange = () => {
    if (!popover.hidden && popoverAnchor) {
      positionPopover(popoverAnchor);
    }
  };

  function teardownPopoverListeners() {
    doc.removeEventListener("mousedown", onDocMouseDown, true);
    win?.removeEventListener("blur", onWindowBlur);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    win?.removeEventListener("resize", onViewportChange);
    scroll.removeEventListener("scroll", onViewportChange);
    root.removeEventListener("keydown", stopKeyToNotebook, true);
    root.removeEventListener("keyup", stopKeyToNotebook, true);
    popover.removeEventListener("keydown", onPopoverKeyBubble, false);
    popover.removeEventListener("keyup", onPopoverKeyBubble, false);
    doc.removeEventListener("keydown", onDocKeyDown, false);
    popover.remove();
    exportMenu.remove();
  }

  doc.addEventListener("mousedown", onDocMouseDown, true);
  doc.addEventListener("keydown", onDocKeyDown, false);
  win?.addEventListener("blur", onWindowBlur);
  doc.addEventListener("visibilitychange", onVisibilityChange);
  win?.addEventListener("resize", onViewportChange);
  scroll.addEventListener("scroll", onViewportChange, { passive: true });

  function syncPopoverClearState() {
    const hasValue = popoverInput.value.trim().length > 0;
    popoverClear.disabled = !hasValue;
    popoverClear.setAttribute("aria-disabled", hasValue ? "false" : "true");
  }

  popoverInput.addEventListener("input", () => {
    syncPopoverClearState();
    if (openPopoverCol === null) {
      return;
    }
    setColumnFilter(openPopoverCol, popoverInput.value, { from: "popover" });
  });
  popoverInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      closePopover();
    }
  });
  popoverClear.addEventListener("click", () => {
    if (openPopoverCol === null || popoverClear.disabled) {
      return;
    }
    setColumnFilter(openPopoverCol, "", { from: "popover" });
    popoverInput.value = "";
    syncPopoverClearState();
    popoverInput.focus();
  });

  /**
   * @param {number} colIdx
   * @param {string} value
   * @param {{ from?: 'row' | 'popover' | 'sync' }} [opts]
   */
  function setColumnFilter(colIdx, value, opts = {}) {
    state.columns[colIdx] = value;
    if (opts.from !== "row") {
      const input = colFilterInputs[colIdx];
      if (input && input.value !== value) {
        input.value = value;
      }
    }
    if (opts.from !== "popover" && openPopoverCol === colIdx) {
      if (popoverInput.value !== value) {
        popoverInput.value = value;
      }
    }
    colFilterInputs[colIdx]?.classList.toggle(
      "is-filled",
      value.trim().length > 0,
    );
    updateFilterLabels();
    updateLupaMarks();
    renderBody();
  }

  function syncColFilterVisibility() {
    colFilterInputs.forEach((input) => {
      input.hidden = !state.showColFilters;
    });
    searchSlots.forEach((slot, idx) => {
      slot.hidden = state.showColFilters;
      lupaBtns[idx].hidden = state.showColFilters;
    });
    root.classList.toggle("dbadmin-it--filters", state.showColFilters);
    updateFilterLabels();
    applyColumnLayout();
  }

  /**
   * @param {HTMLElement} anchor
   */
  function positionPopover(anchor) {
    popover.hidden = false;
    const anchorRect = anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const margin = 4;
    const viewH = win?.innerHeight ?? anchorRect.bottom + popRect.height + margin;
    const viewW = win?.innerWidth ?? anchorRect.right + popRect.width + margin;

    let top = anchorRect.bottom + margin;
    if (top + popRect.height > viewH - margin) {
      top = anchorRect.top - popRect.height - margin;
    }
    top = Math.max(margin, Math.min(top, viewH - popRect.height - margin));

    let left = anchorRect.left;
    left = Math.max(margin, Math.min(left, viewW - popRect.width - margin));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  /**
   * @param {number} colIdx
   * @param {HTMLElement} anchor
   */
  function openPopover(colIdx, anchor) {
    if (state.showColFilters) {
      return;
    }
    closeExportMenu();
    openPopoverCol = colIdx;
    popoverAnchor = anchor;
    popoverInput.placeholder = tf(
      "webview.renderer.filterColumn",
      { column: columns[colIdx] },
      `Filtrar ${columns[colIdx]}`,
    ) + "…";
    popoverInput.value = state.columns[colIdx] || "";
    syncPopoverClearState();
    popover.hidden = false;
    popover.style.visibility = "hidden";
    requestAnimationFrame(() => {
      positionPopover(anchor);
      popover.style.visibility = "";
      popoverInput.focus();
    });
    updateLupaMarks();
  }

  function closePopover() {
    const active = doc.activeElement;
    if (active instanceof HTMLElement && popover.contains(active)) {
      active.blur();
    }
    openPopoverCol = null;
    popoverAnchor = null;
    popover.hidden = true;
    popover.style.visibility = "";
    updateLupaMarks();
  }

  function updateFilterLabels() {
    filterLabels.forEach((label, idx) => {
      const value = state.columns[idx].trim();
      label.textContent = value;
      label.hidden = !value || state.showColFilters;
      label.title = value ? `${columns[idx]}: ${value}` : "";
    });
  }

  function updateSortMarks() {
    sortMarks.forEach((mark, idx) => {
      const active = state.sortCol === idx && state.sortDir;
      mark.classList.toggle("is-none", !active);
      mark.classList.toggle("is-asc", active && state.sortDir === "asc");
      mark.classList.toggle("is-desc", active && state.sortDir === "desc");
      mark.innerHTML = !active
        ? SORT_ICON_NONE
        : state.sortDir === "asc"
          ? SORT_ICON_ASC
          : SORT_ICON_DESC;
    });
  }

  function updateLupaMarks() {
    lupaBtns.forEach((btn, idx) => {
      const value = state.columns[idx].trim();
      const filled = value.length > 0;
      const open = openPopoverCol === idx;
      btn.hidden = state.showColFilters;
      btn.classList.toggle("is-filled", filled);
      btn.classList.toggle("is-open", open);
      searchSlots[idx].classList.toggle("is-filled", filled);
      searchSlots[idx].classList.toggle("is-open", open);
      searchSlots[idx].title = filled
        ? `${columns[idx]}: ${value}`
        : tf("webview.renderer.filterColumn", { column: columns[idx] }, `Filtrar ${columns[idx]}`);
    });
  }

  /**
   * @param {string} text
   * @param {string} font
   */
  function measureText(text, font) {
    if (!measureCtx) {
      return text.length * 7;
    }
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function computeMinColumnWidths() {
    const view = root.ownerDocument.defaultView;
    const thStyle = thEls[0] && view ? view.getComputedStyle(thEls[0]) : null;
    const sampleTd = tbody.querySelector("td");
    const tdStyle =
      sampleTd && view ? view.getComputedStyle(sampleTd) : thStyle;
    const headerFont =
      thStyle?.font ||
      `${thStyle?.fontWeight || 600} ${thStyle?.fontSize || "12px"} ${thStyle?.fontFamily || "sans-serif"}`;
    const bodyFont =
      tdStyle?.font ||
      `${tdStyle?.fontWeight || 400} ${tdStyle?.fontSize || "12px"} ${tdStyle?.fontFamily || "sans-serif"}`;
    const filterFont = `11px ${thStyle?.fontFamily || "sans-serif"}`;
    const padX = 20;
    const sortW = 16;
    const lupaW = state.showColFilters ? 0 : 20;
    const filterFloor = state.showColFilters
      ? Math.max(60, Math.ceil(measureText(t("webview.renderer.filter", "Filtrar"), filterFont)) + 16)
      : 48;

    return columns.map((colName) => {
      const headerW =
        Math.ceil(measureText(colName, headerFont)) + sortW + lupaW + padX + 8;
      let maxValueW = 0;
      for (const row of sourceRows) {
        const text = cellText(row, colName) || "null";
        maxValueW = Math.max(
          maxValueW,
          Math.ceil(measureText(text, bodyFont)) + padX,
        );
      }
      return Math.max(headerW, maxValueW, filterFloor);
    });
  }

  function syncWidthToggleBtn() {
    widthToggleBtn.classList.remove("is-active");
    if (state.equalWidth) {
      widthToggleBtn.innerHTML = WIDTH_EQUAL_ICON;
      widthToggleBtn.title = t(
        "webview.renderer.widthEqual",
        "Colunas com largura igual",
      );
    } else {
      widthToggleBtn.innerHTML = WIDTH_MIN_ICON;
      widthToggleBtn.title = t(
        "webview.renderer.widthMin",
        "Colunas com largura mínima (conteúdo)",
      );
    }
    widthToggleBtn.setAttribute("aria-label", widthToggleBtn.title);
  }

  function applyColumnLayout() {
    table.classList.toggle("is-equal-width", state.equalWidth);
    table.classList.toggle("is-min-width", !state.equalWidth);

    if (state.equalWidth) {
      colEls.forEach((colEl) => {
        colEl.style.width = `${EQUAL_COL_WIDTH}px`;
        colEl.style.minWidth = `${EQUAL_COL_WIDTH}px`;
        colEl.style.maxWidth = `${EQUAL_COL_WIDTH}px`;
      });
      return;
    }

    const autoWidths = computeMinColumnWidths();
    colEls.forEach((colEl, idx) => {
      const manual = colWidths[idx];
      const width =
        typeof manual === "number" && manual > 0 ? manual : autoWidths[idx];
      colEl.style.width = `${width}px`;
      colEl.style.minWidth = `${width}px`;
      colEl.style.maxWidth = "";
    });
  }

  /**
   * @param {number} colIdx
   * @param {number} startX
   * @param {HTMLElement} resizer
   */
  function startResize(colIdx, startX, resizer) {
    const th = thEls[colIdx];
    const startWidth = th.getBoundingClientRect().width;
    root.classList.add("is-resizing");
    resizer.classList.add("is-resizing");

    /** @param {MouseEvent} event */
    const onMove = (event) => {
      const next = Math.max(48, Math.round(startWidth + (event.clientX - startX)));
      colWidths[colIdx] = next;
      if (state.equalWidth) {
        state.equalWidth = false;
        syncWidthToggleBtn();
      }
      applyColumnLayout();
    };

    const onUp = () => {
      root.classList.remove("is-resizing");
      resizer.classList.remove("is-resizing");
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseup", onUp, true);
    };

    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseup", onUp, true);
  }

  function cellText(row, col) {
    const value = row?.[col];
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  }

  function getVisibleRows() {
    const global = state.global.trim().toLowerCase();
    const colFilters = state.columns.map((value) => value.trim().toLowerCase());

    let rows = sourceRows.filter((row) => {
      if (global) {
        const hit = columns.some((col) =>
          cellText(row, col).toLowerCase().includes(global),
        );
        if (!hit) {
          return false;
        }
      }

      for (let i = 0; i < columns.length; i += 1) {
        const filter = colFilters[i];
        if (!filter) {
          continue;
        }
        if (!cellText(row, columns[i]).toLowerCase().includes(filter)) {
          return false;
        }
      }
      return true;
    });

    if (state.sortCol !== null && state.sortDir) {
      const col = columns[state.sortCol];
      const dir = state.sortDir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const left = cellText(a, col);
        const right = cellText(b, col);
        const leftNum = Number(left);
        const rightNum = Number(right);
        if (
          left !== "" &&
          right !== "" &&
          Number.isFinite(leftNum) &&
          Number.isFinite(rightNum)
        ) {
          return (leftNum - rightNum) * dir;
        }
        return (
          left.localeCompare(right, undefined, { sensitivity: "base" }) * dir
        );
      });
    }

    return rows;
  }

  function openExportMenu() {
    exportMenu.hidden = false;
    exportBtn.setAttribute("aria-expanded", "true");
    const btnRect = exportBtn.getBoundingClientRect();
    const menuRect = exportMenu.getBoundingClientRect();
    const viewH = win?.innerHeight ?? btnRect.bottom + 80;
    const viewW = win?.innerWidth ?? btnRect.right + 100;
    let top = btnRect.bottom + 4;
    if (top + menuRect.height > viewH - 4) {
      top = btnRect.top - menuRect.height - 4;
    }
    let left = btnRect.right - menuRect.width;
    left = Math.max(4, Math.min(left, viewW - menuRect.width - 4));
    exportMenu.style.top = `${Math.max(4, top)}px`;
    exportMenu.style.left = `${left}px`;
  }

  function closeExportMenu() {
    exportMenu.hidden = true;
    exportBtn.setAttribute("aria-expanded", "false");
  }

  /** @param {"json" | "csv"} format */
  function exportVisibleRows(format) {
    context.postMessage?.({
      type: "exportData",
      format,
      columns,
      rows: getVisibleRows(),
    });
  }

  function renderBody() {
    const rows = getVisibleRows();

    tbody.replaceChildren();
    for (const row of rows) {
      const tr = el("tr");
      for (const col of columns) {
        const value = row?.[col];
        if (value === null || value === undefined) {
          tr.appendChild(
            el("td", {
              className: "dbadmin-it__null",
              textContent: "null",
            }),
          );
        } else {
          tr.appendChild(el("td", { textContent: String(value) }));
        }
      }
      tbody.appendChild(tr);
    }

    applyColumnLayout();
  }

  syncColFilterVisibility();
  updateFilterLabels();
  updateLupaMarks();
  renderBody();
  return { root, cleanup: teardownPopoverListeners };
}

const SORT_ICON_NONE = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5.2 6.2 8 3.4l2.8 2.8.8-.8L8 1.8 4.4 5.4zM4.4 10.6 8 14.2l3.6-3.6-.8-.8L8 12.6 5.2 9.8z"/></svg>`;
const SORT_ICON_ASC = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 2.2 4.2 6l.8.8L8 3.8 11 6.8l.8-.8z"/></svg>`;
const SORT_ICON_DESC = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4.2 10 8 13.8 11.8 10l-.8-.8L8 12.2 5 9.2z"/></svg>`;
const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M10.5 9.4h-.6l-.2-.2a4 4 0 1 0-.4.4l.2.2v.6l3.2 3.2.9-.9zm-3.7 0a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6z"/></svg>`;
const FILTER_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 3.5h12l-4.5 5.2v3.8L6.5 14V8.7z"/></svg>`;
const WIDTH_EQUAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2h3v12H2zm4.5 0h3v12h-3zM11 2h3v12h-3z"/></svg>`;
const WIDTH_MIN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1 3h2v10H1zm4 0h4v10H5zm6 0h5v10h-5z"/></svg>`;
const EXPORT_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.25 2h1.5v6.2h2.4L8 11.4 4.85 8.2h2.4zm-4.5 10.2h10.5V14H2.75z"/></svg>`;

/**
 * @param {string} tag
 * @param {Record<string, string> & { className?: string, textContent?: string, type?: string, placeholder?: string, title?: string }} [props]
 */
function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "className") {
      node.className = String(value);
    } else if (key === "textContent") {
      node.textContent = String(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

/** @param {HTMLElement} root */
function injectStyles(root) {
  const style = el("style");
  style.textContent = `
    .dbadmin-it {
      position: relative;
      display: flex;
      flex-direction: column;
      max-width: 100%;
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 4px;
      overflow: visible;
      background: var(--vscode-editor-background);
      background-clip: padding-box;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      --dbadmin-input-focus: #007acc;
      accent-color: var(--dbadmin-input-focus);
    }
    .dbadmin-it__shell {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-radius: 3px;
      overflow: hidden;
      background: inherit;
    }
    .dbadmin-it input,
    .dbadmin-it textarea,
    .dbadmin-it select {
      accent-color: var(--dbadmin-input-focus);
      caret-color: var(--vscode-editorCursor-foreground, var(--dbadmin-input-focus));
    }
    .dbadmin-it input:focus,
    .dbadmin-it textarea:focus,
    .dbadmin-it select:focus,
    .dbadmin-it input:focus-visible,
    .dbadmin-it textarea:focus-visible,
    .dbadmin-it select:focus-visible {
      outline: none;
      border-color: var(--dbadmin-input-focus);
    }
    .dbadmin-it.is-resizing,
    .dbadmin-it.is-resizing * {
      cursor: col-resize !important;
      user-select: none !important;
    }
    .dbadmin-it__empty {
      margin: 8px;
      opacity: 0.7;
    }
    .dbadmin-it__header {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: nowrap;
      padding: 3px 6px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
      border-top-left-radius: 3px;
      border-top-right-radius: 3px;
    }
    .dbadmin-it__search-wrap {
      flex: 1 1 auto;
      min-width: 140px;
      position: relative;
      display: flex;
      align-items: center;
      border-radius: 2px;
      overflow: hidden;
    }
    .dbadmin-it__search {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
      height: 20px;
      padding: 0 24px 0 6px;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-input-foreground);
      outline: none;
      font-size: 12px;
      box-sizing: border-box;
      overflow: hidden;
      background-clip: padding-box;
    }
    .dbadmin-it__search:hover {
      border-color: var(--vscode-editorGroup-border);
    }
    .dbadmin-it__search:focus,
    .dbadmin-it__search.is-filled {
      border-color: var(--vscode-editorGroup-border);
      background: var(--vscode-input-background);
    }
    .dbadmin-it__search:focus {
      border-color: var(--dbadmin-input-focus);
      outline: none;
      box-shadow: none;
    }
    .dbadmin-it__search-lupa {
      position: absolute;
      right: 5px;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      opacity: 0.55;
      pointer-events: none;
      color: var(--vscode-foreground);
    }
    .dbadmin-it__search-wrap:hover .dbadmin-it__search-lupa,
    .dbadmin-it__search-wrap:focus-within .dbadmin-it__search-lupa,
    .dbadmin-it__search.is-filled ~ .dbadmin-it__search-lupa {
      opacity: 0.9;
    }
    .dbadmin-it__btn {
      height: 20px;
      padding: 0 10px;
      border: 1px solid var(--vscode-button-border, var(--vscode-editorGroup-border));
      border-radius: 2px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      white-space: nowrap;
      font-size: 12px;
    }
    .dbadmin-it__btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .dbadmin-it__icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 20px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.55;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .dbadmin-it__icon-btn:hover {
      opacity: 0.9;
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    .dbadmin-it__icon-btn.is-active {
      opacity: 1;
      border-color: var(--vscode-editorGroup-border);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      color: #bababa;
    }
    .dbadmin-it__icon-btn.is-active:hover {
      color: #bababa;
      opacity: 1;
    }
    .dbadmin-it__scroll {
      overflow: auto;
      max-height: min(60vh, 520px);
      outline: none;
    }
    .dbadmin-it__table {
      border-collapse: separate;
      border-spacing: 0;
      width: max-content;
      min-width: 100%;
    }
    .dbadmin-it__table.is-equal-width {
      table-layout: fixed;
      width: max-content;
      min-width: 100%;
    }
    .dbadmin-it__table.is-min-width {
      table-layout: fixed;
      width: max-content;
      min-width: 100%;
    }
    .dbadmin-it__table th,
    .dbadmin-it__table td {
      padding: 3px 10px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      text-align: left;
      white-space: nowrap;
      vertical-align: top;
      box-sizing: border-box;
    }
    .dbadmin-it__table th {
      border-right: 1px solid var(--vscode-editorGroup-border);
    }
    .dbadmin-it__table td {
      user-select: text;
      cursor: text;
      background: transparent;
    }
    .dbadmin-it__table tbody tr,
    .dbadmin-it__table tbody tr:nth-child(odd),
    .dbadmin-it__table tbody tr:nth-child(even) {
      background: transparent;
    }
    .dbadmin-it__table.is-equal-width th,
    .dbadmin-it__table.is-equal-width td {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dbadmin-it__table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editor-background);
      font-weight: 600;
      opacity: 0.95;
    }
    .dbadmin-it__th {
      position: relative;
    }
    .dbadmin-it__th-stack {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      width: 100%;
      max-width: 100%;
    }
    .dbadmin-it__th-row {
      display: flex;
      align-items: stretch;
      gap: 0;
      min-width: 0;
      width: 100%;
    }
    .dbadmin-it__th-title {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      flex: 0 1 auto;
      min-width: 0;
    }
    .dbadmin-it__th-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .dbadmin-it__th-title:hover {
      color: var(--vscode-textLink-foreground);
    }
    .dbadmin-it__sort {
      display: inline-flex;
      opacity: 0.45;
      flex: 0 0 auto;
    }
    .dbadmin-it__sort.is-asc,
    .dbadmin-it__sort.is-desc {
      opacity: 0.9;
    }
    .dbadmin-it__search-slot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      flex: 1 1 auto;
      min-width: 0;
      padding-left: 6px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      min-height: 16px;
    }
    .dbadmin-it__search-slot[hidden] {
      display: none !important;
    }
    .dbadmin-it__filter-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
      font-weight: 400;
      font-size: 11px;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      opacity: 0.9;
    }
    .dbadmin-it__filter-label[hidden] {
      display: none !important;
    }
    .dbadmin-it__lupa {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      padding: 0;
      border: 0;
      border-radius: 2px;
      background: transparent;
      color: inherit;
      opacity: 0.35;
      flex: 0 0 auto;
    }
    .dbadmin-it__search-slot:hover .dbadmin-it__lupa,
    .dbadmin-it__lupa:hover,
    .dbadmin-it__lupa.is-open {
      opacity: 1;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .dbadmin-it__lupa.is-filled {
      opacity: 0.95;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .dbadmin-it__lupa[hidden] {
      display: none !important;
    }
    .dbadmin-it__col-filter-wrap {
      width: 100%;
      min-width: 0;
      border-radius: 2px;
      overflow: hidden;
    }
    .dbadmin-it__col-filter {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      height: 20px;
      padding: 0 4px;
      box-sizing: border-box;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 11px;
      outline: none;
      overflow: hidden;
      background-clip: padding-box;
    }
    .dbadmin-it__col-filter[hidden] {
      display: none !important;
    }
    .dbadmin-it__col-filter-wrap:has(> [hidden]) {
      display: none;
    }
    .dbadmin-it__col-filter:hover {
      border-color: var(--vscode-editorGroup-border);
    }
    .dbadmin-it__col-filter:focus,
    .dbadmin-it__col-filter.is-filled {
      border-color: var(--vscode-editorGroup-border);
      background: var(--vscode-input-background);
    }
    .dbadmin-it__col-filter:focus {
      border-color: var(--dbadmin-input-focus);
      outline: none;
      box-shadow: none;
    }
    .dbadmin-it__popover {
      position: fixed;
      z-index: 100000;
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 140px;
      max-width: 220px;
      padding: 3px 4px;
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
    }
    .dbadmin-it__popover[hidden] {
      display: none !important;
    }
    .dbadmin-it__menu {
      position: fixed;
      z-index: 100000;
      min-width: 92px;
      padding: 4px;
      border: 1px solid var(--vscode-editorGroup-border);
      border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
    }
    .dbadmin-it__menu[hidden] {
      display: none !important;
    }
    .dbadmin-it__menu-item {
      display: block;
      width: 100%;
      height: 24px;
      padding: 0 8px;
      border: 0;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
      cursor: pointer;
      font-size: 12px;
    }
    .dbadmin-it__menu-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .dbadmin-it__popover-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 20px;
      padding: 0 4px;
      border: 1px solid var(--dbadmin-input-focus, #007acc);
      border-radius: 2px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 11px;
      outline: none;
      overflow: hidden;
      background-clip: padding-box;
    }
    .dbadmin-it__popover-clear {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .dbadmin-it__popover-clear:disabled {
      opacity: 0.35;
      cursor: default;
      color: color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent);
    }
    .dbadmin-it__popover-clear:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-foreground);
    }
    .dbadmin-it__resizer {
      position: absolute;
      top: 0;
      right: -2px;
      width: 5px;
      height: 100%;
      cursor: col-resize;
      z-index: 3;
    }
    .dbadmin-it__resizer::after {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: 50%;
      width: 3px;
      transform: translateX(-50%);
      background: transparent;
    }
    .dbadmin-it__resizer:hover::after,
    .dbadmin-it__resizer.is-resizing::after {
      background: color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent);
    }
    .dbadmin-it__null {
      color: color-mix(in srgb, var(--vscode-foreground) 40%, transparent);
      font-style: italic;
    }
  `;
  root.appendChild(style);
}
