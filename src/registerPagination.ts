type Sheet = {
  element: HTMLDivElement;
  body: HTMLDivElement;
  footer?: HTMLElement;
  rows?: HTMLTableSectionElement;
};

function entryFields(entry: HTMLElement) {
  return Array.from(entry.querySelectorAll<HTMLElement>(entry.tagName === 'TR' ? 'td' : '.print-field span'));
}

function textBoundary(value: string[], length: number) {
  const end = Math.min(value.length, length);
  if (end === value.length || /\s/u.test(value[end])) return end;

  for (let position = end; position > Math.max(0, end - 32); position--) {
    if (/\s/u.test(value[position - 1])) return position;
  }
  return end;
}

function fitEntryFragment(entry: HTMLElement, remaining: string[][], fits: () => boolean) {
  const fields = entryFields(entry);
  let low = 1;
  let high = Math.max(...remaining.map(value => value.length));
  let count = 0;

  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    fields.forEach((field, index) => { field.textContent = remaining[index].slice(0, length).join(''); });
    if (fits()) {
      count = length;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (!count) return false;

  fields.forEach((field, index) => {
    const value = remaining[index];
    const boundary = textBoundary(value, count);
    field.textContent = value.slice(0, boundary).join('');
    remaining[index] = value.slice(boundary);
  });
  return true;
}

export function paginateRegister(source: HTMLElement, measure: HTMLElement, width: number, height: number) {
  if (width <= 0 || height <= 0) return null;

  const summary = source.querySelector<HTMLTableElement>('.print-table');
  const entries = summary
    ? Array.from(summary.tBodies[0].rows)
    : Array.from(source.querySelectorAll<HTMLElement>('.print-record'));
  const footerTemplate = source.querySelector<HTMLElement>('.print-page-footer');
  const sheets: HTMLDivElement[] = [];

  function createSheet(): Sheet {
    const element = document.createElement('div');
    element.className = 'register-sheet';
    element.style.width = width + 'px';
    element.style.height = height + 'px';
    const body = document.createElement('div');
    body.className = 'register-sheet-body';
    element.append(body);
    const footer = footerTemplate?.cloneNode(true) as HTMLElement | undefined;
    if (footer) {
      footer.classList.remove('print-page-footer');
      element.append(footer);
    }
    return { element, body, footer };
  }

  let current = createSheet();
  sheets.push(current.element);
  measure.replaceChildren(current.element);

  function addSheet() {
    current = createSheet();
    sheets.push(current.element);
    measure.replaceChildren(current.element);
  }

  function fits() {
    return current.body.getBoundingClientRect().height + (current.footer?.getBoundingClientRect().height ?? 0) <= height;
  }

  function appendEntry(entry: HTMLElement) {
    if (summary && !current.rows) {
      const table = summary.cloneNode(false) as HTMLTableElement;
      if (summary.tHead) table.append(summary.tHead.cloneNode(true));
      current.rows = table.createTBody();
      current.body.append(table);
    }
    const copy = entry.cloneNode(true) as HTMLElement;
    (current.rows ?? current.body).append(copy);
    return copy;
  }

  function removeEntry(entry: HTMLElement) {
    entry.remove();
    if (current.rows && !current.rows.childElementCount) {
      current.rows.parentElement?.remove();
      current.rows = undefined;
    }
  }

  function appendIfFits(entry: HTMLElement) {
    const copy = appendEntry(entry);
    if (fits()) return true;
    removeEntry(copy);
    return false;
  }

  try {
    for (const selector of ['.print-header', '.print-meta']) {
      const part = source.querySelector(selector);
      if (part) current.body.append(part.cloneNode(true));
    }
    if (!fits()) return null;

    for (const entry of entries) {
      if (appendIfFits(entry)) continue;
      if (current.body.childElementCount) {
        const previous = current;
        addSheet();
        if (appendIfFits(entry)) continue;

        // An oversized entry can start in the space left on the current sheet.
        sheets.pop();
        current = previous;
        measure.replaceChildren(current.element);
      }

      const remaining = entryFields(entry).map(field => Array.from(field.textContent ?? ''));
      if (!remaining.some(value => value.length)) return null;
      while (remaining.some(value => value.length)) {
        const fragment = appendEntry(entry);
        if (!fitEntryFragment(fragment, remaining, fits)) {
          removeEntry(fragment);
          if (!current.body.childElementCount) return null;
          addSheet();
        } else if (remaining.some(value => value.length)) {
          addSheet();
        }
      }
    }

    const signatures = source.querySelector('.print-signatories')?.cloneNode(true);
    if (signatures) {
      current.body.append(signatures);
      if (!fits()) {
        addSheet();
        current.body.append(signatures);
        if (!fits()) return null;
      }
    }
    return sheets;
  } finally {
    measure.replaceChildren();
  }
}
