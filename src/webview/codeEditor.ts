export function buildCodeEditorStyles(): string {
  return String.raw`
    .code-editor-shell {
      position: relative;
      display: grid;
      grid-template-columns: 54px 1fr;
      flex: 1 1 auto;
      min-height: 160px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .code-editor-find-widget {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 4;
      display: none;
      flex-direction: column;
      gap: 6px;
      min-width: 420px;
      max-width: min(620px, calc(100% - 20px));
      padding: 8px;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 11%, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.18);
    }
    .code-editor-find-widget.open { display: flex; }
    .code-editor-find-row,
    .code-editor-replace-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .code-editor-replace-row { display: none; }
    .code-editor-find-widget.replace-open .code-editor-replace-row { display: flex; }
    .code-editor-find-input-wrap {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
    }
    .code-editor-toggle-replace-chevron {
      position: absolute;
      right: 4px;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--vscode-input-foreground);
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      pointer-events: auto;
    }
    .code-editor-toggle-replace-chevron:hover {
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      border-radius: 4px;
    }
    .code-editor-find-input,
    .code-editor-replace-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 24px;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      padding: 0 6px;
      font-size: 12px;
    }
    .code-editor-find-input:focus,
    .code-editor-replace-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .code-editor-find-result {
      min-width: 52px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      user-select: none;
      flex: 0 0 auto;
    }
    .code-editor-line-numbers {
      margin: 0;
      padding: 10px 0;
      overflow: hidden;
      color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.4;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-sideBar-background));
      border-right: 1px solid var(--vscode-panel-border);
      user-select: none;
    }
    .code-editor-line-number {
      display: block;
      padding: 0 8px 0 0;
      text-align: right;
      cursor: default;
      white-space: pre;
    }
    .code-editor-line-number.current {
      color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground));
    }
    .code-editor-line-number.selected {
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground, var(--vscode-focusBorder)) 28%, transparent);
      color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground));
    }
    .code-editor-stack {
      position: relative;
      overflow: hidden;
      min-height: 160px;
    }
    .code-editor-highlight,
    .code-editor-textarea {
      margin: 0;
      padding: 10px;
      white-space: pre;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.4;
      box-sizing: border-box;
      position: absolute;
      inset: 0;
      overflow: auto;
    }
    .code-editor-highlight {
      pointer-events: none;
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      background: var(--vscode-editor-background);
      z-index: 1;
    }
    .code-editor-textarea {
      color: transparent;
      caret-color: var(--vscode-editorCursor-foreground, var(--vscode-foreground));
      background: transparent;
      border: 0;
      outline: none;
      resize: none;
      z-index: 2;
    }
    .code-token-key { color: var(--vscode-symbolIcon-keyForeground, #9cdcfe); font-weight: 600; }
    .code-token-string { color: color-mix(in srgb, var(--vscode-charts-green, #89d185) 78%, var(--vscode-editor-foreground, #d4d4d4)); }
    .code-token-number { color: color-mix(in srgb, var(--vscode-charts-green, #89d185) 78%, var(--vscode-editor-foreground, #d4d4d4)); }
    .code-token-boolean { color: var(--vscode-charts-blue, #569cd6); }
    .code-token-null { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .code-token-bracket { color: color-mix(in srgb, var(--vscode-charts-yellow, #dcdcaa) 86%, var(--vscode-editor-foreground, #d4d4d4)); }
  `;
}

export function buildCodeEditorMarkup(): string {
  return String.raw`
    <div class="code-editor-shell" id="codeEditorRoot">
      <div class="code-editor-find-widget" id="codeEditorFindWidget">
        <div class="code-editor-find-row">
          <div class="code-editor-find-input-wrap">
            <input class="code-editor-find-input" id="codeEditorFindInput" placeholder="Buscar" />
            <button class="code-editor-toggle-replace-chevron" id="codeEditorToggleReplace" title="Mostrar substituir">▶</button>
          </div>
          <span class="code-editor-find-result" id="codeEditorFindResult"></span>
          <button id="codeEditorFindPrev" class="secondary" title="Anterior">↑</button>
          <button id="codeEditorFindNext" class="secondary" title="Próximo">↓</button>
          <button id="codeEditorRegex" class="secondary" title="Regex">.*</button>
          <button id="codeEditorCloseFind" class="secondary" title="Fechar busca">✕</button>
        </div>
        <div class="code-editor-replace-row" id="codeEditorReplaceRow">
          <input class="code-editor-replace-input" id="codeEditorReplaceInput" placeholder="Substituir" />
          <button id="codeEditorReplaceOne" class="secondary" title="Substituir">Substituir</button>
          <button id="codeEditorReplaceAll" class="secondary" title="Substituir tudo">Tudo</button>
        </div>
      </div>
      <div class="code-editor-line-numbers" id="codeEditorLineNumbers"></div>
      <div class="code-editor-stack">
        <pre class="code-editor-highlight" id="codeEditorHighlight"></pre>
        <textarea class="code-editor-textarea" id="codeEditorTextarea" spellcheck="false"></textarea>
      </div>
    </div>
  `;
}

export function buildCodeEditorScript(): string {
  return String.raw`
    (function () {
      function highlightJson(text) {
        const escaped = String(text)
          .split('&').join('&amp;')
          .split('<').join('&lt;')
          .split('>').join('&gt;');

        return escaped
          .replace(/"(?:\\.|[^"\\])*"/g, function(match) {
            return '<span class="code-token-string">' + match + '</span>';
          })
          .replace(/\b(true|false|null)\b/g, function(match) {
            const className = match === 'null' ? 'code-token-null' : 'code-token-boolean';
            return '<span class="' + className + '">' + match + '</span>';
          })
          .replace(/(-?\d+\.?\d*([eE][+-]?\d+)?)/g, function(match) {
            if (match === '' || match === '-') return match;
            return '<span class="code-token-number">' + match + '</span>';
          })
          .replace(/([{}[\]:,])/g, function(match) {
            return '<span class="code-token-bracket">' + match + '</span>';
          })
          .replace(/:\s*(?=["\d{[\-tfn])/g, function(match) {
            return '<span class="code-token-bracket">:</span> ';
          });
      }

      function getLineStarts(text) {
        const starts = [0];
        for (let index = 0; index < text.length; index += 1) {
          if (text.charCodeAt(index) === 10) {
            starts.push(index + 1);
          }
        }
        return starts;
      }

      function getLineIndexFromOffset(offset, starts) {
        let low = 0;
        let high = starts.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (starts[middle] <= offset) {
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return Math.max(0, high);
      }

      function getLineLength(text, lineStarts, lineIndex) {
        const start = lineStarts[lineIndex] ?? 0;
        const end = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : text.length;
        return Math.max(0, end - start);
      }

      function getSelectionLineRange(text, selectionStart, selectionEnd) {
        const starts = getLineStarts(text);
        const normalizedEnd = selectionEnd > selectionStart ? selectionEnd - 1 : selectionEnd;
        return {
          starts: starts,
          startLine: getLineIndexFromOffset(selectionStart, starts),
          endLine: getLineIndexFromOffset(Math.max(0, normalizedEnd), starts),
        };
      }

      function create(options) {
        const rootEl = options.rootEl;
        const findWidgetEl = options.findWidgetEl;
        const lineNumbersEl = options.lineNumbersEl;
        const highlightEl = options.highlightEl;
        const textareaEl = options.textareaEl;
        const findInputEl = options.findInputEl;
        const findResultEl = options.findResultEl;
        const findPrevEl = options.findPrevEl;
        const findNextEl = options.findNextEl;
        const toggleReplaceEl = options.toggleReplaceEl;
        const replaceRowEl = options.replaceRowEl;
        const replaceInputEl = options.replaceInputEl;
        const replaceOneEl = options.replaceOneEl;
        const replaceAllEl = options.replaceAllEl;
        const closeFindEl = options.closeFindEl;
        let isLineDragging = false;
        let lineDragAnchor = -1;

        function syncScroll() {
          const top = textareaEl.scrollTop;
          const left = textareaEl.scrollLeft;
          highlightEl.scrollTop = top;
          highlightEl.scrollLeft = left;
          lineNumbersEl.scrollTop = top;
        }

        function updateHighlight() {
          const content = textareaEl.value || '';
          highlightEl.textContent = content;
          const highlighted = highlightJson(content);
          highlightEl.innerHTML = highlighted;
        }

        function renderLineNumbers() {
          const content = textareaEl.value || '';
          const lineStarts = getLineStarts(content);
          const selection = getSelectionLineRange(content, textareaEl.selectionStart, textareaEl.selectionEnd);
          const currentLine = getLineIndexFromOffset(textareaEl.selectionStart, lineStarts);
          const fragments = [];
          for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
            const classes = ['code-editor-line-number'];
            if (lineIndex === currentLine) {
              classes.push('current');
            }
            if (lineIndex >= selection.startLine && lineIndex <= selection.endLine) {
              classes.push('selected');
            }
            fragments.push('<span class="' + classes.join(' ') + '" data-line-index="' + String(lineIndex) + '">' + String(lineIndex + 1) + '</span>');
          }
          lineNumbersEl.innerHTML = fragments.join('');
        }

        function refreshEditorUi() {
          renderLineNumbers();
          updateHighlight();
          syncScroll();
          updateSearchResult();
        }

        function emitChange() {
          if (typeof options.onChange === 'function') {
            options.onChange(textareaEl.value || '');
          }
        }

        function setValue(nextValue, emit) {
          textareaEl.value = String(nextValue ?? '');
          renderLineNumbers();
          syncScroll();
          updateHighlight();
          if (emit !== false) {
            emitChange();
          }
        }

        function getValue() {
          return textareaEl.value || '';
        }

        function focus() {
          textareaEl.focus();
        }

        function setSelectionRange(start, end) {
          textareaEl.focus();
          textareaEl.setSelectionRange(start, end);
          renderLineNumbers();
          updateSearchResult();
        }

        function setCaret(lineIndex, column) {
          const content = textareaEl.value || '';
          const lineStarts = getLineStarts(content);
          const normalizedLine = Math.max(0, Math.min(lineIndex, lineStarts.length - 1));
          const lineStart = lineStarts[normalizedLine] ?? 0;
          const nextOffset = lineStart + Math.min(Math.max(0, column), getLineLength(content, lineStarts, normalizedLine));
          setSelectionRange(nextOffset, nextOffset);
        }

        function selectLines(startLine, endLine) {
          const content = textareaEl.value || '';
          const lineStarts = getLineStarts(content);
          const normalizedStartLine = Math.max(0, Math.min(startLine, lineStarts.length - 1));
          const normalizedEndLine = Math.max(0, Math.min(endLine, lineStarts.length - 1));
          const fromLine = Math.min(normalizedStartLine, normalizedEndLine);
          const toLine = Math.max(normalizedStartLine, normalizedEndLine);
          const startOffset = lineStarts[fromLine] ?? 0;
          const endOffset = toLine + 1 < lineStarts.length ? lineStarts[toLine + 1] : content.length;
          setSelectionRange(startOffset, endOffset);
        }

        function beginLineSelection(lineIndex) {
          isLineDragging = true;
          lineDragAnchor = lineIndex;
          selectLines(lineIndex, lineIndex);
        }

        function endLineSelection() {
          isLineDragging = false;
          lineDragAnchor = -1;
        }

        function moveSelectedLines(direction) {
          const content = textareaEl.value || '';
          const lineStarts = getLineStarts(content);
          const selectionStart = textareaEl.selectionStart;
          const selection = getSelectionLineRange(content, selectionStart, textareaEl.selectionEnd);
          const caretLine = getLineIndexFromOffset(selectionStart, lineStarts);
          const caretColumn = selectionStart - (lineStarts[caretLine] ?? 0);
          const lines = content.split('\n');
          const startLine = selection.startLine;
          const endLine = selection.endLine;

          if (direction < 0) {
            if (startLine === 0) {
              return;
            }
            const block = lines.slice(startLine, endLine + 1);
            const previousLine = lines[startLine - 1];
            const nextLines = []
              .concat(lines.slice(0, startLine - 1))
              .concat(block)
              .concat([previousLine])
              .concat(lines.slice(endLine + 1));
            setValue(nextLines.join('\n'));
            setCaret(Math.max(0, caretLine - 1), caretColumn);
            return;
          }

          if (endLine >= lines.length - 1) {
            return;
          }

          const movedBlock = lines.slice(startLine, endLine + 1);
          const nextLine = lines[endLine + 1];
          const reorderedLines = []
            .concat(lines.slice(0, startLine))
            .concat([nextLine])
            .concat(movedBlock)
            .concat(lines.slice(endLine + 2));
          setValue(reorderedLines.join('\n'));
          setCaret(Math.min(lines.length - 1, caretLine + 1), caretColumn);
        }

        function getMatches() {
          const source = textareaEl.value || '';
          const needle = findInputEl.value || '';
          if (!needle) {
            return [];
          }
          const matches = [];
          let fromIndex = 0;
          while (fromIndex <= source.length) {
            const foundIndex = source.indexOf(needle, fromIndex);
            if (foundIndex < 0) {
              break;
            }
            matches.push({ start: foundIndex, end: foundIndex + needle.length });
            fromIndex = foundIndex + Math.max(needle.length, 1);
          }
          return matches;
        }

        function updateSearchResult() {
          const matches = getMatches();
          if (!matches.length) {
            findResultEl.textContent = findInputEl.value ? '0' : '';
            return;
          }
          const selectionStart = textareaEl.selectionStart;
          const selectionEnd = textareaEl.selectionEnd;
          let currentIndex = matches.findIndex(function (match) {
            return match.start === selectionStart && match.end === selectionEnd;
          });
          if (currentIndex < 0) {
            currentIndex = matches.findIndex(function (match) {
              return match.start >= selectionStart;
            });
          }
          if (currentIndex < 0) {
            currentIndex = 0;
          }
          findResultEl.textContent = String(currentIndex + 1) + ' de ' + String(matches.length);
        }

        function findNext(reverse) {
          const matches = getMatches();
          if (!matches.length) {
            updateSearchResult();
            return false;
          }
          const selectionStart = textareaEl.selectionStart;
          const selectionEnd = textareaEl.selectionEnd;
          let nextMatch = null;
          if (reverse) {
            for (let index = matches.length - 1; index >= 0; index -= 1) {
              if (matches[index].start < Math.max(0, selectionStart - 1)) {
                nextMatch = matches[index];
                break;
              }
            }
            if (!nextMatch) {
              nextMatch = matches[matches.length - 1];
            }
          } else {
            for (let index = 0; index < matches.length; index += 1) {
              if (matches[index].start >= Math.max(selectionEnd, selectionStart + (selectionEnd > selectionStart ? 1 : 0))) {
                nextMatch = matches[index];
                break;
              }
            }
            if (!nextMatch) {
              nextMatch = matches[0];
            }
          }
          setSelectionRange(nextMatch.start, nextMatch.end);
          return true;
        }

        function replaceOne() {
          const needle = findInputEl.value || '';
          if (!needle) {
            return false;
          }
          const replacement = replaceInputEl.value || '';
          const selectionStart = textareaEl.selectionStart;
          const selectionEnd = textareaEl.selectionEnd;
          const source = textareaEl.value || '';
          if (source.slice(selectionStart, selectionEnd) !== needle) {
            return findNext(false);
          }
          const nextValue = source.slice(0, selectionStart) + replacement + source.slice(selectionEnd);
          setValue(nextValue);
          const nextEnd = selectionStart + replacement.length;
          setSelectionRange(selectionStart, nextEnd);
          findNext(false);
          return true;
        }

        function replaceAll() {
          const needle = findInputEl.value || '';
          if (!needle) {
            return false;
          }
          const replacement = replaceInputEl.value || '';
          const source = textareaEl.value || '';
          if (!source.includes(needle)) {
            updateSearchResult();
            return false;
          }
          setValue(source.split(needle).join(replacement));
          updateSearchResult();
          return true;
        }

        function openFind(replaceVisible) {
          findWidgetEl.classList.add('open');
          if (replaceVisible) {
            findWidgetEl.classList.add('replace-open');
          }
          const selectedText = textareaEl.value.slice(textareaEl.selectionStart, textareaEl.selectionEnd);
          if (selectedText && !selectedText.includes('\n')) {
            findInputEl.value = selectedText;
          }
          updateSearchResult();
          findInputEl.focus();
          findInputEl.select();
        }

        function closeFind() {
          findWidgetEl.classList.remove('open');
          findWidgetEl.classList.remove('replace-open');
          textareaEl.focus();
        }

        function toggleReplace() {
          findWidgetEl.classList.toggle('replace-open');
          const isOpen = findWidgetEl.classList.contains('replace-open');
          toggleReplaceEl.textContent = isOpen ? '\u25bc' : '\u25b6';
          if (isOpen) {
            replaceInputEl.focus();
            replaceInputEl.select();
          } else {
            findInputEl.focus();
            findInputEl.select();
          }
        }

        lineNumbersEl.addEventListener('mousedown', function (event) {
          if (event.button !== 0) {
            return;
          }
          const lineEl = event.target.closest('.code-editor-line-number');
          if (!lineEl) {
            return;
          }
          event.preventDefault();
          const lineIndex = Number(lineEl.getAttribute('data-line-index') || '0');
          beginLineSelection(lineIndex);
        });

        lineNumbersEl.addEventListener('mousemove', function (event) {
          if (!isLineDragging) {
            return;
          }
          if ((event.buttons & 1) !== 1) {
            endLineSelection();
            return;
          }
          const lineEl = event.target.closest('.code-editor-line-number');
          if (!lineEl) {
            return;
          }
          const lineIndex = Number(lineEl.getAttribute('data-line-index') || '0');
          selectLines(lineDragAnchor, lineIndex);
        });

        document.addEventListener('mouseup', endLineSelection);
        document.addEventListener('mouseleave', endLineSelection);
        window.addEventListener('blur', endLineSelection);

        textareaEl.addEventListener('input', function () {
          refreshEditorUi();
          emitChange();
        });
        textareaEl.addEventListener('scroll', syncScroll);
        textareaEl.addEventListener('click', function () {
          renderLineNumbers();
          updateSearchResult();
        });
        textareaEl.addEventListener('keyup', function () {
          renderLineNumbers();
          updateSearchResult();
        });
        textareaEl.addEventListener('select', function () {
          renderLineNumbers();
          updateSearchResult();
        });

        textareaEl.addEventListener('keydown', function (event) {
          if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault();
            event.stopPropagation();
            openFind(false);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && (event.key === 'h' || event.key === 'H')) {
            event.preventDefault();
            event.stopPropagation();
            openFind(true);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof options.onSaveShortcut === 'function') {
              options.onSaveShortcut();
            }
            return;
          }
          if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            moveSelectedLines(-1);
            return;
          }
          if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            moveSelectedLines(1);
            return;
          }
          if (event.key === 'F3') {
            event.preventDefault();
            event.stopPropagation();
            findNext(event.shiftKey);
            return;
          }
          if (event.key === 'Escape' && findWidgetEl.classList.contains('open')) {
            event.preventDefault();
            event.stopPropagation();
            closeFind();
          }
        });

        findInputEl.addEventListener('input', updateSearchResult);
        replaceInputEl.addEventListener('input', updateSearchResult);
        findInputEl.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            findNext(event.shiftKey);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeFind();
          }
        });
        replaceInputEl.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            replaceOne();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeFind();
          }
        });
        findPrevEl.addEventListener('click', function () { findNext(true); });
        findNextEl.addEventListener('click', function () { findNext(false); });
        toggleReplaceEl.addEventListener('click', toggleReplace);
        replaceOneEl.addEventListener('click', replaceOne);
        replaceAllEl.addEventListener('click', replaceAll);
        closeFindEl.addEventListener('click', closeFind);

        refreshEditorUi();

        return {
          setValue: function (value) { setValue(value, false); },
          getValue: getValue,
          focus: focus,
          setSelectionRange: setSelectionRange,
          closeFind: closeFind,
        };
      }

      window.DbAdminCodeEditor = {
        create: create,
      };
    })();
  `;
}